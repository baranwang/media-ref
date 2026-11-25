/**
 * Exploration agent (`@media-ref/core`), ADR 0002: discover → judge → gate.
 *
 * 1. **Discover** (no model): `discoverCandidates` asks 360kan, Douban "where to watch" and iQIYI
 *    search once per job; client leads add their own IDs. Every candidate is fetched with the
 *    platform adapter's `fetchCollection`, so the agent only ever works on collections it has seen.
 * 2. **Fast path**: a single fetched candidate that already passes Evidence Gate Step 1 with the
 *    default segments is submitted without calling the model.
 * 3. **Judge** (model): otherwise a bounded tool loop picks among the fetched candidates. It can only
 *    look (`list_episodes`, `get_catalog_season`) and conclude (`submit_mapping`, `mark_not_found`);
 *    it cannot search or name a collection outside the candidate set.
 * 4. **Gate** (code): a submission must name a fetched candidate and its segments must fit inside
 *    that collection's fetched episode list; then the normal change-request Evidence Gate runs.
 *
 * Each platform has its own wall-clock budget and step limit, and reports its own outcome.
 * All model calls go through `OutboundClient.invokeModel` (Workers AI binding + AI Gateway).
 */

import {
  EXTERNAL_ID_NAMESPACES,
  formatExternalKey,
  isPlatformNamespace,
  normalizeSegments,
  type Namespace,
  type SegmentInput,
} from "@media-ref/client";
import type { Db } from "@media-ref/db";
import {
  AdapterTransientError,
  createDefaultAdapterRegistry,
  isTier2Adapter,
  type AdapterRegistry,
  type CollectionInfo,
  type Tier2Adapter,
  type Tier3Adapter,
} from "./adapters/index.ts";
import {
  discoverCandidates,
  type DiscoveryMediaInput,
  type DiscoveryResult,
} from "./discovery/candidates.ts";
import {
  evaluateEvidenceGateStep1,
  isNonOriginalVariantDescription,
  type CatalogEvidence,
} from "./evidence-gate.ts";
import type {
  ExplorationExecutionContext,
  ExplorationExecutionResult,
  ExplorationExecutor,
  ExplorationTargetMedia,
  PlatformExplorationOutcome,
} from "./exploration-scheduler.ts";
import { loadCatalogEvidenceForMedia } from "./invalidation.ts";
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
/** Candidates fetched per platform; discovery already filters, this bounds the worst case. */
const MAX_CANDIDATES_PER_PLATFORM = 4;
const MAX_EPISODES_IN_TOOL_RESULT = 80;

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
  /** Test seam; defaults to `discoverCandidates`. */
  discover?: typeof discoverCandidates;
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

