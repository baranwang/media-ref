import type {
  CatalogNamespace,
  MediaType,
  Namespace,
  NormalizedSegment,
  SeasonSnapshot,
} from "@media-ref/client";
import type { CollectionInfo } from "./adapters/types.ts";

export type EvidenceGateDecision = "pass" | "needs_review";

export interface CatalogEvidence {
  namespace: CatalogNamespace;
  canonicalId: string;
  mediaType: MediaType;
  title: string;
  originalTitle?: string | null;
  aliases?: readonly string[];
  year: number | null;
  seasons: readonly SeasonSnapshot[];
  /**
   * Air year per episode, by season then episode number. Fetched only for seasons a submitted
   * segment starts partway through; segment year checks fall back to the season premiere year.
   */
  episodeAirYears?: Readonly<Record<number, Readonly<Record<number, number | null>>>>;
  /** Optional explicit episode count for single-season catalogs (e.g., Douban/Bangumi) or movies. */
  episodeCount?: number | null;
  /**
   * External IDs fetched from the catalog during evidence check (e.g., tmdb, imdb, tvdb, trakt).
   * NEVER populated from submission input.
   */
  externalIds: Partial<Record<Namespace, string>>;
}

export interface SharedIdMatch {
  namespace: Namespace;
  value: string;
}

export interface SharedIdConflict {
  namespace: Namespace;
  catalogValue: string;
  collectionValue: string;
}

export type Step1ConflictCode =
  | "shared_id_conflict"
  | "media_type_missing"
  | "media_type_mismatch"
  | "year_missing"
  | "year_mismatch"
  | "title_missing"
  | "title_mismatch"
  | "episode_count_missing"
  | "episode_count_mismatch";

export type Step2ConflictCode =
  | "non_original_default_variant"
  | "segment_season_not_found"
  | "segment_year_missing"
  | "segment_year_mismatch"
  | "segment_episode_count_missing"
  | "segment_season_episode_count_missing"
  | "segment_episode_out_of_range"
  | "segment_episode_count_mismatch"
  | "target_episode_start_mismatch";

export interface EvaluateEvidenceGateStep1Options {
  segments?: readonly NormalizedSegment[];
}

export type Step1FieldCheckStatus = "matched" | "mismatch" | "missing" | "skipped";

export interface EvidenceGateConflict {
  step: 1 | 2;
  code: string;
  field?: string;
  message: string;
  catalogValue?: unknown;
  collectionValue?: unknown;
}

export interface EvidenceGateStep1Result {
  decision: EvidenceGateDecision;
  matchedBy: "shared_id" | "four_fields" | null;
  matchedSharedIds: readonly SharedIdMatch[];
  conflictingSharedIds: readonly SharedIdConflict[];
  fieldChecks: {
    mediaType: Step1FieldCheckStatus;
    year: Step1FieldCheckStatus;
    title: Step1FieldCheckStatus;
    episodeCount: Step1FieldCheckStatus;
  };
  conflicts: readonly EvidenceGateConflict[];
  reasons: readonly string[];
}

export interface EvidenceGateStep2Context {
  catalog: CatalogEvidence;
  collection: CollectionInfo;
  segments: readonly NormalizedSegment[];
  setDefaultVariant?: boolean;
  variantDescription?: string | null;
  step1: EvidenceGateStep1Result;
}

export interface EvidenceGateStep2Result {
  decision: EvidenceGateDecision;
  skipped?: boolean;
  conflicts: readonly EvidenceGateConflict[];
  reasons: readonly string[];
}

export type EvidenceGateStep2Evaluator = (
  context: EvidenceGateStep2Context,
) => EvidenceGateStep2Result;

export interface EvaluateEvidenceGateInput {
  catalog: CatalogEvidence;
  collection: CollectionInfo;
  segments?: readonly NormalizedSegment[];
  setDefaultVariant?: boolean;
  variantDescription?: string | null;
  evaluateStep2?: EvidenceGateStep2Evaluator;
}

export interface EvidenceGateResult {
  decision: EvidenceGateDecision;
  step1: EvidenceGateStep1Result;
  step2: EvidenceGateStep2Result | null;
  conflicts: readonly EvidenceGateConflict[];
  reasons: readonly string[];
}

/**
 * Curated Traditional Chinese & Japanese Shinjitai -> Simplified Chinese character folding map
 * for deterministic title comparison without external dictionary dependencies.
 */
