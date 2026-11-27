import type { Message, MessageBatch, ScheduledController } from "@cloudflare/workers-types";
import { createApiApp } from "@media-ref/api/app";
import {
  approveChangeRequest,
  bilibiliAdapter,
  convergeDuplicateMedia,
  createAdapterRegistry,
  createChangeRequest,
  createFakeOutboundClient,
  createTmdbGateway,
  DOUBAN_API,
  EXPLORATION_JOB_TYPE,
  listDemands,
  mergeMedia,
  queryMediaByKey,
  recordDemandForRead,
  runTmdbDailySync,
  tencentAdapter,
  type AdapterRegistry,
  type ExternalHttpRequest,
  type ExternalHttpResponse,
  type JobQueueMessage,
  type Tier3Adapter,
} from "@media-ref/core";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { createBackgroundWorker } from "../src/index.ts";
import {
  approveInCore,
  createRpcClients,
  issueApiKeyRpc,
  mediaRef,
  signUpAndVerifyUser,
  TEST_BASE_URL,
  toProtoSegmentInput,
} from "./rpc-helpers.ts";

const TEST_AUTH_SECRET = "test-secret-for-duplicate-media-merge-regression-tests-0123456789";

DOUBAN_API.apiKey = "test-douban-key";
DOUBAN_API.minIntervalMs = 0;
DOUBAN_API.retryDelayMs = 0;

function createScheduledController(scheduledTime: Date): ScheduledController {
  return {
    scheduledTime: scheduledTime.getTime(),
    cron: "* * * * *",
    noRetry() {},
  };
}

function createQueueBatch(
  bodies: JobQueueMessage[],
  timestamp: Date = new Date(),
): {
  batch: MessageBatch<JobQueueMessage>;
} {
  const messages: Message<JobQueueMessage>[] = bodies.map((body, index) => ({
    id: `msg-${index + 1}-${body.jobId}-gen-${body.leaseGeneration}`,
    timestamp,
    body,
    attempts: 1,
    ack() {},
    retry() {},
  }));

  return {
    batch: {
      queue: "media-ref-jobs",
      messages,
      metadata: {
        metrics: {
          backlogCount: messages.length,
          backlogBytes: 0,
        },
      },
      ackAll() {},
      retryAll() {},
    },
  };
}

function createTier3BilibiliStub(): Tier3Adapter<"bilibili"> {
  return {
    ...bilibiliAdapter,
    tier: 3,
    async search() {
      return { status: "ok", candidates: [] };
    },
  };
}

function createTestPlatformRegistry(): AdapterRegistry {
  return createAdapterRegistry([createTier3BilibiliStub(), tencentAdapter]);
}

function createDoubanSubjectResponse(
  request: ExternalHttpRequest,
  options: {
    id: string;
    title: string;
    originalTitle?: string;
    year?: string;
    type?: "movie" | "tv";
    episodesCount?: number | null;
    imdbId?: string | null;
    aka?: string[];
  },
): ExternalHttpResponse {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    url: request.url,
    body: JSON.stringify({
      id: options.id,
      title: options.title,
      original_title: options.originalTitle ?? options.title,
      year: options.year ?? "2026",
      type: options.type ?? "tv",
      subtype: options.type ?? "tv",
      episodes_count: options.episodesCount ?? (options.type === "movie" ? null : 40),
      pubdate: [`${options.year ?? "2026"}-01-01(中国大陆)`],
      aka: options.aka ?? [],
      ...(options.imdbId ? { imdb: options.imdbId } : {}),
      pic: { normal: `https://img.doubanio.com/${options.id}.jpg` },
    }),
  };
}

function createDoubanHtmlResponse(
  request: ExternalHttpRequest,
  options: {
    id: string;
    title: string;
    year?: string;
    type?: "movie" | "tv";
    episodesCount?: number | null;
    imdbId?: string | null;
  },
): ExternalHttpResponse {
  const imdbBlock = options.imdbId ? `<span class="pl">IMDb:</span> ${options.imdbId}<br/>` : "";
  const epBlock =
    options.type !== "movie" && options.episodesCount
      ? `<span class="pl">集数:</span> ${options.episodesCount}<br/>`
      : "";
  return {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    url: request.url,
    body: `<!doctype html><html><head><title>${options.title} (豆瓣)</title></head><body><h1><span property="v:itemreviewed">${options.title}</span><span class="year">(${options.year ?? "2026"})</span></h1><div id="info">${epBlock}${imdbBlock}</div></body></html>`,
  };
}

