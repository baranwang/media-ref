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
  type MediaType,
  type Namespace,
  type SegmentInput,
} from "@media-ref/client";
import type { Database, Db } from "@media-ref/db";
import { sql, type Transaction } from "kysely";
import { fetchBangumiSubjectMetadata } from "./adapters/bangumi.ts";
import { fetchDoubanFrodo } from "./adapters/douban-api.ts";
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
  lastAiredEpisode,
  seasonCoverageConflict,
  seasonCoverageScopes,
  type SeasonEpisode,
} from "./season-coverage.ts";
import {
  discoverCandidates,
  lookupDoubanSeasonSubject,
  type DiscoveryMediaInput,
  type DiscoveryResult,
} from "./discovery/candidates.ts";
import {
  collectNormalizedTitleCandidates,
  evaluateEvidenceGate,
  isNonOriginalVariantDescription,
  normalizeTitleForComparison,
  stripTrailingQualifiers,
  type CatalogEvidence,
} from "./evidence-gate.ts";
import type {
  ExplorationExecutionContext,
  ExplorationExecutionResult,
  ExplorationExecutor,
  ExplorationTargetMedia,
  PlatformExplorationOutcome,
} from "./exploration-scheduler.ts";
import {
  fulfillCoveredCatalogDemandsInTx,
  isCoveredByAssociationsInTx,
  missingListedPlatformsInTx,
  isNamespaceCoveredInTx,
} from "./demands.ts";
import {
  findSharedCatalogDuplicateMediaIdsInTx,
  verifyAndAutoMergeDuplicateMedia,
  verifyAndAutoMergeDuplicateMediaInTx,
} from "./duplicate-merge.ts";
import { resolveCanonicalMediaIdInTx } from "./duplicate-merge-policy.ts";
import { parseCatalogTargetKey } from "./catalog-gateway.ts";
import { loadCatalogEvidenceForMedia } from "./invalidation.ts";
import { listLeadsForTarget, type Lead } from "./leads.ts";
import { acquireAdvisoryLock, ADVISORY_LOCK_CLASSES } from "./locks.ts";
import { createChangeRequest, MediaServiceError } from "./media-service.ts";
import { recordExplorationTokens } from "./exploration-scheduler.ts";
import { reportPiUsage } from "./tokens-report.ts";
import {
  buildCatalogLookupTools,
  buildQueryTools,
  runQueryTool,
  type ToolContext,
} from "./exploration-tools.ts";
import {
  parseTmdbNativeId,
  type ParsedTmdbNativeId,
  type TmdbGateway,
  type TmdbIdentityDetails,
} from "./tmdb.ts";
import {
  BUDGET_EXCEEDED,
  createSessionBudget,
  runToolSession,
  type SessionBudget,
  type SessionUsage,
} from "./agent-session.ts";
import {
  DEFAULT_AI_MODEL,
  DEFAULT_AI_PROVIDER,
  raceWithAbortSignal,
  type ModelMessage,
  type ModelToolCall,
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
  /** Segments a review agent correction gave for this collection (its lead). */
  suggestedSegments?: SegmentInput[];
  /** The corrected request's variant (e.g. a dub), resubmitted with those segments. */
  suggestedVariantDescription?: string | null;
}

function toDiscoveryInput(
  media: ExplorationTargetMedia,
  season: number | null,
  doubanId: string | null,
  seasonImdbId: string | null,
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
    seasonImdbId,
  };
}

/** Segments used when nobody says otherwise: the requested season mapped 1:1. */
function defaultSegments(
  media: ExplorationTargetMedia,
  season: number | null,
  airing: AiringSeason | null,
): SegmentInput[] {
  if (media.type === "movie" || media.baseline === null || season === null) {
    return [];
  }
  const snap = media.snapshot.seasons.find((s) => s.season === season);
  return [
    {
      season,
      episodeStart: 1,
      episodeEnd:
        airing?.season !== season && snap && snap.episodeCount > 0 ? snap.episodeCount : null,
      targetEpisodeStart: 1,
      baseline: media.baseline,
    },
  ];
}