const CJK_VARIANT_FOLD_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["呪", "咒"],
  ["術", "术"],
  ["迴", "回"],
  ["廻", "回"],
  ["戰", "战"],
  ["戦", "战"],
  ["體", "体"],
  ["進", "进"],
  ["擊", "击"],
  ["滅", "灭"],
  ["蓮", "莲"],
  ["國", "国"],
  ["語", "语"],
  ["動", "动"],
  ["畫", "画"],
  ["劇", "剧"],
  ["場", "场"],
  ["傳", "传"],
  ["記", "记"],
  ["紀", "纪"],
  ["錄", "录"],
  ["愛", "爱"],
  ["戀", "恋"],
  ["夢", "梦"],
  ["風", "风"],
  ["雲", "云"],
  ["龍", "龙"],
  ["劍", "剑"],
  ["殺", "杀"],
  ["獵", "猎"],
  ["師", "师"],
  ["學", "学"],
  ["園", "园"],
  ["館", "馆"],
  ["書", "书"],
  ["時", "时"],
  ["間", "间"],
  ["開", "开"],
  ["關", "关"],
  ["門", "门"],
  ["長", "长"],
  ["無", "无"],
  ["與", "与"],
  ["為", "为"],
  ["這", "这"],
  ["個", "个"],
  ["們", "们"],
  ["來", "来"],
  ["發", "发"],
  ["現", "现"],
  ["實", "实"],
  ["點", "点"],
  ["對", "对"],
  ["從", "从"],
  ["後", "后"],
  ["裡", "里"],
  ["裏", "里"],
  ["機", "机"],
  ["電", "电"],
  ["車", "车"],
  ["馬", "马"],
  ["鳥", "鸟"],
  ["魚", "鱼"],
  ["銀", "银"],
  ["鐵", "铁"],
  ["鋼", "钢"],
  ["鍊", "炼"],
  ["鏈", "链"],
  ["鋸", "锯"],
  ["賊", "贼"],
  ["紅", "红"],
  ["藍", "蓝"],
  ["綠", "绿"],
  ["黃", "黄"],
  ["雙", "双"],
  ["萬", "万"],
  ["億", "亿"],
  ["號", "号"],
  ["歲", "岁"],
  ["極", "极"],
  ["樂", "乐"],
  ["聲", "声"],
  ["聽", "听"],
  ["見", "见"],
  ["親", "亲"],
  ["觀", "观"],
  ["視", "视"],
  ["覺", "觉"],
  ["說", "说"],
  ["話", "话"],
  ["詞", "词"],
  ["詩", "诗"],
  ["試", "试"],
  ["誠", "诚"],
  ["請", "请"],
  ["讀", "读"],
  ["變", "变"],
  ["讓", "让"],
  ["頭", "头"],
  ["題", "题"],
  ["顏", "颜"],
  ["飛", "飞"],
  ["飯", "饭"],
  ["飲", "饮"],
  ["飾", "饰"],
  ["餘", "余"],
  ["驅", "驱"],
  ["驚", "惊"],
  ["驗", "验"],
  ["靈", "灵"],
  ["異", "异"],
  ["聖", "圣"],
  ["俠", "侠"],
  ["偵", "侦"],
  ["華", "华"],
  ["麗", "丽"],
  ["爾", "尔"],
  ["亞", "亚"],
  ["歐", "欧"],
  ["漢", "汉"],
  ["澤", "泽"],
  ["滿", "满"],
  ["溫", "温"],
  ["灣", "湾"],
  ["遊", "游"],
  ["運", "运"],
  ["過", "过"],
  ["還", "还"],
  ["邊", "边"],
  ["達", "达"],
  ["選", "选"],
  ["遺", "遗"],
  ["遠", "远"],
  ["適", "适"],
  ["鄰", "邻"],
  ["醫", "医"],
  ["陽", "阳"],
  ["陰", "阴"],
  ["陸", "陆"],
  ["際", "际"],
  ["隱", "隐"],
  ["難", "难"],
  ["離", "离"],
  ["響", "响"],
  ["頁", "页"],
  ["須", "须"],
  ["領", "领"],
  ["類", "类"],
  ["顧", "顾"],
  ["顯", "显"],
  ["養", "养"],
  ["鮮", "鲜"],
  ["鳴", "鸣"],
  ["齊", "齐"],
  ["齒", "齿"],
  ["櫻", "樱"],
  ["島", "岛"],
  ["廣", "广"],
  ["慶", "庆"],
  ["應", "应"],
  ["懷", "怀"],
  ["戲", "戏"],
  ["戶", "户"],
  ["擁", "拥"],
  ["斷", "断"],
  ["會", "会"],
  ["東", "东"],
  ["業", "业"],
  ["樣", "样"],
  ["權", "权"],
  ["歡", "欢"],
  ["歸", "归"],
  ["氣", "气"],
  ["決", "决"],
  ["沒", "没"],
  ["潔", "洁"],
  ["熱", "热"],
  ["燈", "灯"],
  ["獨", "独"],
  ["獸", "兽"],
  ["環", "环"],
  ["產", "产"],
  ["當", "当"],
  ["監", "监"],
  ["盤", "盘"],
  ["眾", "众"],
  ["睜", "睁"],
  ["稱", "称"],
  ["種", "种"],
  ["積", "积"],
  ["窮", "穷"],
  ["競", "竞"],
  ["筆", "笔"],
  ["節", "节"],
  ["範", "范"],
  ["約", "约"],
  ["級", "级"],
  ["純", "纯"],
  ["紙", "纸"],
  ["紛", "纷"],
  ["細", "细"],
  ["終", "终"],
  ["組", "组"],
  ["結", "结"],
  ["絕", "绝"],
  ["絡", "络"],
  ["給", "给"],
  ["統", "统"],
  ["絲", "丝"],
  ["經", "经"],
  ["綜", "综"],
  ["維", "维"],
  ["網", "网"],
  ["緊", "紧"],
  ["線", "线"],
  ["練", "练"],
  ["編", "编"],
  ["緣", "缘"],
  ["總", "总"],
  ["績", "绩"],
  ["織", "织"],
  ["繞", "绕"],
  ["繪", "绘"],
  ["繼", "继"],
  ["續", "续"],
  ["羅", "罗"],
  ["義", "义"],
  ["習", "习"],
  ["聞", "闻"],
  ["聯", "联"],
  ["聰", "聪"],
  ["職", "职"],
  ["肅", "肃"],
  ["勝", "胜"],
  ["脈", "脉"],
  ["脫", "脱"],
  ["臉", "脸"],
  ["臨", "临"],
  ["臺", "台"],
  ["興", "兴"],
  ["舉", "举"],
  ["舊", "旧"],
  ["艦", "舰"],
  ["艙", "舱"],
  ["艱", "艰"],
  ["藝", "艺"],
  ["莊", "庄"],
  ["葉", "叶"],
  ["蓋", "盖"],
  ["蒼", "苍"],
  ["蘇", "苏"],
  ["蘋", "苹"],
  ["蘭", "兰"],
  ["處", "处"],
  ["虛", "虚"],
  ["蟲", "虫"],
  ["衛", "卫"],
  ["裝", "装"],
  ["補", "补"],
  ["複", "复"],
  ["襲", "袭"],
  ["規", "规"],
  ["覽", "览"],
  ["觸", "触"],
  ["計", "计"],
  ["訂", "订"],
  ["認", "认"],
  ["討", "讨"],
  ["訓", "训"],
  ["議", "议"],
  ["訊", "讯"],
  ["講", "讲"],
  ["許", "许"],
  ["論", "论"],
  ["設", "设"],
  ["訪", "访"],
  ["證", "证"],
  ["評", "评"],
  ["識", "识"],
  ["訴", "诉"],
  ["診", "诊"],
  ["譯", "译"],
  ["誕", "诞"],
  ["該", "该"],
  ["詳", "详"],
  ["誤", "误"],
  ["諸", "诸"],
  ["諾", "诺"],
  ["課", "课"],
  ["誰", "谁"],
  ["調", "调"],
  ["談", "谈"],
  ["謀", "谋"],
  ["謊", "谎"],
  ["謎", "谜"],
  ["謝", "谢"],
  ["謹", "谨"],
  ["譚", "谭"],
  ["譜", "谱"],
  ["護", "护"],
  ["貝", "贝"],
  ["貞", "贞"],
  ["負", "负"],
  ["財", "财"],
  ["貢", "贡"],
  ["貧", "贫"],
  ["貨", "货"],
  ["貫", "贯"],
  ["責", "责"],
  ["貴", "贵"],
  ["買", "买"],
  ["費", "费"],
  ["貼", "贴"],
  ["貿", "贸"],
  ["賀", "贺"],
  ["資", "资"],
  ["賦", "赋"],
  ["質", "质"],
  ["賭", "赌"],
  ["賴", "赖"],
  ["賺", "赚"],
  ["賽", "赛"],
  ["贈", "赠"],
  ["贊", "赞"],
  ["贏", "赢"],
  ["趙", "赵"],
  ["趕", "赶"],
  ["趨", "趋"],
  ["躍", "跃"],
  ["軌", "轨"],
  ["軍", "军"],
  ["軒", "轩"],
  ["軟", "软"],
  ["較", "较"],
  ["載", "载"],
  ["輔", "辅"],
  ["輕", "轻"],
  ["輛", "辆"],
  ["輝", "辉"],
  ["輩", "辈"],
  ["輪", "轮"],
  ["輯", "辑"],
  ["輸", "输"],
  ["轉", "转"],
  ["轟", "轰"],
  ["辦", "办"],
  ["辭", "辞"],
  ["辯", "辩"],
  ["農", "农"],
  ["違", "违"],
  ["連", "连"],
  ["遲", "迟"],
  ["遙", "遥"],
  ["遜", "逊"],
  ["遞", "递"],
  ["邁", "迈"],
  ["邏", "逻"],
  ["鄧", "邓"],
  ["鄭", "郑"],
  ["釋", "释"],
  ["針", "针"],
  ["釣", "钓"],
  ["銅", "铜"],
  ["銘", "铭"],
  ["銳", "锐"],
  ["銷", "销"],
  ["鋒", "锋"],
  ["錯", "错"],
  ["錢", "钱"],
  ["錦", "锦"],
  ["鍵", "键"],
  ["鍾", "钟"],
  ["鎮", "镇"],
  ["鏡", "镜"],
  ["鑑", "鉴"],
  ["閃", "闪"],
  ["閉", "闭"],
  ["閏", "闰"],
  ["閑", "闲"],
  ["閣", "阁"],
  ["閱", "阅"],
  ["闊", "阔"],
  ["闖", "闯"],
  ["陣", "阵"],
  ["陳", "陈"],
  ["隊", "队"],
  ["階", "阶"],
  ["隨", "随"],
  ["險", "险"],
  ["隻", "只"],
  ["雜", "杂"],
  ["雞", "鸡"],
  ["霧", "雾"],
  ["靜", "静"],
  ["頂", "顶"],
  ["項", "项"],
  ["順", "顺"],
  ["頑", "顽"],
  ["頓", "顿"],
  ["預", "预"],
  ["頒", "颁"],
  ["頗", "颇"],
  ["頻", "频"],
  ["額", "额"],
  ["願", "愿"],
  ["飽", "饱"],
  ["餅", "饼"],
  ["馳", "驰"],
  ["駐", "驻"],
  ["駕", "驾"],
  ["駿", "骏"],
  ["騎", "骑"],
  ["騙", "骗"],
  ["騷", "骚"],
  ["驟", "骤"],
  ["魯", "鲁"],
  ["鯨", "鲸"],
  ["鳳", "凤"],
  ["鴨", "鸭"],
  ["鴻", "鸿"],
  ["鵝", "鹅"],
  ["鶴", "鹤"],
  ["鷹", "鹰"],
  ["黨", "党"],
  ["齋", "斋"],
  ["齡", "龄"],
  ["龜", "龟"],
];

