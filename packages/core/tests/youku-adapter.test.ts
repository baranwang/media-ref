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

function htmlResponse(url: string, body: string, status = 200): ExternalHttpResponse {
  return {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
    body,
    url,
  };
}

function buildInitialDataHtml(initialData: unknown, title = "优酷视频"): string {
  return [
    "<!doctype html>",
    "<html>",
    `<head><meta charset="utf-8"><title>${title}</title></head>`,
    "<body>",
    `<script>window.__INITIAL_DATA__ = ${JSON.stringify(initialData)};window.__OTHER__ = {"ok":true};</script>`,
    "</body>",
    "</html>",
  ].join("");
}

describe("Youku Tier 1 & Tier 2 adapter", () => {
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

  test("resolves v.youku.com/v_show/id_<vid>.html and mobile video URLs via SSR window.__INITIAL_DATA__", async () => {
    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        if (request.url === "https://v.youku.com/v_show/id_XNjY2Njg5NjU2.html") {
          return htmlResponse(
            request.url,
            buildInitialDataHtml({
              pageMap: {
                extra: {
                  showId: "zCC001F06962411DE83B1",
                  showName: "火影忍者",
                },
              },
            }),
          );
        }
        if (request.url === "https://v.youku.com/v_show/id_XNTg0MDM1NjA2NA==.html") {
          return htmlResponse(
            request.url,
            buildInitialDataHtml({
              pageMap: {
                extra: {
                  showId: "bbac165ee82549779af3",
                  showName: "狂飙",
                },
              },
            }),
          );
        }
        throw new Error(`Unexpected request: ${request.url}`);
      },
    });

    expect(
      youkuAdapter.parseInput("https://v.youku.com/v_show/id_XNjY2Njg5NjU2.html?s=ignored"),
    ).toEqual({
      kind: "video",
      id: "XNjY2Njg5NjU2",
      canonicalId: null,
    });

    expect(
      await youkuAdapter.canonicalize(
        "https://v.youku.com/v_show/id_XNjY2Njg5NjU2.html?spm=a2h0k.8191407",
        outbound,
      ),
    ).toBe("cc001f06962411de83b1");

    expect(
      await youkuAdapter.canonicalize(
        "https://m.youku.com/v_show/id_XNTg0MDM1NjA2NA==.html",
        outbound,
      ),
    ).toBe("bbac165ee82549779af3");

    expect(outbound.httpRequests).toHaveLength(2);
    for (const req of outbound.httpRequests) {
      expect(req.kind).toBe("platform");
      expect(req.namespace).toBe("youku");
    }
  });

  test("rejects unparseable Youku inputs and v_show pages missing showId with InvalidNativeIdError, while raising AdapterTransientError on CAPTCHA/5xx", async () => {
    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        if (request.url.includes("id_XMissingShow.html")) {
          return htmlResponse(
            request.url,
            buildInitialDataHtml({
              pageMap: {
                extra: {
                  videoName: "普通用户上传视频",
                },
              },
            }),
          );
        }
        if (request.url.includes("id_XInvalidShow.html")) {
          return htmlResponse(
            request.url,
            buildInitialDataHtml({
              pageMap: {
                extra: {
                  showId: "not-a-20-hex-id",
                },
              },
            }),
          );
        }
        if (request.url.includes("id_XNotFound.html")) {
          return htmlResponse(
            request.url,
            "<html><head><title>404 Not Found</title></head></html>",
          );
        }
        if (request.url.includes("id_XCaptcha.html")) {
          return htmlResponse(
            "https://v.youku.com/_____tmd_____/punish?x5secdata=abc",
            '<html><script>window._config_={"action":"captcha"};</script></html>',
          );
        }
        if (request.url.includes("id_XServerError.html")) {
          return htmlResponse(request.url, "Bad Gateway", 502);
        }
        throw new Error(`Unexpected request: ${request.url}`);
      },
    });

    const invalidInputs = [
      "",
      "   ",
      "1234567890",
      "cc001f06962411de83b",
      "cc001f06962411de83b12",
      "zcc001f06962411de83b",
      "gg001f06962411de83b1",
      "yk_abc123",
      "XNjY2Njg5NjU2",
      "https://evil.example.com/show/id_zcc001f06962411de83b1.html",
      "https://notyouku.com/show/id_zcc001f06962411de83b1.html",
      "https://list.youku.com/show/id_zshort.html",
      "https://list.youku.com/show/id_zcc001f06962411de83b1.html/extra",
      "https://so.youku.com/search_video/q_test",
      "https://v.youku.com/v_show/id_.html",
      "ftp://list.youku.com/show/id_zcc001f06962411de83b1.html",
    ];

    for (const raw of invalidInputs) {
      expect(youkuAdapter.parseInput(raw)).toBeNull();
      await expect(youkuAdapter.canonicalize(raw, outbound)).rejects.toBeInstanceOf(
        InvalidNativeIdError,
      );
    }

    await expect(
      youkuAdapter.canonicalize("https://v.youku.com/v_show/id_XMissingShow.html", outbound),
    ).rejects.toBeInstanceOf(InvalidNativeIdError);
    await expect(
      youkuAdapter.canonicalize("https://v.youku.com/v_show/id_XInvalidShow.html", outbound),
    ).rejects.toBeInstanceOf(InvalidNativeIdError);
    await expect(
      youkuAdapter.canonicalize("https://v.youku.com/v_show/id_XNotFound.html", outbound),
    ).rejects.toBeInstanceOf(InvalidNativeIdError);

    await expect(
      youkuAdapter.canonicalize("https://v.youku.com/v_show/id_XCaptcha.html", outbound),
    ).rejects.toBeInstanceOf(AdapterTransientError);
    await expect(
      youkuAdapter.canonicalize("https://v.youku.com/v_show/id_XServerError.html", outbound),
    ).rejects.toBeInstanceOf(AdapterTransientError);
  });

  test("fetches TV collection metadata from SSR window.__INITIAL_DATA__ and filters strictly to 正片 feature episodes", async () => {
    const showId = "e2f1a09876543210abcd";
    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        expect(request.kind).toBe("platform");
        expect(request.namespace).toBe("youku");
        expect(request.url).toBe(`https://list.youku.com/show/id_z${showId}.html`);
        return htmlResponse(
          request.url,
          buildInitialDataHtml({
            pageMap: {
              extra: {
                showId,
                showName: "白夜追凶",
                showReleaseTime: "2017-08-30 20:00:00",
                showCategory: "电视剧",
                showCategoryId: 97,
                episodeTotal: 3,
                episodeLast: 3,
                completed: true,
              },
            },
            moduleList: [
              {
                id: "mod-header",
                components: [{ type: 10001, itemList: [{ id: "ignored", videoType: "正片" }] }],
              },
              {
                id: "mod-anthology",
                components: [
                  {
                    type: 10013,
                    componentId: "pc_detail_kuflix_anthology",
                    pageSize: 60,
                    pageIndex: 1,
                    itemList: [
                      {
                        id: "1001",
                        action_value: "XMzAwMDAwMDE=",
                        title: "第1集",
                        subtitle: "灭门惨案 {起点}",
                        stage: 1,
                        stageIndex: 0,
                        videoType: "正片",
                        duration: "45:10",
                        publishTime: "2017-08-30",
                        mark: { text: "" },
                      },
                      {
                        id: "1002",
                        action_value: "XMzAwMDAwMDI=",
                        title: "第2集",
                        subtitle: "双胞胎秘密",
                        stage: 2,
                        stageIndex: 1,
                        videoType: "正片",
                        duration: 2700,
                        mark: { text: "VIP" },
                      },
                      {
                        id: "2001",
                        action_value: "XMzAwMDAwOTk=",
                        title: "第3集预告",
                        stage: 3,
                        videoType: "预告片",
                        mark: { text: "预告" },
                      },
                      {
                        id: "2002",
                        action_value: "XMzAwMDAwOTg=",
                        title: "幕后花絮：潘粤明分饰两角",
                        videoType: "花絮",
                        mark: { text: "花絮" },
                      },
                      {
                        id: "2003",
                        action_value: "XMzAwMDAwOTc=",
                        title: "精彩看点：高能审讯",
                        videoType: "精彩看点",
                        mark: { text: "" },
                      },
                      {
                        id: "2004",
                        action_value: "XMzAwMDAwOTY=",
                        title: "彩蛋片段",
                        videoType: "正片",
                        mark: { text: "预告" },
                      },
                      {
                        id: "1003",
                        action_value: "XMzAwMDAwMDM=",
                        title: "第3集",
                        subtitle: "暗夜追踪",
                        stage: 3,
                        stageIndex: 2,
                        videoType: "正片",
                        mark: { text: "独播" },
                      },
                    ],
                  },
                ],
              },
            ],
          }),
        );
      },
    });

    const result = await youkuAdapter.fetchCollection(showId, outbound);
    expect(result.status).toBe("found");
    if (result.status !== "found") {
      return;
    }

    expect(result.info.namespace).toBe("youku");
    expect(result.info.canonicalId).toBe(showId);
    expect(result.info.title).toBe("白夜追凶");
    expect(result.info.year).toBe(2017);
    expect(result.info.mediaType).toBe("tv");
    expect(result.info.featureEpisodeCount).toBe(3);
    expect(result.info.featureEpisodes.map((ep) => ep.index)).toEqual([1, 2, 3]);
    expect(result.info.featureEpisodes.map((ep) => ep.nativeEpisodeId)).toEqual([
      "XMzAwMDAwMDE=",
      "XMzAwMDAwMDI=",
      "XMzAwMDAwMDM=",
    ]);
    expect(result.info.featureEpisodes[0]?.durationSeconds).toBe(2710);
    expect(result.info.featureEpisodes[0]?.airDate).toBe("2017-08-30");
    expect(result.info.featureEpisodes[1]?.durationSeconds).toBe(2700);
    expect(result.info.externalIds).toBeUndefined();
  });

  test("maps Youku showCategory values (电影 -> movie; 动漫/综艺/纪录片 -> tv)", async () => {
    const fixtures: Record<
      string,
      { category?: string; categoryId?: number; title: string; year: string }
    > = {
      "11111111111111111111": {
        category: "电影",
        categoryId: 96,
        title: "流浪地球",
        year: "2019-02-05",
      },
      "22222222222222222222": {
        category: "动漫",
        categoryId: 100,
        title: "沧元图",
        year: "2023-06-22",
      },
      "33333333333333333333": {
        category: "综艺",
        categoryId: 85,
        title: "这！就是街舞",
        year: "2018-02-24",
      },
      "44444444444444444444": {
        category: "纪录片",
        categoryId: 84,
        title: "河西走廊",
        year: "2015-03-03",
      },
      "55555555555555555555": { categoryId: 96, title: "长安三万里", year: "2023-07-08" },
    };

    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        const match = request.url.match(/id_z([0-9a-f]{20})\.html$/);
        const showId = match?.[1];
        const fixture = showId ? fixtures[showId] : undefined;
        if (!showId || !fixture) {
          throw new Error(`Unexpected URL: ${request.url}`);
        }
        return htmlResponse(
          request.url,
          buildInitialDataHtml({
            pageMap: {
              extra: {
                showId,
                showName: fixture.title,
                showReleaseTime: fixture.year,
                ...(fixture.category ? { showCategory: fixture.category } : {}),
                ...(fixture.categoryId ? { showCategoryId: fixture.categoryId } : {}),
                episodeTotal: 1,
                episodeLast: 1,
              },
            },
            moduleList: [
              {
                components: [
                  {
                    type: 10013,
                    itemList: [
                      {
                        action_value: `XVID_${showId.slice(0, 4)}`,
                        title: "正片",
                        videoType: "正片",
                      },
                      {
                        action_value: `XTRL_${showId.slice(0, 4)}`,
                        title: "终极预告",
                        videoType: "预告片",
                      },
                    ],
                  },
                ],
              },
            ],
          }),
        );
      },
    });

    const movie = await youkuAdapter.fetchCollection("11111111111111111111", outbound);
    expect(movie).toMatchObject({
      status: "found",
      info: { title: "流浪地球", mediaType: "movie", year: 2019, featureEpisodeCount: 1 },
    });

    const anime = await youkuAdapter.fetchCollection("22222222222222222222", outbound);
    expect(anime).toMatchObject({
      status: "found",
      info: { title: "沧元图", mediaType: "tv", year: 2023, featureEpisodeCount: 1 },
    });

    const variety = await youkuAdapter.fetchCollection("33333333333333333333", outbound);
    expect(variety).toMatchObject({
      status: "found",
      info: { title: "这！就是街舞", mediaType: "tv", year: 2018, featureEpisodeCount: 1 },
    });

    const doc = await youkuAdapter.fetchCollection("44444444444444444444", outbound);
    expect(doc).toMatchObject({
      status: "found",
      info: { title: "河西走廊", mediaType: "tv", year: 2015, featureEpisodeCount: 1 },
    });

    const movieById = await youkuAdapter.fetchCollection("55555555555555555555", outbound);
    expect(movieById).toMatchObject({
      status: "found",
      info: { title: "长安三万里", mediaType: "movie", year: 2023, featureEpisodeCount: 1 },
    });
  });

  test("returns featureEpisodeCount: null for region-locked trailer-only and >60-episode truncated SSR responses", async () => {
    const geoLockedId = "cc001f06962411de83b1";
    const truncatedLongId = "bbac165ee82549779af3";
    const trailerPushedPage2Id = "aa001f06962411de83b1";
    const completeSixtyId = "dd001f06962411de83b1";
    const missingYearId = "ee001f06962411de83b1";

    const makeFeatureItems = (count: number) =>
      Array.from({ length: count }, (_, idx) => ({
        id: String(10_000 + idx),
        action_value: `XEP_${idx + 1}`,
        title: `第${idx + 1}集`,
        stage: idx + 1,
        videoType: "正片",
        mark: { text: "VIP" },
      }));

    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        if (request.url.includes(`id_z${geoLockedId}.html`)) {
          return htmlResponse(
            request.url,
            buildInitialDataHtml({
              pageMap: {
                extra: {
                  showId: geoLockedId,
                  showName: "火影忍者",
                  showReleaseTime: "2013-12-01",
                  showCategory: "动漫",
                  episodeTotal: 720,
                  episodeLast: 0,
                  completed: true,
                },
              },
              moduleList: [
                {
                  components: [
                    {
                      type: 10013,
                      pageSize: 60,
                      pageIndex: 1,
                      itemList: [
                        {
                          action_value: "XTRL1",
                          title: "第1集预告",
                          videoType: "预告片",
                          mark: { text: "预告" },
                        },
                        {
                          action_value: "XTRL2",
                          title: "第2集预告",
                          videoType: "预告片",
                          mark: { text: "预告" },
                        },
                      ],
                    },
                  ],
                },
              ],
            }),
          );
        }

        if (request.url.includes(`id_z${truncatedLongId}.html`)) {
          return htmlResponse(
            request.url,
            buildInitialDataHtml({
              pageMap: {
                extra: {
                  showId: truncatedLongId,
                  showName: "火影忍者",
                  showReleaseTime: "2002-10-03",
                  showCategory: "动漫",
                  episodeTotal: 720,
                  episodeLast: 720,
                  completed: true,
                },
              },
              moduleList: [
                {
                  components: [
                    {
                      type: 10013,
                      pageSize: 60,
                      pageIndex: 1,
                      itemList: makeFeatureItems(60),
                    },
                  ],
                },
              ],
            }),
          );
        }

        if (request.url.includes(`id_z${trailerPushedPage2Id}.html`)) {
          return htmlResponse(
            request.url,
            buildInitialDataHtml({
              pageMap: {
                extra: {
                  showId: trailerPushedPage2Id,
                  showName: "长剧六十集",
                  showReleaseTime: "2020-05-01",
                  showCategory: "电视剧",
                  episodeTotal: 60,
                  episodeLast: 60,
                  completed: true,
                },
              },
              moduleList: [
                {
                  components: [
                    {
                      type: 10013,
                      pageSize: 60,
                      pageIndex: 1,
                      itemList: [
                        ...makeFeatureItems(55),
                        ...Array.from({ length: 5 }, (_, idx) => ({
                          action_value: `XTR_${idx + 1}`,
                          title: `预告${idx + 1}`,
                          videoType: "预告片",
                        })),
                      ],
                    },
                  ],
                },
              ],
            }),
          );
        }

        if (request.url.includes(`id_z${completeSixtyId}.html`)) {
          return htmlResponse(
            request.url,
            buildInitialDataHtml({
              pageMap: {
                extra: {
                  showId: completeSixtyId,
                  showName: "完整六十集",
                  showReleaseTime: "2021-01-01",
                  showCategory: "电视剧",
                  episodeTotal: 60,
                  episodeLast: 60,
                  completed: true,
                },
              },
              moduleList: [
                {
                  components: [
                    {
                      type: 10013,
                      pageSize: 60,
                      pageIndex: 1,
                      itemList: makeFeatureItems(60),
                    },
                  ],
                },
              ],
            }),
          );
        }

        if (request.url.includes(`id_z${missingYearId}.html`)) {
          return htmlResponse(
            request.url,
            buildInitialDataHtml({
              pageMap: {
                extra: {
                  showId: missingYearId,
                  showName: "缺少年份剧",
                  showCategory: "电视剧",
                  episodeTotal: 2,
                  episodeLast: 2,
                },
              },
              moduleList: [
                {
                  components: [
                    {
                      type: 10013,
                      itemList: makeFeatureItems(2),
                    },
                  ],
                },
              ],
            }),
          );
        }

        throw new Error(`Unexpected URL: ${request.url}`);
      },
    });

    const geoLocked = await youkuAdapter.fetchCollection(geoLockedId, outbound);
    expect(geoLocked).toMatchObject({
      status: "found",
      info: {
        canonicalId: geoLockedId,
        title: "火影忍者",
        year: 2013,
        mediaType: "tv",
        featureEpisodeCount: null,
        featureEpisodes: [],
      },
    });

    const truncatedLong = await youkuAdapter.fetchCollection(truncatedLongId, outbound);
    expect(truncatedLong.status).toBe("found");
    if (truncatedLong.status === "found") {
      expect(truncatedLong.info.featureEpisodeCount).toBeNull();
      expect(truncatedLong.info.featureEpisodes).toHaveLength(60);
    }

    const trailerPushed = await youkuAdapter.fetchCollection(trailerPushedPage2Id, outbound);
    expect(trailerPushed.status).toBe("found");
    if (trailerPushed.status === "found") {
      expect(trailerPushed.info.featureEpisodeCount).toBeNull();
      expect(trailerPushed.info.featureEpisodes).toHaveLength(55);
    }

    const completeSixty = await youkuAdapter.fetchCollection(completeSixtyId, outbound);
    expect(completeSixty.status).toBe("found");
    if (completeSixty.status === "found") {
      expect(completeSixty.info.featureEpisodeCount).toBe(60);
      expect(completeSixty.info.featureEpisodes).toHaveLength(60);
    }

    const missingYear = await youkuAdapter.fetchCollection(missingYearId, outbound);
    expect(missingYear).toMatchObject({
      status: "found",
      info: {
        canonicalId: missingYearId,
        year: null,
        featureEpisodeCount: 2,
      },
    });
  });

  test("handles 404 pages, missing showId, Alibaba CAPTCHA, 5xx, and timeouts cleanly", async () => {
    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        if (request.url.includes("00000000000000000001")) {
          return htmlResponse(request.url, "Not Found", 404);
        }
        if (request.url.includes("00000000000000000002")) {
          return htmlResponse(
            request.url,
            "<!doctype html><html><head><title>404 Not Found</title></head><body>404</body></html>",
            200,
          );
        }
        if (request.url.includes("00000000000000000003")) {
          return htmlResponse(
            request.url,
            buildInitialDataHtml({
              pageMap: { extra: { showName: "已下架" } },
            }),
          );
        }
        if (request.url.includes("00000000000000000004")) {
          return htmlResponse(
            request.url,
            '<html><script>location.href="https://list.youku.com/show/_____tmd_____/punish?x5secdata=xyz";window._config_={"action":"captcha"};</script></html>',
            200,
          );
        }
        if (request.url.includes("00000000000000000005")) {
          return htmlResponse(request.url, "Service Unavailable", 503);
        }
        if (request.url.includes("00000000000000000006")) {
          throw new Error("ETIMEDOUT connecting to list.youku.com");
        }
        if (request.url.includes("00000000000000000007")) {
          return htmlResponse(
            request.url,
            "<html><script>window.__INITIAL_DATA__ = {broken json</script></html>",
            200,
          );
        }
        throw new Error(`Unexpected URL: ${request.url}`);
      },
    });

    expect((await youkuAdapter.fetchCollection("00000000000000000001", outbound)).status).toBe(
      "not_found",
    );
    expect((await youkuAdapter.fetchCollection("00000000000000000002", outbound)).status).toBe(
      "not_found",
    );
    expect((await youkuAdapter.fetchCollection("00000000000000000003", outbound)).status).toBe(
      "not_found",
    );
    expect((await youkuAdapter.fetchCollection("zcc001f06962411de83b1", outbound)).status).toBe(
      "not_found",
    );

    expect(await youkuAdapter.fetchCollection("00000000000000000004", outbound)).toEqual({
      status: "transient_error",
      reason: "youku_captcha_challenge",
    });
    expect((await youkuAdapter.fetchCollection("00000000000000000005", outbound)).status).toBe(
      "transient_error",
    );
    expect((await youkuAdapter.fetchCollection("00000000000000000006", outbound)).status).toBe(
      "transient_error",
    );
    expect((await youkuAdapter.fetchCollection("00000000000000000007", outbound)).status).toBe(
      "transient_error",
    );
  });

  test("registers youkuAdapter as a Tier 2 adapter in createDefaultAdapterRegistry()", () => {
    const registry = createDefaultAdapterRegistry();
    const youku = registry.get("youku");
    expect(youku).toBe(youkuAdapter);
    expect(youku?.tier).toBe(2);
    expect(youku && isTier2Adapter(youku)).toBe(true);
    expect(youku && isTier3Adapter(youku)).toBe(false);
    expect(registry.listByMinTier(2).map((a) => a.namespace)).toContain("youku");
    expect(registry.listByMinTier(3).map((a) => a.namespace)).not.toContain("youku");
  });
});
