/**
 * Exploration agent (`@media-ref/core`), ADR 0002: discover → judge → gate.
 *
 * 1. **Discover** (no model): `discoverCandidates` asks 360kan, Douban "where to watch" and iQIYI
 *    search once per job; client leads add their own IDs. Every candidate is fetched with the
 *    platform adapter's `fetchCollection`, so only collections someone fetched can be submitted.
 * 2. **Fast path**: a single fetched candidate that already passes Evidence Gate Step 1 with the
 *    default segments is submitted without calling the model.
 * 3. **Agent** (model): every platform still open (with or without candidates) goes into one
 *    session with open tools (`exploration-tools.ts`): catalog/platform search, lookups, link
 *    resolution, web search, `get_collection`. Each platform ends with `submit_mapping` or
 *    `mark_not_found`.
 * 4. **Gate** (code): a submission must name a collection fetched in this job, and its segments must
 *    fit inside that collection's fetched episode list; then the normal change-request Evidence Gate runs.
 *
 * One job shares one wall-clock budget, step limit and token budget; each platform reports its own
 * outcome, and the session's tokens are added to the day's budget.
 * All model calls go through `OutboundClient.invokeModel` (magpie, or AI Gateway as a fallback).
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
  lookupDoubanSubjectByImdb,
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
import { fulfillCoveredCatalogDemandsInTx, isCoveredByAssociationsInTx } from "./demands.ts";
import { loadCatalogEvidenceForMedia } from "./invalidation.ts";
import { listLeadsForTarget, type Lead } from "./leads.ts";
import { acquireAdvisoryLock, ADVISORY_LOCK_CLASSES } from "./locks.ts";
import { createChangeRequest, MediaServiceError } from "./media-service.ts";
import { recordExplorationTokens } from "./exploration-scheduler.ts";
import { addPiUsage, reportPiUsage, type PiUsageBucket } from "./tokens-report.ts";
import {
  buildQueryTools,
  QUERY_TOOL_NAMES,
  runQueryTool,
  type ToolContext,
} from "./exploration-tools.ts";
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
export const DEFAULT_EXPLORATION_MAX_STEPS = 64;
export const DEFAULT_EXPLORATION_MAX_DURATION_MS = 5 * 60_000;
/** Model tokens (input + output, summed over turns) one job's agent session may spend. */
export const DEFAULT_EXPLORATION_MAX_TASK_TOKENS = 2_000_000;
export const DEFAULT_EXPLORATION_VARIANT_DESCRIPTION = "原声";

const MAX_LEADS_IN_PROMPT = 5;
/** Candidates fetched per platform; discovery already filters, this bounds the worst case. */
const MAX_CANDIDATES_PER_PLATFORM = 4;

export interface ExplorationAgentConfig {
  provider?: string;
  model?: string;
  gatewayId?: string;
  maxSteps?: number;
  maxDurationMs?: number;
  temperature?: number;
  maxTokens?: number;
  maxTaskTokens?: number;
  /** Let the model use its provider's built-in web search too (default true). */
  webSearch?: boolean;
  /** tokens.ci API token: session usage is submitted there as client "pi", device MediaRef. */
  tokensApiToken?: string;
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
  maxTaskTokens: number;
  webSearch: boolean;
  tokensApiToken?: string;
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
      : 8192;
  const maxTaskTokens =
    partial.maxTaskTokens !== undefined &&
    Number.isFinite(partial.maxTaskTokens) &&
    partial.maxTaskTokens > 0
      ? partial.maxTaskTokens
      : DEFAULT_EXPLORATION_MAX_TASK_TOKENS;

