import type { ExecutionContext, Hyperdrive } from "@cloudflare/workers-types";
import { createFakeOutboundClient, listLeadsForTarget, type EmailMessage } from "@media-ref/core";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, describe, expect, test } from "vite-plus/test";
import worker, { createApiApp } from "../src/index.ts";

const TEST_BASE_URL = "https://api.mediaref.org";
const TEST_AUTH_SECRET = "test-secret-for-media-ref-leads-integration-tests-0123456789";

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

async function signUpAndVerifyUser(
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

async function issueApiKey(
  app: ReturnType<typeof createApiApp>,
  cookie: string,
  options: { name: string; canSubmit?: boolean; expiresIn?: number },
): Promise<{ id: string; key: string; permissions: { media: string[] }; canSubmit: boolean }> {
  const res = await app.fetch(
    new Request(`${TEST_BASE_URL}/v1/api-keys`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify(options),
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as {
    id: string;
    key: string;
    permissions: { media: string[] };
    canSubmit: boolean;
  };
}

describe("API Worker lead reporting (POST /v1/leads)", () => {
  const handles: TestDbHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop();
      if (handle) {
        await handle.cleanup();
      }
    }
  });

  test("allows a default read-only (read_report) API key to report leads and stores them for exploration lookup", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const outbound = createFakeOutboundClient();
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
      },
    });

    const user = await signUpAndVerifyUser(app, outbound, {
      email: "reporter@example.com",
      password: "StrongPassword123!",
      name: "Client Developer",
    });

    const readOnlyKey = await issueApiKey(app, user.cookie, { name: "Player Client" });
    expect(readOnlyKey.canSubmit).toBe(false);
    expect(readOnlyKey.permissions).toEqual({ media: ["read", "report"] });

    // Report a full lead using X-API-Key header
    const createRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/leads`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": readOnlyKey.key,
        },
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:95479",
          namespace: "bilibili",
          nativeId: "ss34430",
          season: 1,
          variantDescription: "原声",
          notes: "Matched by title and release year",
        }),
      }),
    );

    expect(createRes.status).toBe(201);
    const createdBody = (await createRes.json()) as {
      lead: {
        id: string;
        targetExternalKey: string;
        namespace: string;
        nativeId: string;
        season: number | null;
        variantDescription: string | null;
        notes: string | null;
        createdAt: string;
      };
    };

    expect(createdBody.lead).toMatchObject({
      targetExternalKey: "tmdb:tv:95479",
      namespace: "bilibili",
      nativeId: "ss34430",
      season: 1,
      variantDescription: "原声",
      notes: "Matched by title and release year",
    });
    expect(createdBody.lead.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(Number.isNaN(Date.parse(createdBody.lead.createdAt))).toBe(false);

    // Report a minimal lead (without optional fields) using Authorization: Bearer
    const minimalRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/leads`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${readOnlyKey.key}`,
        },
        body: JSON.stringify({
          targetExternalKey: "douban:1292052",
          namespace: "tencent",
          nativeId: "mzc00200xyz",
        }),
      }),
    );

    expect(minimalRes.status).toBe(201);
    const minimalBody = (await minimalRes.json()) as typeof createdBody;
    expect(minimalBody.lead).toMatchObject({
      targetExternalKey: "douban:1292052",
      namespace: "tencent",
      nativeId: "mzc00200xyz",
      season: null,
      variantDescription: null,
      notes: null,
    });

    // Season 0 (specials) is accepted as a valid non-negative integer
    const specialsRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/leads`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": readOnlyKey.key,
        },
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:95479",
          namespace: "bilibili",
          nativeId: "ss34431",
          season: 0,
        }),
      }),
    );
    expect(specialsRes.status).toBe(201);
    const specialsBody = (await specialsRes.json()) as typeof createdBody;
    expect(specialsBody.lead.season).toBe(0);

    // Exploration helper retrieves stored leads with reporter metadata
    const bilibiliSeason1 = await listLeadsForTarget(testDb.readDb, {
      targetExternalKey: "tmdb:tv:95479",
      namespace: "bilibili",
      season: 1,
    });
    expect(bilibiliSeason1).toHaveLength(1);
    expect(bilibiliSeason1[0]).toMatchObject({
      id: createdBody.lead.id,
      targetExternalKey: "tmdb:tv:95479",
      namespace: "bilibili",
      nativeId: "ss34430",
      season: 1,
      variantDescription: "原声",
      notes: "Matched by title and release year",
      reporterUserId: user.userId,
      reporterKeyId: readOnlyKey.id,
    });
    expect(bilibiliSeason1[0]!.createdAt).toBeInstanceOf(Date);
  });

  test("immediately rejects revoked keys via dbWrite even when dbRead still holds stale cached key rows", async () => {
    const primaryWriteDb = await createTestDb();
    const staleReadDb = await createTestDb();
    handles.push(primaryWriteDb, staleReadDb);

    const outbound = createFakeOutboundClient();
    const app = createApiApp({
      dbRead: staleReadDb.readDb,
      dbWrite: primaryWriteDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
      },
    });

    const user = await signUpAndVerifyUser(app, outbound, {
      email: "revoke-lead@example.com",
      password: "StrongPassword123!",
      name: "Revoke Tester",
    });

    const keyA = await issueApiKey(app, user.cookie, { name: "Revocable Client Key" });
    const submitKey = await issueApiKey(app, user.cookie, {
      name: "Submit Capable Key",
      canSubmit: true,
    });

    // Simulate cached dbRead still holding a snapshot of user + keyA.
    const userRow = await primaryWriteDb.readDb
      .selectFrom("user")
      .selectAll()
      .where("id", "=", user.userId)
      .executeTakeFirstOrThrow();
    const keyARow = await primaryWriteDb.readDb
      .selectFrom("apikey")
      .selectAll()
      .where("id", "=", keyA.id)
      .executeTakeFirstOrThrow();
    await staleReadDb.writeDb.insertInto("user").values(userRow).execute();
    await staleReadDb.writeDb.insertInto("apikey").values(keyARow).execute();

    // Before revocation, keyA can report a lead.
    const beforeRevokeRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/leads`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": keyA.key,
        },
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:95479",
          namespace: "iqiyi",
          nativeId: "a_19rrk12345",
          season: 1,
        }),
      }),
    );
    expect(beforeRevokeRes.status).toBe(201);
    const beforeLead = (await beforeRevokeRes.json()) as { lead: { id: string } };

    // Revoke keyA on dbWrite (staleReadDb still has the old cached row).
    const revokeRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/api-keys/${keyA.id}`, {
        method: "DELETE",
        headers: { cookie: user.cookie },
      }),
    );
    expect(revokeRes.status).toBe(200);

    // Proof that staleReadDb still considers keyA valid on a read endpoint:
    const staleReadCheck = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/api-keys/me`, {
        headers: { "x-api-key": keyA.key },
      }),
    );
    expect(staleReadCheck.status).toBe(200);

    // POST /v1/leads MUST verify against dbWrite and immediately reject the revoked key.
    const afterRevokeRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/leads`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": keyA.key,
        },
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:95479",
          namespace: "iqiyi",
          nativeId: "a_19rrk99999",
          season: 2,
        }),
      }),
    );
    expect(afterRevokeRes.status).toBe(401);
    expect(await afterRevokeRes.json()).toEqual({
      error: "INVALID_API_KEY",
      message: "Invalid API key",
    });

    // Submit-capable key (which also has report permission) still works on dbWrite.
    const submitKeyRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/leads`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${submitKey.key}`,
        },
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:95479",
          namespace: "youku",
          nativeId: "yk_abc123",
          season: 1,
        }),
      }),
    );
    expect(submitKeyRes.status).toBe(201);

    // Earlier lead reported before revocation remains intact; rejected lead was not stored.
    const iqiyiLeads = await listLeadsForTarget(primaryWriteDb.readDb, {
      targetExternalKey: "tmdb:tv:95479",
      namespace: "iqiyi",
    });
    expect(iqiyiLeads.map((item) => item.id)).toEqual([beforeLead.lead.id]);
  });

  test("rejects missing, invalid, disabled, expired, and permission-lacking API keys and invalid payloads", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    let currentTime = new Date();
    const outbound = createFakeOutboundClient();
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => currentTime,
      },
    });

    const validPayload = JSON.stringify({
      targetExternalKey: "tmdb:movie:550",
      namespace: "bilibili",
      nativeId: "ss12345",
    });

    // Missing API key -> 401
    const missingKeyRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/leads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: validPayload,
      }),
    );
    expect(missingKeyRes.status).toBe(401);
    expect(await missingKeyRes.json()).toEqual({
      error: "API_KEY_REQUIRED",
      message: "API key is required",
    });

    // Unknown API key -> 401
    const unknownKeyRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/leads`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "mref_nonexistent_key_value",
        },
        body: validPayload,
      }),
    );
    expect(unknownKeyRes.status).toBe(401);
    expect(await unknownKeyRes.json()).toEqual({
      error: "INVALID_API_KEY",
      message: "Invalid API key",
    });

    const user = await signUpAndVerifyUser(app, outbound, {
      email: "validate-lead@example.com",
      password: "StrongPassword123!",
      name: "Validation Tester",
    });

    const activeKey = await issueApiKey(app, user.cookie, { name: "Active Key" });
    const expiringKey = await issueApiKey(app, user.cookie, {
      name: "Expiring Key",
      expiresIn: 60,
    });
    const disabledKey = await issueApiKey(app, user.cookie, { name: "Disabled Key" });
    const readOnlyNoReportKey = await issueApiKey(app, user.cookie, { name: "No Report Perm Key" });

    // Disable key via Better Auth update endpoint
    const disableRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/api/auth/api-key/update`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: user.cookie },
        body: JSON.stringify({ keyId: disabledKey.id, enabled: false }),
      }),
    );
    expect(disableRes.status).toBe(200);

    const disabledLeadRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/leads`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": disabledKey.key },
        body: validPayload,
      }),
    );
    expect(disabledLeadRes.status).toBe(401);
    expect(await disabledLeadRes.json()).toEqual({
      error: "API_KEY_DISABLED",
      message: "API key is disabled",
    });

    // Restrict a key to ["read"] only in DB to verify report permission check
    await testDb.writeDb
      .updateTable("apikey")
      .set({ permissions: JSON.stringify({ media: ["read"] }) })
      .where("id", "=", readOnlyNoReportKey.id)
      .execute();

    const insufficientPermRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/leads`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": readOnlyNoReportKey.key },
        body: validPayload,
      }),
    );
    expect(insufficientPermRes.status).toBe(403);
    expect(await insufficientPermRes.json()).toEqual({
      error: "INSUFFICIENT_PERMISSIONS",
      message: "API key does not have required permission",
    });

    // Advance clock past expiringKey's expiration
    currentTime = new Date(Date.now() + 65_000);
    const expiredLeadRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/leads`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": expiringKey.key },
        body: validPayload,
      }),
    );
    expect(expiredLeadRes.status).toBe(401);
    expect(await expiredLeadRes.json()).toEqual({
      error: "API_KEY_EXPIRED",
      message: "API key has expired",
    });

    // Invalid JSON and invalid body fields -> 400
    const invalidCases: Array<{ body: string; expectedError: string }> = [
      { body: "{not-json", expectedError: "INVALID_JSON" },
      { body: JSON.stringify(["not-an-object"]), expectedError: "INVALID_REQUEST" },
      { body: JSON.stringify(null), expectedError: "INVALID_REQUEST" },
      {
        body: JSON.stringify({
          targetExternalKey: "unknown:123",
          namespace: "bilibili",
          nativeId: "ss34430",
        }),
        expectedError: "INVALID_EXTERNAL_KEY",
      },
      {
        body: JSON.stringify({
          targetExternalKey: "tmdb:",
          namespace: "bilibili",
          nativeId: "ss34430",
        }),
        expectedError: "INVALID_EXTERNAL_KEY",
      },
      {
        body: JSON.stringify({
          targetExternalKey: " tmdb:tv:95479",
          namespace: "bilibili",
          nativeId: "ss34430",
        }),
        expectedError: "INVALID_EXTERNAL_KEY",
      },
      {
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:95479",
          namespace: "netflix",
          nativeId: "80057281",
        }),
        expectedError: "INVALID_NAMESPACE",
      },
      {
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:95479",
          namespace: "bilibili",
          nativeId: "",
        }),
        expectedError: "INVALID_NATIVE_ID",
      },
      {
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:95479",
          namespace: "bilibili",
          nativeId: "   ",
        }),
        expectedError: "INVALID_NATIVE_ID",
      },
      {
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:95479",
          namespace: "bilibili",
          nativeId: "ss34430",
          season: -1,
        }),
        expectedError: "INVALID_SEASON",
      },
      {
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:95479",
          namespace: "bilibili",
          nativeId: "ss34430",
          season: 1.5,
        }),
        expectedError: "INVALID_SEASON",
      },
      {
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:95479",
          namespace: "bilibili",
          nativeId: "ss34430",
          season: "1",
        }),
        expectedError: "INVALID_SEASON",
      },
      {
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:95479",
          namespace: "bilibili",
          nativeId: "ss34430",
          variantDescription: 42,
        }),
        expectedError: "INVALID_VARIANT_DESCRIPTION",
      },
      {
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:95479",
          namespace: "bilibili",
          nativeId: "ss34430",
          notes: { hint: "bad" },
        }),
        expectedError: "INVALID_NOTES",
      },
    ];

    for (const testCase of invalidCases) {
      const res = await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/leads`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": activeKey.key,
          },
          body: testCase.body,
        }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: testCase.expectedError });
    }

    const totalLeads = await testDb.readDb.selectFrom("leads").select("id").execute();
    expect(totalLeads).toHaveLength(0);
  });

  test("does not enqueue background jobs, invoke outbound calls, or expose leads on public read endpoints, and supports filtered lookup for exploration", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const outbound = createFakeOutboundClient();
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
      },
    });

    const user = await signUpAndVerifyUser(app, outbound, {
      email: "isolation@example.com",
      password: "StrongPassword123!",
      name: "Isolation Tester",
    });

    const key = await issueApiKey(app, user.cookie, { name: "Client App" });

    const payloads = [
      {
        targetExternalKey: "tmdb:tv:95479",
        namespace: "bilibili",
        nativeId: "ss34430",
        season: 1,
        variantDescription: "原声",
      },
      {
        targetExternalKey: "tmdb:tv:95479",
        namespace: "bilibili",
        nativeId: "ss45574",
        season: 2,
      },
      {
        targetExternalKey: "tmdb:tv:95479",
        namespace: "bilibili",
        nativeId: "ss_series_hint",
        season: null,
        notes: "   ",
      },
      {
        targetExternalKey: "tmdb:tv:95479",
        namespace: "tencent",
        nativeId: "mzc00200test",
        season: 1,
      },
      {
        targetExternalKey: "douban:1292052",
        namespace: "mgtv",
        nativeId: "mg_999",
      },
    ];

    const createdIds: string[] = [];
    for (const payload of payloads) {
      const res = await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/leads`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": key.key,
          },
          body: JSON.stringify(payload),
        }),
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as { lead: { id: string; notes: string | null } };
      createdIds.push(body.lead.id);
    }

    // Reporting leads MUST NOT enqueue any background_jobs (cannot trigger exploration)
    const jobs = await testDb.readDb.selectFrom("background_jobs").select("id").execute();
    expect(jobs).toHaveLength(0);

    // Reporting leads MUST NOT trigger outbound HTTP or AI model calls
    expect(outbound.httpRequests).toHaveLength(0);
    expect(outbound.modelRequests).toHaveLength(0);

    // Leads are NOT exposed on public read endpoints
    const getLeadsRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/leads`, {
        headers: { "x-api-key": key.key },
      }),
    );
    expect(getLeadsRes.status).toBe(404);

    const healthRes = await app.fetch(new Request(`${TEST_BASE_URL}/health`));
    expect(healthRes.status).toBe(200);
    expect(await healthRes.text()).not.toContain("ss34430");

    const keyMeRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/api-keys/me`, {
        headers: { "x-api-key": key.key },
      }),
    );
    expect(keyMeRes.status).toBe(200);
    expect(await keyMeRes.text()).not.toContain("ss34430");

    // Exploration lookup helper filters cleanly by targetExternalKey, namespace, season, and limit
    const allForTmdb = await listLeadsForTarget(testDb.readDb, {
      targetExternalKey: "tmdb:tv:95479",
    });
    expect(allForTmdb).toHaveLength(4);

    const bilibiliOnly = await listLeadsForTarget(testDb.readDb, {
      targetExternalKey: "tmdb:tv:95479",
      namespace: "bilibili",
    });
    expect(bilibiliOnly).toHaveLength(3);
    expect(bilibiliOnly.map((item) => item.nativeId).sort()).toEqual([
      "ss34430",
      "ss45574",
      "ss_series_hint",
    ]);

    const bilibiliSeason1 = await listLeadsForTarget(testDb.readDb, {
      targetExternalKey: "tmdb:tv:95479",
      namespace: "bilibili",
      season: 1,
    });
    expect(bilibiliSeason1).toHaveLength(1);
    expect(bilibiliSeason1[0]!.id).toBe(createdIds[0]);

    const bilibiliNoSeason = await listLeadsForTarget(testDb.readDb, {
      targetExternalKey: "tmdb:tv:95479",
      namespace: "bilibili",
      season: null,
    });
    expect(bilibiliNoSeason).toHaveLength(1);
    expect(bilibiliNoSeason[0]).toMatchObject({
      id: createdIds[2],
      nativeId: "ss_series_hint",
      season: null,
      notes: null,
    });

    const limited = await listLeadsForTarget(testDb.readDb, {
      targetExternalKey: "tmdb:tv:95479",
      limit: 2,
    });
    expect(limited).toHaveLength(2);

    const unknownTarget = await listLeadsForTarget(testDb.readDb, {
      targetExternalKey: "tmdb:tv:99999999",
    });
    expect(unknownTarget).toEqual([]);
  });

  test("default Cloudflare Worker fetch entrypoint handles POST /v1/leads over HYPERDRIVE_WRITE", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const outbound = createFakeOutboundClient();
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
      },
    });

    const user = await signUpAndVerifyUser(app, outbound, {
      email: "worker-lead@example.com",
      password: "StrongPassword123!",
      name: "Worker Lead Dev",
    });
    const key = await issueApiKey(app, user.cookie, { name: "Worker Lead Key" });

    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;

    const hyperdrive = {
      connectionString: testDb.connectionString,
    } as Hyperdrive;

    const response = await worker.fetch(
      new Request(`${TEST_BASE_URL}/v1/leads`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key.key,
        },
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:95479",
          namespace: "bilibili",
          nativeId: "ss34430",
          season: 1,
        }),
      }),
      {
        HYPERDRIVE_READ: hyperdrive,
        HYPERDRIVE_WRITE: hyperdrive,
        AUTH_SECRET: TEST_AUTH_SECRET,
        API_BASE_URL: TEST_BASE_URL,
        COOKIE_DOMAIN: "mediaref.org",
      },
      ctx,
    );

    await Promise.all(pending);

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      lead: { id: string; targetExternalKey: string; namespace: string; nativeId: string };
    };
    expect(body.lead).toMatchObject({
      targetExternalKey: "tmdb:tv:95479",
      namespace: "bilibili",
      nativeId: "ss34430",
    });

    const stored = await listLeadsForTarget(testDb.readDb, {
      targetExternalKey: "tmdb:tv:95479",
      namespace: "bilibili",
      season: 1,
    });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.id).toBe(body.lead.id);
  });
});
