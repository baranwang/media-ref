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
const TEST_AUTH_SECRET = "test-secret-for-youku-evidence-integration-tests-0123456789abcdef";

const YOUKU_SHOW_COMPLETE_TV = "c8e2a1b4d5f60718293a";
const YOUKU_SHOW_MOVIE = "a1b2c3d4e5f60718293b";
const YOUKU_SHOW_GEO_LOCKED = "cc001f06962411de83b1";
const YOUKU_SHOW_TRUNCATED_LONG = "bbac165ee82549779af3";
const YOUKU_SHOW_MISSING_YEAR = "dd112233445566778899";
const YOUKU_SHOW_NOT_FOUND = "00000000000000000000";
const YOUKU_SHOW_FLAKY_RETRY = "ee1122334455667788aa";

function jsonResponse(url: string, payload: unknown, status = 200): ExternalHttpResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
    url,
  };
}

function htmlResponse(url: string, body: string, status = 200): ExternalHttpResponse {
  return {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
    body,
    url,
  };
}

function buildYoukuSsrHtml(initialData: unknown, title = "优酷"): string {
  return `<!doctype html><html><head><title>${title}</title></head><body><script>window.__INITIAL_DATA__ = ${JSON.stringify(initialData)};</script></body></html>`;
}

function makeYoukuFeatureItems(count: number, includeNonFeature = true) {
  const items: Array<Record<string, unknown>> = [];
  for (let i = 1; i <= count; i += 1) {
    items.push({
      id: String(200_000 + i),
      action_value: `XEPISODE${i}`,
      title: `第${i}集`,
      stage: i,
      stageIndex: i - 1,
      videoType: "正片",
      mark: { text: i > 1 ? "VIP" : "" },
    });
  }
  if (includeNonFeature) {
    items.push({
      id: "990001",
      action_value: "XTRAILER01",
      title: "预告片",
      videoType: "预告片",
      mark: { text: "预告" },
    });
    items.push({
      id: "990002",
      action_value: "XEXTRA01",
      title: "幕后花絮",
      videoType: "花絮",
      mark: { text: "花絮" },
    });
    items.push({
      id: "990003",
      action_value: "XHIGHLIGHT01",
      title: "精彩看点",
      videoType: "精彩看点",
      mark: { text: "" },
    });
  }
  return items;
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
        name: "Youku Tester",
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

  const submitKeyRes = await app.fetch(
    new Request(`${TEST_BASE_URL}/v1/api-keys`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Submit Key", canSubmit: true }),
    }),
  );
  expect(submitKeyRes.status).toBe(201);
  const submitKey = (await submitKeyRes.json()) as { key: string };

  const readKeyRes = await app.fetch(
    new Request(`${TEST_BASE_URL}/v1/api-keys`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Read Key", canSubmit: false }),
    }),
  );
  expect(readKeyRes.status).toBe(201);
  const readKey = (await readKeyRes.json()) as { key: string };

  return {
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

function createYoukuAndTmdbStub() {
  return (request: ExternalHttpRequest): ExternalHttpResponse => {
    if (request.kind === "catalog" && request.namespace === "tmdb") {
      if (request.url.includes("/tv/73618")) {
        return jsonResponse(request.url, {
          id: 73618,
          name: "白夜追凶",
          original_name: "白夜追凶",
          first_air_date: "2017-08-30",
          seasons: [{ season_number: 1, episode_count: 32, air_date: "2017-08-30" }],
          external_ids: {
            imdb_id: "tt7344032",
            tvdb_id: 334912,
          },
        });
      }
      if (request.url.includes("/tv/31910")) {
        return jsonResponse(request.url, {
          id: 31910,
          name: "火影忍者",
          original_name: "NARUTO -ナルト-",
          first_air_date: "2002-10-03",
          seasons: [{ season_number: 1, episode_count: 720, air_date: "2002-10-03" }],
          external_ids: {
            imdb_id: "tt0409591",
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
      if (request.url.includes("/tv/219001")) {
        return jsonResponse(request.url, {
          id: 219001,
          name: "边水往事",
          original_name: "边水往事",
          first_air_date: "2024-08-16",
          seasons: [{ season_number: 1, episode_count: 21, air_date: "2024-08-16" }],
          external_ids: {
            imdb_id: "tt33129100",
          },
        });
      }
      return jsonResponse(request.url, { status_code: 34, status_message: "Not found" }, 404);
    }

    if (request.kind === "catalog" && request.namespace === "trakt") {
      return jsonResponse(request.url, []);
    }

    if (request.kind === "platform" && request.namespace === "youku") {
      if (request.url === "https://v.youku.com/v_show/id_XMzAwMDAwMDE=.html") {
        return htmlResponse(
          request.url,
          buildYoukuSsrHtml({
            pageMap: {
              extra: {
                showId: `z${YOUKU_SHOW_COMPLETE_TV}`,
                showName: "白夜追凶",
              },
            },
          }),
        );
      }

      if (request.url === `https://list.youku.com/show/id_z${YOUKU_SHOW_COMPLETE_TV}.html`) {
        return htmlResponse(
          request.url,
          buildYoukuSsrHtml({
            pageMap: {
              extra: {
                showId: YOUKU_SHOW_COMPLETE_TV,
                showName: "白夜追凶",
                showReleaseTime: "2017-08-30 20:00:00",
                showCategory: "电视剧",
                showCategoryId: 97,
                episodeTotal: 32,
                episodeLast: 32,
                completed: true,
              },
            },
            moduleList: [
              {
                components: [
                  {
                    type: 10013,
                    componentId: "pc_detail_kuflix_anthology",
                    pageSize: 60,
                    pageIndex: 1,
                    itemList: makeYoukuFeatureItems(32, true),
                  },
                ],
              },
            ],
          }),
        );
      }

      if (request.url === `https://list.youku.com/show/id_z${YOUKU_SHOW_MOVIE}.html`) {
        return htmlResponse(
          request.url,
          buildYoukuSsrHtml({
            pageMap: {
              extra: {
                showId: YOUKU_SHOW_MOVIE,
                showName: "流浪地球",
                showReleaseTime: "2019-02-05",
                showCategory: "电影",
                showCategoryId: 96,
                episodeTotal: 1,
                episodeLast: 1,
                completed: true,
              },
            },
            moduleList: [
              {
                components: [
                  {
                    type: 10013,
                    itemList: makeYoukuFeatureItems(1, true),
                  },
                ],
              },
            ],
          }),
        );
      }

      if (request.url === `https://list.youku.com/show/id_z${YOUKU_SHOW_GEO_LOCKED}.html`) {
        // Region-locked overseas response: only 预告片 items, episodeLast: 0
        return htmlResponse(
          request.url,
          buildYoukuSsrHtml({
            pageMap: {
              extra: {
                showId: YOUKU_SHOW_GEO_LOCKED,
                showName: "火影忍者",
                showReleaseTime: "2002-10-03",
                showCategory: "动漫",
                episodeTotal: 720,
                episodeLast: 0,
                completed: true,
              },
            },
            moduleList: [
              {
                components: [
                  {
                    type: 10013,
                    pageSize: 60,
                    pageIndex: 1,
                    itemList: [
                      {
                        action_value: "XTR1",
                        title: "第1集预告",
                        videoType: "预告片",
                        mark: { text: "预告" },
                      },
                      {
                        action_value: "XTR2",
                        title: "第2集预告",
                        videoType: "预告片",
                        mark: { text: "预告" },
                      },
                    ],
                  },
                ],
              },
            ],
          }),
        );
      }

      if (request.url === `https://list.youku.com/show/id_z${YOUKU_SHOW_TRUNCATED_LONG}.html`) {
        // Long series (>60 episodes): SSR page 1 only embeds 60 正片 items
        return htmlResponse(
          request.url,
          buildYoukuSsrHtml({
            pageMap: {
              extra: {
                showId: YOUKU_SHOW_TRUNCATED_LONG,
                showName: "火影忍者",
                showReleaseTime: "2002-10-03",
                showCategory: "动漫",
                episodeTotal: 720,
                episodeLast: 720,
                completed: true,
              },
            },
            moduleList: [
              {
                components: [
                  {
                    type: 10013,
                    pageSize: 60,
                    pageIndex: 1,
                    itemList: makeYoukuFeatureItems(60, false),
                  },
                ],
              },
            ],
          }),
        );
      }

      if (request.url === `https://list.youku.com/show/id_z${YOUKU_SHOW_MISSING_YEAR}.html`) {
        // Missing showReleaseTime -> year: null -> must route to needs_review
        return htmlResponse(
          request.url,
          buildYoukuSsrHtml({
            pageMap: {
              extra: {
                showId: YOUKU_SHOW_MISSING_YEAR,
                showName: "白夜追凶",
                showCategory: "电视剧",
                episodeTotal: 32,
                episodeLast: 32,
              },
            },
            moduleList: [
              {
                components: [
                  {
                    type: 10013,
                    pageSize: 60,
                    pageIndex: 1,
                    itemList: makeYoukuFeatureItems(32, false),
                  },
                ],
              },
            ],
          }),
        );
      }

      if (request.url === `https://list.youku.com/show/id_z${YOUKU_SHOW_NOT_FOUND}.html`) {
        return htmlResponse(
          request.url,
          "<!doctype html><html><head><title>404 Not Found</title></head><body>Not Found</body></html>",
          200,
        );
      }

      if (request.url === `https://list.youku.com/show/id_z${YOUKU_SHOW_FLAKY_RETRY}.html`) {
        return htmlResponse(
          request.url,
          buildYoukuSsrHtml({
            pageMap: {
              extra: {
                showId: YOUKU_SHOW_FLAKY_RETRY,
                showName: "边水往事",
                showReleaseTime: "2024-08-16 12:00:00",
                showCategory: "电视剧",
                episodeTotal: 21,
                episodeLast: 21,
                completed: true,
              },
            },
            moduleList: [
              {
                components: [
                  {
                    type: 10013,
                    pageSize: 60,
                    pageIndex: 1,
                    itemList: makeYoukuFeatureItems(21, true),
                  },
                ],
              },
            ],
          }),
        );
      }
    }

    throw new Error(
      `Unexpected outbound request: ${request.kind}:${request.namespace} ${request.url}`,
    );
  };
}

describe("Youku adapter (Tier 1-2) end-to-end evidence check (#15)", () => {
  const handles: TestDbHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop();
      if (handle) {
        await handle.cleanup();
      }
    }
  });

  test("canonicalizes Youku URLs/IDs to 20-hex showId on submit, rejects invalid inputs, and auto-approves complete matching TV and movie collections", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-23T18:00:00.000Z");
    const outbound = createFakeOutboundClient({
      fetchExternal: createYoukuAndTmdbStub(),
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
        submitBaseHourlyLimit: 20,
      },
    });

    const user = await setupVerifiedUserAndKeys(app, outbound, "youku-submitter@example.com");

    // 1. Invalid Youku URLs/IDs are immediately rejected with 400 INVALID_NATIVE_ID
    for (const badInput of [
      "https://so.youku.com/search_video/q_白夜追凶",
      "https://evil.example.com/show/id_zc8e2a1b4d5f60718293a.html",
      "id_zc8e2a1b4d5f60718293a",
      "short123",
    ]) {
      const badRes = await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": user.submitKey },
          body: JSON.stringify({
            targetExternalKey: "tmdb:tv:73618",
            namespace: "youku",
            nativeId: badInput,
            variantDescription: "原声",
            segments: [
              {
                season: 1,
                episodeStart: 1,
                episodeEnd: 32,
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

    // 2. All valid Youku URL/ID variants canonicalize to 20-char lowercase hex showId without leading z
    const urlVariants = [
      `https://list.youku.com/show/id_z${YOUKU_SHOW_COMPLETE_TV}.html`,
      `https://m.youku.com/show/id_z${YOUKU_SHOW_COMPLETE_TV.toUpperCase()}.html?from=share`,
      "https://v.youku.com/v_show/id_XMzAwMDAwMDE=.html",
      `z${YOUKU_SHOW_COMPLETE_TV}`,
      YOUKU_SHOW_COMPLETE_TV,
    ];

    const submittedTvIds: string[] = [];
    for (const rawInput of urlVariants) {
      const res = await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": user.submitKey },
          body: JSON.stringify({
            targetExternalKey: "tmdb:tv:73618",
            namespace: "youku",
            nativeId: rawInput,
            variantDescription: "原声",
            segments: [
              {
                season: 1,
                episodeStart: 1,
                episodeEnd: 32,
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
      expect(body.changeRequest.nativeId).toBe(YOUKU_SHOW_COMPLETE_TV);
      submittedTvIds.push(body.changeRequest.id);
    }

    // Also submit a Youku movie URL
    const movieSubmitRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": user.submitKey },
        body: JSON.stringify({
          targetExternalKey: "tmdb:movie:535167",
          namespace: "youku",
          nativeId: `https://list.youku.com/show/id_z${YOUKU_SHOW_MOVIE}.html`,
          variantDescription: "原声",
          segments: [],
        }),
      }),
    );
    expect(movieSubmitRes.status).toBe(201);
    const movieCr = (await movieSubmitRes.json()) as {
      changeRequest: { id: string; nativeId: string; status: string };
    };
    expect(movieCr.changeRequest.nativeId).toBe(YOUKU_SHOW_MOVIE);
    expect(movieCr.changeRequest.status).toBe("pending_evidence");

    // 3. Run Background Worker scheduled -> queue for first TV CR and movie CR
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
    const tvMsg = emitted.find(
      (msg) =>
        msg.jobType === "evidence_check" && msg.payload.changeRequestId === submittedTvIds[0],
    );
    const movieMsg = emitted.find(
      (msg) =>
        msg.jobType === "evidence_check" &&
        msg.payload.changeRequestId === movieCr.changeRequest.id,
    );
    expect(tvMsg).toBeDefined();
    expect(movieMsg).toBeDefined();

    const { batch, tracked } = createQueueBatch([tvMsg!, movieMsg!], t0);
    const summary = await worker.queue(batch);
    expect(summary.completed).toBe(2);
    expect(tracked.every((entry) => entry.acked)).toBe(true);

    // 4. Verify TV change request auto-approved and readable via GET /v1/media + resolveEpisode
    const tvCrStatus = (await (
      await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests/${submittedTvIds[0]}`, {
          headers: { "x-api-key": user.readKey },
        }),
      )
    ).json()) as {
      changeRequest: {
        status: string;
        reviewerUserId: string | null;
        decisionReason: string | null;
      };
    };
    expect(tvCrStatus.changeRequest.status).toBe("approved");
    expect(tvCrStatus.changeRequest.reviewerUserId).toBeNull();
    expect(tvCrStatus.changeRequest.decisionReason).toBe("evidence_gate_passed");

    const tvMediaRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:73618`, {
        headers: { "x-api-key": user.readKey },
      }),
    );
    expect(tvMediaRes.status).toBe(200);
    const tvMediaBody = (await tvMediaRes.json()) as { document: MediaDocument };
    expect(tvMediaBody.document.associations).toHaveLength(1);
    expect(tvMediaBody.document.associations[0]).toMatchObject({
      namespace: "youku",
      nativeId: YOUKU_SHOW_COMPLETE_TV,
      status: "confirmed",
    });
    expect(
      resolveEpisode(tvMediaBody.document, { namespace: "youku", season: 1, episode: 15 }),
    ).toMatchObject({
      kind: "mapped",
      nativeId: YOUKU_SHOW_COMPLETE_TV,
      targetEpisode: 15,
    });

    // 5. Verify Movie change request auto-approved and readable
    const movieMediaRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:movie:535167`, {
        headers: { "x-api-key": user.readKey },
      }),
    );
    expect(movieMediaRes.status).toBe(200);
    const movieMediaBody = (await movieMediaRes.json()) as { document: MediaDocument };
    expect(movieMediaBody.document.associations[0]).toMatchObject({
      namespace: "youku",
      nativeId: YOUKU_SHOW_MOVIE,
      status: "confirmed",
    });
  });

  test("routes region-locked trailer-only, >60-episode truncated, missing-year, and 404 Youku collections to needs_review instead of auto-approving", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-23T19:00:00.000Z");
    const outbound = createFakeOutboundClient({
      fetchExternal: createYoukuAndTmdbStub(),
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
        submitBaseHourlyLimit: 20,
      },
    });

    const user = await setupVerifiedUserAndKeys(app, outbound, "youku-caveats@example.com");

    const submitCr = async (payload: {
      targetExternalKey: string;
      nativeId: string;
      episodeEnd: number;
    }) => {
      const res = await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": user.submitKey },
          body: JSON.stringify({
            targetExternalKey: payload.targetExternalKey,
            namespace: "youku",
            nativeId: payload.nativeId,
            variantDescription: "原声",
            segments: [
              {
                season: 1,
                episodeStart: 1,
                episodeEnd: payload.episodeEnd,
                targetEpisodeStart: 1,
                baseline: "tmdb",
              },
            ],
          }),
        }),
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as { changeRequest: { id: string } };
      return body.changeRequest.id;
    };

    const geoLockedCrId = await submitCr({
      targetExternalKey: "tmdb:tv:31910",
      nativeId: `https://list.youku.com/show/id_z${YOUKU_SHOW_GEO_LOCKED}.html`,
      episodeEnd: 720,
    });
    const truncatedCrId = await submitCr({
      targetExternalKey: "tmdb:tv:31910",
      nativeId: `https://list.youku.com/show/id_z${YOUKU_SHOW_TRUNCATED_LONG}.html`,
      episodeEnd: 720,
    });
    const missingYearCrId = await submitCr({
      targetExternalKey: "tmdb:tv:73618",
      nativeId: `https://list.youku.com/show/id_z${YOUKU_SHOW_MISSING_YEAR}.html`,
      episodeEnd: 32,
    });
    const notFoundCrId = await submitCr({
      targetExternalKey: "tmdb:tv:73618",
      nativeId: `https://list.youku.com/show/id_z${YOUKU_SHOW_NOT_FOUND}.html`,
      episodeEnd: 32,
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
      config: { tmdb: { accessToken: "test-tmdb-token" } },
      now: () => t0,
    });

    await worker.scheduled(createScheduledController(t0));
    expect(emitted).toHaveLength(4);
    const summary = await worker.queue(createQueueBatch(emitted, t0).batch);
    expect(summary.completed).toBe(4);

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
          evidence: {
            collection?: { featureEpisodeCount?: number | null; year?: number | null };
          } | null;
        };
      };
    };

    const geoInspect = await inspectCr(geoLockedCrId);
    expect(geoInspect.changeRequest.status).toBe("needs_review");
    expect(geoInspect.changeRequest.conflictReason).toBe("episode_count_missing");
    expect(geoInspect.changeRequest.evidence?.collection?.featureEpisodeCount).toBeNull();

    const truncatedInspect = await inspectCr(truncatedCrId);
    expect(truncatedInspect.changeRequest.status).toBe("needs_review");
    expect(truncatedInspect.changeRequest.conflictReason).toBe("episode_count_missing");
    expect(truncatedInspect.changeRequest.evidence?.collection?.featureEpisodeCount).toBeNull();

    const missingYearInspect = await inspectCr(missingYearCrId);
    expect(missingYearInspect.changeRequest.status).toBe("needs_review");
    expect(missingYearInspect.changeRequest.conflictReason).toBe("year_missing");
    expect(missingYearInspect.changeRequest.evidence?.collection?.year).toBeNull();

    const notFoundInspect = await inspectCr(notFoundCrId);
    expect(notFoundInspect.changeRequest.status).toBe("needs_review");
    expect(notFoundInspect.changeRequest.conflictReason).toBe("collection_not_found");

    // None of the needs_review submissions appear in default read API
    for (const key of ["tmdb:tv:31910", "tmdb:tv:73618"]) {
      const readRes = await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/media/${key}`, {
          headers: { "x-api-key": user.readKey },
        }),
      );
      expect(readRes.status).toBe(404);
    }
  });

  test("retries Alibaba CAPTCHA and 5xx responses while keeping change request in pending_evidence until recovery", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-23T20:00:00.000Z");
    let now = t0;
    let youkuCalls = 0;
    const baseStub = createYoukuAndTmdbStub();

    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        if (
          request.namespace === "youku" &&
          request.url.includes(`id_z${YOUKU_SHOW_FLAKY_RETRY}.html`)
        ) {
          youkuCalls += 1;
          if (youkuCalls === 1) {
            return htmlResponse(
              "https://list.youku.com/show/_____tmd_____/punish?x5secdata=test",
              '<html><script>window._config_={"action":"captcha"};</script></html>',
              200,
            );
          }
          if (youkuCalls === 2) {
            return htmlResponse(request.url, "Upstream 503", 503);
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

    const user = await setupVerifiedUserAndKeys(app, outbound, "youku-retry@example.com");

    const submitRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": user.submitKey },
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:219001",
          namespace: "youku",
          nativeId: `https://list.youku.com/show/id_z${YOUKU_SHOW_FLAKY_RETRY}.html`,
          variantDescription: "原声",
          segments: [
            { season: 1, episodeStart: 1, episodeEnd: 21, targetEpisodeStart: 1, baseline: "tmdb" },
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

    // Attempt 1: CAPTCHA -> rescheduled, CR remains pending_evidence
    await worker.scheduled(createScheduledController(now));
    expect(emitted).toHaveLength(1);
    const attempt1 = await worker.queue(createQueueBatch([emitted.shift()!], now).batch);
    expect(attempt1.rescheduled).toBe(1);

    const status1 = (await (
      await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests/${changeRequest.id}`, {
          headers: { "x-api-key": user.readKey },
        }),
      )
    ).json()) as { changeRequest: { status: string } };
    expect(status1.changeRequest.status).toBe("pending_evidence");

    // Attempt 2: HTTP 503 -> rescheduled, CR remains pending_evidence
    now = new Date(now.getTime() + 30_000);
    await worker.scheduled(createScheduledController(now));
    expect(emitted).toHaveLength(1);
    const attempt2 = await worker.queue(createQueueBatch([emitted.shift()!], now).batch);
    expect(attempt2.rescheduled).toBe(1);

    const status2 = (await (
      await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests/${changeRequest.id}`, {
          headers: { "x-api-key": user.readKey },
        }),
      )
    ).json()) as { changeRequest: { status: string } };
    expect(status2.changeRequest.status).toBe("pending_evidence");

    // Attempt 3: clean SSR response -> auto-approved!
    now = new Date(now.getTime() + 30_000);
    await worker.scheduled(createScheduledController(now));
    expect(emitted).toHaveLength(1);
    const attempt3 = await worker.queue(createQueueBatch([emitted.shift()!], now).batch);
    expect(attempt3.completed).toBe(1);

    const status3 = (await (
      await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests/${changeRequest.id}`, {
          headers: { "x-api-key": user.readKey },
        }),
      )
    ).json()) as { changeRequest: { status: string } };
    expect(status3.changeRequest.status).toBe("approved");

    const mediaRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:219001`, {
        headers: { "x-api-key": user.readKey },
      }),
    );
    expect(mediaRes.status).toBe(200);
    const mediaBody = (await mediaRes.json()) as { document: MediaDocument };
    expect(mediaBody.document.associations[0]?.nativeId).toBe(YOUKU_SHOW_FLAKY_RETRY);
  });
});
