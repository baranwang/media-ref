import {
  formatExternalKey,
  isCatalogNamespace,
  isExternalIdNamespace,
  type ExternalIdNamespace,
  type MediaType,
} from "@media-ref/client";
import type { AssociationNamespaceRow, Database, Db, JsonObject } from "@media-ref/db";
import { sql, type Transaction } from "kysely";
import {
  buildCatalogTargetSnapshotFromTmdb,
  parseCatalogTargetKey,
  resolveCatalogTargetSnapshot,
  type CatalogGatewayConfig,
} from "./catalog-gateway.ts";
import {
  areMediaSnapshotsCompatibleForAutoMerge,
  doesCatalogTargetMatchMediaSnapshot,
  loadMediaMergeCandidateSnapshotInTx,
  resolveCanonicalMediaIdInTx,
  verifyAutoMergeEligibilityInTx,
  type MergeCandidateMediaSnapshot,
} from "./duplicate-merge-policy.ts";
import { fulfillCoveredCatalogDemandsInTx } from "./demands.ts";
import { isUuid } from "./media-service.ts";
import type { OutboundClient } from "./outbound.ts";
import {
  createTmdbGateway,
  parseTmdbNativeId,
  type TmdbGateway,
  type TmdbGatewayConfig,
} from "./tmdb.ts";
import { mergeMediaInTx, REVIEW_ALERT_TYPES, type MergeMediaResult } from "./tmdb-sync.ts";

export interface VerifyAndAutoMergeDuplicateInput {
  mediaIdA: string;
  mediaIdB: string;
  actorUserId: string | null;
  reason: string;
  extraTitlesByMediaId?: ReadonlyMap<string, readonly (string | null | undefined)[]>;
  acquireMergeLocks?: boolean;
  now?: Date;
}

export type AutoMergeDuplicateResult =
  | {
      merged: true;
      sourceMediaId: string;
      targetMediaId: string;
      mergeResult: MergeMediaResult;
      matchingExternalIds: Array<{ namespace: ExternalIdNamespace; nativeId: string }>;
      sharedCollections: Array<{ namespace: AssociationNamespaceRow; nativeId: string }>;
    }
  | {
      merged: false;
      blockReason: string;
      sourceMediaId?: string;
      targetMediaId?: string;
      details: Record<string, unknown>;
    };

export interface VerifyAndAutoMergeWithCatalogInput extends Omit<
  VerifyAndAutoMergeDuplicateInput,
  "acquireMergeLocks"
> {
  /** The live catalog association that identified this pair, if applicable. */
  sharedCatalog?: { namespace: AssociationNamespaceRow; nativeId: string };
  outbound?: OutboundClient;
  tmdbConfig?: TmdbGatewayConfig;
  tmdbGateway?: TmdbGateway;
  catalogConfig?: CatalogGatewayConfig;
}

export interface ConvergeDuplicateMediaOptions {
  actorUserId?: string | null;
  batchSize?: number;
  outbound?: OutboundClient;
  tmdbConfig?: TmdbGatewayConfig;
  tmdbGateway?: TmdbGateway;
  catalogConfig?: CatalogGatewayConfig;
  now?: Date;
}

export interface ConvergeDuplicateMediaResult {
  inspectedPairs: number;
  mergedCount: number;
  skippedCount: number;
  mergedPairs: Array<{ sourceMediaId: string; targetMediaId: string; reason: string }>;
}

type MergeGuard = (
  trx: Transaction<Database>,
  source: MergeCandidateMediaSnapshot,
  target: MergeCandidateMediaSnapshot,
) => Promise<string | null>;

function blocked(blockReason: string) {
  return { merged: false as const, blockReason, details: {} };
}

/**
 * Verifies identity + snapshot compatibility and executes `mergeMediaInTx` atomically
 * when two media are confirmed duplicates.
 */
export async function verifyAndAutoMergeDuplicateMediaInTx(
  trx: Transaction<Database>,
  input: VerifyAndAutoMergeDuplicateInput,
  guard?: MergeGuard,
): Promise<AutoMergeDuplicateResult> {
  const now = input.now ?? new Date();
  const eligibility = await verifyAutoMergeEligibilityInTx(trx, {
    mediaIdA: input.mediaIdA,
    mediaIdB: input.mediaIdB,
    extraTitlesByMediaId: input.extraTitlesByMediaId,
    acquireMergeLocks: input.acquireMergeLocks,
  });

  if (!eligibility.eligible) {
    return {
      merged: false,
      blockReason: eligibility.blockReason,
      ...(eligibility.sourceMediaId !== undefined
        ? { sourceMediaId: eligibility.sourceMediaId }
        : {}),
      ...(eligibility.targetMediaId !== undefined
        ? { targetMediaId: eligibility.targetMediaId }
        : {}),
      details: eligibility.details,
    };
  }

  const reason = await guard?.(trx, eligibility.source, eligibility.target);
  if (reason) return blocked(reason);

  const mergeResult = await mergeMediaInTx(trx, {
    sourceMediaId: eligibility.sourceMediaId,
    targetMediaId: eligibility.targetMediaId,
    actorUserId: input.actorUserId,
    reason: input.reason,
    now,
  });

  await fulfillCoveredCatalogDemandsInTx(trx, {
    mediaId: mergeResult.targetMediaId,
    now,
  });

  return {
    merged: true,
    sourceMediaId: mergeResult.sourceMediaId,
    targetMediaId: mergeResult.targetMediaId,
    mergeResult,
    matchingExternalIds: eligibility.matchingExternalIds,
    sharedCollections: eligibility.sharedCollections,
  };
}

