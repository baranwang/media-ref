import type {
  BaselineSource,
  CatalogNamespace,
  ChangeRequestStatus,
  MediaType,
  Namespace,
  PlatformNamespace,
} from "@media-ref/client";

export const TMDB_POSTER = (path: string) => `https://image.tmdb.org/t/p/w500/${path}`;
export const TMDB_BACKDROP = (path: string) => `https://image.tmdb.org/t/p/w1280/${path}`;

export interface CoverageSegment {
  id: string;
  title: string;
  nativeId: string;
  /** 1-based start episode (or season in all-seasons mode) */
  start: number;
  /** 1-based inclusive end episode (or season in all-seasons mode) */
  end: number;
  targetStart?: number;
  status: "confirmed" | "pending" | "muted";
  changeRequestId?: string;
  revisionCount?: number;
  url?: string;
}

export interface PlatformVariantRow {
  id: string;
  namespace: PlatformNamespace;
  label: string;
  isDefault?: boolean;
  /** Season-keyed coverage segments; key 0 represents whole-movie coverage */
  segmentsBySeason: Record<number, CoverageSegment[]>;
  /** Optional all-seasons summary segments for long-running shows (>6 seasons) */
  allSeasonSegments?: CoverageSegment[];
}

export interface CatalogDirectoryRow {
  id: string;
  namespace: CatalogNamespace;
  roleLabel: string;
  isBaseline?: boolean;
  wholeMediaNativeId?: string;
  wholeMediaLabel?: string;
  note?: string;
  /** Season-keyed segments (episode range or whole-season bar) */
  segmentsBySeason?: Record<number, CoverageSegment[]>;
  /** All-seasons summary segments */
  allSeasonSegments?: CoverageSegment[];
  externalUrl?: string;
}

export interface MediaSeasonInfo {
  season: number;
  episodeCount: number;
  airYear?: number;
}

export interface MediaItem {
  id: string;
  tmdbId: number;
  type: MediaType;
  category: "tv" | "movie" | "anime";
  title: string;
  originalTitle: string;
  yearRange: string;
  year: number;
  region: string;
  statusLabel: string;
  genres: string[];
  synopsis: string;
  credits: Array<{ role: string; name: string }>;
  posterUrl: string;
  backdropUrl: string;
  baseline: BaselineSource;
  seasons: MediaSeasonInfo[];
  totalEpisodes?: number;
  defaultSeason?: number;
  platformRows: PlatformVariantRow[];
  catalogRows: CatalogDirectoryRow[];
  catalogNote?: string;
  /** Which discovery shelves feature this item */
  shelves: CatalogNamespace[];
  /** Used for URL/ID reverse search */
  externalIds: Partial<Record<Namespace, string[]>>;
  weeklyQueries?: number;
}

export interface DemandItem {
  id: string;
  rank: number;
  mediaId: string;
  lookingFor: string;
  existingPlatforms: PlatformNamespace[];
  queryCount30d: number;
  queryCount7d?: number;
}

export interface AutoCheckItem {
  id: string;
  title: string;
  detail: string;
  status: "passed" | "needs_confirm" | "failed";
}

export interface ChangeRequestTimelineStep {
  label: string;
  time: string;
  detail: string;
  state: "done" | "current" | "pending";
}

export interface ChangeRequestItem {
  id: string;
  mediaId: string;
  title: string;
  namespace: Namespace;
  nativeId: string;
  pageUrl: string;
  pageTitle: string;
  pageEpisodeCount?: number;
  variantLabel: string | null;
  season: number;
  episodeStart: number;
  episodeEnd: number;
  targetEpisodeStart: number;
  totalSeasonEpisodes: number;
  status: ChangeRequestStatus;
  conflictTag?: string;
  submitterName: string;
  submittedAt: string;
  relativeTime: string;
  existingSegments: CoverageSegment[];
  proposedSegment: CoverageSegment;
  effectSummary: string;
  checks: AutoCheckItem[];
  reviewer?: {
    name: string;
    initial: string;
    time: string;
    comment: string;
  };
  timeline: ChangeRequestTimelineStep[];
}

export interface ReviewAlertItem {
  id: string;
  namespace: Namespace;
  badge: string;
  severity: "destructive" | "warning";
  title: string;
  description: string;
  relativeTime: string;
  actionLabel: string;
  mediaId: string;
  resolved?: boolean;
}

export interface ApiKeyItem {
  id: string;
  name: string;
  prefix: string;
  canRead: boolean;
  canSubmit: boolean;
  createdAt: string;
  lastUsed: string;
  expiresInDays: number | null;
}

export interface ApiTrendDay {
  date: string;
  found: number;
  notFound: number;
  submitted: number;
}

function makeOnePieceSeasons(): MediaSeasonInfo[] {
  const counts = [
    61, 16, 15, 38, 13, 52, 33, 35, 73, 45, 26, 14, 35, 58, 62, 50, 56, 118, 74, 191, 195, 195,
  ];
  return counts.map((episodeCount, i) => ({
    season: i + 1,
    episodeCount,
    airYear: 1999 + i,
  }));
}

function makeOnePieceBilibiliSegments(): CoverageSegment[] {
  const ranges: Array<[number, number, string]> = [
    [1, 13, "1–13"],
    [14, 26, "14–26"],
    [27, 39, "27–39"],
    [40, 52, "40–52"],
    [53, 65, "53–65"],
    [66, 78, "66–78"],
    [79, 91, "79–91"],
    [92, 104, "92–104"],
    [105, 117, "105–117"],
    [118, 130, "118–130"],
    [131, 143, "131–143"],
    [144, 156, "144–156"],
    [157, 169, "157–169"],
    [170, 182, "170–182"],
    [183, 195, "183–195"],
  ];
  return ranges.map(([start, end, label], idx) => ({
    id: `op-bili-${idx + 1}`,
    title: label,
    nativeId: `ss${42100 + idx}`,
    start,
    end,
    targetStart: 1,
    status: idx === ranges.length - 1 ? "pending" : "confirmed",
  }));
}

