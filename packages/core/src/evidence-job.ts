import {
  formatExternalKey,
  type CatalogNamespace,
  type NormalizedSegment,
} from "@media-ref/client";
import type { Database, Db, ExternalIdNamespaceRow, JsonObject } from "@media-ref/db";
import { sql, type Transaction } from "kysely";
import {
  createDefaultAdapterRegistry,
  isTier2Adapter,
  type AdapterRegistry,
} from "./adapters/index.ts";
import {
  CATALOG_EVIDENCE_PRIORITY,
  parseCatalogTargetKey,
  resolveCatalogTargetSnapshot,
  type CatalogGatewayConfig,
  type CatalogTargetSnapshot,
} from "./catalog-gateway.ts";
import {
  CONFLICT_REASONS,
  evaluateEvidenceCheckConflict,
  findConflictingAssociations,
  recordLockedAssociationAlertInTx,
} from "./conflict-resolution.ts";
import {
  evaluateEvidenceGate,
  type CatalogEvidence,
  type EvidenceGateStep2Evaluator,
} from "./evidence-gate.ts";
import { enqueueJob, type JobExecutionOutcome, type JobHandler } from "./jobs.ts";
import {
  approveChangeRequestInTransaction,
  EVIDENCE_CHECK_JOB_TYPE,
  getChangeRequestById,
  isUuid,
  MediaServiceError,
  TIER1_MANUAL_REVIEW_REASON,
} from "./media-service.ts";
import { enqueueReviewAgentJobInTx } from "./review-agent.ts";
import {
  createTmdbGateway,
  parseTmdbNativeId,
  type TmdbGateway,
  type TmdbGatewayConfig,
} from "./tmdb.ts";

export interface EvidenceCheckJobOptions {
  adapterRegistry?: AdapterRegistry;
  catalogConfig?: CatalogGatewayConfig;
  tmdbConfig?: TmdbGatewayConfig;
  tmdbGateway?: TmdbGateway;
  evaluateStep2?: EvidenceGateStep2Evaluator;
}

/** TMDB air year per episode, for the seasons a segment starts partway through. */
async function fetchSegmentEpisodeAirYears(
  gateway: TmdbGateway,
  catalog: CatalogEvidence,
  segments: readonly NormalizedSegment[],
): Promise<CatalogEvidence["episodeAirYears"]> {
  const tmdb = catalog.namespace === "tmdb" ? parseTmdbNativeId(catalog.canonicalId) : null;
  if (tmdb?.type !== "tv") {
    return undefined;
  }
  const result: Record<number, Record<number, number | null>> = {};
  for (const season of new Set(segments.filter((s) => s.episodeStart > 1).map((s) => s.season))) {
    try {
      const episodes = await gateway.fetchSeasonEpisodes(tmdb.id, season);
      if (episodes) {
        result[season] = Object.fromEntries(
          episodes.map((e) => [e.episode, e.airDate ? Number(e.airDate.slice(0, 4)) : null]),
        );
      }
    } catch {
      // Without episode air years the gate compares against the season premiere year, as before
    }
  }
  return result;
}

interface MarkNeedsReviewInput {
  changeRequestId: string;
  evidence: JsonObject | null;
  conflictReason: string;
  decisionReason: string;
  now: Date;
}

function mergeEvidenceWithExistingMetadata(
  existingEvidence: JsonObject | null,
  nextEvidence: JsonObject,
  replacesAssociationId: string | null,
): JsonObject {
  return {
    ...existingEvidence,
    ...nextEvidence,
    ...(replacesAssociationId !== null ? { replacesAssociationId } : {}),
  };
}

/**
 * Marks the request `needs_review` and queues its review in the same transaction: every request
 * that turns `needs_review` is decided by the review agent, never left waiting (CONSTITUTION.md).
 * Returns whether the request was still `pending_evidence` and is now `needs_review`.
 */
async function markChangeRequestNeedsReviewInTx(
  trx: Transaction<Database>,
  input: MarkNeedsReviewInput,
): Promise<boolean> {
  const result = await trx
    .updateTable("change_requests")
    .set({
      status: "needs_review",
      evidence: input.evidence !== null ? JSON.stringify(input.evidence) : null,
      conflict_reason: input.conflictReason,
      decision_reason: input.decisionReason,
      updated_at: input.now,
    })
    .where("id", "=", input.changeRequestId)
    .where("status", "=", "pending_evidence")
    .executeTakeFirst();
  const marked = result.numUpdatedRows > 0n;
  if (marked) {
    await enqueueReviewAgentJobInTx(trx, {
      changeRequestId: input.changeRequestId,
      now: input.now,
    });
  }
  return marked;
}

