import type { MediaType, Namespace, PlatformNamespace } from "@media-ref/client";
import { bilibiliAdapter } from "../adapters/bilibili.ts";
import { iqiyiAdapter } from "../adapters/iqiyi.ts";
import { mgtvAdapter } from "../adapters/mgtv.ts";
import { tencentAdapter } from "../adapters/tencent.ts";
import {
  AdapterTransientError,
  type PlatformAdapter,
  type Tier3Adapter,
} from "../adapters/types.ts";
import { fetchDoubanFrodo, fetchDoubanImdbLookup } from "../adapters/douban-api.ts";
import { youkuAdapter } from "../adapters/youku.ts";
import { normalizeTitleForComparison } from "../evidence-gate.ts";
import type { ExternalHttpRequest, ExternalHttpResponse, OutboundClient } from "../outbound.ts";

/**
 * Discovery sources for the exploration agent (ADR 0002, "discover" step). Deterministic, no model:
 * given one media, ask 360kan's index, Douban's "where to watch" and iQIYI / Youku search for play
 * links, canonicalize every link through the platform adapters, and return a closed candidate set
 * keyed by (namespace, canonicalId). A failing source never hides the others: each gets its own report.
 */

export type DiscoverySourceId = "360kan" | "douban" | "iqiyi_search" | "youku_search";

export interface DiscoveryMediaInput {
  title: string;
  originalTitle?: string | null;
  year?: number | null;
  mediaType: MediaType;
  season?: number | null;
  /** Already-known External IDs / associations; `douban` and `imdb` feed the Douban source. */
  externalIds?: Partial<Record<Namespace, string>>;
}

export interface DiscoveryCandidateSource {
  source: DiscoverySourceId;
  /** Title / year as that source labelled the entry. */
  title: string | null;
  year: number | null;
  /** The link as the source gave it (null when the source returned an ID, not a link). */
  rawUrl: string | null;
}

export interface DiscoveryCandidate {
  namespace: PlatformNamespace;
  canonicalId: string;
  /** From the first source that reported the collection. */
  title: string | null;
  year: number | null;
  sources: DiscoveryCandidateSource[];
}

export type DiscoverySourceReport =
  /** The source answered; `links` may be 0, which means the source really has nothing. */
  | { source: DiscoverySourceId; status: "ok"; links: number }
  /** The source answered that it does not know this media (e.g. IMDb ID absent on Douban). */
  | { source: DiscoverySourceId; status: "not_found"; reason: string }
  /** Not asked: the media lacks the input this source needs. */
  | { source: DiscoverySourceId; status: "skipped"; reason: string }
  /** Request failed, timed out or returned something unreadable; absence of links means nothing. */
  | { source: DiscoverySourceId; status: "error"; reason: string };

export interface DroppedDiscoveryLink {
  source: DiscoverySourceId;
  /** Platform key as the source named it (`qiyi`, `qq`, `douyin`, ...). */
  platformKey: string;
  rawUrl: string;
  namespace: PlatformNamespace | null;
  reason: string;
}

export interface DiscoveryResult {
  candidates: DiscoveryCandidate[];
  sources: DiscoverySourceReport[];
  dropped: DroppedDiscoveryLink[];
}

export interface DiscoverCandidatesOptions {
  outbound: OutboundClient;
  /** Per-request timeout, applied to adapter canonicalization requests too. Default 10s. */
  timeoutMs?: number;
}

export const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000;

const KAN360_INDEX_API = "https://api.so.360kan.com/index";
const MAX_360KAN_ROWS = 6;

// Workers keep at most 6 connections open; timeouts start at call time, so queue here instead.
const MAX_CONCURRENT_RESOLVES = 4;

const PLATFORM_ADAPTERS: readonly PlatformAdapter[] = [
  iqiyiAdapter,
  tencentAdapter,
  youkuAdapter,
  bilibiliAdapter,
  mgtvAdapter,
];

/** 360kan `playlinks` keys and Douban `vendors[].id` values → our namespace. */
const PLATFORM_KEYS: Record<string, PlatformNamespace> = {
  qiyi: "iqiyi",
  iqiyi: "iqiyi",
  qq: "tencent",
  tencent: "tencent",
  youku: "youku",
  imgo: "mgtv",
  mgtv: "mgtv",
  bilibili: "bilibili",
  bilibili1: "bilibili",
};