export const INITIAL_MEDIA_CATALOG: MediaItem[] = [
  {
    id: "aot",
    tmdbId: 1429,
    type: "tv",
    category: "anime",
    title: "进击的巨人",
    originalTitle: "進撃の巨人 · Attack on Titan",
    yearRange: "2013–2023",
    year: 2013,
    region: "日本",
    statusLabel: "已完结",
    genres: ["动画", "动作", "奇幻", "剧情"],
    synopsis:
      "人类居住在高墙包围的城市中对抗食人巨人。艾伦·耶格尔立誓驱逐所有巨人，并逐步揭开高墙与世界的真相。",
    credits: [
      { role: "原作", name: "谏山创" },
      { role: "动画制作", name: "WIT STUDIO / MAPPA" },
    ],
    posterUrl: TMDB_POSTER("1j3s19nko8OtGhCRwRMDGmr0m5O.jpg"),
    backdropUrl: TMDB_BACKDROP("rqbCbjB19amtOtFQbb3K2lgm2zv.jpg"),
    baseline: "tmdb",
    seasons: [
      { season: 1, episodeCount: 25, airYear: 2013 },
      { season: 2, episodeCount: 12, airYear: 2017 },
      { season: 3, episodeCount: 22, airYear: 2018 },
      { season: 4, episodeCount: 30, airYear: 2020 },
    ],
    totalEpisodes: 89,
    defaultSeason: 4,
    shelves: ["tmdb", "douban"],
    externalIds: {
      tmdb: ["tv:1429"],
      imdb: ["tt2560140"],
      douban: ["30488569", "35414552", "35867291"],
      bangumi: ["285666", "331752"],
      bilibili: ["ss38221", "ss39444", "ss41020"],
      tencent: ["mzc002009x8ab1"],
      iqiyi: ["19rrk2u98p"],
    },
    catalogNote: "同一部剧在各资料站的条目。豆瓣把这一季拆成了 3 个条目",
    platformRows: [
      {
        id: "aot-bili-jp",
        namespace: "bilibili",
        label: "日语原声",
        isDefault: true,
        segmentsBySeason: {
          1: [
            {
              id: "aot-bili-s1",
              title: "进击的巨人 第一季",
              nativeId: "ss1580",
              start: 1,
              end: 25,
              targetStart: 1,
              status: "confirmed",
              revisionCount: 2,
            },
          ],
          2: [
            {
              id: "aot-bili-s2",
              title: "进击的巨人 第二季",
              nativeId: "ss5978",
              start: 1,
              end: 12,
              targetStart: 1,
              status: "confirmed",
              revisionCount: 1,
            },
          ],
          3: [
            {
              id: "aot-bili-s3-1",
              title: "第三季 Part.1",
              nativeId: "ss24621",
              start: 1,
              end: 12,
              targetStart: 1,
              status: "confirmed",
              revisionCount: 2,
            },
            {
              id: "aot-bili-s3-2",
              title: "第三季 Part.2",
              nativeId: "ss26801",
              start: 13,
              end: 22,
              targetStart: 1,
              status: "confirmed",
              revisionCount: 1,
            },
          ],
          4: [
            {
              id: "aot-bili-s4-1",
              title: "最终季",
              nativeId: "ss38221",
              start: 1,
              end: 16,
              targetStart: 1,
              status: "confirmed",
              revisionCount: 3,
            },
            {
              id: "aot-bili-s4-2",
              title: "Part.2",
              nativeId: "ss39444",
              start: 17,
              end: 28,
              targetStart: 1,
              status: "confirmed",
              revisionCount: 2,
            },
            {
              id: "aot-bili-s4-3",
              title: "完结篇",
              nativeId: "ss41020",
              start: 29,
              end: 30,
              targetStart: 1,
              status: "pending",
              changeRequestId: "CR-218",
            },
          ],
        },
      },
      {
        id: "aot-bili-zh",
        namespace: "bilibili",
        label: "中文配音",
        segmentsBySeason: {
          4: [
            {
              id: "aot-bili-zh-s4",
              title: "最终季 · 中配",
              nativeId: "ss38990",
              start: 1,
              end: 16,
              targetStart: 1,
              status: "muted",
            },
          ],
        },
      },
      {
        id: "aot-iqiyi-jp",
        namespace: "iqiyi",
        label: "日语原声",
        segmentsBySeason: {
          1: [
            {
              id: "aot-iqiyi-s1",
              title: "第一季 全 25 集",
              nativeId: "19rrk2u98a",
              start: 1,
              end: 25,
              targetStart: 1,
              status: "confirmed",
            },
          ],
          4: [
            {
              id: "aot-iqiyi-s4",
              title: "The Final Season 全 28 集",
              nativeId: "19rrk2u98p",
              start: 1,
              end: 28,
              targetStart: 1,
              status: "confirmed",
            },
          ],
        },
      },
      {
        id: "aot-tencent-jp",
        namespace: "tencent",
        label: "日语原声",
        segmentsBySeason: {
          4: [
            {
              id: "aot-tx-s4-1",
              title: "最终季",
              nativeId: "mzc002009x8ab1",
              start: 1,
              end: 16,
              targetStart: 1,
              status: "confirmed",
            },
          ],
        },
      },
    ],
    catalogRows: [
      {
        id: "aot-tmdb",
        namespace: "tmdb",
        roleLabel: "基准 · tv:1429",
        isBaseline: true,
        wholeMediaNativeId: "tv:1429",
        wholeMediaLabel: "整部",
      },
      {
        id: "aot-imdb",
        namespace: "imdb",
        roleLabel: "tt2560140 · 另有 1 个单集",
        wholeMediaNativeId: "tt2560140",
        wholeMediaLabel: "整部",
      },
      {
        id: "aot-douban",
        namespace: "douban",
        roleLabel: "3 个条目",
        segmentsBySeason: {
          4: [
            {
              id: "aot-db-1",
              title: "进击的巨人 最终季",
              nativeId: "30488569",
              start: 1,
              end: 16,
              status: "confirmed",
            },
            {
              id: "aot-db-2",
              title: "最终季 Part.2",
              nativeId: "35414552",
              start: 17,
              end: 28,
              status: "confirmed",
            },
            {
              id: "aot-db-3",
              title: "完结篇",
              nativeId: "35867291",
              start: 29,
              end: 30,
              status: "pending",
            },
          ],
        },
      },
      {
        id: "aot-bangumi",
        namespace: "bangumi",
        roleLabel: "2 个条目",
        segmentsBySeason: {
          4: [
            {
              id: "aot-bgm-1",
              title: "The Final Season",
              nativeId: "285666",
              start: 1,
              end: 16,
              status: "confirmed",
            },
            {
              id: "aot-bgm-2",
              title: "Final Season Part 2",
              nativeId: "331752",
              start: 17,
              end: 28,
              status: "confirmed",
            },
          ],
        },
      },
    ],
  },
  {
    id: "one-piece",
    tmdbId: 37854,
    type: "tv",
    category: "anime",
    title: "海贼王",
    originalTitle: "ワンピース · One Piece",
    yearRange: "1999–",
    year: 1999,
    region: "日本",
    statusLabel: "连载中",
    genres: ["动画", "冒险", "奇幻", "热血"],
    synopsis: "少年路飞为了成为海贼王，和伙伴们驾船出海，寻找传说中的大秘宝「ONE PIECE」。",
    credits: [
      { role: "原作", name: "尾田荣一郎" },
      { role: "动画制作", name: "东映动画" },
    ],
    posterUrl: TMDB_POSTER("f9AFdxegmmWOghgw9E6ebICkstl.jpg"),
    backdropUrl: TMDB_BACKDROP("2rmK7mnchw9Xr3XdiTFSxTTLXqv.jpg"),
    baseline: "tmdb",
    seasons: makeOnePieceSeasons(),
    totalEpisodes: 1377,
    defaultSeason: 22,
    shelves: ["bangumi"],
    externalIds: {
      tmdb: ["tv:37854"],
      tvdb: ["81797"],
      imdb: ["tt0388629"],
      douban: ["1453238"],
      bangumi: ["975"],
    },
    catalogNote: "第 22 季在各资料站的条目",
    platformRows: [
      {
        id: "op-bili-jp",
        namespace: "bilibili",
        label: "日语原声",
        isDefault: true,
        segmentsBySeason: {
          22: makeOnePieceBilibiliSegments(),
          1: [
            {
              id: "op-bili-s1",
              title: "东海篇 · 1–61",
              nativeId: "ss42001",
              start: 1,
              end: 61,
              status: "confirmed",
            },
          ],
        },
        allSeasonSegments: [
          {
            id: "op-bili-all-1",
            title: "第 1–7 季",
            nativeId: "ss42001",
            start: 1,
            end: 7,
            status: "confirmed",
          },
          {
            id: "op-bili-all-2",
            title: "第 10–22 季",
            nativeId: "ss42010",
            start: 10,
            end: 22,
            status: "confirmed",
          },
        ],
      },
      {
        id: "op-tx-jp",
        namespace: "tencent",
        label: "日语原声",
        segmentsBySeason: {
          22: [
            {
              id: "op-tx-s22",
              title: "全集 · 本季 1–195",
              nativeId: "m441e3rjq9kwpsc",
              start: 1,
              end: 195,
              status: "confirmed",
            },
          ],
        },
        allSeasonSegments: [
          {
            id: "op-tx-all",
            title: "第 1–22 季",
            nativeId: "m441e3rjq9kwpsc",
            start: 1,
            end: 22,
            status: "confirmed",
          },
        ],
      },
      {
        id: "op-iqiyi-jp",
        namespace: "iqiyi",
        label: "日语原声",
        segmentsBySeason: {
          22: [
            {
              id: "op-iq-1",
              title: "第 1 · 1–40",
              nativeId: "19rrhb199p",
              start: 1,
              end: 40,
              status: "confirmed",
            },
            {
              id: "op-iq-2",
              title: "第 2 · 41–80",
              nativeId: "19rrhb199q",
              start: 41,
              end: 80,
              status: "confirmed",
            },
            {
              id: "op-iq-3",
              title: "第 3 · 81–120",
              nativeId: "19rrhb199r",
              start: 81,
              end: 120,
              status: "confirmed",
            },
          ],
        },
        allSeasonSegments: [
          {
            id: "op-iq-all",
            title: "第 1–22 季",
            nativeId: "19rrhb199p",
            start: 1,
            end: 21,
            status: "confirmed",
          },
        ],
      },
      {
        id: "op-youku-zh",
        namespace: "youku",
        label: "国语配音",
        segmentsBySeason: {
          22: [],
        },
        allSeasonSegments: [
          {
            id: "op-yk-all",
            title: "第 1–12 季",
            nativeId: "cc001f06962411de83b1",
            start: 1,
            end: 12,
            status: "muted",
          },
        ],
      },
    ],
    catalogRows: [
      {
        id: "op-tmdb",
        namespace: "tmdb",
        roleLabel: "基准",
        isBaseline: true,
        wholeMediaNativeId: "tv:37854",
        wholeMediaLabel: "整部 · tv:37854",
        segmentsBySeason: {
          22: [
            {
              id: "op-tmdb-s22",
              title: "第 22 季 · 3754",
              nativeId: "tv:37854",
              start: 1,
              end: 195,
              status: "confirmed",
            },
          ],
        },
        allSeasonSegments: [
          {
            id: "op-tmdb-all",
            title: "第 1–22 季",
            nativeId: "tv:37854",
            start: 1,
            end: 22,
            status: "confirmed",
          },
        ],
      },
      {
        id: "op-tvdb",
        namespace: "tvdb",
        roleLabel: "整部 + 季",
        wholeMediaNativeId: "81797",
        wholeMediaLabel: "整部 · 81797",
        segmentsBySeason: {
          22: [
            {
              id: "op-tvdb-s22",
              title: "第 22 季 · 27154",
              nativeId: "81797",
              start: 1,
              end: 195,
              status: "confirmed",
            },
          ],
        },
        allSeasonSegments: [
          {
            id: "op-tvdb-all",
            title: "第 1–22 季",
            nativeId: "81797",
            start: 1,
            end: 22,
            status: "confirmed",
          },
        ],
      },
      {
        id: "op-imdb",
        namespace: "imdb",
        roleLabel: "整部 + 单集",
        wholeMediaNativeId: "tt0388629",
        wholeMediaLabel: "整部 · tt0388629",
        note: "IMDb 没有季编号，只有整部和单集（单集暂不收录）",
      },
      {
        id: "op-douban",
        namespace: "douban",
        roleLabel: "本季 3 个条目",
        segmentsBySeason: {
          22: [
            {
              id: "op-db-1",
              title: "和之国篇 第一幕 · 1–60",
              nativeId: "34452811",
              start: 1,
              end: 60,
              status: "confirmed",
            },
            {
              id: "op-db-2",
              title: "和之国篇 第二幕 · 61–130",
              nativeId: "35204190",
              start: 61,
              end: 130,
              status: "confirmed",
            },
            {
              id: "op-db-3",
              title: "和之国篇 第三幕 · 131–195",
              nativeId: "36108842",
              start: 131,
              end: 195,
              status: "pending",
            },
          ],
        },
        allSeasonSegments: [
          {
            id: "op-db-all-1",
            title: "第 1–21 季",
            nativeId: "1453238",
            start: 1,
            end: 21,
            status: "confirmed",
          },
          {
            id: "op-db-all-2",
            title: "第 22 季",
            nativeId: "36108842",
            start: 22,
            end: 22,
            status: "pending",
          },
        ],
      },
      {
        id: "op-bangumi",
        namespace: "bangumi",
        roleLabel: "本季 1 个条目",
        segmentsBySeason: {
          22: [
            {
              id: "op-bgm-s22",
              title: "ONE PIECE · 本季 1–195",
              nativeId: "975",
              start: 1,
              end: 195,
              status: "confirmed",
            },
          ],
        },
        allSeasonSegments: [
          {
            id: "op-bgm-all",
            title: "第 1–22 季",
            nativeId: "975",
            start: 1,
            end: 22,
            status: "confirmed",
          },
        ],
      },
    ],
  },
  {
    id: "dandadan",
    tmdbId: 240411,
    type: "tv",
    category: "anime",
    title: "胆大党",
    originalTitle: "ダンダダン · DAN DA DAN",
    yearRange: "2024–",
    year: 2024,
    region: "日本",
    statusLabel: "连载中",
    genres: ["动画", "动作冒险", "喜剧", "科幻奇幻"],
    synopsis:
      "出生于灵媒师家族的女高中生·小桃（绫濑桃），与她同年级的超自然爱好者·厄卡伦（高仓健）。小桃在厄卡伦遭到班上同学欺凌时保护了他，两人以此为契机开始有了交流。相信幽灵存在但否定外星人的小桃，和相信外星人存在但否定幽灵的厄卡伦各自前往灵异圣地，在绝境中觉醒超能力，挑战接连逼近的怪异！",
    credits: [
      { role: "原作", name: "龙幸伸" },
      { role: "动画制作", name: "Science SARU" },
    ],
    posterUrl: TMDB_POSTER("dRNNUYCJB9gACxqiIbbDLOkpFB2.jpg"),
    backdropUrl: TMDB_BACKDROP("uNTrRKIOyKYISthoeizghtXPEOK.jpg"),
    baseline: "tmdb",
    seasons: [{ season: 1, episodeCount: 24, airYear: 2024 }],
    totalEpisodes: 24,
    defaultSeason: 1,
    shelves: ["bangumi"],
    weeklyQueries: 1284,
    externalIds: {
      tmdb: ["tv:240411"],
      tvdb: ["432832"],
      imdb: ["tt30217403"],
      bangumi: ["467461"],
    },
    catalogNote: "第 1 季在各资料站的条目，权威资料站自动同步。TVDB 把这一季拆成了 2 季",
    platformRows: [],
    catalogRows: [
      {
        id: "ddd-tmdb",
        namespace: "tmdb",
        roleLabel: "基准",
        isBaseline: true,
        wholeMediaNativeId: "tv:240411",
        wholeMediaLabel: "整部 · tv:240411",
        segmentsBySeason: {
          1: [
            {
              id: "ddd-tmdb-s1",
              title: "第 1 季 · 385312",
              nativeId: "tv:240411",
              start: 1,
              end: 24,
              status: "confirmed",
            },
          ],
        },
      },
      {
        id: "ddd-tvdb",
        namespace: "tvdb",
        roleLabel: "整部 + 季",
        wholeMediaNativeId: "432832",
        wholeMediaLabel: "整部 · 432832",
        segmentsBySeason: {
          1: [
            {
              id: "ddd-tvdb-1",
              title: "第 1 季 · 2054746 · E1–12",
              nativeId: "432832",
              start: 1,
              end: 12,
              status: "confirmed",
            },
            {
              id: "ddd-tvdb-2",
              title: "第 2 季 · 2161196 · E13–24",
              nativeId: "432832",
              start: 13,
              end: 24,
              status: "confirmed",
            },
          ],
        },
      },
      {
        id: "ddd-imdb",
        namespace: "imdb",
        roleLabel: "整部 + 单集",
        wholeMediaNativeId: "tt30217403",
        wholeMediaLabel: "整部 · tt30217403",
        note: "IMDb 没有季编号，只有整部和单集（单集暂不收录）",
      },
    ],
  },
  {
    id: "three-body",
    tmdbId: 204541,
    type: "tv",
    category: "tv",
    title: "三体",
    originalTitle: "三体 · Three-Body",
    yearRange: "2023",
    year: 2023,
    region: "中国大陆",
    statusLabel: "已完结",
    genres: ["科幻", "悬疑", "剧情"],
    synopsis:
      "2007年，地球基础科学出现了异常的扰动，纳米科学家汪淼与刑警史强联手调查科学界频发的离奇自杀事件，逐步揭开了名为「三体」的未知文明与人类命运的宏大序幕。",
    credits: [
      { role: "导演", name: "杨磊" },
      { role: "原著", name: "刘慈欣" },
    ],
    posterUrl: TMDB_POSTER("q2sNliRi4j0ncXKUO1x0MldR20A.jpg"),
    backdropUrl: TMDB_BACKDROP("zxfBtHz5UmSTfIEC4O4GngyjHwa.jpg"),
    baseline: "tmdb",
    seasons: [{ season: 1, episodeCount: 30, airYear: 2023 }],
    totalEpisodes: 30,
    defaultSeason: 1,
    shelves: ["tmdb", "douban"],
    externalIds: {
      tmdb: ["tv:204541"],
      douban: ["26647087"],
      imdb: ["tt20242042"],
      tencent: ["mzc002007knmh3g"],
    },
    platformRows: [
      {
        id: "tb-tx",
        namespace: "tencent",
        label: "国语原声",
        isDefault: true,
        segmentsBySeason: {
          1: [
            {
              id: "tb-tx-s1",
              title: "三体 全 30 集",
              nativeId: "mzc002007knmh3g",
              start: 1,
              end: 30,
              targetStart: 1,
              status: "confirmed",
            },
          ],
        },
      },
    ],
    catalogRows: [
      {
        id: "tb-tmdb",
        namespace: "tmdb",
        roleLabel: "基准 · tv:204541",
        isBaseline: true,
        wholeMediaNativeId: "tv:204541",
        wholeMediaLabel: "整部",
      },
      {
        id: "tb-douban",
        namespace: "douban",
        roleLabel: "1 个条目",
        segmentsBySeason: {
          1: [
            {
              id: "tb-db-1",
              title: "三体 · 26647087",
              nativeId: "26647087",
              start: 1,
              end: 30,
              status: "confirmed",
            },
          ],
        },
      },
      {
        id: "tb-imdb",
        namespace: "imdb",
        roleLabel: "tt20242042",
        wholeMediaNativeId: "tt20242042",
        wholeMediaLabel: "整部",
      },
    ],
  },
  {
    id: "wandering-earth-2",
    tmdbId: 842675,
    type: "movie",
    category: "movie",
    title: "流浪地球2",
    originalTitle: "流浪地球2 · The Wandering Earth II",
    yearRange: "2023",
    year: 2023,
    region: "中国大陆",
    statusLabel: "电影",
    genres: ["科幻", "冒险", "动作"],
    synopsis:
      "太阳即将毁灭，人类在地球表面建造出巨大的推进器，寻找新的家园。然而宇宙之路危机四伏，为了拯救地球，流浪地球时代的年轻人再次挺身而出，展开争分夺秒的生死之战。",
    credits: [
      { role: "导演", name: "郭帆" },
      { role: "主演", name: "吴京 / 刘德华 / 李雪健" },
    ],
    posterUrl: TMDB_POSTER("cAS2e9hUwu6Ydsx7byXj16H00Ai.jpg"),
    backdropUrl: TMDB_BACKDROP("94cS0mzODEoNIXFT7nhPcI8V4IJ.jpg"),
    baseline: "tmdb",
    seasons: [],
    shelves: ["tmdb", "douban"],
    externalIds: {
      tmdb: ["movie:842675"],
      douban: ["35267208"],
      imdb: ["tt13539646"],
    },
    platformRows: [
      {
        id: "we2-tx",
        namespace: "tencent",
        label: "国语原声",
        isDefault: true,
        segmentsBySeason: {
          0: [
            {
              id: "we2-tx-0",
              title: "流浪地球2 正片",
              nativeId: "mzc00200we201",
              start: 1,
              end: 1,
              status: "confirmed",
            },
          ],
        },
      },
      {
        id: "we2-iq",
        namespace: "iqiyi",
        label: "国语原声",
        segmentsBySeason: {
          0: [
            {
              id: "we2-iq-0",
              title: "流浪地球2",
              nativeId: "19rrwe2iq",
              start: 1,
              end: 1,
              status: "confirmed",
            },
          ],
        },
      },
      {
        id: "we2-yk",
        namespace: "youku",
        label: "国语原声",
        segmentsBySeason: {
          0: [
            {
              id: "we2-yk-0",
              title: "流浪地球2",
              nativeId: "XNTk1Mjg0MTI",
              start: 1,
              end: 1,
              status: "confirmed",
            },
          ],
        },
      },
    ],
    catalogRows: [
      {
        id: "we2-tmdb",
        namespace: "tmdb",
        roleLabel: "基准 · movie:842675",
        isBaseline: true,
        wholeMediaNativeId: "movie:842675",
        wholeMediaLabel: "整部",
      },
      {
        id: "we2-douban",
        namespace: "douban",
        roleLabel: "1 个条目",
        wholeMediaNativeId: "35267208",
        wholeMediaLabel: "流浪地球2 · 35267208",
      },
      {
        id: "we2-imdb",
        namespace: "imdb",
        roleLabel: "tt13539646",
        wholeMediaNativeId: "tt13539646",
        wholeMediaLabel: "整部",
      },
    ],
  },
  {
    id: "blossoms-shanghai",
    tmdbId: 106841,
    type: "tv",
    category: "tv",
    title: "繁花",
    originalTitle: "繁花 · Blossoms Shanghai",
    yearRange: "2023",
    year: 2023,
    region: "中国大陆",
    statusLabel: "已完结",
    genres: ["剧情", "年代"],
    synopsis:
      "九十年代的上海处处是机遇与希望。青年阿宝凭借改革开放的春风和自己的打拼跻身成为商界后起之秀，黄河路上无人不晓的宝总。",
    credits: [
      { role: "导演", name: "王家卫" },
      { role: "主演", name: "胡歌 / 马伊琍 / 唐嫣 / 辛芷蕾" },
    ],
    posterUrl: TMDB_POSTER("rV1owsdKtXytJ5eFMOOVTze3mrk.jpg"),
    backdropUrl: TMDB_BACKDROP("3J8HmgR16MKX2iT71mB4EIDdV2x.jpg"),
    baseline: "tmdb",
    seasons: [{ season: 1, episodeCount: 30, airYear: 2023 }],
    totalEpisodes: 30,
    defaultSeason: 1,
    shelves: ["tmdb", "douban"],
    externalIds: { tmdb: ["tv:106841"], douban: ["34874432"] },
    platformRows: [
      {
        id: "fh-tx",
        namespace: "tencent",
        label: "普通话版",
        isDefault: true,
        segmentsBySeason: {
          1: [
            {
              id: "fh-tx-s1",
              title: "繁花 全 30 集",
              nativeId: "mzc00200fh2023",
              start: 1,
              end: 30,
              status: "confirmed",
            },
          ],
        },
      },
    ],
    catalogRows: [
      {
        id: "fh-tmdb",
        namespace: "tmdb",
        roleLabel: "基准 · tv:106841",
        isBaseline: true,
        wholeMediaNativeId: "tv:106841",
        wholeMediaLabel: "整部",
      },
      {
        id: "fh-db",
        namespace: "douban",
        roleLabel: "1 个条目",
        segmentsBySeason: {
          1: [
            {
              id: "fh-db-1",
              title: "繁花 · 34874432",
              nativeId: "34874432",
              start: 1,
              end: 30,
              status: "confirmed",
            },
          ],
        },
      },
    ],
  },
  {
    id: "shogun",
    tmdbId: 126308,
    type: "tv",
    category: "tv",
    title: "幕府将军",
    originalTitle: "Shōgun",
    yearRange: "2024–",
    year: 2024,
    region: "美国",
    statusLabel: "连载中",
    genres: ["剧情", "历史", "战争"],
    synopsis:
      "1600 年的日本正处于世纪内战的前夕。吉井虎永领主在摄政委员会强敌环伺之际，一艘神秘欧洲船只搁浅在附近渔村，英国引航员约翰·布莱克索恩带来了足以扭转局势的秘密。",
    credits: [
      { role: "主创", name: "雷切尔·近藤 / 贾斯汀·马克斯" },
      { role: "主演", name: "真田广之 / 柯斯莫·贾维斯 / 泽井杏奈" },
    ],
    posterUrl: TMDB_POSTER("t1eSI5NU4nXcT0DHjwgDjjQP0k6.jpg"),
    backdropUrl: TMDB_BACKDROP("bwSmgmd90hCWwqOKQYTEraeOZhJ.jpg"),
    baseline: "tmdb",
    seasons: [{ season: 1, episodeCount: 10, airYear: 2024 }],
    totalEpisodes: 10,
    defaultSeason: 1,
    shelves: ["tmdb", "trakt"],
    weeklyQueries: 962,
    externalIds: { tmdb: ["tv:126308"], imdb: ["tt2788316"], trakt: ["shogun-2024"] },
    platformRows: [],
    catalogRows: [
      {
        id: "sg-tmdb",
        namespace: "tmdb",
        roleLabel: "基准 · tv:126308",
        isBaseline: true,
        wholeMediaNativeId: "tv:126308",
        wholeMediaLabel: "整部",
      },
      {
        id: "sg-imdb",
        namespace: "imdb",
        roleLabel: "tt2788316",
        wholeMediaNativeId: "tt2788316",
        wholeMediaLabel: "整部",
      },
      {
        id: "sg-trakt",
        namespace: "trakt",
        roleLabel: "shogun-2024",
        wholeMediaNativeId: "shogun-2024",
        wholeMediaLabel: "整部",
      },
    ],
  },
  {
    id: "frieren",
    tmdbId: 209867,
    type: "tv",
    category: "anime",
    title: "葬送的芙莉莲",
    originalTitle: "葬送のフリーレン · Frieren: Beyond Journey's End",
    yearRange: "2023–",
    year: 2023,
    region: "日本",
    statusLabel: "已完结",
    genres: ["动画", "奇幻", "冒险", "剧情"],
    synopsis:
      "打倒魔王的勇者一行人凯旋归来，精灵魔法使芙莉莲见证了伙伴欣美尔的衰老离世后，踏上了重新了解人类与追寻灵魂安眠之地的旅程。",
    credits: [
      { role: "原作", name: "山田钟人 / 阿部司" },
      { role: "动画制作", name: "MADHOUSE" },
    ],
    posterUrl: TMDB_POSTER("1TtrtRIwXz5BB0gXEl8zgBypl9c.jpg"),
    backdropUrl: TMDB_BACKDROP("rBOnrVlck7BIlGeWVlzYiZeg4l2.jpg"),
    baseline: "tmdb",
    seasons: [{ season: 1, episodeCount: 28, airYear: 2023 }],
    totalEpisodes: 28,
    defaultSeason: 1,
    shelves: ["tmdb", "douban", "bangumi"],
    externalIds: { tmdb: ["tv:209867"], bangumi: ["400602"], bilibili: ["ss45948"] },
    platformRows: [
      {
        id: "fr-bili",
        namespace: "bilibili",
        label: "日语原声",
        isDefault: true,
        segmentsBySeason: {
          1: [
            {
              id: "fr-bili-s1",
              title: "葬送的芙莉莲 全 28 集",
              nativeId: "ss45948",
              start: 1,
              end: 28,
              status: "confirmed",
            },
          ],
        },
      },
    ],
    catalogRows: [
      {
        id: "fr-tmdb",
        namespace: "tmdb",
        roleLabel: "基准 · tv:209867",
        isBaseline: true,
        wholeMediaNativeId: "tv:209867",
        wholeMediaLabel: "整部",
      },
      {
        id: "fr-bgm",
        namespace: "bangumi",
        roleLabel: "1 个条目",
        segmentsBySeason: {
          1: [
            {
              id: "fr-bgm-1",
              title: "葬送のフリーレン · 400602",
              nativeId: "400602",
              start: 1,
              end: 28,
              status: "confirmed",
            },
          ],
        },
      },
    ],
  },
  {
    id: "long-season",
    tmdbId: 225008,
    type: "tv",
    category: "tv",
    title: "漫长的季节",
    originalTitle: "漫长的季节 · The Long Season",
    yearRange: "2023",
    year: 2023,
    region: "中国大陆",
    statusLabel: "已完结",
    genres: ["悬疑", "剧情", "犯罪"],
    synopsis:
      "小城桦林，此时此刻。出租车司机王响做梦也没想到，他还有机会遇到一个本该死去的人，一段横跨十八年的陈年旧案再度浮出水面。",
    credits: [
      { role: "导演", name: "辛爽" },
      { role: "主演", name: "范伟 / 秦昊 / 陈明昊" },
    ],
    posterUrl: TMDB_POSTER("tJLiKDYdfMskFkJXV1HnaQAdpGf.jpg"),
    backdropUrl: TMDB_BACKDROP("mYKFUpNjwtsqm9DWGnXlCJhEj0q.jpg"),
    baseline: "tmdb",
    seasons: [{ season: 1, episodeCount: 12, airYear: 2023 }],
    totalEpisodes: 12,
    defaultSeason: 1,
    shelves: ["douban"],
    externalIds: { tmdb: ["tv:225008"], douban: ["35588177"] },
    platformRows: [
      {
        id: "ls-tx",
        namespace: "tencent",
        label: "国语原声",
        isDefault: true,
        segmentsBySeason: {
          1: [
            {
              id: "ls-tx-1",
              title: "漫长的季节 1–6 集",
              nativeId: "mzc00200ls12",
              start: 1,
              end: 6,
              status: "confirmed",
            },
          ],
        },
      },
    ],
    catalogRows: [
      {
        id: "ls-tmdb",
        namespace: "tmdb",
        roleLabel: "基准 · tv:225008",
        isBaseline: true,
        wholeMediaNativeId: "tv:225008",
        wholeMediaLabel: "整部",
      },
      {
        id: "ls-db",
        namespace: "douban",
        roleLabel: "1 个条目",
        segmentsBySeason: {
          1: [
            {
              id: "ls-db-1",
              title: "漫长的季节 · 35588177",
              nativeId: "35588177",
              start: 1,
              end: 12,
              status: "confirmed",
            },
          ],
        },
      },
    ],
  },
  {
    id: "knockout",
    tmdbId: 210757,
    type: "tv",
    category: "tv",
    title: "狂飙",
    originalTitle: "狂飙 · The Knockout",
    yearRange: "2023",
    year: 2023,
    region: "中国大陆",
    statusLabel: "已完结",
    genres: ["犯罪", "剧情"],
    synopsis:
      "京海市一线刑警安欣与鱼贩出身的高启强之间长达二十年的正邪较量，折射出一座城市在时代浪潮中的命运起伏。",
    credits: [
      { role: "导演", name: "徐纪周" },
      { role: "主演", name: "张译 / 张颂文" },
    ],
    posterUrl: TMDB_POSTER("xmBmR46Nks73VlTrCsH9i6KCWSH.jpg"),
    backdropUrl: TMDB_BACKDROP("i4xRsWEAwGgL5wMm8jrBbxxXKEI.jpg"),
    baseline: "tmdb",
    seasons: [{ season: 1, episodeCount: 39, airYear: 2023 }],
    totalEpisodes: 39,
    defaultSeason: 1,
    shelves: ["douban"],
    externalIds: { tmdb: ["tv:210757"], douban: ["35465232"] },
    platformRows: [
      {
        id: "ko-iq",
        namespace: "iqiyi",
        label: "国语原声",
        isDefault: true,
        segmentsBySeason: {
          1: [
            {
              id: "ko-iq-1",
              title: "狂飙 全 39 集",
              nativeId: "19rrko2023",
              start: 1,
              end: 39,
              status: "confirmed",
            },
          ],
        },
      },
    ],
    catalogRows: [
      {
        id: "ko-tmdb",
        namespace: "tmdb",
        roleLabel: "基准 · tv:210757",
        isBaseline: true,
        wholeMediaNativeId: "tv:210757",
        wholeMediaLabel: "整部",
      },
      {
        id: "ko-db",
        namespace: "douban",
        roleLabel: "1 个条目",
        segmentsBySeason: {
          1: [
            {
              id: "ko-db-1",
              title: "狂飙 · 35465232",
              nativeId: "35465232",
              start: 1,
              end: 39,
              status: "confirmed",
            },
          ],
        },
      },
    ],
  },
  {
    id: "bad-kids",
    tmdbId: 104960,
    type: "tv",
    category: "tv",
    title: "隐秘的角落",
    originalTitle: "隐秘的角落 · The Bad Kids",
    yearRange: "2020",
    year: 2020,
    region: "中国大陆",
    statusLabel: "已完结",
    genres: ["悬疑", "犯罪", "剧情"],
    synopsis:
      "沿海小城的三个孩子在景区游玩时无意拍摄记录了一次谋杀，他们的冒险也由此展开。扑朔迷离的案情，将几个家庭裹挟其中。",
    credits: [
      { role: "导演", name: "辛爽" },
      { role: "主演", name: "秦昊 / 王景春 / 荣梓杉" },
    ],
    posterUrl: TMDB_POSTER("zlaml7IKAIPa3NJE9LhRveELD0v.jpg"),
    backdropUrl: TMDB_BACKDROP("22DU3JT5EJ6fCkCUB8iYgwI8stO.jpg"),
    baseline: "tmdb",
    seasons: [{ season: 1, episodeCount: 12, airYear: 2020 }],
    totalEpisodes: 12,
    defaultSeason: 1,
    shelves: ["douban"],
    externalIds: { tmdb: ["tv:104960"], douban: ["33404425"] },
    platformRows: [
      {
        id: "bk-iq",
        namespace: "iqiyi",
        label: "国语原声",
        isDefault: true,
        segmentsBySeason: {
          1: [
            {
              id: "bk-iq-1",
              title: "隐秘的角落 全 12 集",
              nativeId: "19rrbk2020",
              start: 1,
              end: 12,
              status: "confirmed",
            },
          ],
        },
      },
    ],
    catalogRows: [
      {
        id: "bk-tmdb",
        namespace: "tmdb",
        roleLabel: "基准 · tv:104960",
        isBaseline: true,
        wholeMediaNativeId: "tv:104960",
        wholeMediaLabel: "整部",
      },
      {
        id: "bk-db",
        namespace: "douban",
        roleLabel: "1 个条目",
        segmentsBySeason: {
          1: [
            {
              id: "bk-db-1",
              title: "隐秘的角落 · 33404425",
              nativeId: "33404425",
              start: 1,
              end: 12,
              status: "confirmed",
            },
          ],
        },
      },
    ],
  },
  {
    id: "joy-of-life",
    tmdbId: 95842,
    type: "tv",
    category: "tv",
    title: "庆余年",
    originalTitle: "庆余年 · Joy of Life",
    yearRange: "2019–",
    year: 2019,
    region: "中国大陆",
    statusLabel: "连载中",
    genres: ["古装", "剧情", "悬疑"],
    synopsis:
      "身世神秘的少年范闲自海边小城初出茅庐，历经家族、江湖、庙堂的种种考验，逐渐揭开身世与这个世界隐藏的真相。",
    credits: [
      { role: "导演", name: "孙皓" },
      { role: "主演", name: "张若昀 / 李沁 / 陈道明" },
    ],
    posterUrl: TMDB_POSTER("wHJvPo9CLpXwX1ncDg6uD0QJIZo.jpg"),
    backdropUrl: TMDB_BACKDROP("u1CqlLecfpcuOaugKi3ol9gDQHJ.jpg"),
    baseline: "tmdb",
    seasons: [
      { season: 1, episodeCount: 46, airYear: 2019 },
      { season: 2, episodeCount: 36, airYear: 2024 },
    ],
    totalEpisodes: 82,
    defaultSeason: 1,
    shelves: ["douban"],
    externalIds: { tmdb: ["tv:95842"], douban: ["25853071"] },
    platformRows: [
      {
        id: "jol-tx",
        namespace: "tencent",
        label: "国语原声",
        isDefault: true,
        segmentsBySeason: {
          1: [
            {
              id: "jol-tx-1",
              title: "庆余年 第一季 全 46 集",
              nativeId: "rjae621recq2404",
              start: 1,
              end: 46,
              status: "confirmed",
            },
          ],
          2: [
            {
              id: "jol-tx-2",
              title: "庆余年 第二季 全 36 集",
              nativeId: "mzc00200jol2",
              start: 1,
              end: 36,
              status: "confirmed",
            },
          ],
        },
      },
    ],
    catalogRows: [
      {
        id: "jol-tmdb",
        namespace: "tmdb",
        roleLabel: "基准 · tv:95842",
        isBaseline: true,
        wholeMediaNativeId: "tv:95842",
        wholeMediaLabel: "整部",
      },
      {
        id: "jol-db",
        namespace: "douban",
        roleLabel: "2 个条目",
        segmentsBySeason: {
          1: [
            {
              id: "jol-db-1",
              title: "庆余年 第一季",
              nativeId: "25853071",
              start: 1,
              end: 46,
              status: "confirmed",
            },
          ],
        },
      },
    ],
  },
  {
    id: "dungeon-meshi",
    tmdbId: 207784,
    type: "tv",
    category: "anime",
    title: "迷宫饭",
    originalTitle: "ダンジョン飯 · Delicious in Dungeon",
    yearRange: "2024–",
    year: 2024,
    region: "日本",
    statusLabel: "连载中",
    genres: ["动画", "奇幻", "冒险", "喜剧"],
    synopsis:
      "莱欧斯的妹妹法琳在迷宫深处被红龙吞食，失去全部盘缠的冒险者小队决定就地取材，靠烹饪迷宫魔物作为口粮杀回深处救回妹妹。",
    credits: [
      { role: "原作", name: "九井谅子" },
      { role: "动画制作", name: "TRIGGER" },
    ],
    posterUrl: TMDB_POSTER("xBQK95axIdaOmfsJE7PM5bnioym.jpg"),
    backdropUrl: TMDB_BACKDROP("xC5GyeIzLsSRizJE5LedGShNgBa.jpg"),
    baseline: "tmdb",
    seasons: [{ season: 1, episodeCount: 24, airYear: 2024 }],
    totalEpisodes: 24,
    defaultSeason: 1,
    shelves: ["bangumi"],
    weeklyQueries: 731,
    externalIds: { tmdb: ["tv:207784"], bangumi: ["395499"] },
    platformRows: [],
    catalogRows: [
      {
        id: "dm-tmdb",
        namespace: "tmdb",
        roleLabel: "基准 · tv:207784",
        isBaseline: true,
        wholeMediaNativeId: "tv:207784",
        wholeMediaLabel: "整部",
      },
      {
        id: "dm-bgm",
        namespace: "bangumi",
        roleLabel: "1 个条目",
        segmentsBySeason: {
          1: [
            {
              id: "dm-bgm-1",
              title: "迷宫饭 · 395499",
              nativeId: "395499",
              start: 1,
              end: 24,
              status: "confirmed",
            },
          ],
        },
      },
    ],
  },
  {
    id: "apothecary",
    tmdbId: 220542,
    type: "tv",
    category: "anime",
    title: "药屋少女的呢喃",
    originalTitle: "薬屋のひとりごと · The Apothecary Diaries",
    yearRange: "2023–",
    year: 2023,
    region: "日本",
    statusLabel: "连载中",
    genres: ["动画", "悬疑", "剧情"],
    synopsis:
      "花街药师少女猫猫阴差阳错进宫成为下女，凭着对药学与毒理的痴迷，屡次破解后宫离奇谜案。",
    credits: [
      { role: "原作", name: "日向夏" },
      { role: "动画制作", name: "OLM / TOHO animation STUDIO" },
    ],
    posterUrl: TMDB_POSTER("nUFTbH417TqmCbw2b2mPSAESoTb.jpg"),
    backdropUrl: TMDB_BACKDROP("gffVOVZ2Y9cmVIZ26Gt9ByMGCYH.jpg"),
    baseline: "tmdb",
    seasons: [
      { season: 1, episodeCount: 24, airYear: 2023 },
      { season: 2, episodeCount: 24, airYear: 2025 },
    ],
    totalEpisodes: 48,
    defaultSeason: 1,
    shelves: ["bangumi"],
    weeklyQueries: 508,
    externalIds: { tmdb: ["tv:220542"], bangumi: ["420628"], bilibili: ["ss46284"] },
    platformRows: [
      {
        id: "ap-bili",
        namespace: "bilibili",
        label: "日语原声",
        isDefault: true,
        segmentsBySeason: {
          1: [
            {
              id: "ap-bili-s1",
              title: "药屋少女的呢喃 全 24 集",
              nativeId: "ss46284",
              start: 1,
              end: 24,
              status: "confirmed",
            },
          ],
        },
      },
    ],
    catalogRows: [
      {
        id: "ap-tmdb",
        namespace: "tmdb",
        roleLabel: "基准 · tv:220542",
        isBaseline: true,
        wholeMediaNativeId: "tv:220542",
        wholeMediaLabel: "整部",
      },
      {
        id: "ap-bgm",
        namespace: "bangumi",
        roleLabel: "1 个条目",
        segmentsBySeason: {
          1: [
            {
              id: "ap-bgm-1",
              title: "薬屋のひとりごと · 420628",
              nativeId: "420628",
              start: 1,
              end: 24,
              status: "confirmed",
            },
          ],
        },
      },
    ],
  },
  {
    id: "oshi-no-ko",
    tmdbId: 203737,
    type: "tv",
    category: "anime",
    title: "【我推的孩子】",
    originalTitle: "【推しの子】 · Oshi no Ko",
    yearRange: "2023–",
    year: 2023,
    region: "日本",
    statusLabel: "连载中",
    genres: ["动画", "剧情", "悬疑"],
    synopsis:
      "在演艺圈的聚光灯背后，谎言是最锋利的武器。妇产科医生雨宫吾郎在意外身亡后转生成了自己推的偶像星野爱的孩子，踏上了追寻真相的演艺之路。",
    credits: [
      { role: "原作", name: "赤坂明 / 横枪萌果" },
      { role: "动画制作", name: "动画工房" },
    ],
    posterUrl: TMDB_POSTER("2Au9bkgXXdzxcghyFZVfksBYPPP.jpg"),
    backdropUrl: TMDB_BACKDROP("s76eYQi6hcAcOVYpVd9hofdyt11.jpg"),
    baseline: "tmdb",
    seasons: [
      { season: 1, episodeCount: 11, airYear: 2023 },
      { season: 2, episodeCount: 13, airYear: 2024 },
    ],
    totalEpisodes: 24,
    defaultSeason: 1,
    shelves: ["douban", "bangumi"],
    externalIds: { tmdb: ["tv:203737"], bangumi: ["386809"], bilibili: ["ss44893"] },
    platformRows: [
      {
        id: "onk-bili",
        namespace: "bilibili",
        label: "日语原声",
        isDefault: true,
        segmentsBySeason: {
          1: [
            {
              id: "onk-bili-s1",
              title: "第一季 全 11 集",
              nativeId: "ss44893",
              start: 1,
              end: 11,
              status: "confirmed",
            },
          ],
        },
      },
    ],
    catalogRows: [
      {
        id: "onk-tmdb",
        namespace: "tmdb",
        roleLabel: "基准 · tv:203737",
        isBaseline: true,
        wholeMediaNativeId: "tv:203737",
        wholeMediaLabel: "整部",
      },
      {
        id: "onk-bgm",
        namespace: "bangumi",
        roleLabel: "1 个条目",
        segmentsBySeason: {
          1: [
            {
              id: "onk-bgm-1",
              title: "【推しの子】",
              nativeId: "386809",
              start: 1,
              end: 11,
              status: "confirmed",
            },
          ],
        },
      },
    ],
  },
  {
    id: "bocchi",
    tmdbId: 119100,
    type: "tv",
    category: "anime",
    title: "孤独摇滚！",
    originalTitle: "ぼっち・ざ・ろっく！ · Bocchi the Rock!",
    yearRange: "2022",
    year: 2022,
    region: "日本",
    statusLabel: "已完结",
    genres: ["动画", "喜剧", "音乐"],
    synopsis:
      "极度社恐的高中生后藤一里每天独自苦练吉他，直到偶然加入伊地知虹夏组建的「结束乐队」，开始在 Livehouse 舞台上绽放光芒。",
    credits: [
      { role: "原作", name: "滨路晶" },
      { role: "动画制作", name: "CloverWorks" },
    ],
    posterUrl: TMDB_POSTER("vWq8kZyOdSdCLeu7HjlVRIG9CYA.jpg"),
    backdropUrl: TMDB_BACKDROP("riRJGnbb18zVBEXpov8GJKnBczj.jpg"),
    baseline: "tmdb",
    seasons: [{ season: 1, episodeCount: 12, airYear: 2022 }],
    totalEpisodes: 12,
    defaultSeason: 1,
    shelves: ["douban", "bangumi"],
    externalIds: { tmdb: ["tv:119100"], bangumi: ["328609"], bilibili: ["ss43164"] },
    platformRows: [
      {
        id: "bc-bili",
        namespace: "bilibili",
        label: "日语原声",
        isDefault: true,
        segmentsBySeason: {
          1: [
            {
              id: "bc-bili-s1",
              title: "孤独摇滚！全 12 集",
              nativeId: "ss43164",
              start: 1,
              end: 12,
              status: "confirmed",
            },
          ],
        },
      },
    ],
    catalogRows: [
      {
        id: "bc-tmdb",
        namespace: "tmdb",
        roleLabel: "基准 · tv:119100",
        isBaseline: true,
        wholeMediaNativeId: "tv:119100",
        wholeMediaLabel: "整部",
      },
      {
        id: "bc-bgm",
        namespace: "bangumi",
        roleLabel: "1 个条目",
        segmentsBySeason: {
          1: [
            {
              id: "bc-bgm-1",
              title: "ぼっち・ざ・ろっく！",
              nativeId: "328609",
              start: 1,
              end: 12,
              status: "confirmed",
            },
          ],
        },
      },
    ],
  },
  {
    id: "spy-family",
    tmdbId: 120089,
    type: "tv",
    category: "anime",
    title: "间谍过家家",
    originalTitle: "SPY×FAMILY",
    yearRange: "2022–",
    year: 2022,
    region: "日本",
    statusLabel: "连载中",
    genres: ["动画", "喜剧", "动作"],
    synopsis:
      "代号「黄昏」的顶尖间谍为执行机密任务，临时组建了由杀手妻子与读心超能力女儿组成的伪装家庭，展开啼笑皆非的日常。",
    credits: [
      { role: "原作", name: "远藤达哉" },
      { role: "动画制作", name: "WIT STUDIO / CloverWorks" },
    ],
    posterUrl: TMDB_POSTER("xkEGd9GF3oty89xDiXMGJm6pGQL.jpg"),
    backdropUrl: TMDB_BACKDROP("lysUnU6V0VfcthDbviuVlIqgHOR.jpg"),
    baseline: "tmdb",
    seasons: [
      { season: 1, episodeCount: 25, airYear: 2022 },
      { season: 2, episodeCount: 12, airYear: 2023 },
    ],
    totalEpisodes: 37,
    defaultSeason: 1,
    shelves: ["douban"],
    externalIds: { tmdb: ["tv:120089"], bilibili: ["ss41410"] },
    platformRows: [
      {
        id: "sf-bili",
        namespace: "bilibili",
        label: "日语原声",
        isDefault: true,
        segmentsBySeason: {
          1: [
            {
              id: "sf-bili-s1",
              title: "第一季 全 25 集",
              nativeId: "ss41410",
              start: 1,
              end: 25,
              status: "confirmed",
            },
          ],
          2: [
            {
              id: "sf-bili-s2",
              title: "第二季 全 12 集",
              nativeId: "ss46082",
              start: 1,
              end: 12,
              status: "confirmed",
            },
          ],
        },
      },
      {
        id: "sf-iq",
        namespace: "iqiyi",
        label: "日语原声",
        segmentsBySeason: {
          1: [
            {
              id: "sf-iq-s1",
              title: "第一季 全 25 集",
              nativeId: "19rrsf2022",
              start: 1,
              end: 25,
              status: "confirmed",
            },
          ],
        },
      },
    ],
    catalogRows: [
      {
        id: "sf-tmdb",
        namespace: "tmdb",
        roleLabel: "基准 · tv:120089",
        isBaseline: true,
        wholeMediaNativeId: "tv:120089",
        wholeMediaLabel: "整部",
      },
    ],
  },
  {
    id: "penguin",
    tmdbId: 194764,
    type: "tv",
    category: "tv",
    title: "企鹅人",
    originalTitle: "The Penguin",
    yearRange: "2024",
    year: 2024,
    region: "美国",
    statusLabel: "已完结",
    genres: ["犯罪", "剧情"],
    synopsis:
      "紧接电影《新蝙蝠侠》事件之后，奥兹·科布企图趁哥谭黑帮权力真空之际，用阴谋与狠辣手段一步步登上哥谭地下帝国的王座。",
    credits: [
      { role: "主创", name: "劳伦·莱弗朗茨" },
      { role: "主演", name: "科林·法瑞尔 / 克里斯汀·米利欧缇" },
    ],
    posterUrl: TMDB_POSTER("ia3J58V58ABXMlqZQFHwmtwMMTW.jpg"),
    backdropUrl: TMDB_BACKDROP("4TdmuuwiIiKw3JOjIuhdgYxRXnN.jpg"),
    baseline: "tmdb",
    seasons: [{ season: 1, episodeCount: 8, airYear: 2024 }],
    totalEpisodes: 8,
    defaultSeason: 1,
    shelves: ["trakt"],
    externalIds: { tmdb: ["tv:194764"], imdb: ["tt15435876"], trakt: ["the-penguin"] },
    platformRows: [],
    catalogRows: [
      {
        id: "pg-tmdb",
        namespace: "tmdb",
        roleLabel: "基准 · tv:194764",
        isBaseline: true,
        wholeMediaNativeId: "tv:194764",
        wholeMediaLabel: "整部",
      },
      {
        id: "pg-trakt",
        namespace: "trakt",
        roleLabel: "the-penguin",
        wholeMediaNativeId: "the-penguin",
        wholeMediaLabel: "整部",
      },
    ],
  },
  {
    id: "fallout",
    tmdbId: 106379,
    type: "tv",
    category: "tv",
    title: "辐射",
    originalTitle: "Fallout",
    yearRange: "2024–",
    year: 2024,
    region: "美国",
    statusLabel: "连载中",
    genres: ["科幻", "冒险", "动作"],
    synopsis:
      "核灾发生两百年后，生活在舒适地下避难所的露西被迫踏上荒芜诡异的废土表面，寻找失踪的父亲并直面残酷的新世界。",
    credits: [
      { role: "主创", name: "格雷厄姆·瓦格纳 / 日内瓦·罗伯逊-德沃雷特" },
      { role: "主演", name: "艾拉·珀内尔 / 沃尔顿·戈金斯" },
    ],
    posterUrl: TMDB_POSTER("b056vciDjYJ3pthEvaFpPcZNT3i.jpg"),
    backdropUrl: TMDB_BACKDROP("coaPCIqQBPUZsOnJcWZxhaORcDT.jpg"),
    baseline: "tmdb",
    seasons: [{ season: 1, episodeCount: 8, airYear: 2024 }],
    totalEpisodes: 8,
    defaultSeason: 1,
    shelves: ["trakt"],
    externalIds: { tmdb: ["tv:106379"], imdb: ["tt12637874"], trakt: ["fallout"] },
    platformRows: [],
    catalogRows: [
      {
        id: "fo-tmdb",
        namespace: "tmdb",
        roleLabel: "基准 · tv:106379",
        isBaseline: true,
        wholeMediaNativeId: "tv:106379",
        wholeMediaLabel: "整部",
      },
      {
        id: "fo-trakt",
        namespace: "trakt",
        roleLabel: "fallout",
        wholeMediaNativeId: "fallout",
        wholeMediaLabel: "整部",
      },
    ],
  },
  {
    id: "severance",
    tmdbId: 95396,
    type: "tv",
    category: "tv",
    title: "人生切割术",
    originalTitle: "Severance",
    yearRange: "2022–",
    year: 2022,
    region: "美国",
    statusLabel: "连载中",
    genres: ["科幻", "悬疑", "惊悚"],
    synopsis:
      "卢蒙工业的员工接受了「记忆分离手术」，将工作记忆与私人生活记忆彻底割裂。随着一名神秘前同事的出现，马克开始怀疑公司背后隐藏着惊人秘密。",
    credits: [
      { role: "主创", name: "丹·埃里克森" },
      { role: "导演", name: "本·斯蒂勒" },
    ],
    posterUrl: TMDB_POSTER("s69hd1WlHYuE4XmAlIm7iAIhuTo.jpg"),
    backdropUrl: TMDB_BACKDROP("ixgFmf1X59PUZam2qbAfskx2gQr.jpg"),
    baseline: "tmdb",
    seasons: [
      { season: 1, episodeCount: 9, airYear: 2022 },
      { season: 2, episodeCount: 10, airYear: 2025 },
    ],
    totalEpisodes: 19,
    defaultSeason: 1,
    shelves: ["trakt"],
    externalIds: { tmdb: ["tv:95396"], imdb: ["tt11280740"], trakt: ["severance"] },
    platformRows: [],
    catalogRows: [
      {
        id: "sv-tmdb",
        namespace: "tmdb",
        roleLabel: "基准 · tv:95396",
        isBaseline: true,
        wholeMediaNativeId: "tv:95396",
        wholeMediaLabel: "整部",
      },
      {
        id: "sv-trakt",
        namespace: "trakt",
        roleLabel: "severance",
        wholeMediaNativeId: "severance",
        wholeMediaLabel: "整部",
      },
    ],
  },
  {
    id: "the-bear",
    tmdbId: 136315,
    type: "tv",
    category: "tv",
    title: "熊家餐馆",
    originalTitle: "The Bear",
    yearRange: "2022–",
    year: 2022,
    region: "美国",
    statusLabel: "连载中",
    genres: ["剧情", "喜剧"],
    synopsis:
      "出身顶级米其林餐厅的年轻主厨卡米回到芝加哥接手家族留下的三明治老店，在混乱的后厨与沉重债务间挣扎重建秩序。",
    credits: [
      { role: "主创", name: "克里斯托弗·斯托勒" },
      { role: "主演", name: "杰瑞米·艾伦·怀特 / 阿尤·艾德维利" },
    ],
    posterUrl: TMDB_POSTER("7y1ibpkTwlKYrxFbq3lh2RgIB1k.jpg"),
    backdropUrl: TMDB_BACKDROP("aJtG4txtmiRHwAAqENQHZvBs6kY.jpg"),
    baseline: "tmdb",
    seasons: [
      { season: 1, episodeCount: 8, airYear: 2022 },
      { season: 2, episodeCount: 10, airYear: 2023 },
      { season: 3, episodeCount: 10, airYear: 2024 },
    ],
    totalEpisodes: 28,
    defaultSeason: 1,
    shelves: ["trakt"],
    externalIds: { tmdb: ["tv:136315"], imdb: ["tt14452776"], trakt: ["the-bear"] },
    platformRows: [],
    catalogRows: [
      {
        id: "br-tmdb",
        namespace: "tmdb",
        roleLabel: "基准 · tv:136315",
        isBaseline: true,
        wholeMediaNativeId: "tv:136315",
        wholeMediaLabel: "整部",
      },
      {
        id: "br-trakt",
        namespace: "trakt",
        roleLabel: "the-bear",
        wholeMediaNativeId: "the-bear",
        wholeMediaLabel: "整部",
      },
    ],
  },
  {
    id: "last-of-us",
    tmdbId: 100088,
    type: "tv",
    category: "tv",
    title: "最后生还者",
    originalTitle: "The Last of Us",
    yearRange: "2023–",
    year: 2023,
    region: "美国",
    statusLabel: "连载中",
    genres: ["剧情", "科幻", "冒险"],
    synopsis:
      "现代文明被虫草菌疫情摧毁二十年后，冷酷的走私客乔尔受雇护送拥有免疫体质的少女艾莉穿越危机四伏的美国。",
    credits: [
      { role: "主创", name: "克雷格·麦辛 / 尼尔·德鲁克曼" },
      { role: "主演", name: "佩德罗·帕斯卡 / 贝拉·拉姆齐" },
    ],
    posterUrl: TMDB_POSTER("ydyTjqxZsPlcFSTBNY2INYrmEvk.jpg"),
    backdropUrl: TMDB_BACKDROP("lY2DhbA7Hy44fAKddr06UrXWWaQ.jpg"),
    baseline: "tmdb",
    seasons: [{ season: 1, episodeCount: 9, airYear: 2023 }],
    totalEpisodes: 9,
    defaultSeason: 1,
    shelves: ["trakt"],
    externalIds: { tmdb: ["tv:100088"], imdb: ["tt3581920"], trakt: ["the-last-of-us"] },
    platformRows: [],
    catalogRows: [
      {
        id: "tlou-tmdb",
        namespace: "tmdb",
        roleLabel: "基准 · tv:100088",
        isBaseline: true,
        wholeMediaNativeId: "tv:100088",
        wholeMediaLabel: "整部",
      },
      {
        id: "tlou-trakt",
        namespace: "trakt",
        roleLabel: "the-last-of-us",
        wholeMediaNativeId: "the-last-of-us",
        wholeMediaLabel: "整部",
      },
    ],
  },
  {
    id: "chang-an",
    tmdbId: 1089654,
    type: "movie",
    category: "movie",
    title: "长安三万里",
    originalTitle: "长安三万里 · Chang An",
    yearRange: "2023",
    year: 2023,
    region: "中国大陆",
    statusLabel: "电影",
    genres: ["动画", "历史", "剧情"],
    synopsis:
      "安史之乱后数年，吐蕃大军攻打西南。大唐节度使高适交战不利，长安岌岌可危。困守孤城的高适向监军太监回忆起自己与李白的一生往事。",
    credits: [
      { role: "导演", name: "谢君伟 / 邹靖" },
      { role: "制作", name: "追光动画" },
    ],
    posterUrl: TMDB_POSTER("7wxk8Ka5AGUIjCpEPg4vBOwSSul.jpg"),
    backdropUrl: TMDB_BACKDROP("zXyYAcZmTh1l6jaJzl8cxP5NN9P.jpg"),
    baseline: "tmdb",
    seasons: [],
    shelves: ["douban"],
    externalIds: { tmdb: ["movie:1089654"], douban: ["36035676"] },
    platformRows: [
      {
        id: "ca-tx",
        namespace: "tencent",
        label: "国语原声",
        isDefault: true,
        segmentsBySeason: {
          0: [
            {
              id: "ca-tx-0",
              title: "长安三万里",
              nativeId: "mzc00200changan",
              start: 1,
              end: 1,
              status: "confirmed",
            },
          ],
        },
      },
      {
        id: "ca-iq",
        namespace: "iqiyi",
        label: "国语原声",
        segmentsBySeason: {
          0: [
            {
              id: "ca-iq-0",
              title: "长安三万里",
              nativeId: "19rrca2023",
              start: 1,
              end: 1,
              status: "confirmed",
            },
          ],
        },
      },
    ],
    catalogRows: [
      {
        id: "ca-tmdb",
        namespace: "tmdb",
        roleLabel: "基准 · movie:1089654",
        isBaseline: true,
        wholeMediaNativeId: "movie:1089654",
        wholeMediaLabel: "整部",
      },
    ],
  },
  {
    id: "three-body-anime",
    tmdbId: 97113,
    type: "tv",
    category: "anime",
    title: "三体",
    originalTitle: "三体 动画版",
    yearRange: "2022",
    year: 2022,
    region: "中国大陆",
    statusLabel: "已完结",
    genres: ["动画", "科幻"],
    synopsis: "面对三体舰队的逼近，人类启动面壁计划，展开了一场跨越数个世纪的文明博弈。",
    credits: [{ role: "制作", name: "艺画开天" }],
    posterUrl: TMDB_POSTER("pHimzLXxMSZjUvDxRA4fFjvvtxa.jpg"),
    backdropUrl: TMDB_BACKDROP("Ap6qkRyJWJl7QCKRuLUleDybnBn.jpg"),
    baseline: "tmdb",
    seasons: [{ season: 1, episodeCount: 15, airYear: 2022 }],
    totalEpisodes: 15,
    defaultSeason: 1,
    shelves: [],
    externalIds: { tmdb: ["tv:97113"], bilibili: ["ss38405"] },
    platformRows: [
      {
        id: "tba-bili",
        namespace: "bilibili",
        label: "国语原声",
        isDefault: true,
        segmentsBySeason: {
          1: [
            {
              id: "tba-bili-1",
              title: "三体 动画 全 15 集",
              nativeId: "ss38405",
              start: 1,
              end: 15,
              status: "confirmed",
            },
          ],
        },
      },
    ],
    catalogRows: [
      {
        id: "tba-tmdb",
        namespace: "tmdb",
        roleLabel: "基准 · tv:97113",
        isBaseline: true,
        wholeMediaNativeId: "tv:97113",
        wholeMediaLabel: "整部",
      },
    ],
  },
  {
    id: "three-body-netflix",
    tmdbId: 108545,
    type: "tv",
    category: "tv",
    title: "三体",
    originalTitle: "3 Body Problem",
    yearRange: "2024–",
    year: 2024,
    region: "美国",
    statusLabel: "连载中",
    genres: ["科幻", "悬疑", "剧情"],
    synopsis:
      "1960 年代中国的一项关键决定跨越时空在现代引起回响，一群关系紧密的科学家携手应对人类史上最大的威胁。",
    credits: [{ role: "主创", name: "大卫·贝尼奥夫 / D·B·威斯" }],
    posterUrl: TMDB_POSTER("v96LmQ0mJ5l8IW7EhOZ1AKKSm6D.jpg"),
    backdropUrl: TMDB_BACKDROP("ciizJ9Okzt9tBBGK7Q3T14LFT2j.jpg"),
    baseline: "tmdb",
    seasons: [{ season: 1, episodeCount: 8, airYear: 2024 }],
    totalEpisodes: 8,
    defaultSeason: 1,
    shelves: [],
    externalIds: { tmdb: ["tv:108545"], imdb: ["tt13016388"] },
    platformRows: [],
    catalogRows: [
      {
        id: "tbn-tmdb",
        namespace: "tmdb",
        roleLabel: "基准 · tv:108545",
        isBaseline: true,
        wholeMediaNativeId: "tv:108545",
        wholeMediaLabel: "整部",
      },
    ],
  },
  {
    id: "my-three-body",
    tmdbId: 100363,
    type: "tv",
    category: "anime",
    title: "我的三体",
    originalTitle: "我的三体 · The Three-Body Problem in Minecraft",
    yearRange: "2014–2024",
    year: 2014,
    region: "中国大陆",
    statusLabel: "已完结",
    genres: ["动画", "科幻"],
    synopsis: "以方块风格倾力还原刘慈欣科幻巨著《三体》三部曲的同人及官方动画系列。",
    credits: [{ role: "导演", name: "李圳宜" }],
    posterUrl: TMDB_POSTER("wZUio8U3OwiNOAE33naAFmeHRUQ.jpg"),
    backdropUrl: TMDB_BACKDROP("4WroLty7DMWH0oykKKvBmsuSQ7F.jpg"),
    baseline: "tmdb",
    seasons: [
      { season: 1, episodeCount: 11, airYear: 2014 },
      { season: 2, episodeCount: 11, airYear: 2018 },
      { season: 3, episodeCount: 9, airYear: 2020 },
      { season: 4, episodeCount: 9, airYear: 2024 },
    ],
    totalEpisodes: 40,
    defaultSeason: 3,
    shelves: [],
    externalIds: { tmdb: ["tv:100363"], bilibili: ["ss28747"] },
    platformRows: [
      {
        id: "mtb-bili",
        namespace: "bilibili",
        label: "国语原声",
        isDefault: true,
        segmentsBySeason: {
          3: [
            {
              id: "mtb-bili-3",
              title: "章北海传 全 9 集",
              nativeId: "ss28747",
              start: 1,
              end: 9,
              status: "confirmed",
            },
          ],
        },
      },
    ],
    catalogRows: [
      {
        id: "mtb-tmdb",
        namespace: "tmdb",
        roleLabel: "基准 · tv:100363",
        isBaseline: true,
        wholeMediaNativeId: "tv:100363",
        wholeMediaLabel: "整部",
      },
    ],
  },
];

