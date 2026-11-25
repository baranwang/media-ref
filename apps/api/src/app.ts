import type { ExecutionContext } from "@cloudflare/workers-types";
import { proto } from "@media-ref/client";
import {
  createDefaultAdapterRegistry,
  resolveAnonymousInvalidationThreshold,
  type AdapterRegistry,
  type BrowseCache,
  type CatalogGatewayConfig,
  type ExternalTargetKind,
  type OutboundClient,
  type ReputationTier,
  type TmdbGateway,
  type TmdbGatewayConfig,
} from "@media-ref/core";
import type { Db } from "@media-ref/db";
import { createConnectRouter, createContextValues } from "@connectrpc/connect";
import {
  universalServerRequestFromFetch,
  universalServerResponseToFetch,
  type UniversalHandler,
} from "@connectrpc/connect/protocol";
import { accountServiceImpl } from "./api-keys.ts";
import { associationServiceImpl } from "./associations.ts";
import { browseServiceImpl } from "./browse.ts";
import {
  AUTH_BASE_PATH,
  createAuth,
  isAllowedCorsOrigin,
  type AuthConfig,
  type AuthInstance,
} from "./auth.ts";
import { changeRequestServiceImpl } from "./change-requests.ts";
import { kApiRequestRuntime, type ApiRequestRuntime } from "./context.ts";
import { mediaServiceImpl } from "./media.ts";
import {
  createReadRateLimitRuntime,
  resolveSubmissionQuotaConfig,
  type RateLimitBinding,
  type RateLimitConfig,
  type ReadRateLimitRuntime,
} from "./rate-limit.ts";
import { reviewerServiceImpl } from "./reviewer.ts";
import type { UsageReader, UsageRecorder } from "./usage.ts";

export interface ApiConfig extends AuthConfig {
  enableHealthOutboundProbe?: boolean;
  now?: () => Date;
  catalog?: CatalogGatewayConfig;
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
  anonymousInvalidationThreshold?: number;
}

export interface ApiDeps {
  dbRead: Db;
  dbWrite: Db;
  outbound: OutboundClient;
  adapterRegistry?: AdapterRegistry;
  browseCache?: BrowseCache;
  usageRecorder?: UsageRecorder;
  usageReader?: UsageReader;
  tmdbGateway?: TmdbGateway;
  onBackgroundTask?: (promise: Promise<unknown>) => void;
  onBackgroundTaskError?: (error: unknown) => void;
  readKeyLimiter?: RateLimitBinding;
  readIpLimiter?: RateLimitBinding;
  readRateLimitRuntime?: ReadRateLimitRuntime;
  config: ApiConfig;
}

export interface ApiApp {
  fetch(request: Request, env?: unknown, ctx?: ExecutionContext): Promise<Response>;
  /**
   * Entry for trusted callers reaching the API over a service binding (the website server).
   * Public read RPCs skip the API key; the caller forwards the visitor IP in
   * `INTERNAL_VISITOR_IP_HEADER` so per-IP read limits still apply.
   */
  fetchInternal(request: Request, ctx?: ExecutionContext): Promise<Response>;
}

export const INTERNAL_VISITOR_IP_HEADER = "x-media-ref-visitor-ip";

const VALID_KINDS = new Set<ExternalTargetKind>(["platform", "catalog"]);

const CORS_ALLOW_HEADERS =
  "Content-Type, Authorization, X-API-Key, Connect-Protocol-Version, Connect-Timeout-Ms, X-Grpc-Web, X-User-Agent";
const CORS_EXPOSE_HEADERS = "Retry-After, Grpc-Status, Grpc-Message, Grpc-Status-Details-Bin";
const CORS_ALLOW_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";

/**
 * Module-level singleton ConnectRPC router shared across all Worker requests.
 * Per-request dependencies (dual Hyperdrive pools, lazy Better Auth, rate limiters)
 * are injected per call via Connect `ContextValues`.
 */
const connectRouter = createConnectRouter({
  // Accept standard Connect binary/JSON, gRPC-Web, and gRPC requests without requiring
  // manual `Connect-Protocol-Version` header for plain HTTP clients/tests.
  requireConnectProtocolHeader: false,
  jsonOptions: {
    ignoreUnknownFields: false,
  },
});

connectRouter.service(proto.MediaService, mediaServiceImpl);
connectRouter.service(proto.ChangeRequestService, changeRequestServiceImpl);
connectRouter.service(proto.AssociationService, associationServiceImpl);
connectRouter.service(proto.AccountService, accountServiceImpl);
connectRouter.service(proto.ReviewerService, reviewerServiceImpl);
connectRouter.service(proto.BrowseService, browseServiceImpl);

const connectHandlerMap = new Map<string, UniversalHandler>(
  connectRouter.handlers.map((handler) => [handler.requestPath, handler]),
);

function isValidHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function appendVaryOrigin(headers: Headers): void {
  const existing = headers.get("vary");
  if (!existing) {
    headers.set("vary", "Origin");
    return;
  }
  const parts = existing.split(",").map((part) => part.trim().toLowerCase());
  if (!parts.includes("origin")) {
    headers.set("vary", `${existing}, Origin`);
  }
}

