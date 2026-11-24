import type { Hyperdrive, RateLimit } from "@cloudflare/workers-types";
import type { MediaDocument } from "@media-ref/client";
import { queryMediaByKey, type MediaQueryItem } from "@media-ref/core";
import { createDb, type Db } from "@media-ref/db";
import { WorkerEntrypoint } from "cloudflare:workers";

export const INTERNAL_MEDIA_PATH_PREFIX = "/internal/media";
export const CLIENT_IP_HEADER = "x-forwarded-client-ip";
export const DEFAULT_ANONYMOUS_IP_RATE_LIMIT = 60;
export const DEFAULT_ANONYMOUS_IP_RATE_WINDOW_SECONDS = 60;

export interface InternalMediaWorkerEnv {
  HYPERDRIVE_READ: Hyperdrive;
  RATE_LIMITER_ANONYMOUS_IP?: RateLimit;
  ANONYMOUS_IP_RATE_LIMIT?: string;
  ANONYMOUS_IP_RATE_WINDOW_SECONDS?: string;
}

export interface AnonymousIpRateLimitDecision {
  allowed: boolean;
  retryAfterSeconds?: number;
}

export interface AnonymousIpRateLimiter {
  check(clientIp: string, now?: Date): Promise<AnonymousIpRateLimitDecision>;
}

export interface InMemoryIpRateLimiterOptions {
  limit?: number;
  windowSeconds?: number;
  now?: () => Date;
}

export interface InternalMediaDeps {
  dbRead: Db;
  rateLimiter?: AnonymousIpRateLimiter;
  rateLimit?: {
    limit?: number;
    windowSeconds?: number;
  };
  now?: () => Date;
}

export interface InternalMediaApp {
  fetch(request: Request): Promise<Response>;
}

export type InternalMediaRpcResult =
  | {
      status: 200;
      document: MediaDocument;
      matchedAssociationId: string | null;
      items: MediaQueryItem[];
    }
  | {
      status: 400;
      error: "INVALID_KEY";
      message: string;
    }
  | {
      status: 404;
      error: "MEDIA_NOT_FOUND";
      message: string;
    }
  | {
      status: 429;
      error: "RATE_LIMITED";
      message: string;
      retryAfterSeconds: number;
    };

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeClientIp(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.toLowerCase();
}

export function extractClientIp(headers: Headers): string {
  const explicit = normalizeClientIp(headers.get(CLIENT_IP_HEADER));
  if (explicit) {
    return explicit;
  }

  const cfConnectingIp = normalizeClientIp(headers.get("cf-connecting-ip"));
  if (cfConnectingIp) {
    return cfConnectingIp;
  }

  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor) {
    const firstHop = normalizeClientIp(forwardedFor.split(",")[0]);
    if (firstHop) {
      return firstHop;
    }
  }

  return "unknown";
}

export function createInMemoryIpRateLimiter(
  options: InMemoryIpRateLimiterOptions = {},
): AnonymousIpRateLimiter {
  const limit =
    options.limit !== undefined && options.limit > 0
      ? Math.floor(options.limit)
      : DEFAULT_ANONYMOUS_IP_RATE_LIMIT;
  const windowSeconds =
    options.windowSeconds !== undefined && options.windowSeconds > 0
      ? Math.floor(options.windowSeconds)
      : DEFAULT_ANONYMOUS_IP_RATE_WINDOW_SECONDS;
  const windowMs = windowSeconds * 1000;
  const getNow = options.now ?? (() => new Date());

  const buckets = new Map<string, { count: number; resetAtMs: number }>();

  return {
    async check(clientIp: string, now?: Date): Promise<AnonymousIpRateLimitDecision> {
      const nowMs = (now ?? getNow()).getTime();
      const key = normalizeClientIp(clientIp) ?? "unknown";

      if (buckets.size > 1024) {
        for (const [bucketKey, bucket] of buckets) {
          if (nowMs >= bucket.resetAtMs) {
            buckets.delete(bucketKey);
          }
        }
      }

      const existing = buckets.get(key);
      if (!existing || nowMs >= existing.resetAtMs) {
        buckets.set(key, { count: 1, resetAtMs: nowMs + windowMs });
        return { allowed: true };
      }

      if (existing.count >= limit) {
        const remainingMs = Math.max(1, existing.resetAtMs - nowMs);
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)),
        };
      }

      existing.count += 1;
      return { allowed: true };
    },
  };
}

export function createCloudflareRateLimiterAdapter(
  binding: RateLimit,
  options: { retryAfterSeconds?: number } = {},
): AnonymousIpRateLimiter {
  const retryAfterSeconds =
    options.retryAfterSeconds !== undefined && options.retryAfterSeconds > 0
      ? Math.floor(options.retryAfterSeconds)
      : DEFAULT_ANONYMOUS_IP_RATE_WINDOW_SECONDS;

  return {
    async check(clientIp: string): Promise<AnonymousIpRateLimitDecision> {
      const normalized = normalizeClientIp(clientIp) ?? "unknown";
      const outcome = await binding.limit({ key: `anon-ip:${normalized}` });
      if (!outcome.success) {
        return { allowed: false, retryAfterSeconds };
      }
      return { allowed: true };
    },
  };
}

const fallbackLimitersByConfig = new Map<string, AnonymousIpRateLimiter>();

