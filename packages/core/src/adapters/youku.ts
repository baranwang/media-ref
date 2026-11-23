import type { MediaType } from "@media-ref/client";
import type { ExternalHttpResponse, OutboundClient } from "../outbound.ts";
import {
  AdapterTransientError,
  InvalidNativeIdError,
  type CollectionEvidenceResult,
  type FeatureEpisode,
  type ParsedNativeIdInput,
  type Tier2Adapter,
} from "./types.ts";

/**
 * Youku platform adapter (Tier 1 & Tier 2).
 *
 * Canonical ID (`canonicalId`):
 * - 20-character lowercase hexadecimal `showId` WITHOUT the URL's leading `z` prefix
 *   (regex `/^[0-9a-f]{20}$/`, e.g. `cc001f06962411de83b1`).
 * - Matches `window.__INITIAL_DATA__.pageMap.extra.showId` and `bangumi-data`'s `youku` ID.
 *
 * Tier 1 accepted inputs & canonicalization:
 * - Bare 20-char hex `<showId>` or `z<showId>` -> lowercased 20-char hex (no network call).
 * - `https://list.youku.com/show/id_z<showId>.html` (or `id_<showId>.html`, plus `m.youku.com` /
 *   `www.youku.com` / `youku.com` equivalents) -> lowercased 20-char hex (no network call).
 * - `https://v.youku.com/v_show/id_<vid>.html` (and `m.youku.com` `/v_show/`, `/video/`,
 *   `/alipay_video/` equivalents) -> fetches SSR HTML via `OutboundClient` (`kind: "platform"`,
 *   `namespace: "youku"`) and extracts `window.__INITIAL_DATA__.pageMap.extra.showId`.
 * - Unparseable URLs/IDs or `v_show` pages lacking a valid `showId` fail with `InvalidNativeIdError`.
 *
 * Tier 2 caveats (verified against public unauthenticated SSR):
 * - Fetches `GET https://list.youku.com/show/id_z<showId>.html` via `OutboundClient` (can be routed
 *   through a domestic proxy via `OUTBOUND_PROXY_CONFIG` when overseas IPs hit geo-restrictions).
 * - SSR `comp 10013` (`pc_detail_kuflix_anthology`) only embeds page 1 (`pageSize: 60`); subsequent
 *   pages require signed Alibaba MTOP requests. Geo-restricted overseas responses may expose only
 *   `"预告片"` items (`featureEpisodes.length === 0`). Whenever feature episodes are empty or
 *   truncated, `featureEpisodeCount` is set to `null` so Evidence Gate routes to `needs_review`
 *   rather than fabricating episode counts or auto-approving.
 * - Alibaba TMD/Baxia CAPTCHA (`_____tmd_____/punish`) is NEVER bypassed and returns
 *   `transient_error` (or `AdapterTransientError` during Tier 1 resolution).
 */

const YOUKU_SHOW_HOSTS = new Set(["youku.com", "www.youku.com", "list.youku.com", "m.youku.com"]);

const YOUKU_VIDEO_HOSTS = new Set(["youku.com", "www.youku.com", "v.youku.com", "m.youku.com"]);

const CANONICAL_SHOW_ID_PATTERN = /^([0-9a-f]{20})$/i;
const BARE_SHOW_ID_PATTERN = /^z?([0-9a-f]{20})$/i;
const URL_SHOW_PATH_PATTERN = /^\/show\/id_z?([0-9a-f]{20})\.html$/i;
const URL_V_SHOW_PATH_PATTERN = /^\/v_show\/id_([A-Za-z0-9=_-]{2,64})\.html$/;
const URL_MOBILE_VIDEO_PATH_PATTERN = /^\/(?:video|alipay_video)\/id_([A-Za-z0-9=_-]{2,64})\.html$/;

const YOUKU_PAGE_HEADERS: Record<string, string> = {
  referer: "https://www.youku.com/",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "zh-CN,zh;q=0.9",
};

