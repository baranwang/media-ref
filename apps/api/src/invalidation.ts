import {
  DEFAULT_ANONYMOUS_INVALIDATION_THRESHOLD,
  InvalidationError,
  reportInvalidAssociation,
  type InvalidationReporterInput,
} from "@media-ref/core";
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { extractApiKeyFromHeaders, verifyApiKey } from "./api-keys.ts";
import { getAuthenticatedSession, type ApiEnv } from "./auth.ts";

export interface ReportInvalidationResponse {
  reportId: string;
  deduplicated: boolean;
  triggered: boolean;
  jobId: string | null;
  reportCount: number;
  threshold: number;
}

type ResolveReporterResult =
  | { ok: true; reporter: InvalidationReporterInput }
  | { ok: false; status: 401 | 403; error: string; message: string };

export function parseAnonymousInvalidationThresholdFromEnv(raw: string | undefined): number {
  if (!raw) {
    return DEFAULT_ANONYMOUS_INVALIDATION_THRESHOLD;
  }
  const trimmed = raw.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    return DEFAULT_ANONYMOUS_INVALIDATION_THRESHOLD;
  }
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= 1
    ? parsed
    : DEFAULT_ANONYMOUS_INVALIDATION_THRESHOLD;
}

async function resolveInvalidationReporter(c: Context<ApiEnv>): Promise<ResolveReporterResult> {
  const rawApiKey = extractApiKeyFromHeaders(c.req.raw.headers);
  if (rawApiKey !== null) {
    const verified = await verifyApiKey({
      db: c.get("dbWrite"),
      rawKey: rawApiKey,
      requiredPermission: "report",
      now: c.get("now")(),
    });
    if (!verified.ok) {
      return {
        ok: false,
        status: verified.status,
        error: verified.code,
        message: verified.message,
      };
    }
    c.set("apiKey", verified.apiKey);
    return {
      ok: true,
      reporter: {
        reporterType: "api_key",
        reporterKeyId: verified.apiKey.keyId,
        reporterUserId: verified.apiKey.userId,
      },
    };
  }

  const session = await getAuthenticatedSession(c.get("auth"), c.req.raw.headers);
  if (!session) {
    return {
      ok: false,
      status: 401,
      error: "UNAUTHORIZED",
      message: "Authentication or API key with report permission is required",
    };
  }

  c.set("session", session);
  return {
    ok: true,
    reporter: {
      reporterType: "user",
      reporterUserId: session.user.id,
    },
  };
}

async function parseOptionalReportBody(
  c: Context<ApiEnv>,
): Promise<{ ok: true; reason: string | null } | { ok: false; error: string; message: string }> {
  const rawText = await c.req.text();
  if (rawText.trim().length === 0) {
    return { ok: true, reason: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { ok: false, error: "INVALID_JSON", message: "Request body must be valid JSON" };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      error: "INVALID_REQUEST",
      message: "Request body must be a JSON object",
    };
  }

  const record = parsed as Record<string, unknown>;
  if (record.reason !== undefined && record.reason !== null && typeof record.reason !== "string") {
    return { ok: false, error: "INVALID_REASON", message: "reason must be a string" };
  }

  return {
    ok: true,
    reason: typeof record.reason === "string" ? record.reason : null,
  };
}

export function registerInvalidationRoutes(app: Hono<ApiEnv>): void {
  app.post("/v1/associations/:id/invalidation-reports", async (c) => {
    const authResult = await resolveInvalidationReporter(c);
    if (!authResult.ok) {
      return c.json({ error: authResult.error, message: authResult.message }, authResult.status);
    }

    const body = await parseOptionalReportBody(c);
    if (!body.ok) {
      return c.json({ error: body.error, message: body.message }, 400);
    }

    try {
      const result = await reportInvalidAssociation(c.get("dbWrite"), {
        ...authResult.reporter,
        associationId: c.req.param("id"),
        reason: body.reason,
        anonymousInvalidationThreshold: c.get("anonymousInvalidationThreshold"),
        now: c.get("hasCustomClock") ? c.get("now")() : undefined,
      });

      const response: ReportInvalidationResponse = {
        reportId: result.reportId,
        deduplicated: result.deduplicated,
        triggered: result.triggered,
        jobId: result.jobId,
        reportCount: result.reportCount,
        threshold: result.threshold,
      };

      return c.json(response, 202);
    } catch (error) {
      if (error instanceof InvalidationError) {
        return c.json(
          { error: error.code, message: error.message },
          error.status as ContentfulStatusCode,
        );
      }
      throw error;
    }
  });
}
