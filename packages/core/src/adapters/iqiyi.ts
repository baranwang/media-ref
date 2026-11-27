import type { MediaType } from "@media-ref/client";
import { createHash } from "node:crypto";
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

/**
 * iQIYI (`iqiyi`) Platform Adapter (Tier 1, Tier 2 & Tier 3).
 *
 * Canonical ID (`canonicalId`):
 * - Numeric `qipuId` / `albumId` string matching `/^[1-9]\d{5,}$/` (typically 9-16 digits):
 *   - Multi-episode collections (TV drama, anime, documentary, variety, kids) use `albumId`,
 *     whose digits end in `01` (e.g. `5328486914190101` for 狂飙, `202861101` for 航海王).
 *   - Single movies use `tvId` (which `video/video/baseinfo` also returns as `albumId === tvId`),
 *     whose digits end in `00` (e.g. `923452300` for 流浪地球, `7292991076670500` for 流浪地球2).
 *
 * Tier 1 URL & ID Conversion Rules:
 * - Bare numeric `qipuId` / `albumId` (`/^[1-9]\d{5,}$/`) -> canonical directly (no outbound call).
 * - Album URLs (`https://www.iqiyi.com/a_<hash>.html`, `https://m.iqiyi.com/a_<hash>.html`,
 *   `http://iqiyi.com/a_<hash>.html`, or bare `a_<hash>`):
 *   - Fetch desktop SSR HTML `https://www.iqiyi.com/a_<hash>.html` via `OutboundClient`
 *     (`kind: "platform"`, `namespace: "iqiyi"`), extracting `"albumId"` (or fallback `"qipuId"`).
 * - Video / share URLs (`https://www.iqiyi.com/v_<hash>.html`, `https://m.iqiyi.com/v_<hash>.html`,
 *   `http://iqiyi.com/v_<hash>.html`, or bare `v_<hash>`):
 *   - Desktop `www.iqiyi.com/v_<hash>.html` returns a 48 KB SPA shell without IDs, so rewrite host
 *     to mobile SSR `https://m.iqiyi.com/v_<hash>.html` with a mobile User-Agent.
 *   - Extract `"albumId"` directly when present; otherwise extract `"qipuId"` / `"tvId"` and
 *     normalize via `GET https://pcw-api.iqiyi.com/video/video/baseinfo/<qipuId>` -> `data.albumId`.
 * - Unrecognized hosts/paths, non-album/video URLs, HTTP 404/410, or pages lacking a valid
 *   `albumId` / `qipuId` throw `InvalidNativeIdError`.
 *
 * Tier 2 Metadata & Feature Episodes (`fetchCollection`):
 * - TV/series albums:
 *   - `GET https://pcw-api.iqiyi.com/album/album/baseinfo/<id>` for title, `channelId`, and premiere
 *     year from `firstVideo.period` or CST (`UTC+8`) year of `publishTime` (never `data.period`
 *     on TV albums, because `data.period` holds the latest episode air date).
 *   - `GET https://pcw-api.iqiyi.com/albums/album/avlistinfo?aid=<id>&page=<p>&size=50` paginating
 *     `data.epsodelist` and keeping only `contentType === 1` feature episodes.
 * - Movies (`id` ending in `00`, or fallback when `album/album/baseinfo` returns `A00001`):
 *   - `GET https://pcw-api.iqiyi.com/video/video/baseinfo/<id>` for title, `channelId`, release
 *     year (`period` / `publishTime`), and 1 feature item.
 *
 * Tier 3 Search (`search`, Ticket #30):
 * - Unauthenticated `GET https://search.video.iqiyi.com/o?if=html5&key=<keyword>&pageNum=<page>&pageSize=<size>&site=iqiyi`.
 * - Parses `data.docinfos[].albumDocInfo`, filtering strictly to `siteId === "iqiyi"` and valid
 *   numeric `albumId` / `qipu_id`, deduplicating by `canonicalId`, and mapping `channel`,
 *   `releaseDate`, and `itemTotalNumber`.
 */

const IQIYI_ALLOWED_HOSTS = new Set(["iqiyi.com", "www.iqiyi.com", "m.iqiyi.com"]);

const BARE_QIPU_PATTERN = /^[1-9]\d{5,}$/;
const BARE_ALBUM_HASH_PATTERN = /^a_([A-Za-z0-9]{4,})$/;
const BARE_VIDEO_HASH_PATTERN = /^v_([A-Za-z0-9]{4,})$/;

const URL_ALBUM_PATH_PATTERN = /^\/a_([A-Za-z0-9]+)\.html$/;
const URL_VIDEO_PATH_PATTERN = /^\/v_([A-Za-z0-9]+)\.html$/;