export interface DiscoveryCatalogConfig {
  slug: CatalogNamespace;
  title: string;
  shelfTitle: string;
  shelfSubtitle: string;
  pageSubtitle: string;
  sortLabel: string;
  totalRecorded: number;
  counts: { all: number; tv: number; movie: number; anime: number };
}

export const DISCOVERY_CATALOGS: Record<
  "tmdb" | "douban" | "bangumi" | "trakt",
  DiscoveryCatalogConfig
> = {
  tmdb: {
    slug: "tmdb",
    title: "TMDB",
    shelfTitle: "TMDB 热门",
    shelfSubtitle: "TMDB 本周最多人看的电影和剧",
    pageSubtitle: "本站记录了 12,480 部媒体在 TMDB 上的条目，按本周热度排序",
    sortLabel: "按 TMDB 热度",
    totalRecorded: 12480,
    counts: { all: 12480, tv: 6420, movie: 4310, anime: 1750 },
  },
  douban: {
    slug: "douban",
    title: "豆瓣",
    shelfTitle: "豆瓣 热门",
    shelfSubtitle: "豆瓣上最近讨论最多的华语剧",
    pageSubtitle: "本站记录了 4,812 部媒体在豆瓣上的条目，按豆瓣热度排序",
    sortLabel: "按豆瓣热度",
    totalRecorded: 4812,
    counts: { all: 4812, tv: 2906, movie: 1377, anime: 529 },
  },
  bangumi: {
    slug: "bangumi",
    title: "Bangumi",
    shelfTitle: "Bangumi 热门",
    shelfSubtitle: "Bangumi 上最多人在追的动画",
    pageSubtitle: "本站记录了 3,190 部媒体在 Bangumi 上的条目，按追番热度排序",
    sortLabel: "按 Bangumi 热度",
    totalRecorded: 3190,
    counts: { all: 3190, tv: 120, movie: 410, anime: 2660 },
  },
  trakt: {
    slug: "trakt",
    title: "Trakt",
    shelfTitle: "Trakt 近期热播",
    shelfSubtitle: "Trakt 上最近很多人在追的海外剧",
    pageSubtitle: "本站记录了 6,940 部媒体在 Trakt 上的条目，按近期观看热度排序",
    sortLabel: "按 Trakt 热度",
    totalRecorded: 6940,
    counts: { all: 6940, tv: 4210, movie: 2150, anime: 580 },
  },
};