const MAX_PENDING_EVIDENCE_AGE_MS = 24 * 60 * 60_000;

export async function enqueuePendingEvidenceChecks(db: Db, { now }: { now: Date }): Promise<void> {
  const cutoff = new Date(now.getTime() - MAX_PENDING_EVIDENCE_AGE_MS);
  await db.transaction().execute(async (trx) => {
    const requests = await trx
      .selectFrom("change_requests")
      .select(["id", "created_at", "evidence"])
      .where("status", "=", "pending_evidence")
      .where((eb) =>
        eb.or([
          eb("created_at", "<", cutoff),
          eb.not(
            eb.exists(
              eb
                .selectFrom("background_jobs")
                .select("id")
                .where("status", "in", ["pending", "leased"])
                .where(
                  "dedupe_key",
                  "=",
                  sql<string>`${EVIDENCE_CHECK_JOB_TYPE} || ':' || change_requests.id::text`,
                ),
            ),
          ),
        ]),
      )
      .orderBy("created_at")
      .limit(50)
      .forUpdate()
      .skipLocked()
      .execute();
    for (const request of requests) {
      if (request.created_at < cutoff) {
        await markChangeRequestNeedsReviewInTx(trx, {
          changeRequestId: request.id,
          evidence: { ...request.evidence, evidenceTimedOutAt: now.toISOString() },
          conflictReason: "catalog_not_found",
          decisionReason: "Evidence could not be verified before the deadline",
          now,
        });
      } else {
        await enqueueJob(trx, {
          jobType: EVIDENCE_CHECK_JOB_TYPE,
          payload: { changeRequestId: request.id },
          dedupeKey: `${EVIDENCE_CHECK_JOB_TYPE}:${request.id}`,
          runAfter: now,
        });
      }
    }
  });
}

