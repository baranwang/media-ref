import {
  EXTERNAL_ID_NAMESPACES,
  formatExternalKey,
  getNamespaceGroup,
  isPlatformNamespace,
  parseExternalKey,
  type BaselineSource,
  type ExternalId,
  type ExternalIdNamespace,
  type MediaSnapshot,
  type MediaType,
  type Namespace,
  type NamespaceGroup,
  type NormalizedSegment,
  type SeasonSnapshot,
} from "@media-ref/client";
import type { Database, Db, ExternalIdNamespaceRow, SeasonSnapshotRow } from "@media-ref/db";
import { sql, type Transaction } from "kysely";
import {
  createDefaultAdapterRegistry,
  isTier2Adapter,
  type AdapterRegistry,
} from "./adapters/index.ts";
import {
  parseCatalogTargetKey,
  resolveCatalogTargetSnapshot,
  type CatalogGatewayConfig,
  type CatalogTargetInitialAssociation,
} from "./catalog-gateway.ts";
import {
  computeNotFoundBackoffSeconds,
  DEFAULT_NOT_FOUND_BACKOFF_SECONDS,
  isMediaDemandCoveredInTx,
  mergeExternalKeyDemandsIntoMedia,
} from "./demands.ts";

export { computeNotFoundBackoffSeconds, DEFAULT_NOT_FOUND_BACKOFF_SECONDS } from "./demands.ts";
import {
  enqueueJob,
  type BackgroundJob,
  type JobExecutionOutcome,
  type JobHandler,
} from "./jobs.ts";
import { acquireAdvisoryLock, ADVISORY_LOCK_CLASSES } from "./locks.ts";
import { isAssociationNamespace, isUuid } from "./media-service.ts";
import type { ExternalHttpResponse, OutboundClient } from "./outbound.ts";
import { formatUtcDate } from "./tmdb-sync.ts";
import {
  createTmdbGateway,
  parseTmdbNativeId,
  type TmdbGateway,
  type TmdbGatewayConfig,
} from "./tmdb.ts";

export const EXPLORATION_JOB_TYPE = "exploration";
export const TMDB_DAILY_EXPORTS_JOB_TYPE = "tmdb_daily_exports";
export const TMDB_DAILY_EXPORTS_SYNC_KEY = "tmdb_daily_exports";
export const DEFAULT_TMDB_EXPORTS_BASE_URL = "https://files.tmdb.org/p/exports";
export const DEFAULT_EXPLORATION_DAILY_BUDGET = 100;
/** Model tokens (input + output) the agent may spend per UTC day before scheduling stops. */
export const DEFAULT_EXPLORATION_DAILY_TOKEN_BUDGET = 1_000_000_000;
export const DEFAULT_EXPLORATION_BATCH_SIZE = 10;
export const DEFAULT_EXPLORATION_LEASE_DURATION_MS = 15 * 60 * 1000;
export const DEFAULT_EXPLORATION_JOB_MAX_ATTEMPTS = 3;

const UTC_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const POSITIVE_INT_STRING_PATTERN = /^[1-9]\d*$/;
const EXPORT_UPSERT_CHUNK_SIZE = 1000;
const EXTERNAL_ID_NAMESPACE_SET: ReadonlySet<string> = new Set(EXTERNAL_ID_NAMESPACES);

export interface ExplorationSchedulerConfig {
  dailyBudget: number;
  dailyTokenBudget: number;
  batchSize: number;
  leaseDurationMs: number;
  notFoundBackoffSeconds: readonly number[];
  transientRetryDelayMs?: number;
  jobMaxAttempts?: number;
}

export interface SyncTmdbDailyExportsOptions {
  date?: string | Date;
  mediaTypes?: readonly MediaType[];
  exportBaseUrl?: string;
  replaceExisting?: boolean;
  timeoutMs?: number;
}

export interface TmdbExportMediaTypeSyncResult {
  mediaType: MediaType;
  ok: boolean;
  exportedDate: string;
  url: string;
  count: number;
  status?: number;
  error?: string;
}

export interface SyncTmdbDailyExportsResult {
  exportedDate: string;
  movie?: TmdbExportMediaTypeSyncResult;
  tv?: TmdbExportMediaTypeSyncResult;
  totalSynced: number;
}

export interface SeedTmdbExportIdEntry {
  mediaType: MediaType;
  tmdbId: string;
  exportedDate?: string;
}

export interface EnqueueTmdbDailyExportsOptions {
  now?: Date;
  date?: string | Date;
  priority?: number;
  maxAttempts?: number;
}

export interface EnqueueTmdbDailyExportsResult {
  enqueued: boolean;
  reason: "enqueued" | "already_active" | "already_synced_today" | "failed_today";
  exportDate: string;
  job?: BackgroundJob;
}

export interface CreateTmdbDailyExportsJobHandlerOptions {
  exportBaseUrl?: string;
  timeoutMs?: number;
}

export interface ScheduleExplorationJobsOptions {
  now?: Date;
  config?: Partial<ExplorationSchedulerConfig>;
  adapterRegistry?: AdapterRegistry;
}

export interface ScheduleExplorationJobsResult {
  budgetDate: string;
  dailyBudget: number;
  consumedBefore: number;
  consumedAfter: number;
  remainingBudget: number;
  invalidKeysMarked: number;
  scheduledCount: number;
  jobs: BackgroundJob[];
}

export interface ExplorationJobPayload {
  demandId: string;
  mediaId: string | null;
  externalKey: string | null;
  season: number | null;
  namespaceGroup: NamespaceGroup;
  targetNamespaces: Namespace[];
  demandLeaseGeneration: number;
}

export interface ExplorationTargetMedia {
  id: string;
  type: MediaType;
  baseline: BaselineSource | null;
  snapshot: MediaSnapshot;
  externalIds: readonly ExternalId[];
}

export interface ExplorationExecutionContext {
  db: Db;
  outbound: OutboundClient;
  adapterRegistry: AdapterRegistry;
  jobId: string;
  jobLeaseGeneration: number;
  demandId: string;
  demandLeaseGeneration: number;
  media: ExplorationTargetMedia;
  season: number | null;
  namespaceGroup: NamespaceGroup;
  targetNamespaces: readonly Namespace[];
  /** For catalog exploration: TMDB `/find` and detail lookups. */
  tmdbGateway: TmdbGateway;
  now: Date;
}

export type PlatformExplorationOutcome =
  | {
      namespace: Namespace;
      status: "submitted";
      changeRequestId?: string;
      nativeId?: string;
      /** Written straight into the library (agent external ID), no change request to wait for. */
      directWrite?: boolean;
      durationMs?: number;
    }
  | {
      namespace: Namespace;
      status: "not_found";
      reason?: string;
      durationMs?: number;
    }
  | {
      namespace: Namespace;
      status: "transient_error";
      reason: string;
      retryAfterMs?: number;
      durationMs?: number;
    };

export interface ExplorationExecutionResult {
  platformOutcomes: readonly PlatformExplorationOutcome[];
  durationMs?: number;
}

export type ExplorationExecutor = (
  ctx: ExplorationExecutionContext,
) => Promise<ExplorationExecutionResult>;

export type CatalogVerificationResult =
  | {
      status: "found";
      mediaType: MediaType;
      baseline: BaselineSource | null;
      snapshot: MediaSnapshot;
      externalIds?: Partial<Record<ExternalIdNamespace, string>>;
      initialAssociation?: CatalogTargetInitialAssociation | null;
    }
  | {
      status: "not_found";
      reason?: string;
    }
  | {
      status: "transient_error";
      reason: string;
      retryAfterMs?: number;
    };

export interface CatalogVerifierDeps {
  outbound: OutboundClient;
  adapterRegistry: AdapterRegistry;
  tmdbGateway: TmdbGateway;
  tmdbConfig?: TmdbGatewayConfig;
  catalogConfig?: CatalogGatewayConfig;
}