const INITIAL_DATA_START_PATTERN = /window\.__INITIAL_DATA__\s*=\s*\{/;

const YOUKU_ANTHOLOGY_COMPONENT_TYPE = 10013;
const YOUKU_ANTHOLOGY_COMPONENT_ID = "pc_detail_kuflix_anthology";
const YOUKU_SSR_PAGE_SIZE = 60;

const YOUKU_TV_CATEGORIES = new Set(["电视剧", "动漫", "综艺", "纪录片", "少儿", "剧集"]);
const YOUKU_TV_CATEGORY_IDS = new Set([97, 100, 85, 84, 177]);

const NON_FEATURE_MARK_TEXTS = new Set([
  "预告",
  "预告片",
  "花絮",
  "片花",
  "精彩看点",
  "彩蛋",
  "番外",
  "特辑",
  "周边",
  "资讯",
]);

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

function parseDurationSeconds(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return raw >= 100_000 ? Math.round(raw / 1000) : Math.round(raw);
  }
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    if (Number.isFinite(num) && num > 0) {
      return num >= 100_000 ? Math.round(num / 1000) : Math.round(num);
    }
    return null;
  }
  const hms = trimmed.match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/);
  if (!hms) {
    return null;
  }
  const hours = hms[1] ? Number(hms[1]) : 0;
  const minutes = Number(hms[2]);
  const seconds = Number(hms[3]);
  const total = hours * 3600 + minutes * 60 + seconds;
  return total > 0 ? total : null;
}

function parseAirDate(raw: unknown): string | null {
  if (typeof raw === "string") {
    const match = raw.trim().match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1]! : null;
  }
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    const ms = raw > 1e12 ? raw : raw * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  }
  return null;
}

function mapYoukuMediaType(showCategory: unknown, showCategoryId: unknown): MediaType | null {
  const category = nonEmptyString(showCategory);
  if (category === "电影") {
    return "movie";
  }
  if (category && YOUKU_TV_CATEGORIES.has(category)) {
    return "tv";
  }

  const categoryId = parsePositiveInt(showCategoryId);
  if (categoryId === 96) {
    return "movie";
  }
  if (categoryId !== null && YOUKU_TV_CATEGORY_IDS.has(categoryId)) {
    return "tv";
  }

  return null;
}

function collectAliases(extra: Record<string, unknown>, primaryTitle: string): string[] {
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

  for (const field of [extra.showAlias, extra.alias, extra.showSecondName]) {
    if (Array.isArray(field)) {
      for (const item of field) {
        addCandidate(item);
      }
      continue;
    }
    const raw = nonEmptyString(field);
    if (raw) {
      addCandidate(raw);
      for (const part of raw.split(/[/／、,，|;；]/)) {
        addCandidate(part);
      }
    }
  }

  return aliases;
}

function normalizeShowId(raw: unknown): string | null {
  const str = nonEmptyString(raw);
  if (!str) {
    return null;
  }
  const match = str.match(BARE_SHOW_ID_PATTERN);
  return match ? match[1]!.toLowerCase() : null;
}

function isYoukuChallengeResponse(response: ExternalHttpResponse): boolean {
  const url = response.url.toLowerCase();
  if (url.includes("_____tmd_____") || url.includes("/punish")) {
    return true;
  }
  const body = response.body;
  if (body.includes("_____tmd_____")) {
    return true;
  }
  if (
    (body.includes("x5secdata") || body.includes("rgv587_flag")) &&
    /["']action["']\s*:\s*["'](?:captcha|wait|deny)["']/i.test(body)
  ) {
    return true;
  }
  return false;
}

function isYoukuNotFoundPage(html: string): boolean {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!titleMatch) {
    return false;
  }
  return /\b404\b/i.test(titleMatch[1]!);
}

type InitialDataExtraction =
  | { kind: "ok"; data: Record<string, unknown> }
  | { kind: "missing" }
  | { kind: "invalid_json" };

