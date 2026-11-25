import type { MediaType } from "@media-ref/client";
import { DEFAULT_BANGUMI_API_BASE_URL } from "./adapters/bangumi.ts";
import type { AdapterRegistry } from "./adapters/types.ts";
import {
  parseCatalogTargetKey,
  resolveCatalogTargetSnapshot,
  type CatalogGatewayConfig,
} from "./catalog-gateway.ts";
import type { ExternalHttpResponse, OutboundClient } from "./outbound.ts";
import { DEFAULT_TMDB_API_BASE_URL, DEFAULT_TRAKT_API_BASE_URL } from "./tmdb.ts";

/**
 * Display-oriented catalog reads for the website: trending shelves, a title's artwork/synopsis,
 * and title search. Everything here is presentation metadata fetched live from the catalog
 * sites (cached); none of it is written to the database.
 */

export type BrowseNamespace = "tmdb" | "douban" | "bangumi" | "trakt";
export type BrowseType = "all" | "movie" | "tv" | "anime";

export interface CatalogCard {
  /** Catalog target key usable as a MediaRef / change-request target, e.g. `tmdb:tv:1429`. */
  key: string;
  namespace: BrowseNamespace;
  type: MediaType;
  isAnime: boolean;
  title: string;
  originalTitle: string | null;
  year: number | null;
  posterUrl: string | null;
}

export interface CatalogCredit {
  role: string;
  name: string;
}

export interface CatalogDetail extends CatalogCard {
  backdropUrl: string | null;
  overview: string | null;
  genres: string[];
  regions: string[];
  credits: CatalogCredit[];
  /** `ongoing` / `ended`, when the source says so. */
  status: "ongoing" | "ended" | null;
  yearEnd: number | null;
  seasons: Array<{ season: number; episodeCount: number }>;
}

/** Small key-value cache; the API backs it with the Workers Cache API, tests leave it out. */
export interface BrowseCache {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown, ttlSeconds: number): Promise<void>;
}

export interface CatalogBrowseOptions {
  outbound: OutboundClient;
  config?: CatalogGatewayConfig;
  cache?: BrowseCache;
}

export const TRENDING_CACHE_TTL_SECONDS = 3600;
export const DETAIL_CACHE_TTL_SECONDS = 6 * 3600;
export const TMDB_POSTER_BASE = "https://image.tmdb.org/t/p/w500";
export const TMDB_BACKDROP_BASE = "https://image.tmdb.org/t/p/w1280";
const DOUBAN_REXXAR_BASE = "https://m.douban.com/rexxar/api/v2";
const BANGUMI_ROOT = "https://api.bgm.tv";
const BROWSER_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const MEDIA_REF_UA = "media-ref/0.1 (https://mediaref.org)";
const TMDB_ANIMATION_GENRE_ID = 16;
const MAX_TRENDING_LIMIT = 40;

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function yearOf(value: unknown): number | null {
  const match = typeof value === "string" ? value.match(/^(\d{4})/) : null;
  return match ? Number(match[1]) : typeof value === "number" ? value : null;
}