const CJK_VARIANT_FOLD_MAP = new Map<string, string>(CJK_VARIANT_FOLD_PAIRS);

function foldCjkVariants(value: string): string {
  let out = "";
  for (const ch of value) {
    out += CJK_VARIANT_FOLD_MAP.get(ch) ?? ch;
  }
  return out;
}

const TRAILING_BRACKET_QUALIFIER =
  /\s*(?:\([^)]{1,24}\)|\[[^\]]{1,24}\]|（[^）]{1,24}）|【[^】]{1,24}】)\s*$/u;

const TRAILING_SEASON_QUALIFIER =
  /\s*(?:第[0-9一二三四五六七八九十百]+[季部期篇]|最[终終]季|season\s*\d+|part\s*\d+|s\d{1,2})\s*$/iu;

/** A trailing year is a qualifier only when it is the item's own year: 「银翼杀手2049」 is a title. */
function trailingYearPattern(year: number | null): RegExp | null {
  return year === null ? null : new RegExp(`\\s*(?<!\\d)${year}\\s*$`, "u");
}

function stripTrailingQualifiers(raw: string, year: number | null): string {
  const trailingYear = trailingYearPattern(year);
  let current = raw.trim();
  for (let i = 0; i < 4; i += 1) {
    const withoutBracket = current.replace(TRAILING_BRACKET_QUALIFIER, "").trim();
    if (withoutBracket !== current && withoutBracket.length >= 2) {
      current = withoutBracket;
      continue;
    }
    let withoutSeason = current.replace(TRAILING_SEASON_QUALIFIER, "").trim();
    if (withoutSeason === current && trailingYear) {
      withoutSeason = current.replace(trailingYear, "").trim();
    }
    if (withoutSeason !== current && withoutSeason.length >= 2) {
      current = withoutSeason;
      continue;
    }
    break;
  }
  return current;
}

