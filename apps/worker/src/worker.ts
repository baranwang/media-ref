import type {
  ExecutionContext,
  MessageBatch,
  ScheduledController,
} from "@cloudflare/workers-types";
import {
  claimDueJobs,
  startLeasedJob,
  completeJobWithFencing,
  convergeDuplicateMedia,
  createEvidenceCheckJobHandler,
  createExplorationAgentExecutor,
  createExplorationJobHandler,
  createInvalidationRecheckJobHandler,
  createReviewAgentJobHandler,
  DEFAULT_REVIEW_AGENT_MAX_DURATION_MS,
  createSeedEvidenceCheckJobHandler,
  createTmdbDailyExportsJobHandler,
  createTmdbSyncJobHandler,
  resolveExplorationAgentConfig,
  resolveExplorationSchedulerConfig,
  enqueueTmdbDailyExportsIfDue,
  enqueueTmdbDailySyncIfDue,
  EVIDENCE_CHECK_JOB_TYPE,
  EXPLORATION_JOB_TYPE,
  failJobWithFencing,
  getJobById,
  releaseDemandAfterFailedExploration,
  INVALIDATION_RECHECK_JOB_TYPE,
  releaseLeaseOnDispatchFailure,
  rescheduleJobWithFencing,
  enqueuePendingEvidenceChecks,
  enqueuePendingReviews,
  enqueueTmdbLookupDemands,
  REVIEW_AGENT_JOB_TYPE,
  scheduleExplorationJobs,
  retryFailedSeedEvidenceChecks,
  SEED_EVIDENCE_CHECK_JOB_TYPE,
  TMDB_DAILY_EXPORTS_JOB_TYPE,
  TMDB_SYNC_JOB_TYPE,
  type AdapterRegistry,
  type CatalogGatewayConfig,
  type EvidenceGateStep2Evaluator,
  type ExplorationAgentConfig,
  type ExplorationExecutor,
  type ExplorationSchedulerConfig,
  type ExternalKeyCatalogVerifier,
  type JobHandlerRegistry,
  type JobQueueMessage,
  type JobQueueSender,
  type OutboundClient,
  type ReviewAgentConfig,
  type TmdbGateway,
  type TmdbGatewayConfig,
} from "@media-ref/core";
import type { Db } from "@media-ref/db";

export const DEFAULT_JOB_BATCH_SIZE = 20;
export const DEFAULT_LEASE_DURATION_MS = 5 * 60 * 1000;
export const DEFAULT_RETRY_DELAY_MS = 60 * 1000;
// Per-request cap on catalog calls (TMDB, Trakt, TVDB, Douban, ...). Without it a hung request
// waits until the platform kills the invocation at its wall-clock limit.
export const DEFAULT_CATALOG_TIMEOUT_MS = 30 * 1000;
// Wall clock of one queue consumer or cron invocation (no `limits` in wrangler.jsonc).
const INVOCATION_WALL_TIME_MS = 15 * 60 * 1000;

export interface BackgroundWorkerConfig {
  batchSize?: number;
  leaseDurationMs?: number;
  dispatchFailureRetryDelayMs?: number;
  defaultRetryDelayMs?: number;
  jobTypes?: readonly string[];
  catalog?: CatalogGatewayConfig;
  tmdb?: TmdbGatewayConfig;
  enableDailyTmdbSync?: boolean;
  enableDailyTmdbExportsSync?: boolean;
  tmdbExportsBaseUrl?: string;
  exploration?: Partial<ExplorationSchedulerConfig>;
  explorationAgent?: ExplorationAgentConfig;
  reviewAgent?: ReviewAgentConfig;
  enableExplorationScheduling?: boolean;
}

export interface BackgroundWorkerDeps {
  db: Db;
  outbound: OutboundClient;
  queue: JobQueueSender;
  adapterRegistry?: AdapterRegistry;
  tmdbGateway?: TmdbGateway;
  evaluateStep2?: EvidenceGateStep2Evaluator;
  explorationExecutor?: ExplorationExecutor;
  explorationCatalogVerifier?: ExternalKeyCatalogVerifier;
  handlers?: JobHandlerRegistry;
  config?: BackgroundWorkerConfig;
  now?: () => Date;
}

export interface ScheduledRunSummary {
  claimed: number;
  dispatched: number;
  dispatchFailed: number;
}

export interface QueueBatchSummary {
  processed: number;
  completed: number;
  discarded: number;
  rescheduled: number;
  failed: number;
  retriedInQueue: number;
}