describe("Duplicate media creation prevention & auto-merge (#99)", () => {
  const handles: TestDbHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop();
      if (handle) {
        await handle.cleanup();
      }
    }
  });

  test("exploration job for externalKey douban:35235320 reuses existing media holding seed_unconfirmed douban:35235320 instead of creating a duplicate media", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);
    const db = testDb.writeDb;
    const now = new Date("2026-11-24T10:00:00.000Z");

    // Existing TMDB media 3e1981bd already holds seed_unconfirmed douban:35235320
    const tmdbMedia = await db
      .insertInto("media")
      .values({
        type: "tv",
        baseline: "tmdb",
        title: "两京十五日",
        original_title: "两京十五日",
        year: 2026,
        seasons: JSON.stringify([{ season: 1, episodeCount: 40, airYear: 2026 }]),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await db
      .insertInto("associations")
      .values({
        media_id: tmdbMedia.id,
        namespace: "tmdb",
        native_id: "tv:203483",
        is_external_id: true,
        status: "confirmed",
        needs_review: false,
        locked: false,
      })
      .execute();

    const seedDoubanAssoc = await db
      .insertInto("associations")
      .values({
        media_id: tmdbMedia.id,
        namespace: "douban",
        native_id: "35235320",
        is_external_id: false,
        status: "seed_unconfirmed",
        needs_review: false,
        locked: false,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await db
      .insertInto("segments")
      .values({
        association_id: seedDoubanAssoc.id,
        season: 1,
        episode_start: 1,
        episode_end: 40,
        target_episode_start: 1,
        baseline: "tmdb",
        non_linear: false,
        needs_review: false,
      })
      .execute();

    // Reading douban:35235320 with default includeUnconfirmed=false creates an external_key demand
    const queryResult = await queryMediaByKey(db, "douban:35235320");
    await recordDemandForRead(db, {
      rawKey: "douban:35235320",
      queryResult,
      now,
    });
    await db
      .updateTable("demands")
      .set({ demand_count: 10, next_eligible_at: now })
      .where("external_key", "=", "douban:35235320")
      .execute();

    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        const url = new URL(request.url);
        if (url.hostname === "frodo.douban.com" && url.pathname.includes("35235320")) {
          return createDoubanSubjectResponse(request, {
            id: "35235320",
            title: "两京十五日",
            year: "2026",
            type: "tv",
            episodesCount: 40,
          });
        }
        if (url.hostname === "movie.douban.com" && url.pathname.includes("/subject/35235320")) {
          return createDoubanHtmlResponse(request, {
            id: "35235320",
            title: "两京十五日",
            year: "2026",
            type: "tv",
            episodesCount: 40,
          });
        }
        throw new Error(`Unexpected outbound URL: ${request.url}`);
      },
    });

    const emitted: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db,
      outbound,
      queue: {
        async send(msg) {
          emitted.push(msg);
        },
      },
      adapterRegistry: createTestPlatformRegistry(),
      config: {
        enableDailyTmdbSync: false,
        tmdb: { accessToken: "test-tmdb-token" },
        exploration: { dailyBudget: 10 },
      },
      explorationExecutor: async () => ({
        platformOutcomes: [{ namespace: "bilibili", status: "not_found" }],
      }),
      now: () => now,
    });

    await worker.scheduled(createScheduledController(now));
    const explorationMsgs = emitted.filter((m) => m.jobType === EXPLORATION_JOB_TYPE);
    expect(explorationMsgs).toHaveLength(1);

    await worker.queue(createQueueBatch(explorationMsgs, now).batch);

    const activeMedia = await db
      .selectFrom("media")
      .selectAll()
      .where("merged_into_media_id", "is", null)
      .execute();
    expect(activeMedia).toHaveLength(1);
    expect(activeMedia[0]!.id).toBe(tmdbMedia.id);

    const doubanRows = await db
      .selectFrom("associations")
      .selectAll()
      .where("is_external_id", "=", false)
      .where("namespace", "=", "douban")
      .where("native_id", "=", "35235320")
      .where("status", "!=", "delisted")
      .execute();
    expect(doubanRows).toHaveLength(1);
    expect(doubanRows[0]!.media_id).toBe(tmdbMedia.id);
    expect(doubanRows[0]!.status).toBe("confirmed");
  });

  test("approving a new-target CR for douban:35235320 reuses existing media holding matching IMDb external ID or seed_unconfirmed douban", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);
    const db = testDb.writeDb;
    const now = new Date("2026-11-24T10:00:00.000Z");

    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        const url = new URL(request.url);
        if (url.hostname === "frodo.douban.com" && url.pathname.includes("35235320")) {
          return createDoubanSubjectResponse(request, {
            id: "35235320",
            title: "两京十五日",
            year: "2026",
            type: "tv",
            episodesCount: 40,
            imdbId: "tt9915020",
          });
        }
        if (url.hostname === "movie.douban.com" && url.pathname.includes("/subject/35235320")) {
          return createDoubanHtmlResponse(request, {
            id: "35235320",
            title: "两京十五日",
            year: "2026",
            type: "tv",
            episodesCount: 40,
            imdbId: "tt9915020",
          });
        }
        if (url.pathname.endsWith("/find/tt9915020")) {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            url: request.url,
            body: JSON.stringify({
              movie_results: [],
              tv_results: [{ id: 203483, name: "两京十五日" }],
            }),
          };
        }
        if (url.pathname.endsWith("/tv/203483")) {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            url: request.url,
            body: JSON.stringify({
              id: 203483,
              name: "两京十五日",
              original_name: "两京十五日",
              first_air_date: "2026-06-01",
              seasons: [{ season_number: 1, episode_count: 40, air_date: "2026-06-01" }],
              external_ids: { imdb_id: "tt9915020" },
            }),
          };
        }
        throw new Error(`Unexpected outbound URL: ${request.url}`);
      },
    });

    const existingTmdb = await db
      .insertInto("media")
      .values({
        type: "tv",
        baseline: "tmdb",
        title: "两京十五日",
        original_title: "两京十五日",
        year: 2026,
        seasons: JSON.stringify([{ season: 1, episodeCount: 40, airYear: 2026 }]),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await db
      .insertInto("associations")
      .values([
        {
          media_id: existingTmdb.id,
          namespace: "tmdb",
          native_id: "tv:203483",
          is_external_id: true,
          status: "confirmed",
          needs_review: false,
          locked: false,
        },
        {
          media_id: existingTmdb.id,
          namespace: "imdb",
          native_id: "tt9915020",
          is_external_id: true,
          status: "confirmed",
          needs_review: false,
          locked: false,
        },
      ])
      .execute();

    const userId = "cr-submitter-1";
    await db
      .insertInto("user")
      .values({
        id: userId,
        name: "Submitter",
        email: "cr-submitter@example.com",
        emailVerified: true,
        role: "reviewer",
        createdAt: now,
        updatedAt: now,
      })
      .execute();

    const cr = await createChangeRequest(db, {
      submitterUserId: userId,
      targetExternalKey: "douban:35235320",
      namespace: "tencent",
      nativeId: "mzc00200999",
      variantDescription: "国语",
      segments: [
        { season: 1, episodeStart: 1, episodeEnd: 40, targetEpisodeStart: 1, baseline: "tmdb" },
      ],
      now,
    });

    const approved = await approveChangeRequest(db, outbound, {
      changeRequestId: cr.id,
      reviewerUserId: userId,
      reason: "Confirmed",
      now,
      tmdbConfig: { accessToken: "test-tmdb-token" },
    });

    expect(approved.mediaId).toBe(existingTmdb.id);

    const activeMedia = await db
      .selectFrom("media")
      .selectAll()
      .where("merged_into_media_id", "is", null)
      .execute();
    expect(activeMedia).toHaveLength(1);

    const doubanRows = await db
      .selectFrom("associations")
      .selectAll()
      .where("is_external_id", "=", false)
      .where("namespace", "=", "douban")
      .where("native_id", "=", "35235320")
      .where("status", "=", "confirmed")
      .execute();
    expect(doubanRows).toHaveLength(1);
    expect(doubanRows[0]!.media_id).toBe(existingTmdb.id);
  });

  test("catalog exploration automatically merges Douban-only duplicate into matching TMDB media via IMDb /find", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);
    const db = testDb.writeDb;
    const now = new Date("2026-11-24T10:00:00.000Z");

    // 3e1981bd-style TMDB media (without Douban yet)
    const tmdbMedia = await db
      .insertInto("media")
      .values({
        type: "tv",
        baseline: "tmdb",
        title: "两京十五日",
        original_title: "两京十五日",
        year: 2026,
        seasons: JSON.stringify([{ season: 1, episodeCount: 40, airYear: 2026 }]),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await db
      .insertInto("associations")
      .values({
        media_id: tmdbMedia.id,
        namespace: "tmdb",
        native_id: "tv:203483",
        is_external_id: true,
        status: "confirmed",
        needs_review: false,
        locked: false,
      })
      .execute();

    // da1fa0d3-style Douban-only media with IMDb external ID
    const doubanMedia = await db
      .insertInto("media")
      .values({
        type: "tv",
        baseline: "douban",
        title: "两京十五日",
        original_title: "两京十五日",
        year: 2026,
        seasons: JSON.stringify([{ season: 1, episodeCount: 40, airYear: 2026 }]),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const doubanAssoc = await db
      .insertInto("associations")
      .values({
        media_id: doubanMedia.id,
        namespace: "douban",
        native_id: "35235320",
        is_external_id: false,
        status: "confirmed",
        needs_review: false,
        locked: false,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await db
      .insertInto("segments")
      .values({
        association_id: doubanAssoc.id,
        season: 1,
        episode_start: 1,
        episode_end: 40,
        target_episode_start: 1,
        baseline: "douban",
        non_linear: false,
        needs_review: false,
      })
      .execute();
    await db
      .insertInto("associations")
      .values({
        media_id: doubanMedia.id,
        namespace: "imdb",
        native_id: "tt9915020",
        is_external_id: true,
        status: "confirmed",
        needs_review: false,
        locked: false,
      })
      .execute();

    await db
      .insertInto("demands")
      .values({
        media_id: doubanMedia.id,
        season: null,
        namespace_group: "catalog",
        demand_count: 3,
        status: "open",
        next_eligible_at: now,
        last_demanded_at: now,
      })
      .execute();

    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/find/tt9915020")) {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            url: request.url,
            body: JSON.stringify({
              movie_results: [],
              tv_results: [{ id: 203483, name: "两京十五日", first_air_date: "2026-06-01" }],
            }),
          };
        }
        if (url.pathname.endsWith("/tv/203483")) {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            url: request.url,
            body: JSON.stringify({
              id: 203483,
              name: "两京十五日",
              original_name: "两京十五日",
              first_air_date: "2026-06-01",
              seasons: [{ season_number: 1, episode_count: 40, air_date: "2026-06-01" }],
              external_ids: { imdb_id: "tt9915020" },
            }),
          };
        }
        throw new Error(`Unexpected outbound URL: ${request.url}`);
      },
    });

    const emitted: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db,
      outbound,
      queue: {
        async send(msg) {
          emitted.push(msg);
        },
      },
      adapterRegistry: createTestPlatformRegistry(),
      config: {
        enableDailyTmdbSync: false,
        tmdb: { accessToken: "test-tmdb-token" },
        exploration: { dailyBudget: 10 },
      },
      now: () => now,
    });

    await worker.scheduled(createScheduledController(now));
    const explorationMsgs = emitted.filter((m) => m.jobType === EXPLORATION_JOB_TYPE);
    expect(explorationMsgs.length).toBeGreaterThan(0);

    await worker.queue(createQueueBatch(explorationMsgs, now).batch);

    const mergedDoubanMedia = await db
      .selectFrom("media")
      .select(["id", "merged_into_media_id"])
      .where("id", "=", doubanMedia.id)
      .executeTakeFirstOrThrow();
    expect(mergedDoubanMedia.merged_into_media_id).toBe(tmdbMedia.id);

    const movedDoubanAssoc = await db
      .selectFrom("associations")
      .selectAll()
      .where("is_external_id", "=", false)
      .where("namespace", "=", "douban")
      .where("native_id", "=", "35235320")
      .where("status", "=", "confirmed")
      .execute();
    expect(movedDoubanAssoc).toHaveLength(1);
    expect(movedDoubanAssoc[0]!.media_id).toBe(tmdbMedia.id);

    const movedDemands = await listDemands(db, { mediaId: tmdbMedia.id });
    const catalogDemand = movedDemands.find((d) => d.namespaceGroup === "catalog");
    expect(catalogDemand).toBeDefined();
    expect(catalogDemand!.demandCount).toBe(3);
    expect(catalogDemand!.status).toBe("fulfilled");

    const openConflictAlerts = await db
      .selectFrom("review_alerts")
      .selectAll()
      .where("alert_type", "=", "agent_external_id_conflict")
      .where("status", "=", "open")
      .execute();
    expect(openConflictAlerts).toHaveLength(0);
  });

  test("catalog exploration merges duplicate media sharing douban:35235320 even without IMDb ID (exact #99 comment #4 state)", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);
    const db = testDb.writeDb;
    const now = new Date("2026-11-24T10:00:00.000Z");

    // 3e1981bd: has BOTH tmdb:tv:203483 and douban:35235320
    const tmdbMedia = await db
      .insertInto("media")
      .values({
        type: "tv",
        baseline: "tmdb",
        title: "两京十五日",
        original_title: "两京十五日",
        year: 2026,
        seasons: JSON.stringify([{ season: 1, episodeCount: 40, airYear: 2026 }]),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await db
      .insertInto("associations")
      .values({
        media_id: tmdbMedia.id,
        namespace: "tmdb",
        native_id: "tv:203483",
        is_external_id: true,
        status: "confirmed",
        needs_review: false,
        locked: false,
      })
      .execute();
    const tmdbDoubanAssoc = await db
      .insertInto("associations")
      .values({
        media_id: tmdbMedia.id,
        namespace: "douban",
        native_id: "35235320",
        is_external_id: false,
        status: "confirmed",
        needs_review: false,
        locked: false,
        source: "agent",
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await db
      .insertInto("segments")
      .values({
        association_id: tmdbDoubanAssoc.id,
        season: 1,
        episode_start: 1,
        episode_end: 40,
        target_episode_start: 1,
        baseline: "tmdb",
        non_linear: false,
        needs_review: false,
      })
      .execute();

    // da1fa0d3: Douban-only (no IMDb, no TMDB) also linked to douban:35235320
    const doubanMedia = await db
      .insertInto("media")
      .values({
        type: "tv",
        baseline: "douban",
        title: "两京十五日",
        original_title: "两京十五日",
        year: 2026,
        seasons: JSON.stringify([{ season: 1, episodeCount: 40, airYear: 2026 }]),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const doubanOnlyAssoc = await db
      .insertInto("associations")
      .values({
        media_id: doubanMedia.id,
        namespace: "douban",
        native_id: "35235320",
        is_external_id: false,
        status: "confirmed",
        needs_review: false,
        locked: false,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await db
      .insertInto("segments")
      .values({
        association_id: doubanOnlyAssoc.id,
        season: 1,
        episode_start: 1,
        episode_end: 40,
        target_episode_start: 1,
        baseline: "douban",
        non_linear: false,
        needs_review: false,
      })
      .execute();

    await db
      .insertInto("demands")
      .values({
        media_id: doubanMedia.id,
        season: null,
        namespace_group: "catalog",
        demand_count: 5,
        status: "open",
        next_eligible_at: now,
        last_demanded_at: now,
      })
      .execute();

    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        const url = new URL(request.url);
        if (url.hostname === "frodo.douban.com" && url.pathname.includes("35235320")) {
          return createDoubanSubjectResponse(request, {
            id: "35235320",
            title: "两京十五日",
            year: "2026",
            type: "tv",
            episodesCount: 40,
          });
        }
        throw new Error(`Unexpected outbound URL: ${request.url}`);
      },
    });

    const emitted: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db,
      outbound,
      queue: {
        async send(msg) {
          emitted.push(msg);
        },
      },
      adapterRegistry: createTestPlatformRegistry(),
      config: {
        enableDailyTmdbSync: false,
        tmdb: { accessToken: "test-tmdb-token" },
        exploration: { dailyBudget: 10 },
      },
      now: () => now,
    });

    await worker.scheduled(createScheduledController(now));
    const explorationMsgs = emitted.filter((m) => m.jobType === EXPLORATION_JOB_TYPE);
    expect(explorationMsgs.length).toBeGreaterThan(0);

    await worker.queue(createQueueBatch(explorationMsgs, now).batch);

    const refreshed = await db
      .selectFrom("media")
      .select(["id", "merged_into_media_id"])
      .where("id", "=", doubanMedia.id)
      .executeTakeFirstOrThrow();
    expect(refreshed.merged_into_media_id).toBe(tmdbMedia.id);

    const activeDouban = await db
      .selectFrom("associations")
      .selectAll()
      .where("is_external_id", "=", false)
      .where("namespace", "=", "douban")
      .where("native_id", "=", "35235320")
      .where("status", "=", "confirmed")
      .execute();
    expect(activeDouban).toHaveLength(1);
    expect(activeDouban[0]!.media_id).toBe(tmdbMedia.id);

    const sourceDemands = await listDemands(db, { mediaId: doubanMedia.id });
    expect(sourceDemands).toHaveLength(0);
    const targetDemands = await listDemands(db, { mediaId: tmdbMedia.id });
    const catalogDemand = targetDemands.find((d) => d.namespaceGroup === "catalog");
    expect(catalogDemand?.demandCount).toBe(5);
    expect(catalogDemand?.status).toBe("fulfilled");
  });

  test("submitting and approving douban:35235320 onto TMDB media merges non-TMDB duplicate instead of rejecting with SEGMENT_OVERLAP, while distinct TMDB media still reject", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);
    const db = testDb.writeDb;

    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        const url = new URL(request.url);
        if (url.hostname === "frodo.douban.com" && url.pathname.includes("35235320")) {
          return createDoubanSubjectResponse(request, {
            id: "35235320",
            title: "两京十五日",
            year: "2026",
            type: "tv",
            episodesCount: 40,
            imdbId: "tt9915020",
          });
        }
        if (url.hostname === "movie.douban.com" && url.pathname.includes("/subject/35235320")) {
          return createDoubanHtmlResponse(request, {
            id: "35235320",
            title: "两京十五日",
            year: "2026",
            type: "tv",
            episodesCount: 40,
            imdbId: "tt9915020",
          });
        }
        if (url.pathname.endsWith("/tv/203483")) {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            url: request.url,
            body: JSON.stringify({
              id: 203483,
              name: "两京十五日",
              original_name: "两京十五日",
              first_air_date: "2026-06-01",
              seasons: [{ season_number: 1, episode_count: 40, air_date: "2026-06-01" }],
              external_ids: { imdb_id: "tt9915020" },
            }),
          };
        }
        if (url.pathname.endsWith("/tv/888888")) {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            url: request.url,
            body: JSON.stringify({
              id: 888888,
              name: "无关剧集",
              original_name: "Unrelated Show",
              first_air_date: "2021-01-01",
              seasons: [{ season_number: 1, episode_count: 12, air_date: "2021-01-01" }],
              external_ids: {},
            }),
          };
        }
        throw new Error(`Unexpected outbound URL: ${request.url}`);
      },
    });

    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: db,
      outbound,
      adapterRegistry: createTestPlatformRegistry(),
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });

    const submitter = await signUpAndVerifyUser(app, outbound, {
      email: "dup-submitter@example.com",
      password: "StrongPassword123!",
      name: "Submitter",
    });
    const reviewer = await signUpAndVerifyUser(app, outbound, {
      email: "dup-reviewer@example.com",
      password: "StrongPassword123!",
      name: "Reviewer",
    });
    await db
      .updateTable("user")
      .set({ role: "reviewer" })
      .where("id", "=", reviewer.userId)
      .execute();

    const submitKey = await issueApiKeyRpc(app, submitter.cookie, {
      name: "Submit Key",
      canSubmit: true,
    });

    // Existing non-TMDB duplicate holding douban:35235320
    const doubanMedia = await db
      .insertInto("media")
      .values({
        type: "tv",
        baseline: "douban",
        title: "两京十五日",
        original_title: "两京十五日",
        year: 2026,
        seasons: JSON.stringify([{ season: 1, episodeCount: 40, airYear: 2026 }]),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const doubanAssoc = await db
      .insertInto("associations")
      .values({
        media_id: doubanMedia.id,
        namespace: "douban",
        native_id: "35235320",
        is_external_id: false,
        status: "confirmed",
        needs_review: false,
        locked: false,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await db
      .insertInto("segments")
      .values({
        association_id: doubanAssoc.id,
        season: 1,
        episode_start: 1,
        episode_end: 40,
        target_episode_start: 1,
        baseline: "douban",
        non_linear: false,
        needs_review: false,
      })
      .execute();

    // Unrelated TMDB show: submitting overlapping douban:35235320 MUST still be rejected
    const rpc = createRpcClients(app, { apiKey: submitKey.key });
    await expect(
      (async () => {
        const unrelatedCr = await rpc.changeRequest.createChangeRequest({
          target: mediaRef("tmdb:tv:888888"),
          namespace: "douban",
          nativeId: "35235320",
          segments: [
            toProtoSegmentInput({
              season: 1,
              episodeStart: 1,
              episodeEnd: 12,
              targetEpisodeStart: 1,
              baseline: "tmdb",
            }),
          ],
        });
        await approveInCore(
          { db, outbound },
          {
            id: unrelatedCr.changeRequest!.id,
            reason: "Should fail",
            reviewerUserId: reviewer.userId,
          },
        );
      })(),
    ).rejects.toThrow();

    // Clean unrelated CR row if created so next submission works cleanly
    const mediaStillUnmerged = await db
      .selectFrom("media")
      .select("merged_into_media_id")
      .where("id", "=", doubanMedia.id)
      .executeTakeFirstOrThrow();
    expect(mediaStillUnmerged.merged_into_media_id).toBeNull();

    // Matching TMDB show (两京十五日 tmdb:tv:203483): submitting and approving douban:35235320 succeeds and merges doubanMedia!
    const matchingCr = await rpc.changeRequest.createChangeRequest({
      target: mediaRef("tmdb:tv:203483"),
      namespace: "douban",
      nativeId: "35235320",
      segments: [
        toProtoSegmentInput({
          season: 1,
          episodeStart: 1,
          episodeEnd: 40,
          targetEpisodeStart: 1,
          baseline: "tmdb",
        }),
      ],
    });

    const approved = await approveInCore(
      { db, outbound },
      {
        id: matchingCr.changeRequest!.id,
        reason: "Merge duplicate",
        reviewerUserId: reviewer.userId,
      },
    );

    const tmdbMedia = await db
      .selectFrom("associations")
      .select("media_id")
      .where("is_external_id", "=", true)
      .where("namespace", "=", "tmdb")
      .where("native_id", "=", "tv:203483")
      .executeTakeFirstOrThrow();

    expect(approved.mediaId).toBe(tmdbMedia.media_id);

    const mergedSource = await db
      .selectFrom("media")
      .select(["id", "merged_into_media_id"])
      .where("id", "=", doubanMedia.id)
      .executeTakeFirstOrThrow();
    expect(mergedSource.merged_into_media_id).toBe(tmdbMedia.media_id);

    const doubanAfterMerge = await db
      .selectFrom("associations")
      .selectAll()
      .where("is_external_id", "=", false)
      .where("namespace", "=", "douban")
      .where("native_id", "=", "35235320")
      .where("status", "=", "confirmed")
      .execute();
    expect(doubanAfterMerge).toHaveLength(1);
    expect(doubanAfterMerge[0]!.media_id).toBe(tmdbMedia.media_id);
  });

  test("mergeMedia preserves confirmed association over seed_unconfirmed, coalesces overlapping demands, and resolves pairwise conflict alerts", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);
    const db = testDb.writeDb;
    const now = new Date("2026-11-24T10:00:00.000Z");

    const actorId = "merge-actor-1";
    await db
      .insertInto("user")
      .values({
        id: actorId,
        name: "Merge Actor",
        email: "merge-actor@example.com",
        emailVerified: true,
        role: "reviewer",
        createdAt: now,
        updatedAt: now,
      })
      .execute();

    const target = await db
      .insertInto("media")
      .values({
        type: "tv",
        baseline: "tmdb",
        title: "两京十五日",
        original_title: "两京十五日",
        year: 2026,
        seasons: JSON.stringify([{ season: 1, episodeCount: 40, airYear: 2026 }]),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await db
      .insertInto("associations")
      .values([
        {
          media_id: target.id,
          namespace: "tmdb",
          native_id: "tv:203483",
          is_external_id: true,
          status: "confirmed",
          needs_review: false,
          locked: false,
        },
        {
          // Target only has seed_unconfirmed without segments
          media_id: target.id,
          namespace: "douban",
          native_id: "35235320",
          is_external_id: false,
          status: "seed_unconfirmed",
          needs_review: false,
          locked: false,
        },
      ])
      .execute();

    const source = await db
      .insertInto("media")
      .values({
        type: "tv",
        baseline: "douban",
        title: "两京十五日",
        original_title: "两京十五日",
        year: 2026,
        seasons: JSON.stringify([{ season: 1, episodeCount: 40, airYear: 2026 }]),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const sourceDouban = await db
      .insertInto("associations")
      .values({
        media_id: source.id,
        namespace: "douban",
        native_id: "35235320",
        is_external_id: false,
        status: "confirmed",
        needs_review: false,
        locked: false,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await db
      .insertInto("segments")
      .values({
        association_id: sourceDouban.id,
        season: 1,
        episode_start: 1,
        episode_end: 40,
        target_episode_start: 1,
        baseline: "douban",
        non_linear: false,
        needs_review: false,
      })
      .execute();

    // Overlapping demand rows (-1, 'catalog') + source-only demand row (1, 'platform') + open pairwise alert
    await db
      .insertInto("demands")
      .values([
        {
          media_id: target.id,
          season: null,
          namespace_group: "catalog",
          demand_count: 2,
          status: "open",
          next_eligible_at: now,
          last_demanded_at: now,
        },
        {
          media_id: source.id,
          season: null,
          namespace_group: "catalog",
          demand_count: 4,
          status: "open",
          next_eligible_at: now,
          last_demanded_at: now,
        },
        {
          media_id: source.id,
          season: 1,
          namespace_group: "platform",
          demand_count: 1,
          status: "open",
          next_eligible_at: now,
          last_demanded_at: now,
        },
      ])
      .execute();

    await db
      .insertInto("review_alerts")
      .values({
        alert_type: "agent_external_id_conflict",
        media_id: source.id,
        association_id: null,
        status: "open",
        details: JSON.stringify({
          namespace: "tmdb",
          nativeId: "tv:203483",
          conflictingMediaId: target.id,
        }),
      })
      .execute();

    await mergeMedia(db, {
      sourceMediaId: source.id,
      targetMediaId: target.id,
      actorUserId: actorId,
      reason: "Test merge",
      now,
    });

    const mergedDouban = await db
      .selectFrom("associations")
      .selectAll()
      .where("media_id", "=", target.id)
      .where("is_external_id", "=", false)
      .where("namespace", "=", "douban")
      .where("native_id", "=", "35235320")
      .executeTakeFirstOrThrow();
    expect(mergedDouban.status).toBe("confirmed");

    const mergedSegs = await db
      .selectFrom("segments")
      .selectAll()
      .where("association_id", "=", mergedDouban.id)
      .execute();
    expect(mergedSegs).toHaveLength(1);
    expect(mergedSegs[0]!.episode_end).toBe(40);

    const sourceDemands = await listDemands(db, { mediaId: source.id });
    expect(sourceDemands).toHaveLength(0);
    const targetDemands = await listDemands(db, { mediaId: target.id });
    const catalogDemand = targetDemands.find(
      (d) => d.season === null && d.namespaceGroup === "catalog",
    );
    const platformDemand = targetDemands.find(
      (d) => d.season === 1 && d.namespaceGroup === "platform",
    );
    expect(catalogDemand?.demandCount).toBe(6);
    expect(platformDemand?.demandCount).toBe(1);

    const conflictAlerts = await db
      .selectFrom("review_alerts")
      .selectAll()
      .where("alert_type", "=", "agent_external_id_conflict")
      .execute();
    expect(conflictAlerts).toHaveLength(1);
    expect(conflictAlerts[0]!.status).toBe("resolved");
  });

  test("catalog exploration keeps agent_external_id_conflict and refuses auto-merge when type/title/TMDB identity conflicts", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);
    const db = testDb.writeDb;
    const now = new Date("2026-11-24T10:00:00.000Z");

    // Existing movie
    const movieMedia = await db
      .insertInto("media")
      .values({
        type: "movie",
        baseline: "tmdb",
        title: "Fight Club",
        original_title: "Fight Club",
        year: 1999,
        seasons: JSON.stringify([]),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await db
      .insertInto("associations")
      .values({
        media_id: movieMedia.id,
        namespace: "tmdb",
        native_id: "movie:550",
        is_external_id: true,
        status: "confirmed",
        needs_review: false,
        locked: false,
      })
      .execute();

    // Different media with incompatible title/year (`Totally Unrelated Movie` 2024) sharing same IMDb -> MUST NOT auto-merge!
    const mismatchTvMedia = await db
      .insertInto("media")
      .values({
        type: "movie",
        baseline: "douban",
        title: "Totally Unrelated Movie",
        original_title: "Totally Unrelated Movie",
        year: 2024,
        seasons: JSON.stringify([]),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await db
      .insertInto("associations")
      .values([
        {
          media_id: mismatchTvMedia.id,
          namespace: "douban",
          native_id: "99999999",
          is_external_id: false,
          status: "confirmed",
          needs_review: false,
          locked: false,
        },
        {
          media_id: mismatchTvMedia.id,
          namespace: "imdb",
          native_id: "tt0137523",
          is_external_id: true,
          status: "confirmed",
          needs_review: false,
          locked: false,
        },
      ])
      .execute();

    await db
      .insertInto("demands")
      .values({
        media_id: mismatchTvMedia.id,
        season: null,
        namespace_group: "catalog",
        demand_count: 1,
        status: "open",
        next_eligible_at: now,
        last_demanded_at: now,
      })
      .execute();

    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/find/tt0137523")) {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            url: request.url,
            body: JSON.stringify({
              movie_results: [{ id: 550, title: "Fight Club" }],
              tv_results: [],
            }),
          };
        }
        if (url.pathname.endsWith("/movie/550")) {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            url: request.url,
            body: JSON.stringify({
              id: 550,
              title: "Fight Club",
              original_title: "Fight Club",
              release_date: "1999-10-15",
              external_ids: { imdb_id: "tt0137523" },
            }),
          };
        }
        throw new Error(`Unexpected outbound URL: ${request.url}`);
      },
    });

    const emitted: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db,
      outbound,
      queue: {
        async send(msg) {
          emitted.push(msg);
        },
      },
      adapterRegistry: createTestPlatformRegistry(),
      config: {
        enableDailyTmdbSync: false,
        tmdb: { accessToken: "test-tmdb-token" },
        exploration: { dailyBudget: 10 },
      },
      now: () => now,
    });

    await worker.scheduled(createScheduledController(now));
    const explorationMsgs = emitted.filter((m) => m.jobType === EXPLORATION_JOB_TYPE);
    expect(explorationMsgs).toHaveLength(1);

    await worker.queue(createQueueBatch(explorationMsgs, now).batch);

    const stillUnmerged = await db
      .selectFrom("media")
      .select("merged_into_media_id")
      .where("id", "=", mismatchTvMedia.id)
      .executeTakeFirstOrThrow();
    expect(stillUnmerged.merged_into_media_id).toBeNull();

    const conflictAlerts = await db
      .selectFrom("review_alerts")
      .selectAll()
      .where("alert_type", "=", "agent_external_id_conflict")
      .where("status", "=", "open")
      .execute();
    expect(conflictAlerts.length).toBeGreaterThan(0);
  });

  test("runTmdbDailySync automatically merges compatible Douban+IMDb duplicate when TMDB reports shared secondary imdb_id", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);
    const db = testDb.writeDb;
    const now = new Date("2026-11-24T10:00:00.000Z");

    const tmdbMedia = await db
      .insertInto("media")
      .values({
        type: "tv",
        baseline: "tmdb",
        title: "两京十五日",
        original_title: "两京十五日",
        year: 2026,
        seasons: JSON.stringify([{ season: 1, episodeCount: 40, airYear: 2026 }]),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await db
      .insertInto("associations")
      .values({
        media_id: tmdbMedia.id,
        namespace: "tmdb",
        native_id: "tv:203483",
        is_external_id: true,
        status: "confirmed",
        needs_review: false,
        locked: false,
      })
      .execute();

    // Non-TMDB duplicate holding douban:35235320 + imdb:tt9915020
    const doubanMedia = await db
      .insertInto("media")
      .values({
        type: "tv",
        baseline: "douban",
        title: "两京十五日",
        original_title: "两京十五日",
        year: 2026,
        seasons: JSON.stringify([{ season: 1, episodeCount: 40, airYear: 2026 }]),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const doubanAssoc = await db
      .insertInto("associations")
      .values([
        {
          media_id: doubanMedia.id,
          namespace: "douban",
          native_id: "35235320",
          is_external_id: false,
          status: "confirmed",
          needs_review: false,
          locked: false,
        },
        {
          media_id: doubanMedia.id,
          namespace: "imdb",
          native_id: "tt9915020",
          is_external_id: true,
          status: "confirmed",
          needs_review: false,
          locked: false,
        },
      ])
      .returning("id")
      .execute();
    await db
      .insertInto("segments")
      .values({
        association_id: doubanAssoc[0]!.id,
        season: 1,
        episode_start: 1,
        episode_end: 40,
        target_episode_start: 1,
        baseline: "douban",
        non_linear: false,
        needs_review: false,
      })
      .execute();

    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/tv/changes")) {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            url: request.url,
            body: JSON.stringify({
              page: 1,
              total_pages: 1,
              total_results: 1,
              results: [{ id: 203483, adult: false }],
            }),
          };
        }
        if (url.pathname.endsWith("/tv/203483")) {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            url: request.url,
            body: JSON.stringify({
              id: 203483,
              name: "两京十五日",
              original_name: "两京十五日",
              first_air_date: "2026-06-01",
              seasons: [{ season_number: 1, episode_count: 40, air_date: "2026-06-01" }],
              external_ids: { imdb_id: "tt9915020" },
            }),
          };
        }
        throw new Error(`Unexpected outbound URL: ${request.url}`);
      },
    });

    await runTmdbDailySync(db, outbound, {
      now,
      tmdbGateway: createTmdbGateway(outbound, { accessToken: "test-tmdb-token" }),
    });

    const mergedRow = await db
      .selectFrom("media")
      .select("merged_into_media_id")
      .where("id", "=", doubanMedia.id)
      .executeTakeFirstOrThrow();
    expect(mergedRow.merged_into_media_id).toBe(tmdbMedia.id);

    const movedImdb = await db
      .selectFrom("associations")
      .where("is_external_id", "=", true)
      .selectAll()
      .where("media_id", "=", tmdbMedia.id)
      .where("namespace", "=", "imdb")
      .executeTakeFirstOrThrow();
    expect(movedImdb.native_id).toBe("tt9915020");
  });

  test("convergeDuplicateMedia is idempotent across runs, merges shared Douban duplicates, and skips mismatched works", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);
    const db = testDb.writeDb;
    const now = new Date("2026-11-24T10:00:00.000Z");

    const tmdbMedia = await db
      .insertInto("media")
      .values({
        type: "tv",
        baseline: "tmdb",
        title: "两京十五日",
        original_title: "两京十五日",
        year: 2026,
        seasons: JSON.stringify([{ season: 1, episodeCount: 40, airYear: 2026 }]),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const dupDoubanMedia = await db
      .insertInto("media")
      .values({
        type: "tv",
        baseline: "douban",
        title: "两京十五日",
        original_title: "两京十五日",
        year: 2026,
        seasons: JSON.stringify([{ season: 1, episodeCount: 40, airYear: 2026 }]),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const unrelatedMedia = await db
      .insertInto("media")
      .values({
        type: "tv",
        baseline: "tmdb",
        title: "完全无关的剧",
        original_title: "Unrelated Drama",
        year: 2020,
        seasons: JSON.stringify([{ season: 1, episodeCount: 12, airYear: 2020 }]),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await db
      .insertInto("associations")
      .values([
        {
          media_id: tmdbMedia.id,
          namespace: "tmdb",
          native_id: "tv:203483",
          is_external_id: true,
          status: "confirmed",
          needs_review: false,
          locked: false,
        },
        {
          media_id: unrelatedMedia.id,
          namespace: "tmdb",
          native_id: "tv:777777",
          is_external_id: true,
          status: "confirmed",
          needs_review: false,
          locked: false,
        },
        {
          media_id: tmdbMedia.id,
          namespace: "douban",
          native_id: "35235320",
          is_external_id: false,
          status: "confirmed",
          needs_review: false,
          locked: false,
        },
        {
          media_id: dupDoubanMedia.id,
          namespace: "douban",
          native_id: "35235320",
          is_external_id: false,
          status: "confirmed",
          needs_review: false,
          locked: false,
        },
        {
          media_id: unrelatedMedia.id,
          namespace: "douban",
          native_id: "35235320",
          is_external_id: false,
          status: "seed_unconfirmed",
          needs_review: false,
          locked: false,
        },
      ])
      .execute();

    const first = await convergeDuplicateMedia(db, { now });
    expect(first.mergedCount).toBe(1);
    expect(first.mergedPairs).toEqual([
      expect.objectContaining({
        sourceMediaId: dupDoubanMedia.id,
        targetMediaId: tmdbMedia.id,
      }),
    ]);

    const mergedRow = await db
      .selectFrom("media")
      .select("merged_into_media_id")
      .where("id", "=", dupDoubanMedia.id)
      .executeTakeFirstOrThrow();
    expect(mergedRow.merged_into_media_id).toBe(tmdbMedia.id);

    const unrelatedRow = await db
      .selectFrom("media")
      .select("merged_into_media_id")
      .where("id", "=", unrelatedMedia.id)
      .executeTakeFirstOrThrow();
    expect(unrelatedRow.merged_into_media_id).toBeNull();

    // Idempotent second sweep: dupDoubanMedia already merged, unrelated stays skipped
    const second = await convergeDuplicateMedia(db, { now });
    expect(second.mergedCount).toBe(0);
  });
});