export function normalizeTitleForComparison(raw: string): string {
  const nfkc = raw.normalize("NFKC").toLowerCase();
  const folded = foldCjkVariants(nfkc);
  return folded.replace(/[\p{P}\p{S}\s]+/gu, "");
}

function collectNormalizedTitleCandidates(
  primary: string | null | undefined,
  original: string | null | undefined,
  aliases: readonly string[] | undefined,
  year: number | null,
): Set<string> {
  const result = new Set<string>();
  const rawList: string[] = [];
  if (primary && primary.trim().length > 0) {
    rawList.push(primary);
  }
  if (original && original.trim().length > 0) {
    rawList.push(original);
  }
  if (aliases) {
    for (const alias of aliases) {
      if (alias && alias.trim().length > 0) {
        rawList.push(alias);
      }
    }
  }

  for (const raw of rawList) {
    const normalized = normalizeTitleForComparison(raw);
    if (normalized.length > 0) {
      result.add(normalized);
    }

    const stripped = stripTrailingQualifiers(raw, year);
    if (stripped !== raw) {
      const normalizedStripped = normalizeTitleForComparison(stripped);
      if (normalizedStripped.length >= 2) {
        result.add(normalizedStripped);
      }
    }
  }

  return result;
}

function normalizeIdValue(value: string): string {
  return value.trim().toLowerCase();
}

function collectCatalogFetchedIds(catalog: CatalogEvidence): Map<Namespace, string> {
  const ids = new Map<Namespace, string>();
  if (catalog.canonicalId.trim().length > 0) {
    ids.set(catalog.namespace, catalog.canonicalId.trim());
  }
  for (const [ns, rawVal] of Object.entries(catalog.externalIds)) {
    if (typeof rawVal === "string" && rawVal.trim().length > 0) {
      ids.set(ns as Namespace, rawVal.trim());
    }
  }
  return ids;
}

function collectCollectionFetchedIds(
  collection: CollectionInfo,
  catalogNamespace: CatalogNamespace,
): Map<Namespace, string> {
  const ids = new Map<Namespace, string>();
  if (collection.namespace !== catalogNamespace && collection.canonicalId.trim().length > 0) {
    ids.set(collection.namespace, collection.canonicalId.trim());
  }
  if (collection.externalIds) {
    for (const [ns, rawVal] of Object.entries(collection.externalIds)) {
      if (typeof rawVal === "string" && rawVal.trim().length > 0) {
        ids.set(ns as Namespace, rawVal.trim());
      }
    }
  }
  return ids;
}

/** Air year of the segment's first episode, else the season premiere year. */
function segmentStartYear(
  catalog: CatalogEvidence,
  segment: Pick<NormalizedSegment, "season" | "episodeStart">,
): number | null {
  const year =
    catalog.episodeAirYears?.[segment.season]?.[segment.episodeStart] ??
    catalog.seasons.find((s) => s.season === segment.season)?.airYear ??
    null;
  return year !== null && Number.isInteger(year) ? year : null;
}

function collectCatalogCandidateYears(
  catalog: CatalogEvidence,
  segments?: readonly NormalizedSegment[],
): Set<number> {
  const years = new Set<number>();
  if (catalog.year !== null && Number.isInteger(catalog.year)) {
    years.add(catalog.year);
  }
  for (const segment of segments ?? []) {
    const year = segmentStartYear(catalog, segment);
    if (year !== null) {
      years.add(year);
    }
  }
  const includeSpecials = Boolean(segments?.some((s) => s.season === 0));
  if (catalog.mediaType === "tv") {
    for (const season of catalog.seasons) {
      if (
        (season.season >= 1 || (includeSpecials && season.season === 0)) &&
        season.airYear !== null &&
        Number.isInteger(season.airYear)
      ) {
        years.add(season.airYear);
      }
    }
  }
  return years;
}

interface LinearSegmentEpisodeRange {
  hasOpenEnded: boolean;
  minEpisodes: number;
  maxEpisodes: number;
}

function computeLinearSegmentEpisodeRange(
  catalog: CatalogEvidence,
  segments: readonly NormalizedSegment[],
): LinearSegmentEpisodeRange | null {
  if (segments.length === 0) {
    return null;
  }

  const seasonMap = new Map<number, SeasonSnapshot>();
  for (const season of catalog.seasons) {
    seasonMap.set(season.season, season);
  }

  const sorted = [...segments].toSorted((a, b) =>
    a.season !== b.season ? a.season - b.season : a.episodeStart - b.episodeStart,
  );

  let hasOpenEnded = false;
  let minEpisodes = 0;
  let maxEpisodes = 0;

  for (let i = 0; i < sorted.length; i += 1) {
    const seg = sorted[i]!;
    const isLast = i === sorted.length - 1;
    const seasonSnapshot = seasonMap.get(seg.season);
    if (
      !seasonSnapshot ||
      !Number.isInteger(seasonSnapshot.episodeCount) ||
      seasonSnapshot.episodeCount <= 0
    ) {
      return null;
    }

    if (seg.episodeStart > seasonSnapshot.episodeCount) {
      return null;
    }
    if (seg.episodeEnd !== null && seg.episodeEnd > seasonSnapshot.episodeCount) {
      return null;
    }

    const effectiveEnd = seg.episodeEnd ?? seasonSnapshot.episodeCount;
    const span = effectiveEnd - seg.episodeStart + 1;
    if (span <= 0) {
      return null;
    }

    maxEpisodes += span;
    if (seg.episodeEnd === null) {
      hasOpenEnded = true;
      minEpisodes += isLast ? 1 : span;
    } else {
      minEpisodes += span;
    }
  }

  return { hasOpenEnded, minEpisodes, maxEpisodes };
}

