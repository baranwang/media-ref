import type { Message, MessageBatch, ScheduledController } from "@cloudflare/workers-types";
import { createApiApp } from "@media-ref/api/app";
import { resolveEpisode } from "@media-ref/client";
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
  fromProtoChangeRequestStatus,
  getChangeRequestStateRpc,
  getMediaDocumentRpc,
  issueApiKeyRpc,
  mediaRef,
  signUpAndVerifyUser,
  TEST_BASE_URL,
  toProtoSegmentInput,
} from "./rpc-helpers.ts";

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

/** Feature episodes as the open API's `shows/videos.json` lists them. */
function makeYoukuVideos(count: number, from = 1) {
  return Array.from({ length: count }, (_, i) => ({
    id: `XEPISODE${from + i}`,
    seq: String(from + i),
    title: `第${from + i}集`,
    duration: "2700.00",
    published: "2017-08-30 20:00:00",
  }));
}

/** Show metadata (`shows/show.json`) and episode total for each stubbed show. */
const YOUKU_SHOWS: Record<string, { show: Record<string, unknown>; episodes: number }> = {
  [YOUKU_SHOW_COMPLETE_TV]: {
    show: { name: "白夜追凶", category: "电视剧", released: "2017-08-30" },
    episodes: 32,
  },
  [YOUKU_SHOW_MOVIE]: {
    show: { name: "流浪地球", category: "电影", released: "2019-02-05" },
    episodes: 1,
  },
  // Expired copyright: the show exists but lists no episodes.
  [YOUKU_SHOW_GEO_LOCKED]: {
    show: { name: "火影忍者", category: "动漫", released: "2002-10-03" },
    episodes: 0,
  },
  // Longer than the 20 pages of 100 the adapter reads.
  [YOUKU_SHOW_TRUNCATED_LONG]: {
    show: { name: "火影忍者", category: "动漫", released: "2002-10-03" },
    episodes: 2100,
  },
  [YOUKU_SHOW_MISSING_YEAR]: {
    show: { name: "白夜追凶", category: "电视剧" },
    episodes: 32,
  },
  [YOUKU_SHOW_FLAKY_RETRY]: {
    show: { name: "边水往事", category: "电视剧", released: "2024-08-16" },
    episodes: 21,
  },
};

function youkuOpenApiResponse(url: string): ExternalHttpResponse {
  const parsed = new URL(url);
  const params = parsed.searchParams;
  if (parsed.pathname === "/v2/videos/show.json") {
    return params.get("video_id") === "XMzAwMDAwMDE="
      ? jsonResponse(url, { id: "XMzAwMDAwMDE=", show: { id: YOUKU_SHOW_COMPLETE_TV } })
      : jsonResponse(url, { error: { code: 120020101, description: "invalid ID" } });
  }
  const entry = YOUKU_SHOWS[params.get("show_id") ?? ""];
  if (!entry) {
    return jsonResponse(url, []);
  }
  if (parsed.pathname === "/v2/shows/show.json") {
    return jsonResponse(url, { id: params.get("show_id"), ...entry.show });
  }
  const size = Number(params.get("count"));
  const from = (Number(params.get("page")) - 1) * size + 1;
  return jsonResponse(url, {
    total: String(entry.episodes),
    videos: makeYoukuVideos(Math.max(0, Math.min(size, entry.episodes - from + 1)), from),
  });
}

