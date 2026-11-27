import { describe, expect, test } from "vite-plus/test";
import {
  AdapterTransientError,
  bilibiliAdapter,
  createAdapterRegistry,
  createDefaultAdapterRegistry,
  createFakeOutboundClient,
  createTier1Adapter,
  InvalidNativeIdError,
  isTier2Adapter,
  isTier3Adapter,
  type ExternalHttpResponse,
} from "../src/index.ts";

function jsonResponse(url: string, payload: unknown, status = 200): ExternalHttpResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
    url,
  };
}

describe("Bilibili Tier 1 & Tier 2 adapter", () => {
  test("parses and canonicalizes ss IDs and Bilibili bangumi URLs without network calls", async () => {
    const outbound = createFakeOutboundClient();

    const directInputs = [
      "ss34430",
      "SS34430",
      "  ss34430  ",
      "https://www.bilibili.com/bangumi/play/ss34430",
      "https://www.bilibili.com/bangumi/play/ss34430/",
      "https://www.bilibili.com/bangumi/play/ss34430?from_spmid=666.25.episode.0#reply",
      "https://m.bilibili.com/bangumi/play/ss34430",
      "http://bilibili.com/bangumi/play/ss34430",
    ];

    for (const raw of directInputs) {
      expect(bilibiliAdapter.parseInput(raw)).toEqual({
        kind: "season",
        id: "34430",
        canonicalId: "ss34430",
      });
      expect(await bilibiliAdapter.canonicalize(raw, outbound)).toBe("ss34430");
    }

    expect(outbound.httpRequests).toHaveLength(0);
  });

  test("resolves ep and md IDs/URLs to canonical ss<digits> via OutboundClient", async () => {
    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        if (request.url === "https://api.bilibili.com/pgc/view/web/season?ep_id=341208") {
          return jsonResponse(request.url, {
            code: 0,
            message: "success",
            result: {
              season_id: 34430,
              title: "咒术回战",
            },
          });
        }
        if (request.url === "https://api.bilibili.com/pgc/review/user?media_id=28229899") {
          return jsonResponse(request.url, {
            code: 0,
            message: "success",
            result: {
              media: {
                media_id: 28229899,
                season_id: 34430,
                title: "咒术回战",
              },
            },
          });
        }
        throw new Error(`Unexpected request: ${request.url}`);
      },
    });

    expect(await bilibiliAdapter.canonicalize("ep341208", outbound)).toBe("ss34430");
    expect(
      await bilibiliAdapter.canonicalize(
        "https://www.bilibili.com/bangumi/play/ep341208?spm_id_from=333.337",
        outbound,
      ),
    ).toBe("ss34430");
    expect(await bilibiliAdapter.canonicalize("md28229899", outbound)).toBe("ss34430");
    expect(
      await bilibiliAdapter.canonicalize(
        "https://www.bilibili.com/bangumi/media/md28229899/",
        outbound,
      ),
    ).toBe("ss34430");

    expect(outbound.httpRequests).toHaveLength(4);
    for (const req of outbound.httpRequests) {
      expect(req.kind).toBe("platform");
      expect(req.namespace).toBe("bilibili");
    }
  });

  test("rejects invalid Bilibili URLs, BV/av links, bare numbers, and unresolvable ep/md IDs", async () => {
    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        if (request.url.includes("ep_id=999999999")) {
          return jsonResponse(request.url, { code: -404, message: "啥都木有" });
        }
        if (request.url.includes("media_id=999999999")) {
          return jsonResponse(request.url, { code: -404, message: "啥都木有" });
        }
        if (request.url.includes("ep_id=503503")) {
          return { status: 503, headers: {}, body: "unavailable", url: request.url };
        }
        throw new Error(`Unexpected request: ${request.url}`);
      },
    });

    const invalidInputs = [
      "",
      "   ",
      "34430",
      "ss0",
      "ss-12",
      "BV1xx411c7mD",
      "av170001",
      "https://www.bilibili.com/video/BV1xx411c7mD",
      "https://www.bilibili.com/video/av170001",
      "https://evil.example.com/bangumi/play/ss34430",
      "https://www.bilibili.com/bangumi/play/ss34430/extra",
      "https://v.qq.com/x/cover/mzc002007knmh3g.html",
      "not-a-valid-id",
    ];

    for (const raw of invalidInputs) {
      expect(bilibiliAdapter.parseInput(raw)).toBeNull();
      await expect(bilibiliAdapter.canonicalize(raw, outbound)).rejects.toBeInstanceOf(
        InvalidNativeIdError,
      );
    }

    await expect(bilibiliAdapter.canonicalize("ep999999999", outbound)).rejects.toBeInstanceOf(
      InvalidNativeIdError,
    );
    await expect(bilibiliAdapter.canonicalize("md999999999", outbound)).rejects.toBeInstanceOf(
      InvalidNativeIdError,
    );
    await expect(bilibiliAdapter.canonicalize("ep503503", outbound)).rejects.toBeInstanceOf(
      AdapterTransientError,
    );
  });

  test("fetches TV collection metadata and filters out trailers/previews from feature episodes", async () => {
    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        expect(request.kind).toBe("platform");
        expect(request.namespace).toBe("bilibili");
        expect(request.url).toBe("https://api.bilibili.com/pgc/view/web/season?season_id=34430");
        return jsonResponse(request.url, {
          code: 0,
          message: "success",
          result: {
            season_id: 34430,
            title: "咒术回战",
            season_title: "第一季",
            jp_title: "呪術廻戦",
            alias: "Jujutsu Kaisen / 咒术回战 第一季",
            type: 1,
            total: 24,
            publish: {
              pub_time: "2020-10-03 01:25:00",
              pub_time_show: "2020年10月3日开播",
            },
            series: {
              series_id: 4920,
              series_title: "咒术回战",
            },
            episodes: [
              {
                id: 341208,
                title: "1",
                long_title: "两面宿傩",
                badge: "",
                badge_type: 0,
                section_type: 0,
                duration: 1435000,
                pub_time: 1601659500,
              },
              {
                id: 341209,
                title: "2",
                long_title: "为了自己",
                badge: "会员",
                badge_type: 0,
                section_type: 0,
                duration: 1435000,
                pub_time: 1602264300,
              },
              {
                id: 341210,
                title: "3",
                long_title: "预告片",
                badge: "预告",
                badge_type: 1,
                section_type: 0,
                duration: 30000,
              },
              {
                id: 341211,
                title: "PV1",
                long_title: "先导PV",
                badge: "",
                badge_type: 0,
                section_type: 1,
                duration: 90000,
              },
              {
                id: 341212,
                title: "3",
                long_title: "铁骨娘",
                badge: "会员",
                badge_type: 0,
                section_type: 0,
                duration: 1435000,
              },
            ],
            section: [
              {
                title: "PV",
                episodes: [
                  {
                    id: 999001,
                    title: "PV1",
                    badge: "",
                    badge_type: 0,
                    section_type: 0,
                  },
                ],
              },
            ],
          },
        });
      },
    });

    const result = await bilibiliAdapter.fetchCollection("ss34430", outbound);
    expect(result.status).toBe("found");
    if (result.status !== "found") {
      return;
    }

    expect(result.info.namespace).toBe("bilibili");
    expect(result.info.canonicalId).toBe("ss34430");
    expect(result.info.title).toBe("咒术回战");
    expect(result.info.originalTitle).toBe("呪術廻戦");
    expect(result.info.year).toBe(2020);
    expect(result.info.mediaType).toBe("tv");
    expect(result.info.featureEpisodeCount).toBe(3);
    expect(result.info.featureEpisodes.map((ep) => ep.nativeEpisodeId)).toEqual([
      "341208",
      "341209",
      "341212",
    ]);
    expect(result.info.featureEpisodes.map((ep) => ep.index)).toEqual([1, 2, 3]);
    expect(result.info.aliases).toContain("Jujutsu Kaisen");
    expect(result.info.externalIds).toBeUndefined();
  });

  test("maps Bilibili movie type=2, not_found code=-404, and transient errors (5xx/412/timeout)", async () => {
    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        if (request.url.includes("season_id=28281")) {
          return jsonResponse(request.url, {
            code: 0,
            message: "success",
            result: {
              season_id: 28281,
              title: "哈利·波特与魔法石",
              type: 2,
              publish: { pub_time: "2001-11-16 00:00:00" },
              episodes: [
                {
                  id: 279999,
                  title: "正片",
                  badge: "会员",
                  badge_type: 0,
                  section_type: 0,
                  duration: 9120000,
                },
              ],
            },
          });
        }
        if (request.url.includes("season_id=99999999")) {
          return jsonResponse(request.url, { code: -404, message: "啥都木有" });
        }
        if (request.url.includes("season_id=412000")) {
          return { status: 412, headers: {}, body: "<html>risk control</html>", url: request.url };
        }
        if (request.url.includes("season_id=503000")) {
          return { status: 503, headers: {}, body: "Service Unavailable", url: request.url };
        }
        if (request.url.includes("season_id=408000")) {
          throw new Error("The operation timed out");
        }
        throw new Error(`Unexpected URL: ${request.url}`);
      },
    });

    const movie = await bilibiliAdapter.fetchCollection("ss28281", outbound);
    expect(movie).toMatchObject({
      status: "found",
      info: {
        canonicalId: "ss28281",
        title: "哈利·波特与魔法石",
        mediaType: "movie",
        year: 2001,
        featureEpisodeCount: 1,
      },
    });

    const missing = await bilibiliAdapter.fetchCollection("ss99999999", outbound);
    expect(missing.status).toBe("not_found");

    const riskBlocked = await bilibiliAdapter.fetchCollection("ss412000", outbound);
    expect(riskBlocked.status).toBe("transient_error");

    const serverErr = await bilibiliAdapter.fetchCollection("ss503000", outbound);
    expect(serverErr.status).toBe("transient_error");

    const timedOut = await bilibiliAdapter.fetchCollection("ss408000", outbound);
    expect(timedOut.status).toBe("transient_error");
  });

  test("takes the year from the media's premiere date, not the season's listing time", async () => {
    const season = (seasonId: number, mediaId: number) => ({
      code: 0,
      message: "success",
      result: {
        season_id: seasonId,
        media_id: mediaId,
        title: "死侍2",
        type: 2,
        publish: { pub_time: "2023-10-05 18:00:00" },
        episodes: [{ id: 1, title: "正片", badge_type: 0, section_type: 0 }],
      },
    });
    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        if (request.url.endsWith("season_id=46072"))
          return jsonResponse(request.url, season(46072, 28339032));
        if (request.url.endsWith("season_id=46073"))
          return jsonResponse(request.url, season(46073, 1));
        if (request.url.endsWith("media?media_id=28339032")) {
          return jsonResponse(request.url, {
            code: 0,
            result: { media_id: 28339032, publish: { pub_date: "2018-05-18" } },
          });
        }
        if (request.url.endsWith("media?media_id=1")) {
          return { status: 412, headers: {}, body: "risk control", url: request.url };
        }
        throw new Error(`Unexpected URL: ${request.url}`);
      },
    });

    const premiere = await bilibiliAdapter.fetchCollection("ss46072", outbound);
    expect(premiere).toMatchObject({ status: "found", info: { year: 2018, mediaType: "movie" } });

    // The media lookup is best effort: when it fails, the season's own year stays.
    const fallback = await bilibiliAdapter.fetchCollection("ss46073", outbound);
    expect(fallback).toMatchObject({ status: "found", info: { year: 2023 } });
  });

  test("reads the display type, not the channel: a film listed under 番剧 is a movie", async () => {
    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        if (request.url.endsWith("season_id=3396")) {
          return jsonResponse(request.url, {
            code: 0,
            message: "success",
            result: {
              season_id: 3396,
              title: "×××HOLiC 仲夏夜之梦",
              type: 1,
              show_season_type: 2,
              publish: { pub_time: "2005-08-20 00:00:01" },
              episodes: [{ id: 84775, title: "1", badge_type: 0, section_type: 0 }],
            },
          });
        }
        throw new Error(`Unexpected URL: ${request.url}`);
      },
    });

    const result = await bilibiliAdapter.fetchCollection("ss3396", outbound);
    expect(result).toMatchObject({ status: "found", info: { mediaType: "movie" } });
  });

  test("registry exposes default adapters and tier guards cleanly", () => {
    const defaultRegistry = createDefaultAdapterRegistry();
    const bili = defaultRegistry.get("bilibili");
    expect(bili).toBeDefined();
    expect(bili?.tier).toBe(3);
    expect(bili && isTier2Adapter(bili)).toBe(true);
    expect(bili && isTier3Adapter(bili)).toBe(true);
    expect(defaultRegistry.listByMinTier(2).map((a) => a.namespace)).toContain("bilibili");
    expect(defaultRegistry.listByMinTier(3).map((a) => a.namespace)).toEqual([
      "bilibili",
      "iqiyi",
      "youku",
    ]);

    const tier1Stub = createTier1Adapter({
      namespace: "youku",
      parseInput(raw) {
        const trimmed = raw.trim();
        return /^[a-f0-9]{20}$/.test(trimmed)
          ? { kind: "show", id: trimmed, canonicalId: trimmed }
          : null;
      },
    });
    const customRegistry = createAdapterRegistry([tier1Stub, bilibiliAdapter]);
    expect(customRegistry.get("youku")?.tier).toBe(1);
    expect(isTier2Adapter(tier1Stub)).toBe(false);
    expect(customRegistry.listByMinTier(1).map((a) => a.namespace)).toEqual(["youku", "bilibili"]);
    expect(customRegistry.listByMinTier(2).map((a) => a.namespace)).toEqual(["bilibili"]);
    expect(customRegistry.listByMinTier(3).map((a) => a.namespace)).toEqual(["bilibili"]);
  });
});

