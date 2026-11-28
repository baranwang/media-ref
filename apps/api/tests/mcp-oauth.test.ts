import {
  createAdapterRegistry,
  createFakeOutboundClient,
  type ExternalHttpRequest,
} from "@media-ref/core";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { hashApiKey } from "../src/api-keys.ts";
import { createApiApp, createInMemoryRateLimiter } from "../src/lib.ts";
import { createRpcClients, signUpUser, TEST_BASE_URL } from "./rpc-helpers.ts";

const TEST_AUTH_SECRET = "test-secret-for-media-ref-mcp-oauth-tests-0123456789abcdef";
const REDIRECT_URI = "http://127.0.0.1:33418/callback";
const RESOURCE = `${TEST_BASE_URL}/mcp`;
const CIMD_URL = "https://client.example/mcp/client.json";
const IP = { "cf-connecting-ip": "203.0.113.9" };

type App = ReturnType<typeof createApiApp>;

let nextId = 1;

async function mcp(
  app: App,
  token: string | null,
  method: string,
  params: unknown = {},
  ip = IP["cf-connecting-ip"],
) {
  const res = await app.fetch(
    new Request(RESOURCE, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        "cf-connecting-ip": ip,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    }),
  );
  const text = await res.text();
  const body = text.startsWith("{") ? text : text.match(/^data: (.+)$/m)?.[1];
  return {
    status: res.status,
    challenge: res.headers.get("www-authenticate"),
    body: body ? JSON.parse(body) : null,
  };
}

async function callTool(app: App, token: string, name: string, args: object = {}, ip?: string) {
  const { status, body } = await mcp(app, token, "tools/call", { name, arguments: args }, ip);
  expect(status).toBe(200);
  const result = body.result as { isError?: boolean; content: { text: string }[] };
  return { isError: result.isError === true, data: JSON.parse(result.content[0]!.text) };
}

async function tokenRequest(app: App, params: Record<string, string>) {
  const res = await app.fetch(
    new Request(`${TEST_BASE_URL}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...IP },
      body: new URLSearchParams(params),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function register(app: App, redirectUris = [REDIRECT_URI]): Promise<string> {
  const res = await app.fetch(
    new Request(`${TEST_BASE_URL}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json", ...IP },
      body: JSON.stringify({ client_name: "Test Client", redirect_uris: redirectUris }),
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

function authorizeUrl(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st-1",
    scope: "read report",
    resource: RESOURCE,
    ...extra,
  });
  return `${TEST_BASE_URL}/oauth/authorize?${query}`;
}

async function pkce() {
  const verifier = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return { verifier, challenge: await hashApiKey(verifier) };
}

/** Where /oauth/authorize sent the browser: the website's consent page, with its query. */
function consentPage(res: Response): URLSearchParams {
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location")!);
  expect(`${location.origin}${location.pathname}`).toBe("https://mediaref.org/oauth/consent");
  return location.searchParams;
}

/** What the consent page displays: the signed payload's body. */
function consentPayload(consent: string): Record<string, unknown> {
  const body = consent.split(".")[0]!.replaceAll("-", "+").replaceAll("_", "/");
  return JSON.parse(Buffer.from(body, "base64").toString("utf8")) as Record<string, unknown>;
}

/** Consent page → approve → code, as the signed-in user. */
async function approve(app: App, cookie: string, clientId: string, extra = {}) {
  const { verifier, challenge } = await pkce();
  const page = await app.fetch(
    new Request(authorizeUrl(clientId, challenge, extra), { headers: { cookie } }),
  );
  const consent = consentPage(page).get("consent")!;

  const decided = await app.fetch(
    new Request(`${TEST_BASE_URL}/oauth/authorize`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded", ...IP },
      body: new URLSearchParams({ consent, decision: "approve" }),
    }),
  );
  expect(decided.status).toBe(303);
  const location = new URL(decided.headers.get("location")!);
  expect(`${location.origin}${location.pathname}`).toBe(REDIRECT_URI);
  expect(location.searchParams.get("state")).toBe("st-1");
  expect(location.searchParams.get("iss")).toBe(TEST_BASE_URL);
  return { shown: consentPayload(consent), code: location.searchParams.get("code")!, verifier };
}

