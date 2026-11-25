import type { ExternalHttpResponse, OutboundClient } from "@media-ref/core";
import {
  getOAuth2Tokens,
  type BetterAuthOptions,
  type BetterAuthPlugin,
  type GithubProfile,
  type OAuth2Tokens,
} from "better-auth";
import { genericOAuth, type GenericOAuthUserInfo } from "better-auth/plugins";

export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_USER_URL = "https://api.github.com/user";
export const GITHUB_USER_EMAILS_URL = "https://api.github.com/user/emails";

// Trakt OAuth runs on auth.trakt.tv as an OIDC provider (see its /.well-known/openid-configuration);
// only the `email` scope makes the account email available, via the userinfo endpoint.
export const TRAKT_AUTHORIZATION_URL = "https://auth.trakt.tv/api/auth/oauth2/authorize";
export const TRAKT_TOKEN_URL = "https://auth.trakt.tv/oauth/token";
export const TRAKT_USERINFO_URL = "https://auth.trakt.tv/api/auth/oauth2/userinfo";
export const TRAKT_SCOPES = ["public", "openid", "profile", "email"];

const REDIRECT_STATUSES = new Set([0, 301, 302, 303, 307, 308]);
const OAUTH_USER_AGENT = "media-ref";

export interface OAuthProviderCredentials {
  clientId: string;
  clientSecret: string;
}

export interface OAuthConfig {
  github?: OAuthProviderCredentials;
  trakt?: OAuthProviderCredentials;
}

export interface OAuthEnvVars {
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  TRAKT_CLIENT_ID?: string;
  TRAKT_CLIENT_SECRET?: string;
}

export interface OAuthAuthOptions {
  socialProviders?: BetterAuthOptions["socialProviders"];
  plugins: BetterAuthPlugin[];
  accountLinking: NonNullable<NonNullable<BetterAuthOptions["account"]>["accountLinking"]>;
}

interface RawGithubUser {
  id?: string | number;
  login?: string;
  name?: string | null;
  email?: string | null;
  avatar_url?: string | null;
  [key: string]: unknown;
}

interface RawGithubEmail {
  email?: string;
  primary?: boolean;
  verified?: boolean;
  visibility?: string | null;
}

interface RawTraktUserInfo {
  sub?: string;
  email?: string | null;
  name?: string | null;
}

function normalizeNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function parseCredentials(
  clientId?: string,
  clientSecret?: string,
): OAuthProviderCredentials | undefined {
  const normalizedId = normalizeNonEmpty(clientId);
  const normalizedSecret = normalizeNonEmpty(clientSecret);
  if (!normalizedId || !normalizedSecret) {
    return undefined;
  }
  return {
    clientId: normalizedId,
    clientSecret: normalizedSecret,
  };
}

export function parseOAuthConfigFromEnv(env: OAuthEnvVars): OAuthConfig | undefined {
  const github = parseCredentials(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET);
  const trakt = parseCredentials(env.TRAKT_CLIENT_ID, env.TRAKT_CLIENT_SECRET);

  if (!github && !trakt) {
    return undefined;
  }

  return {
    ...(github ? { github } : {}),
    ...(trakt ? { trakt } : {}),
  };
}

function parseJsonObject(response: ExternalHttpResponse): Record<string, unknown> | null {
  if (!response.body) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(response.body);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseJsonArray<T>(response: ExternalHttpResponse): T[] | null {
  if (!response.body) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(response.body);
    return Array.isArray(parsed) ? (parsed as T[]) : null;
  } catch {
    return null;
  }
}

function assertNotRedirect(endpoint: string, status: number): void {
  if (REDIRECT_STATUSES.has(status)) {
    throw new Error(`OAuth endpoint "${endpoint}" returned a refused redirect (status ${status})`);
  }
}

async function exchangeGithubTokenViaOutbound(
  outbound: OutboundClient,
  credentials: OAuthProviderCredentials,
  params: URLSearchParams,
): Promise<OAuth2Tokens | null> {
  params.set("client_id", credentials.clientId);
  params.set("client_secret", credentials.clientSecret);

  const response = await outbound.fetchExternal({
    kind: "oauth",
    namespace: "github",
    url: GITHUB_TOKEN_URL,
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: params.toString(),
  });

  assertNotRedirect(GITHUB_TOKEN_URL, response.status);
  if (response.status < 200 || response.status >= 300) {
    return null;
  }

  const data = parseJsonObject(response);
  if (!data || "error" in data || typeof data.access_token !== "string" || !data.access_token) {
    return null;
  }

  return getOAuth2Tokens(data);
}

