import type { ExecutionContext, Hyperdrive } from "@cloudflare/workers-types";
import {
  createFakeOutboundClient,
  type ExternalHttpRequest,
  type ExternalHttpResponse,
} from "@media-ref/core";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, describe, expect, test } from "vite-plus/test";
import worker from "../src/index.ts";
import { createApiApp } from "../src/lib.ts";
import {
  createRpcClients,
  expectRpcError,
  extractCookieHeader,
  extractVerificationUrl,
  mergeCookies,
  TEST_BASE_URL,
} from "./rpc-helpers.ts";

const TEST_WEBSITE_URL = "https://mediaref.org";
const TEST_AUTH_SECRET = "test-secret-for-media-ref-api-oauth-integration-tests-0123456789";

const TEST_GITHUB_CREDS = {
  clientId: "gh-client-id-test",
  clientSecret: "gh-client-secret-test",
};

const TEST_TRAKT_CREDS = {
  clientId: "trakt-client-id-test",
  clientSecret: "trakt-client-secret-test",
};

function jsonResponse(url: string, data: unknown, status = 200): ExternalHttpResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
    url,
  };
}

describe("API Worker OAuth HTTP entrypoint (GitHub & Trakt)", () => {
  const handles: TestDbHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop();
      if (handle) {
        await handle.cleanup();
      }
    }
  });

  test("GitHub OAuth with verified primary email signs in with emailVerified=true, sends no verification email, and passes verified-only RPCs", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const outbound = createFakeOutboundClient({
      fetchExternal: async (req: ExternalHttpRequest): Promise<ExternalHttpResponse> => {
        if (req.url === "https://github.com/login/oauth/access_token" && req.method === "POST") {
          const params = new URLSearchParams(req.body ?? "");
          expect(params.get("code")).toBe("gh-auth-code-1");
          expect(params.get("client_id")).toBe(TEST_GITHUB_CREDS.clientId);
          expect(params.get("client_secret")).toBe(TEST_GITHUB_CREDS.clientSecret);
          expect(params.get("redirect_uri")).toBe(`${TEST_BASE_URL}/api/auth/callback/github`);
          return jsonResponse(req.url, {
            access_token: "gho_verified_token_1",
            token_type: "bearer",
            scope: "read:user,user:email",
          });
        }
        if (req.url === "https://api.github.com/user" && req.method === "GET") {
          expect(req.headers?.authorization).toBe("Bearer gho_verified_token_1");
          return jsonResponse(req.url, {
            id: 424242,
            login: "octodev",
            name: "Octo Dev",
            email: null,
            avatar_url: "https://avatars.githubusercontent.com/u/424242",
          });
        }
        if (req.url === "https://api.github.com/user/emails" && req.method === "GET") {
          expect(req.headers?.authorization).toBe("Bearer gho_verified_token_1");
          return jsonResponse(req.url, [
            { email: "secondary@example.com", primary: false, verified: true },
            { email: "octo@example.com", primary: true, verified: true },
          ]);
        }
        throw new Error(`Unexpected outbound request: ${req.method} ${req.url}`);
      },
    });

    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        trustedOrigins: [TEST_WEBSITE_URL],
        oauth: {
          github: TEST_GITHUB_CREDS,
        },
      },
    });

    const initRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "github",
          callbackURL: `${TEST_WEBSITE_URL}/dashboard`,
          errorCallbackURL: `${TEST_WEBSITE_URL}/auth/error`,
        }),
      }),
    );

    expect(initRes.status).toBe(200);
    const initBody = (await initRes.json()) as { url: string; redirect: boolean };
    const authUrl = new URL(initBody.url);
    expect(authUrl.origin).toBe("https://github.com");
    expect(authUrl.pathname).toBe("/login/oauth/authorize");
    expect(authUrl.searchParams.get("client_id")).toBe(TEST_GITHUB_CREDS.clientId);
    expect(authUrl.searchParams.get("redirect_uri")).toBe(
      `${TEST_BASE_URL}/api/auth/callback/github`,
    );
    const state = authUrl.searchParams.get("state");
    expect(state).toBeTruthy();

    const stateCookie = extractCookieHeader(initRes);
    const callbackRes = await app.fetch(
      new Request(
        `${TEST_BASE_URL}/api/auth/callback/github?code=gh-auth-code-1&state=${encodeURIComponent(state!)}`,
        {
          method: "GET",
          headers: { cookie: stateCookie },
        },
      ),
    );

    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.get("location")).toBe(`${TEST_WEBSITE_URL}/dashboard`);
    const sessionCookie = mergeCookies(stateCookie, extractCookieHeader(callbackRes));
    expect(sessionCookie).toContain("session_token=");

    expect(outbound.sentEmails).toHaveLength(0);
    expect(outbound.httpRequests.map((r) => `${r.kind}:${r.namespace}:${r.url}`)).toEqual([
      "oauth:github:https://github.com/login/oauth/access_token",
      "oauth:github:https://api.github.com/user",
      "oauth:github:https://api.github.com/user/emails",
    ]);

    const rpc = createRpcClients(app, { cookie: sessionCookie });
    const me = (await rpc.account.getCurrentUser({})).user!;
    expect(me).toMatchObject({
      email: "octo@example.com",
      name: "Octo Dev",
      emailVerified: true,
      role: "user",
    });

    // Verified GitHub user can create an API key immediately without additional email verification.
    const createdKey = await rpc.account.createApiKey({ name: "GitHub Key" });
    expect(createdKey.key.startsWith("mref_")).toBe(true);
    expect(createdKey.apiKey?.name).toBe("GitHub Key");
  });

  test("GitHub OAuth with unverified primary email keeps emailVerified=false, sends verification email, and unlocks after verification", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const outbound = createFakeOutboundClient({
      fetchExternal: async (req: ExternalHttpRequest): Promise<ExternalHttpResponse> => {
        if (req.url === "https://github.com/login/oauth/access_token") {
          return jsonResponse(req.url, {
            access_token: "gho_unverified_token_1",
            token_type: "bearer",
            scope: "read:user,user:email",
          });
        }
        if (req.url === "https://api.github.com/user") {
          return jsonResponse(req.url, {
            id: 515151,
            login: "unverified-octo",
            name: "Unverified Octo",
            email: "unverified-gh@example.com",
            avatar_url: "https://avatars.githubusercontent.com/u/515151",
          });
        }
        if (req.url === "https://api.github.com/user/emails") {
          return jsonResponse(req.url, [
            { email: "unverified-gh@example.com", primary: true, verified: false },
          ]);
        }
        throw new Error(`Unexpected outbound request: ${req.method} ${req.url}`);
      },
    });

    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        trustedOrigins: [TEST_WEBSITE_URL],
        oauth: {
          github: TEST_GITHUB_CREDS,
        },
      },
    });

    const initRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "github",
          callbackURL: `${TEST_WEBSITE_URL}/dashboard`,
          errorCallbackURL: `${TEST_WEBSITE_URL}/auth/error`,
        }),
      }),
    );
    expect(initRes.status).toBe(200);
    const { url } = (await initRes.json()) as { url: string };
    const state = new URL(url).searchParams.get("state")!;
    const stateCookie = extractCookieHeader(initRes);

    const callbackRes = await app.fetch(
      new Request(
        `${TEST_BASE_URL}/api/auth/callback/github?code=gh-unverified-code&state=${encodeURIComponent(state)}`,
        {
          method: "GET",
          headers: { cookie: stateCookie },
        },
      ),
    );
    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.get("location")).toBe(`${TEST_WEBSITE_URL}/dashboard`);
    const sessionCookie = mergeCookies(stateCookie, extractCookieHeader(callbackRes));

    expect(outbound.sentEmails).toHaveLength(1);
    expect(outbound.sentEmails[0]!.to).toBe("unverified-gh@example.com");

    const unverifiedRpc = createRpcClients(app, { cookie: sessionCookie });
    const meBefore = (await unverifiedRpc.account.getCurrentUser({})).user!;
    expect(meBefore.emailVerified).toBe(false);

    const blockedErr = await expectRpcError(
      unverifiedRpc.account.createApiKey({ name: "Blocked Key" }),
    );
    expect(blockedErr.status).toBe(403);
    expect(blockedErr.code).toBe("EMAIL_NOT_VERIFIED");
    expect(blockedErr.message).toBe("Email verification is required");

    const verifyUrl = extractVerificationUrl(outbound.sentEmails[0]!);
    const verifyRes = await app.fetch(
      new Request(verifyUrl, { headers: { cookie: sessionCookie } }),
    );
    expect([200, 302]).toContain(verifyRes.status);
    const verifiedCookie = mergeCookies(sessionCookie, extractCookieHeader(verifyRes));

    const verifiedRpc = createRpcClients(app, { cookie: verifiedCookie });
    const allowedRes = await verifiedRpc.account.createApiKey({ name: "Verified Key" });
    expect(allowedRes.key.startsWith("mref_")).toBe(true);
  });

  test("Trakt OAuth via genericOAuth creates unverified user, sends verification email, blocks verified-only RPCs until verified, and reuses account on repeat login", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    let tokenCalls = 0;
    const outbound = createFakeOutboundClient({
      fetchExternal: async (req: ExternalHttpRequest): Promise<ExternalHttpResponse> => {
        if (req.url === "https://api.trakt.tv/oauth/token" && req.method === "POST") {
          tokenCalls += 1;
          expect(req.kind).toBe("catalog");
          expect(req.namespace).toBe("trakt");
          // Trakt's edge returns 403 to requests without a User-Agent
          expect(req.headers?.["user-agent"]).toBe("media-ref");
          const payload = JSON.parse(req.body ?? "{}") as Record<string, string>;
          expect(payload).toEqual({
            code: `trakt-code-${tokenCalls}`,
            client_id: TEST_TRAKT_CREDS.clientId,
            client_secret: TEST_TRAKT_CREDS.clientSecret,
            redirect_uri: `${TEST_BASE_URL}/api/auth/callback/trakt`,
            grant_type: "authorization_code",
          });
          return jsonResponse(req.url, {
            access_token: `trakt_access_${tokenCalls}`,
            token_type: "bearer",
            expires_in: 7776000,
            refresh_token: `trakt_refresh_${tokenCalls}`,
            scope: "public",
            created_at: 1700000000,
          });
        }
        if (req.url === "https://api.trakt.tv/users/settings" && req.method === "GET") {
          expect(req.kind).toBe("catalog");
          expect(req.namespace).toBe("trakt");
          expect(req.headers?.authorization).toBe(`Bearer trakt_access_${tokenCalls}`);
          expect(req.headers?.["trakt-api-version"]).toBe("2");
          expect(req.headers?.["trakt-api-key"]).toBe(TEST_TRAKT_CREDS.clientId);
          expect(req.headers?.["user-agent"]).toBe("media-ref");
          return jsonResponse(req.url, {
            user: {
              username: "cinephile",
              name: "Cine Phile",
              email: "cinephile@example.com",
              ids: {
                slug: "cinephile",
                uuid: "trakt-uuid-001",
              },
              images: {
                avatar: {
                  full: "https://walter.trakt.tv/images/users/cinephile.jpg",
                },
              },
            },
          });
        }
        throw new Error(`Unexpected outbound request: ${req.method} ${req.url}`);
      },
    });

    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        trustedOrigins: [TEST_WEBSITE_URL],
        oauth: {
          trakt: TEST_TRAKT_CREDS,
        },
      },
    });

    const initRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "trakt",
          callbackURL: `${TEST_WEBSITE_URL}/dashboard`,
          errorCallbackURL: `${TEST_WEBSITE_URL}/auth/error`,
        }),
      }),
    );

    expect(initRes.status).toBe(200);
    const initBody = (await initRes.json()) as { url: string };
    const authUrl = new URL(initBody.url);
    expect(authUrl.origin).toBe("https://trakt.tv");
    expect(authUrl.pathname).toBe("/oauth/authorize");
    expect(authUrl.searchParams.get("client_id")).toBe(TEST_TRAKT_CREDS.clientId);
    expect(authUrl.searchParams.get("redirect_uri")).toBe(
      `${TEST_BASE_URL}/api/auth/callback/trakt`,
    );
    expect(authUrl.searchParams.get("code_challenge")).toBeNull();
    const state = authUrl.searchParams.get("state")!;
    const stateCookie = extractCookieHeader(initRes);

    const callbackRes = await app.fetch(
      new Request(
        `${TEST_BASE_URL}/api/auth/callback/trakt?code=trakt-code-1&state=${encodeURIComponent(state)}`,
        {
          method: "GET",
          headers: { cookie: stateCookie },
        },
      ),
    );

    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.get("location")).toBe(`${TEST_WEBSITE_URL}/dashboard`);
    const sessionCookie = mergeCookies(stateCookie, extractCookieHeader(callbackRes));
    expect(sessionCookie).toContain("session_token=");

    expect(outbound.sentEmails).toHaveLength(1);
    expect(outbound.sentEmails[0]!.to).toBe("cinephile@example.com");

    const unverifiedRpc = createRpcClients(app, { cookie: sessionCookie });
    const firstUser = (await unverifiedRpc.account.getCurrentUser({})).user!;
    expect(firstUser).toMatchObject({
      email: "cinephile@example.com",
      name: "Cine Phile",
      emailVerified: false,
      role: "user",
    });

    const blockedKeyErr = await expectRpcError(
      unverifiedRpc.account.createApiKey({ name: "Blocked Trakt Key" }),
    );
    expect(blockedKeyErr.status).toBe(403);
    expect(blockedKeyErr.code).toBe("EMAIL_NOT_VERIFIED");
    expect(blockedKeyErr.message).toBe("Email verification is required");

    const verifyUrl = extractVerificationUrl(outbound.sentEmails[0]!);
    const verifyRes = await app.fetch(
      new Request(verifyUrl, { headers: { cookie: sessionCookie } }),
    );
    expect([200, 302]).toContain(verifyRes.status);
    const verifiedCookie = mergeCookies(sessionCookie, extractCookieHeader(verifyRes));

    const verifiedRpc = createRpcClients(app, { cookie: verifiedCookie });
    const meAfter = (await verifiedRpc.account.getCurrentUser({})).user!;
    expect(meAfter).toMatchObject({
      id: firstUser.id,
      email: "cinephile@example.com",
      emailVerified: true,
    });

    const allowedKey = await verifiedRpc.account.createApiKey({ name: "Verified Trakt Key" });
    expect(allowedKey.key.startsWith("mref_")).toBe(true);

    // Second Trakt sign-in reuses the existing verified user without re-sending verification email.
    const secondInitRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "trakt",
          callbackURL: `${TEST_WEBSITE_URL}/dashboard`,
        }),
      }),
    );
    const secondState = new URL(
      ((await secondInitRes.json()) as { url: string }).url,
    ).searchParams.get("state")!;
    const secondStateCookie = extractCookieHeader(secondInitRes);

    const secondCallbackRes = await app.fetch(
      new Request(
        `${TEST_BASE_URL}/api/auth/callback/trakt?code=trakt-code-2&state=${encodeURIComponent(secondState)}`,
        {
          method: "GET",
          headers: { cookie: secondStateCookie },
        },
      ),
    );
    expect(secondCallbackRes.status).toBe(302);
    const secondSessionCookie = mergeCookies(
      secondStateCookie,
      extractCookieHeader(secondCallbackRes),
    );

    const meRepeat = (
      await createRpcClients(app, { cookie: secondSessionCookie }).account.getCurrentUser({})
    ).user!;
    expect(meRepeat).toMatchObject({
      id: firstUser.id,
      email: "cinephile@example.com",
      emailVerified: true,
    });
    expect(outbound.sentEmails).toHaveLength(1);
  });

  test("Trakt OAuth rejects missing or empty user.email cleanly without creating a broken account", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const outbound = createFakeOutboundClient({
      fetchExternal: async (req: ExternalHttpRequest): Promise<ExternalHttpResponse> => {
        if (req.url === "https://api.trakt.tv/oauth/token") {
          return jsonResponse(req.url, {
            access_token: "trakt_no_email_token",
            token_type: "bearer",
            expires_in: 7776000,
          });
        }
        if (req.url === "https://api.trakt.tv/users/settings") {
          return jsonResponse(req.url, {
            user: {
              username: "private-trakt",
              name: "Private Trakt",
              email: "   ",
              ids: { slug: "private-trakt", uuid: "trakt-uuid-no-email" },
            },
          });
        }
        throw new Error(`Unexpected outbound request: ${req.method} ${req.url}`);
      },
    });

    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        trustedOrigins: [TEST_WEBSITE_URL],
        oauth: {
          trakt: TEST_TRAKT_CREDS,
        },
      },
    });

    const initRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "trakt",
          callbackURL: `${TEST_WEBSITE_URL}/dashboard`,
          errorCallbackURL: `${TEST_WEBSITE_URL}/auth/error`,
        }),
      }),
    );
    expect(initRes.status).toBe(200);
    const state = new URL(((await initRes.json()) as { url: string }).url).searchParams.get(
      "state",
    )!;
    const stateCookie = extractCookieHeader(initRes);

    const callbackRes = await app.fetch(
      new Request(
        `${TEST_BASE_URL}/api/auth/callback/trakt?code=trakt-no-email&state=${encodeURIComponent(state)}`,
        {
          method: "GET",
          headers: { cookie: stateCookie },
        },
      ),
    );

    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.get("location")).toBe(
      `${TEST_WEBSITE_URL}/auth/error?error=email_not_found`,
    );
    expect(extractCookieHeader(callbackRes)).not.toContain("session_token=");
    expect(outbound.sentEmails).toHaveLength(0);

    const users = await testDb.writeDb.selectFrom("user").selectAll().execute();
    expect(users).toHaveLength(0);
  });

  test("same-email policy: verified email+password user auto-links verified GitHub login to the same account", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const outbound = createFakeOutboundClient({
      fetchExternal: async (req: ExternalHttpRequest): Promise<ExternalHttpResponse> => {
        if (req.url === "https://github.com/login/oauth/access_token") {
          return jsonResponse(req.url, {
            access_token: "gho_link_verified_1",
            token_type: "bearer",
            scope: "read:user,user:email",
          });
        }
        if (req.url === "https://api.github.com/user") {
          return jsonResponse(req.url, {
            id: 700001,
            login: "shared-user",
            name: "Shared User GH",
            email: "shared@example.com",
          });
        }
        if (req.url === "https://api.github.com/user/emails") {
          return jsonResponse(req.url, [
            { email: "shared@example.com", primary: true, verified: true },
          ]);
        }
        throw new Error(`Unexpected outbound request: ${req.method} ${req.url}`);
      },
    });

    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        trustedOrigins: [TEST_WEBSITE_URL],
        oauth: { github: TEST_GITHUB_CREDS, trakt: TEST_TRAKT_CREDS },
      },
    });

    const signUpRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "shared@example.com",
          password: "SharedPassword123!",
          name: "Shared User",
        }),
      }),
    );
    expect(signUpRes.status).toBe(200);
    const signUpData = (await signUpRes.json()) as { user: { id: string } };
    expect(outbound.sentEmails).toHaveLength(1);

    const verifyRes = await app.fetch(new Request(extractVerificationUrl(outbound.sentEmails[0]!)));
    expect([200, 302]).toContain(verifyRes.status);

    // Now log in via GitHub using the same verified email.
    const initRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "github",
          callbackURL: `${TEST_WEBSITE_URL}/dashboard`,
          errorCallbackURL: `${TEST_WEBSITE_URL}/auth/error`,
        }),
      }),
    );
    const state = new URL(((await initRes.json()) as { url: string }).url).searchParams.get(
      "state",
    )!;
    const stateCookie = extractCookieHeader(initRes);

    const callbackRes = await app.fetch(
      new Request(
        `${TEST_BASE_URL}/api/auth/callback/github?code=gh-link-code&state=${encodeURIComponent(state)}`,
        {
          method: "GET",
          headers: { cookie: stateCookie },
        },
      ),
    );
    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.get("location")).toBe(`${TEST_WEBSITE_URL}/dashboard`);
    const ghSessionCookie = mergeCookies(stateCookie, extractCookieHeader(callbackRes));

    const meRes = await createRpcClients(app, { cookie: ghSessionCookie }).account.getCurrentUser(
      {},
    );
    expect(meRes.user).toMatchObject({
      id: signUpData.user.id,
      email: "shared@example.com",
      emailVerified: true,
    });
    expect(outbound.sentEmails).toHaveLength(1);

    const accountsRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/api/auth/list-accounts`, {
        headers: { cookie: ghSessionCookie },
      }),
    );
    expect(accountsRes.status).toBe(200);
    const accounts = (await accountsRes.json()) as Array<{ providerId: string }>;
    expect(accounts.map((a) => a.providerId).sort()).toEqual(["credential", "github"]);
  });

  test("same-email policy: rejects unverified Trakt and unverified GitHub logins against an existing verified account to prevent takeover", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const outbound = createFakeOutboundClient({
      fetchExternal: async (req: ExternalHttpRequest): Promise<ExternalHttpResponse> => {
        if (req.url === "https://api.trakt.tv/oauth/token") {
          return jsonResponse(req.url, {
            access_token: "trakt_takeover_attempt",
            token_type: "bearer",
            expires_in: 7776000,
          });
        }
        if (req.url === "https://api.trakt.tv/users/settings") {
          return jsonResponse(req.url, {
            user: {
              username: "attacker-trakt",
              name: "Attacker Trakt",
              email: "protected@example.com",
              ids: { slug: "attacker-trakt", uuid: "trakt-uuid-attacker" },
            },
          });
        }
        if (req.url === "https://github.com/login/oauth/access_token") {
          return jsonResponse(req.url, {
            access_token: "gho_unverified_takeover_attempt",
            token_type: "bearer",
            scope: "read:user,user:email",
          });
        }
        if (req.url === "https://api.github.com/user") {
          return jsonResponse(req.url, {
            id: 999001,
            login: "attacker-gh",
            name: "Attacker GH",
            email: "protected@example.com",
          });
        }
        if (req.url === "https://api.github.com/user/emails") {
          return jsonResponse(req.url, [
            { email: "protected@example.com", primary: true, verified: false },
          ]);
        }
        throw new Error(`Unexpected outbound request: ${req.method} ${req.url}`);
      },
    });

    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        trustedOrigins: [TEST_WEBSITE_URL],
        oauth: { github: TEST_GITHUB_CREDS, trakt: TEST_TRAKT_CREDS },
      },
    });

    const signUpRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "protected@example.com",
          password: "ProtectedPassword123!",
          name: "Protected Owner",
        }),
      }),
    );
    expect(signUpRes.status).toBe(200);
    const ownerCookie = extractCookieHeader(signUpRes);
    const verifyRes = await app.fetch(
      new Request(extractVerificationUrl(outbound.sentEmails[0]!), {
        headers: { cookie: ownerCookie },
      }),
    );
    expect([200, 302]).toContain(verifyRes.status);
    const verifiedOwnerCookie = mergeCookies(ownerCookie, extractCookieHeader(verifyRes));

    // Attempt 1: Trakt login with the same (unverified) email must be rejected.
    const traktInit = await app.fetch(
      new Request(`${TEST_BASE_URL}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "trakt",
          callbackURL: `${TEST_WEBSITE_URL}/dashboard`,
          errorCallbackURL: `${TEST_WEBSITE_URL}/auth/error`,
        }),
      }),
    );
    const traktState = new URL(((await traktInit.json()) as { url: string }).url).searchParams.get(
      "state",
    )!;
    const traktStateCookie = extractCookieHeader(traktInit);

    const traktCallback = await app.fetch(
      new Request(
        `${TEST_BASE_URL}/api/auth/callback/trakt?code=trakt-takeover&state=${encodeURIComponent(traktState)}`,
        {
          method: "GET",
          headers: { cookie: traktStateCookie },
        },
      ),
    );
    expect(traktCallback.status).toBe(302);
    expect(traktCallback.headers.get("location")).toBe(
      `${TEST_WEBSITE_URL}/auth/error?error=account_not_linked`,
    );
    expect(extractCookieHeader(traktCallback)).not.toContain("session_token=");

    // Attempt 2: GitHub login whose primary email is unverified (verified: false) must also be rejected.
    const ghInit = await app.fetch(
      new Request(`${TEST_BASE_URL}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "github",
          callbackURL: `${TEST_WEBSITE_URL}/dashboard`,
          errorCallbackURL: `${TEST_WEBSITE_URL}/auth/error`,
        }),
      }),
    );
    const ghState = new URL(((await ghInit.json()) as { url: string }).url).searchParams.get(
      "state",
    )!;
    const ghStateCookie = extractCookieHeader(ghInit);

    const ghCallback = await app.fetch(
      new Request(
        `${TEST_BASE_URL}/api/auth/callback/github?code=gh-takeover&state=${encodeURIComponent(ghState)}`,
        {
          method: "GET",
          headers: { cookie: ghStateCookie },
        },
      ),
    );
    expect(ghCallback.status).toBe(302);
    expect(ghCallback.headers.get("location")).toBe(
      `${TEST_WEBSITE_URL}/auth/error?error=account_not_linked`,
    );
    expect(extractCookieHeader(ghCallback)).not.toContain("session_token=");

    // Owner still has only their original credential account linked.
    const accountsRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/api/auth/list-accounts`, {
        headers: { cookie: verifiedOwnerCookie },
      }),
    );
    expect(accountsRes.status).toBe(200);
    const accounts = (await accountsRes.json()) as Array<{ providerId: string }>;
    expect(accounts.map((a) => a.providerId)).toEqual(["credential"]);
  });

  test("same-email policy: verified GitHub account rejects Trakt takeover, and unverified local/Trakt account blocks GitHub auto-linking until verified", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    let scenario: "gh-first" | "trakt-first" = "gh-first";
    const outbound = createFakeOutboundClient({
      fetchExternal: async (req: ExternalHttpRequest): Promise<ExternalHttpResponse> => {
        if (req.url === "https://github.com/login/oauth/access_token") {
          return jsonResponse(req.url, {
            access_token: `gho_${scenario}`,
            token_type: "bearer",
            scope: "read:user,user:email",
          });
        }
        if (req.url === "https://api.github.com/user") {
          const isGhFirst = scenario === "gh-first";
          return jsonResponse(req.url, {
            id: isGhFirst ? 800001 : 800002,
            login: isGhFirst ? "gh-first" : "trakt-then-gh",
            name: isGhFirst ? "GH First" : "Trakt Then GH",
            email: isGhFirst ? "gh-first@example.com" : "trakt-first@example.com",
          });
        }
        if (req.url === "https://api.github.com/user/emails") {
          const email =
            scenario === "gh-first" ? "gh-first@example.com" : "trakt-first@example.com";
          return jsonResponse(req.url, [{ email, primary: true, verified: true }]);
        }
        if (req.url === "https://api.trakt.tv/oauth/token") {
          return jsonResponse(req.url, {
            access_token: `trakt_${scenario}`,
            token_type: "bearer",
            expires_in: 7776000,
          });
        }
        if (req.url === "https://api.trakt.tv/users/settings") {
          const isGhFirst = scenario === "gh-first";
          return jsonResponse(req.url, {
            user: {
              username: isGhFirst ? "trakt-intruder" : "trakt-owner",
              name: isGhFirst ? "Trakt Intruder" : "Trakt Owner",
              email: isGhFirst ? "gh-first@example.com" : "trakt-first@example.com",
              ids: {
                slug: isGhFirst ? "trakt-intruder" : "trakt-owner",
                uuid: isGhFirst ? "trakt-uuid-intruder" : "trakt-uuid-owner",
              },
            },
          });
        }
        throw new Error(`Unexpected outbound request: ${req.method} ${req.url}`);
      },
    });

    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        trustedOrigins: [TEST_WEBSITE_URL],
        oauth: { github: TEST_GITHUB_CREDS, trakt: TEST_TRAKT_CREDS },
      },
    });

    const runProviderFlow = async (provider: "github" | "trakt", code: string) => {
      const initRes = await app.fetch(
        new Request(`${TEST_BASE_URL}/api/auth/sign-in/social`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            provider,
            callbackURL: `${TEST_WEBSITE_URL}/dashboard`,
            errorCallbackURL: `${TEST_WEBSITE_URL}/auth/error`,
          }),
        }),
      );
      expect(initRes.status).toBe(200);
      const state = new URL(((await initRes.json()) as { url: string }).url).searchParams.get(
        "state",
      )!;
      const stateCookie = extractCookieHeader(initRes);
      const callbackRes = await app.fetch(
        new Request(
          `${TEST_BASE_URL}/api/auth/callback/${provider}?code=${code}&state=${encodeURIComponent(state)}`,
          { method: "GET", headers: { cookie: stateCookie } },
        ),
      );
      return {
        callbackRes,
        sessionCookie: mergeCookies(stateCookie, extractCookieHeader(callbackRes)),
      };
    };

    // Scenario A: Verified GitHub user -> Trakt with same email must be rejected.
    scenario = "gh-first";
    const ghFirst = await runProviderFlow("github", "gh-1");
    expect(ghFirst.callbackRes.headers.get("location")).toBe(`${TEST_WEBSITE_URL}/dashboard`);

    const traktVsGh = await runProviderFlow("trakt", "trakt-vs-gh");
    expect(traktVsGh.callbackRes.status).toBe(302);
    expect(traktVsGh.callbackRes.headers.get("location")).toBe(
      `${TEST_WEBSITE_URL}/auth/error?error=account_not_linked`,
    );
    expect(extractCookieHeader(traktVsGh.callbackRes)).not.toContain("session_token=");

    // Scenario B: Unverified Trakt user -> GitHub is blocked until Trakt user verifies email, then links cleanly.
    scenario = "trakt-first";
    const traktFirst = await runProviderFlow("trakt", "trakt-1");
    expect(traktFirst.callbackRes.headers.get("location")).toBe(`${TEST_WEBSITE_URL}/dashboard`);
    const traktMe = (
      await createRpcClients(app, { cookie: traktFirst.sessionCookie }).account.getCurrentUser({})
    ).user!;
    expect(traktMe.emailVerified).toBe(false);
    expect(outbound.sentEmails).toHaveLength(1);

    const ghBeforeVerify = await runProviderFlow("github", "gh-before-verify");
    expect(ghBeforeVerify.callbackRes.headers.get("location")).toBe(
      `${TEST_WEBSITE_URL}/auth/error?error=account_not_linked`,
    );

    const verifyTraktRes = await app.fetch(
      new Request(extractVerificationUrl(outbound.sentEmails[0]!), {
        headers: { cookie: traktFirst.sessionCookie },
      }),
    );
    expect([200, 302]).toContain(verifyTraktRes.status);

    const ghAfterVerify = await runProviderFlow("github", "gh-after-verify");
    expect(ghAfterVerify.callbackRes.headers.get("location")).toBe(`${TEST_WEBSITE_URL}/dashboard`);
    const linkedMe = (
      await createRpcClients(app, { cookie: ghAfterVerify.sessionCookie }).account.getCurrentUser(
        {},
      )
    ).user!;
    expect(linkedMe).toMatchObject({
      id: traktMe.id,
      email: "trakt-first@example.com",
      emailVerified: true,
    });

    const accountsRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/api/auth/list-accounts`, {
        headers: { cookie: ghAfterVerify.sessionCookie },
      }),
    );
    const accounts = (await accountsRes.json()) as Array<{ providerId: string }>;
    expect(accounts.map((a) => a.providerId).sort()).toEqual(["github", "trakt"]);

    // Scenario C: Unverified email+password pre-registration blocks verified GitHub auto-linking.
    const preRegEmail = "prereg@example.com";
    const preRegRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: preRegEmail,
          password: "AttackerPassword123!",
          name: "PreReg Attacker",
        }),
      }),
    );
    expect(preRegRes.status).toBe(200);

    const ghPreRegOutbound = createFakeOutboundClient({
      fetchExternal: async (req: ExternalHttpRequest): Promise<ExternalHttpResponse> => {
        if (req.url === "https://github.com/login/oauth/access_token") {
          return jsonResponse(req.url, {
            access_token: "gho_prereg",
            token_type: "bearer",
            scope: "read:user,user:email",
          });
        }
        if (req.url === "https://api.github.com/user") {
          return jsonResponse(req.url, {
            id: 800099,
            login: "real-owner",
            name: "Real Owner",
            email: preRegEmail,
          });
        }
        if (req.url === "https://api.github.com/user/emails") {
          return jsonResponse(req.url, [{ email: preRegEmail, primary: true, verified: true }]);
        }
        throw new Error(`Unexpected outbound request: ${req.method} ${req.url}`);
      },
    });
    const preRegApp = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound: ghPreRegOutbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        trustedOrigins: [TEST_WEBSITE_URL],
        oauth: { github: TEST_GITHUB_CREDS },
      },
    });
    const preRegInit = await preRegApp.fetch(
      new Request(`${TEST_BASE_URL}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "github",
          callbackURL: `${TEST_WEBSITE_URL}/dashboard`,
          errorCallbackURL: `${TEST_WEBSITE_URL}/auth/error`,
        }),
      }),
    );
    const preRegState = new URL(
      ((await preRegInit.json()) as { url: string }).url,
    ).searchParams.get("state")!;
    const preRegStateCookie = extractCookieHeader(preRegInit);
    const preRegCallback = await preRegApp.fetch(
      new Request(
        `${TEST_BASE_URL}/api/auth/callback/github?code=gh-prereg&state=${encodeURIComponent(preRegState)}`,
        { method: "GET", headers: { cookie: preRegStateCookie } },
      ),
    );
    expect(preRegCallback.status).toBe(302);
    expect(preRegCallback.headers.get("location")).toBe(
      `${TEST_WEBSITE_URL}/auth/error?error=account_not_linked`,
    );
    expect(extractCookieHeader(preRegCallback)).not.toContain("session_token=");
  });

  test("OAuth token exchange refuses HTTP redirects and reports invalid_code without creating a session", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const outbound = createFakeOutboundClient({
      fetchExternal: async (req: ExternalHttpRequest): Promise<ExternalHttpResponse> => {
        expect(req.redirect).toBe("manual");
        return {
          status: 302,
          headers: { location: "https://evil.example/steal" },
          body: "",
          url: req.url,
        };
      },
    });

    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        trustedOrigins: [TEST_WEBSITE_URL],
        oauth: { github: TEST_GITHUB_CREDS, trakt: TEST_TRAKT_CREDS },
      },
    });

    for (const provider of ["github", "trakt"] as const) {
      const initRes = await app.fetch(
        new Request(`${TEST_BASE_URL}/api/auth/sign-in/social`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            provider,
            callbackURL: `${TEST_WEBSITE_URL}/dashboard`,
            errorCallbackURL: `${TEST_WEBSITE_URL}/auth/error`,
          }),
        }),
      );
      const state = new URL(((await initRes.json()) as { url: string }).url).searchParams.get(
        "state",
      )!;
      const stateCookie = extractCookieHeader(initRes);

      const callbackRes = await app.fetch(
        new Request(
          `${TEST_BASE_URL}/api/auth/callback/${provider}?code=redirect-code&state=${encodeURIComponent(state)}`,
          { method: "GET", headers: { cookie: stateCookie } },
        ),
      );
      expect(callbackRes.status).toBe(302);
      expect(callbackRes.headers.get("location")).toBe(
        `${TEST_WEBSITE_URL}/auth/error?error=invalid_code`,
      );
      expect(extractCookieHeader(callbackRes)).not.toContain("session_token=");
    }
  });

  test("default Cloudflare Worker entrypoint wires GITHUB_* and TRAKT_* env vars and skips half-configured providers", async () => {
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

    const hyperdrive = {
      connectionString: testDb.connectionString,
    } as Hyperdrive;

    const fullEnv = {
      HYPERDRIVE_READ: hyperdrive,
      HYPERDRIVE_WRITE: hyperdrive,
      AUTH_SECRET: TEST_AUTH_SECRET,
      API_BASE_URL: TEST_BASE_URL,
      TRUSTED_ORIGINS: TEST_WEBSITE_URL,
      GITHUB_CLIENT_ID: TEST_GITHUB_CREDS.clientId,
      GITHUB_CLIENT_SECRET: TEST_GITHUB_CREDS.clientSecret,
      TRAKT_CLIENT_ID: TEST_TRAKT_CREDS.clientId,
      TRAKT_CLIENT_SECRET: TEST_TRAKT_CREDS.clientSecret,
    };

    const ghInit = await worker.fetch(
      new Request(`${TEST_BASE_URL}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "github",
          callbackURL: `${TEST_WEBSITE_URL}/dashboard`,
        }),
      }),
      fullEnv,
      ctx,
    );
    expect(ghInit.status).toBe(200);
    const ghUrl = new URL(((await ghInit.json()) as { url: string }).url);
    expect(ghUrl.origin).toBe("https://github.com");
    expect(ghUrl.searchParams.get("client_id")).toBe(TEST_GITHUB_CREDS.clientId);

    const traktInit = await worker.fetch(
      new Request(`${TEST_BASE_URL}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "trakt",
          callbackURL: `${TEST_WEBSITE_URL}/dashboard`,
        }),
      }),
      fullEnv,
      ctx,
    );
    expect(traktInit.status).toBe(200);
    const traktUrl = new URL(((await traktInit.json()) as { url: string }).url);
    expect(traktUrl.origin).toBe("https://trakt.tv");
    expect(traktUrl.searchParams.get("client_id")).toBe(TEST_TRAKT_CREDS.clientId);

    // Half-configured provider (missing secret) is not enabled.
    const partialRes = await worker.fetch(
      new Request(`${TEST_BASE_URL}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "github",
          callbackURL: `${TEST_WEBSITE_URL}/dashboard`,
        }),
      }),
      {
        HYPERDRIVE_READ: hyperdrive,
        HYPERDRIVE_WRITE: hyperdrive,
        AUTH_SECRET: TEST_AUTH_SECRET,
        API_BASE_URL: TEST_BASE_URL,
        GITHUB_CLIENT_ID: TEST_GITHUB_CREDS.clientId,
      },
      ctx,
    );
    expect(partialRes.status).toBe(404);

    await Promise.all(pending);
  });
});
