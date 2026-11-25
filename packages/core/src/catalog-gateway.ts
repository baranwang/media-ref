import {
  BASELINE_PRIORITY,
  formatExternalKey,
  parseExternalKey,
  type BaselineSource,
  type CatalogNamespace,
  type ExternalIdNamespace,
  type MediaSnapshot,
  type MediaType,
  type Namespace,
  type SeasonSnapshot,
} from "@media-ref/client";
import { fetchBangumiCollection } from "./adapters/bangumi.ts";
import { fetchDoubanCollection } from "./adapters/douban.ts";
import type { CollectionInfo } from "./adapters/types.ts";
import type { CatalogEvidence } from "./evidence-gate.ts";
import type { ExternalHttpResponse, OutboundClient } from "./outbound.ts";
import {
  createTmdbGateway,
  DEFAULT_TRAKT_API_BASE_URL,
  parseTmdbNativeId,
  type TmdbGateway,
  type TmdbGatewayConfig,
  type TmdbMediaFetchResult,
} from "./tmdb.ts";

export const DEFAULT_TVDB_API_BASE_URL = "https://api4.thetvdb.com/v4";
export const DEFAULT_IMDB_API_BASE_URL = "https://api.imdbapi.dev";

export const CATALOG_EVIDENCE_PRIORITY: readonly CatalogNamespace[] = [
  ...BASELINE_PRIORITY,
  "trakt",
] as const;

export interface CatalogGatewayConfig {
  tmdb?: TmdbGatewayConfig;
  tmdbGateway?: TmdbGateway;
  tvdbApiBaseUrl?: string;
  tvdbBearerToken?: string;
  doubanApiBaseUrl?: string;
  bangumiApiBaseUrl?: string;
  imdbApiBaseUrl?: string;
  traktApiBaseUrl?: string;
  traktClientId?: string;
  timeoutMs?: number;
}

export type ParsedCatalogTargetKey =
  | {
      namespace: "tmdb";
      nativeId: string;
      canonicalKey: string;
      tmdbType: MediaType;
      tmdbId: string;
    }
  | {
      namespace: "tvdb";
      nativeId: string;
      canonicalKey: string;
      tvdbId: string;
      mediaTypeHint: MediaType | null;
    }
  | {
      namespace: "imdb";
      nativeId: string;
      canonicalKey: string;
      imdbId: string;
    }
  | {
      namespace: "bangumi";
      nativeId: string;
      canonicalKey: string;
      subjectId: string;
    }
  | {
      namespace: "douban";
      nativeId: string;
      canonicalKey: string;
      subjectId: string;
    }
  | {
      namespace: "trakt";
      nativeId: string;
      canonicalKey: string;
      traktType: "movie" | "show" | null;
      traktId: string;
    };

export interface CatalogTargetInitialAssociation {
  namespace: "douban" | "bangumi";
  nativeId: string;
}

export interface CatalogTargetSnapshot {
  sourceNamespace: CatalogNamespace;
  canonicalId: string;
  canonicalKey: string;
  type: MediaType;
  baseline: BaselineSource | null;
  snapshot: MediaSnapshot;
  externalIds: Partial<Record<ExternalIdNamespace, string>>;
  initialAssociation: CatalogTargetInitialAssociation | null;
  evidence: CatalogEvidence;
}

export type ResolveCatalogTargetResult =
  | { status: "found"; target: CatalogTargetSnapshot }
  | { status: "invalid_key"; reason: string }
  | { status: "not_found"; reason?: string }
  | { status: "transient_error"; reason: string; retryAfterMs?: number };

const POSITIVE_INT_PATTERN = /^[1-9]\d*$/;
const TVDB_TYPED_PATTERN = /^(movie|series|tv):([1-9]\d*)$/i;
const IMDB_ID_PATTERN = /^tt\d+$/i;
const TRAKT_TYPED_PATTERN = /^(movie|show):([a-z0-9][a-z0-9-]*)$/i;

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parsePositiveInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (POSITIVE_INT_PATTERN.test(trimmed)) {
      const parsed = Number(trimmed);
      if (Number.isSafeInteger(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }
  return null;
}

function parseNonNegativeInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number(trimmed);
      if (Number.isSafeInteger(parsed) && parsed >= 0) {
        return parsed;
      }
    }
  }
  return null;
}

