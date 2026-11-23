import type { Message, MessageBatch, ScheduledController } from "@cloudflare/workers-types";
import { createApiApp } from "@media-ref/api/app";
import { resolveEpisode, type MediaDocument } from "@media-ref/client";
import {
  createDefaultAdapterRegistry,
  createFakeOutboundClient,
  deriveExplorationTaskId,
  enqueueJob,
  EVIDENCE_CHECK_JOB_TYPE,
  EXPLORATION_AGENT_USER_ID,
  EXPLORATION_JOB_TYPE,
  getJobById,
  getTier3TargetNamespaces,
  isTier2Adapter,
  isTier3Adapter,
  listDemands,
  seedTmdbExportIds,
  type EmailMessage,
  type ExternalHttpResponse,
  type JobQueueMessage,
} from "@media-ref/core";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { createBackgroundWorker } from "../src/index.ts";

const TEST_BASE_URL = "https://api.mediaref.org";
const TEST_AUTH_SECRET = "test-secret-for-multi-platform-exploration-e2e-0123456789abcdef";

function jsonResponse(url: string, payload: unknown, status = 200): ExternalHttpResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
    url,
  };
}

function makeIqiyiFeatureEpisodes(count: number, tvIdBase = 3493131456000000) {
  const list: Array<Record<string, unknown>> = [];
  for (let i = 1; i <= count; i += 1) {
    list.push({
      tvId: tvIdBase + i * 100,
      order: i,
      name: `狂飙第${i}集`,
      shortTitle: `第${i}集`,
      contentType: 1,
      duration: "45:00",
      period: "2023-01-14",
      effective: true,
    });
  }
  // Trailer must be excluded by Tier 2 adapter during inspect & evidence check
  list.push({
    tvId: tvIdBase + 999900,
    order: 999,
    name: "狂飙终极预告",
    shortTitle: "预告",
    contentType: 3,
    duration: "01:30",
    period: "2023-01-13",
    effective: true,
  });
  return list;
}

function extractCookieHeader(response: Response): string {
  const setCookies = response.headers.getSetCookie();
  return setCookies
    .map((entry) => entry.split(";")[0]?.trim())
    .filter((pair): pair is string => Boolean(pair))
    .join("; ");
}

function extractVerificationUrl(email: EmailMessage): string {
  const match = email.text.match(/https?:\/\/\S+\/api\/auth\/verify-email\?\S+/);
  if (!match) {
    throw new Error(`No verification URL found in email text: ${email.text}`);
  }
  return match[0];
}

