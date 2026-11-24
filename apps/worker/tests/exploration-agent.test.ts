import type { Message, MessageBatch, ScheduledController } from "@cloudflare/workers-types";
import { createApiApp } from "@media-ref/api/app";
import { resolveEpisode } from "@media-ref/client";
import {
  createFakeOutboundClient,
  deriveExplorationTaskId,
  EVIDENCE_CHECK_JOB_TYPE,
  EXPLORATION_AGENT_USER_ID,
  EXPLORATION_JOB_TYPE,
  getJobById,
  listDemands,
  seedTmdbExportIds,
  type ExternalHttpRequest,
  type ExternalHttpResponse,
  type JobQueueMessage,
  type ModelInvocationRequest,
  type ModelInvocationResponse,
} from "@media-ref/core";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  createBackgroundWorker,
  parseWorkerConfig,
  type BackgroundWorkerEnv,
} from "../src/index.ts";
import {
  createRpcClients,
  expectRpcError,
  getMediaDocumentRpc,
  issueApiKeyRpc,
  mediaRef,
  proto,
  signUpAndVerifyUser,
  TEST_BASE_URL,
  toProtoSegmentInput,
} from "./rpc-helpers.ts";

const TEST_AUTH_SECRET = "test-secret-for-exploration-agent-e2e-tests-0123456789abcdef";

function jsonResponse(url: string, payload: unknown, status = 200): ExternalHttpResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
    url,
  };
}

function makeBilibiliEpisodes(count: number, idBase = 341200) {
  const episodes: Array<Record<string, unknown>> = [];
  for (let i = 1; i <= count; i += 1) {
    episodes.push({
      id: idBase + i,
      title: String(i),
      long_title: `第${i}话`,
      badge: i > 1 ? "会员" : "",
      badge_type: 0,
      section_type: 0,
      duration: 1435000,
    });
  }
  episodes.push({
    id: idBase + 9000,
    title: "预告",
    long_title: "下集预告",
    badge: "预告",
    badge_type: 1,
    section_type: 0,
    duration: 30000,
  });
  return episodes;
}

async function setupApiKeys(
  app: ReturnType<typeof createApiApp>,
  outbound: ReturnType<typeof createFakeOutboundClient>,
  email: string,
) {
  const { cookie } = await signUpAndVerifyUser(app, outbound, {
    email,
    name: "Agent E2E Tester",
  });
  const readKey = await issueApiKeyRpc(app, cookie, { name: "Read Key", canSubmit: false });
  const submitKey = await issueApiKeyRpc(app, cookie, { name: "Submit Key", canSubmit: true });

  return {
    cookie,
    readKey: readKey.key,
    submitKey: submitKey.key,
  };
}

function createScheduledController(scheduledTime: Date): ScheduledController {
  return {
    scheduledTime: scheduledTime.getTime(),
    cron: "* * * * *",
    noRetry() {},
  };
}

function createQueueBatch(
  bodies: JobQueueMessage[],
  timestamp: Date = new Date(),
): {
  batch: MessageBatch<JobQueueMessage>;
  ackedIds: () => string[];
} {
  const acked: string[] = [];
  const messages: Message<JobQueueMessage>[] = bodies.map((body, index) => {
    const id = `msg-${index + 1}-${body.jobId}-gen-${body.leaseGeneration}`;
    return {
      id,
      timestamp,
      body,
      attempts: 1,
      ack() {
        acked.push(id);
      },
      retry() {},
    };
  });

  const batch: MessageBatch<JobQueueMessage> = {
    queue: "media-ref-jobs",
    messages,
    metadata: {
      metrics: {
        backlogCount: messages.length,
        backlogBytes: 0,
      },
    },
    ackAll() {
      for (const msg of messages) {
        acked.push(msg.id);
      }
    },
    retryAll() {},
  };

  return { batch, ackedIds: () => acked };
}

