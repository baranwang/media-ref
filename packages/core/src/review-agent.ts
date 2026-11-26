/**
 * Review agent (`@media-ref/core`), ADR 0003: a change request the Evidence Gate sent to
 * `needs_review` gets one model session before a human reviewer sees it.
 *
 * - Queued in the same transaction that marks the request `needs_review`, unless a conflict makes
 *   approval impossible anyway (§1).
 * - The session reuses the exploration agent's loop, budget, wrap-up, query tools and token
 *   accounting (§6), and ends with one conclusion: `approve` or `keep_for_human` (§2).
 * - The model's approval only counts when code confirms it (§3): no non-overridable conflict, the
 *   collection and every season in the segments fetched in this session, a reason per conflict
 *   code. Anything else, including no conclusion, a spent budget or an error, keeps the request
 *   for a human. The verdict and reasons go into `evidence.reviewAgent`.
 */

import type { Database, Db, JsonObject } from "@media-ref/db";
import { sql, type Transaction } from "kysely";
import { createDefaultAdapterRegistry, type AdapterRegistry } from "./adapters/index.ts";
import {
  createSessionBudget,
  runToolSession,
  type SessionStop,
  type SessionUsage,
} from "./agent-session.ts";
import {
  parseCatalogTargetKey,
  resolveCatalogTargetSnapshot,
  type CatalogGatewayConfig,
  type CatalogTargetSnapshot,
} from "./catalog-gateway.ts";
import { resolveExplorationAgentConfig, type ExplorationAgentConfig } from "./exploration-agent.ts";
import {
  DEFAULT_EXPLORATION_DAILY_TOKEN_BUDGET,
  recordExplorationTokens,
} from "./exploration-scheduler.ts";
import { buildQueryTools, runQueryTool, type ToolContext } from "./exploration-tools.ts";
import { enqueueJob, type JobExecutionOutcome, type JobHandler } from "./jobs.ts";
import {
  approveChangeRequestInTransaction,
  getChangeRequestById,
  isUuid,
  MediaServiceError,
  type ChangeRequestRecord,
} from "./media-service.ts";
import type { ModelToolCall, ModelToolDefinition } from "./outbound.ts";
import { createTmdbGateway, type TmdbGateway, type TmdbGatewayConfig } from "./tmdb.ts";
import { formatUtcDate } from "./tmdb-sync.ts";
import { reportPiUsage } from "./tokens-report.ts";

export const REVIEW_AGENT_JOB_TYPE = "review_agent";
export const REVIEW_AGENT_USER_ID = "system:review-agent";
export const REVIEW_AGENT_USER_EMAIL = "review-agent@system.mediaref.internal";
export const REVIEW_AGENT_USER_NAME = "Review Agent";
export const DEFAULT_REVIEW_AGENT_MAX_STEPS = 16;
export const DEFAULT_REVIEW_AGENT_MAX_DURATION_MS = 2 * 60_000;
export const DEFAULT_REVIEW_AGENT_MAX_TASK_TOKENS = 300_000;

/** Gate conflicts the review agent may never approve over (ADR 0003 §1). */
const NON_OVERRIDABLE_CONFLICT_CODES: ReadonlySet<string> = new Set(["shared_id_conflict"]);
/** Platform search finds other collections; a review judges the submitted one (ADR 0003 §6). */
const OMITTED_QUERY_TOOLS: ReadonlySet<string> = new Set(["search_platform"]);
// #76 adds "reject_with_correction" here and in `conclude`.
const CONCLUSION_TOOLS: ReadonlySet<string> = new Set(["approve", "keep_for_human"]);

export interface ReviewAgentConfig extends Omit<ExplorationAgentConfig, "discover"> {
  /** Reviews per UTC day; 0 (the default) runs none. */
  dailyBudget?: number;
}

export interface ReviewAgentJobOptions extends ReviewAgentConfig {
  catalogConfig?: CatalogGatewayConfig;
  tmdbConfig?: TmdbGatewayConfig;
  tmdbGateway?: TmdbGateway;
  /** The day's model token cap, shared with the exploration agent. */
  dailyTokenBudget?: number;
}

interface ReviewReason {
  code: string;
  reason: string;
}

type ReviewVerdict = "approve" | "keep_for_human";

