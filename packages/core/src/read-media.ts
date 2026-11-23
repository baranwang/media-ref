import {
  EXTERNAL_ID_NAMESPACES,
  PLATFORM_NAMESPACES,
  formatExternalKey,
  isPlatformNamespace,
  parseExternalKey,
  type Association,
  type BaselineSource,
  type ExternalIdNamespace,
  type MediaDocument,
  type PlatformNamespace,
  type PlatformStatusEntry,
  type SeasonSnapshot,
  type Segment,
  type Variant,
} from "@media-ref/client";
import type {
  AssociationNamespaceRow,
  Db,
  SeasonSnapshotRow,
  StoredSegmentJson,
} from "@media-ref/db";
import { isAssociationNamespace, isUuid } from "./media-service.ts";

export const MAX_BATCH_MEDIA_KEYS = 100;

const EXTERNAL_ID_NAMESPACE_SET: ReadonlySet<string> = new Set(EXTERNAL_ID_NAMESPACES);
const MAX_MERGE_HOPS = 10;
const INVALID_KEY_MESSAGE = "Key must be a valid media UUID or external key (e.g. tmdb:tv:95479)";
const MEDIA_NOT_FOUND_MESSAGE = "Media not found";

export type BatchMediaQueryErrorCode = "BATCH_LIMIT_EXCEEDED";

export class BatchMediaQueryError extends Error {
  readonly code: BatchMediaQueryErrorCode;
  readonly status: number;

  constructor(code: BatchMediaQueryErrorCode, status: number, message: string) {
    super(message);
    this.name = "BatchMediaQueryError";
    this.code = code;
    this.status = status;
  }
}

export interface ReadMediaOptions {
  includeUnconfirmed?: boolean;
}

export interface MediaQueryItem {
  document: MediaDocument;
  matchedAssociationId: string | null;
}

export type QueryMediaByKeyResult =
  | { kind: "ok"; key: string; items: MediaQueryItem[] }
  | { kind: "not_found"; key: string }
  | { kind: "invalid_key"; key: string; message: string };

export interface BatchMediaQueryInput {
  keys: readonly string[];
  includeUnconfirmed?: boolean;
}

export type BatchMediaQueryResult =
  | { key: string; ok: true; items: MediaQueryItem[] }
  | { key: string; ok: false; error: "INVALID_KEY" | "NOT_FOUND"; message: string };

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

type ParsedLookupKey =
  | { kind: "media_id"; mediaId: string; canonicalKey: string }
  | {
      kind: "external_id";
      namespace: ExternalIdNamespace;
      nativeId: string;
      canonicalKey: string;
    }
  | {
      kind: "association";
      namespace: AssociationNamespaceRow;
      nativeId: string;
      canonicalKey: string;
    };

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

function parseSeasonsSnapshot(raw: unknown): SeasonSnapshot[] {
  const entries = parseJsonArray<SeasonSnapshotRow>(raw);
  return entries.map((entry) => ({
    season: entry.season,
    episodeCount: entry.episodeCount,
    airYear: entry.airYear ?? null,
  }));
}

function parseStoredSegments(raw: unknown): Segment[] {
  const entries = parseJsonArray<StoredSegmentJson>(raw);
  return entries.map((seg) => ({
    season: seg.season,
    episodeStart: seg.episodeStart,
    episodeEnd: seg.episodeEnd ?? null,
    targetEpisodeStart: seg.targetEpisodeStart,
    baseline: seg.baseline,
    ...(seg.nonLinear ? { nonLinear: true } : {}),
    ...(seg.needsReview ? { needsReview: true } : {}),
  }));
}

function formatChangeRequestAssociationId(changeRequestId: string): string {
  return `change-request:${changeRequestId}`;
}

function formatChangeRequestVariantId(changeRequestId: string): string {
  return `change-request-variant:${changeRequestId}`;
}

function parseLookupKey(raw: string): ParsedLookupKey | null {
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

  const canonicalKey = formatExternalKey(parsed);
  if (isExternalIdNamespace(parsed.namespace)) {
    return {
      kind: "external_id",
      namespace: parsed.namespace,
      nativeId: parsed.nativeId,
      canonicalKey,
    };
  }

  if (isAssociationNamespace(parsed.namespace)) {
    return {
      kind: "association",
      namespace: parsed.namespace,
      nativeId: parsed.nativeId,
      canonicalKey,
    };
  }

  return null;
}

