import type { OutboundClient } from "@media-ref/core";
import type { Db } from "@media-ref/db";
import {
  buildApiKeyPermissions,
  hashApiKey,
  MAX_API_KEY_NAME_LENGTH,
  verifyApiKey,
  type ApiKeyAction,
} from "./api-keys.ts";
import { getAuthenticatedSession, type AuthInstance } from "./auth.ts";
import { MCP_PATH } from "./mcp.ts";

/**
 * The OAuth authorization server for `/mcp` (docs/adr/0006-mcp-oauth.md). Each approval creates
 * an API key, the grant; access tokens are short-lived signed tokens naming that key, so a
 * token is checked exactly like the key itself.
 */

export const MCP_ACCESS_TOKEN_PREFIX = "mrat_";
export const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
const AUTHORIZATION_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";
const REGISTER_PATH = "/oauth/register";
const AUTHORIZE_PATH = "/oauth/authorize";
const TOKEN_PATH = "/oauth/token";

const REGISTERED_CLIENT_PREFIX = "mrc_";
const ROW_PREFIX = "mcp-oauth:";
const CODE_ROW_PREFIX = `${ROW_PREFIX}code:`;
const REFRESH_ROW_PREFIX = `${ROW_PREFIX}refresh:`;
const USED_REFRESH_ROW_PREFIX = `${ROW_PREFIX}used:`;

const ACCESS_TOKEN_TTL_SECONDS = 3600;
const GRANT_TTL_SECONDS = 90 * 86_400;
const CODE_TTL_SECONDS = 300;
const CONSENT_TTL_SECONDS = 600;

const SCOPES: readonly ApiKeyAction[] = ["read", "report", "submit"];
/** Every API key can read and report; `submit` is the one scope a client asks for. */
const BASE_SCOPES: readonly ApiKeyAction[] = ["read", "report"];

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const UNSAFE_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "blob:", "about:"]);

export interface McpOAuthDeps {
  /** API origin: the issuer, and the base of every endpoint here. */
  issuer: string;
  /** Website origin, whose `/login` signs the user in. */
  websiteUrl: string;
  secret: string;
  dbWrite: Db;
  outbound: OutboundClient;
  getAuth: () => AuthInstance;
  now: () => Date;
}

interface OAuthClient {
  id: string;
  name: string;
  redirectUris: string[];
  /** Host that published the client's metadata document; null for a registered client. */
  host: string | null;
}

/** An approved authorization request, sealed into the consent form and then the code. */
interface Approval {
  c: string;
  n: string;
  u: string;
  cc: string;
  sc: ApiKeyAction[];
  uid: string;
}

/** The error codes the website's consent page knows; it never shows text from the URL. */
type ConsentPageError =
  | "unknown_client"
  | "redirect_mismatch"
  | "invalid_request"
  | "email_not_verified"
  | "expired";

interface Grant {
  k: string;
  c: string;
  sc: ApiKeyAction[];
}

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

const randomToken = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
const nowSeconds = (deps: Pick<McpOAuthDeps, "now">) => Math.floor(deps.now().getTime() / 1000);
const resourceOf = (deps: Pick<McpOAuthDeps, "issuer">) => `${deps.issuer}${MCP_PATH}`;

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** `purpose` keeps a value sealed for one use from being accepted as another. */
async function seal(secret: string, purpose: string, payload: object): Promise<string> {
  const body = base64url(encoder.encode(JSON.stringify(payload)));
  const mac = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    encoder.encode(`${purpose}.${body}`),
  );
  return `${body}.${base64url(new Uint8Array(mac))}`;
}

async function unseal<T>(
  secret: string,
  purpose: string,
  sealed: string,
  now: Date,
): Promise<T | null> {
  const [body, mac, extra] = sealed.split(".");
  if (!body || !mac || extra !== undefined) return null;
  try {
    const decode = (text: string) =>
      Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
    const valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      decode(mac),
      encoder.encode(`${purpose}.${body}`),
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(decode(body))) as T & { exp?: number };
    return payload.exp === undefined || payload.exp * 1000 > now.getTime() ? payload : null;
  } catch {
    return null;
  }
}

