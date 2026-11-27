import type { Message, MessageBatch, ScheduledController } from "@cloudflare/workers-types";
import type { SegmentInput } from "@media-ref/client";
import {
  approveChangeRequest,
  bilibiliAdapter,
  createAdapterRegistry,
  createChangeRequest,
  createChangeRequestComment,
  createReviewAgentJobHandler,
  completeJobWithFencing,
  getJobById,
  createDefaultAdapterRegistry,
  createFakeOutboundClient,
  createExplorationJobHandler,
  scheduleExplorationJobs,
  rejectChangeRequest,
  enqueuePendingReviews,
  ensureExplorationAgentUser,
  EXPLORATION_AGENT_USER_ID,
  type AdapterRegistry,
  type ExternalHttpRequest,
  type ExternalHttpResponse,
  type JobQueueMessage,
  type ModelInvocationRequest,
  type ModelInvocationResponse,
  type ModelToolCall,
} from "@media-ref/core";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  createBackgroundWorker,
  parseWorkerConfig,
  type BackgroundWorkerConfig,
  type BackgroundWorkerEnv,
} from "../src/index.ts";

// Review agent (ADR 0003 §1–3, §6): a change request the Evidence Gate sent to needs_review gets
// one model session before a human sees it. Only approve and keep-for-human so far (#75).

const T0 = new Date("2026-11-26T08:00:00.000Z");
const REVIEW_AGENT_USER_ID = "system:review-agent";

function jsonResponse(url: string, payload: unknown, status = 200): ExternalHttpResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
    url,
  };
}

// 灵笼 第一季 on Bilibili: 16 feature entries; 中章 sits between 006 and 007 (ADR 0003 §6.1).
const LINGLONG_TITLES = [
  "001",
  "002",
  "003",
  "004",
  "005",
  "006",
  "中章",
  "007",
  "008",
  "009",
  "010",
  "011",
  "012",
  "终章上",
  "终章下",
  "特别篇",
];

/** Correct split for 灵笼: episodes 1–6 at positions 1–6, 7–12 at positions 8–13. */
const LINGLONG_SEGMENTS = [
  { season: 1, episodeStart: 1, episodeEnd: 6, targetEpisodeStart: 1, baseline: "tmdb" },
  { season: 1, episodeStart: 7, episodeEnd: 12, targetEpisodeStart: 8, baseline: "tmdb" },
] satisfies SegmentInput[];

// 妻子的浪漫旅行 on TMDB: season n aired in WIFE_SEASON_YEARS[n - 1]; season 8 has 10 episodes.
const WIFE_SEASON_YEARS = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2026];
const wifeEpisodeCount = (season: number) => (season === 8 ? 10 : 12);

function wifeTmdbStub(url: string): ExternalHttpResponse | null {
  const season = url.match(/\/tv\/70001\/season\/(\d+)/)?.[1];
  if (season) {
    return jsonResponse(url, {
      episodes: Array.from({ length: wifeEpisodeCount(Number(season)) }, (_, i) => ({
        episode_number: i + 1,
        name: `第${i + 1}期`,
        air_date: `${WIFE_SEASON_YEARS[Number(season) - 1]}-03-01`,
      })),
    });
  }
  if (url.includes("/tv/70001")) {
    return jsonResponse(url, {
      id: 70001,
      name: "妻子的浪漫旅行",
      original_name: "妻子的浪漫旅行",
      first_air_date: "2018-03-01",
      seasons: WIFE_SEASON_YEARS.map((year, i) => ({
        season_number: i + 1,
        episode_count: wifeEpisodeCount(i + 1),
        air_date: `${year}-03-01`,
      })),
      external_ids: { imdb_id: null, tvdb_id: null },
    });
  }
  return null;
}

function httpStub(request: ExternalHttpRequest): ExternalHttpResponse {
  const url = request.url;
  if (request.namespace === "tmdb") {
    const wife = wifeTmdbStub(url);
    if (wife) {
      return wife;
    }
    if (url.includes("/movie/383498")) {
      return jsonResponse(url, {
        id: 383498,
        title: "死侍2",
        original_title: "Deadpool 2",
        release_date: "2018-05-10",
        external_ids: { imdb_id: "tt5463162" },
      });
    }
    if (url.includes("/tv/91234/season/1")) {
      return jsonResponse(url, {
        episodes: Array.from({ length: 12 }, (_, i) => ({
          episode_number: i + 1,
          name: `第${i + 1}集`,
          air_date: "2019-07-13",
        })),
      });
    }
    if (url.includes("/tv/91234/season/0")) {
      return jsonResponse(url, {
        episodes: ["中章", "终章上", "终章下", "特别篇"].map((name, i) => ({
          episode_number: i + 1,
          name,
          air_date: "2019-09-01",
        })),
      });
    }
    if (url.includes("/tv/91234")) {
      return jsonResponse(url, {
        id: 91234,
        name: "灵笼",
        original_name: "灵笼",
        first_air_date: "2019-07-13",
        seasons: [
          { season_number: 0, episode_count: 4, air_date: "2019-09-01" },
          { season_number: 1, episode_count: 12, air_date: "2019-07-13" },
        ],
        external_ids: { imdb_id: "tt10914566", tvdb_id: 370001 },
      });
    }
  }
  if (request.namespace === "trakt") {
    return jsonResponse(url, []);
  }
  if (request.namespace === "bilibili" && url.includes("season_id=28888")) {
    return jsonResponse(url, {
      code: 0,
      message: "success",
      result: {
        season_id: 28888,
        title: "灵笼",
        type: 4,
        publish: { pub_time: "2019-07-13 11:00:00" },
        episodes: LINGLONG_TITLES.map((title, i) => ({
          id: 300000 + i,
          title,
          long_title: "",
          badge: "",
          badge_type: 0,
          section_type: 0,
          duration: 1500000,
        })),
      },
    });
  }
  if (request.namespace === "bilibili" && url.includes("season_id=28889")) {
    // 灵笼's second half on its own: TMDB season 1 episodes 7–12.
    return jsonResponse(url, {
      code: 0,
      message: "success",
      result: {
        season_id: 28889,
        title: "灵笼",
        type: 4,
        publish: { pub_time: "2019-09-01 11:00:00" },
        episodes: LINGLONG_TITLES.slice(7, 13).map((title, i) => ({
          id: 310000 + i,
          title,
          long_title: "",
          badge: "",
          badge_type: 0,
          section_type: 0,
          duration: 1500000,
        })),
      },
    });
  }
  if (request.namespace === "bilibili" && url.includes("season_id=77777")) {
    // The 2026 season, which is TMDB season 8.
    return jsonResponse(url, {
      code: 0,
      message: "success",
      result: {
        season_id: 77777,
        title: "妻子的浪漫旅行2026",
        type: 7,
        publish: { pub_time: "2026-03-01 12:00:00" },
        episodes: Array.from({ length: 10 }, (_, i) => ({
          id: 400000 + i,
          title: String(i + 1),
          long_title: `第${i + 1}期`,
          badge: "",
          badge_type: 0,
          section_type: 0,
          duration: 5400000,
        })),
      },
    });
  }
  if (request.namespace === "bilibili" && url.includes("season_id=46072")) {
    // 死侍2, listed on Bilibili in 2023: without its media's premiere date, the year is 2023.
    return jsonResponse(url, {
      code: 0,
      message: "success",
      result: {
        season_id: 46072,
        title: "死侍2",
        type: 2,
        publish: { pub_time: "2023-10-05 18:00:00" },
        episodes: [{ id: 500000, title: "正片", badge: "付费", badge_type: 0, section_type: 0 }],
      },
    });
  }
  if (request.namespace === "bilibili" && url.includes("season_id=404404")) {
    return jsonResponse(url, { code: -404, message: "啥都木有" });
  }
  throw new Error(`Unexpected outbound request: ${request.namespace} ${url}`);
}

function createScheduledController(scheduledTime: Date): ScheduledController {
  return { scheduledTime: scheduledTime.getTime(), cron: "* * * * *", noRetry() {} };
}

function createQueueBatch(bodies: JobQueueMessage[]): MessageBatch<JobQueueMessage> {
  const messages: Message<JobQueueMessage>[] = bodies.map((body, index) => ({
    id: `msg-${index}-${body.jobId}-${body.leaseGeneration}`,
    timestamp: T0,
    body,
    attempts: 1,
    ack() {},
    retry() {},
  }));
  return {
    queue: "media-ref-jobs",
    messages,
    metadata: { metrics: { backlogCount: messages.length, backlogBytes: 0 } },
    ackAll() {},
    retryAll() {},
  };
}

type ScriptedModel = (request: ModelInvocationRequest) => ModelInvocationResponse;

function reply(
  turn: number,
  calls: Array<[string, ModelToolCall["arguments"]]>,
  usage = { inputTokens: 1000, outputTokens: 100 },
): ModelInvocationResponse {
  return {
    content: null,
    toolCalls: calls.map(([name, args], i) => ({ id: `call_${turn}_${i}`, name, arguments: args })),
    model: "test-model",
    usage,
  };
}

const turnOf = (request: ModelInvocationRequest) =>
  request.messages.filter((m) => m.role === "assistant").length;

/** Conflict codes the session is shown, read back from the first user message. */
function conflictCodes(request: ModelInvocationRequest): string[] {
  const prompt = request.messages.find((m) => m.role === "user")!.content;
  const payload = JSON.parse(prompt.slice(prompt.indexOf("{"))) as {
    conflicts: Array<{ code: string }>;
  };
  return [...new Set(payload.conflicts.map((c) => c.code))];
}

function reasonsFor(request: ModelInvocationRequest) {
  return conflictCodes(request).map((code) => ({
    code,
    reason: "平台多出的 4 条是中章、终章上下、特别篇，TMDB 放在第 0 季",
  }));
}

/** Fetches the collection and season 1, then approves with a reason per conflict code. */
const approvesLikeLinglong: ScriptedModel = (request) => {
  const turn = turnOf(request);
  if (turn === 0) {
    return reply(turn, [
      ["get_collection", { namespace: "bilibili", id: "ss28888" }],
      ["get_catalog_season", { season: 1 }],
      ["get_catalog_season", { season: 0 }],
    ]);
  }
  return reply(turn, [["approve", { reasons: reasonsFor(request) }]]);
};

/** Bilibili, but its collection names an IMDb ID other than the catalog's: shared_id_conflict. */
const conflictingIdRegistry = createAdapterRegistry([
  {
    ...bilibiliAdapter,
    async fetchCollection(id, outbound) {
      const result = await bilibiliAdapter.fetchCollection(id, outbound);
      return result.status === "found"
        ? { ...result, info: { ...result.info, externalIds: { imdb: "tt0000001" } } }
        : result;
    },
  },
]);

async function setup(
  invokeModel: ScriptedModel,
  reviewAgent: BackgroundWorkerConfig["reviewAgent"] = {},
  adapterRegistry: AdapterRegistry = createDefaultAdapterRegistry(),
  workerConfig: Partial<BackgroundWorkerConfig> = {},
  fetchExternal: (request: ExternalHttpRequest) => ExternalHttpResponse = httpStub,
) {
  const testDb = await createTestDb();
  const outbound = createFakeOutboundClient({ fetchExternal, invokeModel });
  const emitted: JobQueueMessage[] = [];
  const worker = createBackgroundWorker({
    db: testDb.writeDb,
    outbound,
    adapterRegistry,
    queue: {
      async send(message) {
        emitted.push(message);
      },
    },
    config: {
      enableDailyTmdbSync: false,
      enableExplorationScheduling: false,
      tmdb: { accessToken: "test-tmdb-token" },
      reviewAgent: { dailyBudget: 10, ...reviewAgent },
      ...workerConfig,
    },
    now: () => T0,
  });

  const submit = async (
    nativeId = "ss28888",
    overrides: Partial<Parameters<typeof createChangeRequest>[1]> = {},
  ) => {
    await ensureExplorationAgentUser(testDb.writeDb);
    const cr = await createChangeRequest(
      testDb.writeDb,
      {
        submitterUserId: EXPLORATION_AGENT_USER_ID,
        submitterType: "agent",
        targetExternalKey: "tmdb:tv:91234",
        namespace: "bilibili",
        nativeId,
        variantDescription: "原声",
        setDefaultVariant: true,
        segments: LINGLONG_SEGMENTS,
        now: T0,
        ...overrides,
      },
      { adapterRegistry, outbound, now: T0 },
    );
    return cr.id;
  };

  /** Claims due jobs and runs each message once; returns what ran. */
  const tick = async () => {
    emitted.length = 0;
    await worker.scheduled(createScheduledController(T0));
    const ran = [...emitted];
    for (const message of ran) {
      await worker.queue(createQueueBatch([message]));
    }
    return ran;
  };

  /** Runs ticks until no job is left; returns the job types that ran, in order. */
  const drain = async () => {
    const ran: JobQueueMessage[] = [];
    for (let i = 0; i < 5; i += 1) {
      const batch = await tick();
      if (batch.length === 0) {
        break;
      }
      ran.push(...batch);
    }
    return ran;
  };

  const changeRequest = (id: string) =>
    testDb.readDb
      .selectFrom("change_requests")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();

  return { testDb, outbound, worker, emitted, submit, tick, drain, changeRequest };
}

