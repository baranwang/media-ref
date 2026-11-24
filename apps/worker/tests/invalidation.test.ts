import type { Message, MessageBatch, ScheduledController } from "@cloudflare/workers-types";
import { createApiApp } from "@media-ref/api/app";
import type { SegmentInput } from "@media-ref/client";
import {
  createFakeOutboundClient,
  type ExternalHttpRequest,
  type ExternalHttpResponse,
  type JobQueueMessage,
} from "@media-ref/core";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { createBackgroundWorker } from "../src/index.ts";
import {
  createRpcClients,
  expectRpcError,
  fromProtoReviewAlertStatus,
  getMediaDocumentRpc,
  issueApiKeyRpc,
  mediaRef,
  signUpAndVerifyUser,
  TEST_BASE_URL,
  toProtoSegmentInput,
} from "./rpc-helpers.ts";

const TEST_AUTH_SECRET = "test-secret-for-invalidation-integration-tests-0123456789abcdef";

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
      id: 341200 + i,
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

async function setupVerifiedUser(
  app: ReturnType<typeof createApiApp>,
  outbound: ReturnType<typeof createFakeOutboundClient>,
  email: string,
) {
  return signUpAndVerifyUser(app, outbound, {
    email,
    name: "Tester",
  });
}

async function createUserApiKey(
  app: ReturnType<typeof createApiApp>,
  cookie: string,
  options: { name: string; canSubmit?: boolean },
) {
  return issueApiKeyRpc(app, cookie, options);
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
        id: `msg-${index + 1}-${body.jobId}-gen-${body.leaseGeneration}`,
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

async function runWorkerCycle(
  worker: ReturnType<typeof createBackgroundWorker>,
  dispatched: JobQueueMessage[],
  now: Date,
) {
  const scheduled = await worker.scheduled(createScheduledController(now));
  const messages = dispatched.splice(0, dispatched.length);
  if (messages.length === 0) {
    return {
      scheduled,
      queue: {
        processed: 0,
        completed: 0,
        discarded: 0,
        rescheduled: 0,
        failed: 0,
        retriedInQueue: 0,
      },
      messages,
    };
  }
  const { batch, tracked } = createQueueBatch(messages, now);
  const queue = await worker.queue(batch);
  for (const item of tracked) {
    expect(item.acked).toBe(true);
    expect(item.retried).toBe(false);
  }
  return { scheduled, queue, messages };
}

function createDefaultTmdbAndBilibiliHandler(
  bilibiliOverride?: (request: ExternalHttpRequest) => ExternalHttpResponse | null,
) {
  return (request: ExternalHttpRequest): ExternalHttpResponse => {
    if (request.kind === "catalog" && request.namespace === "tmdb") {
      if (request.url.includes("/tv/95479")) {
        return jsonResponse(request.url, {
          id: 95479,
          name: "咒术回战",
          original_name: "呪術廻戦",
          first_air_date: "2020-10-03",
          seasons: [
            { season_number: 0, episode_count: 5, air_date: "2020-12-26" },
            { season_number: 1, episode_count: 24, air_date: "2020-10-03" },
          ],
          external_ids: {
            imdb_id: "tt12343534",
            tvdb_id: 377543,
          },
        });
      }
      return jsonResponse(request.url, { status_code: 34, status_message: "Not found" }, 404);
    }

    if (request.kind === "catalog" && request.namespace === "trakt") {
      return jsonResponse(request.url, []);
    }

    if (request.kind === "platform" && request.namespace === "bilibili") {
      if (bilibiliOverride) {
        const overridden = bilibiliOverride(request);
        if (overridden) {
          return overridden;
        }
      }

      if (request.url.includes("season_id=34430")) {
        return jsonResponse(request.url, {
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

      if (request.url.includes("season_id=34431")) {
        return jsonResponse(request.url, {
          code: 0,
          message: "success",
          result: {
            season_id: 34431,
            title: "咒术回战（中配）",
            jp_title: "呪術廻戦",
            type: 1,
            publish: { pub_time: "2020-10-03 01:25:00" },
            episodes: makeBilibiliEpisodes(24),
          },
        });
      }
    }

    throw new Error(
      `Unexpected outbound request: ${request.kind}:${request.namespace} ${request.url}`,
    );
  };
}

async function createConfirmedBilibiliAssociation(input: {
  app: ReturnType<typeof createApiApp>;
  worker: ReturnType<typeof createBackgroundWorker>;
  dispatched: JobQueueMessage[];
  submitKey: string;
  readKey: string;
  now: Date;
  nativeId?: string;
  variantDescription?: string;
}) {
  const nativeId = input.nativeId ?? "ss34430";
  const variantDescription = input.variantDescription ?? "原声";

  await createRpcClients(input.app, {
    apiKey: input.submitKey,
  }).changeRequest.createChangeRequest({
    target: mediaRef("tmdb:tv:95479"),
    namespace: "bilibili",
    nativeId,
    variantDescription,
    segments: [
      toProtoSegmentInput({
        season: 1,
        episodeStart: 1,
        episodeEnd: 24,
        targetEpisodeStart: 1,
        baseline: "tmdb",
      }),
    ],
  });

  const cycle = await runWorkerCycle(input.worker, input.dispatched, input.now);
  expect(cycle.queue.completed).toBeGreaterThanOrEqual(1);

  const readBody = await getMediaDocumentRpc(input.app, input.readKey, "tmdb:tv:95479");
  const assoc = readBody.document.associations.find(
    (entry) => entry.namespace === "bilibili" && entry.nativeId === nativeId,
  );
  expect(assoc).toBeDefined();
  return {
    mediaId: readBody.document.media.id,
    associationId: assoc!.id,
    document: readBody.document,
  };
}

describe("Invalidation reports, re-check, and confirmed delisting (#20)", () => {
  const handles: TestDbHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop();
      if (handle) {
        await handle.cleanup();
      }
    }
  });

  test("logged-in user report immediately enqueues invalidation_recheck; anonymous API key reports deduplicate per key, require threshold, start fresh cycle after trigger, and reject revoked keys via dbWrite", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-23T18:00:00.000Z");
    const outbound = createFakeOutboundClient({
      fetchExternal: createDefaultTmdbAndBilibiliHandler(),
    });
    const dispatched: JobQueueMessage[] = [];

    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => t0,
        tmdb: { accessToken: "test-tmdb-token" },
        anonymousInvalidationThreshold: 3,
      },
    });

    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      queue: {
        async send(message) {
          dispatched.push(message);
        },
      },
      config: {
        enableDailyTmdbSync: false,
      },
      now: () => t0,
    });

    const user = await setupVerifiedUser(app, outbound, "invalidation-reporter@example.com");
    const submitKey = await createUserApiKey(app, user.cookie, {
      name: "Submit Key",
      canSubmit: true,
    });
    const key1 = await createUserApiKey(app, user.cookie, { name: "Read Key 1" });
    const key2 = await createUserApiKey(app, user.cookie, { name: "Read Key 2" });
    const key3 = await createUserApiKey(app, user.cookie, { name: "Read Key 3" });
    const revocableKey = await createUserApiKey(app, user.cookie, { name: "Revocable Key" });

    // Create two confirmed associations (two variants) to test user vs anonymous flows cleanly
    const assocUserFlow = await createConfirmedBilibiliAssociation({
      app,
      worker,
      dispatched,
      submitKey: submitKey.key,
      readKey: key1.key,
      now: t0,
      nativeId: "ss34430",
      variantDescription: "原声",
    });

    const assocAnonFlow = await createConfirmedBilibiliAssociation({
      app,
      worker,
      dispatched,
      submitKey: submitKey.key,
      readKey: key1.key,
      now: t0,
      nativeId: "ss34431",
      variantDescription: "中配",
    });

    // 1. Unauthenticated request is rejected with 401
    const unauthErr = await expectRpcError(
      createRpcClients(app).association.reportInvalidation({
        associationId: assocUserFlow.associationId,
        reason: "gone",
      }),
    );
    expect(unauthErr.status).toBe(401);

    const userRpc = createRpcClients(app, { cookie: user.cookie });

    // 2. Unknown association returns 404
    const missingErr = await expectRpcError(
      userRpc.association.reportInvalidation({
        associationId: "00000000-0000-4000-8000-000000000000",
      }),
    );
    expect(missingErr.status).toBe(404);

    // 3. Logged-in user report immediately enqueues an invalidation_recheck job
    const userReportBody = await userRpc.association.reportInvalidation({
      associationId: assocUserFlow.associationId,
      reason: "Page returns 404",
    });
    expect(userReportBody.triggered).toBe(true);
    expect(userReportBody.jobId).toBeTruthy();
    expect(userReportBody.reportCount).toBe(1);
    expect(userReportBody.threshold).toBe(1);

    const userJob = await testDb.readDb
      .selectFrom("background_jobs")
      .selectAll()
      .where("id", "=", userReportBody.jobId!)
      .executeTakeFirstOrThrow();
    expect(userJob.job_type).toBe("invalidation_recheck");
    expect(userJob.status).toBe("pending");
    expect(userJob.dedupe_key).toBe(`invalidation_recheck:${assocUserFlow.associationId}`);
    expect(userJob.payload).toEqual({ associationId: assocUserFlow.associationId });

    // 4. Revoked API key is immediately rejected with 401 via dbWrite
    const deleteKeyRes = await userRpc.account.deleteApiKey({ id: revocableKey.id });
    expect(deleteKeyRes.success).toBe(true);

    const revokedReportErr = await expectRpcError(
      createRpcClients(app, { apiKey: revocableKey.key }).association.reportInvalidation({
        associationId: assocAnonFlow.associationId,
      }),
    );
    expect(revokedReportErr.status).toBe(401);

    // 5. Anonymous API key reports with threshold = 3:
    const k1Rpc = createRpcClients(app, { apiKey: key1.key });
    const k2Rpc = createRpcClients(app, { apiKey: key2.key });
    const k3Rpc = createRpcClients(app, { apiKey: key3.key });

    // Key 1 report #1 -> count 1, NOT triggered
    const k1First = await k1Rpc.association.reportInvalidation({
      associationId: assocAnonFlow.associationId,
      reason: "video unavailable",
    });
    expect(k1First).toMatchObject({
      triggered: false,
      reportCount: 1,
      threshold: 3,
      deduplicated: false,
    });
    expect(k1First.jobId).toBeUndefined();

    // Key 1 report #2 (duplicate!) -> still count 1, NO job enqueued
    const k1Dup = await k1Rpc.association.reportInvalidation({
      associationId: assocAnonFlow.associationId,
      reason: "spam retry",
    });
    expect(k1Dup).toMatchObject({
      triggered: false,
      reportCount: 1,
      threshold: 3,
      deduplicated: true,
    });
    expect(k1Dup.jobId).toBeUndefined();

    // Key 2 report -> count 2, NO job enqueued
    const k2Res = await k2Rpc.association.reportInvalidation({
      associationId: assocAnonFlow.associationId,
    });
    expect(k2Res).toMatchObject({
      triggered: false,
      reportCount: 2,
      threshold: 3,
      deduplicated: false,
    });
    expect(k2Res.jobId).toBeUndefined();

    const jobsBeforeThreshold = await testDb.readDb
      .selectFrom("background_jobs")
      .select("id")
      .where("job_type", "=", "invalidation_recheck")
      .where("dedupe_key", "=", `invalidation_recheck:${assocAnonFlow.associationId}`)
      .execute();
    expect(jobsBeforeThreshold).toHaveLength(0);

    // Key 3 report -> count 3 -> triggers invalidation_recheck job and closes the open cycle!
    const k3Body = await k3Rpc.association.reportInvalidation({
      associationId: assocAnonFlow.associationId,
    });
    expect(k3Body.triggered).toBe(true);
    expect(k3Body.jobId).toBeTruthy();
    expect(k3Body.reportCount).toBe(3);
    expect(k3Body.threshold).toBe(3);
    expect(k3Body.deduplicated).toBe(false);

    const openReportsAfterTrigger = await testDb.readDb
      .selectFrom("invalidation_reports")
      .select(["id", "recheck_job_id"])
      .where("association_id", "=", assocAnonFlow.associationId)
      .execute();
    expect(openReportsAfterTrigger).toHaveLength(3);
    for (const row of openReportsAfterTrigger) {
      expect(row.recheck_job_id).toBe(k3Body.jobId);
    }

    // 6. Now that the cycle closed, Key 1 can open a fresh cycle (count = 1, not triggered)
    const k1NextCycle = await k1Rpc.association.reportInvalidation({
      associationId: assocAnonFlow.associationId,
    });
    expect(k1NextCycle).toMatchObject({
      triggered: false,
      reportCount: 1,
      threshold: 3,
      deduplicated: false,
    });
    expect(k1NextCycle.jobId).toBeUndefined();

    // 7. Reporting an already-delisted association returns 409
    await testDb.writeDb
      .updateTable("associations")
      .set({ status: "delisted" })
      .where("id", "=", assocAnonFlow.associationId)
      .execute();

    const delistedReportErr = await expectRpcError(
      userRpc.association.reportInvalidation({
        associationId: assocAnonFlow.associationId,
      }),
    );
    expect(delistedReportErr.status).toBe(409);
  });

  test("confirmed not_found delists sole association, removes it from default and includeUnconfirmed reads, preserves revision history, and transitions platformStatuses to not_found with checkedAt", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    let currentTime = new Date("2026-11-23T18:00:00.000Z");
    let ss34430Deleted = false;

    const outbound = createFakeOutboundClient({
      fetchExternal: createDefaultTmdbAndBilibiliHandler((request) => {
        if (ss34430Deleted && request.url.includes("season_id=34430")) {
          return jsonResponse(request.url, { code: -404, message: "啥都木有" });
        }
        return null;
      }),
    });
    const dispatched: JobQueueMessage[] = [];

    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => currentTime,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });

    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      queue: {
        async send(message) {
          dispatched.push(message);
        },
      },
      config: {
        enableDailyTmdbSync: false,
      },
      now: () => currentTime,
    });

    const user = await setupVerifiedUser(app, outbound, "delist-sole@example.com");
    const submitKey = await createUserApiKey(app, user.cookie, {
      name: "Submit Key",
      canSubmit: true,
    });
    const readKey = await createUserApiKey(app, user.cookie, { name: "Read Key" });

    const created = await createConfirmedBilibiliAssociation({
      app,
      worker,
      dispatched,
      submitKey: submitKey.key,
      readKey: readKey.key,
      now: currentTime,
      nativeId: "ss34430",
      variantDescription: "原声",
    });
    expect(created.document.platformStatuses?.bilibili).toEqual({ status: "associated" });

    // Platform removes ss34430 later, and logged-in user reports it
    currentTime = new Date("2026-11-23T20:15:00.000Z");
    ss34430Deleted = true;

    const reportBody = await createRpcClients(app, {
      cookie: user.cookie,
    }).association.reportInvalidation({
      associationId: created.associationId,
      reason: "Removed from Bilibili",
    });
    expect(reportBody.triggered).toBe(true);
    expect(reportBody.jobId).toBeTruthy();

    const cycle = await runWorkerCycle(worker, dispatched, currentTime);
    expect(cycle.scheduled.dispatched).toBe(1);
    expect(cycle.queue.completed).toBe(1);

    // Default read: association is gone and bilibili platformStatus is not_found with checkedAt
    const readDefault = await getMediaDocumentRpc(app, readKey.key, "tmdb:tv:95479");
    expect(readDefault.document.associations).toEqual([]);
    expect(readDefault.document.platformStatuses?.bilibili).toEqual({
      status: "not_found",
      checkedAt: "2026-11-23T20:15:00.000Z",
    });

    // includeUnconfirmed=true read: delisted association STILL must not appear
    const readUnconfirmed = await getMediaDocumentRpc(app, readKey.key, "tmdb:tv:95479", {
      includeUnconfirmed: true,
    });
    expect(readUnconfirmed.document.associations).toEqual([]);
    expect(readUnconfirmed.document.platformStatuses?.bilibili).toEqual({
      status: "not_found",
      checkedAt: "2026-11-23T20:15:00.000Z",
    });

    // Reverse lookup by delisted platform key returns 404 (default & includeUnconfirmed)
    const reverseDefaultErr = await expectRpcError(
      getMediaDocumentRpc(app, readKey.key, "bilibili:ss34430"),
    );
    expect(reverseDefaultErr.status).toBe(404);

    const reverseUnconfirmedErr = await expectRpcError(
      getMediaDocumentRpc(app, readKey.key, "bilibili:ss34430", { includeUnconfirmed: true }),
    );
    expect(reverseUnconfirmedErr.status).toBe(404);

    // Association revisions preserve full history and current_revision_id points to the delisted revision
    const assocRow = await testDb.readDb
      .selectFrom("associations")
      .select(["id", "status", "current_revision_id"])
      .where("id", "=", created.associationId)
      .executeTakeFirstOrThrow();
    expect(assocRow.status).toBe("delisted");

    const revisions = await testDb.readDb
      .selectFrom("association_revisions")
      .selectAll()
      .where("association_id", "=", created.associationId)
      .orderBy("revision_number", "asc")
      .execute();
    expect(revisions).toHaveLength(2);
    expect(revisions[0]).toMatchObject({
      revision_number: 1,
      status: "confirmed",
    });
    expect(revisions[1]).toMatchObject({
      revision_number: 2,
      status: "delisted",
      reason: "confirmed_delisted_by_recheck",
    });
    expect(assocRow.current_revision_id).toBe(revisions[1]!.id);
  });

  test("delisting one association when another confirmed association remains on the same platform keeps platformStatuses as associated", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    let currentTime = new Date("2026-11-23T18:00:00.000Z");
    let ss34430Deleted = false;

    const outbound = createFakeOutboundClient({
      fetchExternal: createDefaultTmdbAndBilibiliHandler((request) => {
        if (ss34430Deleted && request.url.includes("season_id=34430")) {
          return jsonResponse(request.url, { code: -404, message: "啥都木有" });
        }
        return null;
      }),
    });
    const dispatched: JobQueueMessage[] = [];

    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => currentTime,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });

    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      queue: {
        async send(message) {
          dispatched.push(message);
        },
      },
      config: {
        enableDailyTmdbSync: false,
      },
      now: () => currentTime,
    });

    const user = await setupVerifiedUser(app, outbound, "delist-multi@example.com");
    const submitKey = await createUserApiKey(app, user.cookie, {
      name: "Submit Key",
      canSubmit: true,
    });
    const readKey = await createUserApiKey(app, user.cookie, { name: "Read Key" });

    const assoc1 = await createConfirmedBilibiliAssociation({
      app,
      worker,
      dispatched,
      submitKey: submitKey.key,
      readKey: readKey.key,
      now: currentTime,
      nativeId: "ss34430",
      variantDescription: "原声",
    });

    const assoc2 = await createConfirmedBilibiliAssociation({
      app,
      worker,
      dispatched,
      submitKey: submitKey.key,
      readKey: readKey.key,
      now: currentTime,
      nativeId: "ss34431",
      variantDescription: "中配",
    });

    // Only ss34430 is removed; ss34431 remains active
    currentTime = new Date("2026-11-23T21:00:00.000Z");
    ss34430Deleted = true;

    await createRpcClients(app, { cookie: user.cookie }).association.reportInvalidation({
      associationId: assoc1.associationId,
    });

    const cycle = await runWorkerCycle(worker, dispatched, currentTime);
    expect(cycle.queue.completed).toBe(1);

    const readBody = await getMediaDocumentRpc(app, readKey.key, "tmdb:tv:95479");
    expect(readBody.document.associations.map((a) => a.id)).toEqual([assoc2.associationId]);
    expect(readBody.document.platformStatuses?.bilibili).toEqual({ status: "associated" });

    const platformChecks = await testDb.readDb
      .selectFrom("platform_checks")
      .selectAll()
      .where("media_id", "=", assoc1.mediaId)
      .where("platform", "=", "bilibili")
      .execute();
    expect(platformChecks).toHaveLength(0);
  });

  test("platform timeout and 5xx errors reschedule the re-check job and never delist the association", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    let currentTime = new Date("2026-11-23T18:00:00.000Z");
    let failureMode: "ok" | "timeout" | "http503" = "ok";

    const outbound = createFakeOutboundClient({
      fetchExternal: createDefaultTmdbAndBilibiliHandler((request) => {
        if (request.url.includes("season_id=34430")) {
          if (failureMode === "timeout") {
            throw new Error("Upstream request timed out after 10000ms");
          }
          if (failureMode === "http503") {
            return jsonResponse(request.url, { message: "Service Unavailable" }, 503);
          }
        }
        return null;
      }),
    });
    const dispatched: JobQueueMessage[] = [];

    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => currentTime,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });

    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      queue: {
        async send(message) {
          dispatched.push(message);
        },
      },
      config: {
        enableDailyTmdbSync: false,
        defaultRetryDelayMs: 60_000,
      },
      now: () => currentTime,
    });

    const user = await setupVerifiedUser(app, outbound, "timeout-case@example.com");
    const submitKey = await createUserApiKey(app, user.cookie, {
      name: "Submit Key",
      canSubmit: true,
    });
    const readKey = await createUserApiKey(app, user.cookie, { name: "Read Key" });

    const created = await createConfirmedBilibiliAssociation({
      app,
      worker,
      dispatched,
      submitKey: submitKey.key,
      readKey: readKey.key,
      now: currentTime,
      nativeId: "ss34430",
    });

    // Attempt 1: network timeout -> job reschedules, association stays confirmed
    currentTime = new Date("2026-11-23T19:00:00.000Z");
    failureMode = "timeout";

    const reportBody = await createRpcClients(app, {
      cookie: user.cookie,
    }).association.reportInvalidation({
      associationId: created.associationId,
    });

    const cycle1 = await runWorkerCycle(worker, dispatched, currentTime);
    expect(cycle1.queue.rescheduled).toBe(1);
    expect(cycle1.queue.completed).toBe(0);

    const jobAfterTimeout = await testDb.readDb
      .selectFrom("background_jobs")
      .selectAll()
      .where("id", "=", reportBody.jobId!)
      .executeTakeFirstOrThrow();
    expect(jobAfterTimeout.status).toBe("pending");
    expect(jobAfterTimeout.attempts).toBe(1);
    expect(jobAfterTimeout.run_after.getTime()).toBeGreaterThan(currentTime.getTime());
    expect(jobAfterTimeout.error_message).toContain("timed out");

    // Attempt 2: HTTP 503 -> job reschedules again, association STILL confirmed
    currentTime = new Date("2026-11-23T19:02:00.000Z");
    failureMode = "http503";

    const cycle2 = await runWorkerCycle(worker, dispatched, currentTime);
    expect(cycle2.queue.rescheduled).toBe(1);
    expect(cycle2.queue.completed).toBe(0);

    const jobAfter503 = await testDb.readDb
      .selectFrom("background_jobs")
      .selectAll()
      .where("id", "=", reportBody.jobId!)
      .executeTakeFirstOrThrow();
    expect(jobAfter503.status).toBe("pending");
    expect(jobAfter503.attempts).toBe(2);
    expect(jobAfter503.error_message).toContain("http_503");

    // Read API confirms association is still live and platformStatuses is still associated
    const readBody = await getMediaDocumentRpc(app, readKey.key, "tmdb:tv:95479");
    expect(readBody.document.associations.map((a) => a.id)).toEqual([created.associationId]);
    expect(readBody.document.platformStatuses?.bilibili).toEqual({ status: "associated" });

    const revisions = await testDb.readDb
      .selectFrom("association_revisions")
      .select("id")
      .where("association_id", "=", created.associationId)
      .execute();
    expect(revisions).toHaveLength(1);
  });

  test("locked association returning not_found is NOT auto-delisted and creates an open locked_association_delisted review alert", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    let currentTime = new Date("2026-11-23T18:00:00.000Z");
    let ss34430Deleted = false;

    const outbound = createFakeOutboundClient({
      fetchExternal: createDefaultTmdbAndBilibiliHandler((request) => {
        if (ss34430Deleted && request.url.includes("season_id=34430")) {
          return jsonResponse(request.url, { code: -404, message: "啥都木有" });
        }
        return null;
      }),
    });
    const dispatched: JobQueueMessage[] = [];

    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => currentTime,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });

    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      queue: {
        async send(message) {
          dispatched.push(message);
        },
      },
      config: {
        enableDailyTmdbSync: false,
      },
      now: () => currentTime,
    });

    const reviewer = await setupVerifiedUser(app, outbound, "locked-reviewer@example.com");
    await testDb.writeDb
      .updateTable("user")
      .set({ role: "reviewer" })
      .where("id", "=", reviewer.userId)
      .execute();

    const submitKey = await createUserApiKey(app, reviewer.cookie, {
      name: "Submit Key",
      canSubmit: true,
    });
    const readKey = await createUserApiKey(app, reviewer.cookie, { name: "Read Key" });

    const created = await createConfirmedBilibiliAssociation({
      app,
      worker,
      dispatched,
      submitKey: submitKey.key,
      readKey: readKey.key,
      now: currentTime,
      nativeId: "ss34430",
    });

    // Lock the association
    await testDb.writeDb
      .updateTable("associations")
      .set({ locked: true })
      .where("id", "=", created.associationId)
      .execute();

    currentTime = new Date("2026-11-23T20:00:00.000Z");
    ss34430Deleted = true;

    const reviewerRpc = createRpcClients(app, { cookie: reviewer.cookie });
    await reviewerRpc.association.reportInvalidation({
      associationId: created.associationId,
    });

    const cycle = await runWorkerCycle(worker, dispatched, currentTime);
    expect(cycle.queue.completed).toBe(1);

    // Association stays confirmed and visible in read API
    const readBody = await getMediaDocumentRpc(app, readKey.key, "tmdb:tv:95479");
    expect(readBody.document.associations).toHaveLength(1);
    expect(readBody.document.associations[0]).toMatchObject({
      id: created.associationId,
      status: "confirmed",
      locked: true,
    });
    expect(readBody.document.platformStatuses?.bilibili).toEqual({ status: "associated" });

    // Reviewer alert is created for triage
    const alertsBody = await reviewerRpc.reviewer.listReviewAlerts({
      alertType: "locked_association_delisted",
    });
    expect(alertsBody.total).toBe(1);
    expect(alertsBody.alerts[0]).toMatchObject({
      alertType: "locked_association_delisted",
      mediaId: created.mediaId,
      associationId: created.associationId,
      details: {
        reason: "platform_returned_not_found",
      },
    });
    expect(fromProtoReviewAlertStatus(alertsBody.alerts[0]!.status)).toBe("open");
  });

  test("page still exists: matching content leaves association untouched; mismatched content keeps association confirmed with needsReview=true and creates association_content_mismatch alert", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    let currentTime = new Date("2026-11-23T18:00:00.000Z");
    let contentChanged = false;

    const outbound = createFakeOutboundClient({
      fetchExternal: createDefaultTmdbAndBilibiliHandler((request) => {
        if (contentChanged && request.url.includes("season_id=34430")) {
          return jsonResponse(request.url, {
            code: 0,
            message: "success",
            result: {
              season_id: 34430,
              title: "完全不同的另一部番剧",
              jp_title: "別の作品",
              type: 1,
              publish: { pub_time: "2025-04-01 00:00:00" },
              episodes: makeBilibiliEpisodes(12),
            },
          });
        }
        return null;
      }),
    });
    const dispatched: JobQueueMessage[] = [];

    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => currentTime,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });

    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      queue: {
        async send(message) {
          dispatched.push(message);
        },
      },
      config: {
        enableDailyTmdbSync: false,
      },
      now: () => currentTime,
    });

    const reviewer = await setupVerifiedUser(app, outbound, "mismatch-reviewer@example.com");
    await testDb.writeDb
      .updateTable("user")
      .set({ role: "reviewer" })
      .where("id", "=", reviewer.userId)
      .execute();

    const submitKey = await createUserApiKey(app, reviewer.cookie, {
      name: "Submit Key",
      canSubmit: true,
    });
    const readKey = await createUserApiKey(app, reviewer.cookie, { name: "Read Key" });

    const created = await createConfirmedBilibiliAssociation({
      app,
      worker,
      dispatched,
      submitKey: submitKey.key,
      readKey: readKey.key,
      now: currentTime,
      nativeId: "ss34430",
    });

    // 1. False-alarm report while page still exists and matches catalog -> stays confirmed & clean
    const reviewerRpc = createRpcClients(app, { cookie: reviewer.cookie });
    currentTime = new Date("2026-11-23T19:00:00.000Z");
    await reviewerRpc.association.reportInvalidation({
      associationId: created.associationId,
    });

    const cycle1 = await runWorkerCycle(worker, dispatched, currentTime);
    expect(cycle1.queue.completed).toBe(1);

    const docAfterMatch = (await getMediaDocumentRpc(app, readKey.key, "tmdb:tv:95479")).document;
    expect(docAfterMatch.associations).toHaveLength(1);
    expect(docAfterMatch.associations[0]?.status).toBe("confirmed");
    expect(docAfterMatch.associations[0]?.needsReview).toBeUndefined();

    const alertsAfterMatch = await testDb.readDb.selectFrom("review_alerts").select("id").execute();
    expect(alertsAfterMatch).toHaveLength(0);

    // 2. Page still returns found, but content changed to a different media -> NOT delisted, needsReview=true, alert created
    currentTime = new Date("2026-11-23T21:00:00.000Z");
    contentChanged = true;

    await reviewerRpc.association.reportInvalidation({
      associationId: created.associationId,
    });

    const cycle2 = await runWorkerCycle(worker, dispatched, currentTime);
    expect(cycle2.queue.completed).toBe(1);

    const docAfterMismatch = (await getMediaDocumentRpc(app, readKey.key, "tmdb:tv:95479"))
      .document;
    expect(docAfterMismatch.associations).toHaveLength(1);
    expect(docAfterMismatch.associations[0]).toMatchObject({
      id: created.associationId,
      status: "confirmed",
      needsReview: true,
    });
    expect(docAfterMismatch.platformStatuses?.bilibili).toEqual({ status: "associated" });

    const mismatchAlertsBody = await reviewerRpc.reviewer.listReviewAlerts({
      alertType: "association_content_mismatch",
    });
    expect(mismatchAlertsBody.total).toBe(1);
    expect(mismatchAlertsBody.alerts[0]).toMatchObject({
      alertType: "association_content_mismatch",
      mediaId: created.mediaId,
      associationId: created.associationId,
    });
    expect(fromProtoReviewAlertStatus(mismatchAlertsBody.alerts[0]!.status)).toBe("open");
  });

  test("invalidation recheck loads association segments so valid split-season, open-ended ongoing, and nonLinear collections are NOT falsely flagged needs_review", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    let currentTime = new Date("2026-11-23T18:00:00.000Z");

    const outbound = createFakeOutboundClient({
      fetchExternal: (request) => {
        if (request.kind === "catalog" && request.namespace === "tmdb") {
          if (request.url.includes("/tv/95479")) {
            // TMDB S1 has 47 episodes; platform splits S1 into a 24-ep collection (part 1)
            return jsonResponse(request.url, {
              id: 95479,
              name: "咒术回战",
              original_name: "呪術廻戦",
              first_air_date: "2020-10-03",
              seasons: [{ season_number: 1, episode_count: 47, air_date: "2020-10-03" }],
              external_ids: { imdb_id: "tt12343534" },
            });
          }
          return jsonResponse(request.url, { status_code: 34 }, 404);
        }
        if (request.kind === "catalog" && request.namespace === "trakt") {
          return jsonResponse(request.url, []);
        }
        if (request.kind === "platform" && request.namespace === "bilibili") {
          if (request.url.includes("season_id=34430")) {
            return jsonResponse(request.url, {
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
          if (request.url.includes("season_id=34431")) {
            // Ongoing collection currently at 12 eps (open-ended segment episodeEnd: null)
            return jsonResponse(request.url, {
              code: 0,
              message: "success",
              result: {
                season_id: 34431,
                title: "咒术回战",
                jp_title: "呪術廻戦",
                type: 1,
                publish: { pub_time: "2020-10-03 01:25:00" },
                episodes: makeBilibiliEpisodes(12),
              },
            });
          }
          if (request.url.includes("season_id=34432")) {
            // Non-linear cut (e.g., 10 compiled episodes covering S1 E1-47 with nonLinear: true)
            return jsonResponse(request.url, {
              code: 0,
              message: "success",
              result: {
                season_id: 34432,
                title: "咒术回战",
                jp_title: "呪術廻戦",
                type: 1,
                publish: { pub_time: "2020-10-03 01:25:00" },
                episodes: makeBilibiliEpisodes(10),
              },
            });
          }
        }
        return jsonResponse(request.url, { error: "not_found" }, 404);
      },
    });
    const dispatched: JobQueueMessage[] = [];

    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => currentTime,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });

    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      queue: {
        async send(message) {
          dispatched.push(message);
        },
      },
      config: { enableDailyTmdbSync: false },
      now: () => currentTime,
    });

    const user = await setupVerifiedUser(app, outbound, "split-season-recheck@example.com");
    const submitKey = await createUserApiKey(app, user.cookie, {
      name: "Submit Key",
      canSubmit: true,
    });
    const readKey = await createUserApiKey(app, user.cookie, { name: "Read Key" });

    // Submit & confirm all 3 valid associations: split-season, open-ended ongoing, and nonLinear
    const submissions: Array<{
      nativeId: string;
      variantDescription: string;
      segments: SegmentInput[];
    }> = [
      {
        nativeId: "ss34430",
        variantDescription: "原声",
        segments: [
          { season: 1, episodeStart: 1, episodeEnd: 24, targetEpisodeStart: 1, baseline: "tmdb" },
        ],
      },
      {
        nativeId: "ss34431",
        variantDescription: "中配",
        segments: [
          { season: 1, episodeStart: 1, episodeEnd: null, targetEpisodeStart: 1, baseline: "tmdb" },
        ],
      },
      {
        nativeId: "ss34432",
        variantDescription: "剪辑版",
        segments: [
          {
            season: 1,
            episodeStart: 1,
            episodeEnd: 47,
            targetEpisodeStart: 1,
            baseline: "tmdb",
            nonLinear: true,
          },
        ],
      },
    ];

    const submitRpc = createRpcClients(app, { apiKey: submitKey.key });
    const userRpc = createRpcClients(app, { cookie: user.cookie });

    const assocIds: string[] = [];
    for (const sub of submissions) {
      await submitRpc.changeRequest.createChangeRequest({
        target: mediaRef("tmdb:tv:95479"),
        namespace: "bilibili",
        nativeId: sub.nativeId,
        variantDescription: sub.variantDescription,
        segments: sub.segments.map(toProtoSegmentInput),
      });
      const cycle = await runWorkerCycle(worker, dispatched, currentTime);
      expect(cycle.queue.completed).toBe(1);
    }

    const mediaBefore = await getMediaDocumentRpc(app, readKey.key, "tmdb:tv:95479");
    expect(mediaBefore.document.associations).toHaveLength(3);
    for (const assoc of mediaBefore.document.associations) {
      assocIds.push(assoc.id);
    }

    // Trigger invalidation recheck on every single one of the 3 associations
    currentTime = new Date("2026-11-23T19:30:00.000Z");
    for (const assocId of assocIds) {
      await userRpc.association.reportInvalidation({ associationId: assocId });
    }

    const recheckCycle = await runWorkerCycle(worker, dispatched, currentTime);
    expect(recheckCycle.queue.completed).toBe(3);

    // ALL 3 MUST remain confirmed with needsReview unset/false and ZERO mismatch alerts!
    const mediaAfter = await getMediaDocumentRpc(app, readKey.key, "tmdb:tv:95479");
    expect(mediaAfter.document.associations).toHaveLength(3);
    for (const assoc of mediaAfter.document.associations) {
      expect(assoc.status).toBe("confirmed");
      expect(assoc.needsReview).toBeUndefined();
    }

    const alerts = await testDb.readDb.selectFrom("review_alerts").selectAll().execute();
    expect(alerts).toHaveLength(0);
  });
});
