import type { MediaType } from "@media-ref/client";
import type { ExternalHttpResponse, OutboundClient } from "../outbound.ts";
import { selectBroadcastEpisodes } from "./variety.ts";
import {
  InvalidNativeIdError,
  type CollectionEvidenceResult,
  type FeatureEpisode,
  type ParsedNativeIdInput,
  type Tier2Adapter,
} from "./types.ts";

/**
 * Mango TV (`mgtv`) Platform Adapter — Tier 1 & Tier 2.
 *
 * Canonical ID:
 * - Numeric `collection_id` (also referred to as `clip_id` in Mango TV APIs), matching `/^[1-9]\d*$/`
 *   (e.g. `"510924"` for 《去有风的地方》, `"593455"` for 《小巷人家》).
 *
 * Supported Tier 1 inputs (all resolved synchronously without outbound calls):
 * - Bare numeric `collection_id`: `510924`
 * - Collection overview URL: `https://www.mgtv.com/h/<collection_id>.html` (also `mgtv.com`, `m.mgtv.com`, `w.mgtv.com`)
 * - Collection play URL: `https://www.mgtv.com/b/<collection_id>.html`
 * - Episode play URL: `https://www.mgtv.com/b/<collection_id>/<video_id>.html` (also `m.mgtv.com`, `w.mgtv.com`)
 *
 * Rejected inputs:
 * - Non-Mango TV hosts, search pages (`so.mgtv.com`), channel/short-video paths (`/l/...`, `/s/...`),
 *   non-numeric IDs, zero or leading-zero numeric IDs, and URLs without a valid `collection_id`.
 *
 * Tier 2 data sources (unauthenticated public endpoints via `OutboundClient`):
 * - `GET https://pcweb.api.mgtv.com/episode/list?collection_id=<id>&page=<p>&size=50`
 *   Paginated episode list; feature episodes strictly filtered by `isIntact === "1"` (`"3"` = trailer/preview,
 *   always paired with `isnew === "2"`). Variety lists also carry other collections' clips, all `isIntact === "1"`,
 *   so items whose `src_clip_id` is not the requested collection are dropped (2026-11-28: 13 of 45 in 快乐大本营 2021,
 *   4 of 57 in 大侦探 第十一季; none in dramas). Variety extras of the collection itself (加更, 纯享, 沉浸版…) are
 *   `isIntact === "1"` too; `selectBroadcastEpisodes` removes them only where broadcasts are labelled "第N期".
 * - `GET https://pcweb.api.mgtv.com/video/info?cid=<id>&vid=<firstVid>`
 *   Extracts `clipName` (title), `fstlvlType` (mediaType), and `detail.releaseTime` (4-digit premiere year).
 *
 * Tier 3 search status (intentionally stays Tier 2 — Ticket #30):
 * - Empirically verified unauthenticated search blocks (no auth/sign bypassing):
 *   - `GET https://mobileso.bz.mgtv.com/msite/search/v2` returns HTTP 403 (`Forbidden`).
 *   - `GET https://mobileso.bz.mgtv.com/pc/search/v1` returns HTTP 401 (`{"code":200,"data":{"listItems":[],"totalHits":0,"forbidden":2}}`).
 *   - `GET https://so.mgtv.com/so?k=...` returns an empty Nuxt SPA shell that loads results client-side from those gated APIs.
 * - The Android app's `GET https://mobileso.bz.mgtv.com/aphone/search/rebirth/v2` (Dalvik UA, app device params)
 *   answers without a sign, but is geo-filtered (2026-11-28): from Cloudflare Workers (SIN) and the HK egress relay,
 *   mainland-licensed dramas and films get no `mediaRebirthV2` card (去有风的地方, 小巷人家: none; 长安的荔枝: only
 *   Tencent's), while Mango variety still does. Empty results there would read as "not on Mango TV", so it is not used.
 * - Therefore `mgtvAdapter` intentionally remains `tier: 2` (no `search` method): exploration still targets it
 *   through `get_collection`, but `search_platform` does not offer it.
 */

const MGTV_ALLOWED_HOSTS = new Set(["mgtv.com", "www.mgtv.com", "m.mgtv.com", "w.mgtv.com"]);