  return {
    provider,
    model,
    ...(gatewayId ? { gatewayId } : {}),
    maxSteps,
    maxDurationMs,
    temperature,
    maxTokens,
    maxTaskTokens,
    webSearch: partial.webSearch !== false,
    ...(partial.tokensApiToken?.trim() ? { tokensApiToken: partial.tokensApiToken.trim() } : {}),
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

type CollectionAdapter = Tier2Adapter | Tier3Adapter;

interface FetchedCandidate {
  info: CollectionInfo;
  sources: string[];
}

function toDiscoveryInput(
  media: ExplorationTargetMedia,
  season: number | null,
  doubanId: string | null,
): DiscoveryMediaInput {
  const externalIds: Partial<Record<Namespace, string>> = {};
  for (const ext of media.externalIds) {
    externalIds[ext.namespace] ??= ext.nativeId;
  }
  if (doubanId) {
    externalIds.douban = doubanId;
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

function buildAgentSystemPrompt(namespaces: readonly Namespace[]): string {
  return [
    `You find the target media's collection on each of these namespaces: ${namespaces.join(", ")}.`,
    "Rules:",
    "1. Each namespace needs exactly one conclusion: submit_mapping or mark_not_found.",
    "2. Only collections fetched with get_collection (or already listed as candidates) can be submitted.",
    "   Search results, web pages and links are leads: resolve and fetch them before submitting.",
    "3. Leads: Douban's platform links, 360kan's play links, platform search, web search.",
    "   Douban has one subject per TV season. Video platforms often split or merge seasons.",
    "4. Check title, year, media type and episode count against the target. Prefer original audio over dubs or recuts.",
    "5. A collection may hold several seasons, or a season may be split; express that with segments.",
    "6. passesAutomaticCheckWithDefaultMapping is a hint from a deterministic check, not a decision.",
    "7. mark_not_found only after you looked: the platform may simply not carry it, which is common.",
    "8. Steps and tokens are limited; stop searching a namespace once the evidence is clear.",
  ].join("\n");
}

function buildAgentUserPrompt(
  media: ExplorationTargetMedia,
  season: number | null,
  targets: ReadonlyArray<{
    namespace: Namespace;
    candidates: ReturnType<typeof summarizeCandidate>[];
  }>,
): string {
  const payload = {
    target: {
      type: media.type,
      title: media.snapshot.title,
      originalTitle: media.snapshot.originalTitle,
      year: media.snapshot.year,
      requestedSeason: season,
      seasons: media.snapshot.seasons,
      externalIds: Object.fromEntries(media.externalIds.map((e) => [e.namespace, e.nativeId])),
    },
    namespaces: targets,
  };
  return `Find the matching collections:\n${JSON.stringify(payload, null, 2)}`;
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

/** Candidate IDs for one namespace, and whether a failing source makes "none" inconclusive. */
interface NamespaceCandidates {
  sourcesById: Map<string, string[]>;
  sourceErrored: boolean;
}

function platformCandidates(discovery: DiscoveryResult, namespace: Namespace): NamespaceCandidates {
  const sourcesById = new Map<string, string[]>();
  for (const c of discovery.candidates) {
    if (c.namespace === namespace) {
      sourcesById.set(
        c.canonicalId,
        c.sources.map((s) => s.source),
      );
    }
  }
  return {
    sourcesById,
    // A source error, or a link for this platform that could not be resolved for now, means
    // the absence of candidates is not evidence of absence.
    sourceErrored:
      discovery.sources.some((s) => s.status === "error") ||
      discovery.dropped.some(
        (d) => d.namespace === namespace && d.reason.startsWith("canonicalize_transient:"),
      ),
  };
}

/** Douban candidates: the subject Douban lists for the media's IMDb ID. */
/**
 * The media's Douban subject when the library already names one, confirmed or seeded (unverified).
 * Platform discovery reads its "where to watch" without the rate-limited IMDb lookup; the links
 * found there are still only candidates.
 */
async function knownDoubanSubjectId(
  db: Db,
  mediaId: string,
  season: number | null,
): Promise<string | null> {
  const rows = await db
    .selectFrom("associations")
    .select(["id", "native_id", "status"])
    .where("media_id", "=", mediaId)
    .where("namespace", "=", "douban")
    .where("status", "in", ["confirmed", "seed_unconfirmed"])
    .execute();
  if (rows.length === 0) {
    return null;
  }
  // Douban has one subject per TV season: only an association covering the season (or the whole
  // media, i.e. no segments) is this season's subject.
  const segments = await db
    .selectFrom("segments")
    .select(["association_id", "season"])
    .where(
      "association_id",
      "in",
      rows.map((r) => r.id),
    )
    .execute();
  const covering = rows.filter((r) => {
    const own = segments.filter((seg) => seg.association_id === r.id);
    return season === null || own.length === 0 || own.some((seg) => seg.season === season);
  });
  return (covering.find((r) => r.status === "confirmed") ?? covering[0])?.native_id ?? null;
}

async function doubanCandidates(
  media: ExplorationTargetMedia,
  outbound: OutboundClient,
): Promise<NamespaceCandidates> {
  const imdbId = media.externalIds.find((e) => e.namespace === "imdb")?.nativeId;
  const sourcesById = new Map<string, string[]>();
  if (!imdbId) {
    return { sourcesById, sourceErrored: false };
  }
  try {
    const subjectId = await lookupDoubanSubjectByImdb(imdbId, outbound);
    if (subjectId) {
      sourcesById.set(subjectId, ["douban_imdb"]);
    }
    return { sourcesById, sourceErrored: false };
  } catch {
    return { sourcesById, sourceErrored: true };
  }
}

/** A namespace still without a conclusion after discovery and the fast path. */
interface OpenTarget {
  namespace: Namespace;
  adapter: CollectionAdapter;
  taskId: string;
  fetched: Map<string, FetchedCandidate>;
  /** A failing source or fetch: "not found" is then not evidence of absence. */
  discoveryErrored: boolean;
  transient: PlatformTransient | null;
}

/** What every namespace of one job shares: the time budget and the gate checks. */
interface JobRun {
  ctx: ExplorationExecutionContext;
  budget: PlatformBudget;
  passesStep1(info: CollectionInfo, segments: readonly SegmentInput[]): boolean;
  segmentMisfit(info: CollectionInfo, segments: readonly SegmentInput[]): string | null;
  baseSegments: SegmentInput[];
}

function createJobRun(
  ctx: ExplorationExecutionContext,
  catalog: CatalogEvidence,
  budget: PlatformBudget,
): JobRun {
  const segmentMisfit = (info: CollectionInfo, segments: readonly SegmentInput[]) =>
    checkSegmentsFitCollection(segments, info, (season) => {
      const count = ctx.media.snapshot.seasons.find((s) => s.season === season)?.episodeCount;
      return count && count > 0 ? count : null;
    });
  return {
    ctx,
    budget,
    segmentMisfit,
    // Step 1 alone accepts year and episode counts from any season, so the fetched-range check
    // also has to hold before a candidate counts as passing.
    passesStep1: (info, segments) =>
      segmentMisfit(info, segments) === null &&
      evaluateEvidenceGateStep1(catalog, info, { segments: normalizeSegments(segments) })
        .decision === "pass",
    baseSegments: defaultSegments(ctx.media, ctx.season),
  };
}

function transientOutcome(
  run: JobRun,
  target: Pick<OpenTarget, "namespace" | "transient">,
  fallback: string,
): PlatformExplorationOutcome {
  const t = target.transient;
  return {
    namespace: target.namespace,
    status: "transient_error",
    reason: run.budget.expired() ? BUDGET_EXCEEDED : (t?.reason ?? fallback),
    ...(t?.retryAfterMs !== undefined ? { retryAfterMs: t.retryAfterMs } : {}),
  };
}

/** "None found": inconclusive while a source or fetch failed for this namespace. */
function notFoundOutcome(
  run: JobRun,
  target: OpenTarget,
  reason: string,
): PlatformExplorationOutcome {
  return target.transient || target.discoveryErrored
    ? transientOutcome(run, target, "discovery_source_error")
    : { namespace: target.namespace, status: "not_found", reason };
}

async function submitMapping(
  run: JobRun,
  target: OpenTarget,
  info: CollectionInfo,
  segments: SegmentInput[],
  rawVariantDescription: unknown,
): Promise<PlatformExplorationOutcome | { error: string; message: string }> {
  const { ctx } = run;
  const namespace = target.namespace;
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
        taskId: target.taskId,
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
        target.transient = new PlatformTransient(error.message);
      }
      return { error: error.code, message: error.message };
    }
    throw error;
  }
}

/**
 * Discovery candidates and client leads are fetched; exactly one that the gate would already
 * accept is submitted without the model (fast path). Anything else stays open for the agent.
 */
async function prepareTarget(
  run: JobRun,
  adapter: CollectionAdapter,
  candidates: NamespaceCandidates,
): Promise<{ outcome: PlatformExplorationOutcome } | { open: OpenTarget }> {
  const { ctx, budget } = run;
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
      outcome: {
        namespace,
        status: "submitted",
        changeRequestId: existingCr.id,
        nativeId: existingCr.native_id,
      },
    };
  }