interface ReviewConclusion {
  verdict: ReviewVerdict;
  reasons: ReviewReason[];
  opinion: string | null;
}

/**
 * Queues a review for a change request that just turned `needs_review` on these gate conflicts.
 * Call inside that transaction; nothing is queued when a conflict cannot be approved over.
 */
export async function enqueueReviewAgentJobInTx(
  trx: Transaction<Database>,
  input: { changeRequestId: string; conflictCodes: readonly string[]; now: Date },
): Promise<void> {
  if (input.conflictCodes.some((code) => NON_OVERRIDABLE_CONFLICT_CODES.has(code))) {
    return;
  }
  await enqueueJob(trx, {
    jobType: REVIEW_AGENT_JOB_TYPE,
    payload: { changeRequestId: input.changeRequestId },
    dedupeKey: `${REVIEW_AGENT_JOB_TYPE}:${input.changeRequestId}`,
    runAfter: input.now,
  });
}

/** Ensures the review agent's user row exists: its approvals are written as `reviewer_user_id`. */
export async function ensureReviewAgentUser(dbWrite: Db): Promise<string> {
  await dbWrite
    .insertInto("user")
    .values({
      id: REVIEW_AGENT_USER_ID,
      name: REVIEW_AGENT_USER_NAME,
      email: REVIEW_AGENT_USER_EMAIL,
      emailVerified: true,
      image: null,
      role: "user",
      reputation: 0,
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
  return REVIEW_AGENT_USER_ID;
}

/**
 * Takes one of today's review slots; false when the daily count or the shared token cap is spent.
 * One statement, so concurrent reviews cannot overshoot the count.
 */
async function claimDailyReview(
  db: Db,
  now: Date,
  dailyBudget: number,
  dailyTokenBudget: number,
): Promise<boolean> {
  if (dailyBudget <= 0 || dailyTokenBudget <= 0) {
    return false;
  }
  const row = await db
    .insertInto("exploration_daily_budget")
    .values({ budget_date: formatUtcDate(now), consumed: 0, review_consumed: 1, updated_at: now })
    .onConflict((oc) =>
      oc
        .column("budget_date")
        .doUpdateSet({
          review_consumed: sql`exploration_daily_budget.review_consumed + 1`,
          updated_at: now,
        })
        .where("exploration_daily_budget.review_consumed", "<", dailyBudget)
        .where("exploration_daily_budget.tokens_used", "<", String(dailyTokenBudget)),
    )
    .returning("review_consumed")
    .executeTakeFirst();
  return row !== undefined;
}

function gateConflictCodes(cr: ChangeRequestRecord): string[] {
  const gate = cr.evidence?.gate as { conflicts?: Array<{ code?: unknown }> } | undefined;
  const codes = (gate?.conflicts ?? []).flatMap((c) =>
    typeof c.code === "string" ? [c.code] : [],
  );
  if (codes.length === 0 && cr.conflictReason) {
    codes.push(cr.conflictReason);
  }
  return [...new Set(codes)];
}

function buildSystemPrompt(): string {
  return [
    "You review one change request the automatic Evidence Gate could not approve. It maps a catalog's episodes to a video platform collection. You decide before a human reviewer does.",
    "Rules:",
    "1. End with exactly one conclusion: approve or keep_for_human.",
    "2. approve only counts if, in this session, you fetched the collection with get_collection and every season the segments name with get_catalog_season, and you give one reason per conflict code saying why that conflict does not make the mapping wrong. Otherwise the request stays with a human.",
    "3. A platform episode number is the position in the collection's feature episode list, counted from 1, not the number in the episode title.",
    "4. Extras (chapters, recaps, specials) mixed into the platform's list shift every later position. Check that each segment's episodes land on the right positions.",
    "   Example: 灵笼 season 1 on Bilibili has 16 entries: 001–006, 中章, 007–012, 终章上, 终章下, 特别篇. TMDB season 1 has 12 episodes; 中章, 终章 and 特别篇 are in TMDB season 0. Mapping the whole season from position 1 puts TMDB 7–12 on positions 7–12, one off. The right segments are episodes 1–6 at positions 1–6 and 7–12 at positions 8–13. Extras at the end of the list need no split.",
    "5. If you are unsure, or the submission looks wrong, keep_for_human and say what you found.",
    "6. Steps and tokens are limited: fetch what you need, then conclude.",
  ].join("\n");
}

function buildUserPrompt(cr: ChangeRequestRecord, conflictCodes: readonly string[]): string {
  const evidence = cr.evidence ?? {};
  const gate = (evidence.gate ?? {}) as JsonObject;
  const payload = {
    changeRequest: {
      targetExternalKey: cr.targetExternalKey,
      namespace: cr.namespace,
      nativeId: cr.nativeId,
      variantDescription: cr.variantDescription,
      setDefaultVariant: cr.setDefaultVariant,
      segments: cr.segments,
    },
    conflictCodes,
    conflicts: gate.conflicts ?? [],
    gateReasons: gate.reasons ?? [],
    catalog: evidence.catalog ?? null,
    collection: evidence.collection ?? null,
  };
  return `Review this change request:\n${JSON.stringify(payload, null, 2)}`;
}

const CONCLUSION_TOOL_DEFINITIONS: ModelToolDefinition[] = [
  {
    name: "approve",
    description:
      "Approve the change request as submitted. Give one reason per conflict code. Counts only after you fetched the collection and every season in the segments in this session.",
    parameters: {
      type: "object",
      properties: {
        reasons: {
          type: "array",
          items: {
            type: "object",
            properties: { code: { type: "string" }, reason: { type: "string" } },
            required: ["code", "reason"],
          },
        },
      },
      required: ["reasons"],
    },
  },
  {
    name: "keep_for_human",
    description: "Leave the change request to a human reviewer, with your opinion.",
    parameters: {
      type: "object",
      properties: { opinion: { type: "string" } },
      required: ["opinion"],
    },
  },
];

function parseReasons(raw: unknown): ReviewReason[] {
  return (Array.isArray(raw) ? raw : []).flatMap((item) => {
    const rec = item as Record<string, unknown> | null;
    return typeof rec?.code === "string" &&
      typeof rec.reason === "string" &&
      rec.code.trim() &&
      rec.reason.trim()
      ? [{ code: rec.code.trim(), reason: rec.reason.trim() }]
      : [];
  });
}

function stopReason(stop: SessionStop): string {
  return stop.kind === "model_error" ? `model_error: ${stop.reason}` : stop.kind;
}

export function createReviewAgentJobHandler(options: ReviewAgentJobOptions = {}): JobHandler {
  const config = resolveExplorationAgentConfig({
    ...options,
    maxSteps: options.maxSteps ?? DEFAULT_REVIEW_AGENT_MAX_STEPS,
    maxDurationMs: options.maxDurationMs ?? DEFAULT_REVIEW_AGENT_MAX_DURATION_MS,
    maxTaskTokens: options.maxTaskTokens ?? DEFAULT_REVIEW_AGENT_MAX_TASK_TOKENS,
  });
  const clockMs = options.clockMs ?? (() => Date.now());
  const registry: AdapterRegistry = options.adapterRegistry ?? createDefaultAdapterRegistry();
  const dailyBudget = options.dailyBudget ?? 0;
  const dailyTokenBudget = options.dailyTokenBudget ?? DEFAULT_EXPLORATION_DAILY_TOKEN_BUDGET;

  return async (ctx): Promise<JobExecutionOutcome> => {
    const changeRequestId = ctx.job.payload.changeRequestId;
    if (typeof changeRequestId !== "string" || !isUuid(changeRequestId)) {
      return {
        status: "failed",
        errorMessage: "review_agent job payload requires a valid changeRequestId UUID",
      };
    }
    const skip = (reason: string): JobExecutionOutcome => ({
      status: "completed",
      result: { changeRequestId, skipped: true, reason },
    });

    const cr = await getChangeRequestById(ctx.db, changeRequestId);
    if (!cr || cr.status !== "needs_review") {
      return skip(cr ? `change_request_already_${cr.status}` : "change_request_not_found");
    }
    if (cr.evidence?.reviewAgent) {
      return skip("already_reviewed");
    }
    if (!(await claimDailyReview(ctx.db, ctx.now, dailyBudget, dailyTokenBudget))) {
      return skip("daily_budget_exhausted");
    }

    const conflictCodes = gateConflictCodes(cr);
    const evidence = cr.evidence ?? {};
    const catalog = (evidence.catalog ?? {}) as {
      namespace?: string;
      canonicalId?: string;
      seasons?: ToolContext["seasons"];
    };
    const tmdbGateway =
      options.tmdbGateway ??
      options.catalogConfig?.tmdbGateway ??
      createTmdbGateway(ctx.outbound, options.catalogConfig?.tmdb ?? options.tmdbConfig);

    // What the session actually fetched: approval needs the collection and every season (§3).
    const fetchedCollections = new Set<string>();
    const fetchedSeasons = new Set<number>();
    const queries: Array<{ tool: string; arguments: Record<string, unknown> }> = [];
    let conclusion: ReviewConclusion | null = null;

    const budget = createSessionBudget(ctx.outbound, clockMs() + config.maxDurationMs, clockMs);
    const usage: SessionUsage = { tokens: 0, byModel: new Map() };
    let stop: SessionStop;
    try {
      const toolCtx: ToolContext = {
        outbound: budget.outbound,
        registry,
        tmdb: tmdbGateway,
        collectionNamespaces: [cr.namespace],
        seasons: catalog.seasons ?? [],
        tmdbTvId:
          catalog.namespace === "tmdb"
            ? (catalog.canonicalId?.match(/^tv:(\d+)$/)?.[1] ?? null)
            : null,
        register: (info) => {
          fetchedCollections.add(`${info.namespace}:${info.canonicalId}`);
          // The submitted mapping already failed the gate; the hint would only repeat that.
          return false;
        },
        noteTransient: () => {},
      };
      const queryTools = buildQueryTools(toolCtx).filter((t) => !OMITTED_QUERY_TOOLS.has(t.name));
      const offered = new Set(queryTools.map((t) => t.name));

      const conclude = async (call: ModelToolCall): Promise<unknown> => {
        if (conclusion) {
          return { ok: false, error: "ALREADY_CONCLUDED" };
        }
        const args = call.arguments ?? {};
        const opinion =
          typeof args.opinion === "string" && args.opinion.trim() ? args.opinion.trim() : null;
        conclusion = {
          verdict: call.name === "approve" ? "approve" : "keep_for_human",
          reasons: parseReasons(args.reasons),
          opinion,
        };
        return { ok: true };
      };

      stop = await runToolSession({
        budget,
        config,
        usage,
        messages: [
          { role: "system", content: buildSystemPrompt() },
          { role: "user", content: buildUserPrompt(cr, conflictCodes) },
        ],
        tools: [...queryTools, ...CONCLUSION_TOOL_DEFINITIONS],
        conclusionToolNames: CONCLUSION_TOOLS,
        sessionId: ctx.job.id,
        metadata: { changeRequestId, jobId: ctx.job.id },
        runQuery: async (name, args) => {
          if (!offered.has(name)) {
            return { error: "UNKNOWN_TOOL" };
          }
          queries.push({ tool: name, arguments: args });
          const result = await runQueryTool(toolCtx, name, args);
          const failed = typeof result === "object" && result !== null && "error" in result;
          if (name === "get_catalog_season" && !failed && typeof args.season === "number") {
            fetchedSeasons.add(args.season);
          }
          return result;
        },
        wrapUpMessage: () =>
          "The time, step or token budget is almost used up. Stop searching and conclude now with approve or keep_for_human.",
        wrapUpRefusal: "No more searching: conclude with approve or keep_for_human.",
        conclude,
        done: () => conclusion !== null,
      });
    } catch (error) {
      stop = {
        kind: "model_error",
        reason: error instanceof Error ? error.message : String(error),
      };
    } finally {
      budget.dispose();
      await recordExplorationTokens(ctx.db, ctx.now, usage.tokens);
      await reportPiUsage(ctx.db, ctx.outbound, [...usage.byModel.values()], {
        now: ctx.now,
        ...(config.tokensApiToken ? { token: config.tokensApiToken } : {}),
      });
    }

    const concluded = conclusion as ReviewConclusion | null;
    let fallback: string | null = concluded ? null : stopReason(stop);
    if (concluded?.verdict === "approve") {
      fallback = approvalBlocker(cr, conflictCodes, concluded.reasons, {
        fetchedCollections,
        fetchedSeasons,
      });
    }

    let prefetchedCatalog: CatalogTargetSnapshot | null = null;
    if (concluded?.verdict === "approve" && fallback === null && cr.mediaId === null) {
      // Approval creates the media from the catalog: fetch it outside the transaction.
      const key = parseCatalogTargetKey(cr.targetExternalKey);
      const resolved = key
        ? await resolveCatalogTargetSnapshot(key.canonicalKey, ctx.outbound, {
            ...options.catalogConfig,
            tmdb: options.catalogConfig?.tmdb ?? options.tmdbConfig,
            tmdbGateway,
          })
        : null;
      if (resolved?.status === "found") {
        prefetchedCatalog = resolved.target;
      } else {
        fallback = `catalog_unavailable: ${resolved?.status ?? "invalid_key"}`;
      }
    }

    const approved = concluded?.verdict === "approve" && fallback === null;
    const reviewAgent: JsonObject = {
      verdict: approved ? "approve" : "keep_for_human",
      reasons: concluded?.reasons ?? [],
      opinion: concluded?.opinion ?? null,
      // Why the session's conclusion was not followed, or why there was none.
      fallback,
      queries: queries as unknown as JsonObject[],
      jobId: ctx.job.id,
      reviewedAt: ctx.now.toISOString(),
    };
    const keepForHuman = (trx: Transaction<Database>, record: JsonObject) =>
      trx
        .updateTable("change_requests")
        .set({
          evidence: JSON.stringify({ ...evidence, reviewAgent: record }),
          updated_at: ctx.now,
        })
        .where("id", "=", cr.id)
        .where("status", "=", "needs_review")
        .execute();

    if (approved) {
      await ensureReviewAgentUser(ctx.db);
    }
    return {
      status: "completed",
      result: { changeRequestId, verdict: reviewAgent.verdict, fallback },
      async onCommit(trx) {
        if (!approved) {
          await keepForHuman(trx, reviewAgent);
          return;
        }
        await sql`savepoint sp_review_agent_approve`.execute(trx);
        try {
          await approveChangeRequestInTransaction(trx, {
            changeRequestId: cr.id,
            reviewerUserId: REVIEW_AGENT_USER_ID,
            reason: concluded!.reasons.map((r) => `${r.code}: ${r.reason}`).join("; "),
            evidence: { ...evidence, reviewAgent },
            conflictReason: cr.conflictReason,
            prefetchedCatalog,
            allowedStatuses: ["needs_review"],
            replacesAssociationId: cr.replacesAssociationId,
            enforceUnlockedCheck: true,
            now: ctx.now,
          });
          await sql`release savepoint sp_review_agent_approve`.execute(trx);
        } catch (error) {
          await sql`rollback to savepoint sp_review_agent_approve`.execute(trx);
          if (!(error instanceof MediaServiceError)) {
            throw error;
          }
          if (error.code === "INVALID_CHANGE_REQUEST_STATE") {
            return; // A reviewer decided meanwhile.
          }
          await keepForHuman(trx, {
            ...reviewAgent,
            verdict: "keep_for_human",
            fallback: `approval_failed: ${error.code}`,
          });
        }
      },
    };
  };
}

/** Why code does not follow the model's approval (ADR 0003 §3), or null when it does. */
function approvalBlocker(
  cr: ChangeRequestRecord,
  conflictCodes: readonly string[],
  reasons: readonly ReviewReason[],
  fetched: { fetchedCollections: ReadonlySet<string>; fetchedSeasons: ReadonlySet<number> },
): string | null {
  const blocking = conflictCodes.filter((code) => NON_OVERRIDABLE_CONFLICT_CODES.has(code));
  if (blocking.length > 0) {
    return `non_overridable_conflict: ${blocking.join(", ")}`;
  }
  if (!fetched.fetchedCollections.has(`${cr.namespace}:${cr.nativeId}`)) {
    return "collection_not_fetched";
  }
  const seasons = [...new Set(cr.segments.map((s) => s.season))];
  const unfetched = seasons.filter((s) => !fetched.fetchedSeasons.has(s));
  if (unfetched.length > 0) {
    return `season_not_fetched: ${unfetched.join(", ")}`;
  }
  const unexplained = conflictCodes.filter((code) => !reasons.some((r) => r.code === code));
  if (unexplained.length > 0) {
    return `no_reason_for: ${unexplained.join(", ")}`;
  }
  return null;
}