describe("Bilibili Tier 3 search", () => {
  test("searches media_bangumi and media_ft with buvid3 cookie + search referer, strips highlight tags, and deduplicates by season_id", async () => {
    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        expect(request.kind).toBe("platform");
        expect(request.namespace).toBe("bilibili");
        expect(request.headers?.referer).toBe("https://search.bilibili.com/");
        expect(request.headers?.cookie).toMatch(/buvid3=[A-Za-z0-9-]+/);

        const url = new URL(request.url);
        expect(url.origin + url.pathname).toBe(
          "https://api.bilibili.com/x/web-interface/search/type",
        );
        expect(url.searchParams.get("keyword")).toBe("咒术回战");
        expect(url.searchParams.get("page")).toBe("1");

        const searchType = url.searchParams.get("search_type");
        if (searchType === "media_bangumi") {
          return jsonResponse(request.url, {
            code: 0,
            message: "0",
            data: {
              numResults: 2,
              result: [
                {
                  season_id: 34430,
                  media_id: 28229899,
                  title: '<em class="keyword">咒术回战</em>',
                  org_title: "呪術廻戦",
                  media_type: 1,
                  season_type: 1,
                  pubtime: 1601659500, // 2020-10-03 01:25:00 CST
                  ep_size: 24,
                  url: "https://www.bilibili.com/bangumi/play/ss34430",
                },
                {
                  season_id: 45574,
                  media_id: 28339735,
                  title: '<em class="keyword">咒术回战</em> 第二季',
                  org_title: "呪術廻戦 懐玉・玉折／渋谷事変",
                  media_type: 1,
                  season_type: 1,
                  pubtime: 1688659200, // 2023-07-07 CST
                  ep_size: 23,
                },
              ],
            },
          });
        }

        if (searchType === "media_ft") {
          return jsonResponse(request.url, {
            code: 0,
            message: "0",
            data: {
              numResults: 2,
              result: [
                // Duplicate season_id 34430 must be deduplicated
                {
                  season_id: 34430,
                  media_id: 28229899,
                  title: '<em class="keyword">咒术回战</em> (重复)',
                  media_type: 1,
                  pubtime: 1601659500,
                  ep_size: 24,
                },
                {
                  season_id: 40500,
                  media_id: 28331111,
                  title: '<em class="keyword">咒术回战</em> 0 &amp; 剧场版',
                  org_title: '劇場版 <em class="keyword">呪術廻戦</em> 0',
                  media_type: 2,
                  season_type: 2,
                  pubtime: 1640304000, // 2021-12-24 CST
                  ep_size: 1,
                  url: "https://www.bilibili.com/bangumi/play/ss40500",
                },
              ],
            },
          });
        }

        throw new Error(`Unexpected search_type: ${searchType}`);
      },
    });

    const result = await bilibiliAdapter.search({ title: "咒术回战" }, outbound);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      return;
    }

    expect(outbound.httpRequests).toHaveLength(2);
    expect(result.candidates).toEqual([
      {
        canonicalId: "ss34430",
        title: "咒术回战",
        originalTitle: "呪術廻戦",
        year: 2020,
        mediaType: "tv",
        episodeCount: 24,
        url: "https://www.bilibili.com/bangumi/play/ss34430",
      },
      {
        canonicalId: "ss45574",
        title: "咒术回战 第二季",
        originalTitle: "呪術廻戦 懐玉・玉折／渋谷事変",
        year: 2023,
        mediaType: "tv",
        episodeCount: 23,
        url: "https://www.bilibili.com/bangumi/play/ss45574",
      },
      {
        canonicalId: "ss40500",
        title: "咒术回战 0 & 剧场版",
        originalTitle: "劇場版 呪術廻戦 0",
        year: 2021,
        mediaType: "movie",
        episodeCount: 1,
        url: "https://www.bilibili.com/bangumi/play/ss40500",
      },
    ]);
  });

  test("maps empty search results cleanly to { status: 'ok', candidates: [] } and respects limit", async () => {
    const emptyOutbound = createFakeOutboundClient({
      fetchExternal(request) {
        const url = new URL(request.url);
        if (url.searchParams.get("search_type") === "media_bangumi") {
          return jsonResponse(request.url, {
            code: 0,
            message: "0",
            data: { numResults: 0 },
          });
        }
        return jsonResponse(request.url, {
          code: 0,
          message: "0",
          data: { numResults: 0, result: [] },
        });
      },
    });

    const empty = await bilibiliAdapter.search({ title: "不存在的神秘番剧XYZ" }, emptyOutbound);
    expect(empty).toEqual({ status: "ok", candidates: [] });

    const limitOutbound = createFakeOutboundClient({
      fetchExternal(request) {
        const url = new URL(request.url);
        if (url.searchParams.get("search_type") === "media_bangumi") {
          return jsonResponse(request.url, {
            code: 0,
            data: {
              result: [
                { season_id: 1001, title: "剧A", media_type: 1, pubtime: 1704067200, ep_size: 12 },
                { season_id: 1002, title: "剧B", media_type: 1, pubtime: 1704067200, ep_size: 12 },
              ],
            },
          });
        }
        return jsonResponse(request.url, {
          code: 0,
          data: {
            result: [
              {
                season_id: 1003,
                title: "剧C",
                media_type: 5,
                pubtime: 1704067200,
                eps: [{ id: 1 }, { id: 2 }],
              },
            ],
          },
        });
      },
    });

    const limited = await bilibiliAdapter.search({ title: "剧", limit: 2 }, limitOutbound);
    expect(limited.status).toBe("ok");
    if (limited.status === "ok") {
      expect(limited.candidates).toHaveLength(2);
      expect(limited.candidates.map((c) => c.canonicalId)).toEqual(["ss1001", "ss1002"]);
    }
  });

  test("maps HTTP 412, 429, 5xx, timeouts, and non-zero Bilibili codes to transient_error", async () => {
    const scenarios: Array<{
      label: string;
      handler: () => ExternalHttpResponse | Promise<ExternalHttpResponse>;
      expectedReasonPattern: RegExp;
    }> = [
      {
        label: "http 412 risk control",
        handler: () => ({
          status: 412,
          headers: { "content-type": "text/html" },
          body: "<html>risk control</html>",
          url: "https://api.bilibili.com/x/web-interface/search/type",
        }),
        expectedReasonPattern: /412/,
      },
      {
        label: "http 429 rate limited",
        handler: () => ({
          status: 429,
          headers: { "retry-after": "30" },
          body: "Too Many Requests",
          url: "https://api.bilibili.com/x/web-interface/search/type",
        }),
        expectedReasonPattern: /429/,
      },
      {
        label: "http 503 upstream failure",
        handler: () => ({
          status: 503,
          headers: {},
          body: "Service Unavailable",
          url: "https://api.bilibili.com/x/web-interface/search/type",
        }),
        expectedReasonPattern: /503/,
      },
      {
        label: "network timeout",
        handler: async () => {
          throw new Error("The operation timed out");
        },
        expectedReasonPattern: /timed out/i,
      },
      {
        label: "non-zero bilibili error code",
        handler: () =>
          jsonResponse("https://api.bilibili.com/x/web-interface/search/type", {
            code: -412,
            message: "请求被拦截",
          }),
        expectedReasonPattern: /-412/,
      },
    ];

    for (const scenario of scenarios) {
      const outbound = createFakeOutboundClient({
        fetchExternal: scenario.handler,
      });
      const result = await bilibiliAdapter.search({ title: "咒术回战" }, outbound);
      expect(result.status, scenario.label).toBe("transient_error");
      if (result.status === "transient_error") {
        expect(result.reason, scenario.label).toMatch(scenario.expectedReasonPattern);
      }
    }
  });
});