function extractInitialData(html: string): InitialDataExtraction {
  const match = INITIAL_DATA_START_PATTERN.exec(html);
  if (!match) {
    return { kind: "missing" };
  }

  const startIndex = match.index + match[0].length - 1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIndex; i < html.length; i += 1) {
    const ch = html[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const jsonSlice = html.slice(startIndex, i + 1);
        try {
          const parsed: unknown = JSON.parse(jsonSlice);
          const record = asRecord(parsed);
          return record ? { kind: "ok", data: record } : { kind: "invalid_json" };
        } catch {
          return { kind: "invalid_json" };
        }
      }
    }
  }

  return { kind: "invalid_json" };
}

function getPageMapExtra(initialData: Record<string, unknown>): Record<string, unknown> | null {
  const pageMap = asRecord(initialData.pageMap);
  if (!pageMap) {
    return null;
  }
  return asRecord(pageMap.extra);
}

function isAnthologyComponent(component: Record<string, unknown>): boolean {
  if (
    component.type === YOUKU_ANTHOLOGY_COMPONENT_TYPE ||
    component.type === String(YOUKU_ANTHOLOGY_COMPONENT_TYPE)
  ) {
    return true;
  }
  const componentId = nonEmptyString(component.componentId) ?? nonEmptyString(component.name);
  return componentId === YOUKU_ANTHOLOGY_COMPONENT_ID;
}

function isFeatureEpisodeItem(item: Record<string, unknown>): boolean {
  const videoType = nonEmptyString(item.videoType);
  if (videoType !== "正片") {
    return false;
  }

  const mark = asRecord(item.mark);
  const markText = nonEmptyString(mark?.text);
  if (markText && NON_FEATURE_MARK_TEXTS.has(markText)) {
    return false;
  }

  return true;
}

interface ExtractedAnthology {
  featureEpisodes: FeatureEpisode[];
  rawItemCount: number;
  pageSize: number;
  hasMore: boolean;
}

function extractAnthologyEpisodes(initialData: Record<string, unknown>): ExtractedAnthology {
  const moduleList = Array.isArray(initialData.moduleList) ? initialData.moduleList : [];
  const featureEpisodes: FeatureEpisode[] = [];
  const seenNativeIds = new Set<string>();
  let rawItemCount = 0;
  let pageSize = YOUKU_SSR_PAGE_SIZE;
  let hasMore = false;

  for (const rawModule of moduleList) {
    const mod = asRecord(rawModule);
    if (!mod || !Array.isArray(mod.components)) {
      continue;
    }

    for (const rawComponent of mod.components) {
      const comp = asRecord(rawComponent);
      if (!comp || !isAnthologyComponent(comp)) {
        continue;
      }

      const compData = asRecord(comp.data);
      const compPageSize = parsePositiveInt(comp.pageSize ?? compData?.pageSize);
      if (compPageSize !== null) {
        pageSize = compPageSize;
      }

      const totalPages = parsePositiveInt(
        comp.totalPage ?? comp.totalPages ?? compData?.totalPage ?? compData?.totalPages,
      );
      if (
        comp.hasMore === true ||
        compData?.hasMore === true ||
        (totalPages !== null && totalPages > 1)
      ) {
        hasMore = true;
      }

      const rawItemList = Array.isArray(comp.itemList)
        ? comp.itemList
        : Array.isArray(compData?.itemList)
          ? compData.itemList
          : [];

      for (const rawItem of rawItemList) {
        const item = asRecord(rawItem);
        if (!item) {
          continue;
        }
        rawItemCount += 1;

        if (!isFeatureEpisodeItem(item)) {
          continue;
        }

        const nativeEpisodeId =
          nonEmptyString(item.action_value) ??
          nonEmptyString(item.vid) ??
          (typeof item.id === "number" ? String(item.id) : nonEmptyString(item.id));

        if (nativeEpisodeId && seenNativeIds.has(nativeEpisodeId)) {
          continue;
        }
        if (nativeEpisodeId) {
          seenNativeIds.add(nativeEpisodeId);
        }

        const title =
          nonEmptyString(item.title) ??
          (typeof item.stage === "number" ? String(item.stage) : nonEmptyString(item.stage));
        const longTitleCandidate = nonEmptyString(item.subtitle ?? item.subTitle ?? item.desc);
        const longTitle =
          longTitleCandidate && longTitleCandidate !== title ? longTitleCandidate : null;

        featureEpisodes.push({
          index: featureEpisodes.length + 1,
          ...(nativeEpisodeId ? { nativeEpisodeId } : {}),
          ...(title ? { title } : {}),
          ...(longTitle ? { longTitle } : {}),
          durationSeconds: parseDurationSeconds(item.duration ?? item.totalTime),
          airDate: parseAirDate(item.publishTime ?? item.releaseTime),
        });
      }
    }
  }

  return {
    featureEpisodes,
    rawItemCount,
    pageSize,
    hasMore,
  };
}