const IQIYI_DESKTOP_ALBUM_BASE = "https://www.iqiyi.com";
const IQIYI_MOBILE_VIDEO_BASE = "https://m.iqiyi.com";
const IQIYI_ALBUM_BASEINFO_API = "https://pcw-api.iqiyi.com/album/album/baseinfo";
const IQIYI_ALBUM_AVLIST_API = "https://pcw-api.iqiyi.com/albums/album/avlistinfo";
const IQIYI_VIDEO_BASEINFO_API = "https://pcw-api.iqiyi.com/video/video/baseinfo";
const IQIYI_SEARCH_API = "https://search.video.iqiyi.com/o";

const IQIYI_AVLIST_PAGE_SIZE = 50;
const IQIYI_MAX_AVLIST_PAGES = 100;
const IQIYI_SEARCH_DEFAULT_PAGE_SIZE = 10;
const IQIYI_SEARCH_MAX_PAGE_SIZE = 20;
const CST_OFFSET_MS = 8 * 60 * 60 * 1000;

const IQIYI_TV_CHANNEL_NAMES = new Set(["电视剧", "纪录片", "动漫", "综艺", "儿童", "少儿"]);

const IQIYI_API_HEADERS: Record<string, string> = {
  referer: "https://www.iqiyi.com/",
  accept: "application/json",
};

const IQIYI_DESKTOP_HTML_HEADERS: Record<string, string> = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  referer: "https://www.iqiyi.com/",
};

const IQIYI_MOBILE_HTML_HEADERS: Record<string, string> = {
  "user-agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  referer: "https://m.iqiyi.com/",
};

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function parsePositiveIdString(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return String(value);
  }
  return typeof value === "string" && /^[1-9]\d*$/.test(value.trim()) ? value.trim() : null;
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

function parseQipuId(value: unknown): string | null {
  if (typeof value === "number") {
    if (Number.isInteger(value) && Number.isSafeInteger(value) && value >= 100_000) {
      return String(value);
    }
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (BARE_QIPU_PATTERN.test(trimmed)) {
      return trimmed;
    }
  }
  return null;
}

function parseFourDigitYear(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isInteger(raw)) {
    return raw >= 1800 && raw <= 3000 ? raw : null;
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

function parseTimestampYearCst(raw: unknown): number | null {
  let num: number | null = null;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    num = raw;
  } else if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      num = parsed;
    }
  }
  if (num === null) {
    return null;
  }
  const ms = num > 1e11 ? num : num > 1e8 ? num * 1000 : null;
  if (ms === null) {
    return null;
  }
  const date = new Date(ms + CST_OFFSET_MS);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const year = date.getUTCFullYear();
  return year >= 1800 && year <= 3000 ? year : null;
}

function parseDateString(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  const hyphenMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (hyphenMatch) {
    return `${hyphenMatch[1]}-${hyphenMatch[2]}-${hyphenMatch[3]}`;
  }
  const compactMatch = trimmed.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compactMatch) {
    return `${compactMatch[1]}-${compactMatch[2]}-${compactMatch[3]}`;
  }
  return null;
}

function parseTimestampDateCst(raw: unknown): string | null {
  let num: number | null = null;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    num = raw;
  } else if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      num = parsed;
    }
  }
  if (num === null) {
    return null;
  }
  const ms = num > 1e11 ? num : num > 1e8 ? num * 1000 : null;
  if (ms === null) {
    return null;
  }
  const date = new Date(ms + CST_OFFSET_MS);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

function parseDurationSeconds(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.round(raw);
  }
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const secs = Number(trimmed);
    return Number.isFinite(secs) && secs > 0 ? Math.round(secs) : null;
  }
  const parts = trimmed.split(":");
  if (parts.length === 2 || parts.length === 3) {
    const nums = parts.map((p) => Number(p));
    if (nums.every((n) => Number.isInteger(n) && n >= 0)) {
      const total =
        parts.length === 3 ? nums[0]! * 3600 + nums[1]! * 60 + nums[2]! : nums[0]! * 60 + nums[1]!;
      return total > 0 ? total : null;
    }
  }
  return null;
}

function mapIqiyiMediaType(rawChannelId: unknown): MediaType | null {
  const channelId =
    typeof rawChannelId === "number" ? rawChannelId : parsePositiveInt(rawChannelId);
  if (channelId === null) {
    return null;
  }
  if (channelId === 1) {
    return "movie";
  }
  if (
    channelId === 2 ||
    channelId === 3 ||
    channelId === 4 ||
    channelId === 6 ||
    channelId === 15
  ) {
    return "tv";
  }
  return null;
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

function parseHttpUrl(raw: unknown): string | null {
  const value = nonEmptyString(raw);
  if (!value) {
    return null;
  }
  return /^https?:\/\//i.test(value) ? value : null;
}

function mapIqiyiSearchChannel(rawChannel: unknown): MediaType | null {
  if (typeof rawChannel === "number") {
    return mapIqiyiMediaType(rawChannel);
  }
  const raw = nonEmptyString(rawChannel);
  if (!raw) {
    return null;
  }
  const parts = raw.split(/[,，]/).map((part) => part.trim());
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const mappedId = mapIqiyiMediaType(parts[i]);
    if (mappedId !== null) {
      return mappedId;
    }
  }
  const label = parts[0];
  if (label === "电影") {
    return "movie";
  }
  if (label && IQIYI_TV_CHANNEL_NAMES.has(label)) {
    return "tv";
  }
  return null;
}