export const HOME_SHELF_MEDIA_IDS: Record<"tmdb" | "douban" | "bangumi" | "trakt", string[]> = {
  tmdb: ["three-body", "wandering-earth-2", "blossoms-shanghai", "aot", "shogun", "frieren"],
  douban: ["long-season", "knockout", "blossoms-shanghai", "bad-kids", "joy-of-life", "three-body"],
  bangumi: ["dandadan", "dungeon-meshi", "apothecary", "oshi-no-ko", "bocchi", "frieren"],
  trakt: ["shogun", "penguin", "fallout", "severance", "the-bear", "last-of-us"],
};

export const DOUBAN_CATALOG_MEDIA_IDS: string[] = [
  "three-body",
  "blossoms-shanghai",
  "long-season",
  "knockout",
  "bad-kids",
  "joy-of-life",
  "wandering-earth-2",
  "aot",
  "frieren",
  "bocchi",
  "spy-family",
  "oshi-no-ko",
];

export const HOME_URGENT_DEMANDS: DemandItem[] = [
  {
    id: "urg-1",
    rank: 1,
    mediaId: "dandadan",
    lookingFor: "哔哩哔哩、爱奇艺上的第 1 季",
    existingPlatforms: [],
    queryCount30d: 4120,
    queryCount7d: 1284,
  },
  {
    id: "urg-2",
    rank: 2,
    mediaId: "shogun",
    lookingFor: "各平台的第 1 季",
    existingPlatforms: [],
    queryCount30d: 3180,
    queryCount7d: 962,
  },
  {
    id: "urg-3",
    rank: 3,
    mediaId: "dungeon-meshi",
    lookingFor: "哔哩哔哩上的第 1 季",
    existingPlatforms: [],
    queryCount30d: 2450,
    queryCount7d: 731,
  },
  {
    id: "urg-4",
    rank: 4,
    mediaId: "apothecary",
    lookingFor: "爱奇艺、腾讯视频上的第 2 季",
    existingPlatforms: ["bilibili"],
    queryCount30d: 1890,
    queryCount7d: 508,
  },
];

