import { LeadValidationError, recordLead, type Lead } from "@media-ref/core";
import type { Hono } from "hono";
import { requireApiKey } from "./api-keys.ts";
import type { ApiEnv } from "./auth.ts";

export interface LeadResponse {
  id: string;
  targetExternalKey: string;
  namespace: Lead["namespace"];
  nativeId: string;
  season: number | null;
  variantDescription: string | null;
  notes: string | null;
  createdAt: string;
}

export interface CreateLeadResponse {
  lead: LeadResponse;
}

interface ParsedCreateLeadRequest {
  targetExternalKey: string;
  namespace: string;
  nativeId: string;
  season?: number | null;
  variantDescription?: string | null;
  notes?: string | null;
}

type ParseCreateLeadResult =
  | { ok: true; value: ParsedCreateLeadRequest }
  | { ok: false; code: string; message: string };

function parseCreateLeadRequest(body: unknown): ParseCreateLeadResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      ok: false,
      code: "INVALID_REQUEST",
      message: "Request body must be a JSON object",
    };
  }

  const record = body as Record<string, unknown>;

  if (typeof record.targetExternalKey !== "string") {
    return {
      ok: false,
      code: "INVALID_EXTERNAL_KEY",
      message: "targetExternalKey must be a valid external key in '<namespace>:<nativeId>' format",
    };
  }

  if (typeof record.namespace !== "string") {
    return {
      ok: false,
      code: "INVALID_NAMESPACE",
      message: "namespace must be a valid platform or catalog namespace",
    };
  }

  if (typeof record.nativeId !== "string") {
    return {
      ok: false,
      code: "INVALID_NATIVE_ID",
      message: "nativeId must be a non-empty string",
    };
  }

  let season: number | null | undefined;
  if (record.season !== undefined && record.season !== null) {
    if (typeof record.season !== "number") {
      return {
        ok: false,
        code: "INVALID_SEASON",
        message: "season must be a non-negative integer",
      };
    }
    season = record.season;
  } else {
    season = record.season;
  }

  let variantDescription: string | null | undefined;
  if (record.variantDescription !== undefined && record.variantDescription !== null) {
    if (typeof record.variantDescription !== "string") {
      return {
        ok: false,
        code: "INVALID_VARIANT_DESCRIPTION",
        message: "variantDescription must be a string",
      };
    }
    variantDescription = record.variantDescription;
  } else {
    variantDescription = record.variantDescription;
  }

  let notes: string | null | undefined;
  if (record.notes !== undefined && record.notes !== null) {
    if (typeof record.notes !== "string") {
      return {
        ok: false,
        code: "INVALID_NOTES",
        message: "notes must be a string",
      };
    }
    notes = record.notes;
  } else {
    notes = record.notes;
  }

  return {
    ok: true,
    value: {
      targetExternalKey: record.targetExternalKey,
      namespace: record.namespace,
      nativeId: record.nativeId,
      season,
      variantDescription,
      notes,
    },
  };
}

function toLeadResponse(lead: Lead): LeadResponse {
  return {
    id: lead.id,
    targetExternalKey: lead.targetExternalKey,
    namespace: lead.namespace,
    nativeId: lead.nativeId,
    season: lead.season,
    variantDescription: lead.variantDescription,
    notes: lead.notes,
    createdAt: lead.createdAt.toISOString(),
  };
}

export function registerLeadRoutes(app: Hono<ApiEnv>): void {
  app.post("/v1/leads", requireApiKey({ db: "write", permission: "report" }), async (c) => {
    const verified = c.get("apiKey");
    if (!verified) {
      return c.json({ error: "API_KEY_REQUIRED", message: "API key is required" }, 401);
    }

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: "INVALID_JSON", message: "Request body must be valid JSON" }, 400);
    }

    const parsed = parseCreateLeadRequest(rawBody);
    if (!parsed.ok) {
      return c.json({ error: parsed.code, message: parsed.message }, 400);
    }

    try {
      const lead = await recordLead(c.get("dbWrite"), {
        ...parsed.value,
        reporterUserId: verified.userId,
        reporterKeyId: verified.keyId,
      });

      const response: CreateLeadResponse = {
        lead: toLeadResponse(lead),
      };

      return c.json(response, 201);
    } catch (error) {
      if (error instanceof LeadValidationError) {
        return c.json({ error: error.code, message: error.message }, 400);
      }
      throw error;
    }
  });
}
