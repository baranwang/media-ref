import type { Message, MessageBatch, ScheduledController } from "@cloudflare/workers-types";
import {
  acquireAdvisoryLock,
  ADVISORY_LOCK_CLASSES,
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
  type ModelToolCall,
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

function callTool(name: string, args: ModelToolCall["arguments"]): ModelInvocationResponse {
  return { content: null, toolCalls: [{ id: name, name, arguments: args }], model: "test-model" };
}

function tryTmdbId(nativeId: string) {
  return (request: ModelInvocationRequest) =>
    request.messages.some((message) => message.role === "tool")
      ? callTool("mark_not_found", { reason: "unverified" })
      : callTool("submit_tmdb_id", { nativeId, rationale: "I verified the official translation." });
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

  test.each([
    {
      lookup: "imdb",
      id: "tt0137523",
      other: "tvdb",
      otherId: "42",
      detailIds: { imdb_id: "tt0137523", tvdb_id: 43 },
    },
    {
      lookup: "tvdb",
      id: "42",
      other: "trakt",
      otherId: "movie:12",
      detailIds: { tvdb_id: 42, trakt_id: 13 },
    },
  ])(
    "a reciprocal $lookup ID cannot override a conflicting $other ID in any stage",
    async ({ lookup, id, other, otherId, detailIds }) => {
      const { testDb, mediaId, outbound, runJobs } = await setup({
        baseline: "douban",
        doubanAssociation: "1292000",
        externalIds: [
          [lookup, id],
          [other, otherId],
        ],
        tmdbFindEmpty: true,
        extraHttpStub(request) {
          const path = new URL(request.url).pathname;
          if (path.endsWith(`/find/${id}`))
            return json(request.url, { movie_results: [{ id: 550 }] });
          const movie = {
            id: 550,
            title: "搏击俱乐部",
            original_title: "Fight Club",
            release_date: "1999-10-15",
          };
          if (path.endsWith("/search/movie")) return json(request.url, { results: [movie] });
          if (path.endsWith("/movie/550"))
            return json(request.url, { ...movie, external_ids: detailIds });
          return null;
        },
        invokeModel: tryTmdbId("movie:550"),
      });

      await runJobs();
      expect((await externalIds(testDb, mediaId)).map((row) => row.native_id).sort()).toEqual(
        [id, otherId].sort(),
      );
      expect(outbound.modelRequests).toHaveLength(2);
      expect((await listDemands(testDb.readDb, { mediaId }))[0]?.status).toBe("not_found");
    },
  );

  test.each([
    {
      ns: "imdb",
      id: "tt0137523",
      detailIds: { imdb_id: "tt0137523" },
      secondType: "movie_results",
    },
    { ns: "tvdb", id: "42", detailIds: { tvdb_id: 42 }, secondType: "movie_results" },
    { ns: "imdb", id: "tt0137523", detailIds: { imdb_id: "tt0137523" }, secondType: "tv_results" },
    { ns: "tvdb", id: "42", detailIds: { tvdb_id: 42 }, secondType: "tv_episode_results" },
  ])(
    "an ambiguous $ns /find with another hit in $secondType is insufficient after search or model submission",
    async ({ ns, id, detailIds, secondType }) => {
      const { testDb, mediaId, outbound, runJobs } = await setup({
        baseline: "douban",
        doubanAssociation: "1292000",
        externalIds: [[ns, id]],
        extraHttpStub(request) {
          const path = new URL(request.url).pathname;
          if (path.endsWith(`/find/${id}`))
            return json(request.url, {
              movie_results: [{ id: 550 }],
              [secondType]:
                secondType === "movie_results" ? [{ id: 550 }, { id: 551 }] : [{ id: 551 }],
            });
          const movie = { id: 550, title: "Another Movie" };
          if (path.endsWith("/search/movie")) return json(request.url, { results: [movie] });
          if (path.endsWith("/movie/550"))
            return json(request.url, { ...movie, external_ids: detailIds });
          if (path.endsWith("/movie/551"))
            return json(request.url, { id: 551, title: "Third Movie", external_ids: detailIds });
          return null;
        },
        invokeModel: tryTmdbId("movie:550"),
      });

      await runJobs();
      expect((await externalIds(testDb, mediaId)).map((row) => row.native_id)).toEqual([id]);
      expect(outbound.modelRequests).toHaveLength(2);
      expect((await listDemands(testDb.readDb, { mediaId }))[0]?.status).toBe("not_found");
    },
  );

  test("a confirmed source reporting a conflicting IMDb ID cannot supply identity evidence", async () => {
    const { testDb, mediaId, outbound, runJobs } = await setup({
      baseline: "douban",
      doubanAssociation: "1292000",
      externalIds: [["imdb", "tt0137523"]],
      extraHttpStub(request) {
        return new URL(request.url).pathname.endsWith("/subject/1292000")
          ? json(request.url, { title: "搏击俱乐部", imdb_id: "tt1234567" })
          : null;
      },
    });
    await runJobs();
    expect((await externalIds(testDb, mediaId)).map((row) => row.native_id)).toEqual(["tt0137523"]);
    expect(outbound.httpRequests.some((request) => request.namespace === "tmdb")).toBe(false);
  });

  test("an independent TVDB link resolves a shared IMDb ID across different official titles", async () => {
    const { testDb, mediaId, outbound, runJobs } = await setup({
      baseline: "douban",
      doubanAssociation: "1292000",
      externalIds: [
        ["imdb", "tt0137523"],
        ["tvdb", "movie:42"],
      ],
      extraHttpStub(request) {
        const path = new URL(request.url).pathname;
        if (path.endsWith("/find/tt0137523"))
          return json(request.url, { movie_results: [{ id: 550 }, { id: 551 }] });
        if (path.endsWith("/find/42")) return json(request.url, { movie_results: [{ id: 550 }] });
        if (path.endsWith("/movie/550"))
          return json(request.url, {
            id: 550,
            title: "另一译名",
            external_ids: { tvdb_id: 42, imdb_id: "tt0137523" },
          });
        return null;
      },
    });
    await runJobs();
    expect((await externalIds(testDb, mediaId)).map((row) => row.native_id)).toEqual([
      "tt0137523",
      "movie:550",
      "movie:42",
    ]);
    expect(outbound.modelRequests).toHaveLength(0);
  });

  test("a new conflicting IMDb ID between lookup and submission prevents the entire write", async () => {
    const { testDb, mediaId, runJobs } = await setup({
      baseline: "douban",
      doubanAssociation: "1292000",
      externalIds: [],
      tmdbSearchEmpty: true,
      async invokeModel() {
        await testDb.writeDb
          .insertInto("associations")
          .values({
            media_id: mediaId,
            namespace: "imdb",
            native_id: "tt1234567",
            status: "confirmed",
            is_external_id: true,
            source: "sync",
          })
          .execute();
        return callTool("submit_tmdb_id", { nativeId: "movie:550" });
      },
    });
    await runJobs();
    expect(await externalIds(testDb, mediaId)).toEqual([
      { namespace: "imdb", native_id: "tt1234567", source: "sync" },
    ]);
    expect((await listDemands(testDb.readDb, { mediaId }))[0]?.status).toBe("not_found");
  });

  test.each(["tmdb", "tvdb"] as const)("an owned %s ID vetoes the write", async (namespace) => {
    const { testDb, mediaId, runJobs } = await setup({
      baseline: "douban",
      externalIds: [["imdb", "tt0137523"]],
      doubanAssociation: "1292000",
      extraHttpStub(request) {
        if (!new URL(request.url).pathname.endsWith("/movie/550")) return null;
        return json(request.url, {
          id: 550,
          title: "Fight Club",
          external_ids: { imdb_id: "tt0137523", tvdb_id: 42 },
        });
      },
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
        namespace,
        native_id: namespace === "tmdb" ? "movie:550" : "42",
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
    expect(alerts[0]?.details).toMatchObject({ namespace, otherMediaId: other.id });
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

  test.each([
    { alias: "Example TV", expectedId: null },
    { alias: "另一个名字", expectedId: "movie:90003" },
  ])(
    "TMDB verifies an alias search for $alias independently of the title's punctuation",
    async ({ alias, expectedId }) => {
      const { testDb, mediaId, outbound, runJobs } = await setup({
        baseline: "douban",
        doubanAssociation: "1292000",
        externalIds: [],
        title: "Example (TV)",
        originalTitle: null,
        extraHttpStub(request) {
          const url = new URL(request.url);
          if (url.pathname.endsWith("/subject/1292000")) {
            return json(request.url, { title: "Example (TV)", aka: ["Example TV", alias] });
          }
          if (url.pathname.endsWith("/search/movie")) {
            const hit = { id: 90003, title: "Example (TV)" };
            return json(request.url, {
              results:
                url.searchParams.get("query") === (expectedId ? alias : hit.title) ? [hit] : [],
            });
          }
          if (url.pathname.endsWith("/movie/90003")) {
            return json(request.url, {
              id: 90003,
              title: "Example (TV)",
              original_title: alias,
              release_date: "1999-03-01",
              external_ids: {},
            });
          }
          return null;
        },
      });

      expect(await runJobs()).toEqual([EXPLORATION_JOB_TYPE]);
      const ids = (await externalIds(testDb, mediaId)).map((row) => row.native_id);
      expect(ids).toEqual(expectedId ? [expectedId] : []);
      expect(outbound.modelRequests).toHaveLength(expectedId ? 0 : 1);
    },
  );

  test.each([
    { sourceYear: 2024, tmdbYear: 2025 },
    { sourceYear: 2025, tmdbYear: 2024 },
    { sourceYear: 2025, tmdbYear: 2025 },
  ])(
    "one shared title and 12 episodes require the same season year ($sourceYear and $tmdbYear)",
    async ({ sourceYear, tmdbYear }) => {
      const { testDb, mediaId, outbound, runJobs } = await setup({
        baseline: "bangumi",
        bangumiAssociation: "12345",
        type: "tv",
        title: "Example",
        originalTitle: null,
        year: 2024,
        seasons: [{ season: 1, airYear: sourceYear, episodeCount: 12 }],
        externalIds: [],
        extraHttpStub(request) {
          const path = new URL(request.url).pathname;
          if (path.endsWith("/subjects/12345"))
            return json(request.url, { id: 12345, type: 2, name: "Example" });
          const show = { id: 42, name: "Example", first_air_date: "2024-05-01" };
          if (path.endsWith("/search/tv")) return json(request.url, { results: [show] });
          if (path.endsWith("/tv/42"))
            return json(request.url, {
              ...show,
              external_ids: {},
              seasons: [
                {
                  season_number: 1,
                  air_date: "2024-05-01",
                  episode_count: tmdbYear === 2024 ? 12 : 24,
                },
                {
                  season_number: 2,
                  air_date: "2025-05-01",
                  episode_count: tmdbYear === 2025 ? 12 : 24,
                },
              ],
            });
          return null;
        },
        invokeModel: tryTmdbId("tv:42"),
      });

      await runJobs();
      const sameSeason = sourceYear === tmdbYear;
      expect((await externalIds(testDb, mediaId)).map((r) => r.native_id)).toEqual(
        sameSeason ? ["tv:42"] : [],
      );
      expect(outbound.modelRequests).toHaveLength(sameSeason ? 0 : 2);
    },
  );

  test.each([
    { count: 2, totalPages: 1 },
    { count: 6, totalPages: 1 },
    { count: 1, totalPages: 2 },
  ])(
    "a title match among $count search hits on $totalPages pages must be unambiguous before writing",
    async ({ count, totalPages }) => {
      const hits = Array.from({ length: count }, (_, index) => ({
        id: 550 + index,
        title: index === 0 || index === count - 1 ? "搏击俱乐部" : `Other ${index}`,
        original_title: index === 0 || index === count - 1 ? "Fight Club" : null,
        release_date: "1999-10-15",
      }));
      const { testDb, mediaId, outbound, runJobs } = await setup({
        baseline: "douban",
        doubanAssociation: "1292000",
        externalIds: [],
        extraHttpStub(request) {
          const path = new URL(request.url).pathname;
          if (path.endsWith("/search/movie"))
            return json(request.url, { results: hits, total_pages: totalPages });
          const hit = hits.find((entry) => path.endsWith(`/movie/${entry.id}`));
          return hit ? json(request.url, { ...hit, external_ids: {} }) : null;
        },
        invokeModel: tryTmdbId("movie:550"),
      });

      await runJobs();
      expect(await externalIds(testDb, mediaId)).toEqual([]);
      expect(outbound.modelRequests).toHaveLength(2);
      expect(
        outbound.httpRequests.filter((r) => /\/movie\/\d+$/.test(new URL(r.url).pathname)),
      ).toHaveLength(Math.min(count, 5));
    },
  );

  test("catalog lookup and submission reject a zero-padded TMDB ID even when TMDB serves it", async () => {
    const replies: unknown[] = [];
    const { testDb, mediaId, outbound, runJobs } = await setup({
      baseline: "douban",
      doubanAssociation: "1292000",
      externalIds: [],
      tmdbSearchEmpty: true,
      extraHttpStub(request) {
        return new URL(request.url).pathname.endsWith("/movie/0550")
          ? json(request.url, {
              id: 550,
              title: "搏击俱乐部",
              original_title: "Fight Club",
              external_ids: {},
            })
          : null;
      },
      invokeModel(request) {
        const last = request.messages.at(-1);
        if (last?.role === "tool") replies.push(JSON.parse(last.content));
        if (!replies.length)
          return callTool("get_catalog_entry", { source: "tmdb", id: "movie:0550" });
        if (replies.length === 1) return callTool("submit_tmdb_id", { nativeId: "movie:0550" });
        return callTool("mark_not_found", { reason: "invalid ID" });
      },
    });

    await runJobs();
    expect(await externalIds(testDb, mediaId)).toEqual([]);
    expect(replies).toMatchObject([{ error: "BAD_ID" }, { error: "BAD_TMDB_ID" }]);
    expect(outbound.httpRequests.some((r) => r.url.includes("/movie/0550"))).toBe(false);
  });

  test("TMDB fallback session keeps search tools available even when explorationAgent maxDurationMs exceeds 6 minutes", async () => {
    let seenToolNames: string[] = [];
    let searchTimeoutMs: number | undefined;
    const { testDb, mediaId, runJobs } = await setup({
      baseline: "bangumi",
      type: "tv",
      title: "冷门译名",
      originalTitle: null,
      year: 2026,
      seasons: [{ season: 1, episodeCount: 12, airYear: 2026 }],
      externalIds: [],
      bangumiAssociation: "499997",
      explorationAgent: { maxDurationMs: 10 * 60_000, clockMs: () => T0.getTime() },
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
          searchTimeoutMs = request.timeoutMs;
        }
        return {
          content: null,
          toolCalls: [{ id: "c1", name: "mark_not_found", arguments: { reason: "not on tmdb" } }],
          model: "test-model",
        };
      },
    });

    expect(await runJobs()).toEqual([EXPLORATION_JOB_TYPE]);
    expect(searchTimeoutMs).toBe(67_500);
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

  test("TMDB fallback rolls back every ID when the deadline passes while waiting on a database lock", async () => {
    let clockMs = T0.getTime();
    const { testDb, mediaId, runJobs } = await setup({
      baseline: "douban",
      doubanAssociation: "1292000",
      externalIds: [],
      tmdbSearchEmpty: true,
      explorationAgent: { maxDurationMs: 10_000, clockMs: () => clockMs },
      extraHttpStub(request) {
        if (new URL(request.url).pathname.endsWith("/movie/550")) {
          return json(request.url, {
            id: 550,
            title: "搏击俱乐部",
            original_title: "Fight Club",
            release_date: "1999-10-15",
            external_ids: { tvdb_id: 123 },
          });
        }
        return null;
      },
      invokeModel: () => ({
        content: null,
        toolCalls: [{ id: "c1", name: "submit_tmdb_id", arguments: { nativeId: "movie:550" } }],
        model: "test-model",
      }),
    });

    const { job } = await testDb.readDb.transaction().execute(async (trx) => {
      await acquireAdvisoryLock(trx, ADVISORY_LOCK_CLASSES.MEDIA_NAMESPACE, `${mediaId}:tvdb`);
      const job = runJobs();
      const sessions = testDb.readDb.withTables<{
        pg_stat_activity: { datname: string; wait_event: string | null };
      }>();
      await expect
        .poll(() =>
          sessions
            .selectFrom("pg_stat_activity")
            .select("wait_event")
            .where("datname", "=", testDb.dbName)
            .where("wait_event", "=", "advisory")
            .executeTakeFirst(),
        )
        .toBeDefined();
      clockMs += 10_000;
      return { job };
    });

    expect(await job).toEqual([EXPLORATION_JOB_TYPE]);
    expect(await externalIds(testDb, mediaId)).toEqual([]);
    expect((await listDemands(testDb.readDb, { mediaId }))[0]?.status).toBe("open");
  });

  test.each(["translation", "trakt"])(
    "the model finds an official title using fetched %s evidence",
    async (proof) => {
      let step = 0;
      const toolReplies: unknown[] = [];
      const { testDb, mediaId, runJobs } = await setup({
        baseline: "bangumi",
        type: "tv",
        title: "冷门译名",
        originalTitle: null,
        year: 2026,
        seasons: [{ season: 1, episodeCount: 12, airYear: 2026 }],
        externalIds: proof === "trakt" ? [["trakt", "show:42"]] : [],
        bangumiAssociation: "499998",
        extraHttpStub(request) {
          const url = new URL(request.url);
          if (request.namespace === "bangumi" && url.pathname.endsWith("/subjects/499998")) {
            return json(request.url, {
              id: 499998,
              type: 2,
              name: "冷门译名",
              eps: 12,
              infobox: [{ key: "动画制作", value: "Example Studio" }],
            });
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
          if (url.pathname.endsWith("/tv/999") || url.pathname.endsWith("/tv/998")) {
            const sameStudio = url.pathname.endsWith("/tv/998");
            return json(request.url, {
              id: sameStudio ? 998 : 999,
              name: "无关剧集",
              first_air_date: "2026-01-01",
              seasons: [
                { season_number: 1, episode_count: sameStudio ? 24 : 12, air_date: "2026-01-01" },
              ],
              production_companies: sameStudio ? [{ name: "Example Studio" }] : [],
              external_ids: {},
            });
          }
          if (url.pathname.endsWith("/tv/311842")) {
            return json(request.url, {
              id: 311842,
              name: "FX战士久留美",
              original_name: "FX戦士くるみちゃん",
              translations: {
                translations: proof === "translation" ? [{ data: { name: "冷门译名" } }] : [],
              },
              first_air_date: "2026-10-01",
              seasons: [{ season_number: 1, episode_count: 12, air_date: "2026-10-01" }],
              external_ids: proof === "trakt" ? { trakt_id: 42 } : {},
            });
          }
          return null;
        },
        invokeModel(request) {
          const last = request.messages.at(-1);
          if (last?.role === "tool") toolReplies.push(JSON.parse(last.content));
          step += 1;
          if (step <= 2)
            return callTool("submit_tmdb_id", {
              nativeId: step === 1 ? "tv:999" : "tv:998",
              rationale: "This is the official title.",
            });
          if (step === 3)
            return callTool("search_catalog", {
              source: "tmdb",
              query: "FX戦士くるみちゃん",
              type: "tv",
              year: 2026,
            });
          if (step === 4) return callTool("get_catalog_entry", { source: "tmdb", id: "tv:311842" });
          return callTool("submit_tmdb_id", { nativeId: "tv:311842" });
        },
      });

      expect(await runJobs()).toEqual([EXPLORATION_JOB_TYPE]);
      expect(toolReplies.slice(0, 2)).toMatchObject([
        { ok: false, error: "IDENTITY_CHECK_FAILED" },
        { ok: false, error: "IDENTITY_CHECK_FAILED" },
      ]);
      expect(await externalIds(testDb, mediaId)).toEqual([
        { namespace: "tmdb", native_id: "tv:311842", source: "agent" },
        ...(proof === "trakt"
          ? [{ namespace: "trakt", native_id: "show:42", source: "sync" }]
          : []),
      ]);
      expect((await listDemands(testDb.readDb, { mediaId }))[0]?.status).toBe("fulfilled");
    },
  );

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
