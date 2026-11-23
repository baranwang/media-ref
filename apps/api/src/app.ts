import {
  createDefaultAdapterRegistry,
  type AdapterRegistry,
  type ExternalTargetKind,
  type OutboundClient,
  type ReputationTier,
  type TmdbGateway,
  type TmdbGatewayConfig,
} from "@media-ref/core";
import type { Db } from "@media-ref/db";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { registerApiKeyRoutes } from "./api-keys.ts";
import {
  AUTH_BASE_PATH,
  createAuth,
  isAllowedCorsOrigin,
  requireAuthenticatedSession,
  type ApiEnv,
  type AuthConfig,
  type AuthInstance,
} from "./auth.ts";
import { registerChangeRequestRoutes } from "./change-requests.ts";
import { registerLeadRoutes } from "./leads.ts";
import { registerMediaAdminRoutes } from "./media-admin.ts";
import { registerMediaRoutes } from "./media.ts";
import {
  createReadRateLimitRuntime,
  resolveSubmissionQuotaConfig,
  type RateLimitBinding,
  type RateLimitConfig,
} from "./rate-limit.ts";
import { registerReviewerRoutes } from "./reviewer.ts";

export interface ApiConfig extends AuthConfig {
  enableHealthOutboundProbe?: boolean;
  now?: () => Date;
  tmdb?: TmdbGatewayConfig;
  rateLimits?: RateLimitConfig;
  readKeyLimit?: number;
  readIpLimit?: number;
  readPeriodSeconds?: number;
  readRetryAfterSeconds?: number;
  submitBaseHourlyLimit?: number;
  submitWindowSeconds?: number;
  reputationTiers?: readonly ReputationTier[];
  roleHourlyLimits?: Partial<Record<string, number>>;
}

export interface ApiDeps {
  dbRead: Db;
  dbWrite: Db;
  outbound: OutboundClient;
  adapterRegistry?: AdapterRegistry;
  tmdbGateway?: TmdbGateway;
  onBackgroundTask?: (promise: Promise<unknown>) => void;
  onBackgroundTaskError?: (error: unknown) => void;
  readKeyLimiter?: RateLimitBinding;
  readIpLimiter?: RateLimitBinding;
  config: ApiConfig;
}

const VALID_KINDS = new Set<ExternalTargetKind>(["platform", "catalog"]);

function isValidHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function createApiApp(deps: ApiDeps): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  let cachedAuth: AuthInstance | undefined;

  const getAuth = (): AuthInstance => {
    cachedAuth ??= createAuth({
      dbWrite: deps.dbWrite,
      outbound: deps.outbound,
      config: deps.config,
    });
    return cachedAuth;
  };

  const hasCustomClock = deps.config.now !== undefined;
  const now = deps.config.now ?? (() => new Date());
  const adapterRegistry = deps.adapterRegistry ?? createDefaultAdapterRegistry();
  const readRateLimit = createReadRateLimitRuntime({
    readKeyLimiter: deps.readKeyLimiter,
    readIpLimiter: deps.readIpLimiter,
    config: {
      ...deps.config.rateLimits,
      ...(deps.config.readKeyLimit !== undefined ? { readKeyLimit: deps.config.readKeyLimit } : {}),
      ...(deps.config.readIpLimit !== undefined ? { readIpLimit: deps.config.readIpLimit } : {}),
      ...(deps.config.readPeriodSeconds !== undefined
        ? { readPeriodSeconds: deps.config.readPeriodSeconds }
        : {}),
      ...(deps.config.readRetryAfterSeconds !== undefined
        ? { readRetryAfterSeconds: deps.config.readRetryAfterSeconds }
        : {}),
    },
    now,
  });
  const submissionQuota = resolveSubmissionQuotaConfig({
    rateLimits: deps.config.rateLimits,
    submitBaseHourlyLimit: deps.config.submitBaseHourlyLimit,
    submitWindowSeconds: deps.config.submitWindowSeconds,
    reputationTiers: deps.config.reputationTiers,
    roleHourlyLimits: deps.config.roleHourlyLimits,
  });

  app.use(
    "*",
    cors({
      origin: (origin) => (isAllowedCorsOrigin(origin, deps.config) ? origin : ""),
      allowHeaders: ["Content-Type", "Authorization", "X-API-Key"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      credentials: true,
    }),
  );

  app.use("*", async (c, next) => {
    c.set("dbRead", deps.dbRead);
    c.set("dbWrite", deps.dbWrite);
    c.set("outbound", deps.outbound);
    c.set("adapterRegistry", adapterRegistry);
    c.set("tmdbConfig", deps.config.tmdb);
    c.set("tmdbGateway", deps.tmdbGateway);
    c.set("now", now);
    c.set("onBackgroundTask", deps.onBackgroundTask);
    c.set("onBackgroundTaskError", deps.onBackgroundTaskError);
    c.set("hasCustomClock", hasCustomClock);
    c.set("readRateLimit", readRateLimit);
    c.set("submissionQuota", submissionQuota);
    c.set("session", null);
    c.set("apiKey", null);
    if (c.req.path !== "/health" && c.req.path !== "/health/outbound") {
      c.set("auth", getAuth());
    }
    await next();
  });

  app.get("/health", async (c) => {
    try {
      const row = await deps.dbRead
        .selectFrom("schema_meta")
        .select("value")
        .where("key", "=", "bootstrap_version")
        .executeTakeFirst();

      if (!row) {
        return c.json({ ok: false, database: "uninitialized" }, 503);
      }

      return c.json({ ok: true, database: "ok" }, 200);
    } catch {
      return c.json({ ok: false, database: "error" }, 503);
    }
  });

  if (deps.config.enableHealthOutboundProbe) {
    app.get("/health/outbound", async (c) => {
      const kindParam = (c.req.query("kind") ?? "platform") as ExternalTargetKind;
      const namespace = c.req.query("namespace")?.trim();
      const url = c.req.query("url")?.trim();

      if (!VALID_KINDS.has(kindParam) || !namespace || !url || !isValidHttpUrl(url)) {
        return c.json({ ok: false, error: "invalid_probe_parameters" }, 400);
      }

      try {
        const upstream = await deps.outbound.fetchExternal({
          kind: kindParam,
          namespace,
          url,
          method: "GET",
        });

        return c.json(
          {
            ok: true,
            kind: kindParam,
            namespace,
            upstreamStatus: upstream.status,
            bodyPreview: upstream.body.slice(0, 512),
          },
          200,
        );
      } catch {
        return c.json({ ok: false, error: "upstream_error" }, 502);
      }
    });
  }

  app.on(["GET", "POST"], `${AUTH_BASE_PATH}/*`, (c) => c.get("auth").handler(c.req.raw));

  app.get("/v1/me", requireAuthenticatedSession, (c) => {
    const session = c.get("session");
    if (!session) {
      return c.json({ error: "UNAUTHORIZED", message: "Authentication required" }, 401);
    }
    return c.json(session.user, 200);
  });

  registerApiKeyRoutes(app);
  registerChangeRequestRoutes(app);
  registerLeadRoutes(app);
  registerReviewerRoutes(app);
  registerMediaAdminRoutes(app);
  registerMediaRoutes(app);

  return app;
}