export interface BackgroundWorker {
  scheduled(
    controller?: ScheduledController,
    env?: unknown,
    ctx?: ExecutionContext,
  ): Promise<ScheduledRunSummary>;
  queue(
    batch: MessageBatch<JobQueueMessage>,
    env?: unknown,
    ctx?: ExecutionContext,
  ): Promise<QueueBatchSummary>;
}

function resolveScheduledNow(
  controller: ScheduledController | undefined,
  clock: (() => Date) | undefined,
): Date {
  if (clock) {
    return clock();
  }
  if (controller && Number.isFinite(controller.scheduledTime) && controller.scheduledTime > 0) {
    return new Date(controller.scheduledTime);
  }
  return new Date();
}

function resolveNow(clock: (() => Date) | undefined): Date {
  return clock ? clock() : new Date();
}

function isValidJobQueueMessage(value: unknown): value is JobQueueMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.jobId === "string" &&
    candidate.jobId.length > 0 &&
    typeof candidate.jobType === "string" &&
    candidate.jobType.length > 0 &&
    typeof candidate.leaseGeneration === "number" &&
    Number.isInteger(candidate.leaseGeneration) &&
    candidate.leaseGeneration > 0 &&
    (candidate.dispatchLeaseExpiresAt === undefined ||
      (typeof candidate.dispatchLeaseExpiresAt === "string" &&
        Number.isFinite(Date.parse(candidate.dispatchLeaseExpiresAt)))) &&
    typeof candidate.payload === "object" &&
    candidate.payload !== null &&
    !Array.isArray(candidate.payload)
  );
}

async function runScheduledStep(event: string, jobType: string, step: () => Promise<unknown>) {
  try {
    await step();
  } catch (error) {
    logJobError(event, null, jobType, error);
  }
}

function logJobError(event: string, jobId: string | null, jobType: string, error: unknown) {
  // Drivers and upstreams can put request data in exceptions. Only expose diagnostic codes.
  const code =
    error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "";
  const status =
    error instanceof Error ? /\bHTTP ([1-5]\d\d)\b/i.exec(error.message)?.[1] : undefined;
  const message = /^(?:[0-9A-Z]{5}|ECONNRESET|ECONNREFUSED|ETIMEDOUT)$/.test(code)
    ? `Operation failed (${code})`
    : status
      ? `Upstream HTTP ${status}`
      : "Operation failed";
  console.error({ event, jobId, jobType, error: message });
}

