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
import { evaluateEvidenceGateStep1, type CatalogEvidence } from "./evidence-gate.ts";
import { enqueueJob, type JobExecutionOutcome, type JobHandler } from "./jobs.ts";
import { acquireAdvisoryLock, ADVISORY_LOCK_CLASSES } from "./locks.ts";
import { extractCollectionDisplay, isUuid } from "./media-service.ts";

export const INVALIDATION_RECHECK_JOB_TYPE = "invalidation_recheck";
export const DEFAULT_ANONYMOUS_INVALIDATION_THRESHOLD = 3;
export const MAX_INVALIDATION_REASON_LENGTH = 500;

export const LOCKED_ASSOCIATION_DELISTED_ALERT_TYPE = "locked_association_delisted";
export const ASSOCIATION_CONTENT_MISMATCH_ALERT_TYPE = "association_content_mismatch";
export const DELISTED_BY_RECHECK_REASON = "confirmed_delisted_by_recheck";

export type InvalidationErrorCode =
  | "INVALID_ASSOCIATION_ID"
  | "INVALID_REASON"
  | "INVALID_THRESHOLD"
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
  const associationId = input.associationId.trim();
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
          ...(input.now ? { created_at: now } : {}),
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

    const inserted = await trx
      .insertInto("invalidation_reports")
      .values({
        association_id: associationId,
        reporter_type: "api_key",
        reporter_user_id: input.reporterUserId ?? null,
        reporter_key_id: input.reporterKeyId,
        reason,
        recheck_job_id: null,
        ...(input.now ? { created_at: now } : {}),
      })
      .onConflict((oc) =>
        oc
          .columns(["association_id", "reporter_key_id"])
          .where(sql<boolean>`reporter_type = 'api_key' and recheck_job_id is null`)
          .doNothing(),
      )
      .returning("id")
      .executeTakeFirst();

    let reportId: string;
    const deduplicated = !inserted;
    if (inserted) {
      reportId = inserted.id;
    } else {
      const existing = await trx
        .selectFrom("invalidation_reports")
        .select("id")
        .where("association_id", "=", associationId)
        .where("reporter_type", "=", "api_key")
        .where("reporter_key_id", "=", input.reporterKeyId)
        .where("recheck_job_id", "is", null)
        .executeTakeFirstOrThrow();
      reportId = existing.id;
    }

    const countRow = await trx
      .selectFrom("invalidation_reports")
      .select(sql<string>`count(*)`.as("count"))
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

async function loadCatalogEvidenceForMedia(
  db: Db,
  initialMediaId: string,
): Promise<CatalogEvidence | null> {
  let currentId = initialMediaId;
  let mediaRow: {
    id: string;
    type: "movie" | "tv";
    baseline: CatalogNamespace | null;
    title: string;
    original_title: string | null;
    year: number | null;
    seasons: SeasonSnapshotRow[];
    merged_into_media_id: string | null;
  } | null = null;

  for (let hop = 0; hop < 10; hop += 1) {
    const row = await db
      .selectFrom("media")
      .select([
        "id",
        "type",
        "baseline",
        "title",
        "original_title",
        "year",
        "seasons",
        "merged_into_media_id",
      ])
      .where("id", "=", currentId)
      .executeTakeFirst();

    if (!row) {
      return null;
    }

    if (!row.merged_into_media_id || row.merged_into_media_id === row.id) {
      mediaRow = row;
      break;
    }
    currentId = row.merged_into_media_id;
  }

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

async function flagAssociationContentMismatchInTx(
  trx: Transaction<Database>,
  input: {
    associationId: string;
    details: JsonObject;
    now: Date;
  },
): Promise<boolean> {
  const currentAssoc = await trx
    .selectFrom("associations")
    .where("is_external_id", "=", false)
    .select(["id", "media_id", "status"])
    .where("id", "=", input.associationId)
    .forUpdate()
    .executeTakeFirst();

  if (!currentAssoc || currentAssoc.status !== "confirmed") {
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

  await recordOpenAssociationReviewAlert(trx, {
    alertType: ASSOCIATION_CONTENT_MISMATCH_ALERT_TYPE,
    mediaId: currentAssoc.media_id,
    associationId: currentAssoc.id,
    details: input.details,
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
      .select(["id", "media_id", "namespace", "native_id", "status", "locked"])
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
    if (step1.decision === "pass") {
      const display = extractCollectionDisplay({ collection: collectionResult.info });
      if (Object.keys(display).length > 0) {
        await ctx.db
          .updateTable("associations")
          .set(display)
          .where("id", "=", association.id)
          .execute();
      }
      return {
        status: "completed",
        result: {
          associationId: association.id,
          outcome: "still_valid",
          matchedBy: step1.matchedBy,
        },
      };
    }

    const mismatchDetails: JsonObject = {
      reason: "evidence_gate_step1_mismatch",
      namespace: association.namespace,
      nativeId: association.native_id,
      conflicts: step1.conflicts,
      reasons: step1.reasons,
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
        conflicts: step1.conflicts.map((conflict) => conflict.code),
      },
      async onCommit(trx) {
        await flagAssociationContentMismatchInTx(trx, {
          associationId: association.id,
          details: mismatchDetails,
          now: ctx.now,
        });
      },
    };
  };
}
