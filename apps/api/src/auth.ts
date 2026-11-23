import { apiKey } from "@better-auth/api-key";
import type { OutboundClient, TmdbGateway, TmdbGatewayConfig } from "@media-ref/core";
import type { Db } from "@media-ref/db";
import { betterAuth } from "better-auth";
import type { MiddlewareHandler } from "hono";
import type { VerifiedApiKey } from "./api-keys.ts";
import { buildOAuthAuthOptions, type OAuthConfig } from "./oauth.ts";

export const AUTH_BASE_PATH = "/api/auth";
export const DEFAULT_API_BASE_URL = "https://api.mediaref.org";
export const DEFAULT_EMAIL_FROM = "noreply@mediaref.org";

export interface AuthConfig {
  baseUrl?: string;
  authSecret?: string;
  cookieDomain?: string;
  emailFrom?: string;
  trustedOrigins?: string[];
  oauth?: OAuthConfig;
}

export interface AuthDeps {
  dbWrite: Db;
  outbound: OutboundClient;
  config: AuthConfig;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  role: string;
}

export interface AuthenticatedSession {
  session: {
    id: string;
    userId: string;
    token: string;
    expiresAt: Date;
  };
  user: AuthenticatedUser;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeCookieDomain(raw?: string): string | undefined {
  const trimmed = raw?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function stripLeadingDot(domain: string): string {
  return domain.startsWith(".") ? domain.slice(1) : domain;
}

export function resolveTrustedOrigins(config: AuthConfig): string[] {
  const origins = new Set<string>();

  const baseUrl = config.baseUrl ?? DEFAULT_API_BASE_URL;
  try {
    origins.add(new URL(baseUrl).origin);
  } catch {
    // Let Better Auth validate malformed baseURL if provided.
  }

  const cookieDomain = normalizeCookieDomain(config.cookieDomain);
  if (cookieDomain) {
    const rootDomain = stripLeadingDot(cookieDomain);
    origins.add(`https://${rootDomain}`);
    origins.add(`https://*.${rootDomain}`);
  }

  for (const origin of config.trustedOrigins ?? []) {
    const trimmed = origin.trim();
    if (trimmed.length > 0) {
      origins.add(trimmed);
    }
  }

  return [...origins];
}

export function isAllowedCorsOrigin(origin: string, config: AuthConfig): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  for (const trusted of resolveTrustedOrigins(config)) {
    if (trusted === origin) {
      return true;
    }

    const wildcardMatch = trusted.match(/^(https?):\/\/\*\.(.+)$/);
    if (wildcardMatch) {
      const [, scheme, suffix] = wildcardMatch;
      if (parsed.protocol === `${scheme}:` && parsed.host.endsWith(`.${suffix}`)) {
        return true;
      }
    }
  }

  return false;
}

export function createAuth(deps: AuthDeps) {
  const baseURL = deps.config.baseUrl ?? DEFAULT_API_BASE_URL;
  const cookieDomain = normalizeCookieDomain(deps.config.cookieDomain);
  const emailFrom = deps.config.emailFrom ?? DEFAULT_EMAIL_FROM;
  const trustedOrigins = resolveTrustedOrigins(deps.config);
  const oauthOptions = buildOAuthAuthOptions(deps.config.oauth, deps.outbound);

  return betterAuth({
    baseURL,
    basePath: AUTH_BASE_PATH,
    secret: deps.config.authSecret,
    database: {
      db: deps.dbWrite,
      type: "postgres",
    },
    disabledPaths: ["/api-key/create"],
    trustedOrigins,
    socialProviders: oauthOptions.socialProviders,
    account: {
      accountLinking: oauthOptions.accountLinking,
    },
    plugins: [
      apiKey({
        defaultPrefix: "mref_",
        startingCharactersConfig: {
          shouldStore: true,
          charactersLength: 11,
        },
        maximumNameLength: 64,
        rateLimit: {
          enabled: false,
        },
        enableSessionForAPIKeys: false,
        permissions: {
          defaultPermissions: {
            media: ["read", "report"],
          },
        },
        keyExpiration: {
          defaultExpiresIn: null,
          minExpiresIn: 0,
          maxExpiresIn: 365,
        },
      }),
      ...oauthOptions.plugins,
    ],
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      async sendVerificationEmail({ user, url }) {
        await deps.outbound.sendEmail({
          to: user.email,
          from: emailFrom,
          subject: "Verify your media-ref email address",
          text: `Verify your media-ref email address by opening this link:\n\n${url}\n`,
          html: `<p>Verify your media-ref email address by clicking the link below:</p><p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`,
        });
      },
    },
    user: {
      additionalFields: {
        role: {
          type: "string",
          required: false,
          defaultValue: "user",
          input: false,
        },
      },
    },
    advanced: {
      database: {
        validateSchema: false,
      },
      ...(cookieDomain
        ? {
            crossSubDomainCookies: {
              enabled: true,
              domain: cookieDomain,
            },
          }
        : {}),
    },
  });
}

export type AuthInstance = ReturnType<typeof createAuth>;

export interface ApiEnv {
  Variables: {
    auth: AuthInstance;
    dbRead: Db;
    dbWrite: Db;
    outbound: OutboundClient;
    tmdbConfig: TmdbGatewayConfig | undefined;
    tmdbGateway: TmdbGateway | undefined;
    now: () => Date;
    onBackgroundTask: ((promise: Promise<unknown>) => void) | undefined;
    onBackgroundTaskError: ((error: unknown) => void) | undefined;
    session: AuthenticatedSession | null;
    apiKey: VerifiedApiKey | null;
  };
}

export async function getAuthenticatedSession(
  auth: AuthInstance,
  headers: Headers,
): Promise<AuthenticatedSession | null> {
  const result = await auth.api.getSession({ headers });
  if (!result) {
    return null;
  }

  const rawRole = result.user.role;
  const role = typeof rawRole === "string" && rawRole.length > 0 ? rawRole : "user";

  return {
    session: {
      id: result.session.id,
      userId: result.session.userId,
      token: result.session.token,
      expiresAt:
        result.session.expiresAt instanceof Date
          ? result.session.expiresAt
          : new Date(result.session.expiresAt),
    },
    user: {
      id: result.user.id,
      email: result.user.email,
      name: result.user.name,
      emailVerified: Boolean(result.user.emailVerified),
      role,
    },
  };
}

export const requireAuthenticatedSession: MiddlewareHandler<ApiEnv> = async (c, next) => {
  let session = c.get("session");
  if (!session) {
    session = await getAuthenticatedSession(c.get("auth"), c.req.raw.headers);
  }

  if (!session) {
    return c.json(
      {
        error: "UNAUTHORIZED",
        message: "Authentication required",
      },
      401,
    );
  }

  c.set("session", session);
  await next();
};

export const requireVerifiedUser: MiddlewareHandler<ApiEnv> = async (c, next) => {
  let session = c.get("session");
  if (!session) {
    session = await getAuthenticatedSession(c.get("auth"), c.req.raw.headers);
  }

  if (!session) {
    return c.json(
      {
        error: "UNAUTHORIZED",
        message: "Authentication required",
      },
      401,
    );
  }

  c.set("session", session);

  if (!session.user.emailVerified) {
    return c.json(
      {
        error: "EMAIL_NOT_VERIFIED",
        message: "Email verification is required",
      },
      403,
    );
  }

  await next();
};