function https(url: string | null): string | null {
  return url ? url.replace(/^http:\/\//, "https://") : null;
}

const regionNames = new Intl.DisplayNames(["zh-CN"], { type: "region" });

function regionName(code: string): string {
  try {
    return regionNames.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

async function cached<T>(
  cache: BrowseCache | undefined,
  key: string,
  ttlSeconds: number,
  load: () => Promise<T | null>,
): Promise<T | null> {
  const hit = cache ? await cache.get(key).catch(() => null) : null;
  if (hit !== null && hit !== undefined) {
    return hit as T;
  }
  const value = await load();
  if (value !== null && cache) {
    await cache.put(key, value, ttlSeconds).catch(() => undefined);
  }
  return value;
}

async function fetchJson(
  outbound: OutboundClient,
  namespace: string,
  url: string,
  headers: Record<string, string>,
  timeoutMs?: number,
): Promise<unknown> {
  let response: ExternalHttpResponse;
  try {
    response = await outbound.fetchExternal({
      kind: "catalog",
      namespace,
      url,
      method: "GET",
      headers: { accept: "application/json", ...headers },
      timeoutMs,
    });
  } catch {
    return null;
  }
  if (response.status < 200 || response.status >= 300) {
    return null;
  }
  try {
    return JSON.parse(response.body) as unknown;
  } catch {
    return null;
  }
}

// ---------- TMDB ----------

function tmdbRequest(config: CatalogGatewayConfig | undefined, path: string, params: Json = {}) {
  const tmdb = config?.tmdb ?? {};
  const url = new URL(
    `${(tmdb.apiBaseUrl ?? DEFAULT_TMDB_API_BASE_URL).replace(/\/+$/, "")}${path}`,
  );
  url.searchParams.set("language", tmdb.language ?? "zh-CN");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = {};
  if (tmdb.accessToken) {
    headers.authorization = `Bearer ${tmdb.accessToken}`;
  } else if (tmdb.apiKey) {
    url.searchParams.set("api_key", tmdb.apiKey);
  }
  return { url: url.toString(), headers };
}

function tmdbCard(raw: Json, typeHint?: MediaType): CatalogCard | null {
  const mediaType = (str(raw.media_type) ?? typeHint) as MediaType | undefined;
  const id = typeof raw.id === "number" ? raw.id : null;
  if (!id || (mediaType !== "movie" && mediaType !== "tv")) {
    return null;
  }
  const title = str(mediaType === "tv" ? raw.name : raw.title);
  if (!title) {
    return null;
  }
  const genreIds = Array.isArray(raw.genre_ids)
    ? raw.genre_ids
    : Array.isArray(raw.genres)
      ? raw.genres.map((g) => asRecord(g)?.id)
      : [];
  const poster = str(raw.poster_path);
  return {
    key: `tmdb:${mediaType}:${id}`,
    namespace: "tmdb",
    type: mediaType,
    isAnime: genreIds.includes(TMDB_ANIMATION_GENRE_ID),
    title,
    originalTitle: str(mediaType === "tv" ? raw.original_name : raw.original_title),
    year: yearOf(mediaType === "tv" ? raw.first_air_date : raw.release_date),
    posterUrl: poster ? `${TMDB_POSTER_BASE}${poster}` : null,
  };
}

async function tmdbTrending(opts: CatalogBrowseOptions, type: BrowseType): Promise<CatalogCard[]> {
  const path =
    type === "movie"
      ? "/trending/movie/week"
      : type === "all"
        ? "/trending/all/week"
        : "/trending/tv/week";
  const req = tmdbRequest(opts.config, path);
  const data = asRecord(await fetchJson(opts.outbound, "tmdb", req.url, req.headers));
  const results = Array.isArray(data?.results) ? data.results : [];
  return results
    .map((r) =>
      tmdbCard(asRecord(r) ?? {}, type === "movie" ? "movie" : type === "all" ? undefined : "tv"),
    )
    .filter((c): c is CatalogCard => c !== null)
    .filter((c) => (type === "anime" ? c.isAnime : true));
}

async function tmdbDetail(
  opts: CatalogBrowseOptions,
  type: MediaType,
  id: string,
): Promise<CatalogDetail | null> {
  const req = tmdbRequest(opts.config, `/${type}/${id}`, { append_to_response: "credits" });
  const raw = asRecord(await fetchJson(opts.outbound, "tmdb", req.url, req.headers));
  const card = raw ? tmdbCard(raw, type) : null;
  if (!raw || !card) {
    return null;
  }
  const credits: CatalogCredit[] = [];
  if (type === "tv") {
    const creators = (Array.isArray(raw.created_by) ? raw.created_by : [])
      .map((c) => str(asRecord(c)?.name))
      .filter((n): n is string => n !== null);
    if (creators.length > 0) credits.push({ role: "主创", name: creators.slice(0, 2).join(" / ") });
  } else {
    const crew = Array.isArray(asRecord(raw.credits)?.crew)
      ? (asRecord(raw.credits)!.crew as unknown[])
      : [];
    const directors = crew
      .map((c) => asRecord(c))
      .filter((c) => c?.job === "Director")
      .map((c) => str(c!.name))
      .filter((n): n is string => n !== null);
    if (directors.length > 0)
      credits.push({ role: "导演", name: directors.slice(0, 2).join(" / ") });
  }
  const companies = (Array.isArray(raw.production_companies) ? raw.production_companies : [])
    .map((c) => str(asRecord(c)?.name))
    .filter((n): n is string => n !== null);
  if (companies.length > 0) {
    credits.push({
      role: card.isAnime ? "动画制作" : "制作",
      name: companies.slice(0, 2).join(" / "),
    });
  }
  const backdrop = str(raw.backdrop_path);
  const tmdbStatus = str(raw.status);
  const countries = Array.isArray(raw.origin_country)
    ? raw.origin_country
    : (Array.isArray(raw.production_countries) ? raw.production_countries : []).map(
        (c) => asRecord(c)?.iso_3166_1,
      );
  const seasons =
    type === "tv"
      ? (Array.isArray(raw.seasons) ? raw.seasons : [])
          .map((s) => asRecord(s))
          .filter((s) => typeof s?.season_number === "number" && (s.season_number as number) > 0)
          .map((s) => ({
            season: s!.season_number as number,
            episodeCount: typeof s!.episode_count === "number" ? (s!.episode_count as number) : 0,
          }))
      : [];
  return {
    ...card,
    backdropUrl: backdrop ? `${TMDB_BACKDROP_BASE}${backdrop}` : null,
    overview: str(raw.overview),
    genres: (Array.isArray(raw.genres) ? raw.genres : [])
      .map((g) => str(asRecord(g)?.name))
      .filter((n): n is string => n !== null),
    regions: countries.filter((c): c is string => typeof c === "string").map(regionName),
    credits,
    status:
      type === "movie"
        ? null
        : tmdbStatus === "Ended" || tmdbStatus === "Canceled"
          ? "ended"
          : tmdbStatus
            ? "ongoing"
            : null,
    yearEnd: type === "tv" ? yearOf(raw.last_air_date) : null,
    seasons,
  };
}

async function tmdbSearch(opts: CatalogBrowseOptions, query: string): Promise<CatalogCard[]> {
  const req = tmdbRequest(opts.config, "/search/multi", { query, include_adult: "false" });
  const data = asRecord(await fetchJson(opts.outbound, "tmdb", req.url, req.headers));
  return (Array.isArray(data?.results) ? data.results : [])
    .map((r) => tmdbCard(asRecord(r) ?? {}))
    .filter((c): c is CatalogCard => c !== null);
}

// ---------- Douban ----------

const DOUBAN_COLLECTIONS: Record<Exclude<BrowseType, "all">, string> = {
  movie: "movie_hot_gaia",
  tv: "tv_hot",
  anime: "tv_animation",
};

function doubanHeaders(referer: string): Record<string, string> {
  return { referer, "user-agent": BROWSER_UA };
}

async function doubanCollection(
  opts: CatalogBrowseOptions,
  collection: string,
  isAnime: boolean,
): Promise<CatalogCard[]> {
  const url = `${DOUBAN_REXXAR_BASE}/subject_collection/${collection}/items?start=0&count=${MAX_TRENDING_LIMIT}`;
  const data = asRecord(
    await fetchJson(opts.outbound, "douban", url, doubanHeaders("https://m.douban.com/movie/")),
  );
  return (Array.isArray(data?.subject_collection_items) ? data.subject_collection_items : [])
    .map((r) => asRecord(r))
    .filter((r): r is Json => r !== null && /^\d+$/.test(String(r.id)))
    .map((r) => ({
      key: `douban:${String(r.id)}`,
      namespace: "douban" as const,
      type: (r.type === "movie" ? "movie" : "tv") as MediaType,
      isAnime,
      title: str(r.title) ?? String(r.id),
      originalTitle: str(r.original_title),
      year: yearOf(r.year),
      posterUrl: https(str(asRecord(r.cover)?.url) ?? str(asRecord(r.pic)?.large)),
    }));
}

async function doubanTrending(
  opts: CatalogBrowseOptions,
  type: BrowseType,
): Promise<CatalogCard[]> {
  if (type !== "all") {
    return doubanCollection(opts, DOUBAN_COLLECTIONS[type], type === "anime");
  }
  const [movies, shows] = await Promise.all([
    doubanCollection(opts, DOUBAN_COLLECTIONS.movie, false),
    doubanCollection(opts, DOUBAN_COLLECTIONS.tv, false),
  ]);
  return interleave(shows, movies);
}

async function doubanDetail(opts: CatalogBrowseOptions, id: string): Promise<CatalogDetail | null> {
  // `/movie/{id}` redirects to `/tv/{id}` for TV subjects.
  const raw = asRecord(
    await fetchJson(
      opts.outbound,
      "douban",
      `${DOUBAN_REXXAR_BASE}/movie/${encodeURIComponent(id)}`,
      doubanHeaders(`https://m.douban.com/movie/subject/${encodeURIComponent(id)}/`),
    ),
  );
  const title = raw ? str(raw.title) : null;
  if (!raw || !title || raw.code === 404) {
    return null;
  }
  const isTv = raw.is_tv === true;
  const genres = (Array.isArray(raw.genres) ? raw.genres : []).filter(
    (g): g is string => typeof g === "string",
  );
  const names = (list: unknown) =>
    (Array.isArray(list) ? list : [])
      .map((p) => str(asRecord(p)?.name))
      .filter((n): n is string => n !== null)
      .slice(0, 2)
      .join(" / ");
  const credits: CatalogCredit[] = [];
  if (names(raw.directors)) credits.push({ role: "导演", name: names(raw.directors) });
  if (names(raw.actors)) credits.push({ role: "主演", name: names(raw.actors) });
  const episodes = typeof raw.episodes_count === "number" ? raw.episodes_count : 0;
  return {
    key: `douban:${id}`,
    namespace: "douban",
    type: isTv ? "tv" : "movie",
    isAnime: genres.includes("动画"),
    title,
    originalTitle: str(raw.original_title),
    year: yearOf(raw.year),
    posterUrl: https(str(asRecord(raw.pic)?.large)),
    backdropUrl: null,
    overview: str(raw.intro),
    genres,
    regions: (Array.isArray(raw.countries) ? raw.countries : []).filter(
      (c): c is string => typeof c === "string",
    ),
    credits,
    status: null,
    yearEnd: null,
    seasons: isTv && episodes > 0 ? [{ season: 1, episodeCount: episodes }] : [],
  };
}

// ---------- Bangumi ----------

function bangumiImage(images: unknown): string | null {
  const record = asRecord(images);
  return https(str(record?.large) ?? str(record?.common));
}

async function bangumiTrending(
  opts: CatalogBrowseOptions,
  type: BrowseType,
): Promise<CatalogCard[]> {
  if (type === "movie") {
    return [];
  }
  const data = await fetchJson(opts.outbound, "bangumi", `${BANGUMI_ROOT}/calendar`, {
    "user-agent": MEDIA_REF_UA,
  });
  const items = (Array.isArray(data) ? data : [])
    .flatMap((day) => {
      const list = asRecord(day)?.items;
      return Array.isArray(list) ? list : [];
    })
    .map((r) => asRecord(r))
    .filter((r): r is Json => r !== null && typeof r.id === "number");
  items.sort(
    (a, b) =>
      Number(asRecord(b.collection)?.doing ?? 0) - Number(asRecord(a.collection)?.doing ?? 0),
  );
  return items.map((r) => ({
    key: `bangumi:${String(r.id)}`,
    namespace: "bangumi" as const,
    type: "tv" as MediaType,
    isAnime: true,
    title: str(r.name_cn) ?? str(r.name) ?? String(r.id),
    originalTitle: str(r.name),
    year: yearOf(r.air_date),
    posterUrl: bangumiImage(r.images),
  }));
}

async function bangumiDetail(
  opts: CatalogBrowseOptions,
  id: string,
): Promise<CatalogDetail | null> {
  const base = (opts.config?.bangumiApiBaseUrl ?? DEFAULT_BANGUMI_API_BASE_URL).replace(/\/+$/, "");
  const raw = asRecord(
    await fetchJson(opts.outbound, "bangumi", `${base}/subjects/${encodeURIComponent(id)}`, {
      "user-agent": MEDIA_REF_UA,
    }),
  );
  const name = raw ? (str(raw.name_cn) ?? str(raw.name)) : null;
  if (!raw || !name) {
    return null;
  }
  const isMovie = str(raw.platform) === "剧场版";
  const episodes =
    typeof raw.total_episodes === "number"
      ? raw.total_episodes
      : typeof raw.eps === "number"
        ? raw.eps
        : 0;
  return {
    key: `bangumi:${id}`,
    namespace: "bangumi",
    type: isMovie ? "movie" : "tv",
    isAnime: raw.type === 2,
    title: name,
    originalTitle: str(raw.name),
    year: yearOf(raw.date),
    posterUrl: bangumiImage(raw.images),
    backdropUrl: null,
    overview: str(raw.summary),
    genres: (Array.isArray(raw.tags) ? raw.tags : [])
      .map((t) => str(asRecord(t)?.name))
      .filter((n): n is string => n !== null)
      .slice(0, 4),
    regions: [],
    credits: [],
    status: null,
    yearEnd: null,
    seasons: !isMovie && episodes > 0 ? [{ season: 1, episodeCount: episodes }] : [],
  };
}

// ---------- Trakt ----------

async function traktTrending(opts: CatalogBrowseOptions, type: BrowseType): Promise<CatalogCard[]> {
  const clientId = opts.config?.traktClientId ?? opts.config?.tmdb?.traktClientId;
  if (!clientId || type === "anime") {
    return [];
  }
  const base = (
    opts.config?.traktApiBaseUrl ??
    opts.config?.tmdb?.traktApiBaseUrl ??
    DEFAULT_TRAKT_API_BASE_URL
  ).replace(/\/+$/, "");
  const headers = {
    "trakt-api-version": "2",
    "trakt-api-key": clientId,
    // Trakt's edge returns 403 to requests without a User-Agent
    "user-agent": "media-ref",
  };
  const kinds: Array<"show" | "movie"> =
    type === "movie" ? ["movie"] : type === "tv" ? ["show"] : ["show", "movie"];
  const lists = await Promise.all(
    kinds.map(async (kind) => {
      const data = await fetchJson(
        opts.outbound,
        "trakt",
        `${base}/${kind}s/trending?limit=20`,
        headers,
      );
      return (Array.isArray(data) ? data : [])
        .map((entry) => asRecord(asRecord(entry)?.[kind]))
        .filter((item): item is Json => item !== null)
        .map((item) => ({ kind, item }));
    }),
  );
  // Trakt carries no artwork; enrich through the TMDB id (cached per title).
  const entries = kinds.length === 2 ? interleave(lists[0]!, lists[1]!) : lists[0]!;
  const cards = await Promise.all(
    entries.map(async ({ kind, item }): Promise<CatalogCard | null> => {
      const ids = asRecord(item.ids);
      const tmdbId = typeof ids?.tmdb === "number" ? String(ids.tmdb) : null;
      const slug = str(ids?.slug);
      if (!tmdbId || !slug) {
        return null;
      }
      const mediaType: MediaType = kind === "movie" ? "movie" : "tv";
      const detail = await getCatalogDetail(`tmdb:${mediaType}:${tmdbId}`, opts);
      return {
        key: `trakt:${kind}:${slug}`,
        namespace: "trakt" as const,
        type: mediaType,
        isAnime: detail?.isAnime ?? false,
        title: detail?.title ?? str(item.title) ?? slug,
        originalTitle: str(item.title),
        year: typeof item.year === "number" ? item.year : (detail?.year ?? null),
        posterUrl: detail?.posterUrl ?? null,
      };
    }),
  );
  return cards.filter((c): c is CatalogCard => c !== null);
}

// ---------- Public API ----------

function interleave<T>(a: T[], b: T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (i < a.length) out.push(a[i]!);
    if (i < b.length) out.push(b[i]!);
  }
  return out;
}

const TRENDING_LOADERS: Record<
  BrowseNamespace,
  (opts: CatalogBrowseOptions, type: BrowseType) => Promise<CatalogCard[]>
> = {
  tmdb: tmdbTrending,
  douban: doubanTrending,
  bangumi: bangumiTrending,
  trakt: traktTrending,
};

export function isBrowseNamespace(value: string): value is BrowseNamespace {
  return value in TRENDING_LOADERS;
}

/** Trending titles on one catalog site. Failures yield an empty list, never an error. */
export async function listTrending(
  namespace: BrowseNamespace,
  type: BrowseType,
  limit: number,
  opts: CatalogBrowseOptions,
): Promise<CatalogCard[]> {
  const cards =
    (await cached(
      opts.cache,
      `trending:${namespace}:${type}`,
      TRENDING_CACHE_TTL_SECONDS,
      async () => {
        const list = await TRENDING_LOADERS[namespace](opts, type);
        return list.length > 0 ? list : null;
      },
    )) ?? [];
  return cards.slice(0, Math.min(Math.max(limit, 1), MAX_TRENDING_LIMIT));
}

/**
 * Presentation metadata for a catalog key (`tmdb:tv:1429`, `douban:123`, `bangumi:456`, or any
 * key the catalog gateway can resolve to a TMDB id, e.g. `imdb:tt...`, `trakt:show:slug`).
 */
export async function getCatalogDetail(
  key: string,
  opts: CatalogBrowseOptions,
): Promise<CatalogDetail | null> {
  const parsed = parseCatalogTargetKey(key);
  if (!parsed) {
    return null;
  }
  return cached(opts.cache, `detail:${parsed.canonicalKey}`, DETAIL_CACHE_TTL_SECONDS, async () => {
    switch (parsed.namespace) {
      case "tmdb":
        return tmdbDetail(opts, parsed.tmdbType, parsed.tmdbId);
      case "douban":
        return doubanDetail(opts, parsed.nativeId);
      case "bangumi":
        return bangumiDetail(opts, parsed.nativeId);
      default: {
        const resolved = await resolveCatalogTargetSnapshot(
          parsed.canonicalKey,
          opts.outbound,
          opts.config ?? {},
        );
        const tmdbKey = resolved.status === "found" ? resolved.target.externalIds.tmdb : undefined;
        const tmdb = tmdbKey ? parseCatalogTargetKey(`tmdb:${tmdbKey}`) : null;
        return tmdb?.namespace === "tmdb" ? tmdbDetail(opts, tmdb.tmdbType, tmdb.tmdbId) : null;
      }
    }
  });
}

/** Title search on TMDB (the only catalog with an open search API). */
export async function searchCatalogTitles(
  query: string,
  opts: CatalogBrowseOptions,
): Promise<CatalogCard[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return [];
  }
  return (
    (await cached(opts.cache, `search:${trimmed.toLowerCase()}`, TRENDING_CACHE_TTL_SECONDS, () =>
      tmdbSearch(opts, trimmed),
    )) ?? []
  );
}

const CATALOG_URL_PATTERNS: Array<{ pattern: RegExp; toKey: (m: RegExpMatchArray) => string }> = [
  {
    pattern: /themoviedb\.org\/(tv|movie)\/(\d+)/i,
    toKey: (m) => `tmdb:${m[1]!.toLowerCase()}:${m[2]}`,
  },
  { pattern: /imdb\.com\/(?:[a-z-]+\/)?title\/(tt\d+)/i, toKey: (m) => `imdb:${m[1]}` },
  {
    pattern: /trakt\.tv\/(shows|movies)\/([a-z0-9][a-z0-9-]*)/i,
    toKey: (m) => `trakt:${m[1]!.toLowerCase() === "shows" ? "show" : "movie"}:${m[2]}`,
  },
];

/**
 * Turns pasted input into lookup keys: an explicit `namespace:id` key, a catalog URL
 * (TMDB / IMDb / Trakt), or any URL a platform/catalog adapter recognises. Plain text that is
 * not a URL or key yields nothing, so titles never get misread as native ids.
 */
export function resolveLookupKeys(raw: string, registry: AdapterRegistry): string[] {
  const input = raw.trim();
  if (input.length === 0) {
    return [];
  }
  if (/^[a-z]+:[^/\s]/i.test(input) && !/^https?:/i.test(input)) {
    return [input];
  }
  if (!/^https?:\/\//i.test(input) && !/^[a-z0-9-]+(\.[a-z0-9-]+)+\//i.test(input)) {
    return [];
  }
  const keys: string[] = [];
  for (const { pattern, toKey } of CATALOG_URL_PATTERNS) {
    const match = input.match(pattern);
    if (match) {
      keys.push(toKey(match));
    }
  }
  for (const adapter of registry.list()) {
    const parsed = adapter.parseInput(input);
    if (parsed?.canonicalId) {
      keys.push(`${adapter.namespace}:${parsed.canonicalId}`);
    }
  }
  return [...new Set(keys)];
}
