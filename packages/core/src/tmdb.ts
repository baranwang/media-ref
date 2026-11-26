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

export interface TmdbFetchMediaOptions {
  throwOnNotFound?: boolean;
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

export interface TmdbGateway {
  fetchMediaSnapshotAndExternalIds(
    tmdbType: MediaType,
    tmdbId: string,
    options?: TmdbFetchMediaOptions,
  ): Promise<TmdbMediaFetchResult | null>;
  fetchChanges(mediaType: MediaType, options: TmdbChangesOptions): Promise<TmdbChangesResult>;
  /** TMDB entries whose IMDb ID is `imdbId` (`/find`); empty when there are none. */
  findByImdbId(imdbId: string): Promise<Array<{ type: MediaType; id: string }>>;
  /** Episode numbers and air dates (YYYY-MM-DD) of one TV season; empty when unknown. */
  fetchSeasonEpisodes(
    tvId: string,
    season: number,
  ): Promise<Array<{ episode: number; airDate: string | null }>>;
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
  const tvdb = parsePositiveIdString(record.tvdb_id);

  let trakt: string | null = null;
  const rawTraktId = parsePositiveIdString(record.trakt_id);
  if (rawTraktId) {
    trakt = `${tmdbType === "movie" ? "movie" : "show"}:${rawTraktId}`;
  } else {
    const rawTraktString = nonEmptyString(record.trakt_id);
    if (rawTraktString) {
      trakt = rawTraktString;
    }
  }

  return { imdb, tvdb, trakt };
}

async function lookupTraktId(
  outbound: OutboundClient,
  config: TmdbGatewayConfig,
  tmdbType: MediaType,
  tmdbId: string,
): Promise<string | null> {
  const traktType = tmdbType === "movie" ? "movie" : "show";
  const baseUrl = trimTrailingSlash(config.traktApiBaseUrl ?? DEFAULT_TRAKT_API_BASE_URL);
  const url = `${baseUrl}/search/tmdb/${encodeURIComponent(tmdbId)}?type=${traktType}`;
  const headers: Record<string, string> = {
    accept: "application/json",
    "trakt-api-version": "2",
    // Trakt's edge returns 403 to requests without a User-Agent
    "user-agent": "media-ref",
  };
  if (config.traktClientId) {
    headers["trakt-api-key"] = config.traktClientId;
  }

  try {
    const response = await outbound.fetchExternal({
      kind: "catalog",
      namespace: "trakt",
      url,
      method: "GET",
      headers,
      timeoutMs: config.timeoutMs,
    });
    if (response.status < 200 || response.status >= 300) {
      return null;
    }
    const parsed: unknown = JSON.parse(response.body);
    if (!Array.isArray(parsed)) {
      return null;
    }
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
      if (traktId) {
        return `${traktType}:${traktId}`;
      }
    }
    return null;
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

  return {
    async fetchSeasonEpisodes(tvId, season) {
      const fetched = await fetchTmdbJson(
        buildTmdbUrl(`/tv/${encodeURIComponent(tvId)}/season/${season}`, { language }),
        `tv:${tvId}:season:${season}`,
      );
      if (!fetched.ok) {
        return [];
      }
      const rows = fetched.data.episodes;
      const episodes: Array<{ episode: number; airDate: string | null }> = [];
      for (const row of Array.isArray(rows) ? rows : []) {
        const rec = (row ?? {}) as Record<string, unknown>;
        if (typeof rec.episode_number === "number" && Number.isInteger(rec.episode_number)) {
          const airDate = nonEmptyString(rec.air_date);
          episodes.push({
            episode: rec.episode_number,
            airDate: airDate && /^\d{4}-\d{2}-\d{2}$/.test(airDate) ? airDate : null,
          });
        }
      }
      return episodes.toSorted((a, b) => a.episode - b.episode);
    },

    async findByImdbId(imdbId) {
      const fetched = await fetchTmdbJson(
        buildTmdbUrl(`/find/${encodeURIComponent(imdbId)}`, { external_source: "imdb_id" }),
        `find:${imdbId}`,
      );
      if (!fetched.ok) {
        return [];
      }
      const found: Array<{ type: MediaType; id: string }> = [];
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
    },

    async fetchMediaSnapshotAndExternalIds(tmdbType, tmdbId, options) {
      const detailsUrl = buildTmdbUrl(`/${tmdbType}/${encodeURIComponent(tmdbId)}`, {
        append_to_response: "external_ids",
        language,
      });

      const fetched = await fetchTmdbJson(detailsUrl, `${tmdbType}:${tmdbId}`);
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
          });
          if (extResponse.status >= 200 && extResponse.status < 300) {
            externalBlock = JSON.parse(extResponse.body);
          }
        } catch {
          externalBlock = undefined;
        }
      }

      const extracted = extractExternalIdsBlock(externalBlock, tmdbType);
      const shouldSyncTrakt =
        extracted.trakt === null &&
        config.syncTrakt !== false &&
        (config.syncTrakt === true || Boolean(config.traktClientId));

      const trakt = shouldSyncTrakt
        ? await lookupTraktId(outbound, config, tmdbType, tmdbId)
        : extracted.trakt;

      return {
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