export function createBackgroundWorker(deps: BackgroundWorkerDeps): BackgroundWorker {
  const batchSize = deps.config?.batchSize ?? DEFAULT_JOB_BATCH_SIZE;
  const leaseDurationMs = deps.config?.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
  const explorationBudget = resolveExplorationAgentConfig(
    deps.config?.explorationAgent,
  ).maxDurationMs;
  // The job is already leased during queue delivery and discovery, before the session clock starts.
  const leaseDurationMsByType = {
    [EXPLORATION_JOB_TYPE]: Math.max(leaseDurationMs, explorationBudget + 5 * 60_000),
    // tmdb_sync has no session budget and may use the whole invocation. A shorter lease lets cron
    // claim a second copy while the first still runs, and fencing then drops the first's result.
    [TMDB_SYNC_JOB_TYPE]: Math.max(leaseDurationMs, INVOCATION_WALL_TIME_MS + 5 * 60_000),
    // A review refuses to start with less than its session budget left (see review-agent.ts).
    [REVIEW_AGENT_JOB_TYPE]: Math.max(
      leaseDurationMs,
      (deps.config?.reviewAgent?.maxDurationMs ?? DEFAULT_REVIEW_AGENT_MAX_DURATION_MS) +
        5 * 60_000,
    ),
  };
  // Session jobs restart their lease on delivery, so queue delay does not eat the session budget.
  const leasedOnDelivery = new Set<string>([EXPLORATION_JOB_TYPE, REVIEW_AGENT_JOB_TYPE]);
  // A demand must outlive its job's dispatch lease plus its execution lease; otherwise the
  // scheduler supersedes a session that is still running and throws its result away.
  const explorationConfig = {
    ...deps.config?.exploration,
    leaseDurationMs: Math.max(
      resolveExplorationSchedulerConfig(deps.config?.exploration).leaseDurationMs,
      2 * leaseDurationMsByType[EXPLORATION_JOB_TYPE] + 60_000,
    ),
  };
  // A job that failed for good: an exploration job also releases its demand with a backoff.
  const failJob = async (
    job: { id: string; jobType: string; leaseGeneration: number; payload: Record<string, unknown> },
    errorMessage: string,
    now: Date,
  ) => {
    const result = await failJobWithFencing(deps.db, {
      jobId: job.id,
      leaseGeneration: job.leaseGeneration,
      errorMessage,
      now,
    });
    if (result.applied && job.jobType === EXPLORATION_JOB_TYPE) {
      await releaseDemandAfterFailedExploration(deps.db, {
        payload: job.payload,
        now,
        config: explorationConfig,
      });
    }
    return result;
  };
  const dispatchFailureRetryDelayMs = deps.config?.dispatchFailureRetryDelayMs ?? 0;
  const defaultRetryDelayMs = deps.config?.defaultRetryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const handlers: JobHandlerRegistry = {
    [EVIDENCE_CHECK_JOB_TYPE]: createEvidenceCheckJobHandler({
      adapterRegistry: deps.adapterRegistry,
      catalogConfig: deps.config?.catalog,
      tmdbConfig: deps.config?.tmdb,
      tmdbGateway: deps.tmdbGateway,
      evaluateStep2: deps.evaluateStep2,
    }),
    [SEED_EVIDENCE_CHECK_JOB_TYPE]: createSeedEvidenceCheckJobHandler({
      adapterRegistry: deps.adapterRegistry,
      catalogConfig: deps.config?.catalog,
      tmdbConfig: deps.config?.tmdb,
      tmdbGateway: deps.tmdbGateway,
      evaluateStep2: deps.evaluateStep2,
    }),
    [INVALIDATION_RECHECK_JOB_TYPE]: createInvalidationRecheckJobHandler({
      adapterRegistry: deps.adapterRegistry,
    }),
    [TMDB_SYNC_JOB_TYPE]: createTmdbSyncJobHandler({
      tmdbConfig: deps.config?.tmdb,
      tmdbGateway: deps.tmdbGateway,
    }),
    [TMDB_DAILY_EXPORTS_JOB_TYPE]: createTmdbDailyExportsJobHandler({
      exportBaseUrl: deps.config?.tmdbExportsBaseUrl,
    }),
    [EXPLORATION_JOB_TYPE]: createExplorationJobHandler({
      adapterRegistry: deps.adapterRegistry,
      catalogConfig: deps.config?.catalog,
      tmdbConfig: deps.config?.tmdb,
      tmdbGateway: deps.tmdbGateway,
      config: explorationConfig,
      executor:
        deps.explorationExecutor ??
        createExplorationAgentExecutor({
          adapterRegistry: deps.adapterRegistry,
          ...deps.config?.explorationAgent,
        }),
      catalogVerifier: deps.explorationCatalogVerifier,
    }),
    [REVIEW_AGENT_JOB_TYPE]: createReviewAgentJobHandler({
      adapterRegistry: deps.adapterRegistry,
      catalogConfig: deps.config?.catalog,
      tmdbConfig: deps.config?.tmdb,
      tmdbGateway: deps.tmdbGateway,
      dailyTokenBudget: deps.config?.exploration?.dailyTokenBudget,
      ...deps.config?.reviewAgent,
    }),
    ...deps.handlers,
  };

  return {
    async scheduled(controller) {
      const now = resolveScheduledNow(controller, deps.now);
      const shouldCheckTmdbSync =
        deps.config?.enableDailyTmdbSync !== false &&
        (!deps.config?.jobTypes || deps.config.jobTypes.includes(TMDB_SYNC_JOB_TYPE));

      if (shouldCheckTmdbSync) {
        await runScheduledStep("tmdb_sync_schedule_failed", TMDB_SYNC_JOB_TYPE, () =>
          enqueueTmdbDailySyncIfDue(deps.db, { now }),
        );
      }

      const shouldCheckTmdbDailyExports =
        deps.config?.enableDailyTmdbExportsSync === true &&
        (!deps.config?.jobTypes || deps.config.jobTypes.includes(TMDB_DAILY_EXPORTS_JOB_TYPE));

      if (shouldCheckTmdbDailyExports) {
        await runScheduledStep("tmdb_exports_schedule_failed", TMDB_DAILY_EXPORTS_JOB_TYPE, () =>
          enqueueTmdbDailyExportsIfDue(deps.db, { now }),
        );
      }

      const shouldScheduleExploration =
        deps.config?.enableExplorationScheduling !== false &&
        (!deps.config?.jobTypes || deps.config.jobTypes.includes(EXPLORATION_JOB_TYPE));

      if (shouldScheduleExploration) {
        // Media known only from Douban or Bangumi still need their TMDB ID found.
        await runScheduledStep("tmdb_lookup_schedule_failed", EXPLORATION_JOB_TYPE, () =>
          enqueueTmdbLookupDemands(deps.db, { now }),
        );
        await runScheduledStep("exploration_schedule_failed", EXPLORATION_JOB_TYPE, () =>
          scheduleExplorationJobs(deps.db, {
            now,
            config: explorationConfig,
            adapterRegistry: deps.adapterRegistry,
          }),
        );
      }

      if (!deps.config?.jobTypes || deps.config.jobTypes.includes(EVIDENCE_CHECK_JOB_TYPE)) {
        await runScheduledStep("evidence_sweep_failed", EVIDENCE_CHECK_JOB_TYPE, () =>
          enqueuePendingEvidenceChecks(deps.db, { now }),
        );
      }

      // A seed check that gave up on an outage runs again a day later.
      if (!deps.config?.jobTypes || deps.config.jobTypes.includes(SEED_EVIDENCE_CHECK_JOB_TYPE)) {
        await runScheduledStep("seed_retry_sweep_failed", SEED_EVIDENCE_CHECK_JOB_TYPE, () =>
          retryFailedSeedEvidenceChecks(deps.db, { now }),
        );
      }

      // Every needs_review request gets decided: queue reviews for any without an active job.
      if (!deps.config?.jobTypes || deps.config.jobTypes.includes(REVIEW_AGENT_JOB_TYPE)) {
        await runScheduledStep("review_sweep_failed", REVIEW_AGENT_JOB_TYPE, () =>
          enqueuePendingReviews(deps.db, { now }),
        );
      }

      const claimedJobs = await claimDueJobs(deps.db, {
        now,
        batchSize,
        leaseDurationMs,
        leaseDurationMsByType,
        jobTypes: deps.config?.jobTypes,
      });

      let dispatched = 0;
      let dispatchFailed = 0;

      for (const job of claimedJobs) {
        const message: JobQueueMessage = {
          jobId: job.id,
          jobType: job.jobType,
          leaseGeneration: job.leaseGeneration,
          payload: job.payload,
          ...(leasedOnDelivery.has(job.jobType) && job.leaseExpiresAt
            ? { dispatchLeaseExpiresAt: job.leaseExpiresAt.toISOString() }
            : {}),
        };
        try {
          await deps.queue.send(message);
          dispatched += 1;
        } catch (error) {
          logJobError("job_dispatch_failed", job.id, job.jobType, error);
          dispatchFailed += 1;
          try {
            await releaseLeaseOnDispatchFailure(deps.db, {
              jobId: job.id,
              leaseGeneration: job.leaseGeneration,
              dispatchLeaseExpiresAt: message.dispatchLeaseExpiresAt,
              retryAt: new Date(now.getTime() + dispatchFailureRetryDelayMs),
              now,
            });
          } catch (error) {
            logJobError("dispatch_lease_release_failed", job.id, job.jobType, error);
          }
        }
      }

      if (shouldScheduleExploration) {
        await runScheduledStep("duplicate_convergence_failed", EXPLORATION_JOB_TYPE, () =>
          convergeDuplicateMedia(deps.db, {
            now,
            outbound: deps.outbound,
            catalogConfig: deps.config?.catalog,
            tmdbConfig: deps.config?.tmdb,
            tmdbGateway: deps.tmdbGateway,
          }),
        );
      }

      return {
        claimed: claimedJobs.length,
        dispatched,
        dispatchFailed,
      };
    },

    async queue(batch) {
      const summary: QueueBatchSummary = {
        processed: 0,
        completed: 0,
        discarded: 0,
        rescheduled: 0,
        failed: 0,
        retriedInQueue: 0,
      };

      for (const msg of batch.messages) {
        summary.processed += 1;

        if (!isValidJobQueueMessage(msg.body)) {
          summary.discarded += 1;
          msg.ack();
          continue;
        }

        const body = msg.body;

        let currentJob;
        try {
          currentJob = leasedOnDelivery.has(body.jobType)
            ? await startLeasedJob(
                deps.db,
                body,
                resolveNow(deps.now),
                leaseDurationMsByType[body.jobType as keyof typeof leaseDurationMsByType],
              )
            : await getJobById(deps.db, body.jobId);
        } catch (error) {
          logJobError("job_read_failed", body.jobId, body.jobType, error);
          summary.retriedInQueue += 1;
          msg.retry();
          continue;
        }

        if (
          !currentJob ||
          currentJob.jobType !== body.jobType ||
          currentJob.status !== "leased" ||
          currentJob.leaseGeneration !== body.leaseGeneration
        ) {
          summary.discarded += 1;
          msg.ack();
          continue;
        }

        const handler = handlers[body.jobType];
        if (!handler) {
          try {
            const failResult = await failJobWithFencing(deps.db, {
              jobId: body.jobId,
              leaseGeneration: body.leaseGeneration,
              errorMessage: `No handler registered for job type "${body.jobType}"`,
              now: resolveNow(deps.now),
            });
            if (failResult.applied) {
              summary.failed += 1;
            } else {
              summary.discarded += 1;
            }
            msg.ack();
          } catch (error) {
            logJobError("unhandled_job_write_failed", body.jobId, body.jobType, error);
            summary.retriedInQueue += 1;
            msg.retry();
          }
          continue;
        }

        const jobRef = {
          id: body.jobId,
          jobType: body.jobType,
          leaseGeneration: body.leaseGeneration,
          payload: currentJob.payload,
        };
        try {
          const outcome = await handler({
            db: deps.db,
            outbound: deps.outbound,
            job: {
              id: body.jobId,
              jobType: body.jobType,
              leaseGeneration: body.leaseGeneration,
              payload: currentJob.payload,
              leaseExpiresAt: currentJob.leaseExpiresAt,
            },
            now: resolveNow(deps.now),
          });

          const commitNow = resolveNow(deps.now);

          if (outcome.status === "completed") {
            const writeResult = await completeJobWithFencing(deps.db, {
              jobId: body.jobId,
              leaseGeneration: body.leaseGeneration,
              result: outcome.result,
              now: commitNow,
              onCommit: outcome.onCommit,
            });
            if (writeResult.applied) {
              summary.completed += 1;
            } else {
              summary.discarded += 1;
            }
            msg.ack();
            continue;
          }

          if (outcome.status === "retry") {
            if (currentJob.attempts >= currentJob.maxAttempts) {
              const failResult = await failJob(jobRef, outcome.errorMessage, commitNow);
              if (failResult.applied) {
                summary.failed += 1;
              } else {
                summary.discarded += 1;
              }
            } else {
              const nextRunAfter =
                outcome.runAfter ??
                new Date(commitNow.getTime() + (outcome.delayMs ?? defaultRetryDelayMs));
              const rescheduleResult = await rescheduleJobWithFencing(deps.db, {
                jobId: body.jobId,
                leaseGeneration: body.leaseGeneration,
                runAfter: nextRunAfter,
                errorMessage: outcome.errorMessage,
                now: commitNow,
              });
              if (rescheduleResult.applied) {
                summary.rescheduled += 1;
              } else {
                summary.discarded += 1;
              }
            }
            msg.ack();
            continue;
          }

          const failResult = await failJob(jobRef, outcome.errorMessage, commitNow);
          if (failResult.applied) {
            summary.failed += 1;
          } else {
            summary.discarded += 1;
          }
          msg.ack();
        } catch (error) {
          logJobError("job_execution_failed", body.jobId, body.jobType, error);
          const errorMessage = error instanceof Error ? error.message : String(error);
          const errorNow = resolveNow(deps.now);

          try {
            if (currentJob.attempts >= currentJob.maxAttempts) {
              const failResult = await failJob(jobRef, errorMessage, errorNow);
              if (failResult.applied) {
                summary.failed += 1;
              } else {
                summary.discarded += 1;
              }
            } else {
              const rescheduleResult = await rescheduleJobWithFencing(deps.db, {
                jobId: body.jobId,
                leaseGeneration: body.leaseGeneration,
                runAfter: new Date(errorNow.getTime() + defaultRetryDelayMs),
                errorMessage,
                now: errorNow,
              });
              if (rescheduleResult.applied) {
                summary.rescheduled += 1;
              } else {
                summary.discarded += 1;
              }
            }
            msg.ack();
          } catch (error) {
            logJobError("job_error_write_failed", body.jobId, body.jobType, error);
            summary.retriedInQueue += 1;
            msg.retry();
          }
        }
      }

      return summary;
    },
  };
}