function attemptAutoMerge(db: Db, input: VerifyAndAutoMergeDuplicateInput, guard?: MergeGuard) {
  const tx = db.transaction();
  return (guard ? tx.setIsolationLevel("repeatable read") : tx)
    .execute((trx) => verifyAndAutoMergeDuplicateMediaInTx(trx, input, guard))
    .catch((error: unknown) => {
      // A concurrent change to evidence can abort a locking read. Don't abandon the rest of the batch.
      if (
        guard &&
        error instanceof Error &&
        "code" in error &&
        (error.code === "40001" || error.code === "40P01")
      ) {
        return blocked("concurrent_update");
      }
      throw error;
    });
}

/** Finds all active unmerged media sharing any active catalog (`douban` / `bangumi`) collection with `mediaId`. */
export async function findSharedCatalogDuplicateMediaIdsInTx(
  trx: Transaction<Database>,
  mediaId: string,
): Promise<Array<{ otherMediaId: string; namespace: AssociationNamespaceRow; nativeId: string }>> {
  const canonicalId = await resolveCanonicalMediaIdInTx(trx, mediaId);
  if (!canonicalId) {
    return [];
  }

  const ownCatalogRows = await trx
    .selectFrom("associations")
    .where("is_external_id", "=", false)
    .select(["namespace", "native_id"])
    .where("media_id", "=", canonicalId)
    .where("namespace", "in", ["douban", "bangumi"])
    .where("status", "in", ["confirmed", "seed_unconfirmed"])
    .where("needs_review", "=", false)
    .execute();

  if (ownCatalogRows.length === 0) {
    return [];
  }

  const results: Array<{
    otherMediaId: string;
    namespace: AssociationNamespaceRow;
    nativeId: string;
  }> = [];
  const seenMedia = new Set<string>([canonicalId]);

  for (const row of ownCatalogRows) {
    const sharedRows = await trx
      .selectFrom("associations as a")
      .innerJoin("media as m", "m.id", "a.media_id")
      .where("a.is_external_id", "=", false)
      .where("a.namespace", "=", row.namespace)
      .where("a.native_id", "=", row.native_id)
      .where("a.status", "in", ["confirmed", "seed_unconfirmed"])
      .where("a.needs_review", "=", false)
      .where("m.merged_into_media_id", "is", null)
      .where("m.id", "!=", canonicalId)
      .select("m.id as media_id")
      .orderBy("m.created_at", "asc")
      .orderBy("m.id", "asc")
      .execute();

    for (const shared of sharedRows) {
      if (!seenMedia.has(shared.media_id)) {
        seenMedia.add(shared.media_id);
        results.push({
          otherMediaId: shared.media_id,
          namespace: row.namespace,
          nativeId: row.native_id,
        });
      }
    }
  }

  return results;
}

