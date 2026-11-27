import { describe, expect, test } from "vite-plus/test";
import {
  bangumiAdapter,
  createDefaultAdapterRegistry,
  createFakeOutboundClient,
  doubanAdapter,
  InvalidNativeIdError,
  isTier2Adapter,
  isTier3Adapter,
  parseBangumiInput,
  parseCatalogTargetKey,
  parseDoubanInput,
  resolveCatalogTargetSnapshot,
  selectBaseline,
  type ExternalHttpResponse,
} from "../src/index.ts";
import { DOUBAN_API } from "../src/index.ts";

// A test key, and no pacing delays against the fake Douban.
DOUBAN_API.apiKey = "test-douban-key";
DOUBAN_API.minIntervalMs = 0;
DOUBAN_API.retryDelayMs = 0;

function jsonResponse(url: string, payload: unknown, status = 200): ExternalHttpResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
    url,
  };
}

describe("Douban Tier 1 & Tier 2 adapter", () => {
  test("parses and canonicalizes bare subject IDs and Douban movie/mobile/www URLs without network calls", async () => {
    const outbound = createFakeOutboundClient();

    const validInputs = [
      "1292052",
      "  1292052  ",
      "https://movie.douban.com/subject/1292052/",
      "https://movie.douban.com/subject/1292052",
      "http://movie.douban.com/subject/1292052/?from=showing#comments",
      "https://m.douban.com/movie/subject/1292052/",
      "https://m.douban.com/movie/subject/1292052?dt_dapp=1",
      "https://www.douban.com/subject/1292052/",
      "https://douban.com/subject/1292052/",
    ];

    for (const raw of validInputs) {
      expect(parseDoubanInput(raw)).toEqual({
        kind: "subject",
        id: "1292052",
        canonicalId: "1292052",
      });
      expect(await doubanAdapter.canonicalize(raw, outbound)).toBe("1292052");
    }

    expect(outbound.httpRequests).toHaveLength(0);
  });

  test("rejects invalid Douban IDs and URLs with InvalidNativeIdError", async () => {
    const outbound = createFakeOutboundClient();

    const invalidInputs = [
      "",
      "   ",
      "0",
      "-1292052",
      "abc123",
      "ss1292052",
      "https://movie.douban.com/subject/0/",
      "https://movie.douban.com/subject/1292052/comments",
      "https://movie.douban.com/celebrity/1000001/",
      "https://book.douban.com/subject/1292052/",
      "https://evil.example.com/subject/1292052/",
      "https://bgm.tv/subject/294993",
    ];

    for (const raw of invalidInputs) {
      expect(doubanAdapter.parseInput(raw)).toBeNull();
      await expect(doubanAdapter.canonicalize(raw, outbound)).rejects.toBeInstanceOf(
        InvalidNativeIdError,
      );
    }
  });

  test("fetches movie and TV metadata via frodo with the apiKey", async () => {
    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        expect(request.kind).toBe("catalog");
        expect(request.namespace).toBe("douban");
        if (new URL(request.url).pathname === "/api/v2/subject/35465232") {
          expect(new URL(request.url).searchParams.get("apiKey")).toBe("test-douban-key");
          return jsonResponse(request.url, {
            id: "35465232",
            title: "狂飙",
            original_title: "狂飙",
            aka: ["The Knockout"],
            year: "2023",
            pubdate: ["2023-01-14(中国大陆)"],
            type: "tv",
            subtype: "tv",
            is_tv: true,
            episodes_count: 39,
            // "Where to watch": an ad and an unsupported vendor are not listed platforms.
            vendors: [
              { id: "iqiyi", is_ad: false, uri: "iqiyi://mobile/player?aid=5328486914190101" },
              { id: "qq", is_ad: false, uri: "txvideo://v.qq.com/x?cid=mzc00200agq0com" },
              { id: "youku", is_ad: true, uri: "youku://play?showid=1" },
              { id: "migu", is_ad: false, uri: "migu://x" },
            ],
          });
        }
        if (new URL(request.url).pathname === "/api/v2/subject/1292052") {
          expect(request.headers?.referer).toContain("servicewechat.com");
          return jsonResponse(request.url, {
            id: "1292052",
            title: "肖申克的救赎",
            original_title: "The Shawshank Redemption",
            aka: ["月黑高飞(港)", "刺激1995(台)"],
            year: "1994",
            type: "movie",
            is_tv: false,
            episodes_count: 0,
            imdb: "tt0111161",
          });
        }
        throw new Error(`Unexpected Douban URL: ${request.url}`);
      },
    });

    const tv = await doubanAdapter.fetchCollection("35465232", outbound);
    expect(tv.status).toBe("found");
    if (tv.status === "found") {
      expect(tv.info).toMatchObject({
        namespace: "douban",
        canonicalId: "35465232",
        title: "狂飙",
        originalTitle: "狂飙",
        year: 2023,
        mediaType: "tv",
        featureEpisodeCount: 39,
        listedPlatforms: ["iqiyi", "tencent"],
      });
      expect(tv.info.featureEpisodes).toHaveLength(39);
      expect(tv.info.aliases).toContain("The Knockout");
      expect(tv.info.externalIds).toBeUndefined();
    }

    const movie = await doubanAdapter.fetchCollection("1292052", outbound);
    expect(movie.status).toBe("found");
    if (movie.status === "found") {
      expect(movie.info).toMatchObject({
        namespace: "douban",
        canonicalId: "1292052",
        title: "肖申克的救赎",
        originalTitle: "The Shawshank Redemption",
        year: 1994,
        mediaType: "movie",
        featureEpisodeCount: 1,
        externalIds: { imdb: "tt0111161" },
      });
      // No vendors field at all: unknown, so a stored list is kept.
      expect(movie.info.listedPlatforms).toBeUndefined();
      expect(movie.info.featureEpisodes).toHaveLength(1);
    }
  });

  test("maps Douban 404 to not_found and 403/5xx/timeout to transient_error", async () => {
    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        if (new URL(request.url).pathname.endsWith("/404404")) {
          return jsonResponse(
            request.url,
            { code: 404, msg: "traversal_error", localized_message: "要访问的内容不存在" },
            404,
          );
        }
        if (new URL(request.url).pathname.endsWith("/403403")) {
          return { status: 403, headers: {}, body: "Forbidden", url: request.url };
        }
        if (new URL(request.url).pathname.endsWith("/503503")) {
          return { status: 503, headers: {}, body: "Service Unavailable", url: request.url };
        }
        if (new URL(request.url).pathname.endsWith("/408408")) {
          throw new Error("ETIMEDOUT connecting to frodo.douban.com");
        }
        throw new Error(`Unexpected URL: ${request.url}`);
      },
    });

    expect((await doubanAdapter.fetchCollection("404404", outbound)).status).toBe("not_found");
    expect((await doubanAdapter.fetchCollection("403403", outbound)).status).toBe(
      "transient_error",
    );
    expect((await doubanAdapter.fetchCollection("503503", outbound)).status).toBe(
      "transient_error",
    );
    expect((await doubanAdapter.fetchCollection("408408", outbound)).status).toBe(
      "transient_error",
    );
  });
});

