import { proto } from "@media-ref/client";
import {
  createFakeOutboundClient,
  type ExternalHttpRequest,
  type ExternalHttpResponse,
} from "@media-ref/core";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { INTERNAL_VISITOR_IP_HEADER } from "../src/app.ts";
import { createApiApp } from "../src/lib.ts";
import { createRpcClients, expectRpcError, TEST_BASE_URL } from "./rpc-helpers.ts";

const TEST_AUTH_SECRET = "test-browse-secret-4d1a-8c2e-77f0-91bb-3e5d6c7a8b9c0d1e2f3a";

function json(url: string, body: unknown, status = 200): ExternalHttpResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    url,
    body: JSON.stringify(body),
  };
}

/** Fake TMDB: trending returns 95479 (in the library) and 1399 (not), detail/search by id. */
function tmdbStub(req: ExternalHttpRequest): ExternalHttpResponse {
  if (req.url.includes("/trending/")) {
    return json(req.url, {
      results: [
        { id: 95479, media_type: "tv", name: "咒术回战", poster_path: "/jjk.jpg", genre_ids: [16] },
        {
          id: 1399,
          media_type: "tv",
          name: "权力的游戏",
          poster_path: "/got.jpg",
          genre_ids: [18],
        },
      ],
    });
  }
  if (req.url.includes("/search/multi")) {
    return json(req.url, {
      results: [
        { id: 95479, media_type: "tv", name: "咒术回战", poster_path: "/jjk.jpg" },
        { id: 777, media_type: "movie", title: "咒术回战 0", poster_path: "/zero.jpg" },
      ],
    });
  }
  if (req.url.includes("/tv/95479")) {
    return json(req.url, {
      id: 95479,
      name: "咒术回战",
      poster_path: "/jjk.jpg",
      genres: [{ id: 16, name: "动画" }],
    });
  }
  if (req.url.includes("/tv/1399")) {
    return json(req.url, { id: 1399, name: "权力的游戏", poster_path: "/got.jpg", genres: [] });
  }
  return json(req.url, { status_code: 34 }, 404);
}

describe("BrowseService", () => {
  const handles: TestDbHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      await handles.pop()?.cleanup();
    }
  });

  async function setup() {
    const testDb = await createTestDb();
    handles.push(testDb);
    const media = await testDb.writeDb
      .insertInto("media")
      .values({
        type: "tv",
        baseline: "tmdb",
        title: "咒术回战",
        original_title: "呪術廻戦",
        year: 2020,
        seasons: JSON.stringify([{ season: 1, episodeCount: 24, airYear: 2020 }]),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const variant = await testDb.writeDb
      .insertInto("variants")
      .values({ media_id: media.id, platform: "bilibili", description: "原声", is_default: true })
      .returning("id")
      .executeTakeFirstOrThrow();
    await testDb.writeDb
      .insertInto("associations")
      .values([
        {
          status: "confirmed",
          is_external_id: true,
          media_id: media.id,
          namespace: "tmdb",
          native_id: "tv:95479",
        },
        {
          status: "confirmed",
          media_id: media.id,
          namespace: "bilibili",
          native_id: "ss38221",
          variant_id: variant.id,
        },
      ])
      .execute();
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound: createFakeOutboundClient({ fetchExternal: tmdbStub }),
      config: { baseUrl: TEST_BASE_URL, authSecret: TEST_AUTH_SECRET },
    });
    const rpc = createRpcClients((req) => app.fetchInternal(req), {
      headers: { [INTERNAL_VISITOR_IP_HEADER]: "203.0.113.1" },
    });
    return { testDb, app, rpc, mediaId: media.id };
  }

  test("ListTrending marks titles already in MediaRef with their platforms", async () => {
    const { rpc, mediaId } = await setup();
    const res = await rpc.browse.listTrending({ namespace: "tmdb", type: proto.BrowseType.TV });
    expect(res.items.map((c) => [c.key, c.mediaId, c.platforms])).toEqual([
      ["tmdb:tv:95479", mediaId, ["bilibili"]],
      ["tmdb:tv:1399", undefined, []],
    ]);
    expect(res.items[0]!.posterUrl).toBe("https://image.tmdb.org/t/p/w500/jjk.jpg");
  });

  test("ListTrending rejects an unknown site and needs a key on the public entry", async () => {
    const { app, rpc } = await setup();
    const bad = await expectRpcError(rpc.browse.listTrending({ namespace: "imdb" }));
    expect(bad.code).toBe("INVALID_QUERY");
    const publicErr = await expectRpcError(
      createRpcClients(app).browse.listTrending({ namespace: "tmdb" }),
    );
    expect(publicErr.code).toBe("API_KEY_REQUIRED");
  });

  test("GetCatalogDetail returns 404 for titles the catalog does not know", async () => {
    const { rpc, mediaId } = await setup();
    const found = await rpc.browse.getCatalogDetail({ key: "tmdb:tv:95479" });
    expect(found.detail?.card?.mediaId).toBe(mediaId);
    const missing = await expectRpcError(rpc.browse.getCatalogDetail({ key: "tmdb:tv:42" }));
    expect(missing.code).toBe("CATALOG_ENTRY_NOT_FOUND");
  });

  test("Search by platform URL finds the library title", async () => {
    const { rpc, mediaId } = await setup();
    const res = await rpc.browse.search({ query: "https://www.bilibili.com/bangumi/play/ss38221" });
    expect(res.matchedAsLink).toBe(true);
    expect(res.items.map((c) => [c.key, c.mediaId])).toEqual([["tmdb:tv:95479", mediaId]]);
  });

  test("Search by title merges library hits with TMDB results without duplicates", async () => {
    const { rpc, mediaId } = await setup();
    const res = await rpc.browse.search({ query: "咒术" });
    expect(res.matchedAsLink).toBe(false);
    expect(res.items.map((c) => [c.key, c.mediaId ?? null])).toEqual([
      ["tmdb:tv:95479", mediaId],
      ["tmdb:movie:777", null],
    ]);
  });

  test("ListDemands returns open platform demands, most wanted first, with cards", async () => {
    const { testDb, rpc, mediaId } = await setup();
    await testDb.writeDb
      .insertInto("demands")
      .values([
        { media_id: mediaId, season: 2, namespace_group: "platform", demand_count: 3 },
        { external_key: "tmdb:tv:1399", namespace_group: "platform", demand_count: 9 },
        { external_key: "tmdb:tv:1399", namespace_group: "catalog", demand_count: 50 },
      ])
      .execute();
    const res = await rpc.browse.listDemands({});
    expect(res.demands.map((d) => [d.card?.key, d.demandCount, d.season ?? null])).toEqual([
      ["tmdb:tv:1399", 9, null],
      ["tmdb:tv:95479", 3, 2],
    ]);
    expect(res.demands[1]!.card?.mediaId).toBe(mediaId);
  });
});