export type ExternalKeyCatalogVerifier = (
  externalKey: string,
  deps: CatalogVerifierDeps,
) => Promise<CatalogVerificationResult>;

export interface ExplorationJobHandlerOptions {
  adapterRegistry?: AdapterRegistry;
  catalogConfig?: CatalogGatewayConfig;
  tmdbConfig?: TmdbGatewayConfig;
  tmdbGateway?: TmdbGateway;
  config?: Partial<ExplorationSchedulerConfig>;
  executor?: ExplorationExecutor;
  catalogVerifier?: ExternalKeyCatalogVerifier;
}

type DbExecutor = Db | Transaction<Database>;

function isExternalIdNamespace(value: string): value is ExternalIdNamespace {
  return EXTERNAL_ID_NAMESPACE_SET.has(value);
}

function parsePositiveIdString(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (POSITIVE_INT_STRING_PATTERN.test(trimmed)) {
      return trimmed;
    }
  }
  return null;
}

function parseSeasonsSnapshotJson(raw: unknown): SeasonSnapshot[] {
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

function extractRegularTvSeasons(seasons: readonly SeasonSnapshot[]): number[] {
  const unique = new Set<number>();
  for (const s of seasons) {
    if (Number.isInteger(s.season) && s.season >= 1) {
      unique.add(s.season);
    }
  }
  return [...unique].sort((a, b) => a - b);
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function resolveUtcDateString(date: string | Date | undefined): string {
  if (date === undefined) {
    return formatUtcDate(new Date());
  }
  if (date instanceof Date) {
    return formatUtcDate(date);
  }
  const trimmed = date.trim();
  if (!UTC_DATE_PATTERN.test(trimmed)) {
    throw new Error(`Invalid UTC date string "${date}"; expected YYYY-MM-DD`);
  }
  return trimmed;
}

export function formatTmdbExportDate(utcDate: string): string {
  const match = utcDate.trim().match(UTC_DATE_PATTERN);
  if (!match) {
    throw new Error(`Invalid UTC date string "${utcDate}"; expected YYYY-MM-DD`);
  }
  return `${match[2]}_${match[3]}_${match[1]}`;
}

export function buildTmdbExportUrl(
  mediaType: MediaType,
  utcDate: string,
  baseUrl: string = DEFAULT_TMDB_EXPORTS_BASE_URL,
): string {
  const formatted = formatTmdbExportDate(utcDate);
  const filePrefix = mediaType === "movie" ? "movie_ids" : "tv_series_ids";
  return `${trimTrailingSlash(baseUrl)}/${filePrefix}_${formatted}.json.gz`;
}

export function parseExplorationBackoffSeconds(
  raw: string | undefined,
  fallback: readonly number[] = DEFAULT_NOT_FOUND_BACKOFF_SECONDS,
): number[] {
  if (!raw || raw.trim() === "") {
    return [...fallback];
  }
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    return [...fallback];
  }

  const parsed: number[] = [];
  for (const part of parts) {
    if (!POSITIVE_INT_STRING_PATTERN.test(part)) {
      return [...fallback];
    }
    const seconds = Number.parseInt(part, 10);
    if (!Number.isSafeInteger(seconds) || seconds <= 0) {
      return [...fallback];
    }
    parsed.push(seconds);
  }

  return parsed;
}

export function resolveExplorationSchedulerConfig(
  partial: Partial<ExplorationSchedulerConfig> = {},
): ExplorationSchedulerConfig {
  const dailyBudget =
    partial.dailyBudget !== undefined &&
    Number.isInteger(partial.dailyBudget) &&
    partial.dailyBudget >= 0
      ? partial.dailyBudget
      : DEFAULT_EXPLORATION_DAILY_BUDGET;

  const dailyTokenBudget =
    partial.dailyTokenBudget !== undefined &&
    Number.isFinite(partial.dailyTokenBudget) &&
    partial.dailyTokenBudget >= 0
      ? partial.dailyTokenBudget
      : DEFAULT_EXPLORATION_DAILY_TOKEN_BUDGET;

  const batchSize =
    partial.batchSize !== undefined && Number.isInteger(partial.batchSize) && partial.batchSize > 0
      ? partial.batchSize
      : DEFAULT_EXPLORATION_BATCH_SIZE;

  const leaseDurationMs =
    partial.leaseDurationMs !== undefined &&
    Number.isFinite(partial.leaseDurationMs) &&
    partial.leaseDurationMs > 0
      ? partial.leaseDurationMs
      : DEFAULT_EXPLORATION_LEASE_DURATION_MS;

  const rawBackoff = partial.notFoundBackoffSeconds;
  const notFoundBackoffSeconds =
    rawBackoff && rawBackoff.length > 0 && rawBackoff.every((v) => Number.isFinite(v) && v > 0)
      ? [...rawBackoff]
      : [...DEFAULT_NOT_FOUND_BACKOFF_SECONDS];

  const transientRetryDelayMs =
    partial.transientRetryDelayMs !== undefined &&
    Number.isFinite(partial.transientRetryDelayMs) &&
    partial.transientRetryDelayMs >= 0
      ? partial.transientRetryDelayMs
      : 0;

  const jobMaxAttempts =
    partial.jobMaxAttempts !== undefined &&
    Number.isInteger(partial.jobMaxAttempts) &&
    partial.jobMaxAttempts > 0
      ? partial.jobMaxAttempts
      : DEFAULT_EXPLORATION_JOB_MAX_ATTEMPTS;

  return {
    dailyBudget,
    dailyTokenBudget,
    batchSize,
    leaseDurationMs,
    notFoundBackoffSeconds,
    transientRetryDelayMs,
    jobMaxAttempts,
  };
}

/**
 * Catalog namespaces the agent has a candidate source for: Douban via IMDb lookup (change request)
 * and the TMDB external ID via TMDB `/find` (written directly). Bangumi has no source yet.
 */
const CATALOG_EXPLORATION_NAMESPACES: ReadonlySet<Namespace> = new Set(["douban"]);

/**
 * Namespaces exploration can target. Platforms only need `fetchCollection` (Tier 2+): candidates
 * come from the discovery sources, not platform search. Catalog targets are the namespaces in
 * `CATALOG_EXPLORATION_NAMESPACES` with a Tier 2+ adapter, plus `tmdb` (an external ID, no adapter).
 */
export function getExplorationTargetNamespaces(
  adapterRegistry: AdapterRegistry,
  namespaceGroup: NamespaceGroup,
): Namespace[] {
  const targets = new Set<Namespace>(namespaceGroup === "catalog" ? ["tmdb"] : []);
  for (const adapter of adapterRegistry.list()) {
    const explorable =
      isTier2Adapter(adapter) &&
      (namespaceGroup === "platform" || CATALOG_EXPLORATION_NAMESPACES.has(adapter.namespace));
    if (explorable && getNamespaceGroup(adapter.namespace) === namespaceGroup) {
      targets.add(adapter.namespace);
    }
  }
  return [...targets].sort();
}

function hasGzipMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function gunzipToUtf8(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const stream = new Blob([copy]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

function decodeBase64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded.trim());
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i) & 0xff;
  }
  return bytes;
}

async function decodeTmdbExportResponseText(response: ExternalHttpResponse): Promise<string> {
  if (response.bodyBytes && response.bodyBytes.byteLength > 0) {
    if (hasGzipMagic(response.bodyBytes)) {
      return gunzipToUtf8(response.bodyBytes);
    }
    return new TextDecoder().decode(response.bodyBytes);
  }

  const body = response.body;
  if (body.length === 0) {
    return "";
  }

  if (response.headers["content-transfer-encoding"]?.toLowerCase() === "base64") {
    const decoded = decodeBase64ToBytes(body);
    if (hasGzipMagic(decoded)) {
      return gunzipToUtf8(decoded);
    }
    return new TextDecoder().decode(decoded);
  }

  if (body.length >= 2 && body.charCodeAt(0) === 0x1f && body.charCodeAt(1) === 0x8b) {
    const rawBytes = new Uint8Array(body.length);
    for (let i = 0; i < body.length; i += 1) {
      rawBytes[i] = body.charCodeAt(i) & 0xff;
    }
    return gunzipToUtf8(rawBytes);
  }

  return body;
}

