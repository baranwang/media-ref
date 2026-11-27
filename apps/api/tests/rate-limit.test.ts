import type { ExecutionContext, Hyperdrive } from "@cloudflare/workers-types";
import { fromProtoChangeRequestStatus, toProtoSegmentInput } from "@media-ref/client";
import {
  createAdapterRegistry,
  createFakeOutboundClient,
  type ExternalHttpRequest,
} from "@media-ref/core";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, describe, expect, test } from "vite-plus/test";
import worker from "../src/index.ts";
import { createApiApp, createInMemoryRateLimiter } from "../src/lib.ts";
import {
  createRpcClients,
  expectRpcError,
  issueApiKeyRpc,
  mediaRef,
  signUpUser,
  TEST_BASE_URL,
  approveInCore,
} from "./rpc-helpers.ts";

const TEST_AUTH_SECRET = "test-secret-for-media-ref-rate-limit-integration-tests-0123456789";

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

  const ownerRpc = createRpcClients(app, { cookie: owner.cookie });
  const created = await ownerRpc.changeRequest.createChangeRequest({
    target: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
    namespace: "bilibili",
    nativeId: "ss34430",
    variantDescription: "原声",
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

  await approveInCore({ db: testDb.writeDb, outbound }, { id: created.changeRequest!.id });
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
    const keyA = await issueApiKeyRpc(app, user.cookie, { name: "Key A" });
    const keyB = await issueApiKeyRpc(app, user.cookie, { name: "Key B" });

    const rpcA = createRpcClients(app, {
      apiKey: keyA.key,
      headers: { "cf-connecting-ip": "203.0.113.10" },
    });
    const rpcB = createRpcClients(app, {
      apiKey: keyB.key,
      headers: { "cf-connecting-ip": "203.0.113.20" },
    });

    // First 3 requests for Key A succeed
    for (let i = 0; i < 3; i++) {
      const res = await rpcA.media.getMedia({ ref: mediaRef({ tmdb: { type: "tv", id: 95479 } }) });
      expect(res.document?.media?.id).toBeTruthy();
    }

    // 4th request for Key A hits per-key rate limit -> 429 with Retry-After
    const blockedA = await expectRpcError(
      rpcA.media.getMedia({ ref: mediaRef({ tmdb: { type: "tv", id: 95479 } }) }),
    );
    expect(blockedA.status).toBe(429);
    expect(blockedA.connectError.metadata.get("retry-after")).toBe("60");
    expect(blockedA).toMatchObject({
      code: "RATE_LIMITED",
      scope: "api_key",
      retryAfterSeconds: 60,
    });

    // Different API key from a different IP still succeeds
    expect(
      (await rpcB.media.getMedia({ ref: mediaRef({ tmdb: { type: "tv", id: 95479 } }) })).document
        ?.media?.id,
    ).toBeTruthy();

    // After the 60s fixed window rolls over, Key A succeeds again
    currentTime = new Date(currentTime.getTime() + 60_000);
    expect(
      (await rpcA.media.getMedia({ ref: mediaRef({ tmdb: { type: "tv", id: 95479 } }) })).document
        ?.media?.id,
    ).toBeTruthy();
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
    const key1 = await issueApiKeyRpc(app, user1.cookie, { name: "Key 1" });
    const key2 = await issueApiKeyRpc(app, user2.cookie, { name: "Key 2" });

    // 2 reads via Key 1 from 198.51.100.5
    const key1Rpc = createRpcClients(app, {
      apiKey: key1.key,
      headers: { "cf-connecting-ip": "198.51.100.5" },
    });
    for (let i = 0; i < 2; i++) {
      expect(
        (await key1Rpc.media.getMedia({ ref: mediaRef({ tmdb: { type: "tv", id: 95479 } }) }))
          .document,
      ).toBeDefined();
    }

    // 1 read via Key 2 from the same IP (via X-Forwarded-For) -> 3rd IP hit, succeeds
    const key2XffRpc = createRpcClients(app, {
      apiKey: key2.key,
      headers: { "x-forwarded-for": "198.51.100.5, 10.0.0.1" },
    });
    expect(
      (await key2XffRpc.media.getMedia({ ref: mediaRef({ tmdb: { type: "tv", id: 95479 } }) }))
        .document,
    ).toBeDefined();

    // 4th read from the same IP via Key 2 hits the IP cap -> 429 with scope "ip"
    const key2SameIpRpc = createRpcClients(app, {
      apiKey: key2.key,
      headers: { "cf-connecting-ip": "198.51.100.5" },
    });
    const blockedIp = await expectRpcError(
      key2SameIpRpc.media.getMedia({ ref: mediaRef({ tmdb: { type: "tv", id: 95479 } }) }),
    );
    expect(blockedIp.status).toBe(429);
    expect(blockedIp.connectError.metadata.get("retry-after")).toBe("45");
    expect(blockedIp).toMatchObject({
      code: "RATE_LIMITED",
      scope: "ip",
      retryAfterSeconds: 45,
    });

    // Same Key 2 from a different IP still succeeds
    const key2OtherIpRpc = createRpcClients(app, {
      apiKey: key2.key,
      headers: { "cf-connecting-ip": "198.51.100.99" },
    });
    expect(
      (await key2OtherIpRpc.media.getMedia({ ref: mediaRef({ tmdb: { type: "tv", id: 95479 } }) }))
        .document,
    ).toBeDefined();
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
    const readKey = await issueApiKeyRpc(setupApp, user.cookie, { name: "Worker Read Key" });

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

    const workerRpc = createRpcClients((req) => worker.fetch(req, workerEnv, ctx), {
      apiKey: readKey.key,
      headers: { "cf-connecting-ip": "203.0.113.55" },
    });

    const first = await workerRpc.media.getMedia({
      ref: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
    });
    expect(first.document?.media?.id).toBeTruthy();

    const secondErr = await expectRpcError(
      workerRpc.media.getMedia({ ref: mediaRef({ tmdb: { type: "tv", id: 95479 } }) }),
    );
    await Promise.all(pending);

    expect(secondErr.status).toBe(429);
    expect(secondErr.connectError.metadata.get("retry-after")).toBe("10");
    expect(secondErr).toMatchObject({
      code: "RATE_LIMITED",
      scope: "api_key",
      retryAfterSeconds: 10,
    });
  });

  test("persists module-scoped fallback read rate-limit buckets across requests when CF bindings are omitted", async () => {
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
      email: "worker-fallback-rl@example.com",
      password: "StrongPassword123!",
      name: "Fallback Reader",
    });
    const readKey = await issueApiKeyRpc(setupApp, user.cookie, { name: "Fallback Key" });

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
      RATE_LIMIT_READ_KEY_LIMIT: "2",
      RATE_LIMIT_READ_IP_LIMIT: "100",
      RATE_LIMIT_READ_PERIOD_SECONDS: "60",
      RATE_LIMIT_READ_RETRY_AFTER_SECONDS: "12",
    };

    const workerRpc = createRpcClients((req) => worker.fetch(req, workerEnv, ctx), {
      apiKey: readKey.key,
      headers: { "cf-connecting-ip": "203.0.113.88" },
    });

    expect(
      (await workerRpc.media.getMedia({ ref: mediaRef({ tmdb: { type: "tv", id: 95479 } }) }))
        .document,
    ).toBeDefined();
    expect(
      (await workerRpc.media.getMedia({ ref: mediaRef({ tmdb: { type: "tv", id: 95479 } }) }))
        .document,
    ).toBeDefined();
    const blocked = await expectRpcError(
      workerRpc.media.getMedia({ ref: mediaRef({ tmdb: { type: "tv", id: 95479 } }) }),
    );
    await Promise.all(pending);

    expect(blocked.status).toBe(429);
    expect(blocked.code).toBe("RATE_LIMITED");
    expect(blocked.scope).toBe("api_key");
    expect(blocked.retryAfterSeconds).toBe(12);
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

    const keyA = await issueApiKeyRpc(app, contributor.cookie, { name: "Key A", canSubmit: true });
    const keyB = await issueApiKeyRpc(app, contributor.cookie, { name: "Key B", canSubmit: true });
    const otherKey = await issueApiKeyRpc(app, otherUser.cookie, {
      name: "Other Key",
      canSubmit: true,
    });

    const rpcA = createRpcClients(app, { apiKey: keyA.key });
    const rpcB = createRpcClients(app, { apiKey: keyB.key });
    const sessionRpc = createRpcClients(app, { cookie: contributor.cookie });
    const otherRpc = createRpcClients(app, { apiKey: otherKey.key });

    const submitPayload = (nativeId: string) => ({
      target: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
      namespace: "bilibili",
      nativeId,
      variantDescription: "原声",
      segments: [
        toProtoSegmentInput({
          season: 1,
          episodeStart: 1,
          episodeEnd: 12,
          targetEpisodeStart: 1,
          baseline: "tmdb",
        }),
      ],
    });

    // 1st submission at 12:00:00Z via Key A
    expect(
      (await rpcA.changeRequest.createChangeRequest(submitPayload("ss10001"))).changeRequest,
    ).toBeDefined();

    // Advance 10 minutes to 12:10:00Z; submit 2 more via Key A and 2 via Key B (total 5)
    currentTime = new Date("2026-11-23T12:10:00.000Z");
    for (const [rpc, nativeId] of [
      [rpcA, "ss10002"],
      [rpcA, "ss10003"],
      [rpcB, "ss10004"],
      [rpcB, "ss10005"],
    ] as const) {
      expect(
        (await rpc.changeRequest.createChangeRequest(submitPayload(nativeId))).changeRequest,
      ).toBeDefined();
    }

    // 6th submission via Key B is rejected with 429 and exact Retry-After = 3000s (50 min left for 12:00Z row)
    const blockedViaKeyB = await expectRpcError(
      rpcB.changeRequest.createChangeRequest(submitPayload("ss10006")),
    );
    expect(blockedViaKeyB.status).toBe(429);
    expect(blockedViaKeyB.connectError.metadata.get("retry-after")).toBe("3000");
    expect(blockedViaKeyB).toMatchObject({
      code: "SUBMISSION_RATE_LIMITED",
      scope: "account",
      limit: 5,
      used: 5,
      windowSeconds: 3600,
      retryAfterSeconds: 3000,
    });

    // Submitting via browser session cookie for the SAME account is also rejected!
    const blockedViaSession = await expectRpcError(
      sessionRpc.changeRequest.createChangeRequest(submitPayload("ss10007")),
    );
    expect(blockedViaSession.status).toBe(429);
    expect(blockedViaSession.connectError.metadata.get("retry-after")).toBe("3000");
    expect(blockedViaSession).toMatchObject({
      code: "SUBMISSION_RATE_LIMITED",
      scope: "account",
      retryAfterSeconds: 3000,
    });

    // A different account is unaffected
    expect(
      (await otherRpc.changeRequest.createChangeRequest(submitPayload("ss20001"))).changeRequest,
    ).toBeDefined();

    // Advance clock to 13:00:00Z -> oldest submission (12:00:00Z) aged out of rolling 1h window -> 1 slot opens
    currentTime = new Date("2026-11-23T13:00:00.000Z");
    expect(
      (await rpcB.changeRequest.createChangeRequest(submitPayload("ss10008"))).changeRequest,
    ).toBeDefined();

    // Immediately attempting a 7th fails with Retry-After = 600s (until 12:10:00Z batch ages out at 13:10:00Z)
    const blockedAgain = await expectRpcError(
      rpcA.changeRequest.createChangeRequest(submitPayload("ss10009")),
    );
    expect(blockedAgain.status).toBe(429);
    expect(blockedAgain.connectError.metadata.get("retry-after")).toBe("600");
    expect(blockedAgain).toMatchObject({
      code: "SUBMISSION_RATE_LIMITED",
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
    const keyA = await issueApiKeyRpc(app, user.cookie, {
      name: "Parallel Key A",
      canSubmit: true,
    });
    const keyB = await issueApiKeyRpc(app, user.cookie, {
      name: "Parallel Key B",
      canSubmit: true,
    });
    const rpcA = createRpcClients(app, { apiKey: keyA.key });
    const rpcB = createRpcClients(app, { apiKey: keyB.key });

    // Fire 10 parallel CreateChangeRequest RPCs alternating between Key A and Key B
    const results = await Promise.all(
      Array.from({ length: 10 }, async (_, idx) => {
        const rpc = idx % 2 === 0 ? rpcA : rpcB;
        try {
          await rpc.changeRequest.createChangeRequest({
            target: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
            namespace: "bilibili",
            nativeId: `ss9000${idx}`,
            variantDescription: "原声",
            segments: [
              toProtoSegmentInput({
                season: 1,
                episodeStart: 1,
                episodeEnd: 12,
                targetEpisodeStart: 1,
                baseline: "tmdb",
              }),
            ],
          });
          return { ok: true as const };
        } catch (err) {
          return { ok: false as const, err: await expectRpcError(Promise.reject(err)) };
        }
      }),
    );

    const createdResults = results.filter((r) => r.ok);
    const rateLimitedResults = results.filter((r) => !r.ok);

    expect(createdResults).toHaveLength(5);
    expect(rateLimitedResults).toHaveLength(5);

    for (const result of rateLimitedResults) {
      if (result.ok) continue;
      expect(result.err.status).toBe(429);
      const retryAfter = Number(result.err.connectError.metadata.get("retry-after"));
      expect(Number.isInteger(retryAfter)).toBe(true);
      expect(retryAfter).toBeGreaterThanOrEqual(1);
      expect(retryAfter).toBeLessThanOrEqual(3600);
      expect(result.err).toMatchObject({
        code: "SUBMISSION_RATE_LIMITED",
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

    const userKey = await issueApiKeyRpc(app, user.cookie, {
      name: "User Submit",
      canSubmit: true,
    });
    const reviewerKey = await issueApiKeyRpc(app, reviewer.cookie, {
      name: "Reviewer Submit",
      canSubmit: true,
    });

    const userRpc = createRpcClients(app, { apiKey: userKey.key });
    const reviewerRpc = createRpcClients(app, { apiKey: reviewerKey.key });

    const submitAs = (rpc: ReturnType<typeof createRpcClients>, nativeId: string) =>
      rpc.changeRequest.createChangeRequest({
        target: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
        namespace: "tencent",
        nativeId,
        variantDescription: "原声",
        segments: [
          toProtoSegmentInput({
            season: 1,
            episodeStart: 1,
            episodeEnd: 12,
            targetEpisodeStart: 1,
            baseline: "tmdb",
          }),
        ],
      });

    // At reputation = 0, limit is 5/hr
    for (let i = 1; i <= 5; i++) {
      expect((await submitAs(userRpc, `ss3000${i}`)).changeRequest).toBeDefined();
    }
    const blockedAtRep0 = await expectRpcError(submitAs(userRpc, "ss30006"));
    expect(blockedAtRep0.status).toBe(429);
    expect(blockedAtRep0).toMatchObject({
      code: "SUBMISSION_RATE_LIMITED",
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
      const res = await submitAs(userRpc, `ss300${i}`);
      // Reputation only affects quota — submissions still go through normal review / evidence gate
      expect(fromProtoChangeRequestStatus(res.changeRequest!.status)).toBe("needs_review");
    }

    const blockedAtRep10 = await expectRpcError(submitAs(userRpc, "ss30021"));
    expect(blockedAtRep10.status).toBe(429);
    expect(blockedAtRep10).toMatchObject({
      code: "SUBMISSION_RATE_LIMITED",
      limit: 20,
      used: 20,
    });

    // Raising reputation to 50 unlocks tier 3 (100/hr)
    await testDb.writeDb
      .updateTable("user")
      .set({ reputation: 50 })
      .where("id", "=", user.userId)
      .execute();

    const allowedAtRep50 = await submitAs(userRpc, "ss30021");
    expect(fromProtoChangeRequestStatus(allowedAtRep50.changeRequest!.status)).toBe("needs_review");

    // Reviewers with reputation = 0 get elevated hourly quota per config
    for (let i = 1; i <= 7; i++) {
      expect((await submitAs(reviewerRpc, `ss4000${i}`)).changeRequest).toBeDefined();
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
    const submitKey = await issueApiKeyRpc(baseOverrideApp, user.cookie, {
      name: "Override Key",
      canSubmit: true,
    });

    const baseRpc = createRpcClients(baseOverrideApp, {
      apiKey: submitKey.key,
      headers: { "cf-connecting-ip": "203.0.113.70" },
    });

    // Read limit override (2) + custom Retry-After (15)
    for (let i = 0; i < 2; i++) {
      expect(
        (await baseRpc.media.getMedia({ ref: mediaRef({ tmdb: { type: "tv", id: 95479 } }) }))
          .document,
      ).toBeDefined();
    }
    const readLimited = await expectRpcError(
      baseRpc.media.getMedia({ ref: mediaRef({ tmdb: { type: "tv", id: 95479 } }) }),
    );
    expect(readLimited.status).toBe(429);
    expect(readLimited.connectError.metadata.get("retry-after")).toBe("15");
    expect(readLimited).toMatchObject({
      code: "RATE_LIMITED",
      scope: "api_key",
      retryAfterSeconds: 15,
    });

    // Submit base hourly limit override (2)
    const makeSubmit = (appInstance: ReturnType<typeof createApiApp>, nativeId: string) =>
      createRpcClients(appInstance, { apiKey: submitKey.key }).changeRequest.createChangeRequest({
        target: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
        namespace: "tencent",
        nativeId,
        variantDescription: "原声",
        segments: [
          toProtoSegmentInput({
            season: 1,
            episodeStart: 1,
            episodeEnd: 12,
            targetEpisodeStart: 1,
            baseline: "tmdb",
          }),
        ],
      });

    expect((await makeSubmit(baseOverrideApp, "ss50001")).changeRequest).toBeDefined();
    expect((await makeSubmit(baseOverrideApp, "ss50002")).changeRequest).toBeDefined();
    const thirdBlocked = await expectRpcError(makeSubmit(baseOverrideApp, "ss50003"));
    expect(thirdBlocked.status).toBe(429);
    expect(thirdBlocked).toMatchObject({
      code: "SUBMISSION_RATE_LIMITED",
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
    expect((await makeSubmit(customTiersApp, "ss50003")).changeRequest).toBeDefined();
    expect((await makeSubmit(customTiersApp, "ss50004")).changeRequest).toBeDefined();
    const fifthBlocked = await expectRpcError(makeSubmit(customTiersApp, "ss50005"));
    expect(fifthBlocked.status).toBe(429);
    expect(fifthBlocked).toMatchObject({
      code: "SUBMISSION_RATE_LIMITED",
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
    const workerEnv = {
      HYPERDRIVE_READ: hyperdrive,
      HYPERDRIVE_WRITE: hyperdrive,
      AUTH_SECRET: TEST_AUTH_SECRET,
      API_BASE_URL: TEST_BASE_URL,
      RATE_LIMIT_REPUTATION_TIERS: JSON.stringify([
        { minReputation: 0, maxPerHour: 2 },
        { minReputation: 5, maxPerHour: 6 },
      ]),
    };

    const workerSubmit = await createRpcClients((req) => worker.fetch(req, workerEnv, ctx), {
      apiKey: submitKey.key,
    }).changeRequest.createChangeRequest({
      target: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
      namespace: "tencent",
      nativeId: "mzc002000050005",
      variantDescription: "原声",
      segments: [
        toProtoSegmentInput({
          season: 1,
          episodeStart: 1,
          episodeEnd: 12,
          targetEpisodeStart: 1,
          baseline: "tmdb",
        }),
      ],
    });
    await Promise.all(pending);
    expect(workerSubmit.changeRequest?.id).toBeTruthy();
  });
});
