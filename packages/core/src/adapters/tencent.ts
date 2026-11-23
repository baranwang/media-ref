import type { MediaType } from "@media-ref/client";
import type { ExternalHttpResponse, OutboundClient } from "../outbound.ts";
import {
  InvalidNativeIdError,
  type CollectionEvidenceResult,
  type FeatureEpisode,
  type ParsedNativeIdInput,
  type Tier2Adapter,
} from "./types.ts";

/**
 * Tencent Video (`tencent`, `v.qq.com`) Platform Adapter — Tier 1 & Tier 2.
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
 *   excluding trailers and bonus `彩蛋` clips).
 * ## Tier 3 Search Status (Intentionally Stays Tier 2 — Ticket #30)
 * Empirically verified unauthenticated search blocks (no auth/CAPTCHA bypassing):
 * - `pbaccess` `MultiTerminalSearch/HttpSearch` & `SmartboxCgi/GetSmartbox` return HTTP 200
 *   `{"ret":10401,"msg":"unknow error."}` without signed/authenticated client context.
 * - `https://v.qq.com/x/search/?q=...` returns a ~2.8 KB client-only SPA shell with no SSR results.
 * - Legacy `union.video.qq.com/fcgi-bin/data` returns `{"errorno":-111013,"errormsg":"禁止外部访问接口"}`
 *   (partner auth required), and `s.video.qq.com` times out on TLS handshake.
 * - Therefore `tencentAdapter` intentionally remains `tier: 2` (no `search` method) and is excluded
 *   from automated exploration job target lists.
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
): boolean {
  const isTrailer = params.is_trailer;
  if (isTrailer !== "0" && isTrailer !== 0) {
    return false;
  }

  const title = nonEmptyString(params.title);
  const cTitleOutput = nonEmptyString(params.c_title_output);

  if (
    (title && BONUS_OR_TRAILER_LABEL_PATTERN.test(title)) ||
    (cTitleOutput && BONUS_OR_TRAILER_LABEL_PATTERN.test(cTitleOutput))
  ) {
    return false;
  }

  if (mediaType === "movie") {
    return Boolean(title ?? cTitleOutput ?? nonEmptyString(params.play_title));
  }

  const titleIsNumeric = title !== null && NUMERIC_EPISODE_LABEL_PATTERN.test(title);
  const outputIsNumeric = cTitleOutput !== null && NUMERIC_EPISODE_LABEL_PATTERN.test(cTitleOutput);
  return titleIsNumeric || outputIsNumeric;
}

function appendFilteredFeatureEpisodes(
  rawItems: readonly Record<string, unknown>[],
  mediaType: MediaType | null,
  seenVids: Set<string>,
  target: FeatureEpisode[],
): void {
  for (const params of rawItems) {
    if (!isFeatureEpisodeItem(params, mediaType)) {
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

function isTabSelected(value: unknown): boolean {
  return value === true || value === 1 || value === "true" || value === "1";
}

function extractEpisodeTabs(modules: readonly Record<string, unknown>[]): ParsedEpisodeTab[] {
  const tabs: ParsedEpisodeTab[] = [];
  for (const mod of modules) {
    const moduleParams = asRecord(mod.module_params);
    const rawTabs = moduleParams?.tabs;
    let parsedList: unknown = rawTabs;
    if (typeof rawTabs === "string") {
      const trimmed = rawTabs.trim();
      if (trimmed.length === 0) {
        continue;
      }
      try {
        parsedList = JSON.parse(trimmed);
      } catch {
        continue;
      }
    }
    if (!Array.isArray(parsedList)) {
      continue;
    }
    for (const entry of parsedList) {
      const tabRecord = asRecord(entry);
      if (!tabRecord) {
        continue;
      }
      const pageContext = nonEmptyString(tabRecord.page_context);
      if (!pageContext) {
        continue;
      }
      tabs.push({
        selected: isTabSelected(tabRecord.selected),
        pageContext,
      });
    }
  }
  return tabs;
}

function selectRemainingTabContexts(
  tabs: readonly ParsedEpisodeTab[],
  initialItemCount: number,
): string[] {
  if (tabs.length === 0) {
    return [];
  }
  const hasExplicitSelection = tabs.some((tab) => tab.selected);
  const visited = new Set<string>();
  const remaining: string[] = [];

  for (let i = 0; i < tabs.length; i += 1) {
    const tab = tabs[i]!;
    if (hasExplicitSelection && tab.selected) {
      visited.add(tab.pageContext);
      continue;
    }
    if (!hasExplicitSelection && i === 0 && initialItemCount > 0) {
      visited.add(tab.pageContext);
      continue;
    }
    if (visited.has(tab.pageContext)) {
      continue;
    }
    visited.add(tab.pageContext);
    remaining.push(tab.pageContext);
    if (remaining.length >= MAX_EPISODE_TAB_PAGES) {
      break;
    }
  }

  return remaining;
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

export const tencentAdapter: Tier2Adapter<"tencent"> = {
  namespace: "tencent",
  tier: 2,

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

    const featureEpisodes: FeatureEpisode[] = [];
    const seenVids = new Set<string>();
    const episodeModules = collectModuleDatas(episodeEnvelope.moduleListDatas);
    let initialRawItemCount = 0;
    for (const mod of episodeModules) {
      const items = extractModuleItemParams(mod);
      initialRawItemCount += items.length;
      appendFilteredFeatureEpisodes(items, mediaType, seenVids, featureEpisodes);
    }

    const remainingContexts = selectRemainingTabContexts(
      extractEpisodeTabs(episodeModules),
      initialRawItemCount,
    );
    for (const pageContext of remainingContexts) {
      const nextPage = await postPageData(outbound, buildEpisodeListPageParams(cid, pageContext));
      if (!nextPage.ok) {
        return {
          status: "transient_error",
          reason: nextPage.transientReason,
        };
      }
      const nextModules = collectModuleDatas(nextPage.moduleListDatas);
      for (const mod of nextModules) {
        appendFilteredFeatureEpisodes(
          extractModuleItemParams(mod),
          mediaType,
          seenVids,
          featureEpisodes,
        );
      }
    }

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
        featureEpisodeCount: featureEpisodes.length > 0 ? featureEpisodes.length : null,
        featureEpisodes,
      },
    };
  },
};
