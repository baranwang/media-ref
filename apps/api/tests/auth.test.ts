import type { ExecutionContext, Hyperdrive, SendEmail } from "@cloudflare/workers-types";
import { createFakeOutboundClient } from "@media-ref/core";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, describe, expect, test } from "vite-plus/test";
import worker from "../src/index.ts";
import { createApiApp, createInMemoryRateLimiter } from "../src/lib.ts";
import {
  createRpcClients,
  expectRpcError,
  extractCookieHeader,
  extractVerificationUrl,
  TEST_BASE_URL,
} from "./rpc-helpers.ts";

const TEST_AUTH_SECRET = "test-secret-for-media-ref-api-auth-integration-tests-0123456789";

describe("API Worker auth HTTP + ConnectRPC entrypoint", () => {
  const handles: TestDbHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop();
      if (handle) {
        await handle.cleanup();
      }
    }
  });

  test("signs up with email + password, sends verification email via OutboundClient, and authenticates AccountService.GetCurrentUser", async () => {
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

    const unauthRpc = createRpcClients(app);
    const unauthErr = await expectRpcError(unauthRpc.account.getCurrentUser({}));
    expect(unauthErr.status).toBe(401);
    expect(unauthErr.code).toBe("UNAUTHORIZED");
    expect(unauthErr.message).toBe("Authentication required");

    const signUpRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "alice@example.com",
          password: "StrongPassword123!",
          name: "Alice",
          role: "reviewer",
        }),
      }),
    );

    expect(signUpRes.status).toBe(200);
    const signUpBody = (await signUpRes.json()) as {
      token: string | null;
      user: {
        id: string;
        email: string;
        name: string;
        emailVerified: boolean;
        role: string;
      };
    };

    expect(signUpBody.user).toMatchObject({
      email: "alice@example.com",
      name: "Alice",
      emailVerified: false,
      role: "user",
    });
    expect(typeof signUpBody.user.id).toBe("string");

    const cookieHeader = extractCookieHeader(signUpRes);
    expect(cookieHeader).toContain("session_token=");

    expect(outbound.sentEmails).toHaveLength(1);
    const email = outbound.sentEmails[0]!;
    expect(email.to).toBe("alice@example.com");
    const verifyUrl = extractVerificationUrl(email);
    expect(verifyUrl.startsWith(`${TEST_BASE_URL}/api/auth/verify-email?token=`)).toBe(true);
    expect(email.html).toContain(verifyUrl.replaceAll("&", "&amp;"));

    const authedRpc = createRpcClients(app, { cookie: cookieHeader });
    const meRes = await authedRpc.account.getCurrentUser({});
    expect(meRes.user).toMatchObject({
      id: signUpBody.user.id,
      email: "alice@example.com",
      name: "Alice",
      emailVerified: false,
      role: "user",
    });
  });

  test("limits sign-in attempts by Cloudflare client IP", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound: createFakeOutboundClient(),
      config: { baseUrl: TEST_BASE_URL, authSecret: TEST_AUTH_SECRET, readIpLimit: 1 },
    });
    const signIn = (ip: string) =>
      app.fetch(
        new Request(`${TEST_BASE_URL}/api/auth/sign-in/email`, {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": ip },
          body: JSON.stringify({ email: "visitor@example.test", password: "not-an-account" }),
        }),
      );
    expect((await signIn("192.0.2.1")).status).toBe(401);
    const limited = await signIn("192.0.2.1");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect((await signIn("192.0.2.2")).status).toBe(401);
  });

  test("applies the separate auth IP limit to auth POSTs only", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound: createFakeOutboundClient(),
      authIpLimiter: createInMemoryRateLimiter({ limit: 1, periodSeconds: 60 }),
      config: { baseUrl: TEST_BASE_URL, authSecret: TEST_AUTH_SECRET },
    });
    const auth = (path: string, method: "GET" | "POST") =>
      app.fetch(
        new Request(`${TEST_BASE_URL}/api/auth/${path}`, {
          method,
          headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.9" },
          ...(method === "POST"
            ? { body: JSON.stringify({ email: "visitor@example.test", password: "nope-nope" }) }
            : {}),
        }),
      );
    expect((await auth("sign-in/email", "POST")).status).toBe(401);
    expect((await auth("sign-in/email", "POST")).status).toBe(429);
    expect((await auth("get-session", "GET")).status).toBe(200);
  });

  test("signs in with email + password, authenticates subsequent requests, and invalidates session on sign out", async () => {
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

    const signUpRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "bob@example.com",
          password: "CorrectHorseBatteryStaple1!",
          name: "Bob",
        }),
      }),
    );
    expect(signUpRes.status).toBe(200);

    const wrongPasswordRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "bob@example.com",
          password: "WrongPassword999!",
        }),
      }),
    );
    expect(wrongPasswordRes.status).toBe(401);

    const signInRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "bob@example.com",
          password: "CorrectHorseBatteryStaple1!",
        }),
      }),
    );
    expect(signInRes.status).toBe(200);
    const sessionCookie = extractCookieHeader(signInRes);
    expect(sessionCookie).toContain("session_token=");

    const bobRpc = createRpcClients(app, { cookie: sessionCookie });
    const meBeforeSignOut = await bobRpc.account.getCurrentUser({});
    expect(meBeforeSignOut.user).toMatchObject({
      email: "bob@example.com",
      name: "Bob",
      emailVerified: false,
      role: "user",
    });

    const signOutRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/api/auth/sign-out`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: sessionCookie,
        },
        body: JSON.stringify({}),
      }),
    );
    expect(signOutRes.status).toBe(200);

    const meAfterSignOutErr = await expectRpcError(bobRpc.account.getCurrentUser({}));
    expect(meAfterSignOutErr.status).toBe(401);
  });

  test("blocks unverified users on verified-only RPCs and allows them after clicking verification link", async () => {
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

    const unauthErr = await expectRpcError(
      createRpcClients(app).account.createApiKey({ name: "No Auth" }),
    );
    expect(unauthErr.status).toBe(401);
    expect(unauthErr.code).toBe("UNAUTHORIZED");
    expect(unauthErr.message).toBe("Authentication required");

    const signUpRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "carol@example.com",
          password: "VerifyMePassword123!",
          name: "Carol",
        }),
      }),
    );
    expect(signUpRes.status).toBe(200);
    const signUpData = (await signUpRes.json()) as { user: { id: string } };
    const sessionCookie = extractCookieHeader(signUpRes);

    const blockedErr = await expectRpcError(
      createRpcClients(app, { cookie: sessionCookie }).account.createApiKey({ name: "Blocked" }),
    );
    expect(blockedErr.status).toBe(403);
    expect(blockedErr.code).toBe("EMAIL_NOT_VERIFIED");
    expect(blockedErr.message).toBe("Email verification is required");

    const resendRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/api/auth/send-verification-email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: sessionCookie,
        },
        body: JSON.stringify({ email: "carol@example.com" }),
      }),
    );
    expect(resendRes.status).toBe(200);
    expect(outbound.sentEmails).toHaveLength(2);

    const verificationUrl = extractVerificationUrl(outbound.sentEmails[1]!);
    const verifyRes = await app.fetch(
      new Request(verificationUrl, {
        method: "GET",
        headers: { cookie: sessionCookie },
      }),
    );
    expect([200, 302]).toContain(verifyRes.status);

    const refreshedCookie = extractCookieHeader(verifyRes) || sessionCookie;
    const verifiedRpc = createRpcClients(app, { cookie: refreshedCookie });

    const meAfterVerify = await verifiedRpc.account.getCurrentUser({});
    expect(meAfterVerify.user).toMatchObject({
      id: signUpData.user.id,
      email: "carol@example.com",
      name: "Carol",
      emailVerified: true,
      role: "user",
    });

    const allowedAction = await verifiedRpc.account.createApiKey({ name: "Verified Key" });
    expect(allowedAction.key.startsWith("mref_")).toBe(true);
    expect(allowedAction.apiKey?.name).toBe("Verified Key");
  });

  test("auto-signs in user when verification link is opened without an existing session cookie", async () => {
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

    const signUpRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "dave@example.com",
          password: "AutoSignInPassword123!",
          name: "Dave",
        }),
      }),
    );
    expect(signUpRes.status).toBe(200);

    const verificationUrl = extractVerificationUrl(outbound.sentEmails[0]!);
    const verifyRes = await app.fetch(new Request(verificationUrl, { method: "GET" }));
    expect([200, 302]).toContain(verifyRes.status);

    const autoSignedInCookie = extractCookieHeader(verifyRes);
    expect(autoSignedInCookie).toContain("session_token=");

    const daveRpc = createRpcClients(app, { cookie: autoSignedInCookie });
    const me = await daveRpc.account.getCurrentUser({});
    expect(me.user).toMatchObject({
      email: "dave@example.com",
      emailVerified: true,
    });
    const created = await daveRpc.account.createApiKey({ name: "Auto Verified Key" });
    expect(created.key.startsWith("mref_")).toBe(true);
  });

  test("shares the session cookie but grants credentialed CORS only to configured origins", async () => {
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
        cookieDomain: "mediaref.org",
        trustedOrigins: ["https://www.mediaref.org"],
      },
    });

    const signUpRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://mediaref.org",
        },
        body: JSON.stringify({
          email: "sub@example.com",
          password: "SubdomainPassword123!",
          name: "Subdomain User",
        }),
      }),
    );

    expect(signUpRes.status).toBe(200);
    expect(signUpRes.headers.get("access-control-allow-origin")).toBe("https://mediaref.org");
    expect(signUpRes.headers.get("access-control-allow-credentials")).toBe("true");

    const setCookies = signUpRes.headers.getSetCookie();
    const sessionSetCookie = setCookies.find((header) => header.includes("session_token="));
    expect(sessionSetCookie).toBeDefined();
    expect(sessionSetCookie).toMatch(/Domain=\.?mediaref\.org/i);
    expect(sessionSetCookie).toMatch(/HttpOnly/i);
    expect(sessionSetCookie).toMatch(/Secure/i);
    expect(sessionSetCookie).toMatch(/SameSite=Lax/i);

    const trustedPreflight = await app.fetch(
      new Request(`${TEST_BASE_URL}/mediaref.internal.v1.AccountService/GetCurrentUser`, {
        method: "OPTIONS",
        headers: {
          origin: "https://www.mediaref.org",
          "access-control-request-method": "POST",
        },
      }),
    );
    expect(trustedPreflight.status).toBe(204);
    expect(trustedPreflight.headers.get("access-control-allow-origin")).toBe(
      "https://www.mediaref.org",
    );
    expect(trustedPreflight.headers.get("access-control-allow-headers")).toContain(
      "Connect-Protocol-Version",
    );
    expect(trustedPreflight.headers.get("access-control-allow-headers")).toContain(
      "MCP-Protocol-Version",
    );

    const untrustedPreflight = await app.fetch(
      new Request(`${TEST_BASE_URL}/mediaref.internal.v1.AccountService/GetCurrentUser`, {
        method: "OPTIONS",
        headers: {
          origin: "https://unlisted.mediaref.org",
          "access-control-request-method": "POST",
        },
      }),
    );
    expect(untrustedPreflight.headers.has("access-control-allow-origin")).toBe(false);
    expect(untrustedPreflight.headers.has("access-control-allow-credentials")).toBe(false);
  });

  test("uses uncached dbWrite exclusively for auth operations and never queries dbRead", async () => {
    const writeOnlyDb = await createTestDb();
    const unmigratedReadDb = await createTestDb({ migrate: false });
    handles.push(writeOnlyDb, unmigratedReadDb);

    const outbound = createFakeOutboundClient();
    const app = createApiApp({
      dbRead: unmigratedReadDb.readDb,
      dbWrite: writeOnlyDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
      },
    });

    const signUpRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "writeonly@example.com",
          password: "WriteDbOnlyPassword123!",
          name: "Write Only",
        }),
      }),
    );
    expect(signUpRes.status).toBe(200);
    const cookie = extractCookieHeader(signUpRes);

    const verifyUrl = extractVerificationUrl(outbound.sentEmails[0]!);
    const verifyRes = await app.fetch(new Request(verifyUrl, { headers: { cookie } }));
    expect([200, 302]).toContain(verifyRes.status);

    const rpc = createRpcClients(app, { cookie: extractCookieHeader(verifyRes) || cookie });
    const meRes = await rpc.account.getCurrentUser({});
    expect(meRes.user).toMatchObject({
      email: "writeonly@example.com",
      emailVerified: true,
    });
  });

  test("default Cloudflare Worker fetch entrypoint delivers verification email via EMAIL SendEmail binding", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;

    const sentEmails: unknown[] = [];
    const emailBinding = {
      async send(payload: unknown) {
        sentEmails.push(payload);
        return { messageId: "cf-email-1" };
      },
    } as unknown as SendEmail;

    const hyperdrive = {
      connectionString: testDb.connectionString,
    } as Hyperdrive;

    const response = await worker.fetch(
      new Request(`${TEST_BASE_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "worker@example.com",
          password: "WorkerEmailPassword123!",
          name: "Worker User",
        }),
      }),
      {
        HYPERDRIVE_READ: hyperdrive,
        HYPERDRIVE_WRITE: hyperdrive,
        EMAIL: emailBinding,
        EMAIL_FROM: "verify@mediaref.org",
        AUTH_SECRET: TEST_AUTH_SECRET,
        API_BASE_URL: TEST_BASE_URL,
        COOKIE_DOMAIN: "mediaref.org",
      },
      ctx,
    );

    await Promise.all(pending);

    expect(response.status).toBe(200);
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]).toMatchObject({
      from: "verify@mediaref.org",
      to: "worker@example.com",
      subject: "Verify your media-ref email address",
    });
    const sessionSetCookie = response.headers
      .getSetCookie()
      .find((header) => header.includes("session_token="));
    expect(sessionSetCookie).toMatch(/Domain=\.?mediaref\.org/i);
  });
});