interface RawLink {
  source: DiscoverySourceId;
  platformKey: string;
  url: string;
  /** Extra strings (e.g. Douban's app `uri`) that may carry the platform's own ID. */
  extra?: string;
  title: string | null;
  year: number | null;
}

interface SourceOutcome {
  report: DiscoverySourceReport;
  links: RawLink[];
  /** Entries a source already returned as canonical IDs (platform search). */
  ids?: Array<{ namespace: PlatformNamespace; id: string; candidate: DiscoveryCandidateSource }>;
}

export async function discoverCandidates(
  media: DiscoveryMediaInput,
  options: DiscoverCandidatesOptions,
): Promise<DiscoveryResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const outbound: OutboundClient = {
    ...options.outbound,
    fetchExternal: (request) =>
      options.outbound.fetchExternal({ ...request, timeoutMs: request.timeoutMs ?? timeoutMs }),
  };

  const outcomes = await Promise.all([
    guard("360kan", () => fetch360kan(media, outbound)),
    guard("douban", () => fetchDoubanVendors(media, outbound)),
    guard("iqiyi_search", () => fetchPlatformSearch("iqiyi_search", iqiyiAdapter, media, outbound)),
    guard("youku_search", () => fetchPlatformSearch("youku_search", youkuAdapter, media, outbound)),
  ]);

  const candidates = new Map<string, DiscoveryCandidate>();
  const add = (
    namespace: PlatformNamespace,
    canonicalId: string,
    src: DiscoveryCandidateSource,
  ) => {
    const key = `${namespace}:${canonicalId}`;
    const existing = candidates.get(key);
    if (existing) {
      existing.sources.push(src);
      existing.title ??= src.title;
      existing.year ??= src.year;
    } else {
      candidates.set(key, {
        namespace,
        canonicalId,
        title: src.title,
        year: src.year,
        sources: [src],
      });
    }
  };

  for (const outcome of outcomes) {
    for (const entry of outcome.ids ?? []) {
      add(entry.namespace, entry.id, entry.candidate);
    }
  }

  const dropped: DroppedDiscoveryLink[] = [];
  const resolveCache = new Map<string, Promise<string>>();
  const links = outcomes.flatMap((o) => o.links);
  const resolved = await mapWithConcurrency(links, MAX_CONCURRENT_RESOLVES, (link) =>
    resolveLink(link, outbound, resolveCache),
  );
  links.forEach((link, i) => {
    const result = resolved[i]!;
    const src: DiscoveryCandidateSource = {
      source: link.source,
      title: link.title,
      year: link.year,
      rawUrl: link.url,
    };
    if ("canonicalId" in result) {
      add(result.namespace, result.canonicalId, src);
    } else {
      dropped.push({
        source: link.source,
        platformKey: link.platformKey,
        rawUrl: link.url,
        namespace: result.namespace,
        reason: result.reason,
      });
    }
  });

  return { candidates: [...candidates.values()], sources: outcomes.map((o) => o.report), dropped };
}

async function guard(
  source: DiscoverySourceId,
  run: () => Promise<SourceOutcome>,
): Promise<SourceOutcome> {
  try {
    return await run();
  } catch (error) {
    return { report: { source, status: "error", reason: errorMessage(error) }, links: [] };
  }
}

// ---------------------------------------------------------------------------
// Link → (namespace, canonicalId)

async function resolveLink(
  link: RawLink,
  outbound: OutboundClient,
  cache: Map<string, Promise<string>>,
): Promise<
  | { namespace: PlatformNamespace; canonicalId: string }
  | { namespace: PlatformNamespace | null; reason: string }
