import {
  BASELINE_PRIORITY,
  EXTERNAL_ID_NAMESPACES,
  getNamespaceCapabilities,
  isCatalogNamespace,
  validateVariantSegments,
  type BaselineSource,
  type ExternalIdNamespace,
  type MediaType,
  type NormalizedSegment,
  type SeasonSnapshot,
} from "@media-ref/client";
import type {
  AssociationNamespaceRow,
  AssociationStatusRow,
  Database,
  SeasonSnapshotRow,
} from "@media-ref/db";
import type { Transaction } from "kysely";
import { normalizeTitleForComparison } from "./evidence-gate.ts";
import { acquireAdvisoryLock, ADVISORY_LOCK_CLASSES } from "./locks.ts";

type DbExecutor = Transaction<Database>;

const TITLE_YEAR_SUFFIX_REGEX = /(?:\s*[([（【](?:19|20)\d{2}[)\]）】])+\s*$/u;
const TITLE_SEASON_SUFFIX_REGEX =
  /(?:\s*(?:第[一二三四五六七八九十\d]+[季部]|Season\s+\d+|Series\s+\d+|Part\s+\d+|S0?\d{1,2}))+\s*$/iu;

export interface MergeCandidateAssociation {
  id: string;
  namespace: AssociationNamespaceRow;
  nativeId: string;
  variantId: string | null;
  status: AssociationStatusRow;
  locked: boolean;
  segments: NormalizedSegment[];
}

export interface MergeCandidateExternalId {
  id: string;
  namespace: ExternalIdNamespace;
  nativeId: string;
  locked: boolean;
}

export interface MergeCandidateMediaSnapshot {
  id: string;
  type: MediaType;
  baseline: BaselineSource | null;
  title: string;
  originalTitle: string | null;
  year: number | null;
  seasons: SeasonSnapshot[];
  mergedIntoMediaId: string | null;
  createdAt: Date;
  externalIds: MergeCandidateExternalId[];
  associations: MergeCandidateAssociation[];
}

export interface AutoMergeCompatibilityOptions {
  extraTitlesA?: readonly (string | null | undefined)[];
  extraTitlesB?: readonly (string | null | undefined)[];
}

export type AutoMergeCompatibilityResult =
  | { compatible: true }
  | { compatible: false; reason: string };

export interface VerifyAutoMergeEligibilityInput {
  mediaIdA: string;
  mediaIdB: string;
  extraTitlesByMediaId?: ReadonlyMap<string, readonly (string | null | undefined)[]>;
  /** Set false when caller already acquired `MEDIA_MERGE` locks in sorted order. */
  acquireMergeLocks?: boolean;
}

export type AutoMergeEligibilityResult =
  | {
      eligible: true;
      sourceMediaId: string;
      targetMediaId: string;
      source: MergeCandidateMediaSnapshot;
      target: MergeCandidateMediaSnapshot;
      matchingExternalIds: Array<{ namespace: ExternalIdNamespace; nativeId: string }>;
      sharedCollections: Array<{ namespace: AssociationNamespaceRow; nativeId: string }>;
    }
  | {
      eligible: false;
      blockReason: string;
      sourceMediaId?: string;
      targetMediaId?: string;
      details: Record<string, unknown>;
    };

function toDate(value: unknown): Date {
  if (value instanceof Date) {
    return value;
  }
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

export function parseMediaSeasonsJson(raw: unknown): SeasonSnapshot[] {
  let arr: unknown[] = [];
  if (Array.isArray(raw)) {
    arr = raw;
  } else if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        arr = parsed;
      }
    } catch {
      return [];
    }
  }

  const seasons: SeasonSnapshot[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const row = item as Partial<SeasonSnapshotRow>;
    if (typeof row.season === "number" && typeof row.episodeCount === "number") {
      seasons.push({
        season: row.season,
        episodeCount: row.episodeCount,
        airYear: row.airYear ?? null,
      });
    }
  }
  return seasons;
}

