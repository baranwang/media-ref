import {
  isPlatformNamespace,
  type CatalogNamespace,
  type Namespace,
  type NormalizedSegment,
  type SeasonSnapshot,
} from "@media-ref/client";
import type {
  Database,
  Db,
  ExternalIdNamespaceRow,
  JsonObject,
  SeasonSnapshotRow,
  StoredSegmentJson,
} from "@media-ref/db";
import { sql, type Transaction } from "kysely";
import {
  createDefaultAdapterRegistry,
  isTier2Adapter,
  type AdapterRegistry,
  type CollectionEvidenceResult,
} from "./adapters/index.ts";
import {
  evaluateEvidenceGateStep1,
  evaluateEvidenceGateStep2,
  type CatalogEvidence,
} from "./evidence-gate.ts";
import { enqueueJob, type JobExecutionOutcome, type JobHandler } from "./jobs.ts";
import { acquireAdvisoryLock, ADVISORY_LOCK_CLASSES } from "./locks.ts";
import { extractCollectionDisplay, isUuid, resolveCanonicalMediaById } from "./media-service.ts";

export const INVALIDATION_RECHECK_JOB_TYPE = "invalidation_recheck";
export const DEFAULT_ANONYMOUS_INVALIDATION_THRESHOLD = 3;
export const MAX_INVALIDATION_REASON_LENGTH = 500;
const INVALIDATION_DAILY_LIMIT = 20;

export const LOCKED_ASSOCIATION_DELISTED_ALERT_TYPE = "locked_association_delisted";
export const ASSOCIATION_CONTENT_MISMATCH_ALERT_TYPE = "association_content_mismatch";
export const DELISTED_BY_RECHECK_REASON = "confirmed_delisted_by_recheck";

export type InvalidationErrorCode =
  | "INVALID_ASSOCIATION_ID"
  | "INVALID_REASON"
  | "INVALID_THRESHOLD"
  | "INVALIDATION_LIMIT_REACHED"
  | "ASSOCIATION_NOT_FOUND"
  | "ASSOCIATION_ALREADY_DELISTED"
  | "ASSOCIATION_NOT_CONFIRMED";

export class InvalidationError extends Error {
  readonly code: InvalidationErrorCode;
  readonly status: number;

  constructor(code: InvalidationErrorCode, status: number, message: string) {
    super(message);
    this.name = "InvalidationError";
    this.code = code;
    this.status = status;
  }
}

export type InvalidationReporterInput =
  | {
      reporterType: "user";
      reporterUserId: string;
    }
  | {
      reporterType: "api_key";
      reporterKeyId: string;
      reporterUserId?: string | null;
    };

export type ReportInvalidAssociationInput = InvalidationReporterInput & {
  associationId: string;
  reason?: string | null;
  anonymousInvalidationThreshold?: number;
  now?: Date;
};

export interface ReportInvalidAssociationResult {
  reportId: string;
  deduplicated: boolean;
  triggered: boolean;
  jobId: string | null;
  reportCount: number;
  threshold: number;
}

export function resolveAnonymousInvalidationThreshold(raw?: number): number {
  if (raw === undefined) {
    return DEFAULT_ANONYMOUS_INVALIDATION_THRESHOLD;
  }
  if (!Number.isInteger(raw) || raw < 1) {
    throw new InvalidationError(
      "INVALID_THRESHOLD",
      400,
      "anonymousInvalidationThreshold must be a positive integer",
    );
  }
  return raw;
}

function normalizeReason(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > MAX_INVALIDATION_REASON_LENGTH) {
    throw new InvalidationError(
      "INVALID_REASON",
      400,
      `reason must be at most ${MAX_INVALIDATION_REASON_LENGTH} characters`,
    );
  }
  return trimmed;
}