function parseTmdbExportNdjsonIds(ndjson: string): string[] {
  const ids = new Set<string>();
  const lines = ndjson.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    const id = parsePositiveIdString((parsed as Record<string, unknown>).id);
    if (id) {
      ids.add(id);
    }
  }

  return [...ids];
}

async function upsertTmdbExportIdRows(
  executor: DbExecutor,
  rows: ReadonlyArray<{ media_type: MediaType; tmdb_id: string; exported_date: string }>,
): Promise<number> {
  if (rows.length === 0) {
    return 0;
  }

  for (let i = 0; i < rows.length; i += EXPORT_UPSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + EXPORT_UPSERT_CHUNK_SIZE);
    await executor
      .insertInto("tmdb_daily_export_ids")
      .values(chunk)
      .onConflict((oc) =>
        oc.columns(["media_type", "tmdb_id"]).doUpdateSet({
          exported_date: (eb) => eb.ref("excluded.exported_date"),
        }),
      )
      .execute();
  }

  return rows.length;
}

export async function seedTmdbExportIds(
  db: Db,
  entries: readonly SeedTmdbExportIdEntry[],
  defaultExportedDate: string = formatUtcDate(new Date()),
): Promise<number> {
  const normalizedDate = resolveUtcDateString(defaultExportedDate);
  const deduped = new Map<
    string,
    { media_type: MediaType; tmdb_id: string; exported_date: string }
  >();

  for (const entry of entries) {
    const id = parsePositiveIdString(entry.tmdbId);
    if (!id) {
      throw new Error(`Invalid TMDB ID for export seed: "${entry.tmdbId}"`);
    }
    const entryDate = entry.exportedDate
      ? resolveUtcDateString(entry.exportedDate)
      : normalizedDate;
    deduped.set(`${entry.mediaType}:${id}`, {
      media_type: entry.mediaType,
      tmdb_id: id,
      exported_date: entryDate,
    });
  }

  return db.transaction().execute((trx) => upsertTmdbExportIdRows(trx, [...deduped.values()]));
}

export async function syncTmdbDailyExports(
  db: Db,
  outbound: OutboundClient,
  options: SyncTmdbDailyExportsOptions = {},
): Promise<SyncTmdbDailyExportsResult> {
  const exportedDate = resolveUtcDateString(options.date);
  const mediaTypes = options.mediaTypes ?? (["movie", "tv"] as const);
  const baseUrl = options.exportBaseUrl ?? DEFAULT_TMDB_EXPORTS_BASE_URL;
  const replaceExisting = options.replaceExisting !== false;

  const result: SyncTmdbDailyExportsResult = {
    exportedDate,
    totalSynced: 0,
  };

  for (const mediaType of mediaTypes) {
    const url = buildTmdbExportUrl(mediaType, exportedDate, baseUrl);
    let response: ExternalHttpResponse;
    try {
      response = await outbound.fetchExternal({
        kind: "catalog",
        namespace: "tmdb",
        url,
        method: "GET",
        timeoutMs: options.timeoutMs,
      });
    } catch (error) {
      const entry: TmdbExportMediaTypeSyncResult = {
        mediaType,
        ok: false,
        exportedDate,
        url,
        count: 0,
        error: error instanceof Error ? error.message : String(error),
      };
      result[mediaType] = entry;
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      const entry: TmdbExportMediaTypeSyncResult = {
        mediaType,
        ok: false,
        exportedDate,
        url,
        count: 0,
        status: response.status,
        error: `TMDB export returned HTTP ${response.status}`,
      };
      result[mediaType] = entry;
      continue;
    }

    let text: string;
    try {
      text = await decodeTmdbExportResponseText(response);
    } catch (error) {
      const entry: TmdbExportMediaTypeSyncResult = {
        mediaType,
        ok: false,
        exportedDate,
        url,
        count: 0,
        status: response.status,
        error: `Failed to decode TMDB export: ${error instanceof Error ? error.message : String(error)}`,
      };
      result[mediaType] = entry;
      continue;
    }

    const ids = parseTmdbExportNdjsonIds(text);
    const rows = ids.map((tmdbId) => ({
      media_type: mediaType,
      tmdb_id: tmdbId,
      exported_date: exportedDate,
    }));

    await db.transaction().execute(async (trx) => {
      await upsertTmdbExportIdRows(trx, rows);
      if (replaceExisting) {
        await trx
          .deleteFrom("tmdb_daily_export_ids")
          .where("media_type", "=", mediaType)
          .where("exported_date", "!=", exportedDate)
          .execute();
      }
    });

    const entry: TmdbExportMediaTypeSyncResult = {
      mediaType,
      ok: true,
      exportedDate,
      url,
      count: ids.length,
      status: response.status,
    };
    result[mediaType] = entry;
    result.totalSynced += ids.length;
  }

  return result;
}

export async function enqueueTmdbDailyExportsIfDue(
  db: Db,
  options: EnqueueTmdbDailyExportsOptions = {},
): Promise<EnqueueTmdbDailyExportsResult> {
  const now = options.now ?? new Date();
  const exportDate = options.date ? resolveUtcDateString(options.date) : formatUtcDate(now);

  const cursorRow = await db
    .selectFrom("sync_state")
    .select("last_synced_date")
    .where("sync_key", "=", TMDB_DAILY_EXPORTS_SYNC_KEY)
    .executeTakeFirst();

  if (cursorRow && cursorRow.last_synced_date >= exportDate) {
    return {
      enqueued: false,
      reason: "already_synced_today",
      exportDate,
    };
  }

  const dedupeKey = `${TMDB_DAILY_EXPORTS_JOB_TYPE}:${exportDate}`;
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
      exportDate,
    };
  }

  const enqueued = await enqueueJob(db, {
    jobType: TMDB_DAILY_EXPORTS_JOB_TYPE,
    dedupeKey,
    payload: { exportDate },
    priority: options.priority ?? 0,
    runAfter: now,
    maxAttempts: options.maxAttempts ?? 5,
  });

  return {
    enqueued: enqueued.created,
    reason: enqueued.created ? "enqueued" : "already_active",
    exportDate,
    job: enqueued.job,
  };
}

export function createTmdbDailyExportsJobHandler(
  options: CreateTmdbDailyExportsJobHandlerOptions = {},
): JobHandler {
  return async (ctx): Promise<JobExecutionOutcome> => {
    const rawDate = ctx.job.payload.exportDate;
    const exportDate =
      typeof rawDate === "string" && UTC_DATE_PATTERN.test(rawDate.trim())
        ? rawDate.trim()
        : formatUtcDate(ctx.now);

    const summary = await syncTmdbDailyExports(ctx.db, ctx.outbound, {
      date: exportDate,
      exportBaseUrl: options.exportBaseUrl,
      timeoutMs: options.timeoutMs,
    });

    const errors: string[] = [];
    if (!summary.movie?.ok) {
      errors.push(summary.movie?.error ?? "movie export sync failed");
    }
    if (!summary.tv?.ok) {
      errors.push(summary.tv?.error ?? "tv export sync failed");
    }

    if (errors.length > 0) {
      return {
        status: "retry",
        errorMessage: errors.join("; "),
      };
    }

    return {
      status: "completed",
      result: summary as unknown as Record<string, unknown>,
      async onCommit(trx) {
        const metadata = {
          movieCount: summary.movie?.count ?? 0,
          tvCount: summary.tv?.count ?? 0,
          totalSynced: summary.totalSynced,
          lastRunAt: ctx.now.toISOString(),
        };

        await trx
          .insertInto("sync_state")
          .values({
            sync_key: TMDB_DAILY_EXPORTS_SYNC_KEY,
            last_synced_date: exportDate,
            metadata: JSON.stringify(metadata),
            updated_at: ctx.now,
          })
          .onConflict((oc) =>
            oc.column("sync_key").doUpdateSet({
              last_synced_date: sql<string>`greatest(sync_state.last_synced_date, excluded.last_synced_date)`,
              metadata: JSON.stringify(metadata),
              updated_at: ctx.now,
            }),
          )
          .execute();
      },
    };
  };
}