function collectExpandedNormalizedTitles(
  titles: readonly (string | null | undefined)[],
): Set<string> {
  const result = new Set<string>();
  for (const raw of titles) {
    if (!raw) {
      continue;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    const variants = [
      trimmed,
      trimmed.replace(TITLE_YEAR_SUFFIX_REGEX, "").trim(),
      trimmed.replace(TITLE_SEASON_SUFFIX_REGEX, "").trim(),
      trimmed.replace(TITLE_YEAR_SUFFIX_REGEX, "").replace(TITLE_SEASON_SUFFIX_REGEX, "").trim(),
    ];
    for (const v of variants) {
      const normalized = normalizeTitleForComparison(v);
      if (normalized) {
        result.add(normalized);
      }
    }
  }
  return result;
}

function collectRepresentativeYears(
  year: number | null,
  seasons: readonly SeasonSnapshot[],
): number[] {
  const years = new Set<number>();
  if (year !== null) {
    years.add(year);
  }
  for (const s of seasons) {
    if (s.airYear !== null && s.airYear !== undefined) {
      years.add(s.airYear);
    }
  }
  return [...years];
}

function areYearsCompatible(
  a: Pick<MergeCandidateMediaSnapshot, "year" | "seasons">,
  b: Pick<MergeCandidateMediaSnapshot, "year" | "seasons">,
): boolean {
  const yearsA = collectRepresentativeYears(a.year, a.seasons);
  const yearsB = collectRepresentativeYears(b.year, b.seasons);
  if (yearsA.length === 0 || yearsB.length === 0) {
    return true;
  }
  for (const ya of yearsA) {
    for (const yb of yearsB) {
      if (Math.abs(ya - yb) <= 1) {
        return true;
      }
    }
  }
  return false;
}

/** Checks type, year (±1 including season air years), and normalized title overlap. */
export function areMediaSnapshotsCompatibleForAutoMerge(
  a: Pick<MergeCandidateMediaSnapshot, "type" | "title" | "originalTitle" | "year" | "seasons">,
  b: Pick<MergeCandidateMediaSnapshot, "type" | "title" | "originalTitle" | "year" | "seasons">,
  options: AutoMergeCompatibilityOptions = {},
): AutoMergeCompatibilityResult {
  if (a.type !== b.type) {
    return { compatible: false, reason: "type_mismatch" };
  }

  if (!areYearsCompatible(a, b)) {
    return { compatible: false, reason: "year_mismatch" };
  }

  const titlesA = collectExpandedNormalizedTitles([
    a.title,
    a.originalTitle,
    ...(options.extraTitlesA ?? []),
  ]);
  const titlesB = collectExpandedNormalizedTitles([
    b.title,
    b.originalTitle,
    ...(options.extraTitlesB ?? []),
  ]);

  if (titlesA.size === 0 || titlesB.size === 0) {
    return { compatible: false, reason: "missing_titles" };
  }

  for (const norm of titlesA) {
    if (titlesB.has(norm)) {
      return { compatible: true };
    }
  }

  return { compatible: false, reason: "title_mismatch" };
}

/**
 * Verifies whether a fetched catalog target independently describes `snap` (matching `type`,
 * year within ±1, non-conflicting external IDs, and either title/alias overlap or matching
 * authoritative external ID). Used to keep alias enrichment attributable per media.
 */
export function doesCatalogTargetMatchMediaSnapshot(
  snap: Pick<
    MergeCandidateMediaSnapshot,
    "type" | "title" | "originalTitle" | "year" | "seasons" | "externalIds"
  >,
  ownExtraTitles: readonly (string | null | undefined)[],
  catalogTarget: {
    type: MediaType;
    snapshot: {
      title: string;
      originalTitle: string | null;
      year: number | null;
      seasons: readonly SeasonSnapshot[];
    };
    externalIds?: Partial<Record<ExternalIdNamespace, string>>;
    aliases?: readonly (string | null | undefined)[];
  },
): boolean {
  if (snap.type !== catalogTarget.type) {
    return false;
  }

  if (
    !areYearsCompatible(snap, {
      year: catalogTarget.snapshot.year,
      seasons: [...catalogTarget.snapshot.seasons],
    })
  ) {
    return false;
  }

  const targetExternalIds = catalogTarget.externalIds ?? {};
  let hasMatchingExternalId = false;
  for (const ext of snap.externalIds) {
    const catalogVal = targetExternalIds[ext.namespace];
    if (!catalogVal) {
      continue;
    }
    if (catalogVal !== ext.nativeId) {
      return false;
    }
    hasMatchingExternalId = true;
  }

  const titleCompat = areMediaSnapshotsCompatibleForAutoMerge(
    snap,
    {
      type: catalogTarget.type,
      title: catalogTarget.snapshot.title,
      originalTitle: catalogTarget.snapshot.originalTitle,
      year: catalogTarget.snapshot.year,
      seasons: [...catalogTarget.snapshot.seasons],
    },
    {
      extraTitlesA: ownExtraTitles,
      extraTitlesB: catalogTarget.aliases ?? [],
    },
  );

  return titleCompat.compatible || hasMatchingExternalId;
}

function hasConfirmedTmdb(snapshot: MergeCandidateMediaSnapshot): boolean {
  return snapshot.externalIds.some((ext) => ext.namespace === "tmdb");
}

function getBaselinePriorityScore(baseline: BaselineSource | null): number {
  if (!baseline) {
    return 0;
  }
  const idx = BASELINE_PRIORITY.indexOf(baseline);
  return idx >= 0 ? BASELINE_PRIORITY.length - idx : 0;
}

/** Picks canonical merge target: TMDB > higher baseline priority > earlier created_at > smaller ID. */
export function selectCanonicalMergeTarget(
  a: MergeCandidateMediaSnapshot,
  b: MergeCandidateMediaSnapshot,
): { target: MergeCandidateMediaSnapshot; source: MergeCandidateMediaSnapshot } {
  const aTmdb = hasConfirmedTmdb(a) ? 1 : 0;
  const bTmdb = hasConfirmedTmdb(b) ? 1 : 0;
  if (aTmdb !== bTmdb) {
    return aTmdb > bTmdb ? { target: a, source: b } : { target: b, source: a };
  }

  const aPriority = getBaselinePriorityScore(a.baseline);
  const bPriority = getBaselinePriorityScore(b.baseline);
  if (aPriority !== bPriority) {
    return aPriority > bPriority ? { target: a, source: b } : { target: b, source: a };
  }

  const aCreated = a.createdAt.getTime();
  const bCreated = b.createdAt.getTime();
  if (aCreated !== bCreated) {
    return aCreated < bCreated ? { target: a, source: b } : { target: b, source: a };
  }

  return a.id < b.id ? { target: a, source: b } : { target: b, source: a };
}

export async function resolveCanonicalMediaIdInTx(
  trx: DbExecutor,
  mediaId: string,
): Promise<string | null> {
  let currentId = mediaId;
  const visited = new Set<string>();
  for (let hop = 0; hop < 10; hop += 1) {
    if (visited.has(currentId)) {
      return null;
    }
    visited.add(currentId);
    const row = await trx
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

export async function loadMediaMergeCandidateSnapshotInTx(
  trx: DbExecutor,
  mediaId: string,
): Promise<MergeCandidateMediaSnapshot | null> {
  const row = await trx
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
      "created_at",
    ])
    .where("id", "=", mediaId)
    .executeTakeFirst();

  if (!row) {
    return null;
  }

  const [extRows, assocRows] = await Promise.all([
    trx
      .selectFrom("associations")
      .where("is_external_id", "=", true)
      .select(["id", "namespace", "native_id", "locked"])
      .where("media_id", "=", row.id)
      .where("status", "!=", "delisted")
      .$narrowType<{ namespace: ExternalIdNamespace }>()
      .execute(),
    trx
      .selectFrom("associations")
      .where("is_external_id", "=", false)
      .select(["id", "namespace", "native_id", "variant_id", "status", "locked"])
      .where("media_id", "=", row.id)
      .where("status", "in", ["confirmed", "seed_unconfirmed"])
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute(),
  ]);

  const assocIds = assocRows.map((a) => a.id);
  const segRows =
    assocIds.length > 0
      ? await trx
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
          .execute()
      : [];

  const segmentsByAssoc = new Map<string, NormalizedSegment[]>();
  for (const seg of segRows) {
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

  return {
    id: row.id,
    type: row.type,
    baseline: row.baseline,
    title: row.title,
    originalTitle: row.original_title,
    year: row.year,
    seasons: parseMediaSeasonsJson(row.seasons),
    mergedIntoMediaId: row.merged_into_media_id,
    createdAt: toDate(row.created_at),
    externalIds: extRows.map((ext) => ({
      id: ext.id,
      namespace: ext.namespace,
      nativeId: ext.native_id,
      locked: Boolean(ext.locked),
    })),
    associations: assocRows.map((assoc) => ({
      id: assoc.id,
      namespace: assoc.namespace,
      nativeId: assoc.native_id,
      variantId: assoc.variant_id,
      status: assoc.status,
      locked: Boolean(assoc.locked),
      segments: segmentsByAssoc.get(assoc.id) ?? [],
    })),
  };
}

/**
 * Verifies identity-chain, snapshot compatibility, lock safety, and exclusive catalog bounds
 * before automatically merging duplicate media inside a transaction.
 */
export async function verifyAutoMergeEligibilityInTx(
  trx: DbExecutor,
  input: VerifyAutoMergeEligibilityInput,
): Promise<AutoMergeEligibilityResult> {
  const canonicalA = await resolveCanonicalMediaIdInTx(trx, input.mediaIdA);
  const canonicalB = await resolveCanonicalMediaIdInTx(trx, input.mediaIdB);

  if (!canonicalA || !canonicalB) {
    return {
      eligible: false,
      blockReason: "media_not_found",
      details: { canonicalA, canonicalB },
    };
  }

  if (canonicalA === canonicalB) {
    return {
      eligible: false,
      blockReason: "already_same_media",
      sourceMediaId: canonicalA,
      targetMediaId: canonicalB,
      details: { canonicalMediaId: canonicalA },
    };
  }

  if (input.acquireMergeLocks !== false) {
    for (const id of [canonicalA, canonicalB].sort()) {
      await acquireAdvisoryLock(trx, ADVISORY_LOCK_CLASSES.MEDIA_MERGE, id);
    }
  }

  const [snapA, snapB] = await Promise.all([
    loadMediaMergeCandidateSnapshotInTx(trx, canonicalA),
    loadMediaMergeCandidateSnapshotInTx(trx, canonicalB),
  ]);

  if (!snapA || !snapB) {
    return {
      eligible: false,
      blockReason: "media_not_found",
      details: { canonicalA, canonicalB },
    };
  }

  if (snapA.mergedIntoMediaId !== null || snapB.mergedIntoMediaId !== null) {
    return {
      eligible: false,
      blockReason: "media_already_merged",
      details: {
        aMergedInto: snapA.mergedIntoMediaId,
        bMergedInto: snapB.mergedIntoMediaId,
      },
    };
  }

  const { source, target } = selectCanonicalMergeTarget(snapA, snapB);

  if (source.type !== target.type) {
    return {
      eligible: false,
      blockReason: "type_mismatch",
      sourceMediaId: source.id,
      targetMediaId: target.id,
      details: { sourceType: source.type, targetType: target.type },
    };
  }

  // Reject conflicting external IDs (e.g., two different TMDB/IMDb/TVDB/Trakt IDs) or locked conflicts.
  const targetExtByNs = new Map<ExternalIdNamespace, MergeCandidateExternalId>(
    target.externalIds.map((ext) => [ext.namespace, ext]),
  );
  const matchingExternalIds: Array<{ namespace: ExternalIdNamespace; nativeId: string }> = [];

  for (const ns of EXTERNAL_ID_NAMESPACES) {
    const srcExt = source.externalIds.find((e) => e.namespace === ns);
    const tgtExt = targetExtByNs.get(ns);
    if (!srcExt || !tgtExt) {
      continue;
    }
    if (srcExt.nativeId === tgtExt.nativeId) {
      matchingExternalIds.push({ namespace: ns, nativeId: srcExt.nativeId });
      continue;
    }
    const reasonPrefix =
      srcExt.locked || tgtExt.locked ? "locked_external_id_conflict" : "conflicting_external_id";
    return {
      eligible: false,
      blockReason: `${reasonPrefix}:${ns}`,
      sourceMediaId: source.id,
      targetMediaId: target.id,
      details: {
        namespace: ns,
        sourceNativeId: srcExt.nativeId,
        targetNativeId: tgtExt.nativeId,
        sourceLocked: srcExt.locked,
        targetLocked: tgtExt.locked,
      },
    };
  }

  // Check exclusive catalog associations (`douban`, `bangumi`): different collection IDs cannot overlap
  // in the same season/episodes, while identical collection IDs count as corroborating shared collections.
  const sharedCollections: Array<{ namespace: AssociationNamespaceRow; nativeId: string }> = [];
  const seenSharedKeys = new Set<string>();
  const targetAssocKeys = new Set(target.associations.map((a) => `${a.namespace}:${a.nativeId}`));

  for (const sa of source.associations) {
    const key = `${sa.namespace}:${sa.nativeId}`;
    if (targetAssocKeys.has(key) && !seenSharedKeys.has(key)) {
      seenSharedKeys.add(key);
      sharedCollections.push({ namespace: sa.namespace, nativeId: sa.nativeId });
    }
  }

  const catalogNamespaces = new Set(
    [...source.associations, ...target.associations]
      .filter((a) => isCatalogNamespace(a.namespace))
      .map((a) => a.namespace),
  );

  for (const catalogNs of catalogNamespaces) {
    const tgtAssocs = target.associations.filter((a) => a.namespace === catalogNs);
    const srcAssocs = source.associations.filter((a) => a.namespace === catalogNs);
    // Only check cross-collection overlaps between distinct nativeIds.
    const tgtByNative = new Map(tgtAssocs.map((a) => [a.nativeId, a]));
    const distinctIncoming = srcAssocs.filter((sa) => !tgtByNative.has(sa.nativeId));
    if (distinctIncoming.length === 0 || tgtAssocs.length === 0) {
      continue;
    }

    const validation = validateVariantSegments(
      [
        ...tgtAssocs.map((a) => ({ associationId: a.id, segments: a.segments })),
        ...distinctIncoming.map((a) => ({ associationId: a.id, segments: a.segments })),
      ],
      {
        baseline: target.baseline,
        allowHierarchicalScopes: getNamespaceCapabilities(catalogNs).allowHierarchicalScopes,
      },
    );

    if (!validation.valid) {
      return {
        eligible: false,
        blockReason: `conflicting_catalog_association:${catalogNs}`,
        sourceMediaId: source.id,
        targetMediaId: target.id,
        details: {
          namespace: catalogNs,
          errors: validation.errors.map((e) => e.message),
        },
      };
    }
  }

  // Check snapshot title + year compatibility (including caller-supplied catalog/TMDB aliases).
  const extraTitlesSource = input.extraTitlesByMediaId?.get(source.id) ?? [];
  const extraTitlesTarget = input.extraTitlesByMediaId?.get(target.id) ?? [];
  const compatibility = areMediaSnapshotsCompatibleForAutoMerge(source, target, {
    extraTitlesA: extraTitlesSource,
    extraTitlesB: extraTitlesTarget,
  });

  if (!compatibility.compatible) {
    return {
      eligible: false,
      blockReason: compatibility.reason,
      sourceMediaId: source.id,
      targetMediaId: target.id,
      details: {
        sourceTitle: source.title,
        sourceOriginalTitle: source.originalTitle,
        sourceYear: source.year,
        targetTitle: target.title,
        targetOriginalTitle: target.originalTitle,
        targetYear: target.year,
      },
    };
  }

  return {
    eligible: true,
    sourceMediaId: source.id,
    targetMediaId: target.id,
    source,
    target,
    matchingExternalIds,
    sharedCollections,
  };
}

/**
 * Finds an existing active canonical media matching a newly prefetched catalog target
 * by its external IDs (`tmdb`, `imdb`, `tvdb`, `trakt`) or initial catalog association
 * (`douban`, `bangumi` confirmed or `seed_unconfirmed`), checking coarse type + snapshot
 * compatibility to avoid false merges.
 */
export async function findReusableMediaForPrefetchedCatalogInTx(
  trx: DbExecutor,
  input: {
    type: MediaType;
    snapshot: {
      title: string;
      originalTitle: string | null;
      year: number | null;
      seasons: readonly SeasonSnapshot[];
    };
    externalIds: Partial<Record<ExternalIdNamespace, string>>;
    initialAssociation?: { namespace: AssociationNamespaceRow; nativeId: string } | null;
  },
): Promise<{
  id: string;
  type: MediaType;
  baseline: BaselineSource | null;
  title: string;
  original_title: string | null;
  year: number | null;
  seasons: SeasonSnapshotRow[];
  merged_into_media_id: string | null;
} | null> {
  const candidates: Array<{ mediaId: string; strongKey: boolean }> = [];
  const seen = new Set<string>();

  for (const extNs of EXTERNAL_ID_NAMESPACES) {
    const extNativeId = input.externalIds[extNs];
    if (!extNativeId) {
      continue;
    }
    const ext = await trx
      .selectFrom("associations")
      .where("is_external_id", "=", true)
      .select("media_id")
      .where("namespace", "=", extNs)
      .where("native_id", "=", extNativeId)
      .where("status", "!=", "delisted")
      .executeTakeFirst();
    if (ext) {
      const canonical = await resolveCanonicalMediaIdInTx(trx, ext.media_id);
      if (canonical && !seen.has(canonical)) {
        seen.add(canonical);
        candidates.push({ mediaId: canonical, strongKey: extNs === "tmdb" });
      }
    }
  }

  if (input.initialAssociation) {
    const assocs = await trx
      .selectFrom("associations")
      .where("is_external_id", "=", false)
      .select(["media_id", "status"])
      .where("namespace", "=", input.initialAssociation.namespace)
      .where("native_id", "=", input.initialAssociation.nativeId)
      .where("status", "in", ["confirmed", "seed_unconfirmed"])
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute();
    for (const assoc of [
      ...assocs.filter((a) => a.status === "confirmed"),
      ...assocs.filter((a) => a.status !== "confirmed"),
    ]) {
      const canonical = await resolveCanonicalMediaIdInTx(trx, assoc.media_id);
      if (canonical && !seen.has(canonical)) {
        seen.add(canonical);
        candidates.push({ mediaId: canonical, strongKey: false });
      }
    }
  }

  for (const candidate of candidates) {
    const row = await trx
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
      .where("id", "=", candidate.mediaId)
      .forUpdate()
      .executeTakeFirst();
    if (!row || row.merged_into_media_id !== null || row.type !== input.type) {
      continue;
    }

    if (candidate.strongKey) {
      return row;
    }

    const compat = areMediaSnapshotsCompatibleForAutoMerge(
      {
        type: row.type,
        title: row.title,
        originalTitle: row.original_title,
        year: row.year,
        seasons: parseMediaSeasonsJson(row.seasons),
      },
      {
        type: input.type,
        title: input.snapshot.title,
        originalTitle: input.snapshot.originalTitle,
        year: input.snapshot.year,
        seasons: [...input.snapshot.seasons],
      },
    );
    if (compat.compatible) {
      return row;
    }
  }

  return null;
}

export function extractCatalogAndCollectionTitlesFromEvidence(rawEvidence: unknown): {
  catalogTitles: string[];
  collectionTitles: string[];
} {
  if (!rawEvidence || typeof rawEvidence !== "object" || Array.isArray(rawEvidence)) {
    return { catalogTitles: [], collectionTitles: [] };
  }
  const ev = rawEvidence as Record<string, unknown>;
  const pickTitles = (obj: unknown): string[] => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      return [];
    }
    const rec = obj as Record<string, unknown>;
    const raw: unknown[] = [
      rec.title,
      rec.originalTitle,
      ...(Array.isArray(rec.aliases) ? rec.aliases : []),
    ];
    return raw.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  };
  return {
    catalogTitles: pickTitles(ev.catalog),
    collectionTitles: pickTitles(ev.collection),
  };
}
