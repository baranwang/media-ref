/**
 * Exploration Agent Loop (`@media-ref/core`)
 *
 * ## Agent Library Choice Rationale
 * Rather than pulling a heavy multi-provider agent SDK (e.g. LangChain, Mastra, or Vercel AI SDK)
 * into the Cloudflare Worker, this module implements a lightweight, dependency-free, bounded
 * tool-calling loop directly on top of `OutboundClient.invokeModel`:
 *
 * 1. **Single test-double seam (Spec #1)**: Every model invocation MUST route through
 *    `OutboundClient` (backed in production by Cloudflare Workers `AI` binding + AI Gateway,
 *    and swapped between providers/models purely via env/config `AI_GATEWAY_ID`, `AI_PROVIDER`,
 *    `AI_MODEL`). Building directly over `OutboundClient.invokeModel` keeps tests 100%
 *    deterministic using recorded model responses at that exact seam.
 * 2. **Cloudflare `workerd` compatibility & bundle size**: Zero extra runtime dependencies,
 *    zero Node-only polyfill risks, minimal cold-start overhead inside the Background Worker.
 * 3. **Deterministic step & wall-clock budgets**: Explicit `maxSteps` (default 8) and
 *    `maxDurationMs` (default 60s) bounds guarantee every exploration job finishes well within
 *    Cloudflare Queues' 15-minute batch execution ceiling, and never falsely marks a timed-out
 *    or transiently errored platform as `not_found`.
 */

import {
  EXTERNAL_ID_NAMESPACES,
  formatExternalKey,
  isPlatformNamespace,
  type Namespace,
  type SegmentInput,
} from "@media-ref/client";
import type { Db } from "@media-ref/db";
import {
  AdapterTransientError,
  createDefaultAdapterRegistry,
  InvalidNativeIdError,
  isTier3Adapter,
  type AdapterRegistry,
  type Tier3Adapter,
} from "./adapters/index.ts";
import { isNonOriginalVariantDescription } from "./evidence-gate.ts";
import type {
  ExplorationExecutionContext,
  ExplorationExecutionResult,
  ExplorationExecutor,
  ExplorationTargetMedia,
  PlatformExplorationOutcome,
} from "./exploration-scheduler.ts";
import { listLeadsForTarget, type Lead } from "./leads.ts";
import { createChangeRequest, MediaServiceError } from "./media-service.ts";
import {
  combineAbortSignals,
  DEFAULT_AI_MODEL,
  DEFAULT_AI_PROVIDER,
  raceWithAbortSignal,
  type ModelMessage,
  type ModelToolDefinition,
  type OutboundClient,
} from "./outbound.ts";

export const EXPLORATION_AGENT_USER_ID = "system:exploration-agent";
export const EXPLORATION_AGENT_USER_EMAIL = "exploration-agent@system.mediaref.internal";
export const EXPLORATION_AGENT_USER_NAME = "Exploration Agent";
export const DEFAULT_EXPLORATION_MAX_STEPS = 8;
export const DEFAULT_EXPLORATION_MAX_DURATION_MS = 60_000;
export const DEFAULT_EXPLORATION_VARIANT_DESCRIPTION = "原声";

const MAX_LEADS_IN_PROMPT = 5;
const MAX_SAMPLE_EPISODES_HEAD = 5;
const MAX_SAMPLE_EPISODES_TAIL = 2;

export interface ExplorationAgentConfig {
  provider?: string;
  model?: string;
  gatewayId?: string;
  maxSteps?: number;
  maxDurationMs?: number;
  temperature?: number;
  maxTokens?: number;
  adapterRegistry?: AdapterRegistry;
  clockMs?: () => number;
}

export interface ResolvedExplorationAgentConfig {
  provider: string;
  model: string;
  gatewayId?: string;
  maxSteps: number;
  maxDurationMs: number;
  temperature: number;
  maxTokens: number;
}