async function fetchExtraAliasesForMerge(
  db: Db,
  options: VerifyAndAutoMergeWithCatalogInput,
  outbound: OutboundClient,
): Promise<Map<string, string[]>> {
  const { mediaIdA, mediaIdB } = options;
  const catalogConfig = {
    ...options.catalogConfig,
    tmdb: options.tmdbConfig ?? options.catalogConfig?.tmdb,
    tmdbGateway: options.tmdbGateway ?? options.catalogConfig?.tmdbGateway,
  };
  const extra = new Map<string, string[]>();
  const loaded = await db.transaction().execute(async (trx) => {
    const [snapA, snapB] = await Promise.all([
      loadMediaMergeCandidateSnapshotInTx(trx, mediaIdA),
      loadMediaMergeCandidateSnapshotInTx(trx, mediaIdB),
    ]);
    if (!snapA || !snapB) {
      return null;
    }
    const tmdbItems: Array<{ key: string; mediaIds: string[] }> = [];
    const tmdbA = snapA.externalIds.find((e) => e.namespace === "tmdb");
    const tmdbB = snapB.externalIds.find((e) => e.namespace === "tmdb");
    if (tmdbA) {
      tmdbItems.push({
        key: formatExternalKey({ namespace: "tmdb", nativeId: tmdbA.nativeId }),
        mediaIds: [snapA.id],
      });
    }
    if (tmdbB && (!tmdbA || tmdbB.nativeId !== tmdbA.nativeId)) {
      tmdbItems.push({
        key: formatExternalKey({ namespace: "tmdb", nativeId: tmdbB.nativeId }),
        mediaIds: [snapB.id],
      });
    }

    const sharedCatalogKeys: string[] = [];
    const seenShared = new Set<string>();
    for (const aAssoc of snapA.associations) {
      if (
        !isCatalogNamespace(aAssoc.namespace) ||
        (options.sharedCatalog &&
          (aAssoc.namespace !== options.sharedCatalog.namespace ||
            aAssoc.nativeId !== options.sharedCatalog.nativeId))
      ) {
        continue;
      }
      if (
        snapB.associations.some(
          (bAssoc) => bAssoc.namespace === aAssoc.namespace && bAssoc.nativeId === aAssoc.nativeId,
        )
      ) {
        const key = formatExternalKey({ namespace: aAssoc.namespace, nativeId: aAssoc.nativeId });
        if (!seenShared.has(key)) {
          seenShared.add(key);
          sharedCatalogKeys.push(key);
        }
      }
    }
    return { snapA, snapB, tmdbItems, sharedCatalogKeys };
  });

  if (!loaded) {
    return extra;
  }

  const resolveTitles = (target: {
    snapshot: { title: string; originalTitle: string | null };
    evidence: unknown;
  }): string[] => {
    const ev = target.evidence as {
      aliases?: string[];
      title?: string;
      originalTitle?: string | null;
    };
    return [
      target.snapshot.title,
      target.snapshot.originalTitle,
      ev?.title,
      ev?.originalTitle,
      ...(Array.isArray(ev?.aliases) ? ev.aliases : []),
    ].filter((t): t is string => typeof t === "string" && t.trim().length > 0);
  };

  // 1. Fetch each media's own authoritative TMDB titles first so they belong strictly to that media.
  for (const item of loaded.tmdbItems) {
    try {
      const resolved = await resolveCatalogTargetSnapshot(item.key, outbound, catalogConfig);
      if (resolved.status !== "found") {
        continue;
      }
      const titles = resolveTitles(resolved.target);
      for (const mediaId of item.mediaIds) {
        const list = extra.get(mediaId) ?? [];
        list.push(...titles);
        extra.set(mediaId, list);
      }
    } catch {
      // Best-effort alias enrichment only; verification still rejects safely if aliases are unavailable.
    }
  }

  // 2. For shared catalog entries (including seed_unconfirmed), attribute fetched titles to a side
  //    ONLY when that side independently verifies against the fetched entry (type, year, non-conflicting
  //    external IDs, and either title/alias overlap or matching external ID).
  const attributeSharedIfMatched = (
    snap: MergeCandidateMediaSnapshot,
    resolvedTarget: Parameters<typeof doesCatalogTargetMatchMediaSnapshot>[2],
    titles: readonly string[],
  ) => {
    const ownAliases = extra.get(snap.id) ?? [];
    if (doesCatalogTargetMatchMediaSnapshot(snap, ownAliases, resolvedTarget)) {
      extra.set(snap.id, [...ownAliases, ...titles]);
    }
  };

  for (const key of loaded.sharedCatalogKeys) {
    try {
      const resolved = await resolveCatalogTargetSnapshot(key, outbound, catalogConfig);
      if (resolved.status !== "found") {
        continue;
      }
      const titles = resolveTitles(resolved.target);
      const catalogTarget = {
        type: resolved.target.type,
        snapshot: resolved.target.snapshot,
        externalIds: resolved.target.externalIds,
        aliases: titles,
      };
      attributeSharedIfMatched(loaded.snapA, catalogTarget, titles);
      attributeSharedIfMatched(loaded.snapB, catalogTarget, titles);
    } catch {
      // Best-effort alias enrichment only; verification still rejects safely if aliases are unavailable.
    }
  }

  return extra;
}

/**
 * Runs auto-merge verification + execution inside a transaction, falling back to best-effort
 * catalog/TMDB alias fetching outside lock if DB-only titles miss localized translations.
 */
export async function verifyAndAutoMergeDuplicateMedia(
  db: Db,
  input: VerifyAndAutoMergeWithCatalogInput,
): Promise<AutoMergeDuplicateResult> {
  const group = input.sharedCatalog;
  const guard: MergeGuard | undefined =
    group &&
    (async (trx) => {
      const coverage = await trx
        .selectFrom("associations as a")
        .innerJoin("media as m", "m.id", "a.media_id")
        .select("m.id")
        .where("m.id", "in", [input.mediaIdA, input.mediaIdB])
        .where("m.merged_into_media_id", "is", null)
        .where("a.is_external_id", "=", false)
        .where("a.namespace", "=", group.namespace)
        .where("a.native_id", "=", group.nativeId)
        .where("a.status", "in", ["confirmed", "seed_unconfirmed"])
        .where("a.needs_review", "=", false)
        .orderBy("m.id")
        .forUpdate()
        .execute();
      return new Set(coverage.map((row) => row.id)).size === 2 ? null : "stale_merge_evidence";
    });
  const attempt = (extraTitlesByMediaId = input.extraTitlesByMediaId) =>
    attemptAutoMerge(db, { ...input, extraTitlesByMediaId }, guard);
  const firstAttempt = await attempt();

  if (
    firstAttempt.merged ||
    !input.outbound ||
    (firstAttempt.blockReason !== "title_mismatch" && firstAttempt.blockReason !== "missing_titles")
  ) {
    return firstAttempt;
  }

  const fetchedAliases = await fetchExtraAliasesForMerge(db, input, input.outbound);
  if (fetchedAliases.size === 0) {
    return firstAttempt;
  }

  const combinedTitles = new Map<string, (string | null | undefined)[]>();
  if (input.extraTitlesByMediaId) {
    for (const [k, v] of input.extraTitlesByMediaId.entries()) {
      combinedTitles.set(k, [...v]);
    }
  }
  for (const [k, v] of fetchedAliases.entries()) {
    const existing = combinedTitles.get(k) ?? [];
    combinedTitles.set(k, [...existing, ...v]);
  }

  return attempt(combinedTitles);
}

