import { describe, expect, test } from "vite-plus/test";
import {
  createFakeOutboundClient,
  discoverCandidates,
  type ExternalHttpRequest,
  type ExternalHttpResponse,
} from "../src/index.ts";
import kan360Kuangbiao from "./fixtures/discovery/360kan-kuangbiao.json" with { type: "json" };
import doubanLiulangDiqiu from "./fixtures/discovery/douban-26266893.json" with { type: "json" };
import doubanKuangbiao from "./fixtures/discovery/douban-35465232.json" with { type: "json" };
import { DOUBAN_API } from "../src/index.ts";

// A test key, and no pacing delays against the fake Douban.
DOUBAN_API.apiKey = "test-douban-key";
DOUBAN_API.minIntervalMs = 0;
DOUBAN_API.retryDelayMs = 0;

// Fixtures were recorded from the live endpoints (trimmed to the fields the module reads).

function json(request: ExternalHttpRequest, payload: unknown, status = 200): ExternalHttpResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    url: request.url,
  };
}

function iqiyiSearchPayload(docs: Array<{ albumId: number; title: string; releaseDate: string }>) {
  return {
    code: "A00000",
    data: {
      code: 0,
      docinfos: docs.map((d) => ({
        qipu_id: d.albumId,
        albumDocInfo: {
          albumId: d.albumId,
          albumTitle: d.title,
          channel: "电视剧,2",
          releaseDate: d.releaseDate,
          siteId: "iqiyi",
        },
      })),
    },
  };
}