function parseYear(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1800 && raw <= 3000) {
    return raw;
  }
  if (typeof raw !== "string") {
    return null;
  }
  const match = raw.trim().match(/^(\d{4})/);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  return Number.isInteger(year) && year >= 1800 && year <= 3000 ? year : null;
}

function normalizeImdbId(raw: unknown): string | null {
  const str = nonEmptyString(raw);
  if (!str || !IMDB_ID_PATTERN.test(str)) {
    return null;
  }
  return str.toLowerCase();
}

function normalizeTvdbId(raw: unknown): string | null {
  const num = parsePositiveInt(raw);
  if (num !== null) {
    return String(num);
  }
  const str = nonEmptyString(raw);
  if (!str) {
    return null;
  }
  const typed = str.match(TVDB_TYPED_PATTERN);
  if (typed) {
    const kind = typed[1]!.toLowerCase();
    return kind === "movie" ? `movie:${typed[2]!}` : typed[2]!;
  }
  return null;
}

function extractAliasesFromArray(raw: unknown, exclude: ReadonlySet<string>): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<string>(exclude);
  const aliases: string[] = [];
  for (const item of raw) {
    let candidate: string | null = null;
    if (typeof item === "string") {
      candidate = nonEmptyString(item);
    } else if (item && typeof item === "object" && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      candidate = nonEmptyString(record.name) ?? nonEmptyString(record.title);
    }
    if (candidate && !seen.has(candidate)) {
      seen.add(candidate);
      aliases.push(candidate);
    }
  }
  return aliases;
}

function parseGenericSeasons(
  rawSeasons: unknown,
  preferOfficialTvdbOrder = false,
): SeasonSnapshot[] {
  if (!Array.isArray(rawSeasons)) {
    return [];
  }

  let items = rawSeasons.filter(
    (entry): entry is Record<string, unknown> =>
      Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
  );

  if (preferOfficialTvdbOrder) {
    const officialItems = items.filter((entry) => {
      const seasonType = entry.type;
      if (!seasonType || typeof seasonType !== "object" || Array.isArray(seasonType)) {
        return false;
      }
      const typeRecord = seasonType as Record<string, unknown>;
      return (
        typeRecord.id === 1 ||
        (typeof typeRecord.type === "string" && typeRecord.type.toLowerCase() === "official")
      );
    });
    if (officialItems.length > 0) {
      items = officialItems;
    }
  }

  const bySeason = new Map<number, SeasonSnapshot>();
  for (const record of items) {
    const season = parseNonNegativeInt(
      record.season ?? record.season_number ?? record.seasonNumber ?? record.number,
    );
    if (season === null) {
      continue;
    }
    const rawCount =
      record.episodeCount ??
      record.episode_count ??
      (Array.isArray(record.episodes) ? record.episodes.length : 0);
    const episodeCount = parseNonNegativeInt(rawCount) ?? 0;
    const airYear = parseYear(
      record.airYear ?? record.air_year ?? record.airDate ?? record.air_date ?? record.year,
    );

    const existing = bySeason.get(season);
    if (!existing || (episodeCount > existing.episodeCount && existing.episodeCount === 0)) {
      bySeason.set(season, { season, episodeCount, airYear });
    }
  }

  return [...bySeason.values()].toSorted((a, b) => a.season - b.season);
}

/**
 * Selects the authoritative media baseline from available catalog sources in exact priority:
 * tmdb > tvdb > imdb > bangumi > douban. Returns null when only non-baseline sources (e.g. trakt)
 * are available.
 */
export function selectBaseline(
  availableSources: Iterable<CatalogNamespace>,
): BaselineSource | null {
  const available = new Set<CatalogNamespace>(availableSources);
  for (const source of BASELINE_PRIORITY) {
    if (available.has(source)) {
      return source;
    }
  }
  return null;
}

