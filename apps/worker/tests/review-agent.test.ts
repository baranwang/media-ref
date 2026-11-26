import type { Message, MessageBatch, ScheduledController } from "@cloudflare/workers-types";
import type { SegmentInput } from "@media-ref/client";
import {
  bilibiliAdapter,
  createAdapterRegistry,
  createChangeRequest,
  createDefaultAdapterRegistry,
  createFakeOutboundClient,
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

function httpStub(request: ExternalHttpRequest): ExternalHttpResponse {
  const url = request.url;
  if (request.namespace === "tmdb") {
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
    },
    now: () => T0,
  });

  const submit = async (nativeId = "ss28888") => {
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
      expect.arrayContaining(["get_collection", "get_catalog_season", "approve", "keep_for_human"]),
    );
    expect(toolNames).not.toContain("search_platform");
    expect(toolNames).not.toContain("reject_with_correction");

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
      name: "a model call that fails",
      model: (() => {
        throw new Error("upstream 503");
      }) as ScriptedModel,
      fallback: "model_error: upstream 503",
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
  ])("$name keeps the change request for a human reviewer", async ({ model, config, fallback }) => {
    const { submit, drain, changeRequest } = track(await setup(model, config));
    const id = await submit();

    await drain();

    const cr = await changeRequest(id);
    expect(cr.status).toBe("needs_review");
    expect(cr.reviewer_user_id).toBeNull();
    const evidence = cr.evidence as Record<string, any>;
    expect(evidence.reviewAgent).toMatchObject({ verdict: "keep_for_human", fallback });
    // The gate's evidence stays next to the opinion.
    expect(evidence.gate.decision).toBe("needs_review");
  });

  test("keep_for_human stores the model's opinion for the reviewer", async () => {
    const model: ScriptedModel = (request) =>
      reply(turnOf(request), [["keep_for_human", { opinion: "季号看起来不对" }]]);
    const { submit, drain, changeRequest } = track(await setup(model));
    const id = await submit();

    await drain();

    const cr = await changeRequest(id);
    expect(cr.status).toBe("needs_review");
    expect((cr.evidence as Record<string, any>).reviewAgent).toMatchObject({
      verdict: "keep_for_human",
      opinion: "季号看起来不对",
      fallback: null,
    });
  });

  test.each([
    { name: "shared_id_conflict", registry: conflictingIdRegistry, nativeId: "ss28888" },
    { name: "collection_not_found", registry: undefined, nativeId: "ss404404" },
  ])("$name: approval is impossible, so no review is queued", async ({ registry, nativeId }) => {
    const { submit, drain, changeRequest, outbound } = track(
      await setup(approvesLikeLinglong, {}, registry),
    );
    const id = await submit(nativeId);

    const ran = await drain();

    expect(ran.map((m) => m.jobType)).toEqual(["evidence_check"]);
    expect(outbound.modelRequests).toHaveLength(0);
    const cr = await changeRequest(id);
    expect(cr.status).toBe("needs_review");
    expect((cr.evidence as Record<string, any>).reviewAgent).toBeUndefined();
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

  test("with a daily review budget of 0, the review job runs no session", async () => {
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