describe("discoverCandidates", () => {
  test("collects 360kan, Douban and iQIYI / Youku search, canonicalizes and merges by (namespace, id)", async () => {
    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        const url = new URL(request.url);
        if (url.hostname === "api.so.360kan.com") {
          expect(url.searchParams.get("kw")).toBe("狂飙");
          return json(request, kan360Kuangbiao);
        }
        if (url.hostname === "frodo.douban.com") {
          expect(url.pathname).toBe("/api/v2/subject/35465232");
          expect(url.searchParams.get("apiKey")).toBe("test-douban-key");
          return json(request, doubanKuangbiao);
        }
        if (url.hostname === "search.video.iqiyi.com") {
          return json(
            request,
            iqiyiSearchPayload([
              { albumId: 5328486914190101, title: "狂飙", releaseDate: "20230114" },
            ]),
          );
        }
        if (url.hostname === "search.youku.com") {
          expect(url.searchParams.get("keyword")).toBe("狂飙");
          // Youku lists iQIYI's 狂飙 under its own showId, as off-site (`isYouku: 0`).
          return json(request, {
            pageComponentList: [
              {
                commonData: {
                  showId: "cabed959dea44a72ac1f",
                  titleDTO: { displayName: "狂飙" },
                  feature: "2023 · 电视剧 · 中国 · 共39集",
                  isYouku: 0,
                  hasYouku: 0,
                },
              },
            ],
          });
        }
        if (request.url === "https://m.iqiyi.com/v_2bql2y1p4qs.html") {
          return {
            status: 200,
            headers: { "content-type": "text/html" },
            body: '<script>window.__x={"albumId":5328486914190101}</script>',
            url: request.url,
          };
        }
        // Everything else (other iQIYI pages, Youku pages, Bilibili API) is unavailable.
        return json(request, {}, 503);
      },
    });

    const result = await discoverCandidates(
      { title: "狂飙", year: 2023, mediaType: "tv", externalIds: { douban: "35465232" } },
      { outbound, timeoutMs: 1234 },
    );

    expect(result.sources).toEqual([
      // 狂飙支队 (2012) and GT赛车：极速狂飙 are filtered out: wrong year / title prefix.
      { source: "360kan", status: "ok", links: 1 },
      { source: "douban", status: "ok", links: 1 },
      { source: "iqiyi_search", status: "ok", links: 1 },
      { source: "youku_search", status: "ok", links: 0 },
    ]);
    expect(outbound.httpRequests.every((r) => r.timeoutMs === 1234 && r.kind === "platform")).toBe(
      true,
    );

    const byKey = Object.fromEntries(
      result.candidates.map((c) => [`${c.namespace}:${c.canonicalId}`, c]),
    );
    expect(Object.keys(byKey).sort()).toEqual(["iqiyi:5328486914190101"]);

    const kuangbiao = byKey["iqiyi:5328486914190101"]!;
    expect(kuangbiao.title).toBe("狂飙");
    expect(kuangbiao.year).toBe(2023);
    expect(kuangbiao.sources.map((s) => s.source).sort()).toEqual([
      "360kan",
      "douban",
      "iqiyi_search",
    ]);
    expect(kuangbiao.sources.find((s) => s.source === "360kan")?.rawUrl).toBe(
      "http://www.iqiyi.com/v_2bql2y1p4qs.html?vfm=f_191_360y&fv=p_09_01",
    );

    // Only the matching row's links are resolved, so nothing is dropped.
    expect(result.dropped).toEqual([]);
  });

  test("resolves Douban ID via IMDb and reads platform IDs from vendor app URIs; source failures stay isolated", async () => {
    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        const url = new URL(request.url);
        if (url.hostname === "api.douban.com") {
          expect(request.method).toBe("POST");
          expect(url.pathname).toBe("/v2/movie/imdb/tt7605074");
          return json(request, { id: "https://api.douban.com/movie/26266893" });
        }
        if (url.hostname === "frodo.douban.com") {
          expect(url.pathname).toBe("/api/v2/subject/26266893");
          return json(request, doubanLiulangDiqiu);
        }
        if (url.hostname === "api.so.360kan.com") {
          throw new Error("The operation timed out.");
        }
        // A bare `00` aid is a tvId, checked upstream: a movie's album is itself.
        if (request.url === "https://pcw-api.iqiyi.com/video/video/baseinfo/923452300") {
          return json(request, { code: "A00000", data: { tvId: 923452300, albumId: 923452300 } });
        }
        return json(request, {}, 500);
      },
    });

    const result = await discoverCandidates(
      { title: "流浪地球", year: 2019, mediaType: "movie", externalIds: { imdb: "tt7605074" } },
      { outbound },
    );

    expect(result.sources).toEqual([
      { source: "360kan", status: "error", reason: "The operation timed out." },
      { source: "douban", status: "ok", links: 4 },
      { source: "iqiyi_search", status: "error", reason: "http_500" },
      { source: "youku_search", status: "error", reason: "http_500" },
    ]);
    expect(
      result.candidates
        .map((c) => [c.namespace, c.canonicalId, c.title, c.year])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ["iqiyi", "923452300", "流浪地球", 2019],
      ["tencent", "3fvg46217gw800n", "流浪地球", 2019],
      ["youku", "7027efbfbd13efbfbd04", "流浪地球", 2019],
    ]);
    expect(result.dropped).toEqual([
      expect.objectContaining({
        source: "douban",
        platformKey: "miguvideo",
        reason: "unsupported_platform:miguvideo",
      }),
    ]);
    // Douban vendor IDs come from the app URI, so no platform page was fetched; only the
    // iQIYI `00` tvId was checked against its album.
    expect(outbound.httpRequests.map((r) => new URL(r.url).hostname).sort()).toEqual([
      "api.douban.com",
      "api.so.360kan.com",
      "frodo.douban.com",
      "pcw-api.iqiyi.com",
      "search.video.iqiyi.com",
      "search.youku.com",
    ]);
  });

  test("Douban subject 404 is not_found, other failures are errors; odd platform keys are dropped", async () => {
    const run = (status: number) =>
      discoverCandidates(
        { title: "x", mediaType: "tv", externalIds: { douban: "1" } },
        {
          outbound: createFakeOutboundClient({
            fetchExternal(request) {
              const host = new URL(request.url).hostname;
              if (host === "frodo.douban.com") {
                return json(request, {}, status);
              }
              if (host === "api.so.360kan.com") {
                const row = {
                  titleTxt: "x",
                  year: "2020",
                  playlinks: { constructor: "https://e.com/a" },
                };
                return json(request, { code: 0, data: { longData: { rows: [row] } } });
              }
              return json(request, { code: "A00000", data: { result_num: 0 } });
            },
          }),
        },
      );
    const notFound = await run(404);
    expect(notFound.sources[1]).toEqual({
      source: "douban",
      status: "not_found",
      reason: "douban_subject_not_found",
    });
    expect(notFound.dropped.map((d) => d.reason)).toEqual(["unsupported_platform:constructor"]);
    expect((await run(403)).sources[1]).toEqual({
      source: "douban",
      status: "error",
      reason: "http_403",
    });
  });

  test("tells 'source has nothing' apart from errors", async () => {
    const withImdb = createFakeOutboundClient({
      fetchExternal(request) {
        const host = new URL(request.url).hostname;
        if (host === "api.douban.com") {
          return json(request, { msg: "movie_not_found", code: 5000 });
        }
        if (host === "api.so.360kan.com") {
          return json(request, { code: 0, msg: "ok", data: { longData: { rows: [] } } });
        }
        if (host === "search.youku.com") {
          return json(request, { message: "success", pageComponentList: [] });
        }
        return json(request, { code: "A00000", data: { result_num: 0 } });
      },
    });
    const notFound = await discoverCandidates(
      { title: "不存在", mediaType: "movie", externalIds: { imdb: "tt0000001" } },
      { outbound: withImdb },
    );
    expect(notFound).toEqual({
      candidates: [],
      dropped: [],
      sources: [
        { source: "360kan", status: "ok", links: 0 },
        { source: "douban", status: "not_found", reason: "imdb_not_on_douban" },
        { source: "iqiyi_search", status: "ok", links: 0 },
        { source: "youku_search", status: "ok", links: 0 },
      ],
    });

    const noIds = createFakeOutboundClient({
      fetchExternal: (request) => json(request, { code: 1, msg: "busy" }),
    });
    const skipped = await discoverCandidates({ title: "x", mediaType: "tv" }, { outbound: noIds });
    expect(skipped.sources).toEqual([
      { source: "360kan", status: "error", reason: "360kan_code_1" },
      { source: "douban", status: "skipped", reason: "no_douban_or_imdb_id" },
      { source: "iqiyi_search", status: "error", reason: "missing_code" },
      { source: "youku_search", status: "error", reason: "unexpected_payload" },
    ]);
  });
});
