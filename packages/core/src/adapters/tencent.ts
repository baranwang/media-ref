import type { MediaType } from "@media-ref/client";
import type { ExternalHttpResponse, OutboundClient } from "../outbound.ts";
import { isBroadcastLabel, selectBroadcastEpisodes } from "./variety.ts";
import {
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
 * Tencent Video (`tencent`, `v.qq.com`) Platform Adapter — Tier 1, 2 & 3.
 *
 * ## Canonical ID (`canonicalId`)
 * - 15-character lowercase alphanumeric Cover ID (`cid`), matching `/^[a-z0-9]{15}$/`
 *   (e.g. `mzc00200mp8vo9b`, `mzc002007knmh3g`, `m441e3rjq9kwpsc`, `53q0eh78q97e4d1`).
 *
 * ## Tier 1 Input Conversion Rules (no outbound calls required)
 * - Bare `cid`: `<cid>` → `<cid>`
 * - Desktop cover page: `https://v.qq.com/x/cover/<cid>.html` (or without `.html`) → `<cid>`
 * - Desktop episode page: `https://v.qq.com/x/cover/<cid>/<vid>.html` → `<cid>`
 * - Detail page (also used by `bangumi-data`): `https://v.qq.com/detail/<firstChar>/<cid>.html` → `<cid>`
 * - Mobile play query URL: `https://m.v.qq.com/x/m/play?cid=<cid>...` or `https://m.v.qq.com/play.html?cid=<cid>...` → `<cid>`
 * - Mobile cover path URL: `https://m.v.qq.com/cover/<firstChar>/<cid>.html`,
 *   `https://m.v.qq.com/cover/<firstChar>/<cid>/<vid>.html`,
 *   `https://m.v.qq.com/cover/<cid>.html`, `https://m.v.qq.com/x/cover/<cid>(/<vid>).html` → `<cid>`
 * - Rejected (`InvalidNativeIdError`): video-only URLs without a cover ID (`https://v.qq.com/x/page/<vid>.html`),
 *   non-Tencent hosts, non-HTTP(S) URLs, and malformed/uppercase/wrong-length strings.
 *
 * ## Tier 2 Evidence Retrieval (Unauthenticated Public RPC via `OutboundClient`)
 * - Endpoint: `POST https://pbaccess.video.qq.com/trpc.universal_backend_service.page_server_rpc.PageServer/GetPageData?video_appid=3000010&vplatform=2`
 * - Collection metadata: `page_id: "detail_page_introduction"` (`title`, `year`, `type`/`type_name`, `episode_all`).
 * - Feature episode list: `page_id: "vsite_episode_list"`, paginated across `module_params.tabs[].page_context`.
 *   Strictly filters feature episodes (`is_trailer === "0"` and numeric `title`/`c_title_output` for series,
 *   excluding trailers and bonus `彩蛋` clips; the collection title is ignored when looking for those
 *   markers, so the film 幕后玩家 keeps its feature).
 * - Chaptered cids: some variety cids hold several seasons as chapters (毛雪汪 `mzc00200xkb43kw`:
 *   2021冬 … 2026秋). The episode list then returns only the first chapter, with a numeric
 *   `episode_on_chapter` on its items, and the chapter names appear only in search results. Such a cid keeps the
 *   episodes it listed but reports `featureEpisodeCount: null`, so the Evidence Gate never approves
 *   one chapter's count as the whole cid's.
 * ## Tier 3 Search (`search`)
 * - Endpoint: `POST https://pbaccess.video.qq.com/trpc.videosearch.mobile_search.MultiTerminalSearch/MbSearch?vplatform=2`
 *   with body `{version:"25071701", clientType:1, query, pagenum, pagesize:30, isPrefetch:true,
 *   extraInfo:{multi_terminal_pc:"1"}}` and only the JSON/Origin/Referer headers: no cookies or
 *   signed client headers. Verified 2026-11-28 from a residential IP and from a Cloudflare Workers
 *   egress (`wrangler dev --remote`). The older `HttpSearch` / `SmartboxCgi/GetSmartbox` RPCs still
 *   answer `{"ret":10401}` without a signed client context.
 * - Reads `data.normalList.itemList[]`, then `data.areaBoxList[].itemList[]` (相关影视 recommendations)
 *   keeping only items whose title contains the keyword. Each item's cid is `doc.id`.
 * - Keeps only covers: a 15-character cid, `videoInfo.year > 0`, a `qq` entry in `playSites`,
 *   `typeName` in 电视剧 / 动漫 / 电影 / 纪录片 / 综艺, and no `纯享` clip title. `<em>` highlight
 *   tags are stripped from titles; `subjectDoc.videoNum` is the episode count.
 */

const TENCENT_ALLOWED_HOSTS = new Set(["v.qq.com", "m.v.qq.com"]);

const CANONICAL_CID_PATTERN = /^[a-z0-9]{15}$/;

const URL_X_COVER_PATTERN = /^\/x\/cover\/([a-z0-9]{15})(?:\/[a-zA-Z0-9]+)?(?:\.html)?\/?$/;
const URL_DETAIL_PATTERN = /^\/detail\/[a-z0-9]\/([a-z0-9]{15})(?:\.html)?\/?$/;
const URL_COVER_WITH_PREFIX_PATTERN =
  /^\/cover\/[a-z0-9]\/([a-z0-9]{15})(?:\/[a-zA-Z0-9]+)?(?:\.html)?\/?$/;
const URL_COVER_DIRECT_PATTERN = /^\/cover\/([a-z0-9]{15})(?:\/[a-zA-Z0-9]+)?(?:\.html)?\/?$/;
const URL_MOBILE_QUERY_PATHS = new Set([
  "/x/m/play",
  "/x/m/play/",
  "/x/m/detail",
  "/x/m/detail/",
  "/play.html",
  "/detail.html",
  "/z/msite/play-short/index.html",
]);

const TENCENT_PAGE_DATA_URL =
  "https://pbaccess.video.qq.com/trpc.universal_backend_service.page_server_rpc.PageServer/GetPageData?video_appid=3000010&vplatform=2";

const TENCENT_RPC_HEADERS: Record<string, string> = {
  "content-type": "application/json",
  accept: "application/json",
  referer: "https://v.qq.com/",
  origin: "https://v.qq.com",
};

const TENCENT_SEARCH_URL =
  "https://pbaccess.video.qq.com/trpc.videosearch.mobile_search.MultiTerminalSearch/MbSearch?vplatform=2";
const TENCENT_SEARCH_PAGE_SIZE = 30;
const TENCENT_SEARCH_TYPE_NAMES = new Set(["电视剧", "动漫", "电影", "纪录片", "综艺"]);

const NUMERIC_EPISODE_LABEL_PATTERN = /^0*[1-9]\d*$/;
const BONUS_OR_TRAILER_LABEL_PATTERN =
  /彩蛋|预告|花絮|特辑|先导|片段|看点|片花|番外|宣传片|幕后|解读|剧透|抢先看|MV/iu;
const MAX_EPISODE_TAB_PAGES = 100;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseFourDigitYear(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isInteger(raw) && raw >= 1800 && raw <= 3000 ? raw : null;
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
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null;
  }
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const secs = Number(trimmed);
    return Number.isSafeInteger(secs) && secs > 0 ? secs : null;
  }
  const hmsMatch = trimmed.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (hmsMatch) {
    const hours = hmsMatch[1] ? Number(hmsMatch[1]) : 0;
    const mins = Number(hmsMatch[2]);
    const secs = Number(hmsMatch[3]);
    const total = hours * 3600 + mins * 60 + secs;
    return total > 0 ? total : null;
  }
  return null;
}