export function parseYoukuInput(raw: string): ParsedNativeIdInput | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const bareMatch = trimmed.match(BARE_SHOW_ID_PATTERN);
  if (bareMatch) {
    const canonical = bareMatch[1]!.toLowerCase();
    return { kind: "show", id: canonical, canonicalId: canonical };
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

  if (YOUKU_SHOW_HOSTS.has(host)) {
    const showMatch = pathname.match(URL_SHOW_PATH_PATTERN);
    if (showMatch) {
      const canonical = showMatch[1]!.toLowerCase();
      return { kind: "show", id: canonical, canonicalId: canonical };
    }
  }

  if (YOUKU_VIDEO_HOSTS.has(host)) {
    const vShowMatch = pathname.match(URL_V_SHOW_PATH_PATTERN);
    if (vShowMatch) {
      return { kind: "video", id: vShowMatch[1]!, canonicalId: null };
    }
    if (host === "m.youku.com") {
      const mobileVideoMatch = pathname.match(URL_MOBILE_VIDEO_PATH_PATTERN);
      if (mobileVideoMatch) {
        return { kind: "video", id: mobileVideoMatch[1]!, canonicalId: null };
      }
    }
  }

  return null;
}

async function resolveShowIdFromVideo(
  rawInput: string,
  videoId: string,
  outbound: OutboundClient,
): Promise<string> {
  const url = `https://v.youku.com/v_show/id_${videoId}.html`;
  let response: ExternalHttpResponse;
  try {
    response = await outbound.fetchExternal({
      kind: "platform",
      namespace: "youku",
      url,
      method: "GET",
      headers: YOUKU_PAGE_HEADERS,
    });
  } catch (error) {
    throw new AdapterTransientError(
      "youku",
      error instanceof Error ? error.message : "Failed to fetch Youku video page",
    );
  }

  if (isYoukuChallengeResponse(response)) {
    throw new AdapterTransientError("youku", "youku_captcha_challenge");
  }

  if (response.status === 404) {
    throw new InvalidNativeIdError("youku", rawInput, `Youku video ${videoId} not found`);
  }

  if (response.status < 200 || response.status >= 300) {
    throw new AdapterTransientError("youku", `http_${response.status}`);
  }

  const extracted = extractInitialData(response.body);
  if (extracted.kind === "invalid_json") {
    throw new AdapterTransientError("youku", "invalid_initial_data_json");
  }
  if (extracted.kind === "missing") {
    if (isYoukuNotFoundPage(response.body)) {
      throw new InvalidNativeIdError("youku", rawInput, `Youku video ${videoId} not found`);
    }
    throw new InvalidNativeIdError(
      "youku",
      rawInput,
      `Youku video ${videoId} page does not contain show metadata`,
    );
  }

  const extra = getPageMapExtra(extracted.data);
  const showId = normalizeShowId(extra?.showId);
  if (!showId) {
    throw new InvalidNativeIdError(
      "youku",
      rawInput,
      `Youku video ${videoId} page does not belong to a valid collection showId`,
    );
  }

  return showId;
}

