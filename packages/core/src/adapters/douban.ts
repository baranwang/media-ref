import type { MediaType, Namespace } from "@media-ref/client";
import type { ExternalHttpResponse, OutboundClient } from "../outbound.ts";
import {
  InvalidNativeIdError,
  type CollectionEvidenceResult,
  type FeatureEpisode,
  type ParsedNativeIdInput,
  type Tier2Adapter,
} from "./types.ts";

const DOUBAN_SUBJECT_ID_PATTERN = /^[1-9]\d*$/;
const DOUBAN_DESKTOP_HOSTS = new Set(["movie.douban.com", "www.douban.com", "douban.com"]);
const DOUBAN_MOBILE_HOSTS = new Set(["m.douban.com"]);
const DOUBAN_DESKTOP_PATH_PATTERN = /^\/subject\/([1-9]\d*)\/?$/;
const DOUBAN_MOBILE_PATH_PATTERN = /^\/(?:movie\/)?subject\/([1-9]\d*)\/?$/;
const IMDB_ID_PATTERN = /\b(tt\d+)\b/i;

export const DEFAULT_DOUBAN_API_BASE_URL = "https://m.douban.com/rexxar/api/v2/movie";

export interface DoubanFetchOptions {
  apiBaseUrl?: string;
  timeoutMs?: number;
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

function parseDoubanYear(record: Record<string, unknown>): number | null {
  const direct = parseFourDigitYear(record.year);
  if (direct !== null) {
    return direct;
  }

  if (Array.isArray(record.pubdate)) {
    for (const entry of record.pubdate) {
      const fromPubdate = parseFourDigitYear(entry);
      if (fromPubdate !== null) {
        return fromPubdate;
      }
    }
  }

  return parseFourDigitYear(record.card_subtitle);
}

function parseImdbId(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const match = raw.trim().match(IMDB_ID_PATTERN);
  return match ? match[1]!.toLowerCase() : null;
}

function extractDoubanExternalIds(
  record: Record<string, unknown>,
): Partial<Record<Namespace, string>> | undefined {
  const direct =
    parseImdbId(record.imdb) ??
    parseImdbId(record.imdb_id) ??
    (record.external_ids &&
    typeof record.external_ids === "object" &&
    !Array.isArray(record.external_ids)
      ? (parseImdbId((record.external_ids as Record<string, unknown>).imdb) ??
        parseImdbId((record.external_ids as Record<string, unknown>).imdb_id))
      : null);

  return direct ? { imdb: direct } : undefined;
}

function collectDoubanAliases(
  record: Record<string, unknown>,
  primaryTitle: string,
  originalTitle: string | null,
): string[] {
  const seen = new Set<string>([primaryTitle]);
  if (originalTitle) {
    seen.add(originalTitle);
  }
  const aliases: string[] = [];

  const add = (value: unknown) => {
    const str = nonEmptyString(value);
    if (!str || seen.has(str)) {
      return;
    }
    seen.add(str);
    aliases.push(str);
  };

  if (Array.isArray(record.aka)) {
    for (const entry of record.aka) {
      add(entry);
    }
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

export function parseDoubanInput(raw: string): ParsedNativeIdInput | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (DOUBAN_SUBJECT_ID_PATTERN.test(trimmed)) {
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
  const pathname = parsedUrl.pathname;

  if (DOUBAN_MOBILE_HOSTS.has(host)) {
    const match = pathname.match(DOUBAN_MOBILE_PATH_PATTERN);
    if (match) {
      const id = match[1]!;
      return { kind: "subject", id, canonicalId: id };
    }
    return null;
  }

  if (DOUBAN_DESKTOP_HOSTS.has(host)) {
    const match = pathname.match(DOUBAN_DESKTOP_PATH_PATTERN);
    if (match) {
      const id = match[1]!;
      return { kind: "subject", id, canonicalId: id };
    }
    return null;
  }

  return null;
}

export async function fetchDoubanCollection(
  canonicalId: string,
  outbound: OutboundClient,
  options: DoubanFetchOptions = {},
): Promise<CollectionEvidenceResult> {
  const subjectId = canonicalId.trim();
  if (!DOUBAN_SUBJECT_ID_PATTERN.test(subjectId)) {
    return { status: "not_found", reason: "invalid_canonical_id" };
  }

  const baseUrl = (options.apiBaseUrl ?? DEFAULT_DOUBAN_API_BASE_URL).replace(/\/+$/, "");
  const url = `${baseUrl}/${encodeURIComponent(subjectId)}`;
  const referer = `https://m.douban.com/movie/subject/${encodeURIComponent(subjectId)}/`;

  let response: ExternalHttpResponse;
  try {
    response = await outbound.fetchExternal({
      kind: "catalog",
      namespace: "douban",
      url,
      method: "GET",
      headers: {
        referer,
        accept: "application/json",
      },
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    return {
      status: "transient_error",
      reason: error instanceof Error ? error.message : "douban_request_failed",
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
  if (record.code === 404) {
    return {
      status: "not_found",
      reason: nonEmptyString(record.msg) ?? "douban_not_found",
    };
  }

  const title = nonEmptyString(record.title) ?? nonEmptyString(record.original_title);
  if (!title) {
    return { status: "transient_error", reason: "missing_title" };
  }

  const originalTitle = nonEmptyString(record.original_title);
  const aliases = collectDoubanAliases(record, title, originalTitle);
  const year = parseDoubanYear(record);
  const mediaType: MediaType =
    record.is_tv === true || record.type === "tv" || record.subtype === "tv" ? "tv" : "movie";

  let featureEpisodeCount: number | null;
  let featureEpisodes: FeatureEpisode[];
  if (mediaType === "movie") {
    featureEpisodeCount = 1;
    featureEpisodes = [{ index: 1 }];
  } else {
    const episodesCount = parsePositiveInt(record.episodes_count ?? record.episode_count);
    featureEpisodeCount = episodesCount;
    featureEpisodes = episodesCount !== null ? buildOrdinalEpisodes(episodesCount) : [];
  }

  const externalIds = extractDoubanExternalIds(record);

  return {
    status: "found",
    info: {
      namespace: "douban",
      canonicalId: subjectId,
      title,
      ...(originalTitle ? { originalTitle } : {}),
      ...(aliases.length > 0 ? { aliases } : {}),
      year,
      mediaType,
      featureEpisodeCount,
      featureEpisodes,
      ...(externalIds ? { externalIds } : {}),
    },
  };
}

export const doubanAdapter: Tier2Adapter<"douban"> = {
  namespace: "douban",
  tier: 2,

  parseInput: parseDoubanInput,

  async canonicalize(raw) {
    const parsed = parseDoubanInput(raw);
    if (!parsed || parsed.canonicalId === null) {
      throw new InvalidNativeIdError(
        "douban",
        raw,
        "Expected Douban numeric subject ID or movie.douban.com / m.douban.com / www.douban.com subject URL",
      );
    }
    return parsed.canonicalId;
  },

  fetchCollection(canonicalId, outbound): Promise<CollectionEvidenceResult> {
    return fetchDoubanCollection(canonicalId, outbound);
  },
};
