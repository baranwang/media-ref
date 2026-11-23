import {
  ConflictResolutionError,
  listAssociationRevisions,
  overrideMediaExternalId,
  setAssociationLock,
  setMediaExternalIdLock,
} from "@media-ref/core";
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { extractApiKeyFromHeaders, verifyApiKey } from "./api-keys.ts";
import { getAuthenticatedSession, type ApiEnv } from "./auth.ts";
import { requireReviewer } from "./reviewer.ts";

type ResolveReaderResult =
  | { ok: true; useReadDb: boolean }
  | { ok: false; status: 401 | 403; error: string; message: string };

async function resolveAssociationHistoryReader(c: Context<ApiEnv>): Promise<ResolveReaderResult> {
  const rawApiKey = extractApiKeyFromHeaders(c.req.raw.headers);
  if (rawApiKey !== null) {
    const verified = await verifyApiKey({
      db: c.get("dbRead"),
      rawKey: rawApiKey,
      requiredPermission: "read",
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
    return { ok: true, useReadDb: true };
  }

  const session = await getAuthenticatedSession(c.get("auth"), c.req.raw.headers);
  if (!session) {
    return {
      ok: false,
      status: 401,
      error: "UNAUTHORIZED",
      message: "Authentication or read API key is required",
    };
  }

  c.set("session", session);
  return { ok: true, useReadDb: false };
}

function handleConflictError(c: Context<ApiEnv>, error: ConflictResolutionError) {
  return c.json(
    {
      error: error.code,
      message: error.message,
    },
    error.status as ContentfulStatusCode,
  );
}

async function parseOptionalJsonObject(
  c: Context<ApiEnv>,
): Promise<
  { ok: true; body: Record<string, unknown> } | { ok: false; error: string; message: string }
> {
  const rawText = await c.req.text();
  if (rawText.trim().length === 0) {
    return { ok: true, body: {} };
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

  return { ok: true, body: parsed as Record<string, unknown> };
}

export function registerAssociationRoutes(app: Hono<ApiEnv>): void {
  app.get("/v1/associations/:id/revisions", async (c) => {
    const authResult = await resolveAssociationHistoryReader(c);
    if (!authResult.ok) {
      return c.json({ error: authResult.error, message: authResult.message }, authResult.status);
    }

    const rawOrder = c.req.query("order")?.trim();
    if (rawOrder && rawOrder !== "asc" && rawOrder !== "desc") {
      return c.json(
        { error: "INVALID_ORDER", message: 'order must be either "asc" or "desc"' },
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

    try {
      const db = authResult.useReadDb ? c.get("dbRead") : c.get("dbWrite");
      const result = await listAssociationRevisions(db, c.req.param("id").trim(), {
        order: rawOrder === "desc" ? "desc" : "asc",
        limit,
        offset,
      });
      return c.json(result, 200);
    } catch (error) {
      if (error instanceof ConflictResolutionError) {
        return handleConflictError(c, error);
      }
      throw error;
    }
  });

  app.post("/v1/reviewer/associations/:id/lock", requireReviewer, async (c) => {
    const parsed = await parseOptionalJsonObject(c);
    if (!parsed.ok) {
      return c.json({ error: parsed.error, message: parsed.message }, 400);
    }

    const rawLocked = parsed.body.locked;
    if (rawLocked !== undefined && typeof rawLocked !== "boolean") {
      return c.json({ error: "INVALID_REQUEST", message: "locked must be a boolean" }, 400);
    }

    try {
      const result = await setAssociationLock(c.get("dbWrite"), {
        associationId: c.req.param("id").trim(),
        locked: rawLocked ?? true,
        now: c.get("now")(),
      });
      return c.json(result, 200);
    } catch (error) {
      if (error instanceof ConflictResolutionError) {
        return handleConflictError(c, error);
      }
      throw error;
    }
  });

  app.put("/v1/reviewer/media/:mediaId/external-ids/:namespace", requireReviewer, async (c) => {
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

    const body = rawBody as Record<string, unknown>;
    if (typeof body.nativeId !== "string") {
      return c.json(
        { error: "INVALID_NATIVE_ID", message: "nativeId must be a non-empty string" },
        400,
      );
    }

    if (body.locked !== undefined && typeof body.locked !== "boolean") {
      return c.json({ error: "INVALID_REQUEST", message: "locked must be a boolean" }, 400);
    }

    try {
      const externalId = await overrideMediaExternalId(c.get("dbWrite"), {
        mediaId: c.req.param("mediaId").trim(),
        namespace: c.req.param("namespace").trim(),
        nativeId: body.nativeId,
        locked: body.locked ?? true,
        now: c.get("now")(),
      });
      return c.json({ externalId }, 200);
    } catch (error) {
      if (error instanceof ConflictResolutionError) {
        return handleConflictError(c, error);
      }
      throw error;
    }
  });

  app.post(
    "/v1/reviewer/media/:mediaId/external-ids/:namespace/lock",
    requireReviewer,
    async (c) => {
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

      const body = rawBody as Record<string, unknown>;
      if (typeof body.locked !== "boolean") {
        return c.json({ error: "INVALID_REQUEST", message: "locked must be a boolean" }, 400);
      }

      try {
        const externalId = await setMediaExternalIdLock(c.get("dbWrite"), {
          mediaId: c.req.param("mediaId").trim(),
          namespace: c.req.param("namespace").trim(),
          locked: body.locked,
          now: c.get("now")(),
        });
        return c.json({ externalId }, 200);
      } catch (error) {
        if (error instanceof ConflictResolutionError) {
          return handleConflictError(c, error);
        }
        throw error;
      }
    },
  );
}
