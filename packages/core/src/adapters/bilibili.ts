import type { MediaType } from "@media-ref/client";
import type { ExternalHttpResponse, OutboundClient } from "../outbound.ts";
import { selectBroadcastEpisodes } from "./variety.ts";
import {
  AdapterTransientError,
  InvalidNativeIdError,
  type AdapterSearchCandidate,
  type AdapterSearchQuery,
  type AdapterSearchResult,
  type CollectionEvidenceResult,
  type FeatureEpisode,
  type ParsedNativeIdInput,
  type Tier3Adapter,
} from "./types.ts";

const BILIBILI_ALLOWED_HOSTS = new Set([
  "bilibili.com",
  "www.bilibili.com",
  "m.bilibili.com",
  "bangumi.bilibili.com",
]);

const BARE_SEASON_PATTERN = /^ss([1-9]\d*)$/i;
const BARE_EPISODE_PATTERN = /^ep([1-9]\d*)$/i;
const BARE_MEDIA_PATTERN = /^md([1-9]\d*)$/i;

const URL_SEASON_PATH_PATTERN = /^\/bangumi\/play\/ss([1-9]\d*)\/?$/i;
const URL_EPISODE_PATH_PATTERN = /^\/bangumi\/play\/ep([1-9]\d*)\/?$/i;
const URL_MEDIA_PATH_PATTERN = /^\/bangumi\/media\/md([1-9]\d*)\/?$/i;

const BILIBILI_API_HEADERS: Record<string, string> = {
  referer: "https://www.bilibili.com/",
  accept: "application/json",
};

const BILIBILI_SEASON_API = "https://api.bilibili.com/pgc/view/web/season";
const BILIBILI_MEDIA_API = "https://api.bilibili.com/pgc/review/user";
const BILIBILI_MEDIA_DETAIL_API = "https://api.bilibili.com/pgc/view/web/media";
const BILIBILI_SEARCH_API = "https://api.bilibili.com/x/web-interface/search/type";
const BILIBILI_SEARCH_TYPES = ["media_bangumi", "media_ft"] as const;
const CST_OFFSET_MS = 8 * 60 * 60 * 1000;

function buildBilibiliSearchHeaders(): Record<string, string> {
  const rawUuid =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().toUpperCase()
      : "00000000-0000-4000-8000-000000000000";
  return {
    referer: "https://search.bilibili.com/",
    accept: "application/json",
    cookie: `buvid3=${rawUuid}infoc`,
  };
}