export async function reportInvalidAssociation(
  dbWrite: Db,
  input: ReportInvalidAssociationInput,
): Promise<ReportInvalidAssociationResult> {
  const associationId = input.associationId.trim().toLowerCase();
  if (!isUuid(associationId)) {
    throw new InvalidationError(
      "INVALID_ASSOCIATION_ID",
      400,
      "Association ID must be a valid UUID",
    );
  }

  const reason = normalizeReason(input.reason);
  const anonThreshold = resolveAnonymousInvalidationThreshold(input.anonymousInvalidationThreshold);
  const now = input.now ?? new Date();
  const dedupeKey = `${INVALIDATION_RECHECK_JOB_TYPE}:${associationId}`;

  return dbWrite.transaction().execute(async (trx) => {
    await acquireAdvisoryLock(trx, ADVISORY_LOCK_CLASSES.INVALIDATION, associationId);

    const association = await trx
      .selectFrom("associations")
      .where("is_external_id", "=", false)
      .select(["id", "status"])
      .where("id", "=", associationId)
      .executeTakeFirst();

    if (!association) {
      throw new InvalidationError("ASSOCIATION_NOT_FOUND", 404, "Association not found");
    }

    if (association.status === "delisted") {
      throw new InvalidationError(
        "ASSOCIATION_ALREADY_DELISTED",
        409,
        "Association is already delisted",
      );
    }

    if (association.status !== "confirmed") {
      throw new InvalidationError(
        "ASSOCIATION_NOT_CONFIRMED",
        409,
        `Association in status "${association.status}" cannot be reported for invalidation`,
      );
    }

    const reporterUserId =
      input.reporterType === "user"
        ? input.reporterUserId
        : (input.reporterUserId ??
          (
            await trx
              .selectFrom("apikey")
              .select("referenceId")
              .where("id", "=", input.reporterKeyId)
              .executeTakeFirstOrThrow()
          ).referenceId);
    const existing =
      input.reporterType === "api_key"
        ? await trx
            .selectFrom("invalidation_reports")
            .select("id")
            .where("association_id", "=", associationId)
            .where("reporter_type", "=", "api_key")
            .where("reporter_key_id", "=", input.reporterKeyId)
            .where("recheck_job_id", "is", null)
            .executeTakeFirst()
        : undefined;

    if (!existing) {
      // Reports on different associations share the same account quota.
      await trx
        .selectFrom("user")
        .select("id")
        .where("id", "=", reporterUserId)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      const day = new Date(now);
      day.setUTCHours(0, 0, 0, 0);
      const today = await trx
        .selectFrom("invalidation_reports")
        .select((eb) => eb.fn.countAll().as("count"))
        .where("reporter_user_id", "=", reporterUserId)
        .where("created_at", ">=", day)
        .where("created_at", "<", new Date(day.getTime() + 86_400_000))
        .executeTakeFirstOrThrow();
      if (Number(today.count) >= INVALIDATION_DAILY_LIMIT) {
        throw new InvalidationError(
          "INVALIDATION_LIMIT_REACHED",
          429,
          `At most ${INVALIDATION_DAILY_LIMIT} invalidation reports per day`,
        );
      }
    }

    if (input.reporterType === "user") {
      const enqueued = await enqueueJob(trx, {
        jobType: INVALIDATION_RECHECK_JOB_TYPE,
        payload: { associationId },
        dedupeKey,
        runAfter: now,
      });

      const inserted = await trx
        .insertInto("invalidation_reports")
        .values({
          association_id: associationId,
          reporter_type: "user",
          reporter_user_id: input.reporterUserId,
          reporter_key_id: null,
          reason,
          recheck_job_id: enqueued.job.id,
          created_at: now,
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      // Close any open anonymous reports in the current reporting cycle since a re-check is now queued.
      await trx
        .updateTable("invalidation_reports")
        .set({ recheck_job_id: enqueued.job.id })
        .where("association_id", "=", associationId)
        .where("recheck_job_id", "is", null)
        .execute();

      return {
        reportId: inserted.id,
        deduplicated: false,
        triggered: true,
        jobId: enqueued.job.id,
        reportCount: 1,
        threshold: 1,
      };
    }

    const { id: reportId } =
      existing ??
      (await trx
        .insertInto("invalidation_reports")
        .values({
          association_id: associationId,
          reporter_type: "api_key",
          reporter_user_id: reporterUserId,
          reporter_key_id: input.reporterKeyId,
          reason,
          recheck_job_id: null,
          created_at: now,
        })
        .returning("id")
        .executeTakeFirstOrThrow());
    const deduplicated = Boolean(existing);

    const countRow = await trx
      .selectFrom("invalidation_reports")
      .select((eb) => eb.fn.count("reporter_user_id").distinct().as("count"))
      .where("association_id", "=", associationId)
      .where("reporter_type", "=", "api_key")
      .where("recheck_job_id", "is", null)
      .executeTakeFirstOrThrow();

    const reportCount = Number(countRow.count);

    if (reportCount >= anonThreshold) {
      const enqueued = await enqueueJob(trx, {
        jobType: INVALIDATION_RECHECK_JOB_TYPE,
        payload: { associationId },
        dedupeKey,
        runAfter: now,
      });

      await trx
        .updateTable("invalidation_reports")
        .set({ recheck_job_id: enqueued.job.id })
        .where("association_id", "=", associationId)
        .where("reporter_type", "=", "api_key")
        .where("recheck_job_id", "is", null)
        .execute();

      return {
        reportId,
        deduplicated,
        triggered: true,
        jobId: enqueued.job.id,
        reportCount,
        threshold: anonThreshold,
      };
    }

    return {
      reportId,
      deduplicated,
      triggered: false,
      jobId: null,
      reportCount,
      threshold: anonThreshold,
    };
  });
}

export interface InvalidationRecheckJobOptions {
  adapterRegistry?: AdapterRegistry;
}

function parseJsonObject(raw: unknown): JsonObject {
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as JsonObject;
      }
      return {};
    } catch {
      return {};
    }
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as JsonObject;
  }
  return {};
}