function applyCorsHeaders(request: Request, response: Response, config: AuthConfig): Response {
  const origin = request.headers.get("origin");
  if (!origin || !isAllowedCorsOrigin(origin, config)) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-credentials", "true");
  headers.set("access-control-expose-headers", CORS_EXPOSE_HEADERS);
  appendVaryOrigin(headers);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function buildPreflightResponse(request: Request, config: AuthConfig): Response {
  const origin = request.headers.get("origin");
  const headers = new Headers();
  if (origin && isAllowedCorsOrigin(origin, config)) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-credentials", "true");
    headers.set("access-control-allow-headers", CORS_ALLOW_HEADERS);
    headers.set("access-control-allow-methods", CORS_ALLOW_METHODS);
    headers.set("access-control-expose-headers", CORS_EXPOSE_HEADERS);
    headers.set("vary", "Origin");
  }
  return new Response(null, { status: 204, headers });
}

export function createApiApp(deps: ApiDeps): ApiApp {
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
  const readRateLimit =
    deps.readRateLimitRuntime ??
    createReadRateLimitRuntime({
      readKeyLimiter: deps.readKeyLimiter,
      readIpLimiter: deps.readIpLimiter,
      config: {
        ...deps.config.rateLimits,
        ...(deps.config.readKeyLimit !== undefined
          ? { readKeyLimit: deps.config.readKeyLimit }
          : {}),
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
  const anonymousInvalidationThreshold = resolveAnonymousInvalidationThreshold(
    deps.config.anonymousInvalidationThreshold,
  );

  const baseRuntime: Omit<ApiRequestRuntime, "executionCtx"> = {
    dbRead: deps.dbRead,
    dbWrite: deps.dbWrite,
    outbound: deps.outbound,
    adapterRegistry,
    catalogConfig: deps.config.catalog,
    browseCache: deps.browseCache,
    usageRecorder: deps.usageRecorder,
    usageReader: deps.usageReader,
    tmdbConfig: deps.config.tmdb,
    tmdbGateway: deps.tmdbGateway,
    now,
    hasCustomClock,
    readRateLimit,
    submissionQuota,
    anonymousInvalidationThreshold,
    getAuth,
    onBackgroundTask: deps.onBackgroundTask,
    onBackgroundTaskError: deps.onBackgroundTaskError,
  };

  const handle = async (
    request: Request,
    ctx: ExecutionContext | undefined,
    internal: boolean,
  ): Promise<Response> => {
    if (request.method === "OPTIONS") {
      return buildPreflightResponse(request, deps.config);
    }

    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname === "/health" && request.method === "GET") {
      try {
        const row = await deps.dbRead
          .selectFrom("schema_meta")
          .select("value")
          .where("key", "=", "bootstrap_version")
          .executeTakeFirst();

        const res = row
          ? Response.json({ ok: true, database: "ok" }, { status: 200 })
          : Response.json({ ok: false, database: "uninitialized" }, { status: 503 });
        return applyCorsHeaders(request, res, deps.config);
      } catch {
        return applyCorsHeaders(
          request,
          Response.json({ ok: false, database: "error" }, { status: 503 }),
          deps.config,
        );
      }
    }

    if (
      deps.config.enableHealthOutboundProbe &&
      pathname === "/health/outbound" &&
      request.method === "GET"
    ) {
      const kindParam = (url.searchParams.get("kind") ?? "platform") as ExternalTargetKind;
      const namespace = url.searchParams.get("namespace")?.trim();
      const targetUrl = url.searchParams.get("url")?.trim();

      if (!VALID_KINDS.has(kindParam) || !namespace || !targetUrl || !isValidHttpUrl(targetUrl)) {
        return applyCorsHeaders(
          request,
          Response.json({ ok: false, error: "invalid_probe_parameters" }, { status: 400 }),
          deps.config,
        );
      }

      try {
        const upstream = await deps.outbound.fetchExternal({
          kind: kindParam,
          namespace,
          url: targetUrl,
          method: "GET",
        });

        return applyCorsHeaders(
          request,
          Response.json(
            {
              ok: true,
              kind: kindParam,
              namespace,
              upstreamStatus: upstream.status,
              bodyPreview: upstream.body.slice(0, 512),
            },
            { status: 200 },
          ),
          deps.config,
        );
      } catch {
        return applyCorsHeaders(
          request,
          Response.json({ ok: false, error: "upstream_error" }, { status: 502 }),
          deps.config,
        );
      }
    }

    if (
      (pathname === AUTH_BASE_PATH || pathname.startsWith(`${AUTH_BASE_PATH}/`)) &&
      (request.method === "GET" || request.method === "POST")
    ) {
      const authRes = await getAuth().handler(request);
      return applyCorsHeaders(request, authRes, deps.config);
    }

    const connectHandler = connectHandlerMap.get(pathname);
    if (connectHandler) {
      const runtime: ApiRequestRuntime = {
        ...baseRuntime,
        internal,
        executionCtx: ctx,
      };
      const uReq = universalServerRequestFromFetch(request, {});
      uReq.contextValues = createContextValues().set(kApiRequestRuntime, runtime);
      const uRes = await connectHandler(uReq);
      const fetchRes = universalServerResponseToFetch(uRes);
      return applyCorsHeaders(request, fetchRes, deps.config);
    }

    return applyCorsHeaders(
      request,
      Response.json({ error: "NOT_FOUND", message: "Not found" }, { status: 404 }),
      deps.config,
    );
  };

  return {
    fetch: (request, _env, ctx) => handle(request, ctx, false),
    fetchInternal: (request, ctx) => {
      // Service-binding requests carry no Cloudflare client IP; use the forwarded visitor IP.
      const headers = new Headers(request.headers);
      headers.set("cf-connecting-ip", headers.get(INTERNAL_VISITOR_IP_HEADER) ?? "internal");
      return handle(new Request(request, { headers }), ctx, true);
    },
  };
}