/**
 * Lightweight pre-submission check for catalog `SEGMENT_OVERLAP`: permits submitting `douban`/`bangumi`
 * onto a target media when every overlapping other media is a plausible duplicate candidate rather than
 * an obviously distinct work.
 */
export async function isPlausibleCatalogDuplicateOverlapForSubmit(
  db: Db,
  input: {
    targetMedia: {
      id: string;
      type: MediaType;
      title: string;
      originalTitle: string | null;
      year: number | null;
      seasons: ReturnType<typeof areMediaSnapshotsCompatibleForAutoMerge> extends never
        ? never
        : Parameters<typeof areMediaSnapshotsCompatibleForAutoMerge>[0]["seasons"];
    } | null;
    targetExternalKey: { namespace: string; nativeId: string } | null;
    overlappingMediaIds: readonly string[];
  },
): Promise<boolean> {
  const uniqueOtherIds = [...new Set(input.overlappingMediaIds)];
  if (uniqueOtherIds.length === 0) {
    return false;
  }

  return db.transaction().execute(async (trx) => {
    for (const otherId of uniqueOtherIds) {
      if (input.targetMedia) {
        const snapOther = await loadMediaMergeCandidateSnapshotInTx(trx, otherId);
        if (!snapOther || snapOther.mergedIntoMediaId !== null) {
          return false;
        }
        const snapTarget = await loadMediaMergeCandidateSnapshotInTx(trx, input.targetMedia.id);
        if (!snapTarget || snapTarget.mergedIntoMediaId !== null) {
          return false;
        }
        if (snapOther.type !== snapTarget.type) {
          return false;
        }
        // Reject immediately if both hold different IDs in TMDB/IMDb/TVDB/Trakt.
        for (const ext of snapOther.externalIds) {
          const targetExt = snapTarget.externalIds.find((t) => t.namespace === ext.namespace);
          if (targetExt && targetExt.nativeId !== ext.nativeId) {
            return false;
          }
        }
        // Check coarse year incompatibility when both years exist cleanly; title mismatch still
        // goes through Evidence Gate + approval (or blocks when DB titles differ incompatibly).
        const yearCompat = areMediaSnapshotsCompatibleForAutoMerge(
          { ...snapTarget, title: "placeholder", originalTitle: null },
          { ...snapOther, title: "placeholder", originalTitle: null },
        );
        if (!yearCompat.compatible) {
          return false;
        }
      } else if (input.targetExternalKey) {
        const snapOther = await loadMediaMergeCandidateSnapshotInTx(trx, otherId);
        if (!snapOther || snapOther.mergedIntoMediaId !== null) {
          return false;
        }
        // If uncreated target is an external ID (e.g. tmdb:tv:203483) and overlapping media
        // already holds a DIFFERENT external ID in that namespace, refuse immediately.
        const existingInTargetNs = snapOther.externalIds.find(
          (e) => e.namespace === input.targetExternalKey!.namespace,
        );
        if (
          existingInTargetNs &&
          existingInTargetNs.nativeId !== input.targetExternalKey.nativeId
        ) {
          return false;
        }
      }
    }
    return true;
  });
}

function parseJsonObject(raw: unknown): JsonObject {
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as JsonObject;
      }
    } catch {
      return {};
    }
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as JsonObject;
  }
  return {};
}

interface AlertRow {
  id: string;
  media_id: string | null;
  details: JsonObject;
}

