import {
  EXTERNAL_ID_NAMESPACES,
  formatExternalKey,
  getNamespaceCapabilities,
  isExternalIdNamespace,
  isNamespace,
  isPlatformNamespace,
  normalizeSegments,
  parseExternalKey,
  validateSegment,
  validateSharedCollectionSegments,
  validateVariantSegments,
  type BaselineSource,
  type ChangeRequestStatus,
  type ExternalIdNamespace,
  type MediaDocument,
  type NormalizedSegment,
  type SegmentInput,
  type SegmentValidationError,
} from "@media-ref/client";
import type {
  AssociationNamespaceRow,
  ChangeRequestsTable,
  Db,
  JsonObject,
  SeasonSnapshotRow,
  StoredSegmentJson,
} from "@media-ref/db";
import { sql, type Selectable, type Transaction } from "kysely";
import type { Database } from "@media-ref/db";
import {
  AdapterTransientError,
  InvalidNativeIdError,
  type AdapterRegistry,
} from "./adapters/index.ts";
import {
  buildCatalogTargetSnapshotFromTmdb,
  parseCatalogTargetKey,
  resolveCatalogTargetSnapshot,
  selectBaseline,
  type CatalogGatewayConfig,
  type CatalogTargetSnapshot,
} from "./catalog-gateway.ts";
import {
  fulfillCoveredDemandsForAssociationInTx,
  mergeExternalKeyDemandsIntoMedia,
  reopenDemandAfterRejectionInTx,
} from "./demands.ts";
import { enqueueJob } from "./jobs.ts";
import { MAX_LEAD_VARIANT_DESCRIPTION_LENGTH } from "./leads.ts";
import { acquireAdvisoryLock, ADVISORY_LOCK_CLASSES } from "./locks.ts";
import type { OutboundClient } from "./outbound.ts";
import { enforceSubmissionQuotaInTx, type SubmissionQuotaConfig } from "./quota.ts";
import { queryMediaByKey, type MediaQueryItem } from "./read-media.ts";
import { type TmdbGateway, type TmdbGatewayConfig, type TmdbMediaFetchResult } from "./tmdb.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const EVIDENCE_CHECK_JOB_TYPE = "evidence_check";
export const TIER1_MANUAL_REVIEW_REASON = "adapter_tier_1_manual_review";

export type AssociationNamespace = AssociationNamespaceRow;

export type MediaServiceErrorCode =
  | "INVALID_TARGET_KEY"
  | "INVALID_NAMESPACE"
  | "INVALID_NATIVE_ID"
  | "PLATFORM_UPSTREAM_ERROR"
  | "VARIANT_REQUIRED"
  | "VARIANT_NOT_ALLOWED"
  | "INVALID_VARIANT"
  | "INVALID_SEGMENTS"
  | "SEGMENTS_NOT_ALLOWED_WITHOUT_BASELINE"
  | "SEGMENT_OVERLAP"
  | "INVALID_TASK_ID"
  | "MEDIA_NOT_FOUND"
  | "ASSOCIATION_NOT_FOUND"
  | "INVALID_REPLACES_ASSOCIATION"
  | "ASSOCIATION_LOCKED"
  | "ASSOCIATION_SUPERSEDED"
  | "CHANGE_REQUEST_NOT_FOUND"
  | "INVALID_CHANGE_REQUEST_STATE"
  | "NO_CHANGE"
  | "DUPLICATE_CHANGE_REQUEST"
  | "TMDB_MEDIA_NOT_FOUND"
  | "TMDB_UPSTREAM_ERROR"
  | "CATALOG_MEDIA_NOT_FOUND"
  | "CATALOG_UPSTREAM_ERROR";

export class MediaServiceError extends Error {
  readonly code: MediaServiceErrorCode;
  readonly status: number;
  readonly details?: SegmentValidationError[];

  constructor(
    code: MediaServiceErrorCode,
    status: number,
    message: string,
    details?: SegmentValidationError[],
  ) {
    super(message);
    this.name = "MediaServiceError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export interface ChangeRequestRecord {
  id: string;
  status: ChangeRequestStatus;
  submitterUserId: string;
  submitterKeyId: string | null;
  submitterType: "human" | "agent";
  taskId: string | null;
  mediaId: string | null;
  targetExternalKey: string;
  namespace: AssociationNamespace;
  rawNativeId: string;
  nativeId: string;
  variantId: string | null;
  variantDescription: string | null;
  setDefaultVariant: boolean;
  segments: NormalizedSegment[];
  evidence: JsonObject | null;
  conflictReason: string | null;
  decisionReason: string | null;
  reviewerUserId: string | null;
  reviewedAt: string | null;
  appliedAssociationId: string | null;
  appliedRevisionId: string | null;
  replacesAssociationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateChangeRequestInput {
  submitterUserId: string;
  submitterKeyId?: string | null;
  submitterType?: "human" | "agent";
  taskId?: string | null;
  /** The demand an exploration submitted this for; approval fulfills it, rejection reopens it. */
  demandId?: string | null;
  targetExternalKey: string;
  namespace: string;
  nativeId: string;
  rawNativeId?: string;
  variantId?: string | null;
  variantDescription?: string | null;
  setDefaultVariant?: boolean;
  replacesAssociationId?: string | null;
  segments?: readonly SegmentInput[];
  initialStatus?: "needs_review" | "pending_evidence";
  submissionQuota?: SubmissionQuotaConfig;
  now?: Date;
}

export interface CreateChangeRequestOptions {
  adapterRegistry?: AdapterRegistry;
  outbound?: OutboundClient;
  now?: Date;
}

export interface ListChangeRequestsOptions {
  status?: ChangeRequestStatus;
  /** List one submitter's requests across every status, newest first (`status` is ignored). */
  submitterUserId?: string;
  /** With `status`: only requests this reviewer decided, latest decision first. */
  reviewerUserId?: string;
  limit?: number;
  offset?: number;
}

export interface ListChangeRequestsResult {
  changeRequests: ChangeRequestRecord[];
  total: number;
}

export interface ApproveChangeRequestInput {
  changeRequestId: string;
  reviewerUserId: string | null;
  reason?: string | null;
  evidence?: JsonObject | null;
  conflictReason?: string | null;
  prefetchedCatalog?: CatalogTargetSnapshot | null;
  prefetchedTmdb?: TmdbMediaFetchResult | null;
  catalogConfig?: CatalogGatewayConfig;
  tmdbConfig?: TmdbGatewayConfig;
  tmdbGateway?: TmdbGateway;
  allowedStatuses?: readonly ChangeRequestStatus[];
  now?: Date;
}

export interface ApproveChangeRequestInTransactionInput {
  changeRequestId: string;
  reviewerUserId: string | null;
  reason?: string | null;
  evidence?: JsonObject | null;
  conflictReason?: string | null;
  prefetchedCatalog?: CatalogTargetSnapshot | null;
  prefetchedTmdb?: TmdbMediaFetchResult | null;
  allowedStatuses?: readonly ChangeRequestStatus[];
  replacesAssociationId?: string | null;
  enforceUnlockedCheck?: boolean;
  now?: Date;
}

export interface ApproveChangeRequestResult {
  changeRequest: ChangeRequestRecord;
  mediaId: string;
  associationId: string;
  revisionId: string;
}

export interface RejectChangeRequestInput {
  changeRequestId: string;
  reviewerUserId: string;
  reason?: string | null;
  allowedStatuses?: readonly ChangeRequestStatus[];
}

export type ReadMediaDocumentResult =
  | {
      kind: "ok";
      document: MediaDocument;
      matchedAssociationId: string | null;
      items: MediaQueryItem[];
    }
  | { kind: "not_found" }
  | { kind: "invalid_key"; message: string };

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** Every registered namespace can hold associations (ADR 0001). */
export function isAssociationNamespace(value: string): value is AssociationNamespace {
  return isNamespace(value);
}

/** Display snapshot of the collection/entry from `evidence.collection` (ADR 0001). */
export function extractCollectionDisplay(evidence: unknown): {
  title?: string;
  episode_count?: number;
} {
  const collection = parseJsonObject(evidence)?.collection;
  if (!collection || typeof collection !== "object") {
    return {};
  }
  const { title, featureEpisodeCount } = collection as Record<string, unknown>;
  return {
    ...(typeof title === "string" && title.trim().length > 0 ? { title: title.trim() } : {}),
    ...(typeof featureEpisodeCount === "number" &&
    Number.isInteger(featureEpisodeCount) &&
    featureEpisodeCount >= 0
      ? { episode_count: featureEpisodeCount }
      : {}),
  };
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
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

function parseJsonObject(raw: unknown): JsonObject | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as JsonObject;
      }
      return null;
    } catch {
      return null;
    }
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as JsonObject;
  }
  return null;
}

function extractReplacesAssociationId(rawEvidence: unknown): string | null {
  const parsed = parseJsonObject(rawEvidence);
  const value = parsed?.replacesAssociationId;
  return typeof value === "string" && isUuid(value) ? value : null;
}

