import { describe, expect, test } from "vite-plus/test";
import {
  createDefaultAdapterRegistry,
  createFakeOutboundClient,
  createLiveOutboundClient,
  InvalidNativeIdError,
  isTier2Adapter,
  isTier3Adapter,
  parseTencentInput,
  tencentAdapter,
  type ExternalHttpResponse,
} from "../src/index.ts";

const TENCENT_PAGE_DATA_URL =
  "https://pbaccess.video.qq.com/trpc.universal_backend_service.page_server_rpc.PageServer/GetPageData?video_appid=3000010&vplatform=2";

function jsonResponse(url: string, payload: unknown, status = 200): ExternalHttpResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
    url,
  };
}

function makeIntroPayload(itemParams: Record<string, unknown>) {
  return {
    ret: 0,
    msg: "",
    data: {
      module_list_datas: [
        {
          module_datas: [
            {
              item_data_lists: {
                item_datas: [{ item_params: itemParams }],
              },
            },
          ],
        },
      ],
    },
  };
}

function makeEpisodePagePayload(
  items: Array<Record<string, unknown>>,
  tabs?: Array<Record<string, unknown>> | string,
) {
  return {
    ret: 0,
    msg: "",
    data: {
      module_list_datas: [
        {
          module_datas: [
            {
              module_params:
                tabs === undefined
                  ? {}
                  : { tabs: typeof tabs === "string" ? tabs : JSON.stringify(tabs) },
              item_data_lists: {
                item_datas: items.map((item_params) => ({ item_params })),
              },
            },
          ],
        },
      ],
    },
  };
}

