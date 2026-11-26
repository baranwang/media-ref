import { describe, expect, test } from "vite-plus/test";
import {
  createFakeOutboundClient,
  createTmdbGateway,
  parseTmdbNativeId,
  TmdbGatewayError,
  type ExternalHttpResponse,
} from "../src/index.ts";

describe("TmdbGateway", () => {
  test("parses valid TMDB movie and tv native IDs and rejects malformed ones", () => {
    expect(parseTmdbNativeId("tv:95479")).toEqual({ type: "tv", id: "95479" });
    expect(parseTmdbNativeId("movie:550")).toEqual({ type: "movie", id: "550" });
    expect(parseTmdbNativeId("tv:0")).toBeNull();
    expect(parseTmdbNativeId("show:95479")).toBeNull();
    expect(parseTmdbNativeId("95479")).toBeNull();
  });

  test("falls back to separate /external_ids endpoint when append_to_response is omitted and handles Trakt failure gracefully", async () => {
    const outbound = createFakeOutboundClient({
      fetchExternal(request): ExternalHttpResponse {
        if (request.namespace === "tmdb" && request.url.includes("/tv/42/external_ids")) {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            url: request.url,
            body: JSON.stringify({ imdb_id: "tt0000042", tvdb_id: 4242 }),
          };
        }
        if (request.namespace === "tmdb" && request.url.includes("/tv/42")) {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            url: request.url,
            body: JSON.stringify({
              id: 42,
              name: "示例剧集",
              original_name: "Sample Show",
              first_air_date: "2024-05-01",
              seasons: [{ season_number: 1, episode_count: 12, air_date: "2024-05-01" }],
            }),
          };
        }
        if (request.namespace === "trakt") {
          return {
            status: 503,
            headers: {},
            url: request.url,
            body: "Service Unavailable",
          };
        }
        throw new Error(`Unexpected request: ${request.url}`);
      },
    });

    const gateway = createTmdbGateway(outbound, {
      apiKey: "test-api-key",
      traktClientId: "test-trakt-id",
    });

    const result = await gateway.fetchMediaSnapshotAndExternalIds("tv", "42");
    expect(result).toEqual({
      type: "tv",
      snapshot: {
        title: "示例剧集",
        originalTitle: "Sample Show",
        year: 2024,
        type: "tv",
        seasons: [{ season: 1, episodeCount: 12, airYear: 2024 }],
      },
      externalIds: {
        tmdb: "tv:42",
        imdb: "tt0000042",
        tvdb: "4242",
        trakt: null,
      },
    });
    expect(outbound.httpRequests.map((r) => r.namespace)).toEqual(["tmdb", "tmdb", "trakt"]);
  });

  test("fetches one season's episode air years, null when TMDB has no such season", async () => {
    const outbound = createFakeOutboundClient({
      fetchExternal(request): ExternalHttpResponse {
        if (request.url.includes("/tv/95479/season/1?")) {
          return {
            status: 200,
            headers: {},
            url: request.url,
            body: JSON.stringify({
              episodes: [
                { episode_number: 24, air_date: "2021-03-27" },
                { episode_number: 25, air_date: "2023-07-06" },
                { episode_number: 26, air_date: null },
              ],
            }),
          };
        }
        return { status: 404, headers: {}, url: request.url, body: "{}" };
      },
    });
    const gateway = createTmdbGateway(outbound, { accessToken: "tok" });

    expect(await gateway.fetchSeasonEpisodes("95479", 1)).toEqual([
      { episodeNumber: 24, airYear: 2021 },
      { episodeNumber: 25, airYear: 2023 },
      { episodeNumber: 26, airYear: null },
    ]);
    expect(await gateway.fetchSeasonEpisodes("95479", 9)).toBeNull();
  });

  test("returns null on 404 and throws TmdbGatewayError on 5xx", async () => {
    const outbound = createFakeOutboundClient({
      fetchExternal(request): ExternalHttpResponse {
        if (request.url.includes("/movie/404")) {
          return { status: 404, headers: {}, url: request.url, body: "{}" };
        }
        return { status: 500, headers: {}, url: request.url, body: "Internal Error" };
      },
    });

    const gateway = createTmdbGateway(outbound, { accessToken: "tok" });
    expect(await gateway.fetchMediaSnapshotAndExternalIds("movie", "404")).toBeNull();
    await expect(
      gateway.fetchMediaSnapshotAndExternalIds("movie", "404", { throwOnNotFound: true }),
    ).rejects.toMatchObject({
      name: "TmdbGatewayError",
      code: "TMDB_NOT_FOUND",
      status: 404,
    });
    await expect(gateway.fetchMediaSnapshotAndExternalIds("movie", "500")).rejects.toMatchObject({
      name: "TmdbGatewayError",
      code: "TMDB_UPSTREAM_ERROR",
      status: 502,
    });
  });

  test("fetchChanges paginates through all total_pages, deduplicates IDs, and distinguishes 404 vs transient 5xx/timeout", async () => {
    const outbound = createFakeOutboundClient({
      fetchExternal(request): ExternalHttpResponse {
        const parsedUrl = new URL(request.url);
        if (parsedUrl.pathname.endsWith("/tv/changes")) {
          const page = parsedUrl.searchParams.get("page");
          expect(parsedUrl.searchParams.get("start_date")).toBe("2026-11-18");
          expect(parsedUrl.searchParams.get("end_date")).toBe("2026-11-23");

          if (page === "1") {
            return {
              status: 200,
              headers: { "content-type": "application/json" },
              url: request.url,
              body: JSON.stringify({
                page: 1,
                total_pages: 3,
                total_results: 4,
                results: [
                  { id: 95479, adult: false },
                  { id: 108545, adult: null },
                ],
              }),
            };
          }
          if (page === "2") {
            return {
              status: 200,
              headers: { "content-type": "application/json" },
              url: request.url,
              body: JSON.stringify({
                page: 2,
                total_pages: 3,
                total_results: 4,
                results: [
                  { id: 108545, adult: false }, // duplicate across pages
                  { id: 200001, adult: false },
                ],
              }),
            };
          }
          if (page === "3") {
            return {
              status: 200,
              headers: { "content-type": "application/json" },
              url: request.url,
              body: JSON.stringify({
                page: 3,
                total_pages: 3,
                total_results: 4,
                results: [{ id: 300002, adult: false }],
              }),
            };
          }
        }

        if (parsedUrl.pathname.endsWith("/movie/changes")) {
          if (parsedUrl.searchParams.get("start_date") === "2026-01-01") {
            return { status: 404, headers: {}, url: request.url, body: "{}" };
          }
          if (parsedUrl.searchParams.get("start_date") === "2026-02-01") {
            throw new Error("Request timed out");
          }
          return { status: 503, headers: {}, url: request.url, body: "Service Unavailable" };
        }

        throw new Error(`Unexpected request: ${request.url}`);
      },
    });

    const gateway = createTmdbGateway(outbound, { accessToken: "tok" });
    const changes = await gateway.fetchChanges("tv", {
      startDate: "2026-11-18",
      endDate: "2026-11-23",
    });

    expect(changes).toEqual({
      mediaType: "tv",
      startDate: "2026-11-18",
      endDate: "2026-11-23",
      changedIds: ["95479", "108545", "200001", "300002"],
      totalPages: 3,
      totalResults: 4,
      pagesFetched: 3,
    });

    await expect(
      gateway.fetchChanges("movie", { startDate: "2026-01-01", endDate: "2026-01-02" }),
    ).rejects.toMatchObject({
      name: "TmdbGatewayError",
      code: "TMDB_NOT_FOUND",
      status: 404,
    });

    await expect(
      gateway.fetchChanges("movie", { startDate: "2026-02-01", endDate: "2026-02-02" }),
    ).rejects.toMatchObject({
      name: "TmdbGatewayError",
      code: "TMDB_UPSTREAM_ERROR",
      status: 502,
    });

    await expect(
      gateway.fetchChanges("movie", { startDate: "2026-03-01", endDate: "2026-03-02" }),
    ).rejects.toMatchObject({
      name: "TmdbGatewayError",
      code: "TMDB_UPSTREAM_ERROR",
      status: 502,
    });

    expect(TmdbGatewayError).toBeDefined();
  });
});
