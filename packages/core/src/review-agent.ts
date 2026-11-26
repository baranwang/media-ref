/**
 * Review agent (`@media-ref/core`), ADR 0003: every change request that leaves the Evidence Gate as
 * `needs_review` is decided here, automatically. Nobody reviews after it (CONSTITUTION.md §1).
 *
 * - Queued whenever a request turns `needs_review` (`enqueueReviewAgentJobInTx`), and swept up by
 *   `enqueuePendingReviews` for any that lack an active job.
 * - Requests no review can approve (a clash with an existing or locked association, a shared-ID
 *   conflict, missing evidence) are rejected at once, without a model.
 * - Gate conflicts get one model session, reusing the exploration agent's loop, budget, wrap-up and
 *   query tools. It ends with `approve`, `reject_with_correction` or `reject`.
 * - Code confirms an approval (§3) and a correction (§4); anything it does not confirm, no
 *   conclusion or a spent session is a plain rejection: the demand backs off and exploration tries
 *   again later. A model or catalog outage, or a spent daily budget, retries the job instead.
 *   The verdict and reasons go into `evidence.reviewAgent`.
 */

import {
  getNamespaceGroup,
  validateVariantSegments,
  type NormalizedSegment,
} from "@media-ref/client";
import type { Database, Db, JsonObject } from "@media-ref/db";
import { sql, type Transaction } from "kysely";
import { createDefaultAdapterRegistry, type AdapterRegistry } from "./adapters/index.ts";
import type { CollectionInfo } from "./adapters/types.ts";
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
import { ensureDemandExplorableNowInTx } from "./demands.ts";
import {
  evaluateEvidenceGateStep1,
  evaluateEvidenceGateStep2,
  type CatalogEvidence,
} from "./evidence-gate.ts";
import {
  checkSegmentsFitCollection,
  resolveExplorationAgentConfig,
  type ExplorationAgentConfig,
} from "./exploration-agent.ts";
import {
  DEFAULT_EXPLORATION_DAILY_TOKEN_BUDGET,
  recordExplorationTokens,
} from "./exploration-scheduler.ts";
import { buildQueryTools, runQueryTool, type ToolContext } from "./exploration-tools.ts";
import {
  enqueueJob,
  releaseLeaseOnDispatchFailure,
  type JobExecutionOutcome,
  type JobHandler,
} from "./jobs.ts";
import { MAX_LEAD_NOTES_LENGTH, recordLead } from "./leads.ts";
import {
  approveChangeRequestInTransaction,
  getChangeRequestById,
  isUuid,
  MediaServiceError,
  rejectChangeRequestInTx,
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
/** `reporter_key_id` of the leads it writes: it has no API key, and the column has no foreign key. */
export const REVIEW_AGENT_KEY_ID = REVIEW_AGENT_USER_ID;
export const DEFAULT_REVIEW_AGENT_MAX_STEPS = 16;
export const DEFAULT_REVIEW_AGENT_MAX_DURATION_MS = 2 * 60_000;
export const DEFAULT_REVIEW_AGENT_MAX_TASK_TOKENS = 300_000;
/** Lease time a review needs beyond its session: the outcome's fenced write and its commit. */
const LEASE_MARGIN_MS = 30_000;

/** Gate conflicts the review agent may never approve over (ADR 0003 §1). */
const NON_OVERRIDABLE_CONFLICT_CODES: ReadonlySet<string> = new Set(["shared_id_conflict"]);
/** Wait before retrying a review that failed on an outage (model gateway, catalog). */
const OUTAGE_RETRY_MS = 60 * 60 * 1000;
/** Platform search finds other collections; a review judges the submitted one (ADR 0003 §6). */
const OMITTED_QUERY_TOOLS: ReadonlySet<string> = new Set(["search_platform"]);
/** Step 1 conflicts a correction may keep: a split season differs in count, not identity. */
const EPISODE_COUNT_CONFLICT_CODES: ReadonlySet<string> = new Set([
  "episode_count_mismatch",
  "episode_count_missing",
]);

/**
 * Step 2 conflicts a correction may keep when its segments fit the collection without overlap:
 * extras between feature episodes leave gaps in the positions and an uneven total (灵笼's 中章).
 */
const POSITION_GAP_CONFLICT_CODES: ReadonlySet<string> = new Set([
  "target_episode_start_mismatch",
  "segment_episode_count_mismatch",
]);

/** Why the segments' platform positions don't fit the collection: past its end, or overlapping. */
function positionMisfit(
  segments: readonly NormalizedSegment[],
  collection: CollectionInfo,
  seasons: CatalogEvidence["seasons"],
): string | null {
  const count = (season: number) => seasons.find((s) => s.season === season)?.episodeCount ?? null;
  const misfit = checkSegmentsFitCollection(segments, collection, count);
  if (misfit) {
    return misfit;
  }
  const ranges = segments
    .map((s) => {
      const end = s.episodeEnd ?? count(s.season)!;
      return [s.targetEpisodeStart, s.targetEpisodeStart + end - s.episodeStart] as const;
    })
    .sort((a, b) => a[0] - b[0]);
  return ranges.some((r, i) => i > 0 && r[0] <= ranges[i - 1]![1])
    ? "segments overlap on platform positions"
    : null;
}

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

type ReviewVerdict = "approve" | "reject_with_correction" | "reject";

/** Corrected season and segments; segment fields as in a change request (shared with the website). */
interface ReviewCorrection {
  season: number;
  segments: Array<{
    season: number;
    episodeStart: number;
    episodeEnd: number | null;
    targetEpisodeStart: number;
  }>;
}

interface ReviewConclusion {
  verdict: ReviewVerdict;
  reasons: ReviewReason[];
  opinion: string | null;
  /** Set for `reject_with_correction` when the arguments are well-formed. */
  correction: ReviewCorrection | null;
}

/**
 * Queues the review of a change request that just turned `needs_review`. Call inside that
 * transaction. Every such request is queued: the review decides it, even when the answer can only
 * be a rejection.
 */
export async function enqueueReviewAgentJobInTx(
  trx: Transaction<Database>,
  input: { changeRequestId: string; now: Date },
): Promise<void> {
  await enqueueJob(trx, {
    jobType: REVIEW_AGENT_JOB_TYPE,
    payload: { changeRequestId: input.changeRequestId },
    dedupeKey: `${REVIEW_AGENT_JOB_TYPE}:${input.changeRequestId}`,
    runAfter: input.now,
  });
}

/**
 * Queues reviews for `needs_review` requests without an active review job (requests from before
 * every one was queued, or whose job gave up). Runs on the cron; the dedupe key skips active jobs.
 */
export async function enqueuePendingReviews(
  db: Db,
  input: { now: Date; limit?: number },
): Promise<number> {
  const rows = await db
    .selectFrom("change_requests")
    .select("id")
    .where("status", "=", "needs_review")
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("background_jobs")
            .select("background_jobs.id")
            .where("background_jobs.job_type", "=", REVIEW_AGENT_JOB_TYPE)
            .where("background_jobs.status", "in", ["pending", "leased"])
            .whereRef(
              "background_jobs.dedupe_key",
              "=",
              sql<string>`${REVIEW_AGENT_JOB_TYPE} || ':' || change_requests.id::text`,
            ),
        ),
      ),
    )
    .orderBy("updated_at")
    .limit(input.limit ?? 50)
    .execute();
  for (const row of rows) {
    await enqueueReviewAgentJobInTx(db as unknown as Transaction<Database>, {
      changeRequestId: row.id,
      now: input.now,
    });
  }
  return rows.length;
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

