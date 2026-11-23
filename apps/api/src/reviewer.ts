import type { ChangeRequestStatus } from "@media-ref/client";
import {
  approveChangeRequest,
  listChangeRequests,
  MediaServiceError,
  rejectChangeRequest,
} from "@media-ref/core";
import type { Context, Hono, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { getAuthenticatedSession, type ApiEnv } from "./auth.ts";

const VALID_CHANGE_REQUEST_STATUSES = new Set<ChangeRequestStatus>([
  "pending_evidence",
  "approved",
  "needs_review",
  "rejected",
]);

const ASSIGNABLE_ROLES = new Set(["user", "reviewer"]);

export const requireReviewer: MiddlewareHandler<ApiEnv> = async (c, next) => {
  let session = c.get("session");
  if (!session) {
    session = await getAuthenticatedSession(c.get("auth"), c.req.raw.headers);
  }

  if (!session) {
    return c.json({ error: "UNAUTHORIZED", message: "Authentication required" }, 401);
  }

  c.set("session", session);

  if (session.user.role !== "reviewer" && session.user.role !== "owner") {
    return c.json({ error: "FORBIDDEN", message: "Reviewer role required" }, 403);
  }

  await next();
};

export const requireOwner: MiddlewareHandler<ApiEnv> = async (c, next) => {
  let session = c.get("session");
  if (!session) {
    session = await getAuthenticatedSession(c.get("auth"), c.req.raw.headers);
  }

  if (!session) {
    return c.json({ error: "UNAUTHORIZED", message: "Authentication required" }, 401);
  }

  c.set("session", session);

  if (session.user.role !== "owner") {
    return c.json({ error: "FORBIDDEN", message: "Owner role required" }, 403);
  }

  await next();
};

async function parseOptionalDecisionBody(
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

function handleMediaServiceError(c: Context<ApiEnv>, error: MediaServiceError) {
  return c.json(
    {
      error: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    },
    error.status as ContentfulStatusCode,
  );
}

export function registerReviewerRoutes(app: Hono<ApiEnv>): void {
  app.get("/v1/reviewer/change-requests", requireReviewer, async (c) => {
    const rawStatus = c.req.query("status")?.trim();
    const status: ChangeRequestStatus =
      rawStatus && VALID_CHANGE_REQUEST_STATUSES.has(rawStatus as ChangeRequestStatus)
        ? (rawStatus as ChangeRequestStatus)
        : "needs_review";

    if (rawStatus && !VALID_CHANGE_REQUEST_STATUSES.has(rawStatus as ChangeRequestStatus)) {
      return c.json(
        { error: "INVALID_STATUS", message: `Unsupported change request status: ${rawStatus}` },
        400,
      );
    }

    const rawLimit = c.req.query("limit");
    const rawOffset = c.req.query("offset");
    const limit = rawLimit !== undefined ? Number(rawLimit) : 50;
    const offset = rawOffset !== undefined ? Number(rawOffset) : 0;

    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return c.json(
        { error: "INVALID_PAGINATION", message: "limit must be an integer between 1 and 100" },
        400,
      );
    }
    if (!Number.isInteger(offset) || offset < 0) {
      return c.json(
        { error: "INVALID_PAGINATION", message: "offset must be an integer >= 0" },
        400,
      );
    }

    const listed = await listChangeRequests(c.get("dbWrite"), { status, limit, offset });
    return c.json(listed, 200);
  });

  app.post("/v1/reviewer/change-requests/:id/approve", requireReviewer, async (c) => {
    const session = c.get("session");
    if (!session) {
      return c.json({ error: "UNAUTHORIZED", message: "Authentication required" }, 401);
    }

    const body = await parseOptionalDecisionBody(c);
    if (!body.ok) {
      return c.json({ error: body.error, message: body.message }, 400);
    }

    try {
      const result = await approveChangeRequest(c.get("dbWrite"), c.get("outbound"), {
        changeRequestId: c.req.param("id").trim(),
        reviewerUserId: session.user.id,
        reason: body.reason,
        catalogConfig: c.get("catalogConfig"),
        tmdbConfig: c.get("tmdbConfig"),
        tmdbGateway: c.get("tmdbGateway"),
      });

      return c.json(result, 200);
    } catch (error) {
      if (error instanceof MediaServiceError) {
        return handleMediaServiceError(c, error);
      }
      throw error;
    }
  });

  app.post("/v1/reviewer/change-requests/:id/reject", requireReviewer, async (c) => {
    const session = c.get("session");
    if (!session) {
      return c.json({ error: "UNAUTHORIZED", message: "Authentication required" }, 401);
    }

    const body = await parseOptionalDecisionBody(c);
    if (!body.ok) {
      return c.json({ error: body.error, message: body.message }, 400);
    }

    try {
      const changeRequest = await rejectChangeRequest(c.get("dbWrite"), {
        changeRequestId: c.req.param("id").trim(),
        reviewerUserId: session.user.id,
        reason: body.reason,
      });

      return c.json({ changeRequest }, 200);
    } catch (error) {
      if (error instanceof MediaServiceError) {
        return handleMediaServiceError(c, error);
      }
      throw error;
    }
  });

  app.put("/v1/admin/users/:id/role", requireOwner, async (c) => {
    const targetUserId = c.req.param("id").trim();
    if (targetUserId.length === 0) {
      return c.json({ error: "INVALID_USER_ID", message: "User ID is required" }, 400);
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

    const role = (rawBody as Record<string, unknown>).role;
    if (typeof role !== "string" || !ASSIGNABLE_ROLES.has(role)) {
      return c.json(
        { error: "INVALID_ROLE", message: 'role must be either "user" or "reviewer"' },
        400,
      );
    }

    const updated = await c
      .get("dbWrite")
      .updateTable("user")
      .set({ role, updatedAt: c.get("now")() })
      .where("id", "=", targetUserId)
      .returning(["id", "email", "name", "role"])
      .executeTakeFirst();

    if (!updated) {
      return c.json({ error: "USER_NOT_FOUND", message: "User not found" }, 404);
    }

    return c.json({ user: updated }, 200);
  });
}