function toChangeRequestRecord(row: Selectable<ChangeRequestsTable>): ChangeRequestRecord {
  const storedSegments = parseJsonArray<StoredSegmentJson>(row.segments);
  const evidence = parseJsonObject(row.evidence);
  const replacesAssociationId =
    typeof evidence?.replacesAssociationId === "string" && isUuid(evidence.replacesAssociationId)
      ? evidence.replacesAssociationId
      : null;
  return {
    id: row.id,
    status: row.status,
    submitterUserId: row.submitter_user_id,
    submitterKeyId: row.submitter_key_id,
    submitterType: row.submitter_type,
    taskId: row.task_id,
    mediaId: row.media_id,
    targetExternalKey: row.target_external_key,
    namespace: row.namespace,
    rawNativeId: row.raw_native_id,
    nativeId: row.native_id,
    variantId: row.variant_id,
    variantDescription: row.variant_description,
    setDefaultVariant: Boolean(row.set_default_variant),
    segments: storedSegments.map((seg) => ({
      season: seg.season,
      episodeStart: seg.episodeStart,
      episodeEnd: seg.episodeEnd ?? null,
      targetEpisodeStart: seg.targetEpisodeStart,
      baseline: seg.baseline,
      nonLinear: Boolean(seg.nonLinear),
      needsReview: Boolean(seg.needsReview),
    })),
    evidence,
    conflictReason: row.conflict_reason,
    decisionReason: row.decision_reason,
    reviewerUserId: row.reviewer_user_id,
    reviewedAt: row.reviewed_at ? toIsoString(row.reviewed_at) : null,
    appliedAssociationId: row.applied_association_id,
    appliedRevisionId: row.applied_revision_id,
    replacesAssociationId,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

type DbExecutor = Db | Transaction<Database>;

interface ResolvedMediaRow {
  id: string;
  type: "movie" | "tv";
  baseline: BaselineSource | null;
  title: string;
  original_title: string | null;
  year: number | null;
  seasons: SeasonSnapshotRow[];
  merged_into_media_id: string | null;
}

async function resolveCanonicalMediaById(
  db: DbExecutor,
  mediaId: string,
): Promise<ResolvedMediaRow | null> {
  let currentId = mediaId;
  for (let hop = 0; hop < 10; hop++) {
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

type ParsedTargetKey =
  | { kind: "media_id"; mediaId: string; canonicalKey: string }
  | {
      kind: "external_key";
      namespace: string;
      nativeId: string;
      canonicalKey: string;
    };

function parseTargetKey(raw: string): ParsedTargetKey | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (isUuid(trimmed)) {
    return {
      kind: "media_id",
      mediaId: trimmed,
      canonicalKey: `media:${trimmed}`,
    };
  }

  if (trimmed.startsWith("media:")) {
    const candidateId = trimmed.slice("media:".length);
    if (isUuid(candidateId)) {
      return {
        kind: "media_id",
        mediaId: candidateId,
        canonicalKey: `media:${candidateId}`,
      };
    }
    return null;
  }

  const parsed = parseExternalKey(trimmed);
  if (!parsed) {
    return null;
  }

  return {
    kind: "external_key",
    namespace: parsed.namespace,
    nativeId: parsed.nativeId,
    canonicalKey: formatExternalKey(parsed),
  };
}

async function resolveExistingMediaByTarget(
  db: DbExecutor,
  target: ParsedTargetKey,
): Promise<{ media: ResolvedMediaRow; matchedAssociationIds: string[] } | null> {
  if (target.kind === "media_id") {
    const media = await resolveCanonicalMediaById(db, target.mediaId);
    return media ? { media, matchedAssociationIds: [] } : null;
  }

  if (isExternalIdNamespace(target.namespace)) {
    const ext = await db
      .selectFrom("associations")
      .where("is_external_id", "=", true)
      .select("media_id")
      .where("namespace", "=", target.namespace)
      .where("native_id", "=", target.nativeId)
      .executeTakeFirst();

    if (ext) {
      const media = await resolveCanonicalMediaById(db, ext.media_id);
      return media ? { media, matchedAssociationIds: [] } : null;
    }
  }

  if (isAssociationNamespace(target.namespace)) {
    const rows = await db
      .selectFrom("associations")
      .where("is_external_id", "=", false)
      .select(["id", "media_id"])
      .where("namespace", "=", target.namespace)
      .where("native_id", "=", target.nativeId)
      .where("status", "=", "confirmed")
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute();

    if (rows.length === 0) {
      return null;
    }

    const primaryMedia = await resolveCanonicalMediaById(db, rows[0].media_id);
    if (!primaryMedia) {
      return null;
    }

    const matchedAssociationIds = rows
      .filter((row) => row.media_id === rows[0].media_id || row.media_id === primaryMedia.id)
      .map((row) => row.id);

    return {
      media: primaryMedia,
      matchedAssociationIds,
    };
  }

  return null;
}

async function loadActiveAssociationsWithSegments(
  db: DbExecutor,
  filter: {
    variantId?: string;
    mediaId?: string;
    catalogNamespace?: AssociationNamespace;
    collection?: { namespace: AssociationNamespace; nativeId: string };
    excludeAssociationId?: string;
    excludeAssociationIds?: readonly string[];
  },
): Promise<Array<{ id: string; mediaId: string; segments: NormalizedSegment[] }>> {
  let query = db
    .selectFrom("associations")
    .where("is_external_id", "=", false)
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
  const excludedIds = [
    ...(filter.excludeAssociationId !== undefined ? [filter.excludeAssociationId] : []),
    ...(filter.excludeAssociationIds ?? []),
  ];
  if (excludedIds.length === 1) {
    query = query.where("id", "!=", excludedIds[0]!);
  } else if (excludedIds.length > 1) {
    query = query.where("id", "not in", excludedIds);
  }

  const associations = await query.orderBy("created_at", "asc").orderBy("id", "asc").execute();
  if (associations.length === 0) {
    return [];
  }

  const assocIds = associations.map((a) => a.id);
  const segmentRows = await db
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

export async function validateSubmissionOnSharedCollection(
  db: DbExecutor,
  namespace: AssociationNamespace,
  nativeId: string,
  mediaId: string | null,
  segments: readonly SegmentInput[],
) {
  const existing = await loadActiveAssociationsWithSegments(db, {
    collection: { namespace, nativeId },
  });
  return validateSharedCollectionSegments([
    ...existing
      .filter((e) => e.mediaId !== mediaId)
      .map((e) => ({ mediaId: e.mediaId, associationId: e.id, segments: e.segments })),
    { mediaId: mediaId ?? "__pending_media__", associationId: "candidate", segments },
  ]);
}

function classifyValidationErrorStatus(
  errors: SegmentValidationError[],
  conflictStatus: number,
): { code: MediaServiceErrorCode; status: number } {
  if (errors.some((err) => err.code === "BASELINE_REQUIRED_FOR_SEGMENTS")) {
    return { code: "SEGMENTS_NOT_ALLOWED_WITHOUT_BASELINE", status: 400 };
  }
  const isConflict = errors.some(
    (err) =>
      err.code === "OVERLAPPING_VARIANT_SEGMENTS" ||
      err.code === "CONFLICTING_WHOLE_MEDIA_ASSOCIATION" ||
      err.code === "OVERLAPPING_SHARED_COLLECTION_TARGET_RANGE" ||
      err.code === "SHARED_COLLECTION_OPEN_ENDED_SEGMENT" ||
      err.code === "SHARED_COLLECTION_NON_LINEAR_SEGMENT" ||
      err.code === "SHARED_COLLECTION_WHOLE_MEDIA",
  );
  if (isConflict) {
    return { code: "SEGMENT_OVERLAP", status: conflictStatus };
  }
  return { code: "INVALID_SEGMENTS", status: 400 };
}

export async function createChangeRequest(
  dbWrite: Db,
  input: CreateChangeRequestInput,
  options: CreateChangeRequestOptions = {},
): Promise<ChangeRequestRecord> {
  const target = parseTargetKey(input.targetExternalKey);
  if (!target) {
    throw new MediaServiceError(
      "INVALID_TARGET_KEY",
      400,
      "targetExternalKey must be a valid media UUID or external key (e.g. tmdb:tv:95479)",
    );
  }

  if (!isAssociationNamespace(input.namespace)) {
    throw new MediaServiceError(
      "INVALID_NAMESPACE",
      400,
      `Unsupported association namespace: ${input.namespace}`,
    );
  }
  const namespace: AssociationNamespace = input.namespace;

  const trimmedNativeId = input.nativeId.trim();
  if (trimmedNativeId.length === 0 || input.nativeId.length > 500) {
    throw new MediaServiceError(
      "INVALID_NATIVE_ID",
      400,
      "nativeId must be between 1 and 500 characters",
    );
  }
  if (input.rawNativeId && input.rawNativeId.length > 500) {
    throw new MediaServiceError(
      "INVALID_NATIVE_ID",
      400,
      "rawNativeId must be at most 500 characters",
    );
  }
  if (
    input.variantDescription &&
    input.variantDescription.length > MAX_LEAD_VARIANT_DESCRIPTION_LENGTH
  ) {
    throw new MediaServiceError(
      "INVALID_VARIANT",
      400,
      `variantDescription must be at most ${MAX_LEAD_VARIANT_DESCRIPTION_LENGTH} characters`,
    );
  }
  const rawSegments = input.segments ?? [];
  if (!Array.isArray(rawSegments) || rawSegments.length > 200) {
    throw new MediaServiceError(
      "INVALID_SEGMENTS",
      400,
      "segments must be an array of at most 200 entries",
    );
  }

  const adapter = options.adapterRegistry?.get(namespace);
  let nativeId = trimmedNativeId;
  let resolvedPage: JsonObject | undefined;
  if (adapter) {
    const parsedInput = adapter.parseInput(trimmedNativeId);
    if (!parsedInput) {
      throw new MediaServiceError(
        "INVALID_NATIVE_ID",
        400,
        `Invalid native ID for ${namespace}: unrecognized URL or ID`,
      );
    }
    if (parsedInput.canonicalId !== null) {
      nativeId = parsedInput.canonicalId;
    } else {
      if (!options.outbound) {
        throw new MediaServiceError(
          "PLATFORM_UPSTREAM_ERROR",
          502,
          `Outbound client is required to canonicalize ${namespace} input "${trimmedNativeId}"`,
        );
      }
      try {
        nativeId = await adapter.canonicalize(trimmedNativeId, options.outbound);
        // The verified alias is from the primary input, not the separately submitted raw ID.
        resolvedPage = { namespace, nativeId, kind: parsedInput.kind, id: parsedInput.id };
      } catch (error) {
        if (error instanceof InvalidNativeIdError) {
          throw new MediaServiceError("INVALID_NATIVE_ID", 400, error.message);
        }
        if (error instanceof AdapterTransientError) {
          throw new MediaServiceError("PLATFORM_UPSTREAM_ERROR", 502, error.message);
        }
        throw error;
      }
    }
  } else if (/^https?:\/\//i.test(trimmedNativeId)) {
    throw new MediaServiceError(
      "INVALID_NATIVE_ID",
      400,
      `Cannot verify a URL for ${namespace} without an adapter`,
    );
  }

  const submittedRawId = input.rawNativeId?.trim() || trimmedNativeId;
  // The adapter already verified the native input, including IDs resolved through an upstream lookup.
  const rawNativeId =
    adapter &&
    (submittedRawId === trimmedNativeId ||
      adapter.parseInput(submittedRawId)?.canonicalId === nativeId)
      ? submittedRawId
      : nativeId;

  if (input.taskId !== undefined && input.taskId !== null && !isUuid(input.taskId)) {
    throw new MediaServiceError("INVALID_TASK_ID", 400, "taskId must be a valid UUID");
  }

  // Idempotent per-task change request lookup (duplicate queue delivery fast-path)
  if (input.taskId) {
    const existingByTask = await dbWrite
      .selectFrom("change_requests")
      .selectAll()
      .where("task_id", "=", input.taskId)
      .executeTakeFirst();
    if (existingByTask) {
      return toChangeRequestRecord(existingByTask);
    }
  }

  // Resolve existing media if present
  const resolved = await resolveExistingMediaByTarget(dbWrite, target);
  if (target.kind === "media_id" && !resolved) {
    throw new MediaServiceError("MEDIA_NOT_FOUND", 404, `Media not found for ID ${target.mediaId}`);
  }

  const catalogTarget =
    !resolved && target.kind === "external_key" ? parseCatalogTargetKey(target.canonicalKey) : null;

  if (!resolved && !catalogTarget) {
    throw new MediaServiceError(
      "INVALID_TARGET_KEY",
      400,
      "Uncreated media submissions must target a valid catalog external key (tmdb, tvdb, imdb, bangumi, douban, or trakt)",
    );
  }

  const existingMedia = resolved?.media ?? null;
  const canonicalTargetKey = catalogTarget ? catalogTarget.canonicalKey : target.canonicalKey;
  const effectiveBaseline: BaselineSource | null = existingMedia
    ? existingMedia.baseline
    : selectBaseline([catalogTarget!.namespace]);

  // Optional explicit replacement target validation
  let replacesAssociation: {
    id: string;
    media_id: string;
    namespace: AssociationNamespace;
    native_id: string;
    variant_id: string | null;
    status: "confirmed" | "seed_unconfirmed" | "delisted";
    locked: boolean;
  } | null = null;
  const rawReplacesAssociationId = input.replacesAssociationId?.trim() || null;
  if (rawReplacesAssociationId !== null) {
    if (!isUuid(rawReplacesAssociationId)) {
      throw new MediaServiceError(
        "INVALID_REPLACES_ASSOCIATION",
        400,
        "replacesAssociationId must be a valid UUID",
      );
    }
    if (!existingMedia) {
      throw new MediaServiceError(
        "ASSOCIATION_NOT_FOUND",
        404,
        "Cannot specify replacesAssociationId for a media that does not exist yet",
      );
    }
    const foundReplaced = await dbWrite
      .selectFrom("associations")
      .where("is_external_id", "=", false)
      .select(["id", "media_id", "namespace", "native_id", "variant_id", "status", "locked"])
      .where("id", "=", rawReplacesAssociationId)
      .where("media_id", "=", existingMedia.id)
      .executeTakeFirst();

    if (!foundReplaced) {
      throw new MediaServiceError(
        "ASSOCIATION_NOT_FOUND",
        404,
        "Specified replacesAssociationId does not belong to the target media",
      );
    }
    if (foundReplaced.status === "delisted") {
      throw new MediaServiceError(
        "INVALID_REPLACES_ASSOCIATION",
        409,
        "Cannot replace an already delisted association",
      );
    }
    if (foundReplaced.namespace !== namespace) {
      throw new MediaServiceError(
        "INVALID_REPLACES_ASSOCIATION",
        400,
        "replacesAssociationId must belong to the same namespace",
      );
    }
    replacesAssociation = foundReplaced;
  }

  // Variant validation
  let resolvedVariantId: string | null = null;
  let variantDescription: string | null = null;
  const setDefaultVariant = Boolean(input.setDefaultVariant);

  if (isPlatformNamespace(namespace)) {
    const rawDescription = input.variantDescription?.trim() || null;
    const rawVariantId =
      input.variantId?.trim() ||
      (!rawDescription && replacesAssociation?.variant_id ? replacesAssociation.variant_id : null);

    if (!rawVariantId && !rawDescription) {
      throw new MediaServiceError(
        "VARIANT_REQUIRED",
        400,
        "Platform associations require either variantId or variantDescription",
      );
    }

    if (rawVariantId) {
      if (!isUuid(rawVariantId)) {
        throw new MediaServiceError("INVALID_VARIANT", 400, "variantId must be a valid UUID");
      }
      if (!existingMedia) {
        throw new MediaServiceError(
          "INVALID_VARIANT",
          400,
          "Cannot reference variantId for a media that does not exist yet",
        );
      }
      const existingVariant = await dbWrite
        .selectFrom("variants")
        .select(["id", "description"])
        .where("id", "=", rawVariantId)
        .where("media_id", "=", existingMedia.id)
        .where("platform", "=", namespace)
        .executeTakeFirst();

      if (!existingVariant) {
        throw new MediaServiceError(
          "INVALID_VARIANT",
          400,
          "Specified variantId does not belong to the target media and platform",
        );
      }
      resolvedVariantId = existingVariant.id;
      variantDescription = rawDescription ?? existingVariant.description;
    } else {
      variantDescription = rawDescription;
      if (existingMedia && variantDescription) {
        const matchedByDescription = await dbWrite
          .selectFrom("variants")
          .select("id")
          .where("media_id", "=", existingMedia.id)
          .where("platform", "=", namespace)
          .where("description", "=", variantDescription)
          .executeTakeFirst();
        if (matchedByDescription) {
          resolvedVariantId = matchedByDescription.id;
        }
      }
    }

    if (replacesAssociation && resolvedVariantId !== replacesAssociation.variant_id) {
      throw new MediaServiceError(
        "INVALID_REPLACES_ASSOCIATION",
        400,
        "replacesAssociationId must belong to the same variant as the replacement submission",
      );
    }
  } else {
    if (input.variantId || input.variantDescription) {
      throw new MediaServiceError(
        "VARIANT_NOT_ALLOWED",
        400,
        "Catalog associations cannot specify a variant",
      );
    }
  }

  // Segments validation via @media-ref/client
  if (effectiveBaseline === null && rawSegments.length > 0) {
    throw new MediaServiceError(
      "SEGMENTS_NOT_ALLOWED_WITHOUT_BASELINE",
      400,
      "Media without a baseline cannot have segmented associations; submit whole-media (segments: []) instead",
    );
  }

  const preparedInputs: SegmentInput[] = [];
  const segmentErrors: SegmentValidationError[] = [];

  for (let i = 0; i < rawSegments.length; i++) {
    const raw = rawSegments[i];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      segmentErrors.push({
        code: "INVALID_SEASON",
        message: `Segment at index ${i} must be an object`,
        segmentIndex: i,
      });
      continue;
    }
    const segRecord = raw as unknown as Record<string, unknown>;
    const candidate = {
      ...segRecord,
      baseline:
        segRecord.baseline === undefined && effectiveBaseline !== null
          ? effectiveBaseline
          : segRecord.baseline,
    } as unknown as SegmentInput;

    const check = validateSegment(candidate);
    if (!check.valid) {
      for (const err of check.errors) {
        segmentErrors.push({ ...err, segmentIndex: i });
      }
      continue;
    }
    preparedInputs.push(candidate);
  }

  if (segmentErrors.length > 0) {
    throw new MediaServiceError("INVALID_SEGMENTS", 400, segmentErrors[0].message, segmentErrors);
  }

  const normalizedSegments = normalizeSegments(preparedInputs);
  const { allowHierarchicalScopes, verificationMode } = getNamespaceCapabilities(namespace);

  if (verificationMode === "sync" && normalizedSegments.length === 0) {
    throw new MediaServiceError(
      "INVALID_NAMESPACE",
      400,
      `Whole-media ${namespace} IDs are External IDs maintained by sync; submit season or episode entries with segments`,
    );
  }

  // Intra-submission validation (and baseline requirement check)
  const selfCheck = validateVariantSegments([normalizedSegments], { baseline: effectiveBaseline });
  if (!selfCheck.valid) {
    const classified = classifyValidationErrorStatus(selfCheck.errors, 400);
    throw new MediaServiceError(
      classified.code,
      classified.status,
      selfCheck.errors[0].message,
      selfCheck.errors,
    );
  }

  // Submit-time overlap check against already-confirmed/active associations in target variant/catalog
  let existingSameCollection: {
    id: string;
    native_id: string;
    variant_id: string | null;
    status: "confirmed" | "seed_unconfirmed" | "delisted";
    locked: boolean;
    needs_review: boolean;
  } | null = null;
  if (existingMedia) {
    existingSameCollection =
      (await dbWrite
        .selectFrom("associations")
        .where("is_external_id", "=", false)
        .select(["id", "native_id", "variant_id", "status", "locked", "needs_review"])
        .where("media_id", "=", existingMedia.id)
        .where("namespace", "=", namespace)
        .where("native_id", "=", nativeId)
        .executeTakeFirst()) ?? null;

    const excludeAssociationIds = [
      ...(existingSameCollection ? [existingSameCollection.id] : []),
      ...(replacesAssociation && replacesAssociation.id !== existingSameCollection?.id
        ? [replacesAssociation.id]
        : []),
    ];

    if (isPlatformNamespace(namespace) && resolvedVariantId) {
      const others = await loadActiveAssociationsWithSegments(dbWrite, {
        variantId: resolvedVariantId,
        excludeAssociationIds,
      });
      const variantCheck = validateVariantSegments(
        [
          ...others.map((o) => ({ associationId: o.id, segments: o.segments })),
          {
            associationId: existingSameCollection?.id ?? "candidate",
            segments: normalizedSegments,
          },
        ],
        { baseline: existingMedia.baseline, allowHierarchicalScopes },
      );
      if (!variantCheck.valid) {
        const classified = classifyValidationErrorStatus(variantCheck.errors, 400);
        throw new MediaServiceError(
          classified.code,
          classified.status,
          variantCheck.errors[0].message,
          variantCheck.errors,
        );
      }
    } else if (!isPlatformNamespace(namespace)) {
      const others = await loadActiveAssociationsWithSegments(dbWrite, {
        mediaId: existingMedia.id,
        catalogNamespace: namespace,
        excludeAssociationIds,
      });
      const catalogCheck = validateVariantSegments(
        [
          ...others.map((o) => ({ associationId: o.id, segments: o.segments })),
          {
            associationId: existingSameCollection?.id ?? "candidate",
            segments: normalizedSegments,
          },
        ],
        { baseline: existingMedia.baseline, allowHierarchicalScopes },
      );
      if (!catalogCheck.valid) {
        const classified = classifyValidationErrorStatus(catalogCheck.errors, 400);
        throw new MediaServiceError(
          classified.code,
          classified.status,
          catalogCheck.errors[0].message,
          catalogCheck.errors,
        );
      }
    }
  }

  // Submit-time shared-collection check across other media
  const sharedCheck = await validateSubmissionOnSharedCollection(
    dbWrite,
    namespace,
    nativeId,
    existingMedia?.id ?? null,
    normalizedSegments,
  );
  if (!sharedCheck.valid) {
    const classified = classifyValidationErrorStatus(sharedCheck.errors, 400);
    throw new MediaServiceError(
      classified.code,
      classified.status,
      sharedCheck.errors[0].message,
      sharedCheck.errors,
    );
  }

  const hasTier2Adapter = Boolean(adapter && adapter.tier >= 2);
  const resolvedStatus: ChangeRequestStatus =
    input.initialStatus ?? (hasTier2Adapter ? "pending_evidence" : "needs_review");
  const shouldEnqueueEvidenceCheck = resolvedStatus === "pending_evidence";
  const lockedImmediateTargets: Array<{ id: string; nativeId: string }> = [];
  if (!shouldEnqueueEvidenceCheck && existingMedia) {
    if (replacesAssociation?.locked) {
      lockedImmediateTargets.push({
        id: replacesAssociation.id,
        nativeId: replacesAssociation.native_id,
      });
    }
    if (existingSameCollection?.locked && existingSameCollection.id !== replacesAssociation?.id) {
      lockedImmediateTargets.push({
        id: existingSameCollection.id,
        nativeId: existingSameCollection.native_id,
      });
    }
  }
  const initialConflictReason =
    lockedImmediateTargets.length > 0 ? "locked_association_challenged" : null;
  const initialDecisionReason =
    initialConflictReason ??
    (input.initialStatus === undefined &&
    resolvedStatus === "needs_review" &&
    options.adapterRegistry
      ? TIER1_MANUAL_REVIEW_REASON
      : null);
  const initialEvidenceJson =
    replacesAssociation || resolvedPage
      ? JSON.stringify({
          ...(replacesAssociation ? { replacesAssociationId: replacesAssociation.id } : {}),
          ...(resolvedPage ? { resolvedPage } : {}),
        })
      : null;
  const effectiveNow = input.now ?? options.now;

  const submitterType = input.submitterType ?? "human";
  const inserted = await dbWrite.transaction().execute(async (trx) => {
    if (input.taskId) {
      await acquireAdvisoryLock(trx, ADVISORY_LOCK_CLASSES.TASK_ID, input.taskId);
      const existingByTaskInTx = await trx
        .selectFrom("change_requests")
        .selectAll()
        .where("task_id", "=", input.taskId)
        .executeTakeFirst();
      if (existingByTaskInTx) {
        return existingByTaskInTx;
      }
    }

    // The target can gain a media ID while a submission waits for this collection.
    await acquireAdvisoryLock(
      trx,
      ADVISORY_LOCK_CLASSES.CHANGE_REQUEST_DEDUPE,
      `${namespace}:${nativeId}`,
    );

    const mediaInTx = (await resolveExistingMediaByTarget(trx, target))?.media ?? null;
    let resolvedVariantIdInTx = resolvedVariantId;
    if (
      !resolvedVariantIdInTx &&
      mediaInTx &&
      isPlatformNamespace(namespace) &&
      variantDescription
    ) {
      const matchedVariantInTx = await trx
        .selectFrom("variants")
        .select("id")
        .where("media_id", "=", mediaInTx.id)
        .where("platform", "=", namespace)
        .where("description", "=", variantDescription)
        .executeTakeFirst();
      if (matchedVariantInTx) {
        resolvedVariantIdInTx = matchedVariantInTx.id;
      }
    }
    const sameCollectionInTx = mediaInTx
      ? ((await trx
          .selectFrom("associations")
          .where("is_external_id", "=", false)
          .select(["id", "native_id", "variant_id", "status", "locked", "needs_review"])
          .where("media_id", "=", mediaInTx.id)
          .where("namespace", "=", namespace)
          .where("native_id", "=", nativeId)
          .executeTakeFirst()) ?? null)
      : null;

    await assertNotNoOpSubmission(trx, {
      existingMedia: mediaInTx,
      existingSameCollection: sameCollectionInTx,
      replacesAssociationId: replacesAssociation?.id ?? null,
      resolvedVariantId: resolvedVariantIdInTx,
      setDefaultVariant,
      normalizedSegments,
      namespace,
    });
    await assertNoDuplicateInFlightChangeRequest(trx, {
      existingMedia: mediaInTx,
      canonicalTargetKey,
      namespace,
      nativeId,
      resolvedVariantId: resolvedVariantIdInTx,
      variantDescription,
      setDefaultVariant,
      replacesAssociationId: replacesAssociation?.id ?? null,
      normalizedSegments,
    });

    let referenceNow: Date;
    if (submitterType === "agent") {
      // Agent exploration submissions are capped by exploration_daily_budget,
      // not the human contributor hourly submit quota.
      referenceNow = effectiveNow ?? new Date();
    } else {
      const quota = await enforceSubmissionQuotaInTx(trx, {
        submitterUserId: input.submitterUserId,
        config: input.submissionQuota,
        now: effectiveNow,
      });
      referenceNow = quota.referenceNow;
    }

    const row = await trx
      .insertInto("change_requests")
      .values({
        status: resolvedStatus,
        submitter_user_id: input.submitterUserId,
        submitter_key_id: input.submitterKeyId ?? null,
        submitter_type: submitterType,
        task_id: input.taskId ?? null,
        demand_id: input.demandId ?? null,
        media_id: mediaInTx?.id ?? null,
        target_external_key: canonicalTargetKey,
        namespace,
        raw_native_id: rawNativeId,
        native_id: nativeId,
        variant_id: resolvedVariantIdInTx,
        variant_description: variantDescription,
        set_default_variant: setDefaultVariant,
        segments: JSON.stringify(normalizedSegments),
        evidence: initialEvidenceJson,
        conflict_reason: initialConflictReason,
        decision_reason: initialDecisionReason,
        ...(effectiveNow ? { created_at: referenceNow, updated_at: referenceNow } : {}),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    if (shouldEnqueueEvidenceCheck) {
      await enqueueJob(trx, {
        jobType: EVIDENCE_CHECK_JOB_TYPE,
        payload: replacesAssociation
          ? { changeRequestId: row.id, replacesAssociationId: replacesAssociation.id }
          : { changeRequestId: row.id },
        dedupeKey: `${EVIDENCE_CHECK_JOB_TYPE}:${row.id}`,
        runAfter: effectiveNow ?? referenceNow,
      });
    } else if (lockedImmediateTargets.length > 0 && existingMedia) {
      const detectedAt = (effectiveNow ?? referenceNow).toISOString();
      for (const targetLocked of lockedImmediateTargets) {
        await trx
          .insertInto("review_alerts")
          .values({
            alert_type: "locked_association_challenged",
            media_id: existingMedia.id,
            association_id: targetLocked.id,
            status: "open",
            details: JSON.stringify({
              changeRequestId: row.id,
              namespace,
              nativeId,
              existingNativeId: targetLocked.nativeId,
              detectedAt,
            }),
          })
          .execute();
      }
    }

    return row;
  });

  return toChangeRequestRecord(inserted);
}

export async function getChangeRequestById(
  dbWrite: Db,
  id: string,
): Promise<ChangeRequestRecord | null> {
  if (!isUuid(id)) {
    return null;
  }
  const row = await dbWrite
    .selectFrom("change_requests")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();

  return row ? toChangeRequestRecord(row) : null;
}

export async function listChangeRequests(
  dbWrite: Db,
  options: ListChangeRequestsOptions = {},
): Promise<ListChangeRequestsResult> {
  const status = options.status ?? "needs_review";
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);

  const mine = options.submitterUserId;
  const reviewer = options.reviewerUserId;
  const [rows, countRow] = await Promise.all([
    dbWrite
      .selectFrom("change_requests")
      .selectAll()
      .$if(mine === undefined, (qb) => qb.where("status", "=", status))
      .$if(mine !== undefined, (qb) => qb.where("submitter_user_id", "=", mine!))
      .$if(reviewer !== undefined, (qb) =>
        qb.where("reviewer_user_id", "=", reviewer!).orderBy("reviewed_at", "desc"),
      )
      .orderBy("created_at", mine === undefined && reviewer === undefined ? "asc" : "desc")
      .orderBy("id", mine === undefined && reviewer === undefined ? "asc" : "desc")
      .limit(limit)
      .offset(offset)
      .execute(),
    dbWrite
      .selectFrom("change_requests")
      .select(sql<string>`count(*)`.as("count"))
      .$if(mine === undefined, (qb) => qb.where("status", "=", status))
      .$if(mine !== undefined, (qb) => qb.where("submitter_user_id", "=", mine!))
      .$if(reviewer !== undefined, (qb) => qb.where("reviewer_user_id", "=", reviewer!))
      .executeTakeFirstOrThrow(),
  ]);

  return {
    changeRequests: rows.map(toChangeRequestRecord),
    total: Number(countRow.count),
  };
}

export async function approveChangeRequest(
  dbWrite: Db,
  outbound: OutboundClient,
  input: ApproveChangeRequestInput,
): Promise<ApproveChangeRequestResult> {
  if (!isUuid(input.changeRequestId)) {
    throw new MediaServiceError("CHANGE_REQUEST_NOT_FOUND", 404, "Change request not found");
  }

  const allowedStatuses = input.allowedStatuses ?? ["needs_review"];
  const reason = input.reason?.trim() || null;

  // Inspect change request before transaction so any TMDB/Trakt outbound fetch
  // runs outside database locks.
  const preRead = await dbWrite
    .selectFrom("change_requests")
    .select(["id", "status", "media_id", "target_external_key"])
    .where("id", "=", input.changeRequestId)
    .executeTakeFirst();

  if (!preRead) {
    throw new MediaServiceError("CHANGE_REQUEST_NOT_FOUND", 404, "Change request not found");
  }
  if (!allowedStatuses.includes(preRead.status)) {
    throw new MediaServiceError(
      "INVALID_CHANGE_REQUEST_STATE",
      409,
      `Change request is in status "${preRead.status}" and cannot be approved`,
    );
  }

  const preTarget = parseTargetKey(preRead.target_external_key);
  if (!preTarget) {
    throw new MediaServiceError(
      "INVALID_TARGET_KEY",
      400,
      `Invalid targetExternalKey on change request: ${preRead.target_external_key}`,
    );
  }

  let prefetchedCatalog: CatalogTargetSnapshot | null =
    input.prefetchedCatalog ??
    (input.prefetchedTmdb ? buildCatalogTargetSnapshotFromTmdb(input.prefetchedTmdb) : null);
  let needsMediaCreation = preRead.media_id === null && prefetchedCatalog === null;
  if (needsMediaCreation) {
    const existingBeforeTx = await resolveExistingMediaByTarget(dbWrite, preTarget);
    if (existingBeforeTx) {
      needsMediaCreation = false;
    }
  }

  if (needsMediaCreation) {
    const catalogTarget =
      preTarget.kind === "external_key" ? parseCatalogTargetKey(preTarget.canonicalKey) : null;
    if (!catalogTarget) {
      throw new MediaServiceError(
        "INVALID_TARGET_KEY",
        400,
        "Cannot create media without a valid catalog external key",
      );
    }

    const resolvedCatalog = await resolveCatalogTargetSnapshot(
      catalogTarget.canonicalKey,
      outbound,
      {
        ...input.catalogConfig,
        tmdb: input.catalogConfig?.tmdb ?? input.tmdbConfig,
        tmdbGateway: input.catalogConfig?.tmdbGateway ?? input.tmdbGateway,
      },
    );

    if (resolvedCatalog.status === "invalid_key") {
      throw new MediaServiceError("INVALID_TARGET_KEY", 400, resolvedCatalog.reason);
    }
    if (resolvedCatalog.status === "not_found") {
      throw new MediaServiceError(
        catalogTarget.namespace === "tmdb" ? "TMDB_MEDIA_NOT_FOUND" : "CATALOG_MEDIA_NOT_FOUND",
        404,
        resolvedCatalog.reason ?? `Catalog media not found for ${catalogTarget.canonicalKey}`,
      );
    }
    if (resolvedCatalog.status === "transient_error") {
      throw new MediaServiceError(
        catalogTarget.namespace === "tmdb" ? "TMDB_UPSTREAM_ERROR" : "CATALOG_UPSTREAM_ERROR",
        502,
        resolvedCatalog.reason,
      );
    }

    prefetchedCatalog = resolvedCatalog.target;
  }

  return dbWrite.transaction().execute((trx) =>
    approveChangeRequestInTransaction(trx, {
      changeRequestId: input.changeRequestId,
      reviewerUserId: input.reviewerUserId,
      reason,
      evidence: input.evidence,
      conflictReason: input.conflictReason,
      prefetchedCatalog,
      allowedStatuses,
      now: input.now,
    }),
  );
}

async function loadSegments(db: DbExecutor, associationId: string): Promise<NormalizedSegment[]> {
  const rows = await db
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
    .where("association_id", "=", associationId)
    .orderBy("season", "asc")
    .orderBy("episode_start", "asc")
    .orderBy("id", "asc")
    .execute();
  return rows.map((seg) => ({
    season: seg.season,
    episodeStart: seg.episode_start,
    episodeEnd: seg.episode_end,
    targetEpisodeStart: seg.target_episode_start,
    baseline: seg.baseline,
    nonLinear: Boolean(seg.non_linear),
    needsReview: Boolean(seg.needs_review),
  }));
}

function parseStoredNormalizedSegments(rawSegments: unknown): NormalizedSegment[] {
  return parseJsonArray<StoredSegmentJson>(rawSegments).map((seg) => ({
    season: seg.season,
    episodeStart: seg.episodeStart,
    episodeEnd: seg.episodeEnd ?? null,
    targetEpisodeStart: seg.targetEpisodeStart,
    baseline: seg.baseline,
    nonLinear: Boolean(seg.nonLinear),
    needsReview: Boolean(seg.needsReview),
  }));
}

function canonicalSegmentsKey(segments: readonly NormalizedSegment[]): string {
  const entries = segments
    .map(
      (s) =>
        [
          s.baseline,
          s.season,
          s.episodeStart,
          s.episodeEnd ?? null,
          s.targetEpisodeStart,
          Boolean(s.nonLinear),
          Boolean(s.needsReview),
        ] as const,
    )
    .sort(
      (a, b) =>
        a[1] - b[1] ||
        a[2] - b[2] ||
        a[4] - b[4] ||
        (a[3] ?? Number.POSITIVE_INFINITY) - (b[3] ?? Number.POSITIVE_INFINITY) ||
        a[0].localeCompare(b[0]) ||
        Number(a[5]) - Number(b[5]) ||
        Number(a[6]) - Number(b[6]),
    );
  return JSON.stringify(entries);
}

async function assertNotNoOpSubmission(
  db: DbExecutor,
  input: {
    existingMedia: ResolvedMediaRow | null;
    existingSameCollection: {
      id: string;
      variant_id: string | null;
      status: "confirmed" | "seed_unconfirmed" | "delisted";
      needs_review: boolean;
    } | null;
    replacesAssociationId: string | null;
    resolvedVariantId: string | null;
    setDefaultVariant: boolean;
    normalizedSegments: readonly NormalizedSegment[];
    namespace: AssociationNamespace;
  },
): Promise<void> {
  const { existingMedia, existingSameCollection } = input;
  if (
    !existingMedia ||
    !existingSameCollection ||
    existingSameCollection.status !== "confirmed" ||
    existingSameCollection.needs_review
  ) {
    return;
  }
  if (input.replacesAssociationId && input.replacesAssociationId !== existingSameCollection.id) {
    return;
  }
  if (existingSameCollection.variant_id !== input.resolvedVariantId) {
    return;
  }
  if (input.setDefaultVariant && isPlatformNamespace(input.namespace) && input.resolvedVariantId) {
    const variantRow = await db
      .selectFrom("variants")
      .select("is_default")
      .where("id", "=", input.resolvedVariantId)
      .executeTakeFirst();
    if (!variantRow?.is_default) {
      return;
    }
  }
  const existingSegments = await loadSegments(db, existingSameCollection.id);
  if (existingSegments.some((seg) => seg.needsReview)) {
    return;
  }
  const resultingSegments = mergeApprovedSegments(
    existingSegments,
    input.normalizedSegments,
    existingMedia.seasons,
  );
  if (canonicalSegmentsKey(resultingSegments) === canonicalSegmentsKey(existingSegments)) {
    throw new MediaServiceError(
      "NO_CHANGE",
      409,
      "Submission matches the already confirmed association; no changes to apply",
    );
  }
}

async function assertNoDuplicateInFlightChangeRequest(
  db: DbExecutor,
  input: {
    existingMedia: ResolvedMediaRow | null;
    canonicalTargetKey: string;
    namespace: AssociationNamespace;
    nativeId: string;
    resolvedVariantId: string | null;
    variantDescription: string | null;
    setDefaultVariant: boolean;
    replacesAssociationId: string | null;
    normalizedSegments: readonly NormalizedSegment[];
  },
): Promise<void> {
  const pendingRows = await db
    .selectFrom("change_requests")
    .select([
      "id",
      "media_id",
      "target_external_key",
      "variant_id",
      "variant_description",
      "set_default_variant",
      "segments",
      "evidence",
    ])
    .where("status", "in", ["pending_evidence", "needs_review"])
    .where("namespace", "=", input.namespace)
    .where("native_id", "=", input.nativeId)
    .where((eb) =>
      input.existingMedia
        ? eb.or([eb("media_id", "=", input.existingMedia.id), eb("media_id", "is", null)])
        : eb.and([
            eb("media_id", "is", null),
            eb("target_external_key", "=", input.canonicalTargetKey),
          ]),
    )
    .execute();

  if (pendingRows.length === 0) {
    return;
  }

  const requestedKey = canonicalSegmentsKey(input.normalizedSegments);
  const requestedDesc = input.variantDescription?.trim() || null;

  for (const row of pendingRows) {
    const sameVariant = !isPlatformNamespace(input.namespace)
      ? true
      : row.variant_id !== null && input.resolvedVariantId !== null
        ? row.variant_id === input.resolvedVariantId
        : (row.variant_description?.trim() || null) === requestedDesc;
    if (!sameVariant) {
      continue;
    }
    const rowSetDefault = Boolean(row.set_default_variant);
    if (rowSetDefault !== input.setDefaultVariant) {
      continue;
    }
    if (extractReplacesAssociationId(row.evidence) !== input.replacesAssociationId) {
      continue;
    }
    const rowKey = canonicalSegmentsKey(parseStoredNormalizedSegments(row.segments));
    if (rowKey !== requestedKey) continue;
    if (!row.media_id && row.target_external_key !== input.canonicalTargetKey) {
      const target = parseTargetKey(row.target_external_key);
      const resolved = target && (await resolveExistingMediaByTarget(db, target));
      if (!resolved || resolved.media.id !== input.existingMedia?.id) continue;
    }
    throw new MediaServiceError(
      "DUPLICATE_CHANGE_REQUEST",
      409,
      `An identical pending change request (${row.id}) is already in progress`,
    );
  }
}

/**
 * Segments an approved change request leaves on its collection's existing association: its own,
 * plus existing ones it does not speak for — another season, on platform positions it does not use.
 * A whole-media request (no segments) replaces everything.
 */
function mergeApprovedSegments(
  existing: readonly NormalizedSegment[],
  requested: readonly NormalizedSegment[],
  seasons: readonly SeasonSnapshotRow[],
): NormalizedSegment[] {
  if (requested.length === 0) {
    return [];
  }
  // Platform positions a segment covers; open-ended runs to its season's end, or forever if unknown.
  const positions = (s: NormalizedSegment): [number, number] => {
    const end = s.episodeEnd ?? seasons.find((x) => x.season === s.season)?.episodeCount;
    return [s.targetEpisodeStart, end ? s.targetEpisodeStart + end - s.episodeStart : Infinity];
  };
  const requestedSeasons = new Set(requested.map((s) => s.season));
  const claimed = requested.filter((s) => !s.nonLinear).map(positions);
  const kept = existing.filter((s) => {
    const [start, end] = positions(s);
    return (
      !requestedSeasons.has(s.season) &&
      (s.nonLinear || claimed.every(([a, b]) => end < a || b < start))
    );
  });
  return [...kept, ...requested].sort(
    (a, b) => a.season - b.season || a.episodeStart - b.episodeStart,
  );
}

/** Report only keys confirmed on this media, including which ones this call inserted. */
export async function backfillMissingExternalIdsInTx(
  trx: Transaction<Database>,
  input: {
    mediaId: string;
    externalIds: Partial<Record<ExternalIdNamespace, string | null>>;
    requiredExistingKey?: string;
    now?: Date;
  },
): Promise<{ ownedKeys: string[]; insertedKeys: string[] }> {
  const candidates = EXTERNAL_ID_NAMESPACES.flatMap((namespace) => {
    const nativeId = input.externalIds[namespace];
    return nativeId ? [{ namespace, nativeId }] : [];
  });
  if (candidates.length === 0) {
    return { ownedKeys: [], insertedKeys: [] };
  }

  const rows = await trx
    .selectFrom("associations")
    .select(["media_id", "namespace", "native_id as nativeId", "is_external_id", "status"])
    .where(
      "namespace",
      "in",
      candidates.map((entry) => entry.namespace),
    )
    .where((eb) =>
      eb.or([
        eb.and({ media_id: input.mediaId, is_external_id: true }),
        ...candidates.map(({ namespace, nativeId }) => eb.and({ namespace, native_id: nativeId })),
      ]),
    )
    .orderBy("id")
    .forShare()
    .$narrowType<{ namespace: ExternalIdNamespace }>()
    .execute();
  const local = rows.filter((row) => row.media_id === input.mediaId);
  const ownedKeys = local
    .filter(
      (row) =>
        row.is_external_id &&
        row.status === "confirmed" &&
        row.nativeId === input.externalIds[row.namespace],
    )
    .map(formatExternalKey);
  // A regular association with the same key also occupies (media_id, namespace, native_id).
  const missing = candidates.filter(
    ({ namespace }) => !local.some((row) => row.namespace === namespace),
  );
  if (
    missing.length === 0 ||
    (input.requiredExistingKey !== undefined && !ownedKeys.includes(input.requiredExistingKey)) ||
    local.some((row) => row.is_external_id && row.nativeId !== input.externalIds[row.namespace]) ||
    rows.some(
      (row) => row.media_id !== input.mediaId && (row.is_external_id || row.status === "confirmed"),
    )
  ) {
    return { ownedKeys, insertedKeys: [] };
  }

  // One insert makes a concurrent claim roll back the whole batch.
  const inserted = await trx
    .insertInto("associations")
    .values(
      missing.map(({ namespace, nativeId }) => ({
        media_id: input.mediaId,
        namespace,
        native_id: nativeId,
        status: "confirmed" as const,
        is_external_id: true,
        source: "sync" as const,
        ...(input.now ? { created_at: input.now, updated_at: input.now } : {}),
      })),
    )
    .returning(["namespace", "native_id as nativeId"])
    .execute();
  const insertedKeys = inserted.map(formatExternalKey);
  return { ownedKeys: [...ownedKeys, ...insertedKeys], insertedKeys };
}

export async function approveChangeRequestInTransaction(
  trx: Transaction<Database>,
  input: ApproveChangeRequestInTransactionInput,
): Promise<ApproveChangeRequestResult> {
  if (!isUuid(input.changeRequestId)) {
    throw new MediaServiceError("CHANGE_REQUEST_NOT_FOUND", 404, "Change request not found");
  }

  const allowedStatuses = input.allowedStatuses ?? ["needs_review"];
  const reason = input.reason?.trim() || null;
  const prefetchedCatalog: CatalogTargetSnapshot | null =
    input.prefetchedCatalog ??
    (input.prefetchedTmdb ? buildCatalogTargetSnapshotFromTmdb(input.prefetchedTmdb) : null);

  // 0. Lock the change request row FOR UPDATE to prevent double-approval
  const cr = await trx
    .selectFrom("change_requests")
    .selectAll()
    .where("id", "=", input.changeRequestId)
    .forUpdate()
    .executeTakeFirst();

  if (!cr) {
    throw new MediaServiceError("CHANGE_REQUEST_NOT_FOUND", 404, "Change request not found");
  }
  if (!allowedStatuses.includes(cr.status)) {
    throw new MediaServiceError(
      "INVALID_CHANGE_REQUEST_STATE",
      409,
      `Change request is in status "${cr.status}" and cannot be approved`,
    );
  }

  const target = parseTargetKey(cr.target_external_key);
  if (!target) {
    throw new MediaServiceError(
      "INVALID_TARGET_KEY",
      400,
      `Invalid targetExternalKey on change request: ${cr.target_external_key}`,
    );
  }

  // 1. Resolve or create target media under media-key advisory lock
  let media: ResolvedMediaRow | null = null;
  if (cr.media_id) {
    media = await resolveCanonicalMediaById(trx, cr.media_id);
  }

  let resolvedExistingMedia = Boolean(media);
  if (!media) {
    await acquireAdvisoryLock(trx, ADVISORY_LOCK_CLASSES.MEDIA_KEY, target.canonicalKey);
    const existingInTx = await resolveExistingMediaByTarget(trx, target);
    if (existingInTx) {
      media = existingInTx.media;
      resolvedExistingMedia = true;
    } else {
      if (!prefetchedCatalog) {
        throw new MediaServiceError(
          "MEDIA_NOT_FOUND",
          404,
          `Target media ${target.canonicalKey} does not exist`,
        );
      }

      const createdMedia = await trx
        .insertInto("media")
        .values({
          type: prefetchedCatalog.type,
          baseline: prefetchedCatalog.baseline,
          title: prefetchedCatalog.snapshot.title,
          original_title: prefetchedCatalog.snapshot.originalTitle,
          year: prefetchedCatalog.snapshot.year,
          seasons: JSON.stringify(prefetchedCatalog.snapshot.seasons),
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

      // Sync external IDs (TMDB, IMDb, TVDB, Trakt) discovered from target catalog
      const primaryExternalNamespace: ExternalIdNamespace | null = isExternalIdNamespace(
        prefetchedCatalog.sourceNamespace,
      )
        ? prefetchedCatalog.sourceNamespace
        : null;

      if (primaryExternalNamespace && prefetchedCatalog.externalIds[primaryExternalNamespace]) {
        await trx
          .insertInto("associations")
          .values({
            status: "confirmed",
            is_external_id: true,
            media_id: createdMedia.id,
            namespace: primaryExternalNamespace,
            native_id: prefetchedCatalog.externalIds[primaryExternalNamespace]!,
            source: "sync",
          })
          .execute();
      }

      const { ownedKeys: demandExternalKeys } = await backfillMissingExternalIdsInTx(trx, {
        mediaId: createdMedia.id,
        externalIds: prefetchedCatalog.externalIds,
      });

      // When created from a Douban or Bangumi catalog entry, establish the initial confirmed
      // catalog association immediately so GET /v1/media/douban:<id> or bangumi:<id> finds it.
      const initAssoc = prefetchedCatalog.initialAssociation;
      let createdInitSegments: NormalizedSegment[] = [];
      let createdInitAssociation = false;
      if (
        initAssoc &&
        (cr.namespace !== initAssoc.namespace || cr.native_id !== initAssoc.nativeId)
      ) {
        const createdInitAssoc = await trx
          .insertInto("associations")
          .values({
            media_id: createdMedia.id,
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
        if (createdMedia.type === "tv" && createdMedia.baseline !== null) {
          const season1 = prefetchedCatalog.snapshot.seasons.find((s) => s.season === 1);
          initSegments.push({
            season: 1,
            episodeStart: 1,
            episodeEnd: season1 && season1.episodeCount > 0 ? season1.episodeCount : null,
            targetEpisodeStart: 1,
            baseline: createdMedia.baseline,
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

        createdInitSegments = initSegments;
        createdInitAssociation = true;
      }

      if (initAssoc) {
        demandExternalKeys.push(
          formatExternalKey({ namespace: initAssoc.namespace, nativeId: initAssoc.nativeId }),
        );
      }

      await mergeExternalKeyDemandsIntoMedia(trx, {
        mediaId: createdMedia.id,
        externalKeys: demandExternalKeys,
        seasons: prefetchedCatalog.snapshot.seasons,
        mediaType: createdMedia.type,
        now: input.now,
      });

      if (initAssoc && createdInitAssociation) {
        await fulfillCoveredDemandsForAssociationInTx(trx, {
          mediaId: createdMedia.id,
          namespace: initAssoc.namespace,
          segments: createdInitSegments,
          now: input.now,
        });
      }

      media = createdMedia;
    }
  }

  if (resolvedExistingMedia && prefetchedCatalog) {
    const { insertedKeys } = await backfillMissingExternalIdsInTx(trx, {
      mediaId: media.id,
      externalIds: prefetchedCatalog.externalIds,
    });
    if (insertedKeys.length > 0) {
      await mergeExternalKeyDemandsIntoMedia(trx, {
        mediaId: media.id,
        externalKeys: insertedKeys,
        seasons: media.seasons,
        mediaType: media.type,
        now: input.now,
      });
    }
  }

  const mediaId = media.id;
  const namespace = cr.namespace;
  const nativeId = cr.native_id;
  const now = input.now ?? new Date();

  // 2. Lock media + namespace before resolving/creating variants & reading sibling associations
  await acquireAdvisoryLock(trx, ADVISORY_LOCK_CLASSES.MEDIA_NAMESPACE, `${mediaId}:${namespace}`);

  let resolvedVariantId: string | null = null;
  if (isPlatformNamespace(namespace)) {
    if (cr.variant_id) {
      const variantRow = await trx
        .selectFrom("variants")
        .select(["id", "is_default"])
        .where("id", "=", cr.variant_id)
        .where("media_id", "=", mediaId)
        .where("platform", "=", namespace)
        .executeTakeFirst();

      if (!variantRow) {
        throw new MediaServiceError(
          "INVALID_VARIANT",
          400,
          "Target variant no longer exists for this media and platform",
        );
      }

      if (cr.set_default_variant && !variantRow.is_default) {
        await trx
          .updateTable("variants")
          .set({ is_default: false, updated_at: now })
          .where("media_id", "=", mediaId)
          .where("platform", "=", namespace)
          .where("is_default", "=", true)
          .execute();

        await trx
          .updateTable("variants")
          .set({ is_default: true, updated_at: now })
          .where("id", "=", variantRow.id)
          .execute();
      }

      resolvedVariantId = variantRow.id;
    } else {
      const description = cr.variant_description?.trim();
      if (!description) {
        throw new MediaServiceError(
          "VARIANT_REQUIRED",
          400,
          "Platform change request must provide variantId or variantDescription",
        );
      }

      const existingByDescription = await trx
        .selectFrom("variants")
        .select(["id", "is_default"])
        .where("media_id", "=", mediaId)
        .where("platform", "=", namespace)
        .where("description", "=", description)
        .executeTakeFirst();

      if (existingByDescription) {
        if (cr.set_default_variant && !existingByDescription.is_default) {
          await trx
            .updateTable("variants")
            .set({ is_default: false, updated_at: now })
            .where("media_id", "=", mediaId)
            .where("platform", "=", namespace)
            .where("is_default", "=", true)
            .execute();

          await trx
            .updateTable("variants")
            .set({ is_default: true, updated_at: now })
            .where("id", "=", existingByDescription.id)
            .execute();
        }
        resolvedVariantId = existingByDescription.id;
      } else {
        const existingDefault = await trx
          .selectFrom("variants")
          .select("id")
          .where("media_id", "=", mediaId)
          .where("platform", "=", namespace)
          .where("is_default", "=", true)
          .executeTakeFirst();

        const shouldBeDefault = !existingDefault || Boolean(cr.set_default_variant);
        if (shouldBeDefault && existingDefault) {
          await trx
            .updateTable("variants")
            .set({ is_default: false, updated_at: now })
            .where("id", "=", existingDefault.id)
            .execute();
        }

        const createdVariant = await trx
          .insertInto("variants")
          .values({
            media_id: mediaId,
            platform: namespace,
            description,
            is_default: shouldBeDefault,
          })
          .returning("id")
          .executeTakeFirstOrThrow();

        resolvedVariantId = createdVariant.id;
      }
    }

    // 3. Acquire explicit variant advisory lock (per-variant serialization invariant)
    await acquireAdvisoryLock(trx, ADVISORY_LOCK_CLASSES.VARIANT, resolvedVariantId);
  }

  // 4. Acquire shared collection advisory lock
  await acquireAdvisoryLock(trx, ADVISORY_LOCK_CLASSES.COLLECTION, `${namespace}:${nativeId}`);

  // 5. Re-read active associations & segments inside the locked transaction and validate via @media-ref/client
  const storedSegments = parseJsonArray<StoredSegmentJson>(cr.segments);
  const requestedSegments = normalizeSegments(storedSegments);
  const effectiveReplacesAssociationId =
    input.replacesAssociationId !== undefined
      ? input.replacesAssociationId
      : extractReplacesAssociationId(cr.evidence);

  if (media.baseline === null && requestedSegments.length > 0) {
    throw new MediaServiceError(
      "SEGMENTS_NOT_ALLOWED_WITHOUT_BASELINE",
      400,
      "Media without a baseline cannot have segmented associations",
    );
  }

  const existingAssociation = await trx
    .selectFrom("associations")
    .where("is_external_id", "=", false)
    .select(["id", "variant_id", "status", "locked", "native_id"])
    .where("media_id", "=", mediaId)
    .where("namespace", "=", namespace)
    .where("native_id", "=", nativeId)
    .forUpdate()
    .executeTakeFirst();

  const normalizedSegments =
    existingAssociation?.status === "confirmed"
      ? mergeApprovedSegments(
          await loadSegments(trx, existingAssociation.id),
          requestedSegments,
          media.seasons,
        )
      : requestedSegments;

  const replacedAssociation =
    effectiveReplacesAssociationId &&
    effectiveReplacesAssociationId !== existingAssociation?.id &&
    isUuid(effectiveReplacesAssociationId)
      ? await trx
          .selectFrom("associations")
          .where("is_external_id", "=", false)
          .select(["id", "variant_id", "status", "locked", "native_id", "namespace"])
          .where("id", "=", effectiveReplacesAssociationId)
          .where("media_id", "=", mediaId)
          .forUpdate()
          .executeTakeFirst()
      : undefined;

  if (input.enforceUnlockedCheck) {
    if (existingAssociation?.locked) {
      throw new MediaServiceError(
        "ASSOCIATION_LOCKED",
        409,
        `Association ${existingAssociation.id} is locked and cannot be automatically modified`,
      );
    }
    if (replacedAssociation?.locked) {
      throw new MediaServiceError(
        "ASSOCIATION_LOCKED",
        409,
        `Association ${replacedAssociation.id} is locked and cannot be automatically replaced`,
      );
    }
  }

  const excludeAssociationIds = [
    ...(existingAssociation ? [existingAssociation.id] : []),
    ...(replacedAssociation ? [replacedAssociation.id] : []),
  ];

  const siblingAssociations = isPlatformNamespace(namespace)
    ? await loadActiveAssociationsWithSegments(trx, {
        variantId: resolvedVariantId!,
        excludeAssociationIds,
      })
    : await loadActiveAssociationsWithSegments(trx, {
        mediaId,
        catalogNamespace: namespace,
        excludeAssociationIds,
      });

  const variantValidation = validateVariantSegments(
    [
      ...siblingAssociations.map((a) => ({ associationId: a.id, segments: a.segments })),
      {
        associationId: existingAssociation?.id ?? "candidate",
        segments: normalizedSegments,
      },
    ],
    {
      baseline: media.baseline,
      allowHierarchicalScopes: getNamespaceCapabilities(namespace).allowHierarchicalScopes,
    },
  );

  if (!variantValidation.valid) {
    const classified = classifyValidationErrorStatus(variantValidation.errors, 409);
    throw new MediaServiceError(
      classified.code,
      classified.status,
      variantValidation.errors[0].message,
      variantValidation.errors,
    );
  }

  const collectionAssociations = await loadActiveAssociationsWithSegments(trx, {
    collection: { namespace, nativeId },
    excludeAssociationId: existingAssociation?.id,
  });

  const sharedValidation = validateSharedCollectionSegments([
    ...collectionAssociations.map((a) => ({
      mediaId: a.mediaId,
      associationId: a.id,
      segments: a.segments,
    })),
    {
      mediaId,
      associationId: existingAssociation?.id ?? "candidate",
      segments: normalizedSegments,
    },
  ]);

  if (!sharedValidation.valid) {
    const classified = classifyValidationErrorStatus(sharedValidation.errors, 409);
    throw new MediaServiceError(
      classified.code,
      classified.status,
      sharedValidation.errors[0].message,
      sharedValidation.errors,
    );
  }

  // 5b. If replacing a distinct association, atomically delist it and record a new revision preserving history
  if (replacedAssociation && replacedAssociation.status !== "delisted") {
    const replacedSegmentsSnapshot = await loadSegments(trx, replacedAssociation.id);

    await trx
      .updateTable("associations")
      .set({
        status: "delisted",
        updated_at: now,
      })
      .where("id", "=", replacedAssociation.id)
      .execute();

    await trx.deleteFrom("segments").where("association_id", "=", replacedAssociation.id).execute();

    const maxReplacedRevRow = await trx
      .selectFrom("association_revisions")
      .select(sql<number | null>`max(revision_number)`.as("max_rev"))
      .where("association_id", "=", replacedAssociation.id)
      .executeTakeFirst();

    const nextReplacedRev = (maxReplacedRevRow?.max_rev ?? 0) + 1;
    const delistedRev = await trx
      .insertInto("association_revisions")
      .values({
        association_id: replacedAssociation.id,
        revision_number: nextReplacedRev,
        change_request_id: cr.id,
        variant_id: replacedAssociation.variant_id,
        status: "delisted",
        segments: JSON.stringify(replacedSegmentsSnapshot),
        actor_user_id: input.reviewerUserId,
        reason: reason ?? "replaced_by_change_request",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await trx
      .updateTable("associations")
      .set({
        current_revision_id: delistedRev.id,
        updated_at: now,
      })
      .where("id", "=", replacedAssociation.id)
      .execute();
  }

  // 6. Upsert association, replace segments, insert new revision, and mark change request approved
  const collectionDisplay = extractCollectionDisplay(
    input.evidence !== undefined ? input.evidence : cr.evidence,
  );
  let associationId: string;
  let nextRevisionNumber: number;

  if (existingAssociation) {
    associationId = existingAssociation.id;
    await trx
      .updateTable("associations")
      .set({
        variant_id: resolvedVariantId,
        status: "confirmed",
        needs_review: false,
        ...collectionDisplay,
        updated_at: now,
      })
      .where("id", "=", associationId)
      .execute();

    await trx.deleteFrom("segments").where("association_id", "=", associationId).execute();

    const maxRevRow = await trx
      .selectFrom("association_revisions")
      .select(sql<number | null>`max(revision_number)`.as("max_rev"))
      .where("association_id", "=", associationId)
      .executeTakeFirst();

    nextRevisionNumber = (maxRevRow?.max_rev ?? 0) + 1;
  } else {
    const createdAssoc = await trx
      .insertInto("associations")
      .values({
        media_id: mediaId,
        namespace,
        native_id: nativeId,
        variant_id: resolvedVariantId,
        status: "confirmed",
        needs_review: false,
        locked: false,
        ...collectionDisplay,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    associationId = createdAssoc.id;
    nextRevisionNumber = 1;
  }

  if (normalizedSegments.length > 0) {
    await trx
      .insertInto("segments")
      .values(
        normalizedSegments.map((seg) => ({
          association_id: associationId,
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

  const revision = await trx
    .insertInto("association_revisions")
    .values({
      association_id: associationId,
      revision_number: nextRevisionNumber,
      change_request_id: cr.id,
      variant_id: resolvedVariantId,
      status: "confirmed",
      segments: JSON.stringify(normalizedSegments),
      actor_user_id: input.reviewerUserId,
      reason,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  await trx
    .updateTable("associations")
    .set({
      current_revision_id: revision.id,
      updated_at: now,
    })
    .where("id", "=", associationId)
    .execute();

  await fulfillCoveredDemandsForAssociationInTx(trx, {
    mediaId,
    namespace,
    segments: normalizedSegments,
    now,
  });

  const updatedCr = await trx
    .updateTable("change_requests")
    .set({
      status: "approved",
      media_id: mediaId,
      variant_id: resolvedVariantId,
      decision_reason: reason,
      reviewer_user_id: input.reviewerUserId,
      reviewed_at: now,
      applied_association_id: associationId,
      applied_revision_id: revision.id,
      ...(input.evidence !== undefined
        ? { evidence: input.evidence === null ? null : JSON.stringify(input.evidence) }
        : {}),
      ...(input.conflictReason !== undefined ? { conflict_reason: input.conflictReason } : {}),
      updated_at: now,
    })
    .where("id", "=", cr.id)
    .returningAll()
    .executeTakeFirstOrThrow();

  return {
    changeRequest: toChangeRequestRecord(updatedCr),
    mediaId,
    associationId,
    revisionId: revision.id,
  };
}

export async function rejectChangeRequest(
  dbWrite: Db,
  input: RejectChangeRequestInput,
): Promise<ChangeRequestRecord> {
  if (!isUuid(input.changeRequestId)) {
    throw new MediaServiceError("CHANGE_REQUEST_NOT_FOUND", 404, "Change request not found");
  }

  return dbWrite.transaction().execute((trx) => rejectChangeRequestInTx(trx, input));
}

/**
 * `rejectChangeRequest` inside the caller's transaction. A review agent correction (ADR 0003 §4)
 * also stores the evidence and makes its corrected season explorable without backoff.
 */
export async function rejectChangeRequestInTx(
  trx: Transaction<Database>,
  input: RejectChangeRequestInput & { evidence?: JsonObject; correctedSeason?: number; now?: Date },
): Promise<ChangeRequestRecord> {
  const allowedStatuses = input.allowedStatuses ?? ["needs_review"];
  const reason = input.reason?.trim() || null;

  const cr = await trx
    .selectFrom("change_requests")
    .selectAll()
    .where("id", "=", input.changeRequestId)
    .forUpdate()
    .executeTakeFirst();

  if (!cr) {
    throw new MediaServiceError("CHANGE_REQUEST_NOT_FOUND", 404, "Change request not found");
  }
  if (!allowedStatuses.includes(cr.status)) {
    throw new MediaServiceError(
      "INVALID_CHANGE_REQUEST_STATE",
      409,
      `Change request is in status "${cr.status}" and cannot be rejected`,
    );
  }

  const now = input.now ?? new Date();
  let evidence = input.evidence;
  if (cr.demand_id && input.correctedSeason !== undefined) {
    // The correction can precede the exploration commit or the last sibling review.
    const demand = await trx
      .selectFrom("demands")
      .select("lease_generation")
      .where("id", "=", cr.demand_id)
      .where("season", "=", input.correctedSeason)
      .where("status", "in", ["leased", "awaiting_review"])
      .forUpdate()
      .executeTakeFirst();
    if (demand) evidence = { ...evidence, correctedDemandGeneration: demand.lease_generation };
  }
  const updated = await trx
    .updateTable("change_requests")
    .set({
      status: "rejected",
      decision_reason: reason,
      reviewer_user_id: input.reviewerUserId,
      reviewed_at: now,
      updated_at: now,
      ...(evidence ? { evidence: JSON.stringify(evidence) } : {}),
    })
    .where("id", "=", cr.id)
    .returningAll()
    .executeTakeFirstOrThrow();

  // Rejecting a request that was already rejected keeps it so; its demand had its round then.
  if (cr.demand_id && cr.status !== "rejected") {
    await reopenDemandAfterRejectionInTx(trx, {
      demandId: cr.demand_id,
      now,
    });
  }

  return toChangeRequestRecord(updated);
}

/**
 * Takes back the current approval by restoring the preceding confirmed change request or delisting
 * the association. The caller rechecks demand coverage for the seasons in the removed snapshot
 * (an empty list means the whole media).
 */
export async function revokeChangeRequestInTx(
  trx: Transaction<Database>,
  input: {
    changeRequestId: string;
    reviewerUserId: string;
    reason: string;
    evidence: JsonObject;
    now: Date;
  },
): Promise<{ changeRequest: ChangeRequestRecord; deletedSeasons: number[] }> {
  const cr = await trx
    .selectFrom("change_requests")
    .selectAll()
    .where("id", "=", input.changeRequestId)
    .forUpdate()
    .executeTakeFirst();
  if (!cr) {
    throw new MediaServiceError("CHANGE_REQUEST_NOT_FOUND", 404, "Change request not found");
  }
  if (cr.status !== "approved" || !cr.applied_association_id || !cr.media_id) {
    throw new MediaServiceError(
      "INVALID_CHANGE_REQUEST_STATE",
      409,
      `Change request is in status "${cr.status}" and cannot be revoked`,
    );
  }
  await acquireAdvisoryLock(
    trx,
    ADVISORY_LOCK_CLASSES.MEDIA_NAMESPACE,
    `${cr.media_id}:${cr.namespace}`,
  );
  const revisions = trx
    .selectFrom("association_revisions")
    .where("association_id", "=", cr.applied_association_id)
    .select([
      "id",
      "revision_number",
      "change_request_id",
      "restored_from_revision_id",
      "status",
      "variant_id",
    ]);
  const current = await revisions.orderBy("revision_number", "desc").limit(1).executeTakeFirst();

  // A restore is owned by the revoked request; its effective approval remains the original row.
  const approvalFor = (revision: NonNullable<typeof current>) =>
    trx
      .selectFrom("association_revisions as origin")
      .innerJoin("change_requests as owner", "owner.id", "origin.change_request_id")
      .where("origin.id", "=", revision.restored_from_revision_id ?? revision.id)
      .where("origin.restored_from_revision_id", "is", null)
      .where("origin.association_id", "=", cr.applied_association_id)
      .where("origin.revision_number", "<=", revision.revision_number)
      .where("origin.status", "=", "confirmed")
      .where("owner.status", "=", "approved")
      .whereRef("owner.applied_association_id", "=", "origin.association_id")
      .whereRef("owner.applied_revision_id", "=", "origin.id");
  const original =
    current?.status === "confirmed"
      ? await approvalFor(current)
          .where("owner.id", "=", cr.id)
          .select("origin.revision_number")
          .executeTakeFirst()
      : null;
  const previous =
    original &&
    (await revisions
      .where("revision_number", "=", original.revision_number - 1)
      .executeTakeFirst());
  const restore =
    previous?.status === "confirmed"
      ? await approvalFor(previous)
          .where("owner.id", "!=", cr.id)
          .select(["origin.id", "origin.variant_id", "origin.segments"])
          .executeTakeFirst()
      : null;
  const variantIds = new Set([current?.variant_id, restore?.variant_id].filter((id) => id != null));
  for (const variantId of [...variantIds].sort()) {
    await acquireAdvisoryLock(trx, ADVISORY_LOCK_CLASSES.VARIANT, variantId);
  }
  await acquireAdvisoryLock(
    trx,
    ADVISORY_LOCK_CLASSES.COLLECTION,
    `${cr.namespace}:${cr.native_id}`,
  );
  const association = await trx
    .selectFrom("associations")
    .select(["id", "variant_id", "status", "locked", "current_revision_id"])
    .where("id", "=", cr.applied_association_id)
    .where("media_id", "=", cr.media_id)
    .where("namespace", "=", cr.namespace)
    .where("native_id", "=", cr.native_id)
    .forUpdate()
    .executeTakeFirst();
  if (
    !association ||
    !current ||
    !original ||
    association.status !== "confirmed" ||
    association.current_revision_id !== current.id
  ) {
    throw new MediaServiceError(
      "ASSOCIATION_SUPERSEDED",
      409,
      "The association is no longer the one this change request applied",
    );
  }
  if (association.locked) {
    throw new MediaServiceError(
      "ASSOCIATION_LOCKED",
      409,
      `Association ${association.id} is locked and cannot be automatically modified`,
    );
  }

  // A confirmed legacy restore with no verifiable owner is not evidence that the association was absent.
  if (previous?.status === "confirmed" && previous.change_request_id && !restore) {
    throw new MediaServiceError(
      "ASSOCIATION_SUPERSEDED",
      409,
      "Cannot verify the preceding approval to restore",
    );
  }

  const snapshot = await loadSegments(trx, association.id);
  const restoredSegments = restore ? normalizeSegments(restore.segments) : [];
  if (restore) {
    if (isPlatformNamespace(cr.namespace)) {
      const variant =
        restore.variant_id &&
        (await trx
          .selectFrom("variants")
          .select("id")
          .where("id", "=", restore.variant_id)
          .where("media_id", "=", cr.media_id)
          .where("platform", "=", cr.namespace)
          .executeTakeFirst());
      if (!variant) {
        throw new MediaServiceError(
          "INVALID_VARIANT",
          400,
          "Previous variant no longer exists for this media and platform",
        );
      }
    }
    const media = await trx
      .selectFrom("media")
      .select("baseline")
      .where("id", "=", cr.media_id)
      .executeTakeFirstOrThrow();
    const siblings = await loadActiveAssociationsWithSegments(trx, {
      ...(restore.variant_id
        ? { variantId: restore.variant_id }
        : { mediaId: cr.media_id, catalogNamespace: cr.namespace }),
      excludeAssociationId: association.id,
    });
    const shared = await loadActiveAssociationsWithSegments(trx, {
      collection: { namespace: cr.namespace, nativeId: cr.native_id },
      excludeAssociationId: association.id,
    });
    const candidate = {
      mediaId: cr.media_id,
      associationId: association.id,
      segments: restoredSegments,
    };
    for (const result of [
      validateVariantSegments([...siblings, candidate], {
        baseline: media.baseline,
        allowHierarchicalScopes: getNamespaceCapabilities(cr.namespace).allowHierarchicalScopes,
      }),
      validateSharedCollectionSegments([
        ...shared.map((a) => ({ ...a, associationId: a.id })),
        candidate,
      ]),
    ]) {
      if (!result.valid) {
        const { code, status } = classifyValidationErrorStatus(result.errors, 409);
        throw new MediaServiceError(code, status, result.errors[0].message, result.errors);
      }
    }
  }

  await trx.deleteFrom("segments").where("association_id", "=", association.id).execute();
  if (restoredSegments.length > 0) {
    await trx
      .insertInto("segments")
      .values(
        restoredSegments.map((seg) => ({
          association_id: association.id,
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
  const status = restore ? "confirmed" : "delisted";
  const variantId = restore ? restore.variant_id : association.variant_id;
  const revision = await trx
    .insertInto("association_revisions")
    .values({
      association_id: association.id,
      revision_number: current.revision_number + 1,
      change_request_id: cr.id,
      restored_from_revision_id: restore?.id ?? null,
      variant_id: variantId,
      status,
      segments: JSON.stringify(restore ? restoredSegments : snapshot),
      actor_user_id: input.reviewerUserId,
      reason: input.reason,
      created_at: input.now,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await trx
    .updateTable("associations")
    .set({
      status,
      variant_id: variantId,
      needs_review: false,
      current_revision_id: revision.id,
      updated_at: input.now,
    })
    .where("id", "=", association.id)
    .execute();

  const updated = await trx
    .updateTable("change_requests")
    .set({
      status: "rejected",
      decision_reason: input.reason,
      reviewer_user_id: input.reviewerUserId,
      reviewed_at: input.now,
      updated_at: input.now,
      evidence: JSON.stringify(input.evidence),
    })
    .where("id", "=", cr.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  return {
    changeRequest: toChangeRequestRecord(updated),
    deletedSeasons: [...new Set(snapshot.map((seg) => seg.season))],
  };
}

export async function readMediaDocument(
  dbRead: Db,
  rawKey: string,
): Promise<ReadMediaDocumentResult> {
  const result = await queryMediaByKey(dbRead, rawKey, { includeUnconfirmed: false });
  if (result.kind === "invalid_key") {
    return { kind: "invalid_key", message: result.message };
  }
  if (result.kind === "not_found" || result.items.length === 0) {
    return { kind: "not_found" };
  }

  const primary = result.items[0]!;
  return {
    kind: "ok",
    document: primary.document,
    matchedAssociationId: primary.matchedAssociationId,
    items: result.items,
  };
}