function parseModelSegments(
  raw: unknown,
  media: ExplorationTargetMedia,
  fallback: SegmentInput[],
): SegmentInput[] {
  if (media.type === "movie" || media.baseline === null) {
    return [];
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    return fallback;
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
 * Evidence door: every linear segment must land inside the collection's fetched feature episodes
 * (with an open end resolved against its baseline season length, or for a season still airing
 * against the episodes aired so far). Non-linear segments map the
 * season at collection level rather than 1:1 to episode indexes, requiring only a non-empty
 * collection and valid segment bounds. Returns a reason when a segment does not fit.
 */
export function checkSegmentsFitCollection(
  segments: readonly SegmentInput[],
  info: CollectionInfo,
  seasonEpisodeCount: (season: number) => number | null,
  lastAired: (season: number) => number | null = () => null,
): string | null {
  const available = info.featureEpisodes.length;
  for (const seg of segments) {
    if (!Number.isInteger(seg.season) || seg.season < 0) {
      return "season must be a non-negative integer";
    }
    const start = seg.episodeStart ?? 1;
    if (!Number.isInteger(start) || start < 1) {
      return "episodeStart must be a positive integer";
    }
    const targetStart = seg.targetEpisodeStart ?? 1;
    if (!Number.isInteger(targetStart) || targetStart < 1) {
      return "targetEpisodeStart must be a positive integer";
    }
    const rawEnd = seg.episodeEnd ?? null;
    if (rawEnd !== null && (!Number.isInteger(rawEnd) || rawEnd < start)) {
      return "episodeEnd must not be before episodeStart";
    }
    const count = seasonEpisodeCount(seg.season);
    const seasonCount = count !== null && count > 0 ? count : null;
    if (seasonCount !== null) {
      if (start > seasonCount) {
        return `episodeStart ${start} exceeds season ${seg.season} length ${seasonCount}`;
      }
      if (rawEnd !== null && rawEnd > seasonCount) {
        return `episodeEnd ${rawEnd} exceeds season ${seg.season} length ${seasonCount}`;
      }
    }
    if (seg.nonLinear) {
      if (available === 0) {
        return `${info.canonicalId} has 0 fetched feature episodes`;
      }
      continue;
    }
    let end = rawEnd;
    if (end === null) {
      const aired = lastAired(seg.season);
      end = aired === null ? seasonCount : Math.max(start, aired);
      if (end === null) {
        return `episodeEnd is required: season ${seg.season} has no known episode count`;
      }
    }
    const span = end - start;
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

/** Platform positions [first, last] a segment covers; last is Infinity when its season's length is unknown. */
function platformPositions(
  seg: SegmentInput,
  seasonEpisodeCount: (season: number) => number | null,
): [number, number] {
  const start = seg.episodeStart ?? 1;
  const target = seg.targetEpisodeStart ?? 1;
  const end = seg.episodeEnd ?? seasonEpisodeCount(seg.season);
  return [target, end ? target + end - start : Infinity];
}

/** An already-mapped season of a collection and the platform positions it holds. */
interface MappedSeason {
  season: number;
  positions: [number, number] | null;
}

/**
 * Seasons each collection of this media on `namespace` already holds, for collections that do
 * not hold `season`. Whole-media requests (season null) are not checked.
 */
async function loadMappedSeasons(
  db: Db,
  media: ExplorationTargetMedia,
  namespace: Namespace,
  season: number | null,
): Promise<Map<string, MappedSeason[]>> {
  const mapped = new Map<string, MappedSeason[]>();
  if (season === null) {
    return mapped;
  }
  const rows = await db
    .selectFrom("associations")
    .innerJoin("segments", "segments.association_id", "associations.id")
    .select([
      "associations.native_id",
      "segments.season",
      "segments.episode_start",
      "segments.episode_end",
      "segments.target_episode_start",
      "segments.non_linear",
    ])
    .where("associations.media_id", "=", media.id)
    .where("associations.namespace", "=", namespace)
    .where("associations.status", "=", "confirmed")
    .orderBy("segments.season")
    .orderBy("segments.target_episode_start")
    .execute();
  for (const row of rows) {
    const positions = row.non_linear
      ? null
      : platformPositions(
          {
            season: row.season,
            episodeStart: row.episode_start,
            episodeEnd: row.episode_end,
            targetEpisodeStart: row.target_episode_start,
          } as SegmentInput,
          (s) => seasonLength(media, s),
        );
    mapped.set(row.native_id, [
      ...(mapped.get(row.native_id) ?? []),
      { season: row.season, positions },
    ]);
  }
  for (const [id, seasons] of mapped) {
    if (seasons.some((s) => s.season === season)) {
      mapped.delete(id);
    }
  }
  return mapped;
}

function seasonLength(media: ExplorationTargetMedia, season: number): number | null {
  const count = media.snapshot.seasons.find((s) => s.season === season)?.episodeCount;
  return count && count > 0 ? count : null;
}

/**
 * Seasons approving a submission would drop from the collection's existing association: those
 * it does not restate whose platform positions it claims (see `mergeApprovedSegments`).
 */
function lostSeasons(
  target: Pick<OpenTarget, "mappedSeasons">,
  media: ExplorationTargetMedia,
  canonicalId: string,
  segments: readonly SegmentInput[],
): number[] {
  const restated = new Set(segments.map((s) => s.season));
  const claimed = segments
    .filter((s) => !s.nonLinear)
    .map((s) => platformPositions(s, (x) => seasonLength(media, x)));
  const lost = (target.mappedSeasons.get(canonicalId) ?? []).filter(
    ({ season, positions }) =>
      !restated.has(season) &&
      positions &&
      claimed.some(([c, d]) => positions[0] <= d && c <= positions[1]),
  );
  return [...new Set(lost.map((s) => s.season))];
}

function summarizeCandidate(run: JobRun, target: OpenTarget, candidate: FetchedCandidate) {
  const { info, suggestedSegments } = candidate;
  const mappedTo = target.mappedSeasons.get(info.canonicalId);
  return {
    ...(mappedTo ? { alreadyMappedToSeasons: mappedTo } : {}),
    canonicalId: info.canonicalId,
    title: info.title,
    originalTitle: info.originalTitle ?? null,
    year: info.year,
    mediaType: info.mediaType,
    featureEpisodeCount: info.featureEpisodes.length,
    sources: candidate.sources,
    passesAutomaticCheckWithDefaultMapping: run.passesGate(info, run.baseSegments),
    ...(suggestedSegments
      ? {
          suggestedMapping: {
            segments: suggestedSegments.map((s) => ({
              season: s.season,
              episodeStart: s.episodeStart,
              episodeEnd: s.episodeEnd,
              targetEpisodeStart: s.targetEpisodeStart,
              ...(s.nonLinear ? { nonLinear: true } : {}),
            })),
            passesAutomaticCheck: run.passesGate(info, suggestedSegments),
            variantDescription: candidate.suggestedVariantDescription ?? null,
          },
        }
      : {}),
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
    "5. A collection may hold several seasons, or a season may be split; express that with linear segments when episodes correspond 1:1.",
    "   When episode counts differ because the platform and catalog count variety broadcasts/extras differently (e.g. platform has 第1期上..第10期下 = 20 while TMDB includes 先导片/加更 = 47, and the collection spans the whole season),",
    "   NEVER truncate to a shorter linear prefix like 1..20; inspect get_catalog_season + get_collection and submit { season, episodeStart: 1, episodeEnd: null, targetEpisodeStart: 1, nonLinear: true }.",
    "   Match a substantive finale subtitle or final broadcast installment before claiming the whole season. Platform publication dates can be delayed. Map only the verified finite range for Part 1, using nonLinear when its episodes are grouped differently.",
    "   target.airingSeason is a season still airing: a collection holding the episodes aired so far is the whole season, so submit { season, episodeStart: 1, episodeEnd: null, targetEpisodeStart: 1 }. NEVER cut it to the aired count.",
    "6. passesAutomaticCheckWithDefaultMapping is a hint from a deterministic check, not a decision.",
    "   alreadyMappedToSeasons lists seasons of this media the collection already holds, with their platform positions:",
    "   it is not this season's unless it really holds both; then map this season onto positions those seasons do not use.",
    "   suggestedMapping comes from a review that rejected an earlier submission of that collection: submit its segments unless the evidence says otherwise.",
    "7. mark_not_found only after you looked: the platform may simply not carry it, which is common.",
    "8. Steps and tokens are limited; stop searching a namespace once the evidence is clear.",
  ].join("\n");
}

function buildAgentUserPrompt(
  media: ExplorationTargetMedia,
  season: number | null,
  airing: AiringSeason | null,
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
      ...(airing
        ? { airingSeason: { season: airing.season, lastAiredEpisode: airing.aired } }
        : {}),
      externalIds: Object.fromEntries(media.externalIds.map((e) => [e.namespace, e.nativeId])),
    },
    namespaces: targets,
  };
  return `Find the matching collections:\n${JSON.stringify(payload, null, 2)}`;
}

const CONCLUSION_TOOLS: ReadonlySet<string> = new Set(["submit_mapping", "mark_not_found"]);

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

/**
 * `doubanConfirmed`: the season's confirmed Douban subject lists its own links, so on a platform
 * it lists, search hits are not candidates at all (#130). Elsewhere every source counts.
 * `doubanSeasonUnknown`: discovery could not look the season's own Douban subject up.
 */
function platformCandidates(
  discovery: DiscoveryResult,
  namespace: Namespace,
  doubanConfirmed: boolean,
  doubanSeasonUnknown: boolean,
): NamespaceCandidates {
  const fromDouban = (c: DiscoveryResult["candidates"][number]) =>
    c.sources.some((s) => s.source === "douban");
  const doubanOnly =
    doubanConfirmed && discovery.candidates.some((c) => c.namespace === namespace && fromDouban(c));
  const sourcesById = new Map<string, string[]>();
  for (const c of discovery.candidates) {
    if (c.namespace === namespace && (!doubanOnly || fromDouban(c))) {
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
      doubanSeasonUnknown ||
      discovery.sources.some((s) => s.status === "error") ||
      discovery.dropped.some(
        (d) => d.namespace === namespace && d.reason.startsWith("canonicalize_transient:"),
      ),
  };
}

/**
 * The media's Douban subject when the library already names one, confirmed or seeded (unverified).
 * Platform discovery reads its "where to watch" without the rate-limited IMDb lookup; the links
 * found there still pass the gate like any candidate.
 */
async function knownDoubanSubject(
  db: Db,
  mediaId: string,
  season: number | null,
): Promise<{ nativeId: string; confirmed: boolean } | null> {
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
  const row = covering.find((r) => r.status === "confirmed") ?? covering[0];
  return row ? { nativeId: row.native_id, confirmed: row.status === "confirmed" } : null;
}

/**
 * Douban candidates: the season's subject found by IMDb ID (see lookupDoubanSeasonSubject).
 * `seasonImdbId` undefined: TMDB failed, so the season's own subject may have been missed.
 */
async function doubanCandidates(
  media: ExplorationTargetMedia,
  outbound: OutboundClient,
  seasonImdbId: string | null | undefined,
): Promise<NamespaceCandidates> {
  const imdbId = media.externalIds.find((e) => e.namespace === "imdb")?.nativeId;
  const sourcesById = new Map<string, string[]>();
  try {
    const found = await lookupDoubanSeasonSubject({ imdbId, seasonImdbId }, outbound);
    if (found) {
      sourcesById.set(found.subjectId, [
        found.via === "season_imdb" ? "douban_season_imdb" : "douban_imdb",
      ]);
    }
    return { sourcesById, sourceErrored: seasonImdbId === undefined };
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
  /**
   * Collections this media already has on the namespace for other seasons, by canonical ID. Approving
   * a mapping drops those seasons where it claims their platform positions without restating them.
   */
  mappedSeasons: Map<string, MappedSeason[]>;
  /** A failing source or fetch: "not found" is then not evidence of absence. */
  discoveryErrored: boolean;
  transient: PlatformTransient | null;
}

/** What every namespace of one job shares: the time budget and the gate checks. */
interface JobRun {
  ctx: ExplorationExecutionContext;
  budget: SessionBudget;
  checkCoverage(
    info: CollectionInfo,
    segments: readonly SegmentInput[],
  ): Promise<ReturnType<typeof seasonCoverageConflict>>;
  passesGate(info: CollectionInfo, segments: readonly SegmentInput[]): boolean;
  segmentMisfit(info: CollectionInfo, segments: readonly SegmentInput[]): string | null;
  baseSegments: SegmentInput[];
  airing: AiringSeason | null;
}

/** The media's last season while it is still airing, and the last of its episodes that aired. */
interface AiringSeason {
  season: number;
  aired: number;
}

/**
 * IMDb ID of the requested season's first episode, under which Douban files that season's subject
 * (seasons > 1; season 1 is under the series ID). null when there is none, undefined when TMDB failed.
 */
async function loadSeasonImdbId(
  ctx: ExplorationExecutionContext,
  catalog: CatalogEvidence,
  budget: SessionBudget,
): Promise<string | null | undefined> {
  const tmdbTvId = catalog.namespace === "tmdb" && catalog.canonicalId.match(/^tv:(\d+)$/)?.[1];
  if (!tmdbTvId || ctx.season === null || ctx.season < 2) return null;
  try {
    return await raceWithAbortSignal(
      ctx.tmdbGateway.fetchEpisodeImdbId(tmdbTvId, ctx.season, 1, budget.signal),
      budget.signal,
      BUDGET_EXCEEDED,
    );
  } catch {
    return undefined;
  }
}

async function loadAiringSeason(
  ctx: ExplorationExecutionContext,
  catalog: CatalogEvidence,
  budget: SessionBudget,
): Promise<(AiringSeason & { episodes: readonly SeasonEpisode[] }) | null> {
  const tmdbTvId = catalog.namespace === "tmdb" && catalog.canonicalId.match(/^tv:(\d+)$/)?.[1];
  const season = Math.max(0, ...catalog.seasons.map((s) => s.season));
  if (!tmdbTvId || season < 1 || (ctx.season !== null && ctx.season !== season)) return null;
  try {
    const episodes =
      catalog.seasonEpisodes?.[season] ??
      (await raceWithAbortSignal(
        ctx.tmdbGateway.fetchSeasonEpisodes(tmdbTvId, season, budget.signal),
        budget.signal,
        BUDGET_EXCEEDED,
      )) ??
      [];
    const aired = lastAiredEpisode(episodes, ctx.now);
    return aired === null ? null : { season, aired, episodes };
  } catch {
    // An unknown airing state keeps the finished-season rules.
    return null;
  }
}

function createJobRun(
  ctx: ExplorationExecutionContext,
  catalog: CatalogEvidence,
  budget: SessionBudget,
  airing: (AiringSeason & { episodes: readonly SeasonEpisode[] }) | null,
): JobRun {
  const seasonEpisodes: Record<number, readonly SeasonEpisode[]> = { ...catalog.seasonEpisodes };
  if (airing) seasonEpisodes[airing.season] = airing.episodes;
  const evidence = { ...catalog, seasonEpisodes };
  const tmdbTvId = catalog.canonicalId.match(/^tv:(\d+)$/)?.[1];
  const segmentMisfit = (info: CollectionInfo, segments: readonly SegmentInput[]) =>
    checkSegmentsFitCollection(
      segments,
      info,
      (season) => seasonLength(ctx.media, season),
      (season) => (season === airing?.season ? airing.aired : null),
    );
  return {
    ctx,
    budget,
    segmentMisfit,
    async checkCoverage(info, segments) {
      // Other catalogs provide their live episode list in the change request's evidence job.
      if (catalog.namespace !== "tmdb") return null;
      for (const { season } of seasonCoverageScopes(catalog, info.namespace, segments)) {
        if (tmdbTvId && !seasonEpisodes[season]) {
          seasonEpisodes[season] =
            (await raceWithAbortSignal(
              ctx.tmdbGateway.fetchSeasonEpisodes(tmdbTvId, season, budget.signal),
              budget.signal,
              BUDGET_EXCEEDED,
            )) ?? [];
        }
      }
      return seasonCoverageConflict(evidence, info, segments);
    },
    // The whole gate, not Step 1 alone: Step 1 accepts the year and episode count of any season,
    // so another season's collection (same count, its own year) would pass as this season.
    passesGate: (info, segments) =>
      segmentMisfit(info, segments) === null &&
      evaluateEvidenceGate({
        catalog: evidence,
        collection: info,
        segments: normalizeSegments(segments),
      }).decision === "pass",
    baseSegments: defaultSegments(ctx.media, ctx.season, airing),
    airing: airing && { season: airing.season, aired: airing.aired },
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
  if (run.budget.expired()) return transientOutcome(run, target, BUDGET_EXCEEDED);
  try {
    const conflict = await run.checkCoverage(info, segments);
    if (conflict) return { error: conflict.code.toUpperCase(), message: conflict.message };
  } catch (error) {
    target.transient = new PlatformTransient(
      error instanceof Error ? error.message : "catalog_unavailable",
    );
    return transientOutcome(run, target, "catalog_unavailable");
  }
  if (run.budget.expired()) return transientOutcome(run, target, BUDGET_EXCEEDED);
  await ensureExplorationAgentUser(ctx.db);
  const variant = await resolveAgentVariantSubmission(
    ctx.db,
    ctx.media.id,
    namespace,
    rawVariantDescription,
  );
  if (run.budget.expired()) return transientOutcome(run, target, BUDGET_EXCEEDED);
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
      { adapterRegistry: ctx.adapterRegistry, outbound: run.budget.outbound, now: ctx.now },
    );
    return { namespace, status: "submitted", changeRequestId: cr.id, nativeId: cr.nativeId };
  } catch (error) {
    if (error instanceof MediaServiceError) {
      if (error.code === "NO_CHANGE") {
        return { namespace, status: "already_confirmed", reason: "already_confirmed" };
      }
      if (error.code === "PLATFORM_UPSTREAM_ERROR") {
        target.transient = new PlatformTransient(error.message);
      }
      return { error: error.code, message: error.message };
    }
    throw error;
  }
}

const isVouched = (sources: readonly string[]) =>
  sources.includes("douban") || sources.includes("client_lead");

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

  // Never submit twice for one platform: not on a redelivered job (same task id), and not on a
  // later job for the same demand while an earlier submission is still being checked or reviewed.
  const existingCr = await ctx.db
    .selectFrom("change_requests")
    .select(["id", "native_id", "status"])
    .where((eb) =>
      eb.or([
        eb("task_id", "=", taskId),
        eb.and([
          eb("demand_id", "=", ctx.demandId),
          eb("namespace", "=", namespace),
          eb("status", "in", ["pending_evidence", "needs_review"]),
        ]),
      ]),
    )
    .executeTakeFirst();
  if (existingCr) {
    if (existingCr.status === "rejected") {
      return {
        outcome: {
          namespace,
          status: "rejected",
          reason: "previous_request_rejected",
          changeRequestId: existingCr.id,
        },
      };
    }
    return {
      outcome: {
        namespace,
        status: "submitted",
        changeRequestId: existingCr.id,
        nativeId: existingCr.native_id,
      },
    };
  }

  // Skip platforms whose confirmed association already covers the requested movie or season.
  if (
    (isPlatformNamespace(namespace) || namespace === "douban" || namespace === "bangumi") &&
    (await isNamespaceCoveredInTx(ctx.db, {
      mediaId: ctx.media.id,
      namespace,
      season: ctx.season,
    }))
  ) {
    return {
      outcome: {
        namespace,
        status: "already_confirmed",
        reason: "already_confirmed",
      },
    };
  }

  const target: OpenTarget = {
    namespace,
    adapter,
    taskId,
    fetched: new Map(),
    mappedSeasons: await loadMappedSeasons(ctx.db, ctx.media, namespace, ctx.season),
    discoveryErrored: candidates.sourceErrored,
    transient: null,
  };

  // Candidate IDs: discovery plus client leads (untrusted, but they still go through fetch).
  const sourcesById = new Map(candidates.sourcesById);
  const suggestedById = new Map<
    string,
    { segments: SegmentInput[]; variantDescription: string | null }
  >();
  const leads = await loadLeadsContext(ctx.db, ctx.media, namespace, ctx.season);
  for (const lead of leads) {
    try {
      const id = await adapter.canonicalize(lead.nativeId, budget.outbound);
      sourcesById.set(id, [...(sourcesById.get(id) ?? []), "client_lead"]);
      // Leads come newest first: the latest correction wins.
      if (lead.segments && ctx.media.baseline && !suggestedById.has(id)) {
        const baseline = ctx.media.baseline;
        suggestedById.set(id, {
          segments: lead.segments.map((s) => ({ ...s, baseline })),
          variantDescription: lead.variantDescription,
        });
      }
    } catch {
      // An unusable lead is just skipped.
    }
  }

  // Douban's "where to watch" (reached by the media's Douban or IMDb ID) and client leads name a
  // collection directly; search hits only resemble the title, so they must not use up the slots.
  const ordered = [...sourcesById].sort(
    ([, a], [, b]) => Number(isVouched(b)) - Number(isVouched(a)),
  );
  for (const [id, sources] of ordered.slice(0, MAX_CANDIDATES_PER_PLATFORM)) {
    if (budget.expired()) {
      return { outcome: transientOutcome(run, target, BUDGET_EXCEEDED) };
    }
    try {
      const evidence = await adapter.fetchCollection(id, budget.outbound);
      if (evidence.status === "found") {
        const suggested = suggestedById.get(id);
        target.fetched.set(evidence.info.canonicalId, {
          info: evidence.info,
          sources,
          ...(suggested
            ? {
                suggestedSegments: suggested.segments,
                suggestedVariantDescription: suggested.variantDescription,
              }
            : {}),
        });
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

  // Fast path: the others failed the same check (title, year, type or episode count). A
  // candidate a review corrected is checked, and submitted, with its corrected segments.
  const mapping = (c: FetchedCandidate) => c.suggestedSegments ?? run.baseSegments;
  const passing: FetchedCandidate[] = [];
  for (const candidate of target.fetched.values()) {
    const segments = mapping(candidate);
    if (
      lostSeasons(target, ctx.media, candidate.info.canonicalId, segments).length ||
      run.segmentMisfit(candidate.info, segments)
    )
      continue;
    try {
      if (candidate.suggestedSegments && (await run.checkCoverage(candidate.info, segments)))
        continue;
    } catch (error) {
      target.transient = new PlatformTransient(
        error instanceof Error ? error.message : "catalog_unavailable",
      );
      continue;
    }
    if (run.passesGate(candidate.info, segments)) passing.push(candidate);
  }
  // Several passing (e.g. two albums of one show): the one Douban lists for this media wins.
  const fromDouban = passing.filter((c) => c.sources.includes("douban"));
  const chosen = passing.length === 1 ? passing[0] : fromDouban.length === 1 ? fromDouban[0] : null;
  if (chosen) {
    const result = await submitMapping(
      run,
      target,
      chosen.info,
      mapping(chosen),
      chosen.suggestedVariantDescription ?? undefined,
    );
    if ("status" in result) {
      return { outcome: result };
    }
  }
  return { open: target };
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
    tmdbTvId:
      ctx.media.baseline === "tmdb"
        ? (ctx.media.externalIds
            .find((e) => e.namespace === "tmdb")
            ?.nativeId.match(/^tv:(\d+)$/)?.[1] ?? null)
        : null,
    register: (info, source) => {
      const target = byNamespace.get(info.namespace);
      if (target) {
        const known = target.fetched.get(info.canonicalId);
        target.fetched.set(info.canonicalId, {
          ...known,
          info,
          sources: known?.sources.includes(source)
            ? known.sources
            : [...(known?.sources ?? []), source],
        });
      }
      return (
        (!target ||
          lostSeasons(target, run.ctx.media, info.canonicalId, run.baseSegments).length === 0) &&
        run.passesGate(info, run.baseSegments)
      );
    },
    noteTransient: (namespace, reason) => {
      const target = byNamespace.get(namespace);
      if (target) {
        target.transient = new PlatformTransient(reason);
      }
    },
  };
  const namespaceParam = { type: "string", enum: targets.map((t) => t.namespace) };
  const tools: ModelToolDefinition[] = [
    ...buildQueryTools(toolCtx),
    {
      name: "submit_mapping",
      description:
        "Conclude a namespace with a fetched collection. For TV, linear segments map baseline episodes episodeStart..episodeEnd of `season` to collection episodes targetEpisodeStart onward. Omit segments to map the requested season 1:1. Set nonLinear: true with { episodeStart: 1, episodeEnd: null, targetEpisodeStart: 1 } when a collection holds the full season whose episode granularity differs from the baseline catalog (e.g. variety shows where TMDB counts extras/prologues alongside broadcast parts); never truncate a full season to a shorter linear prefix unless the collection genuinely stops at that episode. A season still airing keeps episodeEnd: null.",
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
                nonLinear: {
                  type: "boolean",
                  description:
                    "True when the segment links the collection at season level without 1:1 episode mapping (e.g. variety shows).",
                },
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
        run.airing,
        targets.map((t) => ({
          namespace: t.namespace,
          candidates: [...t.fetched.values()].map((c) => summarizeCandidate(run, t, c)),
        })),
      ),
    },
  ];
  const conclude = async (call: ModelToolCall): Promise<unknown> => {
    const args = call.arguments ?? {};
    const target =
      typeof args.namespace === "string" ? byNamespace.get(args.namespace as Namespace) : undefined;
    if (!target || outcomes.has(target.namespace)) {
      return {
        ok: false,
        error: target ? "ALREADY_CONCLUDED" : "UNKNOWN_NAMESPACE",
        open: open().map((t) => t.namespace),
      };
    }

    if (call.name === "mark_not_found") {
      const reason =
        typeof args.reason === "string" && args.reason.trim()
          ? args.reason.trim()
          : "no_matching_candidate";
      outcomes.set(target.namespace, notFoundOutcome(run, target, reason));
      return { ok: true, open: open().map((t) => t.namespace) };
    }

    const candidate =
      typeof args.canonicalId === "string"
        ? target.fetched.get(args.canonicalId.trim())
        : undefined;
    if (!candidate) {
      return {
        ok: false,
        error: "UNKNOWN_CANDIDATE",
        message: "Fetch the collection with get_collection before submitting it.",
      };
    }
    const segments = parseModelSegments(args.segments, ctx.media, run.baseSegments);
    const misfit = run.segmentMisfit(candidate.info, segments);
    if (misfit) {
      return { ok: false, error: "SEGMENTS_OUTSIDE_COLLECTION", message: misfit };
    }
    const lost = lostSeasons(target, ctx.media, candidate.info.canonicalId, segments);
    if (lost.length > 0) {
      return {
        ok: false,
        error: "ALREADY_MAPPED_TO_OTHER_SEASON",
        message: `${candidate.info.canonicalId} already holds season ${lost.join(", ")} of this media on the platform positions these segments use. A collection holding only another season is not this season; if it holds both, put this season on the positions the others do not use, or restate segments for all of them.`,
      };
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
      return { ok: true, open: open().map((t) => t.namespace) };
    }
    return { ok: false, ...result };
  };

  const stop = await runToolSession({
    budget,
    config,
    usage,
    messages,
    tools,
    conclusionToolNames: CONCLUSION_TOOLS,
    sessionId: ctx.jobId,
    metadata: { demandId: ctx.demandId, jobId: ctx.jobId },
    runQuery: (name, args) => runQueryTool(toolCtx, name, args),
    wrapUpMessage: () =>
      [
        "The time, step or token budget is almost used up. Stop searching.",
        `Conclude every open namespace now (${open()
          .map((t) => t.namespace)
          .join(", ")}): submit_mapping for a collection you already fetched and checked,`,
        "or mark_not_found if you found no match. Only the conclusion tools are left.",
      ].join(" "),
    wrapUpRefusal: "No more searching: conclude with submit_mapping or mark_not_found.",
    conclude,
    done: () => open().length === 0,
  });
  // An unfinished namespace is settled as transient (the whole job runs again later) or, once
  // the steps or tokens are spent, as not found.
  switch (stop.kind) {
    case "concluded":
      return targets.map((t) => outcomes.get(t.namespace)!);
    case "time_up":
      return settleRest((t) => transientOutcome(run, t, BUDGET_EXCEEDED));
    case "tokens_exhausted":
      return settleRest((t) => notFoundOutcome(run, t, "token_budget_exhausted"));
    case "steps_exhausted":
      return settleRest((t) => notFoundOutcome(run, t, "max_steps_exhausted"));
    case "no_decision":
      // A model that stops without deciding is a failed run, not evidence of absence.
      return settleRest((t) => transientOutcome(run, t, "model_finished_without_decision"));
    case "model_error":
      return settleRest((t) => transientOutcome(run, t, stop.reason));
  }
}

type TmdbIdentityId = "imdb" | "tvdb" | "trakt";
type TmdbIdentityMatch = { matchedBy: TmdbIdentityId | "title" } | { reason: string };
type TmdbFindResults = Partial<
  Record<TmdbIdentityId, { hits: readonly ParsedTmdbNativeId[]; count: number }>
>;

interface TmdbLookupSourceContext {
  externalIds: Record<TmdbIdentityId, string | null>;
  year: number | null;
  aliases: string[];
  directors: string[];
  studios: string[];
  cast: string[];
  seasons: Array<{ airYear?: number | null; episodeCount: number | null }>;
  catalogSources: Array<{ namespace: "douban" | "bangumi"; id: string }>;
}

const UNCONFIGURED_MODEL_PATTERN =
  /Outbound model transport is not configured|Unexpected outbound model invocation without a stubbed handler/;

function normalizePersonOrStudioName(raw: string): string {
  return raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s・·．.,\-_'":;!?()（）「」『』【】]/g, "");
}

function intersectNormalizedNames(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  const setB = new Set(b.map(normalizePersonOrStudioName).filter((s) => s.length >= 2));
  let hits = 0;
  const counted = new Set<string>();
  for (const item of a) {
    const norm = normalizePersonOrStudioName(item);
    if (norm.length >= 2 && setB.has(norm) && !counted.has(norm)) {
      counted.add(norm);
      hits += 1;
    }
  }
  return hits;
}

async function loadDoubanSubjectSummary(
  subjectId: string,
  outbound: OutboundClient,
): Promise<{
  aliases: string[];
  directors: string[];
  cast: string[];
  imdbId: string | null;
  year: number | null;
  episodeCount: number | null;
} | null> {
  try {
    const res = await fetchDoubanFrodo(outbound, `/subject/${subjectId}`, { kind: "catalog" });
    if (res.status < 200 || res.status >= 300) {
      return null;
    }
    const d = JSON.parse(res.body) as Record<string, unknown>;
    const pickNames = (raw: unknown, limit: number) =>
      Array.isArray(raw)
        ? raw.slice(0, limit).flatMap((x) => {
            const name = (x as Record<string, unknown> | null)?.name;
            return typeof name === "string" && name.trim() ? [name.trim()] : [];
          })
        : [];
    const aliases: string[] = [];
    for (const field of [d.title, d.original_title]) {
      if (typeof field === "string" && field.trim()) aliases.push(field.trim());
    }
    if (Array.isArray(d.aka)) {
      for (const a of d.aka) {
        if (typeof a === "string" && a.trim()) aliases.push(a.trim());
      }
    }
    const rawImdb =
      typeof d.imdb === "string" ? d.imdb : typeof d.imdb_id === "string" ? d.imdb_id : null;
    const imdbId = rawImdb && /^tt\d+$/i.test(rawImdb.trim()) ? rawImdb.trim().toLowerCase() : null;
    const rawYear = typeof d.year === "string" || typeof d.year === "number" ? Number(d.year) : NaN;
    const rawEps =
      typeof d.episodes_count === "number"
        ? d.episodes_count
        : typeof d.episodes_count === "string"
          ? Number(d.episodes_count)
          : NaN;
    return {
      aliases,
      directors: pickNames(d.directors, 5),
      cast: pickNames(d.actors, 10),
      imdbId,
      year: Number.isInteger(rawYear) && rawYear > 1800 ? rawYear : null,
      episodeCount: Number.isInteger(rawEps) && rawEps > 0 ? rawEps : null,
    };
  } catch {
    return null;
  }
}

function comparableExternalId(
  ns: TmdbIdentityId | "tmdb",
  raw: string | null,
  type: MediaType,
): string | null {
  if (!raw) return null;
  const id = raw.trim().toLowerCase();
  if (ns === "tvdb") {
    const ref = parseCatalogTargetKey(`tvdb:${id}`);
    if (ref?.namespace === "tvdb" && (!ref.mediaTypeHint || ref.mediaTypeHint === type))
      return ref.tvdbId;
  }
  if (ns === "trakt" && /^[1-9]\d*$/.test(id))
    return `${type === "movie" ? "movie" : "show"}:${id}`;
  return id;
}

async function loadTmdbLookupSourceContext(
  ctx: ExplorationExecutionContext,
  externalIds: ReadonlyMap<Namespace, string>,
): Promise<TmdbLookupSourceContext | null> {
  const ext = (ns: TmdbIdentityId) =>
    comparableExternalId(ns, externalIds.get(ns) ?? null, ctx.media.type);
  let imdbId = ext("imdb");
  const tvdbId = ext("tvdb");
  const traktId = ext("trakt");

  const catalogRows = await ctx.db
    .selectFrom("associations")
    .select(["namespace", "native_id"])
    .where("media_id", "=", ctx.media.id)
    .where("is_external_id", "=", false)
    .where("status", "=", "confirmed")
    .where("namespace", "in", ["douban", "bangumi"])
    .limit(2)
    .execute();

  const aliases: string[] = [];
  const directors: string[] = [];
  const studios: string[] = [];
  const cast: string[] = [];
  let sourceYear: number | null = ctx.media.snapshot.year;
  const seasons: TmdbLookupSourceContext["seasons"] = ctx.media.snapshot.seasons.filter(
    (s) => s.season > 0,
  );

  const catalogSources: Array<{ namespace: "douban" | "bangumi"; id: string }> = [];
  for (const row of catalogRows) {
    const ns = row.namespace === "douban" || row.namespace === "bangumi" ? row.namespace : null;
    if (!ns) continue;
    catalogSources.push({ namespace: ns, id: row.native_id });

    if (ns === "bangumi") {
      const bgm = await fetchBangumiSubjectMetadata(row.native_id, ctx.outbound).catch(() => null);
      if (bgm?.status === "found") {
        const s = bgm.subject;
        aliases.push(s.title, ...(s.originalTitle ? [s.originalTitle] : []), ...s.aliases);
        directors.push(...s.directors);
        studios.push(...s.studios);
        if (imdbId && s.imdbId && imdbId !== s.imdbId) return null;
        imdbId ??= s.imdbId;
        sourceYear ??= s.year;
        seasons.push({ airYear: s.year, episodeCount: s.episodeCount });
      }
    } else {
      const douban = await loadDoubanSubjectSummary(row.native_id, ctx.outbound);
      if (douban) {
        aliases.push(...douban.aliases);
        directors.push(...douban.directors);
        cast.push(...douban.cast);
        if (imdbId && douban.imdbId && imdbId !== douban.imdbId) return null;
        imdbId ??= douban.imdbId;
        sourceYear ??= douban.year;
        seasons.push({ airYear: douban.year, episodeCount: douban.episodeCount });
      }
    }
  }

  return {
    externalIds: { imdb: imdbId, tvdb: tvdbId, trakt: traktId },
    year: sourceYear,
    aliases: [...new Set(aliases.filter((a) => a.trim().length > 0))],
    directors: [...new Set(directors)],
    studios: [...new Set(studios)],
    cast: [...new Set(cast)],
    seasons,
    catalogSources,
  };
}

function countMatchedIndependentTitles(
  media: ExplorationTargetMedia,
  source: TmdbLookupSourceContext,
  candidate: TmdbIdentityDetails,
): number {
  const groupByForm = new Map<string, Set<string>>();
  const collect = (titles: readonly (string | null)[], year: number | null) => {
    const catalogForms = new Set<string>();
    for (const title of titles) {
      const forms = collectNormalizedTitleCandidates(title, null, undefined, year);
      const group = new Set(forms);
      // An alias can repeat either the full title or its qualifier-stripped form.
      for (const form of forms) {
        catalogForms.add(form);
        for (const equivalent of groupByForm.get(form) ?? []) {
          group.add(equivalent);
        }
      }
      for (const form of group) groupByForm.set(form, group);
    }
    return catalogForms;
  };
  const targetForms = collect(
    [media.snapshot.title, media.snapshot.originalTitle, ...source.aliases],
    source.year,
  );
  const candidateForms = collect(
    [candidate.snapshot.title, candidate.snapshot.originalTitle, ...candidate.aliases],
    candidate.snapshot.year,
  );
  const matchedGroups = new Set<Set<string>>();
  for (const form of targetForms) {
    if (candidateForms.has(form)) matchedGroups.add(groupByForm.get(form)!);
  }
  return matchedGroups.size;
}

function evaluateTmdbIdentityMatch(
  media: ExplorationTargetMedia,
  source: TmdbLookupSourceContext,
  finds: TmdbFindResults,
  candidate: TmdbIdentityDetails,
): TmdbIdentityMatch {
  if (candidate.type !== media.type) return { reason: "type_mismatch" };

  let sharedId: TmdbIdentityId | undefined;
  for (const ns of ["imdb", "tvdb", "trakt"] as const) {
    const expected = source.externalIds[ns];
    const actual = comparableExternalId(ns, candidate.externalIds[ns], media.type);
    const found = finds[ns];
    if (expected && actual && expected !== actual) return { reason: "external_id_conflict" };
    if (
      found?.count &&
      !found.hits.some((ref) => `${ref.type}:${ref.id}` === candidate.externalIds.tmdb)
    ) {
      return { reason: "external_id_conflict" };
    }
    if (expected && expected === actual && (found?.count ?? 0) <= 1) sharedId ??= ns;
  }
  if (sharedId) return { matchedBy: sharedId };

  const titleCount = countMatchedIndependentTitles(media, source, candidate);
  if (titleCount === 0) return { reason: "title_mismatch" };
  const { year, seasons } = candidate.snapshot;
  const targetYears = [source.year, ...source.seasons.map((s) => s.airYear)].filter(
    (y) => y != null,
  );
  const candidateYears = [year, ...seasons.map((s) => s.airYear)].filter((y) => y != null);
  if (
    targetYears.length &&
    candidateYears.length &&
    !targetYears.some((y) => candidateYears.some((cy) => Math.abs(y - cy) <= 1))
  ) {
    return { reason: "year_mismatch" };
  }

  const sameSeason =
    media.type === "tv" &&
    seasons.some(
      (s) =>
        s.season > 0 &&
        s.airYear != null &&
        s.episodeCount >= 4 &&
        source.seasons.some(
          (target) => target.airYear === s.airYear && target.episodeCount === s.episodeCount,
        ),
    );
  if (
    titleCount >= 2 ||
    sameSeason ||
    intersectNormalizedNames(source.directors, candidate.directorsAndCreators) > 0 ||
    intersectNormalizedNames(source.studios, candidate.productionCompanies) > 0 ||
    intersectNormalizedNames(source.cast, candidate.cast) >= 2
  ) {
    return { matchedBy: "title" };
  }
  return { reason: "insufficient_identity_evidence" };
}

function buildTmdbSearchQueries(
  media: ExplorationTargetMedia,
  source: TmdbLookupSourceContext,
): string[] {
  const year = media.snapshot.year ?? source.year;
  const raw = [
    media.snapshot.title,
    stripTrailingQualifiers(media.snapshot.title, year),
    media.snapshot.originalTitle,
    media.snapshot.originalTitle
      ? stripTrailingQualifiers(media.snapshot.originalTitle, year)
      : null,
    ...source.aliases.flatMap((a) => [a, stripTrailingQualifiers(a, year)]),
  ];
  const seen = new Set<string>();
  const queries: string[] = [];
  for (const item of raw) {
    if (!item) continue;
    const trimmed = item.trim();
    if (trimmed.length < 2) continue;
    const key = normalizeTitleForComparison(trimmed) || trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(trimmed);
    if (queries.length >= 6) break;
  }
  return queries;
}

type TmdbExplorationStepResult = PlatformExplorationOutcome & { mergedIntoMediaId?: string };

async function redirectedTmdbOutcome(db: Db, mediaId: string): Promise<TmdbExplorationStepResult> {
  const targetTmdb = await db
    .selectFrom("associations")
    .where("is_external_id", "=", true)
    .select("native_id")
    .where("media_id", "=", mediaId)
    .where("namespace", "=", "tmdb")
    .where("status", "!=", "delisted")
    .executeTakeFirst();
  return {
    namespace: "tmdb",
    mergedIntoMediaId: mediaId,
    ...(targetTmdb
      ? { status: "submitted", nativeId: targetTmdb.native_id, directWrite: true }
      : { status: "transient_error", reason: "merged_target_missing_tmdb" }),
  };
}

async function writeTmdbExternalIdsInTx(
  ctx: ExplorationExecutionContext,
  entry: TmdbIdentityDetails,
  sourceIds: TmdbLookupSourceContext["externalIds"],
  matchedBy: Record<string, string>,
  budget?: SessionBudget,
): Promise<TmdbExplorationStepResult> {
  const namespace = "tmdb";
  const submitted = {
    namespace,
    status: "submitted",
    nativeId: entry.externalIds.tmdb,
    directWrite: true,
  } as const;
  // Check IMDb ownership before any TMDB or secondary ID insert.
  const namespaces = ["imdb", "tmdb", "tvdb", "trakt"] as const;
  const refs = namespaces.flatMap((ns) => {
    const nativeId = entry.externalIds[ns];
    return nativeId ? [{ ns, nativeId }] : [];
  });

  const write = async (trx: Transaction<Database>): Promise<TmdbExplorationStepResult> => {
    const mediaId = ctx.media.id;
    for (const { ns, nativeId } of refs) {
      await acquireAdvisoryLock(trx, ADVISORY_LOCK_CLASSES.MEDIA_NAMESPACE, `${mediaId}:${ns}`);
      await acquireAdvisoryLock(trx, ADVISORY_LOCK_CLASSES.EXTERNAL_ID_KEY, `${ns}:${nativeId}`);
    }
    const authorities = trx
      .selectFrom("associations")
      .where("is_external_id", "=", true)
      .where("namespace", "in", namespaces)
      .select(["id", "namespace", "media_id", "native_id", "locked"])
      .$narrowType<{ namespace: (typeof namespaces)[number] }>();
    const claims = authorities.where((eb) =>
      eb.or(
        refs.map(({ ns, nativeId }) =>
          eb.and([eb("namespace", "=", ns), eb("native_id", "=", nativeId)]),
        ),
      ),
    );
    const owners = new Set([mediaId, ...(await claims.execute()).map((row) => row.media_id)]);
    for (const id of owners) {
      const canonical = await resolveCanonicalMediaIdInTx(trx, id);
      if (canonical) owners.add(canonical);
    }
    // Lock in the duplicate merger's order, then recheck ownership before any writes.
    const ownerIds = [...owners].sort();
    for (const id of ownerIds)
      await acquireAdvisoryLock(trx, ADVISORY_LOCK_CLASSES.MEDIA_MERGE, id);
    await trx
      .selectFrom("media")
      .select("id")
      .where("id", "in", ownerIds)
      .orderBy("id")
      .forUpdate()
      .execute();
    if (budget?.expired()) throw new Error(BUDGET_EXCEEDED);
    const canonical = await resolveCanonicalMediaIdInTx(trx, mediaId);
    if (!canonical) return { namespace, status: "transient_error", reason: "media_not_found" };
    if (canonical !== mediaId) return redirectedTmdbOutcome(trx, canonical);

    const liveIds = await authorities
      .where("media_id", "in", ownerIds)
      .orderBy("id")
      .forUpdate()
      .execute();
    const ownTmdb = liveIds.find((row) => row.media_id === mediaId && row.namespace === "tmdb");
    // A concurrent TMDB claim wins; none of the discarded candidate's IDs follow it.
    if (ownTmdb && ownTmdb.native_id !== submitted.nativeId)
      return { ...submitted, nativeId: ownTmdb.native_id };
    const conflictingId = (id: string) =>
      liveIds.find((row) => {
        const ns = row.namespace;
        const expected = entry.externalIds[ns] ?? (ns === "tmdb" ? null : sourceIds[ns]);
        return (
          row.media_id === id &&
          expected &&
          comparableExternalId(ns, row.native_id, entry.type) !==
            comparableExternalId(ns, expected, entry.type)
        );
      });
    if (conflictingId(mediaId))
      return { namespace, status: "not_found", reason: "external_id_conflict" };

    const recordConflict = async (
      ns: (typeof namespaces)[number],
      nativeId: string,
      otherMediaId: string,
      blockReason: string,
    ) => {
      const existing = await trx
        .selectFrom("review_alerts")
        .select("id")
        .where("alert_type", "=", "agent_external_id_conflict")
        .where("media_id", "=", mediaId)
        .where("status", "=", "open")
        .where((eb) => eb(eb.ref("details", "->>").key("namespace"), "=", ns))
        .where((eb) => eb(eb.ref("details", "->>").key("nativeId"), "=", nativeId))
        .executeTakeFirst();
      if (!existing)
        await trx
          .insertInto("review_alerts")
          .values({
            alert_type: "agent_external_id_conflict",
            media_id: mediaId,
            status: "open",
            details: JSON.stringify({
              namespace: ns,
              nativeId,
              otherMediaId,
              matchedBy,
              autoMergeBlockedReason: blockReason,
              autoMergeCheckedAt: ctx.now.toISOString(),
              jobId: ctx.jobId,
            }),
          })
          .execute();
    };
    for (const row of await claims.execute()) {
      const holder = await resolveCanonicalMediaIdInTx(trx, row.media_id);
      if (!holder || !owners.has(holder) || !owners.has(row.media_id)) {
        return { namespace, status: "transient_error", reason: "stale_merge_evidence" };
      }
      const conflict = conflictingId(holder) ?? conflictingId(row.media_id);
      if (conflict) {
        const reason = conflict.locked ? "locked_external_id_conflict" : "conflicting_external_id";
        await recordConflict(
          row.namespace,
          row.native_id,
          holder,
          `${reason}:${conflict.namespace}`,
        );
        return {
          namespace,
          status: "not_found",
          reason: row.namespace === "tmdb" ? "tmdb_id_on_other_media" : "external_id_conflict",
        };
      }
    }

    for (const { ns, nativeId } of refs) {
      // A preceding merge can transfer more than the ID that identified the duplicate.
      const held = await authorities
        .where("namespace", "=", ns)
        .where((eb) => eb.or([eb("media_id", "=", mediaId), eb("native_id", "=", nativeId)]))
        .execute();
      if (held.some((row) => row.media_id === mediaId)) continue;
      const other = held.find((row) => row.native_id === nativeId);
      if (other) {
        const canonicalOtherId = await resolveCanonicalMediaIdInTx(trx, other.media_id);
        if (!canonicalOtherId || !owners.has(canonicalOtherId) || !owners.has(other.media_id)) {
          throw new Error("stale_merge_evidence");
        }
        if (canonicalOtherId === mediaId) {
          await trx
            .updateTable("associations")
            .where("is_external_id", "=", true)
            .set({ media_id: mediaId, source: "agent", updated_at: ctx.now })
            .where("id", "=", other.id)
            .execute();
          continue;
        }

        const mergeAttempt = await verifyAndAutoMergeDuplicateMediaInTx(trx, {
          mediaIdA: mediaId,
          mediaIdB: canonicalOtherId,
          actorUserId: EXPLORATION_AGENT_USER_ID,
          reason: `exploration_external_id_match:${ns}:${nativeId}`,
          // The lookup verified this entry for the explored media. The holder needs independent titles.
          extraTitlesByMediaId: new Map([
            [mediaId, [entry.snapshot.title, entry.snapshot.originalTitle, ...entry.aliases]],
          ]),
          acquireMergeLocks: false,
          now: ctx.now,
        });

        if (mergeAttempt.merged) {
          if (mergeAttempt.targetMediaId !== mediaId) {
            return redirectedTmdbOutcome(trx, mergeAttempt.targetMediaId);
          }
          // `other` merged into `mediaId`; confirm whether `(ns, nativeId)` is now held by `mediaId`
          const nowHeld = await trx
            .selectFrom("associations")
            .where("is_external_id", "=", true)
            .select("id")
            .where("media_id", "=", mediaId)
            .where("namespace", "=", ns)
            .executeTakeFirst();
          if (nowHeld) {
            continue;
          }
        } else {
          await recordConflict(ns, nativeId, canonicalOtherId, mergeAttempt.blockReason);
          if (ns === "tmdb" || ns === "imdb") {
            return {
              namespace,
              status: "not_found",
              reason: ns === "tmdb" ? "tmdb_id_on_other_media" : "external_id_conflict",
            };
          }
          continue;
        }
      }
      if (ns === "imdb") continue;
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
    }
    await fulfillCoveredCatalogDemandsInTx(trx, { mediaId, now: ctx.now });
    return submitted;
  };
  return ctx.db.connection().execute(
    (db) =>
      db.transaction().execute(async (trx) => {
        if (budget) {
          const remaining = Math.ceil(budget.remainingMs());
          if (remaining <= 0) throw new Error(BUDGET_EXCEEDED);
          await sql`select set_config('transaction_timeout', ${String(remaining)}, true)`.execute(
            trx,
          );
        }
        const result = await write(trx);
        // Redirects and conflict alerts can also wait for merge locks before returning.
        if (budget?.expired()) throw new Error(BUDGET_EXCEEDED);
        return result;
      }),
    { signal: budget?.signal },
  );
}

async function withinTmdbBudget<T>(budget: SessionBudget, read: () => Promise<T>): Promise<T> {
  if (budget.expired()) throw new Error(BUDGET_EXCEEDED);
  const result = await raceWithAbortSignal(read(), budget.signal, BUDGET_EXCEEDED);
  if (budget.expired()) throw new Error(BUDGET_EXCEEDED);
  return result;
}

function createTmdbLookup(
  ctx: ExplorationExecutionContext,
  source: TmdbLookupSourceContext,
  finds: TmdbFindResults,
  taskBudget: SessionBudget,
) {
  // Undefined is a known hit still to inspect; null is a fetched 404.
  const candidates = new Map<string, TmdbIdentityDetails | null | undefined>();
  let truncated = false;
  const remember = (nativeId: string) => {
    if (!candidates.has(nativeId) && parseTmdbNativeId(nativeId)?.type === ctx.media.type) {
      candidates.set(nativeId, undefined);
    }
  };
  for (const { hits } of Object.values(finds)) {
    for (const hit of hits) remember(`${hit.type}:${hit.id}`);
  }
  const gateway = ctx.tmdbGateway;
  const tmdb = {
    ...gateway,
    async search(query, options) {
      const hits = await withinTmdbBudget(taskBudget, () =>
        gateway.search(query, {
          ...options,
          signal: options?.signal ?? taskBudget.signal,
          onTruncated: () => {
            if (!options?.type || options.type === ctx.media.type) truncated = true;
          },
        }),
      );
      for (const hit of hits) remember(hit.nativeId);
      return hits;
    },
    async fetchIdentityDetails(type, id, signal = taskBudget.signal) {
      const key = `${type}:${id}`;
      const cached = candidates.get(key);
      if (cached !== undefined) return cached;
      if (!parseTmdbNativeId(key)) return null;
      remember(key);
      let detail = gateway.fetchIdentityDetails
        ? await withinTmdbBudget(taskBudget, () => gateway.fetchIdentityDetails!(type, id, signal))
        : null;
      if (!detail) {
        const basic = await withinTmdbBudget(taskBudget, () =>
          gateway.fetchMediaSnapshotAndExternalIds(type, id, { signal }),
        );
        detail = basic && {
          ...basic,
          aliases: [],
          directorsAndCreators: [],
          productionCompanies: [],
          cast: [],
        };
      }
      if (detail && (detail.type !== type || detail.externalIds.tmdb !== key)) {
        throw new Error("tmdb_response_id_mismatch");
      }
      candidates.set(key, detail);
      return detail;
    },
  } satisfies TmdbGateway;

  const submit = async (candidate: TmdbIdentityDetails, budget = taskBudget) => {
    if (budget.expired()) throw new Error(BUDGET_EXCEEDED);
    const match = evaluateTmdbIdentityMatch(ctx.media, source, finds, candidate);
    if ("reason" in match) return match;
    const byTitle = match.matchedBy === "title";
    if (byTitle && truncated) return { reason: "incomplete_tmdb_search" };
    for (const [key, other] of candidates) {
      if (byTitle && other === undefined) return { reason: "incomplete_tmdb_search" };
      if (!other || key === candidate.externalIds.tmdb) continue;
      const rival = evaluateTmdbIdentityMatch(ctx.media, source, finds, other);
      if ("matchedBy" in rival && (byTitle || rival.matchedBy !== "title")) {
        return { reason: "ambiguous_tmdb_find" };
      }
    }
    const evidence =
      match.matchedBy === "title"
        ? { identityChain: ctx.media.snapshot.title }
        : { [match.matchedBy]: source.externalIds[match.matchedBy]! };
    return writeTmdbExternalIdsInTx(ctx, candidate, source.externalIds, evidence, budget);
  };
  return { tmdb, candidates, submit };
}

interface ExplorationTaskBudget {
  deadlineMs: number;
  clockMs: () => number;
  usage: SessionUsage;
}

async function runTmdbAgentFallback(
  ctx: ExplorationExecutionContext,
  source: TmdbLookupSourceContext,
  lookup: ReturnType<typeof createTmdbLookup>,
  config: ResolvedExplorationAgentConfig,
  task: ExplorationTaskBudget,
  fallbackNotFoundReason: string,
): Promise<TmdbExplorationStepResult> {
  const namespace = "tmdb";
  const maxDurationMs = Math.min(config.maxDurationMs, 90_000);
  const deadlineMs = Math.min(task.deadlineMs, task.clockMs() + maxDurationMs);
  const budget = createSessionBudget(ctx.outbound, deadlineMs, task.clockMs);
  try {
    const registry = ctx.adapterRegistry ?? createDefaultAdapterRegistry();
    const baseToolCtx: ToolContext = {
      outbound: budget.outbound,
      registry,
      tmdb: lookup.tmdb,
      collectionNamespaces: [],
      register: () => false,
      noteTransient: () => {},
      seasons: ctx.media.snapshot.seasons,
      tmdbTvId: null,
    };

    const tools: ModelToolDefinition[] = [
      ...buildCatalogLookupTools(baseToolCtx),
      {
        name: "submit_tmdb_id",
        description:
          'Record the verified TMDB ID ("tv:123" or "movie:123") after inspecting it with get_catalog_entry.',
        parameters: {
          type: "object",
          properties: {
            nativeId: {
              type: "string",
              description: 'TMDB ID such as "tv:311842" or "movie:550".',
            },
          },
          required: ["nativeId"],
        },
      },
      {
        name: "mark_not_found",
        description: "Conclude when TMDB truly does not have this media or identity is ambiguous.",
        parameters: {
          type: "object",
          properties: { reason: { type: "string" } },
          required: ["reason"],
        },
      },
    ];

    const messages: ModelMessage[] = [
      {
        role: "system",
        content: [
          "You link a media entry in MediaRef to its exact TMDB entry (`tv:<id>` or `movie:<id>`).",
          'Search TMDB (including original title, Traditional/Simplified variants, English aliases), inspect Douban/Bangumi entries or use web search to find the exact TMDB URL/ID, then ALWAYS call `get_catalog_entry(source="tmdb", id=...)` to inspect the candidate before submitting.',
          "Verify a reciprocal external ID or a title from the linked catalogs (including TMDB translations and aliases) supported by independent titles, credits or a matching season's air year and episode count. Inspect competing hits before relying on titles. If uncertain, call `mark_not_found`.",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            target: {
              type: ctx.media.type,
              title: ctx.media.snapshot.title,
              originalTitle: ctx.media.snapshot.originalTitle,
              year: ctx.media.snapshot.year ?? source.year,
              seasons: ctx.media.snapshot.seasons,
              externalIds: source.externalIds,
              aliases: source.aliases,
              directors: source.directors,
              studios: source.studios,
              catalogSources: source.catalogSources,
            },
            preCheckedTmdbCandidates: [...lookup.candidates.values()]
              .filter((c) => c != null)
              .map((c) => ({
                id: c.externalIds.tmdb,
                ...c.snapshot,
                aliases: c.aliases.slice(0, 8),
                directorsAndCreators: c.directorsAndCreators,
                productionCompanies: c.productionCompanies,
                externalIds: c.externalIds,
              })),
            uncheckedTmdbIds: [...lookup.candidates]
              .filter(([, detail]) => detail === undefined)
              .map(([id]) => id),
          },
          null,
          2,
        ),
      },
    ];

    let outcome: TmdbExplorationStepResult | null = null;
    const conclude = async (call: ModelToolCall): Promise<unknown> => {
      if (outcome) {
        return { ok: false, error: "ALREADY_CONCLUDED" };
      }
      if (budget.expired()) {
        return { ok: false, error: "TIME_UP", message: "Session budget expired." };
      }
      const args = call.arguments ?? {};
      if (call.name === "mark_not_found") {
        const reason =
          typeof args.reason === "string" && args.reason.trim()
            ? args.reason.trim()
            : fallbackNotFoundReason;
        outcome = { namespace, status: "not_found", reason };
        return { ok: true };
      }
      const rawId = typeof args.nativeId === "string" ? args.nativeId.trim() : "";
      const parsed = parseTmdbNativeId(rawId);
      if (!parsed) {
        return { ok: false, error: "BAD_TMDB_ID", message: 'Use "tv:123" or "movie:123".' };
      }
      const candidate = await raceWithAbortSignal(
        lookup.tmdb.fetchIdentityDetails(parsed.type, parsed.id, budget.signal),
        budget.signal,
        BUDGET_EXCEEDED,
      );
      if (budget.expired())
        return { ok: false, error: "TIME_UP", message: "Session budget expired." };
      if (!candidate) return { ok: false, error: "NOT_FOUND_ON_TMDB" };
      const result = await lookup.submit(candidate, budget);
      if (!("status" in result))
        return { ok: false, error: "IDENTITY_CHECK_FAILED", reason: result.reason };
      outcome = result;
      return { ok: true };
    };

    const stop = await runToolSession({
      budget,
      config: {
        ...config,
        maxDurationMs,
        maxSteps: Math.min(config.maxSteps, 12),
      },
      usage: task.usage,
      messages,
      tools,
      conclusionToolNames: new Set(["submit_tmdb_id", "mark_not_found"]),
      sessionId: `${ctx.jobId}:tmdb`,
      metadata: { demandId: ctx.demandId, jobId: ctx.jobId, namespace: "tmdb" },
      runQuery: (name, args) => runQueryTool(baseToolCtx, name, args),
      wrapUpMessage: () =>
        "Budget is almost spent: call `submit_tmdb_id` for a verified match or `mark_not_found`.",
      wrapUpRefusal: "No more searches: call `submit_tmdb_id` or `mark_not_found`.",
      conclude,
      done: () => outcome !== null,
    });
    if (outcome) {
      return outcome;
    }
    if (budget.expired()) {
      return { namespace, status: "transient_error", reason: BUDGET_EXCEEDED };
    }
    switch (stop.kind) {
      case "time_up":
        return { namespace, status: "transient_error", reason: BUDGET_EXCEEDED };
      case "tokens_exhausted":
        return { namespace, status: "not_found", reason: "token_budget_exhausted" };
      case "steps_exhausted":
        return { namespace, status: "not_found", reason: "max_steps_exhausted" };
      case "no_decision":
        return { namespace, status: "transient_error", reason: "model_finished_without_decision" };
      case "model_error":
        if (UNCONFIGURED_MODEL_PATTERN.test(stop.reason)) {
          return { namespace, status: "not_found", reason: fallbackNotFoundReason };
        }
        return { namespace, status: "transient_error", reason: stop.reason };
      case "concluded":
        return { namespace, status: "not_found", reason: fallbackNotFoundReason };
    }
  } catch (error) {
    if (budget.expired()) return { namespace, status: "transient_error", reason: BUDGET_EXCEEDED };
    throw error;
  } finally {
    budget.dispose();
  }
}

/**
 * Resolves the media's missing TMDB external ID after converging shared catalog duplicates (ADR 0004):
 * 1. Exact chain via IMDb or TVDB (`/find`), verifying the entry's reciprocal ID.
 * 2. Deterministic title / originalTitle / alias search with strict identity corroboration
 *    (multiple distinct script titles, directors/creators/studios/cast, or TV season episode count).
 * 3. Bounded agent fallback (`search_catalog` / `get_catalog_entry` / `web_search`), code-gated.
 */
async function exploreTmdbExternalId(
  ctx: ExplorationExecutionContext,
  config: ResolvedExplorationAgentConfig,
  task: ExplorationTaskBudget,
  budget: SessionBudget,
): Promise<TmdbExplorationStepResult> {
  const namespace = "tmdb";
  await ensureExplorationAgentUser(ctx.db);

  // Shared catalog duplicates can be verified locally even without an external ID.
  const sharedCatalogCandidates = await ctx.db
    .transaction()
    .execute((trx) => findSharedCatalogDuplicateMediaIdsInTx(trx, ctx.media.id));

  for (const candidate of sharedCatalogCandidates) {
    const mergeAttempt = await verifyAndAutoMergeDuplicateMedia(ctx.db, {
      mediaIdA: ctx.media.id,
      mediaIdB: candidate.otherMediaId,
      actorUserId: EXPLORATION_AGENT_USER_ID,
      reason: `exploration_shared_catalog:${candidate.namespace}:${candidate.nativeId}`,
      sharedCatalog: candidate,
      now: ctx.now,
    });
    if (mergeAttempt.merged && mergeAttempt.targetMediaId !== ctx.media.id) {
      return redirectedTmdbOutcome(ctx.db, mergeAttempt.targetMediaId);
    }
  }

  // A merge into the explored media can transfer any of its external IDs.
  const currentExtIds = await ctx.db
    .selectFrom("associations")
    .where("is_external_id", "=", true)
    .select(["namespace", "native_id"])
    .where("media_id", "=", ctx.media.id)
    .where("status", "!=", "delisted")
    .execute();
  const externalIds = new Map(currentExtIds.map((row) => [row.namespace, row.native_id]));
  const acquiredTmdb = externalIds.get("tmdb");
  if (acquiredTmdb) {
    return { namespace, status: "submitted", nativeId: acquiredTmdb, directWrite: true };
  }

  try {
    const source = await withinTmdbBudget(budget, () =>
      loadTmdbLookupSourceContext({ ...ctx, outbound: budget.outbound }, externalIds),
    );
    if (!source) return { namespace, status: "not_found", reason: "external_id_conflict" };
    let fallbackReason = source.externalIds.imdb ? "imdb_not_on_tmdb" : "no_tmdb_candidates";

    // Keep the full cardinality of each reverse lookup for every later submission.
    const finds: TmdbFindResults = {};
    for (const ns of ["imdb", "tvdb"] as const) {
      const id = source.externalIds[ns];
      if (!id) continue;
      let count = 0;
      const reportCount = (total: number) => {
        count = total;
      };
      const hits =
        ns === "imdb"
          ? await withinTmdbBudget(budget, () =>
              ctx.tmdbGateway.findByImdbId(id, reportCount, budget.signal),
            )
          : ctx.tmdbGateway.findByTvdbId
            ? await withinTmdbBudget(budget, () =>
                ctx.tmdbGateway.findByTvdbId!(id, reportCount, budget.signal),
              )
            : undefined;
      if (hits) finds[ns] = { hits, count: Math.max(count, hits.length) };
    }
    const lookup = createTmdbLookup(ctx, source, finds, budget);
    for (const ns of ["imdb", "tvdb"] as const) {
      const found = finds[ns];
      if (!found?.hits.length) continue;
      if (found.count > 1) {
        fallbackReason = "ambiguous_tmdb_find";
        continue;
      }
      const ref = found.hits[0]!;
      if (ref.type !== ctx.media.type) continue;
      const detail = await lookup.tmdb.fetchIdentityDetails(ref.type, ref.id);
      if (
        detail &&
        comparableExternalId(ns, detail.externalIds[ns], ctx.media.type) === source.externalIds[ns]
      ) {
        const result = await lookup.submit(detail);
        if ("status" in result) return result;
      } else if (ns === "imdb") {
        fallbackReason = "tmdb_imdb_mismatch";
      }
    }

    const queries = buildTmdbSearchQueries(ctx.media, source);
    const primaryYear = ctx.media.snapshot.year ?? source.year;
    let hasYearHits = false;
    if (primaryYear !== null) {
      for (const query of queries) {
        const hits = await lookup.tmdb.search(query, { type: ctx.media.type, year: primaryYear });
        if (hits.length) hasYearHits = true;
      }
    }
    if (!hasYearHits) {
      for (const query of queries.slice(0, 3))
        await lookup.tmdb.search(query, { type: ctx.media.type });
    }

    // Bound detail requests; unchecked hits remain visible to the same gate in the model session.
    const unchecked = [...lookup.candidates].filter(([, detail]) => detail === undefined);
    for (const [key] of unchecked.slice(0, 5)) {
      const ref = parseTmdbNativeId(key)!;
      await lookup.tmdb.fetchIdentityDetails(ref.type, ref.id);
    }
    for (const detail of lookup.candidates.values()) {
      if (!detail) continue;
      const result = await lookup.submit(detail);
      if ("status" in result) return result;
    }
    if (lookup.candidates.size && fallbackReason === "no_tmdb_candidates")
      fallbackReason = "tmdb_identity_unverified";
    return await runTmdbAgentFallback(ctx, source, lookup, config, task, fallbackReason);
  } catch (error) {
    if (budget.expired()) return { namespace, status: "transient_error", reason: BUDGET_EXCEEDED };
    return {
      namespace,
      status: "transient_error",
      reason: error instanceof Error ? error.message : "tmdb_lookup_failed",
    };
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
    const platformOutcomes: PlatformExplorationOutcome[] = [];
    const task: ExplorationTaskBudget = {
      deadlineMs: startMs + config.maxDurationMs,
      clockMs,
      usage: { tokens: 0, byModel: new Map() },
    };
    const budget = createSessionBudget(ctx.outbound, task.deadlineMs, clockMs);
    try {
      // The TMDB external ID has no adapter: it is looked up and written directly.
      const hasTmdb = ctx.media.externalIds.some((e) => e.namespace === "tmdb");
      if (ctx.targetNamespaces.includes("tmdb") && !hasTmdb) {
        const stepStartMs = clockMs();
        const { mergedIntoMediaId, ...outcome } = await exploreTmdbExternalId(
          ctx,
          config,
          task,
          budget,
        );
        platformOutcomes.push({ ...outcome, durationMs: Math.max(0, clockMs() - stepStartMs) });
        if (mergedIntoMediaId) {
          return { platformOutcomes, durationMs: Math.max(0, clockMs() - startMs) };
        }
      }

      // A season already covered by a Douban/Bangumi association needs no catalog candidate.
      const catalogAssociationCovered =
        ctx.namespaceGroup === "catalog" &&
        (await isCoveredByAssociationsInTx(ctx.db, {
          mediaId: ctx.media.id,
          season: ctx.season,
          namespaceGroup: "catalog",
        }));
      // A season some platform already covers is only explored for what its Douban subject lists.
      const wanted =
        ctx.namespaceGroup === "platform"
          ? await missingListedPlatformsInTx(ctx.db, { mediaId: ctx.media.id, season: ctx.season })
          : null;
      const targets = catalogAssociationCovered
        ? []
        : ctx.targetNamespaces.flatMap((namespace) => {
            if (wanted?.length && isPlatformNamespace(namespace) && !wanted.includes(namespace))
              return [];
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
      const doubanSubject = await knownDoubanSubject(ctx.db, ctx.media.id, ctx.season);
      const needsPlatforms = targets.some((a) => isPlatformNamespace(a.namespace));
      // Only needed to look the season's Douban subject up by IMDb ID.
      const seasonImdbId =
        targets.some((a) => a.namespace === "douban") || (needsPlatforms && !doubanSubject)
          ? await loadSeasonImdbId(ctx, catalog, budget)
          : null;
      const discovery = needsPlatforms
        ? await discover(
            toDiscoveryInput(
              ctx.media,
              ctx.season,
              doubanSubject?.nativeId ?? null,
              seasonImdbId ?? null,
            ),
            { outbound: ctx.outbound },
          )
        : null;

      const run = createJobRun(ctx, catalog, budget, await loadAiringSeason(ctx, catalog, budget));
      const open: OpenTarget[] = [];
      for (const adapter of targets) {
        const candidates =
          adapter.namespace === "douban"
            ? await doubanCandidates(ctx.media, ctx.outbound, seasonImdbId)
            : platformCandidates(
                discovery!,
                adapter.namespace,
                doubanSubject?.confirmed ?? false,
                // Discovery read the series subject only: the season's own was never checked.
                !doubanSubject && seasonImdbId === undefined,
              );
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
        const outcomes = await runAgentSession(run, open, config, task.usage);
        const durationMs = Math.max(0, clockMs() - sessionStartMs);
        platformOutcomes.push(...outcomes.map((o) => ({ ...o, durationMs })));
      }
    } finally {
      budget.dispose();
      await recordExplorationTokens(ctx.db, ctx.now, task.usage.tokens);
      await reportPiUsage(ctx.db, ctx.outbound, [...task.usage.byModel.values()], {
        now: ctx.now,
        ...(config.tokensApiToken ? { token: config.tokensApiToken } : {}),
      });
    }
    return { platformOutcomes, durationMs: Math.max(0, clockMs() - startMs) };
  };
}
