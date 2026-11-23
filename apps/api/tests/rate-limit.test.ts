import type { ExecutionContext, Hyperdrive } from "@cloudflare/workers-types";
import {
  createAdapterRegistry,
  createFakeOutboundClient,
  type EmailMessage,
  type ExternalHttpRequest,
} from "@media-ref/core";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, describe, expect, test } from "vite-plus/test";
import worker, { createApiApp, createInMemoryRateLimiter } from "../src/index.ts";

const TEST_BASE_URL = "https://api.mediaref.org";
const TEST_AUTH_SECRET = "test-secret-for-media-ref-rate-limit-integration-tests-0123456789";

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

async function signUpUser(
  app: ReturnType<typeof createApiApp>,
  outbound: ReturnType<typeof createFakeOutboundClient>,
  input: { email: string; password: string; name: string },
): Promise<{ userId: string; cookie: string }> {
  const emailsBefore = outbound.sentEmails.length;
  const signUpRes = await app.fetch(
    new Request(`${TEST_BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  expect(signUpRes.status).toBe(200);
  const signUpBody = (await signUpRes.json()) as { user: { id: string } };
  let cookie = extractCookieHeader(signUpRes);

  const email = outbound.sentEmails[emailsBefore];
  expect(email).toBeDefined();
  const verifyRes = await app.fetch(
    new Request(extractVerificationUrl(email!), {
      method: "GET",
      headers: { cookie },
    }),
  );
  expect([200, 302]).toContain(verifyRes.status);
  const refreshed = extractCookieHeader(verifyRes);
  if (refreshed) {
    cookie = refreshed;
  }

  return { userId: signUpBody.user.id, cookie };
}

async function createApiKey(
  app: ReturnType<typeof createApiApp>,
  cookie: string,
  options: { name: string; canSubmit?: boolean },
): Promise<{ id: string; key: string }> {
  const res = await app.fetch(
    new Request(`${TEST_BASE_URL}/v1/api-keys`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        name: options.name,
        canSubmit: options.canSubmit ?? false,
      }),
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; key: string };
}

function createCatalogStubHandler() {
  return (request: ExternalHttpRequest) => {
    if (request.kind === "catalog" && request.namespace === "tmdb") {
      if (request.url.includes("/tv/95479")) {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          url: request.url,
          body: JSON.stringify({
            id: 95479,
            name: "咒术回战",
            original_name: "呪術廻戦",
            first_air_date: "2020-10-03",
            seasons: [{ season_number: 1, episode_count: 47, air_date: "2020-10-03" }],
            external_ids: { imdb_id: "tt12343534", tvdb_id: 377543 },
          }),
        };
      }
      return {
        status: 404,
        headers: { "content-type": "application/json" },
        url: request.url,
        body: JSON.stringify({ status_code: 34, status_message: "Not found" }),
      };
    }

    if (request.kind === "catalog" && request.namespace === "trakt") {
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        url: request.url,
        body: "[]",
      };
    }

    throw new Error(
      `Unexpected outbound request: ${request.kind}:${request.namespace} ${request.url}`,
    );
  };
}

async function seedConfirmedMedia(
  app: ReturnType<typeof createApiApp>,
  testDb: TestDbHandle,
  outbound: ReturnType<typeof createFakeOutboundClient>,
): Promise<void> {
  const owner = await signUpUser(app, outbound, {
    email: `owner-${Math.random().toString(36).slice(2, 8)}@example.com`,
    password: "StrongPassword123!",
    name: "Owner",
  });
  await testDb.writeDb
    .updateTable("user")
    .set({ role: "owner" })
    .where("id", "=", owner.userId)
    .execute();

  const crRes = await app.fetch(
    new Request(`${TEST_BASE_URL}/v1/change-requests`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: owner.cookie },
      body: JSON.stringify({
        targetExternalKey: "tmdb:tv:95479",
        namespace: "bilibili",
        nativeId: "ss34430",
        variantDescription: "原声",
        segments: [
          { season: 1, episodeStart: 1, episodeEnd: 24, targetEpisodeStart: 1, baseline: "tmdb" },
        ],
      }),
    }),
  );
  expect(crRes.status).toBe(201);
  const { changeRequest } = (await crRes.json()) as { changeRequest: { id: string } };

  const approveRes = await app.fetch(
    new Request(`${TEST_BASE_URL}/v1/reviewer/change-requests/${changeRequest.id}/approve`, {
      method: "POST",
      headers: { cookie: owner.cookie },
    }),
  );
  expect(approveRes.status).toBe(200);
}

describe("API Worker rate limiting & submission quotas (#19)", () => {
  const handles: TestDbHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop();
      if (handle) {
        await handle.cleanup();
      }
    }
  });

  test("enforces per-API-key read rate limit with 429 and Retry-After while leaving other keys unaffected", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    let currentTime = new Date("2026-11-23T12:00:00.000Z");
    const outbound = createFakeOutboundClient({
      fetchExternal: createCatalogStubHandler(),
    });

    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      adapterRegistry: createAdapterRegistry(),
      readKeyLimiter: createInMemoryRateLimiter({
        limit: 3,
        periodSeconds: 60,
        now: () => currentTime,
      }),
      readIpLimiter: createInMemoryRateLimiter({
        limit: 20,
        periodSeconds: 60,
        now: () => currentTime,
      }),
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => currentTime,
        tmdb: { accessToken: "test-tmdb-token" },
        readRetryAfterSeconds: 60,
      },
    });

    await seedConfirmedMedia(app, testDb, outbound);

    const user = await signUpUser(app, outbound, {
      email: "reader-key@example.com",
      password: "StrongPassword123!",
      name: "Reader",
    });
    const keyA = await createApiKey(app, user.cookie, { name: "Key A" });
    const keyB = await createApiKey(app, user.cookie, { name: "Key B" });

    // First 3 requests for Key A succeed
    for (let i = 0; i < 3; i++) {
      const res = await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:95479`, {
          headers: {
            "x-api-key": keyA.key,
            "cf-connecting-ip": "203.0.113.10",
          },
        }),
      );
      expect(res.status).toBe(200);
    }

    // 4th request for Key A hits per-key rate limit -> 429 with Retry-After
    const blockedA = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:95479`, {
        headers: {
          "x-api-key": keyA.key,
          "cf-connecting-ip": "203.0.113.10",
        },
      }),
    );
    expect(blockedA.status).toBe(429);
    expect(blockedA.headers.get("retry-after")).toBe("60");
    expect(await blockedA.json()).toMatchObject({
      error: "RATE_LIMITED",
      scope: "api_key",
      retryAfterSeconds: 60,
    });

    // Different API key from a different IP still succeeds
    const allowedB = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:95479`, {
        headers: {
          "x-api-key": keyB.key,
          "cf-connecting-ip": "203.0.113.20",
        },
      }),
    );
    expect(allowedB.status).toBe(200);

    // After the 60s fixed window rolls over, Key A succeeds again
    currentTime = new Date(currentTime.getTime() + 60_000);
    const recoveredA = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:95479`, {
        headers: {
          "x-api-key": keyA.key,
          "cf-connecting-ip": "203.0.113.10",
        },
      }),
    );
    expect(recoveredA.status).toBe(200);
  });

  test("enforces source-IP read rate limit across different API keys sharing the same IP", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const outbound = createFakeOutboundClient({
      fetchExternal: createCatalogStubHandler(),
    });

    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      adapterRegistry: createAdapterRegistry(),
      readKeyLimiter: createInMemoryRateLimiter({ limit: 10, periodSeconds: 60 }),
      readIpLimiter: createInMemoryRateLimiter({ limit: 3, periodSeconds: 60 }),
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        tmdb: { accessToken: "test-tmdb-token" },
        readRetryAfterSeconds: 45,
      },
    });

    await seedConfirmedMedia(app, testDb, outbound);

    const user1 = await signUpUser(app, outbound, {
      email: "ip-user-1@example.com",
      password: "StrongPassword123!",
      name: "User 1",
    });
    const user2 = await signUpUser(app, outbound, {
      email: "ip-user-2@example.com",
      password: "StrongPassword123!",
      name: "User 2",
    });
    const key1 = await createApiKey(app, user1.cookie, { name: "Key 1" });
    const key2 = await createApiKey(app, user2.cookie, { name: "Key 2" });

    // 2 reads via Key 1 from 198.51.100.5
    for (let i = 0; i < 2; i++) {
      const res = await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:95479`, {
          headers: {
            "x-api-key": key1.key,
            "cf-connecting-ip": "198.51.100.5",
          },
        }),
      );
      expect(res.status).toBe(200);
    }

    // 1 read via Key 2 from the same IP (via X-Forwarded-For) -> 3rd IP hit, succeeds
    const thirdRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:95479`, {
        headers: {
          "x-api-key": key2.key,
          "x-forwarded-for": "198.51.100.5, 10.0.0.1",
        },
      }),
    );
    expect(thirdRes.status).toBe(200);

    // 4th read from the same IP via Key 2 hits the IP cap -> 429 with scope "ip"
    const blockedIp = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:95479`, {
        headers: {
          "x-api-key": key2.key,
          "cf-connecting-ip": "198.51.100.5",
        },
      }),
    );
    expect(blockedIp.status).toBe(429);
    expect(blockedIp.headers.get("retry-after")).toBe("45");
    expect(await blockedIp.json()).toMatchObject({
      error: "RATE_LIMITED",
      scope: "ip",
      retryAfterSeconds: 45,
    });

    // Same Key 2 from a different IP still succeeds
    const otherIpRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:95479`, {
        headers: {
          "x-api-key": key2.key,
          "cf-connecting-ip": "198.51.100.99",
        },
      }),
    );
    expect(otherIpRes.status).toBe(200);
  });

  test("wires Cloudflare RATE_LIMITER_READ_KEY and RATE_LIMITER_READ_IP bindings in default Worker fetch entrypoint", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const outbound = createFakeOutboundClient({
      fetchExternal: createCatalogStubHandler(),
    });
    const setupApp = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      adapterRegistry: createAdapterRegistry(),
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });
    await seedConfirmedMedia(setupApp, testDb, outbound);

    const user = await signUpUser(setupApp, outbound, {
      email: "worker-rl@example.com",
      password: "StrongPassword123!",
      name: "Worker Reader",
    });
    const readKey = await createApiKey(setupApp, user.cookie, { name: "Worker Read Key" });

    const keyBinding = createInMemoryRateLimiter({ limit: 1, periodSeconds: 60 });
    const ipBinding = createInMemoryRateLimiter({ limit: 10, periodSeconds: 60 });

    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;

    const hyperdrive = { connectionString: testDb.connectionString } as Hyperdrive;
    const workerEnv = {
      HYPERDRIVE_READ: hyperdrive,
      HYPERDRIVE_WRITE: hyperdrive,
      AUTH_SECRET: TEST_AUTH_SECRET,
      API_BASE_URL: TEST_BASE_URL,
      RATE_LIMITER_READ_KEY: keyBinding,
      RATE_LIMITER_READ_IP: ipBinding,
      RATE_LIMIT_READ_RETRY_AFTER_SECONDS: "10",
    };

    const first = await worker.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:95479`, {
        headers: { "x-api-key": readKey.key, "cf-connecting-ip": "203.0.113.55" },
      }),
      workerEnv,
      ctx,
    );
    expect(first.status).toBe(200);

    const second = await worker.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:95479`, {
        headers: { "x-api-key": readKey.key, "cf-connecting-ip": "203.0.113.55" },
      }),
      workerEnv,
      ctx,
    );
    await Promise.all(pending);

    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("10");
    expect(await second.json()).toMatchObject({
      error: "RATE_LIMITED",
      scope: "api_key",
      retryAfterSeconds: 10,
    });
  });

  test("enforces hourly submission limit per account across multiple API keys and session with rolling-window Retry-After", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    let currentTime = new Date("2026-11-23T12:00:00.000Z");
    const outbound = createFakeOutboundClient({
      fetchExternal: createCatalogStubHandler(),
    });
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => currentTime,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });

    const contributor = await signUpUser(app, outbound, {
      email: "quota-user@example.com",
      password: "StrongPassword123!",
      name: "Quota Contributor",
    });
    const otherUser = await signUpUser(app, outbound, {
      email: "other-quota-user@example.com",
      password: "StrongPassword123!",
      name: "Other Contributor",
    });

    const keyA = await createApiKey(app, contributor.cookie, { name: "Key A", canSubmit: true });
    const keyB = await createApiKey(app, contributor.cookie, { name: "Key B", canSubmit: true });
    const otherKey = await createApiKey(app, otherUser.cookie, {
      name: "Other Key",
      canSubmit: true,
    });

    const submitPayload = (nativeId: string) =>
      JSON.stringify({
        targetExternalKey: "tmdb:tv:95479",
        namespace: "bilibili",
        nativeId,
        variantDescription: "原声",
        segments: [
          { season: 1, episodeStart: 1, episodeEnd: 12, targetEpisodeStart: 1, baseline: "tmdb" },
        ],
      });

    // 1st submission at 12:00:00Z via Key A
    const sub1 = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": keyA.key },
        body: submitPayload("ss10001"),
      }),
    );
    expect(sub1.status).toBe(201);

    // Advance 10 minutes to 12:10:00Z; submit 2 more via Key A and 2 via Key B (total 5)
    currentTime = new Date("2026-11-23T12:10:00.000Z");
    for (const [key, nativeId] of [
      [keyA.key, "ss10002"],
      [keyA.key, "ss10003"],
      [keyB.key, "ss10004"],
      [keyB.key, "ss10005"],
    ] as const) {
      const res = await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": key },
          body: submitPayload(nativeId),
        }),
      );
      expect(res.status).toBe(201);
    }

    // 6th submission via Key B is rejected with 429 and exact Retry-After = 3000s (50 min left for 12:00Z row)
    const blockedViaKeyB = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": keyB.key },
        body: submitPayload("ss10006"),
      }),
    );
    expect(blockedViaKeyB.status).toBe(429);
    expect(blockedViaKeyB.headers.get("retry-after")).toBe("3000");
    expect(await blockedViaKeyB.json()).toMatchObject({
      error: "SUBMISSION_RATE_LIMITED",
      scope: "account",
      limit: 5,
      used: 5,
      windowSeconds: 3600,
      retryAfterSeconds: 3000,
    });

    // Submitting via browser session cookie for the SAME account is also rejected!
    const blockedViaSession = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: contributor.cookie },
        body: submitPayload("ss10007"),
      }),
    );
    expect(blockedViaSession.status).toBe(429);
    expect(blockedViaSession.headers.get("retry-after")).toBe("3000");
    expect(await blockedViaSession.json()).toMatchObject({
      error: "SUBMISSION_RATE_LIMITED",
      scope: "account",
      retryAfterSeconds: 3000,
    });

    // A different account is unaffected
    const otherRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": otherKey.key },
        body: submitPayload("ss20001"),
      }),
    );
    expect(otherRes.status).toBe(201);

    // Advance clock to 13:00:00Z -> oldest submission (12:00:00Z) aged out of rolling 1h window -> 1 slot opens
    currentTime = new Date("2026-11-23T13:00:00.000Z");
    const recovered = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": keyB.key },
        body: submitPayload("ss10008"),
      }),
    );
    expect(recovered.status).toBe(201);

    // Immediately attempting a 7th fails with Retry-After = 600s (until 12:10:00Z batch ages out at 13:10:00Z)
    const blockedAgain = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": keyA.key },
        body: submitPayload("ss10009"),
      }),
    );
    expect(blockedAgain.status).toBe(429);
    expect(blockedAgain.headers.get("retry-after")).toBe("600");
    expect(await blockedAgain.json()).toMatchObject({
      error: "SUBMISSION_RATE_LIMITED",
      retryAfterSeconds: 600,
    });
  });

  test("prevents concurrent submissions from exceeding the account hourly limit via PostgreSQL advisory transaction locks", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const outbound = createFakeOutboundClient({
      fetchExternal: createCatalogStubHandler(),
    });
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      adapterRegistry: createAdapterRegistry(),
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });

    const user = await signUpUser(app, outbound, {
      email: "concurrent-quota@example.com",
      password: "StrongPassword123!",
      name: "Concurrent Submitter",
    });
    const keyA = await createApiKey(app, user.cookie, { name: "Parallel Key A", canSubmit: true });
    const keyB = await createApiKey(app, user.cookie, { name: "Parallel Key B", canSubmit: true });

    // Fire 10 parallel POST /v1/change-requests alternating between Key A and Key B
    const responses = await Promise.all(
      Array.from({ length: 10 }, async (_, idx) =>
        app.fetch(
          new Request(`${TEST_BASE_URL}/v1/change-requests`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": idx % 2 === 0 ? keyA.key : keyB.key,
            },
            body: JSON.stringify({
              targetExternalKey: "tmdb:tv:95479",
              namespace: "bilibili",
              nativeId: `ss9000${idx}`,
              variantDescription: "原声",
              segments: [
                {
                  season: 1,
                  episodeStart: 1,
                  episodeEnd: 12,
                  targetEpisodeStart: 1,
                  baseline: "tmdb",
                },
              ],
            }),
          }),
        ),
      ),
    );

    const createdResponses = responses.filter((res) => res.status === 201);
    const rateLimitedResponses = responses.filter((res) => res.status === 429);

    expect(createdResponses).toHaveLength(5);
    expect(rateLimitedResponses).toHaveLength(5);

    for (const res of rateLimitedResponses) {
      const retryAfter = Number(res.headers.get("retry-after"));
      expect(Number.isInteger(retryAfter)).toBe(true);
      expect(retryAfter).toBeGreaterThanOrEqual(1);
      expect(retryAfter).toBeLessThanOrEqual(3600);
      expect(await res.json()).toMatchObject({
        error: "SUBMISSION_RATE_LIMITED",
        scope: "account",
        limit: 5,
      });
    }

    const dbRows = await testDb.readDb
      .selectFrom("change_requests")
      .select("id")
      .where("submitter_user_id", "=", user.userId)
      .execute();
    expect(dbRows).toHaveLength(5);
  });

  test("scales hourly submission quota with user reputation and reviewer role without bypassing review", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const outbound = createFakeOutboundClient({
      fetchExternal: createCatalogStubHandler(),
    });
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      adapterRegistry: createAdapterRegistry(),
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });

    const user = await signUpUser(app, outbound, {
      email: "reputation-user@example.com",
      password: "StrongPassword123!",
      name: "Growing Contributor",
    });
    const reviewer = await signUpUser(app, outbound, {
      email: "reviewer-quota@example.com",
      password: "StrongPassword123!",
      name: "Reviewer",
    });
    await testDb.writeDb
      .updateTable("user")
      .set({ role: "reviewer" })
      .where("id", "=", reviewer.userId)
      .execute();

    const userKey = await createApiKey(app, user.cookie, { name: "User Submit", canSubmit: true });
    const reviewerKey = await createApiKey(app, reviewer.cookie, {
      name: "Reviewer Submit",
      canSubmit: true,
    });

    const submitAs = (key: string, nativeId: string) =>
      app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": key },
          body: JSON.stringify({
            targetExternalKey: "tmdb:tv:95479",
            namespace: "tencent",
            nativeId,
            variantDescription: "原声",
            segments: [
              {
                season: 1,
                episodeStart: 1,
                episodeEnd: 12,
                targetEpisodeStart: 1,
                baseline: "tmdb",
              },
            ],
          }),
        }),
      );

    // At reputation = 0, limit is 5/hr
    for (let i = 1; i <= 5; i++) {
      expect((await submitAs(userKey.key, `ss3000${i}`)).status).toBe(201);
    }
    const blockedAtRep0 = await submitAs(userKey.key, "ss30006");
    expect(blockedAtRep0.status).toBe(429);
    expect(await blockedAtRep0.json()).toMatchObject({
      error: "SUBMISSION_RATE_LIMITED",
      limit: 5,
      used: 5,
    });

    // Raising reputation to 10 raises hourly limit to 20/hr (tier 2)
    await testDb.writeDb
      .updateTable("user")
      .set({ reputation: 10 })
      .where("id", "=", user.userId)
      .execute();

    for (let i = 6; i <= 20; i++) {
      const res = await submitAs(userKey.key, `ss300${i}`);
      expect(res.status).toBe(201);
      // Reputation only affects quota — submissions still go through normal review / evidence gate
      const body = (await res.json()) as { changeRequest: { status: string } };
      expect(body.changeRequest.status).toBe("needs_review");
    }

    const blockedAtRep10 = await submitAs(userKey.key, "ss30021");
    expect(blockedAtRep10.status).toBe(429);
    expect(await blockedAtRep10.json()).toMatchObject({
      error: "SUBMISSION_RATE_LIMITED",
      limit: 20,
      used: 20,
    });

    // Raising reputation to 50 unlocks tier 3 (100/hr)
    await testDb.writeDb
      .updateTable("user")
      .set({ reputation: 50 })
      .where("id", "=", user.userId)
      .execute();

    const allowedAtRep50 = await submitAs(userKey.key, "ss30021");
    expect(allowedAtRep50.status).toBe(201);
    expect(
      ((await allowedAtRep50.json()) as { changeRequest: { status: string } }).changeRequest.status,
    ).toBe("needs_review");

    // Reviewers with reputation = 0 get elevated hourly quota per config
    for (let i = 1; i <= 7; i++) {
      expect((await submitAs(reviewerKey.key, `ss4000${i}`)).status).toBe(201);
    }
  });

  test("applies custom ApiConfig overrides (submitBaseHourlyLimit, readRetryAfterSeconds, reputationTiers) and Worker env vars immediately", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const outbound = createFakeOutboundClient({
      fetchExternal: createCatalogStubHandler(),
    });

    // 1. Custom ApiConfig with submitBaseHourlyLimit + readKeyLimit + readRetryAfterSeconds
    const baseOverrideApp = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      adapterRegistry: createAdapterRegistry(),
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        tmdb: { accessToken: "test-tmdb-token" },
        submitBaseHourlyLimit: 2,
        readKeyLimit: 2,
        readRetryAfterSeconds: 15,
      },
    });

    await seedConfirmedMedia(baseOverrideApp, testDb, outbound);

    const user = await signUpUser(baseOverrideApp, outbound, {
      email: "override-user@example.com",
      password: "StrongPassword123!",
      name: "Override User",
    });
    const submitKey = await createApiKey(baseOverrideApp, user.cookie, {
      name: "Override Key",
      canSubmit: true,
    });

    // Read limit override (2) + custom Retry-After (15)
    for (let i = 0; i < 2; i++) {
      const res = await baseOverrideApp.fetch(
        new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:95479`, {
          headers: { "x-api-key": submitKey.key, "cf-connecting-ip": "203.0.113.70" },
        }),
      );
      expect(res.status).toBe(200);
    }
    const readLimited = await baseOverrideApp.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:95479`, {
        headers: { "x-api-key": submitKey.key, "cf-connecting-ip": "203.0.113.70" },
      }),
    );
    expect(readLimited.status).toBe(429);
    expect(readLimited.headers.get("retry-after")).toBe("15");
    expect(await readLimited.json()).toMatchObject({
      error: "RATE_LIMITED",
      scope: "api_key",
      retryAfterSeconds: 15,
    });

    // Submit base hourly limit override (2)
    const makeSubmit = (appInstance: ReturnType<typeof createApiApp>, nativeId: string) =>
      appInstance.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": submitKey.key },
          body: JSON.stringify({
            targetExternalKey: "tmdb:tv:95479",
            namespace: "tencent",
            nativeId,
            variantDescription: "原声",
            segments: [
              {
                season: 1,
                episodeStart: 1,
                episodeEnd: 12,
                targetEpisodeStart: 1,
                baseline: "tmdb",
              },
            ],
          }),
        }),
      );

    expect((await makeSubmit(baseOverrideApp, "ss50001")).status).toBe(201);
    expect((await makeSubmit(baseOverrideApp, "ss50002")).status).toBe(201);
    const thirdBlocked = await makeSubmit(baseOverrideApp, "ss50003");
    expect(thirdBlocked.status).toBe(429);
    expect(await thirdBlocked.json()).toMatchObject({
      error: "SUBMISSION_RATE_LIMITED",
      limit: 2,
      used: 2,
    });

    // 2. Custom reputationTiers override immediately takes effect for the same DB state
    await testDb.writeDb
      .updateTable("user")
      .set({ reputation: 5 })
      .where("id", "=", user.userId)
      .execute();

    const customTiersApp = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      adapterRegistry: createAdapterRegistry(),
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        tmdb: { accessToken: "test-tmdb-token" },
        reputationTiers: [
          { minReputation: 0, maxPerHour: 1 },
          { minReputation: 5, maxPerHour: 4 },
        ],
      },
    });

    // User already has 2 submissions; custom tier at reputation 5 allows 4/hr -> 3rd & 4th succeed, 5th fails
    expect((await makeSubmit(customTiersApp, "ss50003")).status).toBe(201);
    expect((await makeSubmit(customTiersApp, "ss50004")).status).toBe(201);
    const fifthBlocked = await makeSubmit(customTiersApp, "ss50005");
    expect(fifthBlocked.status).toBe(429);
    expect(await fifthBlocked.json()).toMatchObject({
      error: "SUBMISSION_RATE_LIMITED",
      limit: 4,
      used: 4,
    });

    // 3. Worker env var overrides (`RATE_LIMIT_REPUTATION_TIERS`) work via default Worker entrypoint
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;
    const hyperdrive = { connectionString: testDb.connectionString } as Hyperdrive;

    const workerSubmit = await worker.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": submitKey.key },
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:95479",
          namespace: "tencent",
          nativeId: "mzc002000050005",
          variantDescription: "原声",
          segments: [
            {
              season: 1,
              episodeStart: 1,
              episodeEnd: 12,
              targetEpisodeStart: 1,
              baseline: "tmdb",
            },
          ],
        }),
      }),
      {
        HYPERDRIVE_READ: hyperdrive,
        HYPERDRIVE_WRITE: hyperdrive,
        AUTH_SECRET: TEST_AUTH_SECRET,
        API_BASE_URL: TEST_BASE_URL,
        RATE_LIMIT_REPUTATION_TIERS: JSON.stringify([
          { minReputation: 0, maxPerHour: 2 },
          { minReputation: 5, maxPerHour: 6 },
        ]),
      },
      ctx,
    );
    await Promise.all(pending);
    expect(workerSubmit.status).toBe(201);
  });
});
