import { describe, expect, test } from "vite-plus/test";
import {
  AdapterTransientError,
  createDefaultAdapterRegistry,
  createFakeOutboundClient,
  InvalidNativeIdError,
  isTier2Adapter,
  isTier3Adapter,
  youkuAdapter,
  type ExternalHttpResponse,
} from "../src/index.ts";
import searchChengfeng from "./fixtures/youku/search-chengfengpolang.json" with { type: "json" };
import searchLiulang from "./fixtures/youku/search-liulangdiqiu.json" with { type: "json" };
import searchQingyunian from "./fixtures/youku/search-qingyunian.json" with { type: "json" };

const API = "https://openapi.youku.com/v2";

function jsonResponse(url: string, body: unknown, status = 200): ExternalHttpResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    url,
  };
}

/** Routes open API calls by path and the show_id / video_id / page query parameters. */
function openApiStub(handler: (path: string, params: URLSearchParams) => unknown) {
  return createFakeOutboundClient({
    fetchExternal: (request) => {
      expect(request.url.startsWith(`${API}/`)).toBe(true);
      const url = new URL(request.url);
      expect(url.searchParams.get("client_id")).toBe("53e6cc67237fc59a");
      const out = handler(url.pathname.replace("/v2/", ""), url.searchParams);
      return out && typeof out === "object" && "status" in out && "body" in out
        ? (out as ExternalHttpResponse)
        : jsonResponse(request.url, out);
    },
  });
}

function makeVideos(count: number, from = 1) {
  return Array.from({ length: count }, (_, i) => ({
    id: `XEP${from + i}==`,
    seq: String(from + i),
    stage: String(from + i),
    title: `第${from + i}集标题`,
    duration: "1415.56",
    category: "电视剧",
    published: "2017-08-30 20:00:00",
  }));
}

/** A show whose episode list is `total` long, served 100 per page. */
function showStub(show: Record<string, unknown>, total: number) {
  return openApiStub((path, params) => {
    if (path === "shows/show.json") {
      return { id: params.get("show_id"), ...show };
    }
    expect(path).toBe("shows/videos.json");
    expect(params.get("ext")).toBe("show");
    const page = Number(params.get("page"));
    const size = Number(params.get("count"));
    const from = (page - 1) * size + 1;
    return {
      total: String(total),
      videos: makeVideos(Math.max(0, Math.min(size, total - from + 1)), from),
    };
  });
}