export const CONTRIBUTE_DEMANDS: DemandItem[] = [
  {
    id: "dem-1",
    rank: 1,
    mediaId: "frieren",
    lookingFor: "腾讯视频、爱奇艺上的第 1 季",
    existingPlatforms: ["bilibili"],
    queryCount30d: 412,
  },
  {
    id: "dem-2",
    rank: 2,
    mediaId: "dandadan",
    lookingFor: "哔哩哔哩上的第 2 季",
    existingPlatforms: ["bilibili"],
    queryCount30d: 356,
  },
  {
    id: "dem-3",
    rank: 3,
    mediaId: "apothecary",
    lookingFor: "爱奇艺上的第 2 季",
    existingPlatforms: ["bilibili", "tencent"],
    queryCount30d: 298,
  },
  {
    id: "dem-4",
    rank: 4,
    mediaId: "blossoms-shanghai",
    lookingFor: "腾讯视频上的沪语版",
    existingPlatforms: ["tencent"],
    queryCount30d: 265,
  },
  {
    id: "dem-5",
    rank: 5,
    mediaId: "oshi-no-ko",
    lookingFor: "哔哩哔哩上的第 2 季",
    existingPlatforms: ["bilibili"],
    queryCount30d: 231,
  },
  {
    id: "dem-6",
    rank: 6,
    mediaId: "long-season",
    lookingFor: "腾讯视频上的第 7–12 集",
    existingPlatforms: ["tencent"],
    queryCount30d: 187,
  },
  {
    id: "dem-7",
    rank: 7,
    mediaId: "spy-family",
    lookingFor: "哔哩哔哩上的中文配音",
    existingPlatforms: ["bilibili", "iqiyi"],
    queryCount30d: 154,
  },
  {
    id: "dem-8",
    rank: 8,
    mediaId: "chang-an",
    lookingFor: "优酷和芒果 TV",
    existingPlatforms: ["tencent", "iqiyi"],
    queryCount30d: 98,
  },
  {
    id: "dem-9",
    rank: 9,
    mediaId: "shogun",
    lookingFor: "任意平台的第 1 季",
    existingPlatforms: [],
    queryCount30d: 84,
  },
  {
    id: "dem-10",
    rank: 10,
    mediaId: "wandering-earth-2",
    lookingFor: "哔哩哔哩与芒果 TV 正片",
    existingPlatforms: ["tencent", "iqiyi", "youku"],
    queryCount30d: 71,
  },
];