export function parseCatalogTargetKey(rawKey: string): ParsedCatalogTargetKey | null {
  const parsed = parseExternalKey(rawKey.trim());
  if (!parsed) {
    return null;
  }

  switch (parsed.namespace) {
    case "tmdb": {
      const tmdb = parseTmdbNativeId(parsed.nativeId);
      if (!tmdb) {
        return null;
      }
      const nativeId = `${tmdb.type}:${tmdb.id}`;
      return {
        namespace: "tmdb",
        nativeId,
        canonicalKey: formatExternalKey({ namespace: "tmdb", nativeId }),
        tmdbType: tmdb.type,
        tmdbId: tmdb.id,
      };
    }

    case "tvdb": {
      const trimmed = parsed.nativeId.trim();
      if (POSITIVE_INT_PATTERN.test(trimmed)) {
        return {
          namespace: "tvdb",
          nativeId: trimmed,
          canonicalKey: formatExternalKey({ namespace: "tvdb", nativeId: trimmed }),
          tvdbId: trimmed,
          mediaTypeHint: null,
        };
      }
      const typed = trimmed.match(TVDB_TYPED_PATTERN);
      if (!typed) {
        return null;
      }
      const kind = typed[1]!.toLowerCase();
      const id = typed[2]!;
      const mediaTypeHint: MediaType = kind === "movie" ? "movie" : "tv";
      const nativeId = kind === "movie" ? `movie:${id}` : id;
      return {
        namespace: "tvdb",
        nativeId,
        canonicalKey: formatExternalKey({ namespace: "tvdb", nativeId }),
        tvdbId: id,
        mediaTypeHint,
      };
    }

    case "imdb": {
      const imdbId = normalizeImdbId(parsed.nativeId);
      if (!imdbId) {
        return null;
      }
      return {
        namespace: "imdb",
        nativeId: imdbId,
        canonicalKey: formatExternalKey({ namespace: "imdb", nativeId: imdbId }),
        imdbId,
      };
    }

    case "bangumi": {
      const subjectId = parsed.nativeId.trim();
      if (!POSITIVE_INT_PATTERN.test(subjectId)) {
        return null;
      }
      return {
        namespace: "bangumi",
        nativeId: subjectId,
        canonicalKey: formatExternalKey({ namespace: "bangumi", nativeId: subjectId }),
        subjectId,
      };
    }

    case "douban": {
      const subjectId = parsed.nativeId.trim();
      if (!POSITIVE_INT_PATTERN.test(subjectId)) {
        return null;
      }
      return {
        namespace: "douban",
        nativeId: subjectId,
        canonicalKey: formatExternalKey({ namespace: "douban", nativeId: subjectId }),
        subjectId,
      };
    }

    case "trakt": {
      const trimmed = parsed.nativeId.trim();
      const typed = trimmed.match(TRAKT_TYPED_PATTERN);
      if (typed) {
        const traktType = typed[1]!.toLowerCase() as "movie" | "show";
        const traktId = typed[2]!.toLowerCase();
        const nativeId = `${traktType}:${traktId}`;
        return {
          namespace: "trakt",
          nativeId,
          canonicalKey: formatExternalKey({ namespace: "trakt", nativeId }),
          traktType,
          traktId,
        };
      }
      if (POSITIVE_INT_PATTERN.test(trimmed)) {
        return {
          namespace: "trakt",
          nativeId: trimmed,
          canonicalKey: formatExternalKey({ namespace: "trakt", nativeId: trimmed }),
          traktType: null,
          traktId: trimmed,
        };
      }
      return null;
    }

    default:
      return null;
  }
}

export function buildCatalogTargetSnapshotFromTmdb(
  result: TmdbMediaFetchResult,
): CatalogTargetSnapshot {
  const externalIds: Partial<Record<ExternalIdNamespace, string>> = {
    tmdb: result.externalIds.tmdb,
  };
  const evidenceExternalIds: Partial<Record<Namespace, string>> = {
    tmdb: result.externalIds.tmdb,
  };
  const sources: CatalogNamespace[] = ["tmdb"];

  if (result.externalIds.imdb) {
    externalIds.imdb = result.externalIds.imdb;
    evidenceExternalIds.imdb = result.externalIds.imdb;
    sources.push("imdb");
  }
  if (result.externalIds.tvdb) {
    externalIds.tvdb = result.externalIds.tvdb;
    evidenceExternalIds.tvdb = result.externalIds.tvdb;
    sources.push("tvdb");
  }
  if (result.externalIds.trakt) {
    externalIds.trakt = result.externalIds.trakt;
    evidenceExternalIds.trakt = result.externalIds.trakt;
    sources.push("trakt");
  }

  return {
    sourceNamespace: "tmdb",
    canonicalId: result.externalIds.tmdb,
    canonicalKey: `tmdb:${result.externalIds.tmdb}`,
    type: result.type,
    baseline: selectBaseline(sources),
    snapshot: result.snapshot,
    externalIds,
    initialAssociation: null,
    evidence: {
      namespace: "tmdb",
      canonicalId: result.externalIds.tmdb,
      mediaType: result.type,
      title: result.snapshot.title,
      originalTitle: result.snapshot.originalTitle,
      year: result.snapshot.year,
      seasons: result.snapshot.seasons,
      externalIds: evidenceExternalIds,
    },
  };
}

