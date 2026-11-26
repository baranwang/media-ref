import type { Message, MessageBatch, ScheduledController } from "@cloudflare/workers-types";
import {
  createFakeOutboundClient,
  deriveExplorationTaskId,
  EVIDENCE_CHECK_JOB_TYPE,
  EXPLORATION_AGENT_USER_ID,
  EXPLORATION_JOB_TYPE,
  getExplorationTargetNamespaces,
  createDefaultAdapterRegistry,
  listDemands,
  scheduleExplorationJobs,
  type ExternalHttpRequest,
  type ExternalHttpResponse,
  type JobQueueMessage,
  type ModelInvocationRequest,
  type ModelInvocationResponse,
} from "@media-ref/core";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { createBackgroundWorker } from "../src/index.ts";
import { DOUBAN_API } from "@media-ref/core";

// A test key, and no pacing delays against the fake Douban.
DOUBAN_API.apiKey = "test-douban-key";
DOUBAN_API.minIntervalMs = 0;
DOUBAN_API.retryDelayMs = 0;

// Exploration agent (ADR 0002): discovery → fast path / model judge → gate.

const T0 = new Date("2026-11-24T01:00:00.000Z");

function jsonResponse(url: string, payload: unknown, status = 200): ExternalHttpResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
    url,
  };
}

function bilibiliEpisodes(count: number, idBase: number) {
  const episodes: Array<Record<string, unknown>> = [];
  for (let i = 1; i <= count; i += 1) {
    episodes.push({
      id: idBase + i,
      title: String(i),
      long_title: `第${i}话`,
      badge: "",
      badge_type: 0,
      section_type: 0,
      duration: 1435000,
    });
  }
  return episodes;
}

const BILIBILI_SEASONS: Record<string, Record<string, unknown>> = {
  "34430": {
    season_id: 34430,
    title: "咒术回战",
    season_title: "第一季",
    jp_title: "呪術廻戦",
    type: 1,
    total: 24,
    publish: { pub_time: "2020-10-03 01:25:00" },
    episodes: bilibiliEpisodes(24, 341200),
  },
  // A dubbed copy of season 1: passes the same automatic check, so only the judge can choose.
  "34431": {
    season_id: 34431,
    title: "咒术回战（中配）",
    jp_title: "呪術廻戦",
    type: 1,
    total: 24,
    publish: { pub_time: "2020-10-03 01:25:00" },
    episodes: bilibiliEpisodes(24, 343200),
  },
  "45574": {
    season_id: 45574,
    title: "咒术回战 第二季",
    season_title: "第二季",
    jp_title: "呪術廻戦",
    type: 1,
    total: 23,
    publish: { pub_time: "2023-07-06 23:56:00" },
    episodes: bilibiliEpisodes(23, 750100),
  },
};

interface StubOptions {
  /**
   * 360kan rows as `[titleTxt, year, bilibili id]` (`34430` → `ss34430`, `ep1` → an episode link);
   * null = 360kan answers HTTP 500.
   */
  kan360Rows: Array<[string, string, string]> | null;
  /** iQIYI search answers HTTP 500 (a failing discovery source). */
  failIqiyiSearch?: boolean;
}