function parseAirDate(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const match = raw.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1]! : null;
}

function mapTencentMediaType(raw: unknown): MediaType | null {
  if (typeof raw === "number") {
    if (raw === 1) {
      return "movie";
    }
    if (raw === 2 || raw === 3 || raw === 9 || raw === 10) {
      return "tv";
    }
    return null;
  }
  const str = nonEmptyString(raw);
  if (!str) {
    return null;
  }
  if (str === "1" || str === "电影") {
    return "movie";
  }
  if (
    str === "2" ||
    str === "3" ||
    str === "9" ||
    str === "10" ||
    str === "电视剧" ||
    str === "动漫" ||
    str === "综艺" ||
    str === "纪录片"
  ) {
    return "tv";
  }
  return null;
}

function collectAliases(params: Record<string, unknown>, primaryTitle: string): string[] {
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

  addCandidate(params.english_title);
  addCandidate(params.foreign_title);
  addCandidate(params.second_title);

  const rawAlias = nonEmptyString(params.alias);
  if (rawAlias) {
    addCandidate(rawAlias);
    for (const part of rawAlias.split(/[/／、,，|;；]/)) {
      addCandidate(part);
    }
  }

  return aliases;
}

type RpcEnvelopeResult =
  | { ok: true; moduleListDatas: unknown[] }
  | { ok: false; transientReason: string };

