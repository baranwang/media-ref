/** Static labels for the four browse sites (home shelves and `/discover/$catalog`). */
export type BrowseSlug = "tmdb" | "douban" | "bangumi" | "trakt";

export interface DiscoveryCatalogConfig {
  slug: BrowseSlug;
  title: string;
  shelfTitle: string;
  shelfSubtitle: string;
  pageSubtitle: string;
  sortLabel: string;
}

export const BROWSE_SLUGS: readonly BrowseSlug[] = ["tmdb", "douban", "bangumi", "trakt"];

export function isBrowseSlug(value: string): value is BrowseSlug {
  return (BROWSE_SLUGS as readonly string[]).includes(value);
}

export const DISCOVERY_CATALOGS: Record<BrowseSlug, DiscoveryCatalogConfig> = {
  tmdb: {
    slug: "tmdb",
    title: "TMDB",
    shelfTitle: "TMDB 热门",
    shelfSubtitle: "TMDB 本周最多人看的电影和剧",
    pageSubtitle: "TMDB 本周最热门的电影和剧，按热度排序",
    sortLabel: "按 TMDB 热度",
  },
  douban: {
    slug: "douban",
    title: "豆瓣",
    shelfTitle: "豆瓣 热门",
    shelfSubtitle: "豆瓣上最近讨论最多的电影和剧",
    pageSubtitle: "豆瓣近期热门的电影、剧集和动画，按豆瓣热度排序",
    sortLabel: "按豆瓣热度",
  },
  bangumi: {
    slug: "bangumi",
    title: "Bangumi",
    shelfTitle: "Bangumi 热门",
    shelfSubtitle: "Bangumi 上最多人在追的当季动画",
    pageSubtitle: "Bangumi 每日放送里的当季动画，按在追人数排序",
    sortLabel: "按在追人数",
  },
  trakt: {
    slug: "trakt",
    title: "Trakt",
    shelfTitle: "Trakt 近期热播",
    shelfSubtitle: "Trakt 上最近很多人在追的海外剧",
    pageSubtitle: "Trakt 上正在被观看的电影和剧，按观看人数排序",
    sortLabel: "按 Trakt 热度",
  },
};

/** Number of platforms MediaRef tracks (bilibili, tencent, iqiyi, youku, mgtv). */
export const PLATFORM_COUNT = 5;
