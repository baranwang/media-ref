import { describe, expect, test } from "vite-plus/test";
import {
  createDefaultAdapterRegistry,
  createFakeOutboundClient,
  InvalidNativeIdError,
  isTier2Adapter,
  isTier3Adapter,
  mgtvAdapter,
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

function makeMgtvEpisodeItem(
  collectionId: string,
  videoId: number,
  options: {
    isIntact: "1" | "3";
    t1: string;
    t2?: string;
    t3?: string;
    ts?: string;
    time?: string;
  },
) {
  return {
    video_id: String(videoId),
    clip_id: collectionId,
    t1: options.t1,
    t2: options.t2 ?? "",
    t3: options.t3 ?? `第${options.t1}集`,
    ts: options.ts ?? "2023-01-03 20:00:00",
    time: options.time ?? "45:20",
    url: `/b/${collectionId}/${videoId}.html`,
    isIntact: options.isIntact,
    contentType: "0",
  };
}

describe("Mango TV (mgtv) Tier 1 & Tier 2 adapter", () => {
  test("parses and canonicalizes Mango TV URLs and bare collection_id without network calls", async () => {
    const outbound = createFakeOutboundClient();

    const collectionInputs = [
      "510924",
      "  510924  ",
      "https://www.mgtv.com/h/510924.html",
      "https://www.mgtv.com/h/510924.html/",
      "https://www.mgtv.com/h/510924.html?fpa=se&fpos=1#top",
      "https://m.mgtv.com/h/510924.html",
      "http://mgtv.com/h/510924.html",
      "https://www.mgtv.com/b/510924.html",
      "https://m.mgtv.com/b/510924.html?cxid=abc",
    ];

    for (const raw of collectionInputs) {
      expect(mgtvAdapter.parseInput(raw)).toEqual({
        kind: "collection",
        id: "510924",
        canonicalId: "510924",
      });
      expect(await mgtvAdapter.canonicalize(raw, outbound)).toBe("510924");
    }

    const videoUrlInputs = [
      "https://www.mgtv.com/b/510924/18030368.html",
      "https://www.mgtv.com/b/510924/18030368.html?fpa=1234&fpos=2",
      "https://m.mgtv.com/b/510924/18030368.html",
      "http://www.mgtv.com/b/510924/18030368.html#comments",
      "https://w.mgtv.com/b/510924/18030368.html",
    ];

    for (const raw of videoUrlInputs) {
      expect(mgtvAdapter.parseInput(raw)).toEqual({
        kind: "video",
        id: "18030368",
        canonicalId: "510924",
      });
      expect(await mgtvAdapter.canonicalize(raw, outbound)).toBe("510924");
    }

    expect(outbound.httpRequests).toHaveLength(0);
  });

  test("rejects non-Mango URLs, URLs without collection_id, and malformed IDs with InvalidNativeIdError", async () => {
    const outbound = createFakeOutboundClient();

    const invalidInputs = [
      "",
      "   ",
      "0",
      "0510924",
      "-510924",
      "mg510924",
      "ss34430",
      "not-a-valid-id",
      "https://www.mgtv.com/",
      "https://www.mgtv.com/h/",
      "https://www.mgtv.com/h/abc.html",
      "https://www.mgtv.com/h/0.html",
      "https://www.mgtv.com/b/",
      "https://www.mgtv.com/b/510924/18030368/extra.html",
      "https://www.mgtv.com/b/510924/notanumber.html",
      "https://www.mgtv.com/l/100001.html",
      "https://www.mgtv.com/s/18030368.html",
      "https://so.mgtv.com/so?k=%E5%8E%BB%E6%9C%89%E9%A3%8E%E7%9A%84%E5%9C%B0%E6%96%B9",
      "https://evil.example.com/h/510924.html",
      "https://evil.mgtv.com.attacker.test/b/510924/18030368.html",
      "https://www.bilibili.com/bangumi/play/ss34430",
      "https://v.qq.com/x/cover/mzc002007knmh3g.html",
      "ftp://www.mgtv.com/h/510924.html",
    ];

    for (const raw of invalidInputs) {
      expect(mgtvAdapter.parseInput(raw)).toBeNull();
      await expect(mgtvAdapter.canonicalize(raw, outbound)).rejects.toBeInstanceOf(
        InvalidNativeIdError,
      );
    }

    expect(outbound.httpRequests).toHaveLength(0);
  });

  test("registers mgtvAdapter as Tier 2 in the default adapter registry", () => {
    const registry = createDefaultAdapterRegistry();
    const mgtv = registry.get("mgtv");
    expect(mgtv).toBeDefined();
    expect(mgtv?.tier).toBe(2);
    expect(mgtv && isTier2Adapter(mgtv)).toBe(true);
    expect(mgtv && isTier3Adapter(mgtv)).toBe(false);
    expect(registry.listByMinTier(2).map((a) => a.namespace)).toContain("mgtv");
  });

  test("paginates episode/list, strictly filters isIntact === '1', and extracts year/type/title from video/info", async () => {
    // Recorded-style fixture modeled on 《去有风的地方》 (510924): 62 items across 2 pages = 40 feature + 22 previews
    const page1Items = [
      // Preview appears first in list to ensure we pick first isIntact === "1" video_id for video/info!
      makeMgtvEpisodeItem("510924", 18030001, {
        isIntact: "3",
        t1: "预告",
        t3: "去有风的地方 终极预告",
        time: "02:15",
      }),
      ...Array.from({ length: 35 }, (_, idx) =>
        makeMgtvEpisodeItem("510924", 18030368 + idx, {
          isIntact: "1",
          t1: String(idx + 1),
          t2: `分集副标题 ${idx + 1}`,
          t3: `去有风的地方 第${idx + 1}集`,
          ts: "2023-01-03 20:00:00",
          time: "45:20",
        }),
      ),
      ...Array.from({ length: 14 }, (_, idx) =>
        makeMgtvEpisodeItem("510924", 18039000 + idx, {
          isIntact: "3",
          t1: `预告${idx + 1}`,
          t3: `第${idx + 2}集预告`,
          time: "01:30",
        }),
      ),
    ];
    const page2Items = [
      ...Array.from({ length: 5 }, (_, idx) =>
        makeMgtvEpisodeItem("510924", 18030403 + idx, {
          isIntact: "1",
          t1: String(36 + idx),
          t2: `分集副标题 ${36 + idx}`,
          t3: `去有风的地方 第${36 + idx}集`,
          ts: "2023-01-27 20:00:00",
          time: "46:10",
        }),
      ),
      ...Array.from({ length: 7 }, (_, idx) =>
        makeMgtvEpisodeItem("510924", 18039100 + idx, {
          isIntact: "3",
          t1: `花絮${idx + 1}`,
          t3: `拍摄花絮 ${idx + 1}`,
          time: "03:00",
        }),
      ),
    ];

    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        expect(request.kind).toBe("platform");
        expect(request.namespace).toBe("mgtv");
        expect(request.headers?.referer).toBe("https://www.mgtv.com/");

        if (
          request.url ===
          "https://pcweb.api.mgtv.com/episode/list?collection_id=510924&page=1&size=50"
        ) {
          return jsonResponse(request.url, {
            code: 200,
            msg: "",
            data: {
              total: 40,
              count: 50,
              total_page: 2,
              info: { title: "去有风的地方", type: "电视剧" },
              list: page1Items,
            },
          });
        }

        if (
          request.url ===
          "https://pcweb.api.mgtv.com/episode/list?collection_id=510924&page=2&size=50"
        ) {
          return jsonResponse(request.url, {
            code: 200,
            msg: "",
            data: {
              total: 40,
              count: 12,
              total_page: 2,
              info: { title: "去有风的地方", type: "电视剧" },
              list: page2Items,
            },
          });
        }

        if (request.url === "https://pcweb.api.mgtv.com/video/info?cid=510924&vid=18030368") {
          return jsonResponse(request.url, {
            code: 200,
            msg: "",
            data: {
              info: {
                clipId: "510924",
                clipName: "去有风的地方",
                fstlvlId: "2",
                fstlvlType: "电视剧",
                detail: {
                  releaseTime: "2023-01-03",
                  updateInfo: "共40集，更新至40集",
                },
              },
            },
          });
        }

        throw new Error(`Unexpected request: ${request.url}`);
      },
    });

    const result = await mgtvAdapter.fetchCollection("510924", outbound);
    expect(result.status).toBe("found");
    if (result.status !== "found") {
      return;
    }

    expect(result.info.namespace).toBe("mgtv");
    expect(result.info.canonicalId).toBe("510924");
    expect(result.info.title).toBe("去有风的地方");
    expect(result.info.mediaType).toBe("tv");
    expect(result.info.year).toBe(2023);
    expect(result.info.featureEpisodeCount).toBe(40);
    expect(result.info.featureEpisodes).toHaveLength(40);
    expect(result.info.featureEpisodes[0]).toEqual({
      index: 1,
      nativeEpisodeId: "18030368",
      title: "1",
      longTitle: "分集副标题 1",
      durationSeconds: 2720,
      airDate: "2023-01-03",
    });
    expect(result.info.featureEpisodes[39]).toEqual({
      index: 40,
      nativeEpisodeId: "18030407",
      title: "40",
      longTitle: "分集副标题 40",
      durationSeconds: 2770,
      airDate: "2023-01-27",
    });
    expect(result.info.externalIds).toBeUndefined();
    expect(outbound.httpRequests).toHaveLength(3);
  });

  test("maps Mango TV fstlvlType for movies and TV categories (电视剧/动漫/综艺/纪录片)", async () => {
    const cases: Array<{
      cid: string;
      vid: string;
      clipName: string;
      fstlvlId: string;
      fstlvlType: string;
      releaseTime: string;
      expectedType: "movie" | "tv";
    }> = [
      {
        cid: "601001",
        vid: "21000001",
        clipName: "满江红",
        fstlvlId: "3",
        fstlvlType: "电影",
        releaseTime: "2023-01-22",
        expectedType: "movie",
      },
      {
        cid: "601002",
        vid: "21000002",
        clipName: "咒术回战",
        fstlvlId: "50",
        fstlvlType: "动漫",
        releaseTime: "2020-10-03",
        expectedType: "tv",
      },
      {
        cid: "601003",
        vid: "21000003",
        clipName: "声生不息",
        fstlvlId: "1",
        fstlvlType: "综艺",
        releaseTime: "2022-04-24",
        expectedType: "tv",
      },
      {
        cid: "601004",
        vid: "21000004",
        clipName: "守护解放西",
        fstlvlId: "51",
        fstlvlType: "纪录片",
        releaseTime: "2019-09-14",
        expectedType: "tv",
      },
    ];

    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        const url = new URL(request.url);
        if (url.pathname === "/episode/list") {
          const cid = url.searchParams.get("collection_id")!;
          const item = cases.find((c) => c.cid === cid)!;
          return jsonResponse(request.url, {
            code: 200,
            msg: "",
            data: {
              total: 1,
              count: 1,
              total_page: 1,
              info: { title: item.clipName, type: item.fstlvlType },
              list: [
                makeMgtvEpisodeItem(cid, Number(item.vid), {
                  isIntact: "1",
                  t1: "1",
                  t3: `${item.clipName} 正片`,
                }),
              ],
            },
          });
        }
        if (url.pathname === "/video/info") {
          const cid = url.searchParams.get("cid")!;
          const item = cases.find((c) => c.cid === cid)!;
          return jsonResponse(request.url, {
            code: 200,
            msg: "",
            data: {
              info: {
                clipId: cid,
                clipName: item.clipName,
                fstlvlId: item.fstlvlId,
                fstlvlType: item.fstlvlType,
                detail: { releaseTime: item.releaseTime },
              },
            },
          });
        }
        throw new Error(`Unexpected request: ${request.url}`);
      },
    });

    for (const c of cases) {
      const result = await mgtvAdapter.fetchCollection(c.cid, outbound);
      expect(result).toMatchObject({
        status: "found",
        info: {
          canonicalId: c.cid,
          title: c.clipName,
          mediaType: c.expectedType,
          year: Number(c.releaseTime.slice(0, 4)),
          featureEpisodeCount: 1,
        },
      });
    }
  });

  test("returns not_found when episode/list reports total=0, empty list, and empty info.title, or invalid canonicalId", async () => {
    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        if (request.url.includes("collection_id=999999999")) {
          return jsonResponse(request.url, {
            code: 200,
            msg: "",
            data: {
              total: 0,
              count: 0,
              total_page: 0,
              info: { title: "", type: "", desc: "" },
              list: [],
            },
          });
        }
        throw new Error(`Unexpected request: ${request.url}`);
      },
    });

    expect(await mgtvAdapter.fetchCollection("999999999", outbound)).toEqual({
      status: "not_found",
      reason: "mgtv_collection_not_found",
    });

    expect(await mgtvAdapter.fetchCollection("not-numeric", outbound)).toEqual({
      status: "not_found",
      reason: "invalid_canonical_id",
    });

    expect(outbound.httpRequests).toHaveLength(1);
  });

  test("returns transient_error on network timeout, 5xx, 403, invalid JSON, or mid-pagination / video/info failure", async () => {
    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        const url = new URL(request.url);
        const cid = url.searchParams.get("collection_id") ?? url.searchParams.get("cid");

        if (cid === "403000") {
          return { status: 403, headers: {}, body: '{"msg":"Forbidden"}', url: request.url };
        }
        if (cid === "503000") {
          return { status: 503, headers: {}, body: "Service Unavailable", url: request.url };
        }
        if (cid === "408000") {
          throw new Error("ETIMEDOUT connecting to pcweb.api.mgtv.com");
        }
        if (cid === "900001") {
          return { status: 200, headers: {}, body: "not-json", url: request.url };
        }
        if (cid === "502002") {
          if (url.pathname === "/episode/list" && url.searchParams.get("page") === "1") {
            return jsonResponse(request.url, {
              code: 200,
              msg: "",
              data: {
                total: 60,
                count: 50,
                total_page: 2,
                info: { title: "多页失败测试" },
                list: [makeMgtvEpisodeItem("502002", 770001, { isIntact: "1", t1: "1" })],
              },
            });
          }
          return { status: 502, headers: {}, body: "Bad Gateway", url: request.url };
        }
        if (cid === "500003") {
          if (url.pathname === "/episode/list") {
            return jsonResponse(request.url, {
              code: 200,
              msg: "",
              data: {
                total: 1,
                count: 1,
                total_page: 1,
                info: { title: "详情失败测试" },
                list: [makeMgtvEpisodeItem("500003", 770002, { isIntact: "1", t1: "1" })],
              },
            });
          }
          return { status: 500, headers: {}, body: "Internal Server Error", url: request.url };
        }

        throw new Error(`Unexpected request: ${request.url}`);
      },
    });

    for (const cid of ["403000", "503000", "408000", "900001", "502002", "500003"]) {
      const result = await mgtvAdapter.fetchCollection(cid, outbound);
      expect(result.status).toBe("transient_error");
    }
  });

  test("returns null year or null featureEpisodeCount (falling back to first list item vid) when metadata cannot be extracted", async () => {
    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        const url = new URL(request.url);
        const cid = url.searchParams.get("collection_id") ?? url.searchParams.get("cid");

        // Case 1: Only preview items (isIntact === "3") -> fallback to first list item vid for video/info, featureEpisodeCount: null
        if (cid === "701001") {
          if (url.pathname === "/episode/list") {
            return jsonResponse(request.url, {
              code: 200,
              msg: "",
              data: {
                total: 0,
                count: 2,
                total_page: 1,
                info: { title: "仅预告合集", type: "电视剧" },
                list: [
                  makeMgtvEpisodeItem("701001", 880001, { isIntact: "3", t1: "预告1" }),
                  makeMgtvEpisodeItem("701001", 880002, { isIntact: "3", t1: "预告2" }),
                ],
              },
            });
          }
          if (url.pathname === "/video/info" && url.searchParams.get("vid") === "880001") {
            return jsonResponse(request.url, {
              code: 200,
              msg: "",
              data: {
                info: {
                  clipId: "701001",
                  clipName: "仅预告合集",
                  fstlvlId: "2",
                  fstlvlType: "电视剧",
                  detail: { releaseTime: "2024-05-01" },
                },
              },
            });
          }
        }

        // Case 2: Feature episodes present, but releaseTime missing/empty -> year: null
        if (cid === "701002") {
          if (url.pathname === "/episode/list") {
            return jsonResponse(request.url, {
              code: 200,
              msg: "",
              data: {
                total: 1,
                count: 1,
                total_page: 1,
                info: { title: "缺年份合集", type: "电视剧" },
                list: [makeMgtvEpisodeItem("701002", 880010, { isIntact: "1", t1: "1" })],
              },
            });
          }
          if (url.pathname === "/video/info" && url.searchParams.get("vid") === "880010") {
            return jsonResponse(request.url, {
              code: 200,
              msg: "",
              data: {
                info: {
                  clipId: "701002",
                  clipName: "缺年份合集",
                  fstlvlId: "2",
                  fstlvlType: "电视剧",
                  detail: { releaseTime: "" },
                },
              },
            });
          }
        }

        // Case 3: Collection exists (info.title present) but empty list -> year: null, featureEpisodeCount: null, no video/info call
        if (cid === "701003" && url.pathname === "/episode/list") {
          return jsonResponse(request.url, {
            code: 200,
            msg: "",
            data: {
              total: 0,
              count: 0,
              total_page: 1,
              info: { title: "空列表合集", type: "电视剧" },
              list: [],
            },
          });
        }

        throw new Error(`Unexpected request: ${request.url}`);
      },
    });

    const previewOnly = await mgtvAdapter.fetchCollection("701001", outbound);
    expect(previewOnly).toMatchObject({
      status: "found",
      info: {
        canonicalId: "701001",
        title: "仅预告合集",
        mediaType: "tv",
        year: 2024,
        featureEpisodeCount: null,
        featureEpisodes: [],
      },
    });

    const missingYear = await mgtvAdapter.fetchCollection("701002", outbound);
    expect(missingYear).toMatchObject({
      status: "found",
      info: {
        canonicalId: "701002",
        title: "缺年份合集",
        mediaType: "tv",
        year: null,
        featureEpisodeCount: 1,
      },
    });

    const emptyList = await mgtvAdapter.fetchCollection("701003", outbound);
    expect(emptyList).toMatchObject({
      status: "found",
      info: {
        canonicalId: "701003",
        title: "空列表合集",
        mediaType: "tv",
        year: null,
        featureEpisodeCount: null,
        featureEpisodes: [],
      },
    });
  });
});
