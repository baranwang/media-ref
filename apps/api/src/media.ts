import type { MediaDocument, NamespaceGroup } from "@media-ref/client";
import {
  BatchMediaQueryError,
  computeDemandTargetsForBatchRead,
  computeDemandTargetsForRead,
  DEFAULT_DEMAND_NAMESPACE_GROUP,
  MAX_BATCH_MEDIA_KEYS,
  queryMediaBatch,
  queryMediaByKey,
  recordDemandForRead,
  recordDemandsForBatchRead,
  type BatchMediaQueryResult,
  type MediaQueryItem,
} from "@media-ref/core";
import type { Context, Hono } from "hono";
import { requireApiKey } from "./api-keys.ts";
import type { ApiEnv } from "./auth.ts";
import { requireReadRateLimit } from "./rate-limit.ts";

const MAX_SEASON_NUMBER = 2_147_483_647;
const NON_NEGATIVE_INTEGER_PATTERN = /^\d+$/;

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

function parseSeasonQueryParam(
  raw: string | undefined,
): { ok: true; value: number | undefined } | { ok: false } {
  if (raw === undefined || raw === "") {
    return { ok: true, value: undefined };
  }
  const trimmed = raw.trim();
  if (!NON_NEGATIVE_INTEGER_PATTERN.test(trimmed)) {
    return { ok: false };
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_SEASON_NUMBER) {
    return { ok: false };
  }
  return { ok: true, value: parsed };
}

function parseNamespaceGroupQueryParam(
  raw: string | undefined,
): { ok: true; value: NamespaceGroup } | { ok: false } {
  if (raw === undefined || raw === "") {
    return { ok: true, value: DEFAULT_DEMAND_NAMESPACE_GROUP };
  }
  const normalized = raw.trim();
  if (normalized === "platform" || normalized === "catalog") {
    return { ok: true, value: normalized };
  }
  return { ok: false };
}

function scheduleBackgroundTask(c: Context<ApiEnv>, work: () => Promise<unknown>): void {
  const onError = c.get("onBackgroundTaskError");
  const promise = Promise.resolve()
    .then(work)
    .catch((error: unknown) => {
      onError?.(error);
    });

  const onBackgroundTask = c.get("onBackgroundTask");
  onBackgroundTask?.(promise);

  try {
    c.executionCtx.waitUntil(promise);
  } catch {
    // No ExecutionContext attached (e.g. direct app.fetch calls in tests).
  }
}

type ParseBatchRequestResult =
  | {
      ok: true;
      keys: string[];
      includeUnconfirmed: boolean;
      season: number | undefined;
      namespaceGroup: NamespaceGroup;
    }
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

  let season: number | undefined;
  if (record.season !== undefined && record.season !== null) {
    if (
      typeof record.season !== "number" ||
      !Number.isInteger(record.season) ||
      record.season < 0 ||
      record.season > MAX_SEASON_NUMBER
    ) {
      return {
        ok: false,
        code: "INVALID_REQUEST",
        message: "season must be a non-negative integer",
      };
    }
    season = record.season;
  }

  let namespaceGroup: NamespaceGroup = DEFAULT_DEMAND_NAMESPACE_GROUP;
  if (record.namespaceGroup !== undefined && record.namespaceGroup !== null) {
    if (record.namespaceGroup !== "platform" && record.namespaceGroup !== "catalog") {
      return {
        ok: false,
        code: "INVALID_REQUEST",
        message: "namespaceGroup must be either 'platform' or 'catalog'",
      };
    }
    namespaceGroup = record.namespaceGroup;
  }

  return {
    ok: true,
    keys: record.keys as string[],
    includeUnconfirmed,
    season,
    namespaceGroup,
  };
}

export function registerMediaRoutes(app: Hono<ApiEnv>): void {
  app.use("/v1/media/*", requireApiKey({ db: "read", permission: "read" }), requireReadRateLimit);

  app.post("/v1/media/batch", async (c) => {
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

      const batchDemandInput = {
        results,
        season: parsed.season,
        namespaceGroup: parsed.namespaceGroup,
      };
      if (computeDemandTargetsForBatchRead(batchDemandInput).length > 0) {
        const dbWrite = c.get("dbWrite");
        const now = c.get("now")();
        scheduleBackgroundTask(c, () =>
          recordDemandsForBatchRead(dbWrite, {
            ...batchDemandInput,
            now,
          }),
        );
      }

      const response: BatchMediaReadResponse = { results };
      return c.json(response, 200);
    } catch (error) {
      if (error instanceof BatchMediaQueryError) {
        return c.json({ error: error.code, message: error.message }, error.status as 400);
      }
      throw error;
    }
  });

  app.get("/v1/media/:key", async (c) => {
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
    const seasonParsed = parseSeasonQueryParam(c.req.query("season"));
    if (!seasonParsed.ok) {
      return c.json(
        {
          error: "INVALID_QUERY",
          message: "season must be a non-negative integer",
        },
        400,
      );
    }

    const namespaceGroupParsed = parseNamespaceGroupQueryParam(c.req.query("namespaceGroup"));
    if (!namespaceGroupParsed.ok) {
      return c.json(
        {
          error: "INVALID_QUERY",
          message: "namespaceGroup must be either 'platform' or 'catalog'",
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

    const demandInput = {
      rawKey,
      queryResult: result,
      season: seasonParsed.value,
      namespaceGroup: namespaceGroupParsed.value,
    };
    if (computeDemandTargetsForRead(demandInput).length > 0) {
      const dbWrite = c.get("dbWrite");
      const now = c.get("now")();
      scheduleBackgroundTask(c, () =>
        recordDemandForRead(dbWrite, {
          ...demandInput,
          now,
        }),
      );
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
