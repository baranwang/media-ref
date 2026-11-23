import type { Message, MessageBatch, ScheduledController } from "@cloudflare/workers-types";
import { createApiApp } from "@media-ref/api/app";
import type { MediaDocument } from "@media-ref/client";
import {
  createFakeOutboundClient,
  importBangumiDataSeeds,
  importWikidataMovieSeeds,
  SEED_EVIDENCE_CHECK_JOB_TYPE,
  SEED_EVIDENCE_FAILED_ALERT_TYPE,
  type EmailMessage,
  type ExternalHttpRequest,
  type ExternalHttpResponse,
  type JobQueueMessage,
} from "@media-ref/core";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { createBackgroundWorker } from "../src/index.ts";

const TEST_BASE_URL = "https://api.mediaref.org";
const TEST_AUTH_SECRET = "test-secret-for-seed-evidence-check-e2e-tests-0123456789abcdef";

function jsonResponse(url: string, payload: unknown, status = 200): ExternalHttpResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
    url,
  };
}

function makeBilibiliEpisodes(count: number) {
  const episodes: Array<Record<string, unknown>> = [];
  for (let i = 1; i <= count; i += 1) {
    episodes.push({
      id: 455700 + i,
      title: String(i),
      long_title: `第${i}话`,
      badge: i > 1 ? "会员" : "",
      badge_type: 0,
      section_type: 0,
      duration: 1435000,
    });
  }
  return episodes;
}

function extractCookieHeader(response: Response): string {
  const setCookies = response.headers.getSetCookie();
  return setCookies
    .map((entry) => entry.split(";")[0]?.trim())
    .filter((pair): pair is string => Boolean(pair))
    .join("; ");
}

function extractVerificationUrl(email: EmailMessage): string {
  const match = email.text.match(/https?:\/\/\S+\/api\/auth\/verify-email\?\S+/);
  if (!match) {
    throw new Error(`No verification URL found in email text: ${email.text}`);
  }
  return match[0];
}

