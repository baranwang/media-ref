import {
  EXTERNAL_ID_NAMESPACES,
  PLATFORM_NAMESPACES,
  formatExternalKey,
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
  type PlatformNamespace,
  type PlatformStatusEntry,
  type SeasonSnapshot,
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
import { mergeExternalKeyDemandsIntoMedia } from "./demands.ts";
import { enqueueJob } from "./jobs.ts";
import type { OutboundClient } from "./outbound.ts";
import { enforceSubmissionQuotaInTx, type SubmissionQuotaConfig } from "./quota.ts";
import {
  TmdbGatewayError,
  createTmdbGateway,
  parseTmdbNativeId,
  type TmdbGateway,
  type TmdbGatewayConfig,
  type TmdbMediaFetchResult,
} from "./tmdb.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXTERNAL_ID_NAMESPACE_SET: ReadonlySet<string> = new Set(EXTERNAL_ID_NAMESPACES);
const ASSOCIATION_NAMESPACE_SET: ReadonlySet<string> = new Set<AssociationNamespaceRow>([
  ...PLATFORM_NAMESPACES,
  "douban",
  "bangumi",
]);

const LOCK_CLASS_MEDIA_KEY = 1001;
const LOCK_CLASS_MEDIA_NAMESPACE = 1002;
const LOCK_CLASS_VARIANT = 1003;
const LOCK_CLASS_COLLECTION = 1004;

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
  | "SEGMENT_OVERLAP"
  | "INVALID_TASK_ID"
  | "MEDIA_NOT_FOUND"
  | "CHANGE_REQUEST_NOT_FOUND"
  | "INVALID_CHANGE_REQUEST_STATE"
  | "TMDB_MEDIA_NOT_FOUND"
  | "TMDB_UPSTREAM_ERROR";

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
  createdAt: string;
  updatedAt: string;
}

