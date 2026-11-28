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

const CST_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * Youku platform adapter (Tier 1, Tier 2 & Tier 3).
 *
 * Canonical ID (`canonicalId`):
 * - 20-character lowercase hexadecimal `showId` WITHOUT the URL's leading `z` prefix
 *   (regex `/^[0-9a-f]{20}$/`, e.g. `cc001f06962411de83b1`), as `bangumi-data`'s `youku` ID.
 *
 * Tier 1 accepted inputs & canonicalization:
 * - Bare 20-char hex `<showId>` or `z<showId>`, or a `list.youku.com/show/id_z<showId>.html` URL
 *   (plus `m.youku.com` / `www.youku.com` / `youku.com`) -> lowercased showId, no network call.
 * - `v.youku.com/v_show/id_<vid>.html` (and `m.youku.com` `/v_show/`, `/video/`, `/alipay_video/`)
 *   -> the video's show from the open API `videos/show.json`.
 *
 * Tier 2: metadata from the open API `shows/show.json`, episodes from `shows/videos.json`
 * (`ext=show` lists feature episodes only), paged. The web pages (`list.youku.com`,
 * `v.youku.com`) sit behind Alibaba's TMD CAPTCHA for datacenter IPs; the open API does not.
 * An empty episode list (expired copyright) or one longer than the pages read gives
 * `featureEpisodeCount: null`, so the Evidence Gate never approves on a guessed count.
 *
 * Tier 3 search: `search.youku.com/api/search` (the site search's JSON API) with a desktop UA;
 * answers datacenter IPs, including Cloudflare Workers egress (checked 2026-11-28), without the
 * CAPTCHA. It lists other platforms' shows too, each under its own Youku showId with `isYouku: 0`
 * (乘风破浪 第三季 `eaba37f7f29b46a7810f` is Migu's): the open API has no episodes for those, so
 * they are dropped, as are commentary and preview shows (解读, 抢先看, 《片名》...).
 * (`searches/show/by_keyword.json` of the open API returns nothing.)
 */

const YOUKU_SHOW_HOSTS = new Set(["youku.com", "www.youku.com", "list.youku.com", "m.youku.com"]);

const YOUKU_VIDEO_HOSTS = new Set(["youku.com", "www.youku.com", "v.youku.com", "m.youku.com"]);

const CANONICAL_SHOW_ID_PATTERN = /^([0-9a-f]{20})$/i;
const BARE_SHOW_ID_PATTERN = /^z?([0-9a-f]{20})$/i;
const URL_SHOW_PATH_PATTERN = /^\/show\/id_z?([0-9a-f]{20})\.html$/i;
const URL_V_SHOW_PATH_PATTERN = /^\/v_show\/id_([A-Za-z0-9=_-]{2,64})\.html$/;
const URL_MOBILE_VIDEO_PATH_PATTERN = /^\/(?:video|alipay_video)\/id_([A-Za-z0-9=_-]{2,64})\.html$/;

const YOUKU_OPENAPI_BASE = "https://openapi.youku.com/v2";
// shortcut: Huawei Video's client_id for the open API (the one open-source danmaku tools use), not
// one issued to MediaRef; if Youku revokes it, every Youku fetch turns transient until replaced.
const YOUKU_OPENAPI_CLIENT = {
  client_id: "53e6cc67237fc59a",
  package: "com.huawei.hwvplayer.youku",
};
/** The API's largest page; a larger `count` silently falls back to 20. */
const YOUKU_PAGE_SIZE = 100;
const YOUKU_MAX_PAGES = 20;

const YOUKU_SEARCH_API = "https://search.youku.com/api/search";
const YOUKU_SEARCH_HEADERS: Record<string, string> = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  accept: "application/json",
};
/** Shows about a work rather than the work; a leading 《 is the same (《庆余年》观影指南). */
const YOUKU_SEARCH_SKIP_WORDS = ["中配版", "抢先看", "非正片", "解读", "揭秘", "赏析"];
const YOUKU_TMD_PATTERN = /punish|_____tmd_____|x5sec/i;

const YOUKU_TV_CATEGORIES = new Set(["电视剧", "动漫", "综艺", "纪录片", "少儿", "剧集"]);

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
    // Air dates are China Standard Time dates.
    const date = new Date(ms + CST_OFFSET_MS);
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  }
  return null;
}

function mapYoukuMediaType(category: unknown): MediaType | null {
  const name = nonEmptyString(category);
  if (name === "电影") {
    return "movie";
  }
  return name && YOUKU_TV_CATEGORIES.has(name) ? "tv" : null;
}