async function createReadApiKey(
  app: ReturnType<typeof createApiApp>,
  outbound: ReturnType<typeof createFakeOutboundClient>,
  email: string,
): Promise<string> {
  const emailsBefore = outbound.sentEmails.length;
  const signUpRes = await app.fetch(
    new Request(`${TEST_BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        password: "StrongPassword123!",
        name: "Seed Tester",
      }),
    }),
  );
  expect(signUpRes.status).toBe(200);
  let cookie = extractCookieHeader(signUpRes);

  const verificationEmail = outbound.sentEmails[emailsBefore];
  expect(verificationEmail).toBeDefined();
  const verifyRes = await app.fetch(
    new Request(extractVerificationUrl(verificationEmail!), {
      method: "GET",
      headers: { cookie },
    }),
  );
  expect([200, 302]).toContain(verifyRes.status);
  const refreshed = extractCookieHeader(verifyRes);
  if (refreshed) {
    cookie = refreshed;
  }

  const keyRes = await app.fetch(
    new Request(`${TEST_BASE_URL}/v1/api-keys`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Seed Read Key", canSubmit: false }),
    }),
  );
  expect(keyRes.status).toBe(201);
  const keyBody = (await keyRes.json()) as { key: string };
  return keyBody.key;
}

function createScheduledController(scheduledTime: Date): ScheduledController {
  return {
    scheduledTime: scheduledTime.getTime(),
    cron: "* * * * *",
    noRetry() {},
  };
}

function createQueueBatch(bodies: JobQueueMessage[], timestamp: Date = new Date()) {
  const tracked = bodies.map((body, index) => {
    const entry = {
      acked: false,
      retried: false,
      message: {
        id: `seed-msg-${index + 1}-${body.jobId}-gen-${body.leaseGeneration}`,
        timestamp,
        body,
        attempts: 1,
        ack() {
          entry.acked = true;
        },
        retry() {
          entry.retried = true;
        },
      } as Message<JobQueueMessage>,
    };
    return entry;
  });

  const batch: MessageBatch<JobQueueMessage> = {
    queue: "media-ref-jobs",
    messages: tracked.map((entry) => entry.message),
    metadata: { metrics: { backlogCount: tracked.length, backlogBytes: 0 } },
    ackAll() {
      for (const entry of tracked) {
        entry.acked = true;
      }
    },
    retryAll() {
      for (const entry of tracked) {
        entry.retried = true;
      }
    },
  };

  return { batch, tracked };
}

describe("seed first-read evidence check end-to-end (#32)", () => {
  const handles: TestDbHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop();
      if (handle) {
        await handle.cleanup();
      }
    }
  });

  async function setupDb(): Promise<TestDbHandle> {
    const handle = await createTestDb();
    handles.push(handle);
    return handle;
  }

  test("seed_unconfirmed is hidden on default GET, visible on ?includeUnconfirmed=true, first read enqueues one seed_evidence_check without consuming exploration budget, and passing Evidence Gate upgrades it to confirmed", async () => {
    const testDb = await setupDb();
    let currentTime = new Date("2026-11-24T04:00:00.000Z");

    await importWikidataMovieSeeds(
      testDb.writeDb,
      [
        {
          P4947: "278",
          P4529: "1292052",
          title: "tmdb:movie:278",
        },
      ],
      { now: currentTime },
    );

    const outbound = createFakeOutboundClient({
      fetchExternal: async (req: ExternalHttpRequest) => {
        if (req.namespace === "tmdb" && req.url.includes("/movie/278")) {
          return jsonResponse(req.url, {
            id: 278,
            title: "肖申克的救赎",
            original_title: "The Shawshank Redemption",
            release_date: "1994-09-23",
            external_ids: { imdb_id: "tt0111161" },
          });
        }
        if (req.namespace === "douban" && req.url.endsWith("/1292052")) {
          return jsonResponse(req.url, {
            id: "1292052",
            title: "肖申克的救赎",
            original_title: "The Shawshank Redemption",
            year: "1994",
            type: "movie",
            is_tv: false,
            episodes_count: 0,
          });
        }
        return jsonResponse(req.url, { error: "not_found" }, 404);
      },
    });

    const bgTasks: Promise<unknown>[] = [];
    const bgErrors: unknown[] = [];
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      onBackgroundTask: (p) => {
        bgTasks.push(p);
      },
      onBackgroundTaskError: (err) => {
        bgErrors.push(err);
      },
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => currentTime,
      },
    });

    const readKey = await createReadApiKey(app, outbound, "seed-e2e-1@example.com");

    // 1. Default GET hides seed_unconfirmed association
    const firstRead = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:movie:278`, {
        headers: { "x-api-key": readKey },
      }),
    );
    expect(firstRead.status).toBe(200);
    const firstBody = (await firstRead.json()) as { document: MediaDocument };
    expect(firstBody.document.associations).toEqual([]);

    await Promise.all(bgTasks.splice(0));
    expect(bgErrors).toEqual([]);

    // Verify exactly 1 seed_evidence_check job was enqueued and exploration budget is untouched
    const jobsAfterFirstRead = await testDb.writeDb
      .selectFrom("background_jobs")
      .selectAll()
      .where("job_type", "=", SEED_EVIDENCE_CHECK_JOB_TYPE)
      .execute();
    expect(jobsAfterFirstRead).toHaveLength(1);
    expect(jobsAfterFirstRead[0]?.status).toBe("pending");

    const budgetBefore = await testDb.writeDb
      .selectFrom("exploration_daily_budget")
      .selectAll()
      .execute();
    expect(budgetBefore).toHaveLength(0);

    // 2. ?includeUnconfirmed=true returns seed_unconfirmed with unconfirmed marker and does NOT duplicate job
    const unconfirmedRead = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:movie:278?includeUnconfirmed=true`, {
        headers: { "x-api-key": readKey },
      }),
    );
    expect(unconfirmedRead.status).toBe(200);
    const unconfirmedBody = (await unconfirmedRead.json()) as { document: MediaDocument };
    expect(unconfirmedBody.document.associations).toHaveLength(1);
    expect(unconfirmedBody.document.associations[0]).toMatchObject({
      namespace: "douban",
      nativeId: "1292052",
      status: "seed_unconfirmed",
      unconfirmed: true,
      unconfirmedSource: "seed_unconfirmed",
    });

    await Promise.all(bgTasks.splice(0));
    const jobsAfterSecondRead = await testDb.writeDb
      .selectFrom("background_jobs")
      .selectAll()
      .where("job_type", "=", SEED_EVIDENCE_CHECK_JOB_TYPE)
      .execute();
    expect(jobsAfterSecondRead).toHaveLength(1);

    // 3. Background Worker scheduled + queue runs Evidence Gate -> upgrades to confirmed + refreshes media
    const dispatched: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      queue: {
        async send(msg) {
          dispatched.push(msg);
        },
      },
      config: {
        enableDailyTmdbSync: false,
        enableExplorationScheduling: false,
        jobTypes: [SEED_EVIDENCE_CHECK_JOB_TYPE],
      },
      now: () => currentTime,
    });

    const sched = await worker.scheduled(createScheduledController(currentTime));
    expect(sched.claimed).toBe(1);
    expect(sched.dispatched).toBe(1);

    const { batch, tracked } = createQueueBatch(dispatched, currentTime);
    const queueSummary = await worker.queue(batch);
    expect(queueSummary.completed).toBe(1);
    expect(tracked.every((t) => t.acked)).toBe(true);

    // Exploration daily budget must STILL be untouched
    const budgetAfter = await testDb.writeDb
      .selectFrom("exploration_daily_budget")
      .selectAll()
      .execute();
    expect(budgetAfter).toHaveLength(0);

    // 4. Subsequent default GET returns confirmed association & refreshed TMDB metadata/IMDb external ID!
    const confirmedRead = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:movie:278`, {
        headers: { "x-api-key": readKey },
      }),
    );
    expect(confirmedRead.status).toBe(200);
    const confirmedBody = (await confirmedRead.json()) as { document: MediaDocument };
    expect(confirmedBody.document.media.snapshot.title).toBe("肖申克的救赎");
    expect(confirmedBody.document.media.snapshot.originalTitle).toBe("The Shawshank Redemption");
    expect(confirmedBody.document.media.snapshot.year).toBe(1994);
    expect(confirmedBody.document.externalIds).toEqual(
      expect.arrayContaining([
        { namespace: "tmdb", nativeId: "movie:278" },
        { namespace: "imdb", nativeId: "tt0111161" },
      ]),
    );
    expect(confirmedBody.document.associations).toHaveLength(1);
    expect(confirmedBody.document.associations[0]).toMatchObject({
      namespace: "douban",
      nativeId: "1292052",
      status: "confirmed",
    });
    expect(confirmedBody.document.associations[0]?.unconfirmed).toBeUndefined();

    // Reverse lookup by douban:1292052 now succeeds by default too
    const reverseRead = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/douban:1292052`, {
        headers: { "x-api-key": readKey },
      }),
    );
    expect(reverseRead.status).toBe(200);

    // Verify revision history preserved seed_unconfirmed (rev 1) -> confirmed (rev 2)
    const revisions = await testDb.writeDb
      .selectFrom("association_revisions")
      .select(["revision_number", "status", "reason"])
      .orderBy("revision_number", "asc")
      .execute();
    expect(revisions).toEqual([
      { revision_number: 1, status: "seed_unconfirmed", reason: "seed_import:wikidata" },
      { revision_number: 2, status: "confirmed", reason: "seed_evidence_gate_passed" },
    ]);
  });

  test("POST /v1/media/batch triggers seed_evidence_check for bangumi-data TV season seeds and verifies Step 2 segments", async () => {
    const testDb = await setupDb();
    const now = new Date("2026-11-24T05:00:00.000Z");

    const outbound = createFakeOutboundClient({
      fetchExternal: async (req: ExternalHttpRequest) => {
        if (req.namespace === "bilibili" && req.url.includes("media_id=28229884")) {
          return jsonResponse(req.url, { code: 0, result: { media: { season_id: 45574 } } });
        }
        if (req.namespace === "tmdb" && req.url.includes("/tv/62564")) {
          return jsonResponse(req.url, {
            id: 62564,
            name: "吹响！上低音号",
            original_name: "響け！ユーフォニアム",
            first_air_date: "2015-04-08",
            seasons: [
              { season_number: 1, episode_count: 13, air_date: "2015-04-08" },
              { season_number: 2, episode_count: 13, air_date: "2016-10-06" },
              { season_number: 3, episode_count: 13, air_date: "2024-04-07" },
            ],
            external_ids: { imdb_id: "tt4654236" },
          });
        }
        if (req.namespace === "bangumi" && req.url.includes("/v0/subjects/385641")) {
          return jsonResponse(req.url, {
            id: 385641,
            type: 2,
            name: "響け！ユーフォニアム3",
            name_cn: "吹响！上低音号 第三季",
            date: "2024-04-07",
            platform: "TV",
            eps: 13,
            infobox: [{ key: "别名", value: [{ v: "吹响！上低音号" }] }],
          });
        }
        if (req.namespace === "bilibili" && req.url.includes("season_id=45574")) {
          return jsonResponse(req.url, {
            code: 0,
            result: {
              season_id: 45574,
              title: "吹响！上低音号 第三季",
              jp_title: "響け！ユーフォニアム",
              type: 1,
              publish: { pub_time: "2024-04-07 20:00:00" },
              episodes: makeBilibiliEpisodes(13),
            },
          });
        }
        return jsonResponse(req.url, { error: "not_found" }, 404);
      },
    });

    await importBangumiDataSeeds(
      testDb.writeDb,
      {
        items: [
          {
            title: "響け！ユーフォニアム3",
            titleTranslate: { "zh-Hans": ["吹响！上低音号 第三季"] },
            type: "tv",
            begin: "2024-04-07T08:00:00.000Z",
            sites: [
              { site: "tmdb", id: "tv/62564/season/3" },
              { site: "bangumi", id: "385641" },
              { site: "bilibili", id: "28229884" },
            ],
          },
        ],
      },
      { outbound, now },
    );

    const bgTasks: Promise<unknown>[] = [];
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      onBackgroundTask: (p) => {
        bgTasks.push(p);
      },
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => now,
      },
    });
    const readKey = await createReadApiKey(app, outbound, "seed-e2e-2@example.com");

    const batchRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/batch`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": readKey },
        body: JSON.stringify({ keys: ["tmdb:tv:62564"] }),
      }),
    );
    expect(batchRes.status).toBe(200);
    const batchBody = (await batchRes.json()) as {
      results: Array<{ ok: boolean; items?: Array<{ document: MediaDocument }> }>;
    };
    expect(batchBody.results[0]?.ok).toBe(true);
    expect(batchBody.results[0]?.items?.[0]?.document.associations).toEqual([]);

    await Promise.all(bgTasks.splice(0));

    const dispatched: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      queue: {
        async send(msg) {
          dispatched.push(msg);
        },
      },
      config: {
        enableDailyTmdbSync: false,
        enableExplorationScheduling: false,
        jobTypes: [SEED_EVIDENCE_CHECK_JOB_TYPE],
      },
      now: () => now,
    });

    const sched = await worker.scheduled(createScheduledController(now));
    expect(sched.claimed).toBe(2);
    const { batch } = createQueueBatch(dispatched, now);
    const queueSummary = await worker.queue(batch);
    expect(queueSummary.completed).toBe(2);

    const readAfter = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:62564`, {
        headers: { "x-api-key": readKey },
      }),
    );
    expect(readAfter.status).toBe(200);
    const afterBody = (await readAfter.json()) as { document: MediaDocument };
    expect(afterBody.document.associations).toHaveLength(2);
    expect(afterBody.document.associations.every((a) => a.status === "confirmed")).toBe(true);
    expect(afterBody.document.platformStatuses?.bilibili?.status).toBe("associated");
    expect(afterBody.document.media.snapshot.seasons).toHaveLength(3);
  });

  test("seed failing Evidence Gate stays hidden from default read, opens seed_evidence_failed review alert, and subsequent reads do not spam new jobs", async () => {
    const testDb = await setupDb();
    const now = new Date("2026-11-24T06:00:00.000Z");

    await importWikidataMovieSeeds(
      testDb.writeDb,
      [{ P4947: "550", P4529: "9990001", title: "搏击俱乐部" }],
      { now },
    );

    const outbound = createFakeOutboundClient({
      fetchExternal: async (req: ExternalHttpRequest) => {
        if (req.namespace === "tmdb" && req.url.includes("/movie/550")) {
          return jsonResponse(req.url, {
            id: 550,
            title: "搏击俱乐部",
            original_title: "Fight Club",
            release_date: "1999-10-15",
            external_ids: { imdb_id: "tt0137523" },
          });
        }
        // Wrong movie on Douban -> Step 1 fails!
        if (req.namespace === "douban" && req.url.endsWith("/9990001")) {
          return jsonResponse(req.url, {
            id: "9990001",
            title: "完全不同的电影",
            original_title: "Completely Different Film",
            year: "2018",
            type: "movie",
            is_tv: false,
            episodes_count: 0,
          });
        }
        return jsonResponse(req.url, { error: "not_found" }, 404);
      },
    });

    const bgTasks: Promise<unknown>[] = [];
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      onBackgroundTask: (p) => {
        bgTasks.push(p);
      },
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => now,
      },
    });
    const readKey = await createReadApiKey(app, outbound, "seed-e2e-3@example.com");

    // First read triggers check
    await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:movie:550`, {
        headers: { "x-api-key": readKey },
      }),
    );
    await Promise.all(bgTasks.splice(0));

    const dispatched: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      queue: {
        async send(msg) {
          dispatched.push(msg);
        },
      },
      config: {
        enableDailyTmdbSync: false,
        enableExplorationScheduling: false,
        jobTypes: [SEED_EVIDENCE_CHECK_JOB_TYPE],
      },
      now: () => now,
    });

    await worker.scheduled(createScheduledController(now));
    const { batch } = createQueueBatch(dispatched, now);
    const queueSummary = await worker.queue(batch);
    expect(queueSummary.completed).toBe(1);

    // Association must stay seed_unconfirmed with needs_review=true and stay OUT of default read
    const assoc = await testDb.writeDb
      .selectFrom("associations")
      .selectAll()
      .where("native_id", "=", "9990001")
      .executeTakeFirstOrThrow();
    expect(assoc.status).toBe("seed_unconfirmed");
    expect(assoc.needs_review).toBe(true);

    // Open review_alerts row created for reviewers
    const alerts = await testDb.writeDb
      .selectFrom("review_alerts")
      .selectAll()
      .where("alert_type", "=", SEED_EVIDENCE_FAILED_ALERT_TYPE)
      .where("association_id", "=", assoc.id)
      .execute();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.status).toBe("open");

    // Subsequent default read still hides it AND does NOT create a second job!
    const secondRead = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:movie:550`, {
        headers: { "x-api-key": readKey },
      }),
    );
    expect(secondRead.status).toBe(200);
    const secondBody = (await secondRead.json()) as { document: MediaDocument };
    expect(secondBody.document.associations).toEqual([]);

    await Promise.all(bgTasks.splice(0));
    const totalJobs = await testDb.writeDb
      .selectFrom("background_jobs")
      .selectAll()
      .where("job_type", "=", SEED_EVIDENCE_CHECK_JOB_TYPE)
      .execute();
    expect(totalJobs).toHaveLength(1);
  });

  test("bangumi-data TV season seed failing Step 2 (wrong season year/episode count) stays unconfirmed and opens review alert", async () => {
    const testDb = await setupDb();
    const now = new Date("2026-11-24T06:30:00.000Z");

    const outbound = createFakeOutboundClient({
      fetchExternal: async (req: ExternalHttpRequest) => {
        if (req.namespace === "tmdb" && req.url.includes("/tv/95479")) {
          return jsonResponse(req.url, {
            id: 95479,
            name: "咒术回战",
            original_name: "呪術廻戦",
            first_air_date: "2020-10-03",
            seasons: [
              { season_number: 1, episode_count: 24, air_date: "2020-10-03" },
              { season_number: 2, episode_count: 23, air_date: "2023-07-06" },
            ],
            external_ids: { imdb_id: "tt12343534" },
          });
        }
        // Bangumi subject has shared IMDb ID (passes Step 1!), but year=2020 & eps=24
        // while the seed tagged it as season 2 (which aired 2023 with 23 eps) -> Step 2 MUST FAIL!
        if (req.namespace === "bangumi" && req.url.includes("/v0/subjects/294993")) {
          return jsonResponse(req.url, {
            id: 294993,
            type: 2,
            name: "呪術廻戦",
            name_cn: "咒术回战",
            date: "2020-10-03",
            platform: "TV",
            eps: 24,
            infobox: [{ key: "IMDb_id", value: "tt12343534" }],
          });
        }
        return jsonResponse(req.url, { error: "not_found" }, 404);
      },
    });

    await importBangumiDataSeeds(
      testDb.writeDb,
      {
        items: [
          {
            title: "呪術廻戦",
            type: "tv",
            begin: "2023-07-06T00:00:00.000Z",
            sites: [
              { site: "tmdb", id: "tv/95479/season/2" },
              { site: "bangumi", id: "294993" },
            ],
          },
        ],
      },
      { outbound, now },
    );

    const bgTasks: Promise<unknown>[] = [];
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      onBackgroundTask: (p) => {
        bgTasks.push(p);
      },
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => now,
      },
    });
    const readKey = await createReadApiKey(app, outbound, "seed-e2e-step2@example.com");

    await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:95479`, {
        headers: { "x-api-key": readKey },
      }),
    );
    await Promise.all(bgTasks.splice(0));

    const dispatched: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      queue: {
        async send(msg) {
          dispatched.push(msg);
        },
      },
      config: {
        enableDailyTmdbSync: false,
        enableExplorationScheduling: false,
        jobTypes: [SEED_EVIDENCE_CHECK_JOB_TYPE],
      },
      now: () => now,
    });

    await worker.scheduled(createScheduledController(now));
    const { batch } = createQueueBatch(dispatched, now);
    const queueSummary = await worker.queue(batch);
    expect(queueSummary.completed).toBe(1);

    const assoc = await testDb.writeDb
      .selectFrom("associations")
      .selectAll()
      .where("namespace", "=", "bangumi")
      .where("native_id", "=", "294993")
      .executeTakeFirstOrThrow();
    expect(assoc.status).toBe("seed_unconfirmed");
    expect(assoc.needs_review).toBe(true);

    const alerts = await testDb.writeDb
      .selectFrom("review_alerts")
      .selectAll()
      .where("alert_type", "=", SEED_EVIDENCE_FAILED_ALERT_TYPE)
      .where("association_id", "=", assoc.id)
      .execute();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.status).toBe("open");

    // Remains absent from default read
    const readAfter = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:95479`, {
        headers: { "x-api-key": readKey },
      }),
    );
    expect(readAfter.status).toBe(200);
    const afterBody = (await readAfter.json()) as { document: MediaDocument };
    expect(afterBody.document.associations).toEqual([]);
  });

  test("transient upstream error retries cleanly without alerting and confirms on recovery", async () => {
    const testDb = await setupDb();
    let currentTime = new Date("2026-11-24T07:00:00.000Z");
    let doubanCallCount = 0;

    await importWikidataMovieSeeds(
      testDb.writeDb,
      [{ P4947: "155", P4529: "1851857", title: "蝙蝠侠：黑暗骑士" }],
      { now: currentTime },
    );

    const outbound = createFakeOutboundClient({
      fetchExternal: async (req: ExternalHttpRequest) => {
        if (req.namespace === "tmdb" && req.url.includes("/movie/155")) {
          return jsonResponse(req.url, {
            id: 155,
            title: "蝙蝠侠：黑暗骑士",
            original_title: "The Dark Knight",
            release_date: "2008-07-16",
            external_ids: { imdb_id: "tt0468569" },
          });
        }
        if (req.namespace === "douban" && req.url.endsWith("/1851857")) {
          doubanCallCount += 1;
          if (doubanCallCount === 1) {
            return jsonResponse(req.url, { error: "upstream_unavailable" }, 503);
          }
          return jsonResponse(req.url, {
            id: "1851857",
            title: "蝙蝠侠：黑暗骑士",
            original_title: "The Dark Knight",
            year: "2008",
            type: "movie",
            is_tv: false,
            episodes_count: 0,
          });
        }
        return jsonResponse(req.url, { error: "not_found" }, 404);
      },
    });

    const bgTasks: Promise<unknown>[] = [];
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      onBackgroundTask: (p) => {
        bgTasks.push(p);
      },
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => currentTime,
      },
    });
    const readKey = await createReadApiKey(app, outbound, "seed-e2e-4@example.com");

    // Reverse lookup on unconfirmed seed returns 404 AND triggers first-read seed_evidence_check
    const initialReverse = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/douban:1851857`, {
        headers: { "x-api-key": readKey },
      }),
    );
    expect(initialReverse.status).toBe(404);
    await Promise.all(bgTasks.splice(0));

    const dispatched: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      queue: {
        async send(msg) {
          dispatched.push(msg);
        },
      },
      config: {
        enableDailyTmdbSync: false,
        enableExplorationScheduling: false,
        defaultRetryDelayMs: 60_000,
        jobTypes: [SEED_EVIDENCE_CHECK_JOB_TYPE],
      },
      now: () => currentTime,
    });

    // Attempt 1: 503 transient error -> rescheduled, stays seed_unconfirmed, no alert
    await worker.scheduled(createScheduledController(currentTime));
    expect(dispatched).toHaveLength(1);
    const firstBatch = createQueueBatch(dispatched.splice(0), currentTime);
    const firstQueueSummary = await worker.queue(firstBatch.batch);
    expect(firstQueueSummary.rescheduled).toBe(1);

    const assocAfterTransient = await testDb.writeDb
      .selectFrom("associations")
      .selectAll()
      .where("native_id", "=", "1851857")
      .executeTakeFirstOrThrow();
    expect(assocAfterTransient.status).toBe("seed_unconfirmed");
    expect(assocAfterTransient.needs_review).toBe(false);

    const alertsAfterTransient = await testDb.writeDb
      .selectFrom("review_alerts")
      .selectAll()
      .execute();
    expect(alertsAfterTransient).toHaveLength(0);

    // Attempt 2 after retry delay -> succeeds and confirms!
    currentTime = new Date(currentTime.getTime() + 120_000);
    await worker.scheduled(createScheduledController(currentTime));
    expect(dispatched).toHaveLength(1);
    const secondBatch = createQueueBatch(dispatched.splice(0), currentTime);
    const secondQueueSummary = await worker.queue(secondBatch.batch);
    expect(secondQueueSummary.completed).toBe(1);

    const reverseAfterConfirm = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/douban:1851857`, {
        headers: { "x-api-key": readKey },
      }),
    );
    expect(reverseAfterConfirm.status).toBe(200);
  });

  test("default read does NOT leak empty variants created solely for seed_unconfirmed rows, while ?includeUnconfirmed=true exposes them and confirmation promotes them", async () => {
    const testDb = await setupDb();
    const now = new Date("2026-11-24T08:00:00.000Z");

    const outbound = createFakeOutboundClient({
      fetchExternal: async (req: ExternalHttpRequest) => {
        if (req.namespace === "tmdb" && req.url.includes("/tv/95479")) {
          return jsonResponse(req.url, {
            id: 95479,
            name: "咒术回战",
            original_name: "呪術廻戦",
            first_air_date: "2020-10-03",
            seasons: [{ season_number: 1, episode_count: 24, air_date: "2020-10-03" }],
            external_ids: { imdb_id: "tt12343534" },
          });
        }
        if (req.namespace === "bilibili" && req.url.includes("season_id=34430")) {
          return jsonResponse(req.url, {
            code: 0,
            message: "success",
            result: {
              season_id: 34430,
              title: "咒术回战",
              jp_title: "呪術廻戦",
              type: 1,
              publish: { pub_time: "2020-10-03 01:25:00" },
              episodes: makeBilibiliEpisodes(24),
            },
          });
        }
        return jsonResponse(req.url, { error: "not_found" }, 404);
      },
    });

    await importBangumiDataSeeds(
      testDb.writeDb,
      {
        items: [
          {
            title: "呪術廻戦",
            type: "tv",
            begin: "2020-10-03T00:00:00.000Z",
            sites: [
              { site: "tmdb", id: "tv/95479/season/1" },
              { site: "bilibili", id: "ss34430" },
            ],
          },
        ],
      },
      { outbound, now },
    );

    // Verify DB actually has a variant created for the platform seed_unconfirmed association
    const variantsInDb = await testDb.readDb.selectFrom("variants").selectAll().execute();
    expect(variantsInDb).toHaveLength(1);
    expect(variantsInDb[0]?.platform).toBe("bilibili");

    const bgTasks: Promise<unknown>[] = [];
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      onBackgroundTask: (p) => {
        bgTasks.push(p);
      },
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => now,
      },
    });
    const readKey = await createReadApiKey(app, outbound, "seed-variant-leak@example.com");

    // 1. Default read MUST NOT leak the empty variant created solely for seed_unconfirmed
    const defaultRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:95479`, {
        headers: { "x-api-key": readKey },
      }),
    );
    expect(defaultRes.status).toBe(200);
    const defaultBody = (await defaultRes.json()) as { document: MediaDocument };
    expect(defaultBody.document.associations).toEqual([]);
    expect(defaultBody.document.variants).toEqual([]);
    await Promise.all(bgTasks.splice(0));

    // 2. ?includeUnconfirmed=true MUST return both the variant and the seed_unconfirmed association
    const unconfirmedRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:95479?includeUnconfirmed=true`, {
        headers: { "x-api-key": readKey },
      }),
    );
    expect(unconfirmedRes.status).toBe(200);
    const unconfirmedBody = (await unconfirmedRes.json()) as { document: MediaDocument };
    expect(unconfirmedBody.document.associations).toHaveLength(1);
    expect(unconfirmedBody.document.associations[0]?.status).toBe("seed_unconfirmed");
    expect(unconfirmedBody.document.variants).toHaveLength(1);
    expect(unconfirmedBody.document.variants[0]?.id).toBe(variantsInDb[0]?.id);

    // 3. After seed_evidence_check promotes the association to confirmed, default read includes the variant
    const dispatched: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      queue: {
        async send(msg) {
          dispatched.push(msg);
        },
      },
      config: {
        enableDailyTmdbSync: false,
        enableExplorationScheduling: false,
        jobTypes: [SEED_EVIDENCE_CHECK_JOB_TYPE],
      },
      now: () => now,
    });
    await worker.scheduled(createScheduledController(now));
    expect(dispatched).toHaveLength(1);
    const { batch } = createQueueBatch(dispatched, now);
    const summary = await worker.queue(batch);
    expect(summary.completed).toBe(1);

    const confirmedRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:95479`, {
        headers: { "x-api-key": readKey },
      }),
    );
    expect(confirmedRes.status).toBe(200);
    const confirmedBody = (await confirmedRes.json()) as { document: MediaDocument };
    expect(confirmedBody.document.associations).toHaveLength(1);
    expect(confirmedBody.document.associations[0]?.status).toBe("confirmed");
    expect(confirmedBody.document.variants).toHaveLength(1);
    expect(confirmedBody.document.variants[0]?.id).toBe(variantsInDb[0]?.id);
  });
});
