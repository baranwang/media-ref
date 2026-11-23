import type { ExecutionContext, Hyperdrive, SendEmail } from "@cloudflare/workers-types";
import { createLiveOutboundClient, parseOutboundProxyConfig } from "@media-ref/core";
import { createDb } from "@media-ref/db";
import { createApiApp } from "./app.ts";
import { DEFAULT_EMAIL_FROM } from "./auth.ts";
import type { InternalMediaWorkerEnv } from "./internal.ts";
import { parseAnonymousInvalidationThresholdFromEnv } from "./invalidation.ts";
import { parseOAuthConfigFromEnv } from "./oauth.ts";
import { parseRateLimitConfigFromEnv, type RateLimitBinding } from "./rate-limit.ts";

export {
  API_KEY_START_LENGTH,
  buildApiKeyPermissions,
  DEFAULT_API_KEY_CONFIG_ID,
  DEFAULT_API_KEY_PREFIX,
  extractApiKeyFromHeaders,
  hashApiKey,
  MAX_API_KEY_EXPIRES_IN_SECONDS,
  MAX_API_KEY_NAME_LENGTH,
  parseApiKeyPermissions,
  registerApiKeyRoutes,
  requireApiKey,
  verifyApiKey,
  type ApiKeyAction,
  type ApiKeyPermissions,
  type ApiKeyScope,
  type ApiKeySummary,
  type CreatedApiKeyResponse,
  type RequireApiKeyOptions,
  type VerifiedApiKey,
  type VerifyApiKeyFailureCode,
  type VerifyApiKeyInput,
  type VerifyApiKeyResult,
} from "./api-keys.ts";
export { createApiApp, type ApiConfig, type ApiDeps } from "./app.ts";
export { registerChangeRequestRoutes } from "./change-requests.ts";
export {
  parseAnonymousInvalidationThresholdFromEnv,
  registerInvalidationRoutes,
  type ReportInvalidationResponse,
} from "./invalidation.ts";
export { registerMediaAdminRoutes } from "./media-admin.ts";
export {
  registerMediaRoutes,
  type BatchMediaReadResponse,
  type MediaReadResponse,
} from "./media.ts";
export { registerReviewerRoutes, requireOwner, requireReviewer } from "./reviewer.ts";
export {
  buildOAuthAuthOptions,
  parseOAuthConfigFromEnv,
  type OAuthAuthOptions,
  type OAuthConfig,
  type OAuthEnvVars,
  type OAuthProviderCredentials,
} from "./oauth.ts";
export {
  AUTH_BASE_PATH,
  createAuth,
  DEFAULT_API_BASE_URL,
  DEFAULT_EMAIL_FROM,
  getAuthenticatedSession,
  isAllowedCorsOrigin,
  requireAuthenticatedSession,
  requireVerifiedUser,
  resolveTrustedOrigins,
  type ApiEnv,
  type AuthConfig,
  type AuthDeps,
  type AuthenticatedSession,
  type AuthenticatedUser,
  type AuthInstance,
} from "./auth.ts";
export { registerLeadRoutes, type CreateLeadResponse, type LeadResponse } from "./leads.ts";
export {
  CLIENT_IP_HEADER,
  createCloudflareRateLimiterAdapter,
  createInMemoryIpRateLimiter,
  createInternalMediaApp,
  DEFAULT_ANONYMOUS_IP_RATE_LIMIT,
  DEFAULT_ANONYMOUS_IP_RATE_WINDOW_SECONDS,
  extractClientIp,
  INTERNAL_MEDIA_PATH_PREFIX,
  InternalMediaEntrypoint,
  type AnonymousIpRateLimitDecision,
  type AnonymousIpRateLimiter,
  type InMemoryIpRateLimiterOptions,
  type InternalMediaDeps,
  type InternalMediaRpcResult,
  type InternalMediaWorkerEnv,
} from "./internal.ts";
export {
  createInMemoryRateLimiter,
  createReadRateLimitRuntime,
  DEFAULT_READ_IP_LIMIT,
  DEFAULT_READ_KEY_LIMIT,
  DEFAULT_READ_PERIOD_SECONDS,
  DEFAULT_READ_RETRY_AFTER_SECONDS,
  extractRequestClientIp,
  parseRateLimitConfigFromEnv,
  parseReadRateLimitConfigFromEnv,
  requireReadRateLimit,
  resolveSubmissionQuotaConfig,
  type InMemoryRateLimiterOptions,
  type RateLimitBinding,
  type RateLimitConfig,
  type RateLimitEnvVars,
  type ReadRateLimitConfig,
  type ReadRateLimitEnvVars,
  type ReadRateLimitRuntime,
  type ReadRateLimitScope,
} from "./rate-limit.ts";

