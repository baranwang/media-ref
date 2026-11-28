import type { MediaSnapshot, MediaType, SeasonSnapshot } from "@media-ref/client";
import type { OutboundClient } from "./outbound.ts";

export const DEFAULT_TMDB_API_BASE_URL = "https://api.themoviedb.org/3";
export const DEFAULT_TRAKT_API_BASE_URL = "https://api.trakt.tv";
export const DEFAULT_TMDB_LANGUAGE = "zh-CN";

export interface TmdbGatewayConfig {
  apiBaseUrl?: string;
  accessToken?: string;
  apiKey?: string;
  language?: string;
  traktApiBaseUrl?: string;
  traktClientId?: string;
  syncTrakt?: boolean;
  timeoutMs?: number;
}

export interface TmdbExternalIdsSync {
  tmdb: string;
  imdb: string | null;
  tvdb: string | null;
  trakt: string | null;
}

export interface TmdbMediaFetchResult {
  type: MediaType;
  snapshot: MediaSnapshot;
  externalIds: TmdbExternalIdsSync;
}

export interface TmdbIdentityDetails extends TmdbMediaFetchResult {
  aliases: string[];
  directorsAndCreators: string[];
  productionCompanies: string[];
  cast: string[];
}

export interface TmdbFetchMediaOptions {
  throwOnNotFound?: boolean;
  signal?: AbortSignal;
}

export interface TmdbChangesOptions {
  startDate: string;
  endDate: string;
  page?: number;
}

export interface TmdbChangesResult {
  mediaType: MediaType;
  startDate: string;
  endDate: string;
  changedIds: string[];
  totalPages: number;
  totalResults: number;
  pagesFetched: number;
}

/** One search or lookup hit from TMDB or Trakt; ids are our native ID formats. */
export interface CatalogSearchHit {
  /** TMDB `tv:123` / `movie:123`, or Trakt `show:123` / `movie:123`. */
  nativeId: string;
  type: MediaType;
  title: string;
  originalTitle: string | null;
  year: number | null;
  /** Cross-catalog IDs the hit itself carries (Trakt returns TMDB and IMDb IDs). */
  externalIds?: { tmdb?: string; imdb?: string };
}

export interface TmdbGateway {
  fetchMediaSnapshotAndExternalIds(
    tmdbType: MediaType,
    tmdbId: string,
    options?: TmdbFetchMediaOptions,
  ): Promise<TmdbMediaFetchResult | null>;
  fetchChanges(mediaType: MediaType, options: TmdbChangesOptions): Promise<TmdbChangesResult>;
  /** Movie/TV matches; the optional count includes other /find result types too. */
  findByImdbId(
    imdbId: string,
    reportCount?: (count: number) => void,
    signal?: AbortSignal,
  ): Promise<ParsedTmdbNativeId[]>;
  findByTvdbId?(
    tvdbId: string,
    reportCount?: (count: number) => void,
    signal?: AbortSignal,
  ): Promise<ParsedTmdbNativeId[]>;
  /** Rich identity metadata (translations, alternative titles, credits) for matching without an IMDb ID. */
  fetchIdentityDetails?(
    tmdbType: MediaType,
    tmdbId: string,
    signal?: AbortSignal,
  ): Promise<TmdbIdentityDetails | null>;
  /** TMDB title search (`/search/{tv,movie,multi}`), at most 10 hits. */
  search(
    query: string,
    options?: { type?: MediaType; year?: number; onTruncated?: () => void; signal?: AbortSignal },
  ): Promise<CatalogSearchHit[]>;
  /** Trakt title search, at most 10 hits. */
  searchTrakt(query: string, options?: { type?: MediaType }): Promise<CatalogSearchHit[]>;
  /** One Trakt entry by native ID (`show:123` / `movie:123`); null when Trakt does not have it. */
  lookupTrakt(nativeId: string): Promise<CatalogSearchHit | null>;
  /** A TV season's episodes (`/tv/{id}/season/{n}`, season 0 = specials); null when TMDB has no such season. */
  fetchSeasonEpisodes(
    tmdbId: string,
    season: number,
    signal?: AbortSignal,
  ): Promise<Array<{ episode: number; title: string | null; airDate: string | null }> | null>;
  /** IMDb ID of one TV episode (`/tv/{id}/season/{n}/episode/{e}/external_ids`), or null. */
  fetchEpisodeImdbId(
    tmdbId: string,
    season: number,
    episode: number,
    signal?: AbortSignal,
  ): Promise<string | null>;
}

