import {
  isBaselineSource,
  validateVariantSegments,
  type BaselineSource,
  type ExternalIdNamespace,
  type MediaType,
  type NormalizedSegment,
  type PlatformNamespace,
  type SeasonSnapshot,
} from "@media-ref/client";
import type {
  AssociationNamespaceRow,
  Database,
  Db,
  JsonObject,
  ReviewAlertStatusRow,
  ReviewAlertsTable,
  SeasonSnapshotRow,
  ExternalIdNamespaceRow,
} from "@media-ref/db";
import { sql, type Selectable, type Transaction } from "kysely";
import { enqueueJob, type BackgroundJob, type JobHandler } from "./jobs.ts";
import { acquireAdvisoryLock, ADVISORY_LOCK_CLASSES } from "./locks.ts";
import { isUuid } from "./media-service.ts";
import type { OutboundClient } from "./outbound.ts";
import {
  createTmdbGateway,
  isTraktSyncEnabled,
  parseTmdbNativeId,
  TmdbGatewayError,
  type TmdbGateway,
  type TmdbGatewayConfig,
} from "./tmdb.ts";

export const TMDB_SYNC_JOB_TYPE = "tmdb_sync";
export const TMDB_SYNC_KEY_MOVIE = "tmdb_changes_movie";
export const TMDB_SYNC_KEY_TV = "tmdb_changes_tv";
export const TMDB_CHANGES_MAX_WINDOW_DAYS = 14;
export const DEFAULT_TMDB_FULL_REFRESH_BATCH_SIZE = 50;

export const REVIEW_ALERT_TYPES = {
  AGENT_EXTERNAL_ID_CONFLICT: "agent_external_id_conflict",
  ASSOCIATION_CONTENT_MISMATCH: "association_content_mismatch",
  TMDB_MISSING_OR_MERGED: "tmdb_missing_or_merged",
  LOCKED_ASSOCIATION_CHALLENGED: "locked_association_challenged",
  LOCKED_ASSOCIATION_DELISTED: "locked_association_delisted",
  SEGMENTS_NEEDS_REVIEW: "segments_needs_review",
  SEED_EVIDENCE_FAILED: "seed_evidence_failed",
} as const;

export type KnownReviewAlertType = (typeof REVIEW_ALERT_TYPES)[keyof typeof REVIEW_ALERT_TYPES];

export type TmdbSyncMode = "changes" | "full_refresh" | "noop_no_tracked_media";

export interface TmdbSyncTransientError {
  mediaType: MediaType;
  mediaId?: string;
  tmdbId?: string;
  message: string;
}

export interface TmdbMediaTypeSyncSummary {
  mediaType: MediaType;
  syncKey: string;
  mode: TmdbSyncMode;
  startDate: string;
  endDate: string;
  gapDays: number;
  trackedCount: number;
  candidateCount: number;
  refreshedCount: number;
  missingCount: number;
  flaggedSegmentCount: number;
  cursorAdvanced: boolean;
  lastSyncedDate: string | null;
}

export interface TmdbDailySyncResult {
  syncDate: string;
  movie: TmdbMediaTypeSyncSummary;
  tv: TmdbMediaTypeSyncSummary;
  transientErrors: TmdbSyncTransientError[];
}

export interface RunTmdbDailySyncOptions {
  now?: Date;
  tmdbConfig?: TmdbGatewayConfig;
  tmdbGateway?: TmdbGateway;
  fullRefreshBatchSize?: number;
  maxChangesWindowDays?: number;
  backfillMissingTrakt?: boolean;
}

export interface EnqueueTmdbDailySyncOptions {
  now?: Date;
  priority?: number;
  maxAttempts?: number;
}

export interface EnqueueTmdbDailySyncResult {
  enqueued: boolean;
  reason:
    | "enqueued"
    | "already_active"
    | "no_tracked_media"
    | "already_synced_today"
    | "failed_today";
  syncDate: string;
  job?: BackgroundJob;
}

export interface CreateTmdbSyncJobHandlerOptions {
  tmdbConfig?: TmdbGatewayConfig;
  tmdbGateway?: TmdbGateway;
  fullRefreshBatchSize?: number;
  maxChangesWindowDays?: number;
  backfillMissingTrakt?: boolean;
}

export type MediaSyncErrorCode =
  | "INVALID_MEDIA_ID"
  | "INVALID_ALERT_ID"
  | "INVALID_BASELINE"
  | "MEDIA_NOT_FOUND"
  | "ALERT_NOT_FOUND"
  | "MERGE_SELF_NOT_ALLOWED"
  | "MERGE_CYCLE"
  | "MEDIA_ALREADY_MERGED";

export class MediaSyncError extends Error {
  readonly code: MediaSyncErrorCode;
  readonly status: number;

  constructor(code: MediaSyncErrorCode, status: number, message: string) {
    super(message);
    this.name = "MediaSyncError";
    this.code = code;
    this.status = status;
  }
}

export interface ReviewAlertRecord {
  id: string;
  alertType: string;
  mediaId: string | null;
  associationId: string | null;
  status: ReviewAlertStatusRow;
  details: JsonObject;
  createdAt: string;
  resolvedAt: string | null;
  resolvedByUserId: string | null;
}

export interface ListReviewAlertsOptions {
  status?: ReviewAlertStatusRow;
  alertType?: string;
  mediaId?: string;
  limit?: number;
  offset?: number;
}

export interface ListReviewAlertsResult {
  alerts: ReviewAlertRecord[];
  total: number;
}

export interface ResolveReviewAlertInput {
  alertId: string;
  reviewerUserId: string;
  now?: Date;
}

export interface NeedsReviewSegmentItem {
  segmentId: string;
  associationId: string;
  mediaId: string;
  mediaTitle: string;
  mediaType: MediaType;
  mediaBaseline: BaselineSource | null;
  namespace: AssociationNamespaceRow;
  nativeId: string;
  variantId: string | null;
  season: number;
  episodeStart: number;
  episodeEnd: number | null;
  targetEpisodeStart: number;
  baseline: BaselineSource;
  nonLinear: boolean;
  needsReview: boolean;
  updatedAt: string;
}

export interface ListNeedsReviewSegmentsOptions {
  mediaId?: string;
  limit?: number;
  offset?: number;
}

export interface ListNeedsReviewSegmentsResult {
  segments: NeedsReviewSegmentItem[];
  total: number;
}

export interface MergeMediaInput {
  sourceMediaId: string;
  targetMediaId: string;
  actorUserId: string;
  reason?: string | null;
  now?: Date;
}