function resolveGithubEmail(
  profileEmail: string | null | undefined,
  emails: RawGithubEmail[] | null,
): { email: string | null; emailVerified: boolean } {
  const validEmails = (emails ?? []).filter(
    (entry): entry is RawGithubEmail & { email: string } =>
      typeof entry.email === "string" && entry.email.trim().length > 0,
  );

  if (validEmails.length > 0) {
    const primary = validEmails.find((entry) => entry.primary === true);
    if (primary) {
      return {
        email: primary.email.trim(),
        emailVerified: primary.verified === true,
      };
    }

    const normalizedProfileEmail = normalizeNonEmpty(profileEmail ?? undefined);
    if (normalizedProfileEmail) {
      const matched = validEmails.find(
        (entry) => entry.email.trim().toLowerCase() === normalizedProfileEmail.toLowerCase(),
      );
      return {
        email: normalizedProfileEmail,
        emailVerified: matched?.verified === true,
      };
    }

    const first = validEmails[0]!;
    return {
      email: first.email.trim(),
      emailVerified: first.verified === true,
    };
  }

  // Never trust profile.email as verified unless /user/emails confirmed verified: true.
  return {
    email: normalizeNonEmpty(profileEmail ?? undefined) ?? null,
    emailVerified: false,
  };
}

async function fetchGithubUserInfoViaOutbound(
  outbound: OutboundClient,
  token: OAuth2Tokens,
): Promise<{
  user: {
    name: string;
    email: string | null;
    image?: string;
    emailVerified: boolean;
  };
  data: GithubProfile;
} | null> {
  if (!token.accessToken) {
    return null;
  }

  const headers = {
    authorization: `Bearer ${token.accessToken}`,
    accept: "application/vnd.github+json",
    "user-agent": OAUTH_USER_AGENT,
  };

  const userRes = await outbound.fetchExternal({
    kind: "oauth",
    namespace: "github",
    url: GITHUB_USER_URL,
    method: "GET",
    headers,
  });

  if (userRes.status < 200 || userRes.status >= 300) {
    return null;
  }

  const rawProfile = parseJsonObject(userRes) as RawGithubUser | null;
  if (!rawProfile || (typeof rawProfile.id !== "string" && typeof rawProfile.id !== "number")) {
    return null;
  }

  const emailsRes = await outbound.fetchExternal({
    kind: "oauth",
    namespace: "github",
    url: GITHUB_USER_EMAILS_URL,
    method: "GET",
    headers,
  });

  const rawEmails =
    emailsRes.status >= 200 && emailsRes.status < 300
      ? parseJsonArray<RawGithubEmail>(emailsRes)
      : null;

  const { email, emailVerified } = resolveGithubEmail(rawProfile.email, rawEmails);
  const name =
    normalizeNonEmpty(rawProfile.name ?? undefined) ?? normalizeNonEmpty(rawProfile.login) ?? "";
  const avatarUrl = normalizeNonEmpty(rawProfile.avatar_url ?? undefined);

  const profileData = {
    ...rawProfile,
    id: String(rawProfile.id),
    login: rawProfile.login ?? "",
    name,
    email,
    avatar_url: avatarUrl ?? "",
  } as unknown as GithubProfile;

  return {
    user: {
      name,
      email,
      image: avatarUrl,
      emailVerified,
    },
    data: profileData,
  };
}