function buildSystemPrompt(conclusions: string): string {
  return [
    "You review one change request the automatic Evidence Gate could not approve. It maps a catalog's episodes to a video platform collection. Your decision is final: nobody reviews after you.",
    "Rules:",
    `1. End with exactly one conclusion: ${conclusions}.`,
    "2. approve only counts if, in this session, you fetched the collection with get_collection and every season the segments name with get_catalog_season, and you give one reason per conflict code saying why that conflict does not make the mapping wrong. Otherwise it counts as reject.",
    ...(conclusions.includes("reject_with_correction")
      ? [
          "   reject_with_correction is for a submission that is wrong (for example the wrong season): give the corrected season and segments. It only counts if you fetched the collection and every corrected season in this session and the Evidence Gate's segment check passes on the correction.",
        ]
      : []),
    "3. A platform episode number is the position in the collection's feature episode list, counted from 1, not the number in the episode title.",
    "4. Extras (chapters, recaps, specials) mixed into the platform's list shift every later position. Check that each segment's episodes land on the right positions.",
    "   Example: 灵笼 season 1 on Bilibili has 16 entries: 001–006, 中章, 007–012, 终章上, 终章下, 特别篇. TMDB season 1 has 12 episodes; 中章, 终章 and 特别篇 are in TMDB season 0. Mapping the whole season from position 1 puts TMDB 7–12 on positions 7–12, one off. The right segments are episodes 1–6 at positions 1–6 and 7–12 at positions 8–13. Extras at the end of the list need no split.",
    "5. If you are unsure, or the submission looks wrong and you cannot correct it, reject and say what you found. A rejection is not final for the media: exploration looks again later.",
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
    name: "reject_with_correction",
    description:
      "The submission is wrong: reject it with the corrected season and segments, and say in opinion what was wrong. Code re-runs the Evidence Gate's segment check on the correction; only if it passes is the request rejected and the correction handed to the exploration agent.",
    parameters: {
      type: "object",
      properties: {
        opinion: { type: "string" },
        season: { type: "integer", description: "The season the collection really is." },
        segments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              season: { type: "integer" },
              episodeStart: { type: "integer" },
              episodeEnd: { type: ["integer", "null"] },
              targetEpisodeStart: { type: "integer" },
            },
            required: ["season", "episodeStart", "targetEpisodeStart"],
          },
        },
      },
      required: ["opinion", "season", "segments"],
    },
  },
  {
    name: "reject",
    description:
      "Reject the change request: it is wrong, or you cannot confirm it is right. Say what you found in opinion.",
    parameters: {
      type: "object",
      properties: { opinion: { type: "string" } },
      required: ["opinion"],
    },
  },
];