async function resolveCanonicalMediaMap(
  dbRead: Db,
  initialMediaIds: Iterable<string>,
): Promise<Map<string, ResolvedMediaRow>> {
  const startIds = [...new Set(initialMediaIds)];
  if (startIds.length === 0) {
    return new Map();
  }

  const fetchedById = new Map<string, ResolvedMediaRow>();
  let frontier = startIds;

  for (let hop = 0; hop < MAX_MERGE_HOPS && frontier.length > 0; hop++) {
    const toFetch = frontier.filter((id) => !fetchedById.has(id));
    if (toFetch.length === 0) {
      break;
    }

    const rows = await dbRead
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
      .where("id", "in", toFetch)
      .execute();

    const nextFrontier = new Set<string>();
    for (const row of rows) {
      fetchedById.set(row.id, row);
      if (row.merged_into_media_id && row.merged_into_media_id !== row.id) {
        if (!fetchedById.has(row.merged_into_media_id)) {
          nextFrontier.add(row.merged_into_media_id);
        }
      }
    }
    frontier = [...nextFrontier];
  }

  const canonicalByOriginalId = new Map<string, ResolvedMediaRow>();
  for (const startId of startIds) {
    let currentId = startId;
    const visited = new Set<string>();
    let resolved: ResolvedMediaRow | null = null;

    for (let hop = 0; hop < MAX_MERGE_HOPS; hop++) {
      if (visited.has(currentId)) {
        resolved = null;
        break;
      }
      visited.add(currentId);

      const row = fetchedById.get(currentId);
      if (!row) {
        resolved = null;
        break;
      }

      if (!row.merged_into_media_id || row.merged_into_media_id === row.id) {
        resolved = row;
        break;
      }
      currentId = row.merged_into_media_id;
    }

    if (resolved) {
      canonicalByOriginalId.set(startId, resolved);
    }
  }

  return canonicalByOriginalId;
}

async function collectMergedDescendantMediaMap(
  dbRead: Db,
  canonicalMediaIds: readonly string[],
): Promise<Map<string, string>> {
  const canonicalByAnyId = new Map<string, string>();
  for (const id of canonicalMediaIds) {
    canonicalByAnyId.set(id, id);
  }

  let frontier = [...canonicalMediaIds];
  for (let hop = 0; hop < MAX_MERGE_HOPS && frontier.length > 0; hop++) {
    const mergedRows = await dbRead
      .selectFrom("media")
      .select(["id", "merged_into_media_id"])
      .where("merged_into_media_id", "in", frontier)
      .execute();

    const nextFrontier: string[] = [];
    for (const row of mergedRows) {
      if (!row.merged_into_media_id || canonicalByAnyId.has(row.id)) {
        continue;
      }
      const rootId = canonicalByAnyId.get(row.merged_into_media_id);
      if (rootId) {
        canonicalByAnyId.set(row.id, rootId);
        nextFrontier.push(row.id);
      }
    }
    frontier = nextFrontier;
  }

  return canonicalByAnyId;
}

async function lookupExternalIdsBatch(
  dbRead: Db,
  pairs: ReadonlyArray<{ namespace: ExternalIdNamespace; nativeId: string }>,
): Promise<Map<string, string>> {
  const byNamespace = new Map<ExternalIdNamespace, Set<string>>();
  for (const pair of pairs) {
    const set = byNamespace.get(pair.namespace) ?? new Set<string>();
    set.add(pair.nativeId);
    byNamespace.set(pair.namespace, set);
  }

  if (byNamespace.size === 0) {
    return new Map();
  }

  const entries = [...byNamespace.entries()];
  const rows = await dbRead
    .selectFrom("external_ids")
    .select(["media_id", "namespace", "native_id"])
    .where((eb) =>
      eb.or(
        entries.map(([namespace, nativeIds]) =>
          eb.and([eb("namespace", "=", namespace), eb("native_id", "in", [...nativeIds])]),
        ),
      ),
    )
    .execute();

  const mediaIdByExternalKey = new Map<string, string>();
  for (const row of rows) {
    mediaIdByExternalKey.set(
      formatExternalKey({ namespace: row.namespace, nativeId: row.native_id }),
      row.media_id,
    );
  }
  return mediaIdByExternalKey;
}