function parseConflict(row: AlertRow) {
  const d = row.details;
  const other = d.otherMediaId ?? d.conflictingMediaId;
  if (
    !row.media_id ||
    typeof other !== "string" ||
    !isUuid(other) ||
    other === row.media_id ||
    (d.conflictingMediaId !== undefined && d.conflictingMediaId !== other) ||
    typeof d.namespace !== "string" ||
    !isExternalIdNamespace(d.namespace) ||
    typeof d.nativeId !== "string" ||
    parseCatalogTargetKey(`${d.namespace}:${d.nativeId}`)?.nativeId !== d.nativeId
  ) {
    return null;
  }
  // Exploration starts from the claimant's recorded IMDb; sync starts from its current TMDB ID.
  let imdb: string | null = null;
  if (d.source === "tmdb_sync") {
    if (d.namespace === "tmdb" || d.matchedBy !== undefined) return null;
  } else {
    const match = d.matchedBy;
    if (
      d.source !== undefined ||
      d.namespace === "imdb" ||
      !match ||
      typeof match !== "object" ||
      !("imdb" in match) ||
      typeof match.imdb !== "string" ||
      parseCatalogTargetKey(`imdb:${match.imdb}`)?.nativeId !== match.imdb
    ) {
      return null;
    }
    imdb = match.imdb;
  }
  return { row, mediaId: row.media_id, other, namespace: d.namespace, nativeId: d.nativeId, imdb };
}

type Conflict = NonNullable<ReturnType<typeof parseConflict>>;

// Both ends must still be confirmed on the original, unredirected media. Never follow an old alert to a third work.
async function loadConflictAnchor(db: Db, c: Conflict) {
  const query = db
    .selectFrom("associations as a")
    .innerJoin("media as m", "m.id", "a.media_id")
    .select(["m.id", "m.type", "a.native_id"])
    .where("m.merged_into_media_id", "is", null)
    .where("a.is_external_id", "=", true)
    .where("a.status", "=", "confirmed")
    .where("a.needs_review", "=", false)
    .where((eb) =>
      eb.or([
        eb.and([eb("m.id", "=", c.mediaId), eb("a.namespace", "=", c.imdb ? "imdb" : "tmdb")]),
        eb.and([
          eb("m.id", "=", c.other),
          eb("a.namespace", "=", c.namespace),
          eb("a.native_id", "=", c.nativeId),
        ]),
      ]),
    )
    .orderBy("m.id");
  const rows = await (db.isTransaction ? query.forUpdate() : query).execute();
  const anchor = rows.find((r) => r.id === c.mediaId);
  return rows.some((r) => r.id === c.other) && anchor && (!c.imdb || anchor.native_id === c.imdb)
    ? anchor
    : null;
}

function sameAlert(row: AlertRow) {
  return sql<boolean>`id = ${row.id} and status = 'open' and alert_type = ${REVIEW_ALERT_TYPES.AGENT_EXTERNAL_ID_CONFLICT}
    and media_id is not distinct from ${row.media_id}::uuid and details = ${JSON.stringify(row.details)}::jsonb`;
}

async function recheckConflict(
  db: Db,
  c: Conflict,
  input: VerifyAndAutoMergeDuplicateInput,
  gateway: TmdbGateway | undefined,
) {
  const anchor = await loadConflictAnchor(db, c);
  if (!anchor) return blocked("stale_merge_evidence");
  if (!gateway) return blocked("tmdb_gateway_unavailable");

  let fetched;
  try {
    let tmdb = parseTmdbNativeId(anchor.native_id);
    if (c.imdb) {
      const hits = (await gateway.findByImdbId(c.imdb)).filter((hit) => hit.type === anchor.type);
      tmdb = hits.length === 1 ? hits[0]! : null;
    }
    if (!tmdb || tmdb.type !== anchor.type) return blocked("stale_merge_evidence");
    const key = `${tmdb.type}:${tmdb.id}`;
    if (c.namespace === "tmdb" && key !== c.nativeId) return blocked("stale_merge_evidence");
    fetched = await gateway.fetchMediaSnapshotAndExternalIds(tmdb.type, tmdb.id);
    if (!fetched || fetched.type !== anchor.type || fetched.externalIds.tmdb !== key) {
      return blocked("stale_merge_evidence");
    }
    // Secondary ID lookups can be unavailable even when the TMDB detail request succeeded.
    if (!fetched.externalIds[c.namespace] || (c.imdb && !fetched.externalIds.imdb)) {
      return blocked("incomplete_catalog_evidence");
    }
    if (
      fetched.externalIds[c.namespace] !== c.nativeId ||
      (c.imdb && fetched.externalIds.imdb !== c.imdb)
    ) {
      return blocked("stale_merge_evidence");
    }
  } catch {
    return blocked("tmdb_lookup_failed");
  }

  const evidence = buildCatalogTargetSnapshotFromTmdb(fetched);
  return attemptAutoMerge(
    db,
    {
      ...input,
      extraTitlesByMediaId: new Map([
        [c.imdb ? c.other : c.mediaId, [evidence.snapshot.title, evidence.snapshot.originalTitle]],
      ]),
    },
    async (trx, source, target) => {
      const current = await loadConflictAnchor(trx, c);
      if (
        current?.native_id !== anchor.native_id ||
        current.type !== anchor.type ||
        !(await trx
          .selectFrom("review_alerts")
          .select("id")
          .where(sameAlert(c.row))
          .forUpdate()
          .executeTakeFirst())
      ) {
        return "stale_merge_evidence";
      }
      if (
        (!c.imdb && target.id !== c.mediaId) ||
        ![source, target].every((snap) => doesCatalogTargetMatchMediaSnapshot(snap, [], evidence))
      ) {
        return "conflicting_catalog_evidence";
      }
      return null;
    },
  );
}

