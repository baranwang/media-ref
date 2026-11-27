import {
  EXTERNAL_ID_NAMESPACES,
  formatExternalKey,
  parseExternalKey,
  type ExternalIdNamespace,
  type NormalizedSegment,
} from "@media-ref/client";
import type {
  AssociationNamespaceRow,
  AssociationStatusRow,
  Database,
  Db,
  ExternalIdSourceRow,
  AssociationsTable,
  ExternalIdNamespaceRow,
  JsonObject,
  StoredSegmentJson,
} from "@media-ref/db";
import { sql, type Selectable, type Transaction } from "kysely";
import {
  isTier2Adapter,
  type AdapterRegistry,
  type CollectionEvidenceResult,
  type CollectionInfo,
} from "./adapters/index.ts";
import {
  evaluateEvidenceGate,
  type CatalogEvidence,
  type EvidenceGateResult,
  type EvidenceGateStep2Evaluator,
} from "./evidence-gate.ts";
import { acquireAdvisoryLock, ADVISORY_LOCK_CLASSES } from "./locks.ts";
import { isUuid, type ChangeRequestRecord } from "./media-service.ts";
import type { OutboundClient } from "./outbound.ts";
import { parseTmdbNativeId } from "./tmdb.ts";
import { REVIEW_ALERT_TYPES } from "./tmdb-sync.ts";

const EXTERNAL_ID_NAMESPACE_SET: ReadonlySet<string> = new Set(EXTERNAL_ID_NAMESPACES);
const MAX_MERGE_HOPS = 10;

export const CONFLICT_REASONS = {
  LOCKED_ASSOCIATION_CHALLENGED: "locked_association_challenged",
  BOTH_PASSED_EVIDENCE_GATE: "both_passed_evidence_gate",
  NEW_FAILED_OLD_PASSED: "new_failed_old_passed",
  BOTH_FAILED_EVIDENCE_GATE: "both_failed_evidence_gate",
  EXISTING_ADAPTER_TIER_1: "existing_adapter_tier_1",
} as const;

export type ConflictMatrixAction = "auto_replace" | "needs_review";

export interface ConflictMatrixDecision {
  action: ConflictMatrixAction;
  newPassed: boolean;
  oldPassed: boolean;
  conflictReason: string | null;
  decisionReason: string;
}

export interface ConflictingAssociationSnapshot {
  id: string;
  mediaId: string;
  namespace: AssociationNamespaceRow;
  nativeId: string;
  variantId: string | null;
  variantDescription: string | null;
  status: AssociationStatusRow;
  locked: boolean;
  segments: NormalizedSegment[];
}

export interface FindConflictingAssociationsInput {
  mediaId: string | null;
  targetExternalKey: string;
  namespace: AssociationNamespaceRow;
  nativeId: string;
  replacesAssociationId?: string | null;
}

export interface EvaluateEvidenceCheckConflictInput {
  changeRequest: ChangeRequestRecord;
  variantDescription?: string | null;
  replacesAssociationId: string | null;
  conflictingAssociations: readonly ConflictingAssociationSnapshot[];
  catalogEvidence: CatalogEvidence;
  newCollectionResult: Exclude<CollectionEvidenceResult, { status: "transient_error" }>;
  adapterRegistry: AdapterRegistry;
  outbound: OutboundClient;
  evaluateStep2?: EvidenceGateStep2Evaluator;
  checkedAt: string;
}

export type ConflictCheckResolution =
  | {
      kind: "retry";
      delayMs?: number;
      errorMessage: string;
    }
  | {
      kind: "locked";
      lockedAssociations: readonly ConflictingAssociationSnapshot[];
      conflictReason: string;
      decisionReason: string;
      evidenceRecord: JsonObject;
    }
  | {
      kind: "auto_replace";
      decisionReason: string;
      evidenceRecord: JsonObject;
      conflictingAssociations: readonly ConflictingAssociationSnapshot[];
    }
  | {
      kind: "needs_review";
      conflictReason: string;
      decisionReason: string;
      evidenceRecord: JsonObject;
    };

export type ConflictResolutionErrorCode =
  | "INVALID_ASSOCIATION_ID"
  | "ASSOCIATION_NOT_FOUND"
  | "INVALID_MEDIA_ID"
  | "MEDIA_NOT_FOUND"
  | "INVALID_NAMESPACE"
  | "INVALID_NATIVE_ID"
  | "EXTERNAL_ID_NOT_FOUND"
  | "EXTERNAL_ID_CONFLICT";

export class ConflictResolutionError extends Error {
  readonly code: ConflictResolutionErrorCode;
  readonly status: number;

  constructor(code: ConflictResolutionErrorCode, status: number, message: string) {
    super(message);
    this.name = "ConflictResolutionError";
    this.code = code;
    this.status = status;
  }
}