/** `alias` is null, a string, or a list of `{ alias, type }`. */
function collectAliases(raw: unknown, primaryTitle: string): string[] {
  const values = Array.isArray(raw)
    ? raw.map((item) => asRecord(item)?.alias)
    : (nonEmptyString(raw)?.split(/[/／、,，|;；]/) ?? []);
  const seen = new Set<string>([primaryTitle]);
  return values.flatMap((value) => {
    const str = nonEmptyString(value);
    if (!str || seen.has(str)) {
      return [];
    }
    seen.add(str);
    return [str];
  });
}

function normalizeShowId(raw: unknown): string | null {
  const str = nonEmptyString(raw);
  if (!str) {
    return null;
  }
  const match = str.match(BARE_SHOW_ID_PATTERN);
  return match ? match[1]!.toLowerCase() : null;
}

type OpenApiResult =
  | { kind: "ok"; data: Record<string, unknown> }
  | { kind: "not_found"; reason: string }
  | { kind: "transient"; reason: string };

/** One open API call. Unknown IDs answer `[]` or an "invalid ID" error. */
async function callOpenApi(
  outbound: OutboundClient,
  path: string,
  params: Record<string, string>,
): Promise<OpenApiResult> {
  const query = new URLSearchParams({ ...YOUKU_OPENAPI_CLIENT, ...params });
  let response;
  try {
    response = await outbound.fetchExternal({
      kind: "platform",
      namespace: "youku",
      url: `${YOUKU_OPENAPI_BASE}/${path}?${query.toString()}`,
      method: "GET",
    });
  } catch (error) {
    return {
      kind: "transient",
      reason: error instanceof Error ? error.message : "youku_request_failed",
    };
  }
  if (response.status === 404) {
    return { kind: "not_found", reason: "http_404" };
  }
  if (response.status < 200 || response.status >= 300) {
    return { kind: "transient", reason: `http_${response.status}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return { kind: "transient", reason: "invalid_json" };
  }
  if (Array.isArray(parsed)) {
    return { kind: "not_found", reason: "unknown_id" };
  }
  const data = asRecord(parsed);
  if (!data) {
    return { kind: "transient", reason: "invalid_json" };
  }
  const error = asRecord(data.error);
  if (error) {
    return /invalid id/i.test(nonEmptyString(error.description) ?? "")
      ? { kind: "not_found", reason: "unknown_id" }
      : { kind: "transient", reason: `youku_api_error_${JSON.stringify(error.code ?? null)}` };
  }
  return { kind: "ok", data };
}

/** One search card's `commonData`, or null when it is off-site, a side show, or unreadable. */
function toSearchCandidate(raw: unknown): AdapterSearchCandidate | null {
  const data = asRecord(asRecord(raw)?.commonData);
  if (!data || (data.isYouku !== 1 && data.hasYouku !== 1)) {
    return null;
  }
  const canonicalId = nonEmptyString(data.showId)?.match(CANONICAL_SHOW_ID_PATTERN)?.[1];
  const title = nonEmptyString(asRecord(data.titleDTO)?.displayName)?.replace(/<[^>]+>/g, "");
  if (
    !canonicalId ||
    !title ||
    title.startsWith("《") ||
    YOUKU_SEARCH_SKIP_WORDS.some((word) => title.includes(word))
  ) {
    return null;
  }
  // `feature` reads "2017 · 电影 · 中国 · 共39集"; the year is missing before release.
  const parts = (nonEmptyString(data.feature) ?? "").split("·").map((part) => part.trim());
  const year = parts.map((part) => parseFourDigitYear(part)).find((y) => y !== null) ?? null;
  const mediaType = parts.map(mapYoukuMediaType).find((type) => type !== null) ?? null;
  const total = Number(data.episodeTotal);
  return {
    canonicalId: canonicalId.toLowerCase(),
    title,
    year,
    mediaType,
    episodeCount: Number.isInteger(total) && total > 0 ? total : null,
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

export const youkuAdapter: Tier3Adapter<"youku"> = {
  namespace: "youku",
  tier: 3,

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

    const result = await callOpenApi(outbound, "videos/show.json", {
      video_id: parsed.id,
      ext: "show",
    });
    if (result.kind === "transient") {
      throw new AdapterTransientError("youku", result.reason);
    }
    const showId = result.kind === "ok" ? normalizeShowId(asRecord(result.data.show)?.id) : null;
    if (!showId) {
      throw new InvalidNativeIdError(
        "youku",
        raw,
        `Youku video ${parsed.id} not found or not part of a show`,
      );
    }
    return showId;
  },

  async fetchCollection(canonicalId, outbound): Promise<CollectionEvidenceResult> {
    const match = canonicalId.trim().match(CANONICAL_SHOW_ID_PATTERN);
    if (!match) {
      return { status: "not_found", reason: "invalid_canonical_id" };
    }
    const showId = match[1]!.toLowerCase();

    const show = await callOpenApi(outbound, "shows/show.json", { show_id: showId });
    if (show.kind === "transient") {
      return { status: "transient_error", reason: show.reason };
    }
    if (show.kind === "not_found") {
      return { status: "not_found", reason: show.reason };
    }
    const title = nonEmptyString(show.data.name);
    if (!title) {
      return { status: "transient_error", reason: "missing_title" };
    }

    const videos: Record<string, unknown>[] = [];
    let total = 0;
    for (let page = 1; page <= YOUKU_MAX_PAGES; page += 1) {
      const result = await callOpenApi(outbound, "shows/videos.json", {
        show_id: showId,
        ext: "show",
        page: String(page),
        count: String(YOUKU_PAGE_SIZE),
      });
      if (result.kind === "transient") {
        return { status: "transient_error", reason: result.reason };
      }
      const items =
        result.kind === "ok" && Array.isArray(result.data.videos) ? result.data.videos : [];
      total = result.kind === "ok" ? Number(result.data.total) || 0 : 0;
      for (const item of items as unknown[]) {
        const video = asRecord(item);
        if (video) {
          videos.push(video);
        }
      }
      if (items.length < YOUKU_PAGE_SIZE || videos.length >= total) {
        break;
      }
    }
    const truncated = videos.length < total;

    const featureEpisodes = selectBroadcastEpisodes(
      videos.map((video, i): FeatureEpisode => {
        const nativeEpisodeId = nonEmptyString(video.id);
        const episodeTitle = nonEmptyString(video.title);
        return {
          index: i + 1,
          ...(nativeEpisodeId ? { nativeEpisodeId } : {}),
          ...(episodeTitle ? { title: episodeTitle } : {}),
          durationSeconds: parseDurationSeconds(video.duration),
          airDate: parseAirDate(video.published),
        };
      }),
    );
    const aliases = collectAliases(show.data.alias, title);

    return {
      status: "found",
      info: {
        namespace: "youku",
        canonicalId: showId,
        title,
        ...(aliases.length > 0 ? { aliases } : {}),
        year: parseFourDigitYear(show.data.released ?? show.data.published),
        mediaType: mapYoukuMediaType(show.data.category),
        featureEpisodeCount:
          featureEpisodes.length === 0 || truncated ? null : featureEpisodes.length,
        featureEpisodes,
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
    const params = new URLSearchParams({
      keyword,
      site: "1",
      categories: "0",
      ftype: "0",
      ob: "0",
      pg: String(page),
    });

    let response: ExternalHttpResponse;
    try {
      response = await outbound.fetchExternal({
        kind: "platform",
        namespace: "youku",
        url: `${YOUKU_SEARCH_API}?${params.toString()}`,
        method: "GET",
        headers: YOUKU_SEARCH_HEADERS,
      });
    } catch (error) {
      return {
        status: "transient_error",
        reason: error instanceof Error ? error.message : "youku_search_request_failed",
      };
    }
    let components: unknown = null;
    if (response.status >= 200 && response.status < 300) {
      try {
        components = asRecord(JSON.parse(response.body))?.pageComponentList;
      } catch {
        // Handled below with the other unreadable answers.
      }
    }
    if (!Array.isArray(components)) {
      // Alibaba's TMD answers with a punish page (or a redirect to one) instead of results.
      const challenged = YOUKU_TMD_PATTERN.test(`${response.url} ${response.body}`);
      return {
        status: "transient_error",
        reason: challenged
          ? "youku_captcha_challenge"
          : response.status < 200 || response.status >= 300
            ? `http_${response.status}`
            : "unexpected_payload",
      };
    }

    const limit =
      query.limit !== undefined && Number.isInteger(query.limit) && query.limit > 0
        ? query.limit
        : Infinity;
    const candidates = new Map<string, AdapterSearchCandidate>();
    for (const component of components) {
      const candidate = toSearchCandidate(component);
      if (candidate && !candidates.has(candidate.canonicalId)) {
        candidates.set(candidate.canonicalId, candidate);
      }
    }
    return { status: "ok", candidates: [...candidates.values()].slice(0, limit) };
  },
};
