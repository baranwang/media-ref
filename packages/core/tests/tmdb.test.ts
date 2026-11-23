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
    await expect(gateway.fetchMediaSnapshotAndExternalIds("movie", "500")).rejects.toThrow(
      TmdbGatewayError,
    );
  });
});