export const youkuAdapter: Tier2Adapter<"youku"> = {
  namespace: "youku",
  tier: 2,

  parseInput: parseYoukuInput,

  async canonicalize(raw, outbound) {
    const parsed = parseYoukuInput(raw);
    if (!parsed) {
      throw new InvalidNativeIdError(
        "youku",
        raw,
        "Expected Youku 20-char hex showId (optional leading z), show URL, or v_show video URL",
      );
    }

    if (parsed.canonicalId !== null) {
      return parsed.canonicalId;
    }

    if (parsed.kind === "video") {
      return resolveShowIdFromVideo(raw, parsed.id, outbound);
    }

    throw new InvalidNativeIdError("youku", raw, "Unsupported Youku input kind");
  },

  async fetchCollection(canonicalId, outbound): Promise<CollectionEvidenceResult> {
    const match = canonicalId.trim().match(CANONICAL_SHOW_ID_PATTERN);
    if (!match) {
      return { status: "not_found", reason: "invalid_canonical_id" };
    }

    const normalizedShowId = match[1]!.toLowerCase();
    const url = `https://list.youku.com/show/id_z${normalizedShowId}.html`;

    let response: ExternalHttpResponse;
    try {
      response = await outbound.fetchExternal({
        kind: "platform",
        namespace: "youku",
        url,
        method: "GET",
        headers: YOUKU_PAGE_HEADERS,
      });
    } catch (error) {
      return {
        status: "transient_error",
        reason: error instanceof Error ? error.message : "youku_request_failed",
      };
    }

    if (isYoukuChallengeResponse(response)) {
      return { status: "transient_error", reason: "youku_captcha_challenge" };
    }

    if (response.status === 404) {
      return { status: "not_found", reason: "http_404" };
    }

    if (response.status < 200 || response.status >= 300) {
      return { status: "transient_error", reason: `http_${response.status}` };
    }

    const extracted = extractInitialData(response.body);
    if (extracted.kind === "invalid_json") {
      return { status: "transient_error", reason: "invalid_initial_data_json" };
    }
    if (extracted.kind === "missing") {
      if (isYoukuNotFoundPage(response.body)) {
        return { status: "not_found", reason: "youku_404_page" };
      }
      return { status: "transient_error", reason: "missing_initial_data" };
    }

    const extra = getPageMapExtra(extracted.data);
    const pageShowId = normalizeShowId(extra?.showId);
    if (!extra || !pageShowId) {
      return { status: "not_found", reason: "missing_show_id" };
    }

    const title = nonEmptyString(extra.showName);
    if (!title) {
      return { status: "transient_error", reason: "missing_title" };
    }

    const year = parseFourDigitYear(extra.showReleaseTime);
    const mediaType = mapYoukuMediaType(extra.showCategory, extra.showCategoryId);
    const aliases = collectAliases(extra, title);
    const episodeTotal = parsePositiveInt(extra.episodeTotal);
    const episodeLast = parsePositiveInt(extra.episodeLast);

    const anthology = extractAnthologyEpisodes(extracted.data);
    const featureCount = anthology.featureEpisodes.length;

    const isTruncated =
      anthology.hasMore ||
      (episodeTotal !== null &&
        episodeTotal > YOUKU_SSR_PAGE_SIZE &&
        featureCount < episodeTotal) ||
      (episodeLast !== null && episodeLast > YOUKU_SSR_PAGE_SIZE && featureCount < episodeLast) ||
      (anthology.rawItemCount >= anthology.pageSize &&
        ((episodeTotal !== null && featureCount < episodeTotal) ||
          (episodeLast !== null && featureCount < episodeLast)));

    // Never fabricate episode counts when geo-locked (trailer-only -> 0 正片) or truncated (>60 eps on SSR page 1)
    const featureEpisodeCount = featureCount === 0 || isTruncated ? null : featureCount;

    return {
      status: "found",
      info: {
        namespace: "youku",
        canonicalId: normalizedShowId,
        title,
        ...(aliases.length > 0 ? { aliases } : {}),
        year,
        mediaType,
        featureEpisodeCount,
        featureEpisodes: anthology.featureEpisodes,
      },
    };
  },
};
