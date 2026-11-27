import type { Message, MessageBatch, ScheduledController } from "@cloudflare/workers-types";
import {
  createFakeOutboundClient,
  deriveExplorationTaskId,
  EVIDENCE_CHECK_JOB_TYPE,
  EXPLORATION_AGENT_USER_ID,
  EXPLORATION_JOB_TYPE,
  getExplorationTargetNamespaces,
  createDefaultAdapterRegistry,
  ensureReviewAgentUser,
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
  // A long collection: get_collection lists it in windows of 80.
  "34500": {
    season_id: 34500,
    title: "咒术回战 合集",
    jp_title: "呪術廻戦",
    type: 1,
    total: 100,
    publish: { pub_time: "2020-10-03 01:25:00" },
    episodes: bilibiliEpisodes(100, 345000),
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
    const tmdbSeason = url.pathname.match(/\/tv\/95479\/season\/(\d+)$/);
    if (request.namespace === "tmdb" && tmdbSeason?.[1] === "3") {
      // A long season: 100 episodes.
      return jsonResponse(request.url, {
        season_number: 3,
        episodes: Array.from({ length: 100 }, (_, i) => ({
          episode_number: i + 1,
          name: `第${i + 1}集`,
          air_date: "2024-01-01",
        })),
      });
    }
    if (request.namespace === "tmdb" && tmdbSeason) {
      // Season 2's episode list is down: the tool falls back to count and year.
      return tmdbSeason[1] === "2"
        ? jsonResponse(request.url, {}, 500)
        : jsonResponse(request.url, {
            season_number: Number(tmdbSeason[1]),
            episodes: [
              { episode_number: 1, name: "两面宿傩", air_date: "2020-10-03" },
              { episode_number: 2, name: "为了自己", air_date: null },
            ],
          });
    }
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
    callWebTool?: (name: string, args: Record<string, unknown>) => string,
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
      ...(callWebTool ? { callWebTool } : {}),
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

  test("a transient demand waits an hour, and the next job does not resubmit a platform under review", async () => {
    // bilibili is submitted on the fast path; iQIYI search fails, so the demand is transient.
    const { testDb, mediaId, outbound, worker, emitted, explore } = await setup({
      kan360Rows: [["咒术回战", "2020", "34430"]],
      failIqiyiSearch: true,
    });
    await explore();
    const demand = (await listDemands(testDb.readDb, { mediaId }))[0]!;
    expect(demand.status).toBe("open");
    expect(new Date(demand.nextEligibleAt).getTime() - T0.getTime()).toBe(60 * 60 * 1000);

    // An hour later the demand runs again while the bilibili submission is still unchecked.
    const later = new Date(T0.getTime() + 60 * 60 * 1000);
    const again = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
      config: { enableDailyTmdbSync: false, exploration: { dailyBudget: 10 } },
      now: () => later,
    });
    emitted.length = 0;
    await again.scheduled(createScheduledController(later));
    expect(emitted.map((m) => m.jobType)).toContain(EXPLORATION_JOB_TYPE);
    await again.queue(createQueueBatch(emitted.filter((m) => m.jobType === EXPLORATION_JOB_TYPE)));

    const crs = await testDb.readDb.selectFrom("change_requests").select("namespace").execute();
    expect(crs).toEqual([{ namespace: "bilibili" }]);
    void worker;
  });

  /** Season 1 shortened to 23 episodes, so season 2's collection (ss45574, 2023, 23 eps) fits it. */
  async function setSeasonOneLength(testDb: TestDbHandle, mediaId: string) {
    await testDb.writeDb
      .updateTable("media")
      .set({
        seasons: JSON.stringify([
          { season: 1, episodeCount: 23, airYear: 2020 },
          { season: 2, episodeCount: 23, airYear: 2023 },
        ]),
      })
      .where("id", "=", mediaId)
      .execute();
  }

  test("another season's collection with the same episode count is not fast-pathed as this season", async () => {
    const { testDb, mediaId, outbound, explore } = await setup({
      kan360Rows: [["咒术回战 第二季", "2023", "45574"]],
    });
    await setSeasonOneLength(testDb, mediaId);

    await explore();

    // Step 1 alone matched season 2's year and count; the full gate sees 2023 ≠ season 1's 2020.
    expect(outbound.modelRequests.length).toBeGreaterThan(0);
    expect(await testDb.readDb.selectFrom("change_requests").select("id").execute()).toEqual([]);
  });

  test.each([
    {
      name: "refused when it takes the positions another season holds",
      held: { episode_end: null },
      submitted: undefined,
      error: "ALREADY_MAPPED_TO_OTHER_SEASON",
    },
    {
      name: "accepted on the positions another season leaves free",
      held: { episode_end: 10 },
      submitted: [{ season: 1, episodeStart: 1, episodeEnd: 13, targetEpisodeStart: 11 }],
      error: undefined,
    },
  ])(
    "a collection already holding another season of the media: $name",
    async ({ held, submitted, error }) => {
      const replies: unknown[] = [];
      const invokeModel = (request: ModelInvocationRequest): ModelInvocationResponse => {
        const tools = request.messages.filter((m) => m.role === "tool");
        if (tools.length === 0) {
          return {
            content: null,
            toolCalls: [
              {
                id: "call_s",
                name: "submit_mapping",
                arguments: { namespace: "bilibili", canonicalId: "ss45574", segments: submitted },
              },
            ],
            model: "test-model",
          };
        }
        replies.push(JSON.parse(tools[0]!.content));
        return markAllNotFound(request);
      };
      const { testDb, mediaId, outbound, explore } = await setup(
        { kan360Rows: [["咒术回战 第二季", "2023", "45574"]] },
        invokeModel,
      );
      await setSeasonOneLength(testDb, mediaId);
      const variant = await testDb.writeDb
        .insertInto("variants")
        .values({ media_id: mediaId, platform: "bilibili", description: "原声", is_default: true })
        .returning("id")
        .executeTakeFirstOrThrow();
      const assoc = await testDb.writeDb
        .insertInto("associations")
        .values({
          media_id: mediaId,
          namespace: "bilibili",
          native_id: "ss45574",
          status: "confirmed",
          variant_id: variant.id,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await testDb.writeDb
        .insertInto("segments")
        .values({
          association_id: assoc.id,
          season: 2,
          episode_start: 1,
          ...held,
          target_episode_start: 1,
          baseline: "tmdb",
        })
        .execute();

      await explore();

      const prompt = outbound.modelRequests[0]!.messages.find((m) => m.role === "user")!.content;
      expect(prompt).toContain('"alreadyMappedToSeasons"');
      const requests = await testDb.readDb.selectFrom("change_requests").select("id").execute();
      if (error) {
        expect(replies).toMatchObject([{ ok: false, error }]);
        expect(requests).toEqual([]);
      } else {
        expect(replies).toMatchObject([{ ok: true }]);
        expect(requests).toHaveLength(1);
      }
    },
  );

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
    // Position, both titles, air date and duration, so extras mixed into the list stand out.
    expect((fetched.episodes as unknown[])[0]).toEqual({
      index: 1,
      title: "1",
      longTitle: "第1话",
      airDate: null,
      durationSeconds: 1435,
    });
    const crs = await testDb.readDb.selectFrom("change_requests").select("native_id").execute();
    expect(crs).toEqual([{ native_id: "ss34430" }]);
    // Session tokens land in today's budget row.
    const budget = await testDb.readDb
      .selectFrom("exploration_daily_budget")
      .select(["tokens_used", "pi_usage"])
      .executeTakeFirstOrThrow();
    expect(Number(budget.tokens_used)).toBe(1050);
    // Per-model totals for tokens.ci (no token configured, so nothing is submitted).
    expect(budget.pi_usage).toEqual({
      "test-model": { input: 1000, output: 50, cacheRead: 0, cacheWrite: 0, messages: 1 },
    });
  });

  test("with a tokens.ci token, the day's running total is submitted as pi on device MediaRef", async () => {
    const { testDb, outbound, explore } = await setup({ kan360Rows: [] }, markAllNotFound, {
      tokensApiToken: "tok",
    });
    // An earlier session today: tokens.ci keeps the latest value per day, so it must be included.
    await testDb.writeDb
      .updateTable("exploration_daily_budget")
      .set({
        pi_usage: JSON.stringify({
          "test-model": { input: 400, output: 100, cacheRead: 0, cacheWrite: 0, messages: 2 },
        }),
      })
      .where("budget_date", "=", "2026-11-24")
      .execute();
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
      summary: { totalTokens: 1550, clients: ["pi"], models: ["test-model"] },
      contributions: [
        {
          date: "2026-11-24",
          totals: { tokens: 1550, messages: 3 },
          clients: [{ client: "pi", modelId: "test-model" }],
        },
      ],
    });
  });

  test("get_catalog_season lists each catalog episode, season 0 too; without the list, count and year only", async () => {
    const invokeModel = (request: ModelInvocationRequest): ModelInvocationResponse => {
      if (request.messages.some((m) => m.role === "assistant")) {
        return markAllNotFound(request);
      }
      return {
        content: null,
        toolCalls: [0, 1, 2].map((season) => ({
          id: `call_s${season}`,
          name: "get_catalog_season",
          arguments: { season },
        })),
        model: "test-model",
      };
    };
    const { testDb, mediaId, outbound, explore } = await setup({ kan360Rows: [] }, invokeModel);
    await testDb.writeDb
      .updateTable("media")
      .set({
        seasons: JSON.stringify([
          { season: 0, episodeCount: 2, airYear: 2021 },
          { season: 1, episodeCount: 24, airYear: 2020 },
          { season: 2, episodeCount: 23, airYear: 2023 },
        ]),
      })
      .where("id", "=", mediaId)
      .execute();

    await explore();

    const replies = outbound.modelRequests[1]!.messages.filter((m) => m.role === "tool");
    const [special, first, second] = replies.map((m) => JSON.parse(m.content) as unknown);
    const episodes = [
      { episode: 1, title: "两面宿傩", airDate: "2020-10-03" },
      { episode: 2, title: "为了自己", airDate: null },
    ];
    expect(special).toEqual({ season: 0, episodeCount: 2, airYear: 2021, episodes });
    expect(first).toEqual({ season: 1, episodeCount: 24, airYear: 2020, episodes });
    expect(second).toEqual({ season: 2, episodeCount: 23, airYear: 2023 });
  });

  test("a review agent's lead shows its corrected segments to the model as the candidate's suggested mapping", async () => {
    const { testDb, outbound, explore } = await setup({ kan360Rows: [] });
    // The correction does not fit the collection (it reaches position 25 of 24): no fast path,
    // and the default mapping, which the review rejected, is not submitted instead.
    const suggested = { season: 1, episodeStart: 1, episodeEnd: 24, targetEpisodeStart: 2 };
    const reviewer = await ensureReviewAgentUser(testDb.writeDb);
    await testDb.writeDb
      .insertInto("leads")
      .values({
        target_external_key: "tmdb:tv:95479",
        namespace: "bilibili",
        native_id: "ss34430",
        season: 1,
        segments: JSON.stringify([suggested]),
        reporter_user_id: reviewer,
        reporter_key_id: reviewer,
      })
      .execute();

    await explore();

    const prompt = outbound.modelRequests[0]!.messages.find((m) => m.role === "user")!.content;
    const { namespaces } = JSON.parse(prompt.slice(prompt.indexOf("{"))) as {
      namespaces: Array<{ namespace: string; candidates: unknown[] }>;
    };
    expect(namespaces.find((n) => n.namespace === "bilibili")!.candidates).toEqual([
      expect.objectContaining({
        canonicalId: "ss34430",
        passesAutomaticCheckWithDefaultMapping: true,
        suggestedMapping: {
          segments: [suggested],
          passesAutomaticCheck: false,
          variantDescription: null,
        },
      }),
    ]);
    expect(await testDb.readDb.selectFrom("change_requests").select("id").execute()).toEqual([]);
  });

  test("get_catalog_season lists at most 80 episodes, says so, and fromEpisode lists the rest", async () => {
    const invokeModel = (request: ModelInvocationRequest): ModelInvocationResponse => {
      if (request.messages.some((m) => m.role === "assistant")) {
        return markAllNotFound(request);
      }
      return {
        content: null,
        toolCalls: [
          { id: "call_a", name: "get_catalog_season", arguments: { season: 3 } },
          { id: "call_b", name: "get_catalog_season", arguments: { season: 3, fromEpisode: 81 } },
        ],
        model: "test-model",
      };
    };
    const { testDb, mediaId, outbound, explore } = await setup({ kan360Rows: [] }, invokeModel);
    await testDb.writeDb
      .updateTable("media")
      .set({
        seasons: JSON.stringify([
          { season: 1, episodeCount: 24, airYear: 2020 },
          { season: 3, episodeCount: 100, airYear: 2024 },
        ]),
      })
      .where("id", "=", mediaId)
      .execute();

    await explore();

    const replies = outbound.modelRequests[1]!.messages.filter((m) => m.role === "tool");
    const [head, rest] = replies.map(
      (m) =>
        JSON.parse(m.content) as {
          episodes: Array<{ episode: number }>;
          episodesTruncated?: unknown;
        },
    );
    expect(head!.episodes.map((e) => e.episode)).toEqual(
      Array.from({ length: 80 }, (_, i) => i + 1),
    );
    expect(head!.episodesTruncated).toEqual({ total: 100, nextFromEpisode: 81 });
    expect(rest!.episodes.map((e) => e.episode)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 81),
    );
    expect(rest!.episodesTruncated).toBeUndefined();
  });

  test("get_collection lists at most 80 positions, says so, and fromPosition lists the rest", async () => {
    const invokeModel = (request: ModelInvocationRequest): ModelInvocationResponse => {
      if (request.messages.some((m) => m.role === "assistant")) {
        return markAllNotFound(request);
      }
      return {
        content: null,
        toolCalls: [
          {
            id: "call_a",
            name: "get_collection",
            arguments: { namespace: "bilibili", id: "ss34500" },
          },
          {
            id: "call_b",
            name: "get_collection",
            arguments: { namespace: "bilibili", id: "ss34500", fromPosition: 81 },
          },
        ],
        model: "test-model",
      };
    };
    const { outbound, explore } = await setup({ kan360Rows: [] }, invokeModel);

    await explore();

    const replies = outbound.modelRequests[1]!.messages.filter((m) => m.role === "tool");
    const [head, rest] = replies.map(
      (m) =>
        JSON.parse(m.content) as {
          featureEpisodeCount: number;
          episodes: Array<{ index: number }>;
          episodesTruncated?: unknown;
        },
    );
    expect(head!.featureEpisodeCount).toBe(100);
    expect(head!.episodes.map((e) => e.index)).toEqual(Array.from({ length: 80 }, (_, i) => i + 1));
    expect(head!.episodesTruncated).toEqual({ total: 100, nextFromPosition: 81 });
    expect(rest!.episodes.map((e) => e.index)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 81),
    );
    expect(rest!.episodesTruncated).toBeUndefined();
    // Both windows, asked in the same turn, come from one fetch of the collection.
    const seasonFetches = outbound.httpRequests.filter((r) => r.url.includes("season_id=34500"));
    expect(seasonFetches).toHaveLength(1);
  });

  test("web tools reach the agent through the session budget when the transport has them", async () => {
    const searched: unknown[] = [];
    const invokeModel = (request: ModelInvocationRequest): ModelInvocationResponse => {
      const turn = request.messages.filter((m) => m.role === "assistant").length;
      if (turn === 0) {
        expect(request.tools?.map((t) => t.name)).toEqual(
          expect.arrayContaining(["web_search", "web_fetch"]),
        );
        return {
          content: null,
          toolCalls: [
            { id: "call_w", name: "web_search", arguments: { query: "咒术回战 腾讯视频" } },
          ],
          model: "test-model",
        };
      }
      return markAllNotFound(request);
    };
    const { outbound, explore } = await setup({ kan360Rows: [] }, invokeModel, {}, (name, args) => {
      searched.push({ name, args });
      return "no results";
    });

    await explore();

    expect(searched).toEqual([{ name: "web_search", args: { query: "咒术回战 腾讯视频" } }]);
    const toolReply = outbound.modelRequests[1]!.messages.find((m) => m.role === "tool")!;
    expect(JSON.parse(toolReply.content)).toEqual({ text: "no results" });
  });

  test("an upstream outage while the agent fetches a collection keeps that platform transient", async () => {
    const invokeModel = (request: ModelInvocationRequest): ModelInvocationResponse => {
      const turn = request.messages.filter((m) => m.role === "assistant").length;
      if (turn === 0) {
        return {
          content: null,
          toolCalls: [
            {
              id: "call_g",
              name: "get_collection",
              arguments: { namespace: "bilibili", id: "https://www.bilibili.com/bangumi/play/ep1" },
            },
          ],
          model: "test-model",
        };
      }
      return markAllNotFound(request);
    };
    const { testDb, explore } = await setup({ kan360Rows: [] }, invokeModel);

    await explore();

    const checks = await testDb.readDb.selectFrom("platform_checks").select("platform").execute();
    expect(checks.map((c) => c.platform)).not.toContain("bilibili");
    expect(checks).toHaveLength(platformCount - 1);
  });

  test("a failed platform search during the session keeps that platform transient", async () => {
    let iqiyiSearches = 0;
    const invokeModel = (request: ModelInvocationRequest): ModelInvocationResponse => {
      const turn = request.messages.filter((m) => m.role === "assistant").length;
      if (turn === 0) {
        return {
          content: null,
          toolCalls: [
            {
              id: "call_p",
              name: "search_platform",
              arguments: { platform: "iqiyi", keyword: "呪術廻戦" },
            },
          ],
          model: "test-model",
        };
      }
      return markAllNotFound(request);
    };
    const { testDb, outbound, explore } = await setup({ kan360Rows: [] }, invokeModel);
    // Discovery's iQIYI search answers; the agent's later one hits an outage.
    const original = outbound.fetchExternal.bind(outbound);
    outbound.fetchExternal = async (request) => {
      if (new URL(request.url).hostname === "search.video.iqiyi.com" && ++iqiyiSearches > 1) {
        return jsonResponse(request.url, {}, 500);
      }
      return original(request);
    };

    await explore();

    expect(iqiyiSearches).toBe(2);
    const checks = await testDb.readDb.selectFrom("platform_checks").select("platform").execute();
    expect(checks.map((c) => c.platform)).not.toContain("iqiyi");
    expect(checks).toHaveLength(platformCount - 1);
  });

  test("near the end of its budget the session gets only conclusion tools and concludes", async () => {
    const invokeModel = (request: ModelInvocationRequest): ModelInvocationResponse => {
      if (request.tools?.some((t) => t.name === "get_catalog_season")) {
        return {
          content: null,
          toolCalls: [{ id: "call_s", name: "get_catalog_season", arguments: { season: 1 } }],
          model: "test-model",
        };
      }
      return markAllNotFound(request);
    };
    const { testDb, outbound, explore } = await setup({ kan360Rows: [] }, invokeModel, {
      maxSteps: 4,
    });

    await explore();

    // Step 2 of 4 leaves 3 steps: wrap-up starts there.
    expect(outbound.modelRequests).toHaveLength(2);
    const last = outbound.modelRequests[1]!;
    expect(last.tools?.map((t) => t.name)).toEqual(["submit_mapping", "mark_not_found"]);
    expect(last.webSearch).toBe(false);
    expect(last.messages.at(-1)).toMatchObject({ role: "user" });
    expect(last.messages.at(-1)!.content).toContain("Stop searching");
    const checks = await testDb.readDb.selectFrom("platform_checks").select("platform").execute();
    expect(checks).toHaveLength(platformCount);
  });

  test("a slow search cannot eat the wrap-up reserve: it is cut off and the session concludes", async () => {
    const invokeModel = (request: ModelInvocationRequest): ModelInvocationResponse => {
      if (request.tools?.some((t) => t.name === "web_search")) {
        return {
          content: null,
          toolCalls: [{ id: "call_w", name: "web_search", arguments: { query: "x" } }],
          model: "test-model",
        };
      }
      return markAllNotFound(request);
    };
    const slowSearch = () => new Promise<string>((r) => setTimeout(() => r("late"), 3000));
    const { testDb, outbound, explore } = await setup(
      { kan360Rows: [] },
      invokeModel,
      { maxDurationMs: 2000 },
      slowSearch as unknown as (name: string, args: Record<string, unknown>) => string,
    );

    await explore();

    const last = outbound.modelRequests.at(-1)!;
    expect(last.tools?.map((t) => t.name)).toEqual(["submit_mapping", "mark_not_found"]);
    const timedOut = last.messages.find((m) => m.role === "tool")!;
    expect(JSON.parse(timedOut.content)).toMatchObject({ error: "TIME_UP" });
    const checks = await testDb.readDb.selectFrom("platform_checks").select("platform").execute();
    expect(checks).toHaveLength(platformCount);
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

  test("variety shows: rejects truncated 1..20 linear prefix, accepts whole-season nonLinear, and fast-paths nonLinear review leads", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);
    const media = await testDb.writeDb
      .insertInto("media")
      .values({
        type: "tv",
        baseline: "tmdb",
        title: "现在就出发",
        original_title: "现在就出发",
        year: 2023,
        seasons: JSON.stringify([
          { season: 1, episodeCount: 20, airYear: 2023 },
          { season: 2, episodeCount: 20, airYear: 2024 },
          { season: 3, episodeCount: 47, airYear: 2025 },
        ]),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await testDb.writeDb
      .insertInto("associations")
      .values({
        status: "confirmed",
        is_external_id: true,
        media_id: media.id,
        namespace: "tmdb",
        native_id: "tv:231620",
      })
      .execute();
    await testDb.writeDb
      .insertInto("demands")
      .values({
        media_id: media.id,
        season: 3,
        namespace_group: "platform",
        status: "open",
        next_eligible_at: T0,
        last_demanded_at: T0,
      })
      .execute();

    // 47 TMDB episodes (pilot Oct 18, E20 Nov 16, finale E47 Dec 28); Tencent mzc00200znyfa5u has 20 第N期上/下 spanning Oct 25..Dec 28.
    const tmdbSeason3 = Array.from({ length: 47 }, (_, i) => {
      const ep = i + 1;
      const day = Math.floor((i * 71) / 46);
      const airDate = new Date(Date.UTC(2025, 9, 18 + day)).toISOString().slice(0, 10);
      return {
        episode_number: ep,
        name: ep === 1 ? "先导片" : ep % 3 === 0 ? `第${Math.ceil(ep / 3)}期加更` : `第${ep}集`,
        air_date: airDate,
      };
    });
    const tencentBroadcastItems = Array.from({ length: 10 }, (_, i) =>
      (["上", "下"] as const).map((part, pIdx) => {
        const idx = i * 2 + pIdx;
        const airDate = new Date(Date.UTC(2025, 9, 25 + Math.floor((idx * 64) / 19)))
          .toISOString()
          .slice(0, 10);
        return {
          vid: `v_${i + 1}_${pIdx}`,
          title: `第${i + 1}期${part}`,
          c_title_output: `第${i + 1}期${part}`,
          play_title: `第${i + 1}期${part}`,
          is_trailer: "0",
          publish_date: airDate,
        };
      }),
    ).flat();

    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        const url = new URL(request.url);
        if (request.namespace === "tmdb" && url.pathname.endsWith("/tv/231620/season/3")) {
          return jsonResponse(request.url, { season_number: 3, episodes: tmdbSeason3 });
        }
        if (request.namespace === "tmdb" && url.pathname.endsWith("/tv/231620")) {
          return jsonResponse(request.url, {
            id: 231620,
            name: "现在就出发",
            original_name: "现在就出发",
            first_air_date: "2023-06-11",
            seasons: [
              { season_number: 1, episode_count: 20, air_date: "2023-06-11" },
              { season_number: 2, episode_count: 20, air_date: "2024-10-26" },
              { season_number: 3, episode_count: 47, air_date: "2025-10-18" },
            ],
            external_ids: {},
          });
        }
        if (request.namespace === "trakt") return jsonResponse(request.url, []);
        if (url.hostname === "api.so.360kan.com") {
          return jsonResponse(request.url, {
            code: 0,
            data: {
              longData: {
                rows: [
                  {
                    titleTxt: "现在就出发 第3季",
                    year: "2025",
                    playlinks: { qq: "https://v.qq.com/x/cover/mzc00200znyfa5u.html" },
                  },
                ],
              },
            },
          });
        }
        if (url.hostname === "api.douban.com") {
          return jsonResponse(request.url, { msg: "not_found", code: 5000 });
        }
        if (url.hostname === "search.video.iqiyi.com") {
          return jsonResponse(request.url, { code: "A00000", data: { code: 0, docinfos: [] } });
        }
        if (url.hostname === "pbaccess.video.qq.com") {
          const body = JSON.parse(request.body ?? "{}") as {
            page_params?: { page_id?: string };
          };
          if (body.page_params?.page_id === "detail_page_introduction") {
            return jsonResponse(request.url, {
              ret: 0,
              msg: "",
              data: {
                module_list_datas: [
                  {
                    module_datas: [
                      {
                        item_data_lists: {
                          item_datas: [
                            {
                              item_params: {
                                title: "现在就出发",
                                year: "2025",
                                type: "10",
                                type_name: "综艺",
                              },
                            },
                          ],
                        },
                      },
                    ],
                  },
                ],
              },
            });
          }
          return jsonResponse(request.url, {
            ret: 0,
            msg: "",
            data: {
              module_list_datas: [
                {
                  module_datas: [
                    {
                      module_params: {},
                      item_data_lists: {
                        item_datas: tencentBroadcastItems.map((item_params) => ({ item_params })),
                      },
                    },
                  ],
                },
              ],
            },
          });
        }
        throw new Error(`Unexpected outbound request: ${request.namespace} ${request.url}`);
      },
      invokeModel(request) {
        const turn = request.messages.filter((m) => m.role === "assistant").length;
        if (turn === 0) {
          return {
            content: null,
            toolCalls: [
              {
                id: "call_trunc",
                name: "submit_mapping",
                arguments: {
                  namespace: "tencent",
                  canonicalId: "mzc00200znyfa5u",
                  segments: [{ season: 3, episodeStart: 1, episodeEnd: 20, targetEpisodeStart: 1 }],
                },
              },
              ...openNamespaces(request)
                .filter((ns) => ns !== "tencent")
                .map((namespace, i) => ({
                  id: `call_nf_${i}`,
                  name: "mark_not_found",
                  arguments: { namespace, reason: "not carried" },
                })),
            ],
            model: "test-model",
          };
        }
        if (turn === 1) {
          const toolMsgs = request.messages.filter((m) => m.role === "tool");
          const truncationReply = JSON.parse(
            toolMsgs.find((m) => m.content.includes("PARTIAL_SEGMENT_SPANS_FULL_SEASON"))!.content,
          ) as { error: string };
          expect(truncationReply.error).toBe("PARTIAL_SEGMENT_SPANS_FULL_SEASON");
          return {
            content: null,
            toolCalls: [
              {
                id: "call_nl",
                name: "submit_mapping",
                arguments: {
                  namespace: "tencent",
                  canonicalId: "mzc00200znyfa5u",
                  segments: [
                    {
                      season: 3,
                      episodeStart: 1,
                      episodeEnd: null,
                      targetEpisodeStart: 1,
                      nonLinear: true,
                    },
                  ],
                },
              },
            ],
            model: "test-model",
          };
        }
        return markAllNotFound(request);
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
        tmdb: { accessToken: "test-tmdb-token" },
        enableDailyTmdbSync: false,
        exploration: { dailyBudget: 10 },
      },
      now: () => T0,
    });

    await worker.scheduled(createScheduledController(T0));
    const exploreMsg = emitted.find((m) => m.jobType === EXPLORATION_JOB_TYPE)!;
    emitted.length = 0;
    await worker.queue(createQueueBatch([exploreMsg]));

    await worker.scheduled(createScheduledController(T0));
    const evidenceMsgs = emitted.filter((m) => m.jobType === EVIDENCE_CHECK_JOB_TYPE);
    expect(evidenceMsgs).toHaveLength(1);
    await worker.queue(createQueueBatch(evidenceMsgs));

    const assoc = await testDb.readDb
      .selectFrom("associations")
      .select(["id", "status", "native_id"])
      .where("media_id", "=", media.id)
      .where("namespace", "=", "tencent")
      .executeTakeFirstOrThrow();
    expect(assoc.status).toBe("confirmed");
    expect(assoc.native_id).toBe("mzc00200znyfa5u");
    const segs = await testDb.readDb
      .selectFrom("segments")
      .select(["season", "episode_start", "episode_end", "target_episode_start", "non_linear"])
      .where("association_id", "=", assoc.id)
      .execute();
    expect(segs).toEqual([
      {
        season: 3,
        episode_start: 1,
        episode_end: null,
        target_episode_start: 1,
        non_linear: true,
      },
    ]);

    // And a review-agent nonLinear lead fast-paths directly in prepareTarget without asking the model.
    await testDb.writeDb.deleteFrom("segments").where("association_id", "=", assoc.id).execute();
    await testDb.writeDb
      .deleteFrom("association_revisions")
      .where("association_id", "=", assoc.id)
      .execute();
    await testDb.writeDb.deleteFrom("associations").where("id", "=", assoc.id).execute();
    await ensureReviewAgentUser(testDb.writeDb);
    await testDb.writeDb
      .insertInto("leads")
      .values({
        target_external_key: "tmdb:tv:231620",
        namespace: "tencent",
        native_id: "mzc00200znyfa5u",
        season: 3,
        segments: JSON.stringify([
          {
            season: 3,
            episodeStart: 1,
            episodeEnd: null,
            targetEpisodeStart: 1,
            nonLinear: true,
          },
        ]),
        reporter_user_id: "system:review-agent",
        reporter_key_id: "system:review-agent",
      })
      .execute();
    const t2 = new Date(T0.getTime() + 60_000);
    await testDb.writeDb
      .updateTable("demands")
      .set({ status: "open", next_eligible_at: t2 })
      .where("media_id", "=", media.id)
      .where("season", "=", 3)
      .execute();
    const fastPathWorker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound: createFakeOutboundClient({
        fetchExternal: (req) => outbound.fetchExternal(req),
        invokeModel: markAllNotFound,
      }),
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
      config: {
        tmdb: { accessToken: "test-tmdb-token" },
        enableDailyTmdbSync: false,
        exploration: { dailyBudget: 10 },
      },
      now: () => t2,
    });
    emitted.length = 0;
    await fastPathWorker.scheduled(createScheduledController(t2));
    const exploreMsg2 = emitted.find((m) => m.jobType === EXPLORATION_JOB_TYPE)!;
    emitted.length = 0;
    await fastPathWorker.queue(createQueueBatch([exploreMsg2]));
    const fastCr = await testDb.readDb
      .selectFrom("change_requests")
      .select(["native_id", "segments", "status"])
      .where("namespace", "=", "tencent")
      .orderBy("created_at", "desc")
      .executeTakeFirstOrThrow();
    expect(fastCr.native_id).toBe("mzc00200znyfa5u");
    expect(fastCr.segments).toEqual([
      expect.objectContaining({
        season: 3,
        episodeStart: 1,
        episodeEnd: null,
        targetEpisodeStart: 1,
        nonLinear: true,
      }),
    ]);
  });
});