async function signIn(app: App, clientId: string, cookie: string, extra = {}) {
  const { code, verifier } = await approve(app, cookie, clientId, extra);
  const res = await tokenRequest(app, {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    resource: RESOURCE,
  });
  expect(res.status).toBe(200);
  return res.body as { access_token: string; refresh_token: string; scope: string };
}

describe("MCP OAuth", () => {
  const handles: TestDbHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) await handles.pop()?.cleanup();
  });

  async function setup(
    options: { readKeyLimit?: number; readIpLimit?: number; cimd?: object; verify?: boolean } = {},
  ) {
    const testDb = await createTestDb();
    handles.push(testDb);
    const clock = { now: new Date() };
    const outbound = createFakeOutboundClient({
      fetchExternal: (request: ExternalHttpRequest) => {
        // As workerd's fetch does.
        if (request.redirect === "error") throw new TypeError("Invalid redirect value: error");
        return {
          status: request.url === CIMD_URL && options.cimd ? 200 : 404,
          headers: { "content-type": "application/json" },
          url: request.url,
          body: JSON.stringify(options.cimd ?? {}),
        };
      },
    });
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      adapterRegistry: createAdapterRegistry(),
      readKeyLimiter: createInMemoryRateLimiter({
        limit: options.readKeyLimit ?? 100,
        periodSeconds: 60,
      }),
      readIpLimiter: createInMemoryRateLimiter({
        limit: options.readIpLimit ?? 100,
        periodSeconds: 60,
      }),
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        websiteUrl: "https://mediaref.org",
        now: () => clock.now,
        readRetryAfterSeconds: 60,
      },
    });
    const user = await signUpUser(app, outbound, {
      email: "oauth@example.com",
      password: "StrongPassword123!",
      name: "OAuth User",
      verify: options.verify,
    });
    return { app, clock, cookie: user.cookie, userId: user.userId };
  }

  test("serves discovery metadata and challenges calls without a token", async () => {
    const { app } = await setup();

    const missing = await mcp(app, null, "tools/list");
    expect(missing.status).toBe(401);
    expect(missing.challenge).toBe(
      `Bearer resource_metadata="${TEST_BASE_URL}/.well-known/oauth-protected-resource/mcp", scope="read report"`,
    );

    for (const path of [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource",
    ]) {
      const res = await app.fetch(new Request(`${TEST_BASE_URL}${path}`));
      expect(await res.json()).toMatchObject({
        resource: RESOURCE,
        authorization_servers: [TEST_BASE_URL],
        scopes_supported: ["read", "report"],
      });
    }

    const as = await app.fetch(
      new Request(`${TEST_BASE_URL}/.well-known/oauth-authorization-server`),
    );
    expect(await as.json()).toMatchObject({
      issuer: TEST_BASE_URL,
      authorization_endpoint: `${TEST_BASE_URL}/oauth/authorize`,
      token_endpoint: `${TEST_BASE_URL}/oauth/token`,
      registration_endpoint: `${TEST_BASE_URL}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  });

  test("an access token is its grant key: same principal, permissions and audience", async () => {
    const { app, cookie, userId } = await setup();
    const clientId = await register(app);

    // Signed out: off to the website's login, which comes back here.
    const { challenge } = await pkce();
    const signedOut = await app.fetch(new Request(authorizeUrl(clientId, challenge)));
    expect(signedOut.status).toBe(302);
    const login = new URL(signedOut.headers.get("location")!);
    expect(`${login.origin}${login.pathname}`).toBe("https://mediaref.org/login");
    expect(login.searchParams.get("redirect")).toBe(authorizeUrl(clientId, challenge));

    const { shown, code, verifier } = await approve(app, cookie, clientId);
    // A registered client has no publisher host, so the page marks its name unverified.
    expect(shown).toMatchObject({
      n: "Test Client",
      u: REDIRECT_URI,
      sc: ["read", "report"],
      h: null,
    });

    const exchange = {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
    };
    const issued = await tokenRequest(app, exchange);
    expect(issued.status).toBe(200);
    expect(issued.body).toMatchObject({
      token_type: "Bearer",
      expires_in: 3600,
      scope: "read report",
    });
    expect(issued.body.access_token).toMatch(/^mrat_/);
    // Codes are single-use.
    expect(await tokenRequest(app, exchange)).toMatchObject({
      status: 400,
      body: { error: "invalid_grant" },
    });

    const token = issued.body.access_token as string;
    const current = await callTool(app, token, "get_current_api_key");
    expect(current.data).toMatchObject({ userId, name: "MCP: Test Client" });
    expect(current.data.canSubmit).toBeUndefined(); // protobuf JSON omits false
    const { apiKeys } = await createRpcClients(app, { cookie }).account.listApiKeys({});
    expect(apiKeys.map((key) => key.id)).toEqual([current.data.keyId]);

    const denied = await callTool(app, token, "create_change_request", {
      target: { tmdb: { type: "MEDIA_TYPE_TV", id: 95479 } },
      namespace: "bilibili",
      nativeId: "ss34430",
    });
    expect(denied).toMatchObject({
      isError: true,
      data: { error: "INSUFFICIENT_PERMISSIONS", status: 403 },
    });

    // The token's audience is /mcp; the RPC endpoints refuse it.
    const direct = createRpcClients(app, { bearerToken: token, headers: IP });
    await expect(direct.apiKey.getCurrentApiKey({})).rejects.toMatchObject({ code: 16 });
  });

  test("submit scope grants a submit key", async () => {
    const { app, cookie } = await setup();
    const tokens = await signIn(app, await register(app), cookie, { scope: "read submit openid" });
    expect(tokens.scope).toBe("read report submit");
    const current = await callTool(app, tokens.access_token, "get_current_api_key");
    expect(current.data.canSubmit).toBe(true);
  });

  test("rejects a wrong verifier, an unregistered redirect URI and a forged client", async () => {
    const { app, cookie } = await setup();
    const clientId = await register(app);

    const { code } = await approve(app, cookie, clientId);
    expect(
      await tokenRequest(app, {
        grant_type: "authorization_code",
        code,
        code_verifier: (await pkce()).verifier,
        client_id: clientId,
      }),
    ).toMatchObject({ status: 400, body: { error: "invalid_grant" } });

    const { challenge } = await pkce();
    const elsewhere = await app.fetch(
      new Request(authorizeUrl(clientId, challenge, { redirect_uri: "https://evil.example/cb" }), {
        headers: { cookie },
      }),
    );
    expect(consentPage(elsewhere).get("error")).toBe("redirect_mismatch");

    // Loopback redirects may use any port (RFC 8252 §7.3).
    const otherPort = await app.fetch(
      new Request(
        authorizeUrl(clientId, challenge, { redirect_uri: "http://127.0.0.1:50001/callback" }),
        { headers: { cookie } },
      ),
    );
    expect(consentPage(otherPort).get("consent")).toBeTruthy();

    const forged = await app.fetch(
      new Request(authorizeUrl(`${clientId.slice(0, -2)}xx`, challenge), { headers: { cookie } }),
    );
    expect(consentPage(forged).get("error")).toBe("unknown_client");

    const noPkce = await app.fetch(
      new Request(authorizeUrl(clientId, challenge, { code_challenge_method: "plain" }), {
        headers: { cookie },
      }),
    );
    // Before the user has clicked anything, errors stay on our site: no open redirect.
    expect(consentPage(noPkce).get("error")).toBe("invalid_request");

    const tampered = await app.fetch(
      new Request(`${TEST_BASE_URL}/oauth/authorize`, {
        method: "POST",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded", ...IP },
        body: new URLSearchParams({ consent: "e30.forged", decision: "approve" }),
      }),
    );
    expect(tampered.status).toBe(303);
    expect(tampered.headers.get("location")).toBe(
      "https://mediaref.org/oauth/consent?error=expired",
    );
  });

  test("reusing a rotated refresh token revokes the whole grant", async () => {
    const { app, cookie } = await setup();
    const clientId = await register(app);
    const first = await signIn(app, clientId, cookie);
    const refresh = { grant_type: "refresh_token", client_id: clientId };

    const second = await tokenRequest(app, { ...refresh, refresh_token: first.refresh_token });
    expect(second.status).toBe(200);
    // R1 again: someone else holds a copy, so R2 and every access token die with the grant key.
    expect(
      await tokenRequest(app, { ...refresh, refresh_token: first.refresh_token }),
    ).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    expect(
      await tokenRequest(app, { ...refresh, refresh_token: second.body.refresh_token }),
    ).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    const revoked = await mcp(app, second.body.access_token, "tools/list");
    expect(revoked.status).toBe(401);
    expect(revoked.challenge).toContain('error="invalid_token"');
    expect((await createRpcClients(app, { cookie }).account.listApiKeys({})).apiKeys).toEqual([]);
  });

  test("each tool call takes one unit of the IP read limit", async () => {
    const { app, cookie } = await setup({ readIpLimit: 3 });
    const { access_token: token } = await signIn(app, await register(app), cookie);

    // A fresh IP: the sign-in POSTs above count against the same limiter.
    for (let i = 0; i < 3; i++) {
      const call = await callTool(app, token, "get_current_api_key", {}, "198.51.100.4");
      expect(call.isError).toBe(false);
    }
    const fourth = await callTool(app, token, "get_current_api_key", {}, "198.51.100.4");
    expect(fourth.data).toMatchObject({ error: "RATE_LIMITED" });
  });

  test("refresh renews an expired token; deleting the grant key revokes it", async () => {
    const { app, clock, cookie } = await setup();
    const clientId = await register(app);
    const first = await signIn(app, clientId, cookie);

    clock.now = new Date(clock.now.getTime() + 2 * 3600_000);
    const expired = await mcp(app, first.access_token, "tools/list");
    expect(expired.status).toBe(401);
    expect(expired.challenge).toContain('error="invalid_token"');

    const refresh = { grant_type: "refresh_token", client_id: clientId };
    const second = await tokenRequest(app, { ...refresh, refresh_token: first.refresh_token });
    expect(second.status).toBe(200);
    expect((await mcp(app, second.body.access_token, "tools/list")).status).toBe(200);

    const account = createRpcClients(app, { cookie }).account;
    const [grantKey] = (await account.listApiKeys({})).apiKeys;
    await account.deleteApiKey({ id: grantKey!.id });
    expect((await mcp(app, second.body.access_token, "tools/list")).status).toBe(401);
    expect(
      await tokenRequest(app, { ...refresh, refresh_token: second.body.refresh_token }),
    ).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
  });

  test("tool calls count against the grant key's read limit", async () => {
    const { app, cookie } = await setup({ readKeyLimit: 2 });
    const { access_token: token } = await signIn(app, await register(app), cookie);
    const ref = { mediaId: "00000000-0000-4000-8000-000000000000" };

    for (let i = 0; i < 2; i++) {
      expect((await callTool(app, token, "get_media", { ref })).data.error).not.toBe(
        "RATE_LIMITED",
      );
    }
    expect(await callTool(app, token, "get_media", { ref })).toMatchObject({
      isError: true,
      data: { error: "RATE_LIMITED", status: 429 },
    });
  });

  test("accepts a client ID metadata document and checks it", async () => {
    const cimd = {
      client_id: CIMD_URL,
      client_name: "Doc Client",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
    };
    const { app, cookie } = await setup({ cimd });
    const { shown } = await approve(app, cookie, CIMD_URL);
    expect(shown).toMatchObject({ n: "Doc Client", h: "client.example" });

    const tokens = await signIn(app, CIMD_URL, cookie);
    const current = await callTool(app, tokens.access_token, "get_current_api_key");
    expect(current.data.name).toBe("MCP: Doc Client");

    const mismatched = await setup({
      cimd: { ...cimd, client_id: "https://other.example/c.json" },
    });
    const { challenge } = await pkce();
    const res = await mismatched.app.fetch(
      new Request(authorizeUrl(CIMD_URL, challenge), { headers: { cookie: mismatched.cookie } }),
    );
    expect(consentPage(res).get("error")).toBe("unknown_client");
  });

  test("an unverified account cannot authorize, as it cannot create API keys", async () => {
    const { app, cookie } = await setup({ verify: false });
    const { challenge } = await pkce();
    const res = await app.fetch(
      new Request(authorizeUrl(await register(app), challenge), { headers: { cookie } }),
    );
    expect(Object.fromEntries(consentPage(res))).toEqual({ error: "email_not_verified" });
  });
});