function stripBilibiliHighlightHtml(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const withoutTags = raw.replace(/<\/?[^>]+>/g, "");
  const decoded = withoutTags
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&nbsp;", " ");
  const trimmed = decoded.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseUnixYear(rawTimestamp: unknown): number | null {
  if (typeof rawTimestamp !== "number" || !Number.isFinite(rawTimestamp) || rawTimestamp <= 0) {
    return null;
  }
  const ms = rawTimestamp > 1e12 ? rawTimestamp : rawTimestamp * 1000;
  const date = new Date(ms + CST_OFFSET_MS);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const year = date.getUTCFullYear();
  return Number.isInteger(year) && year >= 1800 && year <= 3000 ? year : null;
}

function parseRetryAfterMs(headers: Record<string, string>): number | undefined {
  const raw = headers["retry-after"];
  if (!raw) {
    return undefined;
  }
  const seconds = Number.parseInt(raw.trim(), 10);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }
  return undefined;
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

function mapBilibiliMediaType(rawType: unknown): MediaType | null {
  const num = typeof rawType === "number" ? rawType : parsePositiveInt(rawType);
  if (num === null) {
    return null;
  }
  if (num === 2) {
    return "movie";
  }
  if (num === 1 || num === 3 || num === 4 || num === 5 || num === 7) {
    return "tv";
  }
  return null;
}

function parseDurationSeconds(rawDuration: unknown): number | null {
  if (typeof rawDuration !== "number" || !Number.isFinite(rawDuration) || rawDuration <= 0) {
    return null;
  }
  // Bilibili pgc season API returns episode duration in milliseconds (e.g. 1435000)
  return rawDuration >= 10_000 ? Math.round(rawDuration / 1000) : Math.round(rawDuration);
}

function parseUnixDate(rawTimestamp: unknown): string | null {
  if (typeof rawTimestamp !== "number" || !Number.isFinite(rawTimestamp) || rawTimestamp <= 0) {
    return null;
  }
  const ms = rawTimestamp > 1e12 ? rawTimestamp : rawTimestamp * 1000;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

const GENERIC_SEASON_TITLE_PATTERN =
  /^(?:第[0-9一二三四五六七八九十百]+[季部期篇]|season\s*\d+|part\s*\d+|s\d{1,2}|tv版?|ova|正片|全集)$/iu;

function collectAliases(result: Record<string, unknown>, primaryTitle: string): string[] {
  const seen = new Set<string>([primaryTitle]);
  const aliases: string[] = [];

  const addCandidate = (value: unknown) => {
    const str = nonEmptyString(value);
    if (!str || seen.has(str)) {
      return;
    }
    seen.add(str);
    aliases.push(str);
  };

  addCandidate(result.jp_title);

  const seasonTitle = nonEmptyString(result.season_title);
  if (seasonTitle && !GENERIC_SEASON_TITLE_PATTERN.test(seasonTitle)) {
    addCandidate(seasonTitle);
  }

  const series = result.series;
  if (series && typeof series === "object" && !Array.isArray(series)) {
    addCandidate((series as Record<string, unknown>).series_title);
  }

  const rawAlias = nonEmptyString(result.alias);
  if (rawAlias) {
    addCandidate(rawAlias);
    for (const part of rawAlias.split(/[/／、,，|;；]/)) {
      addCandidate(part);
    }
  }

  return aliases;
}

function extractFeatureEpisodes(rawEpisodes: unknown): FeatureEpisode[] | null {
  if (!Array.isArray(rawEpisodes)) {
    return null;
  }

  const episodes: FeatureEpisode[] = [];
  for (const item of rawEpisodes) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const ep = item as Record<string, unknown>;
    const sectionType = ep.section_type;
    if (sectionType !== undefined && sectionType !== 0) {
      continue;
    }

    const badge = nonEmptyString(ep.badge);
    const badgeType = ep.badge_type;
    if (badge === "预告" || badge === "花絮" || badgeType === 1) {
      continue;
    }

    const nativeIdNum = parsePositiveInt(ep.id ?? ep.ep_id);
    episodes.push({
      index: episodes.length + 1,
      ...(nativeIdNum !== null ? { nativeEpisodeId: String(nativeIdNum) } : {}),
      ...(nonEmptyString(ep.title) ? { title: nonEmptyString(ep.title)! } : {}),
      ...(nonEmptyString(ep.long_title) ? { longTitle: nonEmptyString(ep.long_title)! } : {}),
      durationSeconds: parseDurationSeconds(ep.duration),
      airDate: parseUnixDate(ep.pub_time),
    });
  }

  return episodes;
}

function parseBilibiliJsonEnvelope(
  response: ExternalHttpResponse,
):
  | { ok: true; code: number; message: string | null; result: unknown }
  | { ok: false; transientReason: string } {
  if (response.status === 404) {
    return { ok: true, code: -404, message: "http_404", result: null };
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
  if (typeof record.code !== "number") {
    return { ok: false, transientReason: "missing_code" };
  }

  return {
    ok: true,
    code: record.code,
    message: nonEmptyString(record.message),
    result: record.result,
  };
}

function isBilibiliNotFoundCode(code: number): boolean {
  return code === -404 || code === -400;
}

export function parseBilibiliInput(raw: string): ParsedNativeIdInput | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const seasonMatch = trimmed.match(BARE_SEASON_PATTERN);
  if (seasonMatch) {
    const id = seasonMatch[1]!;
    return { kind: "season", id, canonicalId: `ss${id}` };
  }

  const epMatch = trimmed.match(BARE_EPISODE_PATTERN);
  if (epMatch) {
    return { kind: "episode", id: epMatch[1]!, canonicalId: null };
  }

  const mdMatch = trimmed.match(BARE_MEDIA_PATTERN);
  if (mdMatch) {
    return { kind: "media", id: mdMatch[1]!, canonicalId: null };
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
  if (!BILIBILI_ALLOWED_HOSTS.has(host)) {
    return null;
  }

  const pathname = parsedUrl.pathname;
  const urlSeasonMatch = pathname.match(URL_SEASON_PATH_PATTERN);
  if (urlSeasonMatch) {
    const id = urlSeasonMatch[1]!;
    return { kind: "season", id, canonicalId: `ss${id}` };
  }

  const urlEpMatch = pathname.match(URL_EPISODE_PATH_PATTERN);
  if (urlEpMatch) {
    return { kind: "episode", id: urlEpMatch[1]!, canonicalId: null };
  }

  const urlMdMatch = pathname.match(URL_MEDIA_PATH_PATTERN);
  if (urlMdMatch) {
    return { kind: "media", id: urlMdMatch[1]!, canonicalId: null };
  }

  return null;
}

async function resolveSeasonIdFromEpisode(
  rawInput: string,
  episodeId: string,
  outbound: OutboundClient,
): Promise<string> {
  const url = `${BILIBILI_SEASON_API}?ep_id=${encodeURIComponent(episodeId)}`;
  let response: ExternalHttpResponse;
  try {
    response = await outbound.fetchExternal({
      kind: "platform",
      namespace: "bilibili",
      url,
      method: "GET",
      headers: BILIBILI_API_HEADERS,
    });
  } catch (error) {
    throw new AdapterTransientError(
      "bilibili",
      error instanceof Error ? error.message : "Failed to fetch Bilibili episode metadata",
    );
  }

  const envelope = parseBilibiliJsonEnvelope(response);
  if (!envelope.ok) {
    throw new AdapterTransientError("bilibili", envelope.transientReason);
  }
  if (isBilibiliNotFoundCode(envelope.code)) {
    throw new InvalidNativeIdError(
      "bilibili",
      rawInput,
      envelope.message ?? `Bilibili episode ep${episodeId} not found`,
    );
  }
  if (envelope.code !== 0) {
    throw new AdapterTransientError("bilibili", `bilibili_code_${envelope.code}`);
  }

  const result = envelope.result;
  const seasonId =
    result && typeof result === "object" && !Array.isArray(result)
      ? parsePositiveInt((result as Record<string, unknown>).season_id)
      : null;

  if (seasonId === null) {
    throw new InvalidNativeIdError(
      "bilibili",
      rawInput,
      `Bilibili episode ep${episodeId} response did not contain a valid season_id`,
    );
  }

  return `ss${seasonId}`;
}

async function resolveSeasonIdFromMedia(
  rawInput: string,
  mediaId: string,
  outbound: OutboundClient,
): Promise<string> {
  const url = `${BILIBILI_MEDIA_API}?media_id=${encodeURIComponent(mediaId)}`;
  let response: ExternalHttpResponse;
  try {
    response = await outbound.fetchExternal({
      kind: "platform",
      namespace: "bilibili",
      url,
      method: "GET",
      headers: BILIBILI_API_HEADERS,
    });
  } catch (error) {
    throw new AdapterTransientError(
      "bilibili",
      error instanceof Error ? error.message : "Failed to fetch Bilibili media metadata",
    );
  }

  const envelope = parseBilibiliJsonEnvelope(response);
  if (!envelope.ok) {
    throw new AdapterTransientError("bilibili", envelope.transientReason);
  }
  if (isBilibiliNotFoundCode(envelope.code)) {
    throw new InvalidNativeIdError(
      "bilibili",
      rawInput,
      envelope.message ?? `Bilibili media md${mediaId} not found`,
    );
  }
  if (envelope.code !== 0) {
    throw new AdapterTransientError("bilibili", `bilibili_code_${envelope.code}`);
  }

  const result = envelope.result;
  const mediaRecord =
    result && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>).media
      : null;
  const seasonId =
    mediaRecord && typeof mediaRecord === "object" && !Array.isArray(mediaRecord)
      ? parsePositiveInt((mediaRecord as Record<string, unknown>).season_id)
      : null;

  if (seasonId === null) {
    throw new InvalidNativeIdError(
      "bilibili",
      rawInput,
      `Bilibili media md${mediaId} response did not contain a valid season_id`,
    );
  }

  return `ss${seasonId}`;
}

/**
 * The premiere year from the media detail (`publish.pub_date`, e.g. 死侍2 2018-05-18), or null.
 * The season's own `publish.pub_time` is when Bilibili listed it, years later for licensed titles.
 * Best effort: any failure leaves the season's year in place.
 */
async function fetchPremiereYear(
  mediaId: unknown,
  outbound: OutboundClient,
): Promise<number | null> {
  const id = parsePositiveInt(mediaId);
  if (id === null) {
    return null;
  }
  try {
    const response = await outbound.fetchExternal({
      kind: "platform",
      namespace: "bilibili",
      url: `${BILIBILI_MEDIA_DETAIL_API}?media_id=${id}`,
      method: "GET",
      headers: BILIBILI_API_HEADERS,
    });
    const envelope = parseBilibiliJsonEnvelope(response);
    if (!envelope.ok || envelope.code !== 0) {
      return null;
    }
    const publish = (envelope.result as { publish?: { pub_date?: unknown } } | null)?.publish;
    return parseFourDigitYear(publish?.pub_date);
  } catch {
    return null;
  }
}

export const bilibiliAdapter: Tier3Adapter<"bilibili"> = {
  namespace: "bilibili",
  tier: 3,

  parseInput: parseBilibiliInput,

  async canonicalize(raw, outbound) {
    const parsed = parseBilibiliInput(raw);
    if (!parsed) {
      throw new InvalidNativeIdError(
        "bilibili",
        raw,
        "Expected Bilibili bangumi ID (ss<id>, ep<id>, md<id>) or bangumi URL",
      );
    }

    if (parsed.canonicalId !== null) {
      return parsed.canonicalId;
    }

    if (parsed.kind === "episode") {
      return resolveSeasonIdFromEpisode(raw, parsed.id, outbound);
    }

    if (parsed.kind === "media") {
      return resolveSeasonIdFromMedia(raw, parsed.id, outbound);
    }

    throw new InvalidNativeIdError("bilibili", raw, `Unsupported Bilibili input kind`);
  },

  async fetchCollection(canonicalId, outbound): Promise<CollectionEvidenceResult> {
    const match = canonicalId.trim().match(BARE_SEASON_PATTERN);
    if (!match) {
      return { status: "not_found", reason: "invalid_canonical_id" };
    }

    const seasonId = match[1]!;
    const url = `${BILIBILI_SEASON_API}?season_id=${encodeURIComponent(seasonId)}`;

    let response: ExternalHttpResponse;
    try {
      response = await outbound.fetchExternal({
        kind: "platform",
        namespace: "bilibili",
        url,
        method: "GET",
        headers: BILIBILI_API_HEADERS,
      });
    } catch (error) {
      return {
        status: "transient_error",
        reason: error instanceof Error ? error.message : "bilibili_request_failed",
      };
    }

    const envelope = parseBilibiliJsonEnvelope(response);
    if (!envelope.ok) {
      return {
        status: "transient_error",
        reason: envelope.transientReason,
      };
    }

    if (isBilibiliNotFoundCode(envelope.code)) {
      return {
        status: "not_found",
        reason: envelope.message ?? `bilibili_code_${envelope.code}`,
      };
    }

    if (envelope.code !== 0) {
      return {
        status: "transient_error",
        reason: `bilibili_code_${envelope.code}`,
      };
    }

    if (!envelope.result || typeof envelope.result !== "object" || Array.isArray(envelope.result)) {
      return {
        status: "transient_error",
        reason: "missing_result",
      };
    }

    const result = envelope.result as Record<string, unknown>;
    const title = nonEmptyString(result.title) ?? nonEmptyString(result.season_title);
    if (!title) {
      return {
        status: "transient_error",
        reason: "missing_title",
      };
    }

    const publish =
      result.publish && typeof result.publish === "object" && !Array.isArray(result.publish)
        ? (result.publish as Record<string, unknown>)
        : null;
    const year =
      (await fetchPremiereYear(result.media_id, outbound)) ??
      parseFourDigitYear(publish?.pub_time) ??
      parseFourDigitYear(publish?.pub_time_show);

    // `type` is the channel (番剧 also lists theatrical films); `show_season_type` is the display type.
    const mediaType = mapBilibiliMediaType(result.show_season_type ?? result.type);
    const extracted = extractFeatureEpisodes(result.episodes);
    const featureEpisodes = extracted !== null ? selectBroadcastEpisodes(extracted) : null;
    const aliases = collectAliases(result, title);
    const originalTitle = nonEmptyString(result.jp_title);

    return {
      status: "found",
      info: {
        namespace: "bilibili",
        canonicalId: `ss${seasonId}`,
        title,
        ...(originalTitle ? { originalTitle } : {}),
        ...(aliases.length > 0 ? { aliases } : {}),
        year,
        mediaType,
        featureEpisodeCount: featureEpisodes !== null ? featureEpisodes.length : null,
        featureEpisodes: featureEpisodes ?? [],
      },
    };
  },

  async search(query: AdapterSearchQuery, outbound: OutboundClient): Promise<AdapterSearchResult> {
    const keyword = query.title.trim();
    if (keyword.length === 0) {
      return { status: "ok", candidates: [] };
    }

    const page =
      query.page !== undefined && Number.isInteger(query.page) && query.page > 0 ? query.page : 1;
    const limit =
      query.limit !== undefined && Number.isInteger(query.limit) && query.limit > 0
        ? query.limit
        : null;

    const searchHeaders = buildBilibiliSearchHeaders();
    const seenCanonicalIds = new Set<string>();
    const candidates: AdapterSearchCandidate[] = [];

    for (const searchType of BILIBILI_SEARCH_TYPES) {
      const url = `${BILIBILI_SEARCH_API}?search_type=${encodeURIComponent(searchType)}&keyword=${encodeURIComponent(keyword)}&page=${page}`;
      let response: ExternalHttpResponse;
      try {
        response = await outbound.fetchExternal({
          kind: "platform",
          namespace: "bilibili",
          url,
          method: "GET",
          headers: searchHeaders,
        });
      } catch (error) {
        return {
          status: "transient_error",
          reason: error instanceof Error ? error.message : "bilibili_search_request_failed",
        };
      }

      if (response.status < 200 || response.status >= 300) {
        const retryAfterMs =
          response.status === 429 ? parseRetryAfterMs(response.headers) : undefined;
        return {
          status: "transient_error",
          reason: `http_${response.status}`,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(response.body);
      } catch {
        return {
          status: "transient_error",
          reason: "invalid_json",
        };
      }

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {
          status: "transient_error",
          reason: "unexpected_payload",
        };
      }

      const envelope = parsed as Record<string, unknown>;
      if (typeof envelope.code !== "number") {
        return {
          status: "transient_error",
          reason: "missing_code",
        };
      }

      if (envelope.code !== 0) {
        return {
          status: "transient_error",
          reason: `bilibili_code_${envelope.code}`,
        };
      }

      const data =
        envelope.data && typeof envelope.data === "object" && !Array.isArray(envelope.data)
          ? (envelope.data as Record<string, unknown>)
          : null;
      const rawResults = data?.result;
      if (!Array.isArray(rawResults)) {
        continue;
      }

      for (const item of rawResults) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          continue;
        }
        const record = item as Record<string, unknown>;
        const seasonId = parsePositiveInt(record.season_id);
        if (seasonId === null) {
          continue;
        }

        const canonicalId = `ss${seasonId}`;
        if (seenCanonicalIds.has(canonicalId)) {
          continue;
        }

        const title = stripBilibiliHighlightHtml(record.title);
        if (!title) {
          continue;
        }

        seenCanonicalIds.add(canonicalId);

        const originalTitle = stripBilibiliHighlightHtml(record.org_title);
        const year = parseUnixYear(record.pubtime);
        const mediaType =
          mapBilibiliMediaType(record.media_type ?? record.season_type) ??
          (searchType === "media_bangumi" ? "tv" : null);

        const epSize = parsePositiveInt(record.ep_size);
        const epsLength =
          Array.isArray(record.eps) && record.eps.length > 0 ? record.eps.length : null;
        const episodeCount = epSize ?? epsLength;

        const itemUrl =
          nonEmptyString(record.url) ?? `https://www.bilibili.com/bangumi/play/${canonicalId}`;

        candidates.push({
          canonicalId,
          title,
          ...(originalTitle ? { originalTitle } : {}),
          year,
          mediaType,
          episodeCount,
          url: itemUrl,
        });

        if (limit !== null && candidates.length >= limit) {
          return { status: "ok", candidates };
        }
      }
    }

    return { status: "ok", candidates };
  },
};