export interface MergeMediaResult {
  sourceMediaId: string;
  targetMediaId: string;
  movedExternalIdCount: number;
  movedVariantCount: number;
  movedAssociationCount: number;
  flaggedSegmentCount: number;
  resolvedAlertCount: number;
  alreadyMerged: boolean;
}

export interface SwitchMediaBaselineInput {
  mediaId: string;
  newBaseline: BaselineSource | null;
  actorUserId?: string | null;
  reason?: string | null;
  now?: Date;
}

export interface SwitchMediaBaselineResult {
  mediaId: string;
  previousBaseline: BaselineSource | null;
  baseline: BaselineSource | null;
  flaggedSegmentCount: number;
}

type DbExecutor = Db | Transaction<Database>;

const UTC_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

export function formatUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseUtcDateMs(dateStr: string): number {
  const match = dateStr.match(UTC_DATE_PATTERN);
  if (!match) {
    throw new Error(`Invalid UTC date string: ${dateStr}`);
  }
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export function diffUtcDays(fromDate: string, toDate: string): number {
  return Math.round((parseUtcDateMs(toDate) - parseUtcDateMs(fromDate)) / MS_PER_DAY);
}

function maxDateString(a: string | null, b: string): string {
  if (!a) {
    return b;
  }
  return a >= b ? a : b;
}

function parseJsonArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) {
    return raw as T[];
  }
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
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
  return parseJsonArray<SeasonSnapshotRow>(raw).map((entry) => ({
    season: entry.season,
    episodeCount: entry.episodeCount,
    airYear: entry.airYear ?? null,
  }));
}

export function detectChangedSeasons(
  oldSeasons: readonly SeasonSnapshot[],
  newSeasons: readonly SeasonSnapshot[],
): number[] {
  const nextBySeason = new Map<number, SeasonSnapshot>();
  for (const season of newSeasons) {
    nextBySeason.set(season.season, season);
  }

  const changed = new Set<number>();
  for (const prev of oldSeasons) {
    const next = nextBySeason.get(prev.season);
    if (
      !next ||
      next.episodeCount !== prev.episodeCount ||
      (next.airYear ?? null) !== (prev.airYear ?? null)
    ) {
      changed.add(prev.season);
    }
  }

  return Array.from(changed).sort((a, b) => a - b);
}