const BARE_COLLECTION_PATTERN = /^([1-9]\d*)$/;
const URL_H_COLLECTION_PATH_PATTERN = /^\/h\/([1-9]\d*)\.html\/?$/i;
const URL_B_COLLECTION_PATH_PATTERN = /^\/b\/([1-9]\d*)\.html\/?$/i;
const URL_B_VIDEO_PATH_PATTERN = /^\/b\/([1-9]\d*)\/([1-9]\d*)\.html\/?$/i;

const MGTV_EPISODE_LIST_API = "https://pcweb.api.mgtv.com/episode/list";
const MGTV_VIDEO_INFO_API = "https://pcweb.api.mgtv.com/video/info";
const MGTV_PAGE_SIZE = 50;
const MGTV_MAX_EPISODE_PAGES = 50;

const MGTV_API_HEADERS: Record<string, string> = {
  referer: "https://www.mgtv.com/",
  accept: "application/json",
};

const MGTV_TV_CATEGORIES = new Set(["电视剧", "动漫", "综艺", "纪录片"]);
const MGTV_TV_CATEGORY_IDS = new Set(["1", "2", "50", "51"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function parseNumericIdString(value: unknown): string | null {
  const num = parsePositiveInt(value);
  return num !== null ? String(num) : null;
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

function parseDatePrefix(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const match = raw.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1]! : null;
}

function parseDurationSeconds(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.round(raw);
  }
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  const hmsMatch = trimmed.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (hmsMatch) {
    const hours = Number(hmsMatch[1]);
    const minutes = Number(hmsMatch[2]);
    const seconds = Number(hmsMatch[3]);
    const total = hours * 3600 + minutes * 60 + seconds;
    return total > 0 ? total : null;
  }
  const msMatch = trimmed.match(/^(\d{1,3}):(\d{2})$/);
  if (msMatch) {
    const minutes = Number(msMatch[1]);
    const seconds = Number(msMatch[2]);
    const total = minutes * 60 + seconds;
    return total > 0 ? total : null;
  }
  return null;
}

function mapMgtvMediaType(rawType: unknown, rawTypeId: unknown): MediaType | null {
  const typeLabel = nonEmptyString(rawType);
  if (typeLabel === "电影") {
    return "movie";
  }
  if (typeLabel && MGTV_TV_CATEGORIES.has(typeLabel)) {
    return "tv";
  }

  const typeId =
    typeof rawTypeId === "number" && Number.isInteger(rawTypeId)
      ? String(rawTypeId)
      : nonEmptyString(rawTypeId);
  if (typeId === "3") {
    return "movie";
  }
  if (typeId && MGTV_TV_CATEGORY_IDS.has(typeId)) {
    return "tv";
  }

  return null;
}

function parseMgtvJsonEnvelope(
  response: ExternalHttpResponse,
):
  | { ok: true; code: number; message: string | null; data: unknown }
  | { ok: false; transientReason: string } {
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, transientReason: `http_${response.status}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return { ok: false, transientReason: "invalid_json" };
  }

  if (!isRecord(parsed)) {
    return { ok: false, transientReason: "unexpected_payload" };
  }

  const code =
    typeof parsed.code === "number"
      ? parsed.code
      : typeof parsed.code === "string" && /^-?\d+$/.test(parsed.code.trim())
        ? Number(parsed.code.trim())
        : null;

  if (code === null || !Number.isInteger(code)) {
    return { ok: false, transientReason: "missing_code" };
  }

  return {
    ok: true,
    code,
    message: nonEmptyString(parsed.msg),
    data: parsed.data,
  };
}

export function parseMgtvInput(raw: string): ParsedNativeIdInput | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const bareMatch = trimmed.match(BARE_COLLECTION_PATTERN);
  if (bareMatch) {
    const id = bareMatch[1]!;
    return { kind: "collection", id, canonicalId: id };
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
  if (!MGTV_ALLOWED_HOSTS.has(host)) {
    return null;
  }

  const pathname = parsedUrl.pathname;

  const hMatch = pathname.match(URL_H_COLLECTION_PATH_PATTERN);
  if (hMatch) {
    const collectionId = hMatch[1]!;
    return { kind: "collection", id: collectionId, canonicalId: collectionId };
  }

  const bCollectionMatch = pathname.match(URL_B_COLLECTION_PATH_PATTERN);
  if (bCollectionMatch) {
    const collectionId = bCollectionMatch[1]!;
    return { kind: "collection", id: collectionId, canonicalId: collectionId };
  }

  const bVideoMatch = pathname.match(URL_B_VIDEO_PATH_PATTERN);
  if (bVideoMatch) {
    const collectionId = bVideoMatch[1]!;
    const videoId = bVideoMatch[2]!;
    return { kind: "video", id: videoId, canonicalId: collectionId };
  }

  return null;
}

async function fetchEpisodeListPage(
  collectionId: string,
  page: number,
  outbound: OutboundClient,
): Promise<
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; status: "not_found" | "transient_error"; reason: string }
> {
  const url = `${MGTV_EPISODE_LIST_API}?collection_id=${encodeURIComponent(collectionId)}&page=${page}&size=${MGTV_PAGE_SIZE}`;
  let response: ExternalHttpResponse;
  try {
    response = await outbound.fetchExternal({
      kind: "platform",
      namespace: "mgtv",
      url,
      method: "GET",
      headers: MGTV_API_HEADERS,
    });
  } catch (error) {
    return {
      ok: false,
      status: "transient_error",
      reason: error instanceof Error ? error.message : "mgtv_episode_list_request_failed",
    };
  }

  const envelope = parseMgtvJsonEnvelope(response);
  if (!envelope.ok) {
    return { ok: false, status: "transient_error", reason: envelope.transientReason };
  }

  if (envelope.code === 404) {
    return {
      ok: false,
      status: "not_found",
      reason: envelope.message ?? "mgtv_code_404",
    };
  }

  if (envelope.code !== 200) {
    return {
      ok: false,
      status: "transient_error",
      reason: `mgtv_code_${envelope.code}`,
    };
  }

  if (!isRecord(envelope.data)) {
    return {
      ok: false,
      status: "transient_error",
      reason: "missing_data",
    };
  }

  return { ok: true, data: envelope.data };
}

interface VideoInfoExtract {
  clipName: string | null;
  mediaType: MediaType | null;
  year: number | null;
}

async function fetchVideoInfo(
  collectionId: string,
  videoId: string,
  outbound: OutboundClient,
): Promise<{ ok: true; info: VideoInfoExtract } | { ok: false; reason: string }> {
  const url = `${MGTV_VIDEO_INFO_API}?cid=${encodeURIComponent(collectionId)}&vid=${encodeURIComponent(videoId)}`;
  let response: ExternalHttpResponse;
  try {
    response = await outbound.fetchExternal({
      kind: "platform",
      namespace: "mgtv",
      url,
      method: "GET",
      headers: MGTV_API_HEADERS,
    });
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "mgtv_video_info_request_failed",
    };
  }

  const envelope = parseMgtvJsonEnvelope(response);
  if (!envelope.ok) {
    return { ok: false, reason: envelope.transientReason };
  }

  if (envelope.code !== 200) {
    return { ok: false, reason: `mgtv_video_info_code_${envelope.code}` };
  }

  const data = isRecord(envelope.data) ? envelope.data : null;
  const info = data && isRecord(data.info) ? data.info : null;
  const detail = info && isRecord(info.detail) ? info.detail : null;

  return {
    ok: true,
    info: {
      clipName: nonEmptyString(info?.clipName),
      mediaType: mapMgtvMediaType(info?.fstlvlType, info?.fstlvlId),
      year: parseFourDigitYear(detail?.releaseTime),
    },
  };
}

export const mgtvAdapter: Tier2Adapter<"mgtv"> = {
  namespace: "mgtv",
  tier: 2,

  parseInput: parseMgtvInput,

  async canonicalize(raw) {
    const parsed = parseMgtvInput(raw);
    if (!parsed || parsed.canonicalId === null) {
      throw new InvalidNativeIdError(
        "mgtv",
        raw,
        "Expected Mango TV collection_id (digits) or mgtv.com /h/<id>.html or /b/<id>/<vid>.html URL",
      );
    }
    return parsed.canonicalId;
  },

  async fetchCollection(canonicalId, outbound): Promise<CollectionEvidenceResult> {
    const match = canonicalId.trim().match(BARE_COLLECTION_PATTERN);
    if (!match) {
      return { status: "not_found", reason: "invalid_canonical_id" };
    }
    const collectionId = match[1]!;

    const firstPage = await fetchEpisodeListPage(collectionId, 1, outbound);
    if (!firstPage.ok) {
      return firstPage.status === "not_found"
        ? { status: "not_found", reason: firstPage.reason }
        : { status: "transient_error", reason: firstPage.reason };
    }

    const firstData = firstPage.data;
    const listInfo = isRecord(firstData.info) ? firstData.info : null;
    const listInfoTitle = nonEmptyString(listInfo?.title);
    const listInfoType = nonEmptyString(listInfo?.type);
    const total = parseNonNegativeInt(firstData.total);
    const firstList = Array.isArray(firstData.list) ? firstData.list : null;

    if (total === 0 && (firstList === null || firstList.length === 0) && !listInfoTitle) {
      return { status: "not_found", reason: "mgtv_collection_not_found" };
    }

    const featureEpisodes: FeatureEpisode[] = [];
    const seenVideoIds = new Set<string>();
    let firstFeatureVid: string | null = null;
    let firstListVid: string | null = null;

    const collectPageItems = (rawList: unknown[]) => {
      for (const rawItem of rawList) {
        if (!isRecord(rawItem)) {
          continue;
        }
        // Variety lists lend in side collections' clips (慢直播, 直拍, 纯享…) as isIntact "1";
        // only `src_clip_id` tells them apart (`clip_id` is always the requested collection).
        const srcClipId = parseNumericIdString(rawItem.src_clip_id);
        if (srcClipId !== null && srcClipId !== collectionId) {
          continue;
        }
        const vid = parseNumericIdString(rawItem.video_id);
        if (vid !== null && firstListVid === null) {
          firstListVid = vid;
        }
        if (vid !== null) {
          if (seenVideoIds.has(vid)) {
            continue;
          }
          seenVideoIds.add(vid);
        }

        // Mango TV marks full feature episodes with isIntact === "1" and trailers/previews with "3".
        if (rawItem.isIntact !== "1") {
          continue;
        }

        if (vid !== null && firstFeatureVid === null) {
          firstFeatureVid = vid;
        }

        const title = nonEmptyString(rawItem.t1) ?? nonEmptyString(rawItem.t3);
        const longTitle = nonEmptyString(rawItem.t2);

        featureEpisodes.push({
          index: featureEpisodes.length + 1,
          ...(vid !== null ? { nativeEpisodeId: vid } : {}),
          ...(title ? { title } : {}),
          ...(longTitle ? { longTitle } : {}),
          durationSeconds: parseDurationSeconds(rawItem.time),
          airDate: parseDatePrefix(rawItem.ts),
        });
      }
    };

    if (firstList !== null) {
      collectPageItems(firstList);
    }

    const reportedTotalPages = parsePositiveInt(firstData.total_page) ?? 1;
    if (reportedTotalPages > MGTV_MAX_EPISODE_PAGES) {
      return { status: "transient_error", reason: "episode_list_too_many_pages" };
    }

    for (let page = 2; page <= reportedTotalPages; page += 1) {
      const nextPage = await fetchEpisodeListPage(collectionId, page, outbound);
      if (!nextPage.ok) {
        return { status: "transient_error", reason: nextPage.reason };
      }
      const nextList = Array.isArray(nextPage.data.list) ? nextPage.data.list : null;
      if (!nextList || nextList.length === 0) {
        break;
      }
      collectPageItems(nextList);
    }

    const firstVid = firstFeatureVid ?? firstListVid;
    let videoInfo: VideoInfoExtract | null = null;
    if (firstVid !== null) {
      const videoInfoResult = await fetchVideoInfo(collectionId, firstVid, outbound);
      if (!videoInfoResult.ok) {
        return { status: "transient_error", reason: videoInfoResult.reason };
      }
      videoInfo = videoInfoResult.info;
    }

    const title = videoInfo?.clipName ?? listInfoTitle;
    if (!title) {
      return { status: "transient_error", reason: "missing_title" };
    }

    const aliases: string[] = [];
    if (videoInfo?.clipName && listInfoTitle && listInfoTitle !== videoInfo.clipName) {
      aliases.push(listInfoTitle);
    }

    const mediaType = videoInfo?.mediaType ?? mapMgtvMediaType(listInfoType, null);
    const year = videoInfo?.year ?? null;
    const broadcast = selectBroadcastEpisodes(featureEpisodes);
    const featureEpisodeCount = broadcast.length > 0 ? broadcast.length : null;

    return {
      status: "found",
      info: {
        namespace: "mgtv",
        canonicalId: collectionId,
        title,
        ...(aliases.length > 0 ? { aliases } : {}),
        year,
        mediaType,
        featureEpisodeCount,
        featureEpisodes: broadcast,
      },
    };
  },
};