export const DUPLICATE_CONVERGENCE_SYNC_KEY = "duplicate_convergence";

interface CatalogConvergenceCursor {
  namespace: "douban" | "bangumi";
  nativeId: string;
  lastMediaIdA: string | null;
  lastMediaIdB: string | null;
}

function parseCatalogConvergenceCursor(metadata: unknown): CatalogConvergenceCursor | null {
  const obj = parseJsonObject(metadata);
  const raw = obj.catalogCursor;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const rec = raw as Record<string, unknown>;
  if (
    (rec.namespace === "douban" || rec.namespace === "bangumi") &&
    typeof rec.nativeId === "string" &&
    rec.nativeId.length > 0
  ) {
    const lastMediaIdA =
      typeof rec.lastMediaIdA === "string" && rec.lastMediaIdA.length > 0 ? rec.lastMediaIdA : null;
    const lastMediaIdB =
      lastMediaIdA !== null && typeof rec.lastMediaIdB === "string" && rec.lastMediaIdB.length > 0
        ? rec.lastMediaIdB
        : null;
    return { namespace: rec.namespace, nativeId: rec.nativeId, lastMediaIdA, lastMediaIdB };
  }
  return null;
}

async function fetchDuplicateCatalogGroups(
  db: Db,
  limit: number,
  afterCursor: CatalogConvergenceCursor | null,
): Promise<Array<{ namespace: AssociationNamespaceRow; native_id: string }>> {
  if (limit <= 0) {
    return [];
  }
  let query = db
    .selectFrom("associations as a")
    .innerJoin("media as m", "m.id", "a.media_id")
    .where("a.is_external_id", "=", false)
    .where("a.namespace", "in", ["douban", "bangumi"])
    .where("a.status", "in", ["confirmed", "seed_unconfirmed"])
    .where("a.needs_review", "=", false)
    .where("m.merged_into_media_id", "is", null);

  if (afterCursor) {
    const inclusiveCurrentGroup = afterCursor.lastMediaIdA !== null;
    query = query.where((eb) =>
      eb.or([
        eb("a.namespace", ">", afterCursor.namespace),
        eb.and([
          eb("a.namespace", "=", afterCursor.namespace),
          eb("a.native_id", inclusiveCurrentGroup ? ">=" : ">", afterCursor.nativeId),
        ]),
      ]),
    );
  }

  return query
    .select(["a.namespace", "a.native_id"])
    .groupBy(["a.namespace", "a.native_id"])
    .having(sql<number>`count(distinct a.media_id)`, ">", 1)
    .orderBy("a.namespace", "asc")
    .orderBy("a.native_id", "asc")
    .limit(limit)
    .execute();
}

/**
 * Idempotent background sweep converging existing unmerged canonical duplicates sharing
 * active `douban`/`bangumi` entries or open `agent_external_id_conflict` alerts.
 * Advances a keyset cursor in `sync_state` past blocked catalog groups and reserves
 * capacity for due conflict alerts so blocked pairs cannot starve later groups or alerts.
 */
