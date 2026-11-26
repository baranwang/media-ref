import type { Message, MessageBatch, ScheduledController } from "@cloudflare/workers-types";
import { createApiApp } from "@media-ref/api/app";
import { resolveEpisode, type BaselineSource } from "@media-ref/client";
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
import { DOUBAN_API } from "@media-ref/core";

// A test key, and no pacing delays against the fake Douban.
DOUBAN_API.apiKey = "test-douban-key";
DOUBAN_API.minIntervalMs = 0;
DOUBAN_API.retryDelayMs = 0;

const TEST_AUTH_SECRET = "test-secret-for-catalog-and-non-tmdb-integration-tests-0123456789";

function jsonResponse(url: string, payload: unknown, status = 200): ExternalHttpResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
    url,
  };
}

function makeBilibiliEpisodes(count: number) {
  return Array.from({ length: count }, (_, idx) => ({
    id: 500000 + idx + 1,
    title: String(idx + 1),
    long_title: `第${idx + 1}话`,
    badge: "",
    badge_type: 0,
    section_type: 0,
    duration: 1440000,
  }));
}

async function setupVerifiedUserAndKeys(
  app: ReturnType<typeof createApiApp>,
  outbound: ReturnType<typeof createFakeOutboundClient>,
  email: string,
) {
  const { userId, cookie } = await signUpAndVerifyUser(app, outbound, {
    email,
    name: "Catalog Tester",
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

function createCatalogAndPlatformStub() {
  return (request: ExternalHttpRequest): ExternalHttpResponse => {
    if (request.kind === "catalog" && request.namespace === "tmdb") {
      if (request.url.includes("/tv/95479")) {
        return jsonResponse(request.url, {
          id: 95479,
          name: "咒术回战",
          original_name: "呪術廻戦",
          first_air_date: "2020-10-03",
          seasons: [
            { season_number: 1, episode_count: 24, air_date: "2020-10-03" },
            { season_number: 2, episode_count: 23, air_date: "2023-07-06" },
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
      // Trakt's edge returns 403 to requests without a User-Agent
      expect(request.headers?.["user-agent"]).toBe("media-ref");
      if (request.url.includes("/search/tmdb/95479?type=show")) {
        return jsonResponse(request.url, [
          {
            type: "show",
            show: {
              title: "Jujutsu Kaisen",
              year: 2020,
              ids: { trakt: 159384, slug: "jujutsu-kaisen", imdb: "tt12343534", tvdb: 377543 },
            },
          },
        ]);
      }
      if (request.url.includes("/shows/12345")) {
        return jsonResponse(request.url, {
          title: "Trakt Indie Drama",
          year: 2024,
          aired_episodes: 10,
          ids: { trakt: 12345, slug: "trakt-indie-drama" },
        });
      }
      return jsonResponse(request.url, [], 404);
    }

    if (request.kind === "catalog" && request.namespace === "douban") {
      if (new URL(request.url).pathname.endsWith("/subject/1001")) {
        return jsonResponse(request.url, {
          id: "1001",
          title: "咒术回战",
          original_title: "呪術廻戦",
          year: "2020",
          type: "tv",
          is_tv: true,
          episodes_count: 24,
        });
      }
      if (new URL(request.url).pathname.endsWith("/subject/1002")) {
        return jsonResponse(request.url, {
          id: "1002",
          title: "咒术回战 第二季",
          original_title: "呪術廻戦 第2期",
          year: "2023",
          type: "tv",
          is_tv: true,
          episodes_count: 23,
        });
      }
      if (new URL(request.url).pathname.endsWith("/subject/600002")) {
        return jsonResponse(request.url, {
          id: "600002",
          title: "豆瓣独有短剧",
          original_title: "豆瓣独有短剧",
          year: "2024",
          type: "tv",
          is_tv: true,
          episodes_count: 8,
        });
      }
      if (new URL(request.url).pathname.endsWith("/subject/777001")) {
        return jsonResponse(request.url, {
          id: "777001",
          title: "Trakt Indie Drama",
          original_title: "Trakt Indie Drama",
          year: "2024",
          type: "tv",
          is_tv: true,
          episodes_count: 10,
        });
      }
      return jsonResponse(request.url, { code: 404, msg: "traversal_error" }, 404);
    }

    if (request.kind === "catalog" && request.namespace === "bangumi") {
      if (request.url.endsWith("/subjects/294993")) {
        return jsonResponse(request.url, {
          id: 294993,
          type: 2,
          name: "呪術廻戦",
          name_cn: "咒术回战",
          date: "2020-10-02",
          platform: "TV",
          eps: 24,
          infobox: [{ key: "IMDb_id", value: "tt12343534" }],
        });
      }
      if (request.url.endsWith("/subjects/600001")) {
        return jsonResponse(request.url, {
          id: 600001,
          type: 2,
          name: "オリジナルOVA",
          name_cn: "Bangumi原创动画",
          date: "2024-03-10",
          platform: "OVA",
          eps: 6,
          infobox: [],
        });
      }
      if (request.url.endsWith("/subjects/600002")) {
        return jsonResponse(request.url, {
          id: 600002,
          type: 2,
          name: "豆瓣独有短剧",
          name_cn: "豆瓣独有短剧",
          date: "2024-06-01",
          platform: "WEB",
          eps: 8,
          infobox: [],
        });
      }
      if (request.url.endsWith("/subjects/600003")) {
        return jsonResponse(request.url, {
          id: 600003,
          type: 2,
          name: "Cross Catalog Anime",
          name_cn: "跨目录动画",
          date: "2023-10-01",
          platform: "TV",
          eps: 12,
          infobox: [{ key: "IMDb_id", value: "tt6000003" }],
        });
      }
      return jsonResponse(request.url, { title: "Not Found" }, 404);
    }

    if (request.kind === "catalog" && request.namespace === "imdb") {
      if (request.url.includes("/titles/tt8000001")) {
        return jsonResponse(request.url, {
          id: "tt8000001",
          type: "movie",
          primaryTitle: "IMDb Only Indie Film",
          originalTitle: "IMDb Only Indie Film",
          startYear: 2021,
        });
      }
      return jsonResponse(request.url, { error: "not_found" }, 404);
    }

    if (request.kind === "catalog" && request.namespace === "tvdb") {
      if (request.url.includes("/series/700001/extended")) {
        return jsonResponse(request.url, {
          data: {
            id: 700001,
            name: "TVDB Exclusive Show",
            originalName: "TVDB Exclusive Show",
            firstAired: "2022-05-01",
            seasons: [{ number: 1, type: { id: 1 }, episodeCount: 10, year: "2022" }],
            remoteIds: [{ id: "tt7000001", type: 2, sourceName: "IMDB" }],
          },
        });
      }
      return jsonResponse(request.url, { status: "failure" }, 404);
    }

    if (request.kind === "platform" && request.namespace === "bilibili") {
      if (request.url.includes("season_id=600002")) {
        return jsonResponse(request.url, {
          code: 0,
          message: "success",
          result: {
            season_id: 600002,
            title: "豆瓣独有短剧",
            type: 5,
            publish: { pub_time: "2024-06-01 00:00:00" },
            episodes: makeBilibiliEpisodes(8),
          },
        });
      }
      if (request.url.includes("season_id=600001")) {
        return jsonResponse(request.url, {
          code: 0,
          message: "success",
          result: {
            season_id: 600001,
            title: "Bangumi原创动画",
            jp_title: "オリジナルOVA",
            type: 1,
            publish: { pub_time: "2024-03-10 00:00:00" },
            episodes: makeBilibiliEpisodes(6),
          },
        });
      }
      if (request.url.includes("season_id=600003")) {
        return jsonResponse(request.url, {
          code: 0,
          message: "success",
          result: {
            season_id: 600003,
            title: "跨目录动画",
            jp_title: "Cross Catalog Anime",
            type: 1,
            publish: { pub_time: "2023-10-01 00:00:00" },
            episodes: makeBilibiliEpisodes(12),
          },
        });
      }
      if (request.url.includes("season_id=800001")) {
        return jsonResponse(request.url, {
          code: 0,
          message: "success",
          result: {
            season_id: 800001,
            title: "IMDb Only Indie Film",
            type: 2,
            publish: { pub_time: "2021-08-01 00:00:00" },
            episodes: makeBilibiliEpisodes(1),
          },
        });
      }
      if (request.url.includes("season_id=700001")) {
        return jsonResponse(request.url, {
          code: 0,
          message: "success",
          result: {
            season_id: 700001,
            title: "TVDB Exclusive Show",
            type: 5,
            publish: { pub_time: "2022-05-01 00:00:00" },
            episodes: makeBilibiliEpisodes(10),
          },
        });
      }
      if (request.url.includes("season_id=12345")) {
        return jsonResponse(request.url, {
          code: 0,
          message: "success",
          result: {
            season_id: 12345,
            title: "Trakt Indie Drama",
            type: 5,
            publish: { pub_time: "2024-02-01 00:00:00" },
            episodes: makeBilibiliEpisodes(10),
          },
        });
      }
    }

    throw new Error(
      `Unexpected outbound request: ${request.kind}:${request.namespace} ${request.url}`,
    );
  };
}

async function drainEvidenceJobs(
  worker: ReturnType<typeof createBackgroundWorker>,
  emitted: JobQueueMessage[],
  now: Date,
) {
  await worker.scheduled(createScheduledController(now));
  const evidenceMsgs = emitted.filter((m) => m.jobType === "evidence_check");
  emitted.length = 0;
  if (evidenceMsgs.length > 0) {
    const { batch } = createQueueBatch(evidenceMsgs, now);
    await worker.queue(batch);
  }
  return evidenceMsgs.length;
}

describe("Catalog associations (Douban/Bangumi) & non-TMDB media end-to-end (#17)", () => {
  const handles: TestDbHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop();
      if (handle) {
        await handle.cleanup();
      }
    }
  });

  test("processes multi-season Douban and Bangumi associations through Evidence Gate and serves reads for all catalog keys", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-23T18:00:00.000Z");
    const outbound = createFakeOutboundClient({
      fetchExternal: createCatalogAndPlatformStub(),
    });

    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => t0,
        tmdb: { accessToken: "test-tmdb-token", traktClientId: "test-trakt-client" },
        submitBaseHourlyLimit: 20,
      },
    });

    const user = await setupVerifiedUserAndKeys(app, outbound, "catalog-assoc@example.com");
    const submitRpc = createRpcClients(app, { apiKey: user.submitKey });

    // Reject invalid Douban URL and variant on catalog association
    const badUrlErr = await expectRpcError(
      submitRpc.changeRequest.createChangeRequest({
        target: mediaRef("tmdb:tv:95479"),
        namespace: "douban",
        nativeId: "https://book.douban.com/subject/1001/",
        segments: [
          toProtoSegmentInput({
            season: 1,
            episodeStart: 1,
            episodeEnd: 24,
            targetEpisodeStart: 1,
            baseline: "tmdb",
          }),
        ],
      }),
    );
    expect(badUrlErr.status).toBe(400);
    expect(badUrlErr.code).toBe("INVALID_NATIVE_ID");

    const variantCatalogErr = await expectRpcError(
      submitRpc.changeRequest.createChangeRequest({
        target: mediaRef("tmdb:tv:95479"),
        namespace: "douban",
        nativeId: "1001",
        variantDescription: "原声",
        segments: [],
      }),
    );
    expect(variantCatalogErr.status).toBe(400);
    expect(variantCatalogErr.code).toBe("VARIANT_NOT_ALLOWED");

    // Submit Douban Season 1, Douban Season 2, and Bangumi Season 1 (via URLs -> canonicalized!)
    const s1Submit = await submitRpc.changeRequest.createChangeRequest({
      target: mediaRef("tmdb:tv:95479"),
      namespace: "douban",
      nativeId: "https://movie.douban.com/subject/1001/",
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
    const s1Cr = s1Submit.changeRequest!;
    expect(fromProtoChangeRequestStatus(s1Cr.status)).toBe("pending_evidence");
    expect(s1Cr.nativeId).toBe("1001");

    const s2Submit = await submitRpc.changeRequest.createChangeRequest({
      target: mediaRef("tmdb:tv:95479"),
      namespace: "douban",
      nativeId: "https://m.douban.com/movie/subject/1002/",
      segments: [
        toProtoSegmentInput({
          season: 2,
          episodeStart: 1,
          episodeEnd: 23,
          targetEpisodeStart: 1,
          baseline: "tmdb",
        }),
      ],
    });
    const s2Cr = s2Submit.changeRequest!;
    expect(fromProtoChangeRequestStatus(s2Cr.status)).toBe("pending_evidence");
    expect(s2Cr.nativeId).toBe("1002");

    const bgmSubmit = await submitRpc.changeRequest.createChangeRequest({
      target: mediaRef("tmdb:tv:95479"),
      namespace: "bangumi",
      nativeId: "https://bgm.tv/subject/294993",
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
    const bgmCr = bgmSubmit.changeRequest!;
    expect(fromProtoChangeRequestStatus(bgmCr.status)).toBe("pending_evidence");
    expect(bgmCr.nativeId).toBe("294993");

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
        tmdb: { accessToken: "test-tmdb-token", traktClientId: "test-trakt-client" },
        enableDailyTmdbSync: false,
      },
      now: () => t0,
    });

    const processed = await drainEvidenceJobs(worker, emitted, t0);
    expect(processed).toBe(3);

    // All three catalog change requests auto-approved!
    for (const id of [s1Cr.id, s2Cr.id, bgmCr.id]) {
      const crState = await getChangeRequestStateRpc(app, { apiKey: user.readKey }, id);
      expect(crState).toMatchObject({
        status: "approved",
        decisionReason: "evidence_gate_passed",
      });
    }

    // Query by Douban S1, Douban S2, and Bangumi -> returns MediaDocument with matchedAssociationId set
    const douban1Body = await getMediaDocumentRpc(app, user.readKey, "douban:1001");
    expect(douban1Body.matchedAssociationId).toBeTruthy();
    const douban1Assoc = douban1Body.document.associations.find(
      (a) => a.namespace === "douban" && a.nativeId === "1001",
    );
    expect(douban1Assoc).toMatchObject({
      id: douban1Body.matchedAssociationId,
      variantId: null,
      status: "confirmed",
    });

    const douban2Body = await getMediaDocumentRpc(app, user.readKey, "douban:1002");
    expect(douban2Body.matchedAssociationId).toBeTruthy();
    expect(douban2Body.matchedAssociationId).not.toBe(douban1Body.matchedAssociationId);

    const bgmBody = await getMediaDocumentRpc(app, user.readKey, "bangumi:294993");
    expect(bgmBody.matchedAssociationId).toBeTruthy();
    expect(bgmBody.document.media.id).toBe(douban1Body.document.media.id);

    // Also query by IMDb, TVDB, and Trakt external keys
    for (const extKey of ["imdb:tt12343534", "tvdb:377543", "trakt:show:159384"]) {
      const body = await getMediaDocumentRpc(app, user.readKey, extKey);
      expect(body.document.media.id).toBe(douban1Body.document.media.id);
    }

    // resolveEpisode works across multi-season Douban entries with variantId: null
    expect(
      resolveEpisode(douban1Body.document, { namespace: "douban", season: 1, episode: 10 }),
    ).toMatchObject({
      kind: "mapped",
      nativeId: "1001",
      variantId: null,
      targetEpisode: 10,
    });
    expect(
      resolveEpisode(douban1Body.document, { namespace: "douban", season: 2, episode: 5 }),
    ).toMatchObject({
      kind: "mapped",
      nativeId: "1002",
      variantId: null,
      targetEpisode: 5,
    });
  });

  test("creates non-TMDB media from douban, bangumi, imdb, and tvdb with baseline priority tvdb > imdb > bangumi > douban", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-23T19:00:00.000Z");
    const outbound = createFakeOutboundClient({
      fetchExternal: createCatalogAndPlatformStub(),
    });

    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => t0,
        submitBaseHourlyLimit: 20,
      },
    });

    const user = await setupVerifiedUserAndKeys(app, outbound, "non-tmdb@example.com");
    const submitRpc = createRpcClients(app, { apiKey: user.submitKey });

    const submissions: Array<{
      targetExternalKey: string;
      nativeId: string;
      segments: Array<{
        season: number;
        episodeStart: number;
        episodeEnd: number;
        targetEpisodeStart: number;
        baseline?: BaselineSource;
      }>;
      expectedBaseline: BaselineSource;
      expectedLookupKeys: string[];
      expectMatchedOnFirstKey: boolean;
    }> = [
      {
        targetExternalKey: "douban:600002",
        nativeId: "ss600002",
        segments: [{ season: 1, episodeStart: 1, episodeEnd: 8, targetEpisodeStart: 1 }],
        expectedBaseline: "douban",
        expectedLookupKeys: ["douban:600002", "bilibili:ss600002"],
        expectMatchedOnFirstKey: true,
      },
      {
        targetExternalKey: "bangumi:600001",
        nativeId: "ss600001",
        segments: [{ season: 1, episodeStart: 1, episodeEnd: 6, targetEpisodeStart: 1 }],
        expectedBaseline: "bangumi",
        expectedLookupKeys: ["bangumi:600001", "bilibili:ss600001"],
        expectMatchedOnFirstKey: true,
      },
      {
        // Bangumi subject whose infobox includes IMDb_id -> imdb beats bangumi!
        targetExternalKey: "bangumi:600003",
        nativeId: "ss600003",
        segments: [
          { season: 1, episodeStart: 1, episodeEnd: 12, targetEpisodeStart: 1, baseline: "imdb" },
        ],
        expectedBaseline: "imdb",
        expectedLookupKeys: ["bangumi:600003", "imdb:tt6000003"],
        expectMatchedOnFirstKey: true,
      },
      {
        targetExternalKey: "imdb:tt8000001",
        nativeId: "ss800001",
        segments: [],
        expectedBaseline: "imdb",
        expectedLookupKeys: ["imdb:tt8000001", "bilibili:ss800001"],
        expectMatchedOnFirstKey: false,
      },
      {
        // TVDB series whose remoteIds include IMDb -> tvdb beats imdb!
        targetExternalKey: "tvdb:700001",
        nativeId: "ss700001",
        segments: [{ season: 1, episodeStart: 1, episodeEnd: 10, targetEpisodeStart: 1 }],
        expectedBaseline: "tvdb",
        expectedLookupKeys: ["tvdb:700001", "imdb:tt7000001"],
        expectMatchedOnFirstKey: false,
      },
    ];

    for (const sub of submissions) {
      const res = await submitRpc.changeRequest.createChangeRequest({
        target: mediaRef(sub.targetExternalKey),
        namespace: "bilibili",
        nativeId: sub.nativeId,
        variantDescription: "原声",
        segments: sub.segments.map((seg) => toProtoSegmentInput(seg)),
      });
      expect(res.changeRequest?.id).toBeTruthy();
    }

    const emitted: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
      config: { enableDailyTmdbSync: false },
      now: () => t0,
    });

    const processed = await drainEvidenceJobs(worker, emitted, t0);
    expect(processed).toBe(submissions.length);

    for (const sub of submissions) {
      let mediaId: string | null = null;
      for (let i = 0; i < sub.expectedLookupKeys.length; i += 1) {
        const key = sub.expectedLookupKeys[i]!;
        const body = await getMediaDocumentRpc(app, user.readKey, key);
        expect(body.document.media.baseline).toBe(sub.expectedBaseline);
        if (mediaId === null) {
          mediaId = body.document.media.id;
        } else {
          expect(body.document.media.id).toBe(mediaId);
        }
        if (i === 0 && sub.expectMatchedOnFirstKey) {
          expect(body.matchedAssociationId).toBeTruthy();
        }
      }
    }

    // Adding a subsequent catalog association (bangumi:600002) to the existing Douban-baseline media passes Evidence Gate
    const addBgmRes = await submitRpc.changeRequest.createChangeRequest({
      target: mediaRef("douban:600002"),
      namespace: "bangumi",
      nativeId: "https://bgm.tv/subject/600002",
      segments: [
        toProtoSegmentInput({ season: 1, episodeStart: 1, episodeEnd: 8, targetEpisodeStart: 1 }),
      ],
    });
    expect(addBgmRes.changeRequest?.id).toBeTruthy();
    expect(await drainEvidenceJobs(worker, emitted, t0)).toBe(1);

    const byAddedBgm = await getMediaDocumentRpc(app, user.readKey, "bangumi:600002");
    expect(byAddedBgm.document.media.baseline).toBe("douban");
    expect(byAddedBgm.matchedAssociationId).toBeTruthy();
    expect(byAddedBgm.document.associations.map((a) => `${a.namespace}:${a.nativeId}`)).toEqual(
      expect.arrayContaining(["douban:600002", "bilibili:ss600002", "bangumi:600002"]),
    );
  });

  test("enforces Trakt-only no-segments rule before and after media creation while allowing whole-media associations", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-23T20:00:00.000Z");
    const outbound = createFakeOutboundClient({
      fetchExternal: createCatalogAndPlatformStub(),
    });

    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => t0,
        submitBaseHourlyLimit: 20,
      },
    });

    const user = await setupVerifiedUserAndKeys(app, outbound, "trakt-only@example.com");
    const submitRpc = createRpcClients(app, { apiKey: user.submitKey });

    // 1. Before media exists: submitting WITH segments targeting trakt:show:12345 is rejected (400)
    const segmentedBeforeErr = await expectRpcError(
      submitRpc.changeRequest.createChangeRequest({
        target: mediaRef("trakt:show:12345"),
        namespace: "bilibili",
        nativeId: "ss12345",
        variantDescription: "原声",
        segments: [
          toProtoSegmentInput({
            season: 1,
            episodeStart: 1,
            episodeEnd: 10,
            targetEpisodeStart: 1,
          }),
        ],
      }),
    );
    expect(segmentedBeforeErr.status).toBe(400);
    expect(segmentedBeforeErr.code).toBe("SEGMENTS_NOT_ALLOWED_WITHOUT_BASELINE");

    // Also rejected when an explicit baseline is supplied on segments
    const segmentedWithBaselineErr = await expectRpcError(
      submitRpc.changeRequest.createChangeRequest({
        target: mediaRef("trakt:show:12345"),
        namespace: "bilibili",
        nativeId: "ss12345",
        variantDescription: "原声",
        segments: [
          toProtoSegmentInput({
            season: 1,
            episodeStart: 1,
            episodeEnd: 10,
            targetEpisodeStart: 1,
            baseline: "tmdb",
          }),
        ],
      }),
    );
    expect(segmentedWithBaselineErr.status).toBe(400);
    expect(segmentedWithBaselineErr.code).toBe("SEGMENTS_NOT_ALLOWED_WITHOUT_BASELINE");

    // 2. Submitting whole-media (segments: []) succeeds and creates media with baseline: null
    const wholeMediaRes = await submitRpc.changeRequest.createChangeRequest({
      target: mediaRef("trakt:show:12345"),
      namespace: "bilibili",
      nativeId: "ss12345",
      variantDescription: "原声",
      segments: [],
    });
    expect(wholeMediaRes.changeRequest?.id).toBeTruthy();

    const emitted: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
      config: { enableDailyTmdbSync: false },
      now: () => t0,
    });

    const processed = await drainEvidenceJobs(worker, emitted, t0);
    expect(processed).toBe(1);

    const traktDoc = await getMediaDocumentRpc(app, user.readKey, "trakt:show:12345");
    expect(traktDoc.document.media.baseline).toBeNull();
    expect(traktDoc.document.externalIds).toEqual([{ namespace: "trakt", nativeId: "show:12345" }]);
    expect(traktDoc.document.associations).toHaveLength(1);
    expect(traktDoc.document.associations[0]).toMatchObject({
      namespace: "bilibili",
      nativeId: "ss12345",
      segments: [],
    });

    // 3. After media exists with baseline === null: adding segments via trakt key OR media UUID is STILL rejected (400)
    for (const targetKey of ["trakt:show:12345", traktDoc.document.media.id]) {
      const segmentedAfterErr = await expectRpcError(
        submitRpc.changeRequest.createChangeRequest({
          target: mediaRef(targetKey),
          namespace: "douban",
          nativeId: "777001",
          segments: [
            toProtoSegmentInput({
              season: 1,
              episodeStart: 1,
              episodeEnd: 10,
              targetEpisodeStart: 1,
              baseline: "douban",
            }),
          ],
        }),
      );
      expect(segmentedAfterErr.status).toBe(400);
      expect(segmentedAfterErr.code).toBe("SEGMENTS_NOT_ALLOWED_WITHOUT_BASELINE");
    }

    // 4. Adding another whole-media association (douban:777001, segments: []) while baseline === null succeeds!
    const wholeDoubanRes = await submitRpc.changeRequest.createChangeRequest({
      target: mediaRef(traktDoc.document.media.id),
      namespace: "douban",
      nativeId: "777001",
      segments: [],
    });
    expect(wholeDoubanRes.changeRequest?.id).toBeTruthy();

    const processed2 = await drainEvidenceJobs(worker, emitted, t0);
    expect(processed2).toBe(1);

    const byDouban = await getMediaDocumentRpc(app, user.readKey, "douban:777001");
    expect(byDouban.document.media.id).toBe(traktDoc.document.media.id);
    expect(byDouban.document.media.baseline).toBeNull();
    expect(byDouban.matchedAssociationId).toBeTruthy();
  });
});
