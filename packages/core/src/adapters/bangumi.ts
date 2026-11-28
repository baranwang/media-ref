import type { MediaType, Namespace } from "@media-ref/client";
import type { ExternalHttpResponse, OutboundClient } from "../outbound.ts";
import {
  InvalidNativeIdError,
  type CollectionEvidenceResult,
  type FeatureEpisode,
  type ParsedNativeIdInput,
  type Tier2Adapter,
} from "./types.ts";

const BANGUMI_SUBJECT_ID_PATTERN = /^[1-9]\d*$/;
const BANGUMI_ALLOWED_HOSTS = new Set([
  "bgm.tv",
  "www.bgm.tv",
  "bangumi.tv",
  "www.bangumi.tv",
  "chii.in",
  "www.chii.in",
]);
const BANGUMI_SUBJECT_PATH_PATTERN = /^\/subject\/([1-9]\d*)\/?$/;
const IMDB_ID_PATTERN = /\b(tt\d+)\b/i;

export const DEFAULT_BANGUMI_API_BASE_URL = "https://api.bgm.tv/v0";
const BANGUMI_API_HEADERS: Record<string, string> = {
  accept: "application/json",
  "user-agent": "media-ref/0.1 (https://mediaref.org)",
};

export interface BangumiFetchOptions {
  apiBaseUrl?: string;
  timeoutMs?: number;
}

// Bangumi subject types: 1=Book, 2=Anime, 3=Music, 4=Game, 6=Real (live-action TV/Movie)
const BANGUMI_MEDIA_SUBJECT_TYPES = new Set([2, 6]);
const BANGUMI_MOVIE_PLATFORMS = new Set(["剧场版", "电影", "movie"]);

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
    if (/^[1-9]\d*$/.test(trimmed)) {
      const parsed = Number(trimmed);
      if (Number.isSafeInteger(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }
  return null;
}

function parseFourDigitYear(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1800 && raw <= 3000) {
    return raw;
  }
  if (typeof raw !== "string") {
    return null;
  }
  const match = raw.trim().match(/(\d{4})/);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  return Number.isInteger(year) && year >= 1800 && year <= 3000 ? year : null;
}

function extractInfoboxStrings(rawValue: unknown): string[] {
  if (typeof rawValue === "string") {
    const trimmed = rawValue.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }
  if (Array.isArray(rawValue)) {
    const values: string[] = [];
    for (const item of rawValue) {
      if (typeof item === "string") {
        const trimmed = item.trim();
        if (trimmed.length > 0) {
          values.push(trimmed);
        }
      } else if (item && typeof item === "object" && !Array.isArray(item)) {
        const v = nonEmptyString((item as Record<string, unknown>).v);
        if (v) {
          values.push(v);
        }
      }
    }
    return values;
  }
  return [];
}

export interface BangumiSubjectMetadata {
  id: string;
  title: string;
  originalTitle: string | null;
  aliases: string[];
  year: number | null;
  mediaType: MediaType;
  episodeCount: number | null;
  imdbId: string | null;
  directors: string[];
  studios: string[];
}

export type BangumiSubjectMetadataResult =
  | { status: "found"; subject: BangumiSubjectMetadata }
  | { status: "not_found"; reason: string }
  | { status: "transient_error"; reason: string };

const BANGUMI_DIRECTOR_KEYS = new Set(["导演", "总导演", "监督", "director"]);
const BANGUMI_STUDIO_KEYS = new Set(["动画制作", "制作", "制作会社", "studio"]);