export async function scheduleExplorationJobs(
  db: Db,
  options: ScheduleExplorationJobsOptions = {},
): Promise<ScheduleExplorationJobsResult> {
  const now = options.now ?? new Date();
  const config = resolveExplorationSchedulerConfig(options.config);
  const adapterRegistry = options.adapterRegistry ?? createDefaultAdapterRegistry();
  const budgetDate = formatUtcDate(now);

  const tier3ByGroup: Record<NamespaceGroup, Namespace[]> = {
    platform: getExplorationTargetNamespaces(adapterRegistry, "platform"),
    catalog: getExplorationTargetNamespaces(adapterRegistry, "catalog"),
  };

  const eligibleGroups: NamespaceGroup[] = [];
  if (tier3ByGroup.platform.length > 0) {
    eligibleGroups.push("platform");
  }
  if (tier3ByGroup.catalog.length > 0) {
    eligibleGroups.push("catalog");
  }

  if (eligibleGroups.length === 0) {
    const existingBudget = await db
      .selectFrom("exploration_daily_budget")
      .select("consumed")
      .where("budget_date", "=", budgetDate)
      .executeTakeFirst();
    const consumedBefore = existingBudget?.consumed ?? 0;
    return {
      budgetDate,
      dailyBudget: config.dailyBudget,
      consumedBefore,
      consumedAfter: consumedBefore,
      remainingBudget: Math.max(0, config.dailyBudget - consumedBefore),
      invalidKeysMarked: 0,
      scheduledCount: 0,
      jobs: [],
    };
  }

  return db.transaction().execute(async (trx) => {
    await trx
      .insertInto("exploration_daily_budget")
      .values({
        budget_date: budgetDate,
        consumed: 0,
        updated_at: now,
      })
      .onConflict((oc) => oc.column("budget_date").doNothing())
      .execute();

    const budgetRow = await trx
      .selectFrom("exploration_daily_budget")
      .select(["budget_date", "consumed", "tokens_used"])
      .where("budget_date", "=", budgetDate)
      .forUpdate()
      .executeTakeFirstOrThrow();

    const consumedBefore = budgetRow.consumed;
    const remainingBefore = Math.max(0, config.dailyBudget - consumedBefore);
    const tokensExhausted = Number(budgetRow.tokens_used) >= config.dailyTokenBudget;
    if (remainingBefore <= 0 || tokensExhausted || config.batchSize <= 0) {
      return {
        budgetDate,
        dailyBudget: config.dailyBudget,
        consumedBefore,
        consumedAfter: consumedBefore,
        remainingBudget: remainingBefore,
        invalidKeysMarked: 0,
        scheduledCount: 0,
        jobs: [],
      };
    }

    const maxToClaim = Math.min(config.batchSize, remainingBefore);

    const exportTypeRows = await trx
      .selectFrom("tmdb_daily_export_ids")
      .select("media_type")
      .distinct()
      .execute();
    const syncedExportTypes = new Set<MediaType>(exportTypeRows.map((row) => row.media_type));

    const scheduledJobs: BackgroundJob[] = [];
    let consumedDelta = 0;
    let invalidKeysMarked = 0;

    while (scheduledJobs.length < maxToClaim) {
      const needed = maxToClaim - scheduledJobs.length;
      const candidates = await trx
        .selectFrom("demands")
        .selectAll()
        .where("namespace_group", "in", eligibleGroups)
        .where((eb) =>
          eb.or([
            eb.and([eb("status", "in", ["open", "not_found"]), eb("next_eligible_at", "<=", now)]),
            eb.and([
              eb("status", "=", "leased"),
              eb("lease_expires_at", "is not", null),
              eb("lease_expires_at", "<=", now),
            ]),
          ]),
        )
        .orderBy("demand_count", "desc")
        .orderBy("last_demanded_at", "desc")
        .orderBy("created_at", "asc")
        .orderBy("id", "asc")
        .limit(needed)
        .forUpdate()
        .skipLocked()
        .execute();

      if (candidates.length === 0) {
        break;
      }

      let skippedInBatch = 0;

      for (const demand of candidates) {
        if (demand.media_id === null) {
          const parsedKey = demand.external_key ? parseExternalKey(demand.external_key) : null;
          if (!parsedKey) {
            await trx
              .updateTable("demands")
              .set({
                status: "invalid_key",
                lease_expires_at: null,
                updated_at: now,
              })
              .where("id", "=", demand.id)
              .execute();
            invalidKeysMarked += 1;
            skippedInBatch += 1;
            continue;
          }

          if (!parseCatalogTargetKey(demand.external_key!)) {
            const existingByKey = await findExistingMediaIdByExternalKey(trx, demand.external_key!);
            if (!existingByKey) {
              await trx
                .updateTable("demands")
                .set({
                  status: "invalid_key",
                  lease_expires_at: null,
                  updated_at: now,
                })
                .where("id", "=", demand.id)
                .execute();
              invalidKeysMarked += 1;
              skippedInBatch += 1;
              continue;
            }
          }

          if (parsedKey.namespace === "tmdb") {
            const tmdbParsed = parseTmdbNativeId(parsedKey.nativeId);
            if (!tmdbParsed) {
              await trx
                .updateTable("demands")
                .set({
                  status: "invalid_key",
                  lease_expires_at: null,
                  updated_at: now,
                })
                .where("id", "=", demand.id)
                .execute();
              invalidKeysMarked += 1;
              skippedInBatch += 1;
              continue;
            }

            if (syncedExportTypes.has(tmdbParsed.type)) {
              const exportMatch = await trx
                .selectFrom("tmdb_daily_export_ids")
                .select("tmdb_id")
                .where("media_type", "=", tmdbParsed.type)
                .where("tmdb_id", "=", tmdbParsed.id)
                .executeTakeFirst();

              if (!exportMatch) {
                await trx
                  .updateTable("demands")
                  .set({
                    status: "invalid_key",
                    lease_expires_at: null,
                    updated_at: now,
                  })
                  .where("id", "=", demand.id)
                  .execute();
                invalidKeysMarked += 1;
                skippedInBatch += 1;
                continue;
              }
            }
          }
        } else {
          const alreadyCovered = await isMediaDemandCoveredInTx(trx, {
            mediaId: demand.media_id,
            season: demand.season,
            namespaceGroup: demand.namespace_group,
          });
          if (alreadyCovered) {
            await trx
              .updateTable("demands")
              .set({
                status: "fulfilled",
                lease_expires_at: null,
                updated_at: now,
              })
              .where("id", "=", demand.id)
              .execute();
            skippedInBatch += 1;
            continue;
          }
        }

        const newLeaseGeneration = demand.lease_generation + 1;
        const leaseExpiresAt = new Date(now.getTime() + config.leaseDurationMs);
        const targetNamespaces = tier3ByGroup[demand.namespace_group];

        if (demand.status === "leased" && demand.lease_generation > 0) {
          await trx
            .updateTable("background_jobs")
            .set({
              status: "failed",
              error_message: "demand_lease_expired_superseded",
              lease_expires_at: null,
              updated_at: now,
            })
            .where(
              "dedupe_key",
              "=",
              `${EXPLORATION_JOB_TYPE}:${demand.id}:gen:${demand.lease_generation}`,
            )
            .where("status", "in", ["pending", "leased"])
            .execute();
        }

        await trx
          .updateTable("demands")
          .set({
            status: "leased",
            lease_generation: newLeaseGeneration,
            lease_expires_at: leaseExpiresAt,
            updated_at: now,
          })
          .where("id", "=", demand.id)
          .execute();

        const payload: ExplorationJobPayload = {
          demandId: demand.id,
          mediaId: demand.media_id,
          externalKey: demand.external_key,
          season: demand.season,
          namespaceGroup: demand.namespace_group,
          targetNamespaces: [...targetNamespaces],
          demandLeaseGeneration: newLeaseGeneration,
        };

        const enqueued = await enqueueJob(trx, {
          jobType: EXPLORATION_JOB_TYPE,
          priority: demand.demand_count,
          dedupeKey: `${EXPLORATION_JOB_TYPE}:${demand.id}:gen:${newLeaseGeneration}`,
          runAfter: now,
          maxAttempts: config.jobMaxAttempts,
          payload: payload as unknown as Record<string, unknown>,
        });

        scheduledJobs.push(enqueued.job);
        consumedDelta += 1;
      }

      if (skippedInBatch === 0) {
        break;
      }
    }

    const consumedAfter = consumedBefore + consumedDelta;
    if (consumedDelta > 0) {
      await trx
        .updateTable("exploration_daily_budget")
        .set({
          consumed: consumedAfter,
          updated_at: now,
        })
        .where("budget_date", "=", budgetDate)
        .execute();
    }

    return {
      budgetDate,
      dailyBudget: config.dailyBudget,
      consumedBefore,
      consumedAfter,
      remainingBudget: Math.max(0, config.dailyBudget - consumedAfter),
      invalidKeysMarked,
      scheduledCount: scheduledJobs.length,
      jobs: scheduledJobs,
    };
  });
}

