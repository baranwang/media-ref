import type { BackgroundJobStatus, Database, Db } from "@media-ref/db";
import { type Selectable, sql, type Transaction } from "kysely";
import type { OutboundClient } from "./outbound.ts";

export type JobStatus = BackgroundJobStatus;

export interface BackgroundJob {
  id: string;
  jobType: string;
  dedupeKey: string | null;
  status: JobStatus;
  priority: number;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  errorMessage: string | null;
  attempts: number;
  maxAttempts: number;
  runAfter: Date;
  leaseGeneration: number;
  leaseExpiresAt: Date | null;
  leasedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface JobQueueMessage {
  jobId: string;
  jobType: string;
  leaseGeneration: number;
  payload: Record<string, unknown>;
}

export interface JobQueueSender {
  send(message: JobQueueMessage): Promise<unknown>;
}

export interface EnqueueJobInput {
  jobType: string;
  payload?: Record<string, unknown>;
  priority?: number;
  runAfter?: Date;
  dedupeKey?: string | null;
  maxAttempts?: number;
}

export interface EnqueueJobResult {
  job: BackgroundJob;
  created: boolean;
}

export interface ClaimDueJobsOptions {
  now?: Date;
  batchSize: number;
  leaseDurationMs: number;
  jobTypes?: readonly string[];
}

export type FencedWriteResult =
  | {
      applied: true;
      job: BackgroundJob;
    }
  | {
      applied: false;
      reason: "stale_generation_or_already_completed";
    };

export interface CompleteJobWithFencingInput {
  jobId: string;
  leaseGeneration: number;
  result?: Record<string, unknown>;
  now?: Date;
  onCommit?: (trx: Transaction<Database>, job: BackgroundJob) => Promise<void>;
}

export interface RescheduleJobWithFencingInput {
  jobId: string;
  leaseGeneration: number;
  runAfter: Date;
  errorMessage?: string | null;
  now?: Date;
}

export interface FailJobWithFencingInput {
  jobId: string;
  leaseGeneration: number;
  errorMessage: string;
  now?: Date;
}

export interface ReleaseLeaseOnDispatchFailureInput {
  jobId: string;
  leaseGeneration: number;
  retryAt?: Date;
  now?: Date;
}

export interface JobExecutionContext {
  db: Db;
  outbound: OutboundClient;
  job: {
    id: string;
    jobType: string;
    leaseGeneration: number;
    payload: Record<string, unknown>;
  };
  now: Date;
}

export type JobExecutionOutcome =
  | {
      status: "completed";
      result?: Record<string, unknown>;
      onCommit?: (trx: Transaction<Database>, job: BackgroundJob) => Promise<void>;
    }
  | {
      status: "retry";
      runAfter?: Date;
      delayMs?: number;
      errorMessage: string;
    }
  | {
      status: "failed";
      errorMessage: string;
    };

export type JobHandler = (ctx: JobExecutionContext) => Promise<JobExecutionOutcome>;

export type JobHandlerRegistry = Record<string, JobHandler>;

type BackgroundJobRow = Selectable<Database["background_jobs"]>;

function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function toNullableRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) {
    return null;
  }
  return toRecord(value);
}