/** The grant key an access token names, or null when it is forged, expired or for another resource. */
export async function resolveMcpAccessToken(
  deps: Pick<McpOAuthDeps, "issuer" | "secret" | "now">,
  token: string,
): Promise<string | null> {
  if (!token.startsWith(MCP_ACCESS_TOKEN_PREFIX)) return null;
  const claims = await unseal<{ k: string; aud: string }>(
    deps.secret,
    "access",
    token.slice(MCP_ACCESS_TOKEN_PREFIX.length),
    deps.now(),
  );
  return claims?.aud === resourceOf(deps) ? claims.k : null;
}

function json(status: number, body: unknown): Response {
  return Response.json(body, {
    status,
    headers: { "access-control-allow-origin": "*", "cache-control": "no-store" },
  });
}

const oauthError = (status: number, error: string, description: string) =>
  json(status, { error, error_description: description });

function redirectWith(
  uri: string,
  params: Record<string, string | null>,
  status: 302 | 303,
): Response {
  const url = new URL(uri);
  for (const [name, value] of Object.entries(params)) {
    if (value !== null) url.searchParams.set(name, value);
  }
  return new Response(null, {
    status,
    headers: { location: url.href, "cache-control": "no-store" },
  });
}

/** Consent and errors are shown by the website (`/oauth/consent`), in the site's own UI. */
function toConsentPage(
  deps: McpOAuthDeps,
  params: { consent: string } | { error: ConsentPageError },
  status: 302 | 303 = 302,
): Response {
  return new Response(null, {
    status,
    headers: {
      location: `${deps.websiteUrl}/oauth/consent?${new URLSearchParams(params).toString()}`,
      "cache-control": "no-store",
    },
  });
}

function isLoopback(uri: string): boolean {
  const url = new URL(uri);
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

/** https, http on loopback, or a native app's private-use scheme (RFC 8252 §7.1), e.g. `cursor://`. */
function isAllowedRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048 || value.includes("#")) return false;
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    if (url.protocol === "http:") return LOOPBACK_HOSTS.has(url.hostname);
    return !UNSAFE_SCHEMES.has(url.protocol);
  } catch {
    return false;
  }
}

const isRedirectUriList = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= 10 &&
  value.every(isAllowedRedirectUri);

/** Exact match, except that a loopback redirect may use any port (RFC 8252 §7.3). */
function matchesRedirectUri(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  try {
    const target = new URL(requested);
    if (!isLoopback(requested)) return false;
    target.port = "";
    return registered.some((uri) => {
      if (!isLoopback(uri)) return false;
      const candidate = new URL(uri);
      candidate.port = "";
      return candidate.href === target.href;
    });
  } catch {
    return false;
  }
}

/** A client id is either one `/oauth/register` sealed, or the https URL of a metadata document. */
async function resolveClient(deps: McpOAuthDeps, clientId: string): Promise<OAuthClient | null> {
  if (clientId.startsWith(REGISTERED_CLIENT_PREFIX)) {
    const client = await unseal<{ n: string; r: string[] }>(
      deps.secret,
      "client",
      clientId.slice(REGISTERED_CLIENT_PREFIX.length),
      deps.now(),
    );
    return client && { id: clientId, name: client.n, redirectUris: client.r, host: null };
  }

  // Client ID Metadata Document (draft-ietf-oauth-client-id-metadata-document).
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.pathname === "/" || url.username || url.password) {
    return null;
  }
  let doc: Record<string, unknown>;
  try {
    // shortcut: fetched on every authorization, uncached; add a cache when traffic warrants it.
    const res = await deps.outbound.fetchExternal({
      kind: "oauth",
      namespace: "mcp-client",
      url: clientId,
      headers: { accept: "application/json" },
      // workerd rejects "error"; a 3xx fails the status check below.
      redirect: "manual",
      timeoutMs: 5000,
    });
    if (res.status !== 200 || res.body.length > 5120) return null;
    doc = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (
    doc.client_id !== clientId ||
    !isRedirectUriList(doc.redirect_uris) ||
    (doc.token_endpoint_auth_method !== undefined && doc.token_endpoint_auth_method !== "none")
  ) {
    return null;
  }
  const name = typeof doc.client_name === "string" ? doc.client_name.trim().slice(0, 100) : "";
  return { id: clientId, name: name || url.host, redirectUris: doc.redirect_uris, host: url.host };
}