async function lookupAssociationsBatch(
  dbRead: Db,
  pairs: ReadonlyArray<{ namespace: AssociationNamespaceRow; nativeId: string }>,
  includeUnconfirmed: boolean,
): Promise<
  Map<string, Array<{ id: string; mediaId: string; status: "confirmed" | "seed_unconfirmed" }>>
> {
  const byNamespace = new Map<AssociationNamespaceRow, Set<string>>();
  for (const pair of pairs) {
    const set = byNamespace.get(pair.namespace) ?? new Set<string>();
    set.add(pair.nativeId);
    byNamespace.set(pair.namespace, set);
  }

  if (byNamespace.size === 0) {
    return new Map();
  }

  const entries = [...byNamespace.entries()];
  const allowedStatuses: Array<"confirmed" | "seed_unconfirmed"> = includeUnconfirmed
    ? ["confirmed", "seed_unconfirmed"]
    : ["confirmed"];

  const rows = await dbRead
    .selectFrom("associations")
    .select(["id", "media_id", "namespace", "native_id", "status"])
    .where("status", "in", allowedStatuses)
    .where((eb) =>
      eb.or(
        entries.map(([namespace, nativeIds]) =>
          eb.and([eb("namespace", "=", namespace), eb("native_id", "in", [...nativeIds])]),
        ),
      ),
    )
    .orderBy("created_at", "asc")
    .orderBy("id", "asc")
    .execute();

  const confirmedByKey = new Map<
    string,
    Array<{ id: string; mediaId: string; status: "confirmed" | "seed_unconfirmed" }>
  >();
  const seedByKey = new Map<
    string,
    Array<{ id: string; mediaId: string; status: "confirmed" | "seed_unconfirmed" }>
  >();

  for (const row of rows) {
    if (row.status !== "confirmed" && row.status !== "seed_unconfirmed") {
      continue;
    }
    const key = formatExternalKey({ namespace: row.namespace, nativeId: row.native_id });
    const targetMap = row.status === "confirmed" ? confirmedByKey : seedByKey;
    const list = targetMap.get(key) ?? [];
    list.push({ id: row.id, mediaId: row.media_id, status: row.status });
    targetMap.set(key, list);
  }

  const combined = new Map<
    string,
    Array<{ id: string; mediaId: string; status: "confirmed" | "seed_unconfirmed" }>
  >();
  const allKeys = new Set([...confirmedByKey.keys(), ...seedByKey.keys()]);
  for (const key of allKeys) {
    combined.set(key, [...(confirmedByKey.get(key) ?? []), ...(seedByKey.get(key) ?? [])]);
  }
  return combined;
}

async function lookupUnconfirmedChangeRequestsBatch(
  dbRead: Db,
  pairs: ReadonlyArray<{ namespace: AssociationNamespaceRow; nativeId: string }>,
): Promise<Map<string, Array<{ id: string; mediaId: string | null; targetExternalKey: string }>>> {
  const byNamespace = new Map<AssociationNamespaceRow, Set<string>>();
  for (const pair of pairs) {
    const set = byNamespace.get(pair.namespace) ?? new Set<string>();
    set.add(pair.nativeId);
    byNamespace.set(pair.namespace, set);
  }

  if (byNamespace.size === 0) {
    return new Map();
  }

  const entries = [...byNamespace.entries()];
  const rows = await dbRead
    .selectFrom("change_requests")
    .select(["id", "media_id", "target_external_key", "namespace", "native_id"])
    .where("status", "in", ["pending_evidence", "needs_review"])
    .where((eb) =>
      eb.or(
        entries.map(([namespace, nativeIds]) =>
          eb.and([eb("namespace", "=", namespace), eb("native_id", "in", [...nativeIds])]),
        ),
      ),
    )
    .orderBy("created_at", "asc")
    .orderBy("id", "asc")
    .execute();

  const byKey = new Map<
    string,
    Array<{ id: string; mediaId: string | null; targetExternalKey: string }>
  >();
  for (const row of rows) {
    const key = formatExternalKey({ namespace: row.namespace, nativeId: row.native_id });
    const list = byKey.get(key) ?? [];
    list.push({
      id: row.id,
      mediaId: row.media_id,
      targetExternalKey: row.target_external_key,
    });
    byKey.set(key, list);
  }
  return byKey;
}

