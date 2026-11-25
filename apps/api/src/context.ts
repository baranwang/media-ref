import type { ExecutionContext } from "@cloudflare/workers-types";
import { createDomainConnectError } from "@media-ref/client";
import {
  BatchMediaQueryError,
  ConflictResolutionError,
  InvalidationError,
  MediaServiceError,
  MediaSyncError,
  SubmissionQuotaExceededError,
  type AdapterRegistry,
  type CatalogGatewayConfig,
  type InvalidationReporterInput,
  type OutboundClient,
  type SubmissionQuotaConfig,
  type TmdbGateway,
  type TmdbGatewayConfig,
} from "@media-ref/core";
import type { Db } from "@media-ref/db";
import { Code, ConnectError, createContextKey, type HandlerContext } from "@connectrpc/connect";
import {
  extractApiKeyFromHeaders,
  verifyApiKey,
  type ApiKeyAction,
  type VerifiedApiKey,
} from "./api-keys.ts";
import { getAuthenticatedSession, type AuthenticatedSession, type AuthInstance } from "./auth.ts";
import { checkReadRateLimit, type ReadRateLimitRuntime } from "./rate-limit.ts";

export interface ApiRequestRuntime {
  dbRead: Db;
  dbWrite: Db;
  outbound: OutboundClient;
  adapterRegistry: AdapterRegistry;
  catalogConfig: CatalogGatewayConfig | undefined;
  tmdbConfig: TmdbGatewayConfig | undefined;
  tmdbGateway: TmdbGateway | undefined;
  now: () => Date;
  hasCustomClock: boolean;
  readRateLimit: ReadRateLimitRuntime;
  submissionQuota: SubmissionQuotaConfig | undefined;
  anonymousInvalidationThreshold: number;
  getAuth: () => AuthInstance;
  /** True only for requests that arrived through the `InternalApi` service-binding entrypoint. */
  internal?: boolean;
  executionCtx?: ExecutionContext;
  onBackgroundTask?: (promise: Promise<unknown>) => void;
  onBackgroundTaskError?: (error: unknown) => void;
}

export const kApiRequestRuntime = createContextKey<ApiRequestRuntime | null>(null, {
  description: "media-ref API per-request runtime",
});

export function getRuntime(ctx: HandlerContext): ApiRequestRuntime {
  const runtime = ctx.values.get(kApiRequestRuntime);
  if (!runtime) {
    throw new ConnectError("API request runtime is not bound", Code.Internal);
  }
  return runtime;
}

export function scheduleBackgroundTask(
  runtime: ApiRequestRuntime,
  work: () => Promise<unknown>,
): void {
  const promise = Promise.resolve()
    .then(work)
    .catch((error: unknown) => {
      runtime.onBackgroundTaskError?.(error);
    });

  runtime.onBackgroundTask?.(promise);

  try {
    runtime.executionCtx?.waitUntil(promise);
  } catch {
    // No ExecutionContext attached (e.g. direct app.fetch calls in tests).
  }
}

export async function requireApiKeyAuth(
  ctx: HandlerContext,
  options: { db: "read" | "write"; permission: ApiKeyAction },
): Promise<VerifiedApiKey> {
  const runtime = getRuntime(ctx);
  const rawKey = extractApiKeyFromHeaders(ctx.requestHeader);
  if (!rawKey) {
    throw createDomainConnectError({
      status: 401,
      code: "API_KEY_REQUIRED",
      message: "API key is required",
    });
  }

  const db = options.db === "read" ? runtime.dbRead : runtime.dbWrite;
  const result = await verifyApiKey({
    db,
    rawKey,
    requiredPermission: options.permission,
    now: runtime.now(),
  });

  if (!result.ok) {
    throw createDomainConnectError({
      status: result.status,
      code: result.code,
      message: result.message,
    });
  }

  return result.apiKey;
}

export async function enforceReadRateLimit(
  ctx: HandlerContext,
  apiKey: VerifiedApiKey,
): Promise<void> {
  const runtime = getRuntime(ctx);
  const decision = await checkReadRateLimit({
    runtime: runtime.readRateLimit,
    headers: ctx.requestHeader,
    apiKeyId: apiKey.keyId,
  });

  if (!decision.allowed) {
    throw createDomainConnectError({
      status: 429,
      code: "RATE_LIMITED",
      scope: decision.scope,
      retryAfterSeconds: decision.retryAfterSeconds,
      message: decision.message,
    });
  }
}

