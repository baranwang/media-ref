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

const TEST_AUTH_SECRET = "test-secret-for-tencent-adapter-evidence-tests-0123456789abcdef";

function jsonResponse(url: string, payload: unknown, status = 200): ExternalHttpResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
    url,
  };
}

function makeTencentIntroPayload(itemParams: Record<string, unknown>) {
  return {
    ret: 0,
    msg: "",
    data: {
      module_list_datas: [
        {
          module_datas: [
            {
              item_data_lists: {
                item_datas: [{ item_params: itemParams }],
              },
            },
          ],
        },
      ],
    },
  };
}

function makeTencentEpisodePagePayload(
  items: Array<Record<string, unknown>>,
  tabs?: Array<Record<string, unknown>>,
) {
  return {
    ret: 0,
    msg: "",
    data: {
      module_list_datas: [
        {
          module_datas: [
            {
              module_params: tabs ? { tabs: JSON.stringify(tabs) } : {},
              item_data_lists: {
                item_datas: items.map((item_params) => ({ item_params })),
              },
            },
          ],
        },
      ],
    },
  };
}

function makeTencentEpisodesRange(cid: string, seriesTitle: string, start: number, end: number) {
  const items: Array<Record<string, unknown>> = [];
  for (let i = start; i <= end; i += 1) {
    const padded = String(i).padStart(2, "0");
    items.push({
      vid: `${cid.slice(0, 6)}ep${String(i).padStart(3, "0")}`,
      cid,
      title: String(i),
      c_title_output: padded,
      play_title: `${seriesTitle} 第${padded}集`,
      is_trailer: "0",
      duration: "2700",
      publish_date: "2023-01-15",
    });
  }
  return items;
}

