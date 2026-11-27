import type { Message, MessageBatch, ScheduledController } from "@cloudflare/workers-types";
import {
  createExplorationAgentExecutor,
  createDefaultAdapterRegistry,
  createTmdbGateway,
  createFakeOutboundClient,
  EVIDENCE_CHECK_JOB_TYPE,
  EXPLORATION_JOB_TYPE,
  listDemands,
  type ExternalHttpRequest,
  type ExternalHttpResponse,
  type JobQueueMessage,
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
function httpStub(
  request: ExternalHttpRequest,
  tmdbExternalIds?: Record<string, string>,
): ExternalHttpResponse {
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
      external_ids: { imdb_id: "tt0137523", ...tmdbExternalIds },
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
    baseline: "tmdb" | "douban";
    externalIds: Array<[string, string]>;
    doubanAssociation?: string;
    /** TMDB `/find` knows nothing about the IMDb ID. */
    tmdbFindEmpty?: boolean;
    tmdbExternalIds?: Record<string, string>;
  }) {
    const testDb = await createTestDb();
    handles.push(testDb);
    const row = await testDb.writeDb
      .insertInto("media")
      .values({
        type: "movie",
        baseline: media.baseline,
        title: "搏击俱乐部",
        original_title: "Fight Club",
        year: 1999,
        seasons: JSON.stringify([]),
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
      fetchExternal: (request) =>
        media.tmdbFindEmpty && request.namespace === "tmdb" && request.url.includes("/find/")
          ? json(request.url, { movie_results: [], tv_results: [] })
          : httpStub(request, media.tmdbExternalIds),
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
      config: { enableDailyTmdbSync: false, exploration: { dailyBudget: 10 } },
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

  test("a redirect to a media without TMDB does not report a Douban key as a TMDB result", async () => {
    const { testDb, mediaId, outbound } = await setup({
      baseline: "douban",
      externalIds: [],
      doubanAssociation: "1292000",
    });
    const db = testDb.writeDb;
    const snapshot = {
      type: "movie" as const,
      title: "搏击俱乐部",
      originalTitle: "Fight Club",
      year: 1999,
      seasons: [],
    };
    const target = await db
      .insertInto("media")
      .values({
        type: "movie",
        baseline: "douban",
        title: snapshot.title,
        original_title: snapshot.originalTitle,
        year: 1999,
        seasons: "[]",
        created_at: new Date(0),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("associations")
      .values({
        media_id: target.id,
        namespace: "douban",
        native_id: "1292000",
        status: "confirmed",
      })
      .execute();
    const { platformOutcomes } = await createExplorationAgentExecutor()({
      db,
      outbound,
      adapterRegistry: createDefaultAdapterRegistry(),
      tmdbGateway: createTmdbGateway(outbound),
      jobId: crypto.randomUUID(),
      jobLeaseGeneration: 1,
      demandId: crypto.randomUUID(),
      demandLeaseGeneration: 1,
      media: { id: mediaId, type: "movie", baseline: "douban", snapshot, externalIds: [] },
      season: null,
      namespaceGroup: "catalog",
      targetNamespaces: ["tmdb"],
      now: T0,
    });
    expect(platformOutcomes).toMatchObject([
      { namespace: "tmdb", status: "transient_error", reason: "merged_target_missing_tmdb" },
    ]);
    expect(await externalIds(testDb, target.id)).toEqual([]);
  });

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

  test("a TMDB ID held by a compatible duplicate media auto-merges into it and fulfills the demand", async () => {
    const { testDb, mediaId, runJobs } = await setup({
      baseline: "douban",
      externalIds: [["imdb", "tt0137523"]],
      doubanAssociation: "1292000",
    });
    await testDb.writeDb
      .updateTable("media")
      .set({ title: "鬥陣俱樂部", original_title: null })
      .where("id", "=", mediaId)
      .execute();
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

    const mergedRow = await testDb.readDb
      .selectFrom("media")
      .select("merged_into_media_id")
      .where("id", "=", mediaId)
      .executeTakeFirstOrThrow();
    expect(mergedRow.merged_into_media_id).toBe(other.id);

    expect(await externalIds(testDb, other.id)).toEqual([
      { namespace: "imdb", native_id: "tt0137523", source: "sync" },
      { namespace: "tmdb", native_id: "movie:550", source: "sync" },
    ]);
    const conflictAlerts = await testDb.readDb
      .selectFrom("review_alerts")
      .selectAll()
      .where("alert_type", "=", "agent_external_id_conflict")
      .where("status", "=", "open")
      .execute();
    expect(conflictAlerts).toHaveLength(0);
    expect((await listDemands(testDb.readDb, { mediaId: other.id }))[0]?.status).toBe("fulfilled");
  });

  test.each([
    ["tvdb", "123"],
    ["trakt", "movie:123"],
  ] as const)(
    "a conflicting %s ID does not lend the IMDb-verified title to its owner",
    async (namespace, nativeId) => {
      const { testDb, mediaId, runJobs } = await setup({
        baseline: "douban",
        externalIds: [["imdb", "tt0137523"]],
        doubanAssociation: "1292000",
        tmdbExternalIds: { [`${namespace}_id`]: "123" },
      });
      const db = testDb.writeDb;
      const other = await db
        .insertInto("media")
        .values({
          type: "movie",
          title: "An unrelated film",
          year: 1999,
          baseline: "douban",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await db
        .insertInto("associations")
        .values({
          media_id: other.id,
          namespace,
          native_id: nativeId,
          is_external_id: true,
          status: "confirmed",
        })
        .execute();

      expect(await runJobs()).toContain(EXPLORATION_JOB_TYPE);
      expect(
        await db
          .selectFrom("media")
          .select("id")
          .where("merged_into_media_id", "is", null)
          .execute(),
      ).toHaveLength(2);
      expect(await externalIds(testDb, mediaId)).toEqual([
        { namespace: "imdb", native_id: "tt0137523", source: "sync" },
        { namespace: "tmdb", native_id: "movie:550", source: "agent" },
      ]);
      expect(await externalIds(testDb, other.id)).toMatchObject([
        { namespace, native_id: nativeId },
      ]);
      expect(
        await db
          .selectFrom("review_alerts")
          .select("details")
          .where("media_id", "=", mediaId)
          .execute(),
      ).toMatchObject([
        {
          details: {
            namespace,
            nativeId,
            otherMediaId: other.id,
            autoMergeBlockedReason: "title_mismatch",
          },
        },
      ]);
    },
  );

  test("a TMDB ID held by an incompatible media is not written; a retry reuses the open alert", async () => {
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
        title: "Incompatible Film",
        year: 2024,
        seasons: JSON.stringify([]),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await testDb.writeDb
      .insertInto("associations")
      .values([
        {
          media_id: other.id,
          namespace: "tmdb",
          native_id: "movie:550",
          status: "confirmed",
          is_external_id: true,
          source: "sync",
        },
        {
          media_id: other.id,
          namespace: "imdb",
          native_id: "tt9999999",
          status: "confirmed",
          is_external_id: true,
          source: "sync",
        },
      ])
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
    });

    // No IMDb ID: the TMDB lookup has nothing to chain from, so the demand stays unmet and backs off.
    expect(await runJobs()).toEqual([EXPLORATION_JOB_TYPE]);
    const demand = (await listDemands(testDb.readDb, { mediaId }))[0]!;
    expect(demand.status).toBe("not_found");
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