export async function verifyExternalKeyInCatalog(
  externalKey: string,
  deps: CatalogVerifierDeps,
): Promise<CatalogVerificationResult> {
  const parsed = parseCatalogTargetKey(externalKey);
  if (!parsed) {
    return { status: "not_found", reason: "unsupported_or_invalid_catalog_key" };
  }

  const resolved = await resolveCatalogTargetSnapshot(parsed.canonicalKey, deps.outbound, {
    ...deps.catalogConfig,
    tmdb: deps.catalogConfig?.tmdb ?? deps.tmdbConfig,
    tmdbGateway: deps.catalogConfig?.tmdbGateway ?? deps.tmdbGateway,
  });

  if (resolved.status === "transient_error") {
    return {
      status: "transient_error",
      reason: resolved.reason,
      ...(resolved.retryAfterMs !== undefined ? { retryAfterMs: resolved.retryAfterMs } : {}),
    };
  }

  if (resolved.status === "not_found" || resolved.status === "invalid_key") {
    return {
      status: "not_found",
      reason: resolved.reason ?? `${parsed.namespace}_not_found`,
    };
  }

  const target = resolved.target;
  return {
    status: "found",
    mediaType: target.type,
    baseline: target.baseline,
    snapshot: target.snapshot,
    ...(Object.keys(target.externalIds).length > 0 ? { externalIds: target.externalIds } : {}),
    initialAssociation: target.initialAssociation,
  };
}

async function resolveCanonicalMediaId(db: DbExecutor, mediaId: string): Promise<string | null> {
  let currentId = mediaId;
  for (let hop = 0; hop < 10; hop += 1) {
    const row = await db
      .selectFrom("media")
      .select(["id", "merged_into_media_id"])
      .where("id", "=", currentId)
      .executeTakeFirst();
    if (!row) {
      return null;
    }
    if (!row.merged_into_media_id || row.merged_into_media_id === row.id) {
      return row.id;
    }
    currentId = row.merged_into_media_id;
  }
  return null;
}

async function findExistingMediaIdByExternalKey(
  db: DbExecutor,
  externalKey: string,
): Promise<string | null> {
  const parsed = parseExternalKey(externalKey);
  if (!parsed) {
    return null;
  }

  if (isExternalIdNamespace(parsed.namespace)) {
    const ext = await db
      .selectFrom("associations")
      .where("is_external_id", "=", true)
      .select("media_id")
      .where("namespace", "=", parsed.namespace)
      .where("native_id", "=", parsed.nativeId)
      .executeTakeFirst();
    if (ext) {
      return resolveCanonicalMediaId(db, ext.media_id);
    }
  }

  if (isAssociationNamespace(parsed.namespace)) {
    const assoc = await db
      .selectFrom("associations")
      .where("is_external_id", "=", false)
      .select("media_id")
      .where("namespace", "=", parsed.namespace)
      .where("native_id", "=", parsed.nativeId)
      .where("status", "=", "confirmed")
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .executeTakeFirst();
    return assoc ? resolveCanonicalMediaId(db, assoc.media_id) : null;
  }

  return null;
}

async function loadExplorationTargetMedia(
  db: DbExecutor,
  mediaId: string,
): Promise<ExplorationTargetMedia | null> {
  const canonicalId = await resolveCanonicalMediaId(db, mediaId);
  if (!canonicalId) {
    return null;
  }

  const [mediaRow, externalIdRows] = await Promise.all([
    db
      .selectFrom("media")
      .select(["id", "type", "baseline", "title", "original_title", "year", "seasons"])
      .where("id", "=", canonicalId)
      .executeTakeFirst(),
    db
      .selectFrom("associations")
      .where("is_external_id", "=", true)
      .select(["namespace", "native_id", "locked"])
      .where("media_id", "=", canonicalId)
      .orderBy("namespace", "asc")
      .orderBy("native_id", "asc")
      .$narrowType<{ namespace: ExternalIdNamespaceRow }>()
      .execute(),
  ]);

  if (!mediaRow) {
    return null;
  }

  return {
    id: mediaRow.id,
    type: mediaRow.type,
    baseline: mediaRow.baseline,
    snapshot: {
      title: mediaRow.title,
      originalTitle: mediaRow.original_title,
      year: mediaRow.year,
      type: mediaRow.type,
      seasons: parseSeasonsSnapshotJson(mediaRow.seasons),
    },
    externalIds: externalIdRows.map((row) => ({
      namespace: row.namespace,
      nativeId: row.native_id,
      ...(row.locked ? { locked: true } : {}),
    })),
  };
}

function parseExplorationJobPayload(raw: Record<string, unknown>): ExplorationJobPayload | null {
  const demandId = typeof raw.demandId === "string" && isUuid(raw.demandId) ? raw.demandId : null;
  if (!demandId) {
    return null;
  }

  const mediaId =
    raw.mediaId === null || raw.mediaId === undefined
      ? null
      : typeof raw.mediaId === "string" && isUuid(raw.mediaId)
        ? raw.mediaId
        : undefined;
  if (mediaId === undefined) {
    return null;
  }

  const externalKey =
    raw.externalKey === null || raw.externalKey === undefined
      ? null
      : typeof raw.externalKey === "string" && raw.externalKey.trim().length > 0
        ? raw.externalKey.trim()
        : undefined;
  if (externalKey === undefined) {
    return null;
  }

  const season =
    raw.season === null || raw.season === undefined
      ? null
      : typeof raw.season === "number" && Number.isInteger(raw.season) && raw.season >= 0
        ? raw.season
        : undefined;
  if (season === undefined) {
    return null;
  }

  const namespaceGroup =
    raw.namespaceGroup === "platform" || raw.namespaceGroup === "catalog"
      ? raw.namespaceGroup
      : null;
  if (!namespaceGroup) {
    return null;
  }

  const demandLeaseGeneration =
    typeof raw.demandLeaseGeneration === "number" &&
    Number.isInteger(raw.demandLeaseGeneration) &&
    raw.demandLeaseGeneration > 0
      ? raw.demandLeaseGeneration
      : null;
  if (demandLeaseGeneration === null) {
    return null;
  }

  if (!Array.isArray(raw.targetNamespaces)) {
    return null;
  }
  const targetNamespaces: Namespace[] = [];
  for (const item of raw.targetNamespaces) {
    if (typeof item === "string") {
      targetNamespaces.push(item as Namespace);
    }
  }

  return {
    demandId,
    mediaId,
    externalKey,
    season,
    namespaceGroup,
    targetNamespaces,
    demandLeaseGeneration,
  };
}