async function setupReadApiKey(
  app: ReturnType<typeof createApiApp>,
  outbound: ReturnType<typeof createFakeOutboundClient>,
  email: string,
): Promise<string> {
  const emailsBefore = outbound.sentEmails.length;
  const signUpRes = await app.fetch(
    new Request(`${TEST_BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        password: "StrongPassword123!",
        name: "Multi-Platform E2E Tester",
      }),
    }),
  );
  expect(signUpRes.status).toBe(200);
  let cookie = extractCookieHeader(signUpRes);

  const verificationEmail = outbound.sentEmails[emailsBefore];
  expect(verificationEmail).toBeDefined();
  const verifyRes = await app.fetch(
    new Request(extractVerificationUrl(verificationEmail!), {
      method: "GET",
      headers: { cookie },
    }),
  );
  expect([200, 302]).toContain(verifyRes.status);
  const refreshed = extractCookieHeader(verifyRes);
  if (refreshed) {
    cookie = refreshed;
  }

  const readKeyRes = await app.fetch(
    new Request(`${TEST_BASE_URL}/v1/api-keys`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Read Key", canSubmit: false }),
    }),
  );
  expect(readKeyRes.status).toBe(201);
  const readKey = (await readKeyRes.json()) as { id: string; key: string };
  return readKey.key;
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
): MessageBatch<JobQueueMessage> {
  const messages: Message<JobQueueMessage>[] = bodies.map((body, index) => ({
    id: `msg-${index + 1}-${body.jobId}-gen-${body.leaseGeneration}`,
    timestamp,
    body,
    attempts: 1,
    ack() {},
    retry() {},
  }));

  return {
    queue: "media-ref-jobs",
    messages,
    metadata: {
      metrics: {
        backlogCount: messages.length,
        backlogBytes: 0,
      },
    },
    ackAll() {},
    retryAll() {},
  };
}

describe("Multi-platform Tier 3 exploration & Tier 2 exclusion (#30)", () => {
  const handles: TestDbHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop();
      if (handle) {
        await handle.cleanup();
      }
    }
  });

  test("default registry exposes strictly bilibili and iqiyi as Tier 3 platforms and keeps tencent, youku, and mgtv at Tier 2", () => {
    const registry = createDefaultAdapterRegistry();
    const tier3Platforms = getTier3TargetNamespaces(registry, "platform");

    expect(tier3Platforms).toEqual(["bilibili", "iqiyi"]);
    expect(tier3Platforms).not.toContain("tencent");
    expect(tier3Platforms).not.toContain("youku");
    expect(tier3Platforms).not.toContain("mgtv");

    for (const ns of ["bilibili", "iqiyi"] as const) {
      const adapter = registry.get(ns);
      expect(adapter?.tier).toBe(3);
      expect(adapter && isTier2Adapter(adapter)).toBe(true);
      expect(adapter && isTier3Adapter(adapter)).toBe(true);
    }

    for (const ns of ["tencent", "youku", "mgtv"] as const) {
      const adapter = registry.get(ns);
      expect(adapter?.tier).toBe(2);
      expect(adapter && isTier2Adapter(adapter)).toBe(true);
      expect(adapter && isTier3Adapter(adapter)).toBe(false);
    }
  });

  test("full miss-to-hit TV exploration on iQIYI (狂飙): 404 read -> demand -> scheduled -> Tier 3 search/inspect/submit -> evidence_check Step 1 & 2 -> confirmed 200 GET & resolveEpisode", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-24T09:00:00.000Z");
    const pendingBgTasks: Promise<unknown>[] = [];

    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        if (request.namespace === "tmdb" && request.url.includes("/tv/218230")) {
          return jsonResponse(request.url, {
            id: 218230,
            name: "狂飙",
            original_name: "狂飙",
            first_air_date: "2023-01-14",
            seasons: [{ season_number: 1, episode_count: 39, air_date: "2023-01-14" }],
            external_ids: {
              imdb_id: "tt26258202",
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
          return jsonResponse(request.url, { code: 0, data: { numResults: 0, result: [] } });
        }
        if (
          request.namespace === "iqiyi" &&
          request.url.startsWith("https://search.video.iqiyi.com/o")
        ) {
          return jsonResponse(request.url, {
            code: "A00000",
            data: {
              code: 0,
              docinfos: [
                {
                  qipu_id: 5328486914190101,
                  albumDocInfo: {
                    albumId: 5328486914190101,
                    qipu_id: 5328486914190101,
                    albumTitle: "狂飙",
                    albumEnglishTitle: "The Knockout",
                    channel: "电视剧,2",
                    releaseDate: "20230114",
                    itemTotalNumber: 39,
                    albumLink: "https://www.iqiyi.com/a_1fkgtbddd2x.html",
                    siteId: "iqiyi",
                  },
                },
                {
                  albumDocInfo: {
                    albumId: 999999901,
                    albumTitle: "狂飙（站外）",
                    channel: "电视剧,2",
                    releaseDate: "20230114",
                    itemTotalNumber: 39,
                    siteId: "qq",
                  },
                },
              ],
            },
          });
        }
        if (
          request.namespace === "iqiyi" &&
          request.url === "https://pcw-api.iqiyi.com/album/album/baseinfo/5328486914190101"
        ) {
          return jsonResponse(request.url, {
            code: "A00000",
            data: {
              albumId: 5328486914190101,
              name: "狂飙",
              englishName: "The Knockout",
              channelId: 2,
              videoCount: 39,
              latestOrder: 39,
              period: "2023-02-01",
              publishTime: 1673625600000,
              firstVideo: {
                tvId: 3493131456000100,
                period: "2023-01-14",
              },
            },
          });
        }
        if (
          request.namespace === "iqiyi" &&
          request.url ===
            "https://pcw-api.iqiyi.com/albums/album/avlistinfo?aid=5328486914190101&page=1&size=50"
        ) {
          return jsonResponse(request.url, {
            code: "A00000",
            data: {
              total: 40,
              hasMore: false,
              epsodelist: makeIqiyiFeatureEpisodes(39),
            },
          });
        }
        throw new Error(`Unexpected outbound request: ${request.namespace} ${request.url}`);
      },
      invokeModel(request) {
        const userPrompt = request.messages.find((m) => m.role === "user")?.content ?? "";
        const toolResults = request.messages.filter((m) => m.role === "tool");

        if (userPrompt.includes('"targetPlatform": "bilibili"')) {
          if (toolResults.length === 0) {
            return {
              content: null,
              toolCalls: [{ id: "b1", name: "search_platform", arguments: { keyword: "狂飙" } }],
              model: request.model ?? "test-model",
            };
          }
          return {
            content: null,
            toolCalls: [
              { id: "b2", name: "mark_not_found", arguments: { reason: "not_on_bilibili" } },
            ],
            model: request.model ?? "test-model",
          };
        }

        if (userPrompt.includes('"targetPlatform": "iqiyi"')) {
          if (toolResults.length === 0) {
            return {
              content: null,
              toolCalls: [{ id: "q1", name: "search_platform", arguments: { keyword: "狂飙" } }],
              model: request.model ?? "test-model",
            };
          }
          if (toolResults.length === 1) {
            // Confirm search_platform returned the filtered iQIYI candidate
            const searchPayload = JSON.parse(toolResults[0]!.content) as {
              status: string;
              candidates: Array<{ canonicalId: string }>;
            };
            expect(searchPayload.status).toBe("ok");
            expect(searchPayload.candidates.map((c) => c.canonicalId)).toEqual([
              "5328486914190101",
            ]);
            return {
              content: null,
              toolCalls: [
                {
                  id: "q2",
                  name: "inspect_collection",
                  arguments: { nativeId: "5328486914190101" },
                },
              ],
              model: request.model ?? "test-model",
            };
          }
          return {
            content: null,
            toolCalls: [
              {
                id: "q3",
                name: "submit_candidate",
                arguments: {
                  nativeId: "5328486914190101",
                  variantDescription: "原声",
                  segments: [{ season: 1, episodeStart: 1, episodeEnd: 39, targetEpisodeStart: 1 }],
                },
              },
            ],
            model: request.model ?? "test-model",
          };
        }

        throw new Error(`Unexpected targetPlatform in model prompt: ${userPrompt}`);
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

    const readKey = await setupReadApiKey(apiApp, outbound, "iqiyi-e2e@example.com");

    // 1. Read unseen TMDB TV series -> 404 miss + records demand
    const missRes = await apiApp.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:218230?season=1&namespaceGroup=platform`, {
        headers: { "x-api-key": readKey },
      }),
    );
    expect(missRes.status).toBe(404);
    await Promise.all(pendingBgTasks);

    await seedTmdbExportIds(testDb.writeDb, [{ mediaType: "tv", tmdbId: "218230" }], "2026-11-24");

    // 2. Background worker with default registry (Tier 3 = bilibili & iqiyi; Tier 2 = tencent, youku, mgtv)
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

    // 3. scheduled claims demand -> targetNamespaces MUST be ["bilibili", "iqiyi"] only!
    await worker.scheduled(createScheduledController(t0));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.jobType).toBe(EXPLORATION_JOB_TYPE);
    expect(emitted[0]?.payload.targetNamespaces).toEqual(["bilibili", "iqiyi"]);
    const explorationJobId = emitted[0]!.jobId;

    // 4. queue executes exploration agent -> bilibili not_found, iqiyi search + inspect + submit
    const expSummary = await worker.queue(createQueueBatch(emitted, t0));
    expect(expSummary.completed).toBe(1);

    const expectedIqiyiTaskId = await deriveExplorationTaskId(explorationJobId, "iqiyi", 2);
    const iqiyiCr = await testDb.readDb
      .selectFrom("change_requests")
      .selectAll()
      .where("task_id", "=", expectedIqiyiTaskId)
      .executeTakeFirstOrThrow();
    expect(iqiyiCr.namespace).toBe("iqiyi");
    expect(iqiyiCr.native_id).toBe("5328486914190101");
    expect(iqiyiCr.submitter_type).toBe("agent");
    expect(iqiyiCr.submitter_user_id).toBe(EXPLORATION_AGENT_USER_ID);
    expect(iqiyiCr.variant_description).toBe("原声");
    expect(iqiyiCr.set_default_variant).toBe(true);
    expect(iqiyiCr.status).toBe("pending_evidence");

    // 5. scheduled + queue executes evidence_check -> Step 1 + Step 2 pass -> auto-approved!
    emitted.length = 0;
    await worker.scheduled(createScheduledController(t0));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.jobType).toBe(EVIDENCE_CHECK_JOB_TYPE);
    const evSummary = await worker.queue(createQueueBatch(emitted, t0));
    expect(evSummary.completed).toBe(1);

    // 6. Read again -> 200 with confirmed iQIYI association & segments, resolvable via @media-ref/client
    const hitRes = await apiApp.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:218230`, {
        headers: { "x-api-key": readKey },
      }),
    );
    expect(hitRes.status).toBe(200);
    const { document } = (await hitRes.json()) as { document: MediaDocument };
    expect(document.media.snapshot.title).toBe("狂飙");
    expect(document.variants).toHaveLength(1);
    expect(document.variants[0]).toMatchObject({
      namespace: "iqiyi",
      label: "原声",
      isDefault: true,
    });
    expect(document.associations).toHaveLength(1);
    expect(document.associations[0]).toMatchObject({
      namespace: "iqiyi",
      nativeId: "5328486914190101",
      status: "confirmed",
    });

    expect(resolveEpisode(document, { namespace: "iqiyi", season: 1, episode: 20 })).toMatchObject({
      kind: "mapped",
      namespace: "iqiyi",
      nativeId: "5328486914190101",
      targetEpisode: 20,
    });

    // Platform statuses: iqiyi associated, bilibili not_found, Tier 2 platforms strictly unchecked!
    expect(document.platformStatuses?.iqiyi).toEqual({ status: "associated" });
    expect(document.platformStatuses?.bilibili).toEqual({
      status: "not_found",
      checkedAt: t0.toISOString(),
    });
    expect(document.platformStatuses?.tencent).toEqual({ status: "unchecked" });
    expect(document.platformStatuses?.youku).toEqual({ status: "unchecked" });
    expect(document.platformStatuses?.mgtv).toEqual({ status: "unchecked" });

    // Zero outbound requests ever touched Tier 2 platforms
    const touchedNamespaces = new Set(outbound.httpRequests.map((r) => r.namespace));
    expect(touchedNamespaces.has("tencent")).toBe(false);
    expect(touchedNamespaces.has("youku")).toBe(false);
    expect(touchedNamespaces.has("mgtv")).toBe(false);
  });

  test("discovers both Bilibili and iQIYI (00-suffix movie ID) in a single multi-platform exploration job", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-24T10:00:00.000Z");
    const pendingBgTasks: Promise<unknown>[] = [];

    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        if (request.namespace === "tmdb" && request.url.includes("/movie/535167")) {
          return jsonResponse(request.url, {
            id: 535167,
            title: "流浪地球",
            original_title: "流浪地球",
            release_date: "2019-02-05",
            external_ids: { imdb_id: "tt7605074" },
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
          if (url.searchParams.get("search_type") === "media_ft") {
            return jsonResponse(request.url, {
              code: 0,
              data: {
                result: [
                  {
                    season_id: 28001,
                    title: '<em class="keyword">流浪地球</em>',
                    media_type: 2,
                    pubtime: 1549296000,
                    ep_size: 1,
                  },
                ],
              },
            });
          }
          return jsonResponse(request.url, { code: 0, data: { result: [] } });
        }
        if (
          request.namespace === "bilibili" &&
          request.url === "https://api.bilibili.com/pgc/view/web/season?season_id=28001"
        ) {
          return jsonResponse(request.url, {
            code: 0,
            result: {
              season_id: 28001,
              title: "流浪地球",
              type: 2,
              publish: { pub_time: "2019-02-05 00:00:00" },
              episodes: [
                {
                  id: 2800101,
                  title: "正片",
                  badge: "会员",
                  badge_type: 0,
                  section_type: 0,
                  duration: 7500000,
                },
              ],
            },
          });
        }
        if (
          request.namespace === "iqiyi" &&
          request.url.startsWith("https://search.video.iqiyi.com/o")
        ) {
          return jsonResponse(request.url, {
            code: "A00000",
            data: {
              code: 0,
              docinfos: [
                {
                  qipu_id: 923452300,
                  albumDocInfo: {
                    albumId: 923452300,
                    albumTitle: "流浪地球",
                    albumEnglishTitle: "The Wandering Earth",
                    channel: "电影,1",
                    releaseDate: "20190205",
                    itemTotalNumber: 1,
                    albumLink: "https://www.iqiyi.com/v_19rrfe142o.html",
                    siteId: "iqiyi",
                  },
                },
              ],
            },
          });
        }
        if (
          request.namespace === "iqiyi" &&
          request.url === "https://pcw-api.iqiyi.com/video/video/baseinfo/923452300"
        ) {
          return jsonResponse(request.url, {
            code: "A00000",
            data: {
              tvId: 923452300,
              albumId: 923452300,
              name: "流浪地球",
              englishName: "The Wandering Earth",
              channelId: 1,
              period: "2019-02-05",
              publishTime: 1549296000000,
              videoCount: 1,
              contentType: 1,
              duration: 7500,
            },
          });
        }
        throw new Error(`Unexpected outbound request: ${request.namespace} ${request.url}`);
      },
      invokeModel(request) {
        const userPrompt = request.messages.find((m) => m.role === "user")?.content ?? "";
        const toolResults = request.messages.filter((m) => m.role === "tool");
        const isIqiyi = userPrompt.includes('"targetPlatform": "iqiyi"');
        const nativeId = isIqiyi ? "923452300" : "ss28001";

        if (toolResults.length === 0) {
          return {
            content: null,
            toolCalls: [{ id: "s1", name: "search_platform", arguments: { keyword: "流浪地球" } }],
            model: request.model ?? "test-model",
          };
        }
        if (toolResults.length === 1) {
          return {
            content: null,
            toolCalls: [{ id: "i1", name: "inspect_collection", arguments: { nativeId } }],
            model: request.model ?? "test-model",
          };
        }
        return {
          content: null,
          toolCalls: [
            {
              id: "sub1",
              name: "submit_candidate",
              arguments: { nativeId, variantDescription: "原声" },
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

    const readKey = await setupReadApiKey(apiApp, outbound, "both-tier3-movie@example.com");

    const missRes = await apiApp.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:movie:535167?namespaceGroup=platform`, {
        headers: { "x-api-key": readKey },
      }),
    );
    expect(missRes.status).toBe(404);
    await Promise.all(pendingBgTasks);

    await seedTmdbExportIds(
      testDb.writeDb,
      [{ mediaType: "movie", tmdbId: "535167" }],
      "2026-11-24",
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

    await worker.scheduled(createScheduledController(t0));
    expect(emitted).toHaveLength(1);
    const explorationJobId = emitted[0]!.jobId;
    expect(emitted[0]?.payload.targetNamespaces).toEqual(["bilibili", "iqiyi"]);

    const expSummary = await worker.queue(createQueueBatch(emitted, t0));
    expect(expSummary.completed).toBe(1);

    // Distinct deterministic task_ids for bilibili and iqiyi
    const biliTaskId = await deriveExplorationTaskId(explorationJobId, "bilibili", 2);
    const iqiyiTaskId = await deriveExplorationTaskId(explorationJobId, "iqiyi", 2);
    expect(biliTaskId).not.toBe(iqiyiTaskId);

    const crs = await testDb.readDb.selectFrom("change_requests").selectAll().execute();
    expect(crs).toHaveLength(2);
    expect(crs.map((c) => `${c.namespace}:${c.native_id}`).sort()).toEqual([
      "bilibili:ss28001",
      "iqiyi:923452300",
    ]);

    // Evidence check approves both change requests
    emitted.length = 0;
    await worker.scheduled(createScheduledController(t0));
    expect(emitted).toHaveLength(2);
    expect(emitted.every((m) => m.jobType === EVIDENCE_CHECK_JOB_TYPE)).toBe(true);

    const evSummary = await worker.queue(createQueueBatch(emitted, t0));
    expect(evSummary.completed).toBe(2);

    const hitRes = await apiApp.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:movie:535167`, {
        headers: { "x-api-key": readKey },
      }),
    );
    expect(hitRes.status).toBe(200);
    const { document } = (await hitRes.json()) as { document: MediaDocument };
    expect(
      document.associations.map((a) => `${a.namespace}:${a.nativeId}:${a.status}`).sort(),
    ).toEqual(["bilibili:ss28001:confirmed", "iqiyi:923452300:confirmed"]);
    expect(document.platformStatuses?.bilibili).toEqual({ status: "associated" });
    expect(document.platformStatuses?.iqiyi).toEqual({ status: "associated" });
    expect(document.platformStatuses?.tencent).toEqual({ status: "unchecked" });
    expect(document.platformStatuses?.youku).toEqual({ status: "unchecked" });
    expect(document.platformStatuses?.mgtv).toEqual({ status: "unchecked" });
  });

  test("Tier 2 platforms (tencent, youku, mgtv) are NEVER claimed, searched, or marked not_found — even when Tier 3 searches miss or a job payload injects Tier 2 namespaces", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-24T11:00:00.000Z");
    const pendingBgTasks: Promise<unknown>[] = [];

    const media = await testDb.writeDb
      .insertInto("media")
      .values({
        type: "tv",
        baseline: "tmdb",
        title: "仅限海外的测试剧",
        original_title: "Overseas Only Show",
        year: 2024,
        seasons: JSON.stringify([{ season: 1, episodeCount: 10, airYear: 2024 }]),
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await testDb.writeDb
      .insertInto("external_ids")
      .values({
        media_id: media.id,
        namespace: "tmdb",
        native_id: "tv:777771",
        source: "sync",
      })
      .execute();

    const outbound = createFakeOutboundClient({
      fetchExternal(request) {
        if (request.namespace === "bilibili") {
          return jsonResponse(request.url, { code: 0, data: { numResults: 0, result: [] } });
        }
        if (request.namespace === "iqiyi") {
          return jsonResponse(request.url, { code: "A00000", data: { result_num: 0 } });
        }
        throw new Error(
          `Tier 2 platform MUST NEVER be called: ${request.namespace} ${request.url}`,
        );
      },
      invokeModel(request) {
        const toolResults = request.messages.filter((m) => m.role === "tool");
        if (toolResults.length === 0) {
          return {
            content: null,
            toolCalls: [
              { id: "s1", name: "search_platform", arguments: { keyword: "仅限海外的测试剧" } },
            ],
            model: request.model ?? "test-model",
          };
        }
        return {
          content: null,
          toolCalls: [{ id: "nf1", name: "mark_not_found", arguments: { reason: "absent" } }],
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

    const readKey = await setupReadApiKey(apiApp, outbound, "tier2-exclusion@example.com");

    // 1. Trigger demand via GET
    await apiApp.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:777771?season=1&namespaceGroup=platform`, {
        headers: { "x-api-key": readKey },
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

    // 2. Scheduled claims exploration job -> strictly ["bilibili", "iqiyi"]
    await worker.scheduled(createScheduledController(t0));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.payload.targetNamespaces).toEqual(["bilibili", "iqiyi"]);

    // 3. Queue executes -> both bilibili & iqiyi marked not_found; tencent/youku/mgtv untouched
    const summary = await worker.queue(createQueueBatch(emitted, t0));
    expect(summary.completed).toBe(1);

    const checks = await testDb.readDb
      .selectFrom("platform_checks")
      .selectAll()
      .where("media_id", "=", media.id)
      .execute();
    expect(checks.map((c) => c.platform).sort()).toEqual(["bilibili", "iqiyi"]);

    const readAfter = await apiApp.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:777771`, {
        headers: { "x-api-key": readKey },
      }),
    );
    const { document } = (await readAfter.json()) as { document: MediaDocument };
    expect(document.platformStatuses?.bilibili).toEqual({
      status: "not_found",
      checkedAt: t0.toISOString(),
    });
    expect(document.platformStatuses?.iqiyi).toEqual({
      status: "not_found",
      checkedAt: t0.toISOString(),
    });
    expect(document.platformStatuses?.tencent).toEqual({ status: "unchecked" });
    expect(document.platformStatuses?.youku).toEqual({ status: "unchecked" });
    expect(document.platformStatuses?.mgtv).toEqual({ status: "unchecked" });

    // 4. Defense-in-depth: even if a job payload contains ONLY Tier 2 namespaces, handler skips with zero calls
    const demands = await listDemands(testDb.readDb, { mediaId: media.id });
    const demand = demands[0]!;
    const leasedDemand = await testDb.writeDb
      .updateTable("demands")
      .set({
        status: "leased",
        lease_generation: demand.leaseGeneration + 1,
        lease_expires_at: new Date(t0.getTime() + 15 * 60_000),
        updated_at: t0,
      })
      .where("id", "=", demand.id)
      .returning(["id", "lease_generation"])
      .executeTakeFirstOrThrow();

    const injected = await enqueueJob(testDb.writeDb, {
      jobType: EXPLORATION_JOB_TYPE,
      priority: 1,
      dedupeKey: `injected-tier2-only:${leasedDemand.id}`,
      runAfter: t0,
      payload: {
        demandId: leasedDemand.id,
        mediaId: media.id,
        externalKey: null,
        season: 1,
        namespaceGroup: "platform",
        targetNamespaces: ["tencent", "youku", "mgtv"],
        demandLeaseGeneration: leasedDemand.lease_generation,
      },
    });
    await testDb.writeDb
      .updateTable("background_jobs")
      .set({
        status: "leased",
        lease_generation: 1,
        lease_expires_at: new Date(t0.getTime() + 5 * 60_000),
      })
      .where("id", "=", injected.job.id)
      .execute();

    const httpCallsBefore = outbound.httpRequests.length;
    const modelCallsBefore = outbound.modelRequests.length;

    const injectedSummary = await worker.queue(
      createQueueBatch(
        [
          {
            jobId: injected.job.id,
            jobType: EXPLORATION_JOB_TYPE,
            leaseGeneration: 1,
            payload: injected.job.payload,
          },
        ],
        t0,
      ),
    );
    expect(injectedSummary.completed).toBe(1);

    const injectedJobAfter = await getJobById(testDb.readDb, injected.job.id);
    expect(injectedJobAfter?.result).toMatchObject({
      skipped: true,
      reason: "no_tier3_targets",
    });

    // Zero HTTP or model calls executed for Tier 2 platforms
    expect(outbound.httpRequests).toHaveLength(httpCallsBefore);
    expect(outbound.modelRequests).toHaveLength(modelCallsBefore);

    // Still zero platform_checks rows for tencent, youku, or mgtv
    const checksAfter = await testDb.readDb
      .selectFrom("platform_checks")
      .select("platform")
      .where("media_id", "=", media.id)
      .execute();
    expect(checksAfter.map((c) => c.platform).sort()).toEqual(["bilibili", "iqiyi"]);
  });
});
