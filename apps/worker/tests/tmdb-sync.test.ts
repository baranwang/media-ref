import type { Message, MessageBatch, ScheduledController } from "@cloudflare/workers-types";
import { createApiApp } from "@media-ref/api/app";
import { resolveEpisode, type MediaDocument, type SegmentInput } from "@media-ref/client";
import {
  createAdapterRegistry,
  createFakeOutboundClient,
  createTmdbSyncJobHandler,
  DOUBAN_API,
  enqueueTmdbDailySyncIfDue,
  runTmdbDailySync,
  type ExternalHttpRequest,
  type ExternalHttpResponse,
  type JobQueueMessage,
  TMDB_SYNC_KEY_MOVIE,
  TMDB_SYNC_KEY_TV,
} from "@media-ref/core";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { createBackgroundWorker } from "../src/index.ts";
import {
  approveInCore,
  createRpcClients,
  expectRpcError,
  fromProtoReviewAlertStatus,
  getChangeRequestStateRpc,
  getMediaDocumentRpc,
  issueApiKeyRpc,
  mediaRef,
  signUpAndVerifyUser,
  TEST_BASE_URL,
  toProtoSegmentInput,
} from "./rpc-helpers.ts";

const TEST_AUTH_SECRET = "test-secret-for-media-ref-tmdb-sync-integration-tests-0123456789";

async function createApiKey(
  app: ReturnType<typeof createApiApp>,
  cookie: string,
  options: { name: string; canSubmit?: boolean },
): Promise<{ id: string; key: string }> {
  return issueApiKeyRpc(app, cookie, options);
}

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
  ackedCount: () => number;
} {
  let acks = 0;
  const messages: Message<JobQueueMessage>[] = bodies.map((body, index) => ({
    id: `msg-${index + 1}-${body.jobId}-gen-${body.leaseGeneration}`,
    timestamp,
    body,
    attempts: 1,
    ack() {
      acks += 1;
    },
    retry() {},
  }));

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
      acks = messages.length;
    },
    retryAll() {},
  };

  return { batch, ackedCount: () => acks };
}

async function setupActors(
  testDb: TestDbHandle,
  app: ReturnType<typeof createApiApp>,
  outbound: ReturnType<typeof createFakeOutboundClient>,
) {
  const submitter = await signUpAndVerifyUser(app, outbound, {
    email: "submitter@example.com",
    password: "StrongPassword123!",
    name: "Submitter",
  });
  const reviewer = await signUpAndVerifyUser(app, outbound, {
    email: "reviewer@example.com",
    password: "StrongPassword123!",
    name: "Reviewer",
  });
  await testDb.writeDb
    .updateTable("user")
    .set({ role: "reviewer" })
    .where("id", "=", reviewer.userId)
    .execute();

  const submitKey = await createApiKey(app, submitter.cookie, {
    name: "Submit Key",
    canSubmit: true,
  });
  const readKey = await createApiKey(app, submitter.cookie, {
    name: "Read Key",
    canSubmit: false,
  });

  return { submitter, reviewer, submitKey, readKey };
}

async function submitAndApprove(
  app: ReturnType<typeof createApiApp>,
  submitKey: string,
  approver: Parameters<typeof approveInCore>[0],
  body: {
    targetExternalKey: string;
    namespace: string;
    nativeId: string;
    variantDescription?: string;
    segments: SegmentInput[];
  },
): Promise<{ mediaId: string; associationId: string; revisionId: string }> {
  const crRes = await createRpcClients(app, {
    apiKey: submitKey,
  }).changeRequest.createChangeRequest({
    target: mediaRef(body.targetExternalKey),
    namespace: body.namespace,
    nativeId: body.nativeId,
    ...(body.variantDescription !== undefined
      ? { variantDescription: body.variantDescription }
      : {}),
    segments: body.segments.map(toProtoSegmentInput),
  });

  const approved = await approveInCore(approver, {
    id: crRes.changeRequest!.id,
    reason: "Approved in test",
  });
  return {
    mediaId: approved.mediaId,
    associationId: approved.associationId,
    revisionId: approved.revisionId,
  };
}

async function readMedia(
  app: ReturnType<typeof createApiApp>,
  readKey: string,
  key: string,
): Promise<{ status: number; document?: MediaDocument }> {
  try {
    const res = await getMediaDocumentRpc(app, readKey, key);
    return { status: 200, document: res.document };
  } catch (error) {
    const err = await expectRpcError(Promise.reject(error));
    return { status: err.status };
  }
}

/**
 * `count` tracked movies (TMDB movie:1..count) and a fake TMDB that lists `tmdb.changed` as the
 * day's movie changes, answers 500 for ids in `tmdb.failing`, and records every movie it serves.
 */
async function setupTrackedMovies(handles: TestDbHandle[], count: number) {
  const testDb = await createTestDb();
  handles.push(testDb);
  const db = testDb.writeDb;
  for (let id = 1; id <= count; id += 1) {
    const media = await db
      .insertInto("media")
      .values({ type: "movie", title: `Movie ${id}`, baseline: "tmdb" })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("associations")
      .values({
        media_id: media.id,
        namespace: "tmdb",
        native_id: `movie:${id}`,
        status: "confirmed",
        is_external_id: true,
      })
      .execute();
  }

  const tmdb = { changed: [] as number[], failing: new Set<string>(), fetched: [] as string[] };
  const outbound = createFakeOutboundClient({
    fetchExternal({ url }) {
      const path = new URL(url).pathname;
      if (path.endsWith("/changes")) {
        const ids = path === "/3/movie/changes" ? tmdb.changed : [];
        const body = { page: 1, total_pages: 1, results: ids.map((id) => ({ id })) };
        return { url, status: 200, headers: {}, body: JSON.stringify(body) };
      }
      const id = path.match(/^\/3\/movie\/(\d+)$/)?.[1];
      if (!id) throw new Error(`Unexpected URL ${url}`);
      tmdb.fetched.push(id);
      if (tmdb.failing.has(id)) {
        return { url, status: 500, headers: {}, body: "boom" };
      }
      const body = { id: Number(id), title: `Title ${id}`, release_date: "2020-01-01" };
      return { url, status: 200, headers: {}, body: JSON.stringify(body) };
    },
  });
  const run = (iso: string, options: { fullRefreshPageSize?: number } = {}) =>
    runTmdbDailySync(db, outbound, {
      now: new Date(iso),
      tmdbConfig: { accessToken: "test" },
      ...options,
    });
  const cursor = () =>
    db
      .selectFrom("sync_state")
      .select(["last_synced_date", "metadata"])
      .where("sync_key", "=", "tmdb_changes_movie")
      .executeTakeFirstOrThrow();
  return { db, tmdb, run, cursor };
}