async function setupVerifiedUserAndKeys(
  app: ReturnType<typeof createApiApp>,
  outbound: ReturnType<typeof createFakeOutboundClient>,
  email: string,
) {
  const { userId, cookie } = await signUpAndVerifyUser(app, outbound, {
    email,
    name: "Tencent Tester",
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

function createTencentAndTmdbStub() {
  const multiPageTabs = [
    { begin: "1", end: "30", selected: true, page_context: "dl_ctx_1_30" },
    { begin: "31", end: "60", selected: false, page_context: "dl_ctx_31_60" },
    { begin: "61", end: "65", selected: false, page_context: "dl_ctx_61_65" },
  ];

  return (request: ExternalHttpRequest): ExternalHttpResponse => {
    if (request.kind === "catalog" && request.namespace === "tmdb") {
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
      // 古乐风华录: 40 episodes, premiering 2026-11-29.
      if (request.url.includes("/tv/290001/season/1")) {
        return jsonResponse(request.url, {
          episodes: Array.from({ length: 40 }, (_, i) => ({
            episode_number: i + 1,
            name: `第${i + 1}集`,
            air_date: i < 2 ? "2026-11-29" : "2026-12-15",
          })),
        });
      }
      if (request.url.includes("/tv/290001")) {
        return jsonResponse(request.url, {
          id: 290001,
          name: "古乐风华录",
          original_name: "古乐风华录",
          first_air_date: "2026-11-29",
          seasons: [{ season_number: 1, episode_count: 40, air_date: "2026-11-29" }],
          external_ids: {},
        });
      }
      if (request.url.includes("/tv/78879")) {
        return jsonResponse(request.url, {
          id: 78879,
          name: "斗罗大陆",
          original_name: "斗罗大陆",
          first_air_date: "2018-01-20",
          seasons: [{ season_number: 1, episode_count: 65, air_date: "2018-01-20" }],
          external_ids: {
            imdb_id: "tt9605060",
          },
        });
      }
      return jsonResponse(request.url, { status_code: 34, status_message: "Not found" }, 404);
    }

    if (request.kind === "catalog" && request.namespace === "trakt") {
      return jsonResponse(request.url, []);
    }

    if (request.kind === "platform" && request.namespace === "tencent") {
      const body = JSON.parse(request.body ?? "{}") as {
        page_params?: { page_id?: string; cid?: string; page_context?: string };
      };
      const cid = body.page_params?.cid ?? "";
      const pageId = body.page_params?.page_id ?? "";
      const pageContext = body.page_params?.page_context ?? "";

      // Three-Body (30 eps + 10 彩蛋 + 1 trailer)
      if (cid === "mzc002007knmh3g") {
        if (pageId === "detail_page_introduction") {
          return jsonResponse(
            request.url,
            makeTencentIntroPayload({
              title: "三体",
              year: "2023",
              type: "2",
              type_name: "电视剧",
              episode_all: "30",
            }),
          );
        }
        if (pageId === "vsite_episode_list") {
          const items = [
            ...makeTencentEpisodesRange(cid, "三体", 1, 30),
            ...Array.from({ length: 10 }, (_, idx) => ({
              vid: `egg_${idx + 1}`,
              cid,
              title: `彩蛋${idx + 1}`,
              c_title_output: `彩蛋${idx + 1}`,
              is_trailer: "0",
            })),
            { vid: "tr_31", cid, title: "31", c_title_output: "31", is_trailer: "1" },
          ];
          return jsonResponse(request.url, makeTencentEpisodePagePayload(items));
        }
      }

      // Multi-page anime (65 eps across 3 tabs + bonus/trailers)
      if (cid === "m441e3rjq9kwpsc") {
        if (pageId === "detail_page_introduction") {
          return jsonResponse(
            request.url,
            makeTencentIntroPayload({
              title: "斗罗大陆",
              year: "2018",
              type: "动漫",
              episode_all: "65",
            }),
          );
        }
        if (pageId === "vsite_episode_list") {
          if (pageContext === "") {
            return jsonResponse(
              request.url,
              makeTencentEpisodePagePayload(
                [
                  ...makeTencentEpisodesRange(cid, "斗罗大陆", 1, 30),
                  { vid: "dl_egg1", cid, title: "彩蛋1", is_trailer: "0" },
                ],
                multiPageTabs,
              ),
            );
          }
          if (pageContext === "dl_ctx_31_60") {
            return jsonResponse(
              request.url,
              makeTencentEpisodePagePayload(
                [
                  ...makeTencentEpisodesRange(cid, "斗罗大陆", 31, 60),
                  { vid: "dl_tr61", cid, title: "61", is_trailer: "1" },
                ],
                multiPageTabs,
              ),
            );
          }
          if (pageContext === "dl_ctx_61_65") {
            return jsonResponse(
              request.url,
              makeTencentEpisodePagePayload(
                makeTencentEpisodesRange(cid, "斗罗大陆", 61, 65),
                multiPageTabs,
              ),
            );
          }
        }
      }

      // Missing year
      if (cid === "mzc00200noyear1") {
        if (pageId === "detail_page_introduction") {
          return jsonResponse(
            request.url,
            makeTencentIntroPayload({
              title: "三体",
              year: "",
              type: "2",
              episode_all: "30",
            }),
          );
        }
        if (pageId === "vsite_episode_list") {
          return jsonResponse(
            request.url,
            makeTencentEpisodePagePayload(makeTencentEpisodesRange(cid, "三体", 1, 30)),
          );
        }
      }

      // Missing feature episodes (trailer-only page)
      if (cid === "mzc00200noeps01") {
        if (pageId === "detail_page_introduction") {
          return jsonResponse(
            request.url,
            makeTencentIntroPayload({
              title: "三体",
              year: "2023",
              type: "2",
              episode_all: "30",
            }),
          );
        }
        if (pageId === "vsite_episode_list") {
          return jsonResponse(
            request.url,
            makeTencentEpisodePagePayload([
              { vid: "tr_only_1", cid, title: "1", is_trailer: "1" },
              { vid: "egg_only_1", cid, title: "彩蛋1", is_trailer: "0" },
            ]),
          );
        }
      }

      // Before the premiere: the cover is online, its list holds only a trailer.
      if (cid === "mzc002001plkc0p") {
        if (pageId === "detail_page_introduction") {
          return jsonResponse(
            request.url,
            makeTencentIntroPayload({
              title: "古乐风华录",
              year: "2026",
              type: "2",
              type_name: "电视剧",
              episode_all: "40",
            }),
          );
        }
        if (pageId === "vsite_episode_list") {
          return jsonResponse(
            request.url,
            makeTencentEpisodePagePayload([{ vid: "glfh_tr1", cid, title: "1", is_trailer: "1" }]),
          );
        }
      }

      // Not found (empty module_list_datas)
      if (cid === "mzc00200zzzzzzz") {
        return jsonResponse(request.url, {
          ret: 0,
          msg: "",
          data: { module_list_datas: [] },
        });
      }
    }

    throw new Error(
      `Unexpected outbound request: ${request.kind}:${request.namespace} ${request.url} body=${request.body ?? ""}`,
    );
  };
}

describe("Tencent Video adapter end-to-end evidence flow (#13)", () => {
  const handles: TestDbHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop();
      if (handle) {
        await handle.cleanup();
      }
    }
  });

  test("rejects invalid Tencent URLs (400), canonicalizes valid URLs to cid, auto-approves via scheduled + queue, and serves via MediaService.GetMedia", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-23T18:00:00.000Z");
    const outbound = createFakeOutboundClient({
      fetchExternal: createTencentAndTmdbStub(),
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

    const user = await setupVerifiedUserAndKeys(app, outbound, "tencent-submitter@example.com");
    const submitRpc = createRpcClients(app, { apiKey: user.submitKey });
    const readRpc = createRpcClients(app, { apiKey: user.readKey });

    // 1. Invalid URLs / video-only x/page links are rejected immediately with HTTP 400
    for (const badInput of [
      "https://v.qq.com/x/page/u0045abc123.html",
      "https://m.v.qq.com/x/m/play?vid=u0045abc123",
      "https://evil.example.com/x/cover/mzc002007knmh3g.html",
      "mzc00200",
    ]) {
      const badErr = await expectRpcError(
        submitRpc.changeRequest.createChangeRequest({
          target: mediaRef({ tmdb: { type: "tv", id: 108545 } }),
          namespace: "tencent",
          nativeId: badInput,
          variantDescription: "原声",
          segments: [
            toProtoSegmentInput({
              season: 1,
              episodeStart: 1,
              episodeEnd: 30,
              targetEpisodeStart: 1,
              baseline: "tmdb",
            }),
          ],
        }),
      );
      expect(badErr.status).toBe(400);
      expect(badErr.code).toBe("INVALID_NATIVE_ID");
    }

    // 2. All valid Tencent URL/ID forms canonicalize to mzc002007knmh3g and enter pending_evidence
    const urlVariants = [
      "https://v.qq.com/x/cover/mzc002007knmh3g/u0045ep01.html?ptag=10523",
      "https://v.qq.com/x/cover/mzc002007knmh3g.html",
      "https://v.qq.com/detail/m/mzc002007knmh3g.html",
      "https://m.v.qq.com/x/m/play?cid=mzc002007knmh3g&vid=u0045ep01",
      "mzc002007knmh3g",
    ];
    const submittedIds: string[] = [];

    for (const [index, rawInput] of urlVariants.entries()) {
      const body = await submitRpc.changeRequest.createChangeRequest({
        target: mediaRef({ tmdb: { type: "tv", id: 108545 } }),
        namespace: "tencent",
        nativeId: rawInput,
        variantDescription: index === 0 ? "原声" : `原声-${index}`,
        segments: [
          toProtoSegmentInput({
            season: 1,
            episodeStart: 1,
            episodeEnd: 30,
            targetEpisodeStart: 1,
            baseline: "tmdb",
          }),
        ],
      });
      expect(fromProtoChangeRequestStatus(body.changeRequest!.status)).toBe("pending_evidence");
      expect(body.changeRequest!.rawNativeId).toBe(rawInput);
      expect(body.changeRequest!.nativeId).toBe("mzc002007knmh3g");
      submittedIds.push(body.changeRequest!.id);
    }

    // Before background worker runs, media is NOT readable yet
    expect(
      (
        await expectRpcError(
          readRpc.media.getMedia({ ref: mediaRef({ tmdb: { type: "tv", id: 108545 } }) }),
        )
      ).status,
    ).toBe(404);

    // 3. Run Background Worker scheduled -> queue on the first URL submission
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
    const crState = await getChangeRequestStateRpc(app, { apiKey: user.readKey }, submittedIds[0]!);
    expect(crState).toMatchObject({
      status: "approved",
      reviewerUserId: null,
      decisionReason: "evidence_gate_passed",
    });

    // 5. Media is readable via TMDB ref AND via Tencent reverse lookup, and resolves episodes
    const mediaBody = await getMediaDocumentRpc(app, user.readKey, {
      tmdb: { type: "tv", id: 108545 },
    });
    expect(mediaBody.document.associations).toHaveLength(1);
    expect(mediaBody.document.associations[0]).toMatchObject({
      namespace: "tencent",
      nativeId: "mzc002007knmh3g",
      status: "confirmed",
    });
    expect(
      resolveEpisode(mediaBody.document, { namespace: "tencent", season: 1, episode: 15 }),
    ).toMatchObject({
      kind: "mapped",
      nativeId: "mzc002007knmh3g",
      targetEpisode: 15,
    });

    const reverseBody = await getMediaDocumentRpc(app, user.readKey, {
      platform: { platform: "tencent", nativeId: "mzc002007knmh3g" },
    });
    expect(reverseBody.document.media.id).toBe(mediaBody.document.media.id);
  });

  test("auto-approves multi-page paginated Tencent series after aggregating all tabs", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-23T18:30:00.000Z");
    const outbound = createFakeOutboundClient({
      fetchExternal: createTencentAndTmdbStub(),
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

    const user = await setupVerifiedUserAndKeys(app, outbound, "tencent-multipage@example.com");
    const submitRpc = createRpcClients(app, { apiKey: user.submitKey });

    const { changeRequest } = await submitRpc.changeRequest.createChangeRequest({
      target: mediaRef({ tmdb: { type: "tv", id: 78879 } }),
      namespace: "tencent",
      nativeId: "https://v.qq.com/x/cover/m441e3rjq9kwpsc.html",
      variantDescription: "原声",
      segments: [
        toProtoSegmentInput({
          season: 1,
          episodeStart: 1,
          episodeEnd: 65,
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
    expect(emitted).toHaveLength(1);
    const summary = await worker.queue(createQueueBatch(emitted, t0).batch);
    expect(summary.completed).toBe(1);

    expect(
      await getChangeRequestStateRpc(app, { apiKey: user.readKey }, changeRequest!.id),
    ).toMatchObject({
      status: "approved",
      nativeId: "m441e3rjq9kwpsc",
    });

    const mediaBody = await getMediaDocumentRpc(app, user.readKey, {
      tmdb: { type: "tv", id: 78879 },
    });
    expect(
      resolveEpisode(mediaBody.document, { namespace: "tencent", season: 1, episode: 65 }),
    ).toMatchObject({
      kind: "mapped",
      nativeId: "m441e3rjq9kwpsc",
      targetEpisode: 65,
    });
  });

  test("routes missing year, missing feature episodes, and not_found collections to needs_review without auto-approving", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-23T19:00:00.000Z");
    const outbound = createFakeOutboundClient({
      fetchExternal: createTencentAndTmdbStub(),
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

    const user = await setupVerifiedUserAndKeys(app, outbound, "tencent-review@example.com");
    const submitRpc = createRpcClients(app, { apiKey: user.submitKey });
    const readRpc = createRpcClients(app, { apiKey: user.readKey });

    const submitCid = async (cid: string) => {
      const res = await submitRpc.changeRequest.createChangeRequest({
        target: mediaRef({ tmdb: { type: "tv", id: 108545 } }),
        namespace: "tencent",
        nativeId: cid,
        variantDescription: "原声",
        segments: [
          toProtoSegmentInput({
            season: 1,
            episodeStart: 1,
            episodeEnd: 30,
            targetEpisodeStart: 1,
            baseline: "tmdb",
          }),
        ],
      });
      return res.changeRequest!.id;
    };

    const noYearId = await submitCid("mzc00200noyear1");
    const noEpsId = await submitCid("mzc00200noeps01");
    const notFoundId = await submitCid("mzc00200zzzzzzz");

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

    expect(await getChangeRequestStateRpc(app, { apiKey: user.readKey }, noYearId)).toMatchObject({
      status: "needs_review",
      conflictReason: "year_missing",
    });
    expect(await getChangeRequestStateRpc(app, { apiKey: user.readKey }, noEpsId)).toMatchObject({
      status: "needs_review",
      conflictReason: "segment_episode_count_mismatch",
    });
    expect(await getChangeRequestStateRpc(app, { apiKey: user.readKey }, notFoundId)).toMatchObject(
      {
        status: "needs_review",
        conflictReason: "collection_not_found",
      },
    );

    // None of them may appear in default read API
    expect(
      (
        await expectRpcError(
          readRpc.media.getMedia({ ref: mediaRef({ tmdb: { type: "tv", id: 108545 } }) }),
        )
      ).status,
    ).toBe(404);
  });

  test("approves an empty cover the day before its season premieres, mapped open-ended", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const outbound = createFakeOutboundClient({ fetchExternal: createTencentAndTmdbStub() });
    const t0 = new Date("2026-11-28T08:54:00.000Z");
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
    const user = await setupVerifiedUserAndKeys(app, outbound, "tencent-premiere@example.com");
    const submitRpc = createRpcClients(app, { apiKey: user.submitKey });
    const openId = (
      await submitRpc.changeRequest.createChangeRequest({
        target: mediaRef({ tmdb: { type: "tv", id: 290001 } }),
        namespace: "tencent",
        nativeId: "mzc002001plkc0p",
        variantDescription: "国语原声",
        segments: [
          toProtoSegmentInput({
            season: 1,
            episodeStart: 1,
            episodeEnd: null,
            targetEpisodeStart: 1,
            baseline: "tmdb",
          }),
        ],
      })
    ).changeRequest!.id;

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
    expect(emitted).toHaveLength(1);
    expect((await worker.queue(createQueueBatch(emitted, t0).batch)).completed).toBe(1);

    const open = (await getChangeRequestStateRpc(app, { apiKey: user.readKey }, openId)) as {
      status: string;
      evidence: { catalog?: { unairedSeasons?: number[] } } | null;
    };
    expect(open.status).toBe("approved");
    expect(open.evidence?.catalog?.unairedSeasons).toEqual([1]);

    // A report the same day rechecks it under the same rule: still empty, still not premiered.
    const association = await testDb.readDb
      .selectFrom("associations")
      .select("id")
      .where("native_id", "=", "mzc002001plkc0p")
      .executeTakeFirstOrThrow();
    const report = await createRpcClients(app, {
      cookie: user.cookie,
    }).association.reportInvalidation({ associationId: association.id });
    expect(report.jobId).toBeTruthy();
    emitted.length = 0;
    await worker.scheduled(createScheduledController(t0));
    expect((await worker.queue(createQueueBatch(emitted, t0).batch)).completed).toBe(1);
    const recheck = await testDb.readDb
      .selectFrom("background_jobs")
      .select("result")
      .where("id", "=", report.jobId!)
      .executeTakeFirstOrThrow();
    expect(recheck.result).toMatchObject({ outcome: "still_valid" });
  });

  test("retries transient Tencent RPC errors while keeping change request in pending_evidence until recovery", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-23T20:00:00.000Z");
    let now = t0;
    let tencentIntroAttempts = 0;
    const baseStub = createTencentAndTmdbStub();

    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        if (request.kind === "platform" && request.namespace === "tencent") {
          const body = JSON.parse(request.body ?? "{}") as {
            page_params?: { page_id?: string };
          };
          if (body.page_params?.page_id === "detail_page_introduction") {
            tencentIntroAttempts += 1;
            if (tencentIntroAttempts === 1) {
              return jsonResponse(request.url, { ret: 10401, msg: "unknow error." });
            }
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

    const user = await setupVerifiedUserAndKeys(app, outbound, "tencent-retry@example.com");
    const submitRpc = createRpcClients(app, { apiKey: user.submitKey });

    const { changeRequest } = await submitRpc.changeRequest.createChangeRequest({
      target: mediaRef({ tmdb: { type: "tv", id: 108545 } }),
      namespace: "tencent",
      nativeId: "https://v.qq.com/x/cover/mzc002007knmh3g.html",
      variantDescription: "原声",
      segments: [
        toProtoSegmentInput({
          season: 1,
          episodeStart: 1,
          episodeEnd: 30,
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

    // Attempt 1: non-zero Tencent RPC ret -> rescheduled, stays pending_evidence
    await worker.scheduled(createScheduledController(now));
    expect(emitted).toHaveLength(1);
    const attempt1 = await worker.queue(createQueueBatch([emitted.shift()!], now).batch);
    expect(attempt1.rescheduled).toBe(1);

    expect(
      (await getChangeRequestStateRpc(app, { apiKey: user.readKey }, changeRequest!.id)).status,
    ).toBe("pending_evidence");

    // Attempt 2 after retry backoff: Tencent recovers -> auto-approved!
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