function buildCatalogTargetFromAssociationAdapter(
  namespace: "douban" | "bangumi",
  info: CollectionInfo,
): CatalogTargetSnapshot {
  const type: MediaType = info.mediaType ?? (namespace === "bangumi" ? "tv" : "movie");
  const seasons: SeasonSnapshot[] =
    type === "tv"
      ? [
          {
            season: 1,
            episodeCount: info.featureEpisodeCount ?? 0,
            airYear: info.year,
          },
        ]
      : [];

  const externalIds: Partial<Record<ExternalIdNamespace, string>> = {};
  const evidenceExternalIds: Partial<Record<Namespace, string>> = {
    [namespace]: info.canonicalId,
  };
  const sources: CatalogNamespace[] = [namespace];

  const imdbId = normalizeImdbId(info.externalIds?.imdb);
  if (imdbId) {
    externalIds.imdb = imdbId;
    evidenceExternalIds.imdb = imdbId;
    sources.push("imdb");
  }

  const tvdbId = normalizeTvdbId(info.externalIds?.tvdb);
  if (tvdbId) {
    externalIds.tvdb = tvdbId;
    evidenceExternalIds.tvdb = tvdbId;
    sources.push("tvdb");
  }

  const snapshot: MediaSnapshot = {
    title: info.title,
    originalTitle: info.originalTitle ?? null,
    year: info.year,
    type,
    seasons,
  };

  return {
    sourceNamespace: namespace,
    canonicalId: info.canonicalId,
    canonicalKey: `${namespace}:${info.canonicalId}`,
    type,
    baseline: selectBaseline(sources),
    snapshot,
    externalIds,
    initialAssociation: {
      namespace,
      nativeId: info.canonicalId,
    },
    evidence: {
      namespace,
      canonicalId: info.canonicalId,
      mediaType: type,
      title: info.title,
      originalTitle: info.originalTitle ?? null,
      ...(info.aliases && info.aliases.length > 0 ? { aliases: info.aliases } : {}),
      year: info.year,
      seasons,
      episodeCount: info.featureEpisodeCount,
      externalIds: evidenceExternalIds,
    },
  };
}

