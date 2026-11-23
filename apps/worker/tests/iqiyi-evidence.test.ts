import type { Message, MessageBatch, ScheduledController } from "@cloudflare/workers-types";
import { createApiApp } from "@media-ref/api/app";
import { resolveEpisode, type MediaDocument } from "@media-ref/client";
import {
  createFakeOutboundClient,
  type EmailMessage,
  type ExternalHttpRequest,
  type ExternalHttpResponse,
  type JobQueueMessage,
} from "@media-ref/core";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { createBackgroundWorker } from "../src/index.ts";

const TEST_BASE_URL = "https://api.mediaref.org";
const TEST_AUTH_SECRET = "test-secret-for-iqiyi-evidence-integration-tests-0123456789abcdef";

function jsonResponse(url: string, payload: unknown, status = 200): ExternalHttpResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
    url,
  };
}

function htmlResponse(url: string, html: string, status = 200): ExternalHttpResponse {
  return {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: html,
    url,
  };
}

function makeIqiyiEpisodes(startOrder: number, count: number, includeTrailers = true) {
  const list: Array<Record<string, unknown>> = [];
  for (let i = 0; i < count; i += 1) {
    const order = startOrder + i;
    list.push({
      tvId: 3493131456000000 + order * 100,
      order,
      name: `狂飙第${order}集`,
      shortTitle: `第${order}集`,
      contentType: 1,
      duration: "45:00",
      period: "2023-01-14",
      effective: true,
    });
  }
  if (includeTrailers) {
    list.push({
      tvId: 888800000100 + startOrder,
      order: 900 + startOrder,
      name: "下集预告",
      shortTitle: "预告",
      contentType: 3,
      duration: "01:20",
      period: "2023-01-14",
      effective: true,
    });
  }
  return list;
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
        name: "iQIYI Tester",
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

function createDefaultIqiyiAndTmdbStub() {
  return (request: ExternalHttpRequest): ExternalHttpResponse => {
    if (request.kind === "catalog" && request.namespace === "tmdb") {
      if (request.url.includes("/tv/218574")) {
        return jsonResponse(request.url, {
          id: 218574,
          name: "狂飙",
          original_name: "狂飙",
          first_air_date: "2023-01-14",
          seasons: [{ season_number: 1, episode_count: 39, air_date: "2023-01-14" }],
          external_ids: {
            imdb_id: "tt26448858",
            tvdb_id: 429999,
          },
        });
      }
      if (request.url.includes("/movie/535167")) {
        return jsonResponse(request.url, {
          id: 535167,
          title: "流浪地球",
          original_title: "流浪地球",
          release_date: "2019-02-05",
          external_ids: {
            imdb_id: "tt7605074",
          },
        });
      }
      return jsonResponse(request.url, { status_code: 34, status_message: "Not found" }, 404);
    }

    if (request.kind === "catalog" && request.namespace === "trakt") {
      return jsonResponse(request.url, []);
    }

    if (request.kind === "platform" && request.namespace === "iqiyi") {
      // Desktop share URL rewritten to mobile SSR
      if (request.url === "https://m.iqiyi.com/v_xkt6z3z798.html") {
        return htmlResponse(
          request.url,
          `<!doctype html><html><body><script>window.__INITIAL_STATE__={"playPageInfo":{"albumId":5328486914190101,"qipuId":3493131456125200}};</script></body></html>`,
        );
      }
      // Album SSR page
      if (request.url === "https://www.iqiyi.com/a_1fkgtbddd2x.html") {
        return htmlResponse(
          request.url,
          `<!doctype html><html><body><script>window.__INITIAL_STATE__={"albumInfo":{"albumId":5328486914190101,"name":"狂飙"}};</script></body></html>`,
        );
      }
      // SPA shell with no IDs
      if (request.url === "https://m.iqiyi.com/v_spashell00.html") {
        return htmlResponse(
          request.url,
          `<!doctype html><html><head><title>爱奇艺</title></head><body><div id="app"></div></body></html>`,
        );
      }
      // Movie share URL -> mobile SSR with qipuId only -> normalized via video/video/baseinfo
      if (request.url === "https://m.iqiyi.com/v_19rrfe142o.html") {
        return htmlResponse(
          request.url,
          `<!doctype html><html><body><script>window.__DATA__={"qipuId":923452300};</script></body></html>`,
        );
      }

      // TV album baseinfo + avlistinfo (39 feature episodes + trailers)
      if (request.url === "https://pcw-api.iqiyi.com/album/album/baseinfo/5328486914190101") {
        return jsonResponse(request.url, {
          code: "A00000",
          data: {
            albumId: 5328486914190101,
            name: "狂飙",
            channelId: 2,
            videoCount: 39,
            period: "2026-09-21",
            publishTime: 1673625600000,
            firstVideo: { period: "2023-01-14" },
          },
        });
      }
      if (
        request.url ===
        "https://pcw-api.iqiyi.com/albums/album/avlistinfo?aid=5328486914190101&page=1&size=50"
      ) {
        return jsonResponse(request.url, {
          code: "A00000",
          data: {
            total: 40,
            hasMore: false,
            epsodelist: makeIqiyiEpisodes(1, 39, true),
          },
        });
      }

      // Movie baseinfo (00-suffix)
      if (request.url === "https://pcw-api.iqiyi.com/video/video/baseinfo/923452300") {
        return jsonResponse(request.url, {
          code: "A00000",
          data: {
            tvId: 923452300,
            albumId: 923452300,
            name: "流浪地球",
            channelId: 1,
            period: "2019-02-05",
            publishTime: 1549296000000,
            videoCount: 1,
            contentType: 1,
            duration: 7500,
          },
        });
      }

      // Missing premiere year on TV album (data.period is set to 2023-02-01, but firstVideo.period & publishTime absent!)
      if (request.url === "https://pcw-api.iqiyi.com/album/album/baseinfo/700000001") {
        return jsonResponse(request.url, {
          code: "A00000",
          data: {
            albumId: 700000001,
            name: "狂飙",
            channelId: 2,
            period: "2023-02-01",
          },
        });
      }
      if (
        request.url ===
        "https://pcw-api.iqiyi.com/albums/album/avlistinfo?aid=700000001&page=1&size=50"
      ) {
        return jsonResponse(request.url, {
          code: "A00000",
          data: {
            hasMore: false,
            epsodelist: makeIqiyiEpisodes(1, 39, false),
          },
        });
      }

      // Missing feature episodes (trailer-only epsodelist)
      if (request.url === "https://pcw-api.iqiyi.com/album/album/baseinfo/700000002") {
        return jsonResponse(request.url, {
          code: "A00000",
          data: {
            albumId: 700000002,
            name: "狂飙",
            channelId: 2,
            firstVideo: { period: "2023-01-14" },
          },
        });
      }
      if (
        request.url ===
        "https://pcw-api.iqiyi.com/albums/album/avlistinfo?aid=700000002&page=1&size=50"
      ) {
        return jsonResponse(request.url, {
          code: "A00000",
          data: {
            hasMore: false,
            epsodelist: [{ tvId: 700000200, order: 1, name: "狂飙预告", contentType: 3 }],
          },
        });
      }
    }

    throw new Error(
      `Unexpected outbound request: ${request.kind}:${request.namespace} ${request.url}`,
    );
  };
}

describe("iQIYI adapter end-to-end evidence pipeline (#14)", () => {
  const handles: TestDbHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop();
      if (handle) {
        await handle.cleanup();
      }
    }
  });

  test("submits desktop v_ share URL, stores canonical albumId, auto-approves via scheduled + queue, and serves via GET /v1/media", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-24T00:00:00.000Z");
    const outbound = createFakeOutboundClient({
      fetchExternal: createDefaultIqiyiAndTmdbStub(),
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

    const user = await setupVerifiedUserAndKeys(app, outbound, "iqiyi-submitter@example.com");

    // 1. Unparseable iQIYI URLs and SPA shells missing IDs are rejected with 400 INVALID_NATIVE_ID
    for (const badInput of [
      "https://www.iqiyi.com/u/12345",
      "https://evil.example.com/a_1fkgtbddd2x.html",
      "https://www.iqiyi.com/v_spashell00.html",
      "123",
    ]) {
      const badRes = await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": user.submitKey },
          body: JSON.stringify({
            targetExternalKey: "tmdb:tv:218574",
            namespace: "iqiyi",
            nativeId: badInput,
            variantDescription: "原声",
            segments: [
              {
                season: 1,
                episodeStart: 1,
                episodeEnd: 39,
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

    // 2. Submit desktop v_ share URL -> rewritten to m.iqiyi.com -> canonical albumId stored
    const shareUrl = "https://www.iqiyi.com/v_xkt6z3z798.html?vfrm=pcw_home";
    const tvSubmitRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": user.submitKey },
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:218574",
          namespace: "iqiyi",
          nativeId: shareUrl,
          variantDescription: "原声",
          segments: [
            {
              season: 1,
              episodeStart: 1,
              episodeEnd: 39,
              targetEpisodeStart: 1,
              baseline: "tmdb",
            },
          ],
        }),
      }),
    );
    expect(tvSubmitRes.status).toBe(201);
    const tvSubmitBody = (await tvSubmitRes.json()) as {
      changeRequest: {
        id: string;
        status: string;
        rawNativeId: string;
        nativeId: string;
      };
    };
    expect(tvSubmitBody.changeRequest.status).toBe("pending_evidence");
    expect(tvSubmitBody.changeRequest.rawNativeId).toBe(shareUrl);
    expect(tvSubmitBody.changeRequest.nativeId).toBe("5328486914190101");

    // Also submit movie share URL -> m.iqiyi.com -> video/baseinfo -> 923452300
    const movieShareUrl = "https://www.iqiyi.com/v_19rrfe142o.html";
    const movieSubmitRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": user.submitKey },
        body: JSON.stringify({
          targetExternalKey: "tmdb:movie:535167",
          namespace: "iqiyi",
          nativeId: movieShareUrl,
          variantDescription: "原声",
          segments: [],
        }),
      }),
    );
    expect(movieSubmitRes.status).toBe(201);
    const movieSubmitBody = (await movieSubmitRes.json()) as {
      changeRequest: {
        id: string;
        status: string;
        rawNativeId: string;
        nativeId: string;
      };
    };
    expect(movieSubmitBody.changeRequest.status).toBe("pending_evidence");
    expect(movieSubmitBody.changeRequest.rawNativeId).toBe(movieShareUrl);
    expect(movieSubmitBody.changeRequest.nativeId).toBe("923452300");

    // 3. Run Background Worker scheduled -> queue
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
    const { batch, tracked } = createQueueBatch(emitted, t0);
    const summary = await worker.queue(batch);
    expect(summary.completed).toBe(2);
    expect(tracked.every((t) => t.acked)).toBe(true);

    // 4. Both change requests are auto-approved
    for (const crId of [tvSubmitBody.changeRequest.id, movieSubmitBody.changeRequest.id]) {
      const crRes = await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests/${crId}`, {
          headers: { "x-api-key": user.readKey },
        }),
      );
      expect(crRes.status).toBe(200);
      const crBody = (await crRes.json()) as {
        changeRequest: {
          status: string;
          reviewerUserId: string | null;
          decisionReason: string | null;
        };
      };
      expect(crBody.changeRequest.status).toBe("approved");
      expect(crBody.changeRequest.reviewerUserId).toBeNull();
      expect(crBody.changeRequest.decisionReason).toBe("evidence_gate_passed");
    }

    // 5. TV media document is readable via TMDB key & iQIYI canonical key, and works with resolveEpisode
    const tvReadRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:218574`, {
        headers: { "x-api-key": user.readKey },
      }),
    );
    expect(tvReadRes.status).toBe(200);
    const tvDoc = ((await tvReadRes.json()) as { document: MediaDocument }).document;
    expect(tvDoc.associations).toHaveLength(1);
    expect(tvDoc.associations[0]).toMatchObject({
      namespace: "iqiyi",
      nativeId: "5328486914190101",
      status: "confirmed",
    });
    expect(resolveEpisode(tvDoc, { namespace: "iqiyi", season: 1, episode: 15 })).toMatchObject({
      kind: "mapped",
      nativeId: "5328486914190101",
      targetEpisode: 15,
    });

    const reverseReadRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/iqiyi:5328486914190101`, {
        headers: { "x-api-key": user.readKey },
      }),
    );
    expect(reverseReadRes.status).toBe(200);

    // 6. Movie document is readable via TMDB key
    const movieReadRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:movie:535167`, {
        headers: { "x-api-key": user.readKey },
      }),
    );
    expect(movieReadRes.status).toBe(200);
    const movieDoc = ((await movieReadRes.json()) as { document: MediaDocument }).document;
    expect(movieDoc.associations[0]).toMatchObject({
      namespace: "iqiyi",
      nativeId: "923452300",
      status: "confirmed",
    });

    // Verify every iQIYI outbound request carried kind="platform", namespace="iqiyi"
    const iqiyiRequests = outbound.httpRequests.filter((r) => r.url.includes("iqiyi.com"));
    expect(iqiyiRequests.length).toBeGreaterThan(0);
    expect(iqiyiRequests.every((r) => r.kind === "platform" && r.namespace === "iqiyi")).toBe(true);
  });

  test("routes submissions with missing year or missing feature episode count to needs_review instead of auto-approving", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-24T01:00:00.000Z");
    const outbound = createFakeOutboundClient({
      fetchExternal: createDefaultIqiyiAndTmdbStub(),
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

    const user = await setupVerifiedUserAndKeys(app, outbound, "iqiyi-missing-fields@example.com");

    // 1. Missing premiere year on TV album (700000001)
    const noYearRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": user.submitKey },
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:218574",
          namespace: "iqiyi",
          nativeId: "700000001",
          variantDescription: "原声",
          segments: [
            { season: 1, episodeStart: 1, episodeEnd: 39, targetEpisodeStart: 1, baseline: "tmdb" },
          ],
        }),
      }),
    );
    expect(noYearRes.status).toBe(201);
    const noYearCr = (await noYearRes.json()) as { changeRequest: { id: string } };

    // 2. Trailer-only / missing feature episode count (700000002)
    const noEpsRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": user.submitKey },
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:218574",
          namespace: "iqiyi",
          nativeId: "700000002",
          variantDescription: "原声",
          segments: [
            { season: 1, episodeStart: 1, episodeEnd: 39, targetEpisodeStart: 1, baseline: "tmdb" },
          ],
        }),
      }),
    );
    expect(noEpsRes.status).toBe(201);
    const noEpsCr = (await noEpsRes.json()) as { changeRequest: { id: string } };

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
    const summary = await worker.queue(createQueueBatch(emitted, t0).batch);
    expect(summary.completed).toBe(2);

    const noYearInspect = (await (
      await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests/${noYearCr.changeRequest.id}`, {
          headers: { "x-api-key": user.readKey },
        }),
      )
    ).json()) as { changeRequest: { status: string; conflictReason: string | null } };
    expect(noYearInspect.changeRequest.status).toBe("needs_review");
    expect(noYearInspect.changeRequest.conflictReason).toBe("year_missing");

    const noEpsInspect = (await (
      await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests/${noEpsCr.changeRequest.id}`, {
          headers: { "x-api-key": user.readKey },
        }),
      )
    ).json()) as { changeRequest: { status: string; conflictReason: string | null } };
    expect(noEpsInspect.changeRequest.status).toBe("needs_review");
    expect(noEpsInspect.changeRequest.conflictReason).toBe("episode_count_missing");

    // Neither change request appears in default GET /v1/media
    const mediaRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:218574`, {
        headers: { "x-api-key": user.readKey },
      }),
    );
    expect(mediaRes.status).toBe(404);
  });

  test("retries transient iQIYI 503 errors while keeping change request in pending_evidence until recovery", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    let now = new Date("2026-11-24T02:00:00.000Z");
    let albumCalls = 0;
    const baseStub = createDefaultIqiyiAndTmdbStub();

    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        if (
          request.namespace === "iqiyi" &&
          request.url.includes("album/album/baseinfo/5328486914190101")
        ) {
          albumCalls += 1;
          if (albumCalls === 1) {
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

    const user = await setupVerifiedUserAndKeys(app, outbound, "iqiyi-retry@example.com");

    const submitRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": user.submitKey },
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:218574",
          namespace: "iqiyi",
          nativeId: "https://www.iqiyi.com/a_1fkgtbddd2x.html",
          variantDescription: "原声",
          segments: [
            { season: 1, episodeStart: 1, episodeEnd: 39, targetEpisodeStart: 1, baseline: "tmdb" },
          ],
        }),
      }),
    );
    expect(submitRes.status).toBe(201);
    const { changeRequest } = (await submitRes.json()) as {
      changeRequest: { id: string; nativeId: string };
    };
    expect(changeRequest.nativeId).toBe("5328486914190101");

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

    // Attempt 1: 503 -> rescheduled, CR remains pending_evidence
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

    // Attempt 2 after backoff: upstream recovers -> auto-approved!
    now = new Date(now.getTime() + 30_000);
    await worker.scheduled(createScheduledController(now));
    expect(emitted).toHaveLength(1);
    const attempt2 = await worker.queue(createQueueBatch([emitted.shift()!], now).batch);
    expect(attempt2.completed).toBe(1);

    const afterAttempt2 = (await (
      await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests/${changeRequest.id}`, {
          headers: { "x-api-key": user.readKey },
        }),
      )
    ).json()) as { changeRequest: { status: string } };
    expect(afterAttempt2.changeRequest.status).toBe("approved");
  });
});
