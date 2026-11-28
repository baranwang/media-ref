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
  /** Initial deadline used to take the execution lease once per exploration delivery. */
  dispatchLeaseExpiresAt?: string;
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
  leaseDurationMsByType?: Readonly<Record<string, number>>;
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
  jobType?: string;
  dispatchLeaseExpiresAt?: string;
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
    /** When this lease ends; writes after that are fenced out. */
    leaseExpiresAt: Date | null;
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

/** Exchanges the dispatch deadline for an execution deadline, without changing the generation. */
export async function startLeasedJob(
  db: Db,
  message: JobQueueMessage,
  now: Date,
  durationMs: number,
): Promise<BackgroundJob | null> {
  if (message.dispatchLeaseExpiresAt === undefined) {
    // Re-dispatch pre-upgrade messages with a deadline, even when the configured lease changed.
    await releaseLeaseOnDispatchFailure(db, {
      jobId: message.jobId,
      jobType: message.jobType,
      leaseGeneration: message.leaseGeneration,
      now,
    });
    return null;
  }
  const dispatchExpiry = new Date(message.dispatchLeaseExpiresAt);
  // Even an immediate delivery must invalidate the original deadline for its duplicates.
  const expiry = new Date(Math.max(dispatchExpiry.getTime() + 1, now.getTime() + durationMs));
  const row = await db
    .updateTable("background_jobs")
    .set({ lease_expires_at: expiry, updated_at: now })
    .where("id", "=", message.jobId)
    .where("job_type", "=", message.jobType)
    .where("status", "=", "leased")
    .where("lease_generation", "=", message.leaseGeneration)
    .where("lease_expires_at", ">", now)
    .where("lease_expires_at", "=", dispatchExpiry)
    .returningAll()
    .executeTakeFirst();
  return row ? mapJobRow(row) : null;
}

export const SEED_EVIDENCE_CHECK_JOB_TYPE = "seed_evidence_check";

export async function enqueueJob(
  db: Db | Transaction<Database>,
  input: EnqueueJobInput,
): Promise<EnqueueJobResult> {
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

/**
 * Enqueues a one-time `seed_evidence_check` job for a `seed_unconfirmed` association when no
 * prior job (pending, leased, completed, or failed) exists for that association.
 */
export async function enqueueSeedEvidenceCheckForAssociation(
  db: Db | Transaction<Database>,
  input: { associationId: string; mediaId: string; now?: Date },
): Promise<boolean> {
  const dedupeKey = `${SEED_EVIDENCE_CHECK_JOB_TYPE}:${input.associationId}`;
  const existing = await db
    .selectFrom("background_jobs")
    .select("id")
    .where("job_type", "=", SEED_EVIDENCE_CHECK_JOB_TYPE)
    .where("dedupe_key", "=", dedupeKey)
    .executeTakeFirst();

  if (existing) {
    return false;
  }

  const res = await enqueueJob(db, {
    jobType: SEED_EVIDENCE_CHECK_JOB_TYPE,
    dedupeKey,
    payload: {
      associationId: input.associationId,
      mediaId: input.mediaId,
    },
    runAfter: input.now ?? new Date(),
  });
  return res.created;
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

  const defaultExpiry = new Date(now.getTime() + leaseDurationMs);
  const overrides = Object.entries(options.leaseDurationMsByType ?? {}).map(([type, duration]) => {
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("Each job type's lease duration must be a positive number");
    }
    return sql`when ${type} then ${new Date(now.getTime() + duration)}::timestamptz`;
  });
  const leaseExpiresAt = overrides.length
    ? sql<Date>`case job_type ${sql.join(overrides, sql` `)} else ${defaultExpiry}::timestamptz end`
    : defaultExpiry;

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
    .$if(input.jobType !== undefined, (qb) => qb.where("job_type", "=", input.jobType!))
    .$if(input.dispatchLeaseExpiresAt !== undefined, (qb) =>
      qb.where("lease_expires_at", "=", new Date(input.dispatchLeaseExpiresAt!)),
    )
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