async function setupVerifiedUserAndKeys(
  app: ReturnType<typeof createApiApp>,
  outbound: ReturnType<typeof createFakeOutboundClient>,
  email: string,
) {
  const { cookie } = await signUpAndVerifyUser(app, outbound, {
    email,
    name: "Youku Tester",
  });
  const submitKey = await issueApiKeyRpc(app, cookie, { name: "Submit Key", canSubmit: true });
  const readKey = await issueApiKeyRpc(app, cookie, { name: "Read Key", canSubmit: false });

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

    if (
      request.kind === "platform" &&
      request.namespace === "youku" &&
      request.url.startsWith("https://openapi.youku.com/v2/")
    ) {
      return youkuOpenApiResponse(request.url);
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
    const submitRpc = createRpcClients(app, { apiKey: user.submitKey });

    // 1. Invalid Youku URLs/IDs are immediately rejected with 400 INVALID_NATIVE_ID
    for (const badInput of [
      "https://so.youku.com/search_video/q_白夜追凶",
      "https://evil.example.com/show/id_zc8e2a1b4d5f60718293a.html",
      "id_zc8e2a1b4d5f60718293a",
      "short123",
    ]) {
      const badErr = await expectRpcError(
        submitRpc.changeRequest.createChangeRequest({
          target: mediaRef("tmdb:tv:73618"),
          namespace: "youku",
          nativeId: badInput,
          variantDescription: "原声",
          segments: [
            toProtoSegmentInput({
              season: 1,
              episodeStart: 1,
              episodeEnd: 32,
              targetEpisodeStart: 1,
              baseline: "tmdb",
            }),
          ],
        }),
      );
      expect(badErr.status).toBe(400);
      expect(badErr.code).toBe("INVALID_NATIVE_ID");
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
    for (const [index, rawInput] of urlVariants.entries()) {
      const res = await submitRpc.changeRequest.createChangeRequest({
        target: mediaRef("tmdb:tv:73618"),
        namespace: "youku",
        nativeId: rawInput,
        variantDescription: index === 0 ? "原声" : `原声-${index}`,
        segments: [
          toProtoSegmentInput({
            season: 1,
            episodeStart: 1,
            episodeEnd: 32,
            targetEpisodeStart: 1,
            baseline: "tmdb",
          }),
        ],
      });
      const cr = res.changeRequest!;
      expect(fromProtoChangeRequestStatus(cr.status)).toBe("pending_evidence");
      expect(cr.rawNativeId).toBe(rawInput);
      expect(cr.nativeId).toBe(YOUKU_SHOW_COMPLETE_TV);
      submittedTvIds.push(cr.id);
    }

    // Also submit a Youku movie URL
    const movieSubmitRes = await submitRpc.changeRequest.createChangeRequest({
      target: mediaRef("tmdb:movie:535167"),
      namespace: "youku",
      nativeId: `https://list.youku.com/show/id_z${YOUKU_SHOW_MOVIE}.html`,
      variantDescription: "原声",
      segments: [],
    });
    const movieCr = movieSubmitRes.changeRequest!;
    expect(movieCr.nativeId).toBe(YOUKU_SHOW_MOVIE);
    expect(fromProtoChangeRequestStatus(movieCr.status)).toBe("pending_evidence");

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
      (msg) => msg.jobType === "evidence_check" && msg.payload.changeRequestId === movieCr.id,
    );
    expect(tvMsg).toBeDefined();
    expect(movieMsg).toBeDefined();

    const { batch, tracked } = createQueueBatch([tvMsg!, movieMsg!], t0);
    const summary = await worker.queue(batch);
    expect(summary.completed).toBe(2);
    expect(tracked.every((entry) => entry.acked)).toBe(true);

    // 4. Verify TV change request auto-approved and readable via MediaService.GetMedia + resolveEpisode
    const tvCrStatus = await getChangeRequestStateRpc(
      app,
      { apiKey: user.readKey },
      submittedTvIds[0]!,
    );
    expect(tvCrStatus.status).toBe("approved");
    expect(tvCrStatus.reviewerUserId).toBeNull();
    expect(tvCrStatus.decisionReason).toBe("evidence_gate_passed");

    const tvMediaBody = await getMediaDocumentRpc(app, user.readKey, "tmdb:tv:73618");
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
    const movieMediaBody = await getMediaDocumentRpc(app, user.readKey, "tmdb:movie:535167");
    expect(movieMediaBody.document.associations[0]).toMatchObject({
      namespace: "youku",
      nativeId: YOUKU_SHOW_MOVIE,
      status: "confirmed",
    });
  });

  test("routes empty, over-long, missing-year, and unknown Youku collections to needs_review instead of auto-approving", async () => {
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
    const submitRpc = createRpcClients(app, { apiKey: user.submitKey });

    const submitCr = async (payload: {
      targetExternalKey: string;
      nativeId: string;
      episodeEnd: number;
    }) => {
      const res = await submitRpc.changeRequest.createChangeRequest({
        target: mediaRef(payload.targetExternalKey),
        namespace: "youku",
        nativeId: payload.nativeId,
        variantDescription: "原声",
        segments: [
          toProtoSegmentInput({
            season: 1,
            episodeStart: 1,
            episodeEnd: payload.episodeEnd,
            targetEpisodeStart: 1,
            baseline: "tmdb",
          }),
        ],
      });
      return res.changeRequest!.id;
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
      const cr = await getChangeRequestStateRpc(app, { apiKey: user.readKey }, id);
      return cr as typeof cr & {
        evidence: {
          collection?: { featureEpisodeCount?: number | null; year?: number | null };
        } | null;
      };
    };

    const geoInspect = await inspectCr(geoLockedCrId);
    expect(geoInspect.status).toBe("needs_review");
    expect(geoInspect.conflictReason).toBe("segment_episode_count_missing");
    expect(geoInspect.evidence?.collection?.featureEpisodeCount).toBeNull();

    const truncatedInspect = await inspectCr(truncatedCrId);
    expect(truncatedInspect.status).toBe("needs_review");
    expect(truncatedInspect.conflictReason).toBe("segment_episode_count_missing");
    expect(truncatedInspect.evidence?.collection?.featureEpisodeCount).toBeNull();

    const missingYearInspect = await inspectCr(missingYearCrId);
    expect(missingYearInspect.status).toBe("needs_review");
    expect(missingYearInspect.conflictReason).toBe("year_missing");
    expect(missingYearInspect.evidence?.collection?.year).toBeNull();

    const notFoundInspect = await inspectCr(notFoundCrId);
    expect(notFoundInspect.status).toBe("needs_review");
    expect(notFoundInspect.conflictReason).toBe("collection_not_found");

    // None of the needs_review submissions appear in default read API
    for (const key of ["tmdb:tv:31910", "tmdb:tv:73618"]) {
      const readErr = await expectRpcError(getMediaDocumentRpc(app, user.readKey, key));
      expect(readErr.status).toBe(404);
    }
  });

  test("retries Youku API errors and 5xx responses while keeping change request in pending_evidence until recovery", async () => {
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
          request.url.includes("/v2/shows/show.json") &&
          request.url.includes(`show_id=${YOUKU_SHOW_FLAKY_RETRY}`)
        ) {
          youkuCalls += 1;
          if (youkuCalls === 1) {
            return jsonResponse(request.url, {
              error: { code: 1012, type: "SystemException", description: "Service busy" },
            });
          }
          if (youkuCalls === 2) {
            return jsonResponse(request.url, "Upstream 503", 503);
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
    const submitRpc = createRpcClients(app, { apiKey: user.submitKey });

    const submitRes = await submitRpc.changeRequest.createChangeRequest({
      target: mediaRef("tmdb:tv:219001"),
      namespace: "youku",
      nativeId: `https://list.youku.com/show/id_z${YOUKU_SHOW_FLAKY_RETRY}.html`,
      variantDescription: "原声",
      segments: [
        toProtoSegmentInput({
          season: 1,
          episodeStart: 1,
          episodeEnd: 21,
          targetEpisodeStart: 1,
          baseline: "tmdb",
        }),
      ],
    });
    const changeRequest = submitRes.changeRequest!;

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

    // Attempt 1: API error -> rescheduled, CR remains pending_evidence
    await worker.scheduled(createScheduledController(now));
    expect(emitted).toHaveLength(1);
    const attempt1 = await worker.queue(createQueueBatch([emitted.shift()!], now).batch);
    expect(attempt1.rescheduled).toBe(1);

    const status1 = await getChangeRequestStateRpc(app, { apiKey: user.readKey }, changeRequest.id);
    expect(status1.status).toBe("pending_evidence");

    // Attempt 2: HTTP 503 -> rescheduled, CR remains pending_evidence
    now = new Date(now.getTime() + 30_000);
    await worker.scheduled(createScheduledController(now));
    expect(emitted).toHaveLength(1);
    const attempt2 = await worker.queue(createQueueBatch([emitted.shift()!], now).batch);
    expect(attempt2.rescheduled).toBe(1);

    const status2 = await getChangeRequestStateRpc(app, { apiKey: user.readKey }, changeRequest.id);
    expect(status2.status).toBe("pending_evidence");

    // Attempt 3: clean response -> auto-approved!
    now = new Date(now.getTime() + 30_000);
    await worker.scheduled(createScheduledController(now));
    expect(emitted).toHaveLength(1);
    const attempt3 = await worker.queue(createQueueBatch([emitted.shift()!], now).batch);
    expect(attempt3.completed).toBe(1);

    const status3 = await getChangeRequestStateRpc(app, { apiKey: user.readKey }, changeRequest.id);
    expect(status3.status).toBe("approved");

    const mediaBody = await getMediaDocumentRpc(app, user.readKey, "tmdb:tv:219001");
    expect(mediaBody.document.associations[0]?.nativeId).toBe(YOUKU_SHOW_FLAKY_RETRY);
  });
});