/**
 * Auth for public read RPCs. Internal (service-binding) callers without an API key are let
 * through and limited by the forwarded visitor IP only; everyone else needs a read API key.
 * Returns the verified key, or null for keyless internal reads.
 */
export async function authorizePublicRead(ctx: HandlerContext): Promise<VerifiedApiKey | null> {
  const runtime = getRuntime(ctx);
  if (runtime.internal && extractApiKeyFromHeaders(ctx.requestHeader) === null) {
    const decision = await checkReadRateLimit({
      runtime: runtime.readRateLimit,
      headers: ctx.requestHeader,
    });
    if (!decision.allowed) {
      throw createDomainConnectError({
        status: 429,
        code: "RATE_LIMITED",
        scope: decision.scope,
        retryAfterSeconds: decision.retryAfterSeconds,
        message: decision.message,
      });
    }
    return null;
  }

  const apiKey = await requireApiKeyAuth(ctx, { db: "read", permission: "read" });
  await enforceReadRateLimit(ctx, apiKey);
  return apiKey;
}

export async function requireSessionAuth(ctx: HandlerContext): Promise<AuthenticatedSession> {
  const runtime = getRuntime(ctx);
  const session = await getAuthenticatedSession(runtime.getAuth(), ctx.requestHeader);
  if (!session) {
    throw createDomainConnectError({
      status: 401,
      code: "UNAUTHORIZED",
      message: "Authentication required",
    });
  }
  return session;
}

export async function requireVerifiedUserAuth(ctx: HandlerContext): Promise<AuthenticatedSession> {
  const session = await requireSessionAuth(ctx);
  if (!session.user.emailVerified) {
    throw createDomainConnectError({
      status: 403,
      code: "EMAIL_NOT_VERIFIED",
      message: "Email verification is required",
    });
  }
  return session;
}

export async function requireReviewerAuth(ctx: HandlerContext): Promise<AuthenticatedSession> {
  const session = await requireSessionAuth(ctx);
  if (session.user.role !== "reviewer" && session.user.role !== "owner") {
    throw createDomainConnectError({
      status: 403,
      code: "FORBIDDEN",
      message: "Reviewer role required",
    });
  }
  return session;
}

export async function requireOwnerAuth(ctx: HandlerContext): Promise<AuthenticatedSession> {
  const session = await requireSessionAuth(ctx);
  if (session.user.role !== "owner") {
    throw createDomainConnectError({
      status: 403,
      code: "FORBIDDEN",
      message: "Owner role required",
    });
  }
  return session;
}

export async function resolveSubmitterAuth(
  ctx: HandlerContext,
): Promise<{ userId: string; keyId: string | null }> {
  const runtime = getRuntime(ctx);
  const rawApiKey = extractApiKeyFromHeaders(ctx.requestHeader);
  if (rawApiKey !== null) {
    const verified = await verifyApiKey({
      db: runtime.dbWrite,
      rawKey: rawApiKey,
      requiredPermission: "submit",
      now: runtime.now(),
    });
    if (!verified.ok) {
      throw createDomainConnectError({
        status: verified.status,
        code: verified.code,
        message: verified.message,
      });
    }
    return {
      userId: verified.apiKey.userId,
      keyId: verified.apiKey.keyId,
    };
  }

  const session = await getAuthenticatedSession(runtime.getAuth(), ctx.requestHeader);
  if (!session) {
    throw createDomainConnectError({
      status: 401,
      code: "UNAUTHORIZED",
      message: "Authentication or API key with submit permission is required",
    });
  }

  if (!session.user.emailVerified) {
    throw createDomainConnectError({
      status: 403,
      code: "EMAIL_NOT_VERIFIED",
      message: "Email verification is required",
    });
  }

  return {
    userId: session.user.id,
    keyId: null,
  };
}

