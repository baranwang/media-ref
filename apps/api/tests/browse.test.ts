import { proto } from "@media-ref/client";
import {
  createFakeOutboundClient,
  type ExternalHttpRequest,
  type ExternalHttpResponse,
  type FakeOutboundHandlers,
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

  async function setup(fetchExternal: FakeOutboundHandlers["fetchExternal"] = tmdbStub) {
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
      outbound: createFakeOutboundClient({ fetchExternal }),
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

  test("Search keeps library order when the second card returns first", async () => {
    let releaseFirst!: () => void;
    const secondStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const { rpc, testDb, mediaId } = await setup(async (req) => {
      if (req.url.includes("/tv/95479")) await secondStarted;
      if (req.url.includes("/tv/1399")) releaseFirst();
      return tmdbStub(req);
    });
    const older = await testDb.writeDb
      .insertInto("media")
      .values({
        type: "tv",
        title: "咒术前传",
        baseline: "tmdb",
        updated_at: new Date("2000-01-01"),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await testDb.writeDb
      .insertInto("associations")
      .values({
        media_id: older.id,
        status: "confirmed",
        namespace: "tmdb",
        native_id: "tv:1399",
        is_external_id: true,
      })
      .execute();

    const res = await rpc.browse.search({ query: "咒术", limit: 2 });
    expect(res.items.map((card) => card.mediaId)).toEqual([mediaId, older.id]);
  });

  test("Search accepts 200 characters and rejects longer queries", async () => {
    const { rpc } = await setup();
    const query = "🍿".repeat(200);
    await rpc.browse.search({ query });
    expect(await expectRpcError(rpc.browse.search({ query: `${query}x` }))).toMatchObject({
      status: 400,
      code: "INVALID_QUERY",
    });
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

  test("listExplorationActivity shows running and finished jobs in plain words, never the caller", async () => {
    const { testDb, rpc, mediaId } = await setup();
    const now = Date.now();
    const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000);
    await testDb.writeDb
      .insertInto("user")
      .values({ id: "agent", name: "Agent", email: "agent@example.invalid", emailVerified: true })
      .execute();
    const cr = await testDb.writeDb
      .insertInto("change_requests")
      .values({
        submitter_user_id: "agent",
        submitter_type: "agent",
        media_id: mediaId,
        target_external_key: "tmdb:tv:95479",
        namespace: "bilibili",
        raw_native_id: "ss38221",
        native_id: "ss38221",
        status: "approved",
        segments: JSON.stringify([]),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const job = (minutesAgo: number, outcomes: unknown[]) => ({
      job_type: "exploration",
      status: "completed" as const,
      payload: JSON.stringify({ demandId: "d", mediaId, season: 1 }),
      result: JSON.stringify({ mediaId, platformOutcomes: outcomes }),
      leased_at: at(minutesAgo + 1),
      completed_at: at(minutesAgo),
    });
    await testDb.writeDb
      .insertInto("background_jobs")
      .values([
        job(5, [
          { namespace: "bilibili", status: "submitted", changeRequestId: cr.id },
          { namespace: "iqiyi", status: "not_found", reason: "Only user uploads, no series." },
          { namespace: "youku", status: "transient_error", reason: "AI Gateway (x) error: 502" },
        ]),
        job(30, [{ namespace: "tencent", status: "not_found", reason: "no_discovery_candidates" }]),
        {
          job_type: "exploration",
          status: "leased" as const,
          payload: JSON.stringify({ mediaId, season: 2, targetNamespaces: ["bilibili", "mgtv"] }),
          leased_at: at(1),
          lease_expires_at: at(-10),
        },
      ])
      .execute();

    const res = await rpc.browse.listExplorationActivity({ limit: 1 });
    expect(res.running.map((r) => [r.season, r.platforms.map((p) => p.status)])).toEqual([
      [2, ["searching", "searching"]],
    ]);
    expect(res.recent).toHaveLength(1);
    expect(res.recent[0]!.card?.mediaId).toBe(mediaId);
    expect(res.recent[0]!.platforms.map((p) => [p.namespace, p.status, p.reason ?? null])).toEqual([
      ["bilibili", "approved", null],
      ["iqiyi", "not_found", "Only user uploads, no series."],
      ["youku", "retry", "暂时出了问题，稍后再找"],
    ]);
    expect(res.last24h).toMatchObject({ explored: 2, found: 1, approved: 1, inReview: 0 });
    expect(JSON.stringify(res)).not.toContain('"d"');

    const next = await rpc.browse.listExplorationActivity({ before: res.nextBefore! });
    expect(next.running).toEqual([]);
    expect(next.last24h).toBeUndefined();
    expect(next.recent[0]!.platforms[0]).toMatchObject({
      namespace: "tencent",
      reason: "各个来源都没有这部作品",
    });

    const notFound = await rpc.browse.listExplorationActivity({
      filter: proto.ExplorationFilter.NOT_FOUND,
    });
    expect(notFound.recent.map((r) => r.platforms[0]!.namespace)).toEqual(["tencent"]);
  });

  test("listExplorationActivity turns rejected outcomes whose platform is now confirmed into covered with live CR link", async () => {
    const { testDb, rpc } = await setup();
    const t0 = new Date("2026-11-27T08:00:00.000Z");
    const media = await testDb.writeDb
      .insertInto("media")
      .values({ type: "movie", baseline: "tmdb", title: "复仇者联盟", year: 2012 })
      .returning("id")
      .executeTakeFirstOrThrow();
    await testDb.writeDb
      .insertInto("associations")
      .values({
        status: "confirmed",
        is_external_id: true,
        media_id: media.id,
        namespace: "tmdb",
        native_id: "movie:24428",
      })
      .execute();

    const vIqiyi = await testDb.writeDb
      .insertInto("variants")
      .values({ media_id: media.id, platform: "iqiyi", description: "原声", is_default: true })
      .returning("id")
      .executeTakeFirstOrThrow();
    const assocIqiyi = await testDb.writeDb
      .insertInto("associations")
      .values({
        status: "confirmed",
        media_id: media.id,
        namespace: "iqiyi",
        native_id: "200001001",
        variant_id: vIqiyi.id,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const submitterId = (
      await testDb.writeDb
        .insertInto("user")
        .values({
          id: "activity-u1",
          name: "Submitter",
          email: "activity-u1@example.com",
          emailVerified: true,
          role: "user",
          createdAt: t0,
          updatedAt: t0,
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;

    const liveIqiyiCr = await testDb.writeDb
      .insertInto("change_requests")
      .values({
        submitter_user_id: submitterId,
        target_external_key: `tmdb:movie:24428`,
        media_id: media.id,
        namespace: "iqiyi",
        raw_native_id: "200001001",
        native_id: "200001001",
        status: "approved",
        applied_association_id: assocIqiyi.id,
        segments: JSON.stringify([]),
        reviewed_at: new Date(t0.getTime() - 10_000),
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const rejectedIqiyiCr = await testDb.writeDb
      .insertInto("change_requests")
      .values({
        submitter_user_id: submitterId,
        target_external_key: media.id,
        media_id: media.id,
        namespace: "iqiyi",
        raw_native_id: "200001001",
        native_id: "200001001",
        status: "rejected",
        conflict_reason: "both_passed_evidence_gate",
        decision_reason: "无法自动通过：both_passed_evidence_gate",
        segments: JSON.stringify([]),
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const approvedTencentCr = await testDb.writeDb
      .insertInto("change_requests")
      .values({
        submitter_user_id: submitterId,
        target_external_key: media.id,
        media_id: media.id,
        namespace: "tencent",
        raw_native_id: "mzc00200live00",
        native_id: "mzc00200live00",
        status: "approved",
        segments: JSON.stringify([]),
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const genuinelyRejectedBiliCr = await testDb.writeDb
      .insertInto("change_requests")
      .values({
        submitter_user_id: submitterId,
        target_external_key: media.id,
        media_id: media.id,
        namespace: "bilibili",
        raw_native_id: "ss99999",
        native_id: "ss99999",
        status: "rejected",
        conflict_reason: "title_mismatch",
        decision_reason: "Private decision text from the authenticated change request",
        evidence: JSON.stringify({
          reviewAgent: {
            verdict: "reject",
            opinion: "Private reviewer note",
            reasons: [{ reason: "Non-public evidence detail" }],
          },
        }),
        segments: JSON.stringify([]),
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await testDb.writeDb
      .insertInto("background_jobs")
      .values({
        job_type: "exploration",
        status: "completed",
        payload: JSON.stringify({ demandId: "d1", mediaId: media.id }),
        result: JSON.stringify({
          mediaId: media.id,
          platformOutcomes: [
            { namespace: "iqiyi", status: "submitted", changeRequestId: rejectedIqiyiCr.id },
            { namespace: "youku", status: "already_confirmed", reason: "already_confirmed" },
            { namespace: "tencent", status: "submitted", changeRequestId: approvedTencentCr.id },
            {
              namespace: "bilibili",
              status: "submitted",
              changeRequestId: genuinelyRejectedBiliCr.id,
            },
            { namespace: "mgtv", status: "not_found", reason: "no_matching_candidate" },
          ],
        }),
        leased_at: t0,
        completed_at: new Date(t0.getTime() + 1000),
      })
      .execute();

    const res = await rpc.browse.listExplorationActivity({ limit: 5 });
    const platforms = res.recent[0]!.platforms;
    expect(
      platforms.map((p: (typeof platforms)[number]) => ({
        namespace: p.namespace,
        status: p.status,
        reason: p.reason ?? null,
        changeRequestId: p.changeRequestId ?? null,
        liveChangeRequestId: p.liveChangeRequestId ?? null,
      })),
    ).toEqual([
      {
        namespace: "iqiyi",
        status: "covered",
        reason: "此前提交时库里已有收录，当前已在库中生效",
        changeRequestId: rejectedIqiyiCr.id,
        liveChangeRequestId: liveIqiyiCr.id,
      },
      {
        namespace: "youku",
        status: "covered",
        reason: "此前已在库中收录",
        changeRequestId: null,
        liveChangeRequestId: null,
      },
      {
        namespace: "tencent",
        status: "approved",
        reason: null,
        changeRequestId: approvedTencentCr.id,
        liveChangeRequestId: null,
      },
      {
        namespace: "bilibili",
        status: "rejected",
        reason: "平台片名和资料站对不上",
        changeRequestId: genuinelyRejectedBiliCr.id,
        liveChangeRequestId: null,
      },
      {
        namespace: "mgtv",
        status: "not_found",
        reason: "找到的合集都不是这部作品",
        changeRequestId: null,
        liveChangeRequestId: null,
      },
    ]);
  });
});
