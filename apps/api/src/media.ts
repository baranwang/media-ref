import type { MediaDocument } from "@media-ref/client";
import {
  BatchMediaQueryError,
  MAX_BATCH_MEDIA_KEYS,
  queryMediaBatch,
  queryMediaByKey,
  type BatchMediaQueryResult,
  type MediaQueryItem,
} from "@media-ref/core";
import type { Hono } from "hono";
import { requireApiKey } from "./api-keys.ts";
import type { ApiEnv } from "./auth.ts";

export interface MediaReadResponse {
  key: string;
  document: MediaDocument;
  matchedAssociationId: string | null;
  items: MediaQueryItem[];
}

export interface BatchMediaReadResponse {
  results: BatchMediaQueryResult[];
}

function parseBooleanQueryParam(
  raw: string | undefined,
): { ok: true; value: boolean } | { ok: false } {
  if (raw === undefined || raw === "") {
    return { ok: true, value: false };
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return { ok: true, value: true };
  }
  if (normalized === "false" || normalized === "0") {
    return { ok: true, value: false };
  }
  return { ok: false };
}

type ParseBatchRequestResult =
  | { ok: true; keys: string[]; includeUnconfirmed: boolean }
  | { ok: false; code: string; message: string };

function parseBatchMediaRequest(body: unknown): ParseBatchRequestResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      ok: false,
      code: "INVALID_REQUEST",
      message: "Request body must be a JSON object",
    };
  }

  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.keys)) {
    return {
      ok: false,
      code: "INVALID_REQUEST",
      message: "keys must be an array of strings",
    };
  }

  if (record.keys.length === 0 || record.keys.length > MAX_BATCH_MEDIA_KEYS) {
    return {
      ok: false,
      code: "BATCH_LIMIT_EXCEEDED",
      message: `keys must contain between 1 and ${MAX_BATCH_MEDIA_KEYS} items`,
    };
  }

  let includeUnconfirmed = false;
  if (record.includeUnconfirmed !== undefined) {
    if (typeof record.includeUnconfirmed !== "boolean") {
      return {
        ok: false,
        code: "INVALID_REQUEST",
        message: "includeUnconfirmed must be a boolean",
      };
    }
    includeUnconfirmed = record.includeUnconfirmed;
  }

  return {
    ok: true,
    keys: record.keys as string[],
    includeUnconfirmed,
  };
}

export function registerMediaRoutes(app: Hono<ApiEnv>): void {
  app.post("/v1/media/batch", requireApiKey({ db: "read", permission: "read" }), async (c) => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: "INVALID_JSON", message: "Request body must be valid JSON" }, 400);
    }

    const parsed = parseBatchMediaRequest(rawBody);
    if (!parsed.ok) {
      return c.json({ error: parsed.code, message: parsed.message }, 400);
    }

    try {
      const results = await queryMediaBatch(c.get("dbRead"), {
        keys: parsed.keys,
        includeUnconfirmed: parsed.includeUnconfirmed,
      });

      const response: BatchMediaReadResponse = { results };
      return c.json(response, 200);
    } catch (error) {
      if (error instanceof BatchMediaQueryError) {
        return c.json({ error: error.code, message: error.message }, error.status as 400);
      }
      throw error;
    }
  });

  app.get("/v1/media/:key", requireApiKey({ db: "read", permission: "read" }), async (c) => {
    const includeUnconfirmedParsed = parseBooleanQueryParam(c.req.query("includeUnconfirmed"));
    if (!includeUnconfirmedParsed.ok) {
      return c.json(
        {
          error: "INVALID_QUERY",
          message: "includeUnconfirmed must be a boolean (true, false, 1, or 0)",
        },
        400,
      );
    }

    const rawKey = c.req.param("key").trim();
    const result = await queryMediaByKey(c.get("dbRead"), rawKey, {
      includeUnconfirmed: includeUnconfirmedParsed.value,
    });

    if (result.kind === "invalid_key") {
      return c.json({ error: "INVALID_KEY", message: result.message }, 400);
    }

    if (result.kind === "not_found") {
      return c.json({ error: "MEDIA_NOT_FOUND", message: "Media not found" }, 404);
    }

    const primary = result.items[0]!;
    const response: MediaReadResponse = {
      key: result.key,
      document: primary.document,
      matchedAssociationId: primary.matchedAssociationId,
      items: result.items,
    };

    return c.json(response, 200);
  });
}