function parseTencentRpcEnvelope(response: ExternalHttpResponse): RpcEnvelopeResult {
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, transientReason: `http_${response.status}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return { ok: false, transientReason: "invalid_json" };
  }

  const root = asRecord(parsed);
  if (!root) {
    return { ok: false, transientReason: "unexpected_payload" };
  }

  if (typeof root.ret !== "number") {
    return { ok: false, transientReason: "missing_ret" };
  }

  if (root.ret !== 0) {
    return { ok: false, transientReason: `tencent_rpc_ret_${root.ret}` };
  }

  const data = asRecord(root.data);
  if (!data || !Array.isArray(data.module_list_datas)) {
    return { ok: false, transientReason: "missing_module_list_datas" };
  }

  return { ok: true, moduleListDatas: data.module_list_datas };
}

async function postPageData(
  outbound: OutboundClient,
  pageParams: Record<string, string>,
): Promise<RpcEnvelopeResult> {
  let response: ExternalHttpResponse;
  try {
    response = await outbound.fetchExternal({
      kind: "platform",
      namespace: "tencent",
      url: TENCENT_PAGE_DATA_URL,
      method: "POST",
      headers: TENCENT_RPC_HEADERS,
      body: JSON.stringify({
        page_params: pageParams,
        has_cache: 1,
      }),
    });
  } catch (error) {
    return {
      ok: false,
      transientReason: error instanceof Error ? error.message : "tencent_request_failed",
    };
  }

  return parseTencentRpcEnvelope(response);
}

function collectModuleDatas(moduleListDatas: readonly unknown[]): Record<string, unknown>[] {
  const modules: Record<string, unknown>[] = [];
  for (const container of moduleListDatas) {
    const containerRecord = asRecord(container);
    if (!containerRecord || !Array.isArray(containerRecord.module_datas)) {
      continue;
    }
    for (const mod of containerRecord.module_datas) {
      const modRecord = asRecord(mod);
      if (modRecord) {
        modules.push(modRecord);
      }
    }
  }
  return modules;
}

function extractModuleItemParams(mod: Record<string, unknown>): Record<string, unknown>[] {
  const itemDataLists = asRecord(mod.item_data_lists);
  if (!itemDataLists || !Array.isArray(itemDataLists.item_datas)) {
    return [];
  }
  const items: Record<string, unknown>[] = [];
  for (const item of itemDataLists.item_datas) {
    const itemRecord = asRecord(item);
    const params = asRecord(itemRecord?.item_params);
    if (params) {
      items.push(params);
    }
  }
  return items;
}

function extractIntroItemParams(
  moduleListDatas: readonly unknown[],
): Record<string, unknown> | null {
  const modules = collectModuleDatas(moduleListDatas);
  let fallback: Record<string, unknown> | null = null;
  for (const mod of modules) {
    const items = extractModuleItemParams(mod);
    for (const params of items) {
      if (fallback === null) {
        fallback = params;
      }
      if (
        nonEmptyString(params.title) ??
        nonEmptyString(params.cover_title) ??
        nonEmptyString(params.c_title)
      ) {
        return params;
      }
    }
  }
  return fallback;
}

function isFeatureEpisodeItem(
  params: Record<string, unknown>,
  mediaType: MediaType | null,
  collectionTitle: string,
): boolean {
  const isTrailer = params.is_trailer;
  if (isTrailer !== "0" && isTrailer !== 0) {
    return false;
  }

  const title = nonEmptyString(params.title);
  const cTitleOutput = nonEmptyString(params.c_title_output);
  // The collection's own name is no extra marker: the film 幕后玩家 lists its feature as "幕后玩家".
  const isExtraLabel = (label: string | null) =>
    label !== null && BONUS_OR_TRAILER_LABEL_PATTERN.test(label.replaceAll(collectionTitle, ""));

  if (isExtraLabel(title) || isExtraLabel(cTitleOutput)) {
    return false;
  }

  if (mediaType === "movie") {
    return Boolean(title ?? cTitleOutput ?? nonEmptyString(params.play_title));
  }

  const titleIsNumeric = title !== null && NUMERIC_EPISODE_LABEL_PATTERN.test(title);
  const outputIsNumeric = cTitleOutput !== null && NUMERIC_EPISODE_LABEL_PATTERN.test(cTitleOutput);
  // Variety broadcasts are labelled "第N期上：…"; selectBroadcastEpisodes drops the extras later.
  const isBroadcast =
    (title !== null && isBroadcastLabel(title)) ||
    (cTitleOutput !== null && isBroadcastLabel(cTitleOutput));
  return titleIsNumeric || outputIsNumeric || isBroadcast;
}

function appendFilteredFeatureEpisodes(
  rawItems: readonly Record<string, unknown>[],
  mediaType: MediaType | null,
  collectionTitle: string,
  seenVids: Set<string>,
  target: FeatureEpisode[],
): void {
  for (const params of rawItems) {
    if (!isFeatureEpisodeItem(params, mediaType, collectionTitle)) {
      continue;
    }

    const vid = nonEmptyString(params.vid);
    if (vid) {
      if (seenVids.has(vid)) {
        continue;
      }
      seenVids.add(vid);
    }

    const displayTitle = nonEmptyString(params.c_title_output) ?? nonEmptyString(params.title);
    const longTitle = nonEmptyString(params.play_title) ?? nonEmptyString(params.union_title);

    target.push({
      index: target.length + 1,
      ...(vid ? { nativeEpisodeId: vid } : {}),
      ...(displayTitle ? { title: displayTitle } : {}),
      ...(longTitle ? { longTitle } : {}),
      durationSeconds: parseDurationSeconds(params.duration),
      airDate: parseAirDate(params.publish_date),
    });
  }
}

interface ParsedEpisodeTab {
  selected: boolean;
  pageContext: string;
}

function isTruthyRpcFlag(value: unknown): boolean {
  return value === true || value === 1 || value === "true" || value === "1";
}

function extractEpisodeTabs(params: Record<string, unknown> | null): ParsedEpisodeTab[] {
  let entries = params?.tabs;
  if (typeof entries === "string") {
    try {
      entries = JSON.parse(entries);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    const tab = asRecord(entry);
    const pageContext = nonEmptyString(tab?.page_context);
    return pageContext ? [{ pageContext, selected: isTruthyRpcFlag(tab?.selected) }] : [];
  });
}

function nextPageContext(params: Record<string, unknown> | null, current: string): string | null {
  if (!isTruthyRpcFlag(params?.has_next)) return null;
  const next = nonEmptyString(params?.next_page_context);
  return next && next !== current ? next : nonEmptyString(params?.page_context);
}

function resolveInitialTabIndex(
  tabs: readonly ParsedEpisodeTab[],
  initialRawItemCount: number,
): number {
  if (tabs.length === 0) {
    return -1;
  }
  const explicit = tabs.findIndex((tab) => tab.selected);
  if (explicit >= 0) {
    return explicit;
  }
  return initialRawItemCount > 0 ? 0 : -1;
}

function buildEpisodeListPageParams(cid: string, pageContext: string): Record<string, string> {
  return {
    req_from: "web_vsite",
    page_id: "vsite_episode_list",
    page_type: "detail_operation",
    id_type: "1",
    page_size: "30",
    cid,
    vid: "",
    lid: "",
    page_num: "",
    page_context: pageContext,
    detail_page_type: "1",
  };
}

function makeCoverParsed(cid: string): ParsedNativeIdInput {
  return {
    kind: "cover",
    id: cid,
    canonicalId: cid,
  };
}

export function parseTencentInput(raw: string): ParsedNativeIdInput | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (CANONICAL_CID_PATTERN.test(trimmed)) {
    return makeCoverParsed(trimmed);
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
  if (!TENCENT_ALLOWED_HOSTS.has(host)) {
    return null;
  }

  const pathname = parsedUrl.pathname;

  // Video-only pages (v.qq.com/x/page/<vid>.html) have no collection-level cid.
  if (pathname.startsWith("/x/page/")) {
    return null;
  }

  const xCoverMatch = pathname.match(URL_X_COVER_PATTERN);
  if (xCoverMatch) {
    return makeCoverParsed(xCoverMatch[1]!);
  }

  const detailMatch = pathname.match(URL_DETAIL_PATTERN);
  if (detailMatch) {
    return makeCoverParsed(detailMatch[1]!);
  }

  const coverPrefixMatch = pathname.match(URL_COVER_WITH_PREFIX_PATTERN);
  if (coverPrefixMatch) {
    return makeCoverParsed(coverPrefixMatch[1]!);
  }

  const coverDirectMatch = pathname.match(URL_COVER_DIRECT_PATTERN);
  if (coverDirectMatch) {
    return makeCoverParsed(coverDirectMatch[1]!);
  }

  if (host === "m.v.qq.com" && URL_MOBILE_QUERY_PATHS.has(pathname)) {
    const queryCid = parsedUrl.searchParams.get("cid")?.trim() ?? "";
    if (CANONICAL_CID_PATTERN.test(queryCid)) {
      return makeCoverParsed(queryCid);
    }
  }

  return null;
}

/** A search item as a candidate, or null when it is not a Tencent-hosted feature cover. */
function toSearchCandidate(
  rawItem: unknown,
  keyword: string | null,
): AdapterSearchCandidate | null {
  const item = asRecord(rawItem);
  const info = asRecord(item?.videoInfo);
  const cid = nonEmptyString(asRecord(item?.doc)?.id);
  if (!info || !cid || !CANONICAL_CID_PATTERN.test(cid)) {
    return null;
  }
  const title = nonEmptyString(nonEmptyString(info.title)?.replace(/<\/?em>/g, ""));
  const year = parseFourDigitYear(info.year);
  const typeName = nonEmptyString(info.typeName);
  const sites = Array.isArray(info.playSites) ? info.playSites : [];
  if (
    !title ||
    year === null ||
    !typeName ||
    !TENCENT_SEARCH_TYPE_NAMES.has(typeName) ||
    !sites.some((site) => asRecord(site)?.enName === "qq") ||
    title.includes("纯享") ||
    (keyword !== null && !title.includes(keyword))
  ) {
    return null;
  }
  const videoNum = asRecord(info.subjectDoc)?.videoNum;
  return {
    canonicalId: cid,
    title,
    year,
    mediaType: mapTencentMediaType(typeName),
    episodeCount: typeof videoNum === "number" && videoNum > 0 ? videoNum : null,
    url: `https://v.qq.com/x/cover/${cid}.html`,
  };
}

