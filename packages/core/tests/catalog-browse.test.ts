import { describe, expect, test } from "vite-plus/test";
import {
  createDefaultAdapterRegistry,
  createFakeOutboundClient,
  getCatalogDetail,
  listTrending,
  resolveLookupKeys,
  searchCatalogTitles,
  type BrowseCache,
  type ExternalHttpRequest,
  type ExternalHttpResponse,
} from "../src/index.ts";

function json(url: string, body: unknown, status = 200): ExternalHttpResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    url,
    body: JSON.stringify(body),
  };
}

function memoryCache(): BrowseCache & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    get: async (key) => store.get(key) ?? null,
    put: async (key, value) => {
      store.set(key, value);
    },
  };
}

describe("listTrending", () => {
  test("TMDB trending maps posters, keys and the animation flag", async () => {
    const outbound = createFakeOutboundClient({
      fetchExternal: (req: ExternalHttpRequest) => {
        expect(req.url).toContain("/trending/tv/week");
        expect(req.url).toContain("language=zh-CN");
        return json(req.url, {
          results: [
            {
              id: 1429,
              name: "进击的巨人",
              original_name: "進撃の巨人",
              first_air_date: "2013-04-07",
              poster_path: "/p.jpg",
              genre_ids: [16, 10759],
            },
            {
              id: 95396,
              name: "人生切割术",
              original_name: "Severance",
              first_air_date: "2022-02-17",
              poster_path: null,
              genre_ids: [18],
            },
          ],
        });
      },
    });
    const cards = await listTrending("tmdb", "tv", 10, { outbound });
    expect(cards).toEqual([
      {
        key: "tmdb:tv:1429",
        namespace: "tmdb",
        type: "tv",
        isAnime: true,
        title: "进击的巨人",
        originalTitle: "進撃の巨人",
        year: 2013,
        posterUrl: "https://image.tmdb.org/t/p/w500/p.jpg",
      },
      {
        key: "tmdb:tv:95396",
        namespace: "tmdb",
        type: "tv",
        isAnime: false,
        title: "人生切割术",
        originalTitle: "Severance",
        year: 2022,
        posterUrl: null,
      },
    ]);
  });

  test("Douban 'all' interleaves the TV and movie hot collections and sends a referer", async () => {
    const outbound = createFakeOutboundClient({
      fetchExternal: (req: ExternalHttpRequest) => {
        expect(req.headers?.referer).toMatch(/^https:\/\/m\.douban\.com\//);
        const isTv = req.url.includes("/tv_hot/");
        return json(req.url, {
          subject_collection_items: [
            {
              id: isTv ? "35235320" : "36847425",
              title: isTv ? "两京十五日" : "可能的爱",
              type: isTv ? "tv" : "movie",
              year: "2026",
              cover: { url: "http://img3.doubanio.com/p.jpg" },
            },
          ],
        });
      },
    });
    const cards = await listTrending("douban", "all", 10, { outbound });
    expect(cards.map((c) => [c.key, c.type, c.posterUrl])).toEqual([
      ["douban:35235320", "tv", "https://img3.doubanio.com/p.jpg"],
      ["douban:36847425", "movie", "https://img3.doubanio.com/p.jpg"],
    ]);
  });

  test("Bangumi calendar is sorted by people watching; movies are not offered", async () => {
    const outbound = createFakeOutboundClient({
      fetchExternal: (req: ExternalHttpRequest) =>
        json(req.url, [
          {
            weekday: { id: 1 },
            items: [
              {
                id: 1,
                name: "A",
                name_cn: "甲",
                air_date: "2026-10-01",
                images: { large: "http://lain.bgm.tv/a.jpg" },
                collection: { doing: 5 },
              },
            ],
          },
          {
            weekday: { id: 2 },
            items: [
              { id: 2, name: "B", name_cn: "", air_date: "2026-10-02", collection: { doing: 50 } },
            ],
          },
        ]),
    });
    const cards = await listTrending("bangumi", "anime", 10, { outbound });
    expect(cards.map((c) => [c.key, c.title, c.posterUrl])).toEqual([
      ["bangumi:2", "B", null],
      ["bangumi:1", "甲", "https://lain.bgm.tv/a.jpg"],
    ]);
    expect(await listTrending("bangumi", "movie", 10, { outbound })).toEqual([]);
  });

  test("Trakt trending is enriched with TMDB artwork and keyed by slug", async () => {
    const outbound = createFakeOutboundClient({
      fetchExternal: (req: ExternalHttpRequest) => {
        if (req.namespace === "trakt") {
          expect(req.headers?.["user-agent"]).toBe("media-ref");
          return json(req.url, [
            {
              watchers: 9,
              show: { title: "Shogun", year: 2024, ids: { slug: "shogun-2024", tmdb: 126308 } },
            },
          ]);
        }
        expect(req.url).toContain("/tv/126308");
        return json(req.url, {
          id: 126308,
          name: "幕府将军",
          poster_path: "/s.jpg",
          genres: [{ id: 18, name: "剧情" }],
        });
      },
    });
    const cards = await listTrending("trakt", "tv", 10, {
      outbound,
      config: { traktClientId: "cid" },
    });
    expect(cards).toEqual([
      {
        key: "trakt:show:shogun-2024",
        namespace: "trakt",
        type: "tv",
        isAnime: false,
        title: "幕府将军",
        originalTitle: "Shogun",
        year: 2024,
        posterUrl: "https://image.tmdb.org/t/p/w500/s.jpg",
      },
    ]);
  });

  test("an upstream failure yields an empty shelf and is not cached", async () => {
    const cache = memoryCache();
    const outbound = createFakeOutboundClient({
      fetchExternal: (req: ExternalHttpRequest) => json(req.url, {}, 503),
    });
    expect(await listTrending("tmdb", "all", 10, { outbound, cache })).toEqual([]);
    expect(cache.store.size).toBe(0);
  });

  test("results are served from the cache on the second call", async () => {
    const cache = memoryCache();
    let calls = 0;
    const outbound = createFakeOutboundClient({
      fetchExternal: (req: ExternalHttpRequest) => {
        calls += 1;
        return json(req.url, { results: [{ id: 1, media_type: "movie", title: "X" }] });
      },
    });
    await listTrending("tmdb", "all", 10, { outbound, cache });
    await listTrending("tmdb", "all", 10, { outbound, cache });
    expect(calls).toBe(1);
  });
});

describe("getCatalogDetail", () => {
  test("TMDB TV detail carries artwork, regions, credits, status and real seasons", async () => {
    const outbound = createFakeOutboundClient({
      fetchExternal: (req: ExternalHttpRequest) => {
        expect(req.url).toContain("/tv/1429");
        expect(req.url).toContain("append_to_response=credits");
        return json(req.url, {
          id: 1429,
          name: "进击的巨人",
          original_name: "進撃の巨人",
          first_air_date: "2013-04-07",
          last_air_date: "2023-11-05",
          status: "Ended",
          overview: "人类居住在高墙包围的城市中。",
          poster_path: "/p.jpg",
          backdrop_path: "/b.jpg",
          genres: [{ id: 16, name: "动画" }],
          origin_country: ["JP"],
          created_by: [{ name: "谏山创" }],
          production_companies: [{ name: "WIT STUDIO" }, { name: "MAPPA" }],
          seasons: [
            { season_number: 0, episode_count: 3 },
            { season_number: 1, episode_count: 25 },
          ],
        });
      },
    });
    const detail = await getCatalogDetail("tmdb:tv:1429", { outbound });
    expect(detail).toMatchObject({
      key: "tmdb:tv:1429",
      isAnime: true,
      backdropUrl: "https://image.tmdb.org/t/p/w1280/b.jpg",
      regions: ["日本"],
      credits: [
        { role: "主创", name: "谏山创" },
        { role: "动画制作", name: "WIT STUDIO / MAPPA" },
      ],
      status: "ended",
      year: 2013,
      yearEnd: 2023,
      seasons: [{ season: 1, episodeCount: 25 }],
    });
  });

  test("Douban detail maps a TV subject to one season", async () => {
    const outbound = createFakeOutboundClient({
      fetchExternal: (req: ExternalHttpRequest) =>
        json(req.url, {
          title: "两京十五日",
          is_tv: true,
          episodes_count: 26,
          year: "2026",
          intro: "简介",
          pic: { large: "https://img.doubanio.com/l.jpg" },
          genres: ["剧情", "古装"],
          countries: ["中国大陆"],
          directors: [{ name: "张黎" }],
          actors: [{ name: "成毅" }, { name: "林更新" }, { name: "第三位" }],
        }),
    });
    const detail = await getCatalogDetail("douban:35235320", { outbound });
    expect(detail).toMatchObject({
      type: "tv",
      regions: ["中国大陆"],
      credits: [
        { role: "导演", name: "张黎" },
        { role: "主演", name: "成毅 / 林更新" },
      ],
      seasons: [{ season: 1, episodeCount: 26 }],
    });
  });

  test("unknown keys return null without any request", async () => {
    const outbound = createFakeOutboundClient();
    expect(await getCatalogDetail("not-a-key", { outbound })).toBeNull();
  });
});

describe("searchCatalogTitles", () => {
  test("keeps only movie and TV results from TMDB multi search", async () => {
    const outbound = createFakeOutboundClient({
      fetchExternal: (req: ExternalHttpRequest) =>
        json(req.url, {
          results: [
            { id: 1, media_type: "tv", name: "三体" },
            { id: 2, media_type: "person", name: "刘慈欣" },
            { id: 3, media_type: "movie", title: "流浪地球" },
          ],
        }),
    });
    const cards = await searchCatalogTitles("三体", { outbound });
    expect(cards.map((c) => c.key)).toEqual(["tmdb:tv:1", "tmdb:movie:3"]);
    expect(await searchCatalogTitles("   ", { outbound })).toEqual([]);
  });
});

describe("resolveLookupKeys", () => {
  const registry = createDefaultAdapterRegistry();

  test("recognises catalog and platform URLs and explicit keys", () => {
    expect(
      resolveLookupKeys("https://www.themoviedb.org/tv/1429-shingeki-no-kyojin", registry),
    ).toEqual(["tmdb:tv:1429"]);
    expect(resolveLookupKeys("https://www.imdb.com/title/tt2560140/", registry)).toEqual([
      "imdb:tt2560140",
    ]);
    expect(resolveLookupKeys("https://trakt.tv/shows/attack-on-titan", registry)).toEqual([
      "trakt:show:attack-on-titan",
    ]);
    expect(resolveLookupKeys("https://movie.douban.com/subject/35235320/", registry)).toContain(
      "douban:35235320",
    );
    expect(resolveLookupKeys("https://www.bilibili.com/bangumi/play/ss38221", registry)).toContain(
      "bilibili:ss38221",
    );
    expect(resolveLookupKeys("tmdb:tv:1429", registry)).toEqual(["tmdb:tv:1429"]);
  });

  test("plain titles are not treated as ids", () => {
    expect(resolveLookupKeys("进击的巨人", registry)).toEqual([]);
    expect(resolveLookupKeys("12345", registry)).toEqual([]);
  });
});