async function hydrateMediaDocuments(
  dbRead: Db,
  mediaRows: readonly ResolvedMediaRow[],
  includeUnconfirmed: boolean,
): Promise<Map<string, MediaDocument>> {
  if (mediaRows.length === 0) {
    return new Map();
  }

  const mediaIds = mediaRows.map((row) => row.id);
  const allowedStatuses: Array<"confirmed" | "seed_unconfirmed"> = includeUnconfirmed
    ? ["confirmed", "seed_unconfirmed"]
    : ["confirmed"];

  const [externalIdRows, variantRows, associationRows, platformCheckRows] = await Promise.all([
    dbRead
      .selectFrom("external_ids")
      .select(["media_id", "namespace", "native_id", "locked"])
      .where("media_id", "in", mediaIds)
      .orderBy("namespace", "asc")
      .orderBy("native_id", "asc")
      .execute(),
    dbRead
      .selectFrom("variants")
      .select(["id", "media_id", "platform", "description", "is_default"])
      .where("media_id", "in", mediaIds)
      .orderBy("platform", "asc")
      .orderBy("is_default", "desc")
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
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
      .where("media_id", "in", mediaIds)
      .where("status", "in", allowedStatuses)
      .orderBy("namespace", "asc")
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute(),
    dbRead
      .selectFrom("platform_checks")
      .select(["media_id", "platform", "status", "checked_at"])
      .where("media_id", "in", mediaIds)
      .where("status", "=", "not_found")
      .execute(),
  ]);

  const associationIds = associationRows.map((row) => row.id);

  type UnconfirmedChangeRequestRow = {
    id: string;
    status: "pending_evidence" | "needs_review";
    media_id: string | null;
    target_external_key: string;
    namespace: AssociationNamespaceRow;
    native_id: string;
    variant_id: string | null;
    variant_description: string | null;
    set_default_variant: boolean;
    segments: StoredSegmentJson[];
  };

  const unconfirmedChangeRequestsByMedia = new Map<string, UnconfirmedChangeRequestRow[]>();

  const [segmentRows] = await Promise.all([
    associationIds.length > 0
      ? dbRead
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
      : Promise.resolve([]),
    (async () => {
      if (!includeUnconfirmed) {
        return;
      }

      const canonicalByAnyId = await collectMergedDescendantMediaMap(dbRead, mediaIds);
      const allMediaIds = [...canonicalByAnyId.keys()];

      const canonicalByTargetKey = new Map<string, string>();
      for (const [anyId, canonicalId] of canonicalByAnyId.entries()) {
        canonicalByTargetKey.set(`media:${anyId}`, canonicalId);
      }
      for (const ext of externalIdRows) {
        const key = formatExternalKey({ namespace: ext.namespace, nativeId: ext.native_id });
        canonicalByTargetKey.set(key, ext.media_id);
      }

      const mergedOnlyIds = allMediaIds.filter((id) => !mediaIds.includes(id));
      if (mergedOnlyIds.length > 0) {
        const mergedExtRows = await dbRead
          .selectFrom("external_ids")
          .select(["media_id", "namespace", "native_id"])
          .where("media_id", "in", mergedOnlyIds)
          .execute();
        for (const ext of mergedExtRows) {
          const canonicalId = canonicalByAnyId.get(ext.media_id);
          if (canonicalId) {
            canonicalByTargetKey.set(
              formatExternalKey({ namespace: ext.namespace, nativeId: ext.native_id }),
              canonicalId,
            );
          }
        }
      }

      const targetExternalKeys = [...canonicalByTargetKey.keys()];
      const crRows = await dbRead
        .selectFrom("change_requests")
        .select([
          "id",
          "status",
          "media_id",
          "target_external_key",
          "namespace",
          "native_id",
          "variant_id",
          "variant_description",
          "set_default_variant",
          "segments",
        ])
        .where("status", "in", ["pending_evidence", "needs_review"])
        .where((eb) => {
          const conditions = [eb("media_id", "in", allMediaIds)];
          if (targetExternalKeys.length > 0) {
            conditions.push(
              eb.and([
                eb("media_id", "is", null),
                eb("target_external_key", "in", targetExternalKeys),
              ]),
            );
          }
          return eb.or(conditions);
        })
        .orderBy("created_at", "asc")
        .orderBy("id", "asc")
        .execute();

      for (const row of crRows) {
        if (row.status !== "pending_evidence" && row.status !== "needs_review") {
          continue;
        }
        const canonicalId =
          row.media_id !== null
            ? canonicalByAnyId.get(row.media_id)
            : canonicalByTargetKey.get(row.target_external_key);
        if (!canonicalId) {
          continue;
        }
        const list = unconfirmedChangeRequestsByMedia.get(canonicalId) ?? [];
        list.push({
          id: row.id,
          status: row.status,
          media_id: row.media_id,
          target_external_key: row.target_external_key,
          namespace: row.namespace,
          native_id: row.native_id,
          variant_id: row.variant_id,
          variant_description: row.variant_description,
          set_default_variant: Boolean(row.set_default_variant),
          segments: row.segments,
        });
        unconfirmedChangeRequestsByMedia.set(canonicalId, list);
      }
    })(),
  ]);

  const segmentsByAssociation = new Map<string, Segment[]>();
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

  const externalIdsByMedia = new Map<string, typeof externalIdRows>();
  for (const row of externalIdRows) {
    const list = externalIdsByMedia.get(row.media_id) ?? [];
    list.push(row);
    externalIdsByMedia.set(row.media_id, list);
  }

  const variantsByMedia = new Map<string, typeof variantRows>();
  for (const row of variantRows) {
    const list = variantsByMedia.get(row.media_id) ?? [];
    list.push(row);
    variantsByMedia.set(row.media_id, list);
  }

  const associationsByMedia = new Map<string, typeof associationRows>();
  for (const row of associationRows) {
    const list = associationsByMedia.get(row.media_id) ?? [];
    list.push(row);
    associationsByMedia.set(row.media_id, list);
  }

  const checksByMedia = new Map<string, Map<PlatformNamespace, Date | string>>();
  for (const check of platformCheckRows) {
    if (check.status !== "not_found") {
      continue;
    }
    const perMedia =
      checksByMedia.get(check.media_id) ?? new Map<PlatformNamespace, Date | string>();
    perMedia.set(check.platform, check.checked_at);
    checksByMedia.set(check.media_id, perMedia);
  }

  const documentsByMediaId = new Map<string, MediaDocument>();
  for (const media of mediaRows) {
    const mediaExternalIds = externalIdsByMedia.get(media.id) ?? [];
    const mediaVariantRows = variantsByMedia.get(media.id) ?? [];
    const mediaAssociationRows = associationsByMedia.get(media.id) ?? [];
    const mediaChecks = checksByMedia.get(media.id) ?? new Map<PlatformNamespace, Date | string>();
    const mediaChangeRequests = unconfirmedChangeRequestsByMedia.get(media.id) ?? [];

    const confirmedPlatforms = new Set<string>();
    for (const row of mediaAssociationRows) {
      if (row.status === "confirmed") {
        confirmedPlatforms.add(row.namespace);
      }
    }

    const platformStatuses = {} as Record<PlatformNamespace, PlatformStatusEntry>;
    for (const platform of PLATFORM_NAMESPACES) {
      if (confirmedPlatforms.has(platform)) {
        platformStatuses[platform] = { status: "associated" };
      } else {
        const checkedAt = mediaChecks.get(platform);
        if (checkedAt !== undefined) {
          platformStatuses[platform] = {
            status: "not_found",
            checkedAt: toIsoString(checkedAt),
          };
        } else {
          platformStatuses[platform] = { status: "unchecked" };
        }
      }
    }

    const variants: Variant[] = mediaVariantRows.map((row) => ({
      id: row.id,
      mediaId: row.media_id,
      namespace: row.platform,
      label: row.description,
      isDefault: Boolean(row.is_default),
    }));

    const associations: Association[] = mediaAssociationRows.map((row) => ({
      id: row.id,
      mediaId: row.media_id,
      namespace: row.namespace,
      nativeId: row.native_id,
      variantId: row.variant_id,
      status: row.status,
      segments: segmentsByAssociation.get(row.id) ?? [],
      ...(row.needs_review ? { needsReview: true } : {}),
      ...(row.locked ? { locked: true } : {}),
      ...(row.status === "seed_unconfirmed"
        ? { unconfirmed: true, unconfirmedSource: "seed_unconfirmed" as const }
        : {}),
    }));

    if (includeUnconfirmed && mediaChangeRequests.length > 0) {
      const persistedVariantById = new Map<string, Variant>();
      const persistedVariantByPlatformDesc = new Map<string, Variant>();
      const platformHasPersistedDefault = new Set<PlatformNamespace>();

      for (const variant of variants) {
        persistedVariantById.set(variant.id, variant);
        const descKey = `${variant.namespace}\0${variant.label.trim()}`;
        if (!persistedVariantByPlatformDesc.has(descKey)) {
          persistedVariantByPlatformDesc.set(descKey, variant);
        }
        if (variant.isDefault) {
          platformHasPersistedDefault.add(variant.namespace);
        }
      }

      const preferredSyntheticDescByPlatform = new Map<PlatformNamespace, string>();
      for (const cr of mediaChangeRequests) {
        if (!isPlatformNamespace(cr.namespace) || platformHasPersistedDefault.has(cr.namespace)) {
          continue;
        }
        const label = cr.variant_description?.trim() ?? "";
        const descKey = `${cr.namespace}\0${label}`;
        if (persistedVariantByPlatformDesc.has(descKey)) {
          continue;
        }
        if (cr.set_default_variant && !preferredSyntheticDescByPlatform.has(cr.namespace)) {
          preferredSyntheticDescByPlatform.set(cr.namespace, descKey);
        }
      }

      const platformHasSyntheticDefault = new Set<PlatformNamespace>();
      const syntheticVariantByPlatformDesc = new Map<string, Variant>();

      for (const cr of mediaChangeRequests) {
        let resolvedVariantId: string | null = null;

        if (isPlatformNamespace(cr.namespace)) {
          const platform = cr.namespace;
          const byId = cr.variant_id ? persistedVariantById.get(cr.variant_id) : undefined;
          if (byId && byId.namespace === platform) {
            resolvedVariantId = byId.id;
          } else {
            const label = cr.variant_description?.trim() ?? "";
            const descKey = `${platform}\0${label}`;
            const existingByDesc = persistedVariantByPlatformDesc.get(descKey);
            if (existingByDesc) {
              resolvedVariantId = existingByDesc.id;
            } else {
              let synthetic = syntheticVariantByPlatformDesc.get(descKey);
              if (!synthetic) {
                const preferred = preferredSyntheticDescByPlatform.get(platform);
                const shouldBeDefault =
                  !platformHasPersistedDefault.has(platform) &&
                  !platformHasSyntheticDefault.has(platform) &&
                  (preferred === undefined || preferred === descKey);
                if (shouldBeDefault) {
                  platformHasSyntheticDefault.add(platform);
                }
                synthetic = {
                  id: formatChangeRequestVariantId(cr.id),
                  mediaId: media.id,
                  namespace: platform,
                  label,
                  isDefault: shouldBeDefault,
                  unconfirmed: true,
                };
                syntheticVariantByPlatformDesc.set(descKey, synthetic);
                variants.push(synthetic);
              }
              resolvedVariantId = synthetic.id;
            }
          }
        }

        associations.push({
          id: formatChangeRequestAssociationId(cr.id),
          mediaId: media.id,
          namespace: cr.namespace,
          nativeId: cr.native_id,
          variantId: resolvedVariantId,
          status: "confirmed",
          segments: parseStoredSegments(cr.segments),
          unconfirmed: true,
          unconfirmedSource: "change_request",
          changeRequestId: cr.id,
          changeRequestStatus: cr.status,
        });
      }
    }

    documentsByMediaId.set(media.id, {
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
      externalIds: mediaExternalIds.map((row) => ({
        namespace: row.namespace,
        nativeId: row.native_id,
        ...(row.locked ? { locked: true } : {}),
      })),
      variants,
      associations,
      matchedAssociationIds: [],
      platformStatuses,
    });
  }

  return documentsByMediaId;
}

