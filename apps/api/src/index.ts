import type { ExecutionContext } from "@cloudflare/workers-types";
import { createLiveOutboundClient, DOUBAN_API, parseOutboundProxyConfig } from "@media-ref/core";
import { createDb } from "@media-ref/db";
import { createApiApp } from "./app.ts";
import { createWorkersBrowseCache } from "./browse-cache.ts";
import { createAnalyticsUsageReader, createAnalyticsUsageRecorder } from "./usage.ts";
import { DEFAULT_EMAIL_FROM } from "./auth.ts";
import { parseAnonymousInvalidationThresholdFromEnv } from "./invalidation.ts";
import { parseOAuthConfigFromEnv } from "./oauth.ts";
import {
  parseRateLimitConfigFromEnv,
  resolveModuleScopedReadRateLimitRuntime,
} from "./rate-limit.ts";
import type { ApiWorkerEnv } from "./worker-env.ts";

// Not the deploy entry: `worker.ts` is (see its header). Tests import this module directly.
export type { ApiWorkerEnv } from "./worker-env.ts";

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

/**
 * Builds the per-request app and serves one request. `internal` marks requests that came in
 * through the `InternalApi` service-binding entrypoint (see `worker.ts`).
 */
export async function handleWorkerRequest(
  request: Request,
  env: ApiWorkerEnv,
  ctx: ExecutionContext,
  internal: boolean,
): Promise<Response> {
  DOUBAN_API.apiKey = env.DOUBAN_API_KEY?.trim() || undefined;
  const dbRead = createDb(env.HYPERDRIVE_READ.connectionString, { max: 5 });
  const dbWrite = createDb(env.HYPERDRIVE_WRITE.connectionString, { max: 5 });
  const backgroundTasks: Promise<unknown>[] = [];
  const rateLimits = parseRateLimitConfigFromEnv(env);
  const readRateLimitRuntime = resolveModuleScopedReadRateLimitRuntime({
    readKeyLimiter: env.RATE_LIMITER_READ_KEY,
    readIpLimiter: env.RATE_LIMITER_READ_IP,
    config: rateLimits,
  });

  const app = createApiApp({
    dbRead,
    dbWrite,
    outbound: createLiveOutboundClient({
      proxyConfig: parseOutboundProxyConfig(env.OUTBOUND_PROXY_CONFIG),
      egressFetcher: env.EGRESS,
      emailBinding: env.EMAIL,
      defaultEmailFrom: env.EMAIL_FROM ?? DEFAULT_EMAIL_FROM,
    }),
    browseCache: createWorkersBrowseCache(),
    usageRecorder: createAnalyticsUsageRecorder(env.API_USAGE),
    usageReader: createAnalyticsUsageReader({
      accountId: env.CF_ACCOUNT_ID,
      apiToken: env.ANALYTICS_API_TOKEN,
    }),
    onBackgroundTask: (promise) => {
      backgroundTasks.push(promise);
    },
    onBackgroundTaskError: (error) => {
      console.error("API background task failed:", error);
    },
    readRateLimitRuntime,
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
      catalog: {
        tmdb: {
          accessToken: env.TMDB_ACCESS_TOKEN,
          apiKey: env.TMDB_API_KEY,
          apiBaseUrl: env.TMDB_API_BASE_URL,
          traktClientId: env.TRAKT_CLIENT_ID,
          traktApiBaseUrl: env.TRAKT_API_BASE_URL,
        },
        tvdbBearerToken: env.TVDB_BEARER_TOKEN,
        tvdbApiBaseUrl: env.TVDB_API_BASE_URL,
        doubanApiBaseUrl: env.DOUBAN_API_BASE_URL,
        bangumiApiBaseUrl: env.BANGUMI_API_BASE_URL,
        imdbApiBaseUrl: env.IMDB_API_BASE_URL,
        traktClientId: env.TRAKT_CLIENT_ID,
        traktApiBaseUrl: env.TRAKT_API_BASE_URL,
      },
      oauth: parseOAuthConfigFromEnv(env),
      rateLimits,
      anonymousInvalidationThreshold: parseAnonymousInvalidationThresholdFromEnv(
        env.INVALIDATION_ANON_THRESHOLD,
      ),
    },
  });

  try {
    return await (internal ? app.fetchInternal(request, ctx) : app.fetch(request, env, ctx));
  } finally {
    ctx.waitUntil(
      Promise.allSettled(backgroundTasks).finally(() =>
        Promise.allSettled([dbRead.destroy(), dbWrite.destroy()]),
      ),
    );
  }
}

const worker = {
  fetch: (request: Request, env: ApiWorkerEnv, ctx: ExecutionContext): Promise<Response> =>
    handleWorkerRequest(request, env, ctx, false),
};

export default worker;