async function resolveAuthoritativeCatalogKey(
  db: Db,
  mediaId: string | null,
  targetExternalKey: string,
): Promise<string | null> {
  if (mediaId) {
    const [extRows, catalogAssocRows] = await Promise.all([
      db
        .selectFrom("associations")
        .where("is_external_id", "=", true)
        .select(["namespace", "native_id"])
        .where("media_id", "=", mediaId)
        .$narrowType<{ namespace: ExternalIdNamespaceRow }>()
        .execute(),
      db
        .selectFrom("associations")
        .where("is_external_id", "=", false)
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
  }

  const parsedTarget = parseCatalogTargetKey(targetExternalKey);
  return parsedTarget ? parsedTarget.canonicalKey : null;
}

export function createEvidenceCheckJobHandler(options: EvidenceCheckJobOptions = {}): JobHandler {
  const adapterRegistry = options.adapterRegistry ?? createDefaultAdapterRegistry();

  return async (ctx): Promise<JobExecutionOutcome> => {
    const rawChangeRequestId = ctx.job.payload.changeRequestId;
    if (typeof rawChangeRequestId !== "string" || !isUuid(rawChangeRequestId)) {
      return {
        status: "failed",
        errorMessage: "evidence_check job payload requires a valid changeRequestId UUID",
      };
    }

    const changeRequest = await getChangeRequestById(ctx.db, rawChangeRequestId);
    if (!changeRequest) {
      return {
        status: "completed",
        result: {
          changeRequestId: rawChangeRequestId,
          skipped: true,
          reason: "change_request_not_found",
        },
      };
    }

    if (changeRequest.status !== "pending_evidence") {
      return {
        status: "completed",
        result: {
          changeRequestId: changeRequest.id,
          skipped: true,
          reason: `change_request_already_${changeRequest.status}`,
        },
      };
    }

    const checkedAt = ctx.now.toISOString();
    const replacesAssociationId =
      changeRequest.replacesAssociationId ??
      (typeof ctx.job.payload.replacesAssociationId === "string" &&
      isUuid(ctx.job.payload.replacesAssociationId)
        ? ctx.job.payload.replacesAssociationId
        : null);
    const mergeEvidence = (nextEvidence: JsonObject): JsonObject =>
      mergeEvidenceWithExistingMetadata(
        changeRequest.evidence,
        nextEvidence,
        replacesAssociationId,
      );

    const adapter = adapterRegistry.get(changeRequest.namespace);
    if (!adapter || !isTier2Adapter(adapter)) {
      const evidence = mergeEvidence({
        checkedAt,
        adapterTier: adapter?.tier ?? null,
        namespace: changeRequest.namespace,
      });
      return {
        status: "completed",
        result: {
          changeRequestId: changeRequest.id,
          decision: "needs_review",
          conflictReason: TIER1_MANUAL_REVIEW_REASON,
        },
        async onCommit(trx) {
          await markChangeRequestNeedsReviewInTx(trx, {
            changeRequestId: changeRequest.id,
            evidence,
            conflictReason: TIER1_MANUAL_REVIEW_REASON,
            decisionReason: TIER1_MANUAL_REVIEW_REASON,
            now: ctx.now,
          });
        },
      };
    }

    // 1. Fetch fresh catalog evidence (TMDB, TVDB, IMDb, Bangumi, Douban, or Trakt) outside DB transaction locks
    const catalogKey = await resolveAuthoritativeCatalogKey(
      ctx.db,
      changeRequest.mediaId,
      changeRequest.targetExternalKey,
    );

    let catalogEvidence: CatalogEvidence | null = null;
    let prefetchedCatalog: CatalogTargetSnapshot | null = null;

    if (!catalogKey) {
      const evidence = mergeEvidence({
        checkedAt,
        catalogStatus: "unsupported_catalog",
        targetExternalKey: changeRequest.targetExternalKey,
      });
      return {
        status: "completed",
        result: {
          changeRequestId: changeRequest.id,
          decision: "needs_review",
          conflictReason: "catalog_not_found",
        },
        async onCommit(trx) {
          await markChangeRequestNeedsReviewInTx(trx, {
            changeRequestId: changeRequest.id,
            evidence,
            conflictReason: "catalog_not_found",
            decisionReason: `No catalog evidence fetcher available for ${changeRequest.targetExternalKey}`,
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
      const evidence = mergeEvidence({
        checkedAt,
        catalogStatus: catalogResult.status,
        targetExternalKey: changeRequest.targetExternalKey,
        catalogKey,
      });
      return {
        status: "completed",
        result: {
          changeRequestId: changeRequest.id,
          decision: "needs_review",
          conflictReason: "catalog_not_found",
        },
        async onCommit(trx) {
          await markChangeRequestNeedsReviewInTx(trx, {
            changeRequestId: changeRequest.id,
            evidence,
            conflictReason: "catalog_not_found",
            decisionReason:
              catalogResult.reason ??
              `Catalog media not found for ${changeRequest.targetExternalKey}`,
            now: ctx.now,
          });
        },
      };
    }

    prefetchedCatalog = catalogResult.target;
    catalogEvidence = {
      ...catalogResult.target.evidence,
      episodeAirYears: await fetchSegmentEpisodeAirYears(
        options.catalogConfig?.tmdbGateway ??
          options.tmdbGateway ??
          createTmdbGateway(ctx.outbound, options.catalogConfig?.tmdb ?? options.tmdbConfig),
        catalogResult.target.evidence,
        changeRequest.segments,
      ),
    };

    // 2. Fetch fresh platform/collection evidence via Tier 2+ adapter outside DB locks
    const collectionResult = await adapter.fetchCollection(changeRequest.nativeId, ctx.outbound);

    if (collectionResult.status === "transient_error") {
      return {
        status: "retry",
        ...(collectionResult.retryAfterMs !== undefined
          ? { delayMs: collectionResult.retryAfterMs }
          : {}),
        errorMessage: collectionResult.reason,
      };
    }

    // 2b. Resolve variant description fallback when referenced only by variantId
    let resolvedVariantDescription = changeRequest.variantDescription;
    if (resolvedVariantDescription === null && changeRequest.variantId !== null) {
      const variantRow = await ctx.db
        .selectFrom("variants")
        .select("description")
        .where("id", "=", changeRequest.variantId)
        .executeTakeFirst();
      if (variantRow) {
        resolvedVariantDescription = variantRow.description;
      }
    }

    // 2c. Check whether this submission contradicts an existing confirmed or locked association
    const conflictingAssociations = await findConflictingAssociations(ctx.db, {
      mediaId: changeRequest.mediaId,
      targetExternalKey: changeRequest.targetExternalKey,
      namespace: changeRequest.namespace,
      nativeId: changeRequest.nativeId,
      replacesAssociationId,
    });

    if (conflictingAssociations.length > 0) {
      const conflictResolution = await evaluateEvidenceCheckConflict({
        changeRequest,
        variantDescription: resolvedVariantDescription,
        replacesAssociationId,
        conflictingAssociations,
        catalogEvidence,
        newCollectionResult: collectionResult,
        adapterRegistry,
        outbound: ctx.outbound,
        evaluateStep2: options.evaluateStep2,
        checkedAt,
      });

      if (conflictResolution.kind === "retry") {
        return {
          status: "retry",
          ...(conflictResolution.delayMs !== undefined
            ? { delayMs: conflictResolution.delayMs }
            : {}),
          errorMessage: conflictResolution.errorMessage,
        };
      }

      const mergedConflictEvidence = mergeEvidence(conflictResolution.evidenceRecord);

      if (conflictResolution.kind === "locked") {
        return {
          status: "completed",
          result: {
            changeRequestId: changeRequest.id,
            decision: "needs_review",
            conflictReason: conflictResolution.conflictReason,
          },
          async onCommit(trx) {
            await markChangeRequestNeedsReviewInTx(trx, {
              changeRequestId: changeRequest.id,
              evidence: mergedConflictEvidence,
              conflictReason: conflictResolution.conflictReason,
              decisionReason: conflictResolution.decisionReason,
              now: ctx.now,
            });
            for (const locked of conflictResolution.lockedAssociations) {
              await recordLockedAssociationAlertInTx(trx, {
                mediaId: locked.mediaId,
                associationId: locked.id,
                changeRequestId: changeRequest.id,
                namespace: changeRequest.namespace,
                nativeId: changeRequest.nativeId,
                existingNativeId: locked.nativeId,
                detectedAt: checkedAt,
              });
            }
          },
        };
      }

      if (conflictResolution.kind === "needs_review") {
        return {
          status: "completed",
          result: {
            changeRequestId: changeRequest.id,
            decision: "needs_review",
            conflictReason: conflictResolution.conflictReason,
          },
          async onCommit(trx) {
            await markChangeRequestNeedsReviewInTx(trx, {
              changeRequestId: changeRequest.id,
              evidence: mergedConflictEvidence,
              conflictReason: conflictResolution.conflictReason,
              decisionReason: conflictResolution.decisionReason,
              now: ctx.now,
            });
          },
        };
      }

      // conflictResolution.kind === "auto_replace" (newPassed=true, oldPassed=false)
      return {
        status: "completed",
        result: {
          changeRequestId: changeRequest.id,
          decision: "approved",
          conflictReplaced: true,
        },
        async onCommit(trx) {
          await sql`savepoint sp_evidence_conflict_replace`.execute(trx);
          try {
            await approveChangeRequestInTransaction(trx, {
              changeRequestId: changeRequest.id,
              reviewerUserId: null,
              reason: conflictResolution.decisionReason,
              evidence: mergedConflictEvidence,
              conflictReason: null,
              prefetchedCatalog,
              allowedStatuses: ["pending_evidence"],
              replacesAssociationId,
              enforceUnlockedCheck: true,
              now: ctx.now,
            });
            await sql`release savepoint sp_evidence_conflict_replace`.execute(trx);
          } catch (error) {
            await sql`rollback to savepoint sp_evidence_conflict_replace`.execute(trx);
            if (
              error instanceof MediaServiceError &&
              error.code === "INVALID_CHANGE_REQUEST_STATE"
            ) {
              return;
            }
            if (error instanceof MediaServiceError && error.code === "ASSOCIATION_LOCKED") {
              await markChangeRequestNeedsReviewInTx(trx, {
                changeRequestId: changeRequest.id,
                evidence: mergedConflictEvidence,
                conflictReason: CONFLICT_REASONS.LOCKED_ASSOCIATION_CHALLENGED,
                decisionReason: error.message,
                now: ctx.now,
              });
              for (const conflict of conflictResolution.conflictingAssociations) {
                await recordLockedAssociationAlertInTx(trx, {
                  mediaId: conflict.mediaId,
                  associationId: conflict.id,
                  changeRequestId: changeRequest.id,
                  namespace: changeRequest.namespace,
                  nativeId: changeRequest.nativeId,
                  existingNativeId: conflict.nativeId,
                  detectedAt: checkedAt,
                });
              }
              return;
            }
            if (
              error instanceof MediaServiceError &&
              (error.code === "SEGMENT_OVERLAP" ||
                error.code === "INVALID_VARIANT" ||
                error.code === "INVALID_SEGMENTS" ||
                error.code === "SEGMENTS_NOT_ALLOWED_WITHOUT_BASELINE")
            ) {
              await markChangeRequestNeedsReviewInTx(trx, {
                changeRequestId: changeRequest.id,
                evidence: mergedConflictEvidence,
                conflictReason: error.code.toLowerCase(),
                decisionReason: error.message,
                now: ctx.now,
              });
              return;
            }
            throw error;
          }
        },
      };
    }

    if (collectionResult.status === "not_found") {
      const evidence = mergeEvidence({
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
      });
      return {
        status: "completed",
        result: {
          changeRequestId: changeRequest.id,
          decision: "needs_review",
          conflictReason: "collection_not_found",
        },
        async onCommit(trx) {
          await markChangeRequestNeedsReviewInTx(trx, {
            changeRequestId: changeRequest.id,
            evidence,
            conflictReason: "collection_not_found",
            decisionReason:
              collectionResult.reason ??
              `Collection ${changeRequest.namespace}:${changeRequest.nativeId} not found`,
            now: ctx.now,
          });
        },
      };
    }

    // 3. Evaluate deterministic Evidence Gate (Step 1 + Step 2)
    const gate = evaluateEvidenceGate({
      catalog: catalogEvidence,
      collection: collectionResult.info,
      segments: changeRequest.segments,
      setDefaultVariant: changeRequest.setDefaultVariant,
      variantDescription: resolvedVariantDescription,
      evaluateStep2: options.evaluateStep2,
    });

    const evidenceRecord = mergeEvidence({
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
    });

    if (gate.decision === "pass") {
      return {
        status: "completed",
        result: {
          changeRequestId: changeRequest.id,
          decision: "approved",
          matchedBy: gate.step1.matchedBy,
        },
        async onCommit(trx) {
          await sql`savepoint sp_evidence_auto_approve`.execute(trx);
          try {
            await approveChangeRequestInTransaction(trx, {
              changeRequestId: changeRequest.id,
              reviewerUserId: null,
              reason: "evidence_gate_passed",
              evidence: evidenceRecord,
              conflictReason: null,
              prefetchedCatalog,
              allowedStatuses: ["pending_evidence"],
              replacesAssociationId,
              enforceUnlockedCheck: true,
              now: ctx.now,
            });
            await sql`release savepoint sp_evidence_auto_approve`.execute(trx);
          } catch (error) {
            await sql`rollback to savepoint sp_evidence_auto_approve`.execute(trx);
            if (
              error instanceof MediaServiceError &&
              error.code === "INVALID_CHANGE_REQUEST_STATE"
            ) {
              return;
            }
            if (error instanceof MediaServiceError && error.code === "ASSOCIATION_LOCKED") {
              await markChangeRequestNeedsReviewInTx(trx, {
                changeRequestId: changeRequest.id,
                evidence: evidenceRecord,
                conflictReason: CONFLICT_REASONS.LOCKED_ASSOCIATION_CHALLENGED,
                decisionReason: error.message,
                now: ctx.now,
              });
              const lateConflicts = await findConflictingAssociations(trx, {
                mediaId: changeRequest.mediaId,
                targetExternalKey: changeRequest.targetExternalKey,
                namespace: changeRequest.namespace,
                nativeId: changeRequest.nativeId,
                replacesAssociationId,
              });
              for (const locked of lateConflicts.filter((entry) => entry.locked)) {
                await recordLockedAssociationAlertInTx(trx, {
                  mediaId: locked.mediaId,
                  associationId: locked.id,
                  changeRequestId: changeRequest.id,
                  namespace: changeRequest.namespace,
                  nativeId: changeRequest.nativeId,
                  existingNativeId: locked.nativeId,
                  detectedAt: checkedAt,
                });
              }
              return;
            }
            if (
              error instanceof MediaServiceError &&
              (error.code === "SEGMENT_OVERLAP" ||
                error.code === "INVALID_VARIANT" ||
                error.code === "INVALID_SEGMENTS" ||
                error.code === "SEGMENTS_NOT_ALLOWED_WITHOUT_BASELINE")
            ) {
              await markChangeRequestNeedsReviewInTx(trx, {
                changeRequestId: changeRequest.id,
                evidence: evidenceRecord,
                conflictReason: error.code.toLowerCase(),
                decisionReason: error.message,
                now: ctx.now,
              });
              return;
            }
            throw error;
          }
        },
      };
    }

    const primaryConflictCode = gate.conflicts[0]?.code ?? "evidence_gate_conflict";
    const summaryReason =
      gate.reasons.length > 0 ? gate.reasons.join("; ") : "evidence_gate_needs_review";

    return {
      status: "completed",
      result: {
        changeRequestId: changeRequest.id,
        decision: "needs_review",
        conflictReason: primaryConflictCode,
      },
      async onCommit(trx) {
        await markChangeRequestNeedsReviewInTx(trx, {
          changeRequestId: changeRequest.id,
          evidence: evidenceRecord,
          conflictReason: primaryConflictCode,
          decisionReason: summaryReason,
          now: ctx.now,
        });
      },
    };
  };
}

export { EVIDENCE_CHECK_JOB_TYPE };