export async function resolveChangeRequestReaderAuth(ctx: HandlerContext): Promise<void> {
  const runtime = getRuntime(ctx);
  const rawApiKey = extractApiKeyFromHeaders(ctx.requestHeader);
  if (rawApiKey !== null) {
    const verified = await verifyApiKey({
      db: runtime.dbWrite,
      rawKey: rawApiKey,
      requiredPermission: "read",
      now: runtime.now(),
    });
    if (!verified.ok) {
      throw createDomainConnectError({
        status: verified.status,
        code: verified.code,
        message: verified.message,
      });
    }
    return;
  }

  const session = await getAuthenticatedSession(runtime.getAuth(), ctx.requestHeader);
  if (!session) {
    throw createDomainConnectError({
      status: 401,
      code: "UNAUTHORIZED",
      message: "Authentication or API key is required",
    });
  }
}

export async function resolveInvalidationReporterAuth(
  ctx: HandlerContext,
): Promise<InvalidationReporterInput> {
  const runtime = getRuntime(ctx);
  const rawApiKey = extractApiKeyFromHeaders(ctx.requestHeader);
  if (rawApiKey !== null) {
    const verified = await verifyApiKey({
      db: runtime.dbWrite,
      rawKey: rawApiKey,
      requiredPermission: "report",
      now: runtime.now(),
    });
    if (!verified.ok) {
      throw createDomainConnectError({
        status: verified.status,
        code: verified.code,
        message: verified.message,
      });
    }
    return {
      reporterType: "api_key",
      reporterKeyId: verified.apiKey.keyId,
      reporterUserId: verified.apiKey.userId,
    };
  }

  const session = await getAuthenticatedSession(runtime.getAuth(), ctx.requestHeader);
  if (!session) {
    throw createDomainConnectError({
      status: 401,
      code: "UNAUTHORIZED",
      message: "Authentication or API key with report permission is required",
    });
  }

  return {
    reporterType: "user",
    reporterUserId: session.user.id,
  };
}

export async function resolveAssociationHistoryReaderAuth(
  ctx: HandlerContext,
): Promise<{ useReadDb: boolean }> {
  const runtime = getRuntime(ctx);
  const rawApiKey = extractApiKeyFromHeaders(ctx.requestHeader);
  if (rawApiKey !== null) {
    const verified = await verifyApiKey({
      db: runtime.dbRead,
      rawKey: rawApiKey,
      requiredPermission: "read",
      now: runtime.now(),
    });
    if (!verified.ok) {
      throw createDomainConnectError({
        status: verified.status,
        code: verified.code,
        message: verified.message,
      });
    }
    return { useReadDb: true };
  }

  const session = await getAuthenticatedSession(runtime.getAuth(), ctx.requestHeader);
  if (!session) {
    throw createDomainConnectError({
      status: 401,
      code: "UNAUTHORIZED",
      message: "Authentication or read API key is required",
    });
  }

  return { useReadDb: false };
}

export function rethrowDomainError(error: unknown): never {
  if (error instanceof ConnectError) {
    throw error;
  }

  if (error instanceof SubmissionQuotaExceededError) {
    throw createDomainConnectError({
      status: 429,
      code: error.code,
      scope: error.scope,
      limit: error.limit,
      used: error.used,
      windowSeconds: error.windowSeconds,
      retryAfterSeconds: error.retryAfterSeconds,
      message: error.message,
    });
  }

  if (error instanceof MediaServiceError) {
    throw createDomainConnectError({
      status: error.status,
      code: error.code,
      message: error.message,
      validationErrors: error.details,
    });
  }

  if (error instanceof ConflictResolutionError) {
    throw createDomainConnectError({
      status: error.status,
      code: error.code,
      message: error.message,
    });
  }

  if (error instanceof MediaSyncError) {
    throw createDomainConnectError({
      status: error.status,
      code: error.code,
      message: error.message,
    });
  }

  if (error instanceof InvalidationError) {
    throw createDomainConnectError({
      status: error.status,
      code: error.code,
      message: error.message,
    });
  }

  if (error instanceof BatchMediaQueryError) {
    throw createDomainConnectError({
      status: error.status,
      code: error.code,
      message: error.message,
    });
  }

  throw error;
}