function resolveInternalRateLimiter(env: InternalMediaWorkerEnv): AnonymousIpRateLimiter {
  const windowSeconds = parsePositiveInt(
    env.ANONYMOUS_IP_RATE_WINDOW_SECONDS,
    DEFAULT_ANONYMOUS_IP_RATE_WINDOW_SECONDS,
  );

  if (env.RATE_LIMITER_ANONYMOUS_IP) {
    return createCloudflareRateLimiterAdapter(env.RATE_LIMITER_ANONYMOUS_IP, {
      retryAfterSeconds: windowSeconds,
    });
  }

  const limit = parsePositiveInt(env.ANONYMOUS_IP_RATE_LIMIT, DEFAULT_ANONYMOUS_IP_RATE_LIMIT);
  const configKey = `${limit}:${windowSeconds}`;
  let limiter = fallbackLimitersByConfig.get(configKey);
  if (!limiter) {
    limiter = createInMemoryIpRateLimiter({ limit, windowSeconds });
    fallbackLimitersByConfig.set(configKey, limiter);
  }
  return limiter;
}

export async function executeInternalMediaQuery(
  input: {
    dbRead: Db;
    rateLimiter: AnonymousIpRateLimiter;
    now?: Date;
  },
  rawKey: string,
  clientIp: string,
): Promise<InternalMediaRpcResult> {
  const decision = await input.rateLimiter.check(clientIp, input.now);
  if (!decision.allowed) {
    const retryAfterSeconds = Math.max(
      1,
      decision.retryAfterSeconds ?? DEFAULT_ANONYMOUS_IP_RATE_WINDOW_SECONDS,
    );
    return {
      status: 429,
      error: "RATE_LIMITED",
      message: "Too many requests from this IP. Please retry later.",
      retryAfterSeconds,
    };
  }

  const trimmedKey = rawKey.trim();
  const result = await queryMediaByKey(input.dbRead, trimmedKey, { includeUnconfirmed: false });

  if (result.kind === "invalid_key") {
    return {
      status: 400,
      error: "INVALID_KEY",
      message: result.message,
    };
  }

  if (result.kind === "not_found") {
    return {
      status: 404,
      error: "MEDIA_NOT_FOUND",
      message: "Media not found",
    };
  }

  const primary = result.items[0]!;
  return {
    status: 200,
    document: primary.document,
    matchedAssociationId: primary.matchedAssociationId,
    items: result.items,
  };
}

function internalResultToResponse(result: InternalMediaRpcResult): Response {
  if (result.status === 200) {
    return Response.json(
      {
        document: result.document,
        matchedAssociationId: result.matchedAssociationId,
        items: result.items,
      },
      { status: 200 },
    );
  }

  if (result.status === 429) {
    return Response.json(
      {
        error: result.error,
        message: result.message,
        retryAfter: result.retryAfterSeconds,
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(result.retryAfterSeconds),
          "Cache-Control": "no-store",
        },
      },
    );
  }

  return Response.json(
    {
      error: result.error,
      message: result.message,
    },
    { status: result.status },
  );
}

export function createInternalMediaApp(deps: InternalMediaDeps): InternalMediaApp {
  const getNow = deps.now ?? (() => new Date());
  const rateLimiter =
    deps.rateLimiter ??
    createInMemoryIpRateLimiter({
      limit: deps.rateLimit?.limit,
      windowSeconds: deps.rateLimit?.windowSeconds,
      now: getNow,
    });

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (request.method !== "GET") {
        return Response.json({ error: "NOT_FOUND", message: "Not found" }, { status: 404 });
      }

      const prefixWithSlash = `${INTERNAL_MEDIA_PATH_PREFIX}/`;
      if (!url.pathname.startsWith(prefixWithSlash)) {
        return Response.json({ error: "NOT_FOUND", message: "Not found" }, { status: 404 });
      }

      const encodedKey = url.pathname.slice(prefixWithSlash.length);
      if (encodedKey.length === 0 || encodedKey.includes("/")) {
        return Response.json({ error: "NOT_FOUND", message: "Not found" }, { status: 404 });
      }

      let decodedKey: string;
      try {
        decodedKey = decodeURIComponent(encodedKey);
      } catch {
        return Response.json(
          { error: "INVALID_KEY", message: "Invalid percent-encoding in key" },
          { status: 400 },
        );
      }

      const clientIp = extractClientIp(request.headers);
      const result = await executeInternalMediaQuery(
        {
          dbRead: deps.dbRead,
          rateLimiter,
          now: getNow(),
        },
        decodedKey,
        clientIp,
      );

      return internalResultToResponse(result);
    },
  };
}

export class InternalMediaEntrypoint extends WorkerEntrypoint<InternalMediaWorkerEnv> {
  async fetch(request: Request): Promise<Response> {
    const dbRead = createDb(this.env.HYPERDRIVE_READ.connectionString, { max: 5 });
    const app = createInternalMediaApp({
      dbRead,
      rateLimiter: resolveInternalRateLimiter(this.env),
    });

    try {
      return await app.fetch(request);
    } finally {
      this.ctx.waitUntil(dbRead.destroy());
    }
  }

  async getMedia(key: string, clientIp?: string): Promise<InternalMediaRpcResult> {
    const dbRead = createDb(this.env.HYPERDRIVE_READ.connectionString, { max: 5 });
    const rateLimiter = resolveInternalRateLimiter(this.env);
    const normalizedIp = normalizeClientIp(clientIp) ?? "unknown";

    try {
      return await executeInternalMediaQuery({ dbRead, rateLimiter }, key, normalizedIp);
    } finally {
      this.ctx.waitUntil(dbRead.destroy());
    }
  }
}
