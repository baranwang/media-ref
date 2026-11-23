import type { ExecutionContext, Hyperdrive } from "@cloudflare/workers-types";
import { createFakeOutboundClient, type EmailMessage } from "@media-ref/core";
import { createDb } from "@media-ref/db";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, describe, expect, test } from "vite-plus/test";
import worker, { createApiApp, requireApiKey } from "../src/index.ts";

const TEST_BASE_URL = "https://api.mediaref.org";
const TEST_AUTH_SECRET = "test-secret-for-media-ref-api-key-integration-tests-0123456789";

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

describe("API Worker API key management & verification", () => {
  const handles: TestDbHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop();
      if (handle) {
        await handle.cleanup();
      }
    }
  });

  test("allows a verified user to create multiple keys with chosen permissions, list sanitized metadata, and revoke keys with ownership enforcement", async () => {
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

    const alice = await signUpUser(app, outbound, {
      email: "alice@example.com",
      password: "StrongPassword123!",
      name: "Alice",
      verify: true,
    });
    const bob = await signUpUser(app, outbound, {
      email: "bob@example.com",
      password: "StrongPassword456!",
      name: "Bob",
      verify: true,
    });

    const readKeyRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/api-keys`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: alice.cookie,
        },
        body: JSON.stringify({ name: "Player App" }),
      }),
    );
    expect(readKeyRes.status).toBe(201);
    const readKey = (await readKeyRes.json()) as {
      id: string;
      name: string | null;
      prefix: string | null;
      start: string | null;
      key: string;
      enabled: boolean;
      permissions: { media: string[] };
      canSubmit: boolean;
      createdAt: string;
      expiresAt: string | null;
    };

    expect(readKey.name).toBe("Player App");
    expect(readKey.prefix).toBe("mref_");
    expect(readKey.key.startsWith("mref_")).toBe(true);
    expect(readKey.start).toBe(readKey.key.slice(0, 11));
    expect(readKey.enabled).toBe(true);
    expect(readKey.permissions).toEqual({ media: ["read", "report"] });
    expect(readKey.canSubmit).toBe(false);
    expect(readKey.expiresAt).toBeNull();
    expect(Number.isNaN(Date.parse(readKey.createdAt))).toBe(false);

    const submitKeyRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/api-keys`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: alice.cookie,
        },
        body: JSON.stringify({
          name: "Batch Submitter",
          canSubmit: true,
          expiresIn: 86_400,
        }),
      }),
    );
    expect(submitKeyRes.status).toBe(201);
    const submitKey = (await submitKeyRes.json()) as typeof readKey;

    expect(submitKey.id).not.toBe(readKey.id);
    expect(submitKey.key).not.toBe(readKey.key);
    expect(submitKey.permissions).toEqual({ media: ["read", "report", "submit"] });
    expect(submitKey.canSubmit).toBe(true);
    expect(submitKey.expiresAt).not.toBeNull();

    const listRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/api-keys`, {
        headers: { cookie: alice.cookie },
      }),
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      apiKeys: Array<Record<string, unknown>>;
      total: number;
    };

    expect(listBody.total).toBe(2);
    expect(listBody.apiKeys).toHaveLength(2);
    for (const item of listBody.apiKeys) {
      expect(item).not.toHaveProperty("key");
    }
    const serializedList = JSON.stringify(listBody);
    expect(serializedList).not.toContain(readKey.key);
    expect(serializedList).not.toContain(submitKey.key);

    const byId = new Map(listBody.apiKeys.map((item) => [item.id, item]));
    expect(byId.get(readKey.id)).toMatchObject({
      id: readKey.id,
      name: "Player App",
      prefix: "mref_",
      start: readKey.start,
      enabled: true,
      permissions: { media: ["read", "report"] },
      canSubmit: false,
      expiresAt: null,
    });
    expect(byId.get(submitKey.id)).toMatchObject({
      id: submitKey.id,
      name: "Batch Submitter",
      prefix: "mref_",
      start: submitKey.start,
      enabled: true,
      permissions: { media: ["read", "report", "submit"] },
      canSubmit: true,
    });

    // Bob cannot see or revoke Alice's keys.
    const bobListRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/api-keys`, {
        headers: { cookie: bob.cookie },
      }),
    );
    expect(bobListRes.status).toBe(200);
    expect(await bobListRes.json()).toEqual({ apiKeys: [], total: 0 });

    const bobDeleteRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/api-keys/${readKey.id}`, {
        method: "DELETE",
        headers: { cookie: bob.cookie },
      }),
    );
    expect(bobDeleteRes.status).toBe(404);
    expect(await bobDeleteRes.json()).toMatchObject({ error: "API_KEY_NOT_FOUND" });

    // Alice revokes one key; the other remains.
    const deleteRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/api-keys/${readKey.id}`, {
        method: "DELETE",
        headers: { cookie: alice.cookie },
      }),
    );
    expect(deleteRes.status).toBe(200);
    expect(await deleteRes.json()).toEqual({ success: true, id: readKey.id });

    const listAfterDelete = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/api-keys`, {
        headers: { cookie: alice.cookie },
      }),
    );
    expect(listAfterDelete.status).toBe(200);
    const afterBody = (await listAfterDelete.json()) as {
      apiKeys: Array<{ id: string }>;
      total: number;
    };
    expect(afterBody.total).toBe(1);
    expect(afterBody.apiKeys.map((k) => k.id)).toEqual([submitKey.id]);
  });

  test("rejects unverified users creating keys on POST /v1/api-keys and blocks direct /api/auth/api-key/create bypass", async () => {
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

    // Unauthenticated callers are rejected with 401.
    const unauthCreate = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/api-keys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "No Auth" }),
      }),
    );
    expect(unauthCreate.status).toBe(401);

    const unauthList = await app.fetch(new Request(`${TEST_BASE_URL}/v1/api-keys`));
    expect(unauthList.status).toBe(401);

    const unauthDelete = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/api-keys/some-id`, { method: "DELETE" }),
    );
    expect(unauthDelete.status).toBe(401);

    const unverified = await signUpUser(app, outbound, {
      email: "unverified@example.com",
      password: "StrongPassword123!",
      name: "Unverified Dev",
      verify: false,
    });

    const createRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/api-keys`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: unverified.cookie,
        },
        body: JSON.stringify({ name: "Blocked Key" }),
      }),
    );
    expect(createRes.status).toBe(403);
    expect(await createRes.json()).toEqual({
      error: "EMAIL_NOT_VERIFIED",
      message: "Email verification is required",
    });

    // Direct Better Auth /api/auth/api-key/create must be disabled so unverified users cannot bypass.
    const directBypass = await app.fetch(
      new Request(`${TEST_BASE_URL}/api/auth/api-key/create`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: unverified.cookie,
        },
        body: JSON.stringify({ name: "Bypass Attempt" }),
      }),
    );
    expect(directBypass.status).toBe(404);
  });

  test("verifies Better Auth-issued keys with zero DB writes, supports Bearer and X-API-Key headers, and enforces read/report/submit permissions", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    // Enforce read-only transactions at the PostgreSQL session level on dbRead
    // to prove custom verification performs zero database writes.
    const readOnlyUrl = new URL(testDb.connectionString);
    readOnlyUrl.searchParams.set("options", "-c default_transaction_read_only=on");
    const readOnlyDb = createDb(readOnlyUrl.toString());

    try {
      const outbound = createFakeOutboundClient();
      const app = createApiApp({
        dbRead: readOnlyDb,
        dbWrite: testDb.writeDb,
        outbound,
        config: {
          baseUrl: TEST_BASE_URL,
          authSecret: TEST_AUTH_SECRET,
        },
      });

      app.post("/v1/test-report", requireApiKey({ db: "write", permission: "report" }), (c) => {
        const verified = c.get("apiKey")!;
        return c.json({ ok: true, keyId: verified.keyId, userId: verified.userId }, 200);
      });

      app.post("/v1/test-submit", requireApiKey({ db: "write", permission: "submit" }), (c) => {
        const verified = c.get("apiKey")!;
        return c.json(
          {
            ok: true,
            keyId: verified.keyId,
            userId: verified.userId,
            canSubmit: verified.canSubmit,
          },
          200,
        );
      });

      const dev = await signUpUser(app, outbound, {
        email: "dev@example.com",
        password: "StrongPassword123!",
        name: "Dev",
        verify: true,
      });

      // Create genuine keys through Better Auth's apiKey plugin via POST /v1/api-keys.
      const readOnlyKeyRes = await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/api-keys`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: dev.cookie,
          },
          body: JSON.stringify({ name: "Read & Report Key" }),
        }),
      );
      expect(readOnlyKeyRes.status).toBe(201);
      const readOnlyKey = (await readOnlyKeyRes.json()) as {
        id: string;
        key: string;
        start: string;
      };

      const submitKeyRes = await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/api-keys`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: dev.cookie,
          },
          body: JSON.stringify({
            name: "Submit Key",
            scopes: ["read_report", "submit"],
          }),
        }),
      );
      expect(submitKeyRes.status).toBe(201);
      const submitKey = (await submitKeyRes.json()) as { id: string; key: string };

      const beforeRows = await testDb.readDb
        .selectFrom("apikey")
        .select(["id", "requestCount", "lastRequest", "updatedAt"])
        .where("id", "in", [readOnlyKey.id, submitKey.id])
        .execute();
      const beforeById = new Map(beforeRows.map((row) => [row.id, row]));

      // Read-only key works with Authorization: Bearer on GET /v1/api-keys/me (uses readOnlyDb).
      const bearerMeRes = await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/api-keys/me`, {
          headers: { authorization: `Bearer ${readOnlyKey.key}` },
        }),
      );
      expect(bearerMeRes.status).toBe(200);
      expect(await bearerMeRes.json()).toEqual({
        keyId: readOnlyKey.id,
        userId: dev.userId,
        name: "Read & Report Key",
        prefix: "mref_",
        start: readOnlyKey.start,
        permissions: { media: ["read", "report"] },
        canSubmit: false,
        emailVerified: true,
        role: "user",
        expiresAt: null,
      });

      // Read-only key also works with X-API-Key header on GET /v1/api-keys/me and report endpoint.
      const xApiKeyMeRes = await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/api-keys/me`, {
          headers: { "x-api-key": readOnlyKey.key },
        }),
      );
      expect(xApiKeyMeRes.status).toBe(200);

      const readKeyReportRes = await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/test-report`, {
          method: "POST",
          headers: { "x-api-key": readOnlyKey.key },
        }),
      );
      expect(readKeyReportRes.status).toBe(200);
      expect(await readKeyReportRes.json()).toEqual({
        ok: true,
        keyId: readOnlyKey.id,
        userId: dev.userId,
      });

      // Read-only key is rejected with 403 INSUFFICIENT_PERMISSIONS on submit endpoint.
      const readKeySubmitRes = await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/test-submit`, {
          method: "POST",
          headers: { authorization: `Bearer ${readOnlyKey.key}` },
        }),
      );
      expect(readKeySubmitRes.status).toBe(403);
      expect(await readKeySubmitRes.json()).toEqual({
        error: "INSUFFICIENT_PERMISSIONS",
        message: "API key does not have required permission",
      });

      // Submit key succeeds on read, report, and submit endpoints.
      const submitKeyReadRes = await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/api-keys/me`, {
          headers: { "x-api-key": submitKey.key },
        }),
      );
      expect(submitKeyReadRes.status).toBe(200);

      const submitKeyReportRes = await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/test-report`, {
          method: "POST",
          headers: { authorization: `Bearer ${submitKey.key}` },
        }),
      );
      expect(submitKeyReportRes.status).toBe(200);

      const submitKeySubmitRes = await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/test-submit`, {
          method: "POST",
          headers: { authorization: `Bearer ${submitKey.key}` },
        }),
      );
      expect(submitKeySubmitRes.status).toBe(200);
      expect(await submitKeySubmitRes.json()).toEqual({
        ok: true,
        keyId: submitKey.id,
        userId: dev.userId,
        canSubmit: true,
      });

      // Verify zero DB writes happened on apikey rows (requestCount, lastRequest, updatedAt untouched).
      const afterRows = await testDb.readDb
        .selectFrom("apikey")
        .select(["id", "requestCount", "lastRequest", "updatedAt"])
        .where("id", "in", [readOnlyKey.id, submitKey.id])
        .execute();

      for (const after of afterRows) {
        const before = beforeById.get(after.id)!;
        expect(after.requestCount).toBe(0);
        expect(after.lastRequest).toBeNull();
        expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
      }
    } finally {
      await readOnlyDb.destroy();
    }
  });

  test("immediately rejects revoked keys on dbWrite endpoints while leaving other keys active", async () => {
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

    app.post("/v1/test-report", requireApiKey({ db: "write", permission: "report" }), (c) =>
      c.json({ ok: true, keyId: c.get("apiKey")!.keyId }, 200),
    );
    app.post("/v1/test-submit", requireApiKey({ db: "write", permission: "submit" }), (c) =>
      c.json({ ok: true, keyId: c.get("apiKey")!.keyId }, 200),
    );

    const user = await signUpUser(app, outbound, {
      email: "revoke@example.com",
      password: "StrongPassword123!",
      name: "Revoker",
      verify: true,
    });

    const keyARes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/api-keys`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: user.cookie },
        body: JSON.stringify({ name: "Key A", canSubmit: true }),
      }),
    );
    expect(keyARes.status).toBe(201);
    const keyA = (await keyARes.json()) as { id: string; key: string };

    const keyBRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/api-keys`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: user.cookie },
        body: JSON.stringify({ name: "Key B", canSubmit: true }),
      }),
    );
    expect(keyBRes.status).toBe(201);
    const keyB = (await keyBRes.json()) as { id: string; key: string };

    expect(
      (
        await app.fetch(
          new Request(`${TEST_BASE_URL}/v1/test-submit`, {
            method: "POST",
            headers: { "x-api-key": keyA.key },
          }),
        )
      ).status,
    ).toBe(200);

    const revokeRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/api-keys/${keyA.id}`, {
        method: "DELETE",
        headers: { cookie: user.cookie },
      }),
    );
    expect(revokeRes.status).toBe(200);

    // Immediately rejected on both submit and report dbWrite endpoints.
    const submitAfterRevoke = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/test-submit`, {
        method: "POST",
        headers: { authorization: `Bearer ${keyA.key}` },
      }),
    );
    expect(submitAfterRevoke.status).toBe(401);
    expect(await submitAfterRevoke.json()).toEqual({
      error: "INVALID_API_KEY",
      message: "Invalid API key",
    });

    const reportAfterRevoke = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/test-report`, {
        method: "POST",
        headers: { "x-api-key": keyA.key },
      }),
    );
    expect(reportAfterRevoke.status).toBe(401);
    expect(await reportAfterRevoke.json()).toEqual({
      error: "INVALID_API_KEY",
      message: "Invalid API key",
    });

    // Key B owned by the same user continues working unaffected.
    const keyBSubmit = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/test-submit`, {
        method: "POST",
        headers: { "x-api-key": keyB.key },
      }),
    );
    expect(keyBSubmit.status).toBe(200);
  });

  test("rejects expired keys and disabled keys with 401", async () => {
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

    app.post("/v1/test-submit", requireApiKey({ db: "write", permission: "submit" }), (c) =>
      c.json({ ok: true }, 200),
    );

    const user = await signUpUser(app, outbound, {
      email: "expiry@example.com",
      password: "StrongPassword123!",
      name: "Expiry Dev",
      verify: true,
    });

    const expiringRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/api-keys`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: user.cookie },
        body: JSON.stringify({ name: "Short Lived", canSubmit: true, expiresIn: 60 }),
      }),
    );
    expect(expiringRes.status).toBe(201);
    const expiringKey = (await expiringRes.json()) as { id: string; key: string };

    const disableTargetRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/api-keys`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: user.cookie },
        body: JSON.stringify({ name: "Disable Me", canSubmit: true }),
      }),
    );
    expect(disableTargetRes.status).toBe(201);
    const disableTarget = (await disableTargetRes.json()) as { id: string; key: string };

    // Valid before expiration.
    expect(
      (
        await app.fetch(
          new Request(`${TEST_BASE_URL}/v1/api-keys/me`, {
            headers: { "x-api-key": expiringKey.key },
          }),
        )
      ).status,
    ).toBe(200);

    // Advance clock past expiresAt.
    currentTime = new Date(Date.now() + 65_000);

    const expiredRead = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/api-keys/me`, {
        headers: { "x-api-key": expiringKey.key },
      }),
    );
    expect(expiredRead.status).toBe(401);
    expect(await expiredRead.json()).toEqual({
      error: "API_KEY_EXPIRED",
      message: "API key has expired",
    });

    const expiredWrite = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/test-submit`, {
        method: "POST",
        headers: { authorization: `Bearer ${expiringKey.key}` },
      }),
    );
    expect(expiredWrite.status).toBe(401);
    expect(await expiredWrite.json()).toEqual({
      error: "API_KEY_EXPIRED",
      message: "API key has expired",
    });

    // Disable key via Better Auth update endpoint and confirm custom verifier rejects it.
    const disableRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/api/auth/api-key/update`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: user.cookie },
        body: JSON.stringify({ keyId: disableTarget.id, enabled: false }),
      }),
    );
    expect(disableRes.status).toBe(200);

    const disabledCheck = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/test-submit`, {
        method: "POST",
        headers: { "x-api-key": disableTarget.key },
      }),
    );
    expect(disabledCheck.status).toBe(401);
    expect(await disabledCheck.json()).toEqual({
      error: "API_KEY_DISABLED",
      message: "API key is disabled",
    });
  });

  test("routes read verification through dbRead and write/report verification through dbWrite independently", async () => {
    const primaryWriteDb = await createTestDb();
    const cachedReadDb = await createTestDb();
    handles.push(primaryWriteDb, cachedReadDb);

    const outbound = createFakeOutboundClient();
    const app = createApiApp({
      dbRead: cachedReadDb.readDb,
      dbWrite: primaryWriteDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
      },
    });

    app.post("/v1/test-report", requireApiKey({ db: "write", permission: "report" }), (c) =>
      c.json({ ok: true }, 200),
    );
    app.post("/v1/test-submit", requireApiKey({ db: "write", permission: "submit" }), (c) =>
      c.json({ ok: true }, 200),
    );

    const user = await signUpUser(app, outbound, {
      email: "splitdb@example.com",
      password: "StrongPassword123!",
      name: "Split DB Dev",
      verify: true,
    });

    const createRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/api-keys`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: user.cookie },
        body: JSON.stringify({ name: "Split Key", canSubmit: true }),
      }),
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string; key: string };

    // Write/report routes hit dbWrite (primaryWriteDb) and succeed immediately.
    expect(
      (
        await app.fetch(
          new Request(`${TEST_BASE_URL}/v1/test-submit`, {
            method: "POST",
            headers: { "x-api-key": created.key },
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.fetch(
          new Request(`${TEST_BASE_URL}/v1/test-report`, {
            method: "POST",
            headers: { "x-api-key": created.key },
          }),
        )
      ).status,
    ).toBe(200);

    // Read route hits dbRead (cachedReadDb), which does not have the row yet.
    expect(
      (
        await app.fetch(
          new Request(`${TEST_BASE_URL}/v1/api-keys/me`, {
            headers: { "x-api-key": created.key },
          }),
        )
      ).status,
    ).toBe(401);

    // Copy the user and apikey rows into cachedReadDb to simulate cached read visibility.
    const userRow = await primaryWriteDb.readDb
      .selectFrom("user")
      .selectAll()
      .where("id", "=", user.userId)
      .executeTakeFirstOrThrow();
    const keyRow = await primaryWriteDb.readDb
      .selectFrom("apikey")
      .selectAll()
      .where("id", "=", created.id)
      .executeTakeFirstOrThrow();

    await cachedReadDb.writeDb.insertInto("user").values(userRow).execute();
    await cachedReadDb.writeDb.insertInto("apikey").values(keyRow).execute();

    // Now read route succeeds via dbRead.
    expect(
      (
        await app.fetch(
          new Request(`${TEST_BASE_URL}/v1/api-keys/me`, {
            headers: { "x-api-key": created.key },
          }),
        )
      ).status,
    ).toBe(200);

    // Revoke key (deletes on primaryWriteDb while cachedReadDb still holds stale cache entry).
    const revokeRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/api-keys/${created.id}`, {
        method: "DELETE",
        headers: { cookie: user.cookie },
      }),
    );
    expect(revokeRes.status).toBe(200);

    // Write & report endpoints reject IMMEDIATELY because they query uncached dbWrite.
    expect(
      (
        await app.fetch(
          new Request(`${TEST_BASE_URL}/v1/test-submit`, {
            method: "POST",
            headers: { "x-api-key": created.key },
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await app.fetch(
          new Request(`${TEST_BASE_URL}/v1/test-report`, {
            method: "POST",
            headers: { "x-api-key": created.key },
          }),
        )
      ).status,
    ).toBe(401);

    // Read endpoint still sees the stale cached row on dbRead, confirming distinct connection routing.
    expect(
      (
        await app.fetch(
          new Request(`${TEST_BASE_URL}/v1/api-keys/me`, {
            headers: { "x-api-key": created.key },
          }),
        )
      ).status,
    ).toBe(200);
  });

  test("validates POST /v1/api-keys input and rejects missing or malformed API key headers", async () => {
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

    const user = await signUpUser(app, outbound, {
      email: "validator@example.com",
      password: "StrongPassword123!",
      name: "Validator",
      verify: true,
    });

    // Missing or non-Bearer auth headers return 401 API_KEY_REQUIRED.
    const missingKey = await app.fetch(new Request(`${TEST_BASE_URL}/v1/api-keys/me`));
    expect(missingKey.status).toBe(401);
    expect(await missingKey.json()).toEqual({
      error: "API_KEY_REQUIRED",
      message: "API key is required",
    });

    const basicAuth = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/api-keys/me`, {
        headers: { authorization: "Basic dXNlcjpwYXNz" },
      }),
    );
    expect(basicAuth.status).toBe(401);
    expect(await basicAuth.json()).toEqual({
      error: "API_KEY_REQUIRED",
      message: "API key is required",
    });

    const wrongKey = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/api-keys/me`, {
        headers: { "x-api-key": "mref_nonexistent_key_value" },
      }),
    );
    expect(wrongKey.status).toBe(401);
    expect(await wrongKey.json()).toEqual({
      error: "INVALID_API_KEY",
      message: "Invalid API key",
    });

    // Malformed JSON and invalid creation payloads return 400.
    const invalidCases: Array<{ body: string; expectedError: string }> = [
      { body: "{not-json", expectedError: "INVALID_JSON" },
      { body: JSON.stringify({ name: "   " }), expectedError: "INVALID_NAME" },
      { body: JSON.stringify({ name: "a".repeat(65) }), expectedError: "INVALID_NAME" },
      { body: JSON.stringify({ scopes: [] }), expectedError: "INVALID_PERMISSIONS" },
      { body: JSON.stringify({ scopes: ["admin"] }), expectedError: "INVALID_PERMISSIONS" },
      {
        body: JSON.stringify({ canSubmit: false, scopes: ["read_report", "submit"] }),
        expectedError: "INVALID_PERMISSIONS",
      },
      {
        body: JSON.stringify({ name: "Raw Perms", permissions: { media: ["submit"] } }),
        expectedError: "INVALID_PERMISSIONS",
      },
      { body: JSON.stringify({ expiresIn: 0 }), expectedError: "INVALID_EXPIRES_IN" },
      { body: JSON.stringify({ expiresIn: 12.5 }), expectedError: "INVALID_EXPIRES_IN" },
      { body: JSON.stringify({ expiresIn: 400 * 86_400 }), expectedError: "INVALID_EXPIRES_IN" },
    ];

    for (const testCase of invalidCases) {
      const res = await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/api-keys`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: user.cookie },
          body: testCase.body,
        }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: testCase.expectedError });
    }
  });

  test("default Cloudflare Worker fetch entrypoint verifies API keys with X-API-Key header and CORS support", async () => {
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

    const user = await signUpUser(app, outbound, {
      email: "worker-key@example.com",
      password: "StrongPassword123!",
      name: "Worker Key Dev",
      verify: true,
    });

    const createdRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/api-keys`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: user.cookie },
        body: JSON.stringify({ name: "Worker Key" }),
      }),
    );
    expect(createdRes.status).toBe(201);
    const created = (await createdRes.json()) as { id: string; key: string };

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
      new Request(`${TEST_BASE_URL}/v1/api-keys/me`, {
        headers: {
          "x-api-key": created.key,
          origin: "https://mediaref.org",
        },
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

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://mediaref.org");
    expect(await response.json()).toMatchObject({
      keyId: created.id,
      userId: user.userId,
      canSubmit: false,
    });
  });
});