async function exchangeTraktTokenViaOutbound(
  outbound: OutboundClient,
  credentials: OAuthProviderCredentials,
  payload: Record<string, string>,
): Promise<OAuth2Tokens> {
  const response = await outbound.fetchExternal({
    kind: "catalog",
    namespace: "trakt",
    url: TRAKT_TOKEN_URL,
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      // Trakt's edge returns 403 to requests without a User-Agent
      "user-agent": OAUTH_USER_AGENT,
    },
    body: JSON.stringify({
      ...payload,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    }),
  });

  assertNotRedirect(TRAKT_TOKEN_URL, response.status);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Trakt OAuth token exchange failed with status ${response.status}`);
  }

  const data = parseJsonObject(response);
  if (!data || "error" in data || typeof data.access_token !== "string" || !data.access_token) {
    throw new Error("Trakt OAuth token exchange returned an invalid token response");
  }

  return getOAuth2Tokens(data);
}

async function fetchTraktUserInfoViaOutbound(
  outbound: OutboundClient,
  tokens: OAuth2Tokens,
): Promise<GenericOAuthUserInfo | null> {
  if (!tokens.accessToken) {
    return null;
  }

  const response = await outbound.fetchExternal({
    kind: "catalog",
    namespace: "trakt",
    url: TRAKT_USERINFO_URL,
    method: "GET",
    headers: {
      authorization: `Bearer ${tokens.accessToken}`,
      accept: "application/json",
      "user-agent": OAUTH_USER_AGENT,
    },
  });

  if (response.status < 200 || response.status >= 300) {
    return null;
  }

  const data = parseJsonObject(response) as RawTraktUserInfo | null;
  const subject = normalizeNonEmpty(data?.sub);
  if (!data || !subject) {
    return null;
  }

  return {
    id: subject,
    name: normalizeNonEmpty(data.name ?? undefined) ?? subject,
    email: normalizeNonEmpty(data.email ?? undefined),
    // Trakt's email_verified claim is not trusted for account linking; media-ref verifies the email itself.
    emailVerified: false,
  };
}

/**
 * Wraps OAuth provider token exchange/refresh so every outbound OAuth HTTP call
 * routes through `OutboundClient` without global fetch patching.
 */
function createOAuthOutboundTransportPlugin(
  credentials: {
    github?: OAuthProviderCredentials;
    trakt?: OAuthProviderCredentials;
  },
  outbound: OutboundClient,
): BetterAuthPlugin {
  return {
    id: "media-ref-oauth-outbound-transport",
    init(ctx) {
      const updatedProviders = ctx.socialProviders.map((provider) => {
        if (provider.id === "github" && credentials.github) {
          const githubCreds = credentials.github;
          return {
            ...provider,
            async validateAuthorizationCode({
              code,
              codeVerifier,
              redirectURI,
            }: {
              code: string;
              redirectURI: string;
              codeVerifier?: string;
              deviceId?: string;
            }) {
              const params = new URLSearchParams();
              params.set("grant_type", "authorization_code");
              params.set("code", code);
              params.set("redirect_uri", redirectURI);
              if (codeVerifier) {
                params.set("code_verifier", codeVerifier);
              }
              return exchangeGithubTokenViaOutbound(outbound, githubCreds, params);
            },
            async refreshAccessToken(refreshToken: string) {
              const params = new URLSearchParams();
              params.set("grant_type", "refresh_token");
              params.set("refresh_token", refreshToken);
              const tokens = await exchangeGithubTokenViaOutbound(outbound, githubCreds, params);
              if (!tokens) {
                throw new Error("GitHub OAuth token refresh failed");
              }
              return tokens;
            },
          };
        }

        if (provider.id === "trakt" && credentials.trakt) {
          const traktCreds = credentials.trakt;
          return {
            ...provider,
            async refreshAccessToken(refreshToken: string) {
              return exchangeTraktTokenViaOutbound(outbound, traktCreds, {
                grant_type: "refresh_token",
                refresh_token: refreshToken,
              });
            },
          };
        }

        return provider;
      });

      return {
        context: {
          socialProviders: updatedProviders,
        },
      };
    },
  };
}

/**
 * Builds Better Auth OAuth provider, plugin, and account-linking options.
 *
 * Account-linking security policy (verified against Better Auth 1.7.27 `link-account.mjs`):
 * - `enabled: true`, `disableImplicitLinking: false`, `requireLocalEmailVerified: true`
 * - `trustedProviders: []`: Better Auth evaluates `(!isTrustedProvider && !userInfo.emailVerified)`.
 *   Leaving `trustedProviders` empty ensures implicit same-email linking ONLY happens when BOTH
 *   the existing local user has `emailVerified: true` AND the incoming OAuth provider confirms
 *   `emailVerified: true` (e.g. GitHub primary email with `verified: true`). Unverified GitHub
 *   emails (`verified: false`) and Trakt (always `emailVerified: false`) can never hijack an
 *   existing account.
 */
export function buildOAuthAuthOptions(
  oauthConfig: OAuthConfig | undefined,
  outbound: OutboundClient,
): OAuthAuthOptions {
  const github = oauthConfig?.github
    ? parseCredentials(oauthConfig.github.clientId, oauthConfig.github.clientSecret)
    : undefined;
  const trakt = oauthConfig?.trakt
    ? parseCredentials(oauthConfig.trakt.clientId, oauthConfig.trakt.clientSecret)
    : undefined;

  const plugins: BetterAuthPlugin[] = [];
  let socialProviders: BetterAuthOptions["socialProviders"];

  if (github) {
    socialProviders = {
      github: {
        clientId: github.clientId,
        clientSecret: github.clientSecret,
        getUserInfo: (token) => fetchGithubUserInfoViaOutbound(outbound, token),
      },
    };
  }

  if (trakt) {
    plugins.push(
      genericOAuth({
        config: [
          {
            providerId: "trakt",
            name: "Trakt",
            clientId: trakt.clientId,
            clientSecret: trakt.clientSecret,
            authorizationUrl: TRAKT_AUTHORIZATION_URL,
            tokenUrl: TRAKT_TOKEN_URL,
            authentication: "post",
            pkce: true,
            scopes: TRAKT_SCOPES,
            getToken: ({ code, redirectURI, codeVerifier }) =>
              exchangeTraktTokenViaOutbound(outbound, trakt, {
                code,
                redirect_uri: redirectURI,
                grant_type: "authorization_code",
                ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
              }),
            getUserInfo: (tokens) => fetchTraktUserInfoViaOutbound(outbound, tokens),
          },
        ],
      }),
    );
  }

  if (github || trakt) {
    // Must come after `genericOAuth(...)` so both built-in GitHub and generic Trakt providers
    // are present on `ctx.socialProviders` when wrapping transport methods.
    plugins.push(createOAuthOutboundTransportPlugin({ github, trakt }, outbound));
  }

  return {
    ...(socialProviders ? { socialProviders } : {}),
    plugins,
    accountLinking: {
      enabled: true,
      disableImplicitLinking: false,
      requireLocalEmailVerified: true,
      trustedProviders: [],
    },
  };
}