/** A well-formed correction, or null: positive episode numbers, the season among the segments'. */
function parseCorrection(args: Record<string, unknown>): ReviewCorrection | null {
  const int = (value: unknown, min: number): value is number =>
    typeof value === "number" && Number.isInteger(value) && value >= min;
  const raw: unknown[] = Array.isArray(args.segments) ? args.segments : [];
  const segments = raw.flatMap((item) => {
    const s = (item ?? {}) as Record<string, unknown>;
    const end = s.episodeEnd ?? null;
    return int(s.season, 0) &&
      int(s.episodeStart, 1) &&
      int(s.targetEpisodeStart, 1) &&
      (end === null || (int(end, 1) && end >= s.episodeStart))
      ? [
          {
            season: s.season,
            episodeStart: s.episodeStart,
            episodeEnd: end,
            targetEpisodeStart: s.targetEpisodeStart,
          },
        ]
      : [];
  });
  return int(args.season, 0) &&
    segments.length > 0 &&
    segments.length === raw.length &&
    segments.some((s) => s.season === args.season)
    ? { season: args.season, segments }
    : null;
}

function describeCorrection(correction: ReviewCorrection): string {
  return correction.segments
    .map(
      (s) =>
        `第 ${s.season} 季第 ${s.episodeStart}–${s.episodeEnd ?? "末"} 集对平台第 ${s.targetEpisodeStart} 集起`,
    )
    .join("；");
}