function attachMatchedAssociationIds(
  baseDocument: MediaDocument,
  candidateMatchedIds: readonly string[],
): MediaQueryItem {
  const validIds = new Set(baseDocument.associations.map((assoc) => assoc.id));
  const matchedAssociationIds: string[] = [];
  for (const id of candidateMatchedIds) {
    if (validIds.has(id) && !matchedAssociationIds.includes(id)) {
      matchedAssociationIds.push(id);
    }
  }

  return {
    document: {
      ...baseDocument,
      matchedAssociationIds,
    },
    matchedAssociationId: matchedAssociationIds[0] ?? null,
  };
}

async function resolveKeysBatch(
  dbRead: Db,
  rawKeys: readonly unknown[],
  includeUnconfirmed: boolean,
): Promise<BatchMediaQueryResult[]> {
  const parsedKeys: Array<{ rawKey: string; parsed: ParsedLookupKey | null }> = [];
  const externalIdPairs: Array<{ namespace: ExternalIdNamespace; nativeId: string }> = [];
  const associationPairs: Array<{ namespace: AssociationNamespaceRow; nativeId: string }> = [];

  for (const raw of rawKeys) {
    if (typeof raw !== "string") {
      parsedKeys.push({ rawKey: String(raw), parsed: null });
      continue;
    }
    const parsed = parseLookupKey(raw);
    parsedKeys.push({ rawKey: raw, parsed });
    if (parsed?.kind === "external_id") {
      externalIdPairs.push({ namespace: parsed.namespace, nativeId: parsed.nativeId });
    } else if (parsed?.kind === "association") {
      associationPairs.push({ namespace: parsed.namespace, nativeId: parsed.nativeId });
    }
  }

  const [mediaIdByExternalKey, assocRowsByKey, crRowsByKey] = await Promise.all([
    lookupExternalIdsBatch(dbRead, externalIdPairs),
    lookupAssociationsBatch(dbRead, associationPairs, includeUnconfirmed),
    includeUnconfirmed
      ? lookupUnconfirmedChangeRequestsBatch(dbRead, associationPairs)
      : Promise.resolve(
          new Map<
            string,
            Array<{ id: string; mediaId: string | null; targetExternalKey: string }>
          >(),
        ),
  ]);

  // Resolve any unconfirmed change requests whose media_id is NULL via target_external_key
  const crExtPairsToResolve: Array<{ namespace: ExternalIdNamespace; nativeId: string }> = [];
  const parsedCrTargetById = new Map<string, ParsedLookupKey>();
  for (const rows of crRowsByKey.values()) {
    for (const cr of rows) {
      if (cr.mediaId === null && !parsedCrTargetById.has(cr.id)) {
        const parsedCrTarget = parseLookupKey(cr.targetExternalKey);
        if (parsedCrTarget) {
          parsedCrTargetById.set(cr.id, parsedCrTarget);
          if (
            parsedCrTarget.kind === "external_id" &&
            !mediaIdByExternalKey.has(parsedCrTarget.canonicalKey)
          ) {
            crExtPairsToResolve.push({
              namespace: parsedCrTarget.namespace,
              nativeId: parsedCrTarget.nativeId,
            });
          }
        }
      }
    }
  }

  if (crExtPairsToResolve.length > 0) {
    const resolvedCrExt = await lookupExternalIdsBatch(dbRead, crExtPairsToResolve);
    for (const [key, mediaId] of resolvedCrExt.entries()) {
      mediaIdByExternalKey.set(key, mediaId);
    }
  }

  type CandidateMatch = { rawMediaId: string; matchedAssociationId: string | null };
  const candidateMatchesPerIndex: Array<CandidateMatch[]> = [];
  const allRawMediaIds = new Set<string>();

  for (const entry of parsedKeys) {
    const matches: CandidateMatch[] = [];
    const parsed = entry.parsed;

    if (parsed) {
      if (parsed.kind === "media_id") {
        matches.push({ rawMediaId: parsed.mediaId, matchedAssociationId: null });
        allRawMediaIds.add(parsed.mediaId);
      } else if (parsed.kind === "external_id") {
        const mediaId = mediaIdByExternalKey.get(parsed.canonicalKey);
        if (mediaId) {
          matches.push({ rawMediaId: mediaId, matchedAssociationId: null });
          allRawMediaIds.add(mediaId);
        }
      } else {
        const assocRows = assocRowsByKey.get(parsed.canonicalKey) ?? [];
        for (const row of assocRows) {
          matches.push({ rawMediaId: row.mediaId, matchedAssociationId: row.id });
          allRawMediaIds.add(row.mediaId);
        }

        const crRows = crRowsByKey.get(parsed.canonicalKey) ?? [];
        for (const cr of crRows) {
          const assocId = formatChangeRequestAssociationId(cr.id);
          if (cr.mediaId !== null) {
            matches.push({ rawMediaId: cr.mediaId, matchedAssociationId: assocId });
            allRawMediaIds.add(cr.mediaId);
            continue;
          }
          const parsedCrTarget = parsedCrTargetById.get(cr.id);
          if (!parsedCrTarget) {
            continue;
          }
          if (parsedCrTarget.kind === "media_id") {
            matches.push({ rawMediaId: parsedCrTarget.mediaId, matchedAssociationId: assocId });
            allRawMediaIds.add(parsedCrTarget.mediaId);
          } else if (parsedCrTarget.kind === "external_id") {
            const resolvedId = mediaIdByExternalKey.get(parsedCrTarget.canonicalKey);
            if (resolvedId) {
              matches.push({ rawMediaId: resolvedId, matchedAssociationId: assocId });
              allRawMediaIds.add(resolvedId);
            }
          }
        }
      }
    }

    candidateMatchesPerIndex.push(matches);
  }

  const canonicalByOriginalId = await resolveCanonicalMediaMap(dbRead, allRawMediaIds);

  const uniqueCanonicalMediaById = new Map<string, ResolvedMediaRow>();
  const resolvedPerIndex: Array<Array<{ mediaId: string; matchedAssociationIds: string[] }>> = [];

  for (const matches of candidateMatchesPerIndex) {
    const order: Array<{ mediaId: string; matchedAssociationIds: string[] }> = [];
    const byCanonicalId = new Map<string, string[]>();

    for (const match of matches) {
      const canonical = canonicalByOriginalId.get(match.rawMediaId);
      if (!canonical) {
        continue;
      }

      if (!uniqueCanonicalMediaById.has(canonical.id)) {
        uniqueCanonicalMediaById.set(canonical.id, canonical);
      }

      let matchedIds = byCanonicalId.get(canonical.id);
      if (!matchedIds) {
        matchedIds = [];
        byCanonicalId.set(canonical.id, matchedIds);
        order.push({ mediaId: canonical.id, matchedAssociationIds: matchedIds });
      }

      if (match.matchedAssociationId && !matchedIds.includes(match.matchedAssociationId)) {
        matchedIds.push(match.matchedAssociationId);
      }
    }

    resolvedPerIndex.push(order);
  }

  const documentsByMediaId = await hydrateMediaDocuments(
    dbRead,
    [...uniqueCanonicalMediaById.values()],
    includeUnconfirmed,
  );

  return parsedKeys.map((entry, index) => {
    if (!entry.parsed) {
      return {
        key: entry.rawKey,
        ok: false,
        error: "INVALID_KEY",
        message: INVALID_KEY_MESSAGE,
      };
    }

    const resolvedEntries = resolvedPerIndex[index] ?? [];
    const items: MediaQueryItem[] = [];
    for (const resolved of resolvedEntries) {
      const baseDocument = documentsByMediaId.get(resolved.mediaId);
      if (!baseDocument) {
        continue;
      }
      items.push(attachMatchedAssociationIds(baseDocument, resolved.matchedAssociationIds));
    }

    if (items.length === 0) {
      return {
        key: entry.rawKey,
        ok: false,
        error: "NOT_FOUND",
        message: MEDIA_NOT_FOUND_MESSAGE,
      };
    }

    return {
      key: entry.rawKey,
      ok: true,
      items,
    };
  });
}