> {
  const platformKey = link.platformKey.toLowerCase();
  const namespace =
    (Object.hasOwn(PLATFORM_KEYS, platformKey) ? PLATFORM_KEYS[platformKey] : undefined) ??
    PLATFORM_ADAPTERS.find((a) => a.parseInput(link.url) !== null)?.namespace ??
    null;
  if (!namespace) {
    return { namespace: null, reason: `unsupported_platform:${link.platformKey}` };
  }
  const adapter = PLATFORM_ADAPTERS.find((a) => a.namespace === namespace)!;

  const inputs = [...idHints(namespace, `${link.url} ${link.extra ?? ""}`), link.url];
  const parsedInputs = inputs.flatMap((input) => {
    const parsed = adapter.parseInput(input);
    return parsed ? [{ input, parsed }] : [];
  });
  // Prefer inputs that canonicalize without a network call.
  const chosen = parsedInputs.find((p) => p.parsed.canonicalId !== null) ?? parsedInputs[0];
  if (!chosen) {
    return { namespace, reason: "unparseable_link" };
  }
  if (chosen.parsed.canonicalId !== null) {
    return { namespace, canonicalId: chosen.parsed.canonicalId };
  }

  const key = `${namespace}:${chosen.parsed.kind}:${chosen.parsed.id}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = adapter.canonicalize(chosen.input, outbound);
    cache.set(key, pending);
  }
  try {
    return { namespace, canonicalId: await pending };
  } catch (error) {
    // Transient (outage, captcha, timeout) vs permanent (not a collection link) failures differ.
    const kind =
      error instanceof AdapterTransientError ? "canonicalize_transient" : "canonicalize_failed";
    return { namespace, reason: `${kind}:${errorMessage(error)}` };
  }
}

/** Platform IDs carried in query strings of app URIs / redirect links (Douban vendors, 360 youku). */
function idHints(namespace: PlatformNamespace, text: string): string[] {
  const param = (name: string): string[] =>
    [...text.matchAll(new RegExp(`[?&]${name}=([A-Za-z0-9=_-]+)`, "g"))].map((m) => m[1]!);
  switch (namespace) {
    case "iqiyi":
      return param("aid");
    case "tencent":
      return param("cid");
    case "youku":
      return [
        ...param("showid"),
        ...param("showId"),
        ...param("vid").map((vid) => `https://v.youku.com/v_show/id_${vid}.html`),
      ];
    case "bilibili":
      return [
        ...param("season_id").map((id) => `ss${id}`),
        ...param("ep_id").map((id) => `ep${id}`),
      ];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Sources

async function fetch360kan(
  media: DiscoveryMediaInput,
  outbound: OutboundClient,
): Promise<SourceOutcome> {
  const source = "360kan";
  const url = `${KAN360_INDEX_API}?force_v=1&kw=${encodeURIComponent(media.title.trim())}&pageno=1&v_ap=1&tab=all`;
  const root = asRecord(await fetchJson(outbound, { kind: "platform", namespace: "360kan", url }));
  if (!root || root.code !== 0) {
    return errorOutcome(source, `360kan_code_${String(root?.code)}`);
  }
  const rows = asRecord(asRecord(root.data)?.longData)?.rows;
  const links: RawLink[] = [];
  // A keyword search returns loosely related titles too; only rows that start with the title and
  // are not older than the media keep their links, so canonicalization requests stay bounded.
  const wanted = normalizeTitleForComparison(media.title);
  let keptRows = 0;
  for (const rawRow of Array.isArray(rows) ? rows : []) {
    const row = asRecord(rawRow);
    const playlinks = asRecord(row?.playlinks);
    if (!row || !playlinks || keptRows >= MAX_360KAN_ROWS) {
      continue;
    }
    const rowTitle = stringOrNull(row.titleTxt);
    const rowYear = parseYear(row.year);
    if (
      (wanted.length > 0 && !normalizeTitleForComparison(rowTitle ?? "").startsWith(wanted)) ||
      (media.year != null && rowYear !== null && rowYear < media.year - 1)
    ) {
      continue;
    }
    keptRows += 1;
    for (const [platformKey, link] of Object.entries(playlinks)) {
      if (typeof link === "string" && link.length > 0) {
        links.push({
          source,
          platformKey,
          url: link,
          title: stringOrNull(row.titleTxt),
          year: parseYear(row.year),
        });
      }
    }
  }
  return { report: { source, status: "ok", links: links.length }, links };
}