export interface ApiWorkerEnv extends InternalMediaWorkerEnv {
  HYPERDRIVE_WRITE: Hyperdrive;
  EMAIL?: SendEmail;
  EMAIL_FROM?: string;
  AUTH_SECRET?: string;
  API_BASE_URL?: string;
  COOKIE_DOMAIN?: string;
  TRUSTED_ORIGINS?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  TRAKT_CLIENT_ID?: string;
  TRAKT_CLIENT_SECRET?: string;
  OUTBOUND_PROXY_CONFIG?: string;
  ENABLE_HEALTH_OUTBOUND_PROBE?: string;
  TMDB_ACCESS_TOKEN?: string;
  TMDB_API_KEY?: string;
  TMDB_API_BASE_URL?: string;
  TRAKT_API_BASE_URL?: string;
  RATE_LIMITER_READ_KEY?: RateLimitBinding;
  RATE_LIMITER_READ_IP?: RateLimitBinding;
  RATE_LIMIT_READ_KEY_LIMIT?: string;
  RATE_LIMIT_READ_IP_LIMIT?: string;
  RATE_LIMIT_READ_PERIOD_SECONDS?: string;
  RATE_LIMIT_READ_RETRY_AFTER_SECONDS?: string;
  RATE_LIMIT_SUBMIT_BASE_HOURLY?: string;
  RATE_LIMIT_SUBMIT_WINDOW_SECONDS?: string;
  RATE_LIMIT_REPUTATION_TIERS?: string;
  RATE_LIMIT_ROLE_HOURLY_LIMITS?: string;
  INVALIDATION_ANON_THRESHOLD?: string;
}

function parseTrustedOrigins(raw: string | undefined): string[] | undefined {
  if (!raw || raw.trim() === "") {
    return undefined;
  }
  const parsed = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return parsed.length > 0 ? parsed : undefined;
}

const worker = {
  async fetch(request: Request, env: ApiWorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const dbRead = createDb(env.HYPERDRIVE_READ.connectionString, { max: 5 });
    const dbWrite = createDb(env.HYPERDRIVE_WRITE.connectionString, { max: 5 });
    const backgroundTasks: Promise<unknown>[] = [];

    const app = createApiApp({
      dbRead,
      dbWrite,
      outbound: createLiveOutboundClient({
        proxyConfig: parseOutboundProxyConfig(env.OUTBOUND_PROXY_CONFIG),
        emailBinding: env.EMAIL,
        defaultEmailFrom: env.EMAIL_FROM ?? DEFAULT_EMAIL_FROM,
      }),
      onBackgroundTask: (promise) => {
        backgroundTasks.push(promise);
      },
      onBackgroundTaskError: (error) => {
        console.error("API background task failed:", error);
      },
      readKeyLimiter: env.RATE_LIMITER_READ_KEY,
      readIpLimiter: env.RATE_LIMITER_READ_IP,
      config: {
        enableHealthOutboundProbe: env.ENABLE_HEALTH_OUTBOUND_PROBE === "true",
        baseUrl: env.API_BASE_URL,
        authSecret: env.AUTH_SECRET,
        cookieDomain: env.COOKIE_DOMAIN,
        emailFrom: env.EMAIL_FROM,
        trustedOrigins: parseTrustedOrigins(env.TRUSTED_ORIGINS),
        tmdb: {
          accessToken: env.TMDB_ACCESS_TOKEN,
          apiKey: env.TMDB_API_KEY,
          apiBaseUrl: env.TMDB_API_BASE_URL,
          traktClientId: env.TRAKT_CLIENT_ID,
          traktApiBaseUrl: env.TRAKT_API_BASE_URL,
        },
        oauth: parseOAuthConfigFromEnv(env),
        rateLimits: parseRateLimitConfigFromEnv(env),
        anonymousInvalidationThreshold: parseAnonymousInvalidationThresholdFromEnv(
          env.INVALIDATION_ANON_THRESHOLD,
        ),
      },
    });

    try {
      return await app.fetch(request, env, ctx);
    } finally {
      ctx.waitUntil(
        Promise.allSettled(backgroundTasks).finally(() =>
          Promise.allSettled([dbRead.destroy(), dbWrite.destroy()]),
        ),
      );
    }
  },
};

export default worker;