const JUDGE_TOOLS: readonly ModelToolDefinition[] = [
  {
    name: "list_episodes",
    description:
      "List the feature episodes (index, title, air date) of one candidate collection. Trailers and extras are already excluded.",
    parameters: {
      type: "object",
      properties: {
        canonicalId: { type: "string", description: "canonicalId of a listed candidate." },
      },
      required: ["canonicalId"],
    },
  },
  {
    name: "get_catalog_season",
    description:
      "Get the target media's season from the baseline catalog: episode count and air year.",
    parameters: {
      type: "object",
      properties: { season: { type: "integer" } },
      required: ["season"],
    },
  },
  {
    name: "submit_mapping",
    description:
      "Submit one listed candidate as the match. For TV, segments map baseline episodes to the collection's episode indexes: baseline episodes episodeStart..episodeEnd of `season` play as collection episodes targetEpisodeStart onward. Omit segments to map the requested season 1:1.",
    parameters: {
      type: "object",
      properties: {
        canonicalId: { type: "string", description: "canonicalId of a listed candidate." },
        variantDescription: {
          type: "string",
          description: 'Variant label, "原声" for original audio (default).',
        },
        segments: {
          type: "array",
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
      required: ["canonicalId"],
    },
  },
  {
    name: "mark_not_found",
    description: "Conclude that none of the listed candidates is the target media.",
    parameters: {
      type: "object",
      properties: { reason: { type: "string" } },
    },
  },
];

type CollectionAdapter = Tier2Adapter | Tier3Adapter;

interface FetchedCandidate {
  info: CollectionInfo;
  sources: string[];
}

function toDiscoveryInput(
  media: ExplorationTargetMedia,
  season: number | null,
): DiscoveryMediaInput {
  const externalIds: Partial<Record<Namespace, string>> = {};
  for (const ext of media.externalIds) {
    externalIds[ext.namespace] ??= ext.nativeId;
  }
  return {
    title: media.snapshot.title,
    originalTitle: media.snapshot.originalTitle,
    year: media.snapshot.year,
    mediaType: media.type,
    season,
    externalIds,
  };
}

/** Segments used when nobody says otherwise: the requested season mapped 1:1. */
function defaultSegments(media: ExplorationTargetMedia, season: number | null): SegmentInput[] {
  if (media.type === "movie" || media.baseline === null || season === null) {
    return [];
  }
  const snap = media.snapshot.seasons.find((s) => s.season === season);
  return [
    {
      season,
      episodeStart: 1,
      episodeEnd: snap && snap.episodeCount > 0 ? snap.episodeCount : null,
      targetEpisodeStart: 1,
      baseline: media.baseline,
    },
  ];
}

function parseModelSegments(
  raw: unknown,
  media: ExplorationTargetMedia,
  season: number | null,
): SegmentInput[] {
  if (media.type === "movie" || media.baseline === null) {
    return [];
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    return defaultSegments(media, season);
  }
  const num = (v: unknown, fallback: number) => (typeof v === "number" ? v : fallback);
  return raw.flatMap((item): SegmentInput[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const rec = item as Record<string, unknown>;
    return [
      {
        season: num(rec.season, NaN),
        episodeStart: num(rec.episodeStart, NaN),
        episodeEnd:
          rec.episodeEnd === undefined || rec.episodeEnd === null ? null : num(rec.episodeEnd, NaN),
        targetEpisodeStart: num(rec.targetEpisodeStart, 1),
        baseline: media.baseline!,
        nonLinear: rec.nonLinear === true,
      },
    ];
  });
}

/**
 * Evidence door: every segment must land inside the collection's fetched feature episodes.
 * An open-ended segment runs to the end of its baseline season, so that season's episode count
 * must be known. Returns a reason when a segment does not fit.
 */
export function checkSegmentsFitCollection(
  segments: readonly SegmentInput[],
  info: CollectionInfo,
  seasonEpisodeCount: (season: number) => number | null,
): string | null {
  const available = info.featureEpisodes.length;
  for (const seg of segments) {
    const targetStart = seg.targetEpisodeStart ?? 1;
    if (!Number.isInteger(targetStart) || targetStart < 1) {
      return "targetEpisodeStart must be a positive integer";
    }
    let end = seg.episodeEnd ?? null;
    if (end === null) {
      end = seasonEpisodeCount(seg.season);
      if (end === null) {
        return `episodeEnd is required: season ${seg.season} has no known episode count`;
      }
    }
    const span = end - (seg.episodeStart ?? 1);
    if (!Number.isInteger(span) || span < 0) {
      return "episodeEnd must not be before episodeStart";
    }
    const lastTarget = targetStart + span;
    if (available === 0 || lastTarget > available) {
      return `segment reaches collection episode ${lastTarget}, but ${info.canonicalId} has ${available} fetched feature episodes`;
    }
  }
  return null;
}

function summarizeCandidate(candidate: FetchedCandidate, step1Pass: boolean) {
  const { info } = candidate;
  return {
    canonicalId: info.canonicalId,
    title: info.title,
    originalTitle: info.originalTitle ?? null,
    year: info.year,
    mediaType: info.mediaType,
    featureEpisodeCount: info.featureEpisodes.length,
    sources: candidate.sources,
    passesAutomaticCheckWithDefaultMapping: step1Pass,
  };
}

function buildJudgeSystemPrompt(namespace: Namespace): string {
  return [
    `You decide which candidate collection on "${namespace}" is the target media, or that none is.`,
    "Rules:",
    "1. Only the listed candidates exist for you; you cannot search. Submit only a listed canonicalId.",
    "2. Check title, year, media type and episode count. Use list_episodes when counts or seasons are unclear.",
    "3. Prefer the original-audio collection over dubbed or recut versions.",
    "4. A collection may hold several seasons, or a season may be split; express that with segments.",
    "5. passesAutomaticCheckWithDefaultMapping is a hint from a deterministic check, not a decision.",
    "6. Finish with exactly one submit_mapping or mark_not_found.",
  ].join("\n");
}

function buildJudgeUserPrompt(
  media: ExplorationTargetMedia,
  namespace: Namespace,
  season: number | null,
  candidates: ReturnType<typeof summarizeCandidate>[],
): string {
  const payload = {
    target: {
      type: media.type,
      title: media.snapshot.title,
      originalTitle: media.snapshot.originalTitle,
      year: media.snapshot.year,
      requestedSeason: season,
      seasons: media.snapshot.seasons,
    },
    platform: namespace,
    candidates,
  };
  return `Pick the matching collection:\n${JSON.stringify(payload, null, 2)}`;
}

interface PlatformBudget {
  outbound: OutboundClient;
  signal: AbortSignal;
  expired(): boolean;
  dispose(): void;
}

const BUDGET_EXCEEDED = "exploration_time_budget_exceeded";

function createPlatformBudget(
  outbound: OutboundClient,
  deadlineMs: number,
  clockMs: () => number,
): PlatformBudget {
  const controller = new AbortController();
  const remainingMs = Math.max(0, deadlineMs - clockMs());
  const timer =
    remainingMs > 0
      ? setTimeout(() => controller.abort(new Error(BUDGET_EXCEEDED)), remainingMs)
      : undefined;
  if (remainingMs <= 0) {
    controller.abort(new Error(BUDGET_EXCEEDED));
  }
  const signal = controller.signal;
  return {
    signal,
    expired: () => signal.aborted || clockMs() >= deadlineMs,
    dispose: () => clearTimeout(timer),
    outbound: {
      fetchExternal: (request) =>
        raceWithAbortSignal(
          outbound.fetchExternal({
            ...request,
            signal: combineAbortSignals(signal, request.timeoutMs),
          }),
          signal,
          BUDGET_EXCEEDED,
        ),
      sendEmail: (message) => outbound.sendEmail(message),
      invokeModel: (request) =>
        raceWithAbortSignal(
          outbound.invokeModel({
            ...request,
            signal: combineAbortSignals(signal, request.timeoutMs),
          }),
          signal,
          BUDGET_EXCEEDED,
        ),
    },
  };
}

class PlatformTransient extends Error {
  constructor(
    readonly reason: string,
    readonly retryAfterMs?: number,
  ) {
    super(reason);
  }
}

async function explorePlatform(
  ctx: ExplorationExecutionContext,
  adapter: CollectionAdapter,
  discovery: DiscoveryResult,
  catalog: CatalogEvidence,
  config: ResolvedExplorationAgentConfig,
  clockMs: () => number,
): Promise<PlatformExplorationOutcome> {
  const namespace = adapter.namespace;
  const taskId = await deriveExplorationTaskId(ctx.jobId, namespace, ctx.targetNamespaces.length);

  // A redelivered job must not submit twice for the same platform.
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

  const budget = createPlatformBudget(ctx.outbound, clockMs() + config.maxDurationMs, clockMs);
  let transient: PlatformTransient | null = null;
  const noteTransient = (error: PlatformTransient) => {
    transient = error;
  };
  const transientOutcome = (fallback: string): PlatformExplorationOutcome => {
    const t = transient as PlatformTransient | null;
    return {
      namespace,
      status: "transient_error",
      reason: budget.expired() ? BUDGET_EXCEEDED : (t?.reason ?? fallback),
      ...(t?.retryAfterMs !== undefined ? { retryAfterMs: t.retryAfterMs } : {}),
    };
  };

  try {
    // 1. Candidate IDs: discovery plus client leads (untrusted, but they still go through fetch).
    const sourcesById = new Map<string, string[]>();
    for (const c of discovery.candidates) {
      if (c.namespace === namespace) {
        sourcesById.set(
          c.canonicalId,
          c.sources.map((s) => s.source),
        );
      }
    }
    const leads = await loadLeadsContext(ctx.db, ctx.media, namespace, ctx.season);
    for (const lead of leads) {
      try {
        const id = await adapter.canonicalize(lead.nativeId, budget.outbound);
        sourcesById.set(id, [...(sourcesById.get(id) ?? []), "client_lead"]);
      } catch {
        // An unusable lead is just skipped.
      }
    }
    // A source error, or a link for this platform that could not be resolved for now, means
    // the absence of candidates is not evidence of absence.
    const discoveryErrored =
      discovery.sources.some((s) => s.status === "error") ||
      discovery.dropped.some(
        (d) => d.namespace === namespace && d.reason.startsWith("canonicalize_transient:"),
      );
    if (sourcesById.size === 0) {
      return discoveryErrored
        ? { namespace, status: "transient_error", reason: "discovery_source_error" }
        : { namespace, status: "not_found", reason: "no_discovery_candidates" };
    }

    // 2. Fetch every candidate; only fetched collections can be submitted.
    const fetched = new Map<string, FetchedCandidate>();
    for (const [id, sources] of [...sourcesById].slice(0, MAX_CANDIDATES_PER_PLATFORM)) {
      if (budget.expired()) {
        return transientOutcome(BUDGET_EXCEEDED);
      }
      try {
        const evidence = await adapter.fetchCollection(id, budget.outbound);
        if (evidence.status === "found") {
          fetched.set(evidence.info.canonicalId, { info: evidence.info, sources });
        } else if (evidence.status === "transient_error") {
          noteTransient(new PlatformTransient(evidence.reason, evidence.retryAfterMs));
        }
      } catch (error) {
        if (budget.expired()) {
          return transientOutcome(BUDGET_EXCEEDED);
        }
        if (error instanceof AdapterTransientError) {
          noteTransient(new PlatformTransient(error.reason, error.retryAfterMs));
          continue;
        }
        throw error;
      }
    }
    if (fetched.size === 0) {
      return transient || discoveryErrored
        ? transientOutcome("discovery_source_error")
        : { namespace, status: "not_found", reason: "candidates_not_on_platform" };
    }

    const baseSegments = defaultSegments(ctx.media, ctx.season);
    const passesStep1 = (info: CollectionInfo, segments: readonly SegmentInput[]) =>
      evaluateEvidenceGateStep1(catalog, info, { segments: normalizeSegments(segments) })
        .decision === "pass";

    const submit = async (
      info: CollectionInfo,
      segments: SegmentInput[],
      rawVariantDescription: unknown,
    ): Promise<PlatformExplorationOutcome | { error: string; message: string }> => {
      await ensureExplorationAgentUser(ctx.db);
      const variant = await resolveAgentVariantSubmission(
        ctx.db,
        ctx.media.id,
        namespace,
        rawVariantDescription,
      );
      try {
        const cr = await createChangeRequest(
          ctx.db,
          {
            submitterUserId: EXPLORATION_AGENT_USER_ID,
            submitterKeyId: null,
            submitterType: "agent",
            taskId,
            demandId: ctx.demandId,
            targetExternalKey: selectTargetExternalKeyForMedia(ctx.media),
            namespace,
            nativeId: info.canonicalId,
            variantId: variant.variantId,
            variantDescription: variant.variantDescription,
            setDefaultVariant: variant.setDefaultVariant,
            segments,
            now: ctx.now,
          },
          { adapterRegistry: ctx.adapterRegistry, outbound: ctx.outbound, now: ctx.now },
        );
        return { namespace, status: "submitted", changeRequestId: cr.id, nativeId: cr.nativeId };
      } catch (error) {
        if (error instanceof MediaServiceError) {
          if (error.code === "PLATFORM_UPSTREAM_ERROR") {
            noteTransient(new PlatformTransient(error.message));
          }
          return { error: error.code, message: error.message };
        }
        throw error;
      }
    };

    // 3. Fast path: one fetched candidate that the gate would already accept.
    const only = fetched.size === 1 ? [...fetched.values()][0]! : null;
    if (only && passesStep1(only.info, baseSegments)) {
      const result = await submit(only.info, baseSegments, undefined);
      if ("status" in result) {
        return result;
      }
    }

    // 4. Judge with the model, closed over the fetched candidates.
    const summaries = [...fetched.values()].map((c) =>
      summarizeCandidate(c, passesStep1(c.info, baseSegments)),
    );
    const messages: ModelMessage[] = [
      { role: "system", content: buildJudgeSystemPrompt(namespace) },
      { role: "user", content: buildJudgeUserPrompt(ctx.media, namespace, ctx.season, summaries) },
    ];
    const reply = (id: string, name: string, body: unknown) =>
      messages.push({ role: "tool", toolCallId: id, name, content: JSON.stringify(body) });

    for (let step = 0; step < config.maxSteps; step += 1) {
      if (budget.expired()) {
        return transientOutcome(BUDGET_EXCEEDED);
      }
      let response;
      try {
        response = await budget.outbound.invokeModel({
          provider: config.provider,
          model: config.model,
          ...(config.gatewayId ? { gatewayId: config.gatewayId } : {}),
          messages: [...messages],
          tools: [...JUDGE_TOOLS],
          temperature: config.temperature,
          maxTokens: config.maxTokens,
        });
      } catch (error) {
        return transientOutcome(error instanceof Error ? error.message : "model_invocation_failed");
      }

      const toolCalls = response.toolCalls ?? [];
      messages.push({
        role: "assistant",
        content: response.text ?? response.content ?? "",
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      });
      if (toolCalls.length === 0) {
        // A model that stops without deciding is a failed run, not evidence of absence.
        return transientOutcome("model_finished_without_decision");
      }

      for (const call of toolCalls) {
        const args = call.arguments ?? {};
        const candidate =
          typeof args.canonicalId === "string" ? fetched.get(args.canonicalId.trim()) : undefined;

        if (call.name === "list_episodes") {
          reply(
            call.id,
            call.name,
            candidate
              ? {
                  canonicalId: candidate.info.canonicalId,
                  episodes: candidate.info.featureEpisodes
                    .slice(0, MAX_EPISODES_IN_TOOL_RESULT)
                    .map((ep) => ({
                      index: ep.index,
                      title: ep.longTitle ?? ep.title ?? null,
                      airDate: ep.airDate ?? null,
                    })),
                  total: candidate.info.featureEpisodes.length,
                }
              : {
                  error: "UNKNOWN_CANDIDATE",
                  message: "Use a canonicalId from the candidate list.",
                },
          );
          continue;
        }

        if (call.name === "get_catalog_season") {
          const season = ctx.media.snapshot.seasons.find((s) => s.season === args.season);
          reply(call.id, call.name, season ?? { error: "UNKNOWN_SEASON" });
          continue;
        }

        if (call.name === "submit_mapping") {
          if (!candidate) {
            reply(call.id, call.name, {
              ok: false,
              error: "UNKNOWN_CANDIDATE",
              message: "Only canonicalIds from the candidate list can be submitted.",
            });
            continue;
          }
          const segments = parseModelSegments(args.segments, ctx.media, ctx.season);
          const misfit = checkSegmentsFitCollection(segments, candidate.info, (season) => {
            const count = ctx.media.snapshot.seasons.find((s) => s.season === season)?.episodeCount;
            return count && count > 0 ? count : null;
          });
          if (misfit) {
            reply(call.id, call.name, {
              ok: false,
              error: "SEGMENTS_OUTSIDE_COLLECTION",
              message: misfit,
            });
            continue;
          }
          const result = await submit(candidate.info, segments, args.variantDescription);
          if ("status" in result) {
            return result;
          }
          reply(call.id, call.name, { ok: false, ...result });
          continue;
        }

        if (call.name === "mark_not_found") {
          if (transient) {
            return transientOutcome("transient_error");
          }
          return {
            namespace,
            status: "not_found",
            reason:
              typeof args.reason === "string" && args.reason.trim()
                ? args.reason.trim()
                : "no_matching_candidate",
          };
        }

        reply(call.id, call.name, { ok: false, error: "UNKNOWN_TOOL" });
      }
    }

    return transient
      ? transientOutcome("transient_error")
      : { namespace, status: "not_found", reason: "max_steps_exhausted" };
  } finally {
    budget.dispose();
  }
}

export function createExplorationAgentExecutor(
  options: ExplorationAgentConfig = {},
): ExplorationExecutor {
  const config = resolveExplorationAgentConfig(options);
  const clockMs = options.clockMs ?? (() => Date.now());
  const discover = options.discover ?? discoverCandidates;
  const defaultRegistry = options.adapterRegistry ?? createDefaultAdapterRegistry();

  return async (ctx: ExplorationExecutionContext): Promise<ExplorationExecutionResult> => {
    const startMs = clockMs();
    const registry: AdapterRegistry = ctx.adapterRegistry ?? defaultRegistry;
    const targets = ctx.targetNamespaces.flatMap((namespace) => {
      const adapter = registry.get(namespace);
      return adapter && isPlatformNamespace(namespace) && isTier2Adapter(adapter) ? [adapter] : [];
    });
    if (targets.length === 0) {
      return { platformOutcomes: [], durationMs: 0 };
    }

    const catalog = await loadCatalogEvidenceForMedia(ctx.db, ctx.media.id);
    if (!catalog) {
      return {
        platformOutcomes: targets.map((a) => ({
          namespace: a.namespace,
          status: "transient_error" as const,
          reason: "media_snapshot_unavailable",
        })),
        durationMs: Math.max(0, clockMs() - startMs),
      };
    }
    const discovery = await discover(toDiscoveryInput(ctx.media, ctx.season), {
      outbound: ctx.outbound,
    });

    const platformOutcomes: PlatformExplorationOutcome[] = [];
    for (const adapter of targets) {
      const platformStartMs = clockMs();
      const outcome = await explorePlatform(ctx, adapter, discovery, catalog, config, clockMs);
      platformOutcomes.push({ ...outcome, durationMs: Math.max(0, clockMs() - platformStartMs) });
    }
    return { platformOutcomes, durationMs: Math.max(0, clockMs() - startMs) };
  };
}