function parseJsonObjectResponse(
  response: ExternalHttpResponse,
):
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; kind: "not_found" | "transient_error"; reason: string } {
  if (response.status === 404) {
    return { ok: false, kind: "not_found", reason: "http_404" };
  }
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, kind: "transient_error", reason: `http_${response.status}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return { ok: false, kind: "transient_error", reason: "invalid_json" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, kind: "transient_error", reason: "unexpected_payload" };
  }
  return { ok: true, data: parsed as Record<string, unknown> };
}

async function fetchTvdbTargetSnapshot(
  parsed: Extract<ParsedCatalogTargetKey, { namespace: "tvdb" }>,
  outbound: OutboundClient,
  config: CatalogGatewayConfig,
): Promise<ResolveCatalogTargetResult> {
  const baseUrl = trimTrailingSlash(config.tvdbApiBaseUrl ?? DEFAULT_TVDB_API_BASE_URL);
  const resource = parsed.mediaTypeHint === "movie" ? "movies" : "series";
  const url = `${baseUrl}/${resource}/${encodeURIComponent(parsed.tvdbId)}/extended`;
  const headers: Record<string, string> = {
    accept: "application/json",
  };
  if (config.tvdbBearerToken) {
    headers.authorization = `Bearer ${config.tvdbBearerToken}`;
  }

  let response: ExternalHttpResponse;
  try {
    response = await outbound.fetchExternal({
      kind: "catalog",
      namespace: "tvdb",
      url,
      method: "GET",
      headers,
      timeoutMs: config.timeoutMs ?? config.tmdb?.timeoutMs,
    });
  } catch (error) {
    return {
      status: "transient_error",
      reason: error instanceof Error ? error.message : "tvdb_request_failed",
    };
  }

  const parsedResp = parseJsonObjectResponse(response);
  if (!parsedResp.ok) {
    return { status: parsedResp.kind, reason: parsedResp.reason };
  }

  const rawData =
    parsedResp.data.data &&
    typeof parsedResp.data.data === "object" &&
    !Array.isArray(parsedResp.data.data)
      ? (parsedResp.data.data as Record<string, unknown>)
      : parsedResp.data;

  const title = nonEmptyString(rawData.name) ?? nonEmptyString(rawData.title);
  if (!title) {
    return { status: "transient_error", reason: "tvdb_missing_title" };
  }

  const originalTitle =
    nonEmptyString(rawData.originalName) ?? nonEmptyString(rawData.original_name);
  const rawType = nonEmptyString(rawData.mediaType ?? rawData.type)?.toLowerCase();
  const type: MediaType = parsed.mediaTypeHint === "movie" || rawType === "movie" ? "movie" : "tv";
  const year = parseYear(
    rawData.year ??
      rawData.firstAired ??
      rawData.first_aired ??
      rawData.releaseDate ??
      rawData.release_date,
  );
  const seasons = type === "tv" ? parseGenericSeasons(rawData.seasons, true) : [];

  const externalIds: Partial<Record<ExternalIdNamespace, string>> = {
    tvdb: parsed.nativeId,
  };
  const evidenceExternalIds: Partial<Record<Namespace, string>> = {
    tvdb: parsed.nativeId,
  };
  const sources: CatalogNamespace[] = ["tvdb"];

  const addImdb = (raw: unknown) => {
    const imdbId = normalizeImdbId(raw);
    if (imdbId && !externalIds.imdb) {
      externalIds.imdb = imdbId;
      evidenceExternalIds.imdb = imdbId;
      sources.push("imdb");
    }
  };

  if (Array.isArray(rawData.remoteIds)) {
    for (const remote of rawData.remoteIds) {
      if (!remote || typeof remote !== "object" || Array.isArray(remote)) {
        continue;
      }
      const rec = remote as Record<string, unknown>;
      const sourceName = nonEmptyString(rec.sourceName)?.toLowerCase() ?? "";
      if (sourceName === "imdb" || rec.type === 2) {
        addImdb(rec.id);
      }
    }
  }

  const extBlock = (rawData.externalIds ?? rawData.external_ids) as
    | Record<string, unknown>
    | undefined;
  if (extBlock && typeof extBlock === "object" && !Array.isArray(extBlock)) {
    addImdb(extBlock.imdb ?? extBlock.imdb_id);
    const tmdbCandidate = nonEmptyString(extBlock.tmdb);
    if (tmdbCandidate && parseTmdbNativeId(tmdbCandidate)) {
      externalIds.tmdb = tmdbCandidate;
      evidenceExternalIds.tmdb = tmdbCandidate;
      sources.push("tmdb");
    }
  }

  const exclude = new Set<string>([title, ...(originalTitle ? [originalTitle] : [])]);
  const aliases = extractAliasesFromArray(rawData.aliases, exclude);
  const explicitEpisodeCount = parsePositiveInt(
    rawData.episodeCount ?? rawData.episode_count ?? rawData.episodes_count,
  );

  const snapshot: MediaSnapshot = {
    title,
    originalTitle,
    year,
    type,
    seasons,
  };

  return {
    status: "found",
    target: {
      sourceNamespace: "tvdb",
      canonicalId: parsed.nativeId,
      canonicalKey: parsed.canonicalKey,
      type,
      baseline: selectBaseline(sources),
      snapshot,
      externalIds,
      initialAssociation: null,
      evidence: {
        namespace: "tvdb",
        canonicalId: parsed.nativeId,
        mediaType: type,
        title,
        originalTitle,
        ...(aliases.length > 0 ? { aliases } : {}),
        year,
        seasons,
        ...(explicitEpisodeCount !== null ? { episodeCount: explicitEpisodeCount } : {}),
        externalIds: evidenceExternalIds,
      },
    },
  };
}

function mapImdbMediaType(rawType: unknown, seasons: readonly SeasonSnapshot[]): MediaType {
  const normalized = nonEmptyString(rawType)?.toLowerCase();
  if (
    normalized === "tv" ||
    normalized === "tvseries" ||
    normalized === "tvminiseries" ||
    normalized === "series" ||
    normalized === "tv_series"
  ) {
    return "tv";
  }
  if (
    normalized === "movie" ||
    normalized === "tvmovie" ||
    normalized === "film" ||
    normalized === "short"
  ) {
    return "movie";
  }
  return seasons.length > 0 ? "tv" : "movie";
}

async function fetchImdbTargetSnapshot(
  parsed: Extract<ParsedCatalogTargetKey, { namespace: "imdb" }>,
  outbound: OutboundClient,
  config: CatalogGatewayConfig,
): Promise<ResolveCatalogTargetResult> {
  const baseUrl = trimTrailingSlash(config.imdbApiBaseUrl ?? DEFAULT_IMDB_API_BASE_URL);
  const url = `${baseUrl}/titles/${encodeURIComponent(parsed.imdbId)}`;

  let response: ExternalHttpResponse;
  try {
    response = await outbound.fetchExternal({
      kind: "catalog",
      namespace: "imdb",
      url,
      method: "GET",
      headers: { accept: "application/json" },
      timeoutMs: config.timeoutMs ?? config.tmdb?.timeoutMs,
    });
  } catch (error) {
    return {
      status: "transient_error",
      reason: error instanceof Error ? error.message : "imdb_request_failed",
    };
  }

  const parsedResp = parseJsonObjectResponse(response);
  if (!parsedResp.ok) {
    return { status: parsedResp.kind, reason: parsedResp.reason };
  }

  const data = parsedResp.data;
  const title =
    nonEmptyString(data.primaryTitle) ??
    nonEmptyString(data.title) ??
    nonEmptyString(data.originalTitle);
  if (!title) {
    return { status: "transient_error", reason: "imdb_missing_title" };
  }

  const originalTitle = nonEmptyString(data.originalTitle) ?? nonEmptyString(data.original_title);
  const parsedSeasons = parseGenericSeasons(data.seasons, false);
  const type = mapImdbMediaType(data.type ?? data.titleType ?? data.mediaType, parsedSeasons);
  const seasons = type === "tv" ? parsedSeasons : [];
  const year = parseYear(data.startYear ?? data.year ?? data.releaseYear ?? data.release_date);

  const externalIds: Partial<Record<ExternalIdNamespace, string>> = {
    imdb: parsed.imdbId,
  };
  const evidenceExternalIds: Partial<Record<Namespace, string>> = {
    imdb: parsed.imdbId,
  };
  const sources: CatalogNamespace[] = ["imdb"];

  const extBlock = (data.externalIds ?? data.external_ids) as Record<string, unknown> | undefined;
  if (extBlock && typeof extBlock === "object" && !Array.isArray(extBlock)) {
    const tvdbId = normalizeTvdbId(extBlock.tvdb ?? extBlock.tvdb_id);
    if (tvdbId) {
      externalIds.tvdb = tvdbId;
      evidenceExternalIds.tvdb = tvdbId;
      sources.push("tvdb");
    }
    const tmdbCandidate = nonEmptyString(extBlock.tmdb);
    if (tmdbCandidate && parseTmdbNativeId(tmdbCandidate)) {
      externalIds.tmdb = tmdbCandidate;
      evidenceExternalIds.tmdb = tmdbCandidate;
      sources.push("tmdb");
    }
  }

  const exclude = new Set<string>([title, ...(originalTitle ? [originalTitle] : [])]);
  const aliases = extractAliasesFromArray(data.aliases ?? data.aka, exclude);
  const explicitEpisodeCount = parsePositiveInt(
    data.episodeCount ?? data.episode_count ?? data.episodes_count,
  );

  const snapshot: MediaSnapshot = {
    title,
    originalTitle,
    year,
    type,
    seasons,
  };

  return {
    status: "found",
    target: {
      sourceNamespace: "imdb",
      canonicalId: parsed.imdbId,
      canonicalKey: parsed.canonicalKey,
      type,
      baseline: selectBaseline(sources),
      snapshot,
      externalIds,
      initialAssociation: null,
      evidence: {
        namespace: "imdb",
        canonicalId: parsed.imdbId,
        mediaType: type,
        title,
        originalTitle,
        ...(aliases.length > 0 ? { aliases } : {}),
        year,
        seasons,
        ...(explicitEpisodeCount !== null ? { episodeCount: explicitEpisodeCount } : {}),
        externalIds: evidenceExternalIds,
      },
    },
  };
}

async function fetchTraktTargetSnapshot(
  parsed: Extract<ParsedCatalogTargetKey, { namespace: "trakt" }>,
  outbound: OutboundClient,
  config: CatalogGatewayConfig,
): Promise<ResolveCatalogTargetResult> {
  const baseUrl = trimTrailingSlash(
    config.traktApiBaseUrl ?? config.tmdb?.traktApiBaseUrl ?? DEFAULT_TRAKT_API_BASE_URL,
  );
  const traktClientId = config.traktClientId ?? config.tmdb?.traktClientId;
  const headers: Record<string, string> = {
    accept: "application/json",
    "trakt-api-version": "2",
    // Trakt's edge returns 403 to requests without a User-Agent
    "user-agent": "media-ref",
  };
  if (traktClientId) {
    headers["trakt-api-key"] = traktClientId;
  }

  const url =
    parsed.traktType === "movie"
      ? `${baseUrl}/movies/${encodeURIComponent(parsed.traktId)}?extended=full`
      : parsed.traktType === "show"
        ? `${baseUrl}/shows/${encodeURIComponent(parsed.traktId)}?extended=full`
        : `${baseUrl}/search/trakt/${encodeURIComponent(parsed.traktId)}?type=movie,show`;

  let response: ExternalHttpResponse;
  try {
    response = await outbound.fetchExternal({
      kind: "catalog",
      namespace: "trakt",
      url,
      method: "GET",
      headers,
      timeoutMs: config.timeoutMs ?? config.tmdb?.timeoutMs,
    });
  } catch (error) {
    return {
      status: "transient_error",
      reason: error instanceof Error ? error.message : "trakt_request_failed",
    };
  }

  if (response.status === 404) {
    return { status: "not_found", reason: "http_404" };
  }
  if (response.status < 200 || response.status >= 300) {
    return { status: "transient_error", reason: `http_${response.status}` };
  }

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(response.body);
  } catch {
    return { status: "transient_error", reason: "invalid_json" };
  }

  let data: Record<string, unknown> | null = null;
  let inferredType: MediaType = parsed.traktType === "movie" ? "movie" : "tv";
  let canonicalNativeId = parsed.nativeId;

  if (Array.isArray(rawJson)) {
    const first = rawJson[0];
    if (!first || typeof first !== "object" || Array.isArray(first)) {
      return { status: "not_found", reason: "trakt_not_found" };
    }
    const wrapper = first as Record<string, unknown>;
    if (wrapper.movie && typeof wrapper.movie === "object" && !Array.isArray(wrapper.movie)) {
      data = wrapper.movie as Record<string, unknown>;
      inferredType = "movie";
    } else if (wrapper.show && typeof wrapper.show === "object" && !Array.isArray(wrapper.show)) {
      data = wrapper.show as Record<string, unknown>;
      inferredType = "tv";
    } else {
      return { status: "not_found", reason: "trakt_not_found" };
    }
  } else if (rawJson && typeof rawJson === "object") {
    data = rawJson as Record<string, unknown>;
    const rawType = nonEmptyString(data.type)?.toLowerCase();
    if (rawType === "movie") {
      inferredType = "movie";
    } else if (rawType === "show" || rawType === "tv") {
      inferredType = "tv";
    }
  } else {
    return { status: "transient_error", reason: "unexpected_payload" };
  }

  const title = nonEmptyString(data.title);
  if (!title) {
    return { status: "transient_error", reason: "trakt_missing_title" };
  }

  const originalTitle = nonEmptyString(data.originalTitle) ?? nonEmptyString(data.original_title);
  const year = parseYear(data.year ?? data.first_aired ?? data.released);
  const episodeCount =
    inferredType === "movie"
      ? 1
      : parsePositiveInt(data.aired_episodes ?? data.episode_count ?? data.episodeCount);

  const ids =
    data.ids && typeof data.ids === "object" && !Array.isArray(data.ids)
      ? (data.ids as Record<string, unknown>)
      : null;

  if (parsed.traktType === null) {
    const resolvedId = parsePositiveInt(ids?.trakt);
    if (resolvedId !== null) {
      canonicalNativeId = `${inferredType === "movie" ? "movie" : "show"}:${resolvedId}`;
    }
  }

  const externalIds: Partial<Record<ExternalIdNamespace, string>> = {
    trakt: canonicalNativeId,
  };
  const evidenceExternalIds: Partial<Record<Namespace, string>> = {
    trakt: canonicalNativeId,
  };
  const sources: CatalogNamespace[] = ["trakt"];

  if (ids) {
    const tmdbNum = parsePositiveInt(ids.tmdb);
    if (tmdbNum !== null) {
      const tmdbVal = `${inferredType}:${tmdbNum}`;
      externalIds.tmdb = tmdbVal;
      evidenceExternalIds.tmdb = tmdbVal;
      sources.push("tmdb");
    }
    const tvdbVal = normalizeTvdbId(ids.tvdb);
    if (tvdbVal) {
      externalIds.tvdb = tvdbVal;
      evidenceExternalIds.tvdb = tvdbVal;
      sources.push("tvdb");
    }
    const imdbVal = normalizeImdbId(ids.imdb);
    if (imdbVal) {
      externalIds.imdb = imdbVal;
      evidenceExternalIds.imdb = imdbVal;
      sources.push("imdb");
    }
  }

  const snapshot: MediaSnapshot = {
    title,
    originalTitle,
    year,
    type: inferredType,
    seasons: [],
  };

  // Trakt-only media has NO baseline (baseline: null); when Trakt returns higher-priority
  // external IDs (TMDB/TVDB/IMDb), selectBaseline picks the highest priority source.
  const baseline = selectBaseline(sources);

  return {
    status: "found",
    target: {
      sourceNamespace: "trakt",
      canonicalId: canonicalNativeId,
      canonicalKey: `trakt:${canonicalNativeId}`,
      type: inferredType,
      baseline,
      snapshot,
      externalIds,
      initialAssociation: null,
      evidence: {
        namespace: "trakt",
        canonicalId: canonicalNativeId,
        mediaType: inferredType,
        title,
        originalTitle,
        year,
        seasons: [],
        ...(episodeCount !== null ? { episodeCount } : {}),
        externalIds: evidenceExternalIds,
      },
    },
  };
}

export async function resolveCatalogTargetSnapshot(
  externalKey: string,
  outbound: OutboundClient,
  config: CatalogGatewayConfig = {},
): Promise<ResolveCatalogTargetResult> {
  const parsed = parseCatalogTargetKey(externalKey);
  if (!parsed) {
    return {
      status: "invalid_key",
      reason: `Unsupported or invalid catalog external key: ${externalKey}`,
    };
  }

  switch (parsed.namespace) {
    case "tmdb": {
      const gateway = config.tmdbGateway ?? createTmdbGateway(outbound, config.tmdb);
      let fetched: TmdbMediaFetchResult | null;
      try {
        fetched = await gateway.fetchMediaSnapshotAndExternalIds(parsed.tmdbType, parsed.tmdbId);
      } catch (error) {
        return {
          status: "transient_error",
          reason: error instanceof Error ? error.message : "tmdb_request_failed",
        };
      }
      if (!fetched) {
        return { status: "not_found", reason: `TMDB media not found for ${parsed.canonicalKey}` };
      }
      return {
        status: "found",
        target: buildCatalogTargetSnapshotFromTmdb(fetched),
      };
    }

    case "tvdb":
      return fetchTvdbTargetSnapshot(parsed, outbound, config);

    case "imdb":
      return fetchImdbTargetSnapshot(parsed, outbound, config);

    case "bangumi": {
      const fetched = await fetchBangumiCollection(parsed.subjectId, outbound, {
        apiBaseUrl: config.bangumiApiBaseUrl,
        timeoutMs: config.timeoutMs ?? config.tmdb?.timeoutMs,
      });
      if (fetched.status === "not_found") {
        return { status: "not_found", reason: fetched.reason };
      }
      if (fetched.status === "transient_error") {
        return {
          status: "transient_error",
          reason: fetched.reason,
          ...(fetched.retryAfterMs !== undefined ? { retryAfterMs: fetched.retryAfterMs } : {}),
        };
      }
      return {
        status: "found",
        target: buildCatalogTargetFromAssociationAdapter("bangumi", fetched.info),
      };
    }

    case "douban": {
      const fetched = await fetchDoubanCollection(parsed.subjectId, outbound, {
        apiBaseUrl: config.doubanApiBaseUrl,
        timeoutMs: config.timeoutMs ?? config.tmdb?.timeoutMs,
      });
      if (fetched.status === "not_found") {
        return { status: "not_found", reason: fetched.reason };
      }
      if (fetched.status === "transient_error") {
        return {
          status: "transient_error",
          reason: fetched.reason,
          ...(fetched.retryAfterMs !== undefined ? { retryAfterMs: fetched.retryAfterMs } : {}),
        };
      }
      return {
        status: "found",
        target: buildCatalogTargetFromAssociationAdapter("douban", fetched.info),
      };
    }

    case "trakt":
      return fetchTraktTargetSnapshot(parsed, outbound, config);
  }
}
