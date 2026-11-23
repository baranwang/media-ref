import {
  EXTERNAL_ID_NAMESPACES,
  formatExternalKey,
  isPlatformNamespace,
  normalizeSegments,
  validateSharedCollectionSegments,
  validateVariantSegments,
  type BaselineSource,
  type CatalogNamespace,
  type MediaType,
  type NormalizedSegment,
  type PlatformNamespace,
} from "@media-ref/client";
import type { Database, Db, JsonObject, SeasonSnapshotRow } from "@media-ref/db";
import { sql, type Transaction } from "kysely";
import {
  AdapterTransientError,
  createDefaultAdapterRegistry,
  doubanAdapter,
  InvalidNativeIdError,
  isTier2Adapter,
  type AdapterRegistry,
} from "./adapters/index.ts";
import {
  CATALOG_EVIDENCE_PRIORITY,
  resolveCatalogTargetSnapshot,
  type CatalogGatewayConfig,
  type CatalogTargetSnapshot,
} from "./catalog-gateway.ts";
import { evaluateEvidenceGate, type EvidenceGateStep2Evaluator } from "./evidence-gate.ts";
import { enqueueJob, type JobExecutionOutcome, type JobHandler } from "./jobs.ts";
import { isUuid, type AssociationNamespace } from "./media-service.ts";
import type { ExternalHttpResponse, OutboundClient } from "./outbound.ts";
import {
  DEFAULT_TMDB_API_BASE_URL,
  DEFAULT_TMDB_LANGUAGE,
  type TmdbGateway,
  type TmdbGatewayConfig,
} from "./tmdb.ts";

export const SEED_EVIDENCE_CHECK_JOB_TYPE = "seed_evidence_check";
export const SEED_EVIDENCE_FAILED_ALERT_TYPE = "seed_evidence_failed";
export const DEFAULT_SEED_VARIANT_DESCRIPTION = "原声";

const LOCK_CLASS_MEDIA_KEY = 1001;
const LOCK_CLASS_MEDIA_NAMESPACE = 1002;
const LOCK_CLASS_VARIANT = 1003;
const LOCK_CLASS_COLLECTION = 1004;
const MAX_MERGE_HOPS = 10;

const POSITIVE_INT_PATTERN = /^[1-9]\d*$/;
const IMDB_ID_PATTERN = /^tt\d+$/i;

export type SeedSource = "wikidata" | "douban-movies" | "bangumi-data" | "douban-bridge";

export interface SeedImportSummary {
  source: SeedSource;
  processed: number;
  mediaCreated: number;
  mediaReused: number;
  associationsCreated: number;
  associationsAlreadyPresent: number;
  associationsPreservedConfirmedOrDelisted: number;
  skippedInvalid: number;
  skippedAmbiguous: number;
  skippedNonMovie: number;
  skippedDeleted: number;
  skippedUnresolvable: number;
  skippedConflict: number;
  leadsRecorded: number;
}

export interface SeedAmbiguousLead {
  source: SeedSource;
  targetExternalKey: string;
  namespace: AssociationNamespace;
  nativeId: string;
  notes: string;
}

export type SeedLeadReporter = (lead: SeedAmbiguousLead) => Promise<void> | void;

export interface WikidataSparqlBindingValue {
  type?: string;
  value?: string;
}

export type WikidataSparqlBinding = Record<string, WikidataSparqlBindingValue | undefined>;

export interface WikidataSparqlResponse {
  results?: {
    bindings?: readonly WikidataSparqlBinding[];
  };
}

export interface WikidataMovieSeedRowInput {
  item?: string | null;
  qid?: string | null;
  tmdb?: string | number | null;
  tmdbId?: string | number | null;
  tmdbMovieId?: string | number | null;
  P4947?: string | number | null;
  p4947?: string | number | null;
  douban?: string | number | null;
  doubanId?: string | number | null;
  P4529?: string | number | null;
  p4529?: string | number | null;
  imdb?: string | null;
  imdbId?: string | null;
  P345?: string | null;
  p345?: string | null;
  title?: string | null;
  label?: string | null;
  itemLabel?: string | null;
  originalTitle?: string | null;
  original_title?: string | null;
  year?: number | string | null;
  pubDate?: string | null;
  publicationDate?: string | null;
}

export type WikidataMovieSeedInput =
  | WikidataSparqlResponse
  | readonly (WikidataSparqlBinding | WikidataMovieSeedRowInput)[];

export interface ParsedWikidataMovieSeed {
  qid: string | null;
  tmdbMovieId: string;
  doubanId: string;
  imdbId: string | null;
  title: string | null;
  originalTitle: string | null;
  year: number | null;
}

export interface ParseWikidataMovieSeedsResult {
  seeds: ParsedWikidataMovieSeed[];
  processed: number;
  skippedInvalid: number;
  skippedAmbiguous: number;
}

export interface ImportWikidataMovieSeedsOptions {
  now?: Date;
}

export interface DoubanMovieSeedRecord {
  doubanId?: string | number | null;
  douban_id?: string | number | null;
  imdbId?: string | null;
  imdb_id?: string | null;
  title?: string | null;
  originalTitle?: string | null;
  original_title?: string | null;
  year?: number | string | null;
  mediaType?: string | null;
  media_type?: string | null;
  is_tv?: boolean | null;
}

export type DoubanMovieSeedInput =
  | readonly DoubanMovieSeedRecord[]
  | { records?: readonly DoubanMovieSeedRecord[]; items?: readonly DoubanMovieSeedRecord[] };

export interface ImportDoubanMovieSeedsOptions {
  tmdbConfig?: TmdbGatewayConfig;
  now?: Date;
}

export interface BangumiDataSite {
  site: string;
  id?: string | null;
  url?: string | null;
}

export interface BangumiDataItem {
  title?: string | null;
  titleTranslate?: Record<string, readonly string[] | undefined>;
  type?: string | null;
  lang?: string | null;
  begin?: string | null;
  sites?: readonly BangumiDataSite[];
}

export type BangumiDataInput = readonly BangumiDataItem[] | { items?: readonly BangumiDataItem[] };

export type ParsedBangumiDataTmdbRef =
  | { kind: "movie"; tmdbId: string }
  | { kind: "tv_season"; tmdbId: string; season: number }
  | { kind: "tv_seasonless"; tmdbId: string }
  | { kind: "invalid" };

export interface ImportBangumiDataSeedsOptions {
  outbound?: OutboundClient;
  adapterRegistry?: AdapterRegistry;
  leadsReporter?: SeedLeadReporter;
  now?: Date;
}

export interface DoubanBridgeRowInput {
  douban_id?: number | string | null;
  doubanId?: number | string | null;
  tmdb_id?: number | string | null;
  tmdbId?: number | string | null;
  imdb_id?: string | null;
  imdbId?: string | null;
  trakt_id?: number | string | null;
  traktId?: number | string | null;
  calibrated?: boolean | number | null;
  agent?: string | null;
  deleted_at?: number | string | Date | null;
  deletedAt?: number | string | Date | null;
}

export type DoubanBridgeInput =
  | readonly DoubanBridgeRowInput[]
  | { rows?: readonly DoubanBridgeRowInput[]; items?: readonly DoubanBridgeRowInput[] };

export type DoubanBridgeRowClassification =
  | {
      kind: "movie";
      title?: string | null;
      originalTitle?: string | null;
      year?: number | null;
      imdbId?: string | null;
    }
  | { kind: "tv" }
  | { kind: "ambiguous" }
  | { kind: "unknown" };

export type DoubanBridgeRowClassifier = (row: {
  doubanId: string;
  tmdbId: string;
  imdbId: string | null;
}) => Promise<DoubanBridgeRowClassification> | DoubanBridgeRowClassification;

export interface ImportDoubanBridgeMovieSeedsOptions {
  outbound?: OutboundClient;
  tmdbConfig?: TmdbGatewayConfig;
  movieTmdbIds?: ReadonlySet<string>;
  tvTmdbIds?: ReadonlySet<string>;
  useTmdbDailyExportIds?: boolean;
  classifyRow?: DoubanBridgeRowClassifier;
  leadsReporter?: SeedLeadReporter;
  now?: Date;
}

export interface UnmatchedAssociationLookupKey {
  namespace: AssociationNamespace;
  nativeId: string;
}

export interface EnqueueSeedEvidenceChecksOptions {
  now?: Date;
  unmatchedAssociationKeys?: readonly UnmatchedAssociationLookupKey[];
}

export interface EnqueueSeedEvidenceChecksResult {
  enqueuedJobIds: string[];
  alreadyCheckedCount: number;
}

export interface SeedEvidenceCheckJobOptions {
  adapterRegistry?: AdapterRegistry;
  catalogConfig?: CatalogGatewayConfig;
  tmdbConfig?: TmdbGatewayConfig;
  tmdbGateway?: TmdbGateway;
  evaluateStep2?: EvidenceGateStep2Evaluator;
}

interface ResolvedMediaRow {
  id: string;
  type: MediaType;
  baseline: BaselineSource | null;
  title: string;
  original_title: string | null;
  year: number | null;
  seasons: SeasonSnapshotRow[];
  merged_into_media_id: string | null;
}

interface UpsertSeedAssociationInput {
  source: SeedSource;
  tmdbType: MediaType;
  tmdbId: string;
  imdbId?: string | null;
  traktId?: string | null;
  title?: string | null;
  originalTitle?: string | null;
  year?: number | null;
  namespace: AssociationNamespace;
  nativeId: string;
  variantDescription?: string | null;
  segments: readonly NormalizedSegment[];
  now: Date;
}

interface UpsertSeedAssociationResult {
  outcome: "created" | "already_present" | "preserved_confirmed_or_delisted" | "skipped_conflict";
  mediaCreated: boolean;
  mediaId: string;
  associationId: string | null;
}

function createEmptySummary(source: SeedSource): SeedImportSummary {
  return {
    source,
    processed: 0,
    mediaCreated: 0,
    mediaReused: 0,
    associationsCreated: 0,
    associationsAlreadyPresent: 0,
    associationsPreservedConfirmedOrDelisted: 0,
    skippedInvalid: 0,
    skippedAmbiguous: 0,
    skippedNonMovie: 0,
    skippedDeleted: 0,
    skippedUnresolvable: 0,
    skippedConflict: 0,
    leadsRecorded: 0,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parsePositiveIntString(value: unknown): string | null {
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value > 0) {
      return String(value);
    }
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (POSITIVE_INT_PATTERN.test(trimmed)) {
      const parsed = Number(trimmed);
      if (Number.isSafeInteger(parsed) && parsed > 0) {
        return trimmed;
      }
    }
  }
  return null;
}

