import type { ExecutionContext } from "@cloudflare/workers-types";
import { createDomainConnectError } from "@media-ref/client";
import {
  BatchMediaQueryError,
  CommentError,
  ConflictResolutionError,
  InvalidationError,
  MediaServiceError,
  MediaSyncError,
  SubmissionQuotaExceededError,
  type AdapterRegistry,
  type BrowseCache,
  type CatalogGatewayConfig,
  type InvalidationReporterInput,
  type OutboundClient,
  type SubmissionQuotaConfig,
  type TmdbGateway,
  type TmdbGatewayConfig,
} from "@media-ref/core";
import type { Db } from "@media-ref/db";
import {
  Code,
  ConnectError,
  createContextKey,
  type HandlerContext,
  type Interceptor,
} from "@connectrpc/connect";
import {
  extractApiKeyFromHeaders,
  verifyApiKey,
  type ApiKeyAction,
  type VerifiedApiKey,
} from "./api-keys.ts";
import { getAuthenticatedSession, type AuthenticatedSession, type AuthInstance } from "./auth.ts";
import { checkReadRateLimit, type ReadRateLimitRuntime } from "./rate-limit.ts";
import type { UsageReader, UsageRecorder } from "./usage.ts";

export interface ApiRequestRuntime {
  dbRead: Db;
  dbWrite: Db;
  outbound: OutboundClient;
  adapterRegistry: AdapterRegistry;
  catalogConfig: CatalogGatewayConfig | undefined;
  browseCache?: BrowseCache;
  usageRecorder?: UsageRecorder;
  usageReader?: UsageReader;
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

async function enforceRateLimit(input: Parameters<typeof checkReadRateLimit>[0]): Promise<void> {
  const decision = await checkReadRateLimit(input);
  if (!decision.allowed) {
    throw createDomainConnectError({ status: 429, code: "RATE_LIMITED", ...decision });
  }
}

export const limitRpcByIp: Interceptor = (next) => async (req) => {
  const runtime = req.contextValues.get(kApiRequestRuntime);
  if (!runtime) throw new ConnectError("API request runtime is not bound", Code.Internal);
  await enforceRateLimit({ runtime: runtime.readRateLimit, headers: req.header });
  return next(req);
};

/**
 * Auth for public read RPCs. Internal (service-binding) callers without an API key are let
 * through and limited by the forwarded visitor IP only; everyone else needs a read API key.
 * Returns the verified key, or null for keyless internal reads.
 */
export async function authorizePublicRead(ctx: HandlerContext): Promise<VerifiedApiKey | null> {
  const runtime = getRuntime(ctx);
  if (runtime.internal && extractApiKeyFromHeaders(ctx.requestHeader) === null) {
    return null;
  }

  const apiKey = await requireApiKeyAuth(ctx, { db: "read", permission: "read" });
  await enforceRateLimit({ runtime: runtime.readRateLimit, apiKeyId: apiKey.keyId });
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

function requireVerifiedEmail(session: AuthenticatedSession): void {
  if (!session.user.emailVerified) {
    throw createDomainConnectError({
      status: 403,
      code: "EMAIL_NOT_VERIFIED",
      message: "Email verification is required",
    });
  }
}

export async function requireVerifiedUserAuth(ctx: HandlerContext): Promise<AuthenticatedSession> {
  const session = await requireSessionAuth(ctx);
  requireVerifiedEmail(session);
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

/**
 * An API key with `permission` when the request carries one, otherwise a signed-in session
 * (with a verified email when `verifiedSession` is set). `missing` is the 401 message for neither.
 */
async function resolveKeyOrSession(
  ctx: HandlerContext,
  options: {
    permission: ApiKeyAction;
    db: "read" | "write";
    verifiedSession: boolean;
    missing: string;
  },
): Promise<{ apiKey: VerifiedApiKey } | { session: AuthenticatedSession }> {
  if (extractApiKeyFromHeaders(ctx.requestHeader) !== null) {
    return { apiKey: await requireApiKeyAuth(ctx, options) };
  }
  const session = await getAuthenticatedSession(getRuntime(ctx).getAuth(), ctx.requestHeader);
  if (!session) {
    throw createDomainConnectError({ status: 401, code: "UNAUTHORIZED", message: options.missing });
  }
  if (options.verifiedSession) {
    requireVerifiedEmail(session);
  }
  return { session };
}

export async function resolveSubmitterAuth(
  ctx: HandlerContext,
): Promise<{ userId: string; keyId: string | null }> {
  const auth = await resolveKeyOrSession(ctx, {
    permission: "submit",
    db: "write",
    verifiedSession: true,
    missing: "Authentication or API key with submit permission is required",
  });
  return "apiKey" in auth
    ? { userId: auth.apiKey.userId, keyId: auth.apiKey.keyId }
    : { userId: auth.session.user.id, keyId: null };
}

export async function resolveChangeRequestReaderAuth(ctx: HandlerContext): Promise<void> {
  await resolveKeyOrSession(ctx, {
    permission: "read",
    db: "write",
    verifiedSession: false,
    missing: "Authentication or API key is required",
  });
}

export async function resolveInvalidationReporterAuth(
  ctx: HandlerContext,
): Promise<InvalidationReporterInput> {
  const auth = await resolveKeyOrSession(ctx, {
    permission: "report",
    db: "write",
    verifiedSession: true,
    missing: "Authentication or API key with report permission is required",
  });
  return "apiKey" in auth
    ? {
        reporterType: "api_key",
        reporterKeyId: auth.apiKey.keyId,
        reporterUserId: auth.apiKey.userId,
      }
    : { reporterType: "user", reporterUserId: auth.session.user.id };
}

export async function resolveAssociationHistoryReaderAuth(
  ctx: HandlerContext,
): Promise<{ useReadDb: boolean }> {
  const auth = await resolveKeyOrSession(ctx, {
    permission: "read",
    db: "read",
    verifiedSession: false,
    missing: "Authentication or read API key is required",
  });
  return { useReadDb: "apiKey" in auth };
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

  if (error instanceof InvalidationError || error instanceof CommentError) {
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