function parseBangumiInfobox(infobox: unknown): {
  aliases: string[];
  imdbId: string | null;
  fallbackYear: number | null;
  directors: string[];
  studios: string[];
} {
  const aliases: string[] = [];
  const directors: string[] = [];
  const studios: string[] = [];
  let imdbId: string | null = null;
  let fallbackYear: number | null = null;

  if (!Array.isArray(infobox)) {
    return { aliases, imdbId, fallbackYear, directors, studios };
  }

  for (const item of infobox) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const entry = item as Record<string, unknown>;
    const rawKey = nonEmptyString(entry.key);
    if (!rawKey) {
      continue;
    }
    const normalizedKey = rawKey.toLowerCase();
    const values = extractInfoboxStrings(entry.value);

    if (
      normalizedKey === "imdb_id" ||
      normalizedKey === "imdb" ||
      normalizedKey === "imdb id" ||
      normalizedKey === "imdb编号"
    ) {
      for (const val of values) {
        const match = val.match(IMDB_ID_PATTERN);
        if (match) {
          imdbId = match[1]!.toLowerCase();
          break;
        }
      }
      continue;
    }

    if (rawKey === "别名" || rawKey === "中文名" || normalizedKey === "英文名") {
      for (const val of values) {
        aliases.push(val);
      }
      continue;
    }

    if (BANGUMI_DIRECTOR_KEYS.has(normalizedKey)) {
      for (const val of values) {
        directors.push(val);
      }
      continue;
    }

    if (BANGUMI_STUDIO_KEYS.has(normalizedKey)) {
      for (const val of values) {
        studios.push(val);
      }
      continue;
    }

    if (
      fallbackYear === null &&
      (rawKey === "放送开始" || rawKey === "上映年度" || rawKey === "发售日")
    ) {
      for (const val of values) {
        const year = parseFourDigitYear(val);
        if (year !== null) {
          fallbackYear = year;
          break;
        }
      }
    }
  }

  return { aliases, imdbId, fallbackYear, directors, studios };
}

function dedupeAliases(
  candidates: readonly string[],
  primaryTitle: string,
  originalTitle: string | null,
): string[] {
  const seen = new Set<string>([primaryTitle]);
  if (originalTitle) {
    seen.add(originalTitle);
  }
  const aliases: string[] = [];
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    aliases.push(trimmed);
  }
  return aliases;
}

function buildOrdinalEpisodes(count: number): FeatureEpisode[] {
  const episodes: FeatureEpisode[] = [];
  for (let i = 1; i <= count; i += 1) {
    episodes.push({ index: i });
  }
  return episodes;
}

const BANGUMI_EPISODES_PAGE_SIZE = 100;
// shortcut: stops after 30 pages (3000 episodes), when a longer series appears, raise or stream.
const BANGUMI_EPISODES_MAX_PAGES = 30;

async function fetchBangumiMainEpisodes(
  subjectId: string,
  outbound: OutboundClient,
  apiBaseUrl: string,
  timeoutMs?: number,
): Promise<
  | { ok: true; total: number | null; episodes: FeatureEpisode[] }
  | { ok: false; transientReason: string }
> {
  const episodes: FeatureEpisode[] = [];
  let reportedTotal: number | null = null;

  // The episode list is paged; the count and the episodes must describe the same list.
  for (let page = 0; page < BANGUMI_EPISODES_MAX_PAGES; page += 1) {
    const offset = page * BANGUMI_EPISODES_PAGE_SIZE;
    const url = `${apiBaseUrl}/episodes?subject_id=${encodeURIComponent(subjectId)}&type=0&limit=${BANGUMI_EPISODES_PAGE_SIZE}&offset=${offset}`;
    let response: ExternalHttpResponse;
    try {
      response = await outbound.fetchExternal({
        kind: "catalog",
        namespace: "bangumi",
        url,
        method: "GET",
        headers: BANGUMI_API_HEADERS,
        timeoutMs,
      });
    } catch (error) {
      return {
        ok: false,
        transientReason: error instanceof Error ? error.message : "bangumi_episodes_request_failed",
      };
    }

    if (response.status === 404 && page === 0) {
      return { ok: true, total: null, episodes: [] };
    }

    if (response.status < 200 || response.status >= 300) {
      return { ok: false, transientReason: `http_${response.status}` };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      return { ok: false, transientReason: "invalid_json" };
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, transientReason: "unexpected_payload" };
    }

    const record = parsed as Record<string, unknown>;
    const rawData = Array.isArray(record.data) ? record.data : [];

    for (const item of rawData) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const ep = item as Record<string, unknown>;
      if (ep.type !== undefined && ep.type !== 0) {
        continue;
      }
      const epId = parsePositiveInt(ep.id);
      const epTitle = nonEmptyString(ep.name_cn) ?? nonEmptyString(ep.name);
      const airDate = nonEmptyString(ep.airdate);
      episodes.push({
        index: episodes.length + 1,
        ...(epId !== null ? { nativeEpisodeId: String(epId) } : {}),
        ...(epTitle ? { title: epTitle } : {}),
        ...(airDate ? { airDate } : {}),
      });
    }

    reportedTotal = parsePositiveInt(record.total) ?? reportedTotal;
    if (
      rawData.length < BANGUMI_EPISODES_PAGE_SIZE ||
      reportedTotal === null ||
      offset + BANGUMI_EPISODES_PAGE_SIZE >= reportedTotal
    ) {
      break;
    }
  }

  const count =
    reportedTotal !== null
      ? Math.max(reportedTotal, episodes.length)
      : episodes.length > 0
        ? episodes.length
        : null;

  return { ok: true, total: count, episodes };
}