const EXPLORATION_TOOLS: readonly ModelToolDefinition[] = [
  {
    name: "search_platform",
    description:
      "Search the target platform for candidate collections matching a keyword query. Returns deduplicated collection candidates with canonicalId, title, year, mediaType, and episodeCount.",
    parameters: {
      type: "object",
      properties: {
        keyword: {
          type: "string",
          description: "Search query keyword (localized title, original title, or season title).",
        },
        page: {
          type: "integer",
          description: "1-based search results page (default 1).",
        },
        limit: {
          type: "integer",
          description: "Maximum number of candidates to return (default 10).",
        },
      },
      required: ["keyword"],
    },
  },
  {
    name: "inspect_collection",
    description:
      "Fetch authoritative collection metadata and feature episode count (excluding trailers/PVs) for a candidate nativeId or URL on the target platform before submitting.",
    parameters: {
      type: "object",
      properties: {
        nativeId: {
          type: "string",
          description: "Candidate platform collection canonical ID or URL (e.g. ss34430).",
        },
      },
      required: ["nativeId"],
    },
  },
  {
    name: "submit_candidate",
    description:
      "Submit a verified candidate collection through the standard change request pipeline (evaluated by the deterministic Evidence Gate). Always prefer original-audio collections as the default variant.",
    parameters: {
      type: "object",
      properties: {
        nativeId: {
          type: "string",
          description: "Candidate platform collection canonical ID or URL.",
        },
        variantDescription: {
          type: "string",
          description:
            'Variant label for platform associations (defaults to "原声" for original audio).',
        },
        segments: {
          type: "array",
          description: "Episode segments for TV media with a baseline. Omit or pass [] for movies.",
          items: {
            type: "object",
            properties: {
              season: { type: "integer" },
              episodeStart: { type: "integer" },
              episodeEnd: { type: ["integer", "null"] },
              targetEpisodeStart: { type: "integer" },
              nonLinear: { type: "boolean" },
            },
            required: ["season", "episodeStart", "targetEpisodeStart"],
          },
        },
      },
      required: ["nativeId"],
    },
  },
  {
    name: "mark_not_found",
    description:
      "Conclude that no matching collection exists on the target platform after searching cleanly.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Brief explanation of why no matching collection was found.",
        },
      },
    },
  },
];

export function resolveExplorationAgentConfig(
  partial: ExplorationAgentConfig = {},
): ResolvedExplorationAgentConfig {
  const provider =
    typeof partial.provider === "string" && partial.provider.trim().length > 0
      ? partial.provider.trim()
      : DEFAULT_AI_PROVIDER;
  const model =
    typeof partial.model === "string" && partial.model.trim().length > 0
      ? partial.model.trim()
      : DEFAULT_AI_MODEL;
  const gatewayId =
    typeof partial.gatewayId === "string" && partial.gatewayId.trim().length > 0
      ? partial.gatewayId.trim()
      : undefined;
  const maxSteps =
    partial.maxSteps !== undefined && Number.isInteger(partial.maxSteps) && partial.maxSteps > 0
      ? partial.maxSteps
      : DEFAULT_EXPLORATION_MAX_STEPS;
  const maxDurationMs =
    partial.maxDurationMs !== undefined &&
    Number.isFinite(partial.maxDurationMs) &&
    partial.maxDurationMs > 0
      ? partial.maxDurationMs
      : DEFAULT_EXPLORATION_MAX_DURATION_MS;
  const temperature =
    partial.temperature !== undefined && Number.isFinite(partial.temperature)
      ? partial.temperature
      : 0;
  const maxTokens =
    partial.maxTokens !== undefined && Number.isInteger(partial.maxTokens) && partial.maxTokens > 0
      ? partial.maxTokens
      : 1024;

  return {
    provider,
    model,
    ...(gatewayId ? { gatewayId } : {}),
    maxSteps,
    maxDurationMs,
    temperature,
    maxTokens,
  };
}

/**
 * Ensures the system exploration agent submitter user row exists in `"user"`.
 * Uses `role: "user"` (NOT `"reviewer"`) so every agent submission passes through
 * the exact same Evidence Gate as human contributors.
 */
