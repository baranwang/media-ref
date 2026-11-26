import type {
  ExecutionContext,
  MessageBatch,
  ScheduledController,
} from "@cloudflare/workers-types";
import {
  claimDueJobs,
  completeJobWithFencing,
  createEvidenceCheckJobHandler,
  createExplorationAgentExecutor,
  createExplorationJobHandler,
  createInvalidationRecheckJobHandler,
  createReviewAgentJobHandler,
  createSeedEvidenceCheckJobHandler,
  createTmdbDailyExportsJobHandler,
  createTmdbSyncJobHandler,
  enqueueTmdbDailyExportsIfDue,
  enqueueTmdbDailySyncIfDue,
  EVIDENCE_CHECK_JOB_TYPE,
  EXPLORATION_JOB_TYPE,
  failJobWithFencing,
  getJobById,
  INVALIDATION_RECHECK_JOB_TYPE,
  releaseLeaseOnDispatchFailure,
  rescheduleJobWithFencing,
  REVIEW_AGENT_JOB_TYPE,
  scheduleExplorationJobs,
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
    typeof candidate.payload === "object" &&
    candidate.payload !== null &&
    !Array.isArray(candidate.payload)
  );
}

export function createBackgroundWorker(deps: BackgroundWorkerDeps): BackgroundWorker {
  const batchSize = deps.config?.batchSize ?? DEFAULT_JOB_BATCH_SIZE;
  const leaseDurationMs = deps.config?.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
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
      config: deps.config?.exploration,
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
        await enqueueTmdbDailySyncIfDue(deps.db, { now });
      }

      const shouldCheckTmdbDailyExports =
        deps.config?.enableDailyTmdbExportsSync === true &&
        (!deps.config?.jobTypes || deps.config.jobTypes.includes(TMDB_DAILY_EXPORTS_JOB_TYPE));

      if (shouldCheckTmdbDailyExports) {
        await enqueueTmdbDailyExportsIfDue(deps.db, { now });
      }

      const shouldScheduleExploration =
        deps.config?.enableExplorationScheduling !== false &&
        (!deps.config?.jobTypes || deps.config.jobTypes.includes(EXPLORATION_JOB_TYPE));

      if (shouldScheduleExploration) {
        await scheduleExplorationJobs(deps.db, {
          now,
          config: deps.config?.exploration,
          adapterRegistry: deps.adapterRegistry,
        });
      }

      const claimedJobs = await claimDueJobs(deps.db, {
        now,
        batchSize,
        leaseDurationMs,
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
        };
        try {
          await deps.queue.send(message);
          dispatched += 1;
        } catch {
          dispatchFailed += 1;
          await releaseLeaseOnDispatchFailure(deps.db, {
            jobId: job.id,
            leaseGeneration: job.leaseGeneration,
            retryAt: new Date(now.getTime() + dispatchFailureRetryDelayMs),
            now,
          });
        }
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
          currentJob = await getJobById(deps.db, body.jobId);
        } catch {
          summary.retriedInQueue += 1;
          msg.retry();
          continue;
        }

        if (
          !currentJob ||
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
          } catch {
            summary.retriedInQueue += 1;
            msg.retry();
          }
          continue;
        }

        try {
          const outcome = await handler({
            db: deps.db,
            outbound: deps.outbound,
            job: {
              id: body.jobId,
              jobType: body.jobType,
              leaseGeneration: body.leaseGeneration,
              payload: body.payload,
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
              const failResult = await failJobWithFencing(deps.db, {
                jobId: body.jobId,
                leaseGeneration: body.leaseGeneration,
                errorMessage: outcome.errorMessage,
                now: commitNow,
              });
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

          const failResult = await failJobWithFencing(deps.db, {
            jobId: body.jobId,
            leaseGeneration: body.leaseGeneration,
            errorMessage: outcome.errorMessage,
            now: commitNow,
          });
          if (failResult.applied) {
            summary.failed += 1;
          } else {
            summary.discarded += 1;
          }
          msg.ack();
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const errorNow = resolveNow(deps.now);

          try {
            if (currentJob.attempts >= currentJob.maxAttempts) {
              const failResult = await failJobWithFencing(deps.db, {
                jobId: body.jobId,
                leaseGeneration: body.leaseGeneration,
                errorMessage,
                now: errorNow,
              });
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
          } catch {
            summary.retriedInQueue += 1;
            msg.retry();
          }
        }
      }

      return summary;
    },
  };
}