describe("Bangumi Tier 1 & Tier 2 adapter", () => {
  test("parses and canonicalizes bare subject IDs and bgm.tv/bangumi.tv/chii.in URLs without network calls", async () => {
    const outbound = createFakeOutboundClient();

    const validInputs = [
      "294993",
      "  294993  ",
      "https://bgm.tv/subject/294993",
      "https://bgm.tv/subject/294993/",
      "https://bangumi.tv/subject/294993?foo=1",
      "https://chii.in/subject/294993#top",
      "http://www.bgm.tv/subject/294993",
    ];

    for (const raw of validInputs) {
      expect(parseBangumiInput(raw)).toEqual({
        kind: "subject",
        id: "294993",
        canonicalId: "294993",
      });
      expect(await bangumiAdapter.canonicalize(raw, outbound)).toBe("294993");
    }

    expect(outbound.httpRequests).toHaveLength(0);
  });

  test("rejects invalid Bangumi IDs and URLs with InvalidNativeIdError", async () => {
    const outbound = createFakeOutboundClient();

    const invalidInputs = [
      "",
      "   ",
      "0",
      "-294993",
      "subject/294993",
      "https://bgm.tv/ep/123456",
      "https://bgm.tv/subject/294993/ep",
      "https://bgm.tv/character/12345",
      "https://evil.example.com/subject/294993",
      "https://movie.douban.com/subject/1292052/",
    ];

    for (const raw of invalidInputs) {
      expect(bangumiAdapter.parseInput(raw)).toBeNull();
      await expect(bangumiAdapter.canonicalize(raw, outbound)).rejects.toBeInstanceOf(
        InvalidNativeIdError,
      );
    }
  });

  test("fetches TV and movie subjects, parses infobox IMDb_id and aliases, and fetches main episodes when eps is missing/0", async () => {
    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        expect(request.kind).toBe("catalog");
        expect(request.namespace).toBe("bangumi");

        if (request.url === "https://api.bgm.tv/v0/subjects/294993") {
          return jsonResponse(request.url, {
            id: 294993,
            type: 2,
            name: "呪術廻戦",
            name_cn: "咒术回战",
            date: "2020-10-02",
            platform: "TV",
            eps: 24,
            total_episodes: 25,
            infobox: [
              { key: "中文名", value: "咒术回战" },
              {
                key: "别名",
                value: [{ v: "Jujutsu Kaisen" }, { v: "咒术回战 第一季" }],
              },
              { key: "IMDb_id", value: "tt12343534" },
            ],
          });
        }

        if (request.url === "https://api.bgm.tv/v0/subjects/331752") {
          return jsonResponse(request.url, {
            id: 331752,
            type: 2,
            name: "劇場版 呪術廻戦 0",
            name_cn: "剧场版 咒术回战 0",
            date: "2021-12-24",
            platform: "剧场版",
            eps: 1,
            infobox: [{ key: "IMDb", value: "https://www.imdb.com/title/tt14331144/" }],
          });
        }

        if (request.url === "https://api.bgm.tv/v0/subjects/500001") {
          return jsonResponse(request.url, {
            id: 500001,
            type: 2,
            name: "Ongoing Original",
            name_cn: "连载动画",
            date: "2025-04-01",
            platform: "TV",
            eps: 0,
            infobox: [],
          });
        }

        if (
          request.url ===
          "https://api.bgm.tv/v0/episodes?subject_id=500001&type=0&limit=100&offset=0"
        ) {
          return jsonResponse(request.url, {
            total: 3,
            limit: 100,
            offset: 0,
            data: [
              { id: 101, type: 0, ep: 1, name: "Ep 1", name_cn: "第一话", airdate: "2025-04-01" },
              { id: 102, type: 0, ep: 2, name: "Ep 2", name_cn: "第二话", airdate: "2025-04-08" },
              { id: 103, type: 0, ep: 3, name: "Ep 3", name_cn: "第三话", airdate: "2025-04-15" },
            ],
          });
        }

        if (request.url === "https://api.bgm.tv/v0/subjects/900001") {
          // Book subject (type=1) must not be treated as movie/tv
          return jsonResponse(request.url, {
            id: 900001,
            type: 1,
            name: "Manga Book",
            name_cn: "漫画单行本",
            date: "2020-01-01",
            platform: "漫画",
            eps: 0,
          });
        }

        throw new Error(`Unexpected Bangumi URL: ${request.url}`);
      },
    });

    const tv = await bangumiAdapter.fetchCollection("294993", outbound);
    expect(tv.status).toBe("found");
    if (tv.status === "found") {
      expect(tv.info).toMatchObject({
        namespace: "bangumi",
        canonicalId: "294993",
        title: "咒术回战",
        originalTitle: "呪術廻戦",
        year: 2020,
        mediaType: "tv",
        featureEpisodeCount: 24,
        externalIds: { imdb: "tt12343534" },
      });
      expect(tv.info.aliases).toContain("Jujutsu Kaisen");
    }

    const movie = await bangumiAdapter.fetchCollection("331752", outbound);
    expect(movie.status).toBe("found");
    if (movie.status === "found") {
      expect(movie.info).toMatchObject({
        namespace: "bangumi",
        canonicalId: "331752",
        title: "剧场版 咒术回战 0",
        year: 2021,
        mediaType: "movie",
        featureEpisodeCount: 1,
        externalIds: { imdb: "tt14331144" },
      });
    }

    const ongoing = await bangumiAdapter.fetchCollection("500001", outbound);
    expect(ongoing.status).toBe("found");
    if (ongoing.status === "found") {
      expect(ongoing.info.featureEpisodeCount).toBe(3);
      expect(ongoing.info.featureEpisodes.map((ep) => ep.nativeEpisodeId)).toEqual([
        "101",
        "102",
        "103",
      ]);
    }

    const book = await bangumiAdapter.fetchCollection("900001", outbound);
    expect(book.status).toBe("not_found");
  });

  test("maps Bangumi 404 to not_found and 5xx/timeout to transient_error, and registers both adapters in default registry", async () => {
    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        if (request.url.endsWith("/404404")) {
          return jsonResponse(request.url, { title: "Not Found" }, 404);
        }
        if (request.url.endsWith("/502502")) {
          return { status: 502, headers: {}, body: "Bad Gateway", url: request.url };
        }
        if (request.url.endsWith("/408408")) {
          throw new Error("Request timeout");
        }
        throw new Error(`Unexpected URL: ${request.url}`);
      },
    });

    expect((await bangumiAdapter.fetchCollection("404404", outbound)).status).toBe("not_found");
    expect((await bangumiAdapter.fetchCollection("502502", outbound)).status).toBe(
      "transient_error",
    );
    expect((await bangumiAdapter.fetchCollection("408408", outbound)).status).toBe(
      "transient_error",
    );

    const registry = createDefaultAdapterRegistry();
    const douban = registry.get("douban");
    const bangumi = registry.get("bangumi");
    expect(douban?.tier).toBe(2);
    expect(bangumi?.tier).toBe(2);
    expect(douban && isTier2Adapter(douban)).toBe(true);
    expect(douban && isTier3Adapter(douban)).toBe(false);
    expect(bangumi && isTier2Adapter(bangumi)).toBe(true);
    expect(bangumi && isTier3Adapter(bangumi)).toBe(false);
  });
});