async function fetchDoubanVendors(
  media: DiscoveryMediaInput,
  outbound: OutboundClient,
): Promise<SourceOutcome> {
  const source = "douban";
  let doubanId = media.externalIds?.douban?.trim() || null;
  if (doubanId !== null && !/^\d+$/.test(doubanId)) {
    return errorOutcome(source, "invalid_douban_id");
  }
  if (doubanId === null) {
    const imdbId = media.externalIds?.imdb?.trim();
    if (!imdbId) {
      return { report: { source, status: "skipped", reason: "no_douban_or_imdb_id" }, links: [] };
    }
    if (!/^tt\d+$/.test(imdbId)) {
      return errorOutcome(source, "invalid_imdb_id");
    }
    const found = await lookupDoubanSubjectByImdb(imdbId, outbound);
    if (found === null) {
      return { report: { source, status: "not_found", reason: "imdb_not_on_douban" }, links: [] };
    }
    doubanId = found;
  }

  // frodo `/subject/<id>` serves movies and TV alike.
  const detail = asRecord(
    parseJsonResponse(
      await fetchDoubanFrodo(outbound, `/subject/${doubanId}`, { kind: "platform" }),
      [404],
    ),
  );
  if (detail === null) {
    return {
      report: { source, status: "not_found", reason: "douban_subject_not_found" },
      links: [],
    };
  }
  const title = stringOrNull(detail.title);
  const year = parseYear(detail.year);
  const links: RawLink[] = [];
  for (const rawVendor of Array.isArray(detail.vendors) ? detail.vendors : []) {
    const vendor = asRecord(rawVendor);
    const platformKey = stringOrNull(vendor?.id);
    const url = stringOrNull(vendor?.url) ?? stringOrNull(vendor?.uri);
    if (vendor && platformKey && url) {
      links.push({ source, platformKey, url, extra: stringOrNull(vendor.uri) ?? "", title, year });
    }
  }
  return { report: { source, status: "ok", links: links.length }, links };
}

/**
 * Douban subject ID for an IMDb ID (`tt…`), or null when Douban does not know it.
 * Throws on request failures and unexpected payloads, which mean "unknown", not "absent".
 */
export async function lookupDoubanSubjectByImdb(
  imdbId: string,
  outbound: OutboundClient,
): Promise<string | null> {
  const lookup = asRecord(
    parseJsonResponse(await fetchDoubanImdbLookup(outbound, imdbId, { kind: "platform" }), [404]),
  );
  // Unknown IMDb IDs come back as HTTP 200 `{"msg":"movie_not_found","code":5000}` (or a 404).
  const idMatch = stringOrNull(lookup?.id)?.match(/\/(\d+)\/?$/);
  if (idMatch) {
    return idMatch[1]!;
  }
  if (lookup === null || lookup.code === 5000 || lookup.msg === "movie_not_found") {
    return null;
  }
  throw new Error("unexpected_imdb_lookup_payload");
}

async function fetchPlatformSearch(
  source: DiscoverySourceId,
  adapter: Tier3Adapter<PlatformNamespace>,
  media: DiscoveryMediaInput,
  outbound: OutboundClient,
): Promise<SourceOutcome> {
  const result = await adapter.search(
    {
      title: media.title,
      originalTitle: media.originalTitle,
      year: media.year,
      mediaType: media.mediaType,
      season: media.season,
    },
    outbound,
  );
  if (result.status !== "ok") {
    return errorOutcome(source, result.reason);
  }
  return {
    report: { source, status: "ok", links: result.candidates.length },
    links: [],
    ids: result.candidates.map((c) => ({
      namespace: adapter.namespace,
      id: c.canonicalId,
      candidate: { source, title: c.title, year: c.year ?? null, rawUrl: c.url ?? null },
    })),
  };
}

// ---------------------------------------------------------------------------
// Helpers

/** Fetch and parse JSON; returns null for `nullStatuses` (e.g. 404 = "not there"), throws otherwise. */
async function fetchJson(
  outbound: OutboundClient,
  request: ExternalHttpRequest,
  nullStatuses: readonly number[] = [],
): Promise<unknown> {
  return parseJsonResponse(await outbound.fetchExternal(request), nullStatuses);
}

function parseJsonResponse(
  response: ExternalHttpResponse,
  nullStatuses: readonly number[] = [],
): unknown {
  if (nullStatuses.includes(response.status)) {
    return null;
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`http_${response.status}`);
  }
  try {
    return JSON.parse(response.body);
  } catch {
    throw new Error("invalid_json");
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await run(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function errorOutcome(source: DiscoverySourceId, reason: string): SourceOutcome {
  return { report: { source, status: "error", reason }, links: [] };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseYear(value: unknown): number | null {
  const year = Number(typeof value === "string" ? value.trim().slice(0, 4) : value);
  return Number.isInteger(year) && year >= 1800 && year <= 3000 ? year : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