/** The review agent corrects a media's platform ID only once (ADR 0003 §4): its lead says it did. */
async function correctedBefore(db: Db, cr: ChangeRequestRecord): Promise<boolean> {
  const mediaKeys = cr.mediaId
    ? (
        await db
          .selectFrom("associations")
          .select(["namespace", "native_id"])
          .where("media_id", "=", cr.mediaId)
          .where("is_external_id", "=", true)
          .execute()
      ).map((a) => `${a.namespace}:${a.native_id}`)
    : [];
  const lead = await db
    .selectFrom("leads")
    .select("id")
    .where("reporter_user_id", "=", REVIEW_AGENT_USER_ID)
    .where("namespace", "=", cr.namespace)
    .where("native_id", "=", cr.nativeId)
    .where("target_external_key", "in", [cr.targetExternalKey, ...mediaKeys])
    .executeTakeFirst();
  return lead !== undefined;
}

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
    const evidence = cr.evidence ?? {};

    // Nothing a review could approve: reject now, without a model or a daily slot.
    const unreviewable = unreviewableReason(cr);
    if (unreviewable) {
      await ensureReviewAgentUser(ctx.db);
      const reviewAgent: JsonObject = {
        verdict: "reject",
        reasons: [],
        opinion: null,
        fallback: unreviewable,
        queries: [],
        jobId: ctx.job.id,
        reviewedAt: ctx.now.toISOString(),
      };
      return {
        status: "completed",
        result: { changeRequestId, verdict: "reject", fallback: unreviewable },
        onCommit: (trx) =>
          rejectPlainlyInTx(
            trx,
            cr,
            `无法自动通过：${unreviewable}`,
            {
              ...evidence,
              reviewAgent,
            },
            ctx.now,
          ),
      };
    }

    const leaseLeftMs = ctx.job.leaseExpiresAt
      ? ctx.job.leaseExpiresAt.getTime() - ctx.now.getTime()
      : Infinity;
    if (leaseLeftMs < config.maxDurationMs + LEASE_MARGIN_MS) {
      // Started late in a batch: the outcome would be fenced out after the session spent tokens
      // and a daily slot. Hand the job back with its attempt refunded; the worker's own
      // reschedule of this retry is then a fenced no-op.
      await releaseLeaseOnDispatchFailure(ctx.db, {
        jobId: ctx.job.id,
        leaseGeneration: ctx.job.leaseGeneration,
        retryAt: ctx.now,
        now: ctx.now,
      });
      return { status: "retry", runAfter: ctx.now, errorMessage: "lease_too_short_for_review" };
    }
    if (!(await claimDailyReview(ctx.db, ctx.now, dailyBudget, dailyTokenBudget))) {
      // Today's reviews are spent: the request waits for tomorrow's, it is not dropped.
      return {
        status: "retry",
        runAfter: nextUtcDay(ctx.now),
        errorMessage: "daily_budget_exhausted",
      };
    }

    const conflictCodes = gateConflictCodes(cr);
    const conclusionTools = (await correctedBefore(ctx.db, cr))
      ? CONCLUSION_TOOL_DEFINITIONS.filter((t) => t.name !== "reject_with_correction")
      : CONCLUSION_TOOL_DEFINITIONS;
    const conclusionNames = conclusionTools.map((t) => t.name).join(", ");
    const catalog = (evidence.catalog ?? {}) as {
      namespace?: string;
      canonicalId?: string;
      seasons?: ToolContext["seasons"];
    };
    const tmdbGateway =
      options.tmdbGateway ??
      options.catalogConfig?.tmdbGateway ??
      createTmdbGateway(ctx.outbound, options.catalogConfig?.tmdb ?? options.tmdbConfig);

    // What the model was shown, by the turn its result was replied in: approval needs the
    // collection and every season shown before the conclusion's turn (§3), and a correction is
    // re-checked against them (§4).
    const collected = new Map<string, CollectionInfo>();
    const fetchedCollections = new Map<string, { info: CollectionInfo; step: number }>();
    const fetchedSeasons = new Map<number, number>();
    const episodeAirYears: Record<number, Record<number, number | null>> = {};
    const queries: Array<{ tool: string; arguments: Record<string, unknown> }> = [];
    let conclusion: ReviewConclusion | null = null;
    let conclusionStep = 0;

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
          collected.set(`${info.namespace}:${info.canonicalId}`, info);
          // The submitted mapping already failed the gate; the hint would only repeat that.
          return false;
        },
        noteTransient: () => {},
      };
      const queryTools = buildQueryTools(toolCtx).filter((t) => !OMITTED_QUERY_TOOLS.has(t.name));
      const offered = new Set(queryTools.map((t) => t.name));

      const conclude = async (call: ModelToolCall, step: number): Promise<unknown> => {
        if (conclusion) {
          return { ok: false, error: "ALREADY_CONCLUDED" };
        }
        conclusionStep = step;
        const args = call.arguments ?? {};
        const opinion =
          typeof args.opinion === "string" && args.opinion.trim() ? args.opinion.trim() : null;
        conclusion = {
          verdict: call.name as ReviewVerdict,
          reasons: parseReasons(args.reasons),
          opinion,
          correction: call.name === "reject_with_correction" ? parseCorrection(args) : null,
        };
        return { ok: true };
      };

      stop = await runToolSession({
        budget,
        config,
        usage,
        messages: [
          { role: "system", content: buildSystemPrompt(conclusionNames) },
          { role: "user", content: buildUserPrompt(cr, conflictCodes) },
        ],
        tools: [...queryTools, ...conclusionTools],
        conclusionToolNames: new Set(conclusionTools.map((t) => t.name)),
        sessionId: ctx.job.id,
        metadata: { changeRequestId, jobId: ctx.job.id },
        runQuery: async (name, args) => {
          if (!offered.has(name)) {
            return { error: "UNKNOWN_TOOL" };
          }
          queries.push({ tool: name, arguments: args });
          return runQueryTool(toolCtx, name, args);
        },
        onQueryReplied: (call, result, step) => {
          if (typeof result !== "object" || result === null || "error" in result) {
            return;
          }
          const args = call.arguments ?? {};
          if (call.name === "get_collection") {
            const { namespace, canonicalId } = result as { namespace: string; canonicalId: string };
            const key = `${namespace}:${canonicalId}`;
            const info = collected.get(key);
            if (info && !fetchedCollections.has(key)) {
              fetchedCollections.set(key, { info, step });
            }
          }
          if (call.name === "get_catalog_season" && typeof args.season === "number") {
            if (!fetchedSeasons.has(args.season)) {
              fetchedSeasons.set(args.season, step);
            }
            const { episodes } = result as {
              episodes?: Array<{ episode: number; airDate: string | null }>;
            };
            if (episodes) {
              // A long season comes in windows (fromEpisode): keep the episodes of every call.
              episodeAirYears[args.season] = {
                ...episodeAirYears[args.season],
                ...Object.fromEntries(
                  episodes.map((e) => [
                    e.episode,
                    e.airDate ? Number(e.airDate.slice(0, 4)) : null,
                  ]),
                ),
              };
            }
          }
        },
        wrapUpMessage: () =>
          `The time, step or token budget is almost used up. Stop searching and conclude now with ${conclusionNames}.`,
        wrapUpRefusal: `No more searching: conclude with ${conclusionNames}.`,
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
    // Only what the model saw before the turn it concluded in counts.
    const fetched: SessionFetches = {
      fetchedCollections: new Map(
        [...fetchedCollections]
          .filter(([, f]) => f.step < conclusionStep)
          .map(([key, f]) => [key, f.info]),
      ),
      fetchedSeasons: new Set(
        [...fetchedSeasons].filter(([, step]) => step < conclusionStep).map(([season]) => season),
      ),
    };
    if (concluded?.verdict === "approve") {
      fallback = approvalBlocker(cr, conflictCodes, concluded.reasons, fetched);
    }
    if (concluded?.verdict === "reject_with_correction") {
      fallback = correctionBlocker(cr, concluded.correction, fetched, episodeAirYears);
    }
    const correction = concluded?.correction ?? null;

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

    // An outage says nothing about the request: review it again later instead of rejecting it.
    const outage =
      (!concluded && stop.kind === "model_error") || fallback?.startsWith("catalog_unavailable");
    if (outage) {
      return {
        status: "retry",
        runAfter: new Date(ctx.now.getTime() + OUTAGE_RETRY_MS),
        errorMessage: fallback ?? "review_outage",
      };
    }

    const approved = concluded?.verdict === "approve" && fallback === null;
    const rejected = concluded?.verdict === "reject_with_correction" && fallback === null;
    let opinion = concluded?.opinion ?? null;
    if (!rejected && correction) {
      // Rejected plainly: the opinion keeps the correction that did not hold (§4).
      opinion = `${opinion ?? ""}\n改正建议：${describeCorrection(correction)}`.trim();
    }
    const reviewAgent: JsonObject = {
      verdict: approved ? "approve" : rejected ? "reject_with_correction" : "reject",
      reasons: concluded?.reasons ?? [],
      opinion,
      ...(rejected ? { correction: correction as unknown as JsonObject } : {}),
      // Why the session's conclusion was not followed, or why there was none.
      fallback,
      queries: queries as unknown as JsonObject[],
      jobId: ctx.job.id,
      reviewedAt: ctx.now.toISOString(),
    };
    // No approval and no confirmed correction: reject, and exploration tries again later.
    const rejectPlainly = (trx: Transaction<Database>, record: JsonObject) =>
      rejectPlainlyInTx(
        trx,
        cr,
        record.opinion ? String(record.opinion) : `无法确认这条对应：${String(record.fallback)}`,
        { ...evidence, reviewAgent: record },
        ctx.now,
      );

    await ensureReviewAgentUser(ctx.db);
    return {
      status: "completed",
      result: { changeRequestId, verdict: reviewAgent.verdict, fallback },
      async onCommit(trx) {
        if (rejected) {
          await rejectWithCorrectionInTx(
            trx,
            cr,
            correction!,
            opinion,
            {
              ...evidence,
              reviewAgent,
            },
            ctx.now,
          );
          return;
        }
        if (!approved) {
          await rejectPlainly(trx, reviewAgent);
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
            return; // Decided meanwhile.
          }
          await rejectPlainly(trx, {
            ...reviewAgent,
            verdict: "reject",
            fallback: `approval_failed: ${error.code}`,
          });
        }
      },
    };
  };
}