  const target: OpenTarget = {
    namespace,
    adapter,
    taskId,
    fetched: new Map(),
    discoveryErrored: candidates.sourceErrored,
    transient: null,
  };

  // Candidate IDs: discovery plus client leads (untrusted, but they still go through fetch).
  const sourcesById = new Map(candidates.sourcesById);
  const leads = await loadLeadsContext(ctx.db, ctx.media, namespace, ctx.season);
  for (const lead of leads) {
    try {
      const id = await adapter.canonicalize(lead.nativeId, budget.outbound);
      sourcesById.set(id, [...(sourcesById.get(id) ?? []), "client_lead"]);
    } catch {
      // An unusable lead is just skipped.
    }
  }

  for (const [id, sources] of [...sourcesById].slice(0, MAX_CANDIDATES_PER_PLATFORM)) {
    if (budget.expired()) {
      return { outcome: transientOutcome(run, target, BUDGET_EXCEEDED) };
    }
    try {
      const evidence = await adapter.fetchCollection(id, budget.outbound);
      if (evidence.status === "found") {
        target.fetched.set(evidence.info.canonicalId, { info: evidence.info, sources });
      } else if (evidence.status === "transient_error") {
        target.transient = new PlatformTransient(evidence.reason, evidence.retryAfterMs);
      }
    } catch (error) {
      if (budget.expired()) {
        return { outcome: transientOutcome(run, target, BUDGET_EXCEEDED) };
      }
      if (error instanceof AdapterTransientError) {
        target.transient = new PlatformTransient(error.reason, error.retryAfterMs);
        continue;
      }
      throw error;
    }
  }

