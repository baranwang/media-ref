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
  extractBroadcastPeriod,
  hasVarietyExtraMarker,
  isBroadcastStructured,
} from "./adapters/variety.ts";
import {
  discoverCandidates,
  lookupDoubanSubjectByImdb,
  type DiscoveryMediaInput,
  type DiscoveryResult,
} from "./discovery/candidates.ts";
import {
  evaluateEvidenceGate,
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
import {
  findSharedCatalogDuplicateMediaIdsInTx,
  verifyAndAutoMergeDuplicateMedia,
  verifyAndAutoMergeDuplicateMediaInTx,
} from "./duplicate-merge.ts";
import { resolveCanonicalMediaIdInTx } from "./duplicate-merge-policy.ts";
import { loadCatalogEvidenceForMedia } from "./invalidation.ts";
import { listLeadsForTarget, type Lead } from "./leads.ts";
import { acquireAdvisoryLock, ADVISORY_LOCK_CLASSES } from "./locks.ts";
import { createChangeRequest, MediaServiceError } from "./media-service.ts";
import { recordExplorationTokens } from "./exploration-scheduler.ts";
import { reportPiUsage } from "./tokens-report.ts";
import { buildQueryTools, runQueryTool, type ToolContext } from "./exploration-tools.ts";
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
 * Evidence door: every linear segment must land inside the collection's fetched feature episodes
 * (with an open end resolved against its baseline season length). Non-linear segments map the
 * season at collection level rather than 1:1 to episode indexes, requiring only a non-empty
 * collection and valid segment bounds. Returns a reason when a segment does not fit.
 */
export function checkSegmentsFitCollection(
  segments: readonly SegmentInput[],
  info: CollectionInfo,
  seasonEpisodeCount: (season: number) => number | null,
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
    const seasonCount = seasonEpisodeCount(seg.season);
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
      end = seasonCount;
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

const MS_PER_DAY = 86_400_000;
const PARTIAL_SEASON_AIRDATE_GAP_DAYS = 7;
const SIMULCAST_PREMIERE_SLACK_DAYS = 14;
const FINALE_PUBLICATION_SLACK_DAYS = 14;
const MIN_SEASON_SPAN_COVERAGE = 0.75;

function parseAirDateMs(value: string | null | undefined): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
}

function normalizeEpisodeSubtitle(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  const stripped = raw
    .trim()
    .replace(/^第\s*\d+\s*[期集话話回]\s*[上中下]?\s*(?:[（(][^）)]+[)）])?\s*[:：\-\s]*/u, "")
    .replace(/^(?:ep(?:isode)?|e)\s*\d+\s*[:：\-\s]*/iu, "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
  if (
    stripped.length < 4 ||
    /^\d+$/.test(stripped) ||
    /^(?:part\d*|先导片?|预告|花絮|彩蛋|特辑|番外|大结局|收官|加更版?|纯享版?)$/u.test(stripped)
  ) {
    return null;
  }
  return stripped;
}

function fullSeasonHint(season: number, episodeEnd: number, prefix: string): string {
  return (
    `${prefix} Never truncate a complete season to a linear prefix like 1..${episodeEnd}; ` +
    `if the platform splits broadcast parts or omits catalog extras (e.g. variety shows), submit one whole-season segment ` +
    `{ season: ${season}, episodeStart: 1, episodeEnd: null, targetEpisodeStart: 1, nonLinear: true }.`
  );
}

function checkBroadcastPeriodTruncation(
  info: CollectionInfo,
  seg: SegmentInput,
  seasonEpisodes: ReadonlyArray<{ episode: number; title?: string | null; airDate: string | null }>,
  broadcastStructured: boolean,
): { matched: true; message: string | null } | { matched: false } {
  const collectionPeriods = info.featureEpisodes.flatMap((ep) => {
    const period =
      (ep.title ? extractBroadcastPeriod(ep.title) : null) ??
      (ep.longTitle ? extractBroadcastPeriod(ep.longTitle) : null);
    return period !== null ? [period] : [];
  });
  const maxCollectionPeriod =
    collectionPeriods.length >= 2 || (broadcastStructured && collectionPeriods.length > 0)
      ? Math.max(...collectionPeriods)
      : null;

  const prefixPeriods: number[] = [];
  const afterPeriods: number[] = [];
  for (const ep of seasonEpisodes) {
    if (!ep.title) {
      continue;
    }
    const period = extractBroadcastPeriod(ep.title);
    if (period === null) {
      continue;
    }
    if (ep.episode <= seg.episodeEnd!) {
      prefixPeriods.push(period);
    } else {
      afterPeriods.push(period);
    }
  }
  if (maxCollectionPeriod === null || prefixPeriods.length === 0) {
    return { matched: false };
  }
  const maxPrefixPeriod = Math.max(...prefixPeriods);
  // Catalog confirms all collection broadcast periods fall inside 1..episodeEnd (e.g. a genuine Part 1).
  if (maxCollectionPeriod <= maxPrefixPeriod) {
    return { matched: true, message: null };
  }
  if (afterPeriods.length > 0 && Math.max(...afterPeriods) > maxPrefixPeriod) {
    const afterPeriod = Math.max(...afterPeriods);
    return {
      matched: true,
      message: fullSeasonHint(
        seg.season,
        seg.episodeEnd!,
        `${info.canonicalId} reaches broadcast period 第${maxCollectionPeriod}期, while baseline episodes 1..${seg.episodeEnd} only reach 第${maxPrefixPeriod}期 and 第${afterPeriod}期 appears later in season ${seg.season}.`,
      ),
    };
  }
  return { matched: false };
}

function checkTitleMatchTruncation(
  info: CollectionInfo,
  seg: SegmentInput,
  seasonEpisodes: ReadonlyArray<{ episode: number; title?: string | null; airDate: string | null }>,
): string | null {
  const prefixTitles = new Set<string>();
  const afterTitles = new Map<string, number>();
  for (const ep of seasonEpisodes) {
    const normalized = normalizeEpisodeSubtitle(ep.title);
    if (!normalized) {
      continue;
    }
    if (ep.episode <= seg.episodeEnd!) {
      prefixTitles.add(normalized);
    } else if (!afterTitles.has(normalized)) {
      afterTitles.set(normalized, ep.episode);
    }
  }
  if (afterTitles.size === 0) {
    return null;
  }
  const tailStart = Math.floor(info.featureEpisodes.length / 2);
  for (const ep of info.featureEpisodes.slice(tailStart)) {
    for (const rawTitle of [ep.title, ep.longTitle]) {
      const normalized = normalizeEpisodeSubtitle(rawTitle);
      if (!normalized || prefixTitles.has(normalized)) {
        continue;
      }
      const matchedCatalogEp = afterTitles.get(normalized);
      if (matchedCatalogEp !== undefined) {
        return fullSeasonHint(
          seg.season,
          seg.episodeEnd!,
          `${info.canonicalId} episode ${ep.index} matches season ${seg.season} episode ${matchedCatalogEp} (past baseline episode ${seg.episodeEnd}).`,
        );
      }
    }
  }
  return null;
}

function checkScheduleTruncation(
  info: CollectionInfo,
  seg: SegmentInput,
  seasonCount: number,
  seasonEpisodes: ReadonlyArray<{ episode: number; title?: string | null; airDate: string | null }>,
  broadcastStructured: boolean,
): string | null {
  // Only infer full-season coverage from schedule dates when episode granularity actually differs
  // (broadcast-split labels or catalog extras), never on plain linear split seasons.
  const catalogHasExtras = seasonEpisodes.some(
    (ep) => ep.title != null && hasVarietyExtraMarker(ep.title),
  );
  if (!broadcastStructured && !catalogHasExtras) {
    return null;
  }

  const firstEp = seasonEpisodes[0];
  const cutEp = seasonEpisodes.find((e) => e.episode === seg.episodeEnd);
  const finalEp = seasonEpisodes.at(-1);
  if (!firstEp || firstEp.episode !== 1 || !finalEp || finalEp.episode < seasonCount) {
    return null;
  }
  const firstMs = parseAirDateMs(firstEp.airDate);
  const cutMs = parseAirDateMs(cutEp?.airDate);
  const finalMs = parseAirDateMs(finalEp.airDate);
  if (
    firstMs === null ||
    cutMs === null ||
    finalMs === null ||
    finalMs - cutMs <= PARTIAL_SEASON_AIRDATE_GAP_DAYS * MS_PER_DAY
  ) {
    return null;
  }

  const datedMs = info.featureEpisodes.flatMap((ep) => {
    const ms = parseAirDateMs(ep.airDate);
    return ms !== null ? [ms] : [];
  });
  if (datedMs.length < Math.min(4, info.featureEpisodes.length) || datedMs.length < 2) {
    return null;
  }

  const firstCollectionDate = Math.min(...datedMs);
  const lastCollectionDate = Math.max(...datedMs);
  const seasonSpan = finalMs - firstMs;
  const prefixSpan = cutMs - firstMs;
  const collectionSpan = lastCollectionDate - firstCollectionDate;
  if (seasonSpan <= 0) {
    return null;
  }

  const rawShift = Math.max(0, firstCollectionDate - firstMs);
  const delayedShift = rawShift > SIMULCAST_PREMIERE_SLACK_DAYS * MS_PER_DAY ? rawShift : 0;
  const expectedCut = cutMs + delayedShift;
  const expectedFinale = finalMs + delayedShift;
  const finaleUpperBound = expectedFinale + FINALE_PUBLICATION_SLACK_DAYS * MS_PER_DAY;
  const postCutoffThreshold = expectedCut + PARTIAL_SEASON_AIRDATE_GAP_DAYS * MS_PER_DAY;
  const postCutoffDates = datedMs.filter(
    (ms) => ms > postCutoffThreshold && ms <= finaleUpperBound,
  );

  if (
    lastCollectionDate >= expectedFinale - PARTIAL_SEASON_AIRDATE_GAP_DAYS * MS_PER_DAY &&
    lastCollectionDate <= finaleUpperBound &&
    collectionSpan > prefixSpan + PARTIAL_SEASON_AIRDATE_GAP_DAYS * MS_PER_DAY &&
    collectionSpan >= seasonSpan * MIN_SEASON_SPAN_COVERAGE &&
    postCutoffDates.length >= Math.max(2, Math.floor(datedMs.length * 0.2)) &&
    new Set(postCutoffDates).size >= 2
  ) {
    const firstCollectionIso = new Date(firstCollectionDate).toISOString().slice(0, 10);
    const lastCollectionIso = new Date(lastCollectionDate).toISOString().slice(0, 10);
    return fullSeasonHint(
      seg.season,
      seg.episodeEnd!,
      `${info.canonicalId}'s broadcast schedule (${firstCollectionIso}..${lastCollectionIso}) spans season ${seg.season}'s full run through its finale (${finalEp.airDate}), while baseline episode ${seg.episodeEnd} aired on ${cutEp!.airDate}.`,
    );
  }
  return null;
}

/**
 * Catches truncated linear submissions like 1..20 of 47 when actual episode evidence (broadcast
 * period numbers, distinctive post-cutoff titles, or variety-structured schedule progression)
 * shows the collection covers through the season finale rather than just a delayed/split prefix.
 */
export function findFullSeasonTruncationMessage(
  segments: readonly SegmentInput[],
  info: CollectionInfo,
  seasonEpisodeCount: (season: number) => number | null,
  seasonEpisodes: ReadonlyArray<{ episode: number; title?: string | null; airDate: string | null }>,
): string | null {
  if (segments.length !== 1) {
    return null;
  }
  const seg = segments[0]!;
  if (seg.nonLinear || (seg.episodeStart ?? 1) !== 1 || seg.episodeEnd == null) {
    return null;
  }
  const seasonCount = seasonEpisodeCount(seg.season);
  if (
    seasonCount === null ||
    seg.episodeEnd >= seasonCount ||
    info.featureEpisodes.length === 0 ||
    seasonEpisodes.length === 0
  ) {
    return null;
  }

  const broadcastStructured = isBroadcastStructured(info.featureEpisodes);
  const periodCheck = checkBroadcastPeriodTruncation(
    info,
    seg,
    seasonEpisodes,
    broadcastStructured,
  );
  if (periodCheck.matched) {
    return periodCheck.message;
  }

  return (
    checkTitleMatchTruncation(info, seg, seasonEpisodes) ??
    checkScheduleTruncation(info, seg, seasonCount, seasonEpisodes, broadcastStructured)
  );
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
  positions: [number, number];
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
    ])
    .where("associations.media_id", "=", media.id)
    .where("associations.namespace", "=", namespace)
    .where("associations.status", "=", "confirmed")
    .orderBy("segments.season")
    .orderBy("segments.target_episode_start")
    .execute();
  for (const row of rows) {
    const positions = platformPositions(
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
  const claimed = segments.map((s) => platformPositions(s, (x) => seasonLength(media, x)));
  const lost = (target.mappedSeasons.get(canonicalId) ?? []).filter(
    ({ season, positions: [a, b] }) =>
      !restated.has(season) && claimed.some(([c, d]) => a <= d && c <= b),
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
    "   Use partial linear segments (e.g. 1..24 of 47) only when the collection truly covers just that contiguous subset of episodes (such as Part 1 of a split season).",
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
  passesGate(info: CollectionInfo, segments: readonly SegmentInput[]): boolean;
  segmentMisfit(info: CollectionInfo, segments: readonly SegmentInput[]): string | null;
  baseSegments: SegmentInput[];
}

function createJobRun(
  ctx: ExplorationExecutionContext,
  catalog: CatalogEvidence,
  budget: SessionBudget,
): JobRun {
  const segmentMisfit = (info: CollectionInfo, segments: readonly SegmentInput[]) =>
    checkSegmentsFitCollection(segments, info, (season) => seasonLength(ctx.media, season));
  return {
    ctx,
    budget,
    segmentMisfit,
    // The whole gate, not Step 1 alone: Step 1 accepts the year and episode count of any season,
    // so another season's collection (same count, its own year) would pass as this season.
    passesGate: (info, segments) =>
      segmentMisfit(info, segments) === null &&
      evaluateEvidenceGate({ catalog, collection: info, segments: normalizeSegments(segments) })
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

  for (const [id, sources] of [...sourcesById].slice(0, MAX_CANDIDATES_PER_PLATFORM)) {
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
  const passing = [...target.fetched.values()].filter(
    (c) =>
      lostSeasons(target, run.ctx.media, c.info.canonicalId, mapping(c)).length === 0 &&
      run.passesGate(c.info, mapping(c)),
  );
  if (passing.length === 1) {
    const result = await submitMapping(
      run,
      target,
      passing[0]!.info,
      mapping(passing[0]!),
      passing[0]!.suggestedVariantDescription ?? undefined,
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
        "Conclude a namespace with a fetched collection. For TV, linear segments map baseline episodes episodeStart..episodeEnd of `season` to collection episodes targetEpisodeStart onward. Omit segments to map the requested season 1:1. Set nonLinear: true with { episodeStart: 1, episodeEnd: null, targetEpisodeStart: 1 } when a collection holds the full season whose episode granularity differs from the baseline catalog (e.g. variety shows where TMDB counts extras/prologues alongside broadcast parts); never truncate a full season to a shorter linear prefix unless the collection genuinely stops at that episode.",
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
    const segments = parseModelSegments(args.segments, ctx.media, ctx.season);
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
    if (
      segments.length === 1 &&
      !segments[0]!.nonLinear &&
      segments[0]!.episodeStart === 1 &&
      segments[0]!.episodeEnd != null &&
      toolCtx.tmdbTvId &&
      candidate.info.featureEpisodes.length > 0
    ) {
      const targetSeason = segments[0]!.season;
      const seasonCount = seasonLength(ctx.media, targetSeason);
      if (seasonCount !== null && segments[0]!.episodeEnd < seasonCount) {
        const seasonEpisodes = await ctx.tmdbGateway
          .fetchSeasonEpisodes(toolCtx.tmdbTvId, targetSeason)
          .catch(() => null);
        if (seasonEpisodes && seasonEpisodes.length > 0) {
          const truncationMsg = findFullSeasonTruncationMessage(
            segments,
            candidate.info,
            (season) => seasonLength(ctx.media, season),
            seasonEpisodes,
          );
          if (truncationMsg) {
            return {
              ok: false,
              error: "PARTIAL_SEGMENT_SPANS_FULL_SEASON",
              message: truncationMsg,
            };
          }
        }
      }
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

interface TmdbExplorationStepResult {
  outcome: PlatformExplorationOutcome;
  mergedIntoMediaId?: string;
}

/**
 * Resolves the media's missing TMDB external ID (ADR 0002 §2.1 & ADR 0004 §1).
 *
 * 1. First checks whether another active unmerged media in the DB already shares any active
 *    catalog association (`douban`/`bangumi`) and automatically merges verified duplicates.
 * 2. Otherwise looks up IMDb -> TMDB `/find` + details; if that TMDB ID (or secondary external ID)
 *    is held by another canonical media, verifies compatibility and auto-merges verified duplicates,
 *    raising `agent_external_id_conflict` only when verification blocks auto-merge.
 */
async function exploreTmdbExternalId(
  ctx: ExplorationExecutionContext,
): Promise<TmdbExplorationStepResult> {
  const namespace = "tmdb";
  await ensureExplorationAgentUser(ctx.db);

  // 1. Check DB for other active media sharing the same Douban / Bangumi collection first
  //    (zero external calls when DB titles match; handles duplicates that have no IMDb ID).
  const sharedCatalogCandidates = await ctx.db
    .transaction()
    .execute((trx) => findSharedCatalogDuplicateMediaIdsInTx(trx, ctx.media.id));

  for (const candidate of sharedCatalogCandidates) {
    const mergeAttempt = await verifyAndAutoMergeDuplicateMedia(ctx.db, {
      mediaIdA: ctx.media.id,
      mediaIdB: candidate.otherMediaId,
      actorUserId: EXPLORATION_AGENT_USER_ID,
      reason: `exploration_shared_catalog:${candidate.namespace}:${candidate.nativeId}`,
      outbound: ctx.outbound,
      tmdbGateway: ctx.tmdbGateway,
      now: ctx.now,
    });
    if (mergeAttempt.merged && mergeAttempt.targetMediaId !== ctx.media.id) {
      const targetTmdb = await ctx.db
        .selectFrom("associations")
        .where("is_external_id", "=", true)
        .select("native_id")
        .where("media_id", "=", mergeAttempt.targetMediaId)
        .where("namespace", "=", "tmdb")
        .where("status", "!=", "delisted")
        .executeTakeFirst();
      return {
        outcome: targetTmdb
          ? { namespace, status: "submitted", nativeId: targetTmdb.native_id, directWrite: true }
          : { namespace, status: "transient_error", reason: "merged_target_missing_tmdb" },
        mergedIntoMediaId: mergeAttempt.targetMediaId,
      };
    }
  }

  // Re-check DB in case a merged duplicate transferred TMDB or IMDb onto ctx.media.id
  const currentExtIds = await ctx.db
    .selectFrom("associations")
    .where("is_external_id", "=", true)
    .select(["namespace", "native_id"])
    .where("media_id", "=", ctx.media.id)
    .where("status", "!=", "delisted")
    .execute();
  const acquiredTmdb = currentExtIds.find((e) => e.namespace === "tmdb");
  if (acquiredTmdb) {
    return {
      outcome: {
        namespace,
        status: "submitted",
        nativeId: acquiredTmdb.native_id,
        directWrite: true,
      },
    };
  }

  const imdbId =
    currentExtIds.find((e) => e.namespace === "imdb")?.native_id ??
    ctx.media.externalIds.find((e) => e.namespace === "imdb")?.nativeId;
  if (!imdbId) {
    return { outcome: { namespace, status: "not_found", reason: "no_imdb_id_for_tmdb_find" } };
  }

  let entry;
  let tmdbSnapshotTitles: string[] = [];
  try {
    const found = (await ctx.tmdbGateway.findByImdbId(imdbId)).filter(
      (f) => f.type === ctx.media.type,
    );
    if (found.length !== 1) {
      return {
        outcome: {
          namespace,
          status: "not_found",
          reason: found.length === 0 ? "imdb_not_on_tmdb" : "ambiguous_tmdb_find",
        },
      };
    }
    const detail = await ctx.tmdbGateway.fetchMediaSnapshotAndExternalIds(
      found[0]!.type,
      found[0]!.id,
    );
    if (!detail || detail.externalIds.imdb !== imdbId) {
      return { outcome: { namespace, status: "not_found", reason: "tmdb_imdb_mismatch" } };
    }
    tmdbSnapshotTitles = [detail.snapshot.title, detail.snapshot.originalTitle].filter(
      (t): t is string => typeof t === "string" && t.trim().length > 0,
    );
    entry = { ...found[0]!, externalIds: detail.externalIds };
  } catch (error) {
    return {
      outcome: {
        namespace,
        status: "transient_error",
        reason: error instanceof Error ? error.message : "tmdb_lookup_failed",
      },
    };
  }

  const nativeIds: Partial<Record<"tmdb" | "tvdb" | "trakt", string>> = {
    tmdb: `${entry.type}:${entry.id}`,
    ...(entry.externalIds.tvdb ? { tvdb: entry.externalIds.tvdb } : {}),
    ...(entry.externalIds.trakt ? { trakt: entry.externalIds.trakt } : {}),
  };

  const txResult = await ctx.db.transaction().execute(async (trx) => {
    const mediaId = ctx.media.id;
    let tmdbWritten = false;
    for (const [ns, nativeId] of Object.entries(nativeIds) as Array<
      ["tmdb" | "tvdb" | "trakt", string]
    >) {
      await acquireAdvisoryLock(trx, ADVISORY_LOCK_CLASSES.MEDIA_NAMESPACE, `${mediaId}:${ns}`);
      const held = await trx
        .selectFrom("associations")
        .select(["id", "media_id", "native_id"])
        .where("is_external_id", "=", true)
        .where("namespace", "=", ns)
        .where((eb) => eb.or([eb("media_id", "=", mediaId), eb("native_id", "=", nativeId)]))
        .execute();
      if (held.some((row) => row.media_id === mediaId)) {
        if (ns === "tmdb") {
          tmdbWritten = true;
        }
        continue; // Only fill empty slots.
      }
      const other = held.find((row) => row.native_id === nativeId);
      if (other) {
        const canonicalOtherId =
          (await resolveCanonicalMediaIdInTx(trx, other.media_id)) ?? other.media_id;
        if (canonicalOtherId === mediaId) {
          await trx
            .updateTable("associations")
            .where("is_external_id", "=", true)
            .set({ media_id: mediaId, source: "agent", updated_at: ctx.now })
            .where("id", "=", other.id)
            .execute();
          tmdbWritten ||= ns === "tmdb";
          continue;
        }

        const mergeAttempt = await verifyAndAutoMergeDuplicateMediaInTx(trx, {
          mediaIdA: mediaId,
          mediaIdB: canonicalOtherId,
          actorUserId: EXPLORATION_AGENT_USER_ID,
          reason: `exploration_external_id_match:${ns}:${nativeId}`,
          extraTitlesByMediaId: new Map([[mediaId, tmdbSnapshotTitles]]),
          acquireMergeLocks: true,
          now: ctx.now,
        });

        if (mergeAttempt.merged) {
          if (mergeAttempt.targetMediaId !== mediaId) {
            return {
              kind: "merged_into_other" as const,
              targetMediaId: mergeAttempt.targetMediaId,
            };
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
            tmdbWritten ||= ns === "tmdb";
            continue;
          }
        } else {
          const existing = await trx
            .selectFrom("review_alerts")
            .select("id")
            .where("alert_type", "=", "agent_external_id_conflict")
            .where("media_id", "=", mediaId)
            .where("status", "=", "open")
            .where((eb) => eb(eb.ref("details", "->>").key("namespace"), "=", ns))
            .where((eb) => eb(eb.ref("details", "->>").key("nativeId"), "=", nativeId))
            .executeTakeFirst();
          if (!existing) {
            await trx
              .insertInto("review_alerts")
              .values({
                alert_type: "agent_external_id_conflict",
                media_id: mediaId,
                status: "open",
                details: JSON.stringify({
                  namespace: ns,
                  nativeId,
                  otherMediaId: canonicalOtherId,
                  matchedBy: { imdb: imdbId },
                  autoMergeBlockedReason: mergeAttempt.blockReason,
                  autoMergeCheckedAt: ctx.now.toISOString(),
                  jobId: ctx.jobId,
                }),
              })
              .execute();
          }
          if (ns === "tmdb") {
            return { kind: "conflict" as const };
          }
          continue;
        }
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
    return { kind: tmdbWritten ? ("written" as const) : ("conflict" as const) };
  });

  if (txResult.kind === "merged_into_other") {
    return {
      outcome: { namespace, status: "submitted", nativeId: nativeIds.tmdb!, directWrite: true },
      mergedIntoMediaId: txResult.targetMediaId,
    };
  }

  return {
    outcome:
      txResult.kind === "written"
        ? { namespace, status: "submitted", nativeId: nativeIds.tmdb!, directWrite: true }
        : { namespace, status: "not_found", reason: "tmdb_id_on_other_media" },
  };
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

    // The TMDB external ID has no adapter: it is looked up and written directly.
    const hasTmdb = ctx.media.externalIds.some((e) => e.namespace === "tmdb");
    if (ctx.targetNamespaces.includes("tmdb") && !hasTmdb) {
      const stepStartMs = clockMs();
      const tmdbStep = await exploreTmdbExternalId(ctx);
      platformOutcomes.push({
        ...tmdbStep.outcome,
        durationMs: Math.max(0, clockMs() - stepStartMs),
      });
      if (tmdbStep.mergedIntoMediaId) {
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

    const budget = createSessionBudget(ctx.outbound, clockMs() + config.maxDurationMs, clockMs);
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
