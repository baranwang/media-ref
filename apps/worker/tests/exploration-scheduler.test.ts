import { gzipSync } from "node:zlib";
import type { Message, MessageBatch, ScheduledController } from "@cloudflare/workers-types";
import type { PlatformNamespace } from "@media-ref/client";
import {
  bilibiliAdapter,
  createAdapterRegistry,
  createChangeRequest,
  createFakeOutboundClient,
  createTier1Adapter,
  EVIDENCE_CHECK_JOB_TYPE,
  EXPLORATION_JOB_TYPE,
  getJobById,
  listDemands,
  queryMediaByKey,
  recordDemandForRead,
  seedTmdbExportIds,
  syncTmdbDailyExports,
  type AdapterRegistry,
  type ExplorationExecutionContext,
  type ExplorationExecutionResult,
  type JobQueueMessage,
  type Tier2Adapter,
  type Tier3Adapter,
} from "@media-ref/core";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  createBackgroundWorker,
  parseWorkerConfig,
  type BackgroundWorkerEnv,
} from "../src/index.ts";

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
  ackedIds: () => string[];
} {
  const acked: string[] = [];
  const messages: Message<JobQueueMessage>[] = bodies.map((body, index) => {
    const id = `msg-${index + 1}-${body.jobId}-gen-${body.leaseGeneration}`;
    return {
      id,
      timestamp,
      body,
      attempts: 1,
      ack() {
        acked.push(id);
      },
      retry() {},
    };
  });

  const batch: MessageBatch<JobQueueMessage> = {
    queue: "media-ref-jobs",
    messages,
    metadata: {
      metrics: {
        backlogCount: messages.length,
        backlogBytes: 0,
      },
    },
    ackAll() {
      for (const msg of messages) {
        acked.push(msg.id);
      }
    },
    retryAll() {},
  };

  return { batch, ackedIds: () => acked };
}

function createTier3BilibiliStubAdapter(): Tier3Adapter<"bilibili"> {
  return {
    ...bilibiliAdapter,
    tier: 3,
    async search() {
      return { status: "ok", candidates: [] };
    },
  };
}

function createTier3PlatformRegistry(
  extraAdapters: readonly Tier3Adapter<PlatformNamespace>[] = [],
): AdapterRegistry {
  return createAdapterRegistry([createTier3BilibiliStubAdapter(), ...extraAdapters]);
}

