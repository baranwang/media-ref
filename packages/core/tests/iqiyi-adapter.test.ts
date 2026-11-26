import { describe, expect, test } from "vite-plus/test";
import {
  AdapterTransientError,
  createDefaultAdapterRegistry,
  createFakeOutboundClient,
  InvalidNativeIdError,
  iqiyiAdapter,
  isTier2Adapter,
  isTier3Adapter,
  parseIqiyiInput,
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

function htmlResponse(url: string, html: string, status = 200): ExternalHttpResponse {
  return {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: html,
    url,
  };
}

describe("iQIYI Tier 1 & Tier 2 adapter (#14)", () => {
  test("parses and canonicalizes bare numeric qipuId / albumId without network calls", async () => {
    const outbound = createFakeOutboundClient();

    const directInputs = [
      "5328486914190101",
      "  5328486914190101  ",
      "202861101",
      "923452300",
      "7292991076670500",
    ];

    for (const raw of directInputs) {
      const trimmed = raw.trim();
      expect(parseIqiyiInput(raw)).toEqual({
        kind: "qipu",
        id: trimmed,
        canonicalId: trimmed,
      });
      expect(await iqiyiAdapter.canonicalize(raw, outbound)).toBe(trimmed);
    }

    expect(outbound.httpRequests).toHaveLength(0);
  });

  test("canonicalizes iQIYI album URLs (www/m/bare) by extracting albumId or qipuId from SSR HTML", async () => {
    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        expect(request.kind).toBe("platform");
        expect(request.namespace).toBe("iqiyi");
        if (request.url === "https://www.iqiyi.com/a_1fkgtbddd2x.html") {
          return htmlResponse(
            request.url,
            `<!doctype html><html><head><title>狂飙</title></head><body><script>window.__INITIAL_STATE__={"albumId":0,"albumInfo":{"albumId":5328486914190101,"name":"狂飙"}};</script></body></html>`,
          );
        }
        if (request.url === "https://www.iqiyi.com/a_19rrhl4335.html") {
          return htmlResponse(
            request.url,
            `<!doctype html><html><body><script>var pageInfo = {"qipuId": "202861101"};</script></body></html>`,
          );
        }
        throw new Error(`Unexpected request: ${request.url}`);
      },
    });

    expect(
      await iqiyiAdapter.canonicalize("https://www.iqiyi.com/a_1fkgtbddd2x.html", outbound),
    ).toBe("5328486914190101");
    expect(
      await iqiyiAdapter.canonicalize(
        "https://m.iqiyi.com/a_1fkgtbddd2x.html?vfrm=2-3-0-1#comments",
        outbound,
      ),
    ).toBe("5328486914190101");
    expect(await iqiyiAdapter.canonicalize("http://iqiyi.com/a_19rrhl4335.html", outbound)).toBe(
      "202861101",
    );
    expect(await iqiyiAdapter.canonicalize("a_1fkgtbddd2x", outbound)).toBe("5328486914190101");

    expect(outbound.httpRequests).toHaveLength(4);
    expect(outbound.httpRequests.every((r) => r.url.startsWith("https://www.iqiyi.com/a_"))).toBe(
      true,
    );
  });

  test("rewrites desktop v_<hash>.html share URLs to m.iqiyi.com mobile SSR and normalizes qipuId via video/baseinfo", async () => {
    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        expect(request.kind).toBe("platform");
        expect(request.namespace).toBe("iqiyi");

        // Case 1: mobile SSR directly exposes albumId (TV episode)
        if (request.url === "https://m.iqiyi.com/v_xkt6z3z798.html") {
          expect(request.headers?.["user-agent"]).toMatch(/Mobile/i);
          return htmlResponse(
            request.url,
            `<!doctype html><html><body><script>window.__INITIAL_STATE__={"playPageInfo":{"albumId":5328486914190101,"qipuId":3493131456125200}};</script></body></html>`,
          );
        }

        // Case 2: mobile SSR exposes qipuId only (TV episode -> normalized to albumId via video/baseinfo)
        if (request.url === "https://m.iqiyi.com/v_epqipuonly.html") {
          return htmlResponse(
            request.url,
            `<!doctype html><html><body><script>window.__DATA__={"albumId":0,"qipuId":3493131456125200};</script></body></html>`,
          );
        }
        if (request.url === "https://pcw-api.iqiyi.com/video/video/baseinfo/3493131456125200") {
          return jsonResponse(request.url, {
            code: "A00000",
            data: {
              tvId: 3493131456125200,
              albumId: 5328486914190101,
              name: "狂飙第1集",
              channelId: 2,
            },
          });
        }

        // Case 3: mobile SSR for a movie (qipuId only -> video/baseinfo returns albumId === tvId)
        if (request.url === "https://m.iqiyi.com/v_19rrfe142o.html") {
          return htmlResponse(
            request.url,
            `<!doctype html><html><body><script>window.__DATA__={"qipuId":923452300};</script></body></html>`,
          );
        }
        if (request.url === "https://pcw-api.iqiyi.com/video/video/baseinfo/923452300") {
          return jsonResponse(request.url, {
            code: "A00000",
            data: {
              tvId: 923452300,
              albumId: 923452300,
              name: "流浪地球",
              channelId: 1,
            },
          });
        }

        throw new Error(`Unexpected request: ${request.url}`);
      },
    });

    // Desktop share URL must be rewritten to m.iqiyi.com
    expect(
      await iqiyiAdapter.canonicalize(
        "https://www.iqiyi.com/v_xkt6z3z798.html?vfrm=pcw_home",
        outbound,
      ),
    ).toBe("5328486914190101");

    // Mobile URL with qipuId only -> normalized via pcw-api video/baseinfo
    expect(await iqiyiAdapter.canonicalize("https://m.iqiyi.com/v_epqipuonly.html", outbound)).toBe(
      "5328486914190101",
    );

    // Desktop movie share URL -> m.iqiyi.com -> video/baseinfo -> movie tvId/albumId
    expect(
      await iqiyiAdapter.canonicalize("https://www.iqiyi.com/v_19rrfe142o.html", outbound),
    ).toBe("923452300");

    // Bare v_<hash>
    expect(await iqiyiAdapter.canonicalize("v_xkt6z3z798", outbound)).toBe("5328486914190101");

    // Ensure desktop www.iqiyi.com/v_ was NEVER requested directly
    expect(outbound.httpRequests.some((r) => r.url.includes("www.iqiyi.com/v_"))).toBe(false);
  });

  test("rejects unparseable URLs, SPA shells missing albumId/qipuId, 404s, and propagates transient errors", async () => {
    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        if (request.url === "https://m.iqiyi.com/v_spashell00.html") {
          return htmlResponse(
            request.url,
            "<!doctype html><html><head><title>爱奇艺-在线视频网站</title></head><body><div id='app'></div></body></html>",
          );
        }
        if (request.url === "https://www.iqiyi.com/a_missing404.html") {
          return htmlResponse(request.url, "Not Found", 404);
        }
        if (request.url === "https://m.iqiyi.com/v_deletedvid.html") {
          return htmlResponse(request.url, `<script>var x={"qipuId":999999900};</script>`);
        }
        if (request.url === "https://pcw-api.iqiyi.com/video/video/baseinfo/999999900") {
          return jsonResponse(request.url, {
            code: "A00001",
            data: "参数错误",
            errMsg: "video not found",
          });
        }
        if (request.url === "https://m.iqiyi.com/v_transient503.html") {
          return htmlResponse(request.url, "Service Unavailable", 503);
        }
        if (request.url === "https://www.iqiyi.com/a_timeout000.html") {
          throw new Error("ETIMEDOUT");
        }
        throw new Error(`Unexpected request: ${request.url}`);
      },
    });

    const invalidInputs = [
      "",
      "   ",
      "123",
      "000000",
      "012345678",
      "ss34430",
      "not-a-valid-id",
      "https://www.iqiyi.com/u/123456",
      "https://www.iqiyi.com/kszt/topic.html",
      "https://so.iqiyi.com/so/q_test",
      "https://evil.example.com/a_1fkgtbddd2x.html",
      "https://evil.example.com/v_xkt6z3z798.html",
      "https://v.qq.com/x/cover/mzc002007knmh3g.html",
      "ftp://www.iqiyi.com/a_1fkgtbddd2x.html",
    ];

    for (const raw of invalidInputs) {
      expect(parseIqiyiInput(raw)).toBeNull();
      await expect(iqiyiAdapter.canonicalize(raw, outbound)).rejects.toBeInstanceOf(
        InvalidNativeIdError,
      );
    }

    await expect(
      iqiyiAdapter.canonicalize("https://www.iqiyi.com/v_spashell00.html", outbound),
    ).rejects.toBeInstanceOf(InvalidNativeIdError);
    await expect(
      iqiyiAdapter.canonicalize("https://www.iqiyi.com/a_missing404.html", outbound),
    ).rejects.toBeInstanceOf(InvalidNativeIdError);
    await expect(
      iqiyiAdapter.canonicalize("https://www.iqiyi.com/v_deletedvid.html", outbound),
    ).rejects.toBeInstanceOf(InvalidNativeIdError);
    await expect(
      iqiyiAdapter.canonicalize("https://www.iqiyi.com/v_transient503.html", outbound),
    ).rejects.toBeInstanceOf(AdapterTransientError);
    await expect(
      iqiyiAdapter.canonicalize("https://www.iqiyi.com/a_timeout000.html", outbound),
    ).rejects.toBeInstanceOf(AdapterTransientError);
  });

  test("registers iqiyiAdapter at Tier 3 in createDefaultAdapterRegistry()", () => {
    const registry = createDefaultAdapterRegistry();
    const adapter = registry.get("iqiyi");
    expect(adapter).toBeDefined();
    expect(adapter?.tier).toBe(3);
    expect(adapter && isTier2Adapter(adapter)).toBe(true);
    expect(adapter && isTier3Adapter(adapter)).toBe(true);
    expect(registry.listByMinTier(2).map((a) => a.namespace)).toContain("iqiyi");
    expect(registry.listByMinTier(3).map((a) => a.namespace)).toContain("iqiyi");
  });

  test("fetches TV album metadata, paginates epsodelist (size=50), filters contentType === 1, and uses firstVideo.period over data.period", async () => {
    const page1FeatureCount = 50;
    const page2FeatureCount = 12;

    const makePageEpisodes = (startOrder: number, count: number, includeTrailers: boolean) => {
      const list: Array<Record<string, unknown>> = [];
      for (let i = 0; i < count; i += 1) {
        const order = startOrder + i;
        list.push({
          tvId: 3493131456000000 + order * 100,
          order,
          name: `狂飙第${order}集`,
          shortTitle: `第${order}集`,
          contentType: 1,
          duration: "45:12",
          period: "2023-01-14",
          effective: true,
        });
      }
      if (includeTrailers) {
        list.push({
          tvId: 999900000100,
          order: 999,
          name: "狂飙第1集预告",
          shortTitle: "预告",
          contentType: 3,
          duration: "01:30",
          period: "2023-01-13",
          effective: true,
        });
        list.push({
          tvId: 999900000200,
          order: 1000,
          name: "幕后花絮",
          shortTitle: "花絮",
          contentType: 5,
          duration: 120,
          period: "2023-01-15",
          effective: true,
        });
      }
      return list;
    };

    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        expect(request.kind).toBe("platform");
        expect(request.namespace).toBe("iqiyi");

        if (request.url === "https://pcw-api.iqiyi.com/album/album/baseinfo/5328486914190101") {
          return jsonResponse(request.url, {
            code: "A00000",
            data: {
              albumId: 5328486914190101,
              name: "狂飙",
              englishName: "The Knockout",
              channelId: 2,
              videoCount: 62,
              latestOrder: 62,
              // Latest episode date (must NOT win over firstVideo.period)
              period: "2026-09-21",
              publishTime: 1673625600000,
              firstVideo: {
                tvId: 3493131456125200,
                period: "2023-01-14",
              },
            },
          });
        }
        if (
          request.url ===
          "https://pcw-api.iqiyi.com/albums/album/avlistinfo?aid=5328486914190101&page=1&size=50"
        ) {
          return jsonResponse(request.url, {
            code: "A00000",
            data: {
              total: 64,
              hasMore: true,
              epsodelist: makePageEpisodes(1, page1FeatureCount, true),
              updateprevuelist: [{ tvId: 888800000100, contentType: 3, name: "更新预告" }],
            },
          });
        }
        if (
          request.url ===
          "https://pcw-api.iqiyi.com/albums/album/avlistinfo?aid=5328486914190101&page=2&size=50"
        ) {
          return jsonResponse(request.url, {
            code: "A00000",
            data: {
              total: 64,
              hasMore: false,
              epsodelist: makePageEpisodes(51, page2FeatureCount, true),
            },
          });
        }
        throw new Error(`Unexpected request: ${request.url}`);
      },
    });

    const result = await iqiyiAdapter.fetchCollection("5328486914190101", outbound);
    expect(result.status).toBe("found");
    if (result.status !== "found") {
      return;
    }

    expect(result.info.namespace).toBe("iqiyi");
    expect(result.info.canonicalId).toBe("5328486914190101");
    expect(result.info.title).toBe("狂飙");
    expect(result.info.aliases).toContain("The Knockout");
    expect(result.info.year).toBe(2023);
    expect(result.info.mediaType).toBe("tv");
    expect(result.info.featureEpisodeCount).toBe(62);
    expect(result.info.featureEpisodes).toHaveLength(62);
    expect(result.info.featureEpisodes[0]).toMatchObject({
      index: 1,
      nativeEpisodeId: "3493131456000100",
      title: "第1集",
      durationSeconds: 2712,
      airDate: "2023-01-14",
    });
    expect(result.info.featureEpisodes[61]).toMatchObject({
      index: 62,
      nativeEpisodeId: "3493131456006200",
      title: "第62集",
    });
    expect(result.info.externalIds).toBeUndefined();
  });

  test("prefers firstVideo.period, falls back to CST publishTime, and returns null year/episodeCount when missing on TV", async () => {
    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        // Long-running anime: data.period is 2026-09-21, firstVideo.period is 1999-10-20
        if (request.url === "https://pcw-api.iqiyi.com/album/album/baseinfo/202861101") {
          return jsonResponse(request.url, {
            code: "A00000",
            data: {
              albumId: 202861101,
              name: "航海王",
              channelId: 4,
              period: "2026-09-21",
              publishTime: 940348800000,
              firstVideo: { period: "1999-10-20" },
            },
          });
        }
        if (
          request.url ===
          "https://pcw-api.iqiyi.com/albums/album/avlistinfo?aid=202861101&page=1&size=50"
        ) {
          return jsonResponse(request.url, {
            code: "A00000",
            data: {
              hasMore: false,
              epsodelist: [
                { tvId: 202861100, order: 1, name: "第1集", contentType: 1, duration: 1440 },
              ],
            },
          });
        }

        // Missing firstVideo.period -> falls back to publishTime (Jan 1 00:00 CST = 2022-12-31T16:00:00Z -> 2023!)
        if (request.url === "https://pcw-api.iqiyi.com/album/album/baseinfo/300000001") {
          return jsonResponse(request.url, {
            code: "A00000",
            data: {
              albumId: 300000001,
              name: "新年档综艺",
              channelId: 6,
              period: "2025-12-31",
              publishTime: 1672502400000, // 2023-01-01T00:00:00+08:00
            },
          });
        }
        if (
          request.url ===
          "https://pcw-api.iqiyi.com/albums/album/avlistinfo?aid=300000001&page=1&size=50"
        ) {
          return jsonResponse(request.url, {
            code: "A00000",
            data: {
              hasMore: false,
              epsodelist: [
                { tvId: 300000100, order: 1, name: "第1期", contentType: 1 },
                { tvId: 300000200, order: 2, name: "第2期", contentType: 1 },
              ],
            },
          });
        }

        // Missing BOTH firstVideo.period and publishTime (even though data.period exists!), plus trailer-only epsodelist
        if (request.url === "https://pcw-api.iqiyi.com/album/album/baseinfo/400000001") {
          return jsonResponse(request.url, {
            code: "A00000",
            data: {
              albumId: 400000001,
              name: "待播纪录片",
              channelId: 3,
              period: "2026-06-01",
            },
          });
        }
        if (
          request.url ===
          "https://pcw-api.iqiyi.com/albums/album/avlistinfo?aid=400000001&page=1&size=50"
        ) {
          return jsonResponse(request.url, {
            code: "A00000",
            data: {
              hasMore: false,
              epsodelist: [{ tvId: 400000100, order: 1, name: "先导预告", contentType: 3 }],
            },
          });
        }

        throw new Error(`Unexpected request: ${request.url}`);
      },
    });

    const onePiece = await iqiyiAdapter.fetchCollection("202861101", outbound);
    expect(onePiece).toMatchObject({
      status: "found",
      info: {
        title: "航海王",
        year: 1999,
        mediaType: "tv",
        featureEpisodeCount: 1,
      },
    });

    const variety = await iqiyiAdapter.fetchCollection("300000001", outbound);
    expect(variety).toMatchObject({
      status: "found",
      info: {
        title: "新年档综艺",
        year: 2023,
        mediaType: "tv",
        featureEpisodeCount: 2,
      },
    });

    const missingMetadata = await iqiyiAdapter.fetchCollection("400000001", outbound);
    expect(missingMetadata).toMatchObject({
      status: "found",
      info: {
        title: "待播纪录片",
        year: null,
        mediaType: "tv",
        featureEpisodeCount: null,
        featureEpisodes: [],
      },
    });
  });

  test("fetches movie metadata via video/video/baseinfo for 00-suffix IDs and A00001 album fallbacks", async () => {
    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        expect(request.kind).toBe("platform");
        expect(request.namespace).toBe("iqiyi");

        if (request.url === "https://pcw-api.iqiyi.com/video/video/baseinfo/923452300") {
          return jsonResponse(request.url, {
            code: "A00000",
            data: {
              tvId: 923452300,
              albumId: 923452300,
              name: "流浪地球",
              englishName: "The Wandering Earth",
              channelId: 1,
              period: "2019-02-05",
              publishTime: 1549296000000,
              videoCount: 1,
              contentType: 1,
              duration: 7500,
            },
          });
        }

        // Movie without period -> uses publishTime CST year
        if (request.url === "https://pcw-api.iqiyi.com/video/video/baseinfo/7292991076670500") {
          return jsonResponse(request.url, {
            code: "A00000",
            data: {
              tvId: 7292991076670500,
              albumId: 7292991076670500,
              name: "流浪地球2",
              channelId: 1,
              publishTime: 1674316800000, // 2023-01-22T00:00:00+08:00
              contentType: 1,
              duration: "02:53:00",
            },
          });
        }

        // Non-00 ID where album/baseinfo returns A00001 -> falls back to video/video/baseinfo
        if (request.url === "https://pcw-api.iqiyi.com/album/album/baseinfo/555555555") {
          return jsonResponse(request.url, {
            code: "A00001",
            data: "参数错误",
            errMsg: "album not found",
          });
        }
        if (request.url === "https://pcw-api.iqiyi.com/video/video/baseinfo/555555555") {
          return jsonResponse(request.url, {
            code: "A00000",
            data: {
              tvId: 555555555,
              albumId: 555555555,
              name: "特辑电影",
              channelId: 1,
              period: "2024-05-01",
              contentType: 1,
              duration: 5400,
            },
          });
        }

        // Single TV episode tvId ending in 00 whose albumId points to a different album -> not a collection
        if (request.url === "https://pcw-api.iqiyi.com/video/video/baseinfo/3493131456125200") {
          return jsonResponse(request.url, {
            code: "A00000",
            data: {
              tvId: 3493131456125200,
              albumId: 5328486914190101,
              name: "狂飙第1集",
              channelId: 2,
              period: "2023-01-14",
              contentType: 1,
            },
          });
        }

        // Movie missing release year and non-feature trailer contentType -> null year & null count
        if (request.url === "https://pcw-api.iqiyi.com/video/video/baseinfo/888888800") {
          return jsonResponse(request.url, {
            code: "A00000",
            data: {
              tvId: 888888800,
              albumId: 888888800,
              name: "未上映电影预告",
              channelId: 1,
              contentType: 3,
            },
          });
        }

        throw new Error(`Unexpected request: ${request.url}`);
      },
    });

    const movie = await iqiyiAdapter.fetchCollection("923452300", outbound);
    expect(movie).toMatchObject({
      status: "found",
      info: {
        namespace: "iqiyi",
        canonicalId: "923452300",
        title: "流浪地球",
        year: 2019,
        mediaType: "movie",
        featureEpisodeCount: 1,
        featureEpisodes: [
          {
            index: 1,
            nativeEpisodeId: "923452300",
            title: "流浪地球",
            durationSeconds: 7500,
            airDate: "2019-02-05",
          },
        ],
      },
    });
    if (movie.status === "found") {
      expect(movie.info.aliases).toContain("The Wandering Earth");
    }
    // 00-suffix movie goes directly to video/video/baseinfo without hitting album/album/baseinfo
    expect(
      outbound.httpRequests.some((r) => r.url.includes("album/album/baseinfo/923452300")),
    ).toBe(false);

    const movie2 = await iqiyiAdapter.fetchCollection("7292991076670500", outbound);
    expect(movie2).toMatchObject({
      status: "found",
      info: {
        title: "流浪地球2",
        year: 2023,
        mediaType: "movie",
        featureEpisodeCount: 1,
        featureEpisodes: [{ index: 1, durationSeconds: 10380 }],
      },
    });

    const fallbackMovie = await iqiyiAdapter.fetchCollection("555555555", outbound);
    expect(fallbackMovie).toMatchObject({
      status: "found",
      info: {
        canonicalId: "555555555",
        title: "特辑电影",
        year: 2024,
        mediaType: "movie",
        featureEpisodeCount: 1,
      },
    });

    const singleEpisodeId = await iqiyiAdapter.fetchCollection("3493131456125200", outbound);
    expect(singleEpisodeId).toMatchObject({
      status: "not_found",
      reason: "not_a_collection_id",
    });

    const movieTrailerOnly = await iqiyiAdapter.fetchCollection("888888800", outbound);
    expect(movieTrailerOnly).toMatchObject({
      status: "found",
      info: {
        title: "未上映电影预告",
        year: null,
        mediaType: "movie",
        featureEpisodeCount: null,
        featureEpisodes: [],
      },
    });
  });

  test("maps A00001 to not_found and 5xx/429/timeout/invalid-json/avlistinfo errors to transient_error", async () => {
    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        if (request.url.includes("/999999900")) {
          return jsonResponse(request.url, {
            code: "A00001",
            data: "参数错误",
            errMsg: "video not found",
          });
        }
        if (request.url.includes("/999999901")) {
          return jsonResponse(request.url, {
            code: "A00001",
            data: "参数错误",
            errMsg: "album not found",
          });
        }
        if (request.url.includes("/503000001")) {
          return { status: 503, headers: {}, body: "Service Unavailable", url: request.url };
        }
        if (request.url.includes("/429000000")) {
          return { status: 429, headers: {}, body: "Too Many Requests", url: request.url };
        }
        if (request.url.includes("/408000001")) {
          throw new Error("ETIMEDOUT connecting to pcw-api.iqiyi.com");
        }
        if (request.url.includes("/500100001")) {
          return jsonResponse(request.url, { code: "Q00304", errMsg: "busy" });
        }
        if (request.url.includes("/500200001")) {
          return { status: 200, headers: {}, body: "<html>blocked</html>", url: request.url };
        }
        if (request.url === "https://pcw-api.iqiyi.com/album/album/baseinfo/600000001") {
          return jsonResponse(request.url, {
            code: "A00000",
            data: {
              albumId: 600000001,
              name: "分页故障剧",
              channelId: 2,
              firstVideo: { period: "2024-01-01" },
            },
          });
        }
        if (
          request.url ===
          "https://pcw-api.iqiyi.com/albums/album/avlistinfo?aid=600000001&page=1&size=50"
        ) {
          return jsonResponse(request.url, {
            code: "A00000",
            data: {
              hasMore: true,
              epsodelist: [{ tvId: 600000100, order: 1, name: "第1集", contentType: 1 }],
            },
          });
        }
        if (
          request.url ===
          "https://pcw-api.iqiyi.com/albums/album/avlistinfo?aid=600000001&page=2&size=50"
        ) {
          return { status: 502, headers: {}, body: "Bad Gateway", url: request.url };
        }
        throw new Error(`Unexpected URL: ${request.url}`);
      },
    });

    expect((await iqiyiAdapter.fetchCollection("bad-id", outbound)).status).toBe("not_found");
    expect((await iqiyiAdapter.fetchCollection("999999900", outbound)).status).toBe("not_found");
    expect((await iqiyiAdapter.fetchCollection("999999901", outbound)).status).toBe("not_found");

    expect((await iqiyiAdapter.fetchCollection("503000001", outbound)).status).toBe(
      "transient_error",
    );
    expect((await iqiyiAdapter.fetchCollection("429000000", outbound)).status).toBe(
      "transient_error",
    );
    expect((await iqiyiAdapter.fetchCollection("408000001", outbound)).status).toBe(
      "transient_error",
    );
    expect((await iqiyiAdapter.fetchCollection("500100001", outbound)).status).toBe(
      "transient_error",
    );
    expect((await iqiyiAdapter.fetchCollection("500200001", outbound)).status).toBe(
      "transient_error",
    );
    expect((await iqiyiAdapter.fetchCollection("600000001", outbound)).status).toBe(
      "transient_error",
    );
  });
});