function collectCatalogCandidateEpisodeCounts(catalog: CatalogEvidence): Set<number> {
  const counts = new Set<number>();

  if (catalog.mediaType === "movie") {
    const expected =
      catalog.episodeCount !== undefined && catalog.episodeCount !== null
        ? catalog.episodeCount
        : 1;
    if (Number.isInteger(expected) && expected > 0) {
      counts.add(expected);
    }
    return counts;
  }

  if (
    catalog.episodeCount !== undefined &&
    catalog.episodeCount !== null &&
    Number.isInteger(catalog.episodeCount) &&
    catalog.episodeCount > 0
  ) {
    counts.add(catalog.episodeCount);
  }

  const regularSeasons = catalog.seasons
    .filter((s) => s.season >= 1 && Number.isInteger(s.episodeCount) && s.episodeCount > 0)
    .toSorted((a, b) => a.season - b.season);

  for (let i = 0; i < regularSeasons.length; i += 1) {
    let runningSum = 0;
    for (let j = i; j < regularSeasons.length; j += 1) {
      runningSum += regularSeasons[j]!.episodeCount;
      counts.add(runningSum);
    }
  }

  return counts;
}

export function evaluateEvidenceGateStep1(
  catalog: CatalogEvidence,
  collection: CollectionInfo,
  options?: EvaluateEvidenceGateStep1Options,
): EvidenceGateStep1Result {
  const catalogIds = collectCatalogFetchedIds(catalog);
  const collectionIds = collectCollectionFetchedIds(collection, catalog.namespace);

  const matchedSharedIds: SharedIdMatch[] = [];
  const conflictingSharedIds: SharedIdConflict[] = [];

  for (const [namespace, catalogVal] of catalogIds.entries()) {
    const collectionVal = collectionIds.get(namespace);
    if (collectionVal === undefined) {
      continue;
    }

    if (normalizeIdValue(catalogVal) === normalizeIdValue(collectionVal)) {
      matchedSharedIds.push({ namespace, value: catalogVal });
    } else {
      conflictingSharedIds.push({
        namespace,
        catalogValue: catalogVal,
        collectionValue: collectionVal,
      });
    }
  }

  if (conflictingSharedIds.length > 0) {
    const conflicts: EvidenceGateConflict[] = conflictingSharedIds.map((conflict) => ({
      step: 1,
      code: "shared_id_conflict",
      field: `externalIds.${conflict.namespace}`,
      message: `Shared external ID conflict for ${conflict.namespace}: catalog=${conflict.catalogValue}, collection=${conflict.collectionValue}`,
      catalogValue: conflict.catalogValue,
      collectionValue: conflict.collectionValue,
    }));

    return {
      decision: "needs_review",
      matchedBy: null,
      matchedSharedIds,
      conflictingSharedIds,
      fieldChecks: {
        mediaType: "skipped",
        year: "skipped",
        title: "skipped",
        episodeCount: "skipped",
      },
      conflicts,
      reasons: conflicts.map((c) => c.message),
    };
  }

  if (matchedSharedIds.length > 0) {
    return {
      decision: "pass",
      matchedBy: "shared_id",
      matchedSharedIds,
      conflictingSharedIds: [],
      fieldChecks: {
        mediaType: "skipped",
        year: "skipped",
        title: "skipped",
        episodeCount: "skipped",
      },
      conflicts: [],
      reasons: [],
    };
  }

  // No shared IDs fetched on both sides: ALL FOUR fields must match.
  const conflicts: EvidenceGateConflict[] = [];

  // 1. mediaType
  let mediaTypeStatus: Step1FieldCheckStatus;
  if (collection.mediaType === null) {
    mediaTypeStatus = "missing";
    conflicts.push({
      step: 1,
      code: "media_type_missing",
      field: "mediaType",
      message: `Collection ${collection.namespace}:${collection.canonicalId} is missing mediaType`,
      catalogValue: catalog.mediaType,
      collectionValue: null,
    });
  } else if (collection.mediaType !== catalog.mediaType) {
    mediaTypeStatus = "mismatch";
    conflicts.push({
      step: 1,
      code: "media_type_mismatch",
      field: "mediaType",
      message: `Media type mismatch: catalog=${catalog.mediaType}, collection=${collection.mediaType}`,
      catalogValue: catalog.mediaType,
      collectionValue: collection.mediaType,
    });
  } else {
    mediaTypeStatus = "matched";
  }

  // 2. year
  let yearStatus: Step1FieldCheckStatus;
  const segments = options?.segments ?? [];
  const catalogYears = collectCatalogCandidateYears(catalog, segments);
  if (collection.year === null || catalogYears.size === 0) {
    yearStatus = "missing";
    conflicts.push({
      step: 1,
      code: "year_missing",
      field: "year",
      message: `Missing release year for comparison: catalogYears=[${[...catalogYears].join(",")}], collectionYear=${collection.year}`,
      catalogValue: [...catalogYears],
      collectionValue: collection.year,
    });
  } else if (!catalogYears.has(collection.year)) {
    yearStatus = "mismatch";
    conflicts.push({
      step: 1,
      code: "year_mismatch",
      field: "year",
      message: `Year mismatch: catalogYears=[${[...catalogYears].join(",")}], collectionYear=${collection.year}`,
      catalogValue: [...catalogYears],
      collectionValue: collection.year,
    });
  } else {
    yearStatus = "matched";
  }

  // 3. title
  let titleStatus: Step1FieldCheckStatus;
  const catalogTitles = collectNormalizedTitleCandidates(
    catalog.title,
    catalog.originalTitle,
    catalog.aliases,
    catalog.year,
  );
  const collectionTitles = collectNormalizedTitleCandidates(
    collection.title,
    collection.originalTitle,
    collection.aliases,
    collection.year,
  );

  if (catalogTitles.size === 0 || collectionTitles.size === 0) {
    titleStatus = "missing";
    conflicts.push({
      step: 1,
      code: "title_missing",
      field: "title",
      message: "Missing title on catalog or collection",
      catalogValue: catalog.title,
      collectionValue: collection.title,
    });
  } else {
    let matchedTitle = false;
    for (const candidate of collectionTitles) {
      if (catalogTitles.has(candidate)) {
        matchedTitle = true;
        break;
      }
    }
    if (matchedTitle) {
      titleStatus = "matched";
    } else {
      titleStatus = "mismatch";
      conflicts.push({
        step: 1,
        code: "title_mismatch",
        field: "title",
        message: `Title mismatch: catalog="${catalog.title}", collection="${collection.title}"`,
        catalogValue: catalog.title,
        collectionValue: collection.title,
      });
    }
  }

  // 4. episodeCount
  let episodeCountStatus: Step1FieldCheckStatus;
  const linearSegments = segments.filter((s) => !s.nonLinear);

  if (catalog.mediaType === "tv" && segments.length > 0 && linearSegments.length === 0) {
    episodeCountStatus = "skipped";
  } else {
    const catalogEpisodeCounts = collectCatalogCandidateEpisodeCounts(catalog);
    const segmentRange =
      catalog.mediaType === "tv" ? computeLinearSegmentEpisodeRange(catalog, linearSegments) : null;

    const matchesSegmentRange =
      segmentRange !== null &&
      collection.featureEpisodeCount !== null &&
      Number.isInteger(collection.featureEpisodeCount) &&
      (segmentRange.hasOpenEnded
        ? collection.featureEpisodeCount >= segmentRange.minEpisodes &&
          collection.featureEpisodeCount <= segmentRange.maxEpisodes
        : collection.featureEpisodeCount === segmentRange.maxEpisodes);

    if (
      collection.featureEpisodeCount === null ||
      !Number.isInteger(collection.featureEpisodeCount) ||
      collection.featureEpisodeCount <= 0 ||
      (catalogEpisodeCounts.size === 0 && segmentRange === null)
    ) {
      episodeCountStatus = "missing";
      conflicts.push({
        step: 1,
        code: "episode_count_missing",
        field: "episodeCount",
        message: `Missing episode count for comparison: catalogCounts=[${[...catalogEpisodeCounts].join(",")}], collectionCount=${collection.featureEpisodeCount}`,
        catalogValue: [...catalogEpisodeCounts],
        collectionValue: collection.featureEpisodeCount,
      });
    } else if (!catalogEpisodeCounts.has(collection.featureEpisodeCount) && !matchesSegmentRange) {
      episodeCountStatus = "mismatch";
      conflicts.push({
        step: 1,
        code: "episode_count_mismatch",
        field: "episodeCount",
        message: `Episode count mismatch: catalogCounts=[${[...catalogEpisodeCounts].join(",")}], collectionCount=${collection.featureEpisodeCount}`,
        catalogValue: [...catalogEpisodeCounts],
        collectionValue: collection.featureEpisodeCount,
      });
    } else {
      episodeCountStatus = "matched";
    }
  }

  const allMatched = conflicts.length === 0;
  return {
    decision: allMatched ? "pass" : "needs_review",
    matchedBy: allMatched ? "four_fields" : null,
    matchedSharedIds: [],
    conflictingSharedIds: [],
    fieldChecks: {
      mediaType: mediaTypeStatus,
      year: yearStatus,
      title: titleStatus,
      episodeCount: episodeCountStatus,
    },
    conflicts,
    reasons: conflicts.map((c) => c.message),
  };
}

