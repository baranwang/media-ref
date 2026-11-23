import { isBaselineSource, type BaselineSource } from "@media-ref/client";
import {
  listNeedsReviewSegments,
  listReviewAlerts,
  MediaSyncError,
  mergeMedia,
  resolveReviewAlert,
  switchMediaBaseline,
} from "@media-ref/core";
import type { ReviewAlertStatusRow } from "@media-ref/db";
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ApiEnv } from "./auth.ts";
import { requireReviewer } from "./reviewer.ts";

const VALID_ALERT_STATUSES = new Set<ReviewAlertStatusRow>(["open", "resolved"]);

function handleMediaSyncError(c: Context<ApiEnv>, error: MediaSyncError) {
  return c.json(
    {
      error: error.code,
      message: error.message,
    },
    error.status as ContentfulStatusCode,
  );
}

function parsePagination(
  c: Context<ApiEnv>,
): { ok: true; limit: number; offset: number } | { ok: false; message: string } {
  const rawLimit = c.req.query("limit");
  const rawOffset = c.req.query("offset");
  const limit = rawLimit !== undefined ? Number(rawLimit) : 50;
  const offset = rawOffset !== undefined ? Number(rawOffset) : 0;

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return { ok: false, message: "limit must be an integer between 1 and 100" };
  }
  if (!Number.isInteger(offset) || offset < 0) {
    return { ok: false, message: "offset must be an integer >= 0" };
  }

  return { ok: true, limit, offset };
}

export function registerMediaAdminRoutes(app: Hono<ApiEnv>): void {
  app.post("/v1/reviewer/media/merge", requireReviewer, async (c) => {
    const session = c.get("session");
    if (!session) {
      return c.json({ error: "UNAUTHORIZED", message: "Authentication required" }, 401);
    }

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: "INVALID_JSON", message: "Request body must be valid JSON" }, 400);
    }

    if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
      return c.json(
        { error: "INVALID_REQUEST", message: "Request body must be a JSON object" },
        400,
      );
    }

    const record = rawBody as Record<string, unknown>;
    if (typeof record.sourceMediaId !== "string" || typeof record.targetMediaId !== "string") {
      return c.json(
        {
          error: "INVALID_REQUEST",
          message: "sourceMediaId and targetMediaId are required strings",
        },
        400,
      );
    }

    if (
      record.reason !== undefined &&
      record.reason !== null &&
      typeof record.reason !== "string"
    ) {
      return c.json({ error: "INVALID_REASON", message: "reason must be a string" }, 400);
    }

    try {
      const result = await mergeMedia(c.get("dbWrite"), {
        sourceMediaId: record.sourceMediaId.trim(),
        targetMediaId: record.targetMediaId.trim(),
        actorUserId: session.user.id,
        reason: typeof record.reason === "string" ? record.reason : null,
        now: c.get("now")(),
      });
      return c.json(result, 200);
    } catch (error) {
      if (error instanceof MediaSyncError) {
        return handleMediaSyncError(c, error);
      }
      throw error;
    }
  });

  app.post("/v1/reviewer/media/:id/baseline", requireReviewer, async (c) => {
    const session = c.get("session");
    if (!session) {
      return c.json({ error: "UNAUTHORIZED", message: "Authentication required" }, 401);
    }

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: "INVALID_JSON", message: "Request body must be valid JSON" }, 400);
    }

    if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
      return c.json(
        { error: "INVALID_REQUEST", message: "Request body must be a JSON object" },
        400,
      );
    }

    const record = rawBody as Record<string, unknown>;
    const rawBaseline = record.baseline;
    if (
      rawBaseline !== null &&
      (typeof rawBaseline !== "string" || !isBaselineSource(rawBaseline))
    ) {
      return c.json(
        {
          error: "INVALID_BASELINE",
          message: "baseline must be null or one of: tmdb, tvdb, imdb, bangumi, douban",
        },
        400,
      );
    }

    if (
      record.reason !== undefined &&
      record.reason !== null &&
      typeof record.reason !== "string"
    ) {
      return c.json({ error: "INVALID_REASON", message: "reason must be a string" }, 400);
    }

    try {
      const result = await switchMediaBaseline(c.get("dbWrite"), {
        mediaId: c.req.param("id").trim(),
        newBaseline: rawBaseline as BaselineSource | null,
        actorUserId: session.user.id,
        reason: typeof record.reason === "string" ? record.reason : null,
        now: c.get("now")(),
      });
      return c.json(result, 200);
    } catch (error) {
      if (error instanceof MediaSyncError) {
        return handleMediaSyncError(c, error);
      }
      throw error;
    }
  });

  app.get("/v1/reviewer/alerts", requireReviewer, async (c) => {
    const rawStatus = c.req.query("status")?.trim();
    if (rawStatus && !VALID_ALERT_STATUSES.has(rawStatus as ReviewAlertStatusRow)) {
      return c.json(
        { error: "INVALID_STATUS", message: `Unsupported alert status: ${rawStatus}` },
        400,
      );
    }
    const status: ReviewAlertStatusRow = (rawStatus as ReviewAlertStatusRow | undefined) ?? "open";
    const alertType = c.req.query("alertType")?.trim() || undefined;
    const mediaId = c.req.query("mediaId")?.trim() || undefined;

    const pagination = parsePagination(c);
    if (!pagination.ok) {
      return c.json({ error: "INVALID_PAGINATION", message: pagination.message }, 400);
    }

    try {
      const result = await listReviewAlerts(c.get("dbWrite"), {
        status,
        alertType,
        mediaId,
        limit: pagination.limit,
        offset: pagination.offset,
      });
      return c.json(result, 200);
    } catch (error) {
      if (error instanceof MediaSyncError) {
        return handleMediaSyncError(c, error);
      }
      throw error;
    }
  });

  app.post("/v1/reviewer/alerts/:id/resolve", requireReviewer, async (c) => {
    const session = c.get("session");
    if (!session) {
      return c.json({ error: "UNAUTHORIZED", message: "Authentication required" }, 401);
    }

    try {
      const alert = await resolveReviewAlert(c.get("dbWrite"), {
        alertId: c.req.param("id").trim(),
        reviewerUserId: session.user.id,
        now: c.get("now")(),
      });
      return c.json({ alert }, 200);
    } catch (error) {
      if (error instanceof MediaSyncError) {
        return handleMediaSyncError(c, error);
      }
      throw error;
    }
  });

  app.get("/v1/reviewer/segments/needs-review", requireReviewer, async (c) => {
    const mediaId = c.req.query("mediaId")?.trim() || undefined;
    const pagination = parsePagination(c);
    if (!pagination.ok) {
      return c.json({ error: "INVALID_PAGINATION", message: pagination.message }, 400);
    }

    try {
      const result = await listNeedsReviewSegments(c.get("dbWrite"), {
        mediaId,
        limit: pagination.limit,
        offset: pagination.offset,
      });
      return c.json(result, 200);
    } catch (error) {
      if (error instanceof MediaSyncError) {
        return handleMediaSyncError(c, error);
      }
      throw error;
    }
  });
}
