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

const TEST_AUTH_SECRET = "test-secret-for-mgtv-evidence-integration-tests-0123456789abcdef";

function jsonResponse(url: string, payload: unknown, status = 200): ExternalHttpResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
    url,
  };
}

function makeMgtvEpisodeItem(
  collectionId: string,
  videoId: number,
  options: {
    isIntact: "1" | "3";
    t1: string;
    t2?: string;
    t3?: string;
    ts?: string;
    time?: string;
  },
) {
  return {
    video_id: String(videoId),
    clip_id: collectionId,
    t1: options.t1,
    t2: options.t2 ?? "",
    t3: options.t3 ?? `第${options.t1}集`,
    ts: options.ts ?? "2023-01-03 20:00:00",
    time: options.time ?? "45:00",
    url: `/b/${collectionId}/${videoId}.html`,
    isIntact: options.isIntact,
    contentType: "0",
  };
}

async function setupVerifiedUserAndKeys(
  app: ReturnType<typeof createApiApp>,
  outbound: ReturnType<typeof createFakeOutboundClient>,
  email: string,
) {
  const { userId, cookie } = await signUpAndVerifyUser(app, outbound, {
    email,
    name: "Mgtv Tester",
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

function createMgtvAndTmdbStub() {
  // Multi-page fixture modeled on 《去有风的地方》 (510924): 40 feature episodes + 22 previews across 2 pages
  const windyPage1 = [
    ...Array.from({ length: 30 }, (_, idx) =>
      makeMgtvEpisodeItem("510924", 18030368 + idx, {
        isIntact: "1",
        t1: String(idx + 1),
        t3: `去有风的地方 第${idx + 1}集`,
      }),
    ),
    ...Array.from({ length: 20 }, (_, idx) =>
      makeMgtvEpisodeItem("510924", 18039000 + idx, {
        isIntact: "3",
        t1: `预告${idx + 1}`,
        t3: `去有风的地方 预告${idx + 1}`,
      }),
    ),
  ];
  const windyPage2 = [
    ...Array.from({ length: 10 }, (_, idx) =>
      makeMgtvEpisodeItem("510924", 18030398 + idx, {
        isIntact: "1",
        t1: String(31 + idx),
        t3: `去有风的地方 第${31 + idx}集`,
      }),
    ),
    ...Array.from({ length: 2 }, (_, idx) =>
      makeMgtvEpisodeItem("510924", 18039100 + idx, {
        isIntact: "3",
        t1: `花絮${idx + 1}`,
        t3: `去有风的地方 花絮${idx + 1}`,
      }),
    ),
  ];

  return (request: ExternalHttpRequest): ExternalHttpResponse => {
    if (request.kind === "catalog" && request.namespace === "tmdb") {
      if (request.url.includes("/tv/217492")) {
        return jsonResponse(request.url, {
          id: 217492,
          name: "去有风的地方",
          original_name: "去有风的地方",
          first_air_date: "2023-01-03",
          seasons: [{ season_number: 1, episode_count: 40, air_date: "2023-01-03" }],
          external_ids: {
            imdb_id: "tt25433734",
            tvdb_id: 429149,
          },
        });
      }
      if (request.url.includes("/tv/244890")) {
        return jsonResponse(request.url, {
          id: 244890,
          name: "小巷人家",
          original_name: "小巷人家",
          first_air_date: "2024-10-28",
          seasons: [{ season_number: 1, episode_count: 40, air_date: "2024-10-28" }],
          external_ids: {
            imdb_id: "tt33980000",
          },
        });
      }
      return jsonResponse(request.url, { status_code: 34, status_message: "Not found" }, 404);
    }

    if (request.kind === "catalog" && request.namespace === "trakt") {
      return jsonResponse(request.url, []);
    }

    if (request.kind === "platform" && request.namespace === "mgtv") {
      const url = new URL(request.url);
      if (url.pathname === "/episode/list") {
        const cid = url.searchParams.get("collection_id");
        const page = url.searchParams.get("page");

        if (cid === "510924" && page === "1") {
          return jsonResponse(request.url, {
            code: 200,
            msg: "",
            data: {
              total: 40,
              count: 50,
              total_page: 2,
              info: { title: "去有风的地方", type: "电视剧" },
              list: windyPage1,
            },
          });
        }
        if (cid === "510924" && page === "2") {
          return jsonResponse(request.url, {
            code: 200,
            msg: "",
            data: {
              total: 40,
              count: 12,
              total_page: 2,
              info: { title: "去有风的地方", type: "电视剧" },
              list: windyPage2,
            },
          });
        }
        if (cid === "593455") {
          // Missing year case: video/info returns empty releaseTime
          return jsonResponse(request.url, {
            code: 200,
            msg: "",
            data: {
              total: 40,
              count: 40,
              total_page: 1,
              info: { title: "小巷人家", type: "电视剧" },
              list: Array.from({ length: 40 }, (_, idx) =>
                makeMgtvEpisodeItem("593455", 22010001 + idx, {
                  isIntact: "1",
                  t1: String(idx + 1),
                  t3: `小巷人家 第${idx + 1}集`,
                }),
              ),
            },
          });
        }
        if (cid === "593456") {
          // Missing feature episodes case: only previews (isIntact === "3")
          return jsonResponse(request.url, {
            code: 200,
            msg: "",
            data: {
              total: 0,
              count: 2,
              total_page: 1,
              info: { title: "小巷人家", type: "电视剧" },
              list: [
                makeMgtvEpisodeItem("593456", 22020001, { isIntact: "3", t1: "预告1" }),
                makeMgtvEpisodeItem("593456", 22020002, { isIntact: "3", t1: "预告2" }),
              ],
            },
          });
        }
        if (cid === "999999999") {
          return jsonResponse(request.url, {
            code: 200,
            msg: "",
            data: {
              total: 0,
              count: 0,
              total_page: 0,
              info: { title: "" },
              list: [],
            },
          });
        }
      }

      if (url.pathname === "/video/info") {
        const cid = url.searchParams.get("cid");
        if (cid === "510924") {
          return jsonResponse(request.url, {
            code: 200,
            msg: "",
            data: {
              info: {
                clipId: "510924",
                clipName: "去有风的地方",
                fstlvlId: "2",
                fstlvlType: "电视剧",
                detail: {
                  releaseTime: "2023-01-03",
                  updateInfo: "共40集，更新至40集",
                },
              },
            },
          });
        }
        if (cid === "593455") {
          return jsonResponse(request.url, {
            code: 200,
            msg: "",
            data: {
              info: {
                clipId: "593455",
                clipName: "小巷人家",
                fstlvlId: "2",
                fstlvlType: "电视剧",
                detail: {
                  releaseTime: "",
                },
              },
            },
          });
        }
        if (cid === "593456") {
          return jsonResponse(request.url, {
            code: 200,
            msg: "",
            data: {
              info: {
                clipId: "593456",
                clipName: "小巷人家",
                fstlvlId: "2",
                fstlvlType: "电视剧",
                detail: {
                  releaseTime: "2024-10-28",
                },
              },
            },
          });
        }
      }
    }

    throw new Error(
      `Unexpected outbound request: ${request.kind}:${request.namespace} ${request.url}`,
    );
  };
}

describe("Mango TV (mgtv) adapter & Evidence Gate end-to-end (#16)", () => {
  const handles: TestDbHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop();
      if (handle) {
        await handle.cleanup();
      }
    }
  });

  test("canonicalizes Mango TV URLs on submit, rejects invalid URLs, auto-approves via scheduled + queue, and serves via MediaService.GetMedia", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-23T18:00:00.000Z");
    const outbound = createFakeOutboundClient({
      fetchExternal: createMgtvAndTmdbStub(),
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

    const user = await setupVerifiedUserAndKeys(app, outbound, "mgtv-submitter@example.com");
    const submitRpc = createRpcClients(app, { apiKey: user.submitKey });

    // 1. Invalid Mango TV URLs / IDs are rejected with 400 INVALID_NATIVE_ID
    for (const badInput of [
      "https://www.mgtv.com/l/100001.html",
      "https://so.mgtv.com/so?k=test",
      "https://evil.example.com/h/510924.html",
      "mg510924",
    ]) {
      const badErr = await expectRpcError(
        submitRpc.changeRequest.createChangeRequest({
          target: mediaRef({ tmdb: { type: "tv", id: 217492 } }),
          namespace: "mgtv",
          nativeId: badInput,
          variantDescription: "原声",
          segments: [
            toProtoSegmentInput({
              season: 1,
              episodeStart: 1,
              episodeEnd: 40,
              targetEpisodeStart: 1,
              baseline: "tmdb",
            }),
          ],
        }),
      );
      expect(badErr.status).toBe(400);
      expect(badErr.code).toBe("INVALID_NATIVE_ID");
    }

    // 2. Submit Mango TV /b/<id>/<vid>.html, /h/<id>.html, mobile URL, and bare ID -> canonical collection_id stored
    const urlVariants = [
      "https://www.mgtv.com/b/510924/18030368.html",
      "https://m.mgtv.com/b/510924/18030368.html?fpa=1",
      "https://www.mgtv.com/h/510924.html",
      "510924",
    ];
    const submittedIds: string[] = [];
    for (const [index, rawInput] of urlVariants.entries()) {
      const submitBody = await submitRpc.changeRequest.createChangeRequest({
        target: mediaRef({ tmdb: { type: "tv", id: 217492 } }),
        namespace: "mgtv",
        nativeId: rawInput,
        variantDescription: index === 0 ? "原声" : `原声-${index}`,
        segments: [
          toProtoSegmentInput({
            season: 1,
            episodeStart: 1,
            episodeEnd: 40,
            targetEpisodeStart: 1,
            baseline: "tmdb",
          }),
        ],
      });
      expect(fromProtoChangeRequestStatus(submitBody.changeRequest!.status)).toBe(
        "pending_evidence",
      );
      expect(submitBody.changeRequest!.rawNativeId).toBe(rawInput);
      expect(submitBody.changeRequest!.nativeId).toBe("510924");
      submittedIds.push(submitBody.changeRequest!.id);
    }

    // 3. Run Background Worker scheduled -> queue on the /b/<id>/<vid>.html submission
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
    const firstEvidenceMsg = emitted.find(
      (msg) => msg.jobType === "evidence_check" && msg.payload.changeRequestId === submittedIds[0],
    );
    expect(firstEvidenceMsg).toBeDefined();

    const { batch, tracked } = createQueueBatch([firstEvidenceMsg!], t0);
    const summary = await worker.queue(batch);
    expect(summary.completed).toBe(1);
    expect(tracked[0]?.acked).toBe(true);

    // 4. Change request is auto-approved
    const crBody = await getChangeRequestStateRpc(app, { apiKey: user.readKey }, submittedIds[0]!);
    expect(crBody.status).toBe("approved");
    expect(crBody.nativeId).toBe("510924");
    expect(crBody.reviewerUserId).toBeNull();
    expect(crBody.decisionReason).toBe("evidence_gate_passed");

    // 5. Readable via TMDB ref AND reverse lookup via Mango TV ref
    const mediaBody = await getMediaDocumentRpc(app, user.readKey, {
      tmdb: { type: "tv", id: 217492 },
    });
    expect(mediaBody.document.associations).toHaveLength(1);
    expect(mediaBody.document.associations[0]).toMatchObject({
      namespace: "mgtv",
      nativeId: "510924",
      status: "confirmed",
    });
    expect(
      resolveEpisode(mediaBody.document, { namespace: "mgtv", season: 1, episode: 35 }),
    ).toMatchObject({
      kind: "mapped",
      nativeId: "510924",
      targetEpisode: 35,
    });

    const reverseBody = await getMediaDocumentRpc(app, user.readKey, {
      platform: { platform: "mgtv", nativeId: "510924" },
    });
    expect(reverseBody.document.associations[0]?.nativeId).toBe("510924");
  });

  test("routes submissions with missing release year or missing feature episode count to needs_review instead of auto-approving", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-23T19:00:00.000Z");
    const outbound = createFakeOutboundClient({
      fetchExternal: createMgtvAndTmdbStub(),
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

    const user = await setupVerifiedUserAndKeys(app, outbound, "mgtv-missing@example.com");
    const submitRpc = createRpcClients(app, { apiKey: user.submitKey });
    const readRpc = createRpcClients(app, { apiKey: user.readKey });

    // 1. Missing releaseTime in video/info -> year: null -> needs_review (year_missing)
    const missingYearCr = await submitRpc.changeRequest.createChangeRequest({
      target: mediaRef({ tmdb: { type: "tv", id: 244890 } }),
      namespace: "mgtv",
      nativeId: "https://www.mgtv.com/h/593455.html",
      variantDescription: "原声",
      segments: [
        toProtoSegmentInput({
          season: 1,
          episodeStart: 1,
          episodeEnd: 40,
          targetEpisodeStart: 1,
          baseline: "tmdb",
        }),
      ],
    });

    // 2. Only preview items (isIntact === "3") -> featureEpisodeCount: null -> needs_review (episode_count_missing)
    const missingEpsCr = await submitRpc.changeRequest.createChangeRequest({
      target: mediaRef({ tmdb: { type: "tv", id: 244890 } }),
      namespace: "mgtv",
      nativeId: "https://www.mgtv.com/b/593456/22020001.html",
      variantDescription: "原声",
      segments: [
        toProtoSegmentInput({
          season: 1,
          episodeStart: 1,
          episodeEnd: 40,
          targetEpisodeStart: 1,
          baseline: "tmdb",
        }),
      ],
    });

    // 3. Collection not found on Mango TV -> needs_review (collection_not_found)
    const notFoundCr = await submitRpc.changeRequest.createChangeRequest({
      target: mediaRef({ tmdb: { type: "tv", id: 244890 } }),
      namespace: "mgtv",
      nativeId: "999999999",
      variantDescription: "原声",
      segments: [
        toProtoSegmentInput({
          season: 1,
          episodeStart: 1,
          episodeEnd: 40,
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
    expect(emitted).toHaveLength(3);

    const summary = await worker.queue(createQueueBatch(emitted, t0).batch);
    expect(summary.completed).toBe(3);

    expect(
      await getChangeRequestStateRpc(
        app,
        { apiKey: user.readKey },
        missingYearCr.changeRequest!.id,
      ),
    ).toMatchObject({
      status: "needs_review",
      conflictReason: "year_missing",
    });
    expect(
      await getChangeRequestStateRpc(app, { apiKey: user.readKey }, missingEpsCr.changeRequest!.id),
    ).toMatchObject({
      status: "needs_review",
      conflictReason: "episode_count_missing",
    });
    expect(
      await getChangeRequestStateRpc(app, { apiKey: user.readKey }, notFoundCr.changeRequest!.id),
    ).toMatchObject({
      status: "needs_review",
      conflictReason: "collection_not_found",
    });

    // None of them were auto-approved or exposed on default read API
    expect(
      (
        await expectRpcError(
          readRpc.media.getMedia({ ref: mediaRef({ tmdb: { type: "tv", id: 244890 } }) }),
        )
      ).status,
    ).toBe(404);
  });

  test("retries transient Mango TV errors (403/503) while keeping change request in pending_evidence until recovery", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    let now = new Date("2026-11-23T20:00:00.000Z");
    let mgtvCalls = 0;
    const baseStub = createMgtvAndTmdbStub();

    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        if (request.namespace === "mgtv" && request.url.includes("collection_id=510924")) {
          mgtvCalls += 1;
          if (mgtvCalls === 1) {
            return { status: 403, headers: {}, body: '{"msg":"Forbidden"}', url: request.url };
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

    const user = await setupVerifiedUserAndKeys(app, outbound, "mgtv-retry@example.com");
    const submitRpc = createRpcClients(app, { apiKey: user.submitKey });

    const { changeRequest } = await submitRpc.changeRequest.createChangeRequest({
      target: mediaRef({ tmdb: { type: "tv", id: 217492 } }),
      namespace: "mgtv",
      nativeId: "https://www.mgtv.com/b/510924/18030368.html",
      variantDescription: "原声",
      segments: [
        toProtoSegmentInput({
          season: 1,
          episodeStart: 1,
          episodeEnd: 40,
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
      config: {
        defaultRetryDelayMs: 30_000,
        tmdb: { accessToken: "test-tmdb-token" },
      },
      now: () => now,
    });

    // Attempt 1: HTTP 403 -> rescheduled, CR stays pending_evidence
    await worker.scheduled(createScheduledController(now));
    expect(emitted).toHaveLength(1);
    const attempt1 = await worker.queue(createQueueBatch([emitted.shift()!], now).batch);
    expect(attempt1.rescheduled).toBe(1);

    expect(
      (await getChangeRequestStateRpc(app, { apiKey: user.readKey }, changeRequest!.id)).status,
    ).toBe("pending_evidence");

    // Attempt 2: recovers -> auto-approved
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