export interface AssociationSummaryRecord {
  id: string;
  mediaId: string;
  namespace: AssociationNamespaceRow;
  nativeId: string;
  variantId: string | null;
  status: AssociationStatusRow;
  needsReview: boolean;
  locked: boolean;
  currentRevisionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AssociationRevisionRecord {
  id: string;
  associationId: string;
  revisionNumber: number;
  changeRequestId: string | null;
  variantId: string | null;
  status: AssociationStatusRow;
  segments: NormalizedSegment[];
  actorUserId: string | null;
  submitterUserId: string | null;
  reviewerUserId: string | null;
  reason: string | null;
  createdAt: string;
}

export interface ListAssociationRevisionsOptions {
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface ListAssociationRevisionsResult {
  association: AssociationSummaryRecord;
  revisions: AssociationRevisionRecord[];
  total: number;
}

export interface SetAssociationLockInput {
  associationId: string;
  locked: boolean;
  now?: Date;
}

export interface AssociationLockResult {
  association: AssociationSummaryRecord;
  associationId: string;
  locked: boolean;
}

export interface ExternalIdRecord {
  id: string;
  mediaId: string;
  namespace: ExternalIdNamespace;
  nativeId: string;
  locked: boolean;
  source: ExternalIdSourceRow;
  createdAt: string;
  updatedAt: string;
}

export interface OverrideMediaExternalIdInput {
  mediaId: string;
  namespace: string;
  nativeId: string;
  locked?: boolean;
  now?: Date;
}

export interface SetMediaExternalIdLockInput {
  mediaId: string;
  namespace: string;
  locked: boolean;
  now?: Date;
}

type DbExecutor = Db | Transaction<Database>;

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function parseStoredSegments(raw: unknown): NormalizedSegment[] {
  let entries: StoredSegmentJson[];
  if (Array.isArray(raw)) {
    entries = raw as StoredSegmentJson[];
  } else if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      entries = Array.isArray(parsed) ? (parsed as StoredSegmentJson[]) : [];
    } catch {
      entries = [];
    }
  } else {
    entries = [];
  }

  return entries.map((seg) => ({
    season: seg.season,
    episodeStart: seg.episodeStart,
    episodeEnd: seg.episodeEnd ?? null,
    targetEpisodeStart: seg.targetEpisodeStart,
    baseline: seg.baseline,
    nonLinear: Boolean(seg.nonLinear),
    needsReview: Boolean(seg.needsReview),
  }));
}

function isExternalIdNamespace(value: string): value is ExternalIdNamespace {
  return EXTERNAL_ID_NAMESPACE_SET.has(value);
}

function isPgUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === "23505";
}