describe("Catalog gateway & baseline priority (selectBaseline + resolveCatalogTargetSnapshot)", () => {
  test("selectBaseline enforces exact priority tmdb > tvdb > imdb > bangumi > douban and returns null for Trakt-only", () => {
    expect(selectBaseline(["douban"])).toBe("douban");
    expect(selectBaseline(["douban", "bangumi"])).toBe("bangumi");
    expect(selectBaseline(["douban", "bangumi", "imdb"])).toBe("imdb");
    expect(selectBaseline(["douban", "bangumi", "imdb", "tvdb"])).toBe("tvdb");
    expect(selectBaseline(["douban", "bangumi", "imdb", "tvdb", "tmdb"])).toBe("tmdb");
    expect(selectBaseline(["trakt", "douban"])).toBe("douban");
    expect(selectBaseline(["trakt"])).toBeNull();
    expect(selectBaseline([])).toBeNull();
  });

  test("parseCatalogTargetKey validates all 6 catalog namespaces and rejects malformed or platform keys", () => {
    expect(parseCatalogTargetKey("tmdb:tv:95479")).toMatchObject({
      namespace: "tmdb",
      nativeId: "tv:95479",
      canonicalKey: "tmdb:tv:95479",
    });
    expect(parseCatalogTargetKey("tvdb:377543")).toMatchObject({
      namespace: "tvdb",
      nativeId: "377543",
      canonicalKey: "tvdb:377543",
    });
    expect(parseCatalogTargetKey("imdb:TT12343534")).toMatchObject({
      namespace: "imdb",
      nativeId: "tt12343534",
      canonicalKey: "imdb:tt12343534",
    });
    expect(parseCatalogTargetKey("bangumi:294993")).toMatchObject({
      namespace: "bangumi",
      nativeId: "294993",
      canonicalKey: "bangumi:294993",
    });
    expect(parseCatalogTargetKey("douban:1292052")).toMatchObject({
      namespace: "douban",
      nativeId: "1292052",
      canonicalKey: "douban:1292052",
    });
    expect(parseCatalogTargetKey("trakt:show:12345")).toMatchObject({
      namespace: "trakt",
      nativeId: "show:12345",
      canonicalKey: "trakt:show:12345",
    });

    for (const invalid of [
      "bilibili:ss34430",
      "tmdb:95479",
      "tvdb:abc",
      "imdb:12345",
      "bangumi:0",
      "douban:notnum",
      "trakt:bad/id",
      "unknown:123",
    ]) {
      expect(parseCatalogTargetKey(invalid)).toBeNull();
    }
  });

  test("resolveCatalogTargetSnapshot resolves tmdb, tvdb, imdb, bangumi, douban, and trakt with correct baseline, externalIds, and initialAssociation", async () => {
    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        if (request.namespace === "tmdb" && request.url.includes("/tv/95479")) {
          return jsonResponse(request.url, {
            id: 95479,
            name: "咒术回战",
            original_name: "呪術廻戦",
            first_air_date: "2020-10-03",
            seasons: [{ season_number: 1, episode_count: 24, air_date: "2020-10-03" }],
            external_ids: { imdb_id: "tt12343534", tvdb_id: 377543 },
          });
        }
        if (request.namespace === "tvdb" && request.url.includes("/series/700001/extended")) {
          return jsonResponse(request.url, {
            data: {
              id: 700001,
              name: "TVDB Exclusive Show",
              originalName: "TVDB Exclusive Original",
              firstAired: "2022-05-01",
              seasons: [
                { number: 1, type: { id: 1 }, episodeCount: 10, year: "2022" },
                { number: 1, type: { id: 2 }, episodeCount: 10, year: "2022" },
              ],
              remoteIds: [{ id: "tt7000001", type: 2, sourceName: "IMDB" }],
            },
          });
        }
        if (request.namespace === "imdb" && request.url.includes("/titles/tt8000001")) {
          return jsonResponse(request.url, {
            id: "tt8000001",
            type: "movie",
            primaryTitle: "IMDb Only Indie Film",
            originalTitle: "IMDb Only Indie Film",
            startYear: 2021,
          });
        }
        if (request.namespace === "bangumi" && request.url.endsWith("/subjects/600001")) {
          return jsonResponse(request.url, {
            id: 600001,
            type: 2,
            name: "オリジナルOVA",
            name_cn: "原创动画",
            date: "2024-03-10",
            platform: "OVA",
            eps: 6,
            infobox: [],
          });
        }
        if (
          request.namespace === "douban" &&
          new URL(request.url).pathname.endsWith("/subject/600002")
        ) {
          return jsonResponse(request.url, {
            id: "600002",
            title: "豆瓣独有短剧",
            original_title: "豆瓣独有短剧",
            year: "2024",
            type: "tv",
            is_tv: true,
            episodes_count: 8,
          });
        }
        if (request.namespace === "trakt" && request.url.includes("/shows/12345")) {
          return jsonResponse(request.url, {
            title: "Trakt Only Web Series",
            year: 2024,
            aired_episodes: 10,
            ids: { trakt: 12345, slug: "trakt-only-web-series" },
          });
        }
        return jsonResponse(request.url, { error: "not_found" }, 404);
      },
    });

    const tmdbRes = await resolveCatalogTargetSnapshot("tmdb:tv:95479", outbound);
    expect(tmdbRes.status).toBe("found");
    if (tmdbRes.status === "found") {
      expect(tmdbRes.target.baseline).toBe("tmdb");
      expect(tmdbRes.target.externalIds).toMatchObject({
        tmdb: "tv:95479",
        imdb: "tt12343534",
        tvdb: "377543",
      });
      expect(tmdbRes.target.initialAssociation).toBeNull();
    }

    const tvdbRes = await resolveCatalogTargetSnapshot("tvdb:700001", outbound);
    expect(tvdbRes.status).toBe("found");
    if (tvdbRes.status === "found") {
      expect(tvdbRes.target.baseline).toBe("tvdb");
      expect(tvdbRes.target.snapshot.seasons).toEqual([
        { season: 1, episodeCount: 10, airYear: 2022 },
      ]);
      expect(tvdbRes.target.externalIds).toEqual({ tvdb: "700001", imdb: "tt7000001" });
      expect(tvdbRes.target.initialAssociation).toBeNull();
    }

    const imdbRes = await resolveCatalogTargetSnapshot("imdb:tt8000001", outbound);
    expect(imdbRes.status).toBe("found");
    if (imdbRes.status === "found") {
      expect(imdbRes.target.baseline).toBe("imdb");
      expect(imdbRes.target.type).toBe("movie");
      expect(imdbRes.target.externalIds).toEqual({ imdb: "tt8000001" });
      expect(imdbRes.target.initialAssociation).toBeNull();
    }

    const bangumiRes = await resolveCatalogTargetSnapshot("bangumi:600001", outbound);
    expect(bangumiRes.status).toBe("found");
    if (bangumiRes.status === "found") {
      expect(bangumiRes.target.baseline).toBe("bangumi");
      expect(bangumiRes.target.snapshot.seasons).toEqual([
        { season: 1, episodeCount: 6, airYear: 2024 },
      ]);
      expect(bangumiRes.target.initialAssociation).toEqual({
        namespace: "bangumi",
        nativeId: "600001",
      });
    }

    const doubanRes = await resolveCatalogTargetSnapshot("douban:600002", outbound);
    expect(doubanRes.status).toBe("found");
    if (doubanRes.status === "found") {
      expect(doubanRes.target.baseline).toBe("douban");
      expect(doubanRes.target.snapshot.seasons).toEqual([
        { season: 1, episodeCount: 8, airYear: 2024 },
      ]);
      expect(doubanRes.target.initialAssociation).toEqual({
        namespace: "douban",
        nativeId: "600002",
      });
    }

    const traktRes = await resolveCatalogTargetSnapshot("trakt:show:12345", outbound);
    expect(traktRes.status).toBe("found");
    if (traktRes.status === "found") {
      expect(traktRes.target.baseline).toBeNull();
      expect(traktRes.target.externalIds).toEqual({ trakt: "show:12345" });
      expect(traktRes.target.initialAssociation).toBeNull();
      expect(traktRes.target.evidence.episodeCount).toBe(10);
    }

    const missing = await resolveCatalogTargetSnapshot("imdb:tt9999999", outbound);
    expect(missing.status).toBe("not_found");
  });

  test("a Douban rate-limit answer (400) is retried once", async () => {
    let calls = 0;
    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        calls += 1;
        return calls === 1
          ? jsonResponse(request.url, { code: 1, msg: "rate limited" }, 400)
          : jsonResponse(request.url, {
              id: "1292000",
              title: "搏击俱乐部",
              year: "1999",
              is_tv: false,
            });
      },
    });
    const result = await doubanAdapter.fetchCollection("1292000", outbound);
    expect(result.status).toBe("found");
    expect(calls).toBe(2);
  });

  test.each([
    ["imdb:tt0848228", { primaryTitle: "Movie", type: "movie", externalIds: { tmdb: "tv:1429" } }],
    ["tvdb:267440", { data: { name: "Series", externalIds: { tmdb: "movie:24428" } } }],
  ] as const)("does not backfill a cross-type TMDB or Trakt ID for %s", async (key, data) => {
    const outbound = createFakeOutboundClient({
      fetchExternal: (request) => jsonResponse(request.url, data),
    });
    const result = await resolveCatalogTargetSnapshot(key, outbound, { traktClientId: "test" });
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.target.externalIds.tmdb).toBeUndefined();
      expect(result.target.externalIds.trakt).toBeUndefined();
      expect(result.target.evidence.externalIds.tmdb).toBeUndefined();
    }
    expect(outbound.httpRequests).toHaveLength(1);
  });

  test("resolveCatalogTargetSnapshot forwards catalog traktClientId to TMDB and enriches imdb/tvdb targets with Trakt when tmdb external ID is present", async () => {
    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        const url = new URL(request.url);
        if (request.namespace === "tmdb" && url.pathname.endsWith("/movie/24428")) {
          return jsonResponse(request.url, {
            id: 24428,
            title: "复仇者联盟",
            original_title: "The Avengers",
            release_date: "2012-04-25",
            external_ids: { imdb_id: "tt0848228" },
          });
        }
        if (request.namespace === "imdb" && url.pathname.endsWith("/titles/tt0848228")) {
          return jsonResponse(request.url, {
            id: "tt0848228",
            type: "movie",
            primaryTitle: "The Avengers",
            startYear: 2012,
            externalIds: { tmdb: "movie:24428" },
          });
        }
        if (request.namespace === "tvdb" && url.pathname.endsWith("/series/267440/extended")) {
          return jsonResponse(request.url, {
            data: {
              id: 267440,
              name: "进击的巨人",
              year: 2013,
              externalIds: { tmdb: "tv:1429" },
            },
          });
        }
        if (request.namespace === "trakt" && url.pathname.endsWith("/search/tmdb/24428")) {
          expect(request.headers?.["trakt-api-key"]).toBe("trakt-from-catalog-config");
          return jsonResponse(request.url, [
            { type: "movie", movie: { ids: { trakt: 727, tmdb: 24428 } } },
          ]);
        }
        if (request.namespace === "trakt" && url.pathname.endsWith("/search/tmdb/1429")) {
          expect(request.headers?.["trakt-api-key"]).toBe("trakt-from-catalog-config");
          return jsonResponse(request.url, [
            { type: "show", show: { ids: { trakt: 1417, tmdb: 1429 } } },
          ]);
        }
        throw new Error(`Unexpected request: ${request.url}`);
      },
    });

    const config = {
      tmdb: { accessToken: "test-tmdb-token" },
      traktClientId: "trakt-from-catalog-config",
    };

    const tmdbRes = await resolveCatalogTargetSnapshot("tmdb:movie:24428", outbound, config);
    expect(tmdbRes.status).toBe("found");
    if (tmdbRes.status === "found") {
      expect(tmdbRes.target.externalIds).toEqual({
        tmdb: "movie:24428",
        imdb: "tt0848228",
        trakt: "movie:727",
      });
    }

    const imdbRes = await resolveCatalogTargetSnapshot("imdb:tt0848228", outbound, config);
    expect(imdbRes.status).toBe("found");
    if (imdbRes.status === "found") {
      expect(imdbRes.target.externalIds).toEqual({
        imdb: "tt0848228",
        tmdb: "movie:24428",
        trakt: "movie:727",
      });
    }

    const tvdbRes = await resolveCatalogTargetSnapshot("tvdb:series:267440", outbound, config);
    expect(tvdbRes.status).toBe("found");
    if (tvdbRes.status === "found") {
      expect(tvdbRes.target.externalIds).toEqual({
        tvdb: "267440",
        tmdb: "tv:1429",
        trakt: "show:1417",
      });
    }
  });
});
