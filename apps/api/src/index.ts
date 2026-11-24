import type { ExecutionContext } from "@cloudflare/workers-types";
import { createLiveOutboundClient, parseOutboundProxyConfig } from "@media-ref/core";
import { createDb } from "@media-ref/db";
import { createApiApp } from "./app.ts";
import { DEFAULT_EMAIL_FROM } from "./auth.ts";
import { parseAnonymousInvalidationThresholdFromEnv } from "./invalidation.ts";
import { parseOAuthConfigFromEnv } from "./oauth.ts";
import {
  parseRateLimitConfigFromEnv,
  resolveModuleScopedReadRateLimitRuntime,
} from "./rate-limit.ts";
import type { ApiWorkerEnv } from "./worker-env.ts";

// Cloudflare Workers `workerd` entry module must ONLY export `default` and
// `WorkerEntrypoint` subclasses (never plain constants or helper objects).
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

const worker = {
  async fetch(request: Request, env: ApiWorkerEnv, ctx: ExecutionContext): Promise<Response> {
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
        emailBinding: env.EMAIL,
        defaultEmailFrom: env.EMAIL_FROM ?? DEFAULT_EMAIL_FROM,
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