export const INITIAL_CHANGE_REQUESTS: ChangeRequestItem[] = [
  {
    id: "CR-226",
    mediaId: "aot",
    title: "进击的巨人 第 4 季 第 17–28 集",
    namespace: "tencent",
    nativeId: "mzc002009x8ab2",
    pageUrl: "https://v.qq.com/x/cover/mzc002009x8ab2.html",
    pageTitle: "进击的巨人 最终季 Part.2",
    pageEpisodeCount: 12,
    variantLabel: "日语原声（默认）",
    season: 4,
    episodeStart: 17,
    episodeEnd: 28,
    targetEpisodeStart: 1,
    totalSeasonEpisodes: 30,
    status: "approved",
    submitterName: "linxiao",
    submittedAt: "2026 年 11 月 23 日 21:40",
    relativeTime: "昨天",
    existingSegments: [
      {
        id: "cr226-ex",
        title: "最终季",
        nativeId: "mzc002009x8ab1",
        start: 1,
        end: 16,
        status: "confirmed",
      },
    ],
    proposedSegment: {
      id: "cr226-new",
      title: "本次提交 · 17–28",
      nativeId: "mzc002009x8ab2",
      start: 17,
      end: 28,
      status: "confirmed",
    },
    effectSummary: "已生效：腾讯视频日语原声的第 4 季现在有第 1–28 集",
    checks: [
      {
        id: "chk-1",
        title: "平台页面标题与媒体匹配",
        detail:
          "页面标题是「进击的巨人 最终季 Part.2」。片名对得上，但「最终季 Part.2」和第 4 季叫法不同，转给审核员确认",
        status: "needs_confirm",
      },
      {
        id: "chk-2",
        title: "集数一致",
        detail: "页面上共 12 集，和你填的第 17–28 集正好对上",
        status: "passed",
      },
      {
        id: "chk-3",
        title: "不与已有记录重叠",
        detail: "腾讯视频日语原声已有第 4 季第 1–16 集，和这次提交没有重叠",
        status: "passed",
      },
    ],
    reviewer: {
      name: "linhai",
      initial: "林",
      time: "审核员 · 11 月 24 日 10:12",
      comment:
        "核对过了。腾讯视频的「最终季 Part.2」就是第 4 季的后半部分，第 17–28 集，和 TMDB 一致，通过。",
    },
    timeline: [
      { label: "已提交", time: "11 月 23 日 21:40", detail: "你提交了这张变更单", state: "done" },
      {
        label: "自动核对",
        time: "11 月 23 日 21:41",
        detail: "核对了 3 项，其中 1 项需要人工确认",
        state: "done",
      },
      { label: "待审核", time: "11 月 23 日 21:41", detail: "已转给审核员", state: "done" },
      {
        label: "已通过",
        time: "11 月 24 日 10:12",
        detail: "审核员 linhai 通过，已经生效",
        state: "done",
      },
    ],
  },
  {
    id: "CR-231",
    mediaId: "aot",
    title: "进击的巨人 · 第 4 季",
    namespace: "tencent",
    nativeId: "mzc002009x8ab2",
    pageUrl: "https://v.qq.com/x/cover/mzc002009x8ab2.html",
    pageTitle: "进击的巨人 最终季 Part.2",
    pageEpisodeCount: 13,
    variantLabel: "日语原声",
    season: 4,
    episodeStart: 17,
    episodeEnd: 28,
    targetEpisodeStart: 1,
    totalSeasonEpisodes: 30,
    status: "needs_review",
    conflictTag: "自动核对有冲突",
    submitterName: "林晓",
    submittedAt: "2026 年 11 月 25 日 01:30",
    relativeTime: "12 分钟前",
    existingSegments: [
      {
        id: "cr231-ex",
        title: "最终季",
        nativeId: "mzc002009x8ab1",
        start: 1,
        end: 16,
        status: "confirmed",
      },
    ],
    proposedSegment: {
      id: "cr231-new",
      title: "最终季 Part.2 · 本次提交",
      nativeId: "mzc002009x8ab2",
      start: 17,
      end: 28,
      status: "pending",
    },
    effectSummary: "通过后，腾讯视频日语原声的第 4 季会补齐到第 28 集",
    checks: [
      {
        id: "rchk-1",
        title: "片名对得上",
        detail: "页面标题是「进击的巨人 最终季 Part.2」，和这部媒体一致",
        status: "passed",
      },
      {
        id: "rchk-2",
        title: "年份对得上",
        detail: "页面写的是 2022 年，和第 4 季下半部分的播出年份一致",
        status: "passed",
      },
      {
        id: "rchk-3",
        title: "和已有记录不重叠",
        detail: "腾讯视频日语原声现在只有第 1–16 集，这次补的是第 17–28 集",
        status: "passed",
      },
      {
        id: "rchk-4",
        title: "集数对不上",
        detail: "页面上有 13 个视频，提交的是 12 集",
        status: "failed",
      },
      {
        id: "rchk-5",
        title: "多出来的 1 个视频可能是预告",
        detail: "第 13 个视频只有 1 分 30 秒，标题里有「预告」，规则判断不了，需要人确认",
        status: "needs_confirm",
      },
    ],
    timeline: [
      { label: "已提交", time: "12 分钟前", detail: "林晓提交了这张变更单", state: "done" },
      {
        label: "自动核对",
        time: "11 分钟前",
        detail: "3 项通过，1 项没通过，1 项需要人工确认",
        state: "done",
      },
      { label: "待审核", time: "11 分钟前", detail: "等待审核员处理", state: "current" },
    ],
  },
  {
    id: "CR-230",
    mediaId: "frieren",
    title: "葬送的芙莉莲 · 第 1 季",
    namespace: "bilibili",
    nativeId: "ss45949",
    pageUrl: "https://www.bilibili.com/bangumi/play/ss45949",
    pageTitle: "葬送的芙莉莲（中配版）",
    pageEpisodeCount: 28,
    variantLabel: "日语原声",
    season: 1,
    episodeStart: 1,
    episodeEnd: 28,
    targetEpisodeStart: 1,
    totalSeasonEpisodes: 28,
    status: "needs_review",
    conflictTag: "和已有记录重叠",
    submitterName: "miyuki",
    submittedAt: "2026 年 11 月 25 日 00:40",
    relativeTime: "1 小时前",
    existingSegments: [
      {
        id: "cr230-ex",
        title: "葬送的芙莉莲 全 28 集",
        nativeId: "ss45948",
        start: 1,
        end: 28,
        status: "confirmed",
      },
    ],
    proposedSegment: {
      id: "cr230-new",
      title: "本次提交 · 1–28",
      nativeId: "ss45949",
      start: 1,
      end: 28,
      status: "pending",
    },
    effectSummary: "与已有日语原声记录第 1–28 集完全重叠，可能需要改放到「中文配音」版本",
    checks: [
      {
        id: "c230-1",
        title: "片名对得上",
        detail: "页面标题包含「葬送的芙莉莲」，和这部媒体一致",
        status: "passed",
      },
      {
        id: "c230-2",
        title: "集数一致",
        detail: "页面共 28 集，与第 1 季总集数一致",
        status: "passed",
      },
      {
        id: "c230-3",
        title: "和已有记录重叠",
        detail: "日语原声下已有 ss45948 覆盖第 1–28 集；页面标题带「中配版」，疑似选错了版本",
        status: "failed",
      },
    ],
    timeline: [
      { label: "已提交", time: "1 小时前", detail: "miyuki 提交了这张变更单", state: "done" },
      { label: "自动核对", time: "1 小时前", detail: "检测到与已有记录重叠", state: "done" },
      { label: "待审核", time: "1 小时前", detail: "等待审核员处理", state: "current" },
    ],
  },
  {
    id: "CR-229",
    mediaId: "three-body",
    title: "三体 · 第 1 季",
    namespace: "tencent",
    nativeId: "mzc002007knmh99",
    pageUrl: "https://v.qq.com/x/cover/mzc002007knmh99.html",
    pageTitle: "三体 周年纪念版",
    pageEpisodeCount: 26,
    variantLabel: "周年纪念版",
    season: 1,
    episodeStart: 1,
    episodeEnd: 30,
    targetEpisodeStart: 1,
    totalSeasonEpisodes: 30,
    status: "needs_review",
    conflictTag: "集数对不上",
    submitterName: "周舟",
    submittedAt: "2026 年 11 月 24 日 22:15",
    relativeTime: "3 小时前",
    existingSegments: [],
    proposedSegment: {
      id: "cr229-new",
      title: "周年纪念版 · 1–30",
      nativeId: "mzc002007knmh99",
      start: 1,
      end: 30,
      status: "pending",
    },
    effectSummary: "通过后，将为《三体》新增「周年纪念版」版本记录",
    checks: [
      {
        id: "c229-1",
        title: "片名对得上",
        detail: "页面标题是「三体 周年纪念版」，和这部媒体一致",
        status: "passed",
      },
      {
        id: "c229-2",
        title: "集数对不上",
        detail: "页面上只有 26 集精剪版，但提交的范围是第 1–30 集",
        status: "failed",
      },
    ],
    timeline: [
      { label: "已提交", time: "3 小时前", detail: "周舟提交了这张变更单", state: "done" },
      { label: "自动核对", time: "3 小时前", detail: "检测到集数不一致", state: "done" },
      { label: "待审核", time: "3 小时前", detail: "等待审核员处理", state: "current" },
    ],
  },
  {
    id: "CR-228",
    mediaId: "long-season",
    title: "漫长的季节 · 整部",
    namespace: "douban",
    nativeId: "35588177",
    pageUrl: "https://movie.douban.com/subject/35588177/",
    pageTitle: "漫长的季节",
    pageEpisodeCount: 12,
    variantLabel: null,
    season: 1,
    episodeStart: 1,
    episodeEnd: 12,
    targetEpisodeStart: 1,
    totalSeasonEpisodes: 12,
    status: "needs_review",
    conflictTag: "年份对不上",
    submitterName: "阿哲",
    submittedAt: "2026 年 11 月 24 日 14:20",
    relativeTime: "昨天",
    existingSegments: [],
    proposedSegment: {
      id: "cr228-new",
      title: "豆瓣 · 35588177",
      nativeId: "35588177",
      start: 1,
      end: 12,
      status: "pending",
    },
    effectSummary: "通过后，豆瓣条目 35588177 将关联至《漫长的季节》",
    checks: [
      {
        id: "c228-1",
        title: "片名对得上",
        detail: "豆瓣条目标题为「漫长的季节」",
        status: "passed",
      },
      {
        id: "c228-2",
        title: "年份存在差异",
        detail: "豆瓣页面标注首播日期与基准差 1 天，需要人工确认",
        status: "needs_confirm",
      },
    ],
    timeline: [
      { label: "已提交", time: "昨天", detail: "阿哲提交了这张变更单", state: "done" },
      { label: "待审核", time: "昨天", detail: "等待审核员处理", state: "current" },
    ],
  },
  {
    id: "CR-218",
    mediaId: "aot",
    title: "进击的巨人 第 4 季 第 29–30 集",
    namespace: "bilibili",
    nativeId: "ss41020",
    pageUrl: "https://www.bilibili.com/bangumi/play/ss41020",
    pageTitle: "进击的巨人 最终季 完结篇",
    pageEpisodeCount: 2,
    variantLabel: "日语原声（默认）",
    season: 4,
    episodeStart: 29,
    episodeEnd: 30,
    targetEpisodeStart: 1,
    totalSeasonEpisodes: 30,
    status: "needs_review",
    conflictTag: "特别篇拆集",
    submitterName: "linxiao",
    submittedAt: "2026 年 11 月 24 日 19:05",
    relativeTime: "6 小时前",
    existingSegments: [
      {
        id: "cr218-ex1",
        title: "最终季",
        nativeId: "ss38221",
        start: 1,
        end: 16,
        status: "confirmed",
      },
      {
        id: "cr218-ex2",
        title: "Part.2",
        nativeId: "ss39444",
        start: 17,
        end: 28,
        status: "confirmed",
      },
    ],
    proposedSegment: {
      id: "cr218-new",
      title: "完结篇 · 29–30",
      nativeId: "ss41020",
      start: 29,
      end: 30,
      status: "pending",
    },
    effectSummary: "通过后，哔哩哔哩日语原声的第 4 季将完整覆盖第 1–30 集",
    checks: [
      {
        id: "c218-1",
        title: "片名对得上",
        detail: "页面标题「进击的巨人 最终季 完结篇」匹配媒体",
        status: "passed",
      },
      {
        id: "c218-2",
        title: "不与已有记录重叠",
        detail: "接续已有第 1–28 集，无重叠",
        status: "passed",
      },
      {
        id: "c218-3",
        title: "单集时长较长",
        detail: "页面包含 2 集超长特别篇，需确认是否对应 TMDB 第 29–30 集",
        status: "needs_confirm",
      },
    ],
    timeline: [
      { label: "已提交", time: "11 月 24 日 19:05", detail: "你提交了这张变更单", state: "done" },
      {
        label: "自动核对",
        time: "11 月 24 日 19:06",
        detail: "2 项通过，1 项需要人工确认",
        state: "done",
      },
      { label: "待审核", time: "11 月 24 日 19:06", detail: "已转给审核员", state: "current" },
    ],
  },
];

