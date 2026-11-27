import type { Message, MessageBatch, ScheduledController } from "@cloudflare/workers-types";
import {
  createFakeOutboundClient,
  EVIDENCE_CHECK_JOB_TYPE,
  EXPLORATION_JOB_TYPE,
  listDemands,
  type ExplorationAgentConfig,
  type ExternalHttpRequest,
  type ExternalHttpResponse,
  type FakeOutboundHandlers,
  type JobQueueMessage,
  type ModelInvocationRequest,
  type ModelInvocationResponse,
} from "@media-ref/core";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { createBackgroundWorker } from "../src/index.ts";
import { DOUBAN_API } from "@media-ref/core";

// A test key, and no pacing delays against the fake Douban.
DOUBAN_API.apiKey = "test-douban-key";
DOUBAN_API.minIntervalMs = 0;
DOUBAN_API.retryDelayMs = 0;

// Catalog-group exploration (ADR 0002 step 4): the TMDB external ID is written directly when the
// IMDb chain holds; a missing Douban association goes through a change request.

const T0 = new Date("2026-11-24T01:00:00.000Z");

function json(url: string, payload: unknown, status = 200): ExternalHttpResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    url,
  };
}

function createScheduledController(at: Date): ScheduledController {
  return { scheduledTime: at.getTime(), cron: "* * * * *", noRetry() {} };
}

function createQueueBatch(bodies: JobQueueMessage[]): MessageBatch<JobQueueMessage> {
  const messages: Message<JobQueueMessage>[] = bodies.map((body, i) => ({
    id: `msg-${i}-${body.jobId}`,
    timestamp: T0,
    body,
    attempts: 1,
    ack() {},
    retry() {},
  }));
  return {
    queue: "media-ref-jobs",
    messages,
    metadata: { metrics: { backlogCount: messages.length, backlogBytes: 0 } },
    ackAll() {},
    retryAll() {},
  };
}

/** Fight Club as TMDB, IMDb and Douban know it. */
function httpStub(request: ExternalHttpRequest): ExternalHttpResponse {
  const url = new URL(request.url);
  if (request.namespace === "tmdb" && url.pathname.endsWith("/find/tt0137523")) {
    return json(request.url, { movie_results: [{ id: 550 }], tv_results: [] });
  }
  if (request.namespace === "tmdb" && url.pathname.endsWith("/movie/550")) {
    return json(request.url, {
      id: 550,
      title: "搏击俱乐部",
      original_title: "Fight Club",
      release_date: "1999-10-15",
      external_ids: { imdb_id: "tt0137523" },
    });
  }
  if (url.hostname === "api.imdbapi.dev" && url.pathname === "/titles/tt0137523") {
    return json(request.url, {
      primaryTitle: "Fight Club",
      originalTitle: "Fight Club",
      type: "movie",
      startYear: 1999,
    });
  }
  if (url.hostname === "api.douban.com" && url.pathname === "/v2/movie/imdb/tt0137523") {
    return json(request.url, { id: "https://api.douban.com/movie/1292000" });
  }
  if (url.hostname === "frodo.douban.com" && url.pathname.endsWith("/subject/1292000")) {
    return json(request.url, {
      title: "搏击俱乐部",
      original_title: "Fight Club",
      year: "1999",
      is_tv: false,
      subtype: "movie",
    });
  }
  throw new Error(`Unexpected outbound request: ${request.namespace} ${request.url}`);
}