function createHttpStub({ kan360Rows, failIqiyiSearch }: StubOptions) {
  return (request: ExternalHttpRequest): ExternalHttpResponse => {
    const url = new URL(request.url);
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
        external_ids: { imdb_id: "tt12343534", tvdb_id: 377543 },
      });
    }
    if (request.namespace === "trakt") {
      return jsonResponse(request.url, []);
    }
    if (url.hostname === "api.so.360kan.com") {
      if (kan360Rows === null) {
        return jsonResponse(request.url, {}, 500);
      }
      return jsonResponse(request.url, {
        code: 0,
        data: {
          longData: {
            rows: kan360Rows.map(([titleTxt, year, ssid]) => ({
              titleTxt,
              year,
              playlinks: {
                bilibili: `https://www.bilibili.com/bangumi/play/${ssid.startsWith("ep") ? ssid : `ss${ssid}`}`,
              },
            })),
          },
        },
      });
    }
    if (url.hostname === "frodo.douban.com" && url.pathname.startsWith("/api/v2/subject/")) {
      return jsonResponse(request.url, { title: "咒术回战", year: "2020", vendors: [] });
    }
    if (url.hostname === "api.douban.com") {
      return jsonResponse(request.url, { msg: "movie_not_found", code: 5000 });
    }
    if (url.hostname === "search.video.iqiyi.com") {
      if (failIqiyiSearch) {
        return jsonResponse(request.url, {}, 500);
      }
      return jsonResponse(request.url, { code: "A00000", data: { code: 0, docinfos: [] } });
    }
    if (request.url.startsWith("https://api.bilibili.com/pgc/view/web/season?ep_id=")) {
      return jsonResponse(request.url, {}, 503);
    }
    if (request.url.startsWith("https://api.bilibili.com/pgc/view/web/season?season_id=")) {
      const season = BILIBILI_SEASONS[url.searchParams.get("season_id") ?? ""];
      return season
        ? jsonResponse(request.url, { code: 0, message: "success", result: season })
        : jsonResponse(request.url, { code: -404, message: "啥都木有" });
    }
    throw new Error(`Unexpected outbound request: ${request.namespace} ${request.url}`);
  };
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

/** Namespaces the agent session still has to conclude, read from the mark_not_found tool. */
function openNamespaces(request: ModelInvocationRequest): string[] {
  const tool = request.tools?.find((t) => t.name === "mark_not_found");
  return (tool?.parameters as { properties: { namespace: { enum: string[] } } }).properties
    .namespace.enum;
}

/** A model that concludes every open namespace as not found in one turn. */
function markAllNotFound(request: ModelInvocationRequest): ModelInvocationResponse {
  return {
    content: null,
    toolCalls: openNamespaces(request).map((namespace, i) => ({
      id: `call_nf_${i}`,
      name: "mark_not_found",
      arguments: { namespace, reason: "no match" },
    })),
    model: "test-model",
    usage: { inputTokens: 1000, outputTokens: 50 },
  };
}