/** Unknown scopes are ignored; read and report always come with the grant, like any API key. */
const grantedScopes = (raw: string | null): ApiKeyAction[] =>
  SCOPES.filter((scope) => BASE_SCOPES.includes(scope) || (raw ?? "").split(" ").includes(scope));

/** RFC 8707: the MCP endpoint, or the API origin that serves it. Clients before 2025-06-18 send none. */
function acceptsResource(deps: McpOAuthDeps, resource: string | null): boolean {
  if (resource === null) return true;
  const trimmed = resource.replace(/\/$/, "");
  return trimmed === resourceOf(deps) || trimmed === deps.issuer;
}

function protectedResourceMetadata(deps: McpOAuthDeps) {
  return {
    resource: resourceOf(deps),
    authorization_servers: [deps.issuer],
    scopes_supported: BASE_SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "MediaRef",
    resource_documentation: `${deps.websiteUrl}/docs/mcp`,
  };
}

function authorizationServerMetadata(deps: McpOAuthDeps) {
  return {
    issuer: deps.issuer,
    authorization_endpoint: `${deps.issuer}${AUTHORIZE_PATH}`,
    token_endpoint: `${deps.issuer}${TOKEN_PATH}`,
    registration_endpoint: `${deps.issuer}${REGISTER_PATH}`,
    scopes_supported: SCOPES,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${deps.websiteUrl}/docs/mcp`,
  };
}

/** RFC 7591, for clients that predate metadata documents. Stateless: the client id seals its metadata. */
async function register(request: Request, deps: McpOAuthDeps): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return oauthError(400, "invalid_client_metadata", "Body must be a JSON object");
  }
  if (!isRedirectUriList(body?.redirect_uris)) {
    return oauthError(
      400,
      "invalid_redirect_uri",
      "redirect_uris must list 1-10 https, loopback http or private-use scheme URIs",
    );
  }
  const name =
    typeof body.client_name === "string" && body.client_name.trim()
      ? body.client_name.trim().slice(0, 100)
      : "MCP client";
  const clientId =
    REGISTERED_CLIENT_PREFIX +
    (await seal(deps.secret, "client", { n: name, r: body.redirect_uris }));
  return json(201, {
    client_id: clientId,
    client_id_issued_at: nowSeconds(deps),
    client_name: name,
    redirect_uris: body.redirect_uris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
}

async function authorize(request: Request, deps: McpOAuthDeps): Promise<Response> {
  const url = new URL(request.url);
  const params = url.searchParams;
  const session = await getAuthenticatedSession(deps.getAuth(), request.headers);
  if (!session) {
    const back = `${deps.issuer}${AUTHORIZE_PATH}${url.search}`;
    return new Response(null, {
      status: 302,
      headers: { location: `${deps.websiteUrl}/login?redirect=${encodeURIComponent(back)}` },
    });
  }

  // Until the client and redirect URI check out, errors stay on this page (no open redirect).
  const client = await resolveClient(deps, params.get("client_id") ?? "");
  if (!client) {
    return toConsentPage(deps, { error: "unknown_client" });
  }
  const redirectUri =
    params.get("redirect_uri") ?? (client.redirectUris.length === 1 ? client.redirectUris[0]! : "");
  if (!matchesRedirectUri(client.redirectUris, redirectUri)) {
    return toConsentPage(deps, { error: "redirect_mismatch" });
  }

  // Anyone can register any https redirect URI, so nothing redirects to it before the user
  // clicks: a bad response_type, missing PKCE S256 or a foreign resource stays on our page.
  const challenge = params.get("code_challenge") ?? "";
  if (
    params.get("response_type") !== "code" ||
    params.get("code_challenge_method") !== "S256" ||
    !/^[\w-]{43}$/.test(challenge) ||
    !acceptsResource(deps, params.get("resource"))
  ) {
    return toConsentPage(deps, { error: "invalid_request" });
  }
  if (!session.user.emailVerified) {
    return toConsentPage(deps, { error: "email_not_verified" });
  }

  const scopes = grantedScopes(params.get("scope"));
  const approval: Approval = {
    c: client.id,
    n: client.name,
    u: redirectUri,
    cc: challenge,
    sc: scopes,
    uid: session.user.id,
  };
  // The website's consent page reads `n`, `u`, `sc` and `h` from this payload to display them.
  const consent = await seal(deps.secret, "consent", {
    ...approval,
    s: params.get("state"),
    h: client.host,
    exp: nowSeconds(deps) + CONSENT_TTL_SECONDS,
  });
  return toConsentPage(deps, { consent });
}

async function decide(request: Request, deps: McpOAuthDeps): Promise<Response> {
  const form = new URLSearchParams(await request.text());
  const consent = await unseal<Approval & { s: string | null }>(
    deps.secret,
    "consent",
    form.get("consent") ?? "",
    deps.now(),
  );
  const session = await getAuthenticatedSession(deps.getAuth(), request.headers);
  if (!consent || session?.user.id !== consent.uid) {
    return toConsentPage(deps, { error: "expired" }, 303);
  }
  if (form.get("decision") !== "approve") {
    return redirectWith(
      consent.u,
      { error: "access_denied", state: consent.s, iss: deps.issuer },
      303,
    );
  }

  const code = randomToken();
  const { s: state, ...approval } = consent;
  await putRow(
    deps,
    CODE_ROW_PREFIX + (await hashApiKey(code)),
    JSON.stringify(approval satisfies Approval),
    CODE_TTL_SECONDS,
  );
  return redirectWith(consent.u, { code, state, iss: deps.issuer }, 303);
}

async function putRow(deps: McpOAuthDeps, identifier: string, value: string, ttlSeconds: number) {
  await deps.dbWrite
    .insertInto("verification")
    .values({
      id: crypto.randomUUID(),
      identifier,
      value,
      expiresAt: new Date(deps.now().getTime() + ttlSeconds * 1000),
    })
    .execute();
}

/** Codes and refresh tokens are single-use: the row is deleted as it is read. */
async function takeOnce<T>(deps: McpOAuthDeps, prefix: string, secret: string | null) {
  if (!secret) return null;
  const row = await deps.dbWrite
    .deleteFrom("verification")
    .where("identifier", "=", prefix + (await hashApiKey(secret)))
    .returning(["value", "expiresAt"])
    .executeTakeFirst();
  if (!row || new Date(row.expiresAt).getTime() <= deps.now().getTime()) return null;
  return JSON.parse(row.value) as T;
}

async function issueTokens(deps: McpOAuthDeps, grant: Grant): Promise<Response> {
  const now = deps.now();
  const accessToken =
    MCP_ACCESS_TOKEN_PREFIX +
    (await seal(deps.secret, "access", {
      k: grant.k,
      aud: resourceOf(deps),
      exp: nowSeconds(deps) + ACCESS_TOKEN_TTL_SECONDS,
    }));
  const refreshToken = randomToken();
  await putRow(
    deps,
    REFRESH_ROW_PREFIX + (await hashApiKey(refreshToken)),
    JSON.stringify(grant),
    GRANT_TTL_SECONDS,
  );
  // Housekeeping only: a failed sweep must not fail the grant.
  await deps.dbWrite
    .deleteFrom("verification")
    .where("identifier", "like", `${ROW_PREFIX}%`)
    .where("expiresAt", "<=", now)
    .execute()
    .catch(() => undefined);
  return json(200, {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope: grant.sc.join(" "),
  });
}

async function token(request: Request, deps: McpOAuthDeps): Promise<Response> {
  const form = new URLSearchParams(await request.text());
  const clientId = form.get("client_id");
  if (!clientId) return oauthError(401, "invalid_client", "client_id is required");
  if (!acceptsResource(deps, form.get("resource"))) {
    return oauthError(400, "invalid_target", `resource must be ${resourceOf(deps)}`);
  }

  switch (form.get("grant_type")) {
    case "authorization_code": {
      const approval = await takeOnce<Approval>(deps, CODE_ROW_PREFIX, form.get("code"));
      const redirectUri = form.get("redirect_uri");
      const verifier = form.get("code_verifier") ?? "";
      if (
        !approval ||
        approval.c !== clientId ||
        (redirectUri !== null && redirectUri !== approval.u) ||
        !/^[\w.~-]{43,128}$/.test(verifier) ||
        // PKCE S256 is base64url(SHA-256(verifier)), the same encoding as hashApiKey.
        (await hashApiKey(verifier)) !== approval.cc
      ) {
        return oauthError(400, "invalid_grant", "The authorization code is invalid or expired");
      }
      // Server-side call WITHOUT `headers` so Better Auth permits server-only `permissions`.
      const created = await deps.getAuth().api.createApiKey({
        body: {
          userId: approval.uid,
          name: `MCP: ${approval.n}`.slice(0, MAX_API_KEY_NAME_LENGTH),
          permissions: buildApiKeyPermissions(approval.sc.includes("submit")),
          expiresIn: GRANT_TTL_SECONDS,
        },
      });
      try {
        return await issueTokens(deps, { k: created.id, c: clientId, sc: approval.sc });
      } catch (error) {
        // No token names the key and the code is spent: don't leave it in the user's list.
        await deps.dbWrite
          .deleteFrom("apikey")
          .where("id", "=", created.id)
          .execute()
          .catch(() => undefined);
        throw error;
      }
    }
    case "refresh_token": {
      const refreshToken = form.get("refresh_token");
      const grant = await takeOnce<Grant>(deps, REFRESH_ROW_PREFIX, refreshToken);
      if (refreshToken) {
        const usedId = USED_REFRESH_ROW_PREFIX + (await hashApiKey(refreshToken));
        if (grant) {
          // Remember the spent token: if it comes back, a copy of it is out there.
          await putRow(deps, usedId, grant.k, GRANT_TTL_SECONDS);
        } else {
          // Reuse of a rotated token ends the whole grant (RFC 9700 §4.14.2).
          const used = await deps.dbWrite
            .selectFrom("verification")
            .select("value")
            .where("identifier", "=", usedId)
            .executeTakeFirst();
          if (used) await deps.dbWrite.deleteFrom("apikey").where("id", "=", used.value).execute();
        }
      }
      // A deleted, disabled or expired grant key ends the grant.
      const key =
        grant && (await verifyApiKey({ db: deps.dbWrite, keyId: grant.k, now: deps.now() }));
      if (!grant || grant.c !== clientId || !key?.ok) {
        return oauthError(400, "invalid_grant", "The refresh token is invalid, used or revoked");
      }
      return issueTokens(deps, grant);
    }
    default:
      return oauthError(400, "unsupported_grant_type", "Use authorization_code or refresh_token");
  }
}

/** Serves discovery and the OAuth endpoints; null for any other path. */
export async function handleMcpOAuthRequest(
  request: Request,
  deps: McpOAuthDeps,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const { method } = request;
  const isPublicEndpoint =
    pathname === PROTECTED_RESOURCE_METADATA_PATH ||
    pathname === `${PROTECTED_RESOURCE_METADATA_PATH}${MCP_PATH}` ||
    pathname === AUTHORIZATION_SERVER_METADATA_PATH ||
    pathname === REGISTER_PATH ||
    pathname === TOKEN_PATH;

  // Browser-based MCP clients read metadata, register and redeem codes cross-origin, without cookies.
  if (method === "OPTIONS" && isPublicEndpoint) {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST",
        "access-control-allow-headers": "content-type, mcp-protocol-version",
      },
    });
  }
  if (
    method === "GET" &&
    pathname.startsWith(PROTECTED_RESOURCE_METADATA_PATH) &&
    isPublicEndpoint
  ) {
    return json(200, protectedResourceMetadata(deps));
  }
  if (method === "GET" && pathname === AUTHORIZATION_SERVER_METADATA_PATH) {
    return json(200, authorizationServerMetadata(deps));
  }
  if (method === "POST" && pathname === REGISTER_PATH) return register(request, deps);
  if (method === "GET" && pathname === AUTHORIZE_PATH) return authorize(request, deps);
  if (method === "POST" && pathname === AUTHORIZE_PATH) return decide(request, deps);
  if (method === "POST" && pathname === TOKEN_PATH) return token(request, deps);
  return null;
}