export interface CreateChangeRequestInput {
  submitterUserId: string;
  submitterKeyId?: string | null;
  submitterType?: "human" | "agent";
  taskId?: string | null;
  targetExternalKey: string;
  namespace: string;
  nativeId: string;
  rawNativeId?: string;
  variantId?: string | null;
  variantDescription?: string | null;
  setDefaultVariant?: boolean;
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
  prefetchedTmdb?: TmdbMediaFetchResult | null;
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
  prefetchedTmdb?: TmdbMediaFetchResult | null;
  allowedStatuses?: readonly ChangeRequestStatus[];
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
  | { kind: "ok"; document: MediaDocument; matchedAssociationId: string | null }
  | { kind: "not_found" }
  | { kind: "invalid_key"; message: string };

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function isAssociationNamespace(value: string): value is AssociationNamespace {
  return ASSOCIATION_NAMESPACE_SET.has(value);
}

function isExternalIdNamespace(value: string): value is ExternalIdNamespace {
  return EXTERNAL_ID_NAMESPACE_SET.has(value);
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

function parseSeasonsSnapshot(raw: unknown): SeasonSnapshot[] {
  const entries = parseJsonArray<SeasonSnapshotRow>(raw);
  return entries.map((entry) => ({
    season: entry.season,
    episodeCount: entry.episodeCount,
    airYear: entry.airYear ?? null,
  }));
}

function toChangeRequestRecord(row: Selectable<ChangeRequestsTable>): ChangeRequestRecord {
  const storedSegments = parseJsonArray<StoredSegmentJson>(row.segments);
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
    evidence: parseJsonObject(row.evidence),
    conflictReason: row.conflict_reason,
    decisionReason: row.decision_reason,
    reviewerUserId: row.reviewer_user_id,
    reviewedAt: row.reviewed_at ? toIsoString(row.reviewed_at) : null,
    appliedAssociationId: row.applied_association_id,
    appliedRevisionId: row.applied_revision_id,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

type DbExecutor = Db | Transaction<Database>;

async function acquireAdvisoryLock(
  trx: Transaction<Database>,
  lockClass: number,
  lockKey: string,
): Promise<void> {
  await sql`select pg_advisory_xact_lock(${lockClass}::int4, hashtext(${lockKey}::text))`.execute(
    trx,
  );
}

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
      .selectFrom("external_ids")
      .select("media_id")
      .where("namespace", "=", target.namespace)
      .where("native_id", "=", target.nativeId)
      .executeTakeFirst();

    if (!ext) {
      return null;
    }

    const media = await resolveCanonicalMediaById(db, ext.media_id);
    return media ? { media, matchedAssociationIds: [] } : null;
  }

  if (isAssociationNamespace(target.namespace)) {
    const rows = await db
      .selectFrom("associations")
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
  },
): Promise<Array<{ id: string; mediaId: string; segments: NormalizedSegment[] }>> {
  let query = db
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

function classifyValidationErrorStatus(
  errors: SegmentValidationError[],
  conflictStatus: number,
): { code: MediaServiceErrorCode; status: number } {
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
  if (trimmedNativeId.length === 0) {
    throw new MediaServiceError("INVALID_NATIVE_ID", 400, "nativeId must be a non-empty string");
  }
  const rawNativeId = (input.rawNativeId ?? input.nativeId).trim() || trimmedNativeId;

  const adapter = options.adapterRegistry?.get(namespace);
  let nativeId = trimmedNativeId;
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
  }

  if (input.taskId !== undefined && input.taskId !== null && !isUuid(input.taskId)) {
    throw new MediaServiceError("INVALID_TASK_ID", 400, "taskId must be a valid UUID");
  }

  // Resolve existing media if present
  const resolved = await resolveExistingMediaByTarget(dbWrite, target);
  if (target.kind === "media_id" && !resolved) {
    throw new MediaServiceError("MEDIA_NOT_FOUND", 404, `Media not found for ID ${target.mediaId}`);
  }

  if (!resolved) {
    if (
      target.kind !== "external_key" ||
      target.namespace !== "tmdb" ||
      !parseTmdbNativeId(target.nativeId)
    ) {
      throw new MediaServiceError(
        "INVALID_TARGET_KEY",
        400,
        "Uncreated media submissions must target a valid TMDB external key (tmdb:movie:<id> or tmdb:tv:<id>)",
      );
    }
  }

  const existingMedia = resolved?.media ?? null;
  const effectiveBaseline: BaselineSource | null = existingMedia ? existingMedia.baseline : "tmdb";

  // Variant validation
  let resolvedVariantId: string | null = null;
  let variantDescription: string | null = null;
  const setDefaultVariant = Boolean(input.setDefaultVariant);

  if (isPlatformNamespace(namespace)) {
    const rawVariantId = input.variantId?.trim() || null;
    const rawDescription = input.variantDescription?.trim() || null;

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
  const rawSegments = input.segments ?? [];
  if (!Array.isArray(rawSegments)) {
    throw new MediaServiceError("INVALID_SEGMENTS", 400, "segments must be an array");
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
  if (existingMedia) {
    const existingSameCollection = await dbWrite
      .selectFrom("associations")
      .select("id")
      .where("media_id", "=", existingMedia.id)
      .where("namespace", "=", namespace)
      .where("native_id", "=", nativeId)
      .executeTakeFirst();

    if (isPlatformNamespace(namespace) && resolvedVariantId) {
      const others = await loadActiveAssociationsWithSegments(dbWrite, {
        variantId: resolvedVariantId,
        excludeAssociationId: existingSameCollection?.id,
      });
      const variantCheck = validateVariantSegments(
        [
          ...others.map((o) => ({ associationId: o.id, segments: o.segments })),
          {
            associationId: existingSameCollection?.id ?? "candidate",
            segments: normalizedSegments,
          },
        ],
        { baseline: existingMedia.baseline },
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
        excludeAssociationId: existingSameCollection?.id,
      });
      const catalogCheck = validateVariantSegments(
        [
          ...others.map((o) => ({ associationId: o.id, segments: o.segments })),
          {
            associationId: existingSameCollection?.id ?? "candidate",
            segments: normalizedSegments,
          },
        ],
        { baseline: existingMedia.baseline },
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
  const existingOnCollection = await loadActiveAssociationsWithSegments(dbWrite, {
    collection: { namespace, nativeId },
  });
  const otherMediaOnCollection = existingOnCollection.filter(
    (entry) => !existingMedia || entry.mediaId !== existingMedia.id,
  );
  if (otherMediaOnCollection.length > 0) {
    const sharedCheck = validateSharedCollectionSegments([
      ...otherMediaOnCollection.map((entry) => ({
        mediaId: entry.mediaId,
        associationId: entry.id,
        segments: entry.segments,
      })),
      {
        mediaId: existingMedia?.id ?? "__pending_media__",
        associationId: "candidate",
        segments: normalizedSegments,
      },
    ]);
    if (!sharedCheck.valid) {
      const classified = classifyValidationErrorStatus(sharedCheck.errors, 400);
      throw new MediaServiceError(
        classified.code,
        classified.status,
        sharedCheck.errors[0].message,
        sharedCheck.errors,
      );
    }
  }

  const hasTier2Adapter = Boolean(adapter && adapter.tier >= 2);
  const resolvedStatus: ChangeRequestStatus =
    input.initialStatus ?? (hasTier2Adapter ? "pending_evidence" : "needs_review");
  const initialDecisionReason =
    input.initialStatus === undefined &&
    resolvedStatus === "needs_review" &&
    options.adapterRegistry
      ? TIER1_MANUAL_REVIEW_REASON
      : null;
  const shouldEnqueueEvidenceCheck = resolvedStatus === "pending_evidence";
  const effectiveNow = input.now ?? options.now;

  const inserted = await dbWrite.transaction().execute(async (trx) => {
    const quota = await enforceSubmissionQuotaInTx(trx, {
      submitterUserId: input.submitterUserId,
      config: input.submissionQuota,
      now: effectiveNow,
    });

    const row = await trx
      .insertInto("change_requests")
      .values({
        status: resolvedStatus,
        submitter_user_id: input.submitterUserId,
        submitter_key_id: input.submitterKeyId ?? null,
        submitter_type: input.submitterType ?? "human",
        task_id: input.taskId ?? null,
        media_id: existingMedia?.id ?? null,
        target_external_key: target.canonicalKey,
        namespace,
        raw_native_id: rawNativeId,
        native_id: nativeId,
        variant_id: resolvedVariantId,
        variant_description: variantDescription,
        set_default_variant: setDefaultVariant,
        segments: JSON.stringify(normalizedSegments),
        decision_reason: initialDecisionReason,
        ...(effectiveNow ? { created_at: quota.referenceNow, updated_at: quota.referenceNow } : {}),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    if (shouldEnqueueEvidenceCheck) {
      await enqueueJob(trx, {
        jobType: EVIDENCE_CHECK_JOB_TYPE,
        payload: { changeRequestId: row.id },
        dedupeKey: `${EVIDENCE_CHECK_JOB_TYPE}:${row.id}`,
        runAfter: effectiveNow ?? quota.referenceNow,
      });
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

  const [rows, countRow] = await Promise.all([
    dbWrite
      .selectFrom("change_requests")
      .selectAll()
      .where("status", "=", status)
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .limit(limit)
      .offset(offset)
      .execute(),
    dbWrite
      .selectFrom("change_requests")
      .select(sql<string>`count(*)`.as("count"))
      .where("status", "=", status)
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

  let prefetchedTmdb: TmdbMediaFetchResult | null = input.prefetchedTmdb ?? null;
  let needsMediaCreation = preRead.media_id === null && prefetchedTmdb === null;
  if (needsMediaCreation) {
    const existingBeforeTx = await resolveExistingMediaByTarget(dbWrite, preTarget);
    if (existingBeforeTx) {
      needsMediaCreation = false;
    }
  }

  if (needsMediaCreation) {
    if (preTarget.kind !== "external_key" || preTarget.namespace !== "tmdb") {
      throw new MediaServiceError(
        "INVALID_TARGET_KEY",
        400,
        "Cannot create media without a TMDB external key",
      );
    }
    const tmdbParsed = parseTmdbNativeId(preTarget.nativeId);
    if (!tmdbParsed) {
      throw new MediaServiceError(
        "INVALID_TARGET_KEY",
        400,
        `Invalid TMDB native ID: ${preTarget.nativeId}`,
      );
    }

    const gateway = input.tmdbGateway ?? createTmdbGateway(outbound, input.tmdbConfig);
    try {
      prefetchedTmdb = await gateway.fetchMediaSnapshotAndExternalIds(
        tmdbParsed.type,
        tmdbParsed.id,
      );
    } catch (error) {
      if (error instanceof TmdbGatewayError) {
        throw new MediaServiceError("TMDB_UPSTREAM_ERROR", error.status, error.message);
      }
      throw new MediaServiceError(
        "TMDB_UPSTREAM_ERROR",
        502,
        error instanceof Error ? error.message : "Failed to fetch TMDB media metadata",
      );
    }

    if (!prefetchedTmdb) {
      throw new MediaServiceError(
        "TMDB_MEDIA_NOT_FOUND",
        404,
        `TMDB media not found for ${preTarget.canonicalKey}`,
      );
    }
  }

  return dbWrite.transaction().execute((trx) =>
    approveChangeRequestInTransaction(trx, {
      changeRequestId: input.changeRequestId,
      reviewerUserId: input.reviewerUserId,
      reason,
      evidence: input.evidence,
      conflictReason: input.conflictReason,
      prefetchedTmdb,
      allowedStatuses,
      now: input.now,
    }),
  );
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
  const prefetchedTmdb = input.prefetchedTmdb ?? null;

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

  if (!media) {
    await acquireAdvisoryLock(trx, LOCK_CLASS_MEDIA_KEY, target.canonicalKey);
    const existingInTx = await resolveExistingMediaByTarget(trx, target);
    if (existingInTx) {
      media = existingInTx.media;
    } else {
      if (!prefetchedTmdb) {
        throw new MediaServiceError(
          "MEDIA_NOT_FOUND",
          404,
          `Target media ${target.canonicalKey} does not exist`,
        );
      }

      const createdMedia = await trx
        .insertInto("media")
        .values({
          type: prefetchedTmdb.type,
          baseline: "tmdb",
          title: prefetchedTmdb.snapshot.title,
          original_title: prefetchedTmdb.snapshot.originalTitle,
          year: prefetchedTmdb.snapshot.year,
          seasons: JSON.stringify(prefetchedTmdb.snapshot.seasons),
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

      // Sync TMDB + IMDb + TVDB + Trakt external IDs
      await trx
        .insertInto("external_ids")
        .values({
          media_id: createdMedia.id,
          namespace: "tmdb",
          native_id: prefetchedTmdb.externalIds.tmdb,
          source: "sync",
        })
        .execute();

      const secondaryExternalIds: Array<{ namespace: ExternalIdNamespace; nativeId: string }> = [];
      if (prefetchedTmdb.externalIds.imdb) {
        secondaryExternalIds.push({
          namespace: "imdb",
          nativeId: prefetchedTmdb.externalIds.imdb,
        });
      }
      if (prefetchedTmdb.externalIds.tvdb) {
        secondaryExternalIds.push({
          namespace: "tvdb",
          nativeId: prefetchedTmdb.externalIds.tvdb,
        });
      }
      if (prefetchedTmdb.externalIds.trakt) {
        secondaryExternalIds.push({
          namespace: "trakt",
          nativeId: prefetchedTmdb.externalIds.trakt,
        });
      }

      for (const ext of secondaryExternalIds) {
        await trx
          .insertInto("external_ids")
          .values({
            media_id: createdMedia.id,
            namespace: ext.namespace,
            native_id: ext.nativeId,
            source: "sync",
          })
          .onConflict((oc) => oc.doNothing())
          .execute();
      }

      await mergeExternalKeyDemandsIntoMedia(trx, {
        mediaId: createdMedia.id,
        externalKeys: [
          formatExternalKey({ namespace: "tmdb", nativeId: prefetchedTmdb.externalIds.tmdb }),
          ...secondaryExternalIds.map((ext) => formatExternalKey(ext)),
        ],
        seasons: prefetchedTmdb.snapshot.seasons,
        mediaType: createdMedia.type,
        now: input.now,
      });

      media = createdMedia;
    }
  }

  const mediaId = media.id;
  const namespace = cr.namespace;
  const nativeId = cr.native_id;
  const now = input.now ?? new Date();

  // 2. Lock media + namespace before resolving/creating variants & reading sibling associations
  await acquireAdvisoryLock(trx, LOCK_CLASS_MEDIA_NAMESPACE, `${mediaId}:${namespace}`);

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
    await acquireAdvisoryLock(trx, LOCK_CLASS_VARIANT, resolvedVariantId);
  }

  // 4. Acquire shared collection advisory lock
  await acquireAdvisoryLock(trx, LOCK_CLASS_COLLECTION, `${namespace}:${nativeId}`);

  // 5. Re-read active associations & segments inside the locked transaction and validate via @media-ref/client
  const storedSegments = parseJsonArray<StoredSegmentJson>(cr.segments);
  const normalizedSegments = normalizeSegments(storedSegments);

  const existingAssociation = await trx
    .selectFrom("associations")
    .select(["id", "variant_id"])
    .where("media_id", "=", mediaId)
    .where("namespace", "=", namespace)
    .where("native_id", "=", nativeId)
    .executeTakeFirst();

  const siblingAssociations = isPlatformNamespace(namespace)
    ? await loadActiveAssociationsWithSegments(trx, {
        variantId: resolvedVariantId!,
        excludeAssociationId: existingAssociation?.id,
      })
    : await loadActiveAssociationsWithSegments(trx, {
        mediaId,
        catalogNamespace: namespace,
        excludeAssociationId: existingAssociation?.id,
      });

  const variantValidation = validateVariantSegments(
    [
      ...siblingAssociations.map((a) => ({ associationId: a.id, segments: a.segments })),
      {
        associationId: existingAssociation?.id ?? "candidate",
        segments: normalizedSegments,
      },
    ],
    { baseline: media.baseline },
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

  // 6. Upsert association, replace segments, insert new revision, and mark change request approved
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

  const allowedStatuses = input.allowedStatuses ?? ["needs_review"];
  const reason = input.reason?.trim() || null;

  return dbWrite.transaction().execute(async (trx) => {
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

    const now = new Date();
    const updated = await trx
      .updateTable("change_requests")
      .set({
        status: "rejected",
        decision_reason: reason,
        reviewer_user_id: input.reviewerUserId,
        reviewed_at: now,
        updated_at: now,
      })
      .where("id", "=", cr.id)
      .returningAll()
      .executeTakeFirstOrThrow();

    return toChangeRequestRecord(updated);
  });
}

export async function readMediaDocument(
  dbRead: Db,
  rawKey: string,
): Promise<ReadMediaDocumentResult> {
  const target = parseTargetKey(rawKey);
  if (!target) {
    return {
      kind: "invalid_key",
      message: "Key must be a valid media UUID or external key (e.g. tmdb:tv:95479)",
    };
  }

  const resolved = await resolveExistingMediaByTarget(dbRead, target);
  if (!resolved) {
    return { kind: "not_found" };
  }

  const { media, matchedAssociationIds } = resolved;

  const [externalIdRows, variantRows, associationRows] = await Promise.all([
    dbRead
      .selectFrom("external_ids")
      .select(["namespace", "native_id", "locked"])
      .where("media_id", "=", media.id)
      .orderBy("namespace", "asc")
      .orderBy("native_id", "asc")
      .execute(),
    dbRead
      .selectFrom("variants")
      .select(["id", "media_id", "platform", "description", "is_default"])
      .where("media_id", "=", media.id)
      .orderBy("platform", "asc")
      .orderBy("is_default", "desc")
      .orderBy("created_at", "asc")
      .execute(),
    dbRead
      .selectFrom("associations")
      .select([
        "id",
        "media_id",
        "namespace",
        "native_id",
        "variant_id",
        "status",
        "needs_review",
        "locked",
      ])
      .where("media_id", "=", media.id)
      .where("status", "=", "confirmed")
      .orderBy("namespace", "asc")
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute(),
  ]);

  const associationIds = associationRows.map((row) => row.id);
  const segmentRows =
    associationIds.length > 0
      ? await dbRead
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
          .where("association_id", "in", associationIds)
          .orderBy("season", "asc")
          .orderBy("episode_start", "asc")
          .orderBy("id", "asc")
          .execute()
      : [];

  const segmentsByAssociation = new Map<
    string,
    MediaDocument["associations"][number]["segments"][number][]
  >();
  for (const seg of segmentRows) {
    const list = segmentsByAssociation.get(seg.association_id) ?? [];
    list.push({
      season: seg.season,
      episodeStart: seg.episode_start,
      episodeEnd: seg.episode_end,
      targetEpisodeStart: seg.target_episode_start,
      baseline: seg.baseline,
      ...(seg.non_linear ? { nonLinear: true } : {}),
      ...(seg.needs_review ? { needsReview: true } : {}),
    });
    segmentsByAssociation.set(seg.association_id, list);
  }

  const platformStatuses: Partial<Record<PlatformNamespace, PlatformStatusEntry>> = {};
  for (const platform of PLATFORM_NAMESPACES) {
    const hasConfirmed = associationRows.some((row) => row.namespace === platform);
    platformStatuses[platform] = hasConfirmed ? { status: "associated" } : { status: "unchecked" };
  }

  const document: MediaDocument = {
    media: {
      id: media.id,
      type: media.type,
      baseline: media.baseline,
      snapshot: {
        title: media.title,
        originalTitle: media.original_title,
        year: media.year,
        type: media.type,
        seasons: parseSeasonsSnapshot(media.seasons),
      },
    },
    externalIds: externalIdRows.map((row) => ({
      namespace: row.namespace,
      nativeId: row.native_id,
      ...(row.locked ? { locked: true } : {}),
    })),
    variants: variantRows.map((row) => ({
      id: row.id,
      mediaId: row.media_id,
      namespace: row.platform,
      label: row.description,
      isDefault: Boolean(row.is_default),
    })),
    associations: associationRows.map((row) => ({
      id: row.id,
      mediaId: row.media_id,
      namespace: row.namespace,
      nativeId: row.native_id,
      variantId: row.variant_id,
      status: row.status,
      segments: segmentsByAssociation.get(row.id) ?? [],
      ...(row.needs_review ? { needsReview: true } : {}),
      ...(row.locked ? { locked: true } : {}),
    })),
    matchedAssociationIds,
    platformStatuses,
  };

  return {
    kind: "ok",
    document,
    matchedAssociationId: matchedAssociationIds[0] ?? null,
  };
}
