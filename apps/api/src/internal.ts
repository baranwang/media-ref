import type { Hyperdrive, RateLimit } from "@cloudflare/workers-types";
import type { MediaDocument } from "@media-ref/client";
import { readMediaDocument } from "@media-ref/core";
import { createDb, type Db } from "@media-ref/db";
import { WorkerEntrypoint } from "cloudflare:workers";
import { Hono } from "hono";

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

export type InternalMediaRpcResult =
  | {
      status: 200;
      document: MediaDocument;
      matchedAssociationId: string | null;
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

export function createInternalMediaApp(deps: InternalMediaDeps): Hono {
  const app = new Hono();
  const getNow = deps.now ?? (() => new Date());
  const rateLimiter =
    deps.rateLimiter ??
    createInMemoryIpRateLimiter({
      limit: deps.rateLimit?.limit,
      windowSeconds: deps.rateLimit?.windowSeconds,
      now: getNow,
    });

  app.get(`${INTERNAL_MEDIA_PATH_PREFIX}/:key`, async (c) => {
    const clientIp = extractClientIp(c.req.raw.headers);
    const decision = await rateLimiter.check(clientIp, getNow());
    if (!decision.allowed) {
      const retryAfterSeconds = Math.max(
        1,
        decision.retryAfterSeconds ?? DEFAULT_ANONYMOUS_IP_RATE_WINDOW_SECONDS,
      );
      c.header("Retry-After", String(retryAfterSeconds));
      c.header("Cache-Control", "no-store");
      return c.json(
        {
          error: "RATE_LIMITED",
          message: "Too many requests from this IP. Please retry later.",
          retryAfter: retryAfterSeconds,
        },
        429,
      );
    }

    const rawKey = c.req.param("key").trim();
    const result = await readMediaDocument(deps.dbRead, rawKey);

    if (result.kind === "invalid_key") {
      return c.json({ error: "INVALID_KEY", message: result.message }, 400);
    }

    if (result.kind === "not_found") {
      return c.json({ error: "MEDIA_NOT_FOUND", message: "Media not found" }, 404);
    }

    return c.json(
      {
        document: result.document,
        matchedAssociationId: result.matchedAssociationId,
      },
      200,
    );
  });

  return app;
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
    const headers = new Headers({ accept: "application/json" });
    if (clientIp && clientIp.trim().length > 0) {
      headers.set(CLIENT_IP_HEADER, clientIp.trim());
    }

    const response = await this.fetch(
      new Request(
        `https://internal.mediaref.org${INTERNAL_MEDIA_PATH_PREFIX}/${encodeURIComponent(key)}`,
        {
          method: "GET",
          headers,
        },
      ),
    );

    if (response.status === 200) {
      const body = (await response.json()) as {
        document: MediaDocument;
        matchedAssociationId: string | null;
      };
      return {
        status: 200,
        document: body.document,
        matchedAssociationId: body.matchedAssociationId,
      };
    }

    if (response.status === 400) {
      const body = (await response.json()) as { message?: string };
      return {
        status: 400,
        error: "INVALID_KEY",
        message: body.message ?? "Invalid media key",
      };
    }

    if (response.status === 429) {
      const body = (await response.json()) as { message?: string; retryAfter?: number };
      const retryHeader = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
      const retryAfterSeconds =
        Number.isFinite(retryHeader) && retryHeader > 0
          ? retryHeader
          : (body.retryAfter ?? DEFAULT_ANONYMOUS_IP_RATE_WINDOW_SECONDS);
      return {
        status: 429,
        error: "RATE_LIMITED",
        message: body.message ?? "Too many requests from this IP. Please retry later.",
        retryAfterSeconds,
      };
    }

    const body = (await response.json().catch(() => ({}))) as { message?: string };
    return {
      status: 404,
      error: "MEDIA_NOT_FOUND",
      message: body.message ?? "Media not found",
    };
  }
}