export function parseBangumiInput(raw: string): ParsedNativeIdInput | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (BANGUMI_SUBJECT_ID_PATTERN.test(trimmed)) {
    return {
      kind: "subject",
      id: trimmed,
      canonicalId: trimmed,
    };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return null;
  }

  const host = parsedUrl.hostname.toLowerCase();
  if (!BANGUMI_ALLOWED_HOSTS.has(host)) {
    return null;
  }

  const match = parsedUrl.pathname.match(BANGUMI_SUBJECT_PATH_PATTERN);
  if (!match) {
    return null;
  }

  const id = match[1]!;
  return {
    kind: "subject",
    id,
    canonicalId: id,
  };
}

async function loadBangumiSubjectPayload(
  canonicalId: string,
  outbound: OutboundClient,
  options: BangumiFetchOptions = {},
): Promise<
  | {
      status: "found";
      subject: BangumiSubjectMetadata;
      record: Record<string, unknown>;
      apiBaseUrl: string;
    }
  | { status: "not_found"; reason: string }
  | { status: "transient_error"; reason: string }
> {
  const subjectId = canonicalId.trim();
  if (!BANGUMI_SUBJECT_ID_PATTERN.test(subjectId)) {
    return { status: "not_found", reason: "invalid_canonical_id" };
  }

  const apiBaseUrl = (options.apiBaseUrl ?? DEFAULT_BANGUMI_API_BASE_URL).replace(/\/+$/, "");
  const url = `${apiBaseUrl}/subjects/${encodeURIComponent(subjectId)}`;
  let response: ExternalHttpResponse;
  try {
    response = await outbound.fetchExternal({
      kind: "catalog",
      namespace: "bangumi",
      url,
      method: "GET",
      headers: BANGUMI_API_HEADERS,
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    return {
      status: "transient_error",
      reason: error instanceof Error ? error.message : "bangumi_request_failed",
    };
  }

  if (response.status === 404) {
    return { status: "not_found", reason: "http_404" };
  }

  if (response.status < 200 || response.status >= 300) {
    return {
      status: "transient_error",
      reason: `http_${response.status}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return { status: "transient_error", reason: "invalid_json" };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "transient_error", reason: "unexpected_payload" };
  }

  const record = parsed as Record<string, unknown>;
  if (typeof record.type === "number" && !BANGUMI_MEDIA_SUBJECT_TYPES.has(record.type)) {
    return {
      status: "not_found",
      reason: `unsupported_bangumi_subject_type_${record.type}`,
    };
  }

  const nameCn = nonEmptyString(record.name_cn);
  const originalName = nonEmptyString(record.name);
  const title = nameCn ?? originalName;
  if (!title) {
    return { status: "transient_error", reason: "missing_title" };
  }

  const infobox = parseBangumiInfobox(record.infobox);
  const aliases = dedupeAliases(infobox.aliases, title, originalName);
  const year = parseFourDigitYear(record.date) ?? infobox.fallbackYear;

  const rawPlatform = nonEmptyString(record.platform)?.toLowerCase() ?? "";
  const mediaType: MediaType = BANGUMI_MOVIE_PLATFORMS.has(rawPlatform) ? "movie" : "tv";
  const subjectEps = mediaType === "movie" ? 1 : parsePositiveInt(record.eps);

  return {
    status: "found",
    apiBaseUrl,
    record,
    subject: {
      id: subjectId,
      title,
      originalTitle: originalName,
      aliases,
      year,
      mediaType,
      episodeCount: subjectEps,
      imdbId: infobox.imdbId,
      directors: [...new Set(infobox.directors)],
      studios: [...new Set(infobox.studios)],
    },
  };
}

/** Fetches lightweight metadata (aliases, directors, studios, IMDb) for a Bangumi subject. */
export async function fetchBangumiSubjectMetadata(
  canonicalId: string,
  outbound: OutboundClient,
  options: BangumiFetchOptions = {},
): Promise<BangumiSubjectMetadataResult> {
  const loaded = await loadBangumiSubjectPayload(canonicalId, outbound, options);
  if (loaded.status !== "found") {
    return loaded;
  }
  return { status: "found", subject: loaded.subject };
}

export async function fetchBangumiCollection(
  canonicalId: string,
  outbound: OutboundClient,
  options: BangumiFetchOptions = {},
): Promise<CollectionEvidenceResult> {
  const loaded = await loadBangumiSubjectPayload(canonicalId, outbound, options);
  if (loaded.status !== "found") {
    return loaded;
  }

  const { subject, apiBaseUrl } = loaded;

  let featureEpisodeCount: number | null;
  let featureEpisodes: FeatureEpisode[];
  if (subject.mediaType === "movie") {
    featureEpisodeCount = 1;
    featureEpisodes = [{ index: 1 }];
  } else if (subject.episodeCount !== null) {
    featureEpisodeCount = subject.episodeCount;
    featureEpisodes = buildOrdinalEpisodes(subject.episodeCount);
  } else {
    const fetchedEps = await fetchBangumiMainEpisodes(
      subject.id,
      outbound,
      apiBaseUrl,
      options.timeoutMs,
    );
    if (!fetchedEps.ok) {
      return {
        status: "transient_error",
        reason: fetchedEps.transientReason,
      };
    }
    featureEpisodeCount = fetchedEps.total;
    featureEpisodes = fetchedEps.episodes;
  }

  const externalIds: Partial<Record<Namespace, string>> | undefined = subject.imdbId
    ? { imdb: subject.imdbId }
    : undefined;

  return {
    status: "found",
    info: {
      namespace: "bangumi",
      canonicalId: subject.id,
      title: subject.title,
      ...(subject.originalTitle ? { originalTitle: subject.originalTitle } : {}),
      ...(subject.aliases.length > 0 ? { aliases: subject.aliases } : {}),
      year: subject.year,
      mediaType: subject.mediaType,
      featureEpisodeCount,
      featureEpisodes,
      ...(externalIds ? { externalIds } : {}),
    },
  };
}

export const bangumiAdapter: Tier2Adapter<"bangumi"> = {
  namespace: "bangumi",
  tier: 2,

  parseInput: parseBangumiInput,

  async canonicalize(raw) {
    const parsed = parseBangumiInput(raw);
    if (!parsed || parsed.canonicalId === null) {
      throw new InvalidNativeIdError(
        "bangumi",
        raw,
        "Expected Bangumi numeric subject ID or bgm.tv / bangumi.tv / chii.in subject URL",
      );
    }
    return parsed.canonicalId;
  },

  fetchCollection(canonicalId, outbound): Promise<CollectionEvidenceResult> {
    return fetchBangumiCollection(canonicalId, outbound);
  },
};
