import type { Namespace } from "@media-ref/client";
import type { Database, JsonObject } from "@media-ref/db";
import { sql, type Transaction } from "kysely";
import {
  createDefaultAdapterRegistry,
  isTier2Adapter,
  type AdapterRegistry,
} from "./adapters/index.ts";
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
import type { JobExecutionOutcome, JobHandler } from "./jobs.ts";
import {
  approveChangeRequestInTransaction,
  EVIDENCE_CHECK_JOB_TYPE,
  getChangeRequestById,
  isUuid,
  MediaServiceError,
  TIER1_MANUAL_REVIEW_REASON,
} from "./media-service.ts";
import {
  createTmdbGateway,
  parseTmdbNativeId,
  type TmdbGateway,
  type TmdbGatewayConfig,
  type TmdbMediaFetchResult,
} from "./tmdb.ts";

export interface EvidenceCheckJobOptions {
  adapterRegistry?: AdapterRegistry;
  tmdbConfig?: TmdbGatewayConfig;
  tmdbGateway?: TmdbGateway;
  evaluateStep2?: EvidenceGateStep2Evaluator;
}

interface MarkNeedsReviewInput {
  changeRequestId: string;
  evidence: JsonObject | null;
  conflictReason: string;
  decisionReason: string;
  now: Date;
}

async function markChangeRequestNeedsReviewInTx(
  trx: Transaction<Database>,
  input: MarkNeedsReviewInput,
): Promise<void> {
  await trx
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
    .execute();
}

function buildTmdbCatalogEvidence(result: TmdbMediaFetchResult): CatalogEvidence {
  const externalIds: Partial<Record<Namespace, string>> = {
    tmdb: result.externalIds.tmdb,
  };
  if (result.externalIds.imdb) {
    externalIds.imdb = result.externalIds.imdb;
  }
  if (result.externalIds.tvdb) {
    externalIds.tvdb = result.externalIds.tvdb;
  }
  if (result.externalIds.trakt) {
    externalIds.trakt = result.externalIds.trakt;
  }

  return {
    namespace: "tmdb",
    canonicalId: result.externalIds.tmdb,
    mediaType: result.type,
    title: result.snapshot.title,
    originalTitle: result.snapshot.originalTitle,
    year: result.snapshot.year,
    seasons: result.snapshot.seasons,
    externalIds,
  };
}

function extractTmdbTarget(targetExternalKey: string): { type: "movie" | "tv"; id: string } | null {
  if (!targetExternalKey.startsWith("tmdb:")) {
    return null;
  }
  return parseTmdbNativeId(targetExternalKey.slice("tmdb:".length));
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
    const adapter = adapterRegistry.get(changeRequest.namespace);
    if (!adapter || !isTier2Adapter(adapter)) {
      const evidence: JsonObject = {
        checkedAt,
        adapterTier: adapter?.tier ?? null,
        namespace: changeRequest.namespace,
      };
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

    // 1. Fetch fresh catalog evidence (TMDB) outside DB transaction locks
    let tmdbTarget = extractTmdbTarget(changeRequest.targetExternalKey);
    if (!tmdbTarget && changeRequest.mediaId) {
      const tmdbRow = await ctx.db
        .selectFrom("external_ids")
        .select("native_id")
        .where("media_id", "=", changeRequest.mediaId)
        .where("namespace", "=", "tmdb")
        .executeTakeFirst();
      if (tmdbRow) {
        tmdbTarget = parseTmdbNativeId(tmdbRow.native_id);
      }
    }

    let catalogEvidence: CatalogEvidence | null = null;
    let prefetchedTmdb: TmdbMediaFetchResult | null = null;

    if (tmdbTarget) {
      const gateway = options.tmdbGateway ?? createTmdbGateway(ctx.outbound, options.tmdbConfig);
      let fetched: TmdbMediaFetchResult | null;
      try {
        fetched = await gateway.fetchMediaSnapshotAndExternalIds(tmdbTarget.type, tmdbTarget.id);
      } catch (error) {
        return {
          status: "retry",
          errorMessage:
            error instanceof Error ? error.message : "Failed to fetch TMDB catalog evidence",
        };
      }

      if (!fetched) {
        const evidence: JsonObject = {
          checkedAt,
          catalogStatus: "not_found",
          targetExternalKey: changeRequest.targetExternalKey,
        };
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
              decisionReason: `Catalog media not found for ${changeRequest.targetExternalKey}`,
              now: ctx.now,
            });
          },
        };
      }

      prefetchedTmdb = fetched;
      catalogEvidence = buildTmdbCatalogEvidence(fetched);
    } else {
      const evidence: JsonObject = {
        checkedAt,
        catalogStatus: "unsupported_catalog",
        targetExternalKey: changeRequest.targetExternalKey,
      };
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
    const replacesAssociationId =
      changeRequest.replacesAssociationId ??
      (typeof ctx.job.payload.replacesAssociationId === "string" &&
      isUuid(ctx.job.payload.replacesAssociationId)
        ? ctx.job.payload.replacesAssociationId
        : null);

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
              evidence: conflictResolution.evidenceRecord,
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
              evidence: conflictResolution.evidenceRecord,
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
              evidence: conflictResolution.evidenceRecord,
              conflictReason: null,
              prefetchedTmdb,
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
                evidence: conflictResolution.evidenceRecord,
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
                error.code === "INVALID_SEGMENTS")
            ) {
              await markChangeRequestNeedsReviewInTx(trx, {
                changeRequestId: changeRequest.id,
                evidence: conflictResolution.evidenceRecord,
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
              prefetchedTmdb,
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
                error.code === "INVALID_SEGMENTS")
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