export async function ensureExplorationAgentUser(dbWrite: Db): Promise<string> {
  await dbWrite
    .insertInto("user")
    .values({
      id: EXPLORATION_AGENT_USER_ID,
      name: EXPLORATION_AGENT_USER_NAME,
      email: EXPLORATION_AGENT_USER_EMAIL,
      emailVerified: true,
      image: null,
      role: "user",
      reputation: 0,
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();

  return EXPLORATION_AGENT_USER_ID;
}

/**
 * Derives the idempotent `change_requests.task_id` UUID for a `(jobId, namespace)` pair.
 * - Single-platform exploration tasks use `jobId` directly, guaranteeing 1 change request per task.
 * - Multi-platform exploration tasks derive a deterministic RFC 4122 UUID from `(jobId, namespace)`
 *   so duplicate deliveries never create duplicate change requests while allowing one submission
 *   per target platform.
 */
export async function deriveExplorationTaskId(
  jobId: string,
  namespace: Namespace,
  totalTargets: number,
): Promise<string> {
  if (totalTargets <= 1) {
    return jobId;
  }

  const bytes = new TextEncoder().encode(`media-ref:exploration:${jobId}:${namespace}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  // Format first 16 bytes as RFC 4122 UUID (version 5 / variant 10xx)
  const uuidBytes = digest.slice(0, 16);
  uuidBytes[6] = (uuidBytes[6]! & 0x0f) | 0x50;
  uuidBytes[8] = (uuidBytes[8]! & 0x3f) | 0x80;

  const hex = Array.from(uuidBytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function selectTargetExternalKeyForMedia(media: ExplorationTargetMedia): string {
  const byNamespace = new Map<string, string>();
  for (const ext of media.externalIds) {
    if (!byNamespace.has(ext.namespace)) {
      byNamespace.set(ext.namespace, formatExternalKey(ext));
    }
  }
  for (const preferred of EXTERNAL_ID_NAMESPACES) {
    const key = byNamespace.get(preferred);
    if (key) {
      return key;
    }
  }
  return media.id;
}

async function loadLeadsContext(
  db: Db,
  media: ExplorationTargetMedia,
  namespace: Namespace,
  season: number | null,
): Promise<Lead[]> {
  const keys = media.externalIds.map((ext) => formatExternalKey(ext));
  if (keys.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const collected: Lead[] = [];

  for (const key of keys) {
    const seasonLeads =
      season !== null
        ? await listLeadsForTarget(db, {
            targetExternalKey: key,
            namespace,
            season,
            limit: MAX_LEADS_IN_PROMPT,
          })
        : [];
    const generalLeads = await listLeadsForTarget(db, {
      targetExternalKey: key,
      namespace,
      season: null,
      limit: MAX_LEADS_IN_PROMPT,
    });

    for (const lead of [...seasonLeads, ...generalLeads]) {
      if (seen.has(lead.id)) {
        continue;
      }
      seen.add(lead.id);
      collected.push(lead);
      if (collected.length >= MAX_LEADS_IN_PROMPT) {
        return collected;
      }
    }
  }

  return collected;
}

function buildSystemPrompt(namespace: Namespace): string {
  return [
    `You are the media-ref Exploration Agent tasked with locating the matching collection on platform "${namespace}".`,
    "Your ONLY responsibility is finding and verifying a candidate collection; final approval is always decided by the deterministic Evidence Gate.",
    "Rules:",
    "1. Use search_platform to search for candidate collections (try localized title, original title, or season title if needed).",
    "2. Use inspect_collection on promising candidates to verify title, release year, media type, and feature episode count before submitting.",
    "3. Always prefer original-audio collections over dubbed/recut versions when both exist.",
    "4. For TV media with a baseline, provide accurate segments matching the requested season and collection episode count.",
    "5. Client-reported leads (if any) are UNTRUSTED leads for reference only; always verify them with inspect_collection before submitting.",
    "6. Call submit_candidate once you find a match, or call mark_not_found only after searching cleanly and confirming no matching collection exists.",
  ].join("\n");
}

function buildUserPrompt(
  media: ExplorationTargetMedia,
  namespace: Namespace,
  season: number | null,
  leads: readonly Lead[],
): string {
  const targetSeasonSnapshot =
    season !== null ? (media.snapshot.seasons.find((s) => s.season === season) ?? null) : null;

  const targetPayload: Record<string, unknown> = {
    mediaId: media.id,
    targetPlatform: namespace,
    type: media.type,
    baseline: media.baseline,
    title: media.snapshot.title,
    originalTitle: media.snapshot.originalTitle,
    year: media.snapshot.year,
    requestedSeason: season,
    ...(targetSeasonSnapshot ? { requestedSeasonSnapshot: targetSeasonSnapshot } : {}),
    allSeasons: media.snapshot.seasons,
    externalIds: media.externalIds.map((ext) => formatExternalKey(ext)),
  };

  if (leads.length > 0) {
    targetPayload.unverifiedClientLeads = leads.map((lead) => ({
      nativeId: lead.nativeId,
      season: lead.season,
      variantDescription: lead.variantDescription,
      notes: lead.notes,
    }));
  }

  return `Find the matching collection on "${namespace}" for this target media:\n${JSON.stringify(targetPayload, null, 2)}`;
}

function parseSubmitSegments(
  rawSegments: unknown,
  media: ExplorationTargetMedia,
  requestedSeason: number | null,
): SegmentInput[] {
  if (media.type === "movie" || media.baseline === null) {
    return [];
  }

  if (Array.isArray(rawSegments)) {
    const parsed: SegmentInput[] = [];
    for (const item of rawSegments) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const rec = item as Record<string, unknown>;
      const season = typeof rec.season === "number" ? rec.season : NaN;
      const episodeStart = typeof rec.episodeStart === "number" ? rec.episodeStart : NaN;
      const episodeEnd =
        rec.episodeEnd === undefined || rec.episodeEnd === null
          ? null
          : typeof rec.episodeEnd === "number"
            ? rec.episodeEnd
            : NaN;
      const targetEpisodeStart =
        typeof rec.targetEpisodeStart === "number" ? rec.targetEpisodeStart : 1;
      const nonLinear = typeof rec.nonLinear === "boolean" ? rec.nonLinear : false;

      parsed.push({
        season,
        episodeStart,
        episodeEnd,
        targetEpisodeStart,
        baseline: media.baseline,
        nonLinear,
      });
    }
    return parsed;
  }

  if (requestedSeason !== null) {
    const seasonSnapshot = media.snapshot.seasons.find((s) => s.season === requestedSeason);
    return [
      {
        season: requestedSeason,
        episodeStart: 1,
        episodeEnd:
          seasonSnapshot && seasonSnapshot.episodeCount > 0 ? seasonSnapshot.episodeCount : null,
        targetEpisodeStart: 1,
        baseline: media.baseline,
      },
    ];
  }

  return [];
}

async function resolveAgentVariantSubmission(
  db: Db,
  mediaId: string,
  namespace: Namespace,
  rawVariantDescription: unknown,
): Promise<{
  variantId: string | null;
  variantDescription: string | null;
  setDefaultVariant: boolean;
}> {
  if (!isPlatformNamespace(namespace)) {
    return {
      variantId: null,
      variantDescription: null,
      setDefaultVariant: false,
    };
  }

  const requestedDescription =
    typeof rawVariantDescription === "string" && rawVariantDescription.trim().length > 0
      ? rawVariantDescription.trim()
      : null;

  // Spec #1 US #68: agent ALWAYS prefers original audio as default.
  // Non-original variants (dubs / recuts) MUST NEVER be marked as default.
  if (requestedDescription !== null && isNonOriginalVariantDescription(requestedDescription)) {
    return {
      variantId: null,
      variantDescription: requestedDescription,
      setDefaultVariant: false,
    };
  }

  // If an original-audio default variant already exists for (media, platform),
  // reuse it when the agent did not ask for a distinct variant label so multi-season
  // associations stay grouped under the same default original variant.
  const existingDefault = await db
    .selectFrom("variants")
    .select(["id", "description"])
    .where("media_id", "=", mediaId)
    .where("platform", "=", namespace)
    .where("is_default", "=", true)
    .executeTakeFirst();

  if (
    existingDefault &&
    !isNonOriginalVariantDescription(existingDefault.description) &&
    (requestedDescription === null || requestedDescription === existingDefault.description)
  ) {
    return {
      variantId: existingDefault.id,
      variantDescription: existingDefault.description,
      setDefaultVariant: true,
    };
  }

  return {
    variantId: null,
    variantDescription: requestedDescription ?? DEFAULT_EXPLORATION_VARIANT_DESCRIPTION,
    setDefaultVariant: true,
  };
}

async function exploreSinglePlatform(
  ctx: ExplorationExecutionContext,
  adapter: Tier3Adapter,
  config: ResolvedExplorationAgentConfig,
  clockMs: () => number,
  deadlineMs: number,
): Promise<PlatformExplorationOutcome> {
  const namespace = adapter.namespace;
  const taskId = await deriveExplorationTaskId(ctx.jobId, namespace, ctx.targetNamespaces.length);

  // Fast-path idempotency: if a prior attempt or concurrent delivery of this exact task already
  // created a change request for this task_id, return it without burning redundant model/platform calls.
  const existingCr = await ctx.db
    .selectFrom("change_requests")
    .select(["id", "native_id"])
    .where("task_id", "=", taskId)
    .executeTakeFirst();

  if (existingCr) {
    return {
      namespace,
      status: "submitted",
      changeRequestId: existingCr.id,
      nativeId: existingCr.native_id,
    };
  }

  const leads = await loadLeadsContext(ctx.db, ctx.media, namespace, ctx.season);
  const messages: ModelMessage[] = [
    { role: "system", content: buildSystemPrompt(namespace) },
    { role: "user", content: buildUserPrompt(ctx.media, namespace, ctx.season, leads) },
  ];

  const targetSeasonSnap =
    ctx.season !== null
      ? (ctx.media.snapshot.seasons.find((s) => s.season === ctx.season) ?? null)
      : null;
  const targetYear = targetSeasonSnap?.airYear ?? ctx.media.snapshot.year;

  let searchSucceededCount = 0;
  let hadTransientError = false;
  let lastTransientReason = "transient_error";
  let lastTransientRetryAfterMs: number | undefined;

  const isBudgetExceeded = (): boolean => clockMs() >= deadlineMs;

  const createBudgetSignal = (): { signal: AbortSignal; dispose: () => void } => {
    const controller = new AbortController();
    const remainingMs = Math.max(0, deadlineMs - clockMs());
    if (remainingMs <= 0) {
      controller.abort(new Error("exploration_time_budget_exceeded"));
      return { signal: controller.signal, dispose: () => {} };
    }
    const timer = setTimeout(() => {
      controller.abort(new Error("exploration_time_budget_exceeded"));
    }, remainingMs);
    return {
      signal: controller.signal,
      dispose: () => clearTimeout(timer),
    };
  };

  const withBudgetOutbound = (signal: AbortSignal): OutboundClient => ({
    fetchExternal: (request) =>
      raceWithAbortSignal(
        ctx.outbound.fetchExternal({
          ...request,
          signal: combineAbortSignals(signal, request.timeoutMs),
        }),
        signal,
        "exploration_time_budget_exceeded",
      ),
    sendEmail: (message) => ctx.outbound.sendEmail(message),
    invokeModel: (request) =>
      raceWithAbortSignal(
        ctx.outbound.invokeModel({
          ...request,
          signal: combineAbortSignals(signal, request.timeoutMs),
        }),
        signal,
        "exploration_time_budget_exceeded",
      ),
  });

  const budget = createBudgetSignal();
  const budgetedOutbound = withBudgetOutbound(budget.signal);

  try {
    for (let step = 0; step < config.maxSteps; step += 1) {
      if (isBudgetExceeded() || budget.signal.aborted) {
        return {
          namespace,
          status: "transient_error",
          reason: "exploration_time_budget_exceeded",
        };
      }

      let modelResponse;
      try {
        modelResponse = await budgetedOutbound.invokeModel({
          provider: config.provider,
          model: config.model,
          ...(config.gatewayId ? { gatewayId: config.gatewayId } : {}),
          messages: [...messages],
          tools: [...EXPLORATION_TOOLS],
          temperature: config.temperature,
          maxTokens: config.maxTokens,
        });
      } catch (error) {
        return {
          namespace,
          status: "transient_error",
          reason:
            budget.signal.aborted || isBudgetExceeded()
              ? "exploration_time_budget_exceeded"
              : error instanceof Error
                ? error.message
                : "model_invocation_failed",
        };
      }

      const assistantText = modelResponse.text ?? modelResponse.content ?? "";
      const toolCalls = modelResponse.toolCalls ?? [];

      messages.push({
        role: "assistant",
        content: assistantText,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      });

      if (toolCalls.length === 0) {
        if (hadTransientError) {
          return {
            namespace,
            status: "transient_error",
            reason: lastTransientReason,
            ...(lastTransientRetryAfterMs !== undefined
              ? { retryAfterMs: lastTransientRetryAfterMs }
              : {}),
          };
        }
        if (searchSucceededCount > 0) {
          return {
            namespace,
            status: "not_found",
            reason: assistantText.trim() || "model_finished_without_candidate",
          };
        }
        return {
          namespace,
          status: "transient_error",
          reason: "model_stopped_without_searching",
        };
      }

      for (const toolCall of toolCalls) {
        if (isBudgetExceeded() || budget.signal.aborted) {
          return {
            namespace,
            status: "transient_error",
            reason: "exploration_time_budget_exceeded",
          };
        }

        const args = toolCall.arguments ?? {};

        if (toolCall.name === "search_platform") {
          const keyword =
            typeof args.keyword === "string" && args.keyword.trim().length > 0
              ? args.keyword.trim()
              : ctx.media.snapshot.title;
          const page =
            typeof args.page === "number" && Number.isInteger(args.page) && args.page > 0
              ? args.page
              : 1;
          const limit =
            typeof args.limit === "number" && Number.isInteger(args.limit) && args.limit > 0
              ? Math.min(args.limit, 20)
              : 10;

          let searchResult;
          try {
            searchResult = await raceWithAbortSignal(
              adapter.search(
                {
                  title: keyword,
                  originalTitle: ctx.media.snapshot.originalTitle,
                  year: targetYear,
                  mediaType: ctx.media.type,
                  season: ctx.season,
                  page,
                  limit,
                },
                budgetedOutbound,
              ),
              budget.signal,
              "exploration_time_budget_exceeded",
            );
          } catch (error) {
            if (budget.signal.aborted || isBudgetExceeded()) {
              return {
                namespace,
                status: "transient_error",
                reason: "exploration_time_budget_exceeded",
              };
            }
            throw error;
          }

          if (searchResult.status === "transient_error") {
            hadTransientError = true;
            lastTransientReason = searchResult.reason;
            if (searchResult.retryAfterMs !== undefined) {
              lastTransientRetryAfterMs = searchResult.retryAfterMs;
            }
            messages.push({
              role: "tool",
              toolCallId: toolCall.id,
              name: toolCall.name,
              content: JSON.stringify({
                status: "transient_error",
                reason: searchResult.reason,
              }),
            });
          } else {
            searchSucceededCount += 1;
            messages.push({
              role: "tool",
              toolCallId: toolCall.id,
              name: toolCall.name,
              content: JSON.stringify({
                status: "ok",
                candidates: searchResult.candidates,
              }),
            });
          }
          continue;
        }

        if (toolCall.name === "inspect_collection") {
          const rawNativeId = typeof args.nativeId === "string" ? args.nativeId.trim() : "";
          if (rawNativeId.length === 0) {
            messages.push({
              role: "tool",
              toolCallId: toolCall.id,
              name: toolCall.name,
              content: JSON.stringify({
                status: "error",
                reason: "nativeId must be a non-empty string",
              }),
            });
            continue;
          }

          let canonicalId: string;
          try {
            canonicalId = await raceWithAbortSignal(
              adapter.canonicalize(rawNativeId, budgetedOutbound),
              budget.signal,
              "exploration_time_budget_exceeded",
            );
          } catch (error) {
            if (budget.signal.aborted || isBudgetExceeded()) {
              return {
                namespace,
                status: "transient_error",
                reason: "exploration_time_budget_exceeded",
              };
            }
            if (error instanceof InvalidNativeIdError) {
              messages.push({
                role: "tool",
                toolCallId: toolCall.id,
                name: toolCall.name,
                content: JSON.stringify({
                  status: "invalid_id",
                  reason: error.reason,
                }),
              });
              continue;
            }
            if (error instanceof AdapterTransientError) {
              hadTransientError = true;
              lastTransientReason = error.reason;
              if (error.retryAfterMs !== undefined) {
                lastTransientRetryAfterMs = error.retryAfterMs;
              }
              messages.push({
                role: "tool",
                toolCallId: toolCall.id,
                name: toolCall.name,
                content: JSON.stringify({
                  status: "transient_error",
                  reason: error.reason,
                }),
              });
              continue;
            }
            throw error;
          }

          let evidence;
          try {
            evidence = await raceWithAbortSignal(
              adapter.fetchCollection(canonicalId, budgetedOutbound),
              budget.signal,
              "exploration_time_budget_exceeded",
            );
          } catch (error) {
            if (budget.signal.aborted || isBudgetExceeded()) {
              return {
                namespace,
                status: "transient_error",
                reason: "exploration_time_budget_exceeded",
              };
            }
            throw error;
          }
          if (evidence.status === "transient_error") {
            hadTransientError = true;
            lastTransientReason = evidence.reason;
            if (evidence.retryAfterMs !== undefined) {
              lastTransientRetryAfterMs = evidence.retryAfterMs;
            }
            messages.push({
              role: "tool",
              toolCallId: toolCall.id,
              name: toolCall.name,
              content: JSON.stringify({
                status: "transient_error",
                reason: evidence.reason,
              }),
            });
            continue;
          }

          if (evidence.status === "not_found") {
            messages.push({
              role: "tool",
              toolCallId: toolCall.id,
              name: toolCall.name,
              content: JSON.stringify({
                status: "not_found",
                canonicalId,
                reason: evidence.reason ?? "collection_not_found",
              }),
            });
            continue;
          }

          const info = evidence.info;
          const eps = info.featureEpisodes;
          const sampleEpisodes =
            eps.length <= MAX_SAMPLE_EPISODES_HEAD + MAX_SAMPLE_EPISODES_TAIL
              ? eps
              : [
                  ...eps.slice(0, MAX_SAMPLE_EPISODES_HEAD),
                  ...eps.slice(-MAX_SAMPLE_EPISODES_TAIL),
                ];

          messages.push({
            role: "tool",
            toolCallId: toolCall.id,
            name: toolCall.name,
            content: JSON.stringify({
              status: "found",
              info: {
                namespace: info.namespace,
                canonicalId: info.canonicalId,
                title: info.title,
                originalTitle: info.originalTitle ?? null,
                aliases: info.aliases ?? [],
                year: info.year,
                mediaType: info.mediaType,
                featureEpisodeCount: info.featureEpisodeCount,
                sampleEpisodes,
              },
            }),
          });
          continue;
        }

        if (toolCall.name === "submit_candidate") {
          const rawNativeId = typeof args.nativeId === "string" ? args.nativeId.trim() : "";
          if (rawNativeId.length === 0) {
            messages.push({
              role: "tool",
              toolCallId: toolCall.id,
              name: toolCall.name,
              content: JSON.stringify({
                ok: false,
                error: "INVALID_NATIVE_ID",
                message: "nativeId must be a non-empty string",
              }),
            });
            continue;
          }

          await ensureExplorationAgentUser(ctx.db);
          const variant = await resolveAgentVariantSubmission(
            ctx.db,
            ctx.media.id,
            namespace,
            args.variantDescription,
          );
          const segments = parseSubmitSegments(args.segments, ctx.media, ctx.season);
          const targetExternalKey = selectTargetExternalKeyForMedia(ctx.media);

          try {
            const changeRequest = await createChangeRequest(
              ctx.db,
              {
                submitterUserId: EXPLORATION_AGENT_USER_ID,
                submitterKeyId: null,
                submitterType: "agent",
                taskId,
                targetExternalKey,
                namespace,
                nativeId: rawNativeId,
                variantId: variant.variantId,
                variantDescription: variant.variantDescription,
                setDefaultVariant: variant.setDefaultVariant,
                segments,
                now: ctx.now,
              },
              {
                adapterRegistry: ctx.adapterRegistry,
                outbound: ctx.outbound,
                now: ctx.now,
              },
            );

            return {
              namespace,
              status: "submitted",
              changeRequestId: changeRequest.id,
              nativeId: changeRequest.nativeId,
            };
          } catch (error) {
            if (error instanceof MediaServiceError) {
              if (error.code === "PLATFORM_UPSTREAM_ERROR") {
                hadTransientError = true;
                lastTransientReason = error.message;
              }
              messages.push({
                role: "tool",
                toolCallId: toolCall.id,
                name: toolCall.name,
                content: JSON.stringify({
                  ok: false,
                  error: error.code,
                  message: error.message,
                }),
              });
              continue;
            }
            throw error;
          }
        }

        if (toolCall.name === "mark_not_found") {
          const reason =
            typeof args.reason === "string" && args.reason.trim().length > 0
              ? args.reason.trim()
              : "no_matching_collection";

          if (hadTransientError) {
            return {
              namespace,
              status: "transient_error",
              reason: lastTransientReason,
              ...(lastTransientRetryAfterMs !== undefined
                ? { retryAfterMs: lastTransientRetryAfterMs }
                : {}),
            };
          }

          if (searchSucceededCount === 0) {
            messages.push({
              role: "tool",
              toolCallId: toolCall.id,
              name: toolCall.name,
              content: JSON.stringify({
                ok: false,
                error: "SEARCH_REQUIRED_BEFORE_NOT_FOUND",
                message: "Call search_platform at least once before marking not_found.",
              }),
            });
            continue;
          }

          return {
            namespace,
            status: "not_found",
            reason,
          };
        }

        messages.push({
          role: "tool",
          toolCallId: toolCall.id,
          name: toolCall.name,
          content: JSON.stringify({
            ok: false,
            error: "UNKNOWN_TOOL",
            message: `Unknown tool "${toolCall.name}"`,
          }),
        });
      }
    }

    if (hadTransientError) {
      return {
        namespace,
        status: "transient_error",
        reason: lastTransientReason,
        ...(lastTransientRetryAfterMs !== undefined
          ? { retryAfterMs: lastTransientRetryAfterMs }
          : {}),
      };
    }

    if (searchSucceededCount > 0) {
      return {
        namespace,
        status: "not_found",
        reason: "max_steps_exhausted",
      };
    }

    return {
      namespace,
      status: "transient_error",
      reason: "max_steps_exhausted_without_search",
    };
  } finally {
    budget.dispose();
  }
}

export function createExplorationAgentExecutor(
  options: ExplorationAgentConfig = {},
): ExplorationExecutor {
  const config = resolveExplorationAgentConfig(options);
  const clockMs = options.clockMs ?? (() => Date.now());
  const defaultRegistry = options.adapterRegistry ?? createDefaultAdapterRegistry();

  return async (ctx: ExplorationExecutionContext): Promise<ExplorationExecutionResult> => {
    const startMs = clockMs();
    const deadlineMs = startMs + config.maxDurationMs;
    const registry: AdapterRegistry = ctx.adapterRegistry ?? defaultRegistry;
    const platformOutcomes: PlatformExplorationOutcome[] = [];

    for (const namespace of ctx.targetNamespaces) {
      const adapter = registry.get(namespace);
      if (!adapter || !isTier3Adapter(adapter)) {
        continue;
      }

      const platformStartMs = clockMs();
      const outcome = await exploreSinglePlatform(ctx, adapter, config, clockMs, deadlineMs);
      const platformDurationMs = Math.max(0, clockMs() - platformStartMs);
      platformOutcomes.push({
        ...outcome,
        durationMs: platformDurationMs,
      });
    }

    const durationMs = Math.max(0, clockMs() - startMs);
    return {
      platformOutcomes,
      durationMs,
    };
  };
}