export type TmdbGatewayErrorCode =
  | "TMDB_NOT_FOUND"
  | "TMDB_UPSTREAM_ERROR"
  | "TMDB_INVALID_RESPONSE";

export class TmdbGatewayError extends Error {
  readonly code: TmdbGatewayErrorCode;
  readonly status: number;

  constructor(code: TmdbGatewayErrorCode, message: string, status = 502) {
    super(message);
    this.name = "TmdbGatewayError";
    this.code = code;
    this.status = status;
  }
}

export interface ParsedTmdbNativeId {
  type: MediaType;
  id: string;
}

const TMDB_NATIVE_ID_PATTERN = /^(movie|tv):([1-9]\d*)$/;

export function parseTmdbNativeId(nativeId: string): ParsedTmdbNativeId | null {
  const match = nativeId.match(TMDB_NATIVE_ID_PATTERN);
  if (!match) {
    return null;
  }
  return {
    type: match[1] as MediaType,
    id: match[2],
  };
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function parseYear(dateString: unknown): number | null {
  if (typeof dateString !== "string") {
    return null;
  }
  const match = dateString.trim().match(/^(\d{4})/);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  return Number.isInteger(year) && year >= 1800 && year <= 3000 ? year : null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parsePositiveIdString(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^[1-9]\d*$/.test(trimmed)) {
      return trimmed;
    }
  }
  return null;
}

function parseSeasons(rawSeasons: unknown): SeasonSnapshot[] {
  if (!Array.isArray(rawSeasons)) {
    return [];
  }

  const seasons: SeasonSnapshot[] = [];
  for (const entry of rawSeasons) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const seasonNumber = record.season_number;
    if (typeof seasonNumber !== "number" || !Number.isInteger(seasonNumber) || seasonNumber < 0) {
      continue;
    }
    const rawEpisodeCount = record.episode_count;
    const episodeCount =
      typeof rawEpisodeCount === "number" &&
      Number.isInteger(rawEpisodeCount) &&
      rawEpisodeCount >= 0
        ? rawEpisodeCount
        : 0;

    seasons.push({
      season: seasonNumber,
      episodeCount,
      airYear: parseYear(record.air_date),
    });
  }

  seasons.sort((a, b) => a.season - b.season);
  return seasons;
}

function extractExternalIdsBlock(
  raw: unknown,
  tmdbType: MediaType,
): { imdb: string | null; tvdb: string | null; trakt: string | null } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { imdb: null, tvdb: null, trakt: null };
  }
  const record = raw as Record<string, unknown>;
  const imdb = nonEmptyString(record.imdb_id);
  // TVDB numbers movies and series separately; a bare id means a series (see catalog-gateway).
  const rawTvdb = parsePositiveIdString(record.tvdb_id);
  const tvdb = rawTvdb && tmdbType === "movie" ? `movie:${rawTvdb}` : rawTvdb;

  let trakt: string | null = null;
  const rawTraktId = parsePositiveIdString(record.trakt_id);
  if (rawTraktId) {
    trakt = `${tmdbType === "movie" ? "movie" : "show"}:${rawTraktId}`;
  } else {
    const rawTraktString = nonEmptyString(record.trakt_id);
    if (rawTraktString && !/^\d+$/.test(rawTraktString)) {
      trakt = rawTraktString;
    }
  }

  return { imdb, tvdb, trakt };
}