function normalizeImdbId(value: unknown): string | null {
  const str = nonEmptyString(value);
  if (!str || !IMDB_ID_PATTERN.test(str)) {
    return null;
  }
  return str.toLowerCase();
}

function parseYear(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 1800 && value <= 3000 ? value : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const match = value.trim().match(/^(\d{4})/);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  return Number.isInteger(year) && year >= 1800 && year <= 3000 ? year : null;
}

function normalizeWikidataQid(raw: unknown): string | null {
  const str = nonEmptyString(raw);
  if (!str) {
    return null;
  }
  const match = str.match(/(?:^|\/)(Q[1-9]\d*)$/i);
  return match ? match[1]!.toUpperCase() : null;
}

function unwrapBindingField(raw: unknown): unknown {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const rec = raw as Record<string, unknown>;
    if ("value" in rec) {
      return rec.value;
    }
  }
  return raw;
}

function pickField(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (key in record && record[key] !== undefined && record[key] !== null) {
      return unwrapBindingField(record[key]);
    }
  }
  return undefined;
}

async function acquireAdvisoryLock(
  trx: Transaction<Database>,
  lockClass: number,
  lockKey: string,
): Promise<void> {
  await sql`select pg_advisory_xact_lock(${lockClass}::int4, hashtext(${lockKey}::text))`.execute(
    trx,
  );
}

async function resolveCanonicalMediaById(
  db: Db | Transaction<Database>,
  mediaId: string,
): Promise<ResolvedMediaRow | null> {
  let currentId = mediaId;
  for (let hop = 0; hop < MAX_MERGE_HOPS; hop += 1) {
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
      return row;
    }
    currentId = row.merged_into_media_id;
  }
  return null;
}

async function loadActiveAssociationsWithSegmentsInTx(
  trx: Transaction<Database>,
  filter: {
    variantId?: string;
    mediaId?: string;
    catalogNamespace?: AssociationNamespace;
    collection?: { namespace: AssociationNamespace; nativeId: string };
    excludeAssociationId?: string;
  },
): Promise<Array<{ id: string; mediaId: string; segments: NormalizedSegment[] }>> {
  let query = trx
    .selectFrom("associations")
    .select(["id", "media_id"])
    .where("status", "!=", "delisted");

  if (filter.variantId !== undefined) {
    query = query.where("variant_id", "=", filter.variantId);
  }
  if (filter.mediaId !== undefined) {
    query = query.where("media_id", "=", filter.mediaId);
  }
  if (filter.catalogNamespace !== undefined) {
    query = query.where("namespace", "=", filter.catalogNamespace).where("variant_id", "is", null);
  }
  if (filter.collection !== undefined) {
    query = query
      .where("namespace", "=", filter.collection.namespace)
      .where("native_id", "=", filter.collection.nativeId);
  }
  if (filter.excludeAssociationId !== undefined) {
    query = query.where("id", "!=", filter.excludeAssociationId);
  }

  const associations = await query.orderBy("created_at", "asc").orderBy("id", "asc").execute();
  if (associations.length === 0) {
    return [];
  }

  const assocIds = associations.map((a) => a.id);
  const segmentRows = await trx
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
    .where("association_id", "in", assocIds)
    .orderBy("season", "asc")
    .orderBy("episode_start", "asc")
    .orderBy("id", "asc")
    .execute();

  const segmentsByAssociation = new Map<string, NormalizedSegment[]>();
  for (const seg of segmentRows) {
    const list = segmentsByAssociation.get(seg.association_id) ?? [];
    list.push({
      season: seg.season,
      episodeStart: seg.episode_start,
      episodeEnd: seg.episode_end,
      targetEpisodeStart: seg.target_episode_start,
      baseline: seg.baseline,
      nonLinear: Boolean(seg.non_linear),
      needsReview: Boolean(seg.needs_review),
    });
    segmentsByAssociation.set(seg.association_id, list);
  }

  return associations.map((a) => ({
    id: a.id,
    mediaId: a.media_id,
    segments: segmentsByAssociation.get(a.id) ?? [],
  }));
}