/**
 * Why no review could approve this request, or null when it is a gate conflict a session may
 * decide. Only the gate's own needs_review (its first conflict code as the reason) is reviewable:
 * a clash with an existing or locked association, missing evidence or a Tier 1 platform is not.
 */
function unreviewableReason(cr: ChangeRequestRecord): string | null {
  const gate = cr.evidence?.gate as { conflicts?: Array<{ code?: unknown }> } | undefined;
  const codes = (gate?.conflicts ?? []).flatMap((c) =>
    typeof c.code === "string" ? [c.code] : [],
  );
  if (codes.length === 0 || cr.conflictReason !== codes[0]) {
    return cr.conflictReason ?? cr.decisionReason ?? "not_a_gate_conflict";
  }
  const blocking = codes.filter((code) => NON_OVERRIDABLE_CONFLICT_CODES.has(code));
  return blocking.length > 0
    ? `non_overridable_conflict: ${[...new Set(blocking)].join(", ")}`
    : null;
}

function nextUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

/** Rejects without a correction: the request's demand gets a not-found round and backs off. */
async function rejectPlainlyInTx(
  trx: Transaction<Database>,
  cr: ChangeRequestRecord,
  reason: string,
  evidence: JsonObject,
  now: Date,
): Promise<void> {
  try {
    await rejectChangeRequestInTx(trx, {
      changeRequestId: cr.id,
      reviewerUserId: REVIEW_AGENT_USER_ID,
      reason,
      evidence,
      now,
    });
  } catch (error) {
    if (error instanceof MediaServiceError && error.code === "INVALID_CHANGE_REQUEST_STATE") {
      return; // Decided meanwhile.
    }
    throw error;
  }
}