  // Fast path: the others failed the same check (title, year, type or episode count).
  const passing = [...target.fetched.values()].filter((c) =>
    run.passesStep1(c.info, run.baseSegments),
  );
  if (passing.length === 1) {
    const result = await submitMapping(run, target, passing[0]!.info, run.baseSegments, undefined);
    if ("status" in result) {
      return { outcome: result };
    }
  }
  return { open: target };
}

/** Totals for one agent session. */
interface SessionUsage {
  tokens: number;
  /** Per routed model, for the tokens.ci report. */
  byModel: Map<string, PiUsageBucket>;
}

/**
 * One model session for every open namespace of the job, with the open tools. Each namespace is
 * concluded by `submit_mapping` (a fetched collection only, segments inside its episodes) or
 * `mark_not_found`. Steps, tokens and wall-clock time are bounded for the whole session.
 */
async function runAgentSession(
  run: JobRun,
  targets: OpenTarget[],
  config: ResolvedExplorationAgentConfig,
  usage: SessionUsage,
): Promise<PlatformExplorationOutcome[]> {
  const { ctx, budget } = run;
  const byNamespace = new Map(targets.map((t) => [t.namespace, t]));
  const outcomes = new Map<Namespace, PlatformExplorationOutcome>();
  const open = () => targets.filter((t) => !outcomes.has(t.namespace));
  const settleRest = (conclude: (t: OpenTarget) => PlatformExplorationOutcome) => {
    for (const t of open()) {
      outcomes.set(t.namespace, conclude(t));
    }
    return targets.map((t) => outcomes.get(t.namespace)!);
  };

  const toolCtx: ToolContext = {
    outbound: budget.outbound,
    registry: ctx.adapterRegistry,
    tmdb: ctx.tmdbGateway,
    collectionNamespaces: targets.map((t) => t.namespace),
    seasons: ctx.media.snapshot.seasons,
    register: (info, source) => {
      const target = byNamespace.get(info.namespace);
      if (target) {
        const known = target.fetched.get(info.canonicalId);
        target.fetched.set(info.canonicalId, {
          info,
          sources: known?.sources.includes(source)
            ? known.sources
            : [...(known?.sources ?? []), source],
        });
      }
      return run.passesStep1(info, run.baseSegments);
    },
  };
  const namespaceParam = { type: "string", enum: targets.map((t) => t.namespace) };
  const tools: ModelToolDefinition[] = [
    ...buildQueryTools(toolCtx),
    {
      name: "submit_mapping",
      description:
        "Conclude a namespace with a fetched collection. For TV, segments map baseline episodes to the collection's episode indexes: baseline episodes episodeStart..episodeEnd of `season` play as collection episodes targetEpisodeStart onward. Omit segments to map the requested season 1:1.",
      parameters: {
        type: "object",
        properties: {
          namespace: namespaceParam,
          canonicalId: { type: "string", description: "canonicalId of a fetched collection." },
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
        required: ["namespace", "canonicalId"],
      },
    },
    {
      name: "mark_not_found",
      description: "Conclude that the namespace does not carry the target media.",
      parameters: {
        type: "object",
        properties: { namespace: namespaceParam, reason: { type: "string" } },
        required: ["namespace"],
      },
    },
  ];

  const messages: ModelMessage[] = [
    { role: "system", content: buildAgentSystemPrompt(targets.map((t) => t.namespace)) },
    {
      role: "user",
      content: buildAgentUserPrompt(
        ctx.media,
        ctx.season,
        targets.map((t) => ({
          namespace: t.namespace,
          candidates: [...t.fetched.values()].map((c) =>
            summarizeCandidate(c, run.passesStep1(c.info, run.baseSegments)),
          ),
        })),
      ),
    },
  ];
  const reply = (id: string, name: string, body: unknown) =>
    messages.push({ role: "tool", toolCallId: id, name, content: JSON.stringify(body) });

  for (let step = 0; step < config.maxSteps; step += 1) {
    if (budget.expired()) {
      return settleRest((t) => transientOutcome(run, t, BUDGET_EXCEEDED));
    }
    if (usage.tokens >= config.maxTaskTokens) {
      return settleRest((t) => notFoundOutcome(run, t, "token_budget_exhausted"));
    }
    let response;
    try {
      response = await budget.outbound.invokeModel({
        provider: config.provider,
        model: config.model,
        ...(config.gatewayId ? { gatewayId: config.gatewayId } : {}),
        messages: [...messages],
        tools,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        webSearch: config.webSearch,
        // One session per job: every turn stays on the same routed model and its prompt cache.
        sessionId: ctx.jobId,
        metadata: { demandId: ctx.demandId, jobId: ctx.jobId },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "model_invocation_failed";
      return settleRest((t) => transientOutcome(run, t, reason));
    }
    const u = response.usage;
    usage.tokens +=
      (u?.inputTokens ?? 0) +
      (u?.outputTokens ?? 0) +
      (u?.cacheReadTokens ?? 0) +
      (u?.cacheWriteTokens ?? 0);
    addPiUsage(usage.byModel, response);

    const toolCalls = response.toolCalls ?? [];
    messages.push({
      role: "assistant",
      content: response.text ?? response.content ?? "",
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    });
    if (toolCalls.length === 0) {
      // A model that stops without deciding is a failed run, not evidence of absence.
      return settleRest((t) => transientOutcome(run, t, "model_finished_without_decision"));
    }

    for (const call of toolCalls) {
      const args = call.arguments ?? {};
      if (QUERY_TOOL_NAMES.has(call.name)) {
        reply(call.id, call.name, await runQueryTool(toolCtx, call.name, args));
        continue;
      }
      if (call.name !== "submit_mapping" && call.name !== "mark_not_found") {
        reply(call.id, call.name, { ok: false, error: "UNKNOWN_TOOL" });
        continue;
      }
      const target =
        typeof args.namespace === "string"
          ? byNamespace.get(args.namespace as Namespace)
          : undefined;
      if (!target || outcomes.has(target.namespace)) {
        reply(call.id, call.name, {
          ok: false,
          error: target ? "ALREADY_CONCLUDED" : "UNKNOWN_NAMESPACE",
          open: open().map((t) => t.namespace),
        });
        continue;
      }

      if (call.name === "mark_not_found") {
        const reason =
          typeof args.reason === "string" && args.reason.trim()
            ? args.reason.trim()
            : "no_matching_candidate";
        outcomes.set(target.namespace, notFoundOutcome(run, target, reason));
        reply(call.id, call.name, { ok: true, open: open().map((t) => t.namespace) });
        continue;
      }

      const candidate =
        typeof args.canonicalId === "string"
          ? target.fetched.get(args.canonicalId.trim())
          : undefined;
      if (!candidate) {
        reply(call.id, call.name, {
          ok: false,
          error: "UNKNOWN_CANDIDATE",
          message: "Fetch the collection with get_collection before submitting it.",
        });
        continue;
      }
      const segments = parseModelSegments(args.segments, ctx.media, ctx.season);
      const misfit = run.segmentMisfit(candidate.info, segments);
      if (misfit) {
        reply(call.id, call.name, {
          ok: false,
          error: "SEGMENTS_OUTSIDE_COLLECTION",
          message: misfit,
        });
        continue;
      }
      const result = await submitMapping(
        run,
        target,
        candidate.info,
        segments,
        args.variantDescription,
      );
      if ("status" in result) {
        outcomes.set(target.namespace, result);
        reply(call.id, call.name, { ok: true, open: open().map((t) => t.namespace) });
      } else {
        reply(call.id, call.name, { ok: false, ...result });
      }
    }
    if (open().length === 0) {
      return targets.map((t) => outcomes.get(t.namespace)!);
    }
  }
  return settleRest((t) => notFoundOutcome(run, t, "max_steps_exhausted"));
}

/**
 * Writes the media's missing TMDB external ID (ADR 0002 §2.1). The identity chain is the IMDb ID:
 * TMDB `/find` must return exactly one entry of the media's type, and that entry's own IMDb ID must
 * be the media's. TVDB and Trakt IDs are taken only from that same entry, and only fill empty slots.
 * An ID already held by another media is not written; a review alert is raised instead.
 * shortcut: no title/year/director chain for media without an IMDb ID; add one when such demands show up.
 */
async function exploreTmdbExternalId(
  ctx: ExplorationExecutionContext,
): Promise<PlatformExplorationOutcome> {
  const namespace = "tmdb";
  const imdbId = ctx.media.externalIds.find((e) => e.namespace === "imdb")?.nativeId;
  if (!imdbId) {
    return { namespace, status: "not_found", reason: "no_imdb_id_for_tmdb_find" };
  }

  let entry;
  try {
    const found = (await ctx.tmdbGateway.findByImdbId(imdbId)).filter(
      (f) => f.type === ctx.media.type,
    );
    if (found.length !== 1) {
      return {
        namespace,
        status: "not_found",
        reason: found.length === 0 ? "imdb_not_on_tmdb" : "ambiguous_tmdb_find",
      };
    }
    const detail = await ctx.tmdbGateway.fetchMediaSnapshotAndExternalIds(
      found[0]!.type,
      found[0]!.id,
    );
    if (!detail || detail.externalIds.imdb !== imdbId) {
      return { namespace, status: "not_found", reason: "tmdb_imdb_mismatch" };
    }
    entry = { ...found[0]!, externalIds: detail.externalIds };
  } catch (error) {
    return {
      namespace,
      status: "transient_error",
      reason: error instanceof Error ? error.message : "tmdb_lookup_failed",
    };
  }

  const nativeIds: Partial<Record<"tmdb" | "tvdb" | "trakt", string>> = {
    tmdb: `${entry.type}:${entry.id}`,
    ...(entry.externalIds.tvdb ? { tvdb: entry.externalIds.tvdb } : {}),
    ...(entry.externalIds.trakt ? { trakt: entry.externalIds.trakt } : {}),
  };

  const written = await ctx.db.transaction().execute(async (trx) => {
    const mediaId = ctx.media.id;
    let tmdbWritten = false;
    for (const [ns, nativeId] of Object.entries(nativeIds) as Array<
      ["tmdb" | "tvdb" | "trakt", string]
    >) {
      await acquireAdvisoryLock(trx, ADVISORY_LOCK_CLASSES.MEDIA_NAMESPACE, `${mediaId}:${ns}`);
      const held = await trx
        .selectFrom("associations")
        .select(["media_id", "native_id"])
        .where("is_external_id", "=", true)
        .where("namespace", "=", ns)
        .where((eb) => eb.or([eb("media_id", "=", mediaId), eb("native_id", "=", nativeId)]))
        .execute();
      if (held.some((row) => row.media_id === mediaId)) {
        continue; // Only fill empty slots.
      }
      const other = held.find((row) => row.native_id === nativeId);
      if (other) {
        await trx
          .insertInto("review_alerts")
          .values({
            alert_type: "agent_external_id_conflict",
            media_id: mediaId,
            status: "open",
            details: JSON.stringify({
              namespace: ns,
              nativeId,
              otherMediaId: other.media_id,
              matchedBy: { imdb: imdbId },
              jobId: ctx.jobId,
            }),
          })
          .execute();
        if (ns === "tmdb") {
          return false; // Probably the same work twice: a reviewer decides on merging.
        }
        continue;
      }
      await trx
        .insertInto("associations")
        .values({
          media_id: mediaId,
          namespace: ns,
          native_id: nativeId,
          status: "confirmed",
          is_external_id: true,
          source: "agent",
        })
        .execute();
      tmdbWritten ||= ns === "tmdb";
    }
    if (tmdbWritten) {
      await fulfillCoveredCatalogDemandsInTx(trx, { mediaId, now: ctx.now });
    }
    return tmdbWritten;
  });

  return written
    ? { namespace, status: "submitted", nativeId: nativeIds.tmdb, directWrite: true }
    : { namespace, status: "not_found", reason: "tmdb_id_on_other_media" };
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
    const timed = async (run: () => Promise<PlatformExplorationOutcome>) => {
      const platformStartMs = clockMs();
      const outcome = await run();
      return { ...outcome, durationMs: Math.max(0, clockMs() - platformStartMs) };
    };
    const platformOutcomes: PlatformExplorationOutcome[] = [];

    // The TMDB external ID has no adapter: it is looked up and written directly.
    const hasTmdb = ctx.media.externalIds.some((e) => e.namespace === "tmdb");
    if (ctx.targetNamespaces.includes("tmdb") && !hasTmdb) {
      platformOutcomes.push(await timed(() => exploreTmdbExternalId(ctx)));
    }

    // A season already covered by a Douban/Bangumi association needs no catalog candidate.
    const catalogAssociationCovered =
      ctx.namespaceGroup === "catalog" &&
      (await isCoveredByAssociationsInTx(ctx.db, {
        mediaId: ctx.media.id,
        season: ctx.season,
        namespaceGroup: "catalog",
      }));
    const targets = catalogAssociationCovered
      ? []
      : ctx.targetNamespaces.flatMap((namespace) => {
          const adapter = registry.get(namespace);
          return adapter && isTier2Adapter(adapter) ? [adapter] : [];
        });
    if (targets.length === 0) {
      return { platformOutcomes, durationMs: Math.max(0, clockMs() - startMs) };
    }

    // After a TMDB write the snapshot and external IDs changed, so read them fresh.
    const catalog = await loadCatalogEvidenceForMedia(ctx.db, ctx.media.id);
    if (!catalog) {
      for (const a of targets) {
        platformOutcomes.push({
          namespace: a.namespace,
          status: "transient_error",
          reason: "media_snapshot_unavailable",
        });
      }
      return { platformOutcomes, durationMs: Math.max(0, clockMs() - startMs) };
    }
    const discovery = targets.some((a) => isPlatformNamespace(a.namespace))
      ? await discover(
          toDiscoveryInput(
            ctx.media,
            ctx.season,
            await knownDoubanSubjectId(ctx.db, ctx.media.id, ctx.season),
          ),
          { outbound: ctx.outbound },
        )
      : null;

    const budget = createPlatformBudget(ctx.outbound, clockMs() + config.maxDurationMs, clockMs);
    try {
      const run = createJobRun(ctx, catalog, budget);
      const open: OpenTarget[] = [];
      for (const adapter of targets) {
        const candidates =
          adapter.namespace === "douban"
            ? await doubanCandidates(ctx.media, ctx.outbound)
            : platformCandidates(discovery!, adapter.namespace);
        const platformStartMs = clockMs();
        const prepared = await prepareTarget(run, adapter, candidates);
        if ("outcome" in prepared) {
          platformOutcomes.push({
            ...prepared.outcome,
            durationMs: Math.max(0, clockMs() - platformStartMs),
          });
        } else {
          open.push(prepared.open);
        }
      }
      if (open.length > 0) {
        const sessionStartMs = clockMs();
        const usage: SessionUsage = { tokens: 0, byModel: new Map() };
        try {
          const outcomes = await runAgentSession(run, open, config, usage);
          const durationMs = Math.max(0, clockMs() - sessionStartMs);
          platformOutcomes.push(...outcomes.map((o) => ({ ...o, durationMs })));
        } finally {
          await recordExplorationTokens(ctx.db, ctx.now, usage.tokens);
          await reportPiUsage(ctx.db, ctx.outbound, [...usage.byModel.values()], {
            now: ctx.now,
            ...(config.tokensApiToken ? { token: config.tokensApiToken } : {}),
          });
        }
      }
    } finally {
      budget.dispose();
    }
    return { platformOutcomes, durationMs: Math.max(0, clockMs() - startMs) };
  };
}