function extractTmdbAliases(
  data: Record<string, unknown>,
  primaryTitle: string,
  originalTitle: string | null,
): string[] {
  const seen = new Set<string>([primaryTitle]);
  if (originalTitle) {
    seen.add(originalTitle);
  }
  const aliases: string[] = [];
  const push = (val: unknown) => {
    const str = nonEmptyString(val);
    if (!str || seen.has(str)) {
      return;
    }
    seen.add(str);
    aliases.push(str);
  };

  const alt = data.alternative_titles as Record<string, unknown> | undefined;
  const altRows = Array.isArray(alt?.titles)
    ? alt.titles
    : Array.isArray(alt?.results)
      ? alt.results
      : [];
  for (const row of altRows) {
    if (row && typeof row === "object") {
      push((row as Record<string, unknown>).title);
    }
  }

  const trans = data.translations as Record<string, unknown> | undefined;
  const transRows = Array.isArray(trans?.translations) ? trans.translations : [];
  for (const row of transRows) {
    const entry = row && typeof row === "object" ? (row as Record<string, unknown>) : null;
    const tData = entry?.data as Record<string, unknown> | undefined;
    if (tData) {
      push(tData.title);
      push(tData.name);
    }
  }

  return aliases;
}

function extractTmdbCredits(data: Record<string, unknown>): {
  directorsAndCreators: string[];
  productionCompanies: string[];
  cast: string[];
} {
  const directors: string[] = [];
  const cast: string[] = [];
  const companies: string[] = [];
  const pushUnique = (list: string[], val: unknown) => {
    const s = nonEmptyString(val);
    if (s && !list.includes(s)) {
      list.push(s);
    }
  };

  const credits = data.credits as Record<string, unknown> | undefined;
  if (Array.isArray(credits?.crew)) {
    for (const member of credits.crew) {
      const m = member && typeof member === "object" ? (member as Record<string, unknown>) : null;
      if (m && m.job === "Director") {
        pushUnique(directors, m.name);
      }
    }
  }
  if (Array.isArray(data.created_by)) {
    for (const creator of data.created_by) {
      const c =
        creator && typeof creator === "object" ? (creator as Record<string, unknown>) : null;
      if (c) {
        pushUnique(directors, c.name);
      }
    }
  }
  if (Array.isArray(credits?.cast)) {
    for (const actor of credits.cast.slice(0, 15)) {
      const a = actor && typeof actor === "object" ? (actor as Record<string, unknown>) : null;
      if (a) {
        pushUnique(cast, a.name);
      }
    }
  }
  if (Array.isArray(data.production_companies)) {
    for (const company of data.production_companies) {
      const p =
        company && typeof company === "object" ? (company as Record<string, unknown>) : null;
      if (p) {
        pushUnique(companies, p.name);
      }
    }
  }

  return { directorsAndCreators: directors, productionCompanies: companies, cast };
}

export function isTraktSyncEnabled(config?: TmdbGatewayConfig): boolean {
  return (
    config?.syncTrakt !== false &&
    (config?.syncTrakt === true || nonEmptyString(config?.traktClientId) !== null)
  );
}

function traktHeaders(config: TmdbGatewayConfig): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "trakt-api-version": "2",
    // Trakt's edge returns 403 to requests without a User-Agent
    "user-agent": "media-ref",
  };
  const traktClientId = nonEmptyString(config.traktClientId);
  if (traktClientId) {
    headers["trakt-api-key"] = traktClientId;
  }
  return headers;
}