export const INITIAL_REVIEW_ALERTS: ReviewAlertItem[] = [
  {
    id: "alert-1",
    namespace: "mgtv",
    badge: "页面打不开",
    severity: "destructive",
    title: "《去有风的地方》在芒果 TV 的播放页打不开了",
    description:
      "最近 24 小时有 3 位用户反馈打不开，系统复查后确认页面已经下线。下架后，这部剧在芒果 TV 会显示为未收录。",
    relativeTime: "2 小时前",
    actionLabel: "下架这条记录",
    mediaId: "blossoms-shanghai",
  },
  {
    id: "alert-2",
    namespace: "bilibili",
    badge: "记录重叠",
    severity: "warning",
    title: "《葬送的芙莉莲》在哔哩哔哩有两条记录包含同样的集",
    description:
      "日语原声下，「葬送的芙莉莲」和「葬送的芙莉莲 第二部分」都包含第 15–28 集，查询时不知道该用哪一条。",
    relativeTime: "5 小时前",
    actionLabel: "查看两条记录",
    mediaId: "frieren",
  },
  {
    id: "alert-3",
    namespace: "tencent",
    badge: "集数变了",
    severity: "warning",
    title: "《三体》在腾讯视频的页面多了 1 个视频",
    description:
      "页面上原来是 30 集，现在是 31 个视频，可能加了花絮。现有记录对应第 1–30 集，也许需要调整。",
    relativeTime: "昨天",
    actionLabel: "去核对",
    mediaId: "three-body",
  },
  {
    id: "alert-4",
    namespace: "tvdb",
    badge: "分季不同",
    severity: "warning",
    title: "《进击的巨人》在 TVDB 的分季和 TMDB 不一样",
    description:
      "TVDB 把第 4 季拆成了两季，TMDB 是一季 30 集。TVDB 上第 4 季第 17–30 集的对应需要人确认。",
    relativeTime: "3 天前",
    actionLabel: "去核对",
    mediaId: "aot",
  },
];

