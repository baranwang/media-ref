import type { ExecutionContext, Hyperdrive, SendEmail } from "@cloudflare/workers-types";
import { createFakeOutboundClient, type EmailMessage } from "@media-ref/core";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, describe, expect, test } from "vite-plus/test";
import worker, { createApiApp, requireVerifiedUser } from "../src/index.ts";

const TEST_BASE_URL = "https://api.mediaref.org";
const TEST_AUTH_SECRET = "test-secret-for-media-ref-api-auth-integration-tests-0123456789";

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

describe("API Worker auth HTTP entrypoint", () => {
  const handles: TestDbHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop();
      if (handle) {
        await handle.cleanup();
      }
    }
  });

  test("signs up with email + password, sends verification email via OutboundClient, and authenticates GET /v1/me", async () => {
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

    const unauthMe = await app.fetch(new Request(`${TEST_BASE_URL}/v1/me`));
    expect(unauthMe.status).toBe(401);
    expect(await unauthMe.json()).toEqual({
      error: "UNAUTHORIZED",
      message: "Authentication required",
    });

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

    const meRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/me`, {
        headers: { cookie: cookieHeader },
      }),
    );
    expect(meRes.status).toBe(200);
    expect(await meRes.json()).toEqual({
      id: signUpBody.user.id,
      email: "alice@example.com",
      name: "Alice",
      emailVerified: false,
      role: "user",
    });
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

    const meBeforeSignOut = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/me`, {
        headers: { cookie: sessionCookie },
      }),
    );
    expect(meBeforeSignOut.status).toBe(200);
    expect(await meBeforeSignOut.json()).toMatchObject({
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

    const meAfterSignOut = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/me`, {
        headers: { cookie: sessionCookie },
      }),
    );
    expect(meAfterSignOut.status).toBe(401);
  });

  test("blocks unverified users on requireVerifiedUser routes and allows them after clicking verification link", async () => {
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

    app.post("/v1/verified-action", requireVerifiedUser, (c) => {
      const session = c.get("session")!;
      return c.json({ ok: true, userId: session.user.id }, 200);
    });

    const unauthAction = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/verified-action`, { method: "POST" }),
    );
    expect(unauthAction.status).toBe(401);
    expect(await unauthAction.json()).toEqual({
      error: "UNAUTHORIZED",
      message: "Authentication required",
    });

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

    const blockedAction = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/verified-action`, {
        method: "POST",
        headers: { cookie: sessionCookie },
      }),
    );
    expect(blockedAction.status).toBe(403);
    expect(await blockedAction.json()).toEqual({
      error: "EMAIL_NOT_VERIFIED",
      message: "Email verification is required",
    });

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

    const meAfterVerify = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/me`, {
        headers: { cookie: refreshedCookie },
      }),
    );
    expect(meAfterVerify.status).toBe(200);
    expect(await meAfterVerify.json()).toEqual({
      id: signUpData.user.id,
      email: "carol@example.com",
      name: "Carol",
      emailVerified: true,
      role: "user",
    });

    const allowedAction = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/verified-action`, {
        method: "POST",
        headers: { cookie: refreshedCookie },
      }),
    );
    expect(allowedAction.status).toBe(200);
    expect(await allowedAction.json()).toEqual({
      ok: true,
      userId: signUpData.user.id,
    });
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

    app.post("/v1/verified-action", requireVerifiedUser, (c) => {
      const session = c.get("session")!;
      return c.json({ ok: true, email: session.user.email }, 200);
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

    const allowedAction = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/verified-action`, {
        method: "POST",
        headers: { cookie: autoSignedInCookie },
      }),
    );
    expect(allowedAction.status).toBe(200);
    expect(await allowedAction.json()).toEqual({
      ok: true,
      email: "dave@example.com",
    });
  });

  test("sets cross-subdomain session cookie Domain and allows trusted subdomain CORS when cookieDomain is configured", async () => {
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

    const untrustedPreflight = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/me`, {
        method: "OPTIONS",
        headers: {
          origin: "https://evil.example",
          "access-control-request-method": "GET",
        },
      }),
    );
    expect(untrustedPreflight.headers.get("access-control-allow-origin")).not.toBe(
      "https://evil.example",
    );
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

    const meRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/me`, {
        headers: { cookie: extractCookieHeader(verifyRes) || cookie },
      }),
    );
    expect(meRes.status).toBe(200);
    expect(await meRes.json()).toMatchObject({
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