export async function queryMediaByKey(
  dbRead: Db,
  rawKey: string,
  options: ReadMediaOptions = {},
): Promise<QueryMediaByKeyResult> {
  const [result] = await resolveKeysBatch(dbRead, [rawKey], options.includeUnconfirmed === true);
  if (!result) {
    return { kind: "not_found", key: rawKey };
  }

  if (!result.ok) {
    if (result.error === "INVALID_KEY") {
      return {
        kind: "invalid_key",
        key: rawKey,
        message: result.message,
      };
    }
    return { kind: "not_found", key: rawKey };
  }

  return {
    kind: "ok",
    key: result.key,
    items: result.items,
  };
}

export async function queryMediaBatch(
  dbRead: Db,
  input: BatchMediaQueryInput,
): Promise<BatchMediaQueryResult[]> {
  if (
    !Array.isArray(input.keys) ||
    input.keys.length === 0 ||
    input.keys.length > MAX_BATCH_MEDIA_KEYS
  ) {
    throw new BatchMediaQueryError(
      "BATCH_LIMIT_EXCEEDED",
      400,
      `keys must contain between 1 and ${MAX_BATCH_MEDIA_KEYS} items`,
    );
  }

  return resolveKeysBatch(dbRead, input.keys, input.includeUnconfirmed === true);
}