describe("Daily TMDB sync, media merge, and baseline switch (#21)", () => {
  const handles: TestDbHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop();
      if (handle) {
        await handle.cleanup();
      }
    }
  });

  test("reports no tracked media even when both cursors are current", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);
    const syncDate = "2026-11-10";
    await testDb.writeDb
      .insertInto("sync_state")
      .values(
        [TMDB_SYNC_KEY_MOVIE, TMDB_SYNC_KEY_TV].map((sync_key) => ({
          sync_key,
          last_synced_date: syncDate,
        })),
      )
      .execute();

    await expect(
      enqueueTmdbDailySyncIfDue(testDb.writeDb, { now: new Date(syncDate) }),
    ).resolves.toEqual({
      enqueued: false,
      reason: "no_tracked_media",
      syncDate,
    });
  });

  test("refreshes TMDB snapshot (title, year, seasons) and non-locked external IDs while preserving locked IDs", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    let tvSnapshot = {
      id: 95479,
      name: "咒术回战（旧）",
      original_name: "呪術廻戦",
      first_air_date: "2020-10-03",
      seasons: [{ season_number: 1, episode_count: 24, air_date: "2020-10-03" }],
      external_ids: {
        imdb_id: "tt12343534",
        tvdb_id: 377543,
      },
    };
    let tvChangedIds: number[] = [];

    const outbound = createFakeOutboundClient({
      fetchExternal(request: ExternalHttpRequest): ExternalHttpResponse {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/tv/95479")) {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            url: request.url,
            body: JSON.stringify(tvSnapshot),
          };
        }
        if (url.pathname.endsWith("/tv/changes")) {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            url: request.url,
            body: JSON.stringify({
              page: 1,
              total_pages: 1,
              total_results: tvChangedIds.length,
              results: tvChangedIds.map((id) => ({ id, adult: false })),
            }),
          };
        }
        throw new Error(`Unexpected outbound request: ${request.url}`);
      },
    });

    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      adapterRegistry: createAdapterRegistry(),
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });

    const { submitKey, readKey } = await setupActors(testDb, app, outbound);
    const { mediaId } = await submitAndApprove(
      app,
      submitKey.key,
      { db: testDb.writeDb, outbound },
      {
        targetExternalKey: "tmdb:tv:95479",
        namespace: "bilibili",
        nativeId: "ss34430",
        variantDescription: "原声",
        segments: [
          { season: 1, episodeStart: 1, episodeEnd: 24, targetEpisodeStart: 1, baseline: "tmdb" },
        ],
      },
    );

    // Lock the IMDb external ID so sync must NOT overwrite it, while leaving TVDB unlocked
    await testDb.writeDb
      .updateTable("associations")
      .where("is_external_id", "=", true)
      .set({ native_id: "tt9999999", locked: true, source: "reviewer" })
      .where("media_id", "=", mediaId)
      .where("namespace", "=", "imdb")
      .execute();

    // Upstream TMDB updates title, premiere year, adds season 2 (season 1 unchanged), and changes imdb + tvdb
    tvSnapshot = {
      id: 95479,
      name: "咒术回战",
      original_name: "呪術廻戦 Revised",
      first_air_date: "2021-01-01",
      seasons: [
        { season_number: 1, episode_count: 24, air_date: "2020-10-03" },
        { season_number: 2, episode_count: 23, air_date: "2023-07-06" },
      ],
      external_ids: {
        imdb_id: "tt0000001",
        tvdb_id: 999888,
      },
    };
    tvChangedIds = [95479];

    let now = new Date("2026-11-23T04:00:00.000Z");
    const emitted: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
      config: { tmdb: { accessToken: "test-tmdb-token" } },
      now: () => now,
    });

    await worker.scheduled(createScheduledController(now));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.jobType).toBe("tmdb_sync");

    const { batch, ackedCount } = createQueueBatch([emitted.shift()!], now);
    const queueSummary = await worker.queue(batch);
    expect(queueSummary.completed).toBe(1);
    expect(ackedCount()).toBe(1);

    const after = await readMedia(app, readKey.key, "tmdb:tv:95479");
    expect(after.status).toBe(200);
    expect(after.document?.media.snapshot).toEqual({
      title: "咒术回战",
      originalTitle: "呪術廻戦 Revised",
      year: 2021,
      type: "tv",
      seasons: [
        { season: 1, episodeCount: 24, airYear: 2020 },
        { season: 2, episodeCount: 23, airYear: 2023 },
      ],
    });
    expect(after.document?.externalIds).toEqual(
      expect.arrayContaining([
        { namespace: "tmdb", nativeId: "tv:95479" },
        { namespace: "imdb", nativeId: "tt9999999", locked: true },
        { namespace: "tvdb", nativeId: "999888" },
      ]),
    );
    // Season 1 structure did not change -> segment remains mapped!
    expect(
      resolveEpisode(after.document!, { namespace: "bilibili", season: 1, episode: 5 }),
    ).toMatchObject({ kind: "mapped", nativeId: "ss34430", targetEpisode: 5 });

    // A second cron tick on the same day does NOT enqueue another sync job
    now = new Date("2026-11-23T05:00:00.000Z");
    await worker.scheduled(createScheduledController(now));
    expect(emitted).toHaveLength(0);
  });

  test("one item that keeps failing does not hold the cursor back; it is retried on later runs", async () => {
    const { tmdb, run, cursor } = await setupTrackedMovies(handles, 2);

    await run("2026-11-10T04:00:00Z");
    tmdb.changed = [1, 2];
    tmdb.failing.add("2");
    const day2 = await run("2026-11-11T04:00:00Z");
    expect(day2.transientErrors).toHaveLength(1);
    expect(day2.movie).toMatchObject({ cursorAdvanced: true, refreshedCount: 1 });
    expect(await cursor()).toMatchObject({
      last_synced_date: "2026-11-11",
      metadata: { retryTmdbIds: ["2"] },
    });

    // Day 3: neither item changed, but the failed one is retried, succeeds and leaves the list.
    tmdb.changed = [];
    tmdb.failing.clear();
    tmdb.fetched.length = 0;
    const day3 = await run("2026-11-12T04:00:00Z");
    expect(day3.transientErrors).toEqual([]);
    expect(tmdb.fetched).toEqual(["2"]);
    const after = await cursor();
    expect(after.last_synced_date).toBe("2026-11-12");
    expect(after.metadata).not.toHaveProperty("retryTmdbIds");
  });

  test("a full refresh runs one page per run and advances the date only after the last page", async () => {
    const { db, tmdb, run, cursor } = await setupTrackedMovies(handles, 3);
    await db
      .insertInto("sync_state")
      .values({ sync_key: "tmdb_changes_movie", last_synced_date: "2026-10-01", metadata: "{}" })
      .execute();
    const now = "2026-11-12T04:00:00Z";

    const first = await run(now, { fullRefreshPageSize: 2 });
    expect(first.movie).toMatchObject({
      mode: "full_refresh",
      candidateCount: 2,
      cursorAdvanced: false,
    });
    expect((await cursor()).last_synced_date).toBe("2026-10-01");
    expect((await cursor()).metadata).toHaveProperty("fullRefreshAfterMediaId");

    const second = await run(now, { fullRefreshPageSize: 2 });
    expect(second.movie).toMatchObject({
      mode: "full_refresh",
      candidateCount: 1,
      cursorAdvanced: true,
    });
    expect(tmdb.fetched.sort()).toEqual(["1", "2", "3"]);
    const after = await cursor();
    expect(after.last_synced_date).toBe("2026-11-12");
    expect(after.metadata).not.toHaveProperty("fullRefreshAfterMediaId");
  });

  test("a full refresh over several days keeps earlier pages' failures and resumes from its first day", async () => {
    const { db, tmdb, run, cursor } = await setupTrackedMovies(handles, 3);
    await db
      .insertInto("sync_state")
      .values({ sync_key: "tmdb_changes_movie", last_synced_date: "2026-10-01", metadata: "{}" })
      .execute();

    // Day 1: the first page's two movies fail.
    for (const id of ["1", "2", "3"]) tmdb.failing.add(id);
    const first = await run("2026-11-10T04:00:00Z", { fullRefreshPageSize: 2 });
    expect(first.movie).toMatchObject({ mode: "full_refresh", cursorAdvanced: false });
    const failed = [...tmdb.fetched].sort();
    expect(failed).toHaveLength(2);
    expect((await cursor()).metadata).toMatchObject({ fullRefreshStartedOn: "2026-11-10" });

    // Day 3: the last page succeeds. The failures stay listed, and the date resumes from day 1.
    tmdb.failing.clear();
    const last = await run("2026-11-12T04:00:00Z", { fullRefreshPageSize: 2 });
    expect(last.movie).toMatchObject({ mode: "full_refresh", cursorAdvanced: true });
    const afterRefresh = await cursor();
    expect(afterRefresh.last_synced_date).toBe("2026-11-10");
    expect(afterRefresh.metadata).not.toHaveProperty("fullRefreshStartedOn");
    expect(
      [...((afterRefresh.metadata as { retryTmdbIds?: string[] }).retryTmdbIds ?? [])].sort(),
    ).toEqual(failed);

    // The next run asks for changes since day 1 and retries the earlier failures.
    tmdb.fetched.length = 0;
    const next = await run("2026-11-12T05:00:00Z");
    expect(next.movie).toMatchObject({ mode: "changes", startDate: "2026-11-10" });
    expect(tmdb.fetched.sort()).toEqual(failed);
    const after = await cursor();
    expect(after.last_synced_date).toBe("2026-11-12");
    expect(after.metadata).not.toHaveProperty("retryTmdbIds");
  });

  test("catches up missed days (<=14d via /changes, >14d via full refresh) and leaves cursor unadvanced on transient 5xx", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    let movieTitle = "搏击俱乐部 v1";
    let tvTitle = "三体 v1";
    let failChangesWith503 = false;
    const changeQueries: Array<{ path: string; startDate: string; endDate: string }> = [];

    const outbound = createFakeOutboundClient({
      fetchExternal(request: ExternalHttpRequest): ExternalHttpResponse {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/movie/550")) {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            url: request.url,
            body: JSON.stringify({
              id: 550,
              title: movieTitle,
              original_title: "Fight Club",
              release_date: "1999-10-15",
              external_ids: { imdb_id: "tt0137523" },
            }),
          };
        }
        if (url.pathname.endsWith("/tv/108545")) {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            url: request.url,
            body: JSON.stringify({
              id: 108545,
              name: tvTitle,
              original_name: "三体",
              first_air_date: "2023-01-15",
              seasons: [{ season_number: 1, episode_count: 30, air_date: "2023-01-15" }],
              external_ids: { imdb_id: "tt20242042", tvdb_id: 400100 },
            }),
          };
        }
        if (url.pathname.endsWith("/movie/changes") || url.pathname.endsWith("/tv/changes")) {
          changeQueries.push({
            path: url.pathname,
            startDate: url.searchParams.get("start_date") ?? "",
            endDate: url.searchParams.get("end_date") ?? "",
          });
          if (failChangesWith503) {
            return { status: 503, headers: {}, url: request.url, body: "Upstream Down" };
          }
          const ids = url.pathname.endsWith("/movie/changes") ? [550] : [108545];
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            url: request.url,
            body: JSON.stringify({
              page: 1,
              total_pages: 1,
              total_results: ids.length,
              results: ids.map((id) => ({ id, adult: false })),
            }),
          };
        }
        throw new Error(`Unexpected outbound request: ${request.url}`);
      },
    });

    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      adapterRegistry: createAdapterRegistry(),
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });

    const { submitKey, readKey } = await setupActors(testDb, app, outbound);
    await submitAndApprove(
      app,
      submitKey.key,
      { db: testDb.writeDb, outbound },
      {
        targetExternalKey: "tmdb:movie:550",
        namespace: "bilibili",
        nativeId: "ss28281",
        variantDescription: "原声",
        segments: [],
      },
    );
    await submitAndApprove(
      app,
      submitKey.key,
      { db: testDb.writeDb, outbound },
      {
        targetExternalKey: "tmdb:tv:108545",
        namespace: "tencent",
        nativeId: "mzc002007knmh3g",
        variantDescription: "原声",
        segments: [
          { season: 1, episodeStart: 1, episodeEnd: 30, targetEpisodeStart: 1, baseline: "tmdb" },
        ],
      },
    );

    let now = new Date("2026-11-10T04:00:00.000Z");
    const emitted: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
      config: {
        tmdb: { accessToken: "test-tmdb-token" },
        defaultRetryDelayMs: 60_000,
      },
      now: () => now,
    });

    // Day 1 (2026-11-10): initial sync initializes sync_state to 2026-11-10
    await worker.scheduled(createScheduledController(now));
    expect(emitted).toHaveLength(1);
    await worker.queue(createQueueBatch([emitted.shift()!], now).batch);

    // Missed 5 days (2026-11-15), first attempt hits transient 503 -> cursor MUST NOT advance
    now = new Date("2026-11-15T04:00:00.000Z");
    movieTitle = "搏击俱乐部 v2 (5天补齐)";
    tvTitle = "三体 v2 (5天补齐)";
    failChangesWith503 = true;
    changeQueries.length = 0;

    await worker.scheduled(createScheduledController(now));
    expect(emitted).toHaveLength(1);
    const failedAttempt = await worker.queue(createQueueBatch([emitted.shift()!], now).batch);
    expect(failedAttempt.rescheduled).toBe(1);

    // Confirm cursor remained at 2026-11-10 and titles did not change yet
    const syncRowsAfter503 = await testDb.readDb
      .selectFrom("sync_state")
      .select(["sync_key", "last_synced_date"])
      .orderBy("sync_key", "asc")
      .execute();
    expect(syncRowsAfter503).toEqual([
      { sync_key: "tmdb_changes_movie", last_synced_date: "2026-11-10" },
      { sync_key: "tmdb_changes_tv", last_synced_date: "2026-11-10" },
    ]);

    // TMDB recovers; after retry delay, job retries and catches up 2026-11-10..2026-11-15 via /changes
    failChangesWith503 = false;
    changeQueries.length = 0;
    now = new Date("2026-11-15T04:02:00.000Z");
    await worker.scheduled(createScheduledController(now));
    expect(emitted).toHaveLength(1);
    const retrySummary = await worker.queue(createQueueBatch([emitted.shift()!], now).batch);
    expect(retrySummary.completed).toBe(1);

    expect(changeQueries).toEqual(
      expect.arrayContaining([
        { path: "/3/movie/changes", startDate: "2026-11-10", endDate: "2026-11-15" },
        { path: "/3/tv/changes", startDate: "2026-11-10", endDate: "2026-11-15" },
      ]),
    );
    expect(
      (await readMedia(app, readKey.key, "tmdb:movie:550")).document?.media.snapshot.title,
    ).toBe("搏击俱乐部 v2 (5天补齐)");
    expect(
      (await readMedia(app, readKey.key, "tmdb:tv:108545")).document?.media.snapshot.title,
    ).toBe("三体 v2 (5天补齐)");

    // Missed 20 days (>14 days window -> 2026-12-05): falls back to full refresh WITHOUT calling /changes!
    now = new Date("2026-12-05T04:00:00.000Z");
    movieTitle = "搏击俱乐部 v3 (超过14天全量补齐)";
    tvTitle = "三体 v3 (超过14天全量补齐)";
    changeQueries.length = 0;

    await worker.scheduled(createScheduledController(now));
    expect(emitted).toHaveLength(1);
    const fullRefreshSummary = await worker.queue(createQueueBatch([emitted.shift()!], now).batch);
    expect(fullRefreshSummary.completed).toBe(1);

    expect(changeQueries).toHaveLength(0);
    expect(
      (await readMedia(app, readKey.key, "tmdb:movie:550")).document?.media.snapshot.title,
    ).toBe("搏击俱乐部 v3 (超过14天全量补齐)");
    expect(
      (await readMedia(app, readKey.key, "tmdb:tv:108545")).document?.media.snapshot.title,
    ).toBe("三体 v3 (超过14天全量补齐)");

    const syncRowsAfterFull = await testDb.readDb
      .selectFrom("sync_state")
      .select(["sync_key", "last_synced_date"])
      .orderBy("sync_key", "asc")
      .execute();
    expect(syncRowsAfterFull).toEqual([
      { sync_key: "tmdb_changes_movie", last_synced_date: "2026-12-05" },
      { sync_key: "tmdb_changes_tv", last_synced_date: "2026-12-05" },
    ]);
  });

  test("marks affected season segments needsReview on TMDB structure change while unaffected seasons still map, and exposes them to reviewers", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    let seasons = [
      { season_number: 1, episode_count: 24, air_date: "2020-10-03" },
      { season_number: 2, episode_count: 23, air_date: "2023-07-06" },
      { season_number: 3, episode_count: 12, air_date: "2025-04-01" },
      { season_number: 4, episode_count: 10, air_date: "2026-01-10" },
    ];

    const outbound = createFakeOutboundClient({
      fetchExternal(request: ExternalHttpRequest): ExternalHttpResponse {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/tv/95479")) {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            url: request.url,
            body: JSON.stringify({
              id: 95479,
              name: "咒术回战",
              original_name: "呪術廻戦",
              first_air_date: "2020-10-03",
              seasons,
              external_ids: { imdb_id: "tt12343534" },
            }),
          };
        }
        if (url.pathname.endsWith("/tv/changes")) {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            url: request.url,
            body: JSON.stringify({
              page: 1,
              total_pages: 1,
              total_results: 1,
              results: [{ id: 95479, adult: false }],
            }),
          };
        }
        throw new Error(`Unexpected outbound request: ${request.url}`);
      },
    });

    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      adapterRegistry: createAdapterRegistry(),
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });

    const { submitter, reviewer, submitKey, readKey } = await setupActors(testDb, app, outbound);
    const { mediaId } = await submitAndApprove(
      app,
      submitKey.key,
      { db: testDb.writeDb, outbound },
      {
        targetExternalKey: "tmdb:tv:95479",
        namespace: "bilibili",
        nativeId: "ss34430",
        variantDescription: "原声",
        segments: [
          { season: 1, episodeStart: 1, episodeEnd: 24, targetEpisodeStart: 1, baseline: "tmdb" },
          { season: 2, episodeStart: 1, episodeEnd: 23, targetEpisodeStart: 25, baseline: "tmdb" },
          { season: 3, episodeStart: 1, episodeEnd: 12, targetEpisodeStart: 48, baseline: "tmdb" },
          { season: 4, episodeStart: 1, episodeEnd: 10, targetEpisodeStart: 60, baseline: "tmdb" },
        ],
      },
    );

    // Upstream TMDB changes:
    // - Season 1: episode_count 24 -> 47
    // - Season 2: air_date year 2023 -> 2024
    // - Season 3: UNCHANGED
    // - Season 4: REMOVED
    seasons = [
      { season_number: 1, episode_count: 47, air_date: "2020-10-03" },
      { season_number: 2, episode_count: 23, air_date: "2024-01-01" },
      { season_number: 3, episode_count: 12, air_date: "2025-04-01" },
    ];

    const now = new Date("2026-11-23T04:00:00.000Z");
    const emitted: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
      config: { tmdb: { accessToken: "test-tmdb-token" } },
      now: () => now,
    });

    await worker.scheduled(createScheduledController(now));
    expect(emitted).toHaveLength(1);
    const summary = await worker.queue(createQueueBatch([emitted.shift()!], now).batch);
    expect(summary.completed).toBe(1);

    // Read API still returns all confirmed associations & segments, with affected seasons flagged needsReview: true
    const after = await readMedia(app, readKey.key, "tmdb:tv:95479");
    expect(after.status).toBe(200);
    const doc = after.document!;
    expect(doc.associations).toHaveLength(1);
    expect(doc.associations[0]?.status).toBe("confirmed");
    expect(doc.associations[0]?.segments).toHaveLength(4);

    // Affected seasons (1, 2, 4) -> collection_only (needs_review), no targetEpisode
    for (const affectedSeason of [1, 2, 4]) {
      const resolved = resolveEpisode(doc, {
        namespace: "bilibili",
        season: affectedSeason,
        episode: 3,
      });
      expect(resolved).toMatchObject({
        kind: "collection_only",
        reason: "needs_review",
        namespace: "bilibili",
        nativeId: "ss34430",
      });
      expect("targetEpisode" in resolved).toBe(false);
    }

    // Unaffected season 3 -> still maps cleanly!
    expect(resolveEpisode(doc, { namespace: "bilibili", season: 3, episode: 5 })).toMatchObject({
      kind: "mapped",
      namespace: "bilibili",
      nativeId: "ss34430",
      targetEpisode: 52, // 48 + (5 - 1)
    });

    // Reviewer endpoint requires reviewer role
    const unauthErr = await expectRpcError(
      createRpcClients(app).reviewer.listNeedsReviewSegments({}),
    );
    expect(unauthErr.status).toBe(401);
    const nonReviewerErr = await expectRpcError(
      createRpcClients(app, { cookie: submitter.cookie }).reviewer.listNeedsReviewSegments({}),
    );
    expect(nonReviewerErr.status).toBe(403);

    // Reviewer sees exactly the 3 flagged segments (seasons 1, 2, 4)
    const reviewerSegsBody = await createRpcClients(app, {
      cookie: reviewer.cookie,
    }).reviewer.listNeedsReviewSegments({});
    expect(reviewerSegsBody.total).toBe(3);
    expect(reviewerSegsBody.segments.map((s) => s.season).sort((a, b) => a - b)).toEqual([1, 2, 4]);
    expect(reviewerSegsBody.segments.every((s) => s.mediaId === mediaId && s.needsReview)).toBe(
      true,
    );
  });

  test("creates a deduplicated open tmdb_missing_or_merged reviewer alert when TMDB returns 404 without deleting the media", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    let return404For77777 = false;
    const outbound = createFakeOutboundClient({
      fetchExternal(request: ExternalHttpRequest): ExternalHttpResponse {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/tv/77777")) {
          if (return404For77777) {
            return {
              status: 404,
              headers: { "content-type": "application/json" },
              url: request.url,
              body: JSON.stringify({
                status_code: 34,
                status_message: "The resource you requested could not be found.",
              }),
            };
          }
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            url: request.url,
            body: JSON.stringify({
              id: 77777,
              name: "待合并剧集",
              original_name: "Duplicate Show",
              first_air_date: "2022-05-01",
              seasons: [{ season_number: 1, episode_count: 12, air_date: "2022-05-01" }],
              external_ids: {},
            }),
          };
        }
        if (url.pathname.endsWith("/tv/changes")) {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            url: request.url,
            body: JSON.stringify({
              page: 1,
              total_pages: 1,
              total_results: 1,
              results: [{ id: 77777, adult: false }],
            }),
          };
        }
        throw new Error(`Unexpected outbound request: ${request.url}`);
      },
    });

    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      adapterRegistry: createAdapterRegistry(),
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });

    const { submitter, reviewer, submitKey, readKey } = await setupActors(testDb, app, outbound);
    const { mediaId } = await submitAndApprove(
      app,
      submitKey.key,
      { db: testDb.writeDb, outbound },
      {
        targetExternalKey: "tmdb:tv:77777",
        namespace: "bilibili",
        nativeId: "ss77777",
        variantDescription: "原声",
        segments: [
          { season: 1, episodeStart: 1, episodeEnd: 12, targetEpisodeStart: 1, baseline: "tmdb" },
        ],
      },
    );

    // Now TMDB deletes/merges 77777 -> 404
    return404For77777 = true;

    let now = new Date("2026-11-23T04:00:00.000Z");
    const emitted: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
      config: { tmdb: { accessToken: "test-tmdb-token" } },
      now: () => now,
    });

    await worker.scheduled(createScheduledController(now));
    expect(emitted).toHaveLength(1);
    const day1Summary = await worker.queue(createQueueBatch([emitted.shift()!], now).batch);
    expect(day1Summary.completed).toBe(1);

    // Media MUST NOT be deleted
    const stillExists = await readMedia(app, readKey.key, "tmdb:tv:77777");
    expect(stillExists.status).toBe(200);
    expect(stillExists.document?.media.id).toBe(mediaId);

    // Alerts endpoint enforces reviewer authorization
    const nonReviewerAlertsErr = await expectRpcError(
      createRpcClients(app, { cookie: submitter.cookie }).reviewer.listReviewAlerts({}),
    );
    expect(nonReviewerAlertsErr.status).toBe(403);

    // Reviewer sees the open tmdb_missing_or_merged alert
    const reviewerRpc = createRpcClients(app, { cookie: reviewer.cookie });
    const alertsBody1 = await reviewerRpc.reviewer.listReviewAlerts({
      alertType: "tmdb_missing_or_merged",
    });
    expect(alertsBody1.total).toBe(1);
    expect(alertsBody1.alerts[0]).toMatchObject({
      alertType: "tmdb_missing_or_merged",
      mediaId,
      details: expect.objectContaining({
        tmdbExternalKey: "tmdb:tv:77777",
      }),
    });
    expect(fromProtoReviewAlertStatus(alertsBody1.alerts[0]!.status)).toBe("open");

    // Running sync again on the next day when 77777 still returns 404 deduplicates the open alert
    now = new Date("2026-11-24T04:00:00.000Z");
    await worker.scheduled(createScheduledController(now));
    expect(emitted).toHaveLength(1);
    await worker.queue(createQueueBatch([emitted.shift()!], now).batch);

    const alertsBody2 = await reviewerRpc.reviewer.listReviewAlerts({
      alertType: "tmdb_missing_or_merged",
    });
    expect(alertsBody2.total).toBe(1);
  });

  test("merges media cleanly: old UUID & external ID redirect, chained merges flatten, single default variant preserved, and open 404 alert auto-resolves", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const tmdbRecords: Record<string, Record<string, unknown>> = {
      "77777": {
        id: 77777,
        name: "重复条目 A",
        original_name: "Dup A",
        first_air_date: "2020-10-03",
        seasons: [{ season_number: 1, episode_count: 47, air_date: "2020-10-03" }],
        external_ids: { tvdb_id: 377543 },
      },
      "88888": {
        id: 88888,
        name: "中间条目 B",
        original_name: "Mid B",
        first_air_date: "2020-10-03",
        seasons: [{ season_number: 1, episode_count: 47, air_date: "2020-10-03" }],
        external_ids: { imdb_id: "tt12343534" },
      },
      "95479": {
        id: 95479,
        name: "咒术回战",
        original_name: "呪術廻戦",
        first_air_date: "2020-10-03",
        seasons: [{ season_number: 1, episode_count: 47, air_date: "2020-10-03" }],
        external_ids: {},
      },
    };

    let return404For77777 = false;
    const outbound = createFakeOutboundClient({
      fetchExternal(request: ExternalHttpRequest): ExternalHttpResponse {
        const url = new URL(request.url);
        const match = url.pathname.match(/\/tv\/(\d+)$/);
        if (match) {
          const id = match[1]!;
          if (id === "77777" && return404For77777) {
            return { status: 404, headers: {}, url: request.url, body: "{}" };
          }
          const rec = tmdbRecords[id];
          if (rec) {
            return {
              status: 200,
              headers: { "content-type": "application/json" },
              url: request.url,
              body: JSON.stringify(rec),
            };
          }
        }
        if (url.pathname.endsWith("/tv/changes")) {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            url: request.url,
            body: JSON.stringify({
              page: 1,
              total_pages: 1,
              total_results: 1,
              results: [{ id: 77777, adult: false }],
            }),
          };
        }
        throw new Error(`Unexpected outbound request: ${request.url}`);
      },
    });

    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      adapterRegistry: createAdapterRegistry(),
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });

    const { submitter, reviewer, submitKey, readKey } = await setupActors(testDb, app, outbound);

    // Media A (tmdb:tv:77777): bilibili S1 E25-47 ("原声" default) + tencent S1 E1-47 ("原声" default)
    const createdA1 = await submitAndApprove(
      app,
      submitKey.key,
      { db: testDb.writeDb, outbound },
      {
        targetExternalKey: "tmdb:tv:77777",
        namespace: "bilibili",
        nativeId: "ss45574",
        variantDescription: "原声",
        segments: [
          { season: 1, episodeStart: 25, episodeEnd: 47, targetEpisodeStart: 1, baseline: "tmdb" },
        ],
      },
    );
    await submitAndApprove(
      app,
      submitKey.key,
      { db: testDb.writeDb, outbound },
      {
        targetExternalKey: "tmdb:tv:77777",
        namespace: "tencent",
        nativeId: "mzc002007knmh3g",
        variantDescription: "原声",
        segments: [
          { season: 1, episodeStart: 1, episodeEnd: 47, targetEpisodeStart: 1, baseline: "tmdb" },
        ],
      },
    );

    // Media B (tmdb:tv:88888): bilibili S1 E1-24 ("原声" default)
    const createdB = await submitAndApprove(
      app,
      submitKey.key,
      { db: testDb.writeDb, outbound },
      {
        targetExternalKey: "tmdb:tv:88888",
        namespace: "bilibili",
        nativeId: "ss34430",
        variantDescription: "原声",
        segments: [
          { season: 1, episodeStart: 1, episodeEnd: 24, targetEpisodeStart: 1, baseline: "tmdb" },
        ],
      },
    );

    // Media C (tmdb:tv:95479): bilibili S1 E1-47 ("中配" default)
    const createdC = await submitAndApprove(
      app,
      submitKey.key,
      { db: testDb.writeDb, outbound },
      {
        targetExternalKey: "tmdb:tv:95479",
        namespace: "bilibili",
        nativeId: "ss99999",
        variantDescription: "中配",
        segments: [
          { season: 1, episodeStart: 1, episodeEnd: 47, targetEpisodeStart: 1, baseline: "tmdb" },
        ],
      },
    );

    // Trigger 404 alert on Media A via daily sync
    return404For77777 = true;
    const now = new Date("2026-11-23T04:00:00.000Z");
    const emitted: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
      config: { tmdb: { accessToken: "test-tmdb-token" } },
      now: () => now,
    });
    await worker.scheduled(createScheduledController(now));
    await worker.queue(createQueueBatch([emitted.shift()!], now).batch);

    // Non-reviewer cannot merge
    const submitterRpc = createRpcClients(app, { cookie: submitter.cookie });
    const reviewerRpc = createRpcClients(app, { cookie: reviewer.cookie });
    const forbiddenMergeErr = await expectRpcError(
      submitterRpc.reviewer.mergeMedia({
        sourceMediaId: createdA1.mediaId,
        targetMediaId: createdB.mediaId,
      }),
    );
    expect(forbiddenMergeErr.status).toBe(403);

    // Self-merge is rejected
    const selfMergeErr = await expectRpcError(
      reviewerRpc.reviewer.mergeMedia({
        sourceMediaId: createdA1.mediaId,
        targetMediaId: createdA1.mediaId,
      }),
    );
    expect(selfMergeErr.status).toBe(400);

    // Merge A -> B
    await reviewerRpc.reviewer.mergeMedia({
      sourceMediaId: createdA1.mediaId,
      targetMediaId: createdB.mediaId,
      reason: "TMDB merged 77777 into 88888",
    });

    // Media A's open tmdb_missing_or_merged alert is automatically resolved after merge
    const remainingOpenAlerts = await reviewerRpc.reviewer.listReviewAlerts({
      alertType: "tmdb_missing_or_merged",
    });
    expect(remainingOpenAlerts.total).toBe(0);

    // Querying old Media A UUID and old TMDB external key transparently resolves to Media B
    const viaOldUuid = await readMedia(app, readKey.key, createdA1.mediaId);
    expect(viaOldUuid.status).toBe(200);
    expect(viaOldUuid.document?.media.id).toBe(createdB.mediaId);
    expect(viaOldUuid.document?.externalIds).toEqual(
      expect.arrayContaining([
        { namespace: "tmdb", nativeId: "tv:88888" },
        { namespace: "imdb", nativeId: "tt12343534" },
        { namespace: "tvdb", nativeId: "377543" },
      ]),
    );
    // Both S1 E5 (from B) and S1 E30 (from A) resolve under the single default Bilibili variant!
    expect(
      resolveEpisode(viaOldUuid.document!, { namespace: "bilibili", season: 1, episode: 5 }),
    ).toMatchObject({ kind: "mapped", nativeId: "ss34430", targetEpisode: 5 });
    expect(
      resolveEpisode(viaOldUuid.document!, { namespace: "bilibili", season: 1, episode: 30 }),
    ).toMatchObject({ kind: "mapped", nativeId: "ss45574", targetEpisode: 6 });
    expect(
      resolveEpisode(viaOldUuid.document!, { namespace: "tencent", season: 1, episode: 10 }),
    ).toMatchObject({ kind: "mapped", nativeId: "mzc002007knmh3g", targetEpisode: 10 });

    const viaOldTmdb = await readMedia(app, readKey.key, "tmdb:tv:77777");
    expect(viaOldTmdb.status).toBe(200);
    expect(viaOldTmdb.document?.media.id).toBe(createdB.mediaId);

    // Chain merge B -> C: A's redirect flattens to C, and C keeps its single default bilibili variant ("中配")
    await reviewerRpc.reviewer.mergeMedia({
      sourceMediaId: createdB.mediaId,
      targetMediaId: createdC.mediaId,
      reason: "Consolidated into canonical TMDB 95479",
    });

    // Cycle attempt C -> A must fail cleanly
    const cycleErr = await expectRpcError(
      reviewerRpc.reviewer.mergeMedia({
        sourceMediaId: createdC.mediaId,
        targetMediaId: createdA1.mediaId,
      }),
    );
    expect(cycleErr.status).toBe(409);

    const viaOldAAfterChain = await readMedia(app, readKey.key, createdA1.mediaId);
    expect(viaOldAAfterChain.status).toBe(200);
    expect(viaOldAAfterChain.document?.media.id).toBe(createdC.mediaId);
    const defaultBilibiliVariants = viaOldAAfterChain.document!.variants.filter(
      (v) => v.namespace === "bilibili" && v.isDefault,
    );
    expect(defaultBilibiliVariants).toHaveLength(1);
    expect(defaultBilibiliVariants[0]?.label).toBe("中配");
  });

  test("marks old-baseline segments needsReview on merge from douban -> tmdb and resumes mapping after new tmdb submission", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const outbound = createFakeOutboundClient({
      fetchExternal(request: ExternalHttpRequest): ExternalHttpResponse {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/tv/95479")) {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            url: request.url,
            body: JSON.stringify({
              id: 95479,
              name: "咒术回战",
              original_name: "呪術廻戦",
              first_air_date: "2020-10-03",
              seasons: [{ season_number: 1, episode_count: 47, air_date: "2020-10-03" }],
              external_ids: { imdb_id: "tt12343534" },
            }),
          };
        }
        throw new Error(`Unexpected outbound request: ${request.url}`);
      },
    });

    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      adapterRegistry: createAdapterRegistry(),
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });

    const { reviewer, submitKey, readKey } = await setupActors(testDb, app, outbound);

    // Seed a non-TMDB media using Douban as baseline (before TMDB entry existed)
    const doubanMedia = await testDb.writeDb
      .insertInto("media")
      .values({
        type: "tv",
        baseline: "douban",
        title: "咒术回战（豆瓣基准）",
        year: 2020,
        seasons: JSON.stringify([{ season: 1, episodeCount: 24, airYear: 2020 }]),
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await submitAndApprove(
      app,
      submitKey.key,
      { db: testDb.writeDb, outbound },
      {
        targetExternalKey: doubanMedia.id,
        namespace: "bilibili",
        nativeId: "ss34430",
        variantDescription: "原声",
        segments: [
          { season: 1, episodeStart: 1, episodeEnd: 24, targetEpisodeStart: 1, baseline: "douban" },
        ],
      },
    );

    // Before merge: resolves cleanly under douban baseline
    const beforeMerge = await readMedia(app, readKey.key, doubanMedia.id);
    expect(beforeMerge.status).toBe(200);
    expect(
      resolveEpisode(beforeMerge.document!, { namespace: "bilibili", season: 1, episode: 5 }),
    ).toMatchObject({ kind: "mapped", nativeId: "ss34430", targetEpisode: 5 });

    // Create TMDB-backed target media (e.g. TMDB added later)
    const tmdbCreated = await submitAndApprove(
      app,
      submitKey.key,
      { db: testDb.writeDb, outbound },
      {
        targetExternalKey: "tmdb:tv:95479",
        namespace: "tencent",
        nativeId: "mzc002007knmh3g",
        variantDescription: "原声",
        segments: [
          { season: 1, episodeStart: 1, episodeEnd: 47, targetEpisodeStart: 1, baseline: "tmdb" },
        ],
      },
    );

    // Merge douban-baseline media into TMDB-backed target
    const mergeRes = await createRpcClients(app, {
      cookie: reviewer.cookie,
    }).reviewer.mergeMedia({
      sourceMediaId: doubanMedia.id,
      targetMediaId: tmdbCreated.mediaId,
      reason: "TMDB entry now available",
    });
    expect(mergeRes).toMatchObject({
      sourceMediaId: doubanMedia.id,
      targetMediaId: tmdbCreated.mediaId,
      flaggedSegmentCount: 1,
    });

    // Old UUID redirects to target, old douban segment is STILL returned with needsReview: true & baseline: "douban"
    const afterMerge = await readMedia(app, readKey.key, doubanMedia.id);
    expect(afterMerge.status).toBe(200);
    expect(afterMerge.document?.media.id).toBe(tmdbCreated.mediaId);
    expect(afterMerge.document?.media.baseline).toBe("tmdb");

    const bilibiliAssoc = afterMerge.document?.associations.find((a) => a.namespace === "bilibili");
    expect(bilibiliAssoc).toMatchObject({
      nativeId: "ss34430",
      status: "confirmed",
      segments: [
        {
          season: 1,
          episodeStart: 1,
          episodeEnd: 24,
          targetEpisodeStart: 1,
          baseline: "douban",
          needsReview: true,
        },
      ],
    });

    // resolveEpisode returns collection_only (needs_review) with NO targetEpisode!
    const resolvedDuringSwitch = resolveEpisode(afterMerge.document!, {
      namespace: "bilibili",
      season: 1,
      episode: 5,
    });
    expect(resolvedDuringSwitch).toMatchObject({
      kind: "collection_only",
      reason: "needs_review",
      namespace: "bilibili",
      nativeId: "ss34430",
    });
    expect("targetEpisode" in resolvedDuringSwitch).toBe(false);

    // Contributor resubmits ss34430 on the new "tmdb" baseline and reviewer approves
    await submitAndApprove(
      app,
      submitKey.key,
      { db: testDb.writeDb, outbound },
      {
        targetExternalKey: "tmdb:tv:95479",
        namespace: "bilibili",
        nativeId: "ss34430",
        variantDescription: "原声",
        segments: [
          { season: 1, episodeStart: 1, episodeEnd: 24, targetEpisodeStart: 1, baseline: "tmdb" },
        ],
      },
    );

    // Mapping resumes!
    const afterResubmit = await readMedia(app, readKey.key, "tmdb:tv:95479");
    expect(afterResubmit.status).toBe(200);
    expect(
      resolveEpisode(afterResubmit.document!, { namespace: "bilibili", season: 1, episode: 5 }),
    ).toMatchObject({
      kind: "mapped",
      namespace: "bilibili",
      nativeId: "ss34430",
      targetEpisode: 5,
    });
  });

  test("switches media baseline directly via reviewer endpoint, flags old-baseline segments needsReview, and restores mapping after new submission", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const outbound = createFakeOutboundClient();
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      adapterRegistry: createAdapterRegistry(),
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
      },
    });

    const { submitter, reviewer, submitKey, readKey } = await setupActors(testDb, app, outbound);

    const media = await testDb.writeDb
      .insertInto("media")
      .values({
        type: "tv",
        baseline: "douban",
        title: "示例国创",
        year: 2024,
        seasons: JSON.stringify([{ season: 1, episodeCount: 12, airYear: 2024 }]),
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await submitAndApprove(
      app,
      submitKey.key,
      { db: testDb.writeDb, outbound },
      {
        targetExternalKey: media.id,
        namespace: "bilibili",
        nativeId: "ss55555",
        variantDescription: "原声",
        segments: [
          { season: 1, episodeStart: 1, episodeEnd: 12, targetEpisodeStart: 1, baseline: "douban" },
        ],
      },
    );

    // Non-reviewer forbidden; invalid baseline rejected
    const submitterRpc = createRpcClients(app, { cookie: submitter.cookie });
    const reviewerRpc = createRpcClients(app, { cookie: reviewer.cookie });

    const forbiddenSwitchErr = await expectRpcError(
      submitterRpc.reviewer.switchMediaBaseline({
        mediaId: media.id,
        baseline: "tmdb",
      }),
    );
    expect(forbiddenSwitchErr.status).toBe(403);

    const invalidBaselineErr = await expectRpcError(
      reviewerRpc.reviewer.switchMediaBaseline({
        mediaId: media.id,
        baseline: "invalid_source",
      }),
    );
    expect(invalidBaselineErr.status).toBe(400);

    // Switch baseline from douban -> tmdb
    const switchRes = await reviewerRpc.reviewer.switchMediaBaseline({
      mediaId: media.id,
      baseline: "tmdb",
      reason: "Adopted TMDB numbering",
    });
    expect(switchRes).toMatchObject({
      mediaId: media.id,
      previousBaseline: "douban",
      baseline: "tmdb",
      flaggedSegmentCount: 1,
    });

    // Old segment still returned with baseline: "douban" & needsReview: true, and resolveEpisode returns collection_only
    const afterSwitch = await readMedia(app, readKey.key, media.id);
    expect(afterSwitch.status).toBe(200);
    expect(afterSwitch.document?.media.baseline).toBe("tmdb");
    expect(afterSwitch.document?.associations[0]?.segments).toEqual([
      {
        season: 1,
        episodeStart: 1,
        episodeEnd: 12,
        targetEpisodeStart: 1,
        baseline: "douban",
        needsReview: true,
      },
    ]);

    const resolvedAfterSwitch = resolveEpisode(afterSwitch.document!, {
      namespace: "bilibili",
      season: 1,
      episode: 4,
    });
    expect(resolvedAfterSwitch).toMatchObject({
      kind: "collection_only",
      reason: "needs_review",
      nativeId: "ss55555",
    });
    expect("targetEpisode" in resolvedAfterSwitch).toBe(false);

    // Visible in reviewer needs-review queue
    const needsReviewRes = await reviewerRpc.reviewer.listNeedsReviewSegments({
      mediaId: media.id,
    });
    expect(needsReviewRes.total).toBe(1);

    // Submit & approve replacement on "tmdb" baseline -> mapping resumes and needs-review queue clears!
    await submitAndApprove(
      app,
      submitKey.key,
      { db: testDb.writeDb, outbound },
      {
        targetExternalKey: media.id,
        namespace: "bilibili",
        nativeId: "ss55555",
        variantDescription: "原声",
        segments: [
          { season: 1, episodeStart: 1, episodeEnd: 12, targetEpisodeStart: 1, baseline: "tmdb" },
        ],
      },
    );

    const afterReplacement = await readMedia(app, readKey.key, media.id);
    expect(afterReplacement.status).toBe(200);
    expect(
      resolveEpisode(afterReplacement.document!, { namespace: "bilibili", season: 1, episode: 4 }),
    ).toMatchObject({
      kind: "mapped",
      nativeId: "ss55555",
      targetEpisode: 4,
    });

    const needsReviewCleared = await reviewerRpc.reviewer.listNeedsReviewSegments({
      mediaId: media.id,
    });
    expect(needsReviewCleared.total).toBe(0);
  });

  test("backfills missing Trakt external IDs on existing TMDB-tracked media even when unchanged in daily /changes and rotates backfill cursor across batches (#103)", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    // Seed two existing TMDB-tracked movies (like Wikidata/Douban seed imports) that do NOT yet have Trakt IDs:
    // movie:24428 has a Trakt entry (movie:727); movie:999001 legitimately has no Trakt entry yet.
    const mediaRows = await testDb.writeDb
      .insertInto("media")
      .values([
        {
          type: "movie",
          baseline: "tmdb",
          title: "复仇者联盟",
          original_title: "The Avengers",
          year: 2012,
          seasons: "[]",
        },
        {
          type: "movie",
          baseline: "tmdb",
          title: "冷门国产片",
          original_title: "Obscure Film",
          year: 2020,
          seasons: "[]",
        },
      ])
      .returning(["id", "title"])
      .execute();

    // Force deterministic ordering: let Obscure Film sort BEFORE Avengers by media.id so we can verify
    // batch=1 cursor rotation does not starve Avengers when Obscure Film has no Trakt ID.
    const sorted = [...mediaRows].sort((a, b) => a.id.localeCompare(b.id));
    const firstMedia = sorted[0]!;
    const secondMedia = sorted[1]!;

    await testDb.writeDb
      .insertInto("associations")
      .values([
        {
          status: "confirmed",
          is_external_id: true,
          media_id: firstMedia.id,
          namespace: "tmdb",
          native_id: "movie:999001",
          source: "sync",
        },
        {
          status: "confirmed",
          is_external_id: true,
          media_id: secondMedia.id,
          namespace: "tmdb",
          native_id: "movie:24428",
          source: "sync",
        },
      ])
      .execute();

    // Cursor is current yesterday so daily sync runs in "changes" mode, and TMDB /movie/changes is EMPTY.
    await testDb.writeDb
      .insertInto("sync_state")
      .values({
        sync_key: TMDB_SYNC_KEY_MOVIE,
        last_synced_date: "2026-11-22",
      })
      .execute();

    const outbound = createFakeOutboundClient({
      fetchExternal(request: ExternalHttpRequest): ExternalHttpResponse {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/movie/changes")) {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            url: request.url,
            body: JSON.stringify({ page: 1, total_pages: 1, total_results: 0, results: [] }),
          };
        }
        if (url.pathname.endsWith("/movie/24428")) {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            url: request.url,
            body: JSON.stringify({
              id: 24428,
              title: "复仇者联盟",
              original_title: "The Avengers",
              release_date: "2012-04-25",
              external_ids: { imdb_id: "tt0848228" },
            }),
          };
        }
        if (url.pathname.endsWith("/movie/999001")) {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            url: request.url,
            body: JSON.stringify({
              id: 999001,
              title: "冷门国产片",
              original_title: "Obscure Film",
              release_date: "2020-01-01",
              external_ids: {},
            }),
          };
        }
        if (request.namespace === "trakt" && url.pathname.endsWith("/search/tmdb/24428")) {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            url: request.url,
            body: JSON.stringify([
              { type: "movie", movie: { title: "The Avengers", ids: { trakt: 727, tmdb: 24428 } } },
            ]),
          };
        }
        if (request.namespace === "trakt" && url.pathname.endsWith("/search/tmdb/999001")) {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            url: request.url,
            body: JSON.stringify([]),
          };
        }
        throw new Error(`Unexpected outbound request: ${request.url}`);
      },
    });

    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      adapterRegistry: createAdapterRegistry(),
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        tmdb: { accessToken: "test-tmdb-token", traktClientId: "test-trakt-client" },
      },
    });
    const { readKey } = await setupActors(testDb, app, outbound);

    const tmdbConfig = { accessToken: "test-tmdb-token", traktClientId: "test-trakt-client" };
    // Day 1 with batchSize=1 picks first missing-Trakt item (Obscure Film, no Trakt match).
    const day1 = await runTmdbDailySync(testDb.writeDb, outbound, {
      now: new Date("2026-11-23T04:00:00.000Z"),
      tmdbConfig,
      fullRefreshBatchSize: 1,
    });
    expect(day1.movie.candidateCount).toBe(1);
    expect((await readMedia(app, readKey.key, "tmdb:movie:24428")).document?.externalIds).toEqual([
      { namespace: "tmdb", nativeId: "movie:24428" },
    ]);

    // Day 2 rotates cursor past Obscure Film and picks Avengers, backfilling IMDb + Trakt!
    const day2 = await runTmdbDailySync(testDb.writeDb, outbound, {
      now: new Date("2026-11-24T04:00:00.000Z"),
      tmdbConfig,
      fullRefreshBatchSize: 1,
    });
    expect(day2.movie.candidateCount).toBe(1);

    const avengers = await readMedia(app, readKey.key, "tmdb:movie:24428");
    expect(avengers.status).toBe(200);
    expect(avengers.document?.externalIds).toEqual(
      expect.arrayContaining([
        { namespace: "tmdb", nativeId: "movie:24428" },
        { namespace: "imdb", nativeId: "tt0848228" },
        { namespace: "trakt", nativeId: "movie:727" },
      ]),
    );

    // Day 3 (default worker path) does NOT re-fetch Avengers because it already has Trakt.
    outbound.reset();
    const emitted: JobQueueMessage[] = [];
    const day3Now = new Date("2026-11-25T04:00:00.000Z");
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
      config: { tmdb: tmdbConfig },
      now: () => day3Now,
    });
    await worker.scheduled(createScheduledController(day3Now));
    expect(emitted).toHaveLength(1);
    await worker.queue(createQueueBatch([emitted.shift()!], day3Now).batch);
    expect(outbound.httpRequests.some((r) => r.url.includes("24428"))).toBe(false);
  });

  test.each(["matching", "conflicting"])(
    "Trakt backfill preserves Bangumi coordinates with a %s IMDb ID",
    async (identity) => {
      const handle = await createTestDb();
      handles.push(handle);
      const db = handle.writeDb;
      const media = await db
        .insertInto("media")
        .values({
          type: "tv",
          baseline: "bangumi",
          title: "Bangumi title",
          original_title: "Original",
          year: 2020,
          seasons: JSON.stringify([{ season: 1, episodeCount: 12, airYear: 2020 }]),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const imdbId = identity === "matching" ? "tt0000001" : "tt0000002";
      await db
        .insertInto("associations")
        .values([
          {
            media_id: media.id,
            namespace: "tmdb",
            native_id: "tv:10",
            status: "confirmed",
            is_external_id: true,
          },
          {
            media_id: media.id,
            namespace: "imdb",
            native_id: imdbId,
            status: "confirmed",
            is_external_id: true,
          },
        ])
        .execute();
      const bangumi = await db
        .insertInto("associations")
        .values({ media_id: media.id, namespace: "bangumi", native_id: "12", status: "confirmed" })
        .returning("id")
        .executeTakeFirstOrThrow();
      const segment = await db
        .insertInto("segments")
        .values({
          association_id: bangumi.id,
          season: 1,
          episode_start: 1,
          episode_end: 12,
          target_episode_start: 1,
          baseline: "bangumi",
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await db
        .insertInto("demands")
        .values({ external_key: "trakt:show:7", namespace_group: "platform", demand_count: 3 })
        .execute();

      const outbound = createFakeOutboundClient({
        fetchExternal({ url }) {
          let data: unknown;
          switch (new URL(url).pathname) {
            case "/3/tv/changes":
              data = { page: 1, total_pages: 1, results: [] };
              break;
            case "/3/tv/10":
              data = {
                id: 10,
                name: "TMDB title",
                first_air_date: "2021-03-01",
                seasons: [
                  { season_number: 1, episode_count: 24 },
                  { season_number: 2, episode_count: 6 },
                ],
                external_ids: { imdb_id: "tt0000001" },
              };
              break;
            case "/search/tmdb/10":
              data = [{ type: "show", show: { ids: { tmdb: 10, trakt: 7 } } }];
              break;
            default:
              throw new Error(`Unexpected URL ${url}`);
          }
          return { url, status: 200, headers: {}, body: JSON.stringify(data) };
        },
      });
      const result = await runTmdbDailySync(db, outbound, {
        tmdbConfig: { accessToken: "test", traktClientId: "test" },
      });
      expect(result.transientErrors).toEqual([]);
      expect(result.tv).toMatchObject({ mode: "changes", candidateCount: 1, cursorAdvanced: true });
      expect(
        await db.selectFrom("media").selectAll().where("id", "=", media.id).executeTakeFirst(),
      ).toEqual(media);
      expect(
        await db.selectFrom("segments").selectAll().where("id", "=", segment.id).executeTakeFirst(),
      ).toEqual(segment);
      expect(await db.selectFrom("review_alerts").select("id").execute()).toEqual([]);
      const ids = await db
        .selectFrom("associations")
        .select("native_id")
        .where("is_external_id", "=", true)
        .orderBy("namespace")
        .execute();
      const demands = await db
        .selectFrom("demands")
        .select(["media_id", "external_key", "season", "demand_count"])
        .execute();
      expect(ids.map((row) => row.native_id)).toEqual(
        identity === "matching" ? [imdbId, "tv:10", "show:7"] : [imdbId, "tv:10"],
      );
      expect(demands).toEqual([
        {
          media_id: identity === "matching" ? media.id : null,
          external_key: identity === "matching" ? null : "trakt:show:7",
          season: identity === "matching" ? 1 : null,
          demand_count: 3,
        },
      ]);
    },
  );

  test.each(["missing", "locked", "foreign"])("approval with a %s IMDb ID", async (imdb) => {
    const testDb = await createTestDb();
    handles.push(testDb);
    const imdbDemand = await testDb.writeDb
      .insertInto("demands")
      .values({
        external_key: "imdb:tt0848228",
        namespace_group: "platform",
        demand_count: 3,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    // With a foreign IMDb owner the requested TMDB media is new at approval.
    const seededMedia = await testDb.writeDb
      .insertInto("media")
      .values(
        imdb === "foreign"
          ? { type: "movie", title: "Another film", year: 1960 }
          : {
              type: "movie",
              baseline: "tmdb",
              title: "复仇者联盟",
              original_title: "The Avengers",
              year: 2012,
              seasons: "[]",
            },
      )
      .returning("id")
      .executeTakeFirstOrThrow();

    await testDb.writeDb
      .insertInto("associations")
      .values({
        status: "confirmed",
        is_external_id: true,
        media_id: seededMedia.id,
        namespace: imdb === "foreign" ? "imdb" : "tmdb",
        native_id: imdb === "foreign" ? "tt0848228" : "movie:24428",
        source: "sync",
      })
      .execute();

    if (imdb === "locked") {
      await testDb.writeDb
        .insertInto("associations")
        .values({
          media_id: seededMedia.id,
          namespace: "imdb",
          native_id: "tt0000001",
          status: "confirmed",
          is_external_id: true,
          locked: true,
          source: "reviewer",
        })
        .execute();
    }

    const outbound = createFakeOutboundClient({
      fetchExternal(request: ExternalHttpRequest): ExternalHttpResponse {
        const url = new URL(request.url);
        if (request.namespace === "tmdb" && url.pathname.endsWith("/movie/24428")) {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            url: request.url,
            body: JSON.stringify({
              id: 24428,
              title: "复仇者联盟",
              original_title: "The Avengers",
              release_date: "2012-04-25",
              external_ids: { imdb_id: "tt0848228" },
            }),
          };
        }
        if (request.namespace === "trakt" && url.pathname.endsWith("/search/tmdb/24428")) {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            url: request.url,
            body: JSON.stringify([
              { type: "movie", movie: { title: "The Avengers", ids: { trakt: 727, tmdb: 24428 } } },
            ]),
          };
        }
        if (request.namespace === "douban" && url.pathname.endsWith("/subject/1866479")) {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            url: request.url,
            body: JSON.stringify({
              id: "1866479",
              title: "复仇者联盟",
              original_title: "The Avengers",
              year: "2012",
              type: "movie",
              imdb_id: "tt0848228",
            }),
          };
        }
        throw new Error(`Unexpected outbound request: ${request.url}`);
      },
    });

    const prevDouban = {
      apiKey: DOUBAN_API.apiKey,
      minIntervalMs: DOUBAN_API.minIntervalMs,
      retryDelayMs: DOUBAN_API.retryDelayMs,
    };
    DOUBAN_API.apiKey = "test-douban-key";
    DOUBAN_API.minIntervalMs = 0;
    DOUBAN_API.retryDelayMs = 0;

    try {
      const now = new Date("2026-11-23T05:00:00.000Z");
      const tmdbConfig = { accessToken: "test-tmdb-token", traktClientId: "test-trakt-client" };
      const app = createApiApp({
        dbRead: testDb.readDb,
        dbWrite: testDb.writeDb,
        outbound,
        config: {
          baseUrl: TEST_BASE_URL,
          authSecret: TEST_AUTH_SECRET,
          now: () => now,
          tmdb: tmdbConfig,
        },
      });
      const { submitKey, readKey } = await setupActors(testDb, app, outbound);

      const submitted = await createRpcClients(app, {
        apiKey: submitKey.key,
      }).changeRequest.createChangeRequest({
        target: mediaRef("tmdb:movie:24428"),
        namespace: "douban",
        nativeId: "1866479",
        segments: [],
      });
      expect(submitted.changeRequest?.id).toBeTruthy();

      const emitted: JobQueueMessage[] = [];
      const worker = createBackgroundWorker({
        db: testDb.writeDb,
        outbound,
        queue: {
          async send(message) {
            emitted.push(message);
          },
        },
        config: {
          tmdb: tmdbConfig,
          enableDailyTmdbSync: false,
          enableDailyTmdbExportsSync: false,
          enableExplorationScheduling: false,
        },
        now: () => now,
      });

      await worker.scheduled(createScheduledController(now));
      expect(emitted.map((job) => job.jobType)).toContain("evidence_check");
      const queueResult = await worker.queue(createQueueBatch(emitted.splice(0), now).batch);
      expect(queueResult.completed).toBeGreaterThanOrEqual(1);

      const crState = await getChangeRequestStateRpc(
        app,
        { apiKey: readKey.key },
        submitted.changeRequest!.id,
      );
      expect(crState.status).toBe("approved");

      const after = await readMedia(app, readKey.key, "tmdb:movie:24428");
      expect(after.status).toBe(200);
      const tmdbId = { namespace: "tmdb", nativeId: "movie:24428" };
      if (imdb === "foreign") {
        expect(after.document?.media.id).not.toBe(seededMedia.id);
        expect(after.document?.externalIds).toEqual([tmdbId]);
      } else if (imdb === "locked") {
        expect(after.document?.externalIds).toEqual([
          { namespace: "imdb", nativeId: "tt0000001", locked: true },
          tmdbId,
        ]);
      } else {
        expect(after.document?.externalIds).toEqual([
          { namespace: "imdb", nativeId: "tt0848228" },
          tmdbId,
          { namespace: "trakt", nativeId: "movie:727" },
        ]);
      }
      expect(
        await testDb.readDb
          .selectFrom("demands")
          .select("id")
          .where("external_key", "=", "imdb:tt0848228")
          .execute(),
      ).toEqual(imdb === "missing" ? [] : [imdbDemand]);
    } finally {
      DOUBAN_API.apiKey = prevDouban.apiKey;
      DOUBAN_API.minIntervalMs = prevDouban.minIntervalMs;
      DOUBAN_API.retryDelayMs = prevDouban.retryDelayMs;
    }
  });

  describe("staying under the queue invocation wall clock (#156)", () => {
    const tmdbConfig = { accessToken: "test-tmdb-token", traktClientId: "test-trakt-client" };
    const staleUpdatedAt = new Date("2026-01-01T00:00:00.000Z");

    // movie:200 has a stale title and no Trakt ID yet; movie:100 is stored exactly as TMDB and
    // Trakt return it. Both are in yesterday's /movie/changes. Fixed ids make movie:200 go first.
    async function seedTwoChangedMovies(testDb: TestDbHandle) {
      const [current, stale] = await testDb.writeDb
        .insertInto("media")
        .values([
          {
            id: "00000000-0000-4000-8000-000000000002",
            type: "movie",
            baseline: "tmdb",
            title: "现行片",
            original_title: "Current Film",
            year: 2001,
            seasons: "[]",
            updated_at: staleUpdatedAt,
          },
          {
            id: "00000000-0000-4000-8000-000000000001",
            type: "movie",
            baseline: "tmdb",
            title: "旧标题",
            original_title: "Stale Film",
            year: 2002,
            seasons: "[]",
            updated_at: staleUpdatedAt,
          },
        ])
        .returning("id")
        .execute();
      await testDb.writeDb
        .insertInto("associations")
        .values(
          [
            [current!.id, "tmdb", "movie:100"],
            [current!.id, "imdb", "tt0000100"],
            [current!.id, "trakt", "movie:1"],
            [stale!.id, "tmdb", "movie:200"],
          ].map(([media_id, namespace, native_id]) => ({
            status: "confirmed" as const,
            is_external_id: true,
            media_id: media_id!,
            namespace: namespace as "tmdb" | "imdb" | "trakt",
            native_id: native_id!,
            source: "sync" as const,
          })),
        )
        .execute();
      await testDb.writeDb
        .insertInto("sync_state")
        .values({ sync_key: TMDB_SYNC_KEY_MOVIE, last_synced_date: "2026-11-27" })
        .execute();
      return { currentId: current!.id, staleId: stale!.id };
    }

    function createTmdbOutbound(onDetail?: () => void) {
      const json = (request: ExternalHttpRequest, body: unknown): ExternalHttpResponse => ({
        status: 200,
        headers: { "content-type": "application/json" },
        url: request.url,
        body: JSON.stringify(body),
      });
      return createFakeOutboundClient({
        fetchExternal(request) {
          const url = new URL(request.url);
          if (url.pathname.endsWith("/movie/changes")) {
            return json(request, {
              page: 1,
              total_pages: 1,
              total_results: 2,
              results: [{ id: 100 }, { id: 200 }],
            });
          }
          if (url.pathname.endsWith("/tv/changes")) {
            return json(request, { page: 1, total_pages: 1, total_results: 0, results: [] });
          }
          if (url.pathname.endsWith("/movie/100")) {
            onDetail?.();
            return json(request, {
              id: 100,
              title: "现行片",
              original_title: "Current Film",
              release_date: "2001-05-01",
              external_ids: { imdb_id: "tt0000100" },
            });
          }
          if (url.pathname.endsWith("/movie/200")) {
            onDetail?.();
            return json(request, {
              id: 200,
              title: "新标题",
              original_title: "Stale Film",
              release_date: "2002-05-01",
              external_ids: { imdb_id: "tt0000200" },
            });
          }
          if (request.namespace === "trakt" && url.pathname.endsWith("/search/tmdb/100")) {
            return json(request, [{ type: "movie", movie: { ids: { trakt: 1, tmdb: 100 } } }]);
          }
          if (request.namespace === "trakt" && url.pathname.endsWith("/search/tmdb/200")) {
            return json(request, [{ type: "movie", movie: { ids: { trakt: 2, tmdb: 200 } } }]);
          }
          throw new Error(`Unexpected outbound request: ${request.url}`);
        },
      });
    }

    async function readMovie(testDb: TestDbHandle, id: string) {
      return testDb.readDb
        .selectFrom("media")
        .select(["title", "updated_at"])
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
    }

    test("an item already matching TMDB and Trakt skips its write", async () => {
      const testDb = await createTestDb();
      handles.push(testDb);
      const { currentId, staleId } = await seedTwoChangedMovies(testDb);
      const outbound = createTmdbOutbound();
      const now = new Date("2026-11-28T00:01:00.000Z");

      const result = await runTmdbDailySync(testDb.writeDb, outbound, { now, tmdbConfig });

      expect(result.transientErrors).toEqual([]);
      expect(result.deadlineReached).toBe(false);
      expect(result.movie).toMatchObject({ candidateCount: 2, refreshedCount: 2 });
      expect(result.movie.cursorAdvanced).toBe(true);
      // No write for the unchanged movie, so it doesn't move up in "recently updated" ordering.
      expect(await readMovie(testDb, currentId)).toEqual({
        title: "现行片",
        updated_at: staleUpdatedAt,
      });
      expect(await readMovie(testDb, staleId)).toEqual({ title: "新标题", updated_at: now });
      const staleExternalIds = await testDb.readDb
        .selectFrom("associations")
        .select(["namespace", "native_id"])
        .where("media_id", "=", staleId)
        .where("is_external_id", "=", true)
        .orderBy("namespace")
        .execute();
      expect(staleExternalIds).toEqual([
        { namespace: "imdb", native_id: "tt0000200" },
        { namespace: "tmdb", native_id: "movie:200" },
        { namespace: "trakt", native_id: "movie:2" },
      ]);
    });

    test("stops at its deadline and leaves the changed items it didn't reach for the retry", async () => {
      const testDb = await createTestDb();
      handles.push(testDb);
      const { currentId, staleId } = await seedTwoChangedMovies(testDb);
      const now = new Date("2026-11-28T00:01:00.000Z");

      // Past deadline: nothing is fetched beyond the tracked-media read.
      const idle = createTmdbOutbound();
      const expired = await runTmdbDailySync(testDb.writeDb, idle, {
        now,
        tmdbConfig,
        deadline: new Date(Date.now() - 1),
      });
      expect(expired.deadlineReached).toBe(true);
      expect(expired.movie).toMatchObject({ cursorAdvanced: false, deadlineReached: true });
      expect(expired.movie.lastSyncedDate).toBe("2026-11-27");
      expect(idle.httpRequests).toEqual([]);

      // The deadline passes while the first item is being fetched: that item is finished, and the
      // second goes on the retry list the way a failed item does.
      const realNow = Date.now();
      let details = 0;
      const outbound = createTmdbOutbound(() => {
        details += 1;
        vi.spyOn(Date, "now").mockReturnValue(realNow + 120_000);
      });
      try {
        const partial = await runTmdbDailySync(testDb.writeDb, outbound, {
          now,
          tmdbConfig,
          deadline: new Date(realNow + 60_000),
        });
        expect(partial.deadlineReached).toBe(true);
        expect(partial.transientErrors).toEqual([]);
        expect(partial.movie.cursorAdvanced).toBe(true);
        // No TV is tracked, so the TV half is a no-op with or without time left.
        expect(partial.tv.mode).toBe("noop_no_tracked_media");
        expect(details).toBe(1);
      } finally {
        vi.restoreAllMocks();
      }
      // The item in flight at the deadline (movie:200) was written; movie:100 was never fetched.
      expect(await readMovie(testDb, staleId)).toEqual({ title: "新标题", updated_at: now });
      expect(outbound.httpRequests.some((r) => r.url.includes("/movie/100"))).toBe(false);
      const afterPartial = await testDb.readDb
        .selectFrom("sync_state")
        .select("metadata")
        .where("sync_key", "=", TMDB_SYNC_KEY_MOVIE)
        .executeTakeFirstOrThrow();
      expect(afterPartial.metadata).toMatchObject({ retryTmdbIds: ["100"] });

      const resumed = await runTmdbDailySync(testDb.writeDb, createTmdbOutbound(), {
        now,
        tmdbConfig,
      });
      expect(resumed.deadlineReached).toBe(false);
      expect(resumed.movie.cursorAdvanced).toBe(true);
      expect(resumed.movie.lastSyncedDate).toBe("2026-11-28");
      expect((await readMovie(testDb, currentId)).updated_at).toEqual(staleUpdatedAt);
      expect((await readMovie(testDb, staleId)).title).toBe("新标题");
      const afterResume = await testDb.readDb
        .selectFrom("sync_state")
        .select("metadata")
        .where("sync_key", "=", TMDB_SYNC_KEY_MOVIE)
        .executeTakeFirstOrThrow();
      expect(afterResume.metadata).not.toHaveProperty("retryTmdbIds");
    });

    test("a full refresh cut off by the deadline resumes after the last item it finished", async () => {
      const testDb = await createTestDb();
      handles.push(testDb);
      const { currentId, staleId } = await seedTwoChangedMovies(testDb);
      // More than 14 days behind: full refresh of every tracked movie, one page.
      await testDb.writeDb
        .updateTable("sync_state")
        .set({ last_synced_date: "2026-11-01" })
        .where("sync_key", "=", TMDB_SYNC_KEY_MOVIE)
        .execute();
      const now = new Date("2026-11-28T00:01:00.000Z");

      const realNow = Date.now();
      try {
        const partial = await runTmdbDailySync(
          testDb.writeDb,
          createTmdbOutbound(() => {
            vi.spyOn(Date, "now").mockReturnValue(realNow + 120_000);
          }),
          { now, tmdbConfig, deadline: new Date(realNow + 60_000) },
        );
        expect(partial.movie).toMatchObject({
          mode: "full_refresh",
          cursorAdvanced: false,
          deadlineReached: true,
          lastSyncedDate: "2026-11-01",
        });
      } finally {
        vi.restoreAllMocks();
      }
      const midway = await testDb.readDb
        .selectFrom("sync_state")
        .select("metadata")
        .where("sync_key", "=", TMDB_SYNC_KEY_MOVIE)
        .executeTakeFirstOrThrow();
      expect(midway.metadata).toMatchObject({ fullRefreshAfterMediaId: staleId });

      const outbound = createTmdbOutbound();
      const resumed = await runTmdbDailySync(testDb.writeDb, outbound, { now, tmdbConfig });
      expect(resumed.movie).toMatchObject({ mode: "full_refresh", cursorAdvanced: true });
      expect(resumed.movie.lastSyncedDate).toBe("2026-11-28");
      // Only the item after the stop is refreshed on the second run.
      expect(outbound.httpRequests.some((r) => r.url.includes("/movie/200"))).toBe(false);
      expect((await readMovie(testDb, currentId)).updated_at).toEqual(staleUpdatedAt);
    });

    test("the job handler retries instead of completing when its time runs out", async () => {
      const testDb = await createTestDb();
      handles.push(testDb);
      await seedTwoChangedMovies(testDb);
      const handler = createTmdbSyncJobHandler({ tmdbConfig, maxDurationMs: 0 });

      const outcome = await handler({
        db: testDb.writeDb,
        outbound: createTmdbOutbound(),
        job: {
          id: "00000000-0000-0000-0000-000000000156",
          jobType: "tmdb_sync",
          leaseGeneration: 1,
          payload: { syncDate: "2026-11-28" },
          leaseExpiresAt: null,
        },
        now: new Date("2026-11-28T00:01:00.000Z"),
      });

      expect(outcome).toEqual({
        status: "retry",
        errorMessage: "tmdb_sync stopped at its deadline",
      });
    });
  });
});
