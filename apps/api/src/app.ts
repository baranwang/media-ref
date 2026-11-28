import type { ExecutionContext } from "@cloudflare/workers-types";
import { proto } from "@media-ref/client";
import * as internalProto from "@media-ref/client/internal";
import {
  createDefaultAdapterRegistry,
  resolveAnonymousInvalidationThreshold,
  type AdapterRegistry,
  type BrowseCache,
  type CatalogGatewayConfig,
  type OutboundClient,
  type ReputationTier,
  type TmdbGateway,
  type TmdbGatewayConfig,
} from "@media-ref/core";
import type { Db } from "@media-ref/db";
import {
  ConnectError,
  createConnectRouter,
  createContextValues,
  type Interceptor,
} from "@connectrpc/connect";
import {
  universalServerRequestFromFetch,
  universalServerResponseToFetch,
  type UniversalHandler,
} from "@connectrpc/connect/protocol";
import { accountServiceImpl, apiKeyServiceImpl } from "./api-keys.ts";
import { associationServiceImpl } from "./associations.ts";
import { browseServiceImpl } from "./browse.ts";
import {
  AUTH_BASE_PATH,
  createAuth,
  isAllowedCorsOrigin,
  type AuthConfig,
  type AuthInstance,
} from "./auth.ts";
import { changeRequestServiceImpl, contributorServiceImpl } from "./change-requests.ts";
import { kApiRequestRuntime, limitRpcByIp, type ApiRequestRuntime } from "./context.ts";
import { handleMcpRequest, MCP_PATH } from "./mcp.ts";
import { mediaServiceImpl } from "./media.ts";
import {
  checkReadRateLimit,
  createReadRateLimitRuntime,
  resolveSubmissionQuotaConfig,
  type RateLimitBinding,
  type RateLimitConfig,
  type ReadRateLimitRuntime,
} from "./rate-limit.ts";
import { reviewerServiceImpl } from "./reviewer.ts";
import type { UsageReader, UsageRecorder } from "./usage.ts";

export interface ApiConfig extends AuthConfig {
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
  /** Extra per-IP limit on auth POSTs (sign-in, sign-up, verification email), on top of the read limit. */
  authIpLimiter?: RateLimitBinding;
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

const CORS_ALLOW_HEADERS =
  "Content-Type, Authorization, X-API-Key, Connect-Protocol-Version, Connect-Timeout-Ms, X-Grpc-Web, X-User-Agent";
const CORS_EXPOSE_HEADERS = "Retry-After, Grpc-Status, Grpc-Message, Grpc-Status-Details-Bin";
const CORS_ALLOW_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";

const logUnexpectedRpcErrors: Interceptor = (next) => async (request) => {
  try {
    return await next(request);
  } catch (error) {
    if (!(error instanceof ConnectError)) {
      // Log only a single-line diagnostic, not the request, error object, or its cause.
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : "Non-Error exception";
      const diagnostic = message
        .split(/[\r\n]/, 1)[0]!
        .replace(/\S+/g, (word) => (word.includes("@") ? "[email]" : word))
        .slice(0, 512);
      console.error(
        `RPC ${request.method.parent.typeName}/${request.method.name} failed: ${diagnostic}`,
      );
    }
    throw error;
  }
};

/**
 * Module-level singleton ConnectRPC router shared across all Worker requests.
 * Per-request dependencies (dual Hyperdrive pools, lazy Better Auth, rate limiters)
 * are injected per call via Connect `ContextValues`.
 */
const connectRouter = createConnectRouter({
  // Accept standard Connect binary/JSON, gRPC-Web, and gRPC requests without requiring
  // manual `Connect-Protocol-Version` header for plain HTTP clients/tests.
  readMaxBytes: 1024 * 1024,
  requireConnectProtocolHeader: false,
  interceptors: [logUnexpectedRpcErrors, limitRpcByIp],
  jsonOptions: {
    ignoreUnknownFields: false,
  },
});

connectRouter.service(proto.MediaService, mediaServiceImpl);
connectRouter.service(proto.ChangeRequestService, changeRequestServiceImpl);
connectRouter.service(proto.AssociationService, associationServiceImpl);
connectRouter.service(proto.ApiKeyService, apiKeyServiceImpl);
connectRouter.service(internalProto.AccountService, accountServiceImpl);
connectRouter.service(internalProto.ContributorService, contributorServiceImpl);
connectRouter.service(internalProto.ReviewerService, reviewerServiceImpl);
connectRouter.service(proto.BrowseService, browseServiceImpl);

const connectHandlerMap = new Map<string, UniversalHandler>(
  connectRouter.handlers.map((handler) => [handler.requestPath, handler]),
);

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
      (pathname === AUTH_BASE_PATH || pathname.startsWith(`${AUTH_BASE_PATH}/`)) &&
      (request.method === "GET" || request.method === "POST")
    ) {
      // Better Auth's own limiter is off outside NODE_ENV=production and in-memory per request.
      for (const ipLimiter of request.method === "POST"
        ? [readRateLimit.ipLimiter, deps.authIpLimiter]
        : []) {
        if (!ipLimiter) continue;
        const decision = await checkReadRateLimit({
          runtime: { ...readRateLimit, ipLimiter },
          headers: request.headers,
        });
        if (!decision.allowed) {
          return applyCorsHeaders(
            request,
            Response.json(
              { code: "RATE_LIMITED", message: decision.message },
              {
                status: 429,
                headers: { "Retry-After": String(decision.retryAfterSeconds) },
              },
            ),
            deps.config,
          );
        }
      }
      const authRes = await getAuth().handler(request);
      return applyCorsHeaders(request, authRes, deps.config);
    }

    // Public only: MCP tools call the public RPCs below with the caller's API key.
    if (pathname === MCP_PATH && !internal) {
      const res = await handleMcpRequest(request, (rpcRequest) => handle(rpcRequest, ctx, false));
      return applyCorsHeaders(request, res, deps.config);
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