export const tencentAdapter: Tier3Adapter<"tencent"> = {
  namespace: "tencent",
  tier: 3,

  parseInput: parseTencentInput,

  async canonicalize(raw, _outbound) {
    const parsed = parseTencentInput(raw);
    if (!parsed || parsed.canonicalId === null) {
      throw new InvalidNativeIdError(
        "tencent",
        raw,
        "Expected Tencent Video 15-character lowercase cid or collection URL (x/cover, detail, m.v.qq.com/x/m/play?cid=...)",
      );
    }
    return parsed.canonicalId;
  },

  async fetchCollection(
    canonicalId: string,
    outbound: OutboundClient,
  ): Promise<CollectionEvidenceResult> {
    const cid = canonicalId.trim();
    if (!CANONICAL_CID_PATTERN.test(cid)) {
      return { status: "not_found", reason: "invalid_canonical_id" };
    }

    const introEnvelope = await postPageData(outbound, {
      req_from: "web",
      cid,
      vid: "",
      lid: "",
      page_type: "detail_operation",
      page_id: "detail_page_introduction",
    });
    if (!introEnvelope.ok) {
      return {
        status: "transient_error",
        reason: introEnvelope.transientReason,
      };
    }

    if (introEnvelope.moduleListDatas.length === 0) {
      return {
        status: "not_found",
        reason: "empty_module_list_datas",
      };
    }

    const introParams = extractIntroItemParams(introEnvelope.moduleListDatas);
    if (!introParams) {
      return {
        status: "not_found",
        reason: "empty_intro_item_datas",
      };
    }

    const title =
      nonEmptyString(introParams.title) ??
      nonEmptyString(introParams.cover_title) ??
      nonEmptyString(introParams.c_title);
    if (!title) {
      return {
        status: "transient_error",
        reason: "missing_title",
      };
    }

    const year =
      parseFourDigitYear(introParams.year) ??
      parseFourDigitYear(introParams.cover_year) ??
      parseFourDigitYear(introParams.show_year) ??
      parseFourDigitYear(introParams.publish_date) ??
      parseFourDigitYear(introParams.release_date);

    const mediaType =
      mapTencentMediaType(introParams.type) ??
      mapTencentMediaType(introParams.type_name) ??
      mapTencentMediaType(introParams.channel_name);

    const originalTitle =
      nonEmptyString(introParams.foreign_title) ?? nonEmptyString(introParams.english_title);
    const aliases = collectAliases(introParams, title);

    const episodeEnvelope = await postPageData(outbound, buildEpisodeListPageParams(cid, ""));
    if (!episodeEnvelope.ok) {
      return {
        status: "transient_error",
        reason: episodeEnvelope.transientReason,
      };
    }

    const episodeModules = collectModuleDatas(episodeEnvelope.moduleListDatas);
    const featureEpisodes: FeatureEpisode[] = [];
    const seenVids = new Set<string>();
    const seenContexts = new Set<string>([""]);
    const tabContexts = new Set<string>();
    type Page = { context: string; module?: Record<string, unknown> };
    const pages: Page[] = [];
    for (const mod of episodeModules) {
      const params = asRecord(mod.module_params);
      const tabs = extractEpisodeTabs(params);
      if (!tabs.length) {
        pages.push({ context: "", module: mod });
        continue;
      }
      const count = extractModuleItemParams(mod).length;
      const selected = resolveInitialTabIndex(tabs, count);
      for (const [index, tab] of tabs.entries()) {
        tabContexts.add(tab.pageContext);
        const initial =
          index === selected && (count > 0 || nextPageContext(params, tab.pageContext));
        if (initial) seenContexts.add(tab.pageContext);
        pages.push({ context: tab.pageContext, ...(initial ? { module: mod } : {}) });
      }
    }

    // Finish each module's cursor chain before the next tab/module takes its place in the list.
    pages.reverse();
    let fetchedPages = 0;
    let chaptered = false;
    while (pages.length) {
      const { context, module } = pages.pop()!;
      if (module) {
        const items = extractModuleItemParams(module);
        // A position within a season chapter; sub-category chapters label items "正片" instead.
        chaptered ||= items.some((params) =>
          NUMERIC_EPISODE_LABEL_PATTERN.test(nonEmptyString(params.episode_on_chapter) ?? ""),
        );
        appendFilteredFeatureEpisodes(items, mediaType, title, seenVids, featureEpisodes);
        const next = nextPageContext(asRecord(module.module_params), context);
        if (next && !tabContexts.has(next)) pages.push({ context: next });
        continue;
      }
      if (seenContexts.has(context)) continue;
      if (fetchedPages >= MAX_EPISODE_TAB_PAGES)
        return { status: "transient_error", reason: "episode_page_limit" };
      seenContexts.add(context);
      fetchedPages++;
      const page = await postPageData(outbound, buildEpisodeListPageParams(cid, context));
      if (!page.ok) return { status: "transient_error", reason: page.transientReason };
      for (const mod of collectModuleDatas(page.moduleListDatas).reverse()) {
        pages.push({ context, module: mod });
      }
    }

    const broadcast = selectBroadcastEpisodes(featureEpisodes);
    return {
      status: "found",
      info: {
        namespace: "tencent",
        canonicalId: cid,
        title,
        ...(originalTitle ? { originalTitle } : {}),
        ...(aliases.length > 0 ? { aliases } : {}),
        year,
        mediaType,
        // A chaptered cid lists only its first chapter here, so this count is not the whole cid's.
        featureEpisodeCount: broadcast.length > 0 && !chaptered ? broadcast.length : null,
        featureEpisodes: broadcast,
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

    let response: ExternalHttpResponse;
    try {
      response = await outbound.fetchExternal({
        kind: "platform",
        namespace: "tencent",
        url: TENCENT_SEARCH_URL,
        method: "POST",
        headers: TENCENT_RPC_HEADERS,
        body: JSON.stringify({
          version: "25071701",
          clientType: 1,
          query: keyword,
          pagenum: page - 1,
          pagesize: TENCENT_SEARCH_PAGE_SIZE,
          isPrefetch: true,
          extraInfo: { multi_terminal_pc: "1" },
        }),
      });
    } catch (error) {
      return {
        status: "transient_error",
        reason: error instanceof Error ? error.message : "tencent_search_request_failed",
      };
    }
    if (response.status < 200 || response.status >= 300) {
      return { status: "transient_error", reason: `http_${response.status}` };
    }

    let root: Record<string, unknown> | null;
    try {
      root = asRecord(JSON.parse(response.body));
    } catch {
      return { status: "transient_error", reason: "invalid_json" };
    }
    if (!root || typeof root.ret !== "number") {
      return { status: "transient_error", reason: "missing_ret" };
    }
    if (root.ret !== 0) {
      return { status: "transient_error", reason: `tencent_rpc_ret_${root.ret}` };
    }
    const data = asRecord(root.data);
    if (data && typeof data.errcode === "number" && data.errcode !== 0) {
      return { status: "transient_error", reason: `tencent_search_errcode_${data.errcode}` };
    }

    const normalItems = asRecord(data?.normalList)?.itemList;
    const boxes = Array.isArray(data?.areaBoxList) ? data.areaBoxList : [];
    const ranked = [
      ...(Array.isArray(normalItems) ? normalItems : []).map((item) => ({ item, keyword: null })),
      // Related-film boxes recommend unrelated titles too; keep only those naming the keyword.
      ...boxes.flatMap((box) => {
        const items = asRecord(box)?.itemList;
        return (Array.isArray(items) ? items : []).map((item) => ({ item, keyword }));
      }),
    ];

    const limit =
      query.limit !== undefined && Number.isInteger(query.limit) && query.limit > 0
        ? query.limit
        : null;
    const seen = new Set<string>();
    const candidates: AdapterSearchCandidate[] = [];
    for (const { item, keyword: mustContain } of ranked) {
      const candidate = toSearchCandidate(item, mustContain);
      if (!candidate || seen.has(candidate.canonicalId)) {
        continue;
      }
      seen.add(candidate.canonicalId);
      candidates.push(candidate);
      if (limit !== null && candidates.length >= limit) {
        break;
      }
    }
    return { status: "ok", candidates };
  },
};
