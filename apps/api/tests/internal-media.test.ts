import type { ExecutionContext, Hyperdrive, RateLimit } from "@cloudflare/workers-types";
import type { MediaDocument } from "@media-ref/client";
import {
  createFakeOutboundClient,
  type EmailMessage,
  type ExternalHttpRequest,
} from "@media-ref/core";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, describe, expect, test } from "vite-plus/test";
import worker, {
  createApiApp,
  createInMemoryIpRateLimiter,
  createInternalMediaApp,
  InternalMediaEntrypoint,
} from "../src/index.ts";

const TEST_BASE_URL = "https://api.mediaref.org";
const INTERNAL_BASE_URL = "https://internal.mediaref.org";
const TEST_AUTH_SECRET = "test-secret-for-media-ref-internal-media-tests-0123456789abcdef";

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
  input: { email: string; password: string; name: string; verify?: boolean },
): Promise<{ userId: string; cookie: string }> {
  const emailsBefore = outbound.sentEmails.length;
  const signUpRes = await app.fetch(
    new Request(`${TEST_BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: input.email,
        password: input.password,
        name: input.name,
      }),
    }),
  );
  expect(signUpRes.status).toBe(200);
  const signUpBody = (await signUpRes.json()) as { user: { id: string } };
  let cookie = extractCookieHeader(signUpRes);

  if (input.verify) {
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
            seasons: [
              { season_number: 0, episode_count: 5, air_date: "2020-12-26" },
              { season_number: 1, episode_count: 47, air_date: "2020-10-03" },
            ],
            external_ids: {
              imdb_id: "tt12343534",
              tvdb_id: 377543,
            },
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
      if (request.url.includes("/search/tmdb/95479?type=show")) {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          url: request.url,
          body: JSON.stringify([
            {
              type: "show",
              score: 1000,
              show: {
                title: "Jujutsu Kaisen",
                year: 2020,
                ids: {
                  trakt: 159384,
                  slug: "jujutsu-kaisen",
                  tvdb: 377543,
                  imdb: "tt12343534",
                  tmdb: 95479,
                },
              },
            },
          ]),
        };
      }
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

async function seedConfirmedMediaFixture(testDb: TestDbHandle) {
  const outbound = createFakeOutboundClient({
    fetchExternal: createCatalogStubHandler(),
  });

  const publicApp = createApiApp({
    dbRead: testDb.readDb,
    dbWrite: testDb.writeDb,
    outbound,
    config: {
      baseUrl: TEST_BASE_URL,
      authSecret: TEST_AUTH_SECRET,
      tmdb: {
        accessToken: "test-tmdb-token",
        traktClientId: "test-trakt-client-id",
      },
    },
  });

  const submitter = await signUpUser(publicApp, outbound, {
    email: "anon-fixture-submitter@example.com",
    password: "StrongPassword123!",
    name: "Submitter",
    verify: true,
  });
  const owner = await signUpUser(publicApp, outbound, {
    email: "anon-fixture-owner@example.com",
    password: "StrongPassword123!",
    name: "Owner",
    verify: true,
  });
  await testDb.writeDb
    .updateTable("user")
    .set({ role: "owner" })
    .where("id", "=", owner.userId)
    .execute();

  const submitKey = await createApiKey(publicApp, submitter.cookie, {
    name: "Submit Key",
    canSubmit: true,
  });
  const readKey = await createApiKey(publicApp, submitter.cookie, {
    name: "Read Key",
    canSubmit: false,
  });

  // Confirmed association: bilibili:ss34430 (S1 E1-24)
  const cr1Res = await publicApp.fetch(
    new Request(`${TEST_BASE_URL}/v1/change-requests`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": submitKey.key,
      },
      body: JSON.stringify({
        targetExternalKey: "tmdb:tv:95479",
        namespace: "bilibili",
        nativeId: "ss34430",
        variantDescription: "原声",
        segments: [
          {
            season: 1,
            episodeStart: 1,
            episodeEnd: 24,
            targetEpisodeStart: 1,
            baseline: "tmdb",
          },
        ],
      }),
    }),
  );
  expect(cr1Res.status).toBe(201);
  const cr1Body = (await cr1Res.json()) as { changeRequest: { id: string } };

  const approve1Res = await publicApp.fetch(
    new Request(
      `${TEST_BASE_URL}/v1/reviewer/change-requests/${cr1Body.changeRequest.id}/approve`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: owner.cookie,
        },
        body: JSON.stringify({ reason: "Verified S1 part 1" }),
      },
    ),
  );
  expect(approve1Res.status).toBe(200);
  const approve1Body = (await approve1Res.json()) as {
    mediaId: string;
    associationId: string;
  };

  // Rejected change request (must never appear in anonymous media response)
  const crRejectedRes = await publicApp.fetch(
    new Request(`${TEST_BASE_URL}/v1/change-requests`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": submitKey.key,
      },
      body: JSON.stringify({
        targetExternalKey: "tmdb:tv:95479",
        namespace: "tencent",
        nativeId: "mzc00200rejected",
        variantDescription: "原声",
        segments: [
          {
            season: 1,
            episodeStart: 1,
            episodeEnd: 24,
            targetEpisodeStart: 1,
            baseline: "tmdb",
          },
        ],
      }),
    }),
  );
  expect(crRejectedRes.status).toBe(201);
  const crRejectedBody = (await crRejectedRes.json()) as { changeRequest: { id: string } };

  const rejectRes = await publicApp.fetch(
    new Request(
      `${TEST_BASE_URL}/v1/reviewer/change-requests/${crRejectedBody.changeRequest.id}/reject`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: owner.cookie,
        },
        body: JSON.stringify({ reason: "Wrong collection" }),
      },
    ),
  );
  expect(rejectRes.status).toBe(200);

  // Seed unconfirmed & delisted associations directly in DB (must NOT be returned by internal anonymous read)
  const variant = await testDb.writeDb
    .selectFrom("variants")
    .select("id")
    .where("media_id", "=", approve1Body.mediaId)
    .where("platform", "=", "bilibili")
    .executeTakeFirstOrThrow();

  await testDb.writeDb
    .insertInto("associations")
    .values([
      {
        media_id: approve1Body.mediaId,
        namespace: "bilibili",
        native_id: "ss99991",
        variant_id: variant.id,
        status: "seed_unconfirmed",
        needs_review: false,
        locked: false,
      },
      {
        media_id: approve1Body.mediaId,
        namespace: "bilibili",
        native_id: "ss99992",
        variant_id: variant.id,
        status: "delisted",
        needs_review: false,
        locked: false,
      },
    ])
    .execute();

  return {
    publicApp,
    readKey: readKey.key,
    mediaId: approve1Body.mediaId,
    confirmedAssociationId: approve1Body.associationId,
  };
}

describe("API Worker internal anonymous single-media entrypoint (#25)", () => {
  const handles: TestDbHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop();
      if (handle) {
        await handle.cleanup();
      }
    }
  });

  test("public HTTP fetch returns 404 for /internal/media/:key even with a valid API key, while internal entrypoint returns confirmed MediaDocument without any API key", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const fixture = await seedConfirmedMediaFixture(testDb);

    // 1. Public Hono app MUST NOT expose /internal/media/:key (with or without API key)
    const publicAnonRes = await fixture.publicApp.fetch(
      new Request(`${TEST_BASE_URL}/internal/media/${fixture.mediaId}`),
    );
    expect(publicAnonRes.status).toBe(404);

    const publicKeyedRes = await fixture.publicApp.fetch(
      new Request(`${TEST_BASE_URL}/internal/media/tmdb:tv:95479`, {
        headers: { "x-api-key": fixture.readKey },
      }),
    );
    expect(publicKeyedRes.status).toBe(404);

    // 2. Default public Cloudflare Worker fetch MUST NOT expose /internal/media/:key
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;
    const hyperdrive = { connectionString: testDb.connectionString } as Hyperdrive;

    const workerPublicRes = await worker.fetch(
      new Request(`${TEST_BASE_URL}/internal/media/${fixture.mediaId}`, {
        headers: { "x-api-key": fixture.readKey },
      }),
      {
        HYPERDRIVE_READ: hyperdrive,
        HYPERDRIVE_WRITE: hyperdrive,
      },
      ctx,
    );
    await Promise.all(pending);
    expect(workerPublicRes.status).toBe(404);

    // 3. Internal entrypoint succeeds WITHOUT any API key for both UUID and external keys
    const internalApp = createInternalMediaApp({
      dbRead: testDb.readDb,
    });

    const byIdRes = await internalApp.fetch(
      new Request(`${INTERNAL_BASE_URL}/internal/media/${fixture.mediaId}`, {
        headers: { "x-forwarded-client-ip": "203.0.113.10" },
      }),
    );
    expect(byIdRes.status).toBe(200);
    const byIdBody = (await byIdRes.json()) as {
      document: MediaDocument;
      matchedAssociationId: string | null;
    };
    expect(byIdBody.matchedAssociationId).toBeNull();
    expect(byIdBody.document.media).toMatchObject({
      id: fixture.mediaId,
      type: "tv",
      baseline: "tmdb",
      snapshot: {
        title: "咒术回战",
        originalTitle: "呪術廻戦",
        year: 2020,
      },
    });
    expect(byIdBody.document.variants).toHaveLength(1);
    expect(byIdBody.document.variants[0]).toMatchObject({
      namespace: "bilibili",
      label: "原声",
      isDefault: true,
    });
    // Must ONLY return confirmed associations — not rejected, seed_unconfirmed, or delisted
    expect(byIdBody.document.associations).toHaveLength(1);
    expect(byIdBody.document.associations[0]).toMatchObject({
      id: fixture.confirmedAssociationId,
      namespace: "bilibili",
      nativeId: "ss34430",
      status: "confirmed",
      segments: [
        {
          season: 1,
          episodeStart: 1,
          episodeEnd: 24,
          targetEpisodeStart: 1,
          baseline: "tmdb",
        },
      ],
    });

    const byTmdbRes = await internalApp.fetch(
      new Request(`${INTERNAL_BASE_URL}/internal/media/tmdb:tv:95479`, {
        headers: { "x-forwarded-client-ip": "203.0.113.10" },
      }),
    );
    expect(byTmdbRes.status).toBe(200);
    const byTmdbBody = (await byTmdbRes.json()) as {
      document: MediaDocument;
      matchedAssociationId: string | null;
    };
    expect(byTmdbBody.document.media.id).toBe(fixture.mediaId);
    expect(byTmdbBody.matchedAssociationId).toBeNull();

    // URL-encoded external key (exact wire format sent by website Worker over service binding)
    const byEncodedTmdbRes = await internalApp.fetch(
      new Request(`${INTERNAL_BASE_URL}/internal/media/${encodeURIComponent("tmdb:tv:95479")}`, {
        headers: { "x-forwarded-client-ip": "203.0.113.10" },
      }),
    );
    expect(byEncodedTmdbRes.status).toBe(200);
    const byEncodedTmdbBody = (await byEncodedTmdbRes.json()) as {
      document: MediaDocument;
      matchedAssociationId: string | null;
    };
    expect(byEncodedTmdbBody.document.media.id).toBe(fixture.mediaId);

    const byCollectionRes = await internalApp.fetch(
      new Request(`${INTERNAL_BASE_URL}/internal/media/bilibili:ss34430`, {
        headers: { "x-forwarded-client-ip": "203.0.113.10" },
      }),
    );
    expect(byCollectionRes.status).toBe(200);
    const byCollectionBody = (await byCollectionRes.json()) as {
      document: MediaDocument;
      matchedAssociationId: string | null;
    };
    expect(byCollectionBody.matchedAssociationId).toBe(fixture.confirmedAssociationId);

    // Unconfirmed seed collection key must NOT resolve through anonymous internal read
    const byUnconfirmedRes = await internalApp.fetch(
      new Request(`${INTERNAL_BASE_URL}/internal/media/bilibili:ss99991`, {
        headers: { "x-forwarded-client-ip": "203.0.113.10" },
      }),
    );
    expect(byUnconfirmedRes.status).toBe(404);
  });

  test("internal entrypoint rejects list, search, batch, write routes, and exposes single-media read via InternalMediaEntrypoint fetch and getMedia RPC", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const fixture = await seedConfirmedMediaFixture(testDb);

    const internalApp = createInternalMediaApp({
      dbRead: testDb.readDb,
    });

    // Rejects non-single-media and write routes
    const rejectedRequests = [
      new Request(`${INTERNAL_BASE_URL}/internal/media`),
      new Request(`${INTERNAL_BASE_URL}/internal/media/`),
      new Request(`${INTERNAL_BASE_URL}/internal/search?q=jujutsu`),
      new Request(`${INTERNAL_BASE_URL}/internal/media/batch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keys: ["tmdb:tv:95479"] }),
      }),
      new Request(`${INTERNAL_BASE_URL}/internal/media/${fixture.mediaId}`, {
        method: "POST",
      }),
      new Request(`${INTERNAL_BASE_URL}/internal/media/${fixture.mediaId}`, {
        method: "DELETE",
      }),
      new Request(`${INTERNAL_BASE_URL}/v1/media/${fixture.mediaId}`),
    ];

    for (const req of rejectedRequests) {
      const res = await internalApp.fetch(req);
      expect(res.status, `${req.method} ${req.url} should be 404`).toBe(404);
    }

    // Rejects malformed key with 400 and unknown valid key with 404
    const invalidKeyRes = await internalApp.fetch(
      new Request(`${INTERNAL_BASE_URL}/internal/media/not-a-valid-key`),
    );
    expect(invalidKeyRes.status).toBe(400);
    expect(await invalidKeyRes.json()).toMatchObject({ error: "INVALID_KEY" });

    const missingKeyRes = await internalApp.fetch(
      new Request(`${INTERNAL_BASE_URL}/internal/media/tmdb:tv:99999999`),
    );
    expect(missingKeyRes.status).toBe(404);
    expect(await missingKeyRes.json()).toMatchObject({ error: "MEDIA_NOT_FOUND" });

    // Named Cloudflare WorkerEntrypoint serves fetch() and getMedia() using ONLY HYPERDRIVE_READ
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;
    const hyperdriveRead = { connectionString: testDb.connectionString } as Hyperdrive;

    const entrypoint = new InternalMediaEntrypoint(ctx, {
      HYPERDRIVE_READ: hyperdriveRead,
    });

    const rpcFetchRes = await entrypoint.fetch(
      new Request(`${INTERNAL_BASE_URL}/internal/media/tmdb:tv:95479`, {
        headers: { "x-forwarded-client-ip": "198.51.100.7" },
      }),
    );
    expect(rpcFetchRes.status).toBe(200);
    const rpcFetchBody = (await rpcFetchRes.json()) as {
      document: MediaDocument;
      matchedAssociationId: string | null;
    };
    expect(rpcFetchBody.document.media.id).toBe(fixture.mediaId);

    const rpcResult = await entrypoint.getMedia("tmdb:tv:95479", "198.51.100.8");
    expect(rpcResult.status).toBe(200);
    if (rpcResult.status === 200) {
      expect(rpcResult.document.media.id).toBe(fixture.mediaId);
      expect(rpcResult.matchedAssociationId).toBeNull();
    }

    const rpcMissing = await entrypoint.getMedia("tmdb:tv:99999999", "198.51.100.8");
    expect(rpcMissing).toMatchObject({ status: 404, error: "MEDIA_NOT_FOUND" });

    await Promise.all(pending);
    expect(pending.length).toBeGreaterThanOrEqual(3);
  });

  test("enforces per-source-IP rate limiting with 429 + Retry-After while allowing other IPs and recovering after window reset", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    await seedConfirmedMediaFixture(testDb);

    let currentMs = Date.parse("2026-11-23T12:00:00.000Z");
    const now = () => new Date(currentMs);
    const rateLimiter = createInMemoryIpRateLimiter({
      limit: 2,
      windowSeconds: 60,
      now,
    });

    const internalApp = createInternalMediaApp({
      dbRead: testDb.readDb,
      rateLimiter,
      now,
    });

    // IP A uses 2/2 allowed requests
    for (let i = 0; i < 2; i++) {
      const res = await internalApp.fetch(
        new Request(`${INTERNAL_BASE_URL}/internal/media/tmdb:tv:95479`, {
          headers: { "x-forwarded-client-ip": "203.0.113.42" },
        }),
      );
      expect(res.status).toBe(200);
    }

    // 3rd request from IP A (15 seconds into the window) is rate-limited with Retry-After: 45
    currentMs += 15_000;
    const limitedRes = await internalApp.fetch(
      new Request(`${INTERNAL_BASE_URL}/internal/media/tmdb:tv:95479`, {
        headers: { "x-forwarded-client-ip": "203.0.113.42" },
      }),
    );
    expect(limitedRes.status).toBe(429);
    expect(limitedRes.headers.get("retry-after")).toBe("45");
    expect(await limitedRes.json()).toMatchObject({
      error: "RATE_LIMITED",
      retryAfter: 45,
    });

    // Different IP via CF-Connecting-IP still succeeds
    const ipBRes = await internalApp.fetch(
      new Request(`${INTERNAL_BASE_URL}/internal/media/tmdb:tv:95479`, {
        headers: { "cf-connecting-ip": "198.51.100.99" },
      }),
    );
    expect(ipBRes.status).toBe(200);

    // Different IP via X-Forwarded-For first hop still succeeds
    const ipCRes = await internalApp.fetch(
      new Request(`${INTERNAL_BASE_URL}/internal/media/tmdb:tv:95479`, {
        headers: { "x-forwarded-for": "192.0.2.55, 10.0.0.1" },
      }),
    );
    expect(ipCRes.status).toBe(200);

    // After the 60s window expires, IP A succeeds again
    currentMs += 45_000;
    const recoveredRes = await internalApp.fetch(
      new Request(`${INTERNAL_BASE_URL}/internal/media/tmdb:tv:95479`, {
        headers: { "x-forwarded-client-ip": "203.0.113.42" },
      }),
    );
    expect(recoveredRes.status).toBe(200);
  });

  test("InternalMediaEntrypoint enforces Cloudflare RATE_LIMITER_ANONYMOUS_IP binding per source IP", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    await seedConfirmedMediaFixture(testDb);

    const seenKeys: string[] = [];
    const counts = new Map<string, number>();
    const fakeBinding: RateLimit = {
      async limit({ key }) {
        seenKeys.push(key);
        const next = (counts.get(key) ?? 0) + 1;
        counts.set(key, next);
        return { success: next <= 1 };
      },
    };

    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;

    const entrypoint = new InternalMediaEntrypoint(ctx, {
      HYPERDRIVE_READ: { connectionString: testDb.connectionString } as Hyperdrive,
      RATE_LIMITER_ANONYMOUS_IP: fakeBinding,
      ANONYMOUS_IP_RATE_WINDOW_SECONDS: "30",
    });

    const firstIpA = await entrypoint.fetch(
      new Request(`${INTERNAL_BASE_URL}/internal/media/tmdb:tv:95479`, {
        headers: { "x-forwarded-client-ip": "203.0.113.77" },
      }),
    );
    expect(firstIpA.status).toBe(200);

    const secondIpA = await entrypoint.fetch(
      new Request(`${INTERNAL_BASE_URL}/internal/media/tmdb:tv:95479`, {
        headers: { "x-forwarded-client-ip": "203.0.113.77" },
      }),
    );
    expect(secondIpA.status).toBe(429);
    expect(secondIpA.headers.get("retry-after")).toBe("30");
    expect(await secondIpA.json()).toMatchObject({
      error: "RATE_LIMITED",
      retryAfter: 30,
    });

    const rpcLimitedIpA = await entrypoint.getMedia("tmdb:tv:95479", "203.0.113.77");
    expect(rpcLimitedIpA).toMatchObject({
      status: 429,
      error: "RATE_LIMITED",
      retryAfterSeconds: 30,
    });

    const firstIpB = await entrypoint.getMedia("tmdb:tv:95479", "198.51.100.88");
    expect(firstIpB.status).toBe(200);

    expect(seenKeys).toEqual([
      "anon-ip:203.0.113.77",
      "anon-ip:203.0.113.77",
      "anon-ip:203.0.113.77",
      "anon-ip:198.51.100.88",
    ]);

    await Promise.all(pending);
  });
});
