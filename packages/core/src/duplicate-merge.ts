import {
  formatExternalKey,
  isCatalogNamespace,
  type ExternalIdNamespace,
  type MediaType,
} from "@media-ref/client";
import type { AssociationNamespaceRow, Database, Db, JsonObject } from "@media-ref/db";
import { sql, type Transaction } from "kysely";
import { resolveCatalogTargetSnapshot, type CatalogGatewayConfig } from "./catalog-gateway.ts";
import {
  areMediaSnapshotsCompatibleForAutoMerge,
  loadMediaMergeCandidateSnapshotInTx,
  resolveCanonicalMediaIdInTx,
  verifyAutoMergeEligibilityInTx,
} from "./duplicate-merge-policy.ts";
import { fulfillCoveredCatalogDemandsInTx } from "./demands.ts";
import type { OutboundClient } from "./outbound.ts";
import type { TmdbGateway, TmdbGatewayConfig } from "./tmdb.ts";
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

/**
 * Verifies identity + snapshot compatibility and executes `mergeMediaInTx` atomically
 * when two media are confirmed duplicates.
 */
export async function verifyAndAutoMergeDuplicateMediaInTx(
  trx: Transaction<Database>,
  input: VerifyAndAutoMergeDuplicateInput,
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
  mediaIdA: string,
  mediaIdB: string,
  outbound: OutboundClient,
  options: {
    tmdbConfig?: TmdbGatewayConfig;
    tmdbGateway?: TmdbGateway;
    catalogConfig?: CatalogGatewayConfig;
  },
): Promise<Map<string, string[]>> {
  const extra = new Map<string, string[]>();
  const keysToFetch = await db.transaction().execute(async (trx) => {
    const [snapA, snapB] = await Promise.all([
      loadMediaMergeCandidateSnapshotInTx(trx, mediaIdA),
      loadMediaMergeCandidateSnapshotInTx(trx, mediaIdB),
    ]);
    if (!snapA || !snapB) {
      return [];
    }
    const items: Array<{ key: string; mediaIds: string[] }> = [];
    const tmdbA = snapA.externalIds.find((e) => e.namespace === "tmdb");
    const tmdbB = snapB.externalIds.find((e) => e.namespace === "tmdb");
    if (tmdbA) {
      items.push({
        key: formatExternalKey({ namespace: "tmdb", nativeId: tmdbA.nativeId }),
        mediaIds: [snapA.id],
      });
    }
    if (tmdbB && (!tmdbA || tmdbB.nativeId !== tmdbA.nativeId)) {
      items.push({
        key: formatExternalKey({ namespace: "tmdb", nativeId: tmdbB.nativeId }),
        mediaIds: [snapB.id],
      });
    }
    for (const aAssoc of snapA.associations) {
      if (!isCatalogNamespace(aAssoc.namespace)) {
        continue;
      }
      if (
        snapB.associations.some(
          (bAssoc) => bAssoc.namespace === aAssoc.namespace && bAssoc.nativeId === aAssoc.nativeId,
        )
      ) {
        items.push({
          key: formatExternalKey({ namespace: aAssoc.namespace, nativeId: aAssoc.nativeId }),
          mediaIds: [snapA.id, snapB.id],
        });
      }
    }
    return items;
  });

  for (const item of keysToFetch) {
    try {
      const resolved = await resolveCatalogTargetSnapshot(item.key, outbound, {
        ...options.catalogConfig,
        ...(options.tmdbConfig ? { tmdb: options.tmdbConfig } : {}),
        ...(options.tmdbGateway ? { tmdbGateway: options.tmdbGateway } : {}),
      });
      if (resolved.status !== "found") {
        continue;
      }
      const ev = resolved.target.evidence as {
        aliases?: string[];
        title?: string;
        originalTitle?: string | null;
      };
      const titles = [
        resolved.target.snapshot.title,
        resolved.target.snapshot.originalTitle,
        ev?.title,
        ev?.originalTitle,
        ...(Array.isArray(ev?.aliases) ? ev.aliases : []),
      ].filter((t): t is string => typeof t === "string" && t.trim().length > 0);
      for (const mediaId of item.mediaIds) {
        const list = extra.get(mediaId) ?? [];
        list.push(...titles);
        extra.set(mediaId, list);
      }
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
  const firstAttempt = await db.transaction().execute((trx) =>
    verifyAndAutoMergeDuplicateMediaInTx(trx, {
      mediaIdA: input.mediaIdA,
      mediaIdB: input.mediaIdB,
      actorUserId: input.actorUserId,
      reason: input.reason,
      extraTitlesByMediaId: input.extraTitlesByMediaId,
      now: input.now,
    }),
  );

  if (
    firstAttempt.merged ||
    !input.outbound ||
    (firstAttempt.blockReason !== "title_mismatch" && firstAttempt.blockReason !== "missing_titles")
  ) {
    return firstAttempt;
  }

  const fetchedAliases = await fetchExtraAliasesForMerge(
    db,
    input.mediaIdA,
    input.mediaIdB,
    input.outbound,
    {
      tmdbConfig: input.tmdbConfig,
      tmdbGateway: input.tmdbGateway,
      catalogConfig: input.catalogConfig,
    },
  );
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

  return db.transaction().execute((trx) =>
    verifyAndAutoMergeDuplicateMediaInTx(trx, {
      mediaIdA: input.mediaIdA,
      mediaIdB: input.mediaIdB,
      actorUserId: input.actorUserId,
      reason: input.reason,
      extraTitlesByMediaId: combinedTitles,
      now: input.now,
    }),
  );
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

/**
 * Idempotent background sweep converging existing unmerged canonical duplicates sharing
 * active `douban`/`bangumi` entries or open `agent_external_id_conflict` alerts.
 */
export async function convergeDuplicateMedia(
  db: Db,
  options: ConvergeDuplicateMediaOptions = {},
): Promise<ConvergeDuplicateMediaResult> {
  const batchSize = Math.min(Math.max(Math.floor(options.batchSize ?? 25), 1), 100);
  const now = options.now ?? new Date();
  const actorUserId = options.actorUserId ?? null;

  // 1. Collect pairs sharing an active exclusive catalog (`douban`/`bangumi`) association.
  const duplicateCatalogGroups = await db
    .selectFrom("associations as a")
    .innerJoin("media as m", "m.id", "a.media_id")
    .where("a.is_external_id", "=", false)
    .where("a.namespace", "in", ["douban", "bangumi"])
    .where("a.status", "in", ["confirmed", "seed_unconfirmed"])
    .where("m.merged_into_media_id", "is", null)
    .select(["a.namespace", "a.native_id"])
    .groupBy(["a.namespace", "a.native_id"])
    .having(sql<number>`count(distinct a.media_id)`, ">", 1)
    .orderBy("a.namespace", "asc")
    .orderBy("a.native_id", "asc")
    .limit(batchSize)
    .execute();

  const candidatePairs: Array<{
    mediaIdA: string;
    mediaIdB: string;
    reason: string;
    alertId?: string;
  }> = [];
  const seenPairs = new Set<string>();

  for (const group of duplicateCatalogGroups) {
    const members = await db
      .selectFrom("associations as a")
      .innerJoin("media as m", "m.id", "a.media_id")
      .where("a.is_external_id", "=", false)
      .where("a.namespace", "=", group.namespace)
      .where("a.native_id", "=", group.native_id)
      .where("a.status", "in", ["confirmed", "seed_unconfirmed"])
      .where("m.merged_into_media_id", "is", null)
      .select("m.id as media_id")
      .distinct()
      .orderBy("m.id", "asc")
      .execute();

    if (members.length < 2) {
      continue;
    }
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        const a = members[i]!.media_id;
        const b = members[j]!.media_id;
        const pairKey = [a, b].sort().join(":");
        if (!seenPairs.has(pairKey)) {
          seenPairs.add(pairKey);
          candidatePairs.push({
            mediaIdA: a,
            mediaIdB: b,
            reason: `converge_shared_catalog:${group.namespace}:${group.native_id}`,
          });
        }
      }
    }
  }

  // 2. Also inspect unchecked open `agent_external_id_conflict` alerts pointing between active media.
  if (candidatePairs.length < batchSize) {
    const openAlerts = await db
      .selectFrom("review_alerts")
      .select(["id", "media_id", "details"])
      .where("alert_type", "=", REVIEW_ALERT_TYPES.AGENT_EXTERNAL_ID_CONFLICT)
      .where("status", "=", "open")
      .where("media_id", "is not", null)
      .where(sql<boolean>`coalesce(details ->> 'autoMergeCheckedAt', '') = ''`)
      .orderBy("created_at", "asc")
      .limit(batchSize - candidatePairs.length)
      .execute();

    for (const alert of openAlerts) {
      if (!alert.media_id) {
        continue;
      }
      const details = parseJsonObject(alert.details);
      const otherMediaId =
        typeof details.otherMediaId === "string"
          ? details.otherMediaId
          : typeof details.conflictingMediaId === "string"
            ? details.conflictingMediaId
            : null;
      if (!otherMediaId || otherMediaId === alert.media_id) {
        continue;
      }
      const pairKey = [alert.media_id, otherMediaId].sort().join(":");
      if (!seenPairs.has(pairKey)) {
        seenPairs.add(pairKey);
        candidatePairs.push({
          mediaIdA: alert.media_id,
          mediaIdB: otherMediaId,
          reason: "converge_external_id_conflict_alert",
          alertId: alert.id,
        });
      }
    }
  }

  const mergedPairs: ConvergeDuplicateMediaResult["mergedPairs"] = [];
  let skippedCount = 0;

  for (const candidate of candidatePairs) {
    const outcome = await verifyAndAutoMergeDuplicateMedia(db, {
      mediaIdA: candidate.mediaIdA,
      mediaIdB: candidate.mediaIdB,
      actorUserId,
      reason: candidate.reason,
      outbound: options.outbound,
      tmdbConfig: options.tmdbConfig,
      tmdbGateway: options.tmdbGateway,
      catalogConfig: options.catalogConfig,
      now,
    });

    if (outcome.merged) {
      mergedPairs.push({
        sourceMediaId: outcome.sourceMediaId,
        targetMediaId: outcome.targetMediaId,
        reason: candidate.reason,
      });
    } else {
      skippedCount += 1;
      if (candidate.alertId) {
        const existing = await db
          .selectFrom("review_alerts")
          .select(["id", "details"])
          .where("id", "=", candidate.alertId)
          .where("status", "=", "open")
          .executeTakeFirst();
        if (existing) {
          const prev = parseJsonObject(existing.details);
          await db
            .updateTable("review_alerts")
            .set({
              details: JSON.stringify({
                ...prev,
                autoMergeCheckedAt: now.toISOString(),
                autoMergeBlockedReason: outcome.blockReason,
              }),
            })
            .where("id", "=", existing.id)
            .execute();
        }
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
