import type { Message, MessageBatch, ScheduledController } from "@cloudflare/workers-types";
import type { SegmentInput } from "@media-ref/client";
import {
  bilibiliAdapter,
  createAdapterRegistry,
  createChangeRequest,
  createChangeRequestComment,
  createDefaultAdapterRegistry,
  createFakeOutboundClient,
  enqueuePendingReviews,
  ensureExplorationAgentUser,
  EXPLORATION_AGENT_USER_ID,
  type AdapterRegistry,
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
const LINGLONG_SEGMENTS: SegmentInput[] = [
  { season: 1, episodeStart: 1, episodeEnd: 6, targetEpisodeStart: 1, baseline: "tmdb" },
  { season: 1, episodeStart: 7, episodeEnd: 12, targetEpisodeStart: 8, baseline: "tmdb" },
];

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
  calls: Array<[string, Record<string, unknown>]>,
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
) {
  const testDb = await createTestDb();
  const outbound = createFakeOutboundClient({ fetchExternal: httpStub, invokeModel });
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

  const approveAfter =
    (queries: Array<[string, Record<string, unknown>]>, dropReason = false): ScriptedModel =>
    (request) => {
      const turn = turnOf(request);
      if (turn === 0) {
        return reply(turn, queries);
      }
      return reply(turn, [["approve", { reasons: reasonsFor(request).slice(dropReason ? 1 : 0) }]]);
    };

  test.each([
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
      maxDurationMs: 120_000,
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
const wifeSegments = (season: number): SegmentInput[] => [
  {
    season,
    episodeStart: 1,
    episodeEnd: wifeEpisodeCount(season),
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

/** Fetches the collection and the corrected season, then rejects with that correction. */
const correctsTo =
  (season: number): ScriptedModel =>
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
        ["reject_with_correction", { opinion: WIFE_OPINION, ...correctionFor(season) }],
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

  async function submitAsHuman(ctx: Awaited<ReturnType<typeof setup>>, season = 6) {
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
      segments: wifeSegments(season),
    });
  }

  const leads = (ctx: Awaited<ReturnType<typeof setup>>) =>
    ctx.testDb.readDb.selectFrom("leads").selectAll().execute();
  const demands = (ctx: Awaited<ReturnType<typeof setup>>) =>
    ctx.testDb.readDb.selectFrom("demands").selectAll().orderBy("season").execute();

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

  test("the same media and platform ID is corrected only once: the second review cannot reject", async () => {
    const ctx = track(await setup(correctsTo(8)));
    await submitAsHuman(ctx);
    await ctx.drain();
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
    (segments: unknown[]): ScriptedModel =>
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
        { season: 1, episodeStart: 7, episodeEnd: 12, targetEpisodeStart: 6 },
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
    // The season 1 demand the approval fulfilled.
    await ctx.testDb.writeDb
      .insertInto("demands")
      .values({
        media_id: mediaId,
        season: 1,
        namespace_group: "platform",
        status: "fulfilled",
        not_found_count: 0,
        next_eligible_at: T0,
        last_demanded_at: T0,
      })
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
    // Wanted again after a not-found round, like a rejection.
    expect(
      await ctx.testDb.readDb
        .selectFrom("demands")
        .select(["status", "not_found_count", "next_eligible_at"])
        .execute(),
    ).toEqual([
      { status: "open", not_found_count: 1, next_eligible_at: new Date(T0.getTime() + 86_400_000) },
    ]);
    expect(await replyTo(ctx, id, commentId)).toEqual([
      expect.objectContaining({ content: expect.stringMatching(/撤下[\s\S]*已撤下/) }),
    ]);
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

  test("revoke_with_correction: 妻子的浪漫旅行 approved as season 6 is taken down, and season 8 handed to exploration without backoff", async () => {
    // The first review approves season 6; the comment session corrects it to season 8.
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
    const id = await ctx.submit("ss77777", {
      targetExternalKey: WIFE_KEY,
      segments: wifeSegments(6),
    });
    await ctx.drain();
    const approved = await ctx.changeRequest(id);
    expect(approved.status).toBe("approved");

    const commentId = await comment(ctx, id, "这是 2026 年那季，第 8 季");
    await ctx.drain();

    const cr = await ctx.changeRequest(id);
    expect(cr.status).toBe("rejected");
    expect((cr.evidence as Record<string, any>).reviewAgent).toMatchObject({
      verdict: "revoke_with_correction",
      correction: correctionFor(8),
      fallback: null,
    });
    expect((await association(ctx, approved.applied_association_id!)).status).toBe("delisted");
    expect(
      await ctx.testDb.readDb.selectFrom("leads").select(["season", "reporter_user_id"]).execute(),
    ).toEqual([{ season: 8, reporter_user_id: REVIEW_AGENT_USER_ID }]);
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
  });

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
});