export async function convergeDuplicateMedia(
  db: Db,
  options: ConvergeDuplicateMediaOptions = {},
): Promise<ConvergeDuplicateMediaResult> {
  const batchSize = Math.min(Math.max(Math.floor(options.batchSize ?? 25), 1), 100);
  const now = options.now ?? new Date();
  const actorUserId = options.actorUserId ?? null;

  const candidatePairs: Array<{
    mediaIdA: string;
    mediaIdB: string;
    reason: string;
    conflict?: Conflict;
    sharedCatalog?: VerifyAndAutoMergeWithCatalogInput["sharedCatalog"];
  }> = [];
  const finishAlert = (db: Db, row: AlertRow, reason: string, resolved: boolean) =>
    db
      .updateTable("review_alerts")
      .where(sameAlert(row))
      .set({
        details: JSON.stringify({ ...row.details, autoMergeBlockedReason: reason }),
        ...(resolved
          ? { status: "resolved" as const, resolved_at: now, resolved_by_user_id: actorUserId }
          : {}),
      })
      .execute();

  const collectOpenAlerts = async (limit: number) => {
    if (limit <= 0) return;
    // Claim before doing I/O: overlapping crons skip in-flight work; a crashed claim expires by itself.
    await db.transaction().execute(async (trx) => {
      const checked = sql<Date | null>`case when details ->> 'autoMergeCheckedAt' ~ '^[0-9]{4}-'
        and pg_input_is_valid(details ->> 'autoMergeCheckedAt', 'timestamptz')
        then (details ->> 'autoMergeCheckedAt')::timestamptz end`;
      // Writers stamp their first attempt without a count. Unchecked historical rows are due immediately.
      const due = sql<Date>`${checked} + case coalesce(details ->> 'autoMergeAttempts', '1')
        when '1' then interval '1 hour' when '2' then interval '6 hours' else interval '24 hours' end`;
      const alerts = await trx
        .selectFrom("review_alerts")
        .select(["id", "media_id", "details"])
        .where("alert_type", "=", REVIEW_ALERT_TYPES.AGENT_EXTERNAL_ID_CONFLICT)
        .where("status", "=", "open")
        .where((eb) =>
          eb.or([
            eb(checked, "is", null),
            eb(due, "<=", now),
            eb(checked, ">", new Date(now.getTime() + 86_400_000)),
          ]),
        )
        .orderBy(checked, (ob) => ob.asc().nullsFirst())
        .orderBy("created_at")
        .orderBy("id")
        .limit(limit)
        .forUpdate()
        .skipLocked()
        .execute();
      for (const row of alerts) {
        const prev = parseJsonObject(row.details);
        const count =
          typeof prev.autoMergeAttempts === "number" &&
          Number.isSafeInteger(prev.autoMergeAttempts) &&
          prev.autoMergeAttempts > 0
            ? prev.autoMergeAttempts
            : prev.autoMergeCheckedAt
              ? 1
              : 0;
        row.details = {
          ...prev,
          autoMergeCheckedAt: now.toISOString(),
          autoMergeAttempts: count + 1,
        };
        await trx
          .updateTable("review_alerts")
          .where("id", "=", row.id)
          .set({ details: JSON.stringify(row.details) })
          .execute();
        const conflict = parseConflict(row);
        if (!conflict) {
          await finishAlert(trx, row, "invalid_alert_target", true);
          continue;
        }
        candidatePairs.push({
          mediaIdA: conflict.mediaId,
          mediaIdB: conflict.other,
          reason: "converge_external_id_conflict_alert",
          conflict,
        });
      }
    });
  };

  // Unchecked alerts come first; eligible retries rotate oldest-check first within this quota.
  const reservedAlertQuota = batchSize === 1 ? 1 : Math.max(1, Math.floor(batchSize / 4));
  await collectOpenAlerts(reservedAlertQuota);

  // Collect pairs sharing an active exclusive catalog (`douban`/`bangumi`) association starting
  // after the persisted keyset cursor, bounded by the remaining pair budget.
  const catalogPairBudget = Math.max(0, batchSize - candidatePairs.length);
  if (catalogPairBudget > 0) {
    const stateRow = await db
      .selectFrom("sync_state")
      .select(["metadata", "updated_at"])
      .where("sync_key", "=", DUPLICATE_CONVERGENCE_SYNC_KEY)
      .executeTakeFirst();
    const initialCursor = stateRow ? parseCatalogConvergenceCursor(stateRow.metadata) : null;

    // Space outbound catalog batches apart, with a longer cooldown before replaying a finished pass.
    const cooling = Boolean(
      options.outbound &&
      stateRow &&
      now.getTime() < new Date(stateRow.updated_at).getTime() + (initialCursor ? 5 : 60) * 60_000,
    );
    let duplicateCatalogGroups = cooling
      ? []
      : await fetchDuplicateCatalogGroups(db, catalogPairBudget, initialCursor);
    if (!options.outbound && initialCursor !== null && duplicateCatalogGroups.length === 0) {
      duplicateCatalogGroups = await fetchDuplicateCatalogGroups(db, catalogPairBudget, null);
    }

    let nextCursor: CatalogConvergenceCursor | null = null;
    let reachedPairLimit = false;

    const addGroupPair = (
      group: { namespace: AssociationNamespaceRow; native_id: string },
      a: string,
      b: string,
    ): boolean => {
      // Different keys for the same pair are independent evidence and each uses one batch slot.
      candidatePairs.push({
        mediaIdA: a,
        mediaIdB: b,
        reason: `converge_shared_catalog:${group.namespace}:${group.native_id}`,
        sharedCatalog: { namespace: group.namespace, nativeId: group.native_id },
      });
      if (candidatePairs.length >= batchSize) {
        nextCursor = {
          namespace: group.namespace as "douban" | "bangumi",
          nativeId: group.native_id,
          lastMediaIdA: a,
          lastMediaIdB: b,
        };
        reachedPairLimit = true;
        return true;
      }
      return false;
    };

    const baseGroupMembersQuery = (group: {
      namespace: AssociationNamespaceRow;
      native_id: string;
    }) =>
      db
        .selectFrom("associations as a")
        .innerJoin("media as m", "m.id", "a.media_id")
        .where("a.is_external_id", "=", false)
        .where("a.namespace", "=", group.namespace)
        .where("a.native_id", "=", group.native_id)
        .where("a.status", "in", ["confirmed", "seed_unconfirmed"])
        .where("a.needs_review", "=", false)
        .where("m.merged_into_media_id", "is", null)
        .select("m.id as media_id")
        .distinct();

    const collectPairsForAnchor = async (
      group: { namespace: AssociationNamespaceRow; native_id: string },
      anchorId: string,
      initialAfterId: string,
    ): Promise<boolean> => {
      let afterId = initialAfterId;
      while (candidatePairs.length < batchSize) {
        const limit = batchSize - candidatePairs.length;
        const partners = await baseGroupMembersQuery(group)
          .where("m.id", ">", afterId)
          .orderBy("m.id", "asc")
          .limit(limit)
          .execute();
        for (const partner of partners) {
          afterId = partner.media_id;
          if (addGroupPair(group, anchorId, partner.media_id)) {
            return true;
          }
        }
        if (partners.length < limit) {
          break;
        }
      }
      return false;
    };

    for (const group of duplicateCatalogGroups) {
      if (candidatePairs.length >= batchSize) {
        reachedPairLimit = true;
        break;
      }

      const isResumingGroup =
        initialCursor !== null &&
        group.namespace === initialCursor.namespace &&
        group.native_id === initialCursor.nativeId &&
        initialCursor.lastMediaIdA !== null;

      const resumeA = isResumingGroup ? initialCursor!.lastMediaIdA : null;
      const resumeB = isResumingGroup ? initialCursor!.lastMediaIdB : null;

      if (resumeA !== null && resumeB !== null) {
        const anchorActive = await baseGroupMembersQuery(group)
          .where("m.id", "=", resumeA)
          .executeTakeFirst();

        if (anchorActive && (await collectPairsForAnchor(group, resumeA, resumeB))) {
          break;
        }
      }

      let afterAnchorId = resumeA;
      while (candidatePairs.length < batchSize) {
        const fetchLimit = batchSize - candidatePairs.length + 1;
        let anchorQuery = baseGroupMembersQuery(group);
        if (afterAnchorId !== null) {
          anchorQuery = anchorQuery.where("m.id", ">", afterAnchorId);
        }
        const anchors = await anchorQuery.orderBy("m.id", "asc").limit(fetchLimit).execute();

        if (anchors.length < 2) {
          break;
        }

        for (let i = 0; i < anchors.length - 1; i += 1) {
          const anchorId = anchors[i]!.media_id;
          afterAnchorId = anchorId;
          if (await collectPairsForAnchor(group, anchorId, anchorId)) {
            break;
          }
        }
        if (reachedPairLimit || anchors.length < fetchLimit) {
          break;
        }
      }
      if (reachedPairLimit) {
        break;
      }
    }

    if (
      !reachedPairLimit &&
      duplicateCatalogGroups.length === catalogPairBudget &&
      duplicateCatalogGroups.length > 0
    ) {
      const lastGroup = duplicateCatalogGroups[duplicateCatalogGroups.length - 1]!;
      nextCursor = {
        namespace: lastGroup.namespace as "douban" | "bangumi",
        nativeId: lastGroup.native_id,
        lastMediaIdA: null,
        lastMediaIdB: null,
      };
    }

    if (
      !cooling &&
      (initialCursor !== null ||
        nextCursor !== null ||
        (options.outbound && duplicateCatalogGroups.length > 0))
    ) {
      const syncDate = now.toISOString().slice(0, 10);
      const serializedMeta = JSON.stringify({
        catalogCursor: nextCursor,
        updatedAt: now.toISOString(),
      });
      await db
        .insertInto("sync_state")
        .values({
          sync_key: DUPLICATE_CONVERGENCE_SYNC_KEY,
          last_synced_date: syncDate,
          metadata: serializedMeta,
          updated_at: now,
        })
        .onConflict((oc) =>
          oc.column("sync_key").doUpdateSet({
            last_synced_date: syncDate,
            metadata: serializedMeta,
            updated_at: now,
          }),
        )
        .execute();
    }
  }

  // Fill any remaining capacity with due conflict alerts.
  if (candidatePairs.length < batchSize) {
    await collectOpenAlerts(batchSize - candidatePairs.length);
  }

  const mergedPairs: ConvergeDuplicateMediaResult["mergedPairs"] = [];
  let skippedCount = 0;

  const gateway =
    options.tmdbGateway ??
    options.catalogConfig?.tmdbGateway ??
    (options.outbound &&
      createTmdbGateway(options.outbound, options.tmdbConfig ?? options.catalogConfig?.tmdb));
  for (const candidate of candidatePairs) {
    const input = { ...candidate, actorUserId, now };
    const outcome = candidate.conflict
      ? await recheckConflict(db, candidate.conflict, input, gateway)
      : await verifyAndAutoMergeDuplicateMedia(db, { ...options, ...input });

    if (outcome.merged) {
      mergedPairs.push({
        sourceMediaId: outcome.sourceMediaId,
        targetMediaId: outcome.targetMediaId,
        reason: candidate.reason,
      });
    } else {
      skippedCount += 1;
      if (candidate.conflict) {
        await finishAlert(
          db,
          candidate.conflict.row,
          outcome.blockReason,
          [
            "stale_merge_evidence",
            "already_same_media",
            "media_not_found",
            "media_already_merged",
          ].includes(outcome.blockReason),
        );
      }
    }
  }

  return {
    inspectedPairs: candidatePairs.length,
    mergedCount: mergedPairs.length,
    skippedCount,
    mergedPairs,
  };
}