describe("Tencent Video Tier 1 & Tier 2 adapter (#13)", () => {
  test("parses and canonicalizes bare cid and all standard Tencent Video collection URLs without network calls", async () => {
    const outbound = createFakeOutboundClient();

    const validInputs = [
      "mzc00200mp8vo9b",
      "  mzc00200mp8vo9b  ",
      "https://v.qq.com/x/cover/mzc00200mp8vo9b.html",
      "https://v.qq.com/x/cover/mzc00200mp8vo9b.html?ptag=10523#comments",
      "https://v.qq.com/x/cover/mzc00200mp8vo9b",
      "https://v.qq.com/x/cover/mzc00200mp8vo9b/u0045abc123.html",
      "https://v.qq.com/x/cover/mzc00200mp8vo9b/u0045abc123.html?ptag=2_7.8",
      "https://v.qq.com/detail/m/mzc00200mp8vo9b.html",
      "https://v.qq.com/detail/x/mzc00200mp8vo9b.html?from=bangumi",
      "https://m.v.qq.com/x/m/play?cid=mzc00200mp8vo9b",
      "https://m.v.qq.com/x/m/play?vid=u0045abc123&cid=mzc00200mp8vo9b&ptag=1",
      "https://m.v.qq.com/play.html?cid=mzc00200mp8vo9b&vid=u0045abc123",
      "https://m.v.qq.com/cover/m/mzc00200mp8vo9b.html",
      "https://m.v.qq.com/cover/m/mzc00200mp8vo9b/u0045abc123.html",
      "https://m.v.qq.com/cover/mzc00200mp8vo9b.html",
      "https://m.v.qq.com/x/cover/mzc00200mp8vo9b/u0045abc123.html",
      "http://v.qq.com/x/cover/mzc00200mp8vo9b.html",
    ];

    for (const raw of validInputs) {
      expect(parseTencentInput(raw)).toEqual({
        kind: "cover",
        id: "mzc00200mp8vo9b",
        canonicalId: "mzc00200mp8vo9b",
      });
      expect(await tencentAdapter.canonicalize(raw, outbound)).toBe("mzc00200mp8vo9b");
    }

    // Numeric-starting 15-char cid also supported
    expect(
      await tencentAdapter.canonicalize("https://v.qq.com/detail/5/53q0eh78q97e4d1.html", outbound),
    ).toBe("53q0eh78q97e4d1");

    expect(outbound.httpRequests).toHaveLength(0);
  });

  test("rejects video-only x/page URLs, non-Tencent URLs, and malformed IDs with InvalidNativeIdError", async () => {
    const outbound = createFakeOutboundClient();

    const invalidInputs = [
      "",
      "   ",
      "mzc00200", // too short
      "mzc00200mp8vo9bx", // 16 chars (too long)
      "MZC00200MP8VO9B", // uppercase not canonical
      "mzc00200_mp8vo9", // non-alphanumeric
      "ss34430",
      "https://v.qq.com/x/page/u0045abc123.html",
      "https://v.qq.com/x/page/u0045abc123.html?cid=mzc00200mp8vo9b",
      "https://m.v.qq.com/x/m/play?vid=u0045abc123",
      "https://m.v.qq.com/x/m/play?cid=short",
      "https://v.qq.com/x/cover/mzc00200mp8vo9b/u0045abc123/extra.html",
      "https://v.qq.com/detail/ab/mzc00200mp8vo9b.html",
      "https://evil.v.qq.com/x/cover/mzc00200mp8vo9b.html",
      "https://v.qq.com.evil.com/x/cover/mzc00200mp8vo9b.html",
      "https://www.bilibili.com/bangumi/play/ss34430",
      "ftp://v.qq.com/x/cover/mzc00200mp8vo9b.html",
      "not-a-valid-id",
    ];

    for (const raw of invalidInputs) {
      expect(tencentAdapter.parseInput(raw)).toBeNull();
      await expect(tencentAdapter.canonicalize(raw, outbound)).rejects.toBeInstanceOf(
        InvalidNativeIdError,
      );
    }

    expect(outbound.httpRequests).toHaveLength(0);
  });

  test("registers tencentAdapter at Tier 2 in the default adapter registry", () => {
    const registry = createDefaultAdapterRegistry();
    const tencent = registry.get("tencent");
    expect(tencent).toBeDefined();
    expect(tencent?.tier).toBe(2);
    expect(tencent && isTier2Adapter(tencent)).toBe(true);
    expect(tencent && isTier3Adapter(tencent)).toBe(false);
    expect(registry.listByMinTier(2).map((a) => a.namespace)).toContain("tencent");
    expect(registry.listByMinTier(3).map((a) => a.namespace)).not.toContain("tencent");
  });

  test("fetches TV collection metadata and strictly excludes trailers and bonus 彩蛋 clips from feature episodes", async () => {
    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        expect(request.kind).toBe("platform");
        expect(request.namespace).toBe("tencent");
        expect(request.method).toBe("POST");
        expect(request.url).toBe(TENCENT_PAGE_DATA_URL);

        const body = JSON.parse(request.body ?? "{}") as {
          page_params?: { page_id?: string; cid?: string };
        };
        expect(body.page_params?.cid).toBe("mzc002007knmh3g");

        if (body.page_params?.page_id === "detail_page_introduction") {
          return jsonResponse(
            request.url,
            makeIntroPayload({
              title: "三体",
              year: "2023",
              type: "2",
              type_name: "电视剧",
              episode_all: "30",
              main_genres: "科幻 悬疑",
              area_name: "中国大陆",
            }),
          );
        }

        if (body.page_params?.page_id === "vsite_episode_list") {
          const items: Array<Record<string, unknown>> = [];
          for (let i = 1; i <= 30; i += 1) {
            const padded = String(i).padStart(2, "0");
            items.push({
              vid: `v0045ep${padded}`,
              cid: "mzc002007knmh3g",
              title: String(i),
              c_title_output: padded,
              play_title: `三体 第${padded}集`,
              is_trailer: "0",
              duration: "2700",
              publish_date: "2023-01-15",
            });
          }
          // Bonus 彩蛋 clips carry is_trailer === "0" on Tencent Video and MUST be excluded!
          for (let j = 1; j <= 10; j += 1) {
            items.push({
              vid: `b0045egg${j}`,
              cid: "mzc002007knmh3g",
              title: `彩蛋${j}`,
              c_title_output: `彩蛋${j}`,
              play_title: `三体 彩蛋${j}`,
              is_trailer: "0",
              duration: "180",
            });
          }
          // Trailers carry is_trailer === "1" even when title looks numeric
          items.push({
            vid: "t0045tr31",
            cid: "mzc002007knmh3g",
            title: "31",
            c_title_output: "31",
            play_title: "三体 第31集预告",
            is_trailer: "1",
            duration: "60",
          });
          return jsonResponse(request.url, makeEpisodePagePayload(items));
        }

        throw new Error(`Unexpected page_id: ${body.page_params?.page_id}`);
      },
    });

    const result = await tencentAdapter.fetchCollection("mzc002007knmh3g", outbound);
    expect(result.status).toBe("found");
    if (result.status !== "found") {
      return;
    }

    expect(result.info.namespace).toBe("tencent");
    expect(result.info.canonicalId).toBe("mzc002007knmh3g");
    expect(result.info.title).toBe("三体");
    expect(result.info.year).toBe(2023);
    expect(result.info.mediaType).toBe("tv");
    expect(result.info.featureEpisodeCount).toBe(30);
    expect(result.info.featureEpisodes).toHaveLength(30);
    expect(result.info.featureEpisodes[0]).toEqual({
      index: 1,
      nativeEpisodeId: "v0045ep01",
      title: "01",
      longTitle: "三体 第01集",
      durationSeconds: 2700,
      airDate: "2023-01-15",
    });
    expect(result.info.featureEpisodes[29]?.index).toBe(30);
    expect(result.info.featureEpisodes[29]?.nativeEpisodeId).toBe("v0045ep30");
    expect(result.info.externalIds).toBeUndefined();
    expect(outbound.httpRequests).toHaveLength(2);
  });

  test("maps Tencent movie and TV category labels/codes accurately (电影 -> movie; 电视剧/动漫/综艺/纪录片 -> tv)", async () => {
    const cases: Array<{
      cid: string;
      intro: Record<string, unknown>;
      episodes: Array<Record<string, unknown>>;
      expectedType: "movie" | "tv";
      expectedYear: number;
      expectedCount: number;
    }> = [
      {
        cid: "mzc00200movie01",
        intro: { title: "流浪地球2", cover_year: "2023", type: "电影", episode_all: "1" },
        episodes: [
          {
            vid: "m0045main01",
            title: "正片",
            c_title_output: "正片",
            play_title: "流浪地球2",
            is_trailer: "0",
            duration: "10380",
          },
          {
            vid: "m0045tr0001",
            title: "终极预告",
            is_trailer: "1",
            duration: "120",
          },
          {
            vid: "m0045egg001",
            title: "彩蛋1",
            is_trailer: "0",
            duration: "90",
          },
        ],
        expectedType: "movie",
        expectedYear: 2023,
        expectedCount: 1,
      },
      {
        cid: "mzc00200movie02",
        intro: { title: "搏击俱乐部", show_year: "1999", type: "1" },
        episodes: [{ vid: "m0045fc0001", title: "搏击俱乐部", is_trailer: "0", duration: "8340" }],
        expectedType: "movie",
        expectedYear: 1999,
        expectedCount: 1,
      },
      {
        cid: "mzc00200anime03",
        intro: { title: "斗罗大陆", year: "2018", type: "动漫" },
        episodes: [
          { vid: "a001", title: "1", c_title_output: "01", is_trailer: "0" },
          { vid: "a002", title: "2", c_title_output: "02", is_trailer: "0" },
        ],
        expectedType: "tv",
        expectedYear: 2018,
        expectedCount: 2,
      },
      {
        cid: "mzc00200varie04",
        intro: { title: "脱口秀大会", year: "2022", type: "综艺" },
        episodes: [{ vid: "z001", title: "1", is_trailer: "0" }],
        expectedType: "tv",
        expectedYear: 2022,
        expectedCount: 1,
      },
      {
        cid: "mzc00200docum05",
        intro: { title: "风味人间", year: "2018", type: "纪录片" },
        episodes: [{ vid: "d001", title: "1", is_trailer: "0" }],
        expectedType: "tv",
        expectedYear: 2018,
        expectedCount: 1,
      },
    ];

    const byCid = new Map(cases.map((c) => [c.cid, c]));
    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        const body = JSON.parse(request.body ?? "{}") as {
          page_params?: { page_id?: string; cid?: string };
        };
        const item = byCid.get(body.page_params?.cid ?? "");
        if (!item) {
          throw new Error(`Unexpected cid: ${body.page_params?.cid}`);
        }
        if (body.page_params?.page_id === "detail_page_introduction") {
          return jsonResponse(request.url, makeIntroPayload(item.intro));
        }
        return jsonResponse(request.url, makeEpisodePagePayload(item.episodes));
      },
    });

    for (const testCase of cases) {
      const result = await tencentAdapter.fetchCollection(testCase.cid, outbound);
      expect(result.status).toBe("found");
      if (result.status === "found") {
        expect(result.info.mediaType).toBe(testCase.expectedType);
        expect(result.info.year).toBe(testCase.expectedYear);
        expect(result.info.featureEpisodeCount).toBe(testCase.expectedCount);
      }
    }
  });

  test("paginates multi-tab episode lists via module_params.tabs[].page_context and deduplicates/filters across pages", async () => {
    const requestedContexts: string[] = [];
    const tabs = [
      { begin: "1", end: "30", selected: true, page_context: "ctx_page_1_30" },
      { begin: "31", end: "60", selected: false, page_context: "ctx_page_31_60" },
      { begin: "61", end: "75", selected: false, page_context: "ctx_page_61_75" },
    ];

    const makeRange = (start: number, end: number) => {
      const list: Array<Record<string, unknown>> = [];
      for (let i = start; i <= end; i += 1) {
        list.push({
          vid: `dl_ep_${String(i).padStart(3, "0")}`,
          cid: "m441e3rjq9kwpsc",
          title: String(i),
          c_title_output: String(i),
          play_title: `斗罗大陆 第${i}集`,
          is_trailer: "0",
          duration: "1200",
        });
      }
      return list;
    };

    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        const body = JSON.parse(request.body ?? "{}") as {
          page_params?: { page_id?: string; page_context?: string };
        };

        if (body.page_params?.page_id === "detail_page_introduction") {
          return jsonResponse(
            request.url,
            makeIntroPayload({
              title: "斗罗大陆",
              year: "2018",
              type: "3",
              episode_all: "75",
            }),
          );
        }

        if (body.page_params?.page_id === "vsite_episode_list") {
          const ctx = body.page_params.page_context ?? "";
          requestedContexts.push(ctx);
          if (ctx === "") {
            return jsonResponse(
              request.url,
              makeEpisodePagePayload(
                [...makeRange(1, 30), { vid: "dl_egg_1", title: "彩蛋1", is_trailer: "0" }],
                tabs,
              ),
            );
          }
          if (ctx === "ctx_page_31_60") {
            return jsonResponse(
              request.url,
              makeEpisodePagePayload(
                [
                  // Deliberately include one duplicate vid from page 1 to verify dedup
                  {
                    vid: "dl_ep_030",
                    title: "30",
                    c_title_output: "30",
                    is_trailer: "0",
                  },
                  ...makeRange(31, 60),
                  { vid: "dl_trailer_61", title: "61", is_trailer: "1" },
                ],
                tabs,
              ),
            );
          }
          if (ctx === "ctx_page_61_75") {
            return jsonResponse(
              request.url,
              makeEpisodePagePayload(
                [
                  ...makeRange(61, 75),
                  { vid: "dl_bonus_final", title: "花絮特辑", is_trailer: "0" },
                ],
                tabs,
              ),
            );
          }
          throw new Error(`Unexpected page_context: ${ctx}`);
        }

        throw new Error(`Unexpected page_id: ${body.page_params?.page_id}`);
      },
    });

    const result = await tencentAdapter.fetchCollection("m441e3rjq9kwpsc", outbound);
    expect(result.status).toBe("found");
    if (result.status !== "found") {
      return;
    }

    expect(requestedContexts).toEqual(["", "ctx_page_31_60", "ctx_page_61_75"]);
    expect(result.info.featureEpisodeCount).toBe(75);
    expect(result.info.featureEpisodes).toHaveLength(75);
    expect(result.info.featureEpisodes[0]?.index).toBe(1);
    expect(result.info.featureEpisodes[0]?.nativeEpisodeId).toBe("dl_ep_001");
    expect(result.info.featureEpisodes[74]?.index).toBe(75);
    expect(result.info.featureEpisodes[74]?.nativeEpisodeId).toBe("dl_ep_075");
  });

  test("returns not_found on empty module_list_datas and transient_error on network, 5xx, invalid JSON, non-zero RPC ret, or mid-pagination error", async () => {
    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        const body = JSON.parse(request.body ?? "{}") as {
          page_params?: { page_id?: string; cid?: string; page_context?: string };
        };
        const cid = body.page_params?.cid ?? "";

        if (cid === "mzc00200zzzzzzz") {
          return jsonResponse(request.url, {
            ret: 0,
            msg: "",
            data: { module_list_datas: [] },
          });
        }
        if (cid === "mzc00200err5030") {
          return { status: 503, headers: {}, body: "Service Unavailable", url: request.url };
        }
        if (cid === "mzc00200errjson") {
          return { status: 200, headers: {}, body: "<html>gateway error</html>", url: request.url };
        }
        if (cid === "mzc00200errrpc1") {
          return jsonResponse(request.url, { ret: 10401, msg: "unknow error." });
        }
        if (cid === "mzc00200timeout") {
          throw new Error("ETIMEDOUT connecting to pbaccess.video.qq.com");
        }
        if (cid === "mzc00200pageerr") {
          if (body.page_params?.page_id === "detail_page_introduction") {
            return jsonResponse(
              request.url,
              makeIntroPayload({ title: "长剧集", year: "2024", type: "2" }),
            );
          }
          if (body.page_params?.page_context === "") {
            return jsonResponse(
              request.url,
              makeEpisodePagePayload(
                [{ vid: "p1", title: "1", is_trailer: "0" }],
                [
                  { begin: "1", end: "30", selected: true, page_context: "ctx1" },
                  { begin: "31", end: "60", selected: false, page_context: "ctx2" },
                ],
              ),
            );
          }
          return { status: 502, headers: {}, body: "Bad Gateway", url: request.url };
        }

        throw new Error(`Unexpected cid: ${cid}`);
      },
    });

    const missing = await tencentAdapter.fetchCollection("mzc00200zzzzzzz", outbound);
    expect(missing.status).toBe("not_found");
    // Should not call vsite_episode_list after detail_page_introduction reports not_found
    expect(outbound.httpRequests).toHaveLength(1);

    expect((await tencentAdapter.fetchCollection("mzc00200err5030", outbound)).status).toBe(
      "transient_error",
    );
    expect((await tencentAdapter.fetchCollection("mzc00200errjson", outbound)).status).toBe(
      "transient_error",
    );
    expect((await tencentAdapter.fetchCollection("mzc00200errrpc1", outbound)).status).toBe(
      "transient_error",
    );
    expect((await tencentAdapter.fetchCollection("mzc00200timeout", outbound)).status).toBe(
      "transient_error",
    );
    // Mid-pagination failure MUST return transient_error rather than partial featureEpisodes!
    expect((await tencentAdapter.fetchCollection("mzc00200pageerr", outbound)).status).toBe(
      "transient_error",
    );
  });

  test("returns null year and null featureEpisodeCount when missing or trailer-only so Evidence Gate routes to needs_review", async () => {
    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        const body = JSON.parse(request.body ?? "{}") as {
          page_params?: { page_id?: string; cid?: string };
        };
        const cid = body.page_params?.cid ?? "";

        if (cid === "mzc00200noyear1") {
          if (body.page_params?.page_id === "detail_page_introduction") {
            return jsonResponse(
              request.url,
              makeIntroPayload({ title: "三体", year: "未知", type: "2" }),
            );
          }
          return jsonResponse(
            request.url,
            makeEpisodePagePayload([{ vid: "v1", title: "1", is_trailer: "0" }]),
          );
        }

        if (cid === "mzc00200noeps01") {
          if (body.page_params?.page_id === "detail_page_introduction") {
            return jsonResponse(
              request.url,
              makeIntroPayload({ title: "三体", year: "2023", type: "2", episode_all: "30" }),
            );
          }
          // Only trailers and bonus clips — zero confirmed feature episodes
          return jsonResponse(
            request.url,
            makeEpisodePagePayload([
              { vid: "tr1", title: "1", is_trailer: "1" },
              { vid: "egg1", title: "彩蛋1", is_trailer: "0" },
            ]),
          );
        }

        throw new Error(`Unexpected cid: ${cid}`);
      },
    });

    const noYear = await tencentAdapter.fetchCollection("mzc00200noyear1", outbound);
    expect(noYear.status).toBe("found");
    if (noYear.status === "found") {
      expect(noYear.info.year).toBeNull();
      expect(noYear.info.featureEpisodeCount).toBe(1);
    }

    const noEps = await tencentAdapter.fetchCollection("mzc00200noeps01", outbound);
    expect(noEps.status).toBe("found");
    if (noEps.status === "found") {
      expect(noEps.info.year).toBe(2023);
      expect(noEps.info.featureEpisodeCount).toBeNull();
      expect(noEps.info.featureEpisodes).toEqual([]);
    }
  });

  test("routes outbound requests through per-namespace proxy configuration when enabled", async () => {
    const seenUrls: string[] = [];
    const seenHeaders: Array<Record<string, string>> = [];

    const liveWithProxy = createLiveOutboundClient({
      proxyConfig: {
        tencent: {
          mode: "proxy",
          proxyBaseUrl: "https://cn-proxy.mediaref.internal/forward",
          headers: { "x-proxy-token": "tencent-proxy-secret" },
        },
      },
      async fetchImpl(input, init) {
        const urlStr =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        seenUrls.push(urlStr);
        seenHeaders.push((init?.headers as Record<string, string>) ?? {});
        const bodyText = typeof init?.body === "string" ? init.body : "{}";
        const body = JSON.parse(bodyText) as {
          page_params?: { page_id?: string };
        };
        const payload =
          body.page_params?.page_id === "detail_page_introduction"
            ? makeIntroPayload({ title: "三体", year: "2023", type: "2" })
            : makeEpisodePagePayload([{ vid: "v1", title: "1", is_trailer: "0" }]);
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const result = await tencentAdapter.fetchCollection("mzc002007knmh3g", liveWithProxy);
    expect(result.status).toBe("found");
    expect(seenUrls).toHaveLength(2);
    for (const urlStr of seenUrls) {
      const parsed = new URL(urlStr);
      expect(parsed.origin).toBe("https://cn-proxy.mediaref.internal");
      expect(parsed.searchParams.get("url")).toBe(TENCENT_PAGE_DATA_URL);
    }
    for (const headers of seenHeaders) {
      expect(headers["x-proxy-token"]).toBe("tencent-proxy-secret");
    }
  });

  test("variety: keeps 第N期 broadcast parts (non-numeric titles) and drops extras", async () => {
    const titles = [
      "先导片：喜人超前集结！",
      "第1期上：喜人初亮相",
      "第1期下：高圆圆落泪",
      "第1期纯享版：《小品的世界》",
      "第1期陪看：唱嗨全场",
      "第2期上：高能预警！",
      "第2期下：《八十一难》",
    ];
    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        const body = JSON.parse(request.body ?? "{}") as { page_params?: { page_id?: string } };
        if (body.page_params?.page_id === "detail_page_introduction") {
          return jsonResponse(
            request.url,
            makeIntroPayload({ title: "喜人奇妙夜", year: "2024", type: "10", type_name: "综艺" }),
          );
        }
        return jsonResponse(
          request.url,
          makeEpisodePagePayload(
            titles.map((title, i) => ({
              vid: `v${i}`,
              title,
              c_title_output: title,
              play_title: title,
              is_trailer: "0",
              publish_date: "2024-06-28",
            })),
          ),
        );
      },
    });

    const result = await tencentAdapter.fetchCollection("mzc00200vyot3cs", outbound);
    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    expect(result.info.featureEpisodes.map((e) => [e.index, e.title])).toEqual([
      [1, "第1期上：喜人初亮相"],
      [2, "第1期下：高圆圆落泪"],
      [3, "第2期上：高能预警！"],
      [4, "第2期下：《八十一难》"],
    ]);
    expect(result.info.featureEpisodeCount).toBe(4);
  });

  test("follows cursor pagination via module_params.has_next and next_page_context when tabs are absent", async () => {
    const requestedContexts: string[] = [];
    const makeBroadcastItems = (startPeriod: number, endPeriod: number) => {
      const items: Array<Record<string, unknown>> = [];
      for (let p = startPeriod; p <= endPeriod; p += 1) {
        for (const part of ["上", "下"]) {
          items.push({
            vid: `v_p${p}_${part}`,
            title: `第${p}期${part}`,
            c_title_output: `第${p}期${part}`,
            play_title: `第${p}期${part}`,
            is_trailer: "0",
            publish_date: `2025-11-${String(p).padStart(2, "0")}`,
          });
        }
      }
      return items;
    };
    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        const body = JSON.parse(request.body ?? "{}") as {
          page_params?: { page_id?: string; page_context?: string };
        };
        if (body.page_params?.page_id === "detail_page_introduction") {
          return jsonResponse(
            request.url,
            makeIntroPayload({ title: "现在就出发", year: "2025", type: "10", type_name: "综艺" }),
          );
        }
        const ctx = body.page_params?.page_context ?? "";
        requestedContexts.push(ctx);
        if (ctx === "") {
          return jsonResponse(request.url, {
            ret: 0,
            msg: "",
            data: {
              module_list_datas: [
                {
                  module_datas: [
                    {
                      module_params: { has_next: "1", next_page_context: "cursor_2" },
                      item_data_lists: {
                        item_datas: makeBroadcastItems(1, 6).map((item_params) => ({
                          item_params,
                        })),
                      },
                    },
                  ],
                },
              ],
            },
          });
        }
        if (ctx === "cursor_2") {
          return jsonResponse(request.url, {
            ret: 0,
            msg: "",
            data: {
              module_list_datas: [
                {
                  module_datas: [
                    {
                      module_params: { has_next: "0", next_page_context: "" },
                      item_data_lists: {
                        item_datas: makeBroadcastItems(7, 10).map((item_params) => ({
                          item_params,
                        })),
                      },
                    },
                  ],
                },
              ],
            },
          });
        }
        throw new Error(`Unexpected page_context: ${ctx}`);
      },
    });

    const result = await tencentAdapter.fetchCollection("mzc00200znyfa5u", outbound);
    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    expect(requestedContexts).toEqual(["", "cursor_2"]);
    expect(result.info.featureEpisodeCount).toBe(20);
    expect(result.info.featureEpisodes[0]?.title).toBe("第1期上");
    expect(result.info.featureEpisodes[19]?.title).toBe("第10期下");
  });

  test("preserves tab order when a non-first tab is initially selected", async () => {
    const makeEps = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, i) => ({
        vid: `v_${from + i}`,
        title: String(from + i),
        c_title_output: String(from + i),
        is_trailer: "0",
      }));
    const tabs = [
      { begin: "1", end: "30", selected: false, page_context: "ctx_1_30" },
      { begin: "31", end: "40", selected: true, page_context: "ctx_31_40" },
    ];
    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        const body = JSON.parse(request.body ?? "{}") as {
          page_params?: { page_id?: string; page_context?: string };
        };
        if (body.page_params?.page_id === "detail_page_introduction") {
          return jsonResponse(
            request.url,
            makeIntroPayload({ title: "长剧", year: "2025", type: "2" }),
          );
        }
        const ctx = body.page_params?.page_context ?? "";
        if (ctx === "") {
          return jsonResponse(request.url, makeEpisodePagePayload(makeEps(31, 40), tabs));
        }
        if (ctx === "ctx_1_30") {
          return jsonResponse(request.url, makeEpisodePagePayload(makeEps(1, 30), tabs));
        }
        throw new Error(`Unexpected page_context: ${ctx}`);
      },
    });

    const result = await tencentAdapter.fetchCollection("mzc00200orderby", outbound);
    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    expect(result.info.featureEpisodeCount).toBe(40);
    expect(result.info.featureEpisodes[0]?.title).toBe("1");
    expect(result.info.featureEpisodes[30]?.title).toBe("31");
  });
});