describe("Exploration scheduler (#28)", () => {
  const handles: TestDbHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop();
      if (handle) {
        await handle.cleanup();
      }
    }
  });

  test("syncs TMDB daily exports (gzipped & plain NDJSON) and marks non-existent TMDB IDs invalid_key with zero budget consumed", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-23T09:00:00.000Z");
    const gzippedMovies = gzipSync(
      Buffer.from(
        '{"adult":false,"id":550,"original_title":"Fight Club"}\n{"adult":false,"id":603,"original_title":"The Matrix"}\n',
        "utf8",
      ),
    );
    const plainTvNdjson =
      '{"id":95479,"original_name":"呪術廻戦"}\n{"id":1399,"original_name":"Game of Thrones"}\n';

    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        if (request.url === "https://files.tmdb.org/p/exports/movie_ids_11_23_2026.json.gz") {
          return {
            status: 200,
            headers: { "content-type": "application/gzip" },
            body: "",
            bodyBytes: new Uint8Array(gzippedMovies),
            url: request.url,
          };
        }
        if (request.url === "https://files.tmdb.org/p/exports/tv_series_ids_11_23_2026.json.gz") {
          return {
            status: 200,
            headers: { "content-type": "application/x-ndjson" },
            body: plainTvNdjson,
            url: request.url,
          };
        }
        throw new Error(`Unexpected outbound URL: ${request.url}`);
      },
    });

    const syncResult = await syncTmdbDailyExports(testDb.writeDb, outbound, {
      date: "2026-11-23",
    });

    expect(syncResult.exportedDate).toBe("2026-11-23");
    expect(syncResult.movie?.ok).toBe(true);
    expect(syncResult.movie?.count).toBe(2);
    expect(syncResult.tv?.ok).toBe(true);
    expect(syncResult.tv?.count).toBe(2);

    // Record high-demand invalid TMDB TV ID and valid TMDB TV ID
    for (let i = 0; i < 5; i++) {
      await recordDemandForRead(testDb.writeDb, {
        rawKey: "tmdb:tv:999999999",
        queryResult: { kind: "not_found", key: "tmdb:tv:999999999" },
        season: 1,
        namespaceGroup: "platform",
        now: t0,
      });
    }
    await recordDemandForRead(testDb.writeDb, {
      rawKey: "tmdb:tv:95479",
      queryResult: { kind: "not_found", key: "tmdb:tv:95479" },
      season: 1,
      namespaceGroup: "platform",
      now: t0,
    });

    const emitted: JobQueueMessage[] = [];
    const executedContexts: ExplorationExecutionContext[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
      adapterRegistry: createTier3PlatformRegistry(),
      explorationExecutor: async (ctx): Promise<ExplorationExecutionResult> => {
        executedContexts.push(ctx);
        return { platformOutcomes: [{ namespace: "bilibili", status: "submitted" }] };
      },
      config: {
        enableDailyTmdbSync: false,
        exploration: { dailyBudget: 10, batchSize: 10 },
      },
      now: () => t0,
    });

    await worker.scheduled(createScheduledController(t0));

    // Only the valid TMDB ID was enqueued; invalid TMDB ID was NEVER enqueued
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.jobType).toBe(EXPLORATION_JOB_TYPE);
    expect(emitted[0]?.payload.externalKey).toBe("tmdb:tv:95479");

    // Invalid TMDB demand marked invalid_key; valid TMDB demand leased
    const invalidDemands = await listDemands(testDb.readDb, { externalKey: "tmdb:tv:999999999" });
    expect(invalidDemands).toHaveLength(1);
    expect(invalidDemands[0]?.status).toBe("invalid_key");

    const validDemands = await listDemands(testDb.readDb, { externalKey: "tmdb:tv:95479" });
    expect(validDemands).toHaveLength(1);
    expect(validDemands[0]?.status).toBe("leased");

    // Daily budget consumed === 1 (zero budget consumed for the invalid TMDB ID)
    const budgetRow = await testDb.readDb
      .selectFrom("exploration_daily_budget")
      .selectAll()
      .where("budget_date", "=", "2026-11-23")
      .executeTakeFirstOrThrow();
    expect(budgetRow.consumed).toBe(1);

    // Zero media rows created at scheduling time
    const mediaRows = await testDb.readDb.selectFrom("media").select("id").execute();
    expect(mediaRows).toHaveLength(0);
    expect(executedContexts).toHaveLength(0);
  });

  test("verifies non-TMDB external keys against their catalog at exploration start (404 -> invalid_key, 503 -> retry, zero media)", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-23T10:00:00.000Z");
    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        if (request.namespace === "douban" && request.url.includes("/99999999")) {
          return {
            status: 404,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code: 404, msg: "not_found" }),
            url: request.url,
          };
        }
        if (request.namespace === "bangumi" && request.url.includes("/88888888")) {
          return {
            status: 404,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: "Not Found" }),
            url: request.url,
          };
        }
        if (request.namespace === "douban" && request.url.includes("/77777777")) {
          return {
            status: 503,
            headers: { "content-type": "text/plain" },
            body: "Service Unavailable",
            url: request.url,
          };
        }
        throw new Error(`Unexpected outbound request: ${request.namespace} ${request.url}`);
      },
    });

    await recordDemandForRead(testDb.writeDb, {
      rawKey: "douban:99999999",
      queryResult: { kind: "not_found", key: "douban:99999999" },
      season: 1,
      namespaceGroup: "platform",
      now: t0,
    });
    await recordDemandForRead(testDb.writeDb, {
      rawKey: "bangumi:88888888",
      queryResult: { kind: "not_found", key: "bangumi:88888888" },
      season: 1,
      namespaceGroup: "platform",
      now: t0,
    });
    await recordDemandForRead(testDb.writeDb, {
      rawKey: "douban:77777777",
      queryResult: { kind: "not_found", key: "douban:77777777" },
      season: 1,
      namespaceGroup: "platform",
      now: t0,
    });

    const emitted: JobQueueMessage[] = [];
    const executedContexts: ExplorationExecutionContext[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
      adapterRegistry: createTier3PlatformRegistry(),
      explorationExecutor: async (ctx) => {
        executedContexts.push(ctx);
        return { platformOutcomes: [{ namespace: "bilibili", status: "submitted" }] };
      },
      config: {
        enableDailyTmdbSync: false,
        exploration: { dailyBudget: 10, batchSize: 10 },
      },
      now: () => t0,
    });

    await worker.scheduled(createScheduledController(t0));
    expect(emitted).toHaveLength(3);

    const { batch } = createQueueBatch(emitted, t0);
    const summary = await worker.queue(batch);
    expect(summary.completed).toBe(2);
    expect(summary.rescheduled).toBe(1);

    // Executor was never invoked because none of the keys resolved to a valid media
    expect(executedContexts).toHaveLength(0);

    // Non-existent Douban & Bangumi demands marked invalid_key
    const douban404 = await listDemands(testDb.readDb, { externalKey: "douban:99999999" });
    expect(douban404[0]?.status).toBe("invalid_key");

    const bangumi404 = await listDemands(testDb.readDb, { externalKey: "bangumi:88888888" });
    expect(bangumi404[0]?.status).toBe("invalid_key");

    // Transient 503 Douban demand was NOT marked invalid_key or not_found
    const douban503 = await listDemands(testDb.readDb, { externalKey: "douban:77777777" });
    expect(douban503[0]?.status).toBe("leased");
    expect(douban503[0]?.notFoundCount).toBe(0);

    // Zero media rows created
    const mediaRows = await testDb.readDb.selectFrom("media").select("id").execute();
    expect(mediaRows).toHaveLength(0);

    // Outbound calls hit the corresponding catalog namespaces
    expect(outbound.httpRequests.map((r) => r.namespace).sort()).toEqual([
      "bangumi",
      "douban",
      "douban",
    ]);
  });

  test("lazily creates media and merges demands only when exploration starts for an unseen valid TMDB key", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-23T11:00:00.000Z");
    await seedTmdbExportIds(testDb.writeDb, [{ mediaType: "tv", tmdbId: "95479" }], "2026-11-23");

    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        if (request.namespace === "tmdb" && request.url.includes("/tv/95479")) {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              id: 95479,
              name: "咒术回战",
              original_name: "呪術廻戦",
              first_air_date: "2020-10-03",
              seasons: [
                { season_number: 1, episode_count: 24, air_date: "2020-10-03" },
                { season_number: 2, episode_count: 23, air_date: "2023-07-06" },
              ],
              external_ids: {
                imdb_id: "tt12343534",
                tvdb_id: 377543,
              },
            }),
            url: request.url,
          };
        }
        throw new Error(`Unexpected outbound URL: ${request.url}`);
      },
    });

    // Record demand without season for unseen TMDB TV series
    await recordDemandForRead(testDb.writeDb, {
      rawKey: "tmdb:tv:95479",
      queryResult: { kind: "not_found", key: "tmdb:tv:95479" },
      namespaceGroup: "platform",
      now: t0,
    });

    // Media MUST NOT be created at demand recording time
    expect(await testDb.readDb.selectFrom("media").select("id").execute()).toHaveLength(0);

    const emitted: JobQueueMessage[] = [];
    const executedContexts: ExplorationExecutionContext[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
      adapterRegistry: createTier3PlatformRegistry(),
      explorationExecutor: async (ctx) => {
        executedContexts.push(ctx);
        return {
          platformOutcomes: [{ namespace: "bilibili", status: "submitted", nativeId: "ss34430" }],
        };
      },
      config: {
        enableDailyTmdbSync: false,
        exploration: { dailyBudget: 10 },
      },
      now: () => t0,
    });

    await worker.scheduled(createScheduledController(t0));
    expect(emitted).toHaveLength(1);

    // Media MUST NOT be created yet at scheduling time either
    expect(await testDb.readDb.selectFrom("media").select("id").execute()).toHaveLength(0);

    // Execute exploration queue message -> media is lazily created right now
    const { batch } = createQueueBatch(emitted, t0);
    const summary = await worker.queue(batch);
    expect(summary.completed).toBe(1);

    expect(executedContexts).toHaveLength(1);
    const execCtx = executedContexts[0]!;
    expect(execCtx.media.snapshot.title).toBe("咒术回战");
    expect(execCtx.media.type).toBe("tv");
    expect(execCtx.season).toBe(1);
    expect(execCtx.media.externalIds).toEqual([
      { namespace: "imdb", nativeId: "tt12343534" },
      { namespace: "tmdb", nativeId: "tv:95479" },
      { namespace: "tvdb", nativeId: "377543" },
    ]);

    // Read API now resolves the lazily created media by TMDB and synced IMDb keys
    const readResult = await queryMediaByKey(testDb.readDb, "tmdb:tv:95479");
    expect(readResult.kind).toBe("ok");
    const readByImdb = await queryMediaByKey(testDb.readDb, "imdb:tt12343534");
    expect(readByImdb.kind).toBe("ok");

    // External-key demand was merged into media-scoped season demands: S1 fulfilled, S2 open
    const extDemands = await listDemands(testDb.readDb, { externalKey: "tmdb:tv:95479" });
    expect(extDemands).toHaveLength(0);

    const mediaDemands = await listDemands(testDb.readDb, { mediaId: execCtx.media.id });
    const bySeason = new Map(mediaDemands.map((d) => [d.season, d]));
    expect(bySeason.get(1)?.status).toBe("fulfilled");
    expect(bySeason.get(1)?.lastExploredAt).toBe(t0.toISOString());
    expect(bySeason.get(2)?.status).toBe("open");
    expect(bySeason.get(2)?.leaseExpiresAt).toBeNull();
  });

  test("enforces global daily budget cap, claims highest demand_count first, and leaves evidence_check unaffected", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-23T12:00:00.000Z");
    let now = t0;

    // Seed 5 media items with distinct demands (including a demand_count tie broken by last_demanded_at)
    const createMediaWithDemand = async (opts: {
      title: string;
      tmdbId: string;
      demandCount: number;
      lastDemandedAt: Date;
      createdAt: Date;
    }) => {
      const media = await testDb.writeDb
        .insertInto("media")
        .values({
          type: "tv",
          baseline: "tmdb",
          title: opts.title,
          original_title: opts.title,
          year: 2020,
          seasons: JSON.stringify([{ season: 1, episodeCount: 24, airYear: 2020 }]),
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      await testDb.writeDb
        .insertInto("external_ids")
        .values({
          media_id: media.id,
          namespace: "tmdb",
          native_id: `tv:${opts.tmdbId}`,
          source: "sync",
        })
        .execute();

      const demand = await testDb.writeDb
        .insertInto("demands")
        .values({
          media_id: media.id,
          season: 1,
          namespace_group: "platform",
          demand_count: opts.demandCount,
          status: "open",
          next_eligible_at: opts.createdAt,
          last_demanded_at: opts.lastDemandedAt,
          created_at: opts.createdAt,
          updated_at: opts.lastDemandedAt,
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      return { mediaId: media.id, demandId: demand.id };
    };

    const mA = await createMediaWithDemand({
      title: "Show A",
      tmdbId: "1001",
      demandCount: 3,
      lastDemandedAt: new Date("2026-11-23T11:50:00.000Z"),
      createdAt: new Date("2026-11-23T10:00:00.000Z"),
    });
    const mB = await createMediaWithDemand({
      title: "Show B Highest",
      tmdbId: "1002",
      demandCount: 10,
      lastDemandedAt: new Date("2026-11-23T11:00:00.000Z"),
      createdAt: new Date("2026-11-23T10:01:00.000Z"),
    });
    const mC = await createMediaWithDemand({
      title: "Show C Tie Newer",
      tmdbId: "1003",
      demandCount: 7,
      lastDemandedAt: new Date("2026-11-23T11:55:00.000Z"),
      createdAt: new Date("2026-11-23T10:02:00.000Z"),
    });
    const mD = await createMediaWithDemand({
      title: "Show D Tie Older",
      tmdbId: "1004",
      demandCount: 7,
      lastDemandedAt: new Date("2026-11-23T11:10:00.000Z"),
      createdAt: new Date("2026-11-23T10:03:00.000Z"),
    });
    const mE = await createMediaWithDemand({
      title: "Show E Lowest",
      tmdbId: "1005",
      demandCount: 1,
      lastDemandedAt: new Date("2026-11-23T11:59:00.000Z"),
      createdAt: new Date("2026-11-23T10:04:00.000Z"),
    });

    // Prepare a real user & evidence_check change request for testing budget independence
    await testDb.writeDb
      .insertInto("user")
      .values({
        id: "user_ev_1",
        name: "Submitter",
        email: "submitter@mediaref.org",
        emailVerified: true,
        createdAt: t0,
        updatedAt: t0,
      })
      .execute();

    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        if (request.namespace === "tmdb" && request.url.includes("/tv/1005")) {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              id: 1005,
              name: "Show E Lowest",
              original_name: "Show E Lowest",
              first_air_date: "2020-01-01",
              seasons: [{ season_number: 1, episode_count: 24, air_date: "2020-01-01" }],
              external_ids: {},
            }),
            url: request.url,
          };
        }
        if (request.namespace === "bilibili" && request.url.includes("season_id=34430")) {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              code: 0,
              result: {
                season_id: 34430,
                title: "Show E Lowest",
                type: 1,
                publish: { pub_time: "2020-01-01 00:00:00" },
                episodes: Array.from({ length: 24 }, (_, idx) => ({
                  id: 1000 + idx,
                  title: String(idx + 1),
                  section_type: 0,
                  badge: "",
                  badge_type: 0,
                })),
              },
            }),
            url: request.url,
          };
        }
        throw new Error(`Unexpected outbound request: ${request.namespace} ${request.url}`);
      },
    });

    const registry = createTier3PlatformRegistry();
    const emitted: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
      adapterRegistry: registry,
      explorationExecutor: async () => ({
        platformOutcomes: [{ namespace: "bilibili", status: "submitted" }],
      }),
      config: {
        enableDailyTmdbSync: false,
        exploration: { dailyBudget: 2, batchSize: 10 },
      },
      now: () => now,
    });

    // Tick 1: dailyBudget = 2 -> ONLY top 2 demands (mB count=10, then mC count=7 newer) claimed!
    await worker.scheduled(createScheduledController(now));

    expect(emitted).toHaveLength(2);
    expect(emitted.map((m) => m.jobType)).toEqual([EXPLORATION_JOB_TYPE, EXPLORATION_JOB_TYPE]);
    expect(emitted.map((m) => m.payload.mediaId)).toEqual([mB.mediaId, mC.mediaId]);

    const budgetDay1 = await testDb.readDb
      .selectFrom("exploration_daily_budget")
      .selectAll()
      .where("budget_date", "=", "2026-11-23")
      .executeTakeFirstOrThrow();
    expect(budgetDay1.consumed).toBe(2);

    // Remaining 3 demands stay open
    for (const remaining of [mA, mD, mE]) {
      const rows = await listDemands(testDb.readDb, { mediaId: remaining.mediaId });
      expect(rows[0]?.status).toBe("open");
    }

    // Complete Day 1's 2 exploration jobs via queue consumer
    const day1Batch = createQueueBatch(emitted, now);
    const day1QueueSummary = await worker.queue(day1Batch.batch);
    expect(day1QueueSummary.completed).toBe(2);

    // Now exploration budget for 2026-11-23 is EXHAUSTED (2/2).
    // Create a change request -> enqueues an evidence_check job -> must STILL run unaffected!
    emitted.length = 0;
    const cr = await createChangeRequest(
      testDb.writeDb,
      {
        submitterUserId: "user_ev_1",
        targetExternalKey: "tmdb:tv:1005",
        namespace: "bilibili",
        nativeId: "ss34430",
        variantDescription: "原声",
        segments: [
          {
            season: 1,
            episodeStart: 1,
            episodeEnd: 24,
            targetEpisodeStart: 1,
            baseline: "tmdb",
          },
        ],
        now,
      },
      { adapterRegistry: registry, outbound, now },
    );
    expect(cr.status).toBe("pending_evidence");

    await worker.scheduled(createScheduledController(now));

    // Zero new exploration jobs, but the evidence_check job WAS claimed & dispatched!
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.jobType).toBe(EVIDENCE_CHECK_JOB_TYPE);
    expect(emitted[0]?.payload.changeRequestId).toBe(cr.id);

    const { batch: evBatch } = createQueueBatch(emitted, now);
    const evSummary = await worker.queue(evBatch);
    expect(evSummary.completed).toBe(1);

    const approvedCr = await testDb.readDb
      .selectFrom("change_requests")
      .select("status")
      .where("id", "=", cr.id)
      .executeTakeFirstOrThrow();
    expect(approvedCr.status).toBe("approved");

    // Next UTC day (2026-11-24): fresh daily budget claims the next top 2 (mD count=7, mA count=3)
    emitted.length = 0;
    now = new Date("2026-11-24T00:05:00.000Z");
    await worker.scheduled(createScheduledController(now));

    expect(emitted).toHaveLength(2);
    expect(emitted.map((m) => m.payload.mediaId)).toEqual([mD.mediaId, mA.mediaId]);

    const budgetDay2 = await testDb.readDb
      .selectFrom("exploration_daily_budget")
      .selectAll()
      .where("budget_date", "=", "2026-11-24")
      .executeTakeFirstOrThrow();
    expect(budgetDay2.consumed).toBe(2);
  });

  test("duplicate queue delivery (sequential and concurrent) deducts daily budget once and commits once", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-23T14:00:00.000Z");
    let now = t0;

    const createMedia = async (title: string) =>
      testDb.writeDb
        .insertInto("media")
        .values({
          type: "tv",
          baseline: "tmdb",
          title,
          original_title: title,
          year: 2021,
          seasons: JSON.stringify([{ season: 1, episodeCount: 12, airYear: 2021 }]),
        })
        .returning("id")
        .executeTakeFirstOrThrow();

    const seqMedia = await createMedia("Sequential Dup Show");
    await testDb.writeDb
      .insertInto("demands")
      .values({
        media_id: seqMedia.id,
        season: 1,
        namespace_group: "platform",
        demand_count: 5,
        status: "open",
        next_eligible_at: t0,
        last_demanded_at: t0,
      })
      .execute();

    let execCount = 0;
    const emitted: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound: createFakeOutboundClient(),
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
      adapterRegistry: createTier3PlatformRegistry(),
      explorationExecutor: async () => {
        execCount += 1;
        return {
          platformOutcomes: [
            { namespace: "bilibili", status: "not_found", reason: "absent_on_platform" },
          ],
        };
      },
      config: {
        enableDailyTmdbSync: false,
        exploration: {
          dailyBudget: 10,
          leaseDurationMs: 15 * 60_000,
          notFoundBackoffSeconds: [3600, 10800],
        },
      },
      now: () => now,
    });

    await worker.scheduled(createScheduledController(now));
    expect(emitted).toHaveLength(1);
    const seqMsg = emitted[0]!;

    // Sequential duplicate delivery of the exact same exploration message
    const seqBatch1 = createQueueBatch([seqMsg], now);
    const seqBatch2 = createQueueBatch([seqMsg], now);
    const res1 = await worker.queue(seqBatch1.batch);
    const res2 = await worker.queue(seqBatch2.batch);

    expect(res1.completed).toBe(1);
    expect(res2.discarded).toBe(1);
    expect(execCount).toBe(1);

    const seqDemand = (await listDemands(testDb.readDb, { mediaId: seqMedia.id }))[0]!;
    expect(seqDemand.status).toBe("not_found");
    expect(seqDemand.notFoundCount).toBe(1);

    const seqCheck = await testDb.readDb
      .selectFrom("platform_checks")
      .selectAll()
      .where("media_id", "=", seqMedia.id)
      .where("platform", "=", "bilibili")
      .executeTakeFirstOrThrow();
    expect(seqCheck.attempt_count).toBe(1);

    // Budget deducted ONLY ONCE
    const budgetAfterSeq = await testDb.readDb
      .selectFrom("exploration_daily_budget")
      .select("consumed")
      .where("budget_date", "=", "2026-11-23")
      .executeTakeFirstOrThrow();
    expect(budgetAfterSeq.consumed).toBe(1);

    // Concurrent duplicate delivery racing in parallel
    emitted.length = 0;
    const raceMedia = await createMedia("Concurrent Dup Show");
    await testDb.writeDb
      .insertInto("demands")
      .values({
        media_id: raceMedia.id,
        season: 1,
        namespace_group: "platform",
        demand_count: 5,
        status: "open",
        next_eligible_at: now,
        last_demanded_at: now,
      })
      .execute();

    await worker.scheduled(createScheduledController(now));
    expect(emitted).toHaveLength(1);
    const raceMsg = emitted[0]!;

    const raceA = createQueueBatch([raceMsg], now);
    const raceB = createQueueBatch([raceMsg], now);
    const [raceResA, raceResB] = await Promise.all([
      worker.queue(raceA.batch),
      worker.queue(raceB.batch),
    ]);

    expect(raceResA.completed + raceResB.completed).toBe(1);
    expect(raceResA.discarded + raceResB.discarded).toBe(1);

    const raceDemand = (await listDemands(testDb.readDb, { mediaId: raceMedia.id }))[0]!;
    expect(raceDemand.status).toBe("not_found");
    expect(raceDemand.notFoundCount).toBe(1);

    const raceCheck = await testDb.readDb
      .selectFrom("platform_checks")
      .selectAll()
      .where("media_id", "=", raceMedia.id)
      .where("platform", "=", "bilibili")
      .executeTakeFirstOrThrow();
    expect(raceCheck.attempt_count).toBe(1);

    // Total daily budget consumed is strictly 2 (1 for seqMedia + 1 for raceMedia)
    const budgetAfterRace = await testDb.readDb
      .selectFrom("exploration_daily_budget")
      .select("consumed")
      .where("budget_date", "=", "2026-11-23")
      .executeTakeFirstOrThrow();
    expect(budgetAfterRace.consumed).toBe(2);

    // Verify stale demandLeaseGeneration is fenced out even after demand lease expiry & re-claim
    emitted.length = 0;
    const staleMedia = await createMedia("Stale Lease Show");
    await testDb.writeDb
      .insertInto("demands")
      .values({
        media_id: staleMedia.id,
        season: 1,
        namespace_group: "platform",
        demand_count: 8,
        status: "open",
        next_eligible_at: now,
        last_demanded_at: now,
      })
      .execute();

    await worker.scheduled(createScheduledController(now));
    expect(emitted).toHaveLength(1);
    const gen1Msg = emitted[0]!;
    expect(gen1Msg.payload.demandLeaseGeneration).toBe(1);

    // Expire demand lease (15m + 1s) -> scheduler supersedes gen1 job and re-claims at demandLeaseGeneration 2
    emitted.length = 0;
    now = new Date(t0.getTime() + 15 * 60_000 + 1_000);
    await worker.scheduled(createScheduledController(now));
    expect(emitted).toHaveLength(1);
    const gen2Msg = emitted[0]!;
    expect(gen2Msg.payload.demandLeaseGeneration).toBe(2);

    // Deliver stale gen1 message -> must be discarded without executing or touching gen2 leased demand
    const staleBeforeExec = execCount;
    const staleBatch = createQueueBatch([gen1Msg], now);
    const staleSummary = await worker.queue(staleBatch.batch);
    expect(staleSummary.discarded).toBe(1);
    expect(execCount).toBe(staleBeforeExec);

    const staleDemandAfter = (await listDemands(testDb.readDb, { mediaId: staleMedia.id }))[0]!;
    expect(staleDemandAfter.status).toBe("leased");
    expect(staleDemandAfter.leaseGeneration).toBe(2);
    expect(staleDemandAfter.notFoundCount).toBe(0);

    const staleJob = await getJobById(testDb.readDb, gen1Msg.jobId);
    expect(staleJob?.status).toBe("failed");
    expect(staleJob?.errorMessage).toBe("demand_lease_expired_superseded");
  });

  test("applies escalating not_found backoff and platform_checks while transient_error does not mark not_found", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-23T08:00:00.000Z");
    let now = t0;

    const notFoundMedia = await testDb.writeDb
      .insertInto("media")
      .values({
        type: "movie",
        baseline: "tmdb",
        title: "Not Found Movie",
        original_title: "Not Found Movie",
        year: 2022,
        seasons: JSON.stringify([]),
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const transientMedia = await testDb.writeDb
      .insertInto("media")
      .values({
        type: "movie",
        baseline: "tmdb",
        title: "Transient Timeout Movie",
        original_title: "Transient Timeout Movie",
        year: 2022,
        seasons: JSON.stringify([]),
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await testDb.writeDb
      .insertInto("demands")
      .values([
        {
          media_id: notFoundMedia.id,
          season: null,
          namespace_group: "platform",
          demand_count: 10,
          status: "open",
          next_eligible_at: t0,
          last_demanded_at: t0,
        },
        {
          media_id: transientMedia.id,
          season: null,
          namespace_group: "platform",
          demand_count: 5,
          status: "open",
          next_eligible_at: t0,
          last_demanded_at: t0,
        },
      ])
      .execute();

    const backoffSeconds = [3_600, 10_800, 86_400]; // 1h -> 3h -> 24h
    const emitted: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound: createFakeOutboundClient(),
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
      adapterRegistry: createTier3PlatformRegistry(),
      explorationExecutor: async (ctx) => {
        if (ctx.media.id === notFoundMedia.id) {
          return {
            platformOutcomes: [
              { namespace: "bilibili", status: "not_found", reason: "no_results" },
            ],
          };
        }
        return {
          platformOutcomes: [
            { namespace: "bilibili", status: "transient_error", reason: "timeout_504" },
          ],
        };
      },
      config: {
        enableDailyTmdbSync: false,
        exploration: {
          dailyBudget: 20,
          notFoundBackoffSeconds: backoffSeconds,
        },
      },
      now: () => now,
    });

    // Attempt 1 at T0
    await worker.scheduled(createScheduledController(now));
    expect(emitted).toHaveLength(2);
    const batch1 = createQueueBatch(emitted, now);
    await worker.queue(batch1.batch);

    // Verify transient_error media: NO platform_checks row, NOT marked not_found, not_found_count === 0, reset to open!
    const transientChecks = await testDb.readDb
      .selectFrom("platform_checks")
      .selectAll()
      .where("media_id", "=", transientMedia.id)
      .execute();
    expect(transientChecks).toHaveLength(0);

    const transientRead = await queryMediaByKey(testDb.readDb, transientMedia.id);
    expect(transientRead.kind).toBe("ok");
    if (transientRead.kind === "ok") {
      expect(transientRead.items[0]?.document.platformStatuses?.bilibili).toEqual({
        status: "unchecked",
      });
    }

    const transientDemand = (await listDemands(testDb.readDb, { mediaId: transientMedia.id }))[0]!;
    expect(transientDemand.status).toBe("open");
    expect(transientDemand.notFoundCount).toBe(0);
    expect(transientDemand.lastExploredAt).toBeNull();
    expect(new Date(transientDemand.nextEligibleAt).getTime()).toBeLessThanOrEqual(t0.getTime());

    // Remove transientMedia demand so subsequent assertions focus cleanly on notFoundMedia backoff
    await testDb.writeDb.deleteFrom("demands").where("media_id", "=", transientMedia.id).execute();

    // Verify not_found Attempt 1: platform_checks & demand backoff = T0 + 3600s
    const expectedNext1 = new Date(t0.getTime() + 3_600 * 1_000);
    const nfDemand1 = (await listDemands(testDb.readDb, { mediaId: notFoundMedia.id }))[0]!;
    expect(nfDemand1.status).toBe("not_found");
    expect(nfDemand1.notFoundCount).toBe(1);
    expect(nfDemand1.lastExploredAt).toBe(t0.toISOString());
    expect(nfDemand1.nextEligibleAt).toBe(expectedNext1.toISOString());

    const nfCheck1 = await testDb.readDb
      .selectFrom("platform_checks")
      .selectAll()
      .where("media_id", "=", notFoundMedia.id)
      .where("platform", "=", "bilibili")
      .executeTakeFirstOrThrow();
    expect(nfCheck1.status).toBe("not_found");
    expect(nfCheck1.attempt_count).toBe(1);
    expect(nfCheck1.checked_at.toISOString()).toBe(t0.toISOString());
    expect(nfCheck1.next_retry_at?.toISOString()).toBe(expectedNext1.toISOString());

    // Read API exposes platformStatuses.bilibili = { status: "not_found", checkedAt }
    const nfRead = await queryMediaByKey(testDb.readDb, notFoundMedia.id);
    expect(nfRead.kind).toBe("ok");
    if (nfRead.kind === "ok") {
      expect(nfRead.items[0]?.document.platformStatuses?.bilibili).toEqual({
        status: "not_found",
        checkedAt: t0.toISOString(),
      });
    }

    // 1 second before T0 + 3600s -> MUST NOT be re-claimed!
    emitted.length = 0;
    now = new Date(expectedNext1.getTime() - 1_000);
    await worker.scheduled(createScheduledController(now));
    expect(emitted).toHaveLength(0);

    // At T1 = T0 + 3600s -> re-claimed; 2nd not_found sets strictly longer backoff T1 + 10800s!
    const t1 = expectedNext1;
    now = t1;
    await worker.scheduled(createScheduledController(now));
    expect(emitted).toHaveLength(1);
    await worker.queue(createQueueBatch(emitted, now).batch);

    const expectedNext2 = new Date(t1.getTime() + 10_800 * 1_000);
    const nfDemand2 = (await listDemands(testDb.readDb, { mediaId: notFoundMedia.id }))[0]!;
    expect(nfDemand2.status).toBe("not_found");
    expect(nfDemand2.notFoundCount).toBe(2);
    expect(nfDemand2.lastExploredAt).toBe(t1.toISOString());
    expect(nfDemand2.nextEligibleAt).toBe(expectedNext2.toISOString());

    const interval1Ms = expectedNext1.getTime() - t0.getTime();
    const interval2Ms = expectedNext2.getTime() - t1.getTime();
    expect(interval2Ms).toBeGreaterThan(interval1Ms);

    const nfCheck2 = await testDb.readDb
      .selectFrom("platform_checks")
      .selectAll()
      .where("media_id", "=", notFoundMedia.id)
      .where("platform", "=", "bilibili")
      .executeTakeFirstOrThrow();
    expect(nfCheck2.attempt_count).toBe(2);
    expect(nfCheck2.checked_at.toISOString()).toBe(t1.toISOString());
    expect(nfCheck2.next_retry_at?.toISOString()).toBe(expectedNext2.toISOString());

    // After 3600s from T1 (would have expired under 1st interval, NOT under 2nd interval) -> NOT re-claimed!
    emitted.length = 0;
    now = new Date(t1.getTime() + 3_600 * 1_000);
    await worker.scheduled(createScheduledController(now));
    expect(emitted).toHaveLength(0);

    // At T2 = T1 + 10800s -> 3rd not_found escalates again to T2 + 86400s!
    const t2 = expectedNext2;
    now = t2;
    await worker.scheduled(createScheduledController(now));
    expect(emitted).toHaveLength(1);
    await worker.queue(createQueueBatch(emitted, now).batch);

    const expectedNext3 = new Date(t2.getTime() + 86_400 * 1_000);
    const nfDemand3 = (await listDemands(testDb.readDb, { mediaId: notFoundMedia.id }))[0]!;
    expect(nfDemand3.notFoundCount).toBe(3);
    expect(nfDemand3.nextEligibleAt).toBe(expectedNext3.toISOString());
    expect(expectedNext3.getTime() - t2.getTime()).toBeGreaterThan(interval2Ms);
  });

  test("targets ONLY Tier 3 platforms (never Tier 1 or Tier 2) and parses worker exploration env config", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-23T16:00:00.000Z");
    const media = await testDb.writeDb
      .insertInto("media")
      .values({
        type: "tv",
        baseline: "tmdb",
        title: "Tier Filter Show",
        original_title: "Tier Filter Show",
        year: 2023,
        seasons: JSON.stringify([{ season: 1, episodeCount: 16, airYear: 2023 }]),
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await testDb.writeDb
      .insertInto("demands")
      .values({
        media_id: media.id,
        season: 1,
        namespace_group: "platform",
        demand_count: 4,
        status: "open",
        next_eligible_at: t0,
        last_demanded_at: t0,
      })
      .execute();

    // 1. Registry with ONLY Tier 2 adapters -> zero Tier 3 platforms -> no exploration scheduled, zero budget used
    const tier2Bilibili: Tier2Adapter<"bilibili"> = {
      namespace: "bilibili",
      tier: 2,
      parseInput: (raw) => bilibiliAdapter.parseInput(raw),
      canonicalize: (raw, outbound) => bilibiliAdapter.canonicalize(raw, outbound),
      fetchCollection: (id, outbound) => bilibiliAdapter.fetchCollection(id, outbound),
    };
    const defaultEmitted: JobQueueMessage[] = [];
    const workerNoTier3 = createBackgroundWorker({
      db: testDb.writeDb,
      outbound: createFakeOutboundClient(),
      queue: {
        async send(message) {
          defaultEmitted.push(message);
        },
      },
      adapterRegistry: createAdapterRegistry([tier2Bilibili]),
      config: {
        enableDailyTmdbSync: false,
        exploration: { dailyBudget: 10 },
      },
      now: () => t0,
    });

    await workerNoTier3.scheduled(createScheduledController(t0));
    expect(defaultEmitted).toHaveLength(0);
    const budgetWhenNoTier3 = await testDb.readDb
      .selectFrom("exploration_daily_budget")
      .selectAll()
      .execute();
    expect(budgetWhenNoTier3).toHaveLength(0);

    // 2. Mixed registry: Tier 1 (youku), Tier 2 (bilibili stub, tencent), Tier 3 (iqiyi) -> ONLY iqiyi targeted!
    const tier1Youku = createTier1Adapter({
      namespace: "youku",
      parseInput: (raw) => ({ kind: "show", id: raw, canonicalId: raw }),
    });
    const tier2Tencent: Tier2Adapter<"tencent"> = {
      namespace: "tencent",
      tier: 2,
      parseInput: (raw) => ({ kind: "cid", id: raw, canonicalId: raw }),
      canonicalize: async (raw) => raw,
      fetchCollection: async () => ({ status: "not_found" }),
    };
    const tier3Iqiyi: Tier3Adapter<"iqiyi"> = {
      namespace: "iqiyi",
      tier: 3,
      parseInput: (raw) => ({ kind: "album", id: raw, canonicalId: raw }),
      canonicalize: async (raw) => raw,
      fetchCollection: async () => ({ status: "not_found" }),
      search: async () => ({ status: "ok", candidates: [] }),
    };

    const mixedRegistry = createAdapterRegistry([
      tier1Youku,
      tier2Bilibili, // Tier 2
      tier2Tencent, // Tier 2
      tier3Iqiyi, // Tier 3
    ]);

    const emitted: JobQueueMessage[] = [];
    const seenTargetNamespaces: string[][] = [];
    const workerMixed = createBackgroundWorker({
      db: testDb.writeDb,
      outbound: createFakeOutboundClient(),
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
      adapterRegistry: mixedRegistry,
      explorationExecutor: async (ctx) => {
        seenTargetNamespaces.push([...ctx.targetNamespaces]);
        return {
          platformOutcomes: [{ namespace: "iqiyi", status: "submitted" }],
        };
      },
      config: {
        enableDailyTmdbSync: false,
        exploration: { dailyBudget: 10 },
      },
      now: () => t0,
    });

    await workerMixed.scheduled(createScheduledController(t0));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.payload.targetNamespaces).toEqual(["iqiyi"]);

    await workerMixed.queue(createQueueBatch(emitted, t0).batch);
    expect(seenTargetNamespaces).toEqual([["iqiyi"]]);

    // 3. Verify worker env var parsing for EXPLORATION_DAILY_BUDGET & EXPLORATION_BACKOFF_SECONDS
    const parsedConfig = parseWorkerConfig({
      EXPLORATION_DAILY_BUDGET: "42",
      EXPLORATION_BATCH_SIZE: "5",
      EXPLORATION_LEASE_DURATION_MS: "600000",
      EXPLORATION_BACKOFF_SECONDS: "600,1800,7200",
    } as unknown as BackgroundWorkerEnv);
    expect(parsedConfig.exploration).toEqual({
      dailyBudget: 42,
      batchSize: 5,
      leaseDurationMs: 600_000,
      notFoundBackoffSeconds: [600, 1800, 7200],
    });

    const pausedConfig = parseWorkerConfig({
      EXPLORATION_DAILY_BUDGET: "0",
    } as unknown as BackgroundWorkerEnv);
    expect(pausedConfig.exploration?.dailyBudget).toBe(0);
  });
});