function isFeatureContentType(rawContentType: unknown): boolean {
  return rawContentType === 1 || rawContentType === "1";
}

function collectAliases(data: Record<string, unknown>, primaryTitle: string): string[] {
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

  addCandidate(data.englishName);
  addCandidate(data.originName);
  addCandidate(data.originalName);
  addCandidate(data.secondTitle);

  const rawAlias = nonEmptyString(data.alias);
  if (rawAlias) {
    addCandidate(rawAlias);
    for (const part of rawAlias.split(/[/／、,，|;；]/)) {
      addCandidate(part);
    }
  }

  return aliases;
}

function extractNamedIdFromHtml(
  html: string,
  fieldName: "albumId" | "qipuId" | "tvId",
): string | null {
  const patterns = [
    new RegExp(`["']${fieldName}["']\\s*:\\s*["']?([1-9]\\d{5,})["']?(?=[\\s,}\\];&]|$)`, "g"),
    new RegExp(
      `\\\\"${fieldName}\\\\"\\s*:\\s*(?:\\\\")?([1-9]\\d{5,})(?:\\\\")?(?=[\\s,}\\];\\\\]|$)`,
      "g",
    ),
    new RegExp(
      `(?<![A-Za-z0-9_$])${fieldName}\\s*[:=]\\s*["']?([1-9]\\d{5,})["']?(?=[\\s,}\\];&]|$)`,
      "g",
    ),
  ];

  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const candidate = match[1];
      if (candidate && BARE_QIPU_PATTERN.test(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function parseIqiyiApiEnvelope(
  response: ExternalHttpResponse,
):
  | { ok: true; code: string; data: unknown; errMsg: string | null }
  | { ok: false; transientReason: string } {
  if (response.status === 404) {
    return { ok: true, code: "A00001", data: null, errMsg: "http_404" };
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
  const code = nonEmptyString(record.code);
  if (!code) {
    return { ok: false, transientReason: "missing_code" };
  }

  return {
    ok: true,
    code,
    data: record.data,
    errMsg: nonEmptyString(record.errMsg) ?? nonEmptyString(record.msg),
  };
}

function isIqiyiNotFoundCode(code: string): boolean {
  return code === "A00001" || code === "A00004";
}

export function parseIqiyiInput(raw: string): ParsedNativeIdInput | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (BARE_QIPU_PATTERN.test(trimmed)) {
    return { kind: "qipu", id: trimmed, canonicalId: trimmed };
  }

  const bareAlbumMatch = trimmed.match(BARE_ALBUM_HASH_PATTERN);
  if (bareAlbumMatch) {
    return { kind: "album_page", id: bareAlbumMatch[1]!, canonicalId: null };
  }

  const bareVideoMatch = trimmed.match(BARE_VIDEO_HASH_PATTERN);
  if (bareVideoMatch) {
    return { kind: "video_page", id: bareVideoMatch[1]!, canonicalId: null };
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
  if (!IQIYI_ALLOWED_HOSTS.has(host)) {
    return null;
  }

  const pathname = parsedUrl.pathname;
  const albumMatch = pathname.match(URL_ALBUM_PATH_PATTERN);
  if (albumMatch) {
    return { kind: "album_page", id: albumMatch[1]!, canonicalId: null };
  }

  const videoMatch = pathname.match(URL_VIDEO_PATH_PATTERN);
  if (videoMatch) {
    return { kind: "video_page", id: videoMatch[1]!, canonicalId: null };
  }

  return null;
}

async function normalizeVideoQipuIdToAlbumId(
  rawInput: string,
  qipuId: string,
  outbound: OutboundClient,
): Promise<string> {
  const url = `${IQIYI_VIDEO_BASEINFO_API}/${encodeURIComponent(qipuId)}`;
  let response: ExternalHttpResponse;
  try {
    response = await outbound.fetchExternal({
      kind: "platform",
      namespace: "iqiyi",
      url,
      method: "GET",
      headers: IQIYI_API_HEADERS,
    });
  } catch (error) {
    throw new AdapterTransientError(
      "iqiyi",
      error instanceof Error ? error.message : "Failed to fetch iQIYI video baseinfo",
    );
  }

  const envelope = parseIqiyiApiEnvelope(response);
  if (!envelope.ok) {
    throw new AdapterTransientError("iqiyi", envelope.transientReason);
  }
  if (isIqiyiNotFoundCode(envelope.code)) {
    throw new InvalidNativeIdError(
      "iqiyi",
      rawInput,
      envelope.errMsg ?? `iQIYI video ${qipuId} not found`,
    );
  }
  if (envelope.code !== "A00000") {
    throw new AdapterTransientError("iqiyi", `iqiyi_code_${envelope.code}`);
  }

  const data = asRecord(envelope.data);
  const albumId = data ? parseQipuId(data.albumId) : null;
  if (!albumId) {
    throw new InvalidNativeIdError(
      "iqiyi",
      rawInput,
      `iQIYI video ${qipuId} baseinfo did not contain a valid albumId`,
    );
  }

  return albumId;
}

async function resolveAlbumPageToCanonicalId(
  rawInput: string,
  albumHash: string,
  outbound: OutboundClient,
): Promise<string> {
  const url = `${IQIYI_DESKTOP_ALBUM_BASE}/a_${encodeURIComponent(albumHash)}.html`;
  let response: ExternalHttpResponse;
  try {
    response = await outbound.fetchExternal({
      kind: "platform",
      namespace: "iqiyi",
      url,
      method: "GET",
      headers: IQIYI_DESKTOP_HTML_HEADERS,
    });
  } catch (error) {
    throw new AdapterTransientError(
      "iqiyi",
      error instanceof Error ? error.message : "Failed to fetch iQIYI album page",
    );
  }

  if (response.status === 404 || response.status === 410) {
    throw new InvalidNativeIdError(
      "iqiyi",
      rawInput,
      `iQIYI album page returned HTTP ${response.status}`,
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new AdapterTransientError("iqiyi", `http_${response.status}`);
  }

  const albumId =
    extractNamedIdFromHtml(response.body, "albumId") ??
    extractNamedIdFromHtml(response.body, "qipuId");

  if (!albumId) {
    throw new InvalidNativeIdError(
      "iqiyi",
      rawInput,
      "iQIYI album page did not contain a valid albumId or qipuId",
    );
  }

  return albumId;
}

async function resolveVideoPageToCanonicalId(
  rawInput: string,
  videoHash: string,
  outbound: OutboundClient,
): Promise<string> {
  // Rewrite www.iqiyi.com / iqiyi.com to m.iqiyi.com because desktop /v_<hash>.html returns
  // a 48 KB SPA shell without IDs, whereas mobile SSR embeds albumId and qipuId.
  const url = `${IQIYI_MOBILE_VIDEO_BASE}/v_${encodeURIComponent(videoHash)}.html`;
  let response: ExternalHttpResponse;
  try {
    response = await outbound.fetchExternal({
      kind: "platform",
      namespace: "iqiyi",
      url,
      method: "GET",
      headers: IQIYI_MOBILE_HTML_HEADERS,
    });
  } catch (error) {
    throw new AdapterTransientError(
      "iqiyi",
      error instanceof Error ? error.message : "Failed to fetch iQIYI mobile video page",
    );
  }

  if (response.status === 404 || response.status === 410) {
    throw new InvalidNativeIdError(
      "iqiyi",
      rawInput,
      `iQIYI video page returned HTTP ${response.status}`,
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new AdapterTransientError("iqiyi", `http_${response.status}`);
  }

  const albumId = extractNamedIdFromHtml(response.body, "albumId");
  if (albumId) {
    return albumId;
  }

  const qipuId =
    extractNamedIdFromHtml(response.body, "qipuId") ??
    extractNamedIdFromHtml(response.body, "tvId");
  if (!qipuId) {
    throw new InvalidNativeIdError(
      "iqiyi",
      rawInput,
      "iQIYI video page did not contain a valid albumId or qipuId",
    );
  }

  return normalizeVideoQipuIdToAlbumId(rawInput, qipuId, outbound);
}

type FetchAvListResult =
  | { status: "ok"; episodes: FeatureEpisode[] | null }
  | { status: "transient_error"; reason: string };

const IQIYI_LW_BASE_INFO_API = "https://www.iqiyi.com/prelw/tvg/v2/lw/base_info";
// Public signing secret of iQIYI's web client for the lw/tvg endpoints.
const IQIYI_LW_SECRET = "howcuteitis";
const IQIYI_PREVIEW_MARK = 17;

function signIqiyiLwParams(params: Record<string, string>): string {
  const base = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
  return createHash("md5")
    .update(`${base}&secret_key=${IQIYI_LW_SECRET}`)
    .digest("hex")
    .toUpperCase();
}

async function fetchIqiyiJson(
  url: string,
  outbound: OutboundClient,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; reason: string }> {
  let response: ExternalHttpResponse;
  try {
    response = await outbound.fetchExternal({
      kind: "platform",
      namespace: "iqiyi",
      url,
      method: "GET",
      headers: IQIYI_API_HEADERS,
    });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "iqiyi_request_failed" };
  }
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, reason: `http_${response.status}` };
  }
  try {
    const parsed = asRecord(JSON.parse(response.body));
    return parsed ? { ok: true, data: parsed } : { ok: false, reason: "unexpected_payload" };
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
}

/**
 * Broadcast list of a variety album: the signed `lw/base_info` page for one of its episodes has a
 * `source_selector_bk` block with one group per album (usually per year); the album's own group is
 * either inline or a signed selector URL.
 */
async function fetchVarietySelectorEpisodes(
  albumId: string,
  tvId: string,
  outbound: OutboundClient,
): Promise<
  { status: "ok"; episodes: FeatureEpisode[] } | { status: "transient_error"; reason: string }
> {
  const params: Record<string, string> = {
    entity_id: tvId,
    device_id: "qd5fwuaj4hunxxdgzwkcqmefeb3ww5hx",
    auth_cookie: "",
    user_id: "0",
    vip_type: "-1",
    vip_status: "0",
    conduit_id: "",
    pcv: "13.082.22866",
    app_version: "13.082.22866",
    ext: "",
    app_mode: "standard",
    scale: "100",
    timestamp: String(Date.now()),
    src: "pca_tvg",
    os: "",
    ad_ext: '{"r":"2.2.0-ares6-pure"}',
  };
  params.sign = signIqiyiLwParams(params);
  const page = await fetchIqiyiJson(
    `${IQIYI_LW_BASE_INFO_API}?${new URLSearchParams(params).toString()}`,
    outbound,
  );
  if (!page.ok) {
    return { status: "transient_error", reason: page.reason };
  }
  if (page.data.status_code !== 0) {
    return {
      status: "transient_error",
      reason: `iqiyi_lw_status_${String(page.data.status_code)}`,
    };
  }

  const tabs = asRecord(asRecord(page.data.data)?.template)?.tabs;
  const blocks = (Array.isArray(tabs) ? tabs : []).flatMap((tab) => {
    const b = asRecord(tab)?.blocks;
    return Array.isArray(b) ? b : [];
  });
  const selector = blocks.map(asRecord).find((b) => b?.bk_id === "source_selector_bk");
  const groups = asRecord(selector?.data)?.data;
  const group = (Array.isArray(groups) ? groups : [])
    .map(asRecord)
    .find((g) => g !== null && String(g.entity_id) === albumId);
  if (!group) {
    return { status: "ok", episodes: [] };
  }

  let rows: unknown = group.videos;
  if (typeof rows === "string") {
    const groupPage = await fetchIqiyiJson(rows, outbound);
    if (!groupPage.ok) {
      return { status: "transient_error", reason: groupPage.reason };
    }
    rows = asRecord(groupPage.data.data)?.videos;
  }

  const episodes: FeatureEpisode[] = [];
  const seen = new Set<string>();
  for (const row of Array.isArray(rows) ? rows : []) {
    const items = asRecord(row)?.data;
    for (const raw of Array.isArray(items) ? items : []) {
      const item = asRecord(raw);
      const id = parsePositiveIdString(item?.qipu_id);
      if (!item || !id || seen.has(id) || item.mark_type_show === IQIYI_PREVIEW_MARK) {
        continue;
      }
      seen.add(id);
      const label = nonEmptyString(item.phase_title) ?? nonEmptyString(item.short_display_name);
      const longTitle = nonEmptyString(item.title);
      const date = nonEmptyString(item.publish_date)?.match(/^(\d{4})(\d{2})(\d{2})$/);
      episodes.push({
        index: episodes.length + 1,
        nativeEpisodeId: id,
        ...(label ? { title: label } : {}),
        ...(longTitle ? { longTitle } : {}),
        airDate: date ? `${date[1]}-${date[2]}-${date[3]}` : null,
      });
    }
  }
  return { status: "ok", episodes };
}

async function fetchAlbumFeatureEpisodes(
  albumId: string,
  outbound: OutboundClient,
): Promise<FetchAvListResult> {
  const episodes: FeatureEpisode[] = [];
  const seenEpisodeIds = new Set<string>();
  let totalRawItemsSeen = 0;
  let sawValidEpisodeList = false;

  for (let page = 1; page <= IQIYI_MAX_AVLIST_PAGES; page += 1) {
    const url = `${IQIYI_ALBUM_AVLIST_API}?aid=${encodeURIComponent(albumId)}&page=${page}&size=${IQIYI_AVLIST_PAGE_SIZE}`;
    let response: ExternalHttpResponse;
    try {
      response = await outbound.fetchExternal({
        kind: "platform",
        namespace: "iqiyi",
        url,
        method: "GET",
        headers: IQIYI_API_HEADERS,
      });
    } catch (error) {
      return {
        status: "transient_error",
        reason: error instanceof Error ? error.message : "iqiyi_avlist_request_failed",
      };
    }

    const envelope = parseIqiyiApiEnvelope(response);
    if (!envelope.ok) {
      return { status: "transient_error", reason: envelope.transientReason };
    }
    if (isIqiyiNotFoundCode(envelope.code)) {
      return { status: "ok", episodes: null };
    }
    if (envelope.code !== "A00000") {
      return { status: "transient_error", reason: `iqiyi_code_${envelope.code}` };
    }

    const data = asRecord(envelope.data);
    if (!data) {
      return { status: "ok", episodes: null };
    }

    const rawList = Array.isArray(data.epsodelist)
      ? data.epsodelist
      : Array.isArray(data.episodelist)
        ? data.episodelist
        : null;
    if (!rawList) {
      return { status: "ok", episodes: sawValidEpisodeList ? episodes : null };
    }

    sawValidEpisodeList = true;
    totalRawItemsSeen += rawList.length;

    for (const item of rawList) {
      const ep = asRecord(item);
      if (!ep) {
        continue;
      }
      if (!isFeatureContentType(ep.contentType)) {
        continue;
      }

      const nativeEpisodeId = parseQipuId(ep.tvId ?? ep.qipuId);
      if (nativeEpisodeId) {
        if (seenEpisodeIds.has(nativeEpisodeId)) {
          continue;
        }
        seenEpisodeIds.add(nativeEpisodeId);
      }

      const title =
        nonEmptyString(ep.shortTitle) ??
        nonEmptyString(ep.name) ??
        (parsePositiveInt(ep.order) !== null ? String(parsePositiveInt(ep.order)) : null);
      const longTitle = nonEmptyString(ep.name);

      episodes.push({
        index: episodes.length + 1,
        ...(nativeEpisodeId ? { nativeEpisodeId } : {}),
        ...(title ? { title } : {}),
        ...(longTitle && longTitle !== title ? { longTitle } : {}),
        durationSeconds: parseDurationSeconds(ep.duration),
        airDate: parseDateString(ep.period) ?? parseTimestampDateCst(ep.publishTime),
      });
    }

    // Long albums (e.g. 航海王, total 1181) report hasMore: false on every page, so `total` must win.
    const hasMore =
      data.hasMore === true ||
      (typeof data.total === "number" &&
        Number.isFinite(data.total) &&
        totalRawItemsSeen < data.total);

    if (!hasMore || rawList.length === 0) {
      break;
    }
  }

  return { status: "ok", episodes: sawValidEpisodeList ? episodes : null };
}

async function fetchAlbumCollection(
  canonicalId: string,
  outbound: OutboundClient,
): Promise<CollectionEvidenceResult> {
  const url = `${IQIYI_ALBUM_BASEINFO_API}/${encodeURIComponent(canonicalId)}`;
  let response: ExternalHttpResponse;
  try {
    response = await outbound.fetchExternal({
      kind: "platform",
      namespace: "iqiyi",
      url,
      method: "GET",
      headers: IQIYI_API_HEADERS,
    });
  } catch (error) {
    return {
      status: "transient_error",
      reason: error instanceof Error ? error.message : "iqiyi_album_request_failed",
    };
  }

  const envelope = parseIqiyiApiEnvelope(response);
  if (!envelope.ok) {
    return { status: "transient_error", reason: envelope.transientReason };
  }
  if (isIqiyiNotFoundCode(envelope.code)) {
    return {
      status: "not_found",
      reason: envelope.errMsg ?? `iqiyi_code_${envelope.code}`,
    };
  }
  if (envelope.code !== "A00000") {
    return { status: "transient_error", reason: `iqiyi_code_${envelope.code}` };
  }

  const data = asRecord(envelope.data);
  if (!data) {
    return { status: "transient_error", reason: "missing_data" };
  }

  const title = nonEmptyString(data.name);
  if (!title) {
    return { status: "transient_error", reason: "missing_title" };
  }

  const mediaType = mapIqiyiMediaType(data.channelId);
  const firstVideo = asRecord(data.firstVideo);
  // CRITICAL: For TV albums, data.period is the *latest* episode air date, NOT the premiere year!
  // Only use firstVideo.period / publishTime for TV; allow data.period only for movies (channelId === 1).
  const year =
    parseFourDigitYear(firstVideo?.period) ??
    parseTimestampYearCst(firstVideo?.publishTime) ??
    parseTimestampYearCst(data.publishTime) ??
    (mediaType === "movie" ? parseFourDigitYear(data.period) : null);

  const avListResult = await fetchAlbumFeatureEpisodes(canonicalId, outbound);
  if (avListResult.status === "transient_error") {
    return { status: "transient_error", reason: avListResult.reason };
  }

  let featureEpisodes = avListResult.episodes ?? [];
  // Variety albums list no feature episodes here; their broadcasts live in the source selector.
  const sampleTvId =
    parsePositiveIdString(firstVideo?.tvId) ??
    parsePositiveIdString(asRecord(data.latestVideo)?.tvId);
  if (featureEpisodes.length === 0 && mediaType !== "movie" && sampleTvId) {
    const variety = await fetchVarietySelectorEpisodes(canonicalId, sampleTvId, outbound);
    if (variety.status === "transient_error") {
      return { status: "transient_error", reason: variety.reason };
    }
    featureEpisodes = variety.episodes;
  }
  featureEpisodes = selectBroadcastEpisodes(featureEpisodes);
  const featureEpisodeCount = featureEpisodes.length > 0 ? featureEpisodes.length : null;
  const aliases = collectAliases(data, title);
  const originalTitle = nonEmptyString(data.originName) ?? nonEmptyString(data.originalName);

  return {
    status: "found",
    info: {
      namespace: "iqiyi",
      canonicalId,
      title,
      ...(originalTitle && originalTitle !== title ? { originalTitle } : {}),
      ...(aliases.length > 0 ? { aliases } : {}),
      year,
      mediaType,
      featureEpisodeCount,
      featureEpisodes,
    },
  };
}

async function fetchMovieVideoCollection(
  canonicalId: string,
  outbound: OutboundClient,
): Promise<CollectionEvidenceResult> {
  const url = `${IQIYI_VIDEO_BASEINFO_API}/${encodeURIComponent(canonicalId)}`;
  let response: ExternalHttpResponse;
  try {
    response = await outbound.fetchExternal({
      kind: "platform",
      namespace: "iqiyi",
      url,
      method: "GET",
      headers: IQIYI_API_HEADERS,
    });
  } catch (error) {
    return {
      status: "transient_error",
      reason: error instanceof Error ? error.message : "iqiyi_video_request_failed",
    };
  }

  const envelope = parseIqiyiApiEnvelope(response);
  if (!envelope.ok) {
    return { status: "transient_error", reason: envelope.transientReason };
  }
  if (isIqiyiNotFoundCode(envelope.code)) {
    return {
      status: "not_found",
      reason: envelope.errMsg ?? `iqiyi_code_${envelope.code}`,
    };
  }
  if (envelope.code !== "A00000") {
    return { status: "transient_error", reason: `iqiyi_code_${envelope.code}` };
  }

  const data = asRecord(envelope.data);
  if (!data) {
    return { status: "transient_error", reason: "missing_data" };
  }

  // If this video belongs to a different multi-episode album (e.g. a bare TV episode tvId),
  // it is NOT a collection canonical ID.
  const returnedAlbumId = parseQipuId(data.albumId);
  if (returnedAlbumId !== null && returnedAlbumId !== canonicalId) {
    return { status: "not_found", reason: "not_a_collection_id" };
  }

  const title = nonEmptyString(data.name);
  if (!title) {
    return { status: "transient_error", reason: "missing_title" };
  }

  // User uploads (compilations, commentary clips) are not the work itself: official videos have
  // userId 0 and a non-UGC videoType ("PPC"), uploads carry the uploader's id and "RUGC"/"UGC".
  const videoType = nonEmptyString(data.videoType)?.toUpperCase() ?? "";
  if (videoType.includes("UGC") || parseQipuId(data.userId) !== null) {
    return { status: "not_found", reason: "user_upload" };
  }

  const mediaType = mapIqiyiMediaType(data.channelId);
  const year = parseFourDigitYear(data.period) ?? parseTimestampYearCst(data.publishTime);

  const isFeature =
    (data.contentType === undefined || isFeatureContentType(data.contentType)) &&
    data.videoCount !== 0;
  const nativeEpisodeId = parseQipuId(data.tvId ?? data.qipuId) ?? canonicalId;
  const featureEpisodes: FeatureEpisode[] = isFeature
    ? [
        {
          index: 1,
          nativeEpisodeId,
          title,
          durationSeconds: parseDurationSeconds(data.duration),
          airDate: parseDateString(data.period) ?? parseTimestampDateCst(data.publishTime),
        },
      ]
    : [];
  const featureEpisodeCount = featureEpisodes.length > 0 ? featureEpisodes.length : null;
  const aliases = collectAliases(data, title);
  const originalTitle = nonEmptyString(data.originName) ?? nonEmptyString(data.originalName);

  return {
    status: "found",
    info: {
      namespace: "iqiyi",
      canonicalId,
      title,
      ...(originalTitle && originalTitle !== title ? { originalTitle } : {}),
      ...(aliases.length > 0 ? { aliases } : {}),
      year,
      mediaType,
      featureEpisodeCount,
      featureEpisodes,
    },
  };
}

export const iqiyiAdapter: Tier3Adapter<"iqiyi"> = {
  namespace: "iqiyi",
  tier: 3,

  parseInput: parseIqiyiInput,

  async canonicalize(raw, outbound) {
    const parsed = parseIqiyiInput(raw);
    if (!parsed) {
      throw new InvalidNativeIdError(
        "iqiyi",
        raw,
        "Expected iQIYI numeric qipuId/albumId or iqiyi.com a_<hash>.html / v_<hash>.html URL",
      );
    }

    if (parsed.canonicalId !== null) {
      return parsed.canonicalId;
    }

    if (parsed.kind === "album_page") {
      return resolveAlbumPageToCanonicalId(raw, parsed.id, outbound);
    }

    if (parsed.kind === "video_page") {
      return resolveVideoPageToCanonicalId(raw, parsed.id, outbound);
    }

    throw new InvalidNativeIdError("iqiyi", raw, "Unsupported iQIYI input kind");
  },

  async fetchCollection(canonicalId, outbound): Promise<CollectionEvidenceResult> {
    const trimmed = canonicalId.trim();
    if (!BARE_QIPU_PATTERN.test(trimmed)) {
      return { status: "not_found", reason: "invalid_canonical_id" };
    }

    // Movie canonical IDs end in `00` and live on video/video/baseinfo (album/album/baseinfo returns A00001).
    if (trimmed.endsWith("00")) {
      return fetchMovieVideoCollection(trimmed, outbound);
    }

    const albumResult = await fetchAlbumCollection(trimmed, outbound);
    if (albumResult.status === "not_found") {
      return fetchMovieVideoCollection(trimmed, outbound);
    }
    return albumResult;
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
    const pageSize =
      limit !== null ? Math.min(limit, IQIYI_SEARCH_MAX_PAGE_SIZE) : IQIYI_SEARCH_DEFAULT_PAGE_SIZE;

    const url = `${IQIYI_SEARCH_API}?if=html5&key=${encodeURIComponent(keyword)}&pageNum=${page}&pageSize=${pageSize}&site=iqiyi`;

    let response: ExternalHttpResponse;
    try {
      response = await outbound.fetchExternal({
        kind: "platform",
        namespace: "iqiyi",
        url,
        method: "GET",
        headers: IQIYI_API_HEADERS,
      });
    } catch (error) {
      return {
        status: "transient_error",
        reason: error instanceof Error ? error.message : "iqiyi_search_request_failed",
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

    const root = asRecord(parsed);
    if (!root) {
      return {
        status: "transient_error",
        reason: "unexpected_payload",
      };
    }

    const code = nonEmptyString(root.code);
    if (!code) {
      return {
        status: "transient_error",
        reason: "missing_code",
      };
    }
    if (code !== "A00000") {
      return {
        status: "transient_error",
        reason: `iqiyi_code_${code}`,
      };
    }

    const data = asRecord(root.data);
    if (!data) {
      return { status: "ok", candidates: [] };
    }

    if (typeof data.code === "number" && data.code !== 0) {
      return {
        status: "transient_error",
        reason: `iqiyi_search_data_code_${data.code}`,
      };
    }

    const rawDocInfos = data.docinfos;
    if (!Array.isArray(rawDocInfos)) {
      return { status: "ok", candidates: [] };
    }

    const seenCanonicalIds = new Set<string>();
    const candidates: AdapterSearchCandidate[] = [];

    for (const rawDoc of rawDocInfos) {
      const doc = asRecord(rawDoc);
      const album = asRecord(doc?.albumDocInfo);
      if (!doc || !album) {
        continue;
      }

      const siteId = nonEmptyString(album.siteId)?.toLowerCase();
      if (siteId !== "iqiyi") {
        continue;
      }

      const canonicalId =
        parseQipuId(album.albumId) ?? parseQipuId(album.qipu_id) ?? parseQipuId(doc.qipu_id);
      if (!canonicalId || seenCanonicalIds.has(canonicalId)) {
        continue;
      }

      const title = nonEmptyString(album.albumTitle);
      if (!title) {
        continue;
      }

      seenCanonicalIds.add(canonicalId);

      const originalTitle = nonEmptyString(album.albumEnglishTitle);
      const year = parseFourDigitYear(album.releaseDate);
      const mediaType = mapIqiyiSearchChannel(album.channel);
      const episodeCount = parsePositiveInt(album.itemTotalNumber);
      const itemUrl = parseHttpUrl(album.albumLink);

      candidates.push({
        canonicalId,
        title,
        ...(originalTitle && originalTitle !== title ? { originalTitle } : {}),
        year,
        mediaType,
        episodeCount,
        ...(itemUrl ? { url: itemUrl } : {}),
      });

      if (limit !== null && candidates.length >= limit) {
        break;
      }
    }

    return { status: "ok", candidates };
  },
};