async function recordOpenReviewAlert(
  db: DbExecutor,
  input: {
    alertType: string;
    mediaId: string | null;
    associationId?: string | null;
    details: JsonObject;
    dedupeByMediaAndType?: boolean;
  },
): Promise<{ id: string; created: boolean }> {
  if (input.dedupeByMediaAndType && input.mediaId) {
    const existing = await db
      .selectFrom("review_alerts")
      .select(["id", "details"])
      .where("media_id", "=", input.mediaId)
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
          prevDetails.firstDetectedAt ?? prevDetails.detectedAt ?? input.details.detectedAt,
      };
      await db
        .updateTable("review_alerts")
        .set({
          details: JSON.stringify(mergedDetails),
        })
        .where("id", "=", existing.id)
        .execute();

      return { id: existing.id, created: false };
    }
  }

  const inserted = await db
    .insertInto("review_alerts")
    .values({
      alert_type: input.alertType,
      media_id: input.mediaId,
      association_id: input.associationId ?? null,
      status: "open",
      details: JSON.stringify(input.details),
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  return { id: inserted.id, created: true };
}

async function upsertSyncState(
  db: Db,
  syncKey: string,
  lastSyncedDate: string,
  metadata: JsonObject,
  now: Date,
): Promise<string> {
  const row = await db
    .insertInto("sync_state")
    .values({
      sync_key: syncKey,
      last_synced_date: lastSyncedDate,
      metadata: JSON.stringify(metadata),
      updated_at: now,
    })
    .onConflict((oc) =>
      oc.column("sync_key").doUpdateSet({
        last_synced_date: sql<string>`greatest(sync_state.last_synced_date, excluded.last_synced_date)`,
        metadata: JSON.stringify(metadata),
        updated_at: now,
      }),
    )
    .returning("last_synced_date")
    .executeTakeFirstOrThrow();

  return row.last_synced_date;
}

async function syncSingleMediaType(
  db: Db,
  gateway: TmdbGateway,
  mediaType: MediaType,
  today: string,
  now: Date,
  fullRefreshBatchSize: number,
  maxChangesWindowDays: number,
  traktBackfillEnabled: boolean,
  transientErrors: TmdbSyncTransientError[],
): Promise<TmdbMediaTypeSyncSummary> {
  const syncKey = mediaType === "movie" ? TMDB_SYNC_KEY_MOVIE : TMDB_SYNC_KEY_TV;

  const [trackedRows, existingCursor] = await Promise.all([
    db
      .selectFrom("media")
      .innerJoin("associations as external_ids", "external_ids.media_id", "media.id")
      .where("external_ids.is_external_id", "=", true)
      .select((eb) => [
        "media.id as media_id",
        "media.type as type",
        "media.title as title",
        "external_ids.native_id as tmdb_native_id",
        eb
          .exists(
            eb
              .selectFrom("associations as trakt_ext")
              .select("trakt_ext.id")
              .whereRef("trakt_ext.media_id", "=", "media.id")
              .where("trakt_ext.is_external_id", "=", true)
              .where("trakt_ext.namespace", "=", "trakt"),
          )
          .as("has_trakt"),
      ])
      .where("media.merged_into_media_id", "is", null)
      .where("media.type", "=", mediaType)
      .where("external_ids.namespace", "=", "tmdb")
      .orderBy("media.id", "asc")
      .execute(),
    db
      .selectFrom("sync_state")
      .select(["sync_key", "last_synced_date", "metadata"])
      .where("sync_key", "=", syncKey)
      .executeTakeFirst(),
  ]);

  const parsedTracked = trackedRows
    .map((row) => {
      const parsed = parseTmdbNativeId(row.tmdb_native_id);
      if (!parsed || parsed.type !== mediaType) {
        return null;
      }
      return {
        mediaId: row.media_id,
        title: row.title,
        tmdbType: parsed.type,
        tmdbId: parsed.id,
        tmdbNativeId: row.tmdb_native_id,
        hasTrakt: Boolean(row.has_trakt),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  if (parsedTracked.length === 0) {
    const targetDate = maxDateString(existingCursor?.last_synced_date ?? null, today);
    const savedDate = await upsertSyncState(
      db,
      syncKey,
      targetDate,
      {
        mode: "noop_no_tracked_media",
        syncDate: today,
        trackedCount: 0,
        refreshedCount: 0,
        missingCount: 0,
        flaggedSegmentCount: 0,
        lastRunAt: now.toISOString(),
      },
      now,
    );

    return {
      mediaType,
      syncKey,
      mode: "noop_no_tracked_media",
      startDate: today,
      endDate: today,
      gapDays: existingCursor ? diffUtcDays(existingCursor.last_synced_date, today) : 0,
      trackedCount: 0,
      candidateCount: 0,
      refreshedCount: 0,
      missingCount: 0,
      flaggedSegmentCount: 0,
      cursorAdvanced: true,
      lastSyncedDate: savedDate,
    };
  }

  const gapDays = existingCursor ? diffUtcDays(existingCursor.last_synced_date, today) : 0;
  const mode: TmdbSyncMode = gapDays > maxChangesWindowDays ? "full_refresh" : "changes";
  const startDate = existingCursor && gapDays >= 0 ? existingCursor.last_synced_date : today;
  const endDate = today;

  const existingMetadata = parseJsonObject(existingCursor?.metadata);
  const prevBackfillCursor =
    typeof existingMetadata.traktBackfillAfterMediaId === "string"
      ? existingMetadata.traktBackfillAfterMediaId
      : null;
  let nextBackfillCursor: string | null = prevBackfillCursor;
  let traktBackfillCount = 0;

  let candidates = parsedTracked;
  if (mode === "changes") {
    try {
      const changes = await gateway.fetchChanges(mediaType, { startDate, endDate });
      const changedIdSet = new Set(changes.changedIds);
      const changedCandidates = parsedTracked.filter((entry) => changedIdSet.has(entry.tmdbId));
      let backfillCandidates: typeof parsedTracked = [];
      if (traktBackfillEnabled) {
        const missingTrakt = parsedTracked.filter(
          (entry) => !changedIdSet.has(entry.tmdbId) && !entry.hasTrakt,
        );
        if (missingTrakt.length > 0) {
          const tail = prevBackfillCursor
            ? missingTrakt.filter((entry) => entry.mediaId > prevBackfillCursor)
            : missingTrakt;
          const head = prevBackfillCursor
            ? missingTrakt.filter((entry) => entry.mediaId <= prevBackfillCursor)
            : [];
          backfillCandidates = [...tail, ...head].slice(0, fullRefreshBatchSize);
          traktBackfillCount = backfillCandidates.length;
          nextBackfillCursor = backfillCandidates.at(-1)?.mediaId ?? prevBackfillCursor;
        } else {
          nextBackfillCursor = null;
        }
      }
      candidates = [...changedCandidates, ...backfillCandidates];
    } catch (error) {
      transientErrors.push({
        mediaType,
        message: error instanceof Error ? error.message : String(error),
      });
      return {
        mediaType,
        syncKey,
        mode,
        startDate,
        endDate,
        gapDays,
        trackedCount: parsedTracked.length,
        candidateCount: 0,
        refreshedCount: 0,
        missingCount: 0,
        flaggedSegmentCount: 0,
        cursorAdvanced: false,
        lastSyncedDate: existingCursor?.last_synced_date ?? null,
      };
    }
  }

  let refreshedCount = 0;
  let missingCount = 0;
  let flaggedSegmentCount = 0;
  let typeHadTransientError = false;

  for (let offset = 0; offset < candidates.length; offset += fullRefreshBatchSize) {
    const batch = candidates.slice(offset, offset + fullRefreshBatchSize);

    for (const item of batch) {
      let fetched = null;
      let isNotFound = false;

      try {
        fetched = await gateway.fetchMediaSnapshotAndExternalIds(item.tmdbType, item.tmdbId, {
          throwOnNotFound: true,
        });
        if (!fetched) {
          isNotFound = true;
        }
      } catch (error) {
        if (error instanceof TmdbGatewayError && error.code === "TMDB_NOT_FOUND") {
          isNotFound = true;
        } else {
          typeHadTransientError = true;
          transientErrors.push({
            mediaType,
            mediaId: item.mediaId,
            tmdbId: item.tmdbId,
            message: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
      }

      if (isNotFound || !fetched) {
        missingCount += 1;
        await recordOpenReviewAlert(db, {
          alertType: REVIEW_ALERT_TYPES.TMDB_MISSING_OR_MERGED,
          mediaId: item.mediaId,
          details: {
            tmdbExternalKey: `tmdb:${item.tmdbType}:${item.tmdbId}`,
            mediaTitle: item.title,
            detectedAt: now.toISOString(),
            reason:
              "TMDB returned 404 Not Found; item may have been deleted or merged without a redirect target",
          },
          dedupeByMediaAndType: true,
        });
        continue;
      }

      const txResult = await db.transaction().execute(async (trx) => {
        const currentMedia = await trx
          .selectFrom("media")
          .select(["id", "title", "seasons", "merged_into_media_id"])
          .where("id", "=", item.mediaId)
          .forUpdate()
          .executeTakeFirst();

        if (!currentMedia || currentMedia.merged_into_media_id !== null) {
          return { refreshed: false, newlyFlagged: 0 };
        }

        const oldSeasons = parseSeasonsSnapshot(currentMedia.seasons);
        const newSeasons = fetched.snapshot.seasons;
        const changedSeasons = detectChangedSeasons(oldSeasons, newSeasons);

        await trx
          .updateTable("media")
          .set({
            title: fetched.snapshot.title,
            original_title: fetched.snapshot.originalTitle,
            year: fetched.snapshot.year,
            seasons: JSON.stringify(newSeasons),
            updated_at: now,
          })
          .where("id", "=", currentMedia.id)
          .execute();

        const secondaryExternalIds: Array<{ namespace: ExternalIdNamespace; nativeId: string }> =
          [];
        if (fetched.externalIds.imdb) {
          secondaryExternalIds.push({ namespace: "imdb", nativeId: fetched.externalIds.imdb });
        }
        if (fetched.externalIds.tvdb) {
          secondaryExternalIds.push({ namespace: "tvdb", nativeId: fetched.externalIds.tvdb });
        }
        if (fetched.externalIds.trakt) {
          secondaryExternalIds.push({ namespace: "trakt", nativeId: fetched.externalIds.trakt });
        }

        for (const ext of secondaryExternalIds) {
          const existingExt = await trx
            .selectFrom("associations")
            .where("is_external_id", "=", true)
            .select(["id", "native_id", "locked"])
            .where("media_id", "=", currentMedia.id)
            .where("namespace", "=", ext.namespace)
            .executeTakeFirst();

          if (existingExt) {
            if (existingExt.locked || existingExt.native_id === ext.nativeId) {
              continue;
            }
            const claimedByOther = await trx
              .selectFrom("associations")
              .where("is_external_id", "=", true)
              .select("id")
              .where("namespace", "=", ext.namespace)
              .where("native_id", "=", ext.nativeId)
              .executeTakeFirst();
            if (!claimedByOther) {
              await trx
                .updateTable("associations")
                .where("is_external_id", "=", true)
                .set({
                  native_id: ext.nativeId,
                  source: "sync",
                  updated_at: now,
                })
                .where("id", "=", existingExt.id)
                .execute();
            }
          } else {
            await trx
              .insertInto("associations")
              .values({
                status: "confirmed",
                is_external_id: true,
                media_id: currentMedia.id,
                namespace: ext.namespace,
                native_id: ext.nativeId,
                locked: false,
                source: "sync",
              })
              .onConflict((oc) => oc.doNothing())
              .execute();
          }
        }

        let newlyFlagged = 0;
        if (changedSeasons.length > 0) {
          const assocRows = await trx
            .selectFrom("associations")
            .where("is_external_id", "=", false)
            .select("id")
            .where("media_id", "=", currentMedia.id)
            .where("status", "!=", "delisted")
            .execute();

          if (assocRows.length > 0) {
            const assocIds = assocRows.map((row) => row.id);
            const updatedSegments = await trx
              .updateTable("segments")
              .set({
                needs_review: true,
                updated_at: now,
              })
              .where("association_id", "in", assocIds)
              .where("season", "in", changedSeasons)
              .where("needs_review", "=", false)
              .returning("id")
              .execute();

            newlyFlagged = updatedSegments.length;

            if (newlyFlagged > 0) {
              await recordOpenReviewAlert(trx, {
                alertType: REVIEW_ALERT_TYPES.SEGMENTS_NEEDS_REVIEW,
                mediaId: currentMedia.id,
                details: {
                  reason: "tmdb_season_structure_changed",
                  tmdbExternalKey: `tmdb:${item.tmdbType}:${item.tmdbId}`,
                  changedSeasons,
                  flaggedSegmentCount: newlyFlagged,
                  detectedAt: now.toISOString(),
                },
                dedupeByMediaAndType: true,
              });
            }
          }
        }

        return { refreshed: true, newlyFlagged };
      });

      if (txResult.refreshed) {
        refreshedCount += 1;
        flaggedSegmentCount += txResult.newlyFlagged;
      }
    }
  }

  let cursorAdvanced = false;
  let lastSyncedDate = existingCursor?.last_synced_date ?? null;

  if (!typeHadTransientError) {
    const targetDate = maxDateString(existingCursor?.last_synced_date ?? null, today);
    lastSyncedDate = await upsertSyncState(
      db,
      syncKey,
      targetDate,
      {
        mode,
        startDate,
        endDate,
        gapDays,
        trackedCount: parsedTracked.length,
        candidateCount: candidates.length,
        refreshedCount,
        missingCount,
        flaggedSegmentCount,
        ...(traktBackfillEnabled
          ? {
              traktBackfillCount,
              traktBackfillAfterMediaId: mode === "full_refresh" ? null : nextBackfillCursor,
            }
          : prevBackfillCursor !== null
            ? { traktBackfillAfterMediaId: prevBackfillCursor }
            : {}),
        lastRunAt: now.toISOString(),
      },
      now,
    );
    cursorAdvanced = true;
  }

  return {
    mediaType,
    syncKey,
    mode,
    startDate,
    endDate,
    gapDays,
    trackedCount: parsedTracked.length,
    candidateCount: candidates.length,
    refreshedCount,
    missingCount,
    flaggedSegmentCount,
    cursorAdvanced,
    lastSyncedDate,
  };
}

export async function runTmdbDailySync(
  db: Db,
  outbound: OutboundClient,
  options: RunTmdbDailySyncOptions = {},
): Promise<TmdbDailySyncResult> {
  const now = options.now ?? new Date();
  const today = formatUtcDate(now);
  const fullRefreshBatchSize = Math.max(
    1,
    options.fullRefreshBatchSize ?? DEFAULT_TMDB_FULL_REFRESH_BATCH_SIZE,
  );
  const maxChangesWindowDays = Math.max(
    1,
    options.maxChangesWindowDays ?? TMDB_CHANGES_MAX_WINDOW_DAYS,
  );
  const gateway = options.tmdbGateway ?? createTmdbGateway(outbound, options.tmdbConfig);
  const traktBackfillEnabled =
    options.backfillMissingTrakt ?? isTraktSyncEnabled(options.tmdbConfig);
  const transientErrors: TmdbSyncTransientError[] = [];

  const movie = await syncSingleMediaType(
    db,
    gateway,
    "movie",
    today,
    now,
    fullRefreshBatchSize,
    maxChangesWindowDays,
    traktBackfillEnabled,
    transientErrors,
  );

  const tv = await syncSingleMediaType(
    db,
    gateway,
    "tv",
    today,
    now,
    fullRefreshBatchSize,
    maxChangesWindowDays,
    traktBackfillEnabled,
    transientErrors,
  );

  return {
    syncDate: today,
    movie,
    tv,
    transientErrors,
  };
}

export async function enqueueTmdbDailySyncIfDue(
  db: Db,
  options: EnqueueTmdbDailySyncOptions = {},
): Promise<EnqueueTmdbDailySyncResult> {
  const now = options.now ?? new Date();
  const syncDate = formatUtcDate(now);

  const trackedMedia = db
    .selectFrom("media")
    .innerJoin("associations as external_ids", "external_ids.media_id", "media.id")
    .where("external_ids.is_external_id", "=", true)
    .where("media.merged_into_media_id", "is", null)
    .where("external_ids.namespace", "=", "tmdb")
    .select("media.id");
  const tracked = await db
    .selectNoFrom((eb) => [
      eb.exists(trackedMedia.where("media.type", "=", "movie")).as("movie"),
      eb.exists(trackedMedia.where("media.type", "=", "tv")).as("tv"),
    ])
    .executeTakeFirstOrThrow();
  const requiredKeys: string[] = [];
  if (tracked.movie) requiredKeys.push(TMDB_SYNC_KEY_MOVIE);
  if (tracked.tv) requiredKeys.push(TMDB_SYNC_KEY_TV);

  if (requiredKeys.length === 0) {
    return {
      enqueued: false,
      reason: "no_tracked_media",
      syncDate,
    };
  }

  const cursorRows = await db
    .selectFrom("sync_state")
    .select(["sync_key", "last_synced_date"])
    .where("sync_key", "in", requiredKeys)
    .execute();

  const cursorByKey = new Map(cursorRows.map((row) => [row.sync_key, row.last_synced_date]));
  const allCaughtUp = requiredKeys.every((key) => {
    const last = cursorByKey.get(key);
    return last !== undefined && last >= syncDate;
  });

  if (allCaughtUp) {
    return {
      enqueued: false,
      reason: "already_synced_today",
      syncDate,
    };
  }

  const dedupeKey = `${TMDB_SYNC_JOB_TYPE}:${syncDate}`;
  const failedToday = await db
    .selectFrom("background_jobs")
    .select("id")
    .where("dedupe_key", "=", dedupeKey)
    .where("status", "=", "failed")
    .executeTakeFirst();

  if (failedToday) {
    return {
      enqueued: false,
      reason: "failed_today",
      syncDate,
    };
  }

  const enqueued = await enqueueJob(db, {
    jobType: TMDB_SYNC_JOB_TYPE,
    dedupeKey,
    payload: { syncDate },
    priority: options.priority ?? 0,
    runAfter: now,
    maxAttempts: options.maxAttempts ?? 5,
  });

  return {
    enqueued: enqueued.created,
    reason: enqueued.created ? "enqueued" : "already_active",
    syncDate,
    job: enqueued.job,
  };
}

export function createTmdbSyncJobHandler(
  options: CreateTmdbSyncJobHandlerOptions = {},
): JobHandler {
  return async (ctx) => {
    const summary = await runTmdbDailySync(ctx.db, ctx.outbound, {
      now: ctx.now,
      tmdbConfig: options.tmdbConfig,
      tmdbGateway: options.tmdbGateway,
      fullRefreshBatchSize: options.fullRefreshBatchSize,
      maxChangesWindowDays: options.maxChangesWindowDays,
      backfillMissingTrakt: options.backfillMissingTrakt,
    });

    if (summary.transientErrors.length > 0) {
      return {
        status: "retry",
        errorMessage: summary.transientErrors.map((err) => err.message).join("; "),
      };
    }

    return {
      status: "completed",
      result: {
        syncDate: summary.syncDate,
        movie: summary.movie,
        tv: summary.tv,
      },
    };
  };
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toReviewAlertRecord(row: Selectable<ReviewAlertsTable>): ReviewAlertRecord {
  return {
    id: row.id,
    alertType: row.alert_type,
    mediaId: row.media_id,
    associationId: row.association_id,
    status: row.status,
    details: parseJsonObject(row.details),
    createdAt: toIsoString(row.created_at),
    resolvedAt: row.resolved_at ? toIsoString(row.resolved_at) : null,
    resolvedByUserId: row.resolved_by_user_id,
  };
}

export async function listReviewAlerts(
  db: Db,
  options: ListReviewAlertsOptions = {},
): Promise<ListReviewAlertsResult> {
  const status = options.status ?? "open";
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);

  if (options.mediaId !== undefined && !isUuid(options.mediaId)) {
    throw new MediaSyncError("INVALID_MEDIA_ID", 400, "mediaId must be a valid UUID");
  }

  let rowsQuery = db.selectFrom("review_alerts").selectAll().where("status", "=", status);
  let countQuery = db
    .selectFrom("review_alerts")
    .select(sql<string>`count(*)`.as("count"))
    .where("status", "=", status);

  if (options.alertType) {
    rowsQuery = rowsQuery.where("alert_type", "=", options.alertType);
    countQuery = countQuery.where("alert_type", "=", options.alertType);
  }

  if (options.mediaId) {
    rowsQuery = rowsQuery.where("media_id", "=", options.mediaId);
    countQuery = countQuery.where("media_id", "=", options.mediaId);
  }

  const [rows, countRow] = await Promise.all([
    rowsQuery
      .orderBy("created_at", "desc")
      .orderBy("id", "asc")
      .limit(limit)
      .offset(offset)
      .execute(),
    countQuery.executeTakeFirstOrThrow(),
  ]);

  return {
    alerts: rows.map(toReviewAlertRecord),
    total: Number(countRow.count),
  };
}

export async function resolveReviewAlert(
  db: Db,
  input: ResolveReviewAlertInput,
): Promise<ReviewAlertRecord> {
  if (!isUuid(input.alertId)) {
    throw new MediaSyncError("INVALID_ALERT_ID", 400, "alertId must be a valid UUID");
  }

  const now = input.now ?? new Date();
  const updated = await db
    .updateTable("review_alerts")
    .set({
      status: "resolved",
      resolved_at: now,
      resolved_by_user_id: input.reviewerUserId,
    })
    .where("id", "=", input.alertId)
    .returningAll()
    .executeTakeFirst();

  if (!updated) {
    throw new MediaSyncError("ALERT_NOT_FOUND", 404, "Review alert not found");
  }

  return toReviewAlertRecord(updated);
}

export async function listNeedsReviewSegments(
  db: Db,
  options: ListNeedsReviewSegmentsOptions = {},
): Promise<ListNeedsReviewSegmentsResult> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);

  if (options.mediaId !== undefined && !isUuid(options.mediaId)) {
    throw new MediaSyncError("INVALID_MEDIA_ID", 400, "mediaId must be a valid UUID");
  }

  let rowsQuery = db
    .selectFrom("segments")
    .innerJoin("associations", "associations.id", "segments.association_id")
    .innerJoin("media", "media.id", "associations.media_id")
    .select([
      "segments.id as segment_id",
      "segments.association_id as association_id",
      "media.id as media_id",
      "media.title as media_title",
      "media.type as media_type",
      "media.baseline as media_baseline",
      "associations.namespace as namespace",
      "associations.native_id as native_id",
      "associations.variant_id as variant_id",
      "segments.season as season",
      "segments.episode_start as episode_start",
      "segments.episode_end as episode_end",
      "segments.target_episode_start as target_episode_start",
      "segments.baseline as baseline",
      "segments.non_linear as non_linear",
      "segments.needs_review as needs_review",
      "segments.updated_at as updated_at",
    ])
    .where("segments.needs_review", "=", true)
    .where("associations.status", "!=", "delisted")
    .where("media.merged_into_media_id", "is", null);

  let countQuery = db
    .selectFrom("segments")
    .innerJoin("associations", "associations.id", "segments.association_id")
    .innerJoin("media", "media.id", "associations.media_id")
    .select(sql<string>`count(*)`.as("count"))
    .where("segments.needs_review", "=", true)
    .where("associations.status", "!=", "delisted")
    .where("media.merged_into_media_id", "is", null);

  if (options.mediaId) {
    rowsQuery = rowsQuery.where("media.id", "=", options.mediaId);
    countQuery = countQuery.where("media.id", "=", options.mediaId);
  }

  const [rows, countRow] = await Promise.all([
    rowsQuery
      .orderBy("segments.updated_at", "desc")
      .orderBy("segments.season", "asc")
      .orderBy("segments.episode_start", "asc")
      .orderBy("segments.id", "asc")
      .limit(limit)
      .offset(offset)
      .execute(),
    countQuery.executeTakeFirstOrThrow(),
  ]);

  return {
    segments: rows.map((row) => ({
      segmentId: row.segment_id,
      associationId: row.association_id,
      mediaId: row.media_id,
      mediaTitle: row.media_title,
      mediaType: row.media_type,
      mediaBaseline: row.media_baseline,
      namespace: row.namespace,
      nativeId: row.native_id,
      variantId: row.variant_id,
      season: row.season,
      episodeStart: row.episode_start,
      episodeEnd: row.episode_end,
      targetEpisodeStart: row.target_episode_start,
      baseline: row.baseline,
      nonLinear: Boolean(row.non_linear),
      needsReview: Boolean(row.needs_review),
      updatedAt: toIsoString(row.updated_at),
    })),
    total: Number(countRow.count),
  };
}

async function acquireMergeAdvisoryLock(
  trx: Transaction<Database>,
  mediaId: string,
): Promise<void> {
  await acquireAdvisoryLock(trx, ADVISORY_LOCK_CLASSES.MEDIA_MERGE, mediaId);
}

interface LockedMediaSummary {
  id: string;
  type: MediaType;
  baseline: BaselineSource | null;
  title: string;
  merged_into_media_id: string | null;
}

async function resolveCanonicalMediaForUpdate(
  trx: Transaction<Database>,
  startMediaId: string,
  forbiddenId?: string,
): Promise<LockedMediaSummary | null> {
  let currentId = startMediaId;
  const visited = new Set<string>();

  for (let hop = 0; hop < 10; hop += 1) {
    if (visited.has(currentId)) {
      throw new MediaSyncError(
        "MERGE_CYCLE",
        409,
        "Detected a redirect cycle while resolving media",
      );
    }
    visited.add(currentId);

    if (forbiddenId && currentId === forbiddenId) {
      throw new MediaSyncError(
        "MERGE_CYCLE",
        409,
        "Merging these media would create a redirect cycle",
      );
    }

    const row = await trx
      .selectFrom("media")
      .select(["id", "type", "baseline", "title", "merged_into_media_id"])
      .where("id", "=", currentId)
      .forUpdate()
      .executeTakeFirst();

    if (!row) {
      return null;
    }

    if (!row.merged_into_media_id || row.merged_into_media_id === row.id) {
      return row;
    }

    currentId = row.merged_into_media_id;
  }

  throw new MediaSyncError("MERGE_CYCLE", 409, "Media redirect chain exceeded maximum depth");
}

async function loadSegmentsByAssociationIds(
  trx: Transaction<Database>,
  associationIds: readonly string[],
): Promise<Map<string, NormalizedSegment[]>> {
  const byAssoc = new Map<string, NormalizedSegment[]>();
  if (associationIds.length === 0) {
    return byAssoc;
  }

  const rows = await trx
    .selectFrom("segments")
    .select([
      "association_id",
      "season",
      "episode_start",
      "episode_end",
      "target_episode_start",
      "baseline",
      "non_linear",
      "needs_review",
    ])
    .where("association_id", "in", [...associationIds])
    .orderBy("season", "asc")
    .orderBy("episode_start", "asc")
    .orderBy("id", "asc")
    .execute();

  for (const row of rows) {
    const list = byAssoc.get(row.association_id) ?? [];
    list.push({
      season: row.season,
      episodeStart: row.episode_start,
      episodeEnd: row.episode_end,
      targetEpisodeStart: row.target_episode_start,
      baseline: row.baseline,
      nonLinear: Boolean(row.non_linear),
      needsReview: Boolean(row.needs_review),
    });
    byAssoc.set(row.association_id, list);
  }

  return byAssoc;
}

async function flagBaselineMismatchedSegments(
  trx: Transaction<Database>,
  mediaId: string,
  targetBaseline: BaselineSource | null,
  now: Date,
): Promise<number> {
  const assocRows = await trx
    .selectFrom("associations")
    .where("is_external_id", "=", false)
    .select("id")
    .where("media_id", "=", mediaId)
    .where("status", "!=", "delisted")
    .execute();

  if (assocRows.length === 0) {
    return 0;
  }

  const assocIds = assocRows.map((row) => row.id);
  let updateQuery = trx
    .updateTable("segments")
    .set({
      needs_review: true,
      updated_at: now,
    })
    .where("association_id", "in", assocIds)
    .where("needs_review", "=", false);

  if (targetBaseline !== null) {
    updateQuery = updateQuery.where("baseline", "!=", targetBaseline);
  }

  const flagged = await updateQuery.returning("id").execute();
  return flagged.length;
}

export async function mergeMedia(db: Db, input: MergeMediaInput): Promise<MergeMediaResult> {
  if (!isUuid(input.sourceMediaId) || !isUuid(input.targetMediaId)) {
    throw new MediaSyncError(
      "INVALID_MEDIA_ID",
      400,
      "sourceMediaId and targetMediaId must be valid UUIDs",
    );
  }

  if (input.sourceMediaId === input.targetMediaId) {
    throw new MediaSyncError("MERGE_SELF_NOT_ALLOWED", 400, "Cannot merge a media into itself");
  }

  const now = input.now ?? new Date();
  const reason = input.reason?.trim() || null;

  return db.transaction().execute(async (trx) => {
    // Deterministic lock ordering avoids deadlocks across concurrent merges
    for (const id of [input.sourceMediaId, input.targetMediaId].sort()) {
      await acquireMergeAdvisoryLock(trx, id);
    }

    const source = await trx
      .selectFrom("media")
      .select(["id", "type", "baseline", "title", "merged_into_media_id"])
      .where("id", "=", input.sourceMediaId)
      .forUpdate()
      .executeTakeFirst();

    if (!source) {
      throw new MediaSyncError(
        "MEDIA_NOT_FOUND",
        404,
        `Source media not found: ${input.sourceMediaId}`,
      );
    }

    const canonicalTarget = await resolveCanonicalMediaForUpdate(
      trx,
      input.targetMediaId,
      source.id,
    );
    if (!canonicalTarget) {
      throw new MediaSyncError(
        "MEDIA_NOT_FOUND",
        404,
        `Target media not found: ${input.targetMediaId}`,
      );
    }

    if (canonicalTarget.id !== input.targetMediaId) {
      await acquireMergeAdvisoryLock(trx, canonicalTarget.id);
    }

    if (source.merged_into_media_id !== null) {
      if (source.merged_into_media_id === canonicalTarget.id) {
        await trx
          .updateTable("media")
          .set({ merged_into_media_id: canonicalTarget.id, updated_at: now })
          .where("merged_into_media_id", "=", source.id)
          .execute();

        return {
          sourceMediaId: source.id,
          targetMediaId: canonicalTarget.id,
          movedExternalIdCount: 0,
          movedVariantCount: 0,
          movedAssociationCount: 0,
          flaggedSegmentCount: 0,
          resolvedAlertCount: 0,
          alreadyMerged: true,
        };
      }

      throw new MediaSyncError(
        "MEDIA_ALREADY_MERGED",
        409,
        `Source media ${source.id} is already merged into ${source.merged_into_media_id}`,
      );
    }

    // 1. Mark source redirected to canonicalTarget and flatten any chains pointing to source
    await trx
      .updateTable("media")
      .set({
        merged_into_media_id: canonicalTarget.id,
        updated_at: now,
      })
      .where("id", "=", source.id)
      .execute();

    await trx
      .updateTable("media")
      .set({
        merged_into_media_id: canonicalTarget.id,
        updated_at: now,
      })
      .where("merged_into_media_id", "=", source.id)
      .execute();

    // 2. Migrate non-conflicting external_ids; conflicting ones remain on source as redirect keys
    const [sourceExternalIds, targetExternalIds] = await Promise.all([
      trx
        .selectFrom("associations")
        .where("is_external_id", "=", true)
        .select(["id", "namespace", "native_id"])
        .where("media_id", "=", source.id)
        .$narrowType<{ namespace: ExternalIdNamespaceRow }>()
        .execute(),
      trx
        .selectFrom("associations")
        .where("is_external_id", "=", true)
        .select(["id", "namespace", "native_id"])
        .where("media_id", "=", canonicalTarget.id)
        .$narrowType<{ namespace: ExternalIdNamespaceRow }>()
        .execute(),
    ]);

    const targetExtNamespaces = new Set(targetExternalIds.map((row) => row.namespace));
    let movedExternalIdCount = 0;

    for (const ext of sourceExternalIds) {
      if (!targetExtNamespaces.has(ext.namespace)) {
        await trx
          .updateTable("associations")
          .where("is_external_id", "=", true)
          .set({ media_id: canonicalTarget.id, updated_at: now })
          .where("id", "=", ext.id)
          .execute();
        targetExtNamespaces.add(ext.namespace);
        movedExternalIdCount += 1;
      }
    }

    // 3. Migrate variants and associations cleanly while preserving single default variant per platform
    const [sourceVariants, targetVariants, sourceAssociations, targetAssociations] =
      await Promise.all([
        trx
          .selectFrom("variants")
          .select(["id", "platform", "description", "is_default"])
          .where("media_id", "=", source.id)
          .orderBy("created_at", "asc")
          .orderBy("id", "asc")
          .execute(),
        trx
          .selectFrom("variants")
          .select(["id", "platform", "description", "is_default"])
          .where("media_id", "=", canonicalTarget.id)
          .orderBy("created_at", "asc")
          .orderBy("id", "asc")
          .execute(),
        trx
          .selectFrom("associations")
          .where("is_external_id", "=", false)
          .select(["id", "namespace", "native_id", "variant_id", "status"])
          .where("media_id", "=", source.id)
          .orderBy("created_at", "asc")
          .orderBy("id", "asc")
          .execute(),
        trx
          .selectFrom("associations")
          .where("is_external_id", "=", false)
          .select(["id", "namespace", "native_id", "variant_id", "status"])
          .where("media_id", "=", canonicalTarget.id)
          .orderBy("created_at", "asc")
          .orderBy("id", "asc")
          .execute(),
      ]);

    const allAssocIds = [
      ...sourceAssociations.map((a) => a.id),
      ...targetAssociations.map((a) => a.id),
    ];
    const segmentsByAssoc = await loadSegmentsByAssociationIds(trx, allAssocIds);

    const targetAssocByKey = new Map(
      targetAssociations.map((a) => [`${a.namespace}:${a.native_id}`, a]),
    );
    const targetDefaultPlatforms = new Set<PlatformNamespace>(
      targetVariants.filter((v) => v.is_default).map((v) => v.platform),
    );
    const activeTargetSegmentsByVariant = new Map<
      string,
      Array<{ associationId: string; segments: NormalizedSegment[] }>
    >();
    for (const ta of targetAssociations) {
      if (ta.variant_id && ta.status !== "delisted") {
        const list = activeTargetSegmentsByVariant.get(ta.variant_id) ?? [];
        list.push({ associationId: ta.id, segments: segmentsByAssoc.get(ta.id) ?? [] });
        activeTargetSegmentsByVariant.set(ta.variant_id, list);
      }
    }

    const variantRemap = new Map<string, string>();
    const variantsToDelete: string[] = [];
    let movedVariantCount = 0;

    for (const sv of sourceVariants) {
      const matchingTarget = targetVariants.find(
        (tv) => tv.platform === sv.platform && tv.description === sv.description,
      );

      let coalesced = false;
      if (matchingTarget) {
        const incomingActiveAssocs = sourceAssociations.filter(
          (sa) =>
            sa.variant_id === sv.id &&
            sa.status !== "delisted" &&
            !targetAssocByKey.has(`${sa.namespace}:${sa.native_id}`),
        );
        const existingEntries = activeTargetSegmentsByVariant.get(matchingTarget.id) ?? [];
        const incomingEntries = incomingActiveAssocs.map((sa) => ({
          associationId: sa.id,
          segments: segmentsByAssoc.get(sa.id) ?? [],
        }));
        const combined = [...existingEntries, ...incomingEntries];
        const validation = validateVariantSegments(combined, {
          baseline: canonicalTarget.baseline,
        });

        if (validation.valid) {
          variantRemap.set(sv.id, matchingTarget.id);
          variantsToDelete.push(sv.id);
          activeTargetSegmentsByVariant.set(matchingTarget.id, combined);
          coalesced = true;
        }
      }

      if (!coalesced) {
        const keepDefault = Boolean(sv.is_default) && !targetDefaultPlatforms.has(sv.platform);
        await trx
          .updateTable("variants")
          .set({
            media_id: canonicalTarget.id,
            is_default: keepDefault,
            updated_at: now,
          })
          .where("id", "=", sv.id)
          .execute();

        if (keepDefault) {
          targetDefaultPlatforms.add(sv.platform);
        }
        variantRemap.set(sv.id, sv.id);
        movedVariantCount += 1;
      }
    }

    let movedAssociationCount = 0;
    for (const sa of sourceAssociations) {
      const key = `${sa.namespace}:${sa.native_id}`;
      const existingTarget = targetAssocByKey.get(key);
      const nextVariantId = sa.variant_id
        ? (variantRemap.get(sa.variant_id) ?? sa.variant_id)
        : null;

      if (!existingTarget) {
        await trx
          .updateTable("associations")
          .set({
            media_id: canonicalTarget.id,
            variant_id: nextVariantId,
            updated_at: now,
          })
          .where("id", "=", sa.id)
          .execute();

        if (sa.variant_id && nextVariantId && sa.variant_id !== nextVariantId) {
          await trx
            .updateTable("association_revisions")
            .set({ variant_id: nextVariantId })
            .where("association_id", "=", sa.id)
            .where("variant_id", "=", sa.variant_id)
            .execute();
        }
        movedAssociationCount += 1;
      } else {
        await trx
          .updateTable("associations")
          .set({
            status: "delisted",
            variant_id: nextVariantId,
            updated_at: now,
          })
          .where("id", "=", sa.id)
          .execute();
      }
    }

    for (const [oldVariantId, newVariantId] of variantRemap.entries()) {
      if (oldVariantId !== newVariantId) {
        await trx
          .updateTable("change_requests")
          .set({ variant_id: newVariantId, updated_at: now })
          .where("variant_id", "=", oldVariantId)
          .execute();

        await trx
          .updateTable("association_revisions")
          .set({ variant_id: newVariantId })
          .where("variant_id", "=", oldVariantId)
          .execute();
      }
    }

    await trx
      .updateTable("change_requests")
      .set({ media_id: canonicalTarget.id, updated_at: now })
      .where("media_id", "=", source.id)
      .execute();

    if (variantsToDelete.length > 0) {
      await trx.deleteFrom("variants").where("id", "in", variantsToDelete).execute();
    }

    // 4. Migrate non-conflicting platform_checks from source to canonicalTarget
    const [sourceChecks, targetChecks] = await Promise.all([
      trx
        .selectFrom("platform_checks")
        .select(["id", "platform"])
        .where("media_id", "=", source.id)
        .execute(),
      trx
        .selectFrom("platform_checks")
        .select(["platform"])
        .where("media_id", "=", canonicalTarget.id)
        .execute(),
    ]);

    const targetCheckedPlatforms = new Set(targetChecks.map((row) => row.platform));
    for (const check of sourceChecks) {
      if (!targetCheckedPlatforms.has(check.platform)) {
        await trx
          .updateTable("platform_checks")
          .set({ media_id: canonicalTarget.id, updated_at: now })
          .where("id", "=", check.id)
          .execute();
        targetCheckedPlatforms.add(check.platform);
      }
    }

    // 5. Resolve open tmdb_missing_or_merged alerts on source & move remaining open alerts to target
    const resolvedAlerts = await trx
      .updateTable("review_alerts")
      .set({
        status: "resolved",
        resolved_at: now,
        resolved_by_user_id: input.actorUserId,
      })
      .where("media_id", "=", source.id)
      .where("alert_type", "=", REVIEW_ALERT_TYPES.TMDB_MISSING_OR_MERGED)
      .where("status", "=", "open")
      .returning("id")
      .execute();

    await trx
      .updateTable("review_alerts")
      .set({ media_id: canonicalTarget.id })
      .where("media_id", "=", source.id)
      .where("status", "=", "open")
      .execute();

    // 5. Mark any migrated/existing segments whose baseline mismatches target.baseline as needs_review
    const flaggedSegmentCount = await flagBaselineMismatchedSegments(
      trx,
      canonicalTarget.id,
      canonicalTarget.baseline,
      now,
    );

    if (flaggedSegmentCount > 0) {
      await recordOpenReviewAlert(trx, {
        alertType: REVIEW_ALERT_TYPES.SEGMENTS_NEEDS_REVIEW,
        mediaId: canonicalTarget.id,
        details: {
          reason: "media_merged_baseline_mismatch",
          sourceMediaId: source.id,
          sourceBaseline: source.baseline,
          targetBaseline: canonicalTarget.baseline,
          flaggedSegmentCount,
          actorUserId: input.actorUserId,
          mergeReason: reason,
          detectedAt: now.toISOString(),
        },
        dedupeByMediaAndType: true,
      });
    }

    return {
      sourceMediaId: source.id,
      targetMediaId: canonicalTarget.id,
      movedExternalIdCount,
      movedVariantCount,
      movedAssociationCount,
      flaggedSegmentCount,
      resolvedAlertCount: resolvedAlerts.length,
      alreadyMerged: false,
    };
  });
}

export async function switchMediaBaseline(
  db: Db,
  input: SwitchMediaBaselineInput,
): Promise<SwitchMediaBaselineResult> {
  if (!isUuid(input.mediaId)) {
    throw new MediaSyncError("INVALID_MEDIA_ID", 400, "mediaId must be a valid UUID");
  }

  if (input.newBaseline !== null && !isBaselineSource(input.newBaseline)) {
    throw new MediaSyncError(
      "INVALID_BASELINE",
      400,
      `Invalid baseline source: ${String(input.newBaseline)}`,
    );
  }

  const now = input.now ?? new Date();
  const reason = input.reason?.trim() || null;

  return db.transaction().execute(async (trx) => {
    const canonical = await resolveCanonicalMediaForUpdate(trx, input.mediaId);
    if (!canonical) {
      throw new MediaSyncError("MEDIA_NOT_FOUND", 404, `Media not found: ${input.mediaId}`);
    }

    const previousBaseline = canonical.baseline;
    await trx
      .updateTable("media")
      .set({
        baseline: input.newBaseline,
        updated_at: now,
      })
      .where("id", "=", canonical.id)
      .execute();

    const flaggedSegmentCount = await flagBaselineMismatchedSegments(
      trx,
      canonical.id,
      input.newBaseline,
      now,
    );

    if (flaggedSegmentCount > 0) {
      await recordOpenReviewAlert(trx, {
        alertType: REVIEW_ALERT_TYPES.SEGMENTS_NEEDS_REVIEW,
        mediaId: canonical.id,
        details: {
          reason: "baseline_switched",
          previousBaseline,
          newBaseline: input.newBaseline,
          flaggedSegmentCount,
          actorUserId: input.actorUserId ?? null,
          switchReason: reason,
          detectedAt: now.toISOString(),
        },
        dedupeByMediaAndType: true,
      });
    }

    return {
      mediaId: canonical.id,
      previousBaseline,
      baseline: input.newBaseline,
      flaggedSegmentCount,
    };
  });
}