function toExternalIdRecord(row: Selectable<AssociationsTable>): ExternalIdRecord {
  return {
    id: row.id,
    mediaId: row.media_id,
    // External ID rows (is_external_id) always carry an authority namespace and a source.
    namespace: row.namespace as ExternalIdNamespaceRow,
    nativeId: row.native_id,
    locked: Boolean(row.locked),
    source: row.source ?? "sync",
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

async function resolveCanonicalMediaId(db: DbExecutor, mediaId: string): Promise<string | null> {
  let currentId = mediaId;
  for (let hop = 0; hop < MAX_MERGE_HOPS; hop += 1) {
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

export async function listAssociationRevisions(
  db: Db,
  associationId: string,
  options: ListAssociationRevisionsOptions = {},
): Promise<ListAssociationRevisionsResult> {
  const trimmedId = associationId.trim();
  if (!isUuid(trimmedId)) {
    throw new ConflictResolutionError(
      "INVALID_ASSOCIATION_ID",
      400,
      "Association ID must be a valid UUID",
    );
  }

  const assocRow = await db
    .selectFrom("associations")
    .where("is_external_id", "=", false)
    .select([
      "id",
      "media_id",
      "namespace",
      "native_id",
      "variant_id",
      "status",
      "needs_review",
      "locked",
      "current_revision_id",
      "created_at",
      "updated_at",
    ])
    .where("id", "=", trimmedId)
    .executeTakeFirst();

  if (!assocRow) {
    throw new ConflictResolutionError(
      "ASSOCIATION_NOT_FOUND",
      404,
      `Association not found: ${trimmedId}`,
    );
  }

  const order = options.order === "desc" ? "desc" : "asc";
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);

  const [revisionRows, countRow] = await Promise.all([
    db
      .selectFrom("association_revisions")
      .leftJoin("change_requests", "change_requests.id", "association_revisions.change_request_id")
      .select([
        "association_revisions.id as id",
        "association_revisions.association_id as association_id",
        "association_revisions.revision_number as revision_number",
        "association_revisions.change_request_id as change_request_id",
        "association_revisions.variant_id as variant_id",
        "association_revisions.status as status",
        "association_revisions.segments as segments",
        "association_revisions.actor_user_id as actor_user_id",
        "association_revisions.reason as reason",
        "association_revisions.created_at as created_at",
        "change_requests.submitter_user_id as submitter_user_id",
        "change_requests.reviewer_user_id as reviewer_user_id",
      ])
      .where("association_revisions.association_id", "=", trimmedId)
      .orderBy("association_revisions.revision_number", order)
      .limit(limit)
      .offset(offset)
      .execute(),
    db
      .selectFrom("association_revisions")
      .select(sql<string>`count(*)`.as("count"))
      .where("association_id", "=", trimmedId)
      .executeTakeFirstOrThrow(),
  ]);

  const association: AssociationSummaryRecord = {
    id: assocRow.id,
    mediaId: assocRow.media_id,
    namespace: assocRow.namespace,
    nativeId: assocRow.native_id,
    variantId: assocRow.variant_id,
    status: assocRow.status,
    needsReview: Boolean(assocRow.needs_review),
    locked: Boolean(assocRow.locked),
    currentRevisionId: assocRow.current_revision_id,
    createdAt: toIsoString(assocRow.created_at),
    updatedAt: toIsoString(assocRow.updated_at),
  };

  const revisions: AssociationRevisionRecord[] = revisionRows.map((row) => ({
    id: row.id,
    associationId: row.association_id,
    revisionNumber: row.revision_number,
    changeRequestId: row.change_request_id,
    variantId: row.variant_id,
    status: row.status,
    segments: parseStoredSegments(row.segments),
    actorUserId: row.actor_user_id,
    submitterUserId: row.submitter_user_id ?? null,
    reviewerUserId: row.reviewer_user_id ?? null,
    reason: row.reason,
    createdAt: toIsoString(row.created_at),
  }));

  return {
    association,
    revisions,
    total: Number(countRow.count),
  };
}

export async function setAssociationLock(
  dbWrite: Db,
  input: SetAssociationLockInput,
): Promise<AssociationLockResult> {
  const trimmedId = input.associationId.trim();
  if (!isUuid(trimmedId)) {
    throw new ConflictResolutionError(
      "INVALID_ASSOCIATION_ID",
      400,
      "Association ID must be a valid UUID",
    );
  }

  const now = input.now ?? new Date();

  const updated = await dbWrite
    .updateTable("associations")
    .set({
      locked: input.locked,
      updated_at: now,
    })
    .where("id", "=", trimmedId)
    .returning([
      "id",
      "media_id",
      "namespace",
      "native_id",
      "variant_id",
      "status",
      "needs_review",
      "locked",
      "current_revision_id",
      "created_at",
      "updated_at",
    ])
    .executeTakeFirst();

  if (!updated) {
    throw new ConflictResolutionError(
      "ASSOCIATION_NOT_FOUND",
      404,
      `Association not found: ${trimmedId}`,
    );
  }

  const association: AssociationSummaryRecord = {
    id: updated.id,
    mediaId: updated.media_id,
    namespace: updated.namespace,
    nativeId: updated.native_id,
    variantId: updated.variant_id,
    status: updated.status,
    needsReview: Boolean(updated.needs_review),
    locked: Boolean(updated.locked),
    currentRevisionId: updated.current_revision_id,
    createdAt: toIsoString(updated.created_at),
    updatedAt: toIsoString(updated.updated_at),
  };

  return {
    association,
    associationId: association.id,
    locked: association.locked,
  };
}

export async function overrideMediaExternalId(
  dbWrite: Db,
  input: OverrideMediaExternalIdInput,
): Promise<ExternalIdRecord> {
  const trimmedMediaId = input.mediaId.trim();
  if (!isUuid(trimmedMediaId)) {
    throw new ConflictResolutionError("INVALID_MEDIA_ID", 400, "mediaId must be a valid UUID");
  }

  const rawNamespace = input.namespace.trim();
  if (!isExternalIdNamespace(rawNamespace)) {
    throw new ConflictResolutionError(
      "INVALID_NAMESPACE",
      400,
      `External ID namespace must be one of: ${EXTERNAL_ID_NAMESPACES.join(", ")}`,
    );
  }
  const namespace: ExternalIdNamespace = rawNamespace;

  const nativeId = input.nativeId.trim();
  if (nativeId.length === 0 || /\s/.test(nativeId)) {
    throw new ConflictResolutionError(
      "INVALID_NATIVE_ID",
      400,
      "nativeId must be a non-empty string without whitespace",
    );
  }

  if (namespace === "tmdb" && !parseTmdbNativeId(nativeId)) {
    throw new ConflictResolutionError(
      "INVALID_NATIVE_ID",
      400,
      "TMDB external ID must have format movie:<id> or tv:<id>",
    );
  }

  const locked = input.locked ?? true;
  const now = input.now ?? new Date();

  try {
    return await dbWrite.transaction().execute(async (trx) => {
      const canonicalMediaId = await resolveCanonicalMediaId(trx, trimmedMediaId);
      if (!canonicalMediaId) {
        throw new ConflictResolutionError(
          "MEDIA_NOT_FOUND",
          404,
          `Media not found: ${trimmedMediaId}`,
        );
      }

      await acquireAdvisoryLock(
        trx,
        ADVISORY_LOCK_CLASSES.EXTERNAL_ID_MEDIA,
        `${canonicalMediaId}:${namespace}`,
      );
      await acquireAdvisoryLock(
        trx,
        ADVISORY_LOCK_CLASSES.EXTERNAL_ID_KEY,
        `${namespace}:${nativeId}`,
      );

      const claimedByOther = await trx
        .selectFrom("associations")
        .where("is_external_id", "=", true)
        .select(["id", "media_id"])
        .where("namespace", "=", namespace)
        .where("native_id", "=", nativeId)
        .where("media_id", "!=", canonicalMediaId)
        .executeTakeFirst();

      if (claimedByOther) {
        throw new ConflictResolutionError(
          "EXTERNAL_ID_CONFLICT",
          409,
          `External ID ${namespace}:${nativeId} is already assigned to another media`,
        );
      }

      const existing = await trx
        .selectFrom("associations")
        .where("is_external_id", "=", true)
        .select("id")
        .where("media_id", "=", canonicalMediaId)
        .where("namespace", "=", namespace)
        .executeTakeFirst();

      if (existing) {
        const updated = await trx
          .updateTable("associations")
          .where("is_external_id", "=", true)
          .set({
            native_id: nativeId,
            source: "reviewer",
            locked,
            updated_at: now,
          })
          .where("id", "=", existing.id)
          .returningAll()
          .executeTakeFirstOrThrow();

        return toExternalIdRecord(updated);
      }

      const inserted = await trx
        .insertInto("associations")
        .values({
          status: "confirmed",
          is_external_id: true,
          media_id: canonicalMediaId,
          namespace,
          native_id: nativeId,
          source: "reviewer",
          locked,
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      return toExternalIdRecord(inserted);
    });
  } catch (error) {
    if (error instanceof ConflictResolutionError) {
      throw error;
    }
    if (isPgUniqueViolation(error)) {
      throw new ConflictResolutionError(
        "EXTERNAL_ID_CONFLICT",
        409,
        `External ID ${namespace}:${nativeId} conflicts with an existing external ID`,
      );
    }
    throw error;
  }
}

export async function setMediaExternalIdLock(
  dbWrite: Db,
  input: SetMediaExternalIdLockInput,
): Promise<ExternalIdRecord> {
  const trimmedMediaId = input.mediaId.trim();
  if (!isUuid(trimmedMediaId)) {
    throw new ConflictResolutionError("INVALID_MEDIA_ID", 400, "mediaId must be a valid UUID");
  }

  const rawNamespace = input.namespace.trim();
  if (!isExternalIdNamespace(rawNamespace)) {
    throw new ConflictResolutionError(
      "INVALID_NAMESPACE",
      400,
      `External ID namespace must be one of: ${EXTERNAL_ID_NAMESPACES.join(", ")}`,
    );
  }
  const namespace: ExternalIdNamespace = rawNamespace;
  const now = input.now ?? new Date();

  const canonicalMediaId = await resolveCanonicalMediaId(dbWrite, trimmedMediaId);
  if (!canonicalMediaId) {
    throw new ConflictResolutionError("MEDIA_NOT_FOUND", 404, `Media not found: ${trimmedMediaId}`);
  }

  const updated = await dbWrite
    .updateTable("associations")
    .where("is_external_id", "=", true)
    .set({
      locked: input.locked,
      updated_at: now,
    })
    .where("media_id", "=", canonicalMediaId)
    .where("namespace", "=", namespace)
    .returningAll()
    .executeTakeFirst();

  if (!updated) {
    throw new ConflictResolutionError(
      "EXTERNAL_ID_NOT_FOUND",
      404,
      `External ID "${namespace}" not found for media ${canonicalMediaId}`,
    );
  }

  return toExternalIdRecord(updated);
}

export function evaluateConflictMatrix(
  newPassed: boolean,
  oldPassed: boolean,
): ConflictMatrixDecision {
  if (newPassed && !oldPassed) {
    return {
      action: "auto_replace",
      newPassed,
      oldPassed,
      conflictReason: null,
      decisionReason: "conflict_auto_replaced",
    };
  }
  if (newPassed && oldPassed) {
    return {
      action: "needs_review",
      newPassed,
      oldPassed,
      conflictReason: CONFLICT_REASONS.BOTH_PASSED_EVIDENCE_GATE,
      decisionReason:
        "Both new submission and existing confirmed association passed the evidence gate",
    };
  }
  if (!newPassed && oldPassed) {
    return {
      action: "needs_review",
      newPassed,
      oldPassed,
      conflictReason: CONFLICT_REASONS.NEW_FAILED_OLD_PASSED,
      decisionReason:
        "New submission failed the evidence gate while existing confirmed association passed",
    };
  }
  return {
    action: "needs_review",
    newPassed,
    oldPassed,
    conflictReason: CONFLICT_REASONS.BOTH_FAILED_EVIDENCE_GATE,
    decisionReason:
      "Both new submission and existing confirmed association failed the evidence gate",
  };
}

/**
 * Another approved change request whose association for the same collection and media is live,
 * or null. A rejected request is often resubmitted (by exploration, or after a fix) and goes live
 * that way; its page should say so rather than read as "this mapping is not in MediaRef".
 */
export async function findLiveChangeRequestForSameCollection(
  db: DbExecutor,
  cr: {
    id: string;
    namespace: AssociationNamespaceRow;
    nativeId: string;
    mediaId: string | null;
    targetExternalKey: string;
  },
): Promise<string | null> {
  const mediaId = await resolveMediaIdForChangeRequest(db, cr.mediaId, cr.targetExternalKey);
  if (!mediaId) {
    return null;
  }
  const row = await db
    .selectFrom("change_requests as cr")
    .innerJoin("associations as a", "a.id", "cr.applied_association_id")
    .select("cr.id")
    .where("cr.status", "=", "approved")
    .where("cr.id", "!=", cr.id)
    .where("a.status", "=", "confirmed")
    .where("a.media_id", "=", mediaId)
    .where("a.namespace", "=", cr.namespace)
    .where("a.native_id", "=", cr.nativeId)
    .orderBy("cr.reviewed_at", "desc")
    .executeTakeFirst();
  return row?.id ?? null;
}

async function resolveMediaIdForChangeRequest(
  db: DbExecutor,
  mediaId: string | null,
  targetExternalKey: string,
): Promise<string | null> {
  if (mediaId) {
    return resolveCanonicalMediaId(db, mediaId);
  }

  const trimmed = targetExternalKey.trim();
  if (isUuid(trimmed)) {
    return resolveCanonicalMediaId(db, trimmed);
  }
  if (trimmed.startsWith("media:")) {
    const candidate = trimmed.slice("media:".length);
    return isUuid(candidate) ? resolveCanonicalMediaId(db, candidate) : null;
  }

  const parsed = parseExternalKey(trimmed);
  if (!parsed) {
    return null;
  }

  const canonical = formatExternalKey(parsed);
  const colonIdx = canonical.indexOf(":");
  if (colonIdx <= 0) {
    return null;
  }
  const ns = parsed.namespace;
  const nativeId = parsed.nativeId;

  if (isExternalIdNamespace(ns)) {
    const ext = await db
      .selectFrom("associations")
      .where("is_external_id", "=", true)
      .select("media_id")
      .where("namespace", "=", ns)
      .where("native_id", "=", nativeId)
      .executeTakeFirst();
    return ext ? resolveCanonicalMediaId(db, ext.media_id) : null;
  }

  return null;
}

export async function findConflictingAssociations(
  db: DbExecutor,
  input: FindConflictingAssociationsInput,
): Promise<ConflictingAssociationSnapshot[]> {
  const mediaId = await resolveMediaIdForChangeRequest(db, input.mediaId, input.targetExternalKey);
  if (!mediaId) {
    return [];
  }

  const matchedRows: Array<{
    id: string;
    media_id: string;
    namespace: AssociationNamespaceRow;
    native_id: string;
    variant_id: string | null;
    status: AssociationStatusRow;
    locked: boolean;
  }> = [];
  const seenIds = new Set<string>();

  if (input.replacesAssociationId && isUuid(input.replacesAssociationId)) {
    const replacedRow = await db
      .selectFrom("associations")
      .where("is_external_id", "=", false)
      .select(["id", "media_id", "namespace", "native_id", "variant_id", "status", "locked"])
      .where("id", "=", input.replacesAssociationId)
      .where("media_id", "=", mediaId)
      .executeTakeFirst();

    if (replacedRow && (replacedRow.status === "confirmed" || replacedRow.locked)) {
      seenIds.add(replacedRow.id);
      matchedRows.push(replacedRow);
    }
  }

  const sameCollectionRow = await db
    .selectFrom("associations")
    .where("is_external_id", "=", false)
    .select(["id", "media_id", "namespace", "native_id", "variant_id", "status", "locked"])
    .where("media_id", "=", mediaId)
    .where("namespace", "=", input.namespace)
    .where("native_id", "=", input.nativeId)
    .executeTakeFirst();

  if (
    sameCollectionRow &&
    !seenIds.has(sameCollectionRow.id) &&
    (sameCollectionRow.status === "confirmed" || sameCollectionRow.locked)
  ) {
    seenIds.add(sameCollectionRow.id);
    matchedRows.push(sameCollectionRow);
  }

  if (matchedRows.length === 0) {
    return [];
  }

  const assocIds = matchedRows.map((row) => row.id);
  const variantIds = [
    ...new Set(matchedRows.map((row) => row.variant_id).filter((id): id is string => id !== null)),
  ];

  const [segmentRows, variantRows] = await Promise.all([
    db
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
      .execute(),
    variantIds.length > 0
      ? db
          .selectFrom("variants")
          .select(["id", "description"])
          .where("id", "in", variantIds)
          .execute()
      : Promise.resolve([]),
  ]);

  const segmentsByAssoc = new Map<string, NormalizedSegment[]>();
  for (const seg of segmentRows) {
    const list = segmentsByAssoc.get(seg.association_id) ?? [];
    list.push({
      season: seg.season,
      episodeStart: seg.episode_start,
      episodeEnd: seg.episode_end,
      targetEpisodeStart: seg.target_episode_start,
      baseline: seg.baseline,
      nonLinear: Boolean(seg.non_linear),
      needsReview: Boolean(seg.needs_review),
    });
    segmentsByAssoc.set(seg.association_id, list);
  }

  const variantDescriptionById = new Map(variantRows.map((v) => [v.id, v.description]));

  return matchedRows.map((row) => ({
    id: row.id,
    mediaId: row.media_id,
    namespace: row.namespace,
    nativeId: row.native_id,
    variantId: row.variant_id,
    variantDescription: row.variant_id
      ? (variantDescriptionById.get(row.variant_id) ?? null)
      : null,
    status: row.status,
    locked: Boolean(row.locked),
    segments: segmentsByAssoc.get(row.id) ?? [],
  }));
}

export async function recordLockedAssociationAlertInTx(
  trx: Transaction<Database>,
  input: {
    mediaId: string;
    associationId: string;
    changeRequestId: string;
    namespace: AssociationNamespaceRow;
    nativeId: string;
    existingNativeId: string;
    detectedAt: string;
  },
): Promise<{ id: string }> {
  const inserted = await trx
    .insertInto("review_alerts")
    .values({
      alert_type: REVIEW_ALERT_TYPES.LOCKED_ASSOCIATION_CHALLENGED,
      media_id: input.mediaId,
      association_id: input.associationId,
      status: "open",
      details: JSON.stringify({
        changeRequestId: input.changeRequestId,
        namespace: input.namespace,
        nativeId: input.nativeId,
        existingNativeId: input.existingNativeId,
        detectedAt: input.detectedAt,
      }),
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  return { id: inserted.id };
}

function summarizeCatalogEvidence(catalog: CatalogEvidence): JsonObject {
  return {
    namespace: catalog.namespace,
    canonicalId: catalog.canonicalId,
    mediaType: catalog.mediaType,
    title: catalog.title,
    originalTitle: catalog.originalTitle ?? null,
    year: catalog.year,
    seasons: catalog.seasons,
    externalIds: catalog.externalIds,
  };
}

function summarizeCollectionInfo(info: CollectionInfo): JsonObject {
  return {
    namespace: info.namespace,
    canonicalId: info.canonicalId,
    title: info.title,
    originalTitle: info.originalTitle ?? null,
    aliases: info.aliases ?? [],
    year: info.year,
    mediaType: info.mediaType,
    featureEpisodeCount: info.featureEpisodeCount,
    externalIds: info.externalIds ?? {},
  };
}

function summarizeGateResult(gate: EvidenceGateResult): JsonObject {
  return {
    decision: gate.decision,
    step1: gate.step1,
    step2: gate.step2,
    conflicts: gate.conflicts,
    reasons: gate.reasons,
  };
}

function canAutoMergeSameUnlockedCollection(
  input: EvaluateEvidenceCheckConflictInput,
  existing: ConflictingAssociationSnapshot,
  effectiveVariantDescription: string | null | undefined,
): boolean {
  if (
    input.replacesAssociationId ||
    input.conflictingAssociations.length !== 1 ||
    existing.locked
  ) {
    return false;
  }
  const cr = input.changeRequest;
  if (existing.namespace !== cr.namespace || existing.nativeId !== cr.nativeId) {
    return false;
  }
  const normVariant = (val: string | null | undefined) => (val ?? "原声").trim();
  if (
    existing.variantDescription !== null &&
    normVariant(existing.variantDescription) !== normVariant(effectiveVariantDescription)
  ) {
    return false;
  }

  const existingSegs = existing.segments;
  const incomingSegs = cr.segments;
  if (existingSegs.length === incomingSegs.length) {
    const sortedExisting = [...existingSegs].sort(
      (a, b) =>
        a.season - b.season ||
        a.episodeStart - b.episodeStart ||
        a.targetEpisodeStart - b.targetEpisodeStart,
    );
    const sortedIncoming = [...incomingSegs].sort(
      (a, b) =>
        a.season - b.season ||
        a.episodeStart - b.episodeStart ||
        a.targetEpisodeStart - b.targetEpisodeStart,
    );
    const identical = sortedExisting.every((s, idx) => {
      const inc = sortedIncoming[idx]!;
      return (
        s.season === inc.season &&
        s.episodeStart === inc.episodeStart &&
        s.episodeEnd === inc.episodeEnd &&
        s.targetEpisodeStart === inc.targetEpisodeStart
      );
    });
    if (identical) {
      return true;
    }
  }

  // Non-overlapping season addition on the same collection (merged by `mergeApprovedSegments`).
  if (existingSegs.length > 0 && incomingSegs.length > 0) {
    const existingSeasons = new Set(existingSegs.map((s) => s.season));
    if (incomingSegs.some((s) => existingSeasons.has(s.season))) {
      return false;
    }
    const seasons = input.catalogEvidence.seasons;
    const positionRange = (s: NormalizedSegment): [number, number] => {
      const end = s.episodeEnd ?? seasons.find((x) => x.season === s.season)?.episodeCount;
      return [s.targetEpisodeStart, end ? s.targetEpisodeStart + end - s.episodeStart : Infinity];
    };
    const existingRanges = existingSegs.map(positionRange);
    const incomingRanges = incomingSegs.map(positionRange);
    return incomingRanges.every(([ia, ib]) =>
      existingRanges.every(([ea, eb]) => eb < ia || ib < ea),
    );
  }

  return false;
}

export async function evaluateEvidenceCheckConflict(
  input: EvaluateEvidenceCheckConflictInput,
): Promise<ConflictCheckResolution> {
  const {
    changeRequest,
    variantDescription,
    replacesAssociationId,
    conflictingAssociations,
    catalogEvidence,
    newCollectionResult,
    adapterRegistry,
    outbound,
    evaluateStep2,
    checkedAt,
  } = input;

  const effectiveVariantDescription =
    variantDescription !== undefined ? variantDescription : changeRequest.variantDescription;
  const catalogSummary = summarizeCatalogEvidence(catalogEvidence);

  // 1. Evaluate incoming submission evidence
  let newPassed = false;
  let newCollectionSummary: JsonObject | null = null;
  let newGateSummary: JsonObject | null = null;
  let newEvidence: JsonObject;

  if (newCollectionResult.status === "not_found") {
    newPassed = false;
    newEvidence = {
      namespace: changeRequest.namespace,
      nativeId: changeRequest.nativeId,
      collectionStatus: "not_found",
      collectionReason: newCollectionResult.reason ?? null,
      passed: false,
      gate: null,
    };
  } else {
    const newGate = evaluateEvidenceGate({
      catalog: catalogEvidence,
      collection: newCollectionResult.info,
      segments: changeRequest.segments,
      setDefaultVariant: changeRequest.setDefaultVariant,
      variantDescription: effectiveVariantDescription,
      evaluateStep2,
    });
    newPassed = newGate.decision === "pass";
    newCollectionSummary = summarizeCollectionInfo(newCollectionResult.info);
    newGateSummary = summarizeGateResult(newGate);
    newEvidence = {
      namespace: changeRequest.namespace,
      nativeId: changeRequest.nativeId,
      collectionStatus: "found",
      passed: newPassed,
      collection: newCollectionSummary,
      gate: newGateSummary,
    };
  }

  // 2. If any conflicting association is locked, NEVER auto-modify — route to needs_review + alert
  const lockedAssociations = conflictingAssociations.filter((assoc) => assoc.locked);
  if (lockedAssociations.length > 0) {
    const primaryLocked = lockedAssociations[0]!;
    let existingEvidence: JsonObject = {
      associationId: primaryLocked.id,
      namespace: primaryLocked.namespace,
      nativeId: primaryLocked.nativeId,
      locked: true,
      collectionStatus: "skipped_locked",
      passed: null,
    };

    const lockedAdapter = adapterRegistry.get(primaryLocked.namespace);
    if (lockedAdapter && isTier2Adapter(lockedAdapter)) {
      const lockedFetch: CollectionEvidenceResult =
        primaryLocked.namespace === changeRequest.namespace &&
        primaryLocked.nativeId === changeRequest.nativeId
          ? newCollectionResult
          : await lockedAdapter.fetchCollection(primaryLocked.nativeId, outbound);

      if (lockedFetch.status === "found") {
        const oldGate = evaluateEvidenceGate({
          catalog: catalogEvidence,
          collection: lockedFetch.info,
          segments: primaryLocked.segments,
          setDefaultVariant: false,
          variantDescription: primaryLocked.variantDescription,
          evaluateStep2,
        });
        existingEvidence = {
          associationId: primaryLocked.id,
          namespace: primaryLocked.namespace,
          nativeId: primaryLocked.nativeId,
          locked: true,
          collectionStatus: "found",
          passed: oldGate.decision === "pass",
          collection: summarizeCollectionInfo(lockedFetch.info),
          gate: summarizeGateResult(oldGate),
        };
      } else if (lockedFetch.status === "not_found") {
        existingEvidence = {
          associationId: primaryLocked.id,
          namespace: primaryLocked.namespace,
          nativeId: primaryLocked.nativeId,
          locked: true,
          collectionStatus: "not_found",
          collectionReason: lockedFetch.reason ?? null,
          passed: false,
          gate: null,
        };
      } else {
        existingEvidence = {
          associationId: primaryLocked.id,
          namespace: primaryLocked.namespace,
          nativeId: primaryLocked.nativeId,
          locked: true,
          collectionStatus: "transient_error",
          errorReason: lockedFetch.reason,
          passed: null,
        };
      }
    }

    const evidenceRecord: JsonObject = {
      checkedAt,
      ...(replacesAssociationId ? { replacesAssociationId } : {}),
      catalog: catalogSummary,
      ...(newCollectionSummary ? { collection: newCollectionSummary } : {}),
      ...(newGateSummary ? { gate: newGateSummary } : {}),
      conflict: {
        existingAssociationId: primaryLocked.id,
        existingNamespace: primaryLocked.namespace,
        existingNativeId: primaryLocked.nativeId,
        existingLocked: true,
        newPassed,
        oldPassed: existingEvidence.passed ?? null,
        outcome: "locked",
      },
      newEvidence,
      existingEvidence,
    };

    return {
      kind: "locked",
      lockedAssociations,
      conflictReason: CONFLICT_REASONS.LOCKED_ASSOCIATION_CHALLENGED,
      decisionReason: `Challenged locked association ${primaryLocked.namespace}:${primaryLocked.nativeId}; manual reviewer action required`,
      evidenceRecord,
    };
  }

  // 3. Re-fetch & evaluate fresh evidence for every conflicting unlocked association
  const existingEvidences: Array<{
    association: ConflictingAssociationSnapshot;
    passed: boolean;
    evidence: JsonObject;
  }> = [];

  for (const existing of conflictingAssociations) {
    const existingAdapter = adapterRegistry.get(existing.namespace);
    if (!existingAdapter || !isTier2Adapter(existingAdapter)) {
      const evidenceRecord: JsonObject = {
        checkedAt,
        ...(replacesAssociationId ? { replacesAssociationId } : {}),
        catalog: catalogSummary,
        ...(newCollectionSummary ? { collection: newCollectionSummary } : {}),
        ...(newGateSummary ? { gate: newGateSummary } : {}),
        conflict: {
          existingAssociationId: existing.id,
          existingNamespace: existing.namespace,
          existingNativeId: existing.nativeId,
          existingLocked: false,
          newPassed,
          oldPassed: null,
          outcome: "needs_review",
        },
        newEvidence,
        existingEvidence: {
          associationId: existing.id,
          namespace: existing.namespace,
          nativeId: existing.nativeId,
          adapterTier: existingAdapter?.tier ?? null,
          passed: null,
        },
      };

      return {
        kind: "needs_review",
        conflictReason: CONFLICT_REASONS.EXISTING_ADAPTER_TIER_1,
        decisionReason: `Cannot re-verify existing ${existing.namespace}:${existing.nativeId} without a Tier 2+ adapter`,
        evidenceRecord,
      };
    }

    const existingCollectionResult: CollectionEvidenceResult =
      existing.namespace === changeRequest.namespace && existing.nativeId === changeRequest.nativeId
        ? newCollectionResult
        : await existingAdapter.fetchCollection(existing.nativeId, outbound);

    // CRITICAL: transient timeout/5xx on the existing association is NEVER treated as "old failed"!
    if (existingCollectionResult.status === "transient_error") {
      return {
        kind: "retry",
        ...(existingCollectionResult.retryAfterMs !== undefined
          ? { delayMs: existingCollectionResult.retryAfterMs }
          : {}),
        errorMessage: existingCollectionResult.reason,
      };
    }

    if (existingCollectionResult.status === "not_found") {
      existingEvidences.push({
        association: existing,
        passed: false,
        evidence: {
          associationId: existing.id,
          namespace: existing.namespace,
          nativeId: existing.nativeId,
          locked: false,
          collectionStatus: "not_found",
          collectionReason: existingCollectionResult.reason ?? null,
          passed: false,
          gate: null,
        },
      });
    } else {
      const oldGate = evaluateEvidenceGate({
        catalog: catalogEvidence,
        collection: existingCollectionResult.info,
        segments: existing.segments,
        setDefaultVariant: false,
        variantDescription: existing.variantDescription,
        evaluateStep2,
      });
      const oldPassed = oldGate.decision === "pass";
      existingEvidences.push({
        association: existing,
        passed: oldPassed,
        evidence: {
          associationId: existing.id,
          namespace: existing.namespace,
          nativeId: existing.nativeId,
          locked: false,
          collectionStatus: "found",
          passed: oldPassed,
          collection: summarizeCollectionInfo(existingCollectionResult.info),
          gate: summarizeGateResult(oldGate),
        },
      });
    }
  }

  // 4. Evaluate 4-way conflict matrix: ONLY (newPassed=true, oldPassed=false) auto-replaces,
  // unless an unlocked same-collection submission idempotently matches or cleanly extends seasons.
  const anyOldPassed = existingEvidences.some((entry) => entry.passed);
  const primary = conflictingAssociations[0]!;
  const sameCollectionAutoMerge =
    newPassed &&
    anyOldPassed &&
    canAutoMergeSameUnlockedCollection(input, primary, effectiveVariantDescription);
  const matrix = sameCollectionAutoMerge
    ? {
        action: "auto_replace" as const,
        newPassed: true,
        oldPassed: true,
        conflictReason: null,
        decisionReason:
          "Approved automatically: matches or cleanly extends existing unlocked collection",
      }
    : evaluateConflictMatrix(newPassed, anyOldPassed);

  const evidenceRecord: JsonObject = {
    checkedAt,
    ...(replacesAssociationId ? { replacesAssociationId } : {}),
    catalog: catalogSummary,
    ...(newCollectionSummary ? { collection: newCollectionSummary } : {}),
    ...(newGateSummary ? { gate: newGateSummary } : {}),
    conflict: {
      existingAssociationId: primary.id,
      existingNamespace: primary.namespace,
      existingNativeId: primary.nativeId,
      existingLocked: false,
      newPassed: matrix.newPassed,
      oldPassed: matrix.oldPassed,
      outcome: matrix.action,
    },
    newEvidence,
    existingEvidence:
      existingEvidences.length === 1
        ? existingEvidences[0]!.evidence
        : { items: existingEvidences.map((entry) => entry.evidence) },
  };

  if (matrix.action === "auto_replace") {
    return {
      kind: "auto_replace",
      decisionReason: matrix.decisionReason,
      evidenceRecord,
      conflictingAssociations,
    };
  }

  return {
    kind: "needs_review",
    conflictReason: matrix.conflictReason!,
    decisionReason: matrix.decisionReason,
    evidenceRecord,
  };
}