function mapJobRow(row: BackgroundJobRow): BackgroundJob {
  return {
    id: row.id,
    jobType: row.job_type,
    dedupeKey: row.dedupe_key,
    status: row.status,
    priority: row.priority,
    payload: toRecord(row.payload),
    result: toNullableRecord(row.result),
    errorMessage: row.error_message,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAfter: row.run_after,
    leaseGeneration: row.lease_generation,
    leaseExpiresAt: row.lease_expires_at,
    leasedAt: row.leased_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getJobById(db: Db, jobId: string): Promise<BackgroundJob | null> {
  const row = await db
    .selectFrom("background_jobs")
    .selectAll()
    .where("id", "=", jobId)
    .executeTakeFirst();

  return row ? mapJobRow(row) : null;
}

export async function enqueueJob(db: Db, input: EnqueueJobInput): Promise<EnqueueJobResult> {
  const jobType = input.jobType.trim();
  if (!jobType) {
    throw new Error("jobType must be a non-empty string");
  }

  const payload = input.payload ?? {};
  const priority = input.priority ?? 0;
  const runAfter = input.runAfter ?? new Date();
  const dedupeKey = input.dedupeKey ?? null;
  const maxAttempts = input.maxAttempts ?? 5;

  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
    throw new Error("maxAttempts must be a positive integer");
  }

  if (dedupeKey === null) {
    const inserted = await db
      .insertInto("background_jobs")
      .values({
        job_type: jobType,
        dedupe_key: null,
        status: "pending",
        priority,
        payload: JSON.stringify(payload),
        max_attempts: maxAttempts,
        run_after: runAfter,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return {
      job: mapJobRow(inserted),
      created: true,
    };
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const inserted = await db
      .insertInto("background_jobs")
      .values({
        job_type: jobType,
        dedupe_key: dedupeKey,
        status: "pending",
        priority,
        payload: JSON.stringify(payload),
        max_attempts: maxAttempts,
        run_after: runAfter,
      })
      .onConflict((oc) =>
        oc
          .column("dedupe_key")
          .where(sql<boolean>`dedupe_key is not null and status in ('pending', 'leased')`)
          .doNothing(),
      )
      .returningAll()
      .executeTakeFirst();

    if (inserted) {
      return {
        job: mapJobRow(inserted),
        created: true,
      };
    }

    const existing = await db
      .selectFrom("background_jobs")
      .selectAll()
      .where("dedupe_key", "=", dedupeKey)
      .where("status", "in", ["pending", "leased"])
      .executeTakeFirst();

    if (existing) {
      return {
        job: mapJobRow(existing),
        created: false,
      };
    }
  }

  throw new Error(`Failed to enqueue or locate active job for dedupeKey "${dedupeKey}"`);
}

export async function claimDueJobs(db: Db, options: ClaimDueJobsOptions): Promise<BackgroundJob[]> {
  const now = options.now ?? new Date();
  const { batchSize, leaseDurationMs, jobTypes } = options;

  if (batchSize <= 0) {
    return [];
  }
  if (!Number.isFinite(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new Error("leaseDurationMs must be a positive number");
  }

  const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);

  return db.transaction().execute(async (trx) => {
    let expireExhausted = trx
      .updateTable("background_jobs")
      .set({
        status: "failed",
        error_message: sql<string>`coalesce(error_message, 'max_attempts_exceeded')`,
        lease_expires_at: null,
        updated_at: now,
      })
      .where("status", "=", "leased")
      .where("lease_expires_at", "<=", now)
      .where((eb) => eb("attempts", ">=", eb.ref("max_attempts")));

    if (jobTypes && jobTypes.length > 0) {
      expireExhausted = expireExhausted.where("job_type", "in", [...jobTypes]);
    }

    await expireExhausted.execute();

    let selectQuery = trx
      .selectFrom("background_jobs")
      .select("id")
      .where((eb) =>
        eb.and([
          eb("attempts", "<", eb.ref("max_attempts")),
          eb.or([
            eb.and([eb("status", "=", "pending"), eb("run_after", "<=", now)]),
            eb.and([eb("status", "=", "leased"), eb("lease_expires_at", "<=", now)]),
          ]),
        ]),
      );

    if (jobTypes && jobTypes.length > 0) {
      selectQuery = selectQuery.where("job_type", "in", [...jobTypes]);
    }

    const dueRows = await selectQuery
      .orderBy("priority", "desc")
      .orderBy("run_after", "asc")
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .limit(batchSize)
      .forUpdate()
      .skipLocked()
      .execute();

    if (dueRows.length === 0) {
      return [];
    }

    const ids = dueRows.map((row) => row.id);
    const updatedRows = await trx
      .updateTable("background_jobs")
      .set({
        status: "leased",
        lease_generation: sql<number>`lease_generation + 1`,
        attempts: sql<number>`attempts + 1`,
        leased_at: now,
        lease_expires_at: leaseExpiresAt,
        updated_at: now,
      })
      .where("id", "in", ids)
      .returningAll()
      .execute();

    const byId = new Map(updatedRows.map((row) => [row.id, mapJobRow(row)]));
    const ordered: BackgroundJob[] = [];
    for (const id of ids) {
      const job = byId.get(id);
      if (job) {
        ordered.push(job);
      }
    }

    return ordered;
  });
}

export async function completeJobWithFencing(
  db: Db,
  input: CompleteJobWithFencingInput,
): Promise<FencedWriteResult> {
  const now = input.now ?? new Date();

  return db.transaction().execute(async (trx) => {
    const updated = await trx
      .updateTable("background_jobs")
      .set({
        status: "completed",
        result: input.result !== undefined ? JSON.stringify(input.result) : null,
        error_message: null,
        lease_expires_at: null,
        completed_at: now,
        updated_at: now,
      })
      .where("id", "=", input.jobId)
      .where("status", "=", "leased")
      .where("lease_generation", "=", input.leaseGeneration)
      .returningAll()
      .executeTakeFirst();

    if (!updated) {
      return {
        applied: false,
        reason: "stale_generation_or_already_completed",
      } as const;
    }

    const mapped = mapJobRow(updated);
    if (input.onCommit) {
      await input.onCommit(trx, mapped);
    }

    return {
      applied: true,
      job: mapped,
    } as const;
  });
}

export async function rescheduleJobWithFencing(
  db: Db,
  input: RescheduleJobWithFencingInput,
): Promise<FencedWriteResult> {
  const now = input.now ?? new Date();

  const updated = await db
    .updateTable("background_jobs")
    .set({
      status: "pending",
      run_after: input.runAfter,
      error_message: input.errorMessage ?? null,
      lease_expires_at: null,
      leased_at: null,
      updated_at: now,
    })
    .where("id", "=", input.jobId)
    .where("status", "=", "leased")
    .where("lease_generation", "=", input.leaseGeneration)
    .returningAll()
    .executeTakeFirst();

  if (!updated) {
    return {
      applied: false,
      reason: "stale_generation_or_already_completed",
    };
  }

  return {
    applied: true,
    job: mapJobRow(updated),
  };
}

export async function failJobWithFencing(
  db: Db,
  input: FailJobWithFencingInput,
): Promise<FencedWriteResult> {
  const now = input.now ?? new Date();

  const updated = await db
    .updateTable("background_jobs")
    .set({
      status: "failed",
      error_message: input.errorMessage,
      lease_expires_at: null,
      updated_at: now,
    })
    .where("id", "=", input.jobId)
    .where("status", "=", "leased")
    .where("lease_generation", "=", input.leaseGeneration)
    .returningAll()
    .executeTakeFirst();

  if (!updated) {
    return {
      applied: false,
      reason: "stale_generation_or_already_completed",
    };
  }

  return {
    applied: true,
    job: mapJobRow(updated),
  };
}

export async function releaseLeaseOnDispatchFailure(
  db: Db,
  input: ReleaseLeaseOnDispatchFailureInput,
): Promise<FencedWriteResult> {
  const now = input.now ?? new Date();
  const retryAt = input.retryAt ?? now;

  const updated = await db
    .updateTable("background_jobs")
    .set({
      status: "pending",
      run_after: retryAt,
      lease_expires_at: null,
      leased_at: null,
      attempts: sql<number>`greatest(attempts - 1, 0)`,
      updated_at: now,
    })
    .where("id", "=", input.jobId)
    .where("status", "=", "leased")
    .where("lease_generation", "=", input.leaseGeneration)
    .returningAll()
    .executeTakeFirst();

  if (!updated) {
    return {
      applied: false,
      reason: "stale_generation_or_already_completed",
    };
  }

  return {
    applied: true,
    job: mapJobRow(updated),
  };
}

export function createDefaultJobHandlers(): JobHandlerRegistry {
  return {
    async echo(ctx) {
      return {
        status: "completed",
        result: {
          echoed: ctx.job.payload,
          leaseGeneration: ctx.job.leaseGeneration,
        },
      };
    },

    async record_marker(ctx) {
      const key = typeof ctx.job.payload.key === "string" ? ctx.job.payload.key.trim() : "";
      if (!key) {
        return {
          status: "failed",
          errorMessage: "record_marker payload requires a non-empty string key",
        };
      }

      const mode = ctx.job.payload.mode === "increment" ? "increment" : "set";
      let resolvedValue = typeof ctx.job.payload.value === "string" ? ctx.job.payload.value : "ok";

      if (typeof ctx.job.payload.probeUrl === "string" && ctx.job.payload.probeUrl.length > 0) {
        const probeNamespace =
          typeof ctx.job.payload.probeNamespace === "string" &&
          ctx.job.payload.probeNamespace.length > 0
            ? ctx.job.payload.probeNamespace
            : "bilibili";
        const probeKind = ctx.job.payload.probeKind === "catalog" ? "catalog" : "platform";

        const response = await ctx.outbound.fetchExternal({
          kind: probeKind,
          namespace: probeNamespace,
          url: ctx.job.payload.probeUrl,
          method: "GET",
        });

        if (response.status >= 500) {
          return {
            status: "retry",
            errorMessage: `upstream_status_${response.status}`,
          };
        }

        resolvedValue = response.body;
      }

      return {
        status: "completed",
        result: {
          key,
          mode,
          value: resolvedValue,
          leaseGeneration: ctx.job.leaseGeneration,
        },
        async onCommit(trx) {
          if (mode === "increment") {
            await trx
              .insertInto("schema_meta")
              .values({
                key,
                value: "1",
                updated_at: ctx.now,
              })
              .onConflict((oc) =>
                oc.column("key").doUpdateSet({
                  value: sql<string>`((schema_meta.value)::integer + 1)::text`,
                  updated_at: ctx.now,
                }),
              )
              .execute();
            return;
          }

          await trx
            .insertInto("schema_meta")
            .values({
              key,
              value: resolvedValue,
              updated_at: ctx.now,
            })
            .onConflict((oc) =>
              oc.column("key").doUpdateSet({
                value: resolvedValue,
                updated_at: ctx.now,
              }),
            )
            .execute();
        },
      };
    },
  };
}