/** A Trakt API GET: parsed JSON, null on 404, throws on other failures. */
async function fetchTraktJson(
  outbound: OutboundClient,
  config: TmdbGatewayConfig,
  path: string,
): Promise<unknown> {
  const baseUrl = trimTrailingSlash(config.traktApiBaseUrl ?? DEFAULT_TRAKT_API_BASE_URL);
  const response = await outbound.fetchExternal({
    kind: "catalog",
    namespace: "trakt",
    url: `${baseUrl}${path}`,
    method: "GET",
    headers: traktHeaders(config),
    timeoutMs: config.timeoutMs,
  });
  if (response.status === 404) {
    return null;
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Trakt returned HTTP ${response.status} for ${path}`);
  }
  return JSON.parse(response.body);
}

function traktHit(type: "movie" | "show", raw: unknown): CatalogSearchHit | null {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const ids = record?.ids as Record<string, unknown> | undefined;
  const traktId = parsePositiveIdString(ids?.trakt);
  const title = nonEmptyString(record?.title);
  if (!record || !traktId || !title) {
    return null;
  }
  const mediaType: MediaType = type === "movie" ? "movie" : "tv";
  const tmdbId = parsePositiveIdString(ids?.tmdb);
  const imdbId = nonEmptyString(ids?.imdb);
  return {
    nativeId: `${type}:${traktId}`,
    type: mediaType,
    title,
    originalTitle: nonEmptyString(record.original_title),
    year: typeof record.year === "number" ? record.year : null,
    externalIds: {
      ...(tmdbId ? { tmdb: `${mediaType}:${tmdbId}` } : {}),
      ...(imdbId ? { imdb: imdbId } : {}),
    },
  };
}

export async function lookupTraktId(
  outbound: OutboundClient,
  config: TmdbGatewayConfig,
  tmdbType: MediaType,
  tmdbId: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const traktType = tmdbType === "movie" ? "movie" : "show";
  const baseUrl = trimTrailingSlash(config.traktApiBaseUrl ?? DEFAULT_TRAKT_API_BASE_URL);
  const url = `${baseUrl}/search/tmdb/${encodeURIComponent(tmdbId)}?type=${traktType}`;
  const headers = traktHeaders(config);

  try {
    const response = await outbound.fetchExternal({
      kind: "catalog",
      namespace: "trakt",
      url,
      method: "GET",
      headers,
      timeoutMs: config.timeoutMs,
      signal,
    });
    if (response.status < 200 || response.status >= 300) {
      return null;
    }
    const parsed: unknown = JSON.parse(response.body);
    if (!Array.isArray(parsed)) {
      return null;
    }
    let fallbackTraktId: string | null = null;
    for (const item of parsed) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const record = item as Record<string, unknown>;
      const nested = (traktType === "movie" ? record.movie : record.show) as
        | Record<string, unknown>
        | undefined;
      const ids = nested?.ids as Record<string, unknown> | undefined;
      const traktId = parsePositiveIdString(ids?.trakt);
      if (!traktId) {
        continue;
      }
      const returnedTmdbId = parsePositiveIdString(ids?.tmdb);
      if (returnedTmdbId === tmdbId) {
        return `${traktType}:${traktId}`;
      }
      if (returnedTmdbId === null && fallbackTraktId === null) {
        fallbackTraktId = `${traktType}:${traktId}`;
      }
    }
    return fallbackTraktId;
  } catch {
    return null;
  }
}

export function createTmdbGateway(
  outbound: OutboundClient,
  config: TmdbGatewayConfig = {},
): TmdbGateway {
  const apiBaseUrl = trimTrailingSlash(config.apiBaseUrl ?? DEFAULT_TMDB_API_BASE_URL);
  const language = config.language ?? DEFAULT_TMDB_LANGUAGE;

  function buildTmdbHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      accept: "application/json",
    };
    if (config.accessToken) {
      headers.authorization = `Bearer ${config.accessToken}`;
    }
    return headers;
  }

  function buildTmdbUrl(path: string, params: Record<string, string>): string {
    const url = new URL(`${apiBaseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    if (!config.accessToken && config.apiKey) {
      url.searchParams.set("api_key", config.apiKey);
    }
    return url.toString();
  }

  async function fetchTmdbJson(
    url: string,
    label: string,
    signal?: AbortSignal,
  ): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; notFound: true }> {
    let response;
    try {
      response = await outbound.fetchExternal({
        kind: "catalog",
        namespace: "tmdb",
        url,
        method: "GET",
        headers: buildTmdbHeaders(),
        timeoutMs: config.timeoutMs,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw new TmdbGatewayError(
        "TMDB_UPSTREAM_ERROR",
        `TMDB request failed for ${label}: ${error instanceof Error ? error.message : String(error)}`,
        502,
      );
    }

    if (response.status === 404) {
      return { ok: false, notFound: true };
    }

    if (response.status < 200 || response.status >= 300) {
      throw new TmdbGatewayError(
        "TMDB_UPSTREAM_ERROR",
        `TMDB returned HTTP ${response.status} for ${label}`,
        502,
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(response.body);
    } catch {
      throw new TmdbGatewayError(
        "TMDB_INVALID_RESPONSE",
        `TMDB returned invalid JSON for ${label}`,
        502,
      );
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new TmdbGatewayError(
        "TMDB_INVALID_RESPONSE",
        `TMDB returned unexpected payload for ${label}`,
        502,
      );
    }

    return { ok: true, data: payload as Record<string, unknown> };
  }

  const findByExternalId = async (
    externalId: string,
    externalSource: "imdb_id" | "tvdb_id",
    reportCount?: (count: number) => void,
    signal?: AbortSignal,
  ): Promise<ParsedTmdbNativeId[]> => {
    const fetched = await fetchTmdbJson(
      buildTmdbUrl(`/find/${encodeURIComponent(externalId)}`, { external_source: externalSource }),
      `find:${externalSource}:${externalId}`,
      signal,
    );
    if (!fetched.ok) {
      return [];
    }
    reportCount?.(
      Object.entries(fetched.data).reduce(
        (count, [key, rows]) =>
          count + (key.endsWith("_results") && Array.isArray(rows) ? rows.length : 0),
        0,
      ),
    );
    const found: ParsedTmdbNativeId[] = [];
    for (const [key, type] of [
      ["movie_results", "movie"],
      ["tv_results", "tv"],
    ] as const) {
      const rows = fetched.data[key];
      for (const row of Array.isArray(rows) ? rows : []) {
        const id = parsePositiveIdString((row as Record<string, unknown> | null)?.id);
        if (id) {
          found.push({ type, id });
        }
      }
    }
    return found;
  };

  const fetchMediaWithAppend = async (
    tmdbType: MediaType,
    tmdbId: string,
    appendToResponse: string,
    options?: TmdbFetchMediaOptions,
  ): Promise<{ base: TmdbMediaFetchResult; data: Record<string, unknown> } | null> => {
    const detailsUrl = buildTmdbUrl(`/${tmdbType}/${encodeURIComponent(tmdbId)}`, {
      append_to_response: appendToResponse,
      language,
    });

    const fetched = await fetchTmdbJson(detailsUrl, `${tmdbType}:${tmdbId}`, options?.signal);
    if (!fetched.ok) {
      if (options?.throwOnNotFound) {
        throw new TmdbGatewayError(
          "TMDB_NOT_FOUND",
          `TMDB media not found for ${tmdbType}:${tmdbId}`,
          404,
        );
      }
      return null;
    }

    const data = fetched.data;
    const title =
      tmdbType === "movie"
        ? (nonEmptyString(data.title) ?? nonEmptyString(data.original_title))
        : (nonEmptyString(data.name) ?? nonEmptyString(data.original_name));

    if (!title) {
      throw new TmdbGatewayError(
        "TMDB_INVALID_RESPONSE",
        `TMDB response missing title for ${tmdbType}:${tmdbId}`,
        502,
      );
    }

    const originalTitle =
      tmdbType === "movie"
        ? nonEmptyString(data.original_title)
        : nonEmptyString(data.original_name);
    const year =
      tmdbType === "movie" ? parseYear(data.release_date) : parseYear(data.first_air_date);
    const seasons = tmdbType === "tv" ? parseSeasons(data.seasons) : [];

    let externalBlock: unknown = data.external_ids;
    if (externalBlock === undefined) {
      const extUrl = buildTmdbUrl(`/${tmdbType}/${encodeURIComponent(tmdbId)}/external_ids`, {});
      try {
        const extResponse = await outbound.fetchExternal({
          kind: "catalog",
          namespace: "tmdb",
          url: extUrl,
          method: "GET",
          headers: buildTmdbHeaders(),
          timeoutMs: config.timeoutMs,
          signal: options?.signal,
        });
        if (extResponse.status >= 200 && extResponse.status < 300) {
          externalBlock = JSON.parse(extResponse.body);
        }
      } catch {
        externalBlock = undefined;
      }
    }

    const extracted = extractExternalIdsBlock(externalBlock, tmdbType);
    const shouldSyncTrakt = extracted.trakt === null && isTraktSyncEnabled(config);

    const trakt = shouldSyncTrakt
      ? await lookupTraktId(outbound, config, tmdbType, tmdbId, options?.signal)
      : extracted.trakt;

    return {
      base: {
        type: tmdbType,
        snapshot: {
          title,
          originalTitle,
          year,
          type: tmdbType,
          seasons,
        },
        externalIds: {
          tmdb: `${tmdbType}:${tmdbId}`,
          imdb: extracted.imdb,
          tvdb: extracted.tvdb,
          trakt,
        },
      },
      data,
    };
  };

  return {
    async search(query, options = {}) {
      const kind = options.type ?? "multi";
      const params: Record<string, string> = { query, language };
      if (options.year !== undefined) {
        if (kind === "movie") {
          params["year"] = String(options.year);
        } else if (kind === "tv") {
          params["first_air_date_year"] = String(options.year);
        }
      }
      const fetched = await fetchTmdbJson(
        buildTmdbUrl(`/search/${kind}`, params),
        `search:${query}`,
        options.signal,
      );
      const rows = fetched.ok && Array.isArray(fetched.data.results) ? fetched.data.results : [];
      const hits = rows.slice(0, 20).flatMap((raw): CatalogSearchHit[] => {
        const row = raw as Record<string, unknown>;
        const type = (kind === "multi" ? row.media_type : kind) as string;
        const id = parsePositiveIdString(row.id);
        if ((type !== "movie" && type !== "tv") || !id) {
          return [];
        }
        const title =
          nonEmptyString(type === "movie" ? row.title : row.name) ??
          nonEmptyString(type === "movie" ? row.original_title : row.original_name);
        return title
          ? [
              {
                nativeId: `${type}:${id}`,
                type,
                title,
                originalTitle: nonEmptyString(
                  type === "movie" ? row.original_title : row.original_name,
                ),
                year: parseYear(type === "movie" ? row.release_date : row.first_air_date),
              },
            ]
          : [];
      });
      if (
        hits.length > 10 ||
        rows.length > 20 ||
        (fetched.ok &&
          (Number(fetched.data.total_pages) > 1 ||
            Number(fetched.data.total_results) > rows.length))
      ) {
        options.onTruncated?.();
      }
      return hits.slice(0, 10);
    },

    async searchTrakt(query, options = {}) {
      const types = options.type ? (options.type === "movie" ? "movie" : "show") : "movie,show";
      const parsed = await fetchTraktJson(
        outbound,
        config,
        `/search/${types}?query=${encodeURIComponent(query)}&limit=10`,
      );
      return (Array.isArray(parsed) ? parsed : []).flatMap((raw): CatalogSearchHit[] => {
        const row = raw as Record<string, unknown>;
        const type = row.type === "movie" ? "movie" : row.type === "show" ? "show" : null;
        const hit = type ? traktHit(type, row[type]) : null;
        return hit ? [hit] : [];
      });
    },

    async lookupTrakt(nativeId) {
      const match = nativeId.match(/^(movie|show):(\d+)$/);
      if (!match) {
        return null;
      }
      const type = match[1] as "movie" | "show";
      const parsed = await fetchTraktJson(outbound, config, `/${type}s/${match[2]}?extended=full`);
      return traktHit(type, parsed);
    },

    async fetchSeasonEpisodes(tmdbId, season, signal) {
      const fetched = await fetchTmdbJson(
        buildTmdbUrl(`/tv/${encodeURIComponent(tmdbId)}/season/${season}`, { language }),
        `tv:${tmdbId}:season:${season}`,
        signal,
      );
      if (!fetched.ok) {
        return null;
      }
      const rows = Array.isArray(fetched.data.episodes) ? fetched.data.episodes : [];
      return rows.flatMap((raw) => {
        const row = raw as Record<string, unknown> | null;
        return typeof row?.episode_number === "number"
          ? [
              {
                episode: row.episode_number,
                title: nonEmptyString(row.name),
                airDate: nonEmptyString(row.air_date),
              },
            ]
          : [];
      });
    },

    async fetchEpisodeImdbId(tmdbId, season, episode, signal) {
      const fetched = await fetchTmdbJson(
        buildTmdbUrl(
          `/tv/${encodeURIComponent(tmdbId)}/season/${season}/episode/${episode}/external_ids`,
          {},
        ),
        `tv:${tmdbId}:season:${season}:episode:${episode}`,
        signal,
      );
      const imdbId = fetched.ok ? nonEmptyString(fetched.data.imdb_id) : null;
      return imdbId && /^tt\d+$/.test(imdbId) ? imdbId : null;
    },

    findByImdbId(imdbId, reportCount, signal) {
      return findByExternalId(imdbId, "imdb_id", reportCount, signal);
    },

    findByTvdbId(tvdbId, reportCount, signal) {
      return findByExternalId(tvdbId, "tvdb_id", reportCount, signal);
    },

    async fetchMediaSnapshotAndExternalIds(tmdbType, tmdbId, options) {
      const fetched = await fetchMediaWithAppend(tmdbType, tmdbId, "external_ids", options);
      return fetched ? fetched.base : null;
    },

    async fetchIdentityDetails(tmdbType, tmdbId, signal) {
      const fetched = await fetchMediaWithAppend(
        tmdbType,
        tmdbId,
        "external_ids,alternative_titles,translations,credits",
        { signal },
      );
      if (!fetched) {
        return null;
      }
      return {
        ...fetched.base,
        aliases: extractTmdbAliases(
          fetched.data,
          fetched.base.snapshot.title,
          fetched.base.snapshot.originalTitle,
        ),
        ...extractTmdbCredits(fetched.data),
      };
    },

    async fetchChanges(mediaType, options) {
      const startPage = options.page ?? 1;
      if (!Number.isInteger(startPage) || startPage < 1) {
        throw new TmdbGatewayError(
          "TMDB_INVALID_RESPONSE",
          `Invalid TMDB changes page: ${String(options.page)}`,
          400,
        );
      }

      const seenIds = new Set<string>();
      let currentPage = startPage;
      let totalPages = startPage;
      let totalResults = 0;
      let pagesFetched = 0;
      const maxPages = 1000;

      while (currentPage <= totalPages && pagesFetched < maxPages) {
        const changesUrl = buildTmdbUrl(`/${mediaType}/changes`, {
          start_date: options.startDate,
          end_date: options.endDate,
          page: String(currentPage),
        });

        const fetched = await fetchTmdbJson(
          changesUrl,
          `${mediaType}/changes (${options.startDate}..${options.endDate} page ${currentPage})`,
        );

        if (!fetched.ok) {
          throw new TmdbGatewayError(
            "TMDB_NOT_FOUND",
            `TMDB changes endpoint returned 404 for ${mediaType} (${options.startDate}..${options.endDate})`,
            404,
          );
        }

        const data = fetched.data;
        if (!Array.isArray(data.results)) {
          throw new TmdbGatewayError(
            "TMDB_INVALID_RESPONSE",
            `TMDB changes response missing results array for ${mediaType}`,
            502,
          );
        }

        for (const item of data.results) {
          if (!item || typeof item !== "object") {
            continue;
          }
          const parsedId = parsePositiveIdString((item as Record<string, unknown>).id);
          if (parsedId) {
            seenIds.add(parsedId);
          }
        }

        const rawTotalPages = data.total_pages;
        if (
          typeof rawTotalPages === "number" &&
          Number.isInteger(rawTotalPages) &&
          rawTotalPages >= 0
        ) {
          totalPages = rawTotalPages;
        } else if (pagesFetched === 0) {
          totalPages = currentPage;
        }

        const rawTotalResults = data.total_results;
        if (
          typeof rawTotalResults === "number" &&
          Number.isInteger(rawTotalResults) &&
          rawTotalResults >= 0
        ) {
          totalResults = rawTotalResults;
        }

        pagesFetched += 1;
        if (currentPage >= totalPages) {
          break;
        }
        currentPage += 1;
      }

      return {
        mediaType,
        startDate: options.startDate,
        endDate: options.endDate,
        changedIds: Array.from(seenIds),
        totalPages,
        totalResults,
        pagesFetched,
      };
    },
  };
}