interface SessionFetches {
  fetchedCollections: ReadonlyMap<string, CollectionInfo>;
  fetchedSeasons: ReadonlySet<number>;
}

/** Whether the session fetched the collection and every season of these segments. */
function fetchBlocker(
  cr: ChangeRequestRecord,
  segments: ReadonlyArray<{ season: number }>,
  fetched: SessionFetches,
): string | null {
  if (!fetched.fetchedCollections.has(`${cr.namespace}:${cr.nativeId}`)) {
    return "collection_not_fetched";
  }
  const seasons = [...new Set(segments.map((s) => s.season))];
  const unfetched = seasons.filter((s) => !fetched.fetchedSeasons.has(s));
  return unfetched.length > 0 ? `season_not_fetched: ${unfetched.join(", ")}` : null;
}

/** Why code does not follow the model's approval (ADR 0003 §3), or null when it does. */
function approvalBlocker(
  cr: ChangeRequestRecord,
  conflictCodes: readonly string[],
  reasons: readonly ReviewReason[],
  fetched: SessionFetches,
): string | null {
  const blocking = conflictCodes.filter((code) => NON_OVERRIDABLE_CONFLICT_CODES.has(code));
  if (blocking.length > 0) {
    return `non_overridable_conflict: ${blocking.join(", ")}`;
  }
  const notFetched = fetchBlocker(cr, cr.segments, fetched);
  if (notFetched) {
    return notFetched;
  }
  const unexplained = conflictCodes.filter((code) => !reasons.some((r) => r.code === code));
  if (unexplained.length > 0) {
    return `no_reason_for: ${unexplained.join(", ")}`;
  }
  return null;
}

/**
 * Why code does not follow the model's correction (ADR 0003 §4), or null when it does: Evidence
 * Gate step 2 must pass on it, with the catalog and the collection this session fetched.
 */