export function createExplorationJobHandler(
  options: ExplorationJobHandlerOptions = {},
): JobHandler {
  const adapterRegistry = options.adapterRegistry ?? createDefaultAdapterRegistry();
  const config = resolveExplorationSchedulerConfig(options.config);
  const catalogVerifier = options.catalogVerifier ?? verifyExternalKeyInCatalog;

  return async (ctx): Promise<JobExecutionOutcome> => {
    const payload = parseExplorationJobPayload(ctx.job.payload);
    if (!payload) {
      return {
        status: "failed",
        errorMessage: "exploration job payload is invalid",
      };
    }

    const currentDemand = await ctx.db
      .selectFrom("demands")
      .selectAll()
      .where("id", "=", payload.demandId)
      .executeTakeFirst();

    if (
      !currentDemand ||
      currentDemand.status !== "leased" ||
      currentDemand.lease_generation !== payload.demandLeaseGeneration
    ) {
      return {
        status: "completed",
        result: {
          demandId: payload.demandId,
          skipped: true,
          reason: "stale_demand_lease",
        },
      };
    }

    const tier3Allowed = new Set(
      getExplorationTargetNamespaces(adapterRegistry, payload.namespaceGroup),
    );
    const effectiveTargetNamespaces = payload.targetNamespaces.filter((ns) => tier3Allowed.has(ns));
    if (effectiveTargetNamespaces.length === 0) {
      return {
        status: "completed",
        result: {
          demandId: payload.demandId,
          skipped: true,
          reason: "no_tier3_targets",
        },
        async onCommit(trx) {
          await trx
            .updateTable("demands")
            .set({
              status: "open",
              lease_expires_at: null,
              updated_at: ctx.now,
            })
            .where("id", "=", payload.demandId)
            .where("status", "=", "leased")
            .where("lease_generation", "=", payload.demandLeaseGeneration)
            .execute();
        },
      };
    }

    if (!options.executor) {
      return {
        status: "failed",
        errorMessage: "No exploration executor configured",
      };
    }

    let activeDemandId = currentDemand.id;
    let activeDemandLeaseGeneration = currentDemand.lease_generation;
    let activeSeason = currentDemand.season;
    let activeMediaId = currentDemand.media_id;

    // Lazy media creation & non-TMDB/TMDB existence verification at exploration start
    if (activeMediaId === null) {
      const externalKey = currentDemand.external_key;
      if (!externalKey) {
        return {
          status: "completed",
          result: {
            demandId: activeDemandId,
            status: "invalid_key",
            reason: "missing_external_key",
          },
          async onCommit(trx) {
            await trx
              .updateTable("demands")
              .set({
                status: "invalid_key",
                lease_expires_at: null,
                updated_at: ctx.now,
              })
              .where("id", "=", activeDemandId)
              .where("status", "=", "leased")
              .where("lease_generation", "=", activeDemandLeaseGeneration)
              .execute();
          },
        };
      }

      let existingMediaId = await findExistingMediaIdByExternalKey(ctx.db, externalKey);
      let verifiedCatalog: Extract<CatalogVerificationResult, { status: "found" }> | null = null;

      if (!existingMediaId) {
        const tmdbGateway =
          options.tmdbGateway ??
          options.catalogConfig?.tmdbGateway ??
          createTmdbGateway(ctx.outbound, options.catalogConfig?.tmdb ?? options.tmdbConfig);
        const verification = await catalogVerifier(externalKey, {
          outbound: ctx.outbound,
          adapterRegistry,
          tmdbGateway,
          tmdbConfig: options.catalogConfig?.tmdb ?? options.tmdbConfig,
          catalogConfig: options.catalogConfig,
        });

        if (verification.status === "transient_error") {
          return {
            status: "retry",
            errorMessage: verification.reason,
            ...(verification.retryAfterMs !== undefined
              ? { delayMs: verification.retryAfterMs }
              : {}),
          };
        }

        if (verification.status === "not_found") {
          return {
            status: "completed",
            result: {
              demandId: activeDemandId,
              externalKey,
              status: "invalid_key",
              reason: verification.reason ?? "catalog_not_found",
            },
            async onCommit(trx) {
              await trx
                .updateTable("demands")
                .set({
                  status: "invalid_key",
                  lease_expires_at: null,
                  updated_at: ctx.now,
                })
                .where("id", "=", activeDemandId)
                .where("status", "=", "leased")
                .where("lease_generation", "=", activeDemandLeaseGeneration)
                .execute();
            },
          };
        }

        verifiedCatalog = verification;
      }

      const mergeTxResult = await ctx.db.transaction().execute(async (trx) => {
        // Double-check both job and demand leases inside transaction before creating media
        const lockedJob = await trx
          .selectFrom("background_jobs")
          .select(["id", "status", "lease_generation"])
          .where("id", "=", ctx.job.id)
          .where("status", "=", "leased")
          .where("lease_generation", "=", ctx.job.leaseGeneration)
          .forUpdate()
          .executeTakeFirst();

        if (!lockedJob) {
          return { kind: "stale" as const };
        }

        const lockedDemand = await trx
          .selectFrom("demands")
          .selectAll()
          .where("id", "=", activeDemandId)
          .where("status", "=", "leased")
          .where("lease_generation", "=", activeDemandLeaseGeneration)
          .forUpdate()
          .executeTakeFirst();

        if (!lockedDemand) {
          return { kind: "stale" as const };
        }

        await acquireAdvisoryLock(trx, ADVISORY_LOCK_CLASSES.MEDIA_KEY, externalKey);

        let resolvedMediaId =
          existingMediaId ?? (await findExistingMediaIdByExternalKey(trx, externalKey));
        let mediaType: MediaType | undefined;
        let mediaSeasons: readonly SeasonSnapshot[] | undefined;
        const mergeExternalKeys = new Set<string>([externalKey]);

        if (!resolvedMediaId) {
          if (!verifiedCatalog) {
            return { kind: "stale" as const };
          }

          // Also check if any synced external ID already resolves to an existing media
          if (verifiedCatalog.externalIds) {
            for (const ns of EXTERNAL_ID_NAMESPACES) {
              const val = verifiedCatalog.externalIds[ns];
              if (!val) {
                continue;
              }
              const formatted = formatExternalKey({ namespace: ns, nativeId: val });
              mergeExternalKeys.add(formatted);
              if (!resolvedMediaId) {
                resolvedMediaId = await findExistingMediaIdByExternalKey(trx, formatted);
              }
            }
          }
        }

        if (!resolvedMediaId) {
          const created = await trx
            .insertInto("media")
            .values({
              type: verifiedCatalog!.mediaType,
              baseline: verifiedCatalog!.baseline,
              title: verifiedCatalog!.snapshot.title,
              original_title: verifiedCatalog!.snapshot.originalTitle,
              year: verifiedCatalog!.snapshot.year,
              seasons: JSON.stringify(verifiedCatalog!.snapshot.seasons),
            })
            .returning(["id", "type", "baseline", "seasons"])
            .executeTakeFirstOrThrow();

          resolvedMediaId = created.id;
          mediaType = created.type;
          mediaSeasons = verifiedCatalog!.snapshot.seasons;

          if (verifiedCatalog!.externalIds) {
            for (const ns of EXTERNAL_ID_NAMESPACES) {
              const nativeVal = verifiedCatalog!.externalIds[ns];
              if (!nativeVal) {
                continue;
              }
              await trx
                .insertInto("associations")
                .values({
                  status: "confirmed",
                  is_external_id: true,
                  media_id: created.id,
                  namespace: ns,
                  native_id: nativeVal,
                  source: "sync",
                })
                .onConflict((oc) => oc.doNothing())
                .execute();
              mergeExternalKeys.add(formatExternalKey({ namespace: ns, nativeId: nativeVal }));
            }
          }

          // When lazily created from a Douban or Bangumi catalog entry, establish the initial
          // confirmed catalog association immediately so GET /v1/media/douban:<id> or bangumi:<id> resolves it.
          const parsedCatalogKey = parseCatalogTargetKey(externalKey);
          const initAssoc: CatalogTargetInitialAssociation | null =
            verifiedCatalog!.initialAssociation !== undefined
              ? verifiedCatalog!.initialAssociation
              : parsedCatalogKey &&
                  (parsedCatalogKey.namespace === "douban" ||
                    parsedCatalogKey.namespace === "bangumi")
                ? {
                    namespace: parsedCatalogKey.namespace,
                    nativeId: parsedCatalogKey.nativeId,
                  }
                : null;

          if (initAssoc) {
            const createdInitAssoc = await trx
              .insertInto("associations")
              .values({
                media_id: created.id,
                namespace: initAssoc.namespace,
                native_id: initAssoc.nativeId,
                variant_id: null,
                status: "confirmed",
                needs_review: false,
                locked: false,
              })
              .returning("id")
              .executeTakeFirstOrThrow();

            const initSegments: NormalizedSegment[] = [];
            if (created.type === "tv" && created.baseline !== null) {
              const season1 = verifiedCatalog!.snapshot.seasons.find((s) => s.season === 1);
              initSegments.push({
                season: 1,
                episodeStart: 1,
                episodeEnd: season1 && season1.episodeCount > 0 ? season1.episodeCount : null,
                targetEpisodeStart: 1,
                baseline: created.baseline,
                nonLinear: false,
                needsReview: false,
              });
              await trx
                .insertInto("segments")
                .values(
                  initSegments.map((seg) => ({
                    association_id: createdInitAssoc.id,
                    season: seg.season,
                    episode_start: seg.episodeStart,
                    episode_end: seg.episodeEnd,
                    target_episode_start: seg.targetEpisodeStart,
                    baseline: seg.baseline,
                    non_linear: seg.nonLinear,
                    needs_review: seg.needsReview,
                  })),
                )
                .execute();
            }

            const initRev = await trx
              .insertInto("association_revisions")
              .values({
                association_id: createdInitAssoc.id,
                revision_number: 1,
                change_request_id: null,
                variant_id: null,
                status: "confirmed",
                segments: JSON.stringify(initSegments),
                actor_user_id: null,
                reason: "initial_catalog_target",
              })
              .returning("id")
              .executeTakeFirstOrThrow();

            await trx
              .updateTable("associations")
              .set({ current_revision_id: initRev.id })
              .where("id", "=", createdInitAssoc.id)
              .execute();

            mergeExternalKeys.add(
              formatExternalKey({ namespace: initAssoc.namespace, nativeId: initAssoc.nativeId }),
            );
          }
        } else {
          const mediaRow = await trx
            .selectFrom("media")
            .select(["type", "seasons"])
            .where("id", "=", resolvedMediaId)
            .executeTakeFirstOrThrow();
          mediaType = mediaRow.type;
          mediaSeasons = parseSeasonsSnapshotJson(mediaRow.seasons);
        }

        const regularSeasons = extractRegularTvSeasons(mediaSeasons ?? []);
        let targetSeason: number | null;
        if (mediaType === "movie") {
          targetSeason = null;
        } else if (lockedDemand.season !== null) {
          targetSeason = lockedDemand.season;
        } else if (regularSeasons.length > 0) {
          targetSeason = regularSeasons[0]!;
        } else {
          targetSeason = null;
        }

        // Check whether target media demand is already actively leased by another exploration
        let existingTargetQuery = trx
          .selectFrom("demands")
          .select(["id", "status", "lease_expires_at"])
          .where("media_id", "=", resolvedMediaId)
          .where("namespace_group", "=", lockedDemand.namespace_group);
        existingTargetQuery =
          targetSeason === null
            ? existingTargetQuery.where("season", "is", null)
            : existingTargetQuery.where("season", "=", targetSeason);
        const existingTargetBeforeMerge = await existingTargetQuery.executeTakeFirst();
        const targetAlreadyActivelyLeased = Boolean(
          existingTargetBeforeMerge &&
          existingTargetBeforeMerge.status === "leased" &&
          existingTargetBeforeMerge.lease_expires_at &&
          existingTargetBeforeMerge.lease_expires_at.getTime() > ctx.now.getTime(),
        );

        const merged = await mergeExternalKeyDemandsIntoMedia(trx, {
          mediaId: resolvedMediaId,
          externalKeys: [...mergeExternalKeys],
          seasons: mediaSeasons,
          mediaType,
          now: ctx.now,
        });

        const mergedTarget = merged.demands.find(
          (item) =>
            item.namespaceGroup === lockedDemand.namespace_group && item.season === targetSeason,
        );

        // Reset any sibling rows created from splitting a seasonless TV demand so they aren't stranded in 'leased'
        for (const item of merged.demands) {
          if (
            item.id !== mergedTarget?.id &&
            item.status === "leased" &&
            item.leaseExpiresAt === null
          ) {
            await trx
              .updateTable("demands")
              .set({
                status: "open",
                lease_expires_at: null,
                updated_at: ctx.now,
              })
              .where("id", "=", item.id)
              .execute();
          }
        }

        if (targetAlreadyActivelyLeased || !mergedTarget) {
          return {
            kind: "merged_into_active" as const,
            mediaId: resolvedMediaId,
          };
        }

        const leaseExpiresAt =
          lockedDemand.lease_expires_at ?? new Date(ctx.now.getTime() + config.leaseDurationMs);

        const leasedTarget = await trx
          .updateTable("demands")
          .set({
            status: "leased",
            lease_generation: sql<number>`lease_generation + 1`,
            lease_expires_at: leaseExpiresAt,
            updated_at: ctx.now,
          })
          .where("id", "=", mergedTarget.id)
          .returning(["id", "lease_generation", "season"])
          .executeTakeFirstOrThrow();

        const updatedPayload: ExplorationJobPayload = {
          ...payload,
          demandId: leasedTarget.id,
          mediaId: resolvedMediaId,
          externalKey: null,
          season: leasedTarget.season,
          demandLeaseGeneration: leasedTarget.lease_generation,
        };

        await trx
          .updateTable("background_jobs")
          .set({
            payload: JSON.stringify(updatedPayload),
            updated_at: ctx.now,
          })
          .where("id", "=", ctx.job.id)
          .where("status", "=", "leased")
          .where("lease_generation", "=", ctx.job.leaseGeneration)
          .execute();

        return {
          kind: "ready" as const,
          mediaId: resolvedMediaId,
          demandId: leasedTarget.id,
          demandLeaseGeneration: leasedTarget.lease_generation,
          season: leasedTarget.season,
        };
      });

      if (mergeTxResult.kind === "stale") {
        return {
          status: "completed",
          result: {
            demandId: activeDemandId,
            skipped: true,
            reason: "stale_lease_before_media_create",
          },
        };
      }

      if (mergeTxResult.kind === "merged_into_active") {
        return {
          status: "completed",
          result: {
            demandId: activeDemandId,
            mediaId: mergeTxResult.mediaId,
            skipped: true,
            reason: "merged_into_active_media_demand",
          },
        };
      }

      activeMediaId = mergeTxResult.mediaId;
      activeDemandId = mergeTxResult.demandId;
      activeDemandLeaseGeneration = mergeTxResult.demandLeaseGeneration;
      activeSeason = mergeTxResult.season;
    }

    const targetMedia = await loadExplorationTargetMedia(ctx.db, activeMediaId);
    if (!targetMedia) {
      return {
        status: "completed",
        result: {
          demandId: activeDemandId,
          status: "invalid_key",
          reason: "media_not_found",
        },
        async onCommit(trx) {
          await trx
            .updateTable("demands")
            .set({
              status: "invalid_key",
              lease_expires_at: null,
              updated_at: ctx.now,
            })
            .where("id", "=", activeDemandId)
            .where("status", "=", "leased")
            .where("lease_generation", "=", activeDemandLeaseGeneration)
            .execute();
        },
      };
    }

    const execStartMs = Date.now();
    const execResult = await options.executor({
      db: ctx.db,
      outbound: ctx.outbound,
      adapterRegistry,
      jobId: ctx.job.id,
      jobLeaseGeneration: ctx.job.leaseGeneration,
      demandId: activeDemandId,
      demandLeaseGeneration: activeDemandLeaseGeneration,
      media: targetMedia,
      season: activeSeason,
      namespaceGroup: payload.namespaceGroup,
      targetNamespaces: effectiveTargetNamespaces,
      tmdbGateway:
        options.tmdbGateway ??
        options.catalogConfig?.tmdbGateway ??
        createTmdbGateway(ctx.outbound, options.catalogConfig?.tmdb ?? options.tmdbConfig),
      now: ctx.now,
    });
    const durationMs = execResult.durationMs ?? Math.max(0, Date.now() - execStartMs);

    const outcomes = execResult.platformOutcomes;
    const hasDirectWrite = outcomes.some((o) => o.status === "submitted" && o.directWrite);
    const hasSubmitted = outcomes.some((o) => o.status === "submitted" && !o.directWrite);
    const hasTransientError = outcomes.some((o) => o.status === "transient_error");
    const hasNotFound = outcomes.some((o) => o.status === "not_found");

    let demandOutcome: "submitted" | "not_found" | "transient_error";
    if (hasSubmitted && !hasTransientError) {
      demandOutcome = "submitted";
    } else if (hasNotFound && !hasSubmitted && !hasTransientError) {
      demandOutcome = "not_found";
    } else {
      demandOutcome = "transient_error";
    }

    return {
      status: "completed",
      result: {
        demandId: activeDemandId,
        mediaId: targetMedia.id,
        season: activeSeason,
        namespaceGroup: payload.namespaceGroup,
        targetNamespaces: effectiveTargetNamespaces,
        demandOutcome,
        platformOutcomes: outcomes,
        durationMs,
      },
      async onCommit(trx) {
        const lockedDemand = await trx
          .selectFrom("demands")
          .selectAll()
          .where("id", "=", activeDemandId)
          .where("status", "=", "leased")
          .where("lease_generation", "=", activeDemandLeaseGeneration)
          .forUpdate()
          .executeTakeFirst();

        if (!lockedDemand) {
          return;
        }

        // Write platform_checks ONLY for genuinely searched & confirmed not_found platforms
        for (const outcome of outcomes) {
          if (outcome.status !== "not_found" || !isPlatformNamespace(outcome.namespace)) {
            continue;
          }

          const existingCheck = await trx
            .selectFrom("platform_checks")
            .select(["id", "attempt_count"])
            .where("media_id", "=", targetMedia.id)
            .where("platform", "=", outcome.namespace)
            .forUpdate()
            .executeTakeFirst();

          if (existingCheck) {
            const nextAttempt = existingCheck.attempt_count + 1;
            const backoffSec = computeNotFoundBackoffSeconds(
              nextAttempt,
              config.notFoundBackoffSeconds,
            );
            const nextRetryAt = new Date(ctx.now.getTime() + backoffSec * 1000);
            await trx
              .updateTable("platform_checks")
              .set({
                status: "not_found",
                checked_at: ctx.now,
                attempt_count: nextAttempt,
                next_retry_at: nextRetryAt,
                updated_at: ctx.now,
              })
              .where("id", "=", existingCheck.id)
              .execute();
          } else {
            const backoffSec = computeNotFoundBackoffSeconds(1, config.notFoundBackoffSeconds);
            const nextRetryAt = new Date(ctx.now.getTime() + backoffSec * 1000);
            await trx
              .insertInto("platform_checks")
              .values({
                media_id: targetMedia.id,
                platform: outcome.namespace,
                status: "not_found",
                checked_at: ctx.now,
                attempt_count: 1,
                next_retry_at: nextRetryAt,
                created_at: ctx.now,
                updated_at: ctx.now,
              })
              .execute();
          }
        }

        if (
          hasDirectWrite &&
          (await isMediaDemandCoveredInTx(trx, {
            mediaId: targetMedia.id,
            season: activeSeason,
            namespaceGroup: payload.namespaceGroup,
          }))
        ) {
          await trx
            .updateTable("demands")
            .set({
              status: "fulfilled",
              last_explored_at: ctx.now,
              lease_expires_at: null,
              updated_at: ctx.now,
            })
            .where("id", "=", lockedDemand.id)
            .where("status", "=", "leased")
            .where("lease_generation", "=", activeDemandLeaseGeneration)
            .execute();
          return;
        }

        if (demandOutcome === "submitted") {
          // Submitted is not satisfied: the demand waits for its change requests to take effect.
          // If one was already applied (fast evidence check), coverage is there and it is fulfilled.
          const covered = await isMediaDemandCoveredInTx(trx, {
            mediaId: targetMedia.id,
            season: activeSeason,
            namespaceGroup: payload.namespaceGroup,
          });
          await trx
            .updateTable("demands")
            .set({
              status: covered ? "fulfilled" : "awaiting_review",
              last_explored_at: ctx.now,
              lease_expires_at: null,
              updated_at: ctx.now,
            })
            .where("id", "=", lockedDemand.id)
            .where("status", "=", "leased")
            .where("lease_generation", "=", activeDemandLeaseGeneration)
            .execute();
          return;
        }

        if (demandOutcome === "not_found") {
          const newNotFoundCount = lockedDemand.not_found_count + 1;
          const backoffSec = computeNotFoundBackoffSeconds(
            newNotFoundCount,
            config.notFoundBackoffSeconds,
          );
          const nextEligibleAt = new Date(ctx.now.getTime() + backoffSec * 1000);

          await trx
            .updateTable("demands")
            .set({
              status: "not_found",
              not_found_count: newNotFoundCount,
              next_eligible_at: nextEligibleAt,
              last_explored_at: ctx.now,
              lease_expires_at: null,
              updated_at: ctx.now,
            })
            .where("id", "=", lockedDemand.id)
            .where("status", "=", "leased")
            .where("lease_generation", "=", activeDemandLeaseGeneration)
            .execute();
          return;
        }

        // Transient error: do NOT mark not_found, do NOT increment not_found_count, reset to open
        let transientDelayMs = config.transientRetryDelayMs ?? 0;
        for (const outcome of outcomes) {
          if (
            outcome.status === "transient_error" &&
            outcome.retryAfterMs !== undefined &&
            outcome.retryAfterMs > transientDelayMs
          ) {
            transientDelayMs = outcome.retryAfterMs;
          }
        }
        const nextEligibleAt = new Date(ctx.now.getTime() + transientDelayMs);

        await trx
          .updateTable("demands")
          .set({
            status: "open",
            next_eligible_at: nextEligibleAt,
            lease_expires_at: null,
            updated_at: ctx.now,
          })
          .where("id", "=", lockedDemand.id)
          .where("status", "=", "leased")
          .where("lease_generation", "=", activeDemandLeaseGeneration)
          .execute();
      },
    };
  };
}

/** Adds model tokens the agent spent to today's budget row (UTC day of `now`). */
export async function recordExplorationTokens(db: Db, now: Date, tokens: number): Promise<void> {
  if (!(tokens > 0)) {
    return;
  }
  await db
    .insertInto("exploration_daily_budget")
    .values({
      budget_date: formatUtcDate(now),
      consumed: 0,
      tokens_used: String(tokens),
      updated_at: now,
    })
    .onConflict((oc) =>
      oc.column("budget_date").doUpdateSet({
        tokens_used: sql`exploration_daily_budget.tokens_used + ${tokens}`,
        updated_at: now,
      }),
    )
    .execute();
}