export const INITIAL_API_KEYS: ApiKeyItem[] = [
  {
    id: "key-1",
    name: "播放器本地客户端",
    prefix: "mr_live_a8f2••••",
    canRead: true,
    canSubmit: false,
    createdAt: "2026-11-24",
    lastUsed: "尚未使用",
    expiresInDays: 90,
  },
  {
    id: "key-2",
    name: "个人整理脚本",
    prefix: "mr_live_c901••••",
    canRead: true,
    canSubmit: true,
    createdAt: "2026-11-18",
    lastUsed: "3 小时前",
    expiresInDays: 90,
  },
  {
    id: "key-3",
    name: "Kodi 媒体插件",
    prefix: "mr_live_8a3f••••",
    canRead: true,
    canSubmit: false,
    createdAt: "2026-11-10",
    lastUsed: "昨天",
    expiresInDays: 365,
  },
  {
    id: "key-4",
    name: "家里的 Jellyfin",
    prefix: "mr_live_4d1e••••",
    canRead: true,
    canSubmit: false,
    createdAt: "2026-10-02",
    lastUsed: "12 分钟前",
    expiresInDays: null,
  },
];

export const API_USAGE_TREND: ApiTrendDay[] = [
  { date: "11-11", found: 940, notFound: 140, submitted: 18 },
  { date: "11-12", found: 1020, notFound: 160, submitted: 16 },
  { date: "11-13", found: 880, notFound: 110, submitted: 12 },
  { date: "11-14", found: 1180, notFound: 170, submitted: 22 },
  { date: "11-15", found: 1290, notFound: 190, submitted: 26 },
  { date: "11-16", found: 1440, notFound: 210, submitted: 31 },
  { date: "11-17", found: 1150, notFound: 150, submitted: 19 },
  { date: "11-18", found: 1220, notFound: 160, submitted: 21 },
  { date: "11-19", found: 1060, notFound: 130, submitted: 15 },
  { date: "11-20", found: 1280, notFound: 160, submitted: 20 },
  { date: "11-21", found: 1390, notFound: 180, submitted: 24 },
  { date: "11-22", found: 1510, notFound: 190, submitted: 22 },
  { date: "11-23", found: 1240, notFound: 100, submitted: 13 },
  { date: "11-24", found: 1320, notFound: 100, submitted: 13 },
];

const AUTH_COLLAGE_MEDIA_IDS = [
  "blossoms-shanghai",
  "three-body",
  "joy-of-life",
  "fallout",
  "the-bear",
  "oshi-no-ko",
  "bocchi",
  "shogun",
  "aot",
  "apothecary",
  "frieren",
  "dandadan",
  "penguin",
  "long-season",
  "dungeon-meshi",
  "wandering-earth-2",
] as const;

export const AUTH_COLLAGE_POSTERS: string[] = AUTH_COLLAGE_MEDIA_IDS.map(
  (id) => INITIAL_MEDIA_CATALOG.find((item) => item.id === id)?.posterUrl,
).filter((url): url is string => Boolean(url));