function createJjkOutboundHttpHandler() {
  return (request: ExternalHttpRequest): ExternalHttpResponse => {
    if (request.namespace === "tmdb" && request.url.includes("/tv/95479")) {
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
    if (request.namespace === "trakt") {
      return jsonResponse(request.url, []);
    }
    if (
      request.namespace === "bilibili" &&
      request.url.startsWith("https://api.bilibili.com/x/web-interface/search/type")
    ) {
      const url = new URL(request.url);
      if (url.searchParams.get("search_type") === "media_bangumi") {
        return jsonResponse(request.url, {
          code: 0,
          message: "0",
          data: {
            result: [
              {
                season_id: 34430,
                title: '<em class="keyword">咒术回战</em>',
                org_title: "呪術廻戦",
                media_type: 1,
                pubtime: 1601659500,
                ep_size: 24,
              },
              {
                season_id: 45574,
                title: '<em class="keyword">咒术回战</em> 第二季',
                org_title: "呪術廻戦 懐玉・玉折／渋谷事変",
                media_type: 1,
                pubtime: 1688659200,
                ep_size: 23,
              },
            ],
          },
        });
      }
      return jsonResponse(request.url, { code: 0, data: { result: [] } });
    }
    if (
      request.namespace === "bilibili" &&
      request.url === "https://api.bilibili.com/pgc/view/web/season?season_id=34430"
    ) {
      return jsonResponse(request.url, {
        code: 0,
        message: "success",
        result: {
          season_id: 34430,
          title: "咒术回战",
          season_title: "第一季",
          jp_title: "呪術廻戦",
          type: 1,
          total: 24,
          publish: { pub_time: "2020-10-03 01:25:00" },
          episodes: makeBilibiliEpisodes(24, 341200),
        },
      });
    }
    if (
      request.namespace === "bilibili" &&
      request.url === "https://api.bilibili.com/pgc/view/web/season?season_id=45574"
    ) {
      return jsonResponse(request.url, {
        code: 0,
        message: "success",
        result: {
          season_id: 45574,
          title: "咒术回战 第二季",
          season_title: "第二季",
          jp_title: "呪術廻戦",
          type: 1,
          total: 23,
          publish: { pub_time: "2023-07-06 23:56:00" },
          episodes: makeBilibiliEpisodes(23, 750100),
        },
      });
    }
    if (
      request.namespace === "iqiyi" &&
      request.url.startsWith("https://search.video.iqiyi.com/o")
    ) {
      return jsonResponse(request.url, { code: "A00000", data: { code: 0, docinfos: [] } });
    }
    throw new Error(`Unexpected outbound request: ${request.namespace} ${request.url}`);
  };
}

function createSeasonAwareJjkModelHandler(): (
  request: ModelInvocationRequest,
) => ModelInvocationResponse {
  return (request) => {
    const userPrompt = request.messages.find((m) => m.role === "user")?.content ?? "";
    const isIqiyi = userPrompt.includes('"targetPlatform": "iqiyi"');
    const isSeason2 = userPrompt.includes('"requestedSeason": 2');
    const season = isSeason2 ? 2 : 1;
    const nativeId = isSeason2 ? "ss45574" : "ss34430";
    const episodeEnd = isSeason2 ? 23 : 24;

    const toolResults = request.messages.filter((m) => m.role === "tool");
    if (isIqiyi) {
      if (toolResults.length === 0) {
        return {
          content: null,
          toolCalls: [
            {
              id: `call_iqiyi_search_s${season}`,
              name: "search_platform",
              arguments: { keyword: isSeason2 ? "咒术回战 第二季" : "咒术回战" },
            },
          ],
          model: request.model ?? "test-model",
        };
      }
      return {
        content: null,
        toolCalls: [
          {
            id: `call_iqiyi_nf_s${season}`,
            name: "mark_not_found",
            arguments: { reason: "not_on_iqiyi" },
          },
        ],
        model: request.model ?? "test-model",
      };
    }

    if (toolResults.length === 0) {
      return {
        content: null,
        toolCalls: [
          {
            id: `call_search_s${season}`,
            name: "search_platform",
            arguments: { keyword: isSeason2 ? "咒术回战 第二季" : "咒术回战" },
          },
        ],
        model: request.model ?? "test-model",
      };
    }
    if (toolResults.length === 1) {
      return {
        content: null,
        toolCalls: [
          {
            id: `call_inspect_s${season}`,
            name: "inspect_collection",
            arguments: { nativeId },
          },
        ],
        model: request.model ?? "test-model",
      };
    }
    return {
      content: null,
      toolCalls: [
        {
          id: `call_submit_s${season}`,
          name: "submit_candidate",
          arguments: {
            nativeId,
            variantDescription: "原声",
            segments: [
              {
                season,
                episodeStart: 1,
                episodeEnd,
                targetEpisodeStart: 1,
              },
            ],
          },
        },
      ],
      model: request.model ?? "test-model",
    };
  };
}

describe("Exploration agent loop and Bilibili Tier 3 E2E (#29)", () => {
  const handles: TestDbHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop();
      if (handle) {
        await handle.cleanup();
      }
    }
  });

  test("full miss-to-hit path: 404 read -> demand -> scheduled -> exploration agent -> evidence gate -> 200 read resolvable via resolveEpisode", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-24T01:00:00.000Z");
    const pendingBgTasks: Promise<unknown>[] = [];

    const outbound = createFakeOutboundClient({
      fetchExternal: createJjkOutboundHttpHandler(),
      invokeModel: createSeasonAwareJjkModelHandler(),
    });

    const apiApp = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      onBackgroundTask(promise) {
        pendingBgTasks.push(promise);
      },
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => t0,
      },
    });

    const { readKey } = await setupApiKeys(apiApp, outbound, "e2e-miss-to-hit@example.com");

    // 1. Read unseen external key -> 404 + records demand (NO media created yet!)
    const missErr = await expectRpcError(
      getMediaDocumentRpc(apiApp, readKey, "tmdb:tv:95479", {
        season: 1,
        namespaceGroup: proto.NamespaceGroup.PLATFORM,
      }),
    );
    expect(missErr.status).toBe(404);
    await Promise.all(pendingBgTasks);

    const mediaBefore = await testDb.readDb.selectFrom("media").select("id").execute();
    expect(mediaBefore).toHaveLength(0);

    // 2. Sync TMDB export list containing 95479
    await seedTmdbExportIds(testDb.writeDb, [{ mediaType: "tv", tmdbId: "95479" }], "2026-11-24");

    // 3. Background worker (default exploration agent — NO custom executor override!)
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
        enableDailyTmdbSync: false,
        exploration: { dailyBudget: 10 },
      },
      now: () => t0,
    });

    // 4. scheduled claims demand -> deducts budget -> enqueues exploration job
    await worker.scheduled(createScheduledController(t0));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.jobType).toBe(EXPLORATION_JOB_TYPE);
    const explorationJobId = emitted[0]!.jobId;

    // 5. queue executes exploration agent -> creates media lazily -> searches Tier 3 platforms (bilibili & iqiyi) -> inspects ss34430 -> submits CR + enqueues evidence_check
    const expSummary = await worker.queue(createQueueBatch(emitted, t0).batch);
    expect(expSummary.completed).toBe(1);
    const modelCallsAfterExploration = outbound.modelRequests.length;
    expect(modelCallsAfterExploration).toBe(5); // 3 for bilibili (search/inspect/submit) + 2 for iqiyi (search/not_found)

    const completedExpJob = await getJobById(testDb.readDb, explorationJobId);
    expect(completedExpJob?.status).toBe("completed");
    expect(typeof completedExpJob?.result?.durationMs).toBe("number");

    const expectedBilibiliTaskId = await deriveExplorationTaskId(explorationJobId, "bilibili", 2);
    const agentCrs = await testDb.readDb
      .selectFrom("change_requests")
      .selectAll()
      .where("task_id", "=", expectedBilibiliTaskId)
      .execute();
    expect(agentCrs).toHaveLength(1);
    expect(agentCrs[0]?.submitter_type).toBe("agent");
    expect(agentCrs[0]?.submitter_user_id).toBe(EXPLORATION_AGENT_USER_ID);
    expect(agentCrs[0]?.variant_description).toBe("原声");
    expect(agentCrs[0]?.set_default_variant).toBe(true);
    expect(agentCrs[0]?.status).toBe("pending_evidence");

    // System exploration agent user MUST have role="user" (never reviewer)
    const agentUser = await testDb.readDb
      .selectFrom("user")
      .select(["id", "role", "emailVerified"])
      .where("id", "=", EXPLORATION_AGENT_USER_ID)
      .executeTakeFirstOrThrow();
    expect(agentUser.role).toBe("user");
    expect(agentUser.emailVerified).toBe(true);

    // 6. scheduled + queue executes evidence_check -> passes Step 1 + Step 2 -> auto-approves!
    emitted.length = 0;
    await worker.scheduled(createScheduledController(t0));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.jobType).toBe(EVIDENCE_CHECK_JOB_TYPE);

    const evSummary = await worker.queue(createQueueBatch(emitted, t0).batch);
    expect(evSummary.completed).toBe(1);

    // Zero second LLM review model calls — Evidence Gate is purely deterministic code!
    expect(outbound.modelRequests).toHaveLength(modelCallsAfterExploration);

    // 7. Read again -> 200 with confirmed Bilibili ss34430 & resolvable via @media-ref/client
    const hitBody = await getMediaDocumentRpc(apiApp, readKey, "tmdb:tv:95479");
    expect(hitBody.document.media.snapshot.title).toBe("咒术回战");
    expect(hitBody.document.variants).toHaveLength(1);
    expect(hitBody.document.variants[0]).toMatchObject({
      namespace: "bilibili",
      label: "原声",
      isDefault: true,
    });
    expect(hitBody.document.associations).toHaveLength(1);
    expect(hitBody.document.associations[0]?.namespace).toBe("bilibili");
    expect(hitBody.document.associations[0]?.nativeId).toBe("ss34430");
    expect(hitBody.document.associations[0]?.status).toBe("confirmed");

    const resolvedEp = resolveEpisode(hitBody.document, {
      namespace: "bilibili",
      season: 1,
      episode: 12,
    });
    expect(resolvedEp).toMatchObject({
      kind: "mapped",
      namespace: "bilibili",
      nativeId: "ss34430",
      targetEpisode: 12,
    });
  });

  test("existing media with Season 1 confirmed and Season 2 missing: GET ?season=2 records demand -> exploration confirms Season 2 under same default variant", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-24T02:00:00.000Z");
    const pendingBgTasks: Promise<unknown>[] = [];

    const outbound = createFakeOutboundClient({
      fetchExternal: createJjkOutboundHttpHandler(),
      invokeModel: createSeasonAwareJjkModelHandler(),
    });

    const apiApp = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      onBackgroundTask(promise) {
        pendingBgTasks.push(promise);
      },
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => t0,
      },
    });

    const { readKey, submitKey } = await setupApiKeys(
      apiApp,
      outbound,
      "e2e-missing-s2@example.com",
    );

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
        enableDailyTmdbSync: false,
        exploration: { dailyBudget: 10 },
      },
      now: () => t0,
    });

    // Seed existing media with Season 1 confirmed via the public submission & Evidence Gate flow
    const submitS1Res = await createRpcClients(apiApp, {
      apiKey: submitKey,
    }).changeRequest.createChangeRequest({
      target: mediaRef("tmdb:tv:95479"),
      namespace: "bilibili",
      nativeId: "ss34430",
      variantDescription: "原声",
      setDefaultVariant: true,
      segments: [
        toProtoSegmentInput({ season: 1, episodeStart: 1, episodeEnd: 24, targetEpisodeStart: 1 }),
      ],
    });
    expect(submitS1Res.changeRequest?.id).toBeTruthy();

    await worker.scheduled(createScheduledController(t0));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.jobType).toBe(EVIDENCE_CHECK_JOB_TYPE);
    await worker.queue(createQueueBatch(emitted, t0).batch);
    emitted.length = 0;

    // 1. Read existing media requesting Season 2 -> 200 (S1 only), records demand for Season 2!
    const readS2MissBody = await getMediaDocumentRpc(apiApp, readKey, "tmdb:tv:95479", {
      season: 2,
      namespaceGroup: proto.NamespaceGroup.PLATFORM,
    });
    expect(
      resolveEpisode(readS2MissBody.document, { namespace: "bilibili", season: 2, episode: 5 }),
    ).toMatchObject({ kind: "unmapped" });
    await Promise.all(pendingBgTasks);

    // 2. scheduled claims Season 2 demand -> exploration agent discovers ss45574 -> Evidence Gate approves!
    await worker.scheduled(createScheduledController(t0));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.jobType).toBe(EXPLORATION_JOB_TYPE);
    expect(emitted[0]?.payload.season).toBe(2);

    const expSummary = await worker.queue(createQueueBatch(emitted, t0).batch);
    expect(expSummary.completed).toBe(1);

    emitted.length = 0;
    await worker.scheduled(createScheduledController(t0));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.jobType).toBe(EVIDENCE_CHECK_JOB_TYPE);
    const evSummary = await worker.queue(createQueueBatch(emitted, t0).batch);
    expect(evSummary.completed).toBe(1);

    // 3. GetMedia now resolves BOTH Season 1 and Season 2 under the same default "原声" variant!
    const doc = (await getMediaDocumentRpc(apiApp, readKey, "tmdb:tv:95479")).document;
    expect(doc.variants).toHaveLength(1);
    expect(doc.associations.map((a) => a.nativeId).sort()).toEqual(["ss34430", "ss45574"]);

    expect(resolveEpisode(doc, { namespace: "bilibili", season: 1, episode: 24 })).toMatchObject({
      kind: "mapped",
      nativeId: "ss34430",
      targetEpisode: 24,
    });
    expect(resolveEpisode(doc, { namespace: "bilibili", season: 2, episode: 10 })).toMatchObject({
      kind: "mapped",
      nativeId: "ss45574",
      targetEpisode: 10,
    });
  });

  test("read request omitting season records demands for all missing seasons and exploration resolves every season", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-24T03:00:00.000Z");
    const pendingBgTasks: Promise<unknown>[] = [];

    const outbound = createFakeOutboundClient({
      fetchExternal: createJjkOutboundHttpHandler(),
      invokeModel: createSeasonAwareJjkModelHandler(),
    });

    const apiApp = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      onBackgroundTask(promise) {
        pendingBgTasks.push(promise);
      },
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => t0,
      },
    });

    const { readKey } = await setupApiKeys(apiApp, outbound, "e2e-seasonless@example.com");
    await seedTmdbExportIds(testDb.writeDb, [{ mediaType: "tv", tmdbId: "95479" }], "2026-11-24");

    // Read WITHOUT season -> 404, records seasonless external-key demand
    const missErr = await expectRpcError(getMediaDocumentRpc(apiApp, readKey, "tmdb:tv:95479"));
    expect(missErr.status).toBe(404);
    await Promise.all(pendingBgTasks);

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
        enableDailyTmdbSync: false,
        exploration: { dailyBudget: 10 },
      },
      now: () => t0,
    });

    // Tick 1: claims seasonless external-key demand -> lazily creates media, splits into S1 (leased) & S2 (open), explores S1
    await worker.scheduled(createScheduledController(t0));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.jobType).toBe(EXPLORATION_JOB_TYPE);
    await worker.queue(createQueueBatch(emitted, t0).batch);

    // Tick 2: claims evidence_check for S1 AND exploration for S2!
    emitted.length = 0;
    await worker.scheduled(createScheduledController(t0));
    expect(emitted.map((m) => m.jobType).sort()).toEqual([
      EVIDENCE_CHECK_JOB_TYPE,
      EXPLORATION_JOB_TYPE,
    ]);
    await worker.queue(createQueueBatch(emitted, t0).batch);

    // Tick 3: claims evidence_check for S2
    emitted.length = 0;
    await worker.scheduled(createScheduledController(t0));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.jobType).toBe(EVIDENCE_CHECK_JOB_TYPE);
    await worker.queue(createQueueBatch(emitted, t0).batch);

    // Both Season 1 and Season 2 are now confirmed and resolvable!
    const doc = (await getMediaDocumentRpc(apiApp, readKey, "tmdb:tv:95479")).document;
    expect(resolveEpisode(doc, { namespace: "bilibili", season: 1, episode: 1 })).toMatchObject({
      kind: "mapped",
      nativeId: "ss34430",
      targetEpisode: 1,
    });
    expect(resolveEpisode(doc, { namespace: "bilibili", season: 2, episode: 23 })).toMatchObject({
      kind: "mapped",
      nativeId: "ss45574",
      targetEpisode: 23,
    });
  });

  test("mismatched candidate submitted by agent is routed to needs_review by Evidence Gate and NOT returned in default GET", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-24T04:00:00.000Z");
    const pendingBgTasks: Promise<unknown>[] = [];

    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        if (request.namespace === "tmdb" && request.url.includes("/tv/95479")) {
          return jsonResponse(request.url, {
            id: 95479,
            name: "咒术回战",
            original_name: "呪術廻戦",
            first_air_date: "2020-10-03",
            seasons: [{ season_number: 1, episode_count: 24, air_date: "2020-10-03" }],
            external_ids: {},
          });
        }
        if (request.namespace === "trakt") {
          return jsonResponse(request.url, []);
        }
        if (
          request.namespace === "bilibili" &&
          request.url.startsWith("https://api.bilibili.com/x/web-interface/search/type")
        ) {
          return jsonResponse(request.url, {
            code: 0,
            data: {
              result: [
                {
                  season_id: 99887,
                  title: "咒术回战 伪番外",
                  media_type: 1,
                  pubtime: 1546300800, // 2019 (wrong year!)
                  ep_size: 12, // wrong episode count!
                },
              ],
            },
          });
        }
        if (
          request.namespace === "bilibili" &&
          request.url === "https://api.bilibili.com/pgc/view/web/season?season_id=99887"
        ) {
          return jsonResponse(request.url, {
            code: 0,
            result: {
              season_id: 99887,
              title: "咒术回战",
              type: 1,
              publish: { pub_time: "2019-01-01 00:00:00" }, // wrong year
              episodes: makeBilibiliEpisodes(12, 880000), // wrong episode count (12 != 24)
            },
          });
        }
        if (
          request.namespace === "iqiyi" &&
          request.url.startsWith("https://search.video.iqiyi.com/o")
        ) {
          return jsonResponse(request.url, { code: "A00000", data: { code: 0, docinfos: [] } });
        }
        throw new Error(`Unexpected outbound request: ${request.namespace} ${request.url}`);
      },
      invokeModel(request) {
        const userPrompt = request.messages.find((m) => m.role === "user")?.content ?? "";
        const toolResults = request.messages.filter((m) => m.role === "tool");
        if (userPrompt.includes('"targetPlatform": "iqiyi"')) {
          if (toolResults.length === 0) {
            return {
              content: null,
              toolCalls: [
                { id: "c_iq1", name: "search_platform", arguments: { keyword: "咒术回战" } },
              ],
              model: request.model ?? "test-model",
            };
          }
          return {
            content: null,
            toolCalls: [
              { id: "c_iq2", name: "mark_not_found", arguments: { reason: "not_on_iqiyi" } },
            ],
            model: request.model ?? "test-model",
          };
        }
        if (toolResults.length === 0) {
          return {
            content: null,
            toolCalls: [{ id: "c1", name: "search_platform", arguments: { keyword: "咒术回战" } }],
            model: request.model ?? "test-model",
          };
        }
        return {
          content: null,
          toolCalls: [
            {
              id: "c2",
              name: "submit_candidate",
              arguments: {
                nativeId: "ss99887",
                variantDescription: "原声",
                segments: [{ season: 1, episodeStart: 1, episodeEnd: 24, targetEpisodeStart: 1 }],
              },
            },
          ],
          model: request.model ?? "test-model",
        };
      },
    });

    const apiApp = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      onBackgroundTask(promise) {
        pendingBgTasks.push(promise);
      },
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => t0,
      },
    });

    const { readKey } = await setupApiKeys(apiApp, outbound, "e2e-mismatch@example.com");
    await seedTmdbExportIds(testDb.writeDb, [{ mediaType: "tv", tmdbId: "95479" }], "2026-11-24");

    await expectRpcError(
      getMediaDocumentRpc(apiApp, readKey, "tmdb:tv:95479", {
        season: 1,
        namespaceGroup: proto.NamespaceGroup.PLATFORM,
      }),
    );
    await Promise.all(pendingBgTasks);

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
        enableDailyTmdbSync: false,
        exploration: { dailyBudget: 10 },
      },
      now: () => t0,
    });

    // Exploration runs and submits mismatched ss99887
    await worker.scheduled(createScheduledController(t0));
    await worker.queue(createQueueBatch(emitted, t0).batch);

    // Evidence Gate evaluates ss99887 -> routes to needs_review!
    emitted.length = 0;
    await worker.scheduled(createScheduledController(t0));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.jobType).toBe(EVIDENCE_CHECK_JOB_TYPE);
    await worker.queue(createQueueBatch(emitted, t0).batch);

    const crs = await testDb.readDb.selectFrom("change_requests").selectAll().execute();
    expect(crs).toHaveLength(1);
    expect(crs[0]?.status).toBe("needs_review");
    expect(crs[0]?.conflict_reason).toBeTruthy();

    // Default GetMedia MUST NOT return the unconfirmed/mismatched candidate
    const defaultDoc = (await getMediaDocumentRpc(apiApp, readKey, "tmdb:tv:95479")).document;
    expect(defaultDoc.associations).toHaveLength(0);

    // includeUnconfirmed=true exposes it explicitly tagged unconfirmed
    const unconfirmedDoc = (
      await getMediaDocumentRpc(apiApp, readKey, "tmdb:tv:95479", { includeUnconfirmed: true })
    ).document;
    expect(unconfirmedDoc.associations).toHaveLength(1);
    expect(unconfirmedDoc.associations[0]?.nativeId).toBe("ss99887");
    expect(unconfirmedDoc.associations[0]?.unconfirmed).toBe(true);
  });

  test("duplicate queue delivery (sequential and concurrent) creates strictly ONE change request and deducts daily budget ONCE", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-24T05:00:00.000Z");

    const createSeededMediaWithDemand = async (tmdbId: string, title: string) => {
      const media = await testDb.writeDb
        .insertInto("media")
        .values({
          type: "tv",
          baseline: "tmdb",
          title,
          original_title: title,
          year: 2020,
          seasons: JSON.stringify([{ season: 1, episodeCount: 24, airYear: 2020 }]),
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      await testDb.writeDb
        .insertInto("external_ids")
        .values({
          media_id: media.id,
          namespace: "tmdb",
          native_id: `tv:${tmdbId}`,
          source: "sync",
        })
        .execute();

      await testDb.writeDb
        .insertInto("demands")
        .values({
          media_id: media.id,
          season: 1,
          namespace_group: "platform",
          demand_count: 10,
          status: "open",
          next_eligible_at: t0,
          last_demanded_at: t0,
        })
        .execute();

      return media.id;
    };

    const seqMediaId = await createSeededMediaWithDemand("95479", "咒术回战");

    const outbound = createFakeOutboundClient({
      fetchExternal: createJjkOutboundHttpHandler(),
      invokeModel: createSeasonAwareJjkModelHandler(),
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
        enableDailyTmdbSync: false,
        exploration: { dailyBudget: 10 },
      },
      now: () => t0,
    });

    // 1. Sequential duplicate delivery of the exact same exploration message
    await worker.scheduled(createScheduledController(t0));
    expect(emitted).toHaveLength(1);
    const seqMsg = emitted[0]!;

    const seqRes1 = await worker.queue(createQueueBatch([seqMsg], t0).batch);
    const seqRes2 = await worker.queue(createQueueBatch([seqMsg], t0).batch);
    expect(seqRes1.completed).toBe(1);
    expect(seqRes2.discarded).toBe(1);

    const seqCrs = await testDb.readDb
      .selectFrom("change_requests")
      .selectAll()
      .where("media_id", "=", seqMediaId)
      .execute();
    expect(seqCrs).toHaveLength(1);
    expect(seqCrs[0]?.task_id).toBe(await deriveExplorationTaskId(seqMsg.jobId, "bilibili", 2));

    const budgetAfterSeq = await testDb.readDb
      .selectFrom("exploration_daily_budget")
      .select("consumed")
      .where("budget_date", "=", "2026-11-24")
      .executeTakeFirstOrThrow();
    expect(budgetAfterSeq.consumed).toBe(1);

    // 2. Concurrent duplicate delivery racing in parallel -> task_id lock & unique index enforce 1 CR!
    emitted.length = 0;
    const raceMediaId = await createSeededMediaWithDemand("95480", "咒术回战");
    await worker.scheduled(createScheduledController(t0));
    const raceMsg = emitted.find((m) => m.jobType === EXPLORATION_JOB_TYPE)!;
    expect(raceMsg).toBeDefined();

    const [raceResA, raceResB] = await Promise.all([
      worker.queue(createQueueBatch([raceMsg], t0).batch),
      worker.queue(createQueueBatch([raceMsg], t0).batch),
    ]);
    expect(raceResA.completed + raceResB.completed).toBe(1);
    expect(raceResA.discarded + raceResB.discarded).toBe(1);

    const raceCrs = await testDb.readDb
      .selectFrom("change_requests")
      .selectAll()
      .where("media_id", "=", raceMediaId)
      .execute();
    expect(raceCrs).toHaveLength(1);
    expect(raceCrs[0]?.task_id).toBe(await deriveExplorationTaskId(raceMsg.jobId, "bilibili", 2));

    // Total daily budget strictly 2 (1 for sequential + 1 for concurrent)
    const budgetAfterRace = await testDb.readDb
      .selectFrom("exploration_daily_budget")
      .select("consumed")
      .where("budget_date", "=", "2026-11-24")
      .executeTakeFirstOrThrow();
    expect(budgetAfterRace.consumed).toBe(2);
  });

  test("not_found updates platform_checks + GET platformStatuses.bilibili + backoff, while transient errors NEVER mark not_found", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-24T06:00:00.000Z");
    const pendingBgTasks: Promise<unknown>[] = [];

    const notFoundMedia = await testDb.writeDb
      .insertInto("media")
      .values({
        type: "movie",
        baseline: "tmdb",
        title: "完全不存在的冷门电影",
        original_title: "Obscure Missing Film",
        year: 2024,
        seasons: JSON.stringify([]),
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await testDb.writeDb
      .insertInto("external_ids")
      .values({
        media_id: notFoundMedia.id,
        namespace: "tmdb",
        native_id: "movie:888881",
        source: "sync",
      })
      .execute();

    const transientMedia = await testDb.writeDb
      .insertInto("media")
      .values({
        type: "movie",
        baseline: "tmdb",
        title: "遇到412风控的电影",
        original_title: "Rate Limited Film",
        year: 2024,
        seasons: JSON.stringify([]),
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await testDb.writeDb
      .insertInto("external_ids")
      .values({
        media_id: transientMedia.id,
        namespace: "tmdb",
        native_id: "movie:888882",
        source: "sync",
      })
      .execute();

    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        if (request.url.includes(encodeURIComponent("遇到412风控的电影"))) {
          return {
            status: request.namespace === "bilibili" ? 412 : 503,
            headers: { "content-type": "text/html" },
            body: "<html>risk control</html>",
            url: request.url,
          };
        }
        if (request.namespace === "iqiyi") {
          return jsonResponse(request.url, { code: "A00000", data: { code: 0, docinfos: [] } });
        }
        return jsonResponse(request.url, { code: 0, data: { numResults: 0, result: [] } });
      },
      invokeModel(request) {
        const userPrompt = request.messages.find((m) => m.role === "user")?.content ?? "";
        const isTransient = userPrompt.includes("遇到412风控的电影");
        const toolResults = request.messages.filter((m) => m.role === "tool");
        if (toolResults.length === 0) {
          return {
            content: null,
            toolCalls: [
              {
                id: "call_s",
                name: "search_platform",
                arguments: {
                  keyword: isTransient ? "遇到412风控的电影" : "完全不存在的冷门电影",
                },
              },
            ],
            model: request.model ?? "test-model",
          };
        }
        // Even if model tries to call mark_not_found after a 412 transient error, the agent
        // loop MUST treat it as transient_error and NEVER mark platform_checks as not_found!
        return {
          content: null,
          toolCalls: [
            {
              id: "call_nf",
              name: "mark_not_found",
              arguments: { reason: "empty_search_results" },
            },
          ],
          model: request.model ?? "test-model",
        };
      },
    });

    const apiApp = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      onBackgroundTask(promise) {
        pendingBgTasks.push(promise);
      },
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => t0,
      },
    });

    const { readKey } = await setupApiKeys(apiApp, outbound, "e2e-not-found@example.com");

    // Trigger demands for both existing movies via MediaService.GetMedia
    await getMediaDocumentRpc(apiApp, readKey, "tmdb:movie:888881");
    await getMediaDocumentRpc(apiApp, readKey, "tmdb:movie:888882");
    await Promise.all(pendingBgTasks);

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
        enableDailyTmdbSync: false,
        exploration: {
          dailyBudget: 10,
          notFoundBackoffSeconds: [3600, 10800],
        },
      },
      now: () => t0,
    });

    await worker.scheduled(createScheduledController(t0));
    expect(emitted).toHaveLength(2);
    await worker.queue(createQueueBatch(emitted, t0).batch);

    // 1. Clean empty search -> platformStatuses.bilibili === "not_found" + demand backoff applied
    const nfDoc = (await getMediaDocumentRpc(apiApp, readKey, "tmdb:movie:888881")).document;
    expect(nfDoc.platformStatuses?.bilibili).toEqual({
      status: "not_found",
      checkedAt: t0.toISOString(),
    });

    const nfDemands = await listDemands(testDb.readDb, { mediaId: notFoundMedia.id });
    expect(nfDemands[0]?.status).toBe("not_found");
    expect(nfDemands[0]?.notFoundCount).toBe(1);
    expect(nfDemands[0]?.nextEligibleAt).toBe(new Date(t0.getTime() + 3600 * 1000).toISOString());

    // 2. HTTP 412 transient error -> NEVER marked not_found, platformStatuses stays "unchecked", demand stays "open"
    const trDoc = (await getMediaDocumentRpc(apiApp, readKey, "tmdb:movie:888882")).document;
    expect(trDoc.platformStatuses?.bilibili).toEqual({ status: "unchecked" });

    const trDemands = await listDemands(testDb.readDb, { mediaId: transientMedia.id });
    expect(trDemands[0]?.status).toBe("open");
    expect(trDemands[0]?.notFoundCount).toBe(0);
  });

  test("enforces original-audio default policy, surfaces client leads as hints, and switches provider/model purely via config", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-24T07:00:00.000Z");
    const pendingBgTasks: Promise<unknown>[] = [];

    const media = await testDb.writeDb
      .insertInto("media")
      .values({
        type: "movie",
        baseline: "tmdb",
        title: "哈利·波特与魔法石",
        original_title: "Harry Potter and the Philosopher's Stone",
        year: 2001,
        seasons: JSON.stringify([]),
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await testDb.writeDb
      .insertInto("external_ids")
      .values({
        media_id: media.id,
        namespace: "tmdb",
        native_id: "movie:671",
        source: "sync",
      })
      .execute();

    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        if (request.namespace === "tmdb" && request.url.includes("/movie/671")) {
          return jsonResponse(request.url, {
            id: 671,
            title: "哈利·波特与魔法石",
            original_title: "Harry Potter and the Philosopher's Stone",
            release_date: "2001-11-16",
            external_ids: { imdb_id: "tt0241527" },
          });
        }
        if (request.namespace === "trakt") {
          return jsonResponse(request.url, []);
        }
        if (request.url.includes("search/type")) {
          return jsonResponse(request.url, {
            code: 0,
            data: {
              result: [
                {
                  season_id: 28281,
                  title: "哈利·波特与魔法石（中配）",
                  media_type: 2,
                  pubtime: 1005868800,
                  ep_size: 1,
                },
              ],
            },
          });
        }
        if (request.url.includes("season_id=28281")) {
          return jsonResponse(request.url, {
            code: 0,
            result: {
              season_id: 28281,
              title: "哈利·波特与魔法石",
              type: 2,
              publish: { pub_time: "2001-11-16 00:00:00" },
              episodes: makeBilibiliEpisodes(1, 279990),
            },
          });
        }
        if (
          request.namespace === "iqiyi" &&
          request.url.startsWith("https://search.video.iqiyi.com/o")
        ) {
          return jsonResponse(request.url, { code: "A00000", data: { code: 0, docinfos: [] } });
        }
        throw new Error(`Unexpected outbound request: ${request.namespace} ${request.url}`);
      },
      invokeModel(request) {
        const userPrompt = request.messages.find((m) => m.role === "user")?.content ?? "";
        const toolResults = request.messages.filter((m) => m.role === "tool");
        if (userPrompt.includes('"targetPlatform": "iqiyi"')) {
          if (toolResults.length === 0) {
            return {
              content: null,
              toolCalls: [
                {
                  id: "c_iq1",
                  name: "search_platform",
                  arguments: { keyword: "哈利·波特与魔法石" },
                },
              ],
              model: request.model ?? "custom-model",
            };
          }
          return {
            content: null,
            toolCalls: [
              { id: "c_iq2", name: "mark_not_found", arguments: { reason: "not_on_iqiyi" } },
            ],
            model: request.model ?? "custom-model",
          };
        }
        if (toolResults.length === 0) {
          return {
            content: null,
            toolCalls: [
              { id: "c1", name: "inspect_collection", arguments: { nativeId: "ss28281" } },
            ],
            model: request.model ?? "custom-model",
          };
        }
        return {
          content: null,
          toolCalls: [
            {
              id: "c2",
              name: "submit_candidate",
              arguments: {
                nativeId: "ss28281",
                // Dubbed variant: agent policy MUST force setDefaultVariant = false!
                variantDescription: "中配",
              },
            },
          ],
          model: request.model ?? "custom-model",
        };
      },
    });

    const apiApp = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      onBackgroundTask(promise) {
        pendingBgTasks.push(promise);
      },
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => t0,
      },
    });

    const { readKey } = await setupApiKeys(apiApp, outbound, "e2e-config-switch@example.com");

    // Report a client lead via LeadService.CreateLead (should appear as unverified hint in prompt)
    const leadRes = await createRpcClients(apiApp, { apiKey: readKey }).lead.createLead({
      target: mediaRef("tmdb:movie:671"),
      namespace: "bilibili",
      nativeId: "ss28281",
      notes: "B站中配版",
    });
    expect(leadRes.lead?.id).toBeTruthy();

    // Trigger read demand
    await getMediaDocumentRpc(apiApp, readKey, "tmdb:movie:671");
    await Promise.all(pendingBgTasks);

    // Parse env config -> swaps provider, model, gatewayId, maxSteps with ZERO code changes!
    const parsedConfig = parseWorkerConfig({
      AI_GATEWAY_ID: "media-ref-gw-prod",
      AI_PROVIDER: "anthropic",
      AI_MODEL: "claude-sonnet-4-5",
      EXPLORATION_MAX_STEPS: "6",
      EXPLORATION_MAX_DURATION_MS: "45000",
      EXPLORATION_DAILY_BUDGET: "25",
    } as unknown as BackgroundWorkerEnv);

    expect(parsedConfig.explorationAgent).toEqual({
      gatewayId: "media-ref-gw-prod",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      maxSteps: 6,
      maxDurationMs: 45_000,
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
        ...parsedConfig,
        enableDailyTmdbSync: false,
      },
      now: () => t0,
    });

    await worker.scheduled(createScheduledController(t0));
    await worker.queue(createQueueBatch(emitted, t0).batch);

    // Verify OutboundClient.invokeModel received the exact config-driven provider/model/gatewayId
    expect(outbound.modelRequests.length).toBeGreaterThanOrEqual(2);
    for (const req of outbound.modelRequests) {
      expect(req.provider).toBe("anthropic");
      expect(req.model).toBe("claude-sonnet-4-5");
      expect(req.gatewayId).toBe("media-ref-gw-prod");
    }

    // Verify client-reported lead was included in the prompt as unverified reference context
    const firstUserPrompt = outbound.modelRequests[0]?.messages.find(
      (m) => m.role === "user",
    )?.content;
    expect(firstUserPrompt).toContain("unverifiedClientLeads");
    expect(firstUserPrompt).toContain("ss28281");

    // Verify dubbed candidate had setDefaultVariant forced to false!
    const cr = await testDb.readDb
      .selectFrom("change_requests")
      .selectAll()
      .where("media_id", "=", media.id)
      .executeTakeFirstOrThrow();
    expect(cr.variant_description).toBe("中配");
    expect(cr.set_default_variant).toBe(false);
    expect(cr.status).toBe("pending_evidence");

    // Switching to another provider/model purely via config
    const openaiConfig = parseWorkerConfig({
      AI_GATEWAY_ID: "media-ref-gw-alt",
      AI_PROVIDER: "openai",
      AI_MODEL: "gpt-4o-mini",
    } as unknown as BackgroundWorkerEnv);
    expect(openaiConfig.explorationAgent).toMatchObject({
      gatewayId: "media-ref-gw-alt",
      provider: "openai",
      model: "gpt-4o-mini",
    });
  });

  test("exempts agent submissions from the 5/hour human submit quota and handles invokeModel transient failure without marking not_found", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-24T08:00:00.000Z");

    // Seed 7 distinct media items (6 will succeed > 5/hr human limit; 1 will trigger invokeModel throw)
    const mediaIds: string[] = [];
    for (let i = 1; i <= 7; i += 1) {
      const m = await testDb.writeDb
        .insertInto("media")
        .values({
          type: "movie",
          baseline: "tmdb",
          title: i === 7 ? "模型超时电影" : `批量探索电影 ${i}`,
          original_title: `Batch Film ${i}`,
          year: 2024,
          seasons: JSON.stringify([]),
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      await testDb.writeDb
        .insertInto("external_ids")
        .values({
          media_id: m.id,
          namespace: "tmdb",
          native_id: `movie:${900000 + i}`,
          source: "sync",
        })
        .execute();

      await testDb.writeDb
        .insertInto("demands")
        .values({
          media_id: m.id,
          season: null,
          namespace_group: "platform",
          demand_count: 10 - i,
          status: "open",
          next_eligible_at: t0,
          last_demanded_at: t0,
        })
        .execute();

      mediaIds.push(m.id);
    }

    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        if (request.namespace === "iqiyi") {
          return jsonResponse(request.url, { code: "A00000", data: { code: 0, docinfos: [] } });
        }
        return jsonResponse(request.url, { code: 0, data: { result: [] } });
      },
      invokeModel(request) {
        const userPrompt = request.messages.find((m) => m.role === "user")?.content ?? "";
        if (userPrompt.includes("模型超时电影")) {
          throw new Error("AI Gateway 503 Service Unavailable");
        }
        if (userPrompt.includes('"targetPlatform": "iqiyi"')) {
          const toolResults = request.messages.filter((m) => m.role === "tool");
          if (toolResults.length === 0) {
            return {
              content: null,
              toolCalls: [
                { id: "call_iq_s", name: "search_platform", arguments: { keyword: "电影" } },
              ],
              model: request.model ?? "test-model",
            };
          }
          return {
            content: null,
            toolCalls: [
              { id: "call_iq_nf", name: "mark_not_found", arguments: { reason: "not_on_iqiyi" } },
            ],
            model: request.model ?? "test-model",
          };
        }
        const match = userPrompt.match(/批量探索电影 (\d+)/);
        const idx = match ? Number(match[1]) : 1;
        return {
          content: null,
          toolCalls: [
            {
              id: `call_submit_${idx}`,
              name: "submit_candidate",
              arguments: {
                nativeId: `ss${50000 + idx}`,
                variantDescription: "原声",
              },
            },
          ],
          model: request.model ?? "test-model",
        };
      },
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
        enableDailyTmdbSync: false,
        exploration: { dailyBudget: 20, batchSize: 10 },
      },
      now: () => t0,
    });

    await worker.scheduled(createScheduledController(t0));
    expect(emitted).toHaveLength(7);

    const summary = await worker.queue(createQueueBatch(emitted, t0).batch);
    expect(summary.completed).toBe(7);

    // All 6 agent submissions succeeded within the same hour (> 5/hr human limit!)
    const agentCrs = await testDb.readDb
      .selectFrom("change_requests")
      .selectAll()
      .where("submitter_type", "=", "agent")
      .execute();
    expect(agentCrs).toHaveLength(6);

    // The 7th media whose invokeModel threw MUST NOT be marked not_found
    const failedMediaId = mediaIds[6]!;
    const failedDemands = await listDemands(testDb.readDb, { mediaId: failedMediaId });
    expect(failedDemands[0]?.status).toBe("open");
    expect(failedDemands[0]?.notFoundCount).toBe(0);

    const failedChecks = await testDb.readDb
      .selectFrom("platform_checks")
      .selectAll()
      .where("media_id", "=", failedMediaId)
      .execute();
    expect(failedChecks).toHaveLength(0);
  });

  test("aborts hanging invokeModel and fetchExternal calls at the maxDurationMs wall-clock deadline without marking not_found", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-24T09:30:00.000Z");

    const seedMovie = async (tmdbId: string, title: string) => {
      const media = await testDb.writeDb
        .insertInto("media")
        .values({
          type: "movie",
          baseline: "tmdb",
          title,
          original_title: title,
          year: 2024,
          seasons: JSON.stringify([]),
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      await testDb.writeDb
        .insertInto("external_ids")
        .values({
          media_id: media.id,
          namespace: "tmdb",
          native_id: `movie:${tmdbId}`,
          source: "sync",
        })
        .execute();

      await testDb.writeDb
        .insertInto("demands")
        .values({
          media_id: media.id,
          season: null,
          namespace_group: "platform",
          demand_count: 5,
          status: "open",
          next_eligible_at: t0,
          last_demanded_at: t0,
        })
        .execute();

      return media.id;
    };

    const hangModelMediaId = await seedMovie("999901", "模型挂起超时电影");
    const hangFetchMediaId = await seedMovie("999902", "检索挂起超时电影");

    let modelSignalAborted = false;
    let fetchSignalAborted = false;

    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        return new Promise((_resolve, reject) => {
          const onAbort = () => {
            fetchSignalAborted = true;
            reject(request.signal?.reason ?? new Error("aborted"));
          };
          if (request.signal?.aborted) {
            onAbort();
            return;
          }
          request.signal?.addEventListener("abort", onAbort, { once: true });
        });
      },
      invokeModel(request) {
        const userPrompt = request.messages.find((m) => m.role === "user")?.content ?? "";
        if (userPrompt.includes("检索挂起超时电影")) {
          return {
            content: null,
            toolCalls: [
              {
                id: "call_hang_fetch",
                name: "search_platform",
                arguments: { keyword: "超时测试" },
              },
            ],
            model: request.model ?? "test-model",
          };
        }
        return new Promise((_resolve, reject) => {
          const onAbort = () => {
            modelSignalAborted = true;
            reject(request.signal?.reason ?? new Error("aborted"));
          };
          if (request.signal?.aborted) {
            onAbort();
            return;
          }
          request.signal?.addEventListener("abort", onAbort, { once: true });
        });
      },
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
        enableDailyTmdbSync: false,
        exploration: { dailyBudget: 10, batchSize: 10 },
        explorationAgent: { maxDurationMs: 60 },
      },
      now: () => t0,
    });

    await worker.scheduled(createScheduledController(t0));
    expect(emitted).toHaveLength(2);

    const startedAt = Date.now();
    const summary = await worker.queue(createQueueBatch(emitted, t0).batch);
    const elapsedMs = Date.now() - startedAt;

    expect(summary.completed).toBe(2);
    expect(elapsedMs).toBeLessThan(2000);
    expect(modelSignalAborted).toBe(true);
    expect(fetchSignalAborted).toBe(true);

    // Neither media may be falsely marked not_found on a wall-clock timeout!
    for (const mediaId of [hangModelMediaId, hangFetchMediaId]) {
      const checks = await testDb.readDb
        .selectFrom("platform_checks")
        .selectAll()
        .where("media_id", "=", mediaId)
        .execute();
      expect(checks).toHaveLength(0);

      const demands = await listDemands(testDb.readDb, { mediaId });
      expect(demands[0]?.status).toBe("open");
      expect(demands[0]?.notFoundCount).toBe(0);
    }
  });
});
