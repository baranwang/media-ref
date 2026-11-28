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
import { changeRequestFromProto } from "../../website/src/lib/mappers.ts";
import {
  buildExternalUrl,
  contributionLinkFields,
  parseExternalInput,
} from "../../website/src/lib/url-parser.ts";
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

async function setupVerifiedUserAndKeys(
  app: ReturnType<typeof createApiApp>,
  outbound: ReturnType<typeof createFakeOutboundClient>,
  email: string,
) {
  const { userId, cookie } = await signUpAndVerifyUser(app, outbound, {
    email,
    name: "iQIYI Tester",
  });
  const submitKey = await issueApiKeyRpc(app, cookie, { name: "Submit Key", canSubmit: true });
  const readKey = await issueApiKeyRpc(app, cookie, { name: "Read Key", canSubmit: false });

  return {
    userId,
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

  test("submits desktop v_ share URL, stores canonical albumId, auto-approves via scheduled + queue, and serves via MediaService.GetMedia", async () => {
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
    const submitRpc = createRpcClients(app, { apiKey: user.submitKey });

    // 1. Unparseable iQIYI URLs and SPA shells missing IDs are rejected with 400 INVALID_NATIVE_ID
    for (const badInput of [
      "https://www.iqiyi.com/u/12345",
      "https://evil.example.com/a_1fkgtbddd2x.html",
      "https://www.iqiyi.com/v_spashell00.html",
      "123",
    ]) {
      const badErr = await expectRpcError(
        submitRpc.changeRequest.createChangeRequest({
          target: mediaRef({ tmdb: { type: "tv", id: 218574 } }),
          namespace: "iqiyi",
          nativeId: badInput,
          variantDescription: "原声",
          segments: [
            toProtoSegmentInput({
              season: 1,
              episodeStart: 1,
              episodeEnd: 39,
              targetEpisodeStart: 1,
              baseline: "tmdb",
            }),
          ],
        }),
      );
      expect(badErr.status).toBe(400);
      expect(badErr.code).toBe("INVALID_NATIVE_ID");
    }

    // 2. Submit desktop v_ share URL -> rewritten to m.iqiyi.com -> canonical albumId stored
    const shareUrl = "https://www.iqiyi.com/v_xkt6z3z798.html?vfrm=pcw_home";
    const episodeUrl = "https://www.iqiyi.com/v_xkt6z3z798.html";
    const fields = contributionLinkFields(parseExternalInput(shareUrl)!);
    const tvSubmitBody = await submitRpc.changeRequest.createChangeRequest({
      target: mediaRef({ tmdb: { type: "tv", id: 218574 } }),
      ...fields,
      variantDescription: "原声",
      segments: [
        toProtoSegmentInput({
          season: 1,
          episodeStart: 1,
          episodeEnd: 39,
          targetEpisodeStart: 1,
          baseline: "tmdb",
        }),
      ],
    });
    expect(fromProtoChangeRequestStatus(tvSubmitBody.changeRequest!.status)).toBe(
      "pending_evidence",
    );
    const detailResponse = await submitRpc.changeRequest.getChangeRequest({
      id: tvSubmitBody.changeRequest!.id,
    });
    expect(changeRequestFromProto(detailResponse.changeRequest!).pageLink).toEqual({
      href: episodeUrl,
      source: "entry",
    });
    expect(fields).toEqual({ namespace: "iqiyi", nativeId: episodeUrl, rawNativeId: episodeUrl });
    expect(tvSubmitBody.changeRequest!.rawNativeId).toBe(episodeUrl);
    expect(tvSubmitBody.changeRequest!.nativeId).toBe("5328486914190101");

    const episodePage = {
      namespace: "iqiyi",
      nativeId: "5328486914190101",
      kind: "video_page",
      id: "xkt6z3z798",
    };
    expect(tvSubmitBody.changeRequest!.evidence).toMatchObject({ resolvedPage: episodePage });

    // Also submit movie share URL -> m.iqiyi.com -> video/baseinfo -> 923452300
    const movieShareUrl = "https://www.iqiyi.com/v_19rrfe142o.html";
    const movieSubmitBody = await submitRpc.changeRequest.createChangeRequest({
      target: mediaRef({ tmdb: { type: "movie", id: 535167 } }),
      namespace: "iqiyi",
      nativeId: movieShareUrl,
      variantDescription: "原声",
      segments: [],
    });
    expect(fromProtoChangeRequestStatus(movieSubmitBody.changeRequest!.status)).toBe(
      "pending_evidence",
    );
    expect(movieSubmitBody.changeRequest!.rawNativeId).toBe(movieShareUrl);
    expect(movieSubmitBody.changeRequest!.nativeId).toBe("923452300");

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
    for (const crId of [tvSubmitBody.changeRequest!.id, movieSubmitBody.changeRequest!.id]) {
      const crBody = await getChangeRequestStateRpc(app, { apiKey: user.readKey }, crId);
      expect(crBody.status).toBe("approved");
      if (crId === tvSubmitBody.changeRequest!.id)
        expect(crBody.evidence).toMatchObject({ resolvedPage: episodePage });
      expect(crBody.reviewerUserId).toBeNull();
      expect(crBody.decisionReason).toBe("evidence_gate_passed");
    }

    // 5. TV media document is readable via TMDB ref & iQIYI canonical ref, and works with resolveEpisode
    const { document: tvDoc } = await getMediaDocumentRpc(app, user.readKey, {
      tmdb: { type: "tv", id: 218574 },
    });
    expect(tvDoc.associations).toHaveLength(1);
    expect(tvDoc.associations[0]).toMatchObject({
      namespace: "iqiyi",
      nativeId: "5328486914190101",
      status: "confirmed",
    });
    expect(buildExternalUrl("iqiyi", tvDoc.associations[0]!.nativeId)).toBe(
      "https://www.iqiyi.com/a_1fkgtbddd2x.html",
    );
    expect(resolveEpisode(tvDoc, { namespace: "iqiyi", season: 1, episode: 15 })).toMatchObject({
      kind: "mapped",
      nativeId: "5328486914190101",
      targetEpisode: 15,
    });

    const reverseRead = await getMediaDocumentRpc(app, user.readKey, {
      platform: { platform: "iqiyi", nativeId: "5328486914190101" },
    });
    expect(reverseRead.document.media.id).toBe(tvDoc.media.id);

    // 6. Movie document is readable via TMDB ref
    const { document: movieDoc } = await getMediaDocumentRpc(app, user.readKey, {
      tmdb: { type: "movie", id: 535167 },
    });
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
    const submitRpc = createRpcClients(app, { apiKey: user.submitKey });
    const readRpc = createRpcClients(app, { apiKey: user.readKey });

    // 1. Missing premiere year on TV album (700000001)
    const noYearCr = await submitRpc.changeRequest.createChangeRequest({
      target: mediaRef({ tmdb: { type: "tv", id: 218574 } }),
      namespace: "iqiyi",
      nativeId: "700000001",
      variantDescription: "原声",
      segments: [
        toProtoSegmentInput({
          season: 1,
          episodeStart: 1,
          episodeEnd: 39,
          targetEpisodeStart: 1,
          baseline: "tmdb",
        }),
      ],
    });

    // 2. Trailer-only / missing feature episode count (700000002)
    const noEpsCr = await submitRpc.changeRequest.createChangeRequest({
      target: mediaRef({ tmdb: { type: "tv", id: 218574 } }),
      namespace: "iqiyi",
      nativeId: "700000002",
      variantDescription: "原声",
      segments: [
        toProtoSegmentInput({
          season: 1,
          episodeStart: 1,
          episodeEnd: 39,
          targetEpisodeStart: 1,
          baseline: "tmdb",
        }),
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
      config: { tmdb: { accessToken: "test-tmdb-token" } },
      now: () => t0,
    });

    await worker.scheduled(createScheduledController(t0));
    expect(emitted).toHaveLength(2);
    const summary = await worker.queue(createQueueBatch(emitted, t0).batch);
    expect(summary.completed).toBe(2);

    const noYearInspect = await getChangeRequestStateRpc(
      app,
      { apiKey: user.readKey },
      noYearCr.changeRequest!.id,
    );
    expect(noYearInspect.status).toBe("needs_review");
    expect(noYearInspect.conflictReason).toBe("year_missing");

    const noEpsInspect = await getChangeRequestStateRpc(
      app,
      { apiKey: user.readKey },
      noEpsCr.changeRequest!.id,
    );
    expect(noEpsInspect.status).toBe("needs_review");
    expect(noEpsInspect.conflictReason).toBe("segment_episode_count_missing");

    // Neither change request appears in default MediaService.GetMedia
    expect(
      (
        await expectRpcError(
          readRpc.media.getMedia({ ref: mediaRef({ tmdb: { type: "tv", id: 218574 } }) }),
        )
      ).status,
    ).toBe(404);
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
    const submitRpc = createRpcClients(app, { apiKey: user.submitKey });

    const { changeRequest } = await submitRpc.changeRequest.createChangeRequest({
      target: mediaRef({ tmdb: { type: "tv", id: 218574 } }),
      namespace: "iqiyi",
      nativeId: "https://www.iqiyi.com/a_1fkgtbddd2x.html",
      variantDescription: "原声",
      segments: [
        toProtoSegmentInput({
          season: 1,
          episodeStart: 1,
          episodeEnd: 39,
          targetEpisodeStart: 1,
          baseline: "tmdb",
        }),
      ],
    });
    expect(changeRequest!.nativeId).toBe("5328486914190101");

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

    expect(
      (await getChangeRequestStateRpc(app, { apiKey: user.readKey }, changeRequest!.id)).status,
    ).toBe("pending_evidence");

    // Attempt 2 after backoff: upstream recovers -> auto-approved!
    now = new Date(now.getTime() + 30_000);
    await worker.scheduled(createScheduledController(now));
    expect(emitted).toHaveLength(1);
    const attempt2 = await worker.queue(createQueueBatch([emitted.shift()!], now).batch);
    expect(attempt2.completed).toBe(1);

    expect(
      (await getChangeRequestStateRpc(app, { apiKey: user.readKey }, changeRequest!.id)).status,
    ).toBe("approved");
  });
});