const EXPLICIT_DUB_VARIANT_PATTERN =
  /(?:中配|国配|台配|粤配|港配|英配|日配|韩配|法配|德配|俄配|西配|配音|译制|吹替|\bdub(?:bed|bing)?\b|\bvoice[\s-]?over\b)/iu;

const NON_ORIGINAL_CUT_VARIANT_PATTERN =
  /(?:导演剪辑|导剪|删减|精编|解说|重剪|速看|\bdirector'?s?\s+cut\b|\bextended\s+cut\b|\babridged\b|\bcommentary\b|\brecut\b)/iu;

const EXPLICIT_ORIGINAL_VARIANT_PATTERN = /(?:原声|原版|原音|\boriginal\b)/iu;

const LANGUAGE_DUB_HINT_PATTERN =
  /(?:粤语|国语|普通话|台语|闽南语|中文版|华语版|\bcantonese\b|\bmandarin\b)/iu;

const VARIANT_EXTRA_FOLD_MAP = new Map<string, string>([
  ["粵", "粤"],
  ["導", "导"],
  ["刪", "删"],
  ["減", "减"],
  ["閩", "闽"],
  ["韓", "韩"],
  ["製", "制"],
]);

function normalizeVariantDescriptionForCheck(raw: string): string {
  const nfkc = raw.normalize("NFKC").toLowerCase();
  const baseFolded = foldCjkVariants(nfkc);
  let out = "";
  for (const ch of baseFolded) {
    out += VARIANT_EXTRA_FOLD_MAP.get(ch) ?? ch;
  }
  return out.trim();
}

export function isNonOriginalVariantDescription(description: string | null | undefined): boolean {
  if (!description) {
    return false;
  }
  const normalized = normalizeVariantDescriptionForCheck(description);
  if (normalized.length === 0) {
    return false;
  }

  if (EXPLICIT_DUB_VARIANT_PATTERN.test(normalized)) {
    return true;
  }
  if (NON_ORIGINAL_CUT_VARIANT_PATTERN.test(normalized)) {
    return true;
  }
  if (EXPLICIT_ORIGINAL_VARIANT_PATTERN.test(normalized)) {
    return false;
  }
  return LANGUAGE_DUB_HINT_PATTERN.test(normalized);
}

function checkSegmentEpisodeBounds(
  seg: NormalizedSegment,
  seasonSnapshot: SeasonSnapshot,
  conflicts: EvidenceGateConflict[],
): boolean {
  if (seg.episodeStart > seasonSnapshot.episodeCount) {
    conflicts.push({
      step: 2,
      code: "segment_episode_out_of_range",
      field: "segments.episodeStart",
      message: `Segment episodeStart (${seg.episodeStart}) exceeds season ${seg.season} episodeCount (${seasonSnapshot.episodeCount})`,
      catalogValue: seasonSnapshot.episodeCount,
      collectionValue: seg.episodeStart,
    });
    return false;
  }
  if (seg.episodeEnd !== null && seg.episodeEnd > seasonSnapshot.episodeCount) {
    conflicts.push({
      step: 2,
      code: "segment_episode_out_of_range",
      field: "segments.episodeEnd",
      message: `Segment episodeEnd (${seg.episodeEnd}) exceeds season ${seg.season} episodeCount (${seasonSnapshot.episodeCount})`,
      catalogValue: seasonSnapshot.episodeCount,
      collectionValue: seg.episodeEnd,
    });
    return false;
  }
  return true;
}

export function evaluateEvidenceGateStep2(
  context: EvidenceGateStep2Context,
): EvidenceGateStep2Result {
  const conflicts: EvidenceGateConflict[] = [];

  // 0. Non-original variant explicitly marked as default -> route to human review
  if (context.setDefaultVariant && isNonOriginalVariantDescription(context.variantDescription)) {
    conflicts.push({
      step: 2,
      code: "non_original_default_variant",
      field: "variantDescription",
      message: `Non-original variant "${context.variantDescription}" cannot be auto-approved as default variant`,
      collectionValue: context.variantDescription ?? null,
    });
  }

  // Movies skip segment verification in Step 2
  if (context.catalog.mediaType === "movie") {
    return {
      decision: conflicts.length === 0 ? "pass" : "needs_review",
      skipped: true,
      conflicts,
      reasons: conflicts.map((c) => c.message),
    };
  }

  // Whole-media TV association (segments.length === 0)
  if (context.segments.length === 0) {
    if (
      context.step1.matchedBy !== "shared_id" &&
      context.catalog.year !== null &&
      Number.isInteger(context.catalog.year) &&
      context.collection.year !== null &&
      Number.isInteger(context.collection.year) &&
      context.collection.year !== context.catalog.year
    ) {
      conflicts.push({
        step: 2,
        code: "segment_year_mismatch",
        field: "year",
        message: `Whole-media TV collection year (${context.collection.year}) does not match media premiere year (${context.catalog.year})`,
        catalogValue: context.catalog.year,
        collectionValue: context.collection.year,
      });
    }

    return {
      decision: conflicts.length === 0 ? "pass" : "needs_review",
      skipped: false,
      conflicts,
      reasons: conflicts.map((c) => c.message),
    };
  }

  const seasonMap = new Map<number, SeasonSnapshot>();
  for (const season of context.catalog.seasons) {
    seasonMap.set(season.season, season);
  }

  // 1. Ensure every segment refers to an existing season in the catalog snapshot
  const missingSeasons = new Set<number>();
  for (const seg of context.segments) {
    if (!seasonMap.has(seg.season) && !missingSeasons.has(seg.season)) {
      missingSeasons.add(seg.season);
      conflicts.push({
        step: 2,
        code: "segment_season_not_found",
        field: "segments.season",
        message: `Season ${seg.season} does not exist in catalog snapshot for ${context.catalog.namespace}:${context.catalog.canonicalId}`,
        catalogValue: context.catalog.seasons.map((s) => s.season),
        collectionValue: seg.season,
      });
    }
  }

  // 2. Year check against the air year of the earliest segment's first episode
  const regularSeasonNumbers = context.segments.map((s) => s.season).filter((s) => s >= 1);
  const earliestSeasonNumber =
    regularSeasonNumbers.length > 0
      ? Math.min(...regularSeasonNumbers)
      : Math.min(...context.segments.map((s) => s.season));
  const earliestSeason = seasonMap.get(earliestSeasonNumber);
  const earliestEpisode = Math.min(
    ...context.segments.filter((s) => s.season === earliestSeasonNumber).map((s) => s.episodeStart),
  );
  const earliestLabel = `season ${earliestSeasonNumber} episode ${earliestEpisode}`;

  if (earliestSeason) {
    const expectedYear = segmentStartYear(context.catalog, {
      season: earliestSeasonNumber,
      episodeStart: earliestEpisode,
    });
    if (expectedYear === null) {
      conflicts.push({
        step: 2,
        code: "segment_year_missing",
        field: "year",
        message: `Catalog ${earliestLabel} is missing air year`,
        catalogValue: null,
        collectionValue: context.collection.year,
      });
    } else if (context.collection.year === null || !Number.isInteger(context.collection.year)) {
      conflicts.push({
        step: 2,
        code: "segment_year_missing",
        field: "year",
        message: `Collection ${context.collection.namespace}:${context.collection.canonicalId} is missing release year`,
        catalogValue: expectedYear,
        collectionValue: context.collection.year,
      });
    } else if (context.collection.year !== expectedYear) {
      conflicts.push({
        step: 2,
        code: "segment_year_mismatch",
        field: "year",
        message: `Collection year (${context.collection.year}) does not match ${earliestLabel} air year (${expectedYear})`,
        catalogValue: expectedYear,
        collectionValue: context.collection.year,
      });
    }
  }

  // 3. Validate baseline episode bounds for non-linear segments too when season length is known
  for (const seg of context.segments) {
    if (!seg.nonLinear) {
      continue;
    }
    const seasonSnapshot = seasonMap.get(seg.season);
    if (
      seasonSnapshot &&
      Number.isInteger(seasonSnapshot.episodeCount) &&
      seasonSnapshot.episodeCount > 0
    ) {
      checkSegmentEpisodeBounds(seg, seasonSnapshot, conflicts);
    }
  }

  // Non-linear segments have no one-to-one episode mapping.
  const linearSegments = context.segments.filter((s) => !s.nonLinear);
  if (linearSegments.length === 0) {
    return {
      decision: conflicts.length === 0 ? "pass" : "needs_review",
      skipped: false,
      conflicts,
      reasons: conflicts.map((c) => c.message),
    };
  }

  // 4. Linear segment checks: featureEpisodeCount & targetEpisodeStart alignment
  const featureEpisodeCount = context.collection.featureEpisodeCount;
  if (
    featureEpisodeCount === null ||
    !Number.isInteger(featureEpisodeCount) ||
    featureEpisodeCount <= 0
  ) {
    conflicts.push({
      step: 2,
      code: "segment_episode_count_missing",
      field: "featureEpisodeCount",
      message: `Collection ${context.collection.namespace}:${context.collection.canonicalId} is missing featureEpisodeCount for linear segment verification`,
      catalogValue: null,
      collectionValue: featureEpisodeCount,
    });
    return {
      decision: "needs_review",
      skipped: false,
      conflicts,
      reasons: conflicts.map((c) => c.message),
    };
  }

  const sortedSegments = linearSegments.toSorted((a, b) =>
    a.season !== b.season ? a.season - b.season : a.episodeStart - b.episodeStart,
  );

  let canVerifyTotals = true;
  let expectedTargetStart = 1;
  let totalMinCovered = 0;
  let totalMaxCovered = 0;
  let hasOpenEnded = false;

  for (let i = 0; i < sortedSegments.length; i += 1) {
    const seg = sortedSegments[i]!;
    const isLast = i === sortedSegments.length - 1;
    const seasonSnapshot = seasonMap.get(seg.season);

    if (!seasonSnapshot) {
      canVerifyTotals = false;
      continue;
    }

    if (!Number.isInteger(seasonSnapshot.episodeCount) || seasonSnapshot.episodeCount <= 0) {
      canVerifyTotals = false;
      conflicts.push({
        step: 2,
        code: "segment_season_episode_count_missing",
        field: "segments.episodeCount",
        message: `Catalog season ${seg.season} has unknown episodeCount (${seasonSnapshot.episodeCount})`,
        catalogValue: seasonSnapshot.episodeCount,
        collectionValue: featureEpisodeCount,
      });
      continue;
    }

    if (!checkSegmentEpisodeBounds(seg, seasonSnapshot, conflicts)) {
      canVerifyTotals = false;
      continue;
    }

    const effectiveEnd = seg.episodeEnd ?? seasonSnapshot.episodeCount;
    const maxSpan = effectiveEnd - seg.episodeStart + 1;

    if (seg.targetEpisodeStart !== expectedTargetStart) {
      conflicts.push({
        step: 2,
        code: "target_episode_start_mismatch",
        field: "segments.targetEpisodeStart",
        message: `Segment S${seg.season} E${seg.episodeStart}..${seg.episodeEnd ?? ""} has targetEpisodeStart=${seg.targetEpisodeStart}, expected ${expectedTargetStart}`,
        catalogValue: expectedTargetStart,
        collectionValue: seg.targetEpisodeStart,
      });
    }

    totalMaxCovered += maxSpan;
    if (seg.episodeEnd === null) {
      hasOpenEnded = true;
      totalMinCovered += isLast ? 1 : maxSpan;
    } else {
      totalMinCovered += maxSpan;
    }

    expectedTargetStart += maxSpan;
  }

  if (canVerifyTotals) {
    if (hasOpenEnded) {
      if (featureEpisodeCount < totalMinCovered || featureEpisodeCount > totalMaxCovered) {
        conflicts.push({
          step: 2,
          code: "segment_episode_count_mismatch",
          field: "featureEpisodeCount",
          message: `Collection featureEpisodeCount (${featureEpisodeCount}) is outside allowed open-ended segment range [${totalMinCovered}..${totalMaxCovered}]`,
          catalogValue: { min: totalMinCovered, max: totalMaxCovered },
          collectionValue: featureEpisodeCount,
        });
      }
    } else if (featureEpisodeCount !== totalMaxCovered) {
      conflicts.push({
        step: 2,
        code: "segment_episode_count_mismatch",
        field: "featureEpisodeCount",
        message: `Collection featureEpisodeCount (${featureEpisodeCount}) does not match total segment episodes (${totalMaxCovered})`,
        catalogValue: totalMaxCovered,
        collectionValue: featureEpisodeCount,
      });
    }
  }

  return {
    decision: conflicts.length === 0 ? "pass" : "needs_review",
    skipped: false,
    conflicts,
    reasons: conflicts.map((c) => c.message),
  };
}

export function evaluateEvidenceGate(input: EvaluateEvidenceGateInput): EvidenceGateResult {
  const step1 = evaluateEvidenceGateStep1(input.catalog, input.collection, {
    segments: input.segments,
  });

  // Step 2 runs even when Step 1 fails so reviewers see every conflict at once (ADR 0003 section 5)
  const step2Evaluator = input.evaluateStep2 ?? evaluateEvidenceGateStep2;
  const step2 = step2Evaluator({
    catalog: input.catalog,
    collection: input.collection,
    segments: input.segments ?? [],
    setDefaultVariant: input.setDefaultVariant,
    variantDescription: input.variantDescription,
    step1,
  });

  const conflicts = [...step1.conflicts, ...step2.conflicts];
  const reasons = [...step1.reasons, ...step2.reasons];

  return {
    decision: step1.decision === "pass" ? step2.decision : "needs_review",
    step1,
    step2,
    conflicts,
    reasons,
  };
}