describe("review agent (#75)", () => {
  const handles: TestDbHandle[] = [];
  const track = <T extends { testDb: TestDbHandle }>(ctx: T) => {
    handles.push(ctx.testDb);
    return ctx;
  };

  afterEach(async () => {
    while (handles.length > 0) {
      await handles.pop()!.cleanup();
    }
  });

  test("灵笼: the model fetched the collection and season and explained every conflict, so the change request is approved by the review agent", async () => {
    const { testDb, submit, drain, changeRequest, outbound } = track(
      await setup(approvesLikeLinglong),
    );
    const id = await submit();

    const ran = await drain();

    expect(ran.map((m) => m.jobType)).toEqual(["evidence_check", "review_agent"]);
    const cr = await changeRequest(id);
    expect(cr.status).toBe("approved");
    expect(cr.reviewer_user_id).toBe(REVIEW_AGENT_USER_ID);
    const evidence = cr.evidence as Record<string, any>;
    expect(evidence.gate.decision).toBe("needs_review");
    expect(evidence.reviewAgent).toMatchObject({ verdict: "approve", fallback: null });
    expect(evidence.reviewAgent.reasons.map((r: { code: string }) => r.code)).toEqual(
      conflictCodes(outbound.modelRequests[0]!),
    );
    // The split mapping is live, as a reviewer's approval would have made it.
    const association = await testDb.readDb
      .selectFrom("associations")
      .select(["id", "status"])
      .where("namespace", "=", "bilibili")
      .where("native_id", "=", "ss28888")
      .executeTakeFirstOrThrow();
    expect(association.status).toBe("confirmed");
    expect(cr.applied_association_id).toBe(association.id);

    // The session's tools: the query tools minus platform search, and the conclusions.
    const toolNames = outbound.modelRequests[0]!.tools!.map((t) => t.name);
    expect(toolNames).toEqual(
      expect.arrayContaining([
        "get_collection",
        "get_catalog_season",
        "approve",
        "reject_with_correction",
        "reject",
      ]),
    );
    expect(toolNames).not.toContain("search_platform");

    // Two turns of 1100 tokens count towards the day's model usage, and one review is used.
    const budget = await testDb.readDb
      .selectFrom("exploration_daily_budget")
      .select(["tokens_used", "review_consumed", "pi_usage"])
      .executeTakeFirstOrThrow();
    expect(Number(budget.tokens_used)).toBe(2200);
    expect(budget.review_consumed).toBe(1);
    expect(budget.pi_usage).toMatchObject({ "test-model": { input: 2000, output: 200 } });
  });

  test("死侍2: a movie has no season to correct, so the session approves its year conflict with the collection alone", async () => {
    const model: ScriptedModel = (request) => {
      const turn = turnOf(request);
      if (turn === 0) {
        return reply(turn, [["get_collection", { namespace: "bilibili", id: "ss46072" }]]);
      }
      return reply(turn, [
        [
          "approve",
          {
            reasons: [
              { code: "year_mismatch", reason: "2023 是平台上架年份，正片是 2018 年的电影" },
            ],
          },
        ],
      ]);
    };
    const { submit, drain, changeRequest, outbound } = track(await setup(model));
    const id = await submit("ss46072", { targetExternalKey: "tmdb:movie:383498", segments: [] });

    await drain();

    const first = outbound.modelRequests[0]!;
    expect(conflictCodes(first)).toEqual(["year_mismatch"]);
    const toolNames = first.tools!.map((t) => t.name);
    expect(toolNames).toEqual(expect.arrayContaining(["approve", "reject"]));
    expect(toolNames).not.toContain("reject_with_correction");
    expect(first.messages[0]!.content).toContain("The catalog entry is a movie");
    const cr = await changeRequest(id);
    expect(cr.status).toBe("approved");
    expect((cr.evidence as Record<string, any>).reviewAgent).toMatchObject({
      verdict: "approve",
      fallback: null,
    });
  });

  const approveAfter =
    (queries: Array<[string, ModelToolCall["arguments"]]>, dropReason = false): ScriptedModel =>
    (request) => {
      const turn = turnOf(request);
      if (turn === 0) {
        return reply(turn, queries);
      }
      return reply(turn, [["approve", { reasons: reasonsFor(request).slice(dropReason ? 1 : 0) }]]);
    };

  test.each([
    {
      name: "approve after an empty collection window",
      model: approveAfter([
        ["get_collection", { namespace: "bilibili", id: "ss28888", fromPosition: 99 }],
        ["get_catalog_season", { season: 1 }],
      ]),
      fallback: "collection_not_fetched",
    },
    {
      name: "approve after an empty season window",
      model: approveAfter([
        ["get_collection", { namespace: "bilibili", id: "ss28888" }],
        ["get_catalog_season", { season: 1, fromEpisode: 99 }],
      ]),
      fallback: "season_not_fetched: 1",
    },
    {
      name: "approve without fetching the collection",
      model: approveAfter([["get_catalog_season", { season: 1 }]]),
      fallback: "collection_not_fetched",
    },
    {
      name: "approve without fetching the season the segments name",
      model: approveAfter([
        ["get_collection", { namespace: "bilibili", id: "ss28888" }],
        ["get_catalog_season", { season: 0 }],
      ]),
      fallback: "season_not_fetched: 1",
    },
    {
      name: "approve without a reason for every conflict code",
      model: approveAfter(
        [
          ["get_collection", { namespace: "bilibili", id: "ss28888" }],
          ["get_catalog_season", { season: 1 }],
        ],
        true,
      ),
      fallback: "no_reason_for: episode_count_mismatch",
    },
    {
      name: "a model that stops without a conclusion",
      model: (() => ({
        content: "I am not sure.",
        toolCalls: [],
        model: "test-model",
      })) as ScriptedModel,
      fallback: "no_decision",
    },
    {
      name: "a session that spends its token budget without concluding",
      model: ((request) =>
        reply(turnOf(request), [
          ["get_collection", { namespace: "bilibili", id: "ss28888" }],
        ])) as ScriptedModel,
      config: { maxTaskTokens: 2000 },
      fallback: "tokens_exhausted",
    },
  ])(
    "$name rejects the change request; exploration tries again later",
    async ({ model, config, fallback }) => {
      const { submit, drain, changeRequest } = track(await setup(model, config));
      const id = await submit();

      await drain();

      const cr = await changeRequest(id);
      expect(cr.status).toBe("rejected");
      expect(cr.reviewer_user_id).toBe(REVIEW_AGENT_USER_ID);
      const evidence = cr.evidence as Record<string, any>;
      expect(evidence.reviewAgent).toMatchObject({ verdict: "reject", fallback });
      // The gate's evidence stays next to the verdict.
      expect(evidence.gate.decision).toBe("needs_review");
    },
  );

  test("a model that stops without a conclusion is asked once to conclude, with only the conclusion tools left", async () => {
    const model: ScriptedModel = (request) => {
      const turn = turnOf(request);
      if (turn === 0) {
        return reply(turn, [
          ["get_collection", { namespace: "bilibili", id: "ss28888" }],
          ["get_catalog_season", { season: 1 }],
        ]);
      }
      if (turn === 1) {
        return { content: "看起来没问题。", toolCalls: [], model: "test-model" };
      }
      return reply(turn, [["approve", { reasons: reasonsFor(request) }]]);
    };
    const { submit, drain, changeRequest, outbound } = track(await setup(model));
    const id = await submit();

    await drain();

    const cr = await changeRequest(id);
    expect(cr.status).toBe("approved");
    expect((cr.evidence as Record<string, any>).reviewAgent).toMatchObject({
      verdict: "approve",
      fallback: null,
    });
    const nudged = outbound.modelRequests.at(-1)!;
    expect(nudged.messages.at(-1)).toMatchObject({
      role: "user",
      content: expect.stringContaining("approve"),
    });
    expect(nudged.tools!.map((t) => t.name).sort()).toEqual(
      ["approve", "reject", "reject_with_correction"].sort(),
    );
  });

  test("a session that runs out of time mid-turn is a rejection, not an outage to retry", async () => {
    // The model never answers: the session's time budget ends the call.
    const model = (() => new Promise(() => {})) as unknown as ScriptedModel;
    const { testDb, submit, drain, changeRequest } = track(
      await setup(model, { maxDurationMs: 500 }),
    );
    const id = await submit();

    await drain();

    const cr = await changeRequest(id);
    expect(cr.status).toBe("rejected");
    expect((cr.evidence as Record<string, any>).reviewAgent).toMatchObject({
      verdict: "reject",
      fallback: "time_up",
    });
    expect(
      await testDb.readDb
        .selectFrom("background_jobs")
        .select("id")
        .where("job_type", "=", "review_agent")
        .where("status", "=", "pending")
        .execute(),
    ).toEqual([]);
  });

  test("fetches in the same turn as the approval do not count: the model never saw them", async () => {
    const model: ScriptedModel = (request) =>
      reply(turnOf(request), [
        ["get_collection", { namespace: "bilibili", id: "ss28888" }],
        ["get_catalog_season", { season: 1 }],
        ["approve", { reasons: reasonsFor(request) }],
      ]);
    const { submit, drain, changeRequest } = track(await setup(model));
    const id = await submit();

    await drain();

    const cr = await changeRequest(id);
    expect(cr.status).toBe("rejected");
    expect((cr.evidence as Record<string, any>).reviewAgent).toMatchObject({
      verdict: "reject",
      fallback: "collection_not_fetched",
    });
  });

  test("a fetch answered TIME_UP does not count, even when it finishes before the approval", async () => {
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model: ScriptedModel = (request) => {
      const turn = turnOf(request);
      return turn === 0
        ? reply(turn, [
            ["get_collection", { namespace: "bilibili", id: "ss28888" }],
            ["get_catalog_season", { season: 1 }],
          ])
        : reply(turn, [["approve", { reasons: reasonsFor(request) }]]);
    };
    // Searching gets 1500 of the 2000 ms; the collection fetch outlasts it.
    const ctx = track(await setup(model, { maxDurationMs: 2000 }));
    const id = await ctx.submit();
    await ctx.tick(); // evidence_check
    const fetchExternal = ctx.outbound.fetchExternal.bind(ctx.outbound);
    ctx.outbound.fetchExternal = async (request) => {
      if (request.url.includes("season_id=28888")) {
        await released;
      }
      return fetchExternal(request);
    };
    const invokeModel = ctx.outbound.invokeModel.bind(ctx.outbound);
    ctx.outbound.invokeModel = async (request) => {
      if (turnOf(request) > 0) {
        // The late fetch completes before the model concludes.
        release();
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return invokeModel(request);
    };

    await ctx.tick(); // review_agent

    const toolReplies = ctx.outbound.modelRequests[1]!.messages.filter((m) => m.role === "tool");
    expect(JSON.parse(toolReplies[0]!.content)).toMatchObject({ error: "TIME_UP" });
    const cr = await ctx.changeRequest(id);
    expect(cr.status).toBe("rejected");
    expect((cr.evidence as Record<string, any>).reviewAgent).toMatchObject({
      verdict: "reject",
      fallback: "collection_not_fetched",
    });
  });

  test("reject stores the model's opinion as the rejection reason", async () => {
    const model: ScriptedModel = (request) =>
      reply(turnOf(request), [["reject", { opinion: "季号看起来不对" }]]);
    const { submit, drain, changeRequest } = track(await setup(model));
    const id = await submit();

    await drain();

    const cr = await changeRequest(id);
    expect(cr.status).toBe("rejected");
    expect((cr.evidence as Record<string, any>).reviewAgent).toMatchObject({
      verdict: "reject",
      opinion: "季号看起来不对",
      fallback: null,
    });
  });

  test.each([
    { name: "shared_id_conflict", registry: conflictingIdRegistry, nativeId: "ss28888" },
    { name: "collection_not_found", registry: undefined, nativeId: "ss404404" },
  ])(
    "$name: approval is impossible, so it is rejected without a model",
    async ({ name, registry, nativeId }) => {
      const { submit, drain, changeRequest, outbound, testDb } = track(
        await setup(approvesLikeLinglong, {}, registry),
      );
      const id = await submit(nativeId);

      const ran = await drain();

      expect(ran.map((m) => m.jobType)).toEqual(["evidence_check", "review_agent"]);
      expect(outbound.modelRequests).toHaveLength(0);
      const cr = await changeRequest(id);
      expect(cr.status).toBe("rejected");
      expect(cr.reviewer_user_id).toBe(REVIEW_AGENT_USER_ID);
      expect((cr.evidence as Record<string, any>).reviewAgent).toMatchObject({
        verdict: "reject",
        fallback: expect.stringContaining(name),
      });
      // No daily slot spent.
      const budget = await testDb.readDb
        .selectFrom("exploration_daily_budget")
        .select("review_consumed")
        .executeTakeFirst();
      expect(budget?.review_consumed ?? 0).toBe(0);
    },
  );

  test.each(["media_type_mismatch", "segment_episode_out_of_range", "segment_season_not_found"])(
    "an explained %s cannot be approved",
    async (code) => {
      const ctx = track(await setup(approvesLikeLinglong));
      const id = await ctx.submit();
      await ctx.tick();
      const evidence = (await ctx.changeRequest(id)).evidence!;
      await ctx.testDb.writeDb
        .updateTable("change_requests")
        .where("id", "=", id)
        .set({
          conflict_reason: code,
          evidence: JSON.stringify({ ...evidence, gate: { conflicts: [{ code }] } }),
        })
        .execute();
      await ctx.drain();
      expect(await ctx.changeRequest(id)).toMatchObject({
        status: "rejected",
        evidence: {
          reviewAgent: {
            verdict: "reject",
            concluded: "approve",
            fallback: `non_overridable_conflict: ${code}`,
          },
        },
      });
    },
  );

  test("a stored-only catalog season does not count as fetched", async () => {
    const ctx = track(await setup(approvesLikeLinglong));
    const id = await ctx.submit();
    await ctx.tick();
    const fetchExternal = ctx.outbound.fetchExternal.bind(ctx.outbound);
    ctx.outbound.fetchExternal = (request) =>
      request.namespace === "tmdb" && request.url.includes("/season/")
        ? Promise.resolve(jsonResponse(request.url, {}, 503))
        : fetchExternal(request);
    await ctx.drain();
    expect(await ctx.changeRequest(id)).toMatchObject({
      status: "rejected",
      evidence: { reviewAgent: { fallback: "season_not_fetched: 1" } },
    });
  });

  test.each([
    { nextPosition: 7, expected: "approved" },
    { nextPosition: 6, expected: "rejected" },
    { nextPosition: 12, expected: "rejected" },
  ])(
    "mixed approval checks linear positions only (second linear segment starts at $nextPosition)",
    async ({ nextPosition, expected }) => {
      const ctx = track(await setup(approvesLikeLinglong));
      const id = await ctx.submit("ss28888", {
        segments: [
          {
            season: 0,
            episodeStart: 1,
            episodeEnd: 4,
            targetEpisodeStart: 1,
            baseline: "tmdb",
            nonLinear: true,
          },
          { season: 1, episodeStart: 1, episodeEnd: 6, targetEpisodeStart: 1, baseline: "tmdb" },
          {
            season: 1,
            episodeStart: 7,
            episodeEnd: 12,
            targetEpisodeStart: nextPosition,
            baseline: "tmdb",
          },
        ],
      });
      await ctx.drain();
      expect(await ctx.changeRequest(id)).toMatchObject({
        status: expected,
        evidence: {
          reviewAgent: {
            concluded: "approve",
            verdict: expected === "approved" ? "approve" : "reject",
          },
        },
      });
    },
  );

  test("approval refuses segments extending past the fetched collection", async () => {
    const ctx = track(await setup(approvesLikeLinglong));
    const id = await ctx.submit("ss28888", {
      segments: [
        { season: 1, episodeStart: 1, episodeEnd: 12, targetEpisodeStart: 6, baseline: "tmdb" },
      ],
    });
    await ctx.drain();
    expect(await ctx.changeRequest(id)).toMatchObject({
      status: "rejected",
      evidence: {
        reviewAgent: { fallback: expect.stringContaining("segment reaches collection episode 17") },
      },
    });
  });

  test("a model outage puts the review back for an hour instead of rejecting", async () => {
    const failing: ScriptedModel = () => {
      throw new Error("upstream 503");
    };
    const ctx = track(await setup(failing));
    const id = await ctx.submit();

    await ctx.drain();

    const cr = await ctx.changeRequest(id);
    expect(cr.status).toBe("needs_review");
    const job = await ctx.testDb.readDb
      .selectFrom("background_jobs")
      .select(["status", "run_after"])
      .where("job_type", "=", "review_agent")
      .executeTakeFirstOrThrow();
    expect(job.status).toBe("pending");
    expect(job.run_after.getTime()).toBe(T0.getTime() + 60 * 60 * 1000);
  });

  test("a needs_review request without an active review job is queued again by the cron", async () => {
    const failing: ScriptedModel = () => {
      throw new Error("upstream 503");
    };
    const ctx = track(await setup(failing));
    const id = await ctx.submit();
    await ctx.drain();
    // The job gave up (e.g. every attempt hit an outage).
    await ctx.testDb.writeDb
      .updateTable("background_jobs")
      .set({ status: "failed" })
      .where("job_type", "=", "review_agent")
      .execute();

    expect(await enqueuePendingReviews(ctx.testDb.writeDb, { now: T0 })).toBe(1);
    expect(await enqueuePendingReviews(ctx.testDb.writeDb, { now: T0 })).toBe(0);
    const pending = await ctx.testDb.readDb
      .selectFrom("background_jobs")
      .select("payload")
      .where("job_type", "=", "review_agent")
      .where("status", "=", "pending")
      .execute();
    expect(pending).toEqual([{ payload: { changeRequestId: id } }]);
  });

  test("a redelivered review message does not review twice", async () => {
    const { worker, submit, tick, changeRequest, outbound, emitted } = track(
      await setup(approvesLikeLinglong),
    );
    const id = await submit();
    await tick(); // evidence_check
    await tick(); // review_agent
    const reviewMessage = emitted.find((m) => m.jobType === "review_agent")!;
    const callsAfterReview = outbound.modelRequests.length;

    const summary = await worker.queue(createQueueBatch([reviewMessage]));

    expect(summary.discarded).toBe(1);
    expect(outbound.modelRequests).toHaveLength(callsAfterReview);
    expect((await changeRequest(id)).status).toBe("approved");
  });

  test("a review whose job lease cannot fit a session is put back, without a session, a daily slot or an attempt", async () => {
    // A 1-minute lease for 2-minute sessions: the session could be fenced out after spending.
    const ctx = track(
      await setup(approvesLikeLinglong, {}, createDefaultAdapterRegistry(), {
        leaseDurationMs: 60_000,
      }),
    );
    const id = await ctx.submit();

    await ctx.tick(); // evidence_check
    const ran = await ctx.tick();

    expect(ran.map((m) => m.jobType)).toEqual(["review_agent"]);
    expect(ctx.outbound.modelRequests).toHaveLength(0);
    const cr = await ctx.changeRequest(id);
    expect(cr.status).toBe("needs_review");
    expect((cr.evidence as Record<string, any>).reviewAgent).toBeUndefined();
    const budget = await ctx.testDb.readDb
      .selectFrom("exploration_daily_budget")
      .select("review_consumed")
      .executeTakeFirst();
    expect(budget?.review_consumed ?? 0).toBe(0);
    const job = await ctx.testDb.readDb
      .selectFrom("background_jobs")
      .select(["status", "attempts", "run_after"])
      .where("job_type", "=", "review_agent")
      .executeTakeFirstOrThrow();
    expect(job).toEqual({ status: "pending", attempts: 0, run_after: T0 });
  });

  test("with no daily reviews left, the review waits for the next UTC day, without a session", async () => {
    const { testDb, submit, drain, changeRequest, outbound } = track(
      await setup(approvesLikeLinglong, { dailyBudget: 0 }),
    );
    const id = await submit();

    const ran = await drain();

    expect(ran.map((m) => m.jobType)).toEqual(["evidence_check", "review_agent"]);
    expect(outbound.modelRequests).toHaveLength(0);
    const cr = await changeRequest(id);
    expect(cr.status).toBe("needs_review");
    expect((cr.evidence as Record<string, any>).reviewAgent).toBeUndefined();
    const budget = await testDb.readDb
      .selectFrom("exploration_daily_budget")
      .select("review_consumed")
      .executeTakeFirst();
    expect(budget?.review_consumed ?? 0).toBe(0);
    const job = await testDb.readDb
      .selectFrom("background_jobs")
      .select(["status", "run_after"])
      .where("job_type", "=", "review_agent")
      .executeTakeFirstOrThrow();
    expect(job.status).toBe("pending");
    expect(job.run_after).toEqual(new Date("2026-11-27T00:00:00.000Z"));
  });

  test("worker env: the review agent is off unless REVIEW_AGENT_DAILY_BUDGET says otherwise", () => {
    const env = (vars: Record<string, string>) => vars as unknown as BackgroundWorkerEnv;
    expect(parseWorkerConfig(env({})).reviewAgent).toMatchObject({
      dailyBudget: 0,
      maxSteps: 16,
      maxDurationMs: 180_000,
      maxTaskTokens: 300_000,
    });
    expect(
      parseWorkerConfig(
        env({
          REVIEW_AGENT_DAILY_BUDGET: "20",
          REVIEW_AGENT_MAX_STEPS: "8",
          REVIEW_AGENT_MAX_DURATION_MS: "60000",
          REVIEW_AGENT_MAX_TASK_TOKENS: "100000",
          AI_MODEL: "group/test",
        }),
      ).reviewAgent,
    ).toMatchObject({
      dailyBudget: 20,
      maxSteps: 8,
      maxDurationMs: 60_000,
      maxTaskTokens: 100_000,
      model: "group/test",
    });
  });
});

// Reject with correction (ADR 0003 §4, #76): code re-runs Evidence Gate step 2 on the correction.

const WIFE_KEY = "tmdb:tv:70001";
const WIFE_OPINION = "这是 2026 年播出的一季，TMDB 第 8 季，不是第 6 季";
const wifeSegments = (season: number, episodeEnd = wifeEpisodeCount(season)): SegmentInput[] => [
  {
    season,
    episodeStart: 1,
    episodeEnd,
    targetEpisodeStart: 1,
    baseline: "tmdb",
  },
];
const correctionFor = (season: number) => ({
  season,
  segments: [
    { season, episodeStart: 1, episodeEnd: wifeEpisodeCount(season), targetEpisodeStart: 1 },
  ],
});

async function createWifeMedia(ctx: Ctx) {
  const media = await ctx.testDb.writeDb
    .insertInto("media")
    .values({
      type: "tv",
      baseline: "tmdb",
      title: "妻子的浪漫旅行",
      original_title: "妻子的浪漫旅行",
      year: 2018,
      seasons: JSON.stringify(
        WIFE_SEASON_YEARS.map((airYear, i) => ({
          season: i + 1,
          episodeCount: wifeEpisodeCount(i + 1),
          airYear,
        })),
      ),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await ctx.testDb.writeDb
    .insertInto("associations")
    .values({
      status: "confirmed",
      is_external_id: true,
      media_id: media.id,
      namespace: "tmdb",
      native_id: "tv:70001",
    })
    .execute();
  return media;
}

/** Fetches the collection and the corrected season, then rejects with that correction. */
const correctsTo =
  (season: number, reasons: Array<{ code: string; reason: string }> = []): ScriptedModel =>
  (request) => {
    const turn = turnOf(request);
    if (turn === 0) {
      return reply(turn, [
        ["get_collection", { namespace: "bilibili", id: "ss77777" }],
        ["get_catalog_season", { season }],
      ]);
    }
    if (turn === 1) {
      return reply(turn, [
        ["reject_with_correction", { opinion: WIFE_OPINION, ...correctionFor(season), reasons }],
      ]);
    }
    return reply(turn, [["reject", { opinion: WIFE_OPINION }]]);
  };

describe("review agent: reject with correction (#76)", () => {
  const handles: TestDbHandle[] = [];
  const track = <T extends { testDb: TestDbHandle }>(ctx: T) => {
    handles.push(ctx.testDb);
    return ctx;
  };

  afterEach(async () => {
    while (handles.length > 0) {
      await handles.pop()!.cleanup();
    }
  });

  async function submitAsHuman(
    ctx: Awaited<ReturnType<typeof setup>>,
    season = 6,
    segments = wifeSegments(season),
  ) {
    await ctx.testDb.writeDb
      .insertInto("user")
      .values({
        id: "user-human",
        name: "Human",
        email: "human@example.test",
        emailVerified: true,
        image: null,
        role: "user",
        reputation: 0,
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
    return ctx.submit("ss77777", {
      submitterUserId: "user-human",
      submitterType: "human",
      targetExternalKey: WIFE_KEY,
      segments,
    });
  }

  const leads = (ctx: Awaited<ReturnType<typeof setup>>) =>
    ctx.testDb.readDb.selectFrom("leads").selectAll().execute();
  const demands = (ctx: Awaited<ReturnType<typeof setup>>) =>
    ctx.testDb.readDb.selectFrom("demands").selectAll().orderBy("season").execute();

  test.each([0, 1])(
    "a human whole-season nonLinear submission with %i actual episodes cannot be approved",
    async (available) => {
      const ctx = track(
        await setup((request) => {
          const turn = turnOf(request);
          return turn === 0
            ? reply(turn, [
                ["get_collection", { namespace: "bilibili", id: "ss77777" }],
                ["get_catalog_season", { season: 8 }],
              ])
            : reply(turn, [["approve", { reasons: reasonsFor(request) }]]);
        }),
      );
      const fetch = ctx.outbound.fetchExternal.bind(ctx.outbound);
      ctx.outbound.fetchExternal = async (request) => {
        const response = await fetch(request);
        if (!request.url.includes("season_id=77777")) return response;
        const collection = JSON.parse(response.body);
        collection.result.episodes = collection.result.episodes.slice(0, available);
        return jsonResponse(request.url, collection);
      };
      const id = await submitAsHuman(ctx, 8, [
        {
          season: 8,
          episodeStart: 1,
          episodeEnd: null,
          nonLinear: true,
          targetEpisodeStart: 1,
          baseline: "tmdb",
        },
      ]);
      await ctx.drain();
      const cr = await ctx.changeRequest(id);
      expect(cr.status).toBe("rejected");
      expect((cr.evidence as Record<string, any>).gate.conflicts).toContainEqual(
        expect.objectContaining({
          code: available ? "season_finale_unverified" : "segment_episode_count_missing",
        }),
      );
      expect(
        await ctx.testDb.readDb
          .selectFrom("associations")
          .select("id")
          .where("native_id", "=", "ss77777")
          .execute(),
      ).toEqual([]);
    },
  );

  test("妻子的浪漫旅行: a human submitted season 6, the correction to season 8 passes step 2, so the request is rejected, a lead written and a demand opened now", async () => {
    const ctx = track(await setup(correctsTo(8)));
    const id = await submitAsHuman(ctx);

    const ran = await ctx.drain();

    expect(ran.map((m) => m.jobType)).toEqual(["evidence_check", "review_agent"]);
    const cr = await ctx.changeRequest(id);
    expect(cr.status).toBe("rejected");
    expect(cr.reviewer_user_id).toBe(REVIEW_AGENT_USER_ID);
    expect(cr.decision_reason).toContain(WIFE_OPINION);
    expect(cr.decision_reason).toContain("第 8 季");
    expect((cr.evidence as Record<string, any>).reviewAgent).toMatchObject({
      verdict: "reject_with_correction",
      correction: correctionFor(8),
      opinion: WIFE_OPINION,
      fallback: null,
    });
    expect(ctx.outbound.modelRequests[0]!.tools!.map((t) => t.name)).toContain(
      "reject_with_correction",
    );

    expect(await leads(ctx)).toEqual([
      expect.objectContaining({
        target_external_key: WIFE_KEY,
        namespace: "bilibili",
        native_id: "ss77777",
        season: 8,
        reporter_user_id: REVIEW_AGENT_USER_ID,
        reporter_key_id: REVIEW_AGENT_USER_ID,
        notes: expect.stringContaining(WIFE_OPINION),
      }),
    ]);
    // No media yet, so the demand is on the external key; explorable now, no not-found round.
    expect(await demands(ctx)).toEqual([
      expect.objectContaining({
        media_id: null,
        external_key: WIFE_KEY,
        season: 8,
        namespace_group: "platform",
        status: "open",
        not_found_count: 0,
        next_eligible_at: T0,
      }),
    ]);
  });

  test.each([true, false])(
    "a correction on a media ID rejects and reopens the demand (authority ID: %s)",
    async (withId) => {
      const ctx = track(await setup(correctsTo(8)));
      const media = await createWifeMedia(ctx);
      const id = await ctx.submit("ss77777", {
        targetExternalKey: media.id,
        segments: wifeSegments(6),
      });
      await ctx.tick(); // Collect the evidence before the external ID can disappear.
      if (!withId) {
        await ctx.testDb.writeDb
          .deleteFrom("associations")
          .where("media_id", "=", media.id)
          .where("is_external_id", "=", true)
          .execute();
      }
      await ctx.drain();
      expect(await ctx.changeRequest(id)).toMatchObject({
        target_external_key: `media:${media.id}`,
        status: "rejected",
        decision_reason: expect.stringContaining("改正：第 8 季"),
      });
      expect(await leads(ctx)).toEqual(
        withId ? [expect.objectContaining({ target_external_key: WIFE_KEY, season: 8 })] : [],
      );
      expect(await demands(ctx)).toEqual([
        expect.objectContaining({
          media_id: media.id,
          season: 8,
          status: "open",
          next_eligible_at: T0,
        }),
      ]);
    },
  );

  test("a correction that fails step 2 rejects the request plainly, keeping the opinion and the proposed correction", async () => {
    // Season 7 aired in 2024; the collection is from 2026.
    const ctx = track(await setup(correctsTo(7)));
    const id = await submitAsHuman(ctx);

    await ctx.drain();

    const cr = await ctx.changeRequest(id);
    expect(cr.status).toBe("rejected");
    expect(cr.reviewer_user_id).toBe(REVIEW_AGENT_USER_ID);
    const reviewAgent = (cr.evidence as Record<string, any>).reviewAgent;
    expect(reviewAgent).toMatchObject({
      verdict: "reject",
      fallback: expect.stringMatching(/^correction_failed_step2: .*segment_year_mismatch/),
    });
    expect(reviewAgent.opinion).toContain(WIFE_OPINION);
    expect(reviewAgent.opinion).toContain("第 7 季");
    expect(reviewAgent.correction).toBeUndefined();
    expect(await leads(ctx)).toEqual([]);
    expect(await demands(ctx)).toEqual([]);
  });

  test("a correction on a collection of another show fails step 1: only the episode count may differ", async () => {
    const otherShow = createAdapterRegistry([
      {
        ...bilibiliAdapter,
        async fetchCollection(id, outbound) {
          const result = await bilibiliAdapter.fetchCollection(id, outbound);
          return result.status === "found"
            ? { ...result, info: { ...result.info, title: "爸爸去哪儿2026" } }
            : result;
        },
      },
    ]);
    const ctx = track(await setup(correctsTo(8), {}, otherShow));
    const id = await submitAsHuman(ctx);

    await ctx.drain();

    const cr = await ctx.changeRequest(id);
    expect(cr.status).toBe("rejected");
    expect((cr.evidence as Record<string, any>).reviewAgent).toMatchObject({
      verdict: "reject",
      fallback: "correction_failed_step1: title_mismatch",
    });
    expect(await leads(ctx)).toEqual([]);
  });

  /** Bilibili, with the collection's title or year changed as the platform shows it. */
  const relabelled = (info: { title?: string; year?: number }) =>
    createAdapterRegistry([
      {
        ...bilibiliAdapter,
        async fetchCollection(id, outbound) {
          const result = await bilibiliAdapter.fetchCollection(id, outbound);
          return result.status === "found"
            ? { ...result, info: { ...result.info, ...info } }
            : result;
        },
      },
    ]);

  test.each([
    {
      name: "a platform upload year that matches no season (降世神通)",
      info: { year: 2031, title: "妻子的浪漫旅行" },
      code: "year_mismatch",
      reason: "2031 是平台上架年份，不是播出年份",
    },
    {
      name: "a platform title suffix (斗破苍穹年番)",
      info: { title: "妻子的浪漫旅行 特别版" },
      code: "title_mismatch",
      reason: "「特别版」是平台给这一季起的名字，同一部作品",
    },
  ])(
    "a correction keeps a conflict the submission already had when it explains it: $name",
    async ({ info, code, reason }) => {
      const ctx = track(await setup(correctsTo(8, [{ code, reason }]), {}, relabelled(info)));
      const id = await submitAsHuman(ctx);

      await ctx.drain();

      const cr = await ctx.changeRequest(id);
      expect(cr.status).toBe("rejected");
      expect((cr.evidence as Record<string, any>).reviewAgent).toMatchObject({
        verdict: "reject_with_correction",
        correction: correctionFor(8),
        fallback: null,
      });
      expect(await leads(ctx)).toEqual([expect.objectContaining({ season: 8 })]);
    },
  );

  test("an open-ended correction on a finished season's shorter collection is handed over up to the last verified episode", async () => {
    // TMDB season 8 has 10 episodes, all aired; the platform carries only the first 7.
    const airing = createAdapterRegistry([
      {
        ...bilibiliAdapter,
        async fetchCollection(id, outbound) {
          const result = await bilibiliAdapter.fetchCollection(id, outbound);
          return result.status === "found"
            ? {
                ...result,
                info: { ...result.info, featureEpisodes: result.info.featureEpisodes.slice(0, 7) },
              }
            : result;
        },
      },
    ]);
    const openEnded = {
      season: 8,
      segments: [{ season: 8, episodeStart: 1, episodeEnd: null, targetEpisodeStart: 1 }],
    };
    const model: ScriptedModel = (request) => {
      const turn = turnOf(request);
      if (turn === 0) {
        return reply(turn, [
          ["get_collection", { namespace: "bilibili", id: "ss77777" }],
          ["get_catalog_season", { season: 8 }],
        ]);
      }
      return reply(turn, [["reject_with_correction", { opinion: WIFE_OPINION, ...openEnded }]]);
    };
    const ctx = track(await setup(model, {}, airing));
    const id = await submitAsHuman(ctx);

    await ctx.drain();

    // Positions 1–7 are what the session saw: exploration resubmits exactly that, and its own
    // segment check (which reads an open end as the whole 10-episode season) accepts it.
    const bounded = {
      season: 8,
      segments: [{ season: 8, episodeStart: 1, episodeEnd: 7, targetEpisodeStart: 1 }],
    };
    expect((await ctx.changeRequest(id)).evidence).toMatchObject({
      reviewAgent: { verdict: "reject_with_correction", correction: bounded, fallback: null },
    });
    expect(await leads(ctx)).toEqual([
      expect.objectContaining({ season: 8, segments: bounded.segments }),
    ]);
  });

  test("an open-ended correction on a season still airing keeps its open end", async () => {
    // TMDB season 8 lists 10 episodes, of which 8–10 are scheduled ahead; the platform has the first 7.
    const unaired: typeof httpStub = (request) => {
      const response = httpStub(request);
      if (!/\/tv\/70001\/season\/8/.test(request.url)) return response;
      const body = JSON.parse(response.body) as { episodes: Array<Record<string, unknown>> };
      for (const ep of body.episodes)
        if ((ep.episode_number as number) > 7) ep.air_date = "2026-12-31";
      return { ...response, body: JSON.stringify(body) };
    };
    const airing = createAdapterRegistry([
      {
        ...bilibiliAdapter,
        async fetchCollection(id, outbound) {
          const result = await bilibiliAdapter.fetchCollection(id, outbound);
          return result.status === "found"
            ? {
                ...result,
                info: { ...result.info, featureEpisodes: result.info.featureEpisodes.slice(0, 7) },
              }
            : result;
        },
      },
    ]);
    const openEnded = {
      season: 8,
      segments: [{ season: 8, episodeStart: 1, episodeEnd: null, targetEpisodeStart: 1 }],
    };
    const model: ScriptedModel = (request) => {
      const turn = turnOf(request);
      if (turn === 0) {
        return reply(turn, [
          ["get_collection", { namespace: "bilibili", id: "ss77777" }],
          ["get_catalog_season", { season: 8 }],
        ]);
      }
      return reply(turn, [["reject_with_correction", { opinion: WIFE_OPINION, ...openEnded }]]);
    };
    const ctx = track(await setup(model, {}, airing, {}, unaired));
    const id = await submitAsHuman(ctx);

    await ctx.drain();

    // Exploration accepts an open end on a season still airing once every aired episode is there.
    expect((await ctx.changeRequest(id)).evidence).toMatchObject({
      reviewAgent: { verdict: "reject_with_correction", correction: openEnded, fallback: null },
    });
    expect(await leads(ctx)).toEqual([
      expect.objectContaining({ season: 8, segments: openEnded.segments }),
    ]);
  });

  test("without a reason for it, the submission's own title or year conflict still blocks the correction", async () => {
    const ctx = track(
      await setup(correctsTo(8), {}, relabelled({ year: 2031, title: "妻子的浪漫旅行" })),
    );
    const id = await submitAsHuman(ctx);

    await ctx.drain();

    expect((await ctx.changeRequest(id)).evidence).toMatchObject({
      reviewAgent: { verdict: "reject", fallback: "correction_failed_step1: year_mismatch" },
    });
    expect(await leads(ctx)).toEqual([]);
  });

  test("a season's year still decides a correction when the collection's year matches a season: explaining it does not help", async () => {
    // The collection is from 2026, season 8's year; season 7 aired in 2024.
    const ctx = track(
      await setup(correctsTo(7, [{ code: "segment_year_mismatch", reason: "年份不重要" }])),
    );
    const id = await submitAsHuman(ctx);

    await ctx.drain();

    expect((await ctx.changeRequest(id)).evidence).toMatchObject({
      reviewAgent: {
        verdict: "reject",
        fallback: expect.stringMatching(/^correction_failed_step2: .*segment_year_mismatch/),
      },
    });
    expect(await leads(ctx)).toEqual([]);
  });

  test("a correction with no authority ID survives later comments and applies only once across requests", async () => {
    const ctx = track(await setup(correctsTo(8)));
    const { id: mediaId } = await createWifeMedia(ctx);
    const submit = () =>
      ctx.submit("ss77777", { targetExternalKey: mediaId, segments: wifeSegments(6) });
    const first = await submit();
    await ctx.tick();
    const ext = await ctx.testDb.writeDb
      .deleteFrom("associations")
      .where("media_id", "=", mediaId)
      .where("is_external_id", "=", true)
      .returning(["media_id", "namespace", "native_id", "status", "is_external_id"])
      .executeTakeFirstOrThrow();
    await ctx.drain();
    expect(await ctx.changeRequest(first)).toMatchObject({
      status: "rejected",
      evidence: { reviewAgent: { verdict: "reject_with_correction" } },
    });
    expect(await leads(ctx)).toEqual([]);
    for (const text of ["再改正一次", "请重试改正"]) {
      await comment(ctx, first, text);
      const calls = ctx.outbound.modelRequests.length;
      await ctx.drain();
      expect(ctx.outbound.modelRequests[calls]!.tools!.map((t) => t.name)).not.toContain(
        "reject_with_correction",
      );
      expect(await ctx.changeRequest(first)).toMatchObject({
        status: "rejected",
        evidence: { reviewAgent: { verdict: "reject" } },
      });
    }
    await ctx.testDb.writeDb.insertInto("associations").values(ext).execute();
    const next = await submit();
    const calls = ctx.outbound.modelRequests.length;
    await ctx.drain();
    expect(ctx.outbound.modelRequests[calls]!.tools!.map((t) => t.name)).not.toContain(
      "reject_with_correction",
    );
    expect(await ctx.changeRequest(next)).toMatchObject({
      status: "rejected",
      evidence: { reviewAgent: { verdict: "reject" } },
    });
    expect(await leads(ctx)).toEqual([]);
  });

  test("racing corrections have one durable winner, and an aborted commit consumes no correction", async () => {
    const ctx = track(await setup(correctsTo(8)));
    const { id: mediaId } = await createWifeMedia(ctx);
    const db = ctx.testDb.writeDb;
    const submit = (setDefaultVariant: boolean) =>
      ctx.submit("ss77777", {
        targetExternalKey: mediaId,
        setDefaultVariant,
        segments: wifeSegments(6),
      });
    const ids = [await submit(true), await submit(false)];
    await ctx.tick(); // Evidence for both requests is now available to both sessions.
    await db
      .deleteFrom("associations")
      .where("media_id", "=", mediaId)
      .where("is_external_id", "=", true)
      .execute();
    await ctx.worker.scheduled(createScheduledController(T0));
    const handler = createReviewAgentJobHandler({
      dailyBudget: 10,
      tmdbConfig: { accessToken: "fixture" },
    });
    const reviews = await Promise.all(
      ctx.emitted
        .filter((m) => m.jobType === "review_agent")
        .map(async (m) => {
          const job = (await getJobById(db, m.jobId))!;
          const outcome = await handler({ db, outbound: ctx.outbound, job, now: T0 });
          if (outcome.status !== "completed" || !outcome.onCommit)
            throw new Error("expected a review decision");
          expect(outcome.result?.verdict).toBe("reject_with_correction");
          return {
            jobId: job.id,
            leaseGeneration: job.leaseGeneration,
            result: outcome.result,
            onCommit: outcome.onCommit,
            now: T0,
          };
        }),
    );
    expect(reviews).toHaveLength(2);
    const first = reviews[0]!;
    await expect(
      completeJobWithFencing(db, {
        ...first,
        onCommit: async (trx, job) => {
          await first.onCommit(trx, job);
          throw new Error("abort deciding transaction");
        },
      }),
    ).rejects.toThrow("abort deciding transaction");
    expect(await db.selectFrom("review_corrections").selectAll().execute()).toEqual([]);
    expect(await demands(ctx)).toEqual([]);
    const commits = await Promise.all(reviews.map((r) => completeJobWithFencing(db, r)));
    expect(commits.every((c) => c.applied)).toBe(true);
    const rows = await db.selectFrom("review_corrections").selectAll().execute();
    expect(rows).toEqual([
      expect.objectContaining({ media_id: mediaId, namespace: "bilibili", native_id: "ss77777" }),
    ]);
    for (const id of ids) {
      const verdict = rows[0]!.change_request_id === id ? "reject_with_correction" : "reject";
      expect(await ctx.changeRequest(id)).toMatchObject({
        status: "rejected",
        evidence: {
          reviewAgent: {
            verdict,
            concluded: "reject_with_correction",
            fallback: verdict === "reject" ? "already_corrected" : null,
          },
        },
      });
    }
    const recorded = await Promise.all(reviews.map((r) => getJobById(db, r.jobId)));
    expect(recorded.map((j) => j!.result?.verdict)).toEqual(
      expect.arrayContaining(["reject", "reject_with_correction"]),
    );
    expect(await leads(ctx)).toEqual([]);
    expect(await demands(ctx)).toHaveLength(1);
  });

  test("a receipt for an unresolved catalog key follows that key once it identifies a media", async () => {
    const ctx = track(await setup(correctsTo(8)));
    const { id: mediaId } = await createWifeMedia(ctx);
    const origin = await ctx.submit("ss77777", {
      targetExternalKey: "douban:1234",
      segments: wifeSegments(6),
      initialStatus: "needs_review",
    });
    const db = ctx.testDb.writeDb;
    await db
      .updateTable("change_requests")
      .set({ status: "rejected" })
      .where("id", "=", origin)
      .execute();
    await db
      .insertInto("review_corrections")
      .values({
        change_request_id: origin,
        namespace: "bilibili",
        native_id: "ss77777",
        target_external_key: "douban:1234",
      })
      .execute();
    await db
      .insertInto("associations")
      .values({ media_id: mediaId, namespace: "douban", native_id: "1234", status: "confirmed" })
      .execute();
    const next = await ctx.submit("ss77777", {
      targetExternalKey: mediaId,
      segments: wifeSegments(6),
    });
    await ctx.drain();
    expect(ctx.outbound.modelRequests[0]!.tools!.map((t) => t.name)).not.toContain(
      "reject_with_correction",
    );
    expect(await ctx.changeRequest(next)).toMatchObject({
      status: "rejected",
      evidence: { reviewAgent: { verdict: "reject" } },
    });
    expect(await leads(ctx)).toEqual([]);
  });

  test("the same media and platform ID is corrected only once: the second review cannot reject", async () => {
    const ctx = track(await setup(correctsTo(8)));
    await submitAsHuman(ctx);
    await ctx.drain();
    // Corrections made before receipts existed may have only their lead left.
    await ctx.testDb.writeDb.deleteFrom("review_corrections").execute();
    const callsAfterFirst = ctx.outbound.modelRequests.length;

    const second = await submitAsHuman(ctx);
    await ctx.drain();

    // The second session is not offered the tool; calling it anyway gets UNKNOWN_TOOL.
    const tools = ctx.outbound.modelRequests[callsAfterFirst]!.tools!.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["approve", "reject"]));
    expect(tools).not.toContain("reject_with_correction");
    const cr = await ctx.changeRequest(second);
    expect(cr.status).toBe("rejected");
    expect((cr.evidence as Record<string, any>).reviewAgent).toMatchObject({
      verdict: "reject",
      opinion: WIFE_OPINION,
    });
    expect(await leads(ctx)).toHaveLength(1);
  });

  /** Fetches 灵笼's collection and season 1, then rejects with these segments. */
  const correctsLinglong =
    (segments: typeof linglongCorrection): ScriptedModel =>
    (request) => {
      const turn = turnOf(request);
      if (turn === 0) {
        return reply(turn, [
          ["get_collection", { namespace: "bilibili", id: "ss28888" }],
          ["get_catalog_season", { season: 1 }],
        ]);
      }
      if (turn === 1) {
        return reply(turn, [
          ["reject_with_correction", { opinion: "中章夹在第 6、7 集之间", season: 1, segments }],
        ]);
      }
      return reply(turn, [["reject", { opinion: "改正没过复核" }]]);
    };
  const linglongWholeSeason: SegmentInput[] = [
    { season: 1, episodeStart: 1, episodeEnd: 12, targetEpisodeStart: 1, baseline: "tmdb" },
  ];
  const linglongCorrection = LINGLONG_SEGMENTS.map(
    ({ season, episodeStart, episodeEnd, targetEpisodeStart }) => ({
      season,
      episodeStart,
      episodeEnd,
      targetEpisodeStart,
    }),
  );

  test("灵笼: the whole season from position 1 is off by one after 中章; the split correction skips positions and fits the collection, so it holds", async () => {
    const ctx = track(await setup(correctsLinglong(linglongCorrection)));
    const id = await ctx.submit("ss28888", { segments: linglongWholeSeason });

    await ctx.drain();

    const cr = await ctx.changeRequest(id);
    expect(cr.status).toBe("rejected");
    expect((cr.evidence as Record<string, any>).reviewAgent).toMatchObject({
      verdict: "reject_with_correction",
      correction: { season: 1, segments: linglongCorrection },
      fallback: null,
    });
    expect(await leads(ctx)).toEqual([
      expect.objectContaining({ native_id: "ss28888", season: 1 }),
    ]);
  });

  test.each([
    {
      name: "overlapping positions",
      segments: [
        { season: 1, episodeStart: 1, episodeEnd: 6, targetEpisodeStart: 1 },
        { season: 1, episodeStart: 7, episodeEnd: 12, targetEpisodeStart: 6, baseline: "tmdb" },
      ],
    },
    {
      name: "positions past the collection's last feature episode",
      segments: [
        { season: 1, episodeStart: 1, episodeEnd: 6, targetEpisodeStart: 1 },
        { season: 1, episodeStart: 7, episodeEnd: 12, targetEpisodeStart: 12 },
      ],
    },
  ])("灵笼: a split correction with $name still fails step 2", async ({ segments }) => {
    const ctx = track(await setup(correctsLinglong(segments)));
    const id = await ctx.submit("ss28888", { segments: linglongWholeSeason });

    await ctx.drain();

    const cr = await ctx.changeRequest(id);
    expect(cr.status).toBe("rejected");
    expect((cr.evidence as Record<string, any>).reviewAgent).toMatchObject({
      verdict: "reject",
      fallback: expect.stringMatching(/^correction_failed_step2: /),
    });
    expect(await leads(ctx)).toEqual([]);
  });

  test("灵笼: a correction mapping the same catalog episodes twice cannot be resubmitted, so the request is rejected plainly", async () => {
    // Positions 1–6 and 8–13 fit the collection without overlap, but TMDB 1–6 appears twice.
    const ctx = track(
      await setup(
        correctsLinglong([
          { season: 1, episodeStart: 1, episodeEnd: 6, targetEpisodeStart: 1 },
          { season: 1, episodeStart: 1, episodeEnd: 6, targetEpisodeStart: 8 },
        ]),
      ),
    );
    const id = await ctx.submit("ss28888", { segments: linglongWholeSeason });

    await ctx.drain();

    const cr = await ctx.changeRequest(id);
    expect(cr.status).toBe("rejected");
    expect((cr.evidence as Record<string, any>).reviewAgent).toMatchObject({
      verdict: "reject",
      fallback: expect.stringMatching(
        /^correction_invalid_segments: .*OVERLAPPING_VARIANT_SEGMENTS/,
      ),
    });
    expect(await leads(ctx)).toEqual([]);
  });

  test("灵笼 split in two: a segment-only correction reaches exploration, whose fast path resubmits with the corrected segments", async () => {
    // ss28889 holds only TMDB season 1 episodes 7–12; the submission mapped the whole season.
    const wholeSeason: SegmentInput[] = [
      { season: 1, episodeStart: 1, episodeEnd: 12, targetEpisodeStart: 1, baseline: "tmdb" },
    ];
    const secondHalf = { season: 1, episodeStart: 7, episodeEnd: 12, targetEpisodeStart: 1 };
    const model: ScriptedModel = (request) => {
      const tool = request.tools?.find((t) => t.name === "mark_not_found");
      if (tool) {
        // Exploration: nothing on the other platforms.
        const { enum: namespaces } = (
          tool.parameters as { properties: { namespace: { enum: string[] } } }
        ).properties.namespace;
        return reply(
          turnOf(request),
          namespaces.map((namespace) => ["mark_not_found", { namespace, reason: "no match" }]),
        );
      }
      const turn = turnOf(request);
      if (turn === 0) {
        return reply(turn, [
          ["get_collection", { namespace: "bilibili", id: "ss28889" }],
          ["get_catalog_season", { season: 1 }],
        ]);
      }
      return reply(turn, [
        [
          "reject_with_correction",
          { opinion: "这是第一季的后半部分", season: 1, segments: [secondHalf] },
        ],
      ]);
    };
    const ctx = track(
      await setup(model, {}, createDefaultAdapterRegistry(), {
        enableExplorationScheduling: true,
        exploration: { dailyBudget: 10 },
        explorationAgent: { discover: async () => ({ candidates: [], sources: [], dropped: [] }) },
      }),
    );
    const media = await ctx.testDb.writeDb
      .insertInto("media")
      .values({
        type: "tv",
        baseline: "tmdb",
        title: "灵笼",
        original_title: "灵笼",
        year: 2019,
        seasons: JSON.stringify([
          { season: 0, episodeCount: 4, airYear: 2019 },
          { season: 1, episodeCount: 12, airYear: 2019 },
        ]),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await ctx.testDb.writeDb
      .insertInto("associations")
      .values({
        status: "confirmed",
        is_external_id: true,
        media_id: media.id,
        namespace: "tmdb",
        native_id: "tv:91234",
      })
      .execute();
    const demand = await ctx.testDb.writeDb
      .insertInto("demands")
      .values({
        media_id: media.id,
        season: 1,
        namespace_group: "platform",
        status: "awaiting_review",
        not_found_count: 0,
        next_eligible_at: T0,
        last_demanded_at: T0,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    // A dub: the correction must not turn it into the default original-audio variant.
    const id = await ctx.submit("ss28889", {
      segments: wholeSeason,
      demandId: demand.id,
      variantDescription: "国语配音",
      setDefaultVariant: false,
    });

    await ctx.tick(); // evidence_check
    await ctx.tick(); // review_agent

    expect((await ctx.changeRequest(id)).status).toBe("rejected");
    expect(await leads(ctx)).toEqual([
      expect.objectContaining({ native_id: "ss28889", season: 1, segments: [secondHalf] }),
    ]);
    // The correction keeps the request's season: its demand is explorable now, no not-found round.
    expect(await demands(ctx)).toEqual([
      expect.objectContaining({ id: demand.id, status: "open", not_found_count: 0 }),
    ]);

    await ctx.tick(); // exploration of season 1
    const resubmitted = await ctx.testDb.readDb
      .selectFrom("change_requests")
      .selectAll()
      .where("id", "!=", id)
      .execute();
    expect(resubmitted).toEqual([
      expect.objectContaining({
        native_id: "ss28889",
        submitter_user_id: EXPLORATION_AGENT_USER_ID,
        segments: [expect.objectContaining(secondHalf)],
        variant_description: "国语配音",
        set_default_variant: false,
      }),
    ]);
  });

  /** Stop after exploration has submitted a request; run its commit separately from review. */
  async function leasedReview(season = 8, ordinary = false, mixed = false) {
    const ctx = track(
      await setup(
        ordinary
          ? (request) => reply(turnOf(request), [["reject", { opinion: "no match" }]])
          : correctsTo(8),
        {},
        createDefaultAdapterRegistry(),
        { jobTypes: ["evidence_check", "review_agent"] },
      ),
    );
    const db = ctx.testDb.writeDb;
    const media = await createWifeMedia(ctx);
    const demand = await db
      .insertInto("demands")
      .values({
        media_id: media.id,
        season,
        namespace_group: "platform",
        not_found_count: 1,
        next_eligible_at: T0,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const read = () =>
      db.selectFrom("demands").selectAll().where("id", "=", demand.id).executeTakeFirstOrThrow();
    const [job] = (await scheduleExplorationJobs(db, { now: T0 })).jobs;
    if (!job) throw new Error("missing exploration job");
    let requestId = "";
    const handler = createExplorationJobHandler({
      executor: async () => {
        // The same-season submission includes more episodes than this collection has.
        requestId = await ctx.submit("ss77777", {
          targetExternalKey: WIFE_KEY,
          segments: season === 8 && !mixed ? wifeSegments(8, 12) : wifeSegments(6),
          demandId: demand.id,
        });
        const submitted = {
          namespace: "bilibili",
          status: "submitted",
          changeRequestId: requestId,
        } as const;
        return {
          platformOutcomes: mixed
            ? [submitted, { namespace: "iqiyi", status: "transient_error", reason: "timeout" }]
            : [submitted],
        };
      },
    });
    const outcome = await handler({ db, outbound: ctx.outbound, now: T0, job });
    if (outcome.status !== "completed" || !outcome.onCommit)
      throw new Error("missing exploration commit");
    const commit = () => db.transaction().execute((trx) => outcome.onCommit!(trx, job));
    const review = async () => {
      expect((await ctx.drain()).map((m) => m.jobType)).toEqual(["evidence_check", "review_agent"]);
      expect(await ctx.changeRequest(requestId)).toMatchObject({
        status: "rejected",
        evidence: { reviewAgent: { verdict: ordinary ? "reject" : "reject_with_correction" } },
      });
    };
    const sibling = () =>
      createChangeRequest(db, {
        submitterUserId: EXPLORATION_AGENT_USER_ID,
        targetExternalKey: WIFE_KEY,
        namespace: "bilibili",
        nativeId: "ss77778",
        variantDescription: "原声",
        segments: wifeSegments(8),
        demandId: demand.id,
        initialStatus: "needs_review",
        now: T0,
      });
    return { ctx, db, review, commit, read, sibling };
  }

  test.each([
    { name: "same season", season: 8, ordinary: false, mixed: false, backoff: false },
    {
      name: "same season with another platform unavailable",
      season: 8,
      ordinary: false,
      mixed: true,
      backoff: false,
    },
    { name: "different season", season: 6, ordinary: false, mixed: false, backoff: true },
    { name: "ordinary rejection", season: 8, ordinary: true, mixed: false, backoff: true },
  ])("review before exploration commits: $name", async ({ season, ordinary, mixed, backoff }) => {
    const f = await leasedReview(season, ordinary, mixed);
    await f.review();
    expect(await f.read()).toMatchObject({ status: "leased", not_found_count: 1 });
    await f.commit();
    expect(await f.read()).toMatchObject({
      status: "open",
      lease_expires_at: null,
      not_found_count: backoff ? 2 : 1,
      next_eligible_at: backoff ? new Date(T0.getTime() + 259_200_000) : T0,
    });
  });

  test("a same-season correction survives until the last pending request is rejected", async () => {
    const f = await leasedReview();
    await f.review();
    const sibling = await f.sibling();
    await f.commit();
    expect(await f.read()).toMatchObject({ status: "awaiting_review", not_found_count: 1 });
    await rejectChangeRequest(f.db, {
      changeRequestId: sibling.id,
      reviewerUserId: REVIEW_AGENT_USER_ID,
    });
    const reopened = await f.read();
    expect(reopened).toMatchObject({
      status: "open",
      not_found_count: 1,
      next_eligible_at: reopened.updated_at,
    });
  });

  test("a same-season correction never reopens an already covered demand", async () => {
    const f = await leasedReview();
    await f.commit();
    const sibling = await f.sibling();
    await approveChangeRequest(f.db, f.ctx.outbound, {
      changeRequestId: sibling.id,
      reviewerUserId: null,
      now: T0,
    });
    expect(await f.read()).toMatchObject({ status: "fulfilled" });
    await f.review();
    expect(await f.read()).toMatchObject({ status: "fulfilled", not_found_count: 1 });
  });

  test("neither the old exploration commit nor its correction overrides the next lease", async () => {
    const f = await leasedReview();
    await f.review();
    const later = new Date(T0.getTime() + 86_400_000);
    const [job] = (await scheduleExplorationJobs(f.db, { now: later })).jobs;
    if (!job) throw new Error("missing replacement exploration job");
    await f.commit();
    expect(await f.read()).toMatchObject({
      status: "leased",
      lease_generation: 2,
      not_found_count: 1,
    });
    const handler = createExplorationJobHandler({
      executor: async () => ({
        platformOutcomes: [{ namespace: "bilibili", status: "not_found" }],
      }),
    });
    const result = await handler({ db: f.db, outbound: f.ctx.outbound, now: later, job });
    if (result.status !== "completed" || !result.onCommit)
      throw new Error("missing replacement commit");
    await f.db.transaction().execute((trx) => result.onCommit!(trx, job));
    expect(await f.read()).toMatchObject({
      status: "not_found",
      not_found_count: 2,
      next_eligible_at: new Date(later.getTime() + 259_200_000),
    });
  });

  test("a correction to another season: the submission's own demand backs off, the corrected season is explorable now, and exploration resubmits from the lead", async () => {
    // The exploration agent marks every platform it has no candidate for as not found.
    const model: ScriptedModel = (request) => {
      const tool = request.tools?.find((t) => t.name === "mark_not_found");
      if (!tool) {
        return correctsTo(8)(request);
      }
      const { enum: namespaces } = (
        tool.parameters as { properties: { namespace: { enum: string[] } } }
      ).properties.namespace;
      return reply(
        turnOf(request),
        namespaces.map((namespace) => ["mark_not_found", { namespace, reason: "no match" }]),
      );
    };
    const ctx = track(
      await setup(model, {}, createDefaultAdapterRegistry(), {
        enableExplorationScheduling: true,
        exploration: { dailyBudget: 10 },
        explorationAgent: { discover: async () => ({ candidates: [], sources: [], dropped: [] }) },
      }),
    );
    const media = await createWifeMedia(ctx);
    // The season 6 demand the exploration agent submitted for, now waiting on that review.
    const demand = await ctx.testDb.writeDb
      .insertInto("demands")
      .values({
        media_id: media.id,
        season: 6,
        namespace_group: "platform",
        status: "awaiting_review",
        not_found_count: 1,
        next_eligible_at: T0,
        last_demanded_at: T0,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const id = await ctx.submit("ss77777", {
      targetExternalKey: WIFE_KEY,
      segments: wifeSegments(6),
      demandId: demand.id,
    });

    // evidence_check, then review_agent: nothing else is due before the rejection.
    await ctx.tick();
    await ctx.tick();

    expect((await ctx.changeRequest(id)).status).toBe("rejected");
    expect(await demands(ctx)).toEqual([
      // Season 6 was not corrected, only abandoned: its second not-found round, 3 days.
      expect.objectContaining({
        id: demand.id,
        season: 6,
        status: "open",
        not_found_count: 2,
        next_eligible_at: new Date(T0.getTime() + 259_200_000),
      }),
      expect.objectContaining({
        media_id: media.id,
        season: 8,
        status: "open",
        not_found_count: 0,
        next_eligible_at: T0,
      }),
    ]);

    // Exploration of season 8 finds the lead's collection and submits it as season 8.
    await ctx.drain();
    const resubmitted = await ctx.testDb.readDb
      .selectFrom("change_requests")
      .selectAll()
      .where("id", "!=", id)
      .execute();
    expect(resubmitted).toEqual([
      expect.objectContaining({
        native_id: "ss77777",
        submitter_user_id: EXPLORATION_AGENT_USER_ID,
        status: "approved",
      }),
    ]);
    expect((resubmitted[0]!.segments as Array<{ season: number }>).map((s) => s.season)).toEqual([
      8,
    ]);
  });
});

// People take part by commenting (ADR 0003 amendment 2): each comment drives a review session,
// which verifies before it acts and always replies in the thread.

const COMMENTER_ID = "user-commenter";
/** Comments are written a minute before the worker's clock. */
const BEFORE_T0 = new Date(T0.getTime() - 60_000);

/** Comment contents the session was shown, read back from its first user message. */
function commentsShown(request: ModelInvocationRequest): string[] {
  const prompt = request.messages.find((m) => m.role === "user")!.content;
  const payload = JSON.parse(prompt.slice(prompt.indexOf("{"))) as {
    comments?: Array<{ content: string }>;
  };
  return (payload.comments ?? []).map((c) => c.content);
}

/** One script for sessions without comments, another for sessions that read comments. */
const byComments =
  (without: ScriptedModel, withComments: ScriptedModel): ScriptedModel =>
  (request) =>
    commentsShown(request).length > 0 ? withComments(request) : without(request);

const rejects: ScriptedModel = (request) =>
  reply(turnOf(request), [["reject", { opinion: "拿不准分段对不对" }]]);

/** Like `approvesLikeLinglong`, with a reply to the comments. */
const approvesReplying =
  (text: string): ScriptedModel =>
  (request) => {
    const turn = turnOf(request);
    if (turn === 0) {
      return approvesLikeLinglong(request);
    }
    return reply(turn, [["approve", { reasons: reasonsFor(request), reply: text }]]);
  };

type Ctx = Awaited<ReturnType<typeof setup>>;

async function comment(ctx: Ctx, changeRequestId: string, content: string, now = BEFORE_T0) {
  await ctx.testDb.writeDb
    .insertInto("user")
    .values({
      id: COMMENTER_ID,
      name: "Commenter",
      email: "commenter@example.test",
      emailVerified: true,
      image: null,
      role: "user",
      reputation: 0,
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
  const created = await createChangeRequestComment(ctx.testDb.writeDb, {
    changeRequestId,
    authorUserId: COMMENTER_ID,
    content,
    now,
  });
  return created.id;
}

const agentReplies = (ctx: Ctx, changeRequestId: string) =>
  ctx.testDb.readDb
    .selectFrom("change_request_comments")
    .selectAll()
    .where("change_request_id", "=", changeRequestId)
    .where("author_user_id", "=", REVIEW_AGENT_USER_ID)
    .execute();

const replyTo = async (ctx: Ctx, changeRequestId: string, commentId: string) =>
  (await agentReplies(ctx, changeRequestId)).filter((r) => r.reply_to_ids.includes(commentId));

describe("review agent: people comment, the agent verifies and replies (amendment 2)", () => {
  const handles: TestDbHandle[] = [];
  const track = <T extends { testDb: TestDbHandle }>(ctx: T) => {
    handles.push(ctx.testDb);
    return ctx;
  };

  afterEach(async () => {
    while (handles.length > 0) {
      await handles.pop()!.cleanup();
    }
  });

  test("a review without comments still writes its conclusion into the thread", async () => {
    const ctx = track(await setup(rejects));
    const id = await ctx.submit();

    await ctx.drain();

    expect((await ctx.changeRequest(id)).status).toBe("rejected");
    expect(await agentReplies(ctx, id)).toEqual([
      expect.objectContaining({
        reply_to_ids: [],
        content: expect.stringContaining("拿不准分段对不对"),
      }),
    ]);
  });

  test("a 「通过」 comment on a rejected request: the agent fetches, approves from rejected and replies", async () => {
    const ctx = track(
      await setup(byComments(rejects, approvesReplying("核实过，多出来的是中章等额外内容"))),
    );
    const id = await ctx.submit();
    await ctx.drain();
    expect((await ctx.changeRequest(id)).status).toBe("rejected");

    const commentId = await comment(ctx, id, "通过：多出来的 4 条是中章、终章和特别篇");
    const ran = await ctx.drain();

    expect(ran.map((m) => m.jobType)).toEqual(["review_agent"]);
    expect(commentsShown(ctx.outbound.modelRequests.at(-1)!)).toEqual([
      "通过：多出来的 4 条是中章、终章和特别篇",
    ]);
    const cr = await ctx.changeRequest(id);
    expect(cr.status).toBe("approved");
    expect(cr.reviewer_user_id).toBe(REVIEW_AGENT_USER_ID);
    expect((cr.evidence as Record<string, any>).reviewAgent).toMatchObject({
      verdict: "approve",
      fallback: null,
    });
    const association = await ctx.testDb.readDb
      .selectFrom("associations")
      .select(["id", "status"])
      .where("native_id", "=", "ss28888")
      .executeTakeFirstOrThrow();
    expect(association.status).toBe("confirmed");
    expect(await replyTo(ctx, id, commentId)).toEqual([
      expect.objectContaining({
        content: expect.stringMatching(/通过[\s\S]*核实过，多出来的是中章等额外内容/),
      }),
    ]);
  });

  test("a comment written while evidence is collected waits for the review; a request the agent cannot verify is not followed, and the reply says why", async () => {
    const ctx = track(
      await setup(
        approvesReplying("留言说这是第二季，但 TMDB 只有第 1 季，合集也对得上第 1 季，没有照做"),
      ),
    );
    const id = await ctx.submit();
    const commentId = await comment(ctx, id, "这是第二季，请改成第 2 季");

    const ran = await ctx.drain();

    // No job of its own: the review after the evidence check reads it.
    expect(ran.map((m) => m.jobType)).toEqual(["evidence_check", "review_agent"]);
    expect(commentsShown(ctx.outbound.modelRequests[0]!)).toEqual(["这是第二季，请改成第 2 季"]);
    expect((await ctx.changeRequest(id)).status).toBe("approved");
    expect(await replyTo(ctx, id, commentId)).toEqual([
      expect.objectContaining({ content: expect.stringContaining("没有照做") }),
    ]);
    // The prompt tells the model a comment may be wrong and must be verified first.
    const system = ctx.outbound.modelRequests[0]!.messages.find((m) => m.role === "system")!;
    expect(system.content).toMatch(/comment/i);
    expect(system.content).toMatch(/verify/i);
  });

  test("「这是第 8 季」 on a rejected request: the agent rejects with the correction, writes the lead and replies", async () => {
    const ctx = track(await setup(byComments(rejects, correctsTo(8))));
    await ctx.testDb.writeDb
      .insertInto("user")
      .values({
        id: "user-human",
        name: "Human",
        email: "human@example.test",
        emailVerified: true,
        image: null,
        role: "user",
        reputation: 0,
      })
      .execute();
    const id = await ctx.submit("ss77777", {
      submitterUserId: "user-human",
      submitterType: "human",
      targetExternalKey: WIFE_KEY,
      segments: wifeSegments(6),
    });
    await ctx.drain();
    expect((await ctx.changeRequest(id)).status).toBe("rejected");

    const commentId = await comment(ctx, id, "这是 2026 年那季，是第 8 季");
    await ctx.drain();

    const cr = await ctx.changeRequest(id);
    expect(cr.status).toBe("rejected");
    expect(cr.decision_reason).toContain("第 8 季");
    expect((cr.evidence as Record<string, any>).reviewAgent).toMatchObject({
      verdict: "reject_with_correction",
      correction: correctionFor(8),
    });
    expect(await ctx.testDb.readDb.selectFrom("leads").select("season").execute()).toEqual([
      { season: 8 },
    ]);
    expect(
      await ctx.testDb.readDb
        .selectFrom("demands")
        .select(["season", "status", "next_eligible_at"])
        .where("season", "=", 8)
        .execute(),
    ).toEqual([{ season: 8, status: "open", next_eligible_at: T0 }]);
    expect(await replyTo(ctx, id, commentId)).toEqual([
      expect.objectContaining({ content: expect.stringContaining("第 8 季") }),
    ]);
  });

  test("on a model outage the comment gets no reply until the retried session concludes", async () => {
    let failing = false;
    const ctx = track(
      await setup((request) => {
        if (failing) {
          throw new Error("upstream 503");
        }
        return rejects(request);
      }),
    );
    const id = await ctx.submit();
    await ctx.drain();
    failing = true;

    const commentId = await comment(ctx, id, "通过");
    await ctx.drain();

    expect(await replyTo(ctx, id, commentId)).toEqual([]);
    const job = await ctx.testDb.readDb
      .selectFrom("background_jobs")
      .select(["status", "run_after"])
      .where("job_type", "=", "review_agent")
      .where("status", "=", "pending")
      .executeTakeFirstOrThrow();
    expect(job.run_after.getTime()).toBe(T0.getTime() + 60 * 60 * 1000);
  });

  /** First review: fetches the collection and season 6, then approves season 6. */
  const approvesSeason6: ScriptedModel = (request) => {
    const turn = turnOf(request);
    if (turn === 0) {
      return reply(turn, [
        ["get_collection", { namespace: "bilibili", id: "ss77777" }],
        ["get_catalog_season", { season: 6 }],
      ]);
    }
    return reply(turn, [
      [
        "approve",
        { reasons: conflictCodes(request).map((code) => ({ code, reason: "看着没问题" })) },
      ],
    ]);
  };

  /** Fetches the collection and season 1, then takes the live mapping down. */
  const revokesLinglong: ScriptedModel = (request) => {
    const turn = turnOf(request);
    if (turn === 0) {
      return reply(turn, [
        ["get_collection", { namespace: "bilibili", id: "ss28888" }],
        ["get_catalog_season", { season: 1 }],
      ]);
    }
    return reply(turn, [
      [
        "revoke",
        { opinion: "位置 7 是中章，第 7–12 集错开了一位", reply: "核实过，确实错开一位，已撤下" },
      ],
    ]);
  };

  const keeps: ScriptedModel = (request) =>
    reply(turnOf(request), [["keep", { opinion: "对应没问题", reply: "核实过，维持" }]]);

  /** Approves 灵笼 in its first review, then lets `withComments` answer comments. */
  async function approvedLinglong(withComments: ScriptedModel) {
    const ctx = track(await setup(byComments(approvesLikeLinglong, withComments)));
    const id = await ctx.submit();
    await ctx.drain();
    const cr = await ctx.changeRequest(id);
    expect(cr.status).toBe("approved");
    return { ctx, id, associationId: cr.applied_association_id!, mediaId: cr.media_id! };
  }

  const association = (ctx: Ctx, associationId: string) =>
    ctx.testDb.readDb
      .selectFrom("associations")
      .select(["status", "current_revision_id"])
      .where("id", "=", associationId)
      .executeTakeFirstOrThrow();

  test("revoke: a comment says the approved mapping is wrong; the agent verifies, delists the association with a revision, reopens the season's demand and replies", async () => {
    const { ctx, id, associationId, mediaId } = await approvedLinglong(revokesLinglong);
    // The season 1 demand and the whole-media demand the approval fulfilled.
    await ctx.testDb.writeDb
      .insertInto("demands")
      .values(
        [1, null].map((season) => ({
          media_id: mediaId,
          season,
          namespace_group: "platform" as const,
          status: "fulfilled",
          not_found_count: 0,
          next_eligible_at: T0,
          last_demanded_at: T0,
        })),
      )
      .execute();

    const commentId = await comment(ctx, id, "撤下：第 7 集起错开一位");
    await ctx.drain();

    const cr = await ctx.changeRequest(id);
    expect(cr.status).toBe("rejected");
    expect(cr.reviewer_user_id).toBe(REVIEW_AGENT_USER_ID);
    expect((cr.evidence as Record<string, any>).reviewAgent).toMatchObject({
      verdict: "revoke",
      fallback: null,
    });
    const after = await association(ctx, associationId);
    expect(after.status).toBe("delisted");
    const revision = await ctx.testDb.readDb
      .selectFrom("association_revisions")
      .selectAll()
      .where("id", "=", after.current_revision_id!)
      .executeTakeFirstOrThrow();
    expect(revision).toMatchObject({
      status: "delisted",
      actor_user_id: REVIEW_AGENT_USER_ID,
      change_request_id: id,
      revision_number: 2,
    });
    expect(revision.reason).toContain("撤下：第 7 集起错开一位");
    expect(revision.reason).toContain("位置 7 是中章");
    expect(
      await ctx.testDb.readDb
        .selectFrom("segments")
        .select("id")
        .where("association_id", "=", associationId)
        .execute(),
    ).toEqual([]);
    // Both wanted again after a not-found round, like a rejection.
    const reopened = {
      status: "open",
      not_found_count: 1,
      next_eligible_at: new Date(T0.getTime() + 86_400_000),
    };
    expect(
      await ctx.testDb.readDb
        .selectFrom("demands")
        .select(["season", "status", "not_found_count", "next_eligible_at"])
        .orderBy("season")
        .execute(),
    ).toEqual([
      { season: 1, ...reopened },
      { season: null, ...reopened },
    ]);
    expect(await replyTo(ctx, id, commentId)).toEqual([
      expect.objectContaining({ content: expect.stringMatching(/撤下[\s\S]*已撤下/) }),
    ]);
  });

  async function revokeHistorySetup() {
    const ctx = track(
      await setup((request) => {
        const turn = turnOf(request);
        return turn === 0
          ? reply(turn, [
              ["get_collection", { namespace: "bilibili", id: "ss77777" }],
              ["get_catalog_season", { season: 1 }],
              ["get_catalog_season", { season: 2 }],
            ])
          : reply(turn, [["revoke", { opinion: "核实后撤下本次变更" }]]);
      }),
    );
    const { id: mediaId } = await createWifeMedia(ctx);
    const approve = async (
      nativeId: string,
      season: number,
      episodeStart: number,
      episodeEnd: number,
      targetEpisodeStart = 1,
    ) => {
      const id = await ctx.submit(nativeId, {
        targetExternalKey: mediaId,
        initialStatus: "needs_review",
        segments: [{ season, episodeStart, episodeEnd, targetEpisodeStart, baseline: "tmdb" }],
      });
      return approveChangeRequest(ctx.testDb.writeDb, ctx.outbound, {
        changeRequestId: id,
        reviewerUserId: null,
        now: T0,
        evidence: {
          catalog: {
            namespace: "tmdb",
            canonicalId: "tv:70001",
            seasons: [
              { season: 1, episodeCount: 12 },
              { season: 2, episodeCount: 12 },
            ],
          },
        },
      });
    };
    const segments = (associationId: string) =>
      ctx.testDb.readDb
        .selectFrom("segments")
        .select(["season", "episode_start", "episode_end", "target_episode_start"])
        .where("association_id", "=", associationId)
        .orderBy("season")
        .orderBy("episode_start")
        .execute();
    return { ctx, approve, segments, mediaId };
  }

  test("revoking the second season restores the first season and records a confirmed revision", async () => {
    const { ctx, approve, segments } = await revokeHistorySetup();
    const first = await approve("ss77777", 1, 1, 5);
    const before = await segments(first.associationId);
    const second = await approve("ss77777", 2, 1, 5, 6);
    expect(second.associationId).toBe(first.associationId);
    expect(await segments(first.associationId)).toHaveLength(2);
    await comment(ctx, second.changeRequest.id, "撤下第二季");
    await ctx.drain();
    expect((await ctx.changeRequest(second.changeRequest.id)).status).toBe("rejected");
    expect((await ctx.changeRequest(first.changeRequest.id)).status).toBe("approved");
    expect(await segments(first.associationId)).toEqual(before);
    const restored = await association(ctx, first.associationId);
    expect(restored.status).toBe("confirmed");
    const revision = await ctx.testDb.readDb
      .selectFrom("association_revisions")
      .selectAll()
      .where("id", "=", restored.current_revision_id!)
      .executeTakeFirstOrThrow();
    expect(revision).toMatchObject({
      revision_number: 3,
      status: "confirmed",
      change_request_id: second.changeRequest.id,
      segments: first.changeRequest.segments,
      actor_user_id: REVIEW_AGENT_USER_ID,
      reason: expect.stringContaining("撤下第二季"),
    });
  });

  test.each([false, true])(
    "a restored approval can still be revoked, while locked or superseded ones cannot (another approval: %s)",
    async (withC) => {
      const { ctx, approve, segments } = await revokeHistorySetup();
      const a = await approve("ss77777", 1, 1, 5);
      const b = await approve("ss77777", 2, 1, 5, 6);
      await comment(ctx, b.changeRequest.id, "撤下第二张单");
      await ctx.drain();
      expect(await ctx.changeRequest(b.changeRequest.id)).toMatchObject({ status: "rejected" });
      const c = withC ? await approve("ss77777", 2, 2, 3, 8) : null;
      if (c) {
        await comment(ctx, a.changeRequest.id, "撤下已被替代的第一张单");
        await ctx.drain();
        expect(await ctx.changeRequest(a.changeRequest.id)).toMatchObject({
          status: "approved",
          evidence: { reviewAgent: { fallback: "revoke_failed: ASSOCIATION_SUPERSEDED" } },
        });
        expect((await association(ctx, a.associationId)).current_revision_id).toBe(c.revisionId);
        await comment(ctx, c.changeRequest.id, "撤下第三张单");
        await ctx.drain();
        expect(await ctx.changeRequest(c.changeRequest.id)).toMatchObject({ status: "rejected" });
      }
      const restored = await association(ctx, a.associationId);
      await ctx.testDb.writeDb
        .updateTable("associations")
        .where("id", "=", a.associationId)
        .set({ locked: true })
        .execute();
      await comment(ctx, a.changeRequest.id, "撤下锁定的关联");
      await ctx.drain();
      expect(await association(ctx, a.associationId)).toEqual(restored);
      expect(await ctx.changeRequest(a.changeRequest.id)).toMatchObject({
        status: "approved",
        evidence: { reviewAgent: { fallback: "revoke_failed: ASSOCIATION_LOCKED" } },
      });
      await ctx.testDb.writeDb
        .updateTable("associations")
        .where("id", "=", a.associationId)
        .set({ locked: false })
        .execute();
      await comment(ctx, a.changeRequest.id, "核实后撤下第一张单");
      await ctx.drain();
      expect(await ctx.changeRequest(a.changeRequest.id)).toMatchObject({
        status: "rejected",
        evidence: { reviewAgent: { verdict: "revoke" } },
      });
      expect((await association(ctx, a.associationId)).status).toBe("delisted");
      expect(await segments(a.associationId)).toEqual([]);
      expect(
        await ctx.testDb.readDb
          .selectFrom("association_revisions")
          .select(["change_request_id", "status", "restored_from_revision_id"])
          .where("association_id", "=", a.associationId)
          .orderBy("revision_number")
          .execute(),
      ).toEqual([
        {
          change_request_id: a.changeRequest.id,
          status: "confirmed",
          restored_from_revision_id: null,
        },
        {
          change_request_id: b.changeRequest.id,
          status: "confirmed",
          restored_from_revision_id: null,
        },
        {
          change_request_id: b.changeRequest.id,
          status: "confirmed",
          restored_from_revision_id: a.revisionId,
        },
        ...(c
          ? [
              {
                change_request_id: c.changeRequest.id,
                status: "confirmed",
                restored_from_revision_id: null,
              },
              {
                change_request_id: c.changeRequest.id,
                status: "confirmed",
                restored_from_revision_id: a.revisionId,
              },
            ]
          : []),
        {
          change_request_id: a.changeRequest.id,
          status: "delisted",
          restored_from_revision_id: null,
        },
      ]);
    },
  );

  test("a pre-migration restore without provable provenance cannot authorize a later delist", async () => {
    const { ctx, approve, segments } = await revokeHistorySetup();
    const a = await approve("ss77777", 1, 1, 5);
    const b = await approve("ss77777", 2, 1, 5, 6);
    await comment(ctx, b.changeRequest.id, "撤下第二张单");
    await ctx.drain();
    const restored = await association(ctx, a.associationId);
    await ctx.testDb.writeDb
      .updateTable("association_revisions")
      .set({ restored_from_revision_id: null })
      .where("id", "=", restored.current_revision_id!)
      .execute();
    const c = await approve("ss77777", 2, 1, 5, 6);
    const before = await segments(a.associationId);
    await comment(ctx, c.changeRequest.id, "撤下第三张单");
    await ctx.drain();
    expect(await ctx.changeRequest(c.changeRequest.id)).toMatchObject({
      status: "approved",
      evidence: { reviewAgent: { verdict: "keep" } },
    });
    expect((await association(ctx, a.associationId)).current_revision_id).toBe(c.revisionId);
    expect(await segments(a.associationId)).toEqual(before);
  });

  test("delisting reopens demands for all seasons removed, including segments inherited from a seed", async () => {
    const { ctx, approve, mediaId } = await revokeHistorySetup();
    const first = await approve("ss77777", 1, 1, 5);
    // A seeded revision did not come from a change request.
    await ctx.testDb.writeDb
      .updateTable("association_revisions")
      .set({ change_request_id: null })
      .where("id", "=", first.revisionId)
      .execute();
    const second = await approve("ss77777", 2, 1, 5, 6);
    await ctx.testDb.writeDb
      .insertInto("demands")
      .values(
        [1, 2].map((season) => ({
          media_id: mediaId,
          season,
          namespace_group: "platform" as const,
          status: "fulfilled" as const,
          next_eligible_at: T0,
          last_demanded_at: T0,
        })),
      )
      .execute();
    await comment(ctx, second.changeRequest.id, "撤下第二季");
    await ctx.drain();
    expect((await association(ctx, first.associationId)).status).toBe("delisted");
    expect(
      await ctx.testDb.readDb
        .selectFrom("demands")
        .select(["season", "status"])
        .orderBy("season")
        .execute(),
    ).toEqual([
      { season: 1, status: "open" },
      { season: 2, status: "open" },
    ]);
  });

  test("a restore that overlaps another collection keeps both segment sets, revisions and demands unchanged and explains why", async () => {
    const { ctx, approve, segments, mediaId } = await revokeHistorySetup();
    await approve("ss77777", 1, 1, 12);
    const a = await approve("ss77777", 1, 1, 6);
    const b = await approve("ss28889", 1, 7, 12);
    const before = await Promise.all([segments(a.associationId), segments(b.associationId)]);
    const demand = await ctx.testDb.writeDb
      .insertInto("demands")
      .values({
        media_id: mediaId,
        season: 1,
        namespace_group: "platform",
        status: "fulfilled",
        next_eligible_at: T0,
        last_demanded_at: T0,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const commentId = await comment(ctx, a.changeRequest.id, "撤下缩短范围的变更");
    await ctx.drain();
    expect(await ctx.changeRequest(a.changeRequest.id)).toMatchObject({
      status: "approved",
      evidence: {
        reviewAgent: {
          verdict: "keep",
          concluded: "revoke",
          fallback: expect.stringContaining("Overlapping segments in season 1"),
        },
      },
    });
    expect(await replyTo(ctx, a.changeRequest.id, commentId)).toEqual([
      expect.objectContaining({
        content: expect.stringContaining("Overlapping segments in season 1"),
      }),
    ]);
    expect(await Promise.all([segments(a.associationId), segments(b.associationId)])).toEqual(
      before,
    );
    for (const live of [a, b]) {
      expect(await association(ctx, live.associationId)).toEqual({
        status: "confirmed",
        current_revision_id: live.revisionId,
      });
    }
    expect(
      await ctx.testDb.readDb
        .selectFrom("association_revisions")
        .select("id")
        .where("association_id", "=", a.associationId)
        .execute(),
    ).toHaveLength(2);
    expect(
      await ctx.testDb.readDb
        .selectFrom("demands")
        .selectAll()
        .where("id", "=", demand.id)
        .executeTakeFirst(),
    ).toEqual(demand);
  });

  test("revoke without fetching the collection and season keeps the mapping, and the reply says why", async () => {
    const lazyRevoke: ScriptedModel = (request) =>
      reply(turnOf(request), [["revoke", { opinion: "留言说错了" }]]);
    const { ctx, id, associationId } = await approvedLinglong(lazyRevoke);

    const commentId = await comment(ctx, id, "这条是错的，撤下");
    await ctx.drain();

    expect((await ctx.changeRequest(id)).status).toBe("approved");
    expect((await association(ctx, associationId)).status).toBe("confirmed");
    expect(await replyTo(ctx, id, commentId)).toEqual([
      expect.objectContaining({
        content: expect.stringMatching(/维持通过[\s\S]*collection_not_fetched/),
      }),
    ]);
  });

  test("revoking a whole-media mapping reopens every season's demand it fulfilled, unless another mapping still covers it", async () => {
    const { ctx, id, associationId, mediaId } = await approvedLinglong(revokesLinglong);
    // Make the live mapping whole-media (no segments), as a movie or whole-show mapping is.
    await ctx.testDb.writeDb
      .deleteFrom("segments")
      .where("association_id", "=", associationId)
      .execute();
    await ctx.testDb.writeDb
      .updateTable("change_requests")
      .set({ segments: JSON.stringify([]) })
      .where("id", "=", id)
      .execute();
    // Season 2 is also covered by another platform's mapping, which stays.
    const variant = await ctx.testDb.writeDb
      .insertInto("variants")
      .values({ media_id: mediaId, platform: "iqiyi", description: "原声", is_default: true })
      .returning("id")
      .executeTakeFirstOrThrow();
    const other = await ctx.testDb.writeDb
      .insertInto("associations")
      .values({
        status: "confirmed",
        media_id: mediaId,
        namespace: "iqiyi",
        native_id: "a_2",
        variant_id: variant.id,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await ctx.testDb.writeDb
      .insertInto("segments")
      .values({
        association_id: other.id,
        season: 2,
        episode_start: 1,
        episode_end: null,
        target_episode_start: 1,
        baseline: "tmdb",
      })
      .execute();
    await ctx.testDb.writeDb
      .insertInto("demands")
      .values(
        [1, 2, null].map((season) => ({
          media_id: mediaId,
          season,
          namespace_group: "platform" as const,
          status: "fulfilled",
          not_found_count: 0,
          next_eligible_at: T0,
          last_demanded_at: T0,
        })),
      )
      .execute();

    await comment(ctx, id, "撤下：第 7 集起错开一位");
    await ctx.drain();

    expect((await association(ctx, associationId)).status).toBe("delisted");
    expect(
      await ctx.testDb.readDb
        .selectFrom("demands")
        .select(["season", "status"])
        .orderBy("season")
        .execute(),
    ).toEqual([
      { season: 1, status: "open" },
      { season: 2, status: "fulfilled" },
      { season: null, status: "fulfilled" },
    ]);
  });

  test("revoke_with_correction still needs the revoked seasons fetched: a session that only checked the corrected season keeps the mapping", async () => {
    // Fetches the collection and season 8, never season 6, and takes season 6 down.
    const correctsUnchecked: ScriptedModel = (request) => {
      const turn = turnOf(request);
      if (turn === 0) {
        return reply(turn, [
          ["get_collection", { namespace: "bilibili", id: "ss77777" }],
          ["get_catalog_season", { season: 8 }],
        ]);
      }
      return reply(turn, [
        ["revoke_with_correction", { opinion: WIFE_OPINION, ...correctionFor(8) }],
      ]);
    };
    const ctx = track(await setup(byComments(approvesSeason6, correctsUnchecked)));
    const id = await ctx.submit("ss77777", {
      targetExternalKey: WIFE_KEY,
      segments: wifeSegments(6, 10),
    });
    await ctx.drain();
    const approved = await ctx.changeRequest(id);
    expect(approved.status).toBe("approved");

    const commentId = await comment(ctx, id, "这是 2026 年那季，第 8 季");
    await ctx.drain();

    const cr = await ctx.changeRequest(id);
    expect(cr.status).toBe("approved");
    expect((cr.evidence as Record<string, any>).reviewAgent).toMatchObject({
      verdict: "keep",
      concluded: "revoke_with_correction",
      fallback: "season_not_fetched: 6",
    });
    expect((await association(ctx, approved.applied_association_id!)).status).toBe("confirmed");
    expect(await ctx.testDb.readDb.selectFrom("leads").select("id").execute()).toEqual([]);
    expect(await replyTo(ctx, id, commentId)).toEqual([
      expect.objectContaining({ content: expect.stringContaining("season_not_fetched: 6") }),
    ]);
  });

  test("a locked association cannot be revoked: the request stays approved", async () => {
    const { ctx, id, associationId } = await approvedLinglong(revokesLinglong);
    await ctx.testDb.writeDb
      .updateTable("associations")
      .set({ locked: true })
      .where("id", "=", associationId)
      .execute();

    const commentId = await comment(ctx, id, "撤下：第 7 集起错开一位");
    await ctx.drain();

    const cr = await ctx.changeRequest(id);
    expect(cr.status).toBe("approved");
    expect((cr.evidence as Record<string, any>).reviewAgent).toMatchObject({
      verdict: "keep",
      concluded: "revoke",
      fallback: "revoke_failed: ASSOCIATION_LOCKED",
    });
    expect((await association(ctx, associationId)).status).toBe("confirmed");
    expect(await replyTo(ctx, id, commentId)).toEqual([
      expect.objectContaining({ content: expect.stringContaining("ASSOCIATION_LOCKED") }),
    ]);
  });

  test.each([true, false])(
    "revoke_with_correction: 妻子的浪漫旅行 approved as season 6 is taken down, and season 8 handed to exploration without backoff (authority ID: %s)",
    async (withId) => {
      // The first review approves season 6; the comment session corrects it to season 8.
      const correctsApproved: ScriptedModel = (request) => {
        const turn = turnOf(request);
        if (turn === 0) {
          return reply(turn, [
            ["get_collection", { namespace: "bilibili", id: "ss77777" }],
            ["get_catalog_season", { season: 6 }],
            ["get_catalog_season", { season: 8 }],
          ]);
        }
        return reply(turn, [
          ["revoke_with_correction", { opinion: WIFE_OPINION, ...correctionFor(8) }],
        ]);
      };
      const ctx = track(await setup(byComments(approvesSeason6, correctsApproved)));
      const media = await createWifeMedia(ctx);
      const id = await ctx.submit("ss77777", {
        targetExternalKey: media.id,
        segments: wifeSegments(6, 10),
      });
      await ctx.drain();
      const approved = await ctx.changeRequest(id);
      expect(approved.status).toBe("approved");

      if (!withId) {
        await ctx.testDb.writeDb
          .deleteFrom("associations")
          .where("media_id", "=", media.id)
          .where("is_external_id", "=", true)
          .execute();
      }
      const commentId = await comment(ctx, id, "这是 2026 年那季，第 8 季");
      await ctx.drain();

      const cr = await ctx.changeRequest(id);
      expect(cr).toMatchObject({
        status: "rejected",
        target_external_key: `media:${media.id}`,
        decision_reason: expect.stringContaining("改正：第 8 季"),
      });
      expect((cr.evidence as Record<string, any>).reviewAgent).toMatchObject({
        verdict: "revoke_with_correction",
        correction: correctionFor(8),
        fallback: null,
      });
      expect(
        await ctx.testDb.readDb
          .selectFrom("review_corrections")
          .select(["change_request_id", "media_id"])
          .execute(),
      ).toEqual([{ change_request_id: id, media_id: media.id }]);
      expect((await association(ctx, approved.applied_association_id!)).status).toBe("delisted");
      expect(
        await ctx.testDb.readDb
          .selectFrom("leads")
          .select(["target_external_key", "season", "reporter_user_id"])
          .execute(),
      ).toEqual(
        withId
          ? [{ target_external_key: WIFE_KEY, season: 8, reporter_user_id: REVIEW_AGENT_USER_ID }]
          : [],
      );
      expect(
        await ctx.testDb.readDb
          .selectFrom("demands")
          .select(["media_id", "season", "status", "not_found_count", "next_eligible_at"])
          .execute(),
      ).toEqual([
        {
          media_id: approved.media_id,
          season: 8,
          status: "open",
          not_found_count: 0,
          next_eligible_at: T0,
        },
      ]);
      expect(await replyTo(ctx, id, commentId)).toEqual([
        expect.objectContaining({ content: expect.stringMatching(/撤下并改正[\s\S]*第 8 季/) }),
      ]);
    },
  );

  test(`comments drive at most ${3} sessions per change request a day; the next comment waits for the next UTC day`, async () => {
    const { ctx, id } = await approvedLinglong(keeps);
    for (let i = 1; i <= 3; i += 1) {
      await comment(ctx, id, `第 ${i} 条：请再核实`);
      await ctx.drain();
    }
    const sessionsBefore = ctx.outbound.modelRequests.length;

    const fourth = await comment(ctx, id, "第 4 条：请再核实");
    await ctx.drain();

    expect(ctx.outbound.modelRequests).toHaveLength(sessionsBefore);
    expect(await replyTo(ctx, id, fourth)).toEqual([]);
    const answered = (await agentReplies(ctx, id)).filter((r) => r.reply_to_ids.length > 0);
    expect(answered).toHaveLength(3);
    const job = await ctx.testDb.readDb
      .selectFrom("background_jobs")
      .select(["status", "run_after"])
      .where("job_type", "=", "review_agent")
      .where("status", "=", "pending")
      .executeTakeFirstOrThrow();
    expect(job.run_after).toEqual(new Date("2026-11-27T00:00:00.000Z"));
    // Each comment session took one of the day's review slots, as did the first review.
    const budget = await ctx.testDb.readDb
      .selectFrom("exploration_daily_budget")
      .select("review_consumed")
      .executeTakeFirstOrThrow();
    expect(budget.review_consumed).toBe(4);
  });

  test("the cron queues a review for a decided request with unanswered comments and no active job, but not for one still collecting evidence", async () => {
    const { ctx, id } = await approvedLinglong(keeps);
    const pendingId = await ctx.submit("ss28889", {
      variantDescription: "国语配音",
      setDefaultVariant: false,
    });
    // Comments without a job of their own (e.g. written while a session ran).
    const write = (changeRequestId: string) =>
      ctx.testDb.writeDb
        .insertInto("change_request_comments")
        .values({
          change_request_id: changeRequestId,
          author_user_id: EXPLORATION_AGENT_USER_ID,
          content: "请再核实",
          created_at: BEFORE_T0,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
    const unanswered = await write(id);
    await write(pendingId);
    await ctx.testDb.writeDb
      .updateTable("background_jobs")
      .set({ status: "completed" })
      .where("job_type", "=", "review_agent")
      .execute();

    expect(await enqueuePendingReviews(ctx.testDb.writeDb, { now: T0 })).toBe(1);
    expect(await enqueuePendingReviews(ctx.testDb.writeDb, { now: T0 })).toBe(0);
    await ctx.tick();

    expect(await replyTo(ctx, id, unanswered.id)).toEqual([
      expect.objectContaining({ content: expect.stringContaining("维持通过") }),
    ]);
  });

  test.each(["complete", "partial", "shared"])(
    "rechecks the live finale and shared collection before handing over a %s season correction",
    async (scenario) => {
      const correctsToNonLinear: ScriptedModel = (request) => {
        const turn = turnOf(request);
        if (turn === 0) {
          return reply(turn, [
            ["get_collection", { namespace: "bilibili", id: "ss77777" }],
            ["get_catalog_season", { season: 8 }],
          ]);
        }
        return reply(turn, [
          [
            "revoke_with_correction",
            {
              opinion: "这是整季综艺合集，与 TMDB 分集口径不同，应按整季不拆集关联",
              season: 8,
              segments: [
                {
                  season: 8,
                  episodeStart: 1,
                  episodeEnd: scenario === "shared" ? 20 : null,
                  targetEpisodeStart: 1,
                  nonLinear: true,
                },
              ],
              reasons: [],
              reply: "核实后已撤下原分段映射，改为整季不按集对应并重开探索。",
            },
          ],
        ]);
      };
      const ctx = track(await setup(byComments(approvesSeason6, correctsToNonLinear)));
      const media = await createWifeMedia(ctx);
      let updatedBroadcastLabels = false;
      const fetch = ctx.outbound.fetchExternal.bind(ctx.outbound);
      ctx.outbound.fetchExternal = async (request) => {
        const response = await fetch(request);
        if (request.namespace !== "tmdb" || !request.url.includes("/tv/70001")) return response;
        const body = JSON.parse(response.body);
        if (request.url.includes("/season/8")) {
          body.episodes = Array.from({ length: 20 }, (_, i) => ({
            episode_number: i + 1,
            name: updatedBroadcastLabels
              ? `第${Math.ceil((i + 1) / 2)}期${i % 2 ? "下" : "上"}`
              : `第${i + 1}期`,
            air_date: "2026-03-01",
          }));
        } else if (body.seasons) {
          body.seasons.find((s: { season_number: number }) => s.season_number === 8).episode_count =
            20;
        }
        return jsonResponse(request.url, body);
      };
      // The original catalog numbered 20 installments; the platform listed the first ten.
      const id = await ctx.submit("ss77777", {
        targetExternalKey: media.id,
        segments: wifeSegments(8, 10),
      });
      await ctx.drain();
      const approved = await ctx.changeRequest(id);
      expect(approved.status).toBe("approved");

      updatedBroadcastLabels = scenario !== "partial";
      if (scenario === "shared") {
        const other = await ctx.testDb.writeDb
          .insertInto("media")
          .values({ type: "tv", baseline: "tmdb", title: "另一部", seasons: "[]" })
          .returning("id")
          .executeTakeFirstOrThrow();
        const variant = await ctx.testDb.writeDb
          .insertInto("variants")
          .values({
            media_id: other.id,
            platform: "bilibili",
            description: "原声",
            is_default: true,
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        const assoc = await ctx.testDb.writeDb
          .insertInto("associations")
          .values({
            media_id: other.id,
            namespace: "bilibili",
            variant_id: variant.id,
            native_id: "ss77777",
            status: "confirmed",
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        await ctx.testDb.writeDb
          .insertInto("segments")
          .values({
            association_id: assoc.id,
            season: 1,
            episode_start: 1,
            episode_end: 5,
            target_episode_start: 11,
            baseline: "tmdb",
          })
          .execute();
      }
      const commentId = await comment(ctx, id, "明明整季都在这，不用拆集看");
      await ctx.drain();

      const cr = await ctx.changeRequest(id);
      expect(cr.status).toBe("rejected");
      if (scenario !== "complete") {
        expect(cr.evidence).toMatchObject({
          reviewAgent: {
            verdict: "revoke",
            fallback: expect.stringContaining(
              scenario === "partial"
                ? "season_finale_unverified"
                : "SHARED_COLLECTION_NON_LINEAR_SEGMENT",
            ),
          },
        });
        expect(await ctx.testDb.readDb.selectFrom("leads").select("id").execute()).toEqual([]);
        return;
      }
      expect(cr.decision_reason).toContain("整季（不按集对应）");
      expect((cr.evidence as Record<string, any>).reviewAgent).toMatchObject({
        verdict: "revoke_with_correction",
        fallback: null,
        correction: {
          season: 8,
          segments: [
            {
              season: 8,
              episodeStart: 1,
              episodeEnd: null,
              targetEpisodeStart: 1,
              nonLinear: true,
            },
          ],
        },
      });
      expect(
        await ctx.testDb.readDb.selectFrom("leads").select(["season", "segments"]).execute(),
      ).toEqual([
        {
          season: 8,
          segments: [
            {
              season: 8,
              episodeStart: 1,
              episodeEnd: null,
              targetEpisodeStart: 1,
              nonLinear: true,
            },
          ],
        },
      ]);
      expect(await replyTo(ctx, id, commentId)).toEqual([
        expect.objectContaining({ content: expect.stringContaining("整季（不按集对应）") }),
      ]);
    },
  );
});