function parseSeasonsSnapshot(raw: unknown): SeasonSnapshot[] {
  let entries: SeasonSnapshotRow[] = [];
  if (Array.isArray(raw)) {
    entries = raw as SeasonSnapshotRow[];
  } else if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        entries = parsed as SeasonSnapshotRow[];
      }
    } catch {
      entries = [];
    }
  }
  return entries.map((entry) => ({
    season: entry.season,
    episodeCount: entry.episodeCount,
    airYear: entry.airYear ?? null,
  }));
}

async function recordOpenAssociationReviewAlert(
  trx: Transaction<Database>,
  input: {
    alertType: string;
    mediaId: string;
    associationId: string;
    details: JsonObject;
  },
): Promise<{ id: string; created: boolean }> {
  const existing = await trx
    .selectFrom("review_alerts")
    .select(["id", "details"])
    .where("association_id", "=", input.associationId)
    .where("alert_type", "=", input.alertType)
    .where("status", "=", "open")
    .orderBy("created_at", "desc")
    .executeTakeFirst();

  if (existing) {
    const prevDetails = parseJsonObject(existing.details);
    const mergedDetails: JsonObject = {
      ...prevDetails,
      ...input.details,
      firstDetectedAt:
        prevDetails.firstDetectedAt ?? prevDetails.checkedAt ?? input.details.checkedAt,
    };
    await trx
      .updateTable("review_alerts")
      .set({ details: JSON.stringify(mergedDetails) })
      .where("id", "=", existing.id)
      .execute();
    return { id: existing.id, created: false };
  }

  const inserted = await trx
    .insertInto("review_alerts")
    .values({
      alert_type: input.alertType,
      media_id: input.mediaId,
      association_id: input.associationId,
      status: "open",
      details: JSON.stringify(input.details),
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  return { id: inserted.id, created: true };
}

export async function loadCatalogEvidenceForMedia(
  db: Db,
  initialMediaId: string,
): Promise<CatalogEvidence | null> {
  const mediaRow = await resolveCanonicalMediaById(db, initialMediaId);
  if (!mediaRow) {
    return null;
  }

  const externalIdRows = await db
    .selectFrom("associations")
    .where("is_external_id", "=", true)
    .select(["namespace", "native_id"])
    .where("media_id", "=", mediaRow.id)
    .$narrowType<{ namespace: ExternalIdNamespaceRow }>()
    .execute();

  const externalIds: Partial<Record<Namespace, string>> = {};
  for (const row of externalIdRows) {
    externalIds[row.namespace] = row.native_id;
  }

  let catalogNamespace: CatalogNamespace = "tmdb";
  let canonicalId = mediaRow.id;
  if (externalIds.tmdb) {
    catalogNamespace = "tmdb";
    canonicalId = externalIds.tmdb;
  } else if (mediaRow.baseline && externalIds[mediaRow.baseline]) {
    catalogNamespace = mediaRow.baseline;
    canonicalId = externalIds[mediaRow.baseline]!;
  } else if (mediaRow.baseline) {
    catalogNamespace = mediaRow.baseline;
    canonicalId = mediaRow.id;
  }

  return {
    namespace: catalogNamespace,
    canonicalId,
    mediaType: mediaRow.type,
    title: mediaRow.title,
    originalTitle: mediaRow.original_title,
    year: mediaRow.year,
    seasons: parseSeasonsSnapshot(mediaRow.seasons),
    externalIds,
  };
}

async function handleConfirmedNotFoundInTx(
  trx: Transaction<Database>,
  input: {
    associationId: string;
    mediaId: string;
    namespace: Database["associations"]["namespace"];
    nativeId: string;
    platformReason: string | null;
    jobId: string;
    now: Date;
  },
): Promise<{
  outcome: "skipped" | "locked_alert" | "delisted";
  platformMarkedNotFound: boolean;
}> {
  await acquireAdvisoryLock(
    trx,
    ADVISORY_LOCK_CLASSES.MEDIA_NAMESPACE,
    `${input.mediaId}:${input.namespace}`,
  );

  const currentAssoc = await trx
    .selectFrom("associations")
    .where("is_external_id", "=", false)
    .select(["id", "media_id", "namespace", "native_id", "variant_id", "status", "locked"])
    .where("id", "=", input.associationId)
    .forUpdate()
    .executeTakeFirst();

  if (!currentAssoc || currentAssoc.status !== "confirmed") {
    return { outcome: "skipped", platformMarkedNotFound: false };
  }

  if (currentAssoc.locked) {
    await recordOpenAssociationReviewAlert(trx, {
      alertType: LOCKED_ASSOCIATION_DELISTED_ALERT_TYPE,
      mediaId: currentAssoc.media_id,
      associationId: currentAssoc.id,
      details: {
        reason: "platform_returned_not_found",
        namespace: currentAssoc.namespace,
        nativeId: currentAssoc.native_id,
        platformReason: input.platformReason,
        checkedAt: input.now.toISOString(),
        jobId: input.jobId,
      },
    });
    return { outcome: "locked_alert", platformMarkedNotFound: false };
  }

  const segmentRows = await trx
    .selectFrom("segments")
    .select([
      "season",
      "episode_start",
      "episode_end",
      "target_episode_start",
      "baseline",
      "non_linear",
      "needs_review",
    ])
    .where("association_id", "=", currentAssoc.id)
    .orderBy("season", "asc")
    .orderBy("episode_start", "asc")
    .orderBy("id", "asc")
    .execute();

  const snapshotSegments: StoredSegmentJson[] = segmentRows.map((seg) => ({
    season: seg.season,
    episodeStart: seg.episode_start,
    episodeEnd: seg.episode_end,
    targetEpisodeStart: seg.target_episode_start,
    baseline: seg.baseline,
    nonLinear: Boolean(seg.non_linear),
    needsReview: Boolean(seg.needs_review),
  }));

  const maxRevRow = await trx
    .selectFrom("association_revisions")
    .select(sql<number | null>`max(revision_number)`.as("max_rev"))
    .where("association_id", "=", currentAssoc.id)
    .executeTakeFirst();

  const nextRevisionNumber = (maxRevRow?.max_rev ?? 0) + 1;

  const newRevision = await trx
    .insertInto("association_revisions")
    .values({
      association_id: currentAssoc.id,
      revision_number: nextRevisionNumber,
      change_request_id: null,
      variant_id: currentAssoc.variant_id,
      status: "delisted",
      segments: JSON.stringify(snapshotSegments),
      actor_user_id: null,
      reason: DELISTED_BY_RECHECK_REASON,
      created_at: input.now,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  await trx
    .updateTable("associations")
    .set({
      status: "delisted",
      needs_review: false,
      current_revision_id: newRevision.id,
      updated_at: input.now,
    })
    .where("id", "=", currentAssoc.id)
    .execute();

  let platformMarkedNotFound = false;
  if (isPlatformNamespace(currentAssoc.namespace)) {
    const remainingRow = await trx
      .selectFrom("associations")
      .where("is_external_id", "=", false)
      .select(sql<string>`count(*)`.as("count"))
      .where("media_id", "=", currentAssoc.media_id)
      .where("namespace", "=", currentAssoc.namespace)
      .where("status", "=", "confirmed")
      .executeTakeFirstOrThrow();

    if (Number(remainingRow.count) === 0) {
      await trx
        .insertInto("platform_checks")
        .values({
          media_id: currentAssoc.media_id,
          platform: currentAssoc.namespace,
          status: "not_found",
          checked_at: input.now,
          attempt_count: 1,
          next_retry_at: null,
          updated_at: input.now,
        })
        .onConflict((oc) =>
          oc.columns(["media_id", "platform"]).doUpdateSet({
            status: "not_found",
            checked_at: input.now,
            attempt_count: sql<number>`platform_checks.attempt_count + 1`,
            updated_at: input.now,
          }),
        )
        .execute();
      platformMarkedNotFound = true;
    }
  }

  return { outcome: "delisted", platformMarkedNotFound };
}

type CheckedAssociation = {
  id: string;
  media_id: string;
  namespace: Namespace;
  native_id: string;
  current_revision_id: string | null;
};

function lockCheckedAssociation(trx: Transaction<Database>, association: CheckedAssociation) {
  return trx
    .selectFrom("associations")
    .select(["id", "media_id", "needs_review", "locked"])
    .where("id", "=", association.id)
    .where("media_id", "=", association.media_id)
    .where("namespace", "=", association.namespace)
    .where("native_id", "=", association.native_id)
    .where("current_revision_id", "is not distinct from", association.current_revision_id)
    .where("is_external_id", "=", false)
    .where("status", "=", "confirmed")
    .forUpdate()
    .executeTakeFirst();
}

const STEP1_MISMATCH = "evidence_gate_step1_mismatch";

function mismatchAlerts(trx: Transaction<Database>, association: CheckedAssociation) {
  return trx
    .selectFrom("review_alerts")
    .where("association_id", "=", association.id)
    .where("media_id", "=", association.media_id)
    .where("alert_type", "=", ASSOCIATION_CONTENT_MISMATCH_ALERT_TYPE);
}

async function canAttributeRepeatMismatch(
  trx: Transaction<Database>,
  association: CheckedAssociation,
) {
  if (!association.current_revision_id) return false;
  const query = mismatchAlerts(trx, association)
    .select(["details", "status", "resolved_by_user_id"])
    .limit(2)
    .forUpdate();
  let alerts = await query.where("status", "=", "open").execute();
  // A closed, unversioned alert could never have authorized recovery. Use it to explain a new
  // mismatch only if it is the association's sole alert of this type, never an old cycle.
  if (!alerts.length) alerts = await query.execute();
  const [alert] = alerts;
  if (!alert || alerts.length !== 1) return false;
  const evidence = parseJsonObject(alert.details);
  if (
    alert.status === "resolved" &&
    (alert.resolved_by_user_id === null || "revisionId" in evidence)
  )
    return false;
  if (
    evidence.reason === STEP1_MISMATCH &&
    evidence.revisionId === association.current_revision_id
  ) {
    return evidence.pendingRecovery !== false;
  }
  if (
    "revisionId" in evidence ||
    "checkedRevisionId" in evidence ||
    "pendingRecovery" in evidence ||
    evidence.reason !== STEP1_MISMATCH ||
    evidence.namespace !== association.namespace ||
    evidence.nativeId !== association.native_id ||
    typeof evidence.jobId !== "string" ||
    !isUuid(evidence.jobId)
  )
    return false;

  // Approval creates a clean association. With this as its only revision, a genuine earlier
  // confirmed-content mismatch cannot belong to an older revision or to a failed seed check.
  const revisions = await trx
    .selectFrom("association_revisions as r")
    .leftJoin("change_requests as cr", "cr.id", "r.change_request_id")
    .select([
      "r.id",
      "r.status",
      "r.revision_number",
      "cr.applied_association_id",
      "cr.applied_revision_id",
    ])
    .where("r.association_id", "=", association.id)
    .limit(2)
    .execute();
  const [initial] = revisions;
  if (
    revisions.length !== 1 ||
    !initial ||
    initial.id !== association.current_revision_id ||
    initial.revision_number !== 1 ||
    initial.status !== "confirmed" ||
    initial.applied_association_id !== association.id ||
    initial.applied_revision_id !== initial.id
  )
    return false;
  const job = await trx
    .selectFrom("background_jobs")
    .select("id")
    .where("id", "=", evidence.jobId)
    .where("job_type", "=", INVALIDATION_RECHECK_JOB_TYPE)
    .where("status", "=", "completed")
    .where(sql<string>`payload->>'associationId'`, "=", association.id)
    .where(sql<string>`result->>'associationId'`, "=", association.id)
    .where(sql<string>`result->>'outcome'`, "=", "content_mismatch")
    .executeTakeFirst();
  return Boolean(job);
}

async function recoverMismatchInTx(
  trx: Transaction<Database>,
  association: CheckedAssociation,
  jobId: string,
  now: Date,
) {
  const revision = association.current_revision_id;
  if (!revision) return false;
  const rows = await mismatchAlerts(trx, association)
    .select(["id", "status", "details", "resolved_by_user_id"])
    .where((eb) =>
      eb.or([eb("status", "=", "open"), eb(sql<string>`details->>'revisionId'`, "=", revision)]),
    )
    .where(sql<boolean>`not (details @> '{"pendingRecovery":false}'::jsonb)`)
    .forUpdate()
    .execute();
  const candidates = rows.map((row) => ({ ...row, details: parseJsonObject(row.details) }));
  const attributed = candidates.filter(
    ({ details }) => details.reason === STEP1_MISMATCH && details.revisionId === revision,
  );
  const open = candidates.filter((row) => row.status === "open");
  if (
    !attributed.length ||
    open.some(
      (row) =>
        !attributed.includes(row) &&
        (row.details.checkedRevisionId !== revision || "revisionId" in row.details),
    )
  )
    return false;

  let owners = attributed.filter(
    (row) => row.status === "open" || row.details.pendingRecovery === true,
  );
  if (!owners.length) {
    // The old RPC could re-close an already recovered alert. Without a receipt accept only one
    // manual closure, and only when no earlier pass could have spent its proof.
    if (attributed.length !== 1 || attributed[0]!.resolved_by_user_id === null) return false;
    const priorPass = await trx
      .selectFrom("background_jobs")
      .select("id")
      .where("job_type", "=", INVALIDATION_RECHECK_JOB_TYPE)
      .where("status", "=", "completed")
      .where("id", "!=", jobId)
      .where(sql<string>`payload->>'associationId'`, "=", association.id)
      .where(sql<string>`result->>'outcome'`, "=", "still_valid")
      .where(sql<boolean>`result ? 'matchedBy' and not (result ? 'checkedRevisionId')`)
      .executeTakeFirst();
    if (priorPass) return false;
    owners = attributed;
  }
  await trx
    .updateTable("review_alerts")
    .set({
      status: "resolved",
      resolved_at: sql`case when status = 'open' then ${now}::timestamptz else resolved_at end`,
      details: sql`details || '{"pendingRecovery":false}'::jsonb`,
    })
    .where("id", "in", [...new Set([...owners, ...open].map((r) => r.id))])
    .execute();
  return true;
}

async function flagAssociationContentMismatchInTx(
  trx: Transaction<Database>,
  input: {
    association: CheckedAssociation;
    details: JsonObject;
    now: Date;
  },
): Promise<boolean> {
  const currentAssoc = await lockCheckedAssociation(trx, input.association);
  if (!currentAssoc) {
    return false;
  }

  await trx
    .updateTable("associations")
    .set({
      needs_review: true,
      updated_at: input.now,
    })
    .where("id", "=", currentAssoc.id)
    .execute();

  const ownsFlag =
    !currentAssoc.needs_review || (await canAttributeRepeatMismatch(trx, input.association));
  await recordOpenAssociationReviewAlert(trx, {
    alertType: ASSOCIATION_CONTENT_MISMATCH_ALERT_TYPE,
    mediaId: currentAssoc.media_id,
    associationId: currentAssoc.id,
    details: {
      ...input.details,
      checkedRevisionId: input.association.current_revision_id,
      ...(ownsFlag
        ? {
            reason: STEP1_MISMATCH,
            pendingRecovery: true,
            revisionId: input.association.current_revision_id,
          }
        : {}),
    },
  });

  return true;
}

export function createInvalidationRecheckJobHandler(
  options: InvalidationRecheckJobOptions = {},
): JobHandler {
  const adapterRegistry = options.adapterRegistry ?? createDefaultAdapterRegistry();

  return async (ctx): Promise<JobExecutionOutcome> => {
    const rawAssociationId = ctx.job.payload.associationId;
    if (typeof rawAssociationId !== "string" || !isUuid(rawAssociationId)) {
      return {
        status: "failed",
        errorMessage: "invalidation_recheck job payload requires a valid associationId UUID",
      };
    }

    const association = await ctx.db
      .selectFrom("associations")
      .where("is_external_id", "=", false)
      .select([
        "id",
        "media_id",
        "namespace",
        "native_id",
        "status",
        "locked",
        "current_revision_id",
      ])
      .where("id", "=", rawAssociationId)
      .executeTakeFirst();

    if (!association) {
      return {
        status: "completed",
        result: {
          associationId: rawAssociationId,
          skipped: true,
          reason: "association_not_found",
        },
      };
    }

    if (association.status !== "confirmed") {
      return {
        status: "completed",
        result: {
          associationId: association.id,
          skipped: true,
          reason: `association_status_${association.status}`,
        },
      };
    }

    const adapter = adapterRegistry.get(association.namespace);
    if (!adapter || !isTier2Adapter(adapter)) {
      return {
        status: "completed",
        result: {
          associationId: association.id,
          skipped: true,
          reason: "adapter_tier_1_manual_review",
        },
      };
    }

    let collectionResult: CollectionEvidenceResult;
    try {
      collectionResult = await adapter.fetchCollection(association.native_id, ctx.outbound);
    } catch (error) {
      return {
        status: "retry",
        errorMessage:
          error instanceof Error ? error.message : "Failed to re-check platform collection",
      };
    }

    // Case A: transient_error (timeout / 5xx) -> retry with backoff, NEVER delist
    if (collectionResult.status === "transient_error") {
      return {
        status: "retry",
        ...(collectionResult.retryAfterMs !== undefined
          ? { delayMs: collectionResult.retryAfterMs }
          : {}),
        errorMessage: collectionResult.reason,
      };
    }

    // Case B: platform explicitly confirms collection does not exist
    if (collectionResult.status === "not_found") {
      return {
        status: "completed",
        result: {
          associationId: association.id,
          outcome: association.locked ? "locked_alert_created" : "delisted",
          reason: collectionResult.reason ?? "not_found",
        },
        async onCommit(trx) {
          await handleConfirmedNotFoundInTx(trx, {
            associationId: association.id,
            mediaId: association.media_id,
            namespace: association.namespace,
            nativeId: association.native_id,
            platformReason: collectionResult.reason ?? null,
            jobId: ctx.job.id,
            now: ctx.now,
          });
        },
      };
    }

    // Case C: page still exists -> re-run Evidence Gate Step 1 against current catalog snapshot
    const [catalogEvidence, segmentRows] = await Promise.all([
      loadCatalogEvidenceForMedia(ctx.db, association.media_id),
      ctx.db
        .selectFrom("segments")
        .select([
          "season",
          "episode_start",
          "episode_end",
          "target_episode_start",
          "baseline",
          "non_linear",
          "needs_review",
        ])
        .where("association_id", "=", association.id)
        .orderBy("season", "asc")
        .orderBy("episode_start", "asc")
        .orderBy("id", "asc")
        .execute(),
    ]);
    if (!catalogEvidence) {
      return {
        status: "completed",
        result: {
          associationId: association.id,
          outcome: "still_valid",
          reason: "media_snapshot_unavailable",
        },
      };
    }

    const segments: NormalizedSegment[] = segmentRows.map((seg) => ({
      season: seg.season,
      episodeStart: seg.episode_start,
      episodeEnd: seg.episode_end,
      targetEpisodeStart: seg.target_episode_start,
      baseline: seg.baseline,
      nonLinear: Boolean(seg.non_linear),
      needsReview: Boolean(seg.needs_review),
    }));

    const step1 = evaluateEvidenceGateStep1(catalogEvidence, collectionResult.info, { segments });
    // With segments the episode count is checked against them in Step 2; only that part reruns here,
    // so a collection that lost the positions its segments claim is still caught.
    const countConflicts =
      step1.decision === "pass"
        ? evaluateEvidenceGateStep2({
            catalog: catalogEvidence,
            collection: collectionResult.info,
            segments,
            setDefaultVariant: false,
            variantDescription: null,
            step1,
          }).conflicts.filter((c) => c.field === "featureEpisodeCount")
        : [];
    const conflicts = [...step1.conflicts, ...countConflicts];
    if (conflicts.length === 0) {
      const display = extractCollectionDisplay({ collection: collectionResult.info });
      return {
        status: "completed",
        result: {
          associationId: association.id,
          outcome: "still_valid",
          matchedBy: step1.matchedBy,
          checkedRevisionId: association.current_revision_id,
        },
        async onCommit(trx) {
          const current = await lockCheckedAssociation(trx, association);
          if (!current) return;
          const resolved =
            current.needs_review &&
            !current.locked &&
            (await recoverMismatchInTx(trx, association, ctx.job.id, ctx.now));
          if (resolved || Object.keys(display).length > 0) {
            await trx
              .updateTable("associations")
              .set({
                ...display,
                ...(resolved ? { needs_review: false, updated_at: ctx.now } : {}),
              })
              .where("id", "=", association.id)
              .execute();
          }
        },
      };
    }

    const mismatchDetails: JsonObject = {
      namespace: association.namespace,
      nativeId: association.native_id,
      conflicts,
      reasons: conflicts.map((c) => c.message),
      collection: {
        namespace: collectionResult.info.namespace,
        canonicalId: collectionResult.info.canonicalId,
        title: collectionResult.info.title,
        originalTitle: collectionResult.info.originalTitle ?? null,
        year: collectionResult.info.year,
        mediaType: collectionResult.info.mediaType,
        featureEpisodeCount: collectionResult.info.featureEpisodeCount,
      },
      checkedAt: ctx.now.toISOString(),
      jobId: ctx.job.id,
    };

    return {
      status: "completed",
      result: {
        associationId: association.id,
        outcome: "content_mismatch",
        conflicts: conflicts.map((conflict) => conflict.code),
      },
      async onCommit(trx) {
        await flagAssociationContentMismatchInTx(trx, {
          association,
          details: mismatchDetails,
          now: ctx.now,
        });
      },
    };
  };
}