describe("catalog-group exploration", () => {
  const handles: TestDbHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      await handles.pop()?.cleanup();
    }
  });

  async function setup(media: {
    baseline: "tmdb" | "douban" | "bangumi";
    externalIds: Array<[string, string]>;
    doubanAssociation?: string;
    bangumiAssociation?: string;
    type?: "movie" | "tv";
    title?: string;
    originalTitle?: string | null;
    year?: number | null;
    seasons?: Array<{ season: number; episodeCount: number; airYear?: number | null }>;
    /** TMDB `/find` knows nothing about the IMDb ID. */
    tmdbFindEmpty?: boolean;
    /** TMDB `/search` returns no hits cleanly instead of throwing on stubbed requests. */
    tmdbSearchEmpty?: boolean;
    extraHttpStub?: (
      request: ExternalHttpRequest,
    ) => ExternalHttpResponse | Promise<ExternalHttpResponse> | null;
    invokeModel?: FakeOutboundHandlers["invokeModel"];
    explorationAgent?: ExplorationAgentConfig;
  }) {
    const testDb = await createTestDb();
    handles.push(testDb);
    const row = await testDb.writeDb
      .insertInto("media")
      .values({
        type: media.type ?? "movie",
        baseline: media.baseline,
        title: media.title ?? "搏击俱乐部",
        original_title: media.originalTitle === undefined ? "Fight Club" : media.originalTitle,
        year: media.year === undefined ? 1999 : media.year,
        seasons: JSON.stringify(media.seasons ?? []),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    for (const [namespace, nativeId] of media.externalIds) {
      await testDb.writeDb
        .insertInto("associations")
        .values({
          media_id: row.id,
          namespace: namespace as "tmdb",
          native_id: nativeId,
          status: "confirmed",
          is_external_id: true,
          source: "sync",
        })
        .execute();
    }
    if (media.doubanAssociation) {
      await testDb.writeDb
        .insertInto("associations")
        .values({
          media_id: row.id,
          namespace: "douban",
          native_id: media.doubanAssociation,
          status: "confirmed",
        })
        .execute();
    }
    if (media.bangumiAssociation) {
      await testDb.writeDb
        .insertInto("associations")
        .values({
          media_id: row.id,
          namespace: "bangumi",
          native_id: media.bangumiAssociation,
          status: "confirmed",
        })
        .execute();
    }
    await testDb.writeDb
      .insertInto("demands")
      .values({
        media_id: row.id,
        season: null,
        namespace_group: "catalog",
        status: "open",
        next_eligible_at: T0,
        last_demanded_at: T0,
      })
      .execute();

    const outbound = createFakeOutboundClient({
      fetchExternal: (request) => {
        const extra = media.extraHttpStub?.(request);
        if (extra) {
          return extra;
        }
        if (media.tmdbFindEmpty && request.namespace === "tmdb" && request.url.includes("/find/")) {
          return json(request.url, { movie_results: [], tv_results: [] });
        }
        if (
          (media.tmdbFindEmpty || media.tmdbSearchEmpty) &&
          request.namespace === "tmdb" &&
          request.url.includes("/search/")
        ) {
          return json(request.url, { results: [] });
        }
        return httpStub(request);
      },
      ...(media.invokeModel ? { invokeModel: media.invokeModel } : {}),
    });
    const emitted: JobQueueMessage[] = [];
    let now = T0;
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
      config: {
        enableDailyTmdbSync: false,
        exploration: { dailyBudget: 10 },
        ...(media.explorationAgent ? { explorationAgent: media.explorationAgent } : {}),
      },
      now: () => now,
    });
    const runJobs = async (at = T0) => {
      now = at;
      await worker.scheduled(createScheduledController(now));
      const batch = [...emitted];
      emitted.length = 0;
      await worker.queue(createQueueBatch(batch));
      return batch.map((m) => m.jobType);
    };
    return { testDb, mediaId: row.id, outbound, runJobs };
  }

  const externalIds = (testDb: TestDbHandle, mediaId: string) =>
    testDb.readDb
      .selectFrom("associations")
      .select(["namespace", "native_id", "source"])
      .where("media_id", "=", mediaId)
      .where("is_external_id", "=", true)
      .orderBy("namespace")
      .execute();

  test("a Douban-only media gets its TMDB ID from the IMDb chain, and the demand is fulfilled", async () => {
    const { testDb, mediaId, runJobs } = await setup({
      baseline: "douban",
      externalIds: [["imdb", "tt0137523"]],
      doubanAssociation: "1292000",
    });

    expect(await runJobs()).toEqual([EXPLORATION_JOB_TYPE]);

    expect(await externalIds(testDb, mediaId)).toEqual([
      { namespace: "imdb", native_id: "tt0137523", source: "sync" },
      { namespace: "tmdb", native_id: "movie:550", source: "agent" },
    ]);
    expect((await listDemands(testDb.readDb, { mediaId }))[0]?.status).toBe("fulfilled");
  });

  test("a TMDB ID held by another media is not written; a retry reuses the open alert", async () => {
    const { testDb, mediaId, runJobs } = await setup({
      baseline: "douban",
      externalIds: [["imdb", "tt0137523"]],
      doubanAssociation: "1292000",
    });
    const other = await testDb.writeDb
      .insertInto("media")
      .values({
        type: "movie",
        baseline: "tmdb",
        title: "Fight Club",
        year: 1999,
        seasons: JSON.stringify([]),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await testDb.writeDb
      .insertInto("associations")
      .values({
        media_id: other.id,
        namespace: "tmdb",
        native_id: "movie:550",
        status: "confirmed",
        is_external_id: true,
        source: "sync",
      })
      .execute();

    expect(await runJobs()).toEqual([EXPLORATION_JOB_TYPE]);
    const [demand] = await listDemands(testDb.readDb, { mediaId });
    expect(demand?.status).toBe("not_found");
    expect(await runJobs(new Date(demand!.nextEligibleAt))).toEqual([EXPLORATION_JOB_TYPE]);

    expect((await externalIds(testDb, mediaId)).map((r) => r.namespace)).toEqual(["imdb"]);
    const alerts = await testDb.readDb.selectFrom("review_alerts").selectAll().execute();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      status: "open",
      alert_type: "agent_external_id_conflict",
      media_id: mediaId,
    });
    expect(alerts[0]?.details).toMatchObject({ namespace: "tmdb", otherMediaId: other.id });
    expect((await listDemands(testDb.readDb, { mediaId }))[0]?.status).not.toBe("fulfilled");
  });

  test("a TMDB media without a Douban association gets a Douban change request found via IMDb", async () => {
    const { testDb, mediaId, outbound, runJobs } = await setup({
      baseline: "tmdb",
      externalIds: [
        ["tmdb", "movie:550"],
        ["imdb", "tt0137523"],
      ],
    });

    expect(await runJobs()).toEqual([EXPLORATION_JOB_TYPE]);
    expect(outbound.modelRequests).toHaveLength(0);

    const crs = await testDb.readDb
      .selectFrom("change_requests")
      .select(["namespace", "native_id", "status", "submitter_type"])
      .execute();
    expect(crs).toEqual([
      {
        namespace: "douban",
        native_id: "1292000",
        status: "pending_evidence",
        submitter_type: "agent",
      },
    ]);
    expect((await listDemands(testDb.readDb, { mediaId }))[0]?.status).toBe("awaiting_review");

    // The evidence check approves it and the catalog demand is fulfilled.
    expect(await runJobs()).toEqual([EVIDENCE_CHECK_JOB_TYPE]);
    const approved = await testDb.readDb
      .selectFrom("change_requests")
      .select("status")
      .executeTakeFirstOrThrow();
    expect(approved.status).toBe("approved");
    expect((await listDemands(testDb.readDb, { mediaId }))[0]?.status).toBe("fulfilled");
  });

  test("catalog coverage needs the TMDB ID: a Douban association alone does not fulfill the demand", async () => {
    const { testDb, mediaId, runJobs } = await setup({
      baseline: "douban",
      externalIds: [],
      doubanAssociation: "1292000",
      tmdbSearchEmpty: true,
    });

    // When TMDB genuinely has no match, the demand stays unmet and backs off.
    expect(await runJobs()).toEqual([EXPLORATION_JOB_TYPE]);
    const demand = (await listDemands(testDb.readDb, { mediaId }))[0]!;
    expect(demand.status).toBe("not_found");
  });

  test("Bangumi-only TV anime without IMDb ID (FX战士久留美) gets its TMDB ID via title, originalTitle, and year chain", async () => {
    const { testDb, mediaId, runJobs } = await setup({
      baseline: "bangumi",
      type: "tv",
      title: "FX战士久留美",
      originalTitle: "FX戦士くるみちゃん",
      year: 2026,
      seasons: [{ season: 1, episodeCount: 12, airYear: 2026 }],
      externalIds: [],
      bangumiAssociation: "499999",
      extraHttpStub(request) {
        const url = new URL(request.url);
        if (request.namespace === "bangumi" && url.pathname.endsWith("/subjects/499999")) {
          return json(request.url, {
            id: 499999,
            type: 2,
            name: "FX戦士くるみちゃん",
            name_cn: "FX战士久留美",
            date: "2026-10-01",
            eps: 12,
            infobox: [{ key: "英文名", value: "FX Fighter Kurumi-chan" }],
          });
        }
        if (request.namespace === "tmdb" && url.pathname.endsWith("/search/tv")) {
          return json(request.url, {
            results: [
              {
                id: 311842,
                name: "FX战士久留美",
                original_name: "FX戦士くるみちゃん",
                first_air_date: "2026-10-01",
              },
            ],
          });
        }
        if (request.namespace === "tmdb" && url.pathname.endsWith("/tv/311842")) {
          return json(request.url, {
            id: 311842,
            name: "FX战士久留美",
            original_name: "FX戦士くるみちゃん",
            first_air_date: "2026-10-01",
            seasons: [{ season_number: 1, episode_count: 12, air_date: "2026-10-01" }],
            translations: {
              translations: [{ data: { name: "FX戰士久留美" } }],
            },
            alternative_titles: {
              results: [{ title: "FX Fighter Kurumi-chan" }],
            },
            external_ids: { tvdb_id: 777311 },
          });
        }
        return null;
      },
    });

    expect(await runJobs()).toEqual([EXPLORATION_JOB_TYPE]);
    expect(await externalIds(testDb, mediaId)).toEqual([
      { namespace: "tmdb", native_id: "tv:311842", source: "agent" },
      { namespace: "tvdb", native_id: "777311", source: "agent" },
    ]);
    expect((await listDemands(testDb.readDb, { mediaId }))[0]?.status).toBe("fulfilled");
  });

  test("multi-season TV show falls back to yearless TMDB search when baseline year is for a later season", async () => {
    const { testDb, mediaId, runJobs } = await setup({
      baseline: "bangumi",
      type: "tv",
      title: "我推的孩子",
      originalTitle: "【推しの子】",
      year: 2024,
      seasons: [{ season: 1, episodeCount: 11, airYear: 2024 }],
      externalIds: [],
      bangumiAssociation: "386809",
      extraHttpStub(request) {
        const url = new URL(request.url);
        if (request.namespace === "bangumi" && url.pathname.endsWith("/subjects/386809")) {
          return json(request.url, {
            id: 386809,
            type: 2,
            name: "【推しの子】",
            name_cn: "我推的孩子",
            date: "2024-07-03",
            eps: 13,
          });
        }
        if (request.namespace === "tmdb" && url.pathname.endsWith("/search/tv")) {
          // Only hits when searched without `first_air_date_year=2024` (TMDB first aired 2023).
          const airYear = url.searchParams.get("first_air_date_year");
          return json(request.url, {
            results:
              airYear === null
                ? [
                    {
                      id: 203737,
                      name: "我推的孩子",
                      original_name: "【推しの子】",
                      first_air_date: "2023-04-12",
                    },
                  ]
                : [],
          });
        }
        if (request.namespace === "tmdb" && url.pathname.endsWith("/tv/203737")) {
          return json(request.url, {
            id: 203737,
            name: "我推的孩子",
            original_name: "【推しの子】",
            first_air_date: "2023-04-12",
            seasons: [
              { season_number: 1, episode_count: 11, air_date: "2023-04-12" },
              { season_number: 2, episode_count: 13, air_date: "2024-07-03" },
            ],
            external_ids: {},
          });
        }
        return null;
      },
    });

    expect(await runJobs()).toEqual([EXPLORATION_JOB_TYPE]);
    expect(await externalIds(testDb, mediaId)).toEqual([
      { namespace: "tmdb", native_id: "tv:203737", source: "agent" },
    ]);
    expect((await listDemands(testDb.readDb, { mediaId }))[0]?.status).toBe("fulfilled");
  });

  test("uncorroborated single-title TMDB search hit is not written without distinguishing identity signals", async () => {
    const { testDb, mediaId, runJobs } = await setup({
      baseline: "bangumi",
      type: "movie",
      title: "风声",
      originalTitle: null,
      year: 2009,
      externalIds: [],
      bangumiAssociation: "12345",
      extraHttpStub(request) {
        const url = new URL(request.url);
        if (request.namespace === "bangumi" && url.pathname.endsWith("/subjects/12345")) {
          return json(request.url, { id: 12345, type: 2, name: "风声", date: "2009-09-29" });
        }
        if (request.namespace === "tmdb" && url.pathname.endsWith("/search/movie")) {
          return json(request.url, {
            results: [
              { id: 90001, title: "风声", original_title: "风声", release_date: "2009-09-29" },
            ],
          });
        }
        if (request.namespace === "tmdb" && url.pathname.endsWith("/movie/90001")) {
          return json(request.url, {
            id: 90001,
            title: "风声",
            original_title: "风声",
            release_date: "2009-09-29",
            external_ids: {},
          });
        }
        return null;
      },
    });

    expect(await runJobs()).toEqual([EXPLORATION_JOB_TYPE]);
    expect(await externalIds(testDb, mediaId)).toEqual([]);
    expect((await listDemands(testDb.readDb, { mediaId }))[0]?.status).toBe("not_found");
  });

  test("single shared title with trailing qualifier does not count as two independent signals", async () => {
    const { testDb, mediaId, runJobs } = await setup({
      baseline: "bangumi",
      type: "movie",
      title: "Example (2026)",
      originalTitle: null,
      year: 2026,
      externalIds: [],
      bangumiAssociation: "12346",
      extraHttpStub(request) {
        const url = new URL(request.url);
        if (request.namespace === "bangumi" && url.pathname.endsWith("/subjects/12346")) {
          return json(request.url, {
            id: 12346,
            type: 2,
            name: "Example (2026)",
            date: "2026-03-01",
            infobox: [{ key: "别名", value: "Example" }],
          });
        }
        if (request.namespace === "tmdb" && url.pathname.endsWith("/search/movie")) {
          return json(request.url, {
            results: [
              {
                id: 90002,
                title: "Example (2026)",
                original_title: "Example (2026)",
                release_date: "2026-03-01",
              },
            ],
          });
        }
        if (request.namespace === "tmdb" && url.pathname.endsWith("/movie/90002")) {
          return json(request.url, {
            id: 90002,
            title: "Example (2026)",
            original_title: "Example (2026)",
            release_date: "2026-03-01",
            external_ids: {},
          });
        }
        return null;
      },
    });

    expect(await runJobs()).toEqual([EXPLORATION_JOB_TYPE]);
    expect(await externalIds(testDb, mediaId)).toEqual([]);
    expect((await listDemands(testDb.readDb, { mediaId }))[0]?.status).toBe("not_found");
  });

  test("TMDB fallback session keeps search tools available even when explorationAgent maxDurationMs exceeds 6 minutes", async () => {
    let seenToolNames: string[] = [];
    const { testDb, mediaId, runJobs } = await setup({
      baseline: "bangumi",
      type: "tv",
      title: "冷门译名",
      originalTitle: null,
      year: 2026,
      seasons: [{ season: 1, episodeCount: 12, airYear: 2026 }],
      externalIds: [],
      bangumiAssociation: "499997",
      explorationAgent: { maxDurationMs: 10 * 60_000 },
      extraHttpStub(request) {
        const url = new URL(request.url);
        if (request.namespace === "bangumi" && url.pathname.endsWith("/subjects/499997")) {
          return json(request.url, { id: 499997, type: 2, name: "冷门译名", eps: 12 });
        }
        if (request.namespace === "tmdb" && url.pathname.endsWith("/search/tv")) {
          return json(request.url, { results: [] });
        }
        return null;
      },
      invokeModel(request: ModelInvocationRequest): ModelInvocationResponse {
        if (seenToolNames.length === 0) {
          seenToolNames = (request.tools ?? []).map((t) => t.name);
        }
        return {
          content: null,
          toolCalls: [{ id: "c1", name: "mark_not_found", arguments: { reason: "not on tmdb" } }],
          model: "test-model",
        };
      },
    });

    expect(await runJobs()).toEqual([EXPLORATION_JOB_TYPE]);
    expect(seenToolNames).toEqual(
      expect.arrayContaining([
        "search_catalog",
        "get_catalog_entry",
        "submit_tmdb_id",
        "mark_not_found",
      ]),
    );
    expect((await listDemands(testDb.readDb, { mediaId }))[0]?.status).toBe("not_found");
  });

  test("TMDB fallback bounds submission-time lookup by session deadline and skips write after expiration", async () => {
    let fakeClockMs = T0.getTime();
    const t0Start = Date.now();
    const { testDb, mediaId, runJobs } = await setup({
      baseline: "bangumi",
      type: "tv",
      title: "冷门译名",
      originalTitle: null,
      year: 2026,
      seasons: [{ season: 1, episodeCount: 12, airYear: 2026 }],
      externalIds: [],
      bangumiAssociation: "499996",
      explorationAgent: { maxDurationMs: 120, clockMs: () => fakeClockMs },
      extraHttpStub(request) {
        const url = new URL(request.url);
        if (request.namespace === "bangumi" && url.pathname.endsWith("/subjects/499996")) {
          return json(request.url, { id: 499996, type: 2, name: "冷门译名", eps: 12 });
        }
        if (request.namespace === "tmdb" && url.pathname.endsWith("/search/tv")) {
          return json(request.url, { results: [] });
        }
        if (request.namespace === "tmdb" && url.pathname.endsWith("/tv/311842")) {
          return new Promise<ExternalHttpResponse>((resolve) => {
            setTimeout(() => {
              fakeClockMs += 5000;
              resolve(
                json(request.url, {
                  id: 311842,
                  name: "冷门译名",
                  original_name: "FX戦士くるみちゃん",
                  first_air_date: "2026-10-01",
                  seasons: [{ season_number: 1, episode_count: 12, air_date: "2026-10-01" }],
                  external_ids: {},
                }),
              );
            }, 2500);
          });
        }
        return null;
      },
      invokeModel(): ModelInvocationResponse {
        return {
          content: null,
          toolCalls: [{ id: "c1", name: "submit_tmdb_id", arguments: { nativeId: "tv:311842" } }],
          model: "test-model",
        };
      },
    });

    expect(await runJobs()).toEqual([EXPLORATION_JOB_TYPE]);
    expect(Date.now() - t0Start).toBeLessThan(1500);
    expect(await externalIds(testDb, mediaId)).toEqual([]);
    expect((await listDemands(testDb.readDb, { mediaId }))[0]?.status).toBe("open");
  });

  test("TMDB fallback skips write if session deadline passes while uncached lookup completes", async () => {
    let fakeClockMs = T0.getTime();
    const { testDb, mediaId, runJobs } = await setup({
      baseline: "bangumi",
      type: "tv",
      title: "冷门译名",
      originalTitle: null,
      year: 2026,
      seasons: [{ season: 1, episodeCount: 12, airYear: 2026 }],
      externalIds: [],
      bangumiAssociation: "499995",
      explorationAgent: { maxDurationMs: 1000, clockMs: () => fakeClockMs },
      extraHttpStub(request) {
        const url = new URL(request.url);
        if (request.namespace === "bangumi" && url.pathname.endsWith("/subjects/499995")) {
          return json(request.url, { id: 499995, type: 2, name: "冷门译名", eps: 12 });
        }
        if (request.namespace === "tmdb" && url.pathname.endsWith("/search/tv")) {
          return json(request.url, { results: [] });
        }
        if (request.namespace === "tmdb" && url.pathname.endsWith("/tv/311842")) {
          fakeClockMs += 2000;
          return json(request.url, {
            id: 311842,
            name: "冷门译名",
            original_name: "FX戦士くるみちゃん",
            first_air_date: "2026-10-01",
            seasons: [{ season_number: 1, episode_count: 12, air_date: "2026-10-01" }],
            external_ids: {},
          });
        }
        return null;
      },
      invokeModel(): ModelInvocationResponse {
        return {
          content: null,
          toolCalls: [{ id: "c1", name: "submit_tmdb_id", arguments: { nativeId: "tv:311842" } }],
          model: "test-model",
        };
      },
    });

    expect(await runJobs()).toEqual([EXPLORATION_JOB_TYPE]);
    expect(await externalIds(testDb, mediaId)).toEqual([]);
    expect((await listDemands(testDb.readDb, { mediaId }))[0]?.status).toBe("open");
  });

  test("TMDB lookup falls back to agent session and enforces identity gate on submit_tmdb_id", async () => {
    let step = 0;
    const toolReplies: unknown[] = [];
    const { testDb, mediaId, runJobs } = await setup({
      baseline: "bangumi",
      type: "tv",
      title: "冷门译名",
      originalTitle: null,
      year: 2026,
      seasons: [{ season: 1, episodeCount: 12, airYear: 2026 }],
      externalIds: [],
      bangumiAssociation: "499998",
      extraHttpStub(request) {
        const url = new URL(request.url);
        if (request.namespace === "bangumi" && url.pathname.endsWith("/subjects/499998")) {
          return json(request.url, { id: 499998, type: 2, name: "冷门译名", eps: 12 });
        }
        if (request.namespace === "tmdb" && url.pathname.endsWith("/search/tv")) {
          const q = url.searchParams.get("query");
          return json(request.url, {
            results:
              q === "FX戦士くるみちゃん"
                ? [
                    {
                      id: 311842,
                      name: "FX战士久留美",
                      original_name: "FX戦士くるみちゃん",
                      first_air_date: "2026-10-01",
                    },
                  ]
                : [],
          });
        }
        if (request.namespace === "tmdb" && url.pathname.endsWith("/tv/999")) {
          return json(request.url, {
            id: 999,
            name: "无关剧集",
            original_name: "Other Show",
            first_air_date: "2010-01-01",
            external_ids: {},
          });
        }
        if (request.namespace === "tmdb" && url.pathname.endsWith("/tv/311842")) {
          return json(request.url, {
            id: 311842,
            name: "冷门译名",
            original_name: "FX戦士くるみちゃん",
            first_air_date: "2026-10-01",
            seasons: [{ season_number: 1, episode_count: 12, air_date: "2026-10-01" }],
            external_ids: {},
          });
        }
        return null;
      },
      invokeModel(request: ModelInvocationRequest): ModelInvocationResponse {
        const tools = request.tools ? request.messages.filter((m) => m.role === "tool") : [];
        if (tools.length > 0) {
          toolReplies.push(JSON.parse(tools.at(-1)!.content));
        }
        step += 1;
        if (step === 1) {
          return {
            content: null,
            toolCalls: [{ id: "c1", name: "submit_tmdb_id", arguments: { nativeId: "tv:999" } }],
            model: "test-model",
          };
        }
        if (step === 2) {
          return {
            content: null,
            toolCalls: [
              {
                id: "c2",
                name: "search_catalog",
                arguments: { source: "tmdb", query: "FX戦士くるみちゃん", type: "tv", year: 2026 },
              },
            ],
            model: "test-model",
          };
        }
        return {
          content: null,
          toolCalls: [
            {
              id: "c3",
              name: "submit_tmdb_id",
              arguments: { nativeId: "tv:311842", rationale: "exact air year and episode count" },
            },
          ],
          model: "test-model",
        };
      },
    });

    expect(await runJobs()).toEqual([EXPLORATION_JOB_TYPE]);
    expect(toolReplies[0]).toMatchObject({ ok: false, error: "IDENTITY_CHECK_FAILED" });
    expect(await externalIds(testDb, mediaId)).toEqual([
      { namespace: "tmdb", native_id: "tv:311842", source: "agent" },
    ]);
    expect((await listDemands(testDb.readDb, { mediaId }))[0]?.status).toBe("fulfilled");
  });

  test("approving the Douban request while TMDB is still missing reopens the demand to retry TMDB", async () => {
    const { testDb, mediaId, runJobs } = await setup({
      baseline: "douban",
      externalIds: [["imdb", "tt0137523"]],
      tmdbFindEmpty: true,
    });
    const demand = async () => (await listDemands(testDb.readDb, { mediaId }))[0]!;

    // TMDB not found, Douban change request submitted: waits for review.
    expect(await runJobs()).toEqual([EXPLORATION_JOB_TYPE]);
    expect((await demand()).status).toBe("awaiting_review");

    // Approval covers Douban but not TMDB: the demand is explorable again, not stuck.
    expect(await runJobs()).toEqual([EVIDENCE_CHECK_JOB_TYPE]);
    expect((await demand()).status).toBe("open");

    // The retry only has TMDB left; it is still not found, so the demand backs off.
    expect(await runJobs()).toEqual([EXPLORATION_JOB_TYPE]);
    expect((await demand()).status).toBe("not_found");
  });
});
