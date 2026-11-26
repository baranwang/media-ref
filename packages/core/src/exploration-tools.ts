/**
 * The exploration agent's open tools (ADR 0002 §3.1): catalog and platform search, precise
 * lookups, link resolution, web search, and fetching a collection's episodes.
 *
 * Only `get_collection` puts a collection into the task's candidate set; `submit_mapping` (in the
 * executor) accepts nothing else, so search results are leads, never evidence.
 */

import type { MediaType, Namespace } from "@media-ref/client";
import {
  AdapterTransientError,
  isTier2Adapter,
  isTier3Adapter,
  type AdapterRegistry,
  type CollectionInfo,
} from "./adapters/index.ts";
import { fetchDoubanFrodo } from "./adapters/douban-api.ts";
import type { ModelToolDefinition, OutboundClient } from "./outbound.ts";
import type { TmdbGateway } from "./tmdb.ts";

const MAX_EPISODES_IN_TOOL_RESULT = 80;
const KAN360_INDEX_API = "https://api.so.360kan.com/index";
const SEARCH_SOURCES = ["tmdb", "trakt", "douban", "360kan"] as const;
const LOOKUP_SOURCES = ["tmdb", "trakt", "douban"] as const;

export interface ToolContext {
  outbound: OutboundClient;
  registry: AdapterRegistry;
  tmdb: TmdbGateway;
  /** Namespaces whose collections `get_collection` can fetch (platforms, Douban). */
  collectionNamespaces: readonly Namespace[];
  /** Records a fetched collection as a candidate; returns whether the default mapping passes. */
  register(info: CollectionInfo, source: string): boolean;
  /** An upstream outage on a namespace: its "not found" is then inconclusive. */
  noteTransient(namespace: Namespace, reason: string): void;
  seasons: ReadonlyArray<{ season: number; episodeCount: number; airYear?: number | null }>;
  /** TMDB TV ID when TMDB is the baseline catalog: `get_catalog_season` lists its episodes. */
  tmdbTvId: string | null;
}

/** The query tools; the executor adds `submit_mapping` and `mark_not_found`. */
export function buildQueryTools(ctx: ToolContext): ModelToolDefinition[] {
  const searchable = ctx.collectionNamespaces.filter((ns) => {
    const adapter = ctx.registry.get(ns);
    return adapter !== undefined && isTier3Adapter(adapter);
  });
  const tools: ModelToolDefinition[] = [
    {
      name: "search_catalog",
      description:
        "Search a catalog by title. tmdb/trakt return their IDs; douban returns subject IDs (one subject per TV season); 360kan returns titles with each video platform's play link.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", enum: [...SEARCH_SOURCES] },
          query: { type: "string" },
          year: { type: "integer" },
          type: { type: "string", enum: ["movie", "tv"] },
        },
        required: ["source", "query"],
      },
    },
    {
      name: "get_catalog_entry",
      description:
        'One catalog entry by ID: tmdb "tv:123"/"movie:123" (seasons, IMDb/TVDB IDs), trakt "show:123"/"movie:123", douban subject ID (also lists its "where to watch" platform links).',
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", enum: [...LOOKUP_SOURCES] },
          id: { type: "string" },
        },
        required: ["source", "id"],
      },
    },
    {
      name: "resolve_link",
      description:
        "Turn a video platform or Douban URL into its namespace and canonical collection ID.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
    {
      name: "get_collection",
      description:
        "Fetch one collection (by ID or URL) with its feature episodes. Only collections fetched here can be submitted.",
      parameters: {
        type: "object",
        properties: {
          namespace: { type: "string", enum: [...ctx.collectionNamespaces] },
          id: { type: "string", description: "Collection ID or URL." },
        },
        required: ["namespace", "id"],
      },
    },
    {
      name: "get_catalog_season",
      description: `Get the target media's season from the baseline catalog: episode count, air year and, when available, each episode's number, title and air date (at most ${MAX_EPISODES_IN_TOOL_RESULT} episodes per call).`,
      parameters: {
        type: "object",
        properties: {
          season: { type: "integer", description: "0 = specials." },
          fromEpisode: {
            type: "integer",
            minimum: 1,
            description: "List episodes from this episode number on (default 1).",
          },
        },
        required: ["season"],
      },
    },
  ];
  if (searchable.length > 0) {
    tools.push({
      name: "search_platform",
      description:
        "Search a video platform's own index by keyword. Other platforms have no working search: find their links via 360kan, Douban or web search.",
      parameters: {
        type: "object",
        properties: {
          platform: { type: "string", enum: searchable },
          keyword: { type: "string" },
        },
        required: ["platform", "keyword"],
      },
    });
  }
  if (ctx.outbound.callWebTool) {
    tools.push(
      {
        name: "web_search",
        description:
          "Search the web. Useful for finding platform pages or Douban subjects when other sources fail.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            count: { type: "integer", minimum: 1, maximum: 10 },
            allowed_domains: { type: "array", items: { type: "string" } },
          },
          required: ["query"],
        },
      },
      {
        name: "web_fetch",
        description: "Fetch a web page as text. Long pages come in parts: pass the offset given.",
        parameters: {
          type: "object",
          properties: { url: { type: "string" }, offset: { type: "integer" } },
          required: ["url"],
        },
      },
    );
  }
  return tools;
}