function correctionBlocker(
  cr: ChangeRequestRecord,
  correction: ReviewCorrection | null,
  fetched: SessionFetches,
  episodeAirYears: CatalogEvidence["episodeAirYears"],
): string | null {
  if (!correction) {
    return "invalid_correction";
  }
  const notFetched = fetchBlocker(cr, correction.segments, fetched);
  if (notFetched) {
    return notFetched;
  }
  const key = (s: ReviewCorrection["segments"][number]) =>
    `${s.season}:${s.episodeStart}:${s.episodeEnd}:${s.targetEpisodeStart}`;
  if (correction.segments.map(key).join() === cr.segments.map(key).join()) {
    return "correction_same_as_submission";
  }
  const evidence = cr.evidence ?? {};
  const baseline = cr.segments[0]?.baseline ?? "tmdb";
  const catalog = { ...(evidence.catalog as unknown as CatalogEvidence), episodeAirYears };
  const collection = fetched.fetchedCollections.get(`${cr.namespace}:${cr.nativeId}`)!;
  const segments = correction.segments.map((s): NormalizedSegment => ({
    ...s,
    baseline,
    nonLinear: false,
    needsReview: false,
  }));
  // Exploration resubmits the correction through createChangeRequest: it must pass the same check.
  const valid = validateVariantSegments([segments], { baseline });
  if (!valid.valid) {
    return `correction_invalid_segments: ${[...new Set(valid.errors.map((e) => e.code))].join(", ")}`;
  }
  // Step 1 on the correction: only an episode count may differ, never the collection's identity.
  const step1 = evaluateEvidenceGateStep1(catalog, collection, { segments });
  const identity = step1.conflicts.filter((c) => !EPISODE_COUNT_CONFLICT_CODES.has(c.code));
  if (identity.length > 0) {
    return `correction_failed_step1: ${[...new Set(identity.map((c) => c.code))].join(", ")}`;
  }
  const step2 = evaluateEvidenceGateStep2({
    catalog,
    collection,
    segments,
    setDefaultVariant: cr.setDefaultVariant,
    variantDescription: cr.variantDescription,
    step1,
  });
  const misfit = positionMisfit(segments, collection, catalog.seasons);
  const blocking = step2.conflicts.filter(
    (c) => !(misfit === null && POSITION_GAP_CONFLICT_CODES.has(c.code)),
  );
  if (blocking.length > 0) {
    return `correction_failed_step2: ${[...new Set(blocking.map((c) => c.code))].join(", ")}`;
  }
  return misfit ? `correction_failed_step2: ${misfit}` : null;
}

/**
 * Rejects with the correction (ADR 0003 §4), in the job's transaction: the rejection says what was
 * wrong and the correction, a lead hands the correction to the exploration agent, and the
 * corrected season's demand is explorable now (the request's own demand reopens without backoff
 * only when the correction keeps its season).
 */
async function rejectWithCorrectionInTx(
  trx: Transaction<Database>,
  cr: ChangeRequestRecord,
  correction: ReviewCorrection,
  opinion: string | null,
  evidence: JsonObject,
  now: Date,
): Promise<void> {
  const reason = `${opinion ?? "提交有误"}\n改正：${describeCorrection(correction)}`;
  try {
    await rejectChangeRequestInTx(trx, {
      changeRequestId: cr.id,
      reviewerUserId: REVIEW_AGENT_USER_ID,
      reason,
      evidence,
      // Only a correction within the request's own seasons answers its demand; one to another
      // season leaves that demand a normal not-found round.
      corrected: cr.segments.some((s) => s.season === correction.season),
      now,
    });
  } catch (error) {
    if (error instanceof MediaServiceError && error.code === "INVALID_CHANGE_REQUEST_STATE") {
      return; // Decided meanwhile.
    }
    throw error;
  }
  await recordLead(trx, {
    targetExternalKey: cr.targetExternalKey,
    namespace: cr.namespace,
    nativeId: cr.nativeId,
    season: correction.season,
    segments: correction.segments,
    variantDescription: cr.variantDescription,
    notes: reason.slice(0, MAX_LEAD_NOTES_LENGTH),
    reporterUserId: REVIEW_AGENT_USER_ID,
    reporterKeyId: REVIEW_AGENT_KEY_ID,
  });
  await ensureDemandExplorableNowInTx(trx, {
    mediaId: cr.mediaId,
    externalKey: cr.targetExternalKey,
    season: correction.season,
    namespaceGroup: getNamespaceGroup(cr.namespace),
    now,
  });
}