describe("Exploration agent: discover → judge → gate", () => {
  const handles: TestDbHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      await handles.pop()?.cleanup();
    }
  });

  /** JJK media with TMDB + IMDb IDs and an open season-1 platform demand. */
  async function setup(
    stub: StubOptions,
    invokeModel: (request: ModelInvocationRequest) => ModelInvocationResponse = markAllNotFound,
    explorationAgent: Record<string, unknown> = {},
  ) {
    const testDb = await createTestDb();
    handles.push(testDb);
    const media = await testDb.writeDb
      .insertInto("media")
      .values({
        type: "tv",
        baseline: "tmdb",
        title: "咒术回战",
        original_title: "呪術廻戦",
        year: 2020,
        seasons: JSON.stringify([
          { season: 1, episodeCount: 24, airYear: 2020 },
          { season: 2, episodeCount: 23, airYear: 2023 },
        ]),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await testDb.writeDb
      .insertInto("associations")
      .values([
        {
          status: "confirmed",
          is_external_id: true,
          media_id: media.id,
          namespace: "tmdb",
          native_id: "tv:95479",
        },
        {
          status: "confirmed",
          is_external_id: true,
          media_id: media.id,
          namespace: "imdb",
          native_id: "tt12343534",
        },
      ])
      .execute();
    await testDb.writeDb
      .insertInto("demands")
      .values({
        media_id: media.id,
        season: 1,
        namespace_group: "platform",
        status: "open",
        next_eligible_at: T0,
        last_demanded_at: T0,
      })
      .execute();

    const outbound = createFakeOutboundClient({
      fetchExternal: createHttpStub(stub),
      invokeModel,
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
      config: { enableDailyTmdbSync: false, exploration: { dailyBudget: 10 }, explorationAgent },
      now: () => T0,
    });

    await worker.scheduled(createScheduledController(T0));
    expect(emitted.map((m) => m.jobType)).toEqual([EXPLORATION_JOB_TYPE]);
    const explorationMessage = emitted[0]!;
    emitted.length = 0;
    const explore = () => worker.queue(createQueueBatch([explorationMessage]));
    return { testDb, mediaId: media.id, outbound, worker, emitted, explore, explorationMessage };
  }

  const platformCount = getExplorationTargetNamespaces(
    createDefaultAdapterRegistry(),
    "platform",
  ).length;

  test("every platform with fetchCollection is a target, not only the searchable ones", () => {
    expect(getExplorationTargetNamespaces(createDefaultAdapterRegistry(), "platform")).toEqual([
      "bilibili",
      "iqiyi",
      "mgtv",
      "tencent",
      "youku",
    ]);
  });

  test("fast path: one discovered candidate that passes the gate is submitted without the model, then approved", async () => {
    const { testDb, mediaId, outbound, worker, emitted, explore, explorationMessage } = await setup(
      {
        kan360Rows: [["咒术回战", "2020", "34430"]],
      },
    );

    expect((await explore()).completed).toBe(1);
    // bilibili is settled without the model; one session turn concludes the other platforms.
    expect(outbound.modelRequests).toHaveLength(1);
    expect(openNamespaces(outbound.modelRequests[0]!)).toEqual([
      "iqiyi",
      "mgtv",
      "tencent",
      "youku",
    ]);

    const taskId = await deriveExplorationTaskId(
      explorationMessage.jobId,
      "bilibili",
      platformCount,
    );
    const crs = await testDb.readDb.selectFrom("change_requests").selectAll().execute();
    expect(crs).toHaveLength(1);
    expect(crs[0]).toMatchObject({
      task_id: taskId,
      native_id: "ss34430",
      submitter_type: "agent",
      submitter_user_id: EXPLORATION_AGENT_USER_ID,
      variant_description: "原声",
      status: "pending_evidence",
    });

    // The agent found nothing on the other platforms while every source answered: absence.
    const checks = await testDb.readDb
      .selectFrom("platform_checks")
      .select(["platform", "status"])
      .orderBy("platform")
      .execute();
    expect(checks).toEqual([
      { platform: "iqiyi", status: "not_found" },
      { platform: "mgtv", status: "not_found" },
      { platform: "tencent", status: "not_found" },
      { platform: "youku", status: "not_found" },
    ]);
    expect((await listDemands(testDb.readDb, { mediaId }))[0]?.status).toBe("awaiting_review");

    // The real Evidence Gate accepts what the fast path predicted, and the demand is fulfilled.
    await worker.scheduled(createScheduledController(T0));
    expect(emitted.map((m) => m.jobType)).toEqual([EVIDENCE_CHECK_JOB_TYPE]);
    expect((await worker.queue(createQueueBatch(emitted))).completed).toBe(1);
    const approved = await testDb.readDb
      .selectFrom("change_requests")
      .select("status")
      .executeTakeFirstOrThrow();
    expect(approved.status).toBe("approved");
    expect((await listDemands(testDb.readDb, { mediaId }))[0]?.status).toBe("fulfilled");
  });

  test("redelivered job does not submit twice", async () => {
    const { testDb, explore } = await setup({ kan360Rows: [["咒术回战", "2020", "34430"]] });
    await explore();
    await explore();
    expect(await testDb.readDb.selectFrom("change_requests").select("id").execute()).toHaveLength(
      1,
    );
  });

  test("judge: the model may only submit fetched candidates, with segments inside the fetched episodes", async () => {
    const replies: unknown[] = [];
    const invokeModel = (request: ModelInvocationRequest): ModelInvocationResponse => {
      const toolMessages = request.messages.filter((m) => m.role === "tool");
      replies.splice(0, replies.length, ...toolMessages.map((m) => JSON.parse(m.content)));
      const submit = (args: Record<string, unknown>) => ({
        content: null,
        toolCalls: [
          {
            id: `call_${toolMessages.length}`,
            name: "submit_mapping",
            arguments: { namespace: "bilibili", ...args },
          },
        ],
        model: "test-model",
      });
      if (toolMessages.length === 0) {
        return submit({ canonicalId: "ss99999" });
      }
      if (toolMessages.length === 1) {
        return submit({
          canonicalId: "ss34430",
          segments: [{ season: 1, episodeStart: 1, episodeEnd: 30, targetEpisodeStart: 1 }],
        });
      }
      if (toolMessages.length === 2) {
        return submit({ canonicalId: "ss34430" });
      }
      return markAllNotFound(request);
    };
    const { testDb, outbound, explore } = await setup(
      {
        kan360Rows: [
          ["咒术回战", "2020", "34430"],
          ["咒术回战（中配）", "2020", "34431"],
        ],
      },
      invokeModel,
    );

    await explore();

    // Two fetched candidates → no fast path; the prompt lists exactly those two.
    const prompt = outbound.modelRequests[0]!.messages.find((m) => m.role === "user")!.content;
    expect(prompt).toContain('"canonicalId": "ss34430"');
    expect(prompt).toContain('"canonicalId": "ss34431"');
    expect(outbound.modelRequests).toHaveLength(4);
    // All turns of one job share one session (routing stickiness).
    const sessions = new Set(outbound.modelRequests.map((r) => r.sessionId));
    expect(sessions.size).toBe(1);
    expect([...sessions][0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(replies.slice(0, 3)).toMatchObject([
      { ok: false, error: "UNKNOWN_CANDIDATE" },
      { ok: false, error: "SEGMENTS_OUTSIDE_COLLECTION" },
      { ok: true },
    ]);
    const crs = await testDb.readDb.selectFrom("change_requests").select("native_id").execute();
    expect(crs).toEqual([{ native_id: "ss34430" }]);
  });

  test("a failing discovery source makes candidate-less platforms transient, never not_found", async () => {
    const { testDb, mediaId, outbound, explore } = await setup({ kan360Rows: null });

    await explore();

    // The agent still looks, but its "not found" while a source failed is not evidence.
    expect(outbound.modelRequests).toHaveLength(1);
    expect(await testDb.readDb.selectFrom("platform_checks").select("id").execute()).toEqual([]);
    expect(await testDb.readDb.selectFrom("change_requests").select("id").execute()).toEqual([]);
    const demand = (await listDemands(testDb.readDb, { mediaId }))[0]!;
    expect(demand.status).toBe("open");
    expect(demand.notFoundCount).toBe(0);
  });

  test("all sources answer with nothing: every platform is not_found and the demand backs off", async () => {
    const { testDb, mediaId, explore } = await setup({ kan360Rows: [] });

    await explore();

    const checks = await testDb.readDb.selectFrom("platform_checks").select("platform").execute();
    expect(checks).toHaveLength(platformCount);
    const demand = (await listDemands(testDb.readDb, { mediaId }))[0]!;
    expect(demand.status).toBe("not_found");
    expect(demand.notFoundCount).toBe(1);
  });

  test("a platform link that fails to resolve for now keeps that platform transient", async () => {
    const { testDb, explore } = await setup({ kan360Rows: [["咒术回战", "2020", "ep1"]] });

    await explore();

    const checks = await testDb.readDb.selectFrom("platform_checks").select("platform").execute();
    expect(checks.map((c) => c.platform)).not.toContain("bilibili");
    expect(checks).toHaveLength(platformCount - 1);
  });

  test("fast path also needs the default mapping to fit the fetched episodes", async () => {
    // Season 2's 23-episode collection passes Step 1 (title, year and count of *a* season match),
    // but mapping season 1's 24 episodes onto it does not fit, so the model decides instead.
    const { testDb, outbound, explore } = await setup(
      { kan360Rows: [["咒术回战 第二季", "2023", "45574"]] },
      markAllNotFound,
    );

    await explore();

    expect(outbound.modelRequests).toHaveLength(1);
    expect(await testDb.readDb.selectFrom("change_requests").select("id").execute()).toEqual([]);
  });

  test("a negative judgement while a discovery source failed stays transient", async () => {
    const { testDb, outbound, explore } = await setup(
      { kan360Rows: [["咒术回战 第二季", "2023", "45574"]], failIqiyiSearch: true },
      markAllNotFound,
    );

    await explore();

    expect(outbound.modelRequests).toHaveLength(1);
    const checks = await testDb.readDb.selectFrom("platform_checks").select("platform").execute();
    expect(checks.map((c) => c.platform)).not.toContain("bilibili");
  });

  test("fast path: of several fetched candidates, the only one passing the gate is submitted without the model", async () => {
    const { testDb, outbound, explore } = await setup({
      kan360Rows: [
        ["咒术回战", "2020", "34430"],
        ["咒术回战 第二季", "2023", "45574"],
      ],
    });

    await explore();

    expect(outbound.modelRequests).toHaveLength(1);
    expect(openNamespaces(outbound.modelRequests[0]!)).not.toContain("bilibili");
    const crs = await testDb.readDb.selectFrom("change_requests").select("native_id").execute();
    expect(crs).toEqual([{ native_id: "ss34430" }]);
  });

  test("open tools: the agent fetches a collection nobody discovered and submits it", async () => {
    const invokeModel = (request: ModelInvocationRequest): ModelInvocationResponse => {
      const turn = request.messages.filter((m) => m.role === "assistant").length;
      const call = (name: string, args: Record<string, unknown>) => ({
        content: null,
        toolCalls: [{ id: `call_${turn}`, name, arguments: args }],
        model: "test-model",
      });
      if (turn === 0) {
        return call("get_collection", {
          namespace: "bilibili",
          id: "https://www.bilibili.com/bangumi/play/ss34430",
        });
      }
      if (turn === 1) {
        return call("submit_mapping", { namespace: "bilibili", canonicalId: "ss34430" });
      }
      return markAllNotFound(request);
    };
    const { testDb, outbound, explore } = await setup({ kan360Rows: [] }, invokeModel);

    await explore();

    const fetched = JSON.parse(
      outbound.modelRequests[1]!.messages.find((m) => m.role === "tool")!.content,
    ) as Record<string, unknown>;
    expect(fetched).toMatchObject({
      canonicalId: "ss34430",
      featureEpisodeCount: 24,
      passesAutomaticCheckWithDefaultMapping: true,
    });
    const crs = await testDb.readDb.selectFrom("change_requests").select("native_id").execute();
    expect(crs).toEqual([{ native_id: "ss34430" }]);
    // Session tokens land in today's budget row.
    const budget = await testDb.readDb
      .selectFrom("exploration_daily_budget")
      .select("tokens_used")
      .executeTakeFirstOrThrow();
    expect(Number(budget.tokens_used)).toBe(1050);
    // Per-model totals for tokens.ci (no token configured, so nothing is submitted).
    const piUsage = await testDb.readDb.selectFrom("pi_token_usage").selectAll().execute();
    expect(piUsage).toMatchObject([
      { model: "test-model", input: "1000", output: "50", messages: "1" },
    ]);
  });

  test("with a tokens.ci token, session usage is submitted as pi on device MediaRef", async () => {
    const { testDb, outbound, explore } = await setup({ kan360Rows: [] }, markAllNotFound, {
      tokensApiToken: "tok",
    });
    const submitted: unknown[] = [];
    const original = outbound.fetchExternal.bind(outbound);
    outbound.fetchExternal = async (request) => {
      if (request.url === "https://tokens.ci/api/submit") {
        expect(request.headers?.authorization).toBe("Bearer tok");
        submitted.push(JSON.parse(request.body!));
        return jsonResponse(request.url, { ok: true });
      }
      return original(request);
    };

    await explore();

    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      device: { name: "MediaRef" },
      summary: { totalTokens: 1050, clients: ["pi"], models: ["test-model"] },
      contributions: [{ date: "2026-11-24", clients: [{ client: "pi", modelId: "test-model" }] }],
    });
    expect(await testDb.readDb.selectFrom("pi_token_usage").select("day").execute()).toEqual([
      { day: "2026-11-24" },
    ]);
  });

  test("a session over its token budget stops and backs off instead of looping", async () => {
    const search = (): ModelInvocationResponse => ({
      content: null,
      toolCalls: [{ id: "call_s", name: "get_catalog_season", arguments: { season: 1 } }],
      model: "test-model",
      usage: { inputTokens: 900, outputTokens: 100 },
    });
    const { testDb, mediaId, outbound, explore } = await setup({ kan360Rows: [] }, search, {
      maxTaskTokens: 2500,
    });

    await explore();

    expect(outbound.modelRequests).toHaveLength(3);
    const demand = (await listDemands(testDb.readDb, { mediaId }))[0]!;
    expect(demand.status).toBe("not_found");
  });

  test("discovery reads the known Douban subject of the requested season, not another season's", async () => {
    const { testDb, mediaId, outbound, explore } = await setup({ kan360Rows: [] });
    for (const [subject, season] of [
      ["35000002", 2],
      ["35000001", 1],
    ] as const) {
      const assoc = await testDb.writeDb
        .insertInto("associations")
        .values({
          media_id: mediaId,
          namespace: "douban",
          native_id: subject,
          status: "seed_unconfirmed",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await testDb.writeDb
        .insertInto("segments")
        .values({
          association_id: assoc.id,
          season: 1,
          episode_start: 1,
          episode_end: null,
          target_episode_start: 1,
          baseline: "tmdb",
        })
        .execute();
      if (season === 2) {
        await testDb.writeDb
          .updateTable("segments")
          .set({ season: 2 })
          .where("association_id", "=", assoc.id)
          .execute();
      }
    }

    await explore();

    const subjects = outbound.httpRequests
      .map((r) => new URL(r.url))
      .filter((u) => u.hostname === "frodo.douban.com" && u.pathname.startsWith("/api/v2/subject/"))
      .map((u) => u.pathname.split("/").pop());
    expect(subjects).toEqual(["35000001"]);
  });

  test("scheduling stops for the day once the agent's token budget is spent", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);
    const media = await testDb.writeDb
      .insertInto("media")
      .values({ type: "movie", baseline: "tmdb", title: "x", year: 2020, seasons: "[]" })
      .returning("id")
      .executeTakeFirstOrThrow();
    await testDb.writeDb
      .insertInto("demands")
      .values({
        media_id: media.id,
        season: null,
        namespace_group: "platform",
        status: "open",
        next_eligible_at: T0,
        last_demanded_at: T0,
      })
      .execute();
    await testDb.writeDb
      .insertInto("exploration_daily_budget")
      .values({ budget_date: "2026-11-24", consumed: 0, tokens_used: "1000", updated_at: T0 })
      .execute();
    const config = { dailyBudget: 10, dailyTokenBudget: 1000 };

    const spent = await scheduleExplorationJobs(testDb.writeDb, { now: T0, config });
    expect(spent.scheduledCount).toBe(0);

    const room = await scheduleExplorationJobs(testDb.writeDb, {
      now: T0,
      config: { ...config, dailyTokenBudget: 1001 },
    });
    expect(room.scheduledCount).toBe(1);
  });
});