async function upsertSeedAssociation(
  dbWrite: Db,
  input: UpsertSeedAssociationInput,
): Promise<UpsertSeedAssociationResult> {
  const tmdbNativeId = `${input.tmdbType}:${input.tmdbId}`;
  const tmdbCanonicalKey = `tmdb:${tmdbNativeId}`;
  const normalizedImdbId = normalizeImdbId(input.imdbId);
  const normalizedSegments = normalizeSegments(input.segments);

  return dbWrite.transaction().execute(async (trx) => {
    await acquireAdvisoryLock(trx, LOCK_CLASS_MEDIA_KEY, tmdbCanonicalKey);

    let media: ResolvedMediaRow | null = null;
    let mediaCreated = false;

    const existingTmdbExt = await trx
      .selectFrom("external_ids")
      .select("media_id")
      .where("namespace", "=", "tmdb")
      .where("native_id", "=", tmdbNativeId)
      .executeTakeFirst();

    if (existingTmdbExt) {
      media = await resolveCanonicalMediaById(trx, existingTmdbExt.media_id);
    }

    if (!media && normalizedImdbId) {
      const existingImdbExt = await trx
        .selectFrom("external_ids")
        .select("media_id")
        .where("namespace", "=", "imdb")
        .where("native_id", "=", normalizedImdbId)
        .executeTakeFirst();

      if (existingImdbExt) {
        const candidate = await resolveCanonicalMediaById(trx, existingImdbExt.media_id);
        if (candidate && candidate.type === input.tmdbType) {
          const candidateTmdb = await trx
            .selectFrom("external_ids")
            .select("native_id")
            .where("media_id", "=", candidate.id)
            .where("namespace", "=", "tmdb")
            .executeTakeFirst();

          if (!candidateTmdb) {
            media = candidate;
            await trx
              .insertInto("external_ids")
              .values({
                media_id: candidate.id,
                namespace: "tmdb",
                native_id: tmdbNativeId,
                source: "sync",
              })
              .onConflict((oc) => oc.doNothing())
              .execute();
          }
        }
      }
    }

    if (!media) {
      const created = await trx
        .insertInto("media")
        .values({
          type: input.tmdbType,
          baseline: "tmdb",
          title: nonEmptyString(input.title) ?? tmdbCanonicalKey,
          original_title: nonEmptyString(input.originalTitle) ?? null,
          year: input.year ?? null,
          seasons: JSON.stringify([]),
          created_at: input.now,
          updated_at: input.now,
        })
        .returning([
          "id",
          "type",
          "baseline",
          "title",
          "original_title",
          "year",
          "seasons",
          "merged_into_media_id",
        ])
        .executeTakeFirstOrThrow();

      await trx
        .insertInto("external_ids")
        .values({
          media_id: created.id,
          namespace: "tmdb",
          native_id: tmdbNativeId,
          source: "sync",
          created_at: input.now,
          updated_at: input.now,
        })
        .onConflict((oc) => oc.doNothing())
        .execute();

      media = created;
      mediaCreated = true;
    }

    if (normalizedImdbId) {
      await trx
        .insertInto("external_ids")
        .values({
          media_id: media.id,
          namespace: "imdb",
          native_id: normalizedImdbId,
          source: "sync",
          created_at: input.now,
          updated_at: input.now,
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }

    if (input.traktId) {
      await trx
        .insertInto("external_ids")
        .values({
          media_id: media.id,
          namespace: "trakt",
          native_id: input.traktId,
          source: "sync",
          created_at: input.now,
          updated_at: input.now,
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }

    await acquireAdvisoryLock(trx, LOCK_CLASS_MEDIA_NAMESPACE, `${media.id}:${input.namespace}`);

    const existingAssociation = await trx
      .selectFrom("associations")
      .select(["id", "status"])
      .where("media_id", "=", media.id)
      .where("namespace", "=", input.namespace)
      .where("native_id", "=", input.nativeId)
      .forUpdate()
      .executeTakeFirst();

    if (existingAssociation) {
      if (existingAssociation.status === "confirmed" || existingAssociation.status === "delisted") {
        return {
          outcome: "preserved_confirmed_or_delisted",
          mediaCreated,
          mediaId: media.id,
          associationId: existingAssociation.id,
        };
      }
      return {
        outcome: "already_present",
        mediaCreated,
        mediaId: media.id,
        associationId: existingAssociation.id,
      };
    }

    const platformNamespace: PlatformNamespace | null = isPlatformNamespace(input.namespace)
      ? input.namespace
      : null;
    const variantDescription = platformNamespace
      ? (nonEmptyString(input.variantDescription) ?? DEFAULT_SEED_VARIANT_DESCRIPTION)
      : null;

    let existingVariantId: string | null = null;
    if (platformNamespace !== null && variantDescription !== null) {
      const existingVariant = await trx
        .selectFrom("variants")
        .select("id")
        .where("media_id", "=", media.id)
        .where("platform", "=", platformNamespace)
        .where("description", "=", variantDescription)
        .executeTakeFirst();
      existingVariantId = existingVariant?.id ?? null;
    }

    if (existingVariantId !== null) {
      await acquireAdvisoryLock(trx, LOCK_CLASS_VARIANT, existingVariantId);
    }

    await acquireAdvisoryLock(trx, LOCK_CLASS_COLLECTION, `${input.namespace}:${input.nativeId}`);

    if (platformNamespace !== null) {
      if (existingVariantId !== null) {
        const siblings = await loadActiveAssociationsWithSegmentsInTx(trx, {
          variantId: existingVariantId,
        });
        const variantCheck = validateVariantSegments(
          [
            ...siblings.map((entry) => ({
              associationId: entry.id,
              segments: entry.segments,
            })),
            { associationId: "seed-candidate", segments: normalizedSegments },
          ],
          { baseline: media.baseline },
        );
        if (!variantCheck.valid) {
          return {
            outcome: "skipped_conflict",
            mediaCreated,
            mediaId: media.id,
            associationId: null,
          };
        }
      }
    } else {
      const siblings = await loadActiveAssociationsWithSegmentsInTx(trx, {
        mediaId: media.id,
        catalogNamespace: input.namespace,
      });
      const catalogCheck = validateVariantSegments(
        [
          ...siblings.map((entry) => ({
            associationId: entry.id,
            segments: entry.segments,
          })),
          { associationId: "seed-candidate", segments: normalizedSegments },
        ],
        { baseline: media.baseline },
      );
      if (!catalogCheck.valid) {
        return {
          outcome: "skipped_conflict",
          mediaCreated,
          mediaId: media.id,
          associationId: null,
        };
      }
    }

    const existingOnCollection = await loadActiveAssociationsWithSegmentsInTx(trx, {
      collection: { namespace: input.namespace, nativeId: input.nativeId },
    });
    if (existingOnCollection.length > 0) {
      const sharedCheck = validateSharedCollectionSegments([
        ...existingOnCollection.map((entry) => ({
          mediaId: entry.mediaId,
          associationId: entry.id,
          segments: entry.segments,
        })),
        {
          mediaId: media.id,
          associationId: "seed-candidate",
          segments: normalizedSegments,
        },
      ]);
      if (!sharedCheck.valid) {
        return {
          outcome: "skipped_conflict",
          mediaCreated,
          mediaId: media.id,
          associationId: null,
        };
      }
    }

    let resolvedVariantId: string | null = existingVariantId;
    if (platformNamespace !== null && resolvedVariantId === null && variantDescription !== null) {
      const existingDefault = await trx
        .selectFrom("variants")
        .select("id")
        .where("media_id", "=", media.id)
        .where("platform", "=", platformNamespace)
        .where("is_default", "=", true)
        .executeTakeFirst();

      const createdVariant = await trx
        .insertInto("variants")
        .values({
          media_id: media.id,
          platform: platformNamespace,
          description: variantDescription,
          is_default: !existingDefault,
          created_at: input.now,
          updated_at: input.now,
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      resolvedVariantId = createdVariant.id;
      await acquireAdvisoryLock(trx, LOCK_CLASS_VARIANT, resolvedVariantId);
    }

    const insertedAssoc = await trx
      .insertInto("associations")
      .values({
        media_id: media.id,
        namespace: input.namespace,
        native_id: input.nativeId,
        variant_id: resolvedVariantId,
        status: "seed_unconfirmed",
        needs_review: false,
        locked: false,
        created_at: input.now,
        updated_at: input.now,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    if (normalizedSegments.length > 0) {
      await trx
        .insertInto("segments")
        .values(
          normalizedSegments.map((seg) => ({
            association_id: insertedAssoc.id,
            season: seg.season,
            episode_start: seg.episodeStart,
            episode_end: seg.episodeEnd,
            target_episode_start: seg.targetEpisodeStart,
            baseline: seg.baseline,
            non_linear: seg.nonLinear,
            needs_review: seg.needsReview,
            created_at: input.now,
            updated_at: input.now,
          })),
        )
        .execute();
    }

    const rev = await trx
      .insertInto("association_revisions")
      .values({
        association_id: insertedAssoc.id,
        revision_number: 1,
        change_request_id: null,
        variant_id: resolvedVariantId,
        status: "seed_unconfirmed",
        segments: JSON.stringify(normalizedSegments),
        actor_user_id: null,
        reason: `seed_import:${input.source}`,
        created_at: input.now,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await trx
      .updateTable("associations")
      .set({
        current_revision_id: rev.id,
        updated_at: input.now,
      })
      .where("id", "=", insertedAssoc.id)
      .execute();

    return {
      outcome: "created",
      mediaCreated,
      mediaId: media.id,
      associationId: insertedAssoc.id,
    };
  });
}

function recordUpsertOutcome(
  summary: SeedImportSummary,
  result: UpsertSeedAssociationResult,
  seenMediaIds: Set<string>,
): void {
  if (!seenMediaIds.has(result.mediaId)) {
    seenMediaIds.add(result.mediaId);
    if (result.mediaCreated) {
      summary.mediaCreated += 1;
    } else {
      summary.mediaReused += 1;
    }
  }

  switch (result.outcome) {
    case "created":
      summary.associationsCreated += 1;
      break;
    case "already_present":
      summary.associationsAlreadyPresent += 1;
      break;
    case "preserved_confirmed_or_delisted":
      summary.associationsPreservedConfirmedOrDelisted += 1;
      break;
    case "skipped_conflict":
      summary.skippedConflict += 1;
      break;
  }
}

export function parseWikidataMovieSeeds(
  input: WikidataMovieSeedInput,
): ParseWikidataMovieSeedsResult {
  const resultsObj = Array.isArray(input) ? null : asRecord(asRecord(input)?.results);
  const rawRows: readonly unknown[] = Array.isArray(input)
    ? input
    : Array.isArray(resultsObj?.bindings)
      ? resultsObj.bindings
      : [];

  let skippedInvalid = 0;
  let skippedAmbiguous = 0;

  interface ExtractedWikidataRow {
    qid: string | null;
    tmdbMovieId: string;
    doubanId: string;
    imdbId: string | null;
    title: string | null;
    originalTitle: string | null;
    year: number | null;
  }

  const validRows: ExtractedWikidataRow[] = [];
  const tmdbByQid = new Map<string, Set<string>>();
  const doubanByQid = new Map<string, Set<string>>();
  const doubanByTmdb = new Map<string, Set<string>>();
  const tmdbByDouban = new Map<string, Set<string>>();

  for (const rawRow of rawRows) {
    const rec = asRecord(rawRow);
    if (!rec) {
      skippedInvalid += 1;
      continue;
    }

    const qid = normalizeWikidataQid(pickField(rec, ["item", "entity", "qid"]));
    const tmdbMovieId = parsePositiveIntString(
      pickField(rec, ["tmdbMovieId", "tmdb", "tmdbId", "P4947", "p4947"]),
    );
    const doubanId = parsePositiveIntString(
      pickField(rec, ["doubanId", "douban", "P4529", "p4529"]),
    );

    if (!tmdbMovieId || !doubanId) {
      skippedInvalid += 1;
      continue;
    }

    const imdbId = normalizeImdbId(pickField(rec, ["imdbId", "imdb", "P345", "p345"]));
    const title = nonEmptyString(pickField(rec, ["itemLabel", "title", "label"]));
    const originalTitle = nonEmptyString(pickField(rec, ["originalTitle", "original_title"]));
    const year = parseYear(pickField(rec, ["year", "pubDate", "publicationDate"]));

    validRows.push({
      qid,
      tmdbMovieId,
      doubanId,
      imdbId,
      title,
      originalTitle,
      year,
    });

    if (qid) {
      const qTmdb = tmdbByQid.get(qid) ?? new Set<string>();
      qTmdb.add(tmdbMovieId);
      tmdbByQid.set(qid, qTmdb);

      const qDouban = doubanByQid.get(qid) ?? new Set<string>();
      qDouban.add(doubanId);
      doubanByQid.set(qid, qDouban);
    }

    const dSet = doubanByTmdb.get(tmdbMovieId) ?? new Set<string>();
    dSet.add(doubanId);
    doubanByTmdb.set(tmdbMovieId, dSet);

    const tSet = tmdbByDouban.get(doubanId) ?? new Set<string>();
    tSet.add(tmdbMovieId);
    tmdbByDouban.set(doubanId, tSet);
  }

  const dedupedByPair = new Map<string, { seed: ParsedWikidataMovieSeed; imdbIds: Set<string> }>();

  for (const row of validRows) {
    const isAmbiguousQid =
      row.qid !== null &&
      ((tmdbByQid.get(row.qid)?.size ?? 0) > 1 || (doubanByQid.get(row.qid)?.size ?? 0) > 1);
    const isAmbiguousMapping =
      (doubanByTmdb.get(row.tmdbMovieId)?.size ?? 0) > 1 ||
      (tmdbByDouban.get(row.doubanId)?.size ?? 0) > 1;

    if (isAmbiguousQid || isAmbiguousMapping) {
      skippedAmbiguous += 1;
      continue;
    }

    const pairKey = `${row.tmdbMovieId}:${row.doubanId}`;
    const existing = dedupedByPair.get(pairKey);
    if (!existing) {
      const imdbIds = new Set<string>();
      if (row.imdbId) {
        imdbIds.add(row.imdbId);
      }
      dedupedByPair.set(pairKey, {
        seed: {
          qid: row.qid,
          tmdbMovieId: row.tmdbMovieId,
          doubanId: row.doubanId,
          imdbId: row.imdbId,
          title: row.title,
          originalTitle: row.originalTitle,
          year: row.year,
        },
        imdbIds,
      });
    } else {
      if (row.imdbId) {
        existing.imdbIds.add(row.imdbId);
      }
      if (!existing.seed.title && row.title) {
        existing.seed.title = row.title;
      }
      if (!existing.seed.originalTitle && row.originalTitle) {
        existing.seed.originalTitle = row.originalTitle;
      }
      if (existing.seed.year === null && row.year !== null) {
        existing.seed.year = row.year;
      }
      if (!existing.seed.qid && row.qid) {
        existing.seed.qid = row.qid;
      }
    }
  }

  const seeds: ParsedWikidataMovieSeed[] = [];
  for (const entry of dedupedByPair.values()) {
    entry.seed.imdbId = entry.imdbIds.size === 1 ? [...entry.imdbIds][0]! : null;
    seeds.push(entry.seed);
  }

  return {
    seeds,
    processed: rawRows.length,
    skippedInvalid,
    skippedAmbiguous,
  };
}

export async function importWikidataMovieSeeds(
  dbWrite: Db,
  input: WikidataMovieSeedInput,
  options: ImportWikidataMovieSeedsOptions = {},
): Promise<SeedImportSummary> {
  const now = options.now ?? new Date();
  const parsed = parseWikidataMovieSeeds(input);
  const summary = createEmptySummary("wikidata");
  summary.processed = parsed.processed;
  summary.skippedInvalid = parsed.skippedInvalid;
  summary.skippedAmbiguous = parsed.skippedAmbiguous;

  const seenMediaIds = new Set<string>();
  for (const seed of parsed.seeds) {
    const result = await upsertSeedAssociation(dbWrite, {
      source: "wikidata",
      tmdbType: "movie",
      tmdbId: seed.tmdbMovieId,
      imdbId: seed.imdbId,
      title: seed.title,
      originalTitle: seed.originalTitle,
      year: seed.year,
      namespace: "douban",
      nativeId: seed.doubanId,
      segments: [],
      now,
    });
    recordUpsertOutcome(summary, result, seenMediaIds);
  }

  return summary;
}

interface TmdbFindMovieMatch {
  tmdbId: string;
  title: string | null;
  originalTitle: string | null;
  year: number | null;
}

type TmdbFindByImdbResult =
  | { status: "unambiguous_movie"; movie: TmdbFindMovieMatch }
  | { status: "tv_only"; tvIds: string[] }
  | { status: "ambiguous"; movieIds: string[]; tvIds: string[] }
  | { status: "not_found" }
  | { status: "error"; reason: string };

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function buildTmdbHeaders(config?: TmdbGatewayConfig): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (config?.accessToken) {
    headers.authorization = `Bearer ${config.accessToken}`;
  }
  return headers;
}

function buildTmdbUrl(
  path: string,
  params: Record<string, string>,
  config?: TmdbGatewayConfig,
): string {
  const baseUrl = trimTrailingSlash(config?.apiBaseUrl ?? DEFAULT_TMDB_API_BASE_URL);
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  if (!config?.accessToken && config?.apiKey) {
    url.searchParams.set("api_key", config.apiKey);
  }
  return url.toString();
}

async function lookupTmdbByImdbId(
  imdbId: string,
  outbound: OutboundClient,
  tmdbConfig?: TmdbGatewayConfig,
): Promise<TmdbFindByImdbResult> {
  const language = tmdbConfig?.language ?? DEFAULT_TMDB_LANGUAGE;
  const url = buildTmdbUrl(
    `/find/${encodeURIComponent(imdbId)}`,
    { external_source: "imdb_id", language },
    tmdbConfig,
  );

  let response: ExternalHttpResponse;
  try {
    response = await outbound.fetchExternal({
      kind: "catalog",
      namespace: "tmdb",
      url,
      method: "GET",
      headers: buildTmdbHeaders(tmdbConfig),
      timeoutMs: tmdbConfig?.timeoutMs,
    });
  } catch (error) {
    return {
      status: "error",
      reason: error instanceof Error ? error.message : "tmdb_find_request_failed",
    };
  }

  if (response.status === 404) {
    return { status: "not_found" };
  }
  if (response.status < 200 || response.status >= 300) {
    return { status: "error", reason: `http_${response.status}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return { status: "error", reason: "invalid_json" };
  }

  const record = asRecord(parsed);
  if (!record) {
    return { status: "error", reason: "unexpected_payload" };
  }

  const rawMovies = Array.isArray(record.movie_results) ? record.movie_results : [];
  const rawTvs = Array.isArray(record.tv_results) ? record.tv_results : [];

  const movies: TmdbFindMovieMatch[] = [];
  for (const item of rawMovies) {
    const rec = asRecord(item);
    const id = rec ? parsePositiveIntString(rec.id) : null;
    if (!id) {
      continue;
    }
    movies.push({
      tmdbId: id,
      title: nonEmptyString(rec?.title) ?? nonEmptyString(rec?.original_title),
      originalTitle: nonEmptyString(rec?.original_title),
      year: parseYear(rec?.release_date),
    });
  }

  const tvIds: string[] = [];
  for (const item of rawTvs) {
    const rec = asRecord(item);
    const id = rec ? parsePositiveIntString(rec.id) : null;
    if (id) {
      tvIds.push(id);
    }
  }

  if (movies.length === 1 && tvIds.length === 0) {
    return { status: "unambiguous_movie", movie: movies[0]! };
  }
  if (movies.length === 0 && tvIds.length > 0) {
    return { status: "tv_only", tvIds };
  }
  if (movies.length === 0 && tvIds.length === 0) {
    return { status: "not_found" };
  }
  return {
    status: "ambiguous",
    movieIds: movies.map((m) => m.tmdbId),
    tvIds,
  };
}

export async function importDoubanMovieSeeds(
  dbWrite: Db,
  input: DoubanMovieSeedInput,
  outbound: OutboundClient,
  options: ImportDoubanMovieSeedsOptions = {},
): Promise<SeedImportSummary> {
  const now = options.now ?? new Date();
  const inputObj = Array.isArray(input) ? null : asRecord(input);
  const rawRecords: readonly unknown[] = Array.isArray(input)
    ? input
    : Array.isArray(inputObj?.records)
      ? inputObj.records
      : Array.isArray(inputObj?.items)
        ? inputObj.items
        : [];

  const summary = createEmptySummary("douban-movies");
  summary.processed = rawRecords.length;

  interface NormalizedDoubanMovieRow {
    doubanId: string;
    imdbId: string;
    title: string | null;
    originalTitle: string | null;
    year: number | null;
  }

  const validRows: NormalizedDoubanMovieRow[] = [];
  const imdbByDouban = new Map<string, Set<string>>();
  const doubanByImdb = new Map<string, Set<string>>();

  for (const raw of rawRecords) {
    const rec = asRecord(raw);
    if (!rec) {
      summary.skippedInvalid += 1;
      continue;
    }

    const rawMediaType = nonEmptyString(rec.mediaType ?? rec.media_type)?.toLowerCase();
    if (rec.is_tv === true || rawMediaType === "tv" || rawMediaType === "series") {
      summary.skippedNonMovie += 1;
      continue;
    }

    const doubanId = parsePositiveIntString(rec.doubanId ?? rec.douban_id);
    const imdbId = normalizeImdbId(rec.imdbId ?? rec.imdb_id);
    if (!doubanId || !imdbId) {
      summary.skippedInvalid += 1;
      continue;
    }

    validRows.push({
      doubanId,
      imdbId,
      title: nonEmptyString(rec.title),
      originalTitle: nonEmptyString(rec.originalTitle ?? rec.original_title),
      year: parseYear(rec.year),
    });

    const iSet = imdbByDouban.get(doubanId) ?? new Set<string>();
    iSet.add(imdbId);
    imdbByDouban.set(doubanId, iSet);

    const dSet = doubanByImdb.get(imdbId) ?? new Set<string>();
    dSet.add(doubanId);
    doubanByImdb.set(imdbId, dSet);
  }

  const dedupedRows = new Map<string, NormalizedDoubanMovieRow>();
  for (const row of validRows) {
    if (
      (imdbByDouban.get(row.doubanId)?.size ?? 0) > 1 ||
      (doubanByImdb.get(row.imdbId)?.size ?? 0) > 1
    ) {
      summary.skippedAmbiguous += 1;
      continue;
    }
    const pairKey = `${row.doubanId}:${row.imdbId}`;
    if (!dedupedRows.has(pairKey)) {
      dedupedRows.set(pairKey, row);
    }
  }

  const findCache = new Map<string, TmdbFindByImdbResult>();
  const seenMediaIds = new Set<string>();

  for (const row of dedupedRows.values()) {
    let findResult = findCache.get(row.imdbId);
    if (!findResult) {
      findResult = await lookupTmdbByImdbId(row.imdbId, outbound, options.tmdbConfig);
      findCache.set(row.imdbId, findResult);
    }

    if (findResult.status === "tv_only") {
      summary.skippedNonMovie += 1;
      continue;
    }
    if (findResult.status === "ambiguous") {
      summary.skippedAmbiguous += 1;
      continue;
    }
    if (findResult.status === "not_found" || findResult.status === "error") {
      summary.skippedUnresolvable += 1;
      continue;
    }

    const movie = findResult.movie;
    const upsertResult = await upsertSeedAssociation(dbWrite, {
      source: "douban-movies",
      tmdbType: "movie",
      tmdbId: movie.tmdbId,
      imdbId: row.imdbId,
      title: movie.title ?? row.title,
      originalTitle: movie.originalTitle ?? row.originalTitle,
      year: movie.year ?? row.year,
      namespace: "douban",
      nativeId: row.doubanId,
      segments: [],
      now,
    });
    recordUpsertOutcome(summary, upsertResult, seenMediaIds);
  }

  return summary;
}

const BANGUMI_TMDB_MOVIE_PATTERN = /^movie\/([1-9]\d*)$/;
const BANGUMI_TMDB_TV_SEASON_PATTERN = /^tv\/([1-9]\d*)\/season\/(0|[1-9]\d*)$/;
const BANGUMI_TMDB_TV_SEASONLESS_PATTERN = /^tv\/([1-9]\d*)$/;
const BANGUMI_QQ_DETAIL_ID_PATTERN = /^[a-z0-9]\/[a-z0-9]{15}$/;

export function parseBangumiDataTmdbId(rawId: string): ParsedBangumiDataTmdbRef {
  const trimmed = rawId.trim();
  const movieMatch = trimmed.match(BANGUMI_TMDB_MOVIE_PATTERN);
  if (movieMatch) {
    return { kind: "movie", tmdbId: movieMatch[1]! };
  }
  const tvSeasonMatch = trimmed.match(BANGUMI_TMDB_TV_SEASON_PATTERN);
  if (tvSeasonMatch) {
    return {
      kind: "tv_season",
      tmdbId: tvSeasonMatch[1]!,
      season: Number.parseInt(tvSeasonMatch[2]!, 10),
    };
  }
  const tvSeasonlessMatch = trimmed.match(BANGUMI_TMDB_TV_SEASONLESS_PATTERN);
  if (tvSeasonlessMatch) {
    return { kind: "tv_seasonless", tmdbId: tvSeasonlessMatch[1]! };
  }
  return { kind: "invalid" };
}

interface MappedBangumiSiteCandidate {
  namespace: AssociationNamespace;
  rawInput: string;
}

function mapBangumiDataSite(site: BangumiDataSite): MappedBangumiSiteCandidate | null {
  const siteName = nonEmptyString(site.site)?.toLowerCase();
  const rawId = nonEmptyString(site.id);
  const rawUrl = nonEmptyString(site.url);
  if (!siteName || (!rawId && !rawUrl)) {
    return null;
  }

  switch (siteName) {
    case "bangumi":
      return { namespace: "bangumi", rawInput: rawId ?? rawUrl! };
    case "bilibili": {
      if (rawId && POSITIVE_INT_PATTERN.test(rawId)) {
        // bangumi-data stores bare Bilibili media IDs (md<digits>), not season IDs (ss<digits>).
        return { namespace: "bilibili", rawInput: `md${rawId}` };
      }
      return { namespace: "bilibili", rawInput: rawId ?? rawUrl! };
    }
    case "qq": {
      if (rawId && BANGUMI_QQ_DETAIL_ID_PATTERN.test(rawId)) {
        return { namespace: "tencent", rawInput: `https://v.qq.com/detail/${rawId}.html` };
      }
      return { namespace: "tencent", rawInput: rawId ?? rawUrl! };
    }
    case "iqiyi":
      return { namespace: "iqiyi", rawInput: rawId ?? rawUrl! };
    case "youku":
      return { namespace: "youku", rawInput: rawId ?? rawUrl! };
    case "mgtv":
      return { namespace: "mgtv", rawInput: rawId ?? rawUrl! };
    default:
      return null;
  }
}

function extractBangumiItemTitles(item: BangumiDataItem): {
  title: string | null;
  originalTitle: string | null;
} {
  const originalTitle = nonEmptyString(item.title);
  const zhHans = Array.isArray(item.titleTranslate?.["zh-Hans"])
    ? nonEmptyString(item.titleTranslate["zh-Hans"][0])
    : null;
  const zhHant = Array.isArray(item.titleTranslate?.["zh-Hant"])
    ? nonEmptyString(item.titleTranslate["zh-Hant"][0])
    : null;
  const title = zhHans ?? zhHant ?? originalTitle;
  return { title, originalTitle };
}

async function resolveBangumiCandidateCanonicalId(
  candidate: MappedBangumiSiteCandidate,
  adapterRegistry: AdapterRegistry,
  outbound: OutboundClient | undefined,
  cache: Map<string, string | null>,
): Promise<string | null> {
  const cacheKey = `${candidate.namespace}\0${candidate.rawInput}`;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey) ?? null;
  }

  const adapter = adapterRegistry.get(candidate.namespace);
  if (!adapter) {
    cache.set(cacheKey, null);
    return null;
  }

  const parsed = adapter.parseInput(candidate.rawInput);
  if (!parsed) {
    cache.set(cacheKey, null);
    return null;
  }

  if (parsed.canonicalId !== null) {
    cache.set(cacheKey, parsed.canonicalId);
    return parsed.canonicalId;
  }

  if (!outbound) {
    cache.set(cacheKey, null);
    return null;
  }

  try {
    const canonical = await adapter.canonicalize(candidate.rawInput, outbound);
    cache.set(cacheKey, canonical);
    return canonical;
  } catch (error) {
    if (error instanceof InvalidNativeIdError || error instanceof AdapterTransientError) {
      cache.set(cacheKey, null);
      return null;
    }
    cache.set(cacheKey, null);
    return null;
  }
}

export async function importBangumiDataSeeds(
  dbWrite: Db,
  input: BangumiDataInput,
  options: ImportBangumiDataSeedsOptions = {},
): Promise<SeedImportSummary> {
  const now = options.now ?? new Date();
  const adapterRegistry = options.adapterRegistry ?? createDefaultAdapterRegistry();
  const inputObj = Array.isArray(input) ? null : asRecord(input);
  const items: readonly unknown[] = Array.isArray(input)
    ? input
    : Array.isArray(inputObj?.items)
      ? inputObj.items
      : [];

  const summary = createEmptySummary("bangumi-data");
  summary.processed = items.length;

  const canonicalCache = new Map<string, string | null>();
  const seenMediaIds = new Set<string>();

  for (const rawItem of items) {
    const itemRec = asRecord(rawItem);
    if (!itemRec || !Array.isArray(itemRec.sites)) {
      summary.skippedInvalid += 1;
      continue;
    }

    const item = itemRec as unknown as BangumiDataItem;
    const sites = item.sites ?? [];

    const tmdbSiteIds = new Set<string>();
    for (const site of sites) {
      if (site && typeof site === "object" && nonEmptyString(site.site)?.toLowerCase() === "tmdb") {
        const id = nonEmptyString(site.id);
        if (id) {
          tmdbSiteIds.add(id);
        }
      }
    }

    if (tmdbSiteIds.size === 0 || tmdbSiteIds.size > 1) {
      summary.skippedAmbiguous += 1;
      continue;
    }

    const rawTmdbId = [...tmdbSiteIds][0]!;
    const parsedTmdb = parseBangumiDataTmdbId(rawTmdbId);

    if (parsedTmdb.kind === "invalid") {
      summary.skippedInvalid += 1;
      continue;
    }

    const mappedCandidates: MappedBangumiSiteCandidate[] = [];
    const seenCandidateKeys = new Set<string>();
    for (const site of sites) {
      if (!site || typeof site !== "object") {
        continue;
      }
      const mapped = mapBangumiDataSite(site);
      if (!mapped) {
        continue;
      }
      const key = `${mapped.namespace}\0${mapped.rawInput}`;
      if (!seenCandidateKeys.has(key)) {
        seenCandidateKeys.add(key);
        mappedCandidates.push(mapped);
      }
    }

    if (parsedTmdb.kind === "tv_seasonless") {
      summary.skippedAmbiguous += 1;
      if (options.leadsReporter) {
        const targetExternalKey = `tmdb:tv:${parsedTmdb.tmdbId}`;
        const itemLabel = nonEmptyString(item.title) ?? rawTmdbId;
        for (const candidate of mappedCandidates) {
          const canonical = await resolveBangumiCandidateCanonicalId(
            candidate,
            adapterRegistry,
            options.outbound,
            canonicalCache,
          );
          await options.leadsReporter({
            source: "bangumi-data",
            targetExternalKey,
            namespace: candidate.namespace,
            nativeId: canonical ?? candidate.rawInput,
            notes: `Ambiguous seasonless bangumi-data TV entry: ${itemLabel}`,
          });
          summary.leadsRecorded += 1;
        }
      }
      continue;
    }

    const { title, originalTitle } = extractBangumiItemTitles(item);
    const year = parseYear(item.begin);
    const tmdbType: MediaType = parsedTmdb.kind === "movie" ? "movie" : "tv";
    const segments: NormalizedSegment[] =
      parsedTmdb.kind === "tv_season"
        ? [
            {
              season: parsedTmdb.season,
              episodeStart: 1,
              episodeEnd: null,
              targetEpisodeStart: 1,
              baseline: "tmdb",
              nonLinear: false,
              needsReview: false,
            },
          ]
        : [];

    for (const candidate of mappedCandidates) {
      const canonicalId = await resolveBangumiCandidateCanonicalId(
        candidate,
        adapterRegistry,
        options.outbound,
        canonicalCache,
      );
      if (!canonicalId) {
        summary.skippedUnresolvable += 1;
        continue;
      }

      const upsertResult = await upsertSeedAssociation(dbWrite, {
        source: "bangumi-data",
        tmdbType,
        tmdbId: parsedTmdb.tmdbId,
        title,
        originalTitle,
        year,
        namespace: candidate.namespace,
        nativeId: canonicalId,
        variantDescription: isPlatformNamespace(candidate.namespace)
          ? DEFAULT_SEED_VARIANT_DESCRIPTION
          : null,
        segments,
        now,
      });
      recordUpsertOutcome(summary, upsertResult, seenMediaIds);
    }
  }

  return summary;
}

interface TmdbDirectProbeResult {
  exists: boolean;
  transientError: boolean;
  title: string | null;
  originalTitle: string | null;
  year: number | null;
  imdbId: string | null;
}

async function probeTmdbMediaEndpoint(
  tmdbType: MediaType,
  tmdbId: string,
  outbound: OutboundClient,
  tmdbConfig?: TmdbGatewayConfig,
): Promise<TmdbDirectProbeResult> {
  const language = tmdbConfig?.language ?? DEFAULT_TMDB_LANGUAGE;
  const url = buildTmdbUrl(
    `/${tmdbType}/${encodeURIComponent(tmdbId)}`,
    { append_to_response: "external_ids", language },
    tmdbConfig,
  );

  let response: ExternalHttpResponse;
  try {
    response = await outbound.fetchExternal({
      kind: "catalog",
      namespace: "tmdb",
      url,
      method: "GET",
      headers: buildTmdbHeaders(tmdbConfig),
      timeoutMs: tmdbConfig?.timeoutMs,
    });
  } catch {
    return {
      exists: false,
      transientError: true,
      title: null,
      originalTitle: null,
      year: null,
      imdbId: null,
    };
  }

  if (response.status === 404) {
    return {
      exists: false,
      transientError: false,
      title: null,
      originalTitle: null,
      year: null,
      imdbId: null,
    };
  }
  if (response.status < 200 || response.status >= 300) {
    return {
      exists: false,
      transientError: true,
      title: null,
      originalTitle: null,
      year: null,
      imdbId: null,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return {
      exists: false,
      transientError: true,
      title: null,
      originalTitle: null,
      year: null,
      imdbId: null,
    };
  }

  const data = asRecord(parsed);
  if (!data) {
    return {
      exists: false,
      transientError: true,
      title: null,
      originalTitle: null,
      year: null,
      imdbId: null,
    };
  }

  const extBlock = asRecord(data.external_ids);
  const title =
    tmdbType === "movie"
      ? (nonEmptyString(data.title) ?? nonEmptyString(data.original_title))
      : (nonEmptyString(data.name) ?? nonEmptyString(data.original_name));
  const originalTitle =
    tmdbType === "movie" ? nonEmptyString(data.original_title) : nonEmptyString(data.original_name);
  const year = tmdbType === "movie" ? parseYear(data.release_date) : parseYear(data.first_air_date);
  const imdbId = normalizeImdbId(extBlock?.imdb_id ?? data.imdb_id);

  return {
    exists: true,
    transientError: false,
    title,
    originalTitle,
    year,
    imdbId,
  };
}

async function disambiguateDoubanBridgeCollision(
  row: { doubanId: string; tmdbId: string; imdbId: string | null },
  outbound: OutboundClient | undefined,
  tmdbConfig: TmdbGatewayConfig | undefined,
  findCache: Map<string, TmdbFindByImdbResult>,
): Promise<DoubanBridgeRowClassification> {
  if (!outbound) {
    return { kind: "ambiguous" };
  }

  if (row.imdbId) {
    let findRes = findCache.get(row.imdbId);
    if (!findRes) {
      findRes = await lookupTmdbByImdbId(row.imdbId, outbound, tmdbConfig);
      findCache.set(row.imdbId, findRes);
    }
    if (findRes.status === "unambiguous_movie" && findRes.movie.tmdbId === row.tmdbId) {
      return {
        kind: "movie",
        title: findRes.movie.title,
        originalTitle: findRes.movie.originalTitle,
        year: findRes.movie.year,
        imdbId: row.imdbId,
      };
    }
    if (findRes.status === "tv_only" && findRes.tvIds.includes(row.tmdbId)) {
      return { kind: "tv" };
    }
  }

  const doubanRes = await doubanAdapter.fetchCollection(row.doubanId, outbound);
  if (doubanRes.status === "found") {
    if (doubanRes.info.mediaType === "movie") {
      return {
        kind: "movie",
        title: doubanRes.info.title,
        originalTitle: doubanRes.info.originalTitle ?? null,
        year: doubanRes.info.year,
      };
    }
    if (doubanRes.info.mediaType === "tv") {
      return { kind: "tv" };
    }
  }

  return { kind: "ambiguous" };
}

function isSoftDeleted(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return true;
}

export async function importDoubanBridgeMovieSeeds(
  dbWrite: Db,
  input: DoubanBridgeInput,
  options: ImportDoubanBridgeMovieSeedsOptions = {},
): Promise<SeedImportSummary> {
  const now = options.now ?? new Date();
  const inputObj = Array.isArray(input) ? null : asRecord(input);
  const rawRows: readonly unknown[] = Array.isArray(input)
    ? input
    : Array.isArray(inputObj?.rows)
      ? inputObj.rows
      : Array.isArray(inputObj?.items)
        ? inputObj.items
        : [];

  const summary = createEmptySummary("douban-bridge");
  summary.processed = rawRows.length;

  interface ParsedBridgeRow {
    doubanId: string;
    tmdbId: string;
    imdbId: string | null;
    traktId: string | null;
  }

  const candidateRows: ParsedBridgeRow[] = [];
  const tmdbIdsToCheck = new Set<string>();

  for (const rawRow of rawRows) {
    const rec = asRecord(rawRow);
    if (!rec) {
      summary.skippedInvalid += 1;
      continue;
    }

    if (isSoftDeleted(rec.deleted_at ?? rec.deletedAt)) {
      summary.skippedDeleted += 1;
      continue;
    }

    const doubanId = parsePositiveIntString(rec.douban_id ?? rec.doubanId);
    const tmdbId = parsePositiveIntString(rec.tmdb_id ?? rec.tmdbId);
    if (!doubanId || !tmdbId) {
      summary.skippedInvalid += 1;
      continue;
    }

    const imdbId = normalizeImdbId(rec.imdb_id ?? rec.imdbId);
    const rawTrakt = parsePositiveIntString(rec.trakt_id ?? rec.traktId);
    const traktId = rawTrakt ? `movie:${rawTrakt}` : null;

    candidateRows.push({ doubanId, tmdbId, imdbId, traktId });
    tmdbIdsToCheck.add(tmdbId);
  }

  const movieIdSet = new Set<string>(options.movieTmdbIds ?? []);
  const tvIdSet = new Set<string>(options.tvTmdbIds ?? []);

  if (options.useTmdbDailyExportIds !== false && tmdbIdsToCheck.size > 0) {
    const idList = [...tmdbIdsToCheck];
    const exportRows = await dbWrite
      .selectFrom("tmdb_daily_export_ids")
      .select(["media_type", "tmdb_id"])
      .where("tmdb_id", "in", idList)
      .execute();

    for (const exportRow of exportRows) {
      if (exportRow.media_type === "movie") {
        movieIdSet.add(exportRow.tmdb_id);
      } else if (exportRow.media_type === "tv") {
        tvIdSet.add(exportRow.tmdb_id);
      }
    }
  }

  const findCache = new Map<string, TmdbFindByImdbResult>();
  const tmdbMovieProbeCache = new Map<string, TmdbDirectProbeResult>();
  const tmdbTvProbeCache = new Map<string, TmdbDirectProbeResult>();
  const seenMediaIds = new Set<string>();

  for (const row of candidateRows) {
    let classification: DoubanBridgeRowClassification;

    if (options.classifyRow) {
      classification = await options.classifyRow({
        doubanId: row.doubanId,
        tmdbId: row.tmdbId,
        imdbId: row.imdbId,
      });
    } else {
      const inMovieExport = movieIdSet.has(row.tmdbId);
      const inTvExport = tvIdSet.has(row.tmdbId);

      if (inMovieExport && !inTvExport) {
        classification = { kind: "movie" };
      } else if (inTvExport && !inMovieExport) {
        classification = { kind: "tv" };
      } else if (inMovieExport && inTvExport) {
        classification = await disambiguateDoubanBridgeCollision(
          row,
          options.outbound,
          options.tmdbConfig,
          findCache,
        );
      } else if (options.outbound) {
        // Neither export set contained this TMDB ID -> classify via IMDb /find or TMDB /movie + /tv probes
        let resolved: DoubanBridgeRowClassification | null = null;
        if (row.imdbId) {
          let findRes = findCache.get(row.imdbId);
          if (!findRes) {
            findRes = await lookupTmdbByImdbId(row.imdbId, options.outbound, options.tmdbConfig);
            findCache.set(row.imdbId, findRes);
          }
          if (findRes.status === "unambiguous_movie" && findRes.movie.tmdbId === row.tmdbId) {
            resolved = {
              kind: "movie",
              title: findRes.movie.title,
              originalTitle: findRes.movie.originalTitle,
              year: findRes.movie.year,
              imdbId: row.imdbId,
            };
          } else if (findRes.status === "tv_only" && findRes.tvIds.includes(row.tmdbId)) {
            resolved = { kind: "tv" };
          }
        }

        if (!resolved) {
          let movieProbe = tmdbMovieProbeCache.get(row.tmdbId);
          if (!movieProbe) {
            movieProbe = await probeTmdbMediaEndpoint(
              "movie",
              row.tmdbId,
              options.outbound,
              options.tmdbConfig,
            );
            tmdbMovieProbeCache.set(row.tmdbId, movieProbe);
          }

          let tvProbe = tmdbTvProbeCache.get(row.tmdbId);
          if (!tvProbe) {
            tvProbe = await probeTmdbMediaEndpoint(
              "tv",
              row.tmdbId,
              options.outbound,
              options.tmdbConfig,
            );
            tmdbTvProbeCache.set(row.tmdbId, tvProbe);
          }

          if (movieProbe.transientError || tvProbe.transientError) {
            resolved = { kind: "unknown" };
          } else if (movieProbe.exists && !tvProbe.exists) {
            resolved = {
              kind: "movie",
              title: movieProbe.title,
              originalTitle: movieProbe.originalTitle,
              year: movieProbe.year,
              imdbId: row.imdbId ?? movieProbe.imdbId,
            };
          } else if (tvProbe.exists && !movieProbe.exists) {
            resolved = { kind: "tv" };
          } else if (movieProbe.exists && tvProbe.exists) {
            resolved = await disambiguateDoubanBridgeCollision(
              row,
              options.outbound,
              options.tmdbConfig,
              findCache,
            );
          } else {
            resolved = { kind: "unknown" };
          }
        }

        classification = resolved;
      } else {
        classification = { kind: "unknown" };
      }
    }

    if (classification.kind === "tv") {
      summary.skippedNonMovie += 1;
      if (options.leadsReporter) {
        await options.leadsReporter({
          source: "douban-bridge",
          targetExternalKey: `tmdb:tv:${row.tmdbId}`,
          namespace: "douban",
          nativeId: row.doubanId,
          notes: "Seasonless douban-bridge TV mapping skipped as seed",
        });
        summary.leadsRecorded += 1;
      }
      continue;
    }

    if (classification.kind === "ambiguous") {
      summary.skippedAmbiguous += 1;
      continue;
    }

    if (classification.kind === "unknown") {
      summary.skippedUnresolvable += 1;
      continue;
    }

    const upsertResult = await upsertSeedAssociation(dbWrite, {
      source: "douban-bridge",
      tmdbType: "movie",
      tmdbId: row.tmdbId,
      imdbId: row.imdbId ?? classification.imdbId ?? null,
      traktId: row.traktId,
      title: classification.title ?? null,
      originalTitle: classification.originalTitle ?? null,
      year: classification.year ?? null,
      namespace: "douban",
      nativeId: row.doubanId,
      segments: [],
      now,
    });
    recordUpsertOutcome(summary, upsertResult, seenMediaIds);
  }

  return summary;
}

export async function enqueueSeedEvidenceChecksForMedia(
  dbWrite: Db,
  mediaIds: readonly string[],
  options: EnqueueSeedEvidenceChecksOptions = {},
): Promise<EnqueueSeedEvidenceChecksResult> {
  const uniqueMediaIds = [...new Set(mediaIds.filter((id) => isUuid(id)))];
  const unmatchedKeys = options.unmatchedAssociationKeys ?? [];

  if (uniqueMediaIds.length === 0 && unmatchedKeys.length === 0) {
    return { enqueuedJobIds: [], alreadyCheckedCount: 0 };
  }

  const candidateById = new Map<string, { id: string; mediaId: string }>();

  if (uniqueMediaIds.length > 0) {
    const rows = await dbWrite
      .selectFrom("associations")
      .select(["id", "media_id"])
      .where("media_id", "in", uniqueMediaIds)
      .where("status", "=", "seed_unconfirmed")
      .where("needs_review", "=", false)
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute();

    for (const row of rows) {
      candidateById.set(row.id, { id: row.id, mediaId: row.media_id });
    }
  }

  if (unmatchedKeys.length > 0) {
    const byNamespace = new Map<AssociationNamespace, Set<string>>();
    for (const entry of unmatchedKeys) {
      const nativeId = entry.nativeId.trim();
      if (!nativeId) {
        continue;
      }
      const set = byNamespace.get(entry.namespace) ?? new Set<string>();
      set.add(nativeId);
      byNamespace.set(entry.namespace, set);
    }

    const nsEntries = [...byNamespace.entries()];
    if (nsEntries.length > 0) {
      const rows = await dbWrite
        .selectFrom("associations")
        .select(["id", "media_id"])
        .where("status", "=", "seed_unconfirmed")
        .where("needs_review", "=", false)
        .where((eb) =>
          eb.or(
            nsEntries.map(([namespace, nativeIds]) =>
              eb.and([eb("namespace", "=", namespace), eb("native_id", "in", [...nativeIds])]),
            ),
          ),
        )
        .orderBy("created_at", "asc")
        .orderBy("id", "asc")
        .execute();

      for (const row of rows) {
        candidateById.set(row.id, { id: row.id, mediaId: row.media_id });
      }
    }
  }

  const candidates = [...candidateById.values()];
  if (candidates.length === 0) {
    return { enqueuedJobIds: [], alreadyCheckedCount: 0 };
  }

  const dedupeKeys = candidates.map((c) => `${SEED_EVIDENCE_CHECK_JOB_TYPE}:${c.id}`);
  // Check ALL statuses (pending, leased, completed, failed) so a seed is queued ONLY on first read
  // and never spammed on subsequent reads. Never touches exploration_daily_budget.
  const existingJobs = await dbWrite
    .selectFrom("background_jobs")
    .select("dedupe_key")
    .where("job_type", "=", SEED_EVIDENCE_CHECK_JOB_TYPE)
    .where("dedupe_key", "in", dedupeKeys)
    .execute();

  const existingDedupeKeys = new Set<string>();
  for (const job of existingJobs) {
    if (job.dedupe_key) {
      existingDedupeKeys.add(job.dedupe_key);
    }
  }

  const now = options.now ?? new Date();
  const enqueuedJobIds: string[] = [];
  let alreadyCheckedCount = 0;

  for (const candidate of candidates) {
    const dedupeKey = `${SEED_EVIDENCE_CHECK_JOB_TYPE}:${candidate.id}`;
    if (existingDedupeKeys.has(dedupeKey)) {
      alreadyCheckedCount += 1;
      continue;
    }

    const enqueueRes = await enqueueJob(dbWrite, {
      jobType: SEED_EVIDENCE_CHECK_JOB_TYPE,
      dedupeKey,
      payload: {
        associationId: candidate.id,
        mediaId: candidate.mediaId,
      },
      runAfter: now,
    });

    if (enqueueRes.created) {
      enqueuedJobIds.push(enqueueRes.job.id);
    } else {
      alreadyCheckedCount += 1;
    }
  }

  return { enqueuedJobIds, alreadyCheckedCount };
}

async function resolveAuthoritativeCatalogKeyForMedia(
  db: Db,
  mediaId: string,
): Promise<string | null> {
  const [extRows, catalogAssocRows] = await Promise.all([
    db
      .selectFrom("external_ids")
      .select(["namespace", "native_id"])
      .where("media_id", "=", mediaId)
      .execute(),
    db
      .selectFrom("associations")
      .select(["namespace", "native_id"])
      .where("media_id", "=", mediaId)
      .where("namespace", "in", ["bangumi", "douban"])
      .where("status", "=", "confirmed")
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute(),
  ]);

  const keyByNamespace = new Map<CatalogNamespace, string>();
  for (const row of extRows) {
    if (!keyByNamespace.has(row.namespace)) {
      keyByNamespace.set(
        row.namespace,
        formatExternalKey({ namespace: row.namespace, nativeId: row.native_id }),
      );
    }
  }
  for (const row of catalogAssocRows) {
    const ns = row.namespace as CatalogNamespace;
    if (!keyByNamespace.has(ns)) {
      keyByNamespace.set(ns, formatExternalKey({ namespace: ns, nativeId: row.native_id }));
    }
  }

  for (const preferredNamespace of CATALOG_EVIDENCE_PRIORITY) {
    const candidate = keyByNamespace.get(preferredNamespace);
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

async function markSeedEvidenceFailedInTx(
  trx: Transaction<Database>,
  input: {
    associationId: string;
    mediaId: string;
    namespace: AssociationNamespace;
    nativeId: string;
    conflictReason: string;
    decisionReason: string;
    evidence: JsonObject;
    now: Date;
  },
): Promise<void> {
  const current = await trx
    .selectFrom("associations")
    .select(["id", "status"])
    .where("id", "=", input.associationId)
    .forUpdate()
    .executeTakeFirst();

  if (!current || current.status !== "seed_unconfirmed") {
    return;
  }

  await trx
    .updateTable("associations")
    .set({
      needs_review: true,
      updated_at: input.now,
    })
    .where("id", "=", input.associationId)
    .where("status", "=", "seed_unconfirmed")
    .execute();

  const existingOpenAlert = await trx
    .selectFrom("review_alerts")
    .select("id")
    .where("alert_type", "=", SEED_EVIDENCE_FAILED_ALERT_TYPE)
    .where("association_id", "=", input.associationId)
    .where("status", "=", "open")
    .executeTakeFirst();

  if (!existingOpenAlert) {
    await trx
      .insertInto("review_alerts")
      .values({
        alert_type: SEED_EVIDENCE_FAILED_ALERT_TYPE,
        media_id: input.mediaId,
        association_id: input.associationId,
        status: "open",
        details: JSON.stringify({
          namespace: input.namespace,
          nativeId: input.nativeId,
          conflictReason: input.conflictReason,
          decisionReason: input.decisionReason,
          evidence: input.evidence,
        }),
        created_at: input.now,
      })
      .execute();
  }
}

async function refreshSeedMediaFromCatalogInTx(
  trx: Transaction<Database>,
  media: ResolvedMediaRow,
  catalogTarget: CatalogTargetSnapshot,
  now: Date,
): Promise<void> {
  if (catalogTarget.sourceNamespace === (media.baseline ?? "tmdb")) {
    await trx
      .updateTable("media")
      .set({
        title: catalogTarget.snapshot.title,
        original_title: catalogTarget.snapshot.originalTitle,
        year: catalogTarget.snapshot.year,
        seasons: JSON.stringify(catalogTarget.snapshot.seasons),
        updated_at: now,
      })
      .where("id", "=", media.id)
      .execute();
  }

  for (const extNs of EXTERNAL_ID_NAMESPACES) {
    const extNativeId = catalogTarget.externalIds[extNs];
    if (!extNativeId) {
      continue;
    }

    const existingForMedia = await trx
      .selectFrom("external_ids")
      .select(["id", "native_id", "locked"])
      .where("media_id", "=", media.id)
      .where("namespace", "=", extNs)
      .executeTakeFirst();

    if (!existingForMedia) {
      await trx
        .insertInto("external_ids")
        .values({
          media_id: media.id,
          namespace: extNs,
          native_id: extNativeId,
          source: "sync",
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
      continue;
    }

    if (existingForMedia.locked || existingForMedia.native_id === extNativeId) {
      continue;
    }

    const ownedElsewhere = await trx
      .selectFrom("external_ids")
      .select("media_id")
      .where("namespace", "=", extNs)
      .where("native_id", "=", extNativeId)
      .executeTakeFirst();

    if (!ownedElsewhere) {
      await trx
        .updateTable("external_ids")
        .set({
          native_id: extNativeId,
          updated_at: now,
        })
        .where("id", "=", existingForMedia.id)
        .execute();
    }
  }
}

export function createSeedEvidenceCheckJobHandler(
  options: SeedEvidenceCheckJobOptions = {},
): JobHandler {
  const adapterRegistry = options.adapterRegistry ?? createDefaultAdapterRegistry();

  return async (ctx): Promise<JobExecutionOutcome> => {
    const rawAssociationId = ctx.job.payload.associationId;
    if (typeof rawAssociationId !== "string" || !isUuid(rawAssociationId)) {
      return {
        status: "failed",
        errorMessage: "seed_evidence_check job payload requires a valid associationId UUID",
      };
    }

    const assoc = await ctx.db
      .selectFrom("associations")
      .select(["id", "media_id", "namespace", "native_id", "variant_id", "status", "locked"])
      .where("id", "=", rawAssociationId)
      .executeTakeFirst();

    if (!assoc) {
      return {
        status: "completed",
        result: {
          associationId: rawAssociationId,
          skipped: true,
          reason: "association_not_found",
        },
      };
    }

    if (assoc.status !== "seed_unconfirmed") {
      return {
        status: "completed",
        result: {
          associationId: assoc.id,
          skipped: true,
          reason: `association_already_${assoc.status}`,
        },
      };
    }

    if (assoc.locked) {
      return {
        status: "completed",
        result: {
          associationId: assoc.id,
          skipped: true,
          reason: "association_locked",
        },
      };
    }

    const media = await resolveCanonicalMediaById(ctx.db, assoc.media_id);
    if (!media) {
      return {
        status: "completed",
        result: {
          associationId: assoc.id,
          skipped: true,
          reason: "media_not_found",
        },
      };
    }

    const checkedAt = ctx.now.toISOString();
    const adapter = adapterRegistry.get(assoc.namespace);
    if (!adapter || !isTier2Adapter(adapter)) {
      const evidence: JsonObject = {
        checkedAt,
        adapterTier: adapter?.tier ?? null,
        namespace: assoc.namespace,
        nativeId: assoc.native_id,
      };
      return {
        status: "completed",
        result: {
          associationId: assoc.id,
          mediaId: media.id,
          decision: "needs_review",
          conflictReason: "adapter_tier_1_manual_review",
        },
        async onCommit(trx) {
          await markSeedEvidenceFailedInTx(trx, {
            associationId: assoc.id,
            mediaId: media.id,
            namespace: assoc.namespace,
            nativeId: assoc.native_id,
            conflictReason: "adapter_tier_1_manual_review",
            decisionReason: `No Tier 2 adapter available for ${assoc.namespace}`,
            evidence,
            now: ctx.now,
          });
        },
      };
    }

    const catalogKey = await resolveAuthoritativeCatalogKeyForMedia(ctx.db, media.id);
    if (!catalogKey) {
      const evidence: JsonObject = {
        checkedAt,
        catalogStatus: "missing_catalog_key",
        mediaId: media.id,
      };
      return {
        status: "completed",
        result: {
          associationId: assoc.id,
          mediaId: media.id,
          decision: "needs_review",
          conflictReason: "catalog_not_found",
        },
        async onCommit(trx) {
          await markSeedEvidenceFailedInTx(trx, {
            associationId: assoc.id,
            mediaId: media.id,
            namespace: assoc.namespace,
            nativeId: assoc.native_id,
            conflictReason: "catalog_not_found",
            decisionReason: `No authoritative catalog external key found for media ${media.id}`,
            evidence,
            now: ctx.now,
          });
        },
      };
    }

    const catalogResult = await resolveCatalogTargetSnapshot(catalogKey, ctx.outbound, {
      ...options.catalogConfig,
      tmdb: options.catalogConfig?.tmdb ?? options.tmdbConfig,
      tmdbGateway: options.catalogConfig?.tmdbGateway ?? options.tmdbGateway,
    });

    if (catalogResult.status === "transient_error") {
      return {
        status: "retry",
        ...(catalogResult.retryAfterMs !== undefined
          ? { delayMs: catalogResult.retryAfterMs }
          : {}),
        errorMessage: catalogResult.reason,
      };
    }

    if (catalogResult.status === "not_found" || catalogResult.status === "invalid_key") {
      const evidence: JsonObject = {
        checkedAt,
        catalogStatus: catalogResult.status,
        catalogKey,
      };
      return {
        status: "completed",
        result: {
          associationId: assoc.id,
          mediaId: media.id,
          decision: "needs_review",
          conflictReason: "catalog_not_found",
        },
        async onCommit(trx) {
          await markSeedEvidenceFailedInTx(trx, {
            associationId: assoc.id,
            mediaId: media.id,
            namespace: assoc.namespace,
            nativeId: assoc.native_id,
            conflictReason: "catalog_not_found",
            decisionReason: catalogResult.reason ?? `Catalog media not found for ${catalogKey}`,
            evidence,
            now: ctx.now,
          });
        },
      };
    }

    const catalogTarget = catalogResult.target;
    const catalogEvidence = catalogTarget.evidence;

    const collectionResult = await adapter.fetchCollection(assoc.native_id, ctx.outbound);
    if (collectionResult.status === "transient_error") {
      return {
        status: "retry",
        ...(collectionResult.retryAfterMs !== undefined
          ? { delayMs: collectionResult.retryAfterMs }
          : {}),
        errorMessage: collectionResult.reason,
      };
    }

    if (collectionResult.status === "not_found") {
      const evidence: JsonObject = {
        checkedAt,
        catalog: {
          namespace: catalogEvidence.namespace,
          canonicalId: catalogEvidence.canonicalId,
          mediaType: catalogEvidence.mediaType,
          title: catalogEvidence.title,
          originalTitle: catalogEvidence.originalTitle ?? null,
          year: catalogEvidence.year,
          seasons: catalogEvidence.seasons,
          externalIds: catalogEvidence.externalIds,
        },
        collectionStatus: "not_found",
        collectionReason: collectionResult.reason ?? null,
      };
      return {
        status: "completed",
        result: {
          associationId: assoc.id,
          mediaId: media.id,
          decision: "needs_review",
          conflictReason: "collection_not_found",
        },
        async onCommit(trx) {
          await markSeedEvidenceFailedInTx(trx, {
            associationId: assoc.id,
            mediaId: media.id,
            namespace: assoc.namespace,
            nativeId: assoc.native_id,
            conflictReason: "collection_not_found",
            decisionReason:
              collectionResult.reason ??
              `Collection ${assoc.namespace}:${assoc.native_id} not found`,
            evidence,
            now: ctx.now,
          });
        },
      };
    }

    const [segmentRows, variantRow] = await Promise.all([
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
        .where("association_id", "=", assoc.id)
        .orderBy("season", "asc")
        .orderBy("episode_start", "asc")
        .orderBy("id", "asc")
        .execute(),
      assoc.variant_id !== null
        ? ctx.db
            .selectFrom("variants")
            .select(["description", "is_default"])
            .where("id", "=", assoc.variant_id)
            .executeTakeFirst()
        : Promise.resolve(undefined),
    ]);

    const segments: NormalizedSegment[] = segmentRows.map((seg) => ({
      season: seg.season,
      episodeStart: seg.episode_start,
      episodeEnd: seg.episode_end,
      targetEpisodeStart: seg.target_episode_start,
      baseline: seg.baseline,
      nonLinear: Boolean(seg.non_linear),
      needsReview: Boolean(seg.needs_review),
    }));

    const gate = evaluateEvidenceGate({
      catalog: catalogEvidence,
      collection: collectionResult.info,
      segments,
      setDefaultVariant: Boolean(variantRow?.is_default),
      variantDescription: variantRow?.description ?? null,
      evaluateStep2: options.evaluateStep2,
    });

    const evidenceRecord: JsonObject = {
      checkedAt,
      catalog: {
        namespace: catalogEvidence.namespace,
        canonicalId: catalogEvidence.canonicalId,
        mediaType: catalogEvidence.mediaType,
        title: catalogEvidence.title,
        originalTitle: catalogEvidence.originalTitle ?? null,
        year: catalogEvidence.year,
        seasons: catalogEvidence.seasons,
        externalIds: catalogEvidence.externalIds,
      },
      collection: {
        namespace: collectionResult.info.namespace,
        canonicalId: collectionResult.info.canonicalId,
        title: collectionResult.info.title,
        originalTitle: collectionResult.info.originalTitle ?? null,
        aliases: collectionResult.info.aliases ?? [],
        year: collectionResult.info.year,
        mediaType: collectionResult.info.mediaType,
        featureEpisodeCount: collectionResult.info.featureEpisodeCount,
        externalIds: collectionResult.info.externalIds ?? {},
      },
      gate: {
        decision: gate.decision,
        step1: gate.step1,
        step2: gate.step2,
        conflicts: gate.conflicts,
        reasons: gate.reasons,
      },
    };

    if (gate.decision === "pass") {
      return {
        status: "completed",
        result: {
          associationId: assoc.id,
          mediaId: media.id,
          decision: "confirmed",
          matchedBy: gate.step1.matchedBy,
        },
        async onCommit(trx) {
          const current = await trx
            .selectFrom("associations")
            .select(["id", "media_id", "namespace", "native_id", "variant_id", "status", "locked"])
            .where("id", "=", assoc.id)
            .forUpdate()
            .executeTakeFirst();

          if (!current || current.status !== "seed_unconfirmed" || current.locked) {
            return;
          }

          await acquireAdvisoryLock(
            trx,
            LOCK_CLASS_MEDIA_NAMESPACE,
            `${media.id}:${current.namespace}`,
          );
          if (current.variant_id !== null) {
            await acquireAdvisoryLock(trx, LOCK_CLASS_VARIANT, current.variant_id);
          }
          await acquireAdvisoryLock(
            trx,
            LOCK_CLASS_COLLECTION,
            `${current.namespace}:${current.native_id}`,
          );

          const currentSegRows = await trx
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
            .where("association_id", "=", current.id)
            .orderBy("season", "asc")
            .orderBy("episode_start", "asc")
            .orderBy("id", "asc")
            .execute();

          const currentSegments: NormalizedSegment[] = currentSegRows.map((seg) => ({
            season: seg.season,
            episodeStart: seg.episode_start,
            episodeEnd: seg.episode_end,
            targetEpisodeStart: seg.target_episode_start,
            baseline: seg.baseline,
            nonLinear: Boolean(seg.non_linear),
            needsReview: Boolean(seg.needs_review),
          }));

          const siblings = isPlatformNamespace(current.namespace)
            ? await loadActiveAssociationsWithSegmentsInTx(trx, {
                variantId: current.variant_id!,
                excludeAssociationId: current.id,
              })
            : await loadActiveAssociationsWithSegmentsInTx(trx, {
                mediaId: media.id,
                catalogNamespace: current.namespace,
                excludeAssociationId: current.id,
              });

          const variantValidation = validateVariantSegments(
            [
              ...siblings.map((s) => ({ associationId: s.id, segments: s.segments })),
              { associationId: current.id, segments: currentSegments },
            ],
            { baseline: media.baseline },
          );

          const sharedSiblings = await loadActiveAssociationsWithSegmentsInTx(trx, {
            collection: { namespace: current.namespace, nativeId: current.native_id },
            excludeAssociationId: current.id,
          });
          const sharedValidation = validateSharedCollectionSegments([
            ...sharedSiblings.map((s) => ({
              mediaId: s.mediaId,
              associationId: s.id,
              segments: s.segments,
            })),
            {
              mediaId: media.id,
              associationId: current.id,
              segments: currentSegments,
            },
          ]);

          if (!variantValidation.valid || !sharedValidation.valid) {
            const firstErr = !variantValidation.valid
              ? variantValidation.errors[0]
              : !sharedValidation.valid
                ? sharedValidation.errors[0]
                : undefined;
            await markSeedEvidenceFailedInTx(trx, {
              associationId: current.id,
              mediaId: media.id,
              namespace: current.namespace,
              nativeId: current.native_id,
              conflictReason: firstErr?.code.toLowerCase() ?? "segment_conflict",
              decisionReason:
                firstErr?.message ?? "Seed conflicts with existing association segments",
              evidence: evidenceRecord,
              now: ctx.now,
            });
            return;
          }

          await refreshSeedMediaFromCatalogInTx(trx, media, catalogTarget, ctx.now);

          const maxRevRow = await trx
            .selectFrom("association_revisions")
            .select(sql<number | null>`max(revision_number)`.as("max_rev"))
            .where("association_id", "=", current.id)
            .executeTakeFirst();

          const nextRevNumber = (maxRevRow?.max_rev ?? 0) + 1;
          const rev = await trx
            .insertInto("association_revisions")
            .values({
              association_id: current.id,
              revision_number: nextRevNumber,
              change_request_id: null,
              variant_id: current.variant_id,
              status: "confirmed",
              segments: JSON.stringify(currentSegments),
              actor_user_id: null,
              reason: "seed_evidence_gate_passed",
              created_at: ctx.now,
            })
            .returning("id")
            .executeTakeFirstOrThrow();

          await trx
            .updateTable("associations")
            .set({
              status: "confirmed",
              needs_review: false,
              current_revision_id: rev.id,
              updated_at: ctx.now,
            })
            .where("id", "=", current.id)
            .execute();
        },
      };
    }

    const primaryConflictCode = gate.conflicts[0]?.code ?? "evidence_gate_conflict";
    const summaryReason =
      gate.reasons.length > 0 ? gate.reasons.join("; ") : "seed_evidence_gate_failed";

    return {
      status: "completed",
      result: {
        associationId: assoc.id,
        mediaId: media.id,
        decision: "needs_review",
        conflictReason: primaryConflictCode,
      },
      async onCommit(trx) {
        await markSeedEvidenceFailedInTx(trx, {
          associationId: assoc.id,
          mediaId: media.id,
          namespace: assoc.namespace,
          nativeId: assoc.native_id,
          conflictReason: primaryConflictCode,
          decisionReason: summaryReason,
          evidence: evidenceRecord,
          now: ctx.now,
        });
      },
    };
  };
}
