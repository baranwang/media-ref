import type { SegmentInput } from "@media-ref/client";
import {
  createChangeRequest,
  getChangeRequestById,
  isUuid,
  MediaServiceError,
  SubmissionQuotaExceededError,
} from "@media-ref/core";
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { extractApiKeyFromHeaders, verifyApiKey } from "./api-keys.ts";
import { getAuthenticatedSession, type ApiEnv } from "./auth.ts";

interface SubmitterIdentity {
  userId: string;
  keyId: string | null;
}

type ResolveSubmitterResult =
  | { ok: true; submitter: SubmitterIdentity }
  | { ok: false; status: 401 | 403; error: string; message: string };

async function resolveSubmitter(c: Context<ApiEnv>): Promise<ResolveSubmitterResult> {
  const rawApiKey = extractApiKeyFromHeaders(c.req.raw.headers);
  if (rawApiKey !== null) {
    const verified = await verifyApiKey({
      db: c.get("dbWrite"),
      rawKey: rawApiKey,
      requiredPermission: "submit",
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
      submitter: {
        userId: verified.apiKey.userId,
        keyId: verified.apiKey.keyId,
      },
    };
  }

  const session = await getAuthenticatedSession(c.get("auth"), c.req.raw.headers);
  if (!session) {
    return {
      ok: false,
      status: 401,
      error: "UNAUTHORIZED",
      message: "Authentication or API key with submit permission is required",
    };
  }

  c.set("session", session);

  if (!session.user.emailVerified) {
    return {
      ok: false,
      status: 403,
      error: "EMAIL_NOT_VERIFIED",
      message: "Email verification is required",
    };
  }

  return {
    ok: true,
    submitter: {
      userId: session.user.id,
      keyId: null,
    },
  };
}

type ResolveReaderResult =
  | { ok: true }
  | { ok: false; status: 401 | 403; error: string; message: string };

async function resolveChangeRequestReader(c: Context<ApiEnv>): Promise<ResolveReaderResult> {
  const rawApiKey = extractApiKeyFromHeaders(c.req.raw.headers);
  if (rawApiKey !== null) {
    const verified = await verifyApiKey({
      db: c.get("dbWrite"),
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
    return { ok: true };
  }

  const session = await getAuthenticatedSession(c.get("auth"), c.req.raw.headers);
  if (!session) {
    return {
      ok: false,
      status: 401,
      error: "UNAUTHORIZED",
      message: "Authentication or API key is required",
    };
  }

  c.set("session", session);
  return { ok: true };
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

export function registerChangeRequestRoutes(app: Hono<ApiEnv>): void {
  app.post("/v1/change-requests", async (c) => {
    const authResult = await resolveSubmitter(c);
    if (!authResult.ok) {
      return c.json({ error: authResult.error, message: authResult.message }, authResult.status);
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

    const body = rawBody as Record<string, unknown>;
    const targetExternalKey =
      typeof body.targetExternalKey === "string"
        ? body.targetExternalKey
        : typeof body.mediaId === "string"
          ? body.mediaId
          : "";

    if (typeof body.namespace !== "string" || typeof body.nativeId !== "string") {
      return c.json(
        {
          error: "INVALID_REQUEST",
          message: "targetExternalKey, namespace, and nativeId are required strings",
        },
        400,
      );
    }

    const variantId =
      body.variantId === undefined || body.variantId === null
        ? null
        : typeof body.variantId === "string"
          ? body.variantId
          : null;

    if (
      body.variantId !== undefined &&
      body.variantId !== null &&
      typeof body.variantId !== "string"
    ) {
      return c.json({ error: "INVALID_VARIANT", message: "variantId must be a string" }, 400);
    }

    const rawVariantDescription =
      body.variantDescription !== undefined ? body.variantDescription : body.variantLabel;
    if (
      rawVariantDescription !== undefined &&
      rawVariantDescription !== null &&
      typeof rawVariantDescription !== "string"
    ) {
      return c.json(
        { error: "INVALID_VARIANT", message: "variantDescription must be a string" },
        400,
      );
    }

    if (body.setDefaultVariant !== undefined && typeof body.setDefaultVariant !== "boolean") {
      return c.json(
        { error: "INVALID_REQUEST", message: "setDefaultVariant must be a boolean" },
        400,
      );
    }

    if (body.segments !== undefined && !Array.isArray(body.segments)) {
      return c.json({ error: "INVALID_SEGMENTS", message: "segments must be an array" }, 400);
    }

    if (body.rawNativeId !== undefined && typeof body.rawNativeId !== "string") {
      return c.json({ error: "INVALID_NATIVE_ID", message: "rawNativeId must be a string" }, 400);
    }

    if (body.taskId !== undefined && body.taskId !== null && typeof body.taskId !== "string") {
      return c.json({ error: "INVALID_TASK_ID", message: "taskId must be a string" }, 400);
    }

    if (
      body.replacesAssociationId !== undefined &&
      body.replacesAssociationId !== null &&
      typeof body.replacesAssociationId !== "string"
    ) {
      return c.json(
        {
          error: "INVALID_REPLACES_ASSOCIATION",
          message: "replacesAssociationId must be a string",
        },
        400,
      );
    }

    try {
      const changeRequest = await createChangeRequest(
        c.get("dbWrite"),
        {
          submitterUserId: authResult.submitter.userId,
          submitterKeyId: authResult.submitter.keyId,
          submitterType: "human",
          taskId: typeof body.taskId === "string" ? body.taskId : null,
          targetExternalKey,
          namespace: body.namespace,
          nativeId: body.nativeId,
          rawNativeId: typeof body.rawNativeId === "string" ? body.rawNativeId : undefined,
          variantId,
          variantDescription:
            typeof rawVariantDescription === "string" ? rawVariantDescription : null,
          setDefaultVariant: Boolean(body.setDefaultVariant),
          replacesAssociationId:
            typeof body.replacesAssociationId === "string" ? body.replacesAssociationId : null,
          segments: (body.segments as SegmentInput[] | undefined) ?? [],
          submissionQuota: c.get("submissionQuota"),
          now: c.get("hasCustomClock") ? c.get("now")() : undefined,
        },
        {
          adapterRegistry: c.get("adapterRegistry"),
          outbound: c.get("outbound"),
          now: c.get("hasCustomClock") ? c.get("now")() : undefined,
        },
      );

      return c.json({ changeRequest }, 201);
    } catch (error) {
      if (error instanceof SubmissionQuotaExceededError) {
        c.header("Retry-After", String(error.retryAfterSeconds));
        return c.json(
          {
            error: error.code,
            scope: error.scope,
            limit: error.limit,
            used: error.used,
            windowSeconds: error.windowSeconds,
            retryAfterSeconds: error.retryAfterSeconds,
            message: error.message,
          },
          429,
        );
      }
      if (error instanceof MediaServiceError) {
        return handleMediaServiceError(c, error);
      }
      throw error;
    }
  });

  app.get("/v1/change-requests/:id", async (c) => {
    const authResult = await resolveChangeRequestReader(c);
    if (!authResult.ok) {
      return c.json({ error: authResult.error, message: authResult.message }, authResult.status);
    }

    const id = c.req.param("id").trim();
    if (!isUuid(id)) {
      return c.json(
        { error: "INVALID_CHANGE_REQUEST_ID", message: "Change request ID must be a valid UUID" },
        400,
      );
    }

    const changeRequest = await getChangeRequestById(c.get("dbWrite"), id);
    if (!changeRequest) {
      return c.json(
        { error: "CHANGE_REQUEST_NOT_FOUND", message: "Change request not found" },
        404,
      );
    }

    return c.json({ changeRequest }, 200);
  });
}
