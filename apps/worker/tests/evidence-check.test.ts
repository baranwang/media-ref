import type { Message, MessageBatch, ScheduledController } from "@cloudflare/workers-types";
import { createApiApp } from "@media-ref/api/app";
import { resolveEpisode, type MediaDocument } from "@media-ref/client";
import {
  bilibiliAdapter,
  createAdapterRegistry,
  createFakeOutboundClient,
  createTier1Adapter,
  type EmailMessage,
  type ExternalHttpRequest,
  type ExternalHttpResponse,
  type JobQueueMessage,
  type Tier2Adapter,
} from "@media-ref/core";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { createBackgroundWorker } from "../src/index.ts";

const TEST_BASE_URL = "https://api.mediaref.org";
const TEST_AUTH_SECRET = "test-secret-for-evidence-check-integration-tests-0123456789abcdef";

function jsonResponse(url: string, payload: unknown, status = 200): ExternalHttpResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
    url,
  };
}

function makeBilibiliEpisodes(count: number, includeTrailers = true) {
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
  if (includeTrailers) {
    episodes.push({
      id: 990001,
      title: "预告",
      long_title: "下集预告",
      badge: "预告",
      badge_type: 1,
      section_type: 0,
      duration: 30000,
    });
    episodes.push({
      id: 990002,
      title: "PV",
      long_title: "正式PV",
      badge: "",
      badge_type: 0,
      section_type: 1,
      duration: 90000,
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

async function setupVerifiedUserAndKeys(
  app: ReturnType<typeof createApiApp>,
  outbound: ReturnType<typeof createFakeOutboundClient>,
  email: string,
) {
  const emailsBefore = outbound.sentEmails.length;
  const signUpRes = await app.fetch(
    new Request(`${TEST_BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        password: "StrongPassword123!",
        name: "Tester",
      }),
    }),
  );
  expect(signUpRes.status).toBe(200);
  const signUpBody = (await signUpRes.json()) as { user: { id: string } };
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

  const submitKeyRes = await app.fetch(
    new Request(`${TEST_BASE_URL}/v1/api-keys`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Submit Key", canSubmit: true }),
    }),
  );
  expect(submitKeyRes.status).toBe(201);
  const submitKey = (await submitKeyRes.json()) as { id: string; key: string };

  const readKeyRes = await app.fetch(
    new Request(`${TEST_BASE_URL}/v1/api-keys`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Read Key", canSubmit: false }),
    }),
  );
  expect(readKeyRes.status).toBe(201);
  const readKey = (await readKeyRes.json()) as { id: string; key: string };

  return {
    userId: signUpBody.user.id,
    cookie,
    submitKey: submitKey.key,
    readKey: readKey.key,
  };
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

function createDefaultBilibiliAndTmdbStub() {
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
      if (request.url.includes("/tv/108545")) {
        return jsonResponse(request.url, {
          id: 108545,
          name: "三体",
          original_name: "三体",
          first_air_date: "2023-01-15",
          seasons: [{ season_number: 1, episode_count: 30, air_date: "2023-01-15" }],
          external_ids: {
            imdb_id: "tt20242042",
            tvdb_id: 400100,
          },
        });
      }
      if (request.url.includes("/movie/550")) {
        return jsonResponse(request.url, {
          id: 550,
          title: "搏击俱乐部",
          original_title: "Fight Club",
          release_date: "1999-10-15",
          external_ids: {
            imdb_id: "tt0137523",
          },
        });
      }
      return jsonResponse(request.url, { status_code: 34, status_message: "Not found" }, 404);
    }

    if (request.kind === "catalog" && request.namespace === "trakt") {
      return jsonResponse(request.url, []);
    }

    if (request.kind === "platform" && request.namespace === "bilibili") {
      if (request.url.includes("ep_id=341208")) {
        return jsonResponse(request.url, {
          code: 0,
          message: "success",
          result: { season_id: 34430, title: "咒术回战" },
        });
      }
      if (request.url.includes("media_id=28229899")) {
        return jsonResponse(request.url, {
          code: 0,
          message: "success",
          result: { media: { media_id: 28229899, season_id: 34430 } },
        });
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
            episodes: makeBilibiliEpisodes(24, true),
            section: [{ title: "PV", episodes: [{ id: 880001, title: "PV1", section_type: 0 }] }],
          },
        });
      }
      if (request.url.includes("season_id=77777")) {
        // Conflicting year (2024 instead of 2020)
        return jsonResponse(request.url, {
          code: 0,
          message: "success",
          result: {
            season_id: 77777,
            title: "咒术回战",
            jp_title: "呪術廻戦",
            type: 1,
            publish: { pub_time: "2024-07-01 00:00:00" },
            episodes: makeBilibiliEpisodes(24, false),
          },
        });
      }
      if (request.url.includes("season_id=404404")) {
        return jsonResponse(request.url, { code: -404, message: "啥都木有" });
      }
      if (request.url.includes("season_id=43123")) {
        return jsonResponse(request.url, {
          code: 0,
          message: "success",
          result: {
            season_id: 43123,
            title: "三体",
            type: 5,
            publish: { pub_time: "2023-01-15 21:30:00" },
            episodes: makeBilibiliEpisodes(30, true),
          },
        });
      }
    }

    throw new Error(
      `Unexpected outbound request: ${request.kind}:${request.namespace} ${request.url}`,
    );
  };
}

describe("Bilibili adapter & Evidence Gate Step 1 end-to-end (#10)", () => {
  const handles: TestDbHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop();
      if (handle) {
        await handle.cleanup();
      }
    }
  });

  test("canonicalizes Bilibili URLs/IDs on submit, rejects invalid URLs, and auto-approves matching evidence via scheduled + queue", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-23T18:00:00.000Z");
    const outbound = createFakeOutboundClient({
      fetchExternal: createDefaultBilibiliAndTmdbStub(),
    });

    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => t0,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });

    const user = await setupVerifiedUserAndKeys(app, outbound, "bili-submitter@example.com");

    // 1. Invalid Bilibili URLs / IDs are rejected immediately with 400 INVALID_NATIVE_ID
    for (const badInput of [
      "https://www.bilibili.com/video/BV1xx411c7mD",
      "av170001",
      "https://evil.example.com/bangumi/play/ss34430",
      "34430",
    ]) {
      const badRes = await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": user.submitKey },
          body: JSON.stringify({
            targetExternalKey: "tmdb:tv:95479",
            namespace: "bilibili",
            nativeId: badInput,
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
          }),
        }),
      );
      expect(badRes.status).toBe(400);
      expect(await badRes.json()).toMatchObject({ error: "INVALID_NATIVE_ID" });
    }

    // 2. All valid Bilibili URL/ID forms canonicalize to ss34430 and enter pending_evidence
    const urlVariants = [
      "https://www.bilibili.com/bangumi/play/ss34430",
      "https://m.bilibili.com/bangumi/play/ss34430?from=search",
      "https://www.bilibili.com/bangumi/play/ep341208",
      "https://www.bilibili.com/bangumi/media/md28229899",
      "ss34430",
    ];
    const submittedIds: string[] = [];
    for (const rawInput of urlVariants) {
      const res = await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": user.submitKey },
          body: JSON.stringify({
            targetExternalKey: "tmdb:tv:95479",
            namespace: "bilibili",
            nativeId: rawInput,
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
          }),
        }),
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        changeRequest: {
          id: string;
          status: string;
          rawNativeId: string;
          nativeId: string;
        };
      };
      expect(body.changeRequest.status).toBe("pending_evidence");
      expect(body.changeRequest.rawNativeId).toBe(rawInput);
      expect(body.changeRequest.nativeId).toBe("ss34430");
      submittedIds.push(body.changeRequest.id);
    }

    // Before background worker runs, media is NOT readable yet
    const preRead = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:95479`, {
        headers: { "x-api-key": user.readKey },
      }),
    );
    expect(preRead.status).toBe(404);

    // 3. Run Background Worker scheduled -> queue on the first enqueued evidence_check job
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
      now: () => t0,
    });

    await worker.scheduled(createScheduledController(t0));
    expect(emitted.length).toBeGreaterThanOrEqual(1);
    const firstEvidenceMsg = emitted.find(
      (msg) => msg.jobType === "evidence_check" && msg.payload.changeRequestId === submittedIds[0],
    );
    expect(firstEvidenceMsg).toBeDefined();

    const { batch, tracked } = createQueueBatch([firstEvidenceMsg!], t0);
    const summary = await worker.queue(batch);
    expect(summary.completed).toBe(1);
    expect(tracked[0]?.acked).toBe(true);

    // 4. Change request is now auto-approved with recorded evidence and null reviewerUserId
    const crStatusRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests/${submittedIds[0]}`, {
        headers: { "x-api-key": user.readKey },
      }),
    );
    expect(crStatusRes.status).toBe(200);
    const crStatusBody = (await crStatusRes.json()) as {
      changeRequest: {
        status: string;
        reviewerUserId: string | null;
        decisionReason: string | null;
        evidence: Record<string, unknown> | null;
      };
    };
    expect(crStatusBody.changeRequest.status).toBe("approved");
    expect(crStatusBody.changeRequest.reviewerUserId).toBeNull();
    expect(crStatusBody.changeRequest.decisionReason).toBe("evidence_gate_passed");
    expect(crStatusBody.changeRequest.evidence).toBeTruthy();

    // 5. Media document is now readable via GET /v1/media/tmdb:tv:95479 and usable with resolveEpisode
    const mediaRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:95479`, {
        headers: { "x-api-key": user.readKey },
      }),
    );
    expect(mediaRes.status).toBe(200);
    const mediaBody = (await mediaRes.json()) as { document: MediaDocument };
    expect(mediaBody.document.associations).toHaveLength(1);
    expect(mediaBody.document.associations[0]).toMatchObject({
      namespace: "bilibili",
      nativeId: "ss34430",
      status: "confirmed",
    });
    expect(
      resolveEpisode(mediaBody.document, { namespace: "bilibili", season: 1, episode: 5 }),
    ).toMatchObject({
      kind: "mapped",
      nativeId: "ss34430",
      targetEpisode: 5,
    });
  });

  test("routes conflicting evidence and platform not_found to needs_review with structured reasons and hides from default read API", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-23T19:00:00.000Z");
    const outbound = createFakeOutboundClient({
      fetchExternal: createDefaultBilibiliAndTmdbStub(),
    });
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => t0,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });

    const user = await setupVerifiedUserAndKeys(app, outbound, "conflict-tester@example.com");

    // Submit conflicting year collection (ss77777) AND try to sneak extra submitted externalIds (must be ignored!)
    const conflictSubmitRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": user.submitKey },
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:95479",
          namespace: "bilibili",
          nativeId: "ss77777",
          variantDescription: "原声",
          externalIds: { imdb: "tt12343534" },
          segments: [
            { season: 1, episodeStart: 1, episodeEnd: 24, targetEpisodeStart: 1, baseline: "tmdb" },
          ],
        }),
      }),
    );
    expect(conflictSubmitRes.status).toBe(201);
    const conflictCr = (await conflictSubmitRes.json()) as { changeRequest: { id: string } };

    // Submit non-existent Bilibili collection (ss404404 -> code -404)
    const missingSubmitRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": user.submitKey },
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:95479",
          namespace: "bilibili",
          nativeId: "ss404404",
          variantDescription: "原声",
          segments: [
            { season: 1, episodeStart: 1, episodeEnd: 24, targetEpisodeStart: 1, baseline: "tmdb" },
          ],
        }),
      }),
    );
    expect(missingSubmitRes.status).toBe(201);
    const missingCr = (await missingSubmitRes.json()) as { changeRequest: { id: string } };

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
      now: () => t0,
    });

    await worker.scheduled(createScheduledController(t0));
    expect(emitted).toHaveLength(2);
    const { batch } = createQueueBatch(emitted, t0);
    const summary = await worker.queue(batch);
    expect(summary.completed).toBe(2);

    // Inspect both change requests
    const conflictInspect = (await (
      await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests/${conflictCr.changeRequest.id}`, {
          headers: { "x-api-key": user.readKey },
        }),
      )
    ).json()) as {
      changeRequest: {
        status: string;
        conflictReason: string | null;
        decisionReason: string | null;
        evidence: Record<string, unknown> | null;
      };
    };
    expect(conflictInspect.changeRequest.status).toBe("needs_review");
    expect(conflictInspect.changeRequest.conflictReason).toBe("year_mismatch");
    expect(conflictInspect.changeRequest.decisionReason).toBeTruthy();
    expect(conflictInspect.changeRequest.evidence).toBeTruthy();

    const missingInspect = (await (
      await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests/${missingCr.changeRequest.id}`, {
          headers: { "x-api-key": user.readKey },
        }),
      )
    ).json()) as {
      changeRequest: {
        status: string;
        conflictReason: string | null;
        evidence: Record<string, unknown> | null;
      };
    };
    expect(missingInspect.changeRequest.status).toBe("needs_review");
    expect(missingInspect.changeRequest.conflictReason).toBe("collection_not_found");
    expect(missingInspect.changeRequest.evidence).toBeTruthy();

    // Neither conflicting nor missing CR appears in default read API
    const readRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:95479`, {
        headers: { "x-api-key": user.readKey },
      }),
    );
    expect(readRes.status).toBe(404);
  });

  test("retries transient platform and TMDB errors while keeping change request in pending_evidence until recovery", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-23T20:00:00.000Z");
    let now = t0;
    let biliCalls = 0;
    let tmdbCalls = 0;
    const baseStub = createDefaultBilibiliAndTmdbStub();

    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        if (request.namespace === "bilibili" && request.url.includes("season_id=43123")) {
          biliCalls += 1;
          if (biliCalls === 1) {
            throw new Error("ETIMEDOUT connecting to api.bilibili.com");
          }
        }
        if (request.namespace === "tmdb" && request.url.includes("/tv/108545")) {
          tmdbCalls += 1;
          if (tmdbCalls === 1) {
            return { status: 503, headers: {}, body: "Upstream 503", url: request.url };
          }
        }
        return baseStub(request);
      },
    });

    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => now,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });

    const user = await setupVerifiedUserAndKeys(app, outbound, "retry-tester@example.com");

    const submitRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": user.submitKey },
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:108545",
          namespace: "bilibili",
          nativeId: "ss43123",
          variantDescription: "原声",
          segments: [
            { season: 1, episodeStart: 1, episodeEnd: 30, targetEpisodeStart: 1, baseline: "tmdb" },
          ],
        }),
      }),
    );
    expect(submitRes.status).toBe(201);
    const { changeRequest } = (await submitRes.json()) as { changeRequest: { id: string } };

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
        defaultRetryDelayMs: 30_000,
        tmdb: { accessToken: "test-tmdb-token" },
      },
      now: () => now,
    });

    // Attempt 1: TMDB 503 (or Bilibili timeout) -> rescheduled, CR remains pending_evidence
    await worker.scheduled(createScheduledController(now));
    expect(emitted).toHaveLength(1);
    const attempt1 = await worker.queue(createQueueBatch([emitted.shift()!], now).batch);
    expect(attempt1.rescheduled).toBe(1);

    const afterAttempt1 = (await (
      await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests/${changeRequest.id}`, {
          headers: { "x-api-key": user.readKey },
        }),
      )
    ).json()) as { changeRequest: { status: string } };
    expect(afterAttempt1.changeRequest.status).toBe("pending_evidence");

    // Attempt 2 after 30s backoff: second upstream fails transiently -> rescheduled, STILL pending_evidence
    now = new Date(now.getTime() + 30_000);
    await worker.scheduled(createScheduledController(now));
    expect(emitted).toHaveLength(1);
    const attempt2 = await worker.queue(createQueueBatch([emitted.shift()!], now).batch);
    expect(attempt2.rescheduled).toBe(1);

    const afterAttempt2 = (await (
      await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests/${changeRequest.id}`, {
          headers: { "x-api-key": user.readKey },
        }),
      )
    ).json()) as { changeRequest: { status: string } };
    expect(afterAttempt2.changeRequest.status).toBe("pending_evidence");

    // Attempt 3 after 30s backoff: both upstream services recover -> auto-approved!
    now = new Date(now.getTime() + 30_000);
    await worker.scheduled(createScheduledController(now));
    expect(emitted).toHaveLength(1);
    const attempt3 = await worker.queue(createQueueBatch([emitted.shift()!], now).batch);
    expect(attempt3.completed).toBe(1);

    const afterAttempt3 = (await (
      await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests/${changeRequest.id}`, {
          headers: { "x-api-key": user.readKey },
        }),
      )
    ).json()) as { changeRequest: { status: string } };
    expect(afterAttempt3.changeRequest.status).toBe("approved");

    const mediaRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:108545`, {
        headers: { "x-api-key": user.readKey },
      }),
    );
    expect(mediaRes.status).toBe(200);
    const mediaBody = (await mediaRes.json()) as { document: MediaDocument };
    expect(mediaBody.document.associations[0]?.nativeId).toBe("ss43123");
  });

  test("routes Tier 1-only platform submissions immediately to needs_review without enqueueing an evidence job", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-23T21:00:00.000Z");
    const outbound = createFakeOutboundClient({
      fetchExternal: createDefaultBilibiliAndTmdbStub(),
    });

    const tier1Youku = createTier1Adapter({
      namespace: "youku",
      parseInput(raw) {
        const trimmed = raw.trim();
        const urlMatch = trimmed.match(/id_z?([a-f0-9]{20})\.html$/i);
        if (urlMatch) {
          return {
            kind: "show",
            id: urlMatch[1]!.toLowerCase(),
            canonicalId: urlMatch[1]!.toLowerCase(),
          };
        }
        if (/^[a-f0-9]{20}$/i.test(trimmed)) {
          return { kind: "show", id: trimmed.toLowerCase(), canonicalId: trimmed.toLowerCase() };
        }
        return null;
      },
    });
    const registry = createAdapterRegistry([bilibiliAdapter, tier1Youku]);

    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      adapterRegistry: registry,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => t0,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });

    const user = await setupVerifiedUserAndKeys(app, outbound, "tier1-tester@example.com");

    // Invalid Youku URL is still rejected by Tier 1 canonicalization
    const badRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": user.submitKey },
        body: JSON.stringify({
          targetExternalKey: "tmdb:movie:550",
          namespace: "youku",
          nativeId: "https://example.com/not-youku",
          variantDescription: "原声",
          segments: [],
        }),
      }),
    );
    expect(badRes.status).toBe(400);
    expect(await badRes.json()).toMatchObject({ error: "INVALID_NATIVE_ID" });

    // Valid Youku URL canonicalizes AND goes straight to needs_review (no evidence_check job!)
    const okRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": user.submitKey },
        body: JSON.stringify({
          targetExternalKey: "tmdb:movie:550",
          namespace: "youku",
          nativeId: "https://list.youku.com/show/id_zcc001f06962411de83b1.html",
          variantDescription: "原声",
          segments: [],
        }),
      }),
    );
    expect(okRes.status).toBe(201);
    const okBody = (await okRes.json()) as {
      changeRequest: {
        status: string;
        nativeId: string;
        rawNativeId: string;
        decisionReason: string | null;
      };
    };
    expect(okBody.changeRequest.status).toBe("needs_review");
    expect(okBody.changeRequest.nativeId).toBe("cc001f06962411de83b1");
    expect(okBody.changeRequest.rawNativeId).toBe(
      "https://list.youku.com/show/id_zcc001f06962411de83b1.html",
    );
    expect(okBody.changeRequest.decisionReason).toBe("adapter_tier_1_manual_review");

    // Background worker finds zero jobs to claim
    const emitted: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      adapterRegistry: registry,
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
      now: () => t0,
    });
    const tick = await worker.scheduled(createScheduledController(t0));
    expect(tick.claimed).toBe(0);
    expect(emitted).toHaveLength(0);
  });

  test("auto-approves via consistent platform-fetched shared ID and blocks on mixed match + conflict", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-23T22:00:00.000Z");
    const outbound = createFakeOutboundClient({
      fetchExternal: createDefaultBilibiliAndTmdbStub(),
    });

    const sharedIdAdapter: Tier2Adapter<"bangumi"> = {
      namespace: "bangumi",
      tier: 2,
      parseInput(raw) {
        const trimmed = raw.trim();
        return /^\d+$/.test(trimmed)
          ? { kind: "subject", id: trimmed, canonicalId: trimmed }
          : null;
      },
      async canonicalize(raw) {
        const parsed = this.parseInput(raw);
        if (!parsed || !parsed.canonicalId) {
          throw new Error("Invalid bangumi ID");
        }
        return parsed.canonicalId;
      },
      async fetchCollection(canonicalId) {
        if (canonicalId === "294993") {
          return {
            status: "found",
            info: {
              namespace: "bangumi",
              canonicalId: "294993",
              title: "Localized Unrelated Title",
              year: 2020,
              mediaType: "tv",
              featureEpisodeCount: 24,
              featureEpisodes: [],
              externalIds: { imdb: "tt12343534" },
            },
          };
        }
        return {
          status: "found",
          info: {
            namespace: "bangumi",
            canonicalId,
            title: "咒术回战",
            year: 2020,
            mediaType: "tv",
            featureEpisodeCount: 24,
            featureEpisodes: [],
            externalIds: { imdb: "tt12343534", tvdb: "999999" },
          },
        };
      },
    };

    const registry = createAdapterRegistry([bilibiliAdapter, sharedIdAdapter]);
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      adapterRegistry: registry,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => t0,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });
    const user = await setupVerifiedUserAndKeys(app, outbound, "shared-id@example.com");

    const passRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": user.submitKey },
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:95479",
          namespace: "bangumi",
          nativeId: "294993",
          segments: [{ season: 1, baseline: "tmdb" }],
        }),
      }),
    );
    expect(passRes.status).toBe(201);
    const passCr = (await passRes.json()) as { changeRequest: { id: string } };

    const conflictRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": user.submitKey },
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:95479",
          namespace: "bangumi",
          nativeId: "999999",
          segments: [{ season: 2, baseline: "tmdb" }],
        }),
      }),
    );
    expect(conflictRes.status).toBe(201);
    const conflictCr = (await conflictRes.json()) as { changeRequest: { id: string } };

    const emitted: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      adapterRegistry: registry,
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
      config: { tmdb: { accessToken: "test-tmdb-token" } },
      now: () => t0,
    });

    await worker.scheduled(createScheduledController(t0));
    expect(emitted).toHaveLength(2);
    await worker.queue(createQueueBatch(emitted, t0).batch);

    const passState = (await (
      await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests/${passCr.changeRequest.id}`, {
          headers: { "x-api-key": user.readKey },
        }),
      )
    ).json()) as { changeRequest: { status: string } };
    expect(passState.changeRequest.status).toBe("approved");

    const conflictState = (await (
      await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests/${conflictCr.changeRequest.id}`, {
          headers: { "x-api-key": user.readKey },
        }),
      )
    ).json()) as { changeRequest: { status: string; conflictReason: string | null } };
    expect(conflictState.changeRequest.status).toBe("needs_review");
    expect(conflictState.changeRequest.conflictReason).toBe("shared_id_conflict");
  });

  test("enforces lease generation fencing on evidence_check and routes concurrent segment overlap at auto-approval to needs_review", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-23T23:00:00.000Z");
    let now = t0;
    const baseStub = createDefaultBilibiliAndTmdbStub();

    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        if (request.namespace === "bilibili" && request.url.includes("season_id=34431")) {
          // Second matching collection for the same S1 E1-24 range
          return jsonResponse(request.url, {
            code: 0,
            message: "success",
            result: {
              season_id: 34431,
              title: "咒术回战",
              jp_title: "呪術廻戦",
              type: 1,
              publish: { pub_time: "2020-10-03 01:25:00" },
              episodes: makeBilibiliEpisodes(24, false),
            },
          });
        }
        return baseStub(request);
      },
    });

    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => now,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });
    const user = await setupVerifiedUserAndKeys(app, outbound, "fence-overlap@example.com");

    // Submit two overlapping Bilibili CRs in the same variant while media is uncreated
    const cr1Res = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": user.submitKey },
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:95479",
          namespace: "bilibili",
          nativeId: "ss34430",
          variantDescription: "原声",
          segments: [
            { season: 1, episodeStart: 1, episodeEnd: 24, targetEpisodeStart: 1, baseline: "tmdb" },
          ],
        }),
      }),
    );
    expect(cr1Res.status).toBe(201);
    const cr1 = (await cr1Res.json()) as { changeRequest: { id: string } };

    const cr2Res = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": user.submitKey },
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:95479",
          namespace: "bilibili",
          nativeId: "ss34431",
          variantDescription: "原声",
          segments: [
            { season: 1, episodeStart: 1, episodeEnd: 24, targetEpisodeStart: 1, baseline: "tmdb" },
          ],
        }),
      }),
    );
    expect(cr2Res.status).toBe(201);
    const cr2 = (await cr2Res.json()) as { changeRequest: { id: string } };

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
        leaseDurationMs: 30_000,
        tmdb: { accessToken: "test-tmdb-token" },
      },
      now: () => now,
    });

    // Claim both at T0 (generation 1)
    await worker.scheduled(createScheduledController(now));
    expect(emitted).toHaveLength(2);
    const gen1Messages = emitted.splice(0, emitted.length);

    // Expire leases and re-claim at T0 + 35s (generation 2)
    now = new Date(t0.getTime() + 35_000);
    await worker.scheduled(createScheduledController(now));
    expect(emitted).toHaveLength(2);
    const gen2Messages = emitted.splice(0, emitted.length);
    expect(gen2Messages.every((m) => m.leaseGeneration === 2)).toBe(true);

    // Stale generation 1 delivery is discarded without approving either CR
    const staleSummary = await worker.queue(createQueueBatch(gen1Messages, now).batch);
    expect(staleSummary.discarded).toBe(2);
    expect(
      (
        await app.fetch(
          new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:95479`, {
            headers: { "x-api-key": user.readKey },
          }),
        )
      ).status,
    ).toBe(404);

    // Generation 2 processes CR #1 then CR #2: CR #1 auto-approves, CR #2 hits segment overlap -> needs_review
    const cr1Msg = gen2Messages.find((m) => m.payload.changeRequestId === cr1.changeRequest.id)!;
    const cr2Msg = gen2Messages.find((m) => m.payload.changeRequestId === cr2.changeRequest.id)!;
    const freshSummary = await worker.queue(createQueueBatch([cr1Msg, cr2Msg], now).batch);
    expect(freshSummary.completed).toBe(2);

    const cr1State = (await (
      await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests/${cr1.changeRequest.id}`, {
          headers: { "x-api-key": user.readKey },
        }),
      )
    ).json()) as { changeRequest: { status: string } };
    expect(cr1State.changeRequest.status).toBe("approved");

    const cr2State = (await (
      await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests/${cr2.changeRequest.id}`, {
          headers: { "x-api-key": user.readKey },
        }),
      )
    ).json()) as { changeRequest: { status: string; conflictReason: string | null } };
    expect(cr2State.changeRequest.status).toBe("needs_review");
    expect(cr2State.changeRequest.conflictReason).toBe("segment_overlap");

    // Only one association exists in the confirmed MediaDocument
    const mediaBody = (await (
      await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:95479`, {
          headers: { "x-api-key": user.readKey },
        }),
      )
    ).json()) as { document: MediaDocument };
    expect(mediaBody.document.associations).toHaveLength(1);
    expect(mediaBody.document.associations[0]?.nativeId).toBe("ss34430");
  });
});

describe("Evidence Gate Step 2 end-to-end (#11)", () => {
  const handles: TestDbHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop();
      if (handle) {
        await handle.cleanup();
      }
    }
  });

  function createStep2Stub() {
    const baseStub = createDefaultBilibiliAndTmdbStub();
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
              { season_number: 2, episode_count: 23, air_date: "2023-07-06" },
            ],
            external_ids: {
              imdb_id: "tt12343534",
              tvdb_id: 377543,
            },
          });
        }
        if (request.url.includes("/tv/200100")) {
          return jsonResponse(request.url, {
            id: 200100,
            name: "连载新番",
            original_name: "連載アニメ",
            first_air_date: "2026-04-01",
            seasons: [{ season_number: 1, episode_count: 24, air_date: "2026-04-01" }],
            external_ids: { imdb_id: "tt20010001" },
          });
        }
        if (request.url.includes("/tv/200200")) {
          return jsonResponse(request.url, {
            id: 200200,
            name: "双季合集剧",
            original_name: "双季合集剧",
            first_air_date: "2022-01-10",
            seasons: [
              { season_number: 1, episode_count: 12, air_date: "2022-01-10" },
              { season_number: 2, episode_count: 12, air_date: "2024-01-10" },
            ],
            external_ids: { imdb_id: "tt20020001" },
          });
        }
        if (request.url.includes("/tv/200300")) {
          return jsonResponse(request.url, {
            id: 200300,
            name: "推理综艺",
            original_name: "推理综艺",
            first_air_date: "2023-03-01",
            seasons: [
              { season_number: 1, episode_count: 12, air_date: "2023-03-01" },
              { season_number: 2, episode_count: 12, air_date: "2024-03-01" },
            ],
            external_ids: { imdb_id: "tt20030001" },
          });
        }
        if (request.url.includes("/tv/95480")) {
          // Jujutsu Kaisen split-season catalog representation: S1 has 47 episodes
          return jsonResponse(request.url, {
            id: 95480,
            name: "咒术回战",
            original_name: "呪術廻戦",
            first_air_date: "2020-10-03",
            seasons: [{ season_number: 1, episode_count: 47, air_date: "2020-10-03" }],
            external_ids: { imdb_id: "tt95480001" },
          });
        }
      }

      if (request.kind === "platform" && request.namespace === "bilibili") {
        if (request.url.includes("season_id=45600")) {
          // S2 collection (2023, 23 eps)
          return jsonResponse(request.url, {
            code: 0,
            message: "success",
            result: {
              season_id: 45600,
              title: "咒术回战 第二季",
              jp_title: "呪術廻戦",
              type: 1,
              publish: { pub_time: "2023-07-06 23:00:00" },
              episodes: makeBilibiliEpisodes(23, true),
            },
          });
        }
        if (request.url.includes("season_id=45574") || request.url.includes("season_id=45575")) {
          // Split S1 part 2 (2020, 23 eps: eps 25..47)
          const seasonId = request.url.includes("season_id=45575") ? 45575 : 45574;
          return jsonResponse(request.url, {
            code: 0,
            message: "success",
            result: {
              season_id: seasonId,
              title: "咒术回战 Part 2",
              jp_title: "呪術廻戦",
              type: 1,
              publish: { pub_time: "2020-10-03 01:25:00" },
              episodes: makeBilibiliEpisodes(23, true),
            },
          });
        }
        if (request.url.includes("season_id=34432")) {
          // Dubbed variant collection for S1 (2020, 24 eps)
          return jsonResponse(request.url, {
            code: 0,
            message: "success",
            result: {
              season_id: 34432,
              title: "咒术回战（中配）",
              jp_title: "呪術廻戦",
              type: 1,
              publish: { pub_time: "2020-10-03 01:25:00" },
              episodes: makeBilibiliEpisodes(24, false),
            },
          });
        }
        if (request.url.includes("season_id=80100")) {
          // Ongoing season currently at 10 aired episodes
          return jsonResponse(request.url, {
            code: 0,
            message: "success",
            result: {
              season_id: 80100,
              title: "连载新番",
              jp_title: "連載アニメ",
              type: 1,
              publish: { pub_time: "2026-04-01 20:00:00" },
              episodes: makeBilibiliEpisodes(10, true),
            },
          });
        }
        if (request.url.includes("season_id=80101")) {
          // Exceeds TMDB S1 episodeCount (26 > 24)
          return jsonResponse(request.url, {
            code: 0,
            message: "success",
            result: {
              season_id: 80101,
              title: "连载新番",
              jp_title: "連載アニメ",
              type: 1,
              publish: { pub_time: "2026-04-01 20:00:00" },
              episodes: makeBilibiliEpisodes(26, false),
            },
          });
        }
        if (request.url.includes("season_id=80200")) {
          // Merged 2-season collection (year matches earliest season S1 = 2022, 24 eps)
          return jsonResponse(request.url, {
            code: 0,
            message: "success",
            result: {
              season_id: 80200,
              title: "双季合集剧",
              type: 5,
              publish: { pub_time: "2022-01-10 20:00:00" },
              episodes: makeBilibiliEpisodes(24, true),
            },
          });
        }
        if (request.url.includes("season_id=80201")) {
          // Wrong year (2024 instead of earliest season S1 = 2022)
          return jsonResponse(request.url, {
            code: 0,
            message: "success",
            result: {
              season_id: 80201,
              title: "双季合集剧",
              type: 5,
              publish: { pub_time: "2024-01-10 20:00:00" },
              episodes: makeBilibiliEpisodes(24, false),
            },
          });
        }
        if (request.url.includes("season_id=80202")) {
          // Same valid metadata as 80200, used to test wrong 2nd-segment targetEpisodeStart
          return jsonResponse(request.url, {
            code: 0,
            message: "success",
            result: {
              season_id: 80202,
              title: "双季合集剧",
              type: 5,
              publish: { pub_time: "2022-01-10 20:00:00" },
              episodes: makeBilibiliEpisodes(24, false),
            },
          });
        }
        if (request.url.includes("season_id=28281")) {
          // Movie (type: 2 -> movie)
          return jsonResponse(request.url, {
            code: 0,
            message: "success",
            result: {
              season_id: 28281,
              title: "搏击俱乐部",
              alias: "Fight Club",
              type: 2,
              publish: { pub_time: "1999-10-15 00:00:00" },
              episodes: makeBilibiliEpisodes(1, true),
            },
          });
        }
        if (request.url.includes("season_id=80300")) {
          // Non-linear variety show: 30 feature eps vs TMDB 12 eps, year 2023 matches S1
          return jsonResponse(request.url, {
            code: 0,
            message: "success",
            result: {
              season_id: 80300,
              title: "推理综艺",
              type: 7,
              publish: { pub_time: "2023-03-01 12:00:00" },
              episodes: makeBilibiliEpisodes(30, true),
            },
          });
        }
        if (request.url.includes("season_id=80301")) {
          // Non-linear variety show with S2 year (2024)
          return jsonResponse(request.url, {
            code: 0,
            message: "success",
            result: {
              season_id: 80301,
              title: "推理综艺",
              type: 7,
              publish: { pub_time: "2024-03-01 12:00:00" },
              episodes: makeBilibiliEpisodes(30, false),
            },
          });
        }
      }

      return baseStub(request);
    };
  }

  async function drainEvidenceJobs(
    worker: ReturnType<typeof createBackgroundWorker>,
    emitted: JobQueueMessage[],
    now: Date,
  ) {
    await worker.scheduled(createScheduledController(now));
    const messages = emitted.splice(0, emitted.length);
    if (messages.length > 0) {
      await worker.queue(createQueueBatch(messages, now).batch);
    }
    return messages.length;
  }

  test("routes wrong season, wrong targetEpisodeStart, and wrong episode count to needs_review", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-24T01:00:00.000Z");
    const outbound = createFakeOutboundClient({ fetchExternal: createStep2Stub() });
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => t0,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });
    const user = await setupVerifiedUserAndKeys(app, outbound, "step2-reject@example.com");

    const submitCr = async (body: Record<string, unknown>) => {
      const res = await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": user.submitKey },
          body: JSON.stringify(body),
        }),
      );
      expect(res.status).toBe(201);
      return ((await res.json()) as { changeRequest: { id: string } }).changeRequest.id;
    };

    // 1. Wrong season: S2 collection (2023, 23 eps) submitted as S1
    const wrongSeasonId = await submitCr({
      targetExternalKey: "tmdb:tv:95479",
      namespace: "bilibili",
      nativeId: "ss45600",
      variantDescription: "原声",
      segments: [
        { season: 1, episodeStart: 1, episodeEnd: 23, targetEpisodeStart: 1, baseline: "tmdb" },
      ],
    });

    // 2. Wrong targetEpisodeStart: S1 1..24 with targetEpisodeStart=2
    const wrongOffsetId = await submitCr({
      targetExternalKey: "tmdb:tv:95479",
      namespace: "bilibili",
      nativeId: "ss34430",
      variantDescription: "原声",
      segments: [
        { season: 1, episodeStart: 1, episodeEnd: 24, targetEpisodeStart: 2, baseline: "tmdb" },
      ],
    });

    // 3. Wrong episode count: S1 1..12 on 24-ep collection
    const wrongCountId = await submitCr({
      targetExternalKey: "tmdb:tv:95479",
      namespace: "bilibili",
      nativeId: "ss34430",
      variantDescription: "原声",
      segments: [
        { season: 1, episodeStart: 1, episodeEnd: 12, targetEpisodeStart: 1, baseline: "tmdb" },
      ],
    });

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
        enableDailyTmdbSync: false,
        enableExplorationScheduling: false,
      },
      now: () => t0,
    });

    expect(await drainEvidenceJobs(worker, emitted, t0)).toBe(3);

    const inspectCr = async (id: string) => {
      const res = await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests/${id}`, {
          headers: { "x-api-key": user.readKey },
        }),
      );
      expect(res.status).toBe(200);
      return (await res.json()) as {
        changeRequest: {
          status: string;
          conflictReason: string | null;
          evidence: { gate?: { step1?: { decision: string }; step2?: { decision: string } } };
        };
      };
    };

    const wrongSeason = await inspectCr(wrongSeasonId);
    expect(wrongSeason.changeRequest.status).toBe("needs_review");
    expect(wrongSeason.changeRequest.conflictReason).toBe("segment_year_mismatch");
    expect(wrongSeason.changeRequest.evidence.gate?.step1?.decision).toBe("pass");
    expect(wrongSeason.changeRequest.evidence.gate?.step2?.decision).toBe("needs_review");

    const wrongOffset = await inspectCr(wrongOffsetId);
    expect(wrongOffset.changeRequest.status).toBe("needs_review");
    expect(wrongOffset.changeRequest.conflictReason).toBe("target_episode_start_mismatch");

    const wrongCount = await inspectCr(wrongCountId);
    expect(wrongCount.changeRequest.status).toBe("needs_review");
    expect(wrongCount.changeRequest.conflictReason).toBe("segment_episode_count_mismatch");

    // None of the rejected submissions appear in the default read API
    const mediaRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:95479`, {
        headers: { "x-api-key": user.readKey },
      }),
    );
    expect(mediaRes.status).toBe(404);
  });

  test("auto-approves open-ended ongoing seasons (episodeEnd: null) and routes over-limit counts to needs_review", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-24T02:00:00.000Z");
    const outbound = createFakeOutboundClient({ fetchExternal: createStep2Stub() });
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => t0,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });
    const user = await setupVerifiedUserAndKeys(app, outbound, "step2-ongoing@example.com");

    // 10 aired episodes <= 24 season episodes with episodeEnd: null -> auto-approve
    const okRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": user.submitKey },
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:200100",
          namespace: "bilibili",
          nativeId: "ss80100",
          variantDescription: "原声",
          segments: [
            {
              season: 1,
              episodeStart: 1,
              episodeEnd: null,
              targetEpisodeStart: 1,
              baseline: "tmdb",
            },
          ],
        }),
      }),
    );
    expect(okRes.status).toBe(201);
    const okCr = (await okRes.json()) as { changeRequest: { id: string } };

    // 26 episodes > 24 season episodes -> needs_review
    const overRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": user.submitKey },
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:200100",
          namespace: "bilibili",
          nativeId: "ss80101",
          variantDescription: "备用",
          segments: [
            {
              season: 1,
              episodeStart: 1,
              episodeEnd: null,
              targetEpisodeStart: 1,
              baseline: "tmdb",
            },
          ],
        }),
      }),
    );
    expect(overRes.status).toBe(201);
    const overCr = (await overRes.json()) as { changeRequest: { id: string } };

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
        enableDailyTmdbSync: false,
        enableExplorationScheduling: false,
      },
      now: () => t0,
    });

    expect(await drainEvidenceJobs(worker, emitted, t0)).toBe(2);

    const okState = (await (
      await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests/${okCr.changeRequest.id}`, {
          headers: { "x-api-key": user.readKey },
        }),
      )
    ).json()) as { changeRequest: { status: string } };
    expect(okState.changeRequest.status).toBe("approved");

    const overState = (await (
      await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests/${overCr.changeRequest.id}`, {
          headers: { "x-api-key": user.readKey },
        }),
      )
    ).json()) as { changeRequest: { status: string } };
    expect(overState.changeRequest.status).toBe("needs_review");

    const mediaBody = (await (
      await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:200100`, {
          headers: { "x-api-key": user.readKey },
        }),
      )
    ).json()) as { document: MediaDocument };
    expect(
      resolveEpisode(mediaBody.document, { namespace: "bilibili", season: 1, episode: 10 }),
    ).toMatchObject({ kind: "mapped", nativeId: "ss80100", targetEpisode: 10 });
  });

  test("auto-approves split-season collections (47 eps -> ss34430 1..24 + ss45574 25..47) and resolves S1 E30 to ss45574 E6", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-24T03:00:00.000Z");
    const outbound = createFakeOutboundClient({ fetchExternal: createStep2Stub() });
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => t0,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });
    const user = await setupVerifiedUserAndKeys(app, outbound, "step2-split@example.com");

    const part1Res = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": user.submitKey },
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:95480",
          namespace: "bilibili",
          nativeId: "ss34430",
          variantDescription: "原声",
          segments: [
            { season: 1, episodeStart: 1, episodeEnd: 24, targetEpisodeStart: 1, baseline: "tmdb" },
          ],
        }),
      }),
    );
    expect(part1Res.status).toBe(201);
    const part1Cr = (await part1Res.json()) as { changeRequest: { id: string } };

    const part2Res = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": user.submitKey },
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:95480",
          namespace: "bilibili",
          nativeId: "ss45574",
          variantDescription: "原声",
          segments: [
            {
              season: 1,
              episodeStart: 25,
              episodeEnd: 47,
              targetEpisodeStart: 1,
              baseline: "tmdb",
            },
          ],
        }),
      }),
    );
    expect(part2Res.status).toBe(201);
    const part2Cr = (await part2Res.json()) as { changeRequest: { id: string } };

    // Wrong targetEpisodeStart (25 instead of 1) on part 2 -> needs_review
    const badOffsetRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": user.submitKey },
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:95480",
          namespace: "bilibili",
          nativeId: "ss45575",
          variantDescription: "错偏移变体",
          segments: [
            {
              season: 1,
              episodeStart: 25,
              episodeEnd: 47,
              targetEpisodeStart: 25,
              baseline: "tmdb",
            },
          ],
        }),
      }),
    );
    expect(badOffsetRes.status).toBe(201);
    const badOffsetCr = (await badOffsetRes.json()) as { changeRequest: { id: string } };

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
        enableDailyTmdbSync: false,
        enableExplorationScheduling: false,
      },
      now: () => t0,
    });

    expect(await drainEvidenceJobs(worker, emitted, t0)).toBe(3);

    const checkStatus = async (id: string) =>
      (await (
        await app.fetch(
          new Request(`${TEST_BASE_URL}/v1/change-requests/${id}`, {
            headers: { "x-api-key": user.readKey },
          }),
        )
      ).json()) as { changeRequest: { status: string; conflictReason: string | null } };

    expect((await checkStatus(part1Cr.changeRequest.id)).changeRequest.status).toBe("approved");
    expect((await checkStatus(part2Cr.changeRequest.id)).changeRequest.status).toBe("approved");

    const badOffset = await checkStatus(badOffsetCr.changeRequest.id);
    expect(badOffset.changeRequest.status).toBe("needs_review");
    expect(badOffset.changeRequest.conflictReason).toBe("target_episode_start_mismatch");

    const mediaBody = (await (
      await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:95480`, {
          headers: { "x-api-key": user.readKey },
        }),
      )
    ).json()) as { document: MediaDocument };
    expect(mediaBody.document.associations).toHaveLength(2);
    expect(
      resolveEpisode(mediaBody.document, { namespace: "bilibili", season: 1, episode: 5 }),
    ).toMatchObject({ kind: "mapped", nativeId: "ss34430", targetEpisode: 5 });
    expect(
      resolveEpisode(mediaBody.document, { namespace: "bilibili", season: 1, episode: 30 }),
    ).toMatchObject({ kind: "mapped", nativeId: "ss45574", targetEpisode: 6 });
  });

  test("verifies multi-season merged collections by summed episode count and earliest season premiere year", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-24T04:00:00.000Z");
    const outbound = createFakeOutboundClient({ fetchExternal: createStep2Stub() });
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => t0,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });
    const user = await setupVerifiedUserAndKeys(app, outbound, "step2-merged@example.com");

    const submitCr = async (body: Record<string, unknown>) => {
      const res = await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": user.submitKey },
          body: JSON.stringify(body),
        }),
      );
      expect(res.status).toBe(201);
      return ((await res.json()) as { changeRequest: { id: string } }).changeRequest.id;
    };

    // Valid merged 2-season collection (year 2022 = S1 premiere year, 12 + 12 = 24 eps)
    const validId = await submitCr({
      targetExternalKey: "tmdb:tv:200200",
      namespace: "bilibili",
      nativeId: "ss80200",
      variantDescription: "原声",
      segments: [
        { season: 1, episodeStart: 1, episodeEnd: 12, targetEpisodeStart: 1, baseline: "tmdb" },
        { season: 2, episodeStart: 1, episodeEnd: 12, targetEpisodeStart: 13, baseline: "tmdb" },
      ],
    });

    // Wrong year (2024 instead of S1's 2022) -> needs_review
    const badYearId = await submitCr({
      targetExternalKey: "tmdb:tv:200200",
      namespace: "bilibili",
      nativeId: "ss80201",
      variantDescription: "错年份变体",
      segments: [
        { season: 1, episodeStart: 1, episodeEnd: 12, targetEpisodeStart: 1, baseline: "tmdb" },
        { season: 2, episodeStart: 1, episodeEnd: 12, targetEpisodeStart: 13, baseline: "tmdb" },
      ],
    });

    // Wrong 2nd segment targetEpisodeStart (14 instead of 13) -> needs_review
    const badSecondOffsetId = await submitCr({
      targetExternalKey: "tmdb:tv:200200",
      namespace: "bilibili",
      nativeId: "ss80202",
      variantDescription: "错偏移变体",
      segments: [
        { season: 1, episodeStart: 1, episodeEnd: 12, targetEpisodeStart: 1, baseline: "tmdb" },
        { season: 2, episodeStart: 1, episodeEnd: 12, targetEpisodeStart: 14, baseline: "tmdb" },
      ],
    });

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
        enableDailyTmdbSync: false,
        enableExplorationScheduling: false,
      },
      now: () => t0,
    });

    expect(await drainEvidenceJobs(worker, emitted, t0)).toBe(3);

    const readCr = async (id: string) =>
      (await (
        await app.fetch(
          new Request(`${TEST_BASE_URL}/v1/change-requests/${id}`, {
            headers: { "x-api-key": user.readKey },
          }),
        )
      ).json()) as { changeRequest: { status: string; conflictReason: string | null } };

    expect((await readCr(validId)).changeRequest.status).toBe("approved");
    expect((await readCr(badYearId)).changeRequest).toMatchObject({
      status: "needs_review",
      conflictReason: "segment_year_mismatch",
    });
    expect((await readCr(badSecondOffsetId)).changeRequest).toMatchObject({
      status: "needs_review",
      conflictReason: "target_episode_start_mismatch",
    });

    const mediaBody = (await (
      await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:200200`, {
          headers: { "x-api-key": user.readKey },
        }),
      )
    ).json()) as { document: MediaDocument };
    expect(
      resolveEpisode(mediaBody.document, { namespace: "bilibili", season: 2, episode: 3 }),
    ).toMatchObject({ kind: "mapped", nativeId: "ss80200", targetEpisode: 15 });
  });

  test("skips Step 2 for movie change requests and auto-approves", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-24T05:00:00.000Z");
    const outbound = createFakeOutboundClient({ fetchExternal: createStep2Stub() });
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => t0,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });
    const user = await setupVerifiedUserAndKeys(app, outbound, "step2-movie@example.com");

    const submitRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": user.submitKey },
        body: JSON.stringify({
          targetExternalKey: "tmdb:movie:550",
          namespace: "bilibili",
          nativeId: "ss28281",
          variantDescription: "原声",
          segments: [],
        }),
      }),
    );
    expect(submitRes.status).toBe(201);
    const { changeRequest } = (await submitRes.json()) as { changeRequest: { id: string } };

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
        enableDailyTmdbSync: false,
        enableExplorationScheduling: false,
      },
      now: () => t0,
    });

    expect(await drainEvidenceJobs(worker, emitted, t0)).toBe(1);

    const crBody = (await (
      await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests/${changeRequest.id}`, {
          headers: { "x-api-key": user.readKey },
        }),
      )
    ).json()) as {
      changeRequest: {
        status: string;
        evidence: { gate?: { step2?: { decision: string; skipped?: boolean } } };
      };
    };
    expect(crBody.changeRequest.status).toBe("approved");
    expect(crBody.changeRequest.evidence.gate?.step2).toMatchObject({
      decision: "pass",
      skipped: true,
    });

    const mediaBody = (await (
      await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/media/tmdb:movie:550`, {
          headers: { "x-api-key": user.readKey },
        }),
      )
    ).json()) as { document: MediaDocument };
    expect(mediaBody.document.media.type).toBe("movie");
    expect(mediaBody.document.associations).toHaveLength(1);
    expect(mediaBody.document.associations[0]?.nativeId).toBe("ss28281");
  });

  test("checks only season premiere year for nonLinear segments (skips episode count mismatch)", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-24T06:00:00.000Z");
    const outbound = createFakeOutboundClient({ fetchExternal: createStep2Stub() });
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => t0,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });
    const user = await setupVerifiedUserAndKeys(app, outbound, "step2-nonlinear@example.com");

    // 30 feature eps vs TMDB 12 eps, matching S1 year 2023 + nonLinear: true -> auto-approves!
    const okRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": user.submitKey },
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:200300",
          namespace: "bilibili",
          nativeId: "ss80300",
          variantDescription: "原声",
          segments: [
            {
              season: 1,
              episodeStart: 1,
              episodeEnd: null,
              targetEpisodeStart: 1,
              baseline: "tmdb",
              nonLinear: true,
            },
          ],
        }),
      }),
    );
    expect(okRes.status).toBe(201);
    const okCr = (await okRes.json()) as { changeRequest: { id: string } };

    // Wrong year (2024 collection submitted for S1 2023) with nonLinear: true -> needs_review!
    const badYearRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": user.submitKey },
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:200300",
          namespace: "bilibili",
          nativeId: "ss80301",
          variantDescription: "错年份变体",
          segments: [
            {
              season: 1,
              episodeStart: 1,
              episodeEnd: null,
              targetEpisodeStart: 1,
              baseline: "tmdb",
              nonLinear: true,
            },
          ],
        }),
      }),
    );
    expect(badYearRes.status).toBe(201);
    const badYearCr = (await badYearRes.json()) as { changeRequest: { id: string } };

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
        enableDailyTmdbSync: false,
        enableExplorationScheduling: false,
      },
      now: () => t0,
    });

    expect(await drainEvidenceJobs(worker, emitted, t0)).toBe(2);

    const okState = (await (
      await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests/${okCr.changeRequest.id}`, {
          headers: { "x-api-key": user.readKey },
        }),
      )
    ).json()) as { changeRequest: { status: string } };
    expect(okState.changeRequest.status).toBe("approved");

    const badYearState = (await (
      await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests/${badYearCr.changeRequest.id}`, {
          headers: { "x-api-key": user.readKey },
        }),
      )
    ).json()) as { changeRequest: { status: string; conflictReason: string | null } };
    expect(badYearState.changeRequest.status).toBe("needs_review");
    expect(badYearState.changeRequest.conflictReason).toBe("segment_year_mismatch");

    const mediaBody = (await (
      await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:200300`, {
          headers: { "x-api-key": user.readKey },
        }),
      )
    ).json()) as { document: MediaDocument };
    expect(
      resolveEpisode(mediaBody.document, { namespace: "bilibili", season: 1, episode: 4 }),
    ).toMatchObject({ kind: "collection_only", reason: "non_linear", nativeId: "ss80300" });
  });

  test("routes non-original setDefaultVariant=true to needs_review while promoting neutral first variant and allowing non-default dub", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-24T07:00:00.000Z");
    const outbound = createFakeOutboundClient({ fetchExternal: createStep2Stub() });
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => t0,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });
    const user = await setupVerifiedUserAndKeys(app, outbound, "step2-variant@example.com");

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
        enableDailyTmdbSync: false,
        enableExplorationScheduling: false,
      },
      now: () => t0,
    });

    // 1. Brand-new non-original variant ("中配") explicitly marked setDefaultVariant: true -> needs_review
    const dubDefaultRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": user.submitKey },
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:95479",
          namespace: "bilibili",
          nativeId: "ss34432",
          variantDescription: "中配",
          setDefaultVariant: true,
          segments: [
            { season: 1, episodeStart: 1, episodeEnd: 24, targetEpisodeStart: 1, baseline: "tmdb" },
          ],
        }),
      }),
    );
    expect(dubDefaultRes.status).toBe(201);
    const dubDefaultCr = (await dubDefaultRes.json()) as { changeRequest: { id: string } };

    expect(await drainEvidenceJobs(worker, emitted, t0)).toBe(1);
    const dubDefaultState = (await (
      await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests/${dubDefaultCr.changeRequest.id}`, {
          headers: { "x-api-key": user.readKey },
        }),
      )
    ).json()) as { changeRequest: { status: string; conflictReason: string | null } };
    expect(dubDefaultState.changeRequest).toMatchObject({
      status: "needs_review",
      conflictReason: "non_original_default_variant",
    });

    // 2. Neutral first variant ("标准版") auto-approves and becomes default
    const neutralRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": user.submitKey },
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:95479",
          namespace: "bilibili",
          nativeId: "ss34430",
          variantDescription: "标准版",
          setDefaultVariant: false,
          segments: [
            { season: 1, episodeStart: 1, episodeEnd: 24, targetEpisodeStart: 1, baseline: "tmdb" },
          ],
        }),
      }),
    );
    expect(neutralRes.status).toBe(201);
    const neutralCr = (await neutralRes.json()) as { changeRequest: { id: string } };

    expect(await drainEvidenceJobs(worker, emitted, t0)).toBe(1);
    const neutralState = (await (
      await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests/${neutralCr.changeRequest.id}`, {
          headers: { "x-api-key": user.readKey },
        }),
      )
    ).json()) as { changeRequest: { status: string } };
    expect(neutralState.changeRequest.status).toBe("approved");

    // 3. Adding "中配" with setDefaultVariant: false auto-approves as non-default
    const dubNonDefaultRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": user.submitKey },
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:95479",
          namespace: "bilibili",
          nativeId: "ss34432",
          variantDescription: "中配",
          setDefaultVariant: false,
          segments: [
            { season: 1, episodeStart: 1, episodeEnd: 24, targetEpisodeStart: 1, baseline: "tmdb" },
          ],
        }),
      }),
    );
    expect(dubNonDefaultRes.status).toBe(201);
    const dubNonDefaultCr = (await dubNonDefaultRes.json()) as { changeRequest: { id: string } };

    expect(await drainEvidenceJobs(worker, emitted, t0)).toBe(1);
    const dubNonDefaultState = (await (
      await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests/${dubNonDefaultCr.changeRequest.id}`, {
          headers: { "x-api-key": user.readKey },
        }),
      )
    ).json()) as { changeRequest: { status: string } };
    expect(dubNonDefaultState.changeRequest.status).toBe("approved");

    const mediaAfterDub = (await (
      await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:95479`, {
          headers: { "x-api-key": user.readKey },
        }),
      )
    ).json()) as { document: MediaDocument };
    const neutralVariant = mediaAfterDub.document.variants.find((v) => v.label === "标准版");
    const dubVariant = mediaAfterDub.document.variants.find((v) => v.label === "中配");
    expect(neutralVariant?.isDefault).toBe(true);
    expect(dubVariant?.isDefault).toBe(false);

    // 4a. Submitting a new collection (S2 ss45600) referencing dub variantId with setDefaultVariant: true -> needs_review (non_original_default_variant)
    const newColOverrideRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": user.submitKey },
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:95479",
          namespace: "bilibili",
          nativeId: "ss45600",
          variantId: dubVariant!.id,
          setDefaultVariant: true,
          segments: [
            { season: 2, episodeStart: 1, episodeEnd: 23, targetEpisodeStart: 1, baseline: "tmdb" },
          ],
        }),
      }),
    );
    expect(newColOverrideRes.status).toBe(201);
    const newColOverrideCr = (await newColOverrideRes.json()) as { changeRequest: { id: string } };

    expect(await drainEvidenceJobs(worker, emitted, t0)).toBe(1);
    const newColOverrideState = (await (
      await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests/${newColOverrideCr.changeRequest.id}`, {
          headers: { "x-api-key": user.readKey },
        }),
      )
    ).json()) as { changeRequest: { status: string; conflictReason: string | null } };
    expect(newColOverrideState.changeRequest).toMatchObject({
      status: "needs_review",
      conflictReason: "non_original_default_variant",
    });

    // 4b. Re-submitting already-confirmed ss34432 with dub variantId and setDefaultVariant: true -> conflict re-check catches Step 2 non_original_default_variant
    const overrideRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": user.submitKey },
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:95479",
          namespace: "bilibili",
          nativeId: "ss34432",
          variantId: dubVariant!.id,
          setDefaultVariant: true,
          segments: [
            { season: 1, episodeStart: 1, episodeEnd: 24, targetEpisodeStart: 1, baseline: "tmdb" },
          ],
        }),
      }),
    );
    expect(overrideRes.status).toBe(201);
    const overrideCr = (await overrideRes.json()) as { changeRequest: { id: string } };

    expect(await drainEvidenceJobs(worker, emitted, t0)).toBe(1);
    const overrideState = (await (
      await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests/${overrideCr.changeRequest.id}`, {
          headers: { "x-api-key": user.readKey },
        }),
      )
    ).json()) as {
      changeRequest: {
        status: string;
        conflictReason: string | null;
        evidence: {
          gate?: {
            decision?: string;
            step2?: { conflicts?: Array<{ code: string }> };
          };
        } | null;
      };
    };
    expect(overrideState.changeRequest).toMatchObject({
      status: "needs_review",
      conflictReason: "new_failed_old_passed",
    });
    expect(overrideState.changeRequest.evidence?.gate?.step2?.conflicts?.[0]?.code).toBe(
      "non_original_default_variant",
    );

    // Default variant remains unchanged ("标准版")
    const mediaFinal = (await (
      await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:95479`, {
          headers: { "x-api-key": user.readKey },
        }),
      )
    ).json()) as { document: MediaDocument };
    expect(mediaFinal.document.variants.find((v) => v.label === "标准版")?.isDefault).toBe(true);
    expect(mediaFinal.document.variants.find((v) => v.label === "中配")?.isDefault).toBe(false);
  });
});