describe("iQIYI Tier 3 search (#30)", () => {
  test("searches search.video.iqiyi.com/o, filters siteId === 'iqiyi', maps TV & movie channels, parses releaseDate & itemTotalNumber, and deduplicates by canonicalId", async () => {
    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        expect(request.kind).toBe("platform");
        expect(request.namespace).toBe("iqiyi");
        expect(request.method).toBe("GET");

        const url = new URL(request.url);
        expect(url.origin + url.pathname).toBe("https://search.video.iqiyi.com/o");
        expect(url.searchParams.get("if")).toBe("html5");
        expect(url.searchParams.get("key")).toBe("流浪地球");
        expect(url.searchParams.get("pageNum")).toBe("1");
        expect(url.searchParams.get("pageSize")).toBe("10");
        expect(url.searchParams.get("site")).toBe("iqiyi");

        return jsonResponse(request.url, {
          code: "A00000",
          data: {
            code: 0,
            docinfos: [
              // Valid iQIYI movie (00-suffix)
              {
                qipu_id: 923452300,
                albumDocInfo: {
                  albumId: 923452300,
                  qipu_id: 923452300,
                  albumTitle: "流浪地球",
                  albumEnglishTitle: "The Wandering Earth",
                  channel: "电影,1",
                  releaseDate: "20190205",
                  itemTotalNumber: 1,
                  albumLink: "https://www.iqiyi.com/v_19rrfe142o.html",
                  siteId: "iqiyi",
                },
              },
              // Duplicate albumId -> must be deduplicated
              {
                qipu_id: 923452300,
                albumDocInfo: {
                  albumId: 923452300,
                  albumTitle: "流浪地球（重复）",
                  channel: "电影,1",
                  releaseDate: "20190205",
                  itemTotalNumber: 1,
                  siteId: "iqiyi",
                },
              },
              // Third-party siteId (qq / youku) -> must be excluded
              {
                qipu_id: 888888801,
                albumDocInfo: {
                  albumId: 888888801,
                  albumTitle: "流浪地球（腾讯站外）",
                  channel: "电影,1",
                  releaseDate: "20190205",
                  itemTotalNumber: 1,
                  siteId: "qq",
                },
              },
              // Valid iQIYI documentary TV series using qipu_id fallback
              {
                qipu_id: 4606537651261201,
                albumDocInfo: {
                  qipu_id: 4606537651261201,
                  albumTitle: "流浪地球 幕后纪录片",
                  channel: "纪录片,3",
                  releaseDate: "20250626",
                  itemTotalNumber: 10,
                  albumLink: "http://www.iqiyi.com/a_18schl0p4sd.html",
                  siteId: "iqiyi",
                },
              },
              // Valid iQIYI TV drama with parent docinfo qipu_id fallback
              {
                qipu_id: 5328486914190101,
                albumDocInfo: {
                  albumTitle: "狂飙",
                  albumEnglishTitle: "The Knockout",
                  channel: "电视剧,2",
                  releaseDate: "2023-01-14",
                  itemTotalNumber: "39",
                  albumLink: "https://www.iqiyi.com/a_1fkgtbddd2x.html",
                  siteId: "iqiyi",
                },
              },
              // Anime / Variety / Unrecognized channel + missing year & zero itemTotalNumber
              {
                albumDocInfo: {
                  albumId: 202861101,
                  albumTitle: "航海王",
                  channel: "动漫,4",
                  releaseDate: "19991020",
                  itemTotalNumber: 1100,
                  siteId: "iqiyi",
                },
              },
              {
                albumDocInfo: {
                  albumId: 300000001,
                  albumTitle: "快乐综艺",
                  channel: "综艺,6",
                  releaseDate: "",
                  itemTotalNumber: 0,
                  siteId: "iqiyi",
                },
              },
              {
                albumDocInfo: {
                  albumId: 2380527423901501,
                  albumTitle: "流浪地球解说",
                  channel: "原创,27",
                  releaseDate: "",
                  itemTotalNumber: 8,
                  siteId: "iqiyi",
                },
              },
              // Invalid albumId (too short / zero) -> must be skipped
              {
                albumDocInfo: {
                  albumId: 0,
                  albumTitle: "无效合集",
                  channel: "电视剧,2",
                  siteId: "iqiyi",
                },
              },
            ],
          },
        });
      },
    });

    if (!isTier3Adapter(iqiyiAdapter)) {
      throw new Error("Expected iqiyiAdapter to implement Tier 3 search");
    }

    const result = await iqiyiAdapter.search({ title: "流浪地球" }, outbound);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      return;
    }

    expect(outbound.httpRequests).toHaveLength(1);
    expect(result.candidates).toEqual([
      {
        canonicalId: "923452300",
        title: "流浪地球",
        originalTitle: "The Wandering Earth",
        year: 2019,
        mediaType: "movie",
        episodeCount: 1,
        url: "https://www.iqiyi.com/v_19rrfe142o.html",
      },
      {
        canonicalId: "4606537651261201",
        title: "流浪地球 幕后纪录片",
        year: 2025,
        mediaType: "tv",
        episodeCount: 10,
        url: "http://www.iqiyi.com/a_18schl0p4sd.html",
      },
      {
        canonicalId: "5328486914190101",
        title: "狂飙",
        originalTitle: "The Knockout",
        year: 2023,
        mediaType: "tv",
        episodeCount: 39,
        url: "https://www.iqiyi.com/a_1fkgtbddd2x.html",
      },
      {
        canonicalId: "202861101",
        title: "航海王",
        year: 1999,
        mediaType: "tv",
        episodeCount: 1100,
      },
      {
        canonicalId: "300000001",
        title: "快乐综艺",
        year: null,
        mediaType: "tv",
        episodeCount: null,
      },
      {
        canonicalId: "2380527423901501",
        title: "流浪地球解说",
        year: null,
        mediaType: null,
        episodeCount: 8,
      },
    ]);
  });

  test("maps empty search results and blank queries cleanly to { status: 'ok', candidates: [] } and respects page & limit", async () => {
    const emptyOutbound = createFakeOutboundClient({
      fetchExternal(request) {
        const url = new URL(request.url);
        const key = url.searchParams.get("key");
        if (key === "空数组") {
          return jsonResponse(request.url, {
            code: "A00000",
            data: { code: 0, docinfos: [] },
          });
        }
        if (key === "无docinfos字段") {
          // Empirically observed iQIYI empty-result envelope: code "A00000", data without docinfos/code
          return jsonResponse(request.url, {
            code: "A00000",
            data: { result_num: 0 },
          });
        }
        if (key === "nullData") {
          return jsonResponse(request.url, {
            code: "A00000",
            data: null,
          });
        }
        throw new Error(`Unexpected search query: ${key}`);
      },
    });

    // Blank query makes zero outbound requests
    expect(await iqiyiAdapter.search({ title: "   " }, emptyOutbound)).toEqual({
      status: "ok",
      candidates: [],
    });
    expect(emptyOutbound.httpRequests).toHaveLength(0);

    expect(await iqiyiAdapter.search({ title: "空数组" }, emptyOutbound)).toEqual({
      status: "ok",
      candidates: [],
    });
    expect(await iqiyiAdapter.search({ title: "无docinfos字段" }, emptyOutbound)).toEqual({
      status: "ok",
      candidates: [],
    });
    expect(await iqiyiAdapter.search({ title: "nullData" }, emptyOutbound)).toEqual({
      status: "ok",
      candidates: [],
    });

    const pagedOutbound = createFakeOutboundClient({
      fetchExternal(request) {
        const url = new URL(request.url);
        expect(url.searchParams.get("pageNum")).toBe("2");
        expect(url.searchParams.get("pageSize")).toBe("2");
        return jsonResponse(request.url, {
          code: "A00000",
          data: {
            code: 0,
            docinfos: [
              {
                albumDocInfo: {
                  albumId: 100000101,
                  albumTitle: "剧A",
                  channel: "电视剧,2",
                  releaseDate: "20240101",
                  itemTotalNumber: 24,
                  siteId: "iqiyi",
                },
              },
              {
                albumDocInfo: {
                  albumId: 100000201,
                  albumTitle: "剧B",
                  channel: "电视剧,2",
                  releaseDate: "20240201",
                  itemTotalNumber: 30,
                  siteId: "iqiyi",
                },
              },
              {
                albumDocInfo: {
                  albumId: 100000301,
                  albumTitle: "剧C",
                  channel: "电视剧,2",
                  releaseDate: "20240301",
                  itemTotalNumber: 12,
                  siteId: "iqiyi",
                },
              },
            ],
          },
        });
      },
    });

    const limited = await iqiyiAdapter.search({ title: "剧", page: 2, limit: 2 }, pagedOutbound);
    expect(limited.status).toBe("ok");
    if (limited.status === "ok") {
      expect(limited.candidates.map((c) => c.canonicalId)).toEqual(["100000101", "100000201"]);
    }
  });

  test("maps 5xx, 429 (with retry-after), timeouts, invalid JSON, non-A00000, and non-zero data.code to transient_error", async () => {
    const scenarios: Array<{
      label: string;
      handler: () => ExternalHttpResponse | Promise<ExternalHttpResponse>;
      expectedReasonPattern: RegExp;
      expectedRetryAfterMs?: number;
    }> = [
      {
        label: "http 503 upstream failure",
        handler: () => ({
          status: 503,
          headers: {},
          body: "Service Unavailable",
          url: "https://search.video.iqiyi.com/o",
        }),
        expectedReasonPattern: /503/,
      },
      {
        label: "http 429 rate limited with retry-after",
        handler: () => ({
          status: 429,
          headers: { "retry-after": "45" },
          body: "Too Many Requests",
          url: "https://search.video.iqiyi.com/o",
        }),
        expectedReasonPattern: /429/,
        expectedRetryAfterMs: 45_000,
      },
      {
        label: "network timeout",
        handler: async () => {
          throw new Error("ETIMEDOUT connecting to search.video.iqiyi.com");
        },
        expectedReasonPattern: /ETIMEDOUT/,
      },
      {
        label: "invalid JSON body",
        handler: () => ({
          status: 200,
          headers: { "content-type": "text/html" },
          body: "<html>gateway error</html>",
          url: "https://search.video.iqiyi.com/o",
        }),
        expectedReasonPattern: /invalid_json/,
      },
      {
        label: "non-A00000 top-level code",
        handler: () =>
          jsonResponse("https://search.video.iqiyi.com/o", {
            code: "Q00304",
            msg: "service busy",
          }),
        expectedReasonPattern: /Q00304/,
      },
      {
        label: "non-zero nested data.code",
        handler: () =>
          jsonResponse("https://search.video.iqiyi.com/o", {
            code: "A00000",
            data: { code: -1, docinfos: [] },
          }),
        expectedReasonPattern: /data_code_-1/,
      },
    ];

    for (const scenario of scenarios) {
      const outbound = createFakeOutboundClient({
        fetchExternal: scenario.handler,
      });
      const result = await iqiyiAdapter.search({ title: "狂飙" }, outbound);
      expect(result.status, scenario.label).toBe("transient_error");
      if (result.status === "transient_error") {
        expect(result.reason, scenario.label).toMatch(scenario.expectedReasonPattern);
        if (scenario.expectedRetryAfterMs !== undefined) {
          expect(result.retryAfterMs, scenario.label).toBe(scenario.expectedRetryAfterMs);
        }
      }
    }
  });

  test("variety: an album with no list episodes falls back to the signed source selector", async () => {
    const albumId = "2657274641350501";
    const item = (qipu: number, phase: string, title: string, mark = 0) => ({
      qipu_id: qipu,
      phase_title: phase,
      title,
      mark_type_show: mark,
      publish_date: "20250607",
    });
    let signed: URLSearchParams | null = null;
    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        const url = new URL(request.url);
        if (request.url === `https://pcw-api.iqiyi.com/album/album/baseinfo/${albumId}`) {
          return jsonResponse(request.url, {
            code: "A00000",
            data: {
              albumId: Number(albumId),
              name: "新说唱2025",
              channelId: 6,
              firstVideo: { tvId: 1920084229702900, period: "2025-06-07" },
            },
          });
        }
        if (url.pathname === "/albums/album/avlistinfo") {
          return jsonResponse(request.url, {
            code: "A00000",
            data: { epsodelist: [{ tvId: 8572445604693100, contentType: 28, name: "发布会" }] },
          });
        }
        if (url.pathname === "/prelw/tvg/v2/lw/base_info") {
          signed = url.searchParams;
          return jsonResponse(request.url, {
            status_code: 0,
            data: {
              template: {
                tabs: [
                  {
                    blocks: [
                      {
                        bk_id: "source_selector_bk",
                        data: {
                          data: [
                            { entity_id: 4016143587352901, videos: "https://mesh.if.iqiyi.com/x" },
                            {
                              entity_id: Number(albumId),
                              videos: [
                                {
                                  title: "2025",
                                  data: [
                                    item(1, "发布会", "明星制作人齐立FLAG"),
                                    item(2, "第1期上", "第1期上 超燃魔王秀"),
                                    item(3, "第1期下", "第1期下 莆田Rap"),
                                    item(4, "第1期纯享", "第1期纯享 说唱OG"),
                                    item(5, "第2期上", "下期预告", 17),
                                    item(6, "第2期上", "第2期上 锐评刘海哥"),
                                  ],
                                },
                              ],
                            },
                          ],
                        },
                      },
                    ],
                  },
                ],
              },
            },
          });
        }
        throw new Error(`Unexpected request: ${request.url}`);
      },
    });

    const result = await iqiyiAdapter.fetchCollection(albumId, outbound);
    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    expect(result.info.featureEpisodes).toEqual([
      {
        index: 1,
        nativeEpisodeId: "2",
        title: "第1期上",
        longTitle: "第1期上 超燃魔王秀",
        airDate: "2025-06-07",
      },
      {
        index: 2,
        nativeEpisodeId: "3",
        title: "第1期下",
        longTitle: "第1期下 莆田Rap",
        airDate: "2025-06-07",
      },
      {
        index: 3,
        nativeEpisodeId: "6",
        title: "第2期上",
        longTitle: "第2期上 锐评刘海哥",
        airDate: "2025-06-07",
      },
    ]);
    expect(signed!.get("entity_id")).toBe("1920084229702900");
    expect(signed!.get("sign")).toMatch(/^[0-9A-F]{32}$/);
  });
});