export const QUERY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "search_catalog",
  "get_catalog_entry",
  "resolve_link",
  "get_collection",
  "get_catalog_season",
  "search_platform",
  "web_search",
  "web_fetch",
]);

/** Runs one query tool; failures come back as `{ error }` for the model, never thrown. */
export async function runQueryTool(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const str = (key: string) => (typeof args[key] === "string" ? args[key].trim() : "");
  try {
    switch (name) {
      case "search_catalog":
        return await searchCatalog(ctx, str("source"), str("query"), args);
      case "get_catalog_entry":
        return await getCatalogEntry(ctx, str("source"), str("id"));
      case "resolve_link": {
        const resolved = await resolveLink(ctx, str("url"));
        return resolved ?? { error: "UNSUPPORTED_LINK" };
      }
      case "get_collection":
        return await getCollection(ctx, str("namespace") as Namespace, str("id"));
      case "get_catalog_season":
        return await getCatalogSeason(ctx, args.season, args.fromEpisode);
      case "search_platform":
        return await searchPlatform(ctx, str("platform") as Namespace, str("keyword"));
      case "web_search":
      case "web_fetch":
        if (!ctx.outbound.callWebTool) {
          return { error: "UNKNOWN_TOOL" };
        }
        return { text: await ctx.outbound.callWebTool(name, args) };
      default:
        return { error: "UNKNOWN_TOOL" };
    }
  } catch (error) {
    return {
      error: error instanceof AdapterTransientError ? "UPSTREAM_UNAVAILABLE" : "TOOL_FAILED",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function searchCatalog(
  ctx: ToolContext,
  source: string,
  query: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (!query) {
    return { error: "EMPTY_QUERY" };
  }
  const type = args.type === "movie" || args.type === "tv" ? (args.type as MediaType) : undefined;
  const year = typeof args.year === "number" ? args.year : undefined;
  switch (source) {
    case "tmdb":
      return {
        results: await ctx.tmdb.search(query, {
          ...(type ? { type } : {}),
          ...(year !== undefined ? { year } : {}),
        }),
      };
    case "trakt":
      return { results: await ctx.tmdb.searchTrakt(query, type ? { type } : {}) };
    case "douban":
      return { results: await searchDouban(ctx.outbound, query) };
    case "360kan":
      return { results: await search360kan(ctx.outbound, query) };
    default:
      return { error: "UNKNOWN_SOURCE" };
  }
}

async function getCatalogEntry(ctx: ToolContext, source: string, id: string): Promise<unknown> {
  if (source === "tmdb") {
    const match = id.match(/^(movie|tv):(\d+)$/);
    if (!match) {
      return { error: "BAD_ID", message: 'Use "tv:123" or "movie:123".' };
    }
    const entry = await ctx.tmdb.fetchMediaSnapshotAndExternalIds(match[1] as MediaType, match[2]!);
    return entry ?? { error: "NOT_FOUND" };
  }
  if (source === "trakt") {
    return (await ctx.tmdb.lookupTrakt(id)) ?? { error: "NOT_FOUND" };
  }
  if (source === "douban") {
    if (!/^\d+$/.test(id)) {
      return { error: "BAD_ID" };
    }
    const response = await fetchDoubanFrodo(ctx.outbound, `/subject/${id}`, { kind: "platform" });
    if (response.status === 404) {
      return { error: "NOT_FOUND" };
    }
    if (response.status !== 200) {
      return { error: "UPSTREAM_UNAVAILABLE", message: `Douban HTTP ${response.status}` };
    }
    const d = JSON.parse(response.body) as Record<string, unknown>;
    return {
      id,
      type: d.type ?? d.subtype ?? null,
      title: d.title ?? null,
      originalTitle: d.original_title ?? null,
      year: d.year ?? null,
      episodesCount: d.episodes_count ?? null,
      cardSubtitle: d.card_subtitle ?? null,
      platformLinks: (Array.isArray(d.vendors) ? d.vendors : []).flatMap((v: unknown) => {
        const vendor = v as Record<string, unknown> | null;
        return vendor?.url || vendor?.uri
          ? [{ platform: vendor.id ?? vendor.title, url: vendor.url ?? vendor.uri }]
          : [];
      }),
    };
  }
  return { error: "UNKNOWN_SOURCE" };
}

async function getCatalogSeason(
  ctx: ToolContext,
  season: unknown,
  fromEpisode: unknown,
): Promise<unknown> {
  const known = ctx.seasons.find((s) => s.season === season);
  if (!known) {
    return { error: "UNKNOWN_SEASON" };
  }
  if (!ctx.tmdbTvId) {
    return known;
  }
  // The episode list is extra context: without it the count and year still answer.
  const all = await ctx.tmdb.fetchSeasonEpisodes(ctx.tmdbTvId, known.season).catch(() => null);
  if (!all) {
    return known;
  }
  const from = typeof fromEpisode === "number" ? fromEpisode : 1;
  const listed = all.filter((e) => e.episode >= from);
  const episodes = listed.slice(0, MAX_EPISODES_IN_TOOL_RESULT);
  const next = listed[MAX_EPISODES_IN_TOOL_RESULT];
  return {
    ...known,
    episodes,
    ...(next ? { episodesTruncated: { total: all.length, nextFromEpisode: next.episode } } : {}),
  };
}

async function resolveLink(
  ctx: ToolContext,
  url: string,
): Promise<{ namespace: Namespace; canonicalId: string } | null> {
  for (const namespace of ctx.collectionNamespaces) {
    const adapter = ctx.registry.get(namespace);
    if (adapter && adapter.parseInput(url) !== null) {
      return { namespace, canonicalId: await adapter.canonicalize(url, ctx.outbound) };
    }
  }
  return null;
}

async function getCollection(ctx: ToolContext, namespace: Namespace, id: string): Promise<unknown> {
  const adapter = ctx.collectionNamespaces.includes(namespace)
    ? ctx.registry.get(namespace)
    : undefined;
  if (!adapter || !isTier2Adapter(adapter)) {
    return { error: "UNKNOWN_NAMESPACE" };
  }
  let evidence;
  try {
    const canonicalId = await adapter.canonicalize(id, ctx.outbound);
    evidence = await adapter.fetchCollection(canonicalId, ctx.outbound);
  } catch (error) {
    if (error instanceof AdapterTransientError) {
      ctx.noteTransient(namespace, error.reason);
    }
    throw error;
  }
  if (evidence.status === "not_found") {
    return { error: "NOT_FOUND", reason: evidence.reason ?? null };
  }
  if (evidence.status === "transient_error") {
    ctx.noteTransient(namespace, evidence.reason);
    return { error: "UPSTREAM_UNAVAILABLE", message: evidence.reason };
  }
  const { info } = evidence;
  const passes = ctx.register(info, "agent_fetch");
  return {
    namespace,
    canonicalId: info.canonicalId,
    title: info.title,
    originalTitle: info.originalTitle ?? null,
    year: info.year,
    mediaType: info.mediaType,
    featureEpisodeCount: info.featureEpisodes.length,
    passesAutomaticCheckWithDefaultMapping: passes,
    episodes: info.featureEpisodes.slice(0, MAX_EPISODES_IN_TOOL_RESULT).map((ep) => ({
      index: ep.index,
      title: ep.title ?? null,
      longTitle: ep.longTitle ?? null,
      airDate: ep.airDate ?? null,
      durationSeconds: ep.durationSeconds ?? null,
    })),
  };
}

async function searchPlatform(
  ctx: ToolContext,
  platform: Namespace,
  keyword: string,
): Promise<unknown> {
  const adapter = ctx.registry.get(platform);
  if (!adapter || !isTier3Adapter(adapter)) {
    return { error: "SEARCH_UNAVAILABLE" };
  }
  let result;
  try {
    result = await adapter.search({ title: keyword }, ctx.outbound);
  } catch (error) {
    if (error instanceof AdapterTransientError) {
      ctx.noteTransient(platform, error.reason);
    }
    throw error;
  }
  if (result.status !== "ok") {
    // A failed search may have hidden the match: the platform's "not found" is then inconclusive.
    ctx.noteTransient(platform, result.reason);
    return { error: "UPSTREAM_UNAVAILABLE", message: result.reason };
  }
  return { results: result.candidates };
}

/** frodo's mini program search; Douban rate-limits it per IP, so failures are expected. */
async function searchDouban(outbound: OutboundClient, query: string): Promise<unknown[]> {
  const response = await fetchDoubanFrodo(
    outbound,
    `/search/weixin?q=${encodeURIComponent(query)}&start=0&count=10`,
    { kind: "platform" },
  );
  if (response.status !== 200) {
    throw new Error(`Douban search HTTP ${response.status}; try web_search instead`);
  }
  const items = (JSON.parse(response.body) as { items?: unknown[] }).items;
  return (Array.isArray(items) ? items : []).flatMap((raw) => {
    const item = raw as Record<string, unknown> | null;
    const target = item?.target as Record<string, unknown> | undefined;
    return target?.id
      ? [
          {
            id: String(target.id),
            type: item?.target_type ?? null,
            title: target.title ?? null,
            year: target.year ?? null,
            cardSubtitle: target.card_subtitle ?? null,
          },
        ]
      : [];
  });
}

async function search360kan(outbound: OutboundClient, query: string): Promise<unknown[]> {
  const response = await outbound.fetchExternal({
    kind: "platform",
    namespace: "360kan",
    url: `${KAN360_INDEX_API}?force_v=1&kw=${encodeURIComponent(query)}&pageno=1&v_ap=1&tab=all`,
  });
  if (response.status !== 200) {
    throw new Error(`360kan HTTP ${response.status}`);
  }
  const root = JSON.parse(response.body) as {
    code?: number;
    data?: { longData?: { rows?: unknown[] } };
  };
  if (root.code !== 0) {
    throw new Error(`360kan code ${String(root.code)}`);
  }
  return (root.data?.longData?.rows ?? []).slice(0, 10).flatMap((raw) => {
    const row = raw as Record<string, unknown> | null;
    return row
      ? [
          {
            title: row.titleTxt ?? null,
            year: row.year ?? null,
            category: row.cat_name ?? null,
            platformLinks: row.playlinks ?? {},
          },
        ]
      : [];
  });
}