describe("Youku Tier 1, 2 & 3 adapter", () => {
  test("parses and canonicalizes bare showIds, z-prefixed IDs, and list/m show URLs without network calls", async () => {
    const outbound = createFakeOutboundClient();

    const directInputs = [
      "cc001f06962411de83b1",
      "CC001F06962411DE83B1",
      "  cc001f06962411de83b1  ",
      "zcc001f06962411de83b1",
      "ZCC001F06962411DE83B1",
      "https://list.youku.com/show/id_zcc001f06962411de83b1.html",
      "https://list.youku.com/show/id_zCC001F06962411DE83B1.html?spm=a2h0c.8166622#episodes",
      "https://list.youku.com/show/id_cc001f06962411de83b1.html",
      "https://m.youku.com/show/id_zcc001f06962411de83b1.html",
      "https://m.youku.com/show/id_cc001f06962411de83b1.html?source=share",
      "http://www.youku.com/show/id_zcc001f06962411de83b1.html",
    ];

    for (const raw of directInputs) {
      expect(youkuAdapter.parseInput(raw)).toEqual({
        kind: "show",
        id: "cc001f06962411de83b1",
        canonicalId: "cc001f06962411de83b1",
      });
      expect(await youkuAdapter.canonicalize(raw, outbound)).toBe("cc001f06962411de83b1");
    }

    expect(outbound.httpRequests).toHaveLength(0);
  });

  test("resolves v_show and mobile video URLs to their show through videos/show.json", async () => {
    const outbound = openApiStub((path, params) => {
      expect(path).toBe("videos/show.json");
      expect(params.get("ext")).toBe("show");
      return params.get("video_id") === "XNTk3MzA5NzgzMg=="
        ? { id: "XNTk3MzA5NzgzMg==", show: { id: "ADAEC02F09F9469AB8D8", name: "沧元图" } }
        : { error: { code: 120020101, type: "VideosException", description: "invalid ID" } };
    });

    for (const raw of [
      "https://v.youku.com/v_show/id_XNTk3MzA5NzgzMg==.html",
      "https://m.youku.com/video/id_XNTk3MzA5NzgzMg==.html",
    ]) {
      expect(await youkuAdapter.canonicalize(raw, outbound)).toBe("adaec02f09f9469ab8d8");
    }
    await expect(
      youkuAdapter.canonicalize("https://v.youku.com/v_show/id_XMISSING.html", outbound),
    ).rejects.toBeInstanceOf(InvalidNativeIdError);
    await expect(
      youkuAdapter.canonicalize("https://example.com/x", outbound),
    ).rejects.toBeInstanceOf(InvalidNativeIdError);

    const down = openApiStub(() => jsonResponse(`${API}/videos/show.json`, "busy", 503));
    await expect(
      youkuAdapter.canonicalize("https://v.youku.com/v_show/id_XNTk3MzA5NzgzMg==.html", down),
    ).rejects.toBeInstanceOf(AdapterTransientError);
  });

  test("fetches show metadata and every page of feature episodes", async () => {
    const outbound = showStub(
      {
        name: "沧元图",
        alias: [
          { alias: "Cang Yuan Tu", type: "1" },
          { alias: "沧元图", type: "0" },
        ],
        category: "动漫",
        released: "2023-06-22",
        published: "2022-01-01",
      },
      105,
    );

    const result = await youkuAdapter.fetchCollection("adaec02f09f9469ab8d8", outbound);
    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    expect(result.info).toMatchObject({
      namespace: "youku",
      canonicalId: "adaec02f09f9469ab8d8",
      title: "沧元图",
      aliases: ["Cang Yuan Tu"],
      year: 2023,
      mediaType: "tv",
      featureEpisodeCount: 105,
    });
    expect(result.info.featureEpisodes[0]).toEqual({
      index: 1,
      nativeEpisodeId: "XEP1==",
      title: "第1集标题",
      durationSeconds: 1416,
      airDate: "2017-08-30",
    });
    expect(result.info.featureEpisodes[104]?.nativeEpisodeId).toBe("XEP105==");
    expect(outbound.httpRequests.filter((r) => r.url.includes("videos.json"))).toHaveLength(2);
  });

  test("maps categories: 电影 -> movie; 动漫/综艺/纪录片/电视剧 -> tv; others -> null", async () => {
    for (const [category, expected] of [
      ["电影", "movie"],
      ["动漫", "tv"],
      ["综艺", "tv"],
      ["纪录片", "tv"],
      ["电视剧", "tv"],
      ["音乐", null],
    ] as const) {
      const result = await youkuAdapter.fetchCollection(
        "a1b2c3d4e5f60718293b",
        showStub({ name: "x", category, released: "2019-02-05" }, 1),
      );
      expect(result.status === "found" && result.info.mediaType).toBe(expected);
    }
  });

  test("reports no episode count for an empty list (expired copyright) or one longer than 20 pages", async () => {
    const expired = await youkuAdapter.fetchCollection(
      "cc001f06962411de83b1",
      showStub({ name: "火影忍者", category: "动漫", released: "2002-10-03" }, 0),
    );
    expect(expired).toMatchObject({ status: "found", info: { featureEpisodeCount: null } });

    // An off-site listing (Migu's 乘风破浪 第三季): show.json answers, with no play link and no videos.
    const offSite = await youkuAdapter.fetchCollection(
      "eaba37f7f29b46a7810f",
      showStub(
        {
          name: "乘风破浪 第三季",
          category: "综艺",
          released: "2022-05-20",
          episode_count: "0",
          play_link: null,
          streamtypes: null,
        },
        0,
      ),
    );
    expect(offSite).toMatchObject({
      status: "found",
      info: {
        title: "乘风破浪 第三季",
        mediaType: "tv",
        featureEpisodeCount: null,
        featureEpisodes: [],
      },
    });

    const long = await youkuAdapter.fetchCollection(
      "bbac165ee82549779af3",
      showStub({ name: "名侦探柯南", category: "动漫", released: "1996-01-08" }, 2500),
    );
    expect(long).toMatchObject({ status: "found", info: { featureEpisodeCount: null } });
    if (long.status === "found") {
      expect(long.info.featureEpisodes).toHaveLength(2000);
    }
  });

  test("handles unknown IDs, API errors, 5xx, bad JSON and timeouts", async () => {
    const cases: Array<[string, (path: string) => unknown, string]> = [
      ["00000000000000000001", () => [], "not_found"],
      [
        "00000000000000000002",
        () => ({ error: { code: 120030200, type: "ShowsException", description: "invalid ID:x" } }),
        "not_found",
      ],
      [
        "00000000000000000003",
        () => ({ error: { code: 1012, type: "SystemException", description: "Service busy" } }),
        "transient_error",
      ],
      ["00000000000000000004", () => jsonResponse(`${API}/x`, "down", 503), "transient_error"],
      ["00000000000000000005", () => jsonResponse(`${API}/x`, "<html>"), "transient_error"],
      [
        "00000000000000000006",
        (path) =>
          path === "shows/show.json"
            ? { name: "x", category: "电视剧" }
            : jsonResponse(`${API}/x`, "down", 502),
        "transient_error",
      ],
    ];
    for (const [id, respond, status] of cases) {
      const result = await youkuAdapter.fetchCollection(
        id,
        openApiStub((path) => respond(path)),
      );
      expect([id, result.status]).toEqual([id, status]);
    }

    const timeout = createFakeOutboundClient({
      fetchExternal: async () => {
        throw new Error("Simulated upstream timeout");
      },
    });
    expect(await youkuAdapter.fetchCollection("00000000000000000007", timeout)).toEqual({
      status: "transient_error",
      reason: "Simulated upstream timeout",
    });
    expect((await youkuAdapter.fetchCollection("not-an-id", timeout)).status).toBe("not_found");
  });

  test("searches Youku and keeps only Youku-hosted feature shows", async () => {
    const searchStub = (payload: unknown) =>
      createFakeOutboundClient({
        fetchExternal: (request) => {
          const url = new URL(request.url);
          expect(`${url.origin}${url.pathname}`).toBe("https://search.youku.com/api/search");
          expect(request.headers?.["user-agent"]).toMatch(/^Mozilla\/5\.0/);
          return jsonResponse(request.url, payload);
        },
      });

    const liulang = searchStub(searchLiulang);
    const movies = await youkuAdapter.search({ title: " 流浪地球 ", page: 2 }, liulang);
    const params = new URL(liulang.httpRequests[0]!.url).searchParams;
    expect([params.get("keyword"), params.get("pg"), params.get("site")]).toEqual([
      "流浪地球",
      "2",
      "1",
    ]);
    // Dropped: 《流浪地球》优酷独家幕后记录 (《), Tencent's 流浪地球2：再次冒险, unreleased 流浪地球3.
    expect(movies).toEqual({
      status: "ok",
      candidates: [
        {
          canonicalId: "7027efbfbd13efbfbd04",
          title: "流浪地球",
          year: 2019,
          mediaType: "movie",
          episodeCount: 1,
        },
        {
          canonicalId: "efcdfcb66fd346f9b2a9",
          title: "流浪地球2",
          year: 2023,
          mediaType: "movie",
          episodeCount: 1,
        },
        {
          canonicalId: "dacdc75b16b142c2a0ab",
          title: "流浪地球：飞跃2020特别版",
          year: 2020,
          mediaType: "movie",
          episodeCount: 1,
        },
        {
          canonicalId: "ceaa946b761b4d65a3c9",
          title: "流浪地球",
          year: 2022,
          mediaType: "tv",
          episodeCount: 10,
        },
        {
          canonicalId: "dcca1e4ef15246bcac2a",
          title: "解析流浪地球2-移山计划始末",
          year: 2023,
          mediaType: null,
          episodeCount: 6,
        },
        {
          canonicalId: "1761efbfbd7f31efbfbd",
          title: "流浪地球 畅听版",
          year: 2020,
          mediaType: null,
          episodeCount: 5,
        },
      ],
    });
    const limited = await youkuAdapter.search(
      { title: "流浪地球", limit: 2 },
      searchStub(searchLiulang),
    );
    expect(limited.status === "ok" && limited.candidates.map((c) => c.canonicalId)).toEqual([
      "7027efbfbd13efbfbd04",
      "efcdfcb66fd346f9b2a9",
    ]);

    // Every 乘风破浪的姐姐 season is Mango TV's or Migu's on Youku; only two Youku dramas remain.
    const chengfeng = await youkuAdapter.search(
      { title: "乘风破浪的姐姐" },
      searchStub(searchChengfeng),
    );
    expect(chengfeng.status === "ok" && chengfeng.candidates.map((c) => c.canonicalId)).toEqual([
      "adebd64da6e54938bc10",
      "eabf1c54ee5146d99581",
    ]);

    // 庆余年 is Tencent's; what Youku hosts is commentary (解读, 揭秘, 抢先看, 《》).
    expect(await youkuAdapter.search({ title: "庆余年" }, searchStub(searchQingyunian))).toEqual({
      status: "ok",
      candidates: [],
    });

    const blank = searchStub(searchLiulang);
    expect(await youkuAdapter.search({ title: "  " }, blank)).toEqual({
      status: "ok",
      candidates: [],
    });
    expect(blank.httpRequests).toHaveLength(0);
  });

  test("reports search failures and TMD CAPTCHA pages as transient", async () => {
    const respond = (response: Partial<ExternalHttpResponse>) =>
      createFakeOutboundClient({
        fetchExternal: (request) => ({ ...jsonResponse(request.url, ""), ...response }),
      });
    const cases: Array<[Partial<ExternalHttpResponse>, string]> = [
      [{ status: 503, body: "busy" }, "http_503"],
      [{ body: "<html>" }, "unexpected_payload"],
      [{ body: JSON.stringify({ message: "fail" }) }, "unexpected_payload"],
      [
        { body: '<html><script>var url="https://search.youku.com//punish?x5secdata=abc"</script>' },
        "youku_captcha_challenge",
      ],
      [
        { url: "https://search.youku.com/_____tmd_____/punish?x5secdata=abc", body: "<html>" },
        "youku_captcha_challenge",
      ],
    ];
    for (const [response, reason] of cases) {
      expect(await youkuAdapter.search({ title: "狂飙" }, respond(response))).toEqual({
        status: "transient_error",
        reason,
      });
    }
    const timeout = createFakeOutboundClient({
      fetchExternal: async () => {
        throw new Error("Simulated upstream timeout");
      },
    });
    expect(await youkuAdapter.search({ title: "狂飙" }, timeout)).toEqual({
      status: "transient_error",
      reason: "Simulated upstream timeout",
    });
  });

  test("registers youkuAdapter as a Tier 3 adapter in createDefaultAdapterRegistry()", () => {
    const registry = createDefaultAdapterRegistry();
    const youku = registry.get("youku");
    expect(youku).toBe(youkuAdapter);
    expect(youku?.tier).toBe(3);
    expect(youku && isTier2Adapter(youku)).toBe(true);
    expect(youku && isTier3Adapter(youku)).toBe(true);
    expect(registry.listByMinTier(3).map((a) => a.namespace)).toContain("youku");
  });
});
