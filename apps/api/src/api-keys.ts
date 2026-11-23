import type { Db } from "@media-ref/db";
import type { Hono, MiddlewareHandler } from "hono";
import { requireAuthenticatedSession, requireVerifiedUser, type ApiEnv } from "./auth.ts";

export const DEFAULT_API_KEY_PREFIX = "mref_";
export const DEFAULT_API_KEY_CONFIG_ID = "default";
export const API_KEY_START_LENGTH = 11;
export const MAX_API_KEY_NAME_LENGTH = 64;
export const MAX_API_KEY_EXPIRES_IN_SECONDS = 365 * 86_400;

export type ApiKeyAction = "read" | "report" | "submit";
export type ApiKeyScope = "read_report" | "submit";

export type ApiKeyPermissions = {
  media: ApiKeyAction[];
};

export interface ApiKeySummary {
  id: string;
  name: string | null;
  prefix: string | null;
  start: string | null;
  enabled: boolean;
  permissions: ApiKeyPermissions;
  canSubmit: boolean;
  createdAt: string;
  expiresAt: string | null;
}

export interface CreatedApiKeyResponse extends ApiKeySummary {
  key: string;
}

export interface VerifiedApiKey {
  keyId: string;
  userId: string;
  name: string | null;
  prefix: string | null;
  start: string | null;
  permissions: ApiKeyPermissions;
  canSubmit: boolean;
  emailVerified: boolean;
  role: string;
  expiresAt: Date | null;
}

const VALID_ACTIONS = new Set<ApiKeyAction>(["read", "report", "submit"]);
const VALID_SCOPES = new Set<ApiKeyScope>(["read_report", "submit"]);

export function buildApiKeyPermissions(canSubmit: boolean): ApiKeyPermissions {
  return canSubmit ? { media: ["read", "report", "submit"] } : { media: ["read", "report"] };
}

export function parseApiKeyPermissions(raw: unknown): ApiKeyPermissions {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { media: [] };
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { media: [] };
  }

  const media = (parsed as Record<string, unknown>).media;
  if (!Array.isArray(media)) {
    return { media: [] };
  }

  const actions: ApiKeyAction[] = [];
  for (const item of media) {
    if (
      typeof item === "string" &&
      VALID_ACTIONS.has(item as ApiKeyAction) &&
      !actions.includes(item as ApiKeyAction)
    ) {
      actions.push(item as ApiKeyAction);
    }
  }

  return { media: actions };
}

function toIsoDate(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toApiKeySummary(record: {
  id: string;
  name?: string | null;
  prefix?: string | null;
  start?: string | null;
  enabled?: boolean | null;
  permissions?: unknown;
  createdAt: Date | string;
  expiresAt?: Date | string | null;
}): ApiKeySummary {
  const permissions = parseApiKeyPermissions(record.permissions);
  const createdAt = toIsoDate(record.createdAt) ?? new Date().toISOString();

  return {
    id: record.id,
    name: record.name ?? null,
    prefix: record.prefix ?? null,
    start: record.start ?? null,
    enabled: record.enabled !== false,
    permissions,
    canSubmit: permissions.media.includes("submit"),
    createdAt,
    expiresAt: toIsoDate(record.expiresAt),
  };
}

interface ParsedCreateApiKeyRequest {
  name?: string;
  canSubmit: boolean;
  expiresIn?: number;
}

type ParseCreateResult =
  | { ok: true; value: ParsedCreateApiKeyRequest }
  | { ok: false; code: string; message: string };

function parseCreateApiKeyRequest(body: unknown): ParseCreateResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      ok: false,
      code: "INVALID_REQUEST",
      message: "Request body must be a JSON object",
    };
  }

  const record = body as Record<string, unknown>;

  if (record.permissions !== undefined) {
    return {
      ok: false,
      code: "INVALID_PERMISSIONS",
      message: "Specify permissions using canSubmit or scopes instead of raw permissions",
    };
  }

  let name: string | undefined;
  if (record.name !== undefined && record.name !== null) {
    if (typeof record.name !== "string") {
      return {
        ok: false,
        code: "INVALID_NAME",
        message: "API key name must be a string",
      };
    }
    const trimmed = record.name.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_API_KEY_NAME_LENGTH) {
      return {
        ok: false,
        code: "INVALID_NAME",
        message: `API key name must be between 1 and ${MAX_API_KEY_NAME_LENGTH} characters`,
      };
    }
    name = trimmed;
  }

  let canSubmitFromFlag: boolean | undefined;
  if (record.canSubmit !== undefined) {
    if (typeof record.canSubmit !== "boolean") {
      return {
        ok: false,
        code: "INVALID_PERMISSIONS",
        message: "canSubmit must be a boolean",
      };
    }
    canSubmitFromFlag = record.canSubmit;
  }

  let canSubmitFromScopes: boolean | undefined;
  if (record.scopes !== undefined) {
    if (!Array.isArray(record.scopes) || record.scopes.length === 0) {
      return {
        ok: false,
        code: "INVALID_PERMISSIONS",
        message: "scopes must be a non-empty array of valid scopes",
      };
    }
    for (const scope of record.scopes) {
      if (typeof scope !== "string" || !VALID_SCOPES.has(scope as ApiKeyScope)) {
        return {
          ok: false,
          code: "INVALID_PERMISSIONS",
          message: `Unsupported scope: ${String(scope)}`,
        };
      }
    }
    canSubmitFromScopes = record.scopes.includes("submit");
  }

  if (
    canSubmitFromFlag !== undefined &&
    canSubmitFromScopes !== undefined &&
    canSubmitFromFlag !== canSubmitFromScopes
  ) {
    return {
      ok: false,
      code: "INVALID_PERMISSIONS",
      message: "canSubmit and scopes disagree on submit permission",
    };
  }

  const canSubmit = canSubmitFromFlag ?? canSubmitFromScopes ?? false;

  let expiresIn: number | undefined;
  if (record.expiresIn !== undefined && record.expiresIn !== null) {
    if (
      typeof record.expiresIn !== "number" ||
      !Number.isInteger(record.expiresIn) ||
      record.expiresIn < 1 ||
      record.expiresIn > MAX_API_KEY_EXPIRES_IN_SECONDS
    ) {
      return {
        ok: false,
        code: "INVALID_EXPIRES_IN",
        message: `expiresIn must be an integer between 1 and ${MAX_API_KEY_EXPIRES_IN_SECONDS} seconds`,
      };
    }
    expiresIn = record.expiresIn;
  }

  return {
    ok: true,
    value: {
      name,
      canSubmit,
      expiresIn,
    },
  };
}

function isKeyNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as {
    statusCode?: number;
    status?: string | number;
    body?: { code?: string };
  };
  return (
    candidate.statusCode === 404 ||
    candidate.status === 404 ||
    candidate.status === "NOT_FOUND" ||
    candidate.body?.code === "KEY_NOT_FOUND"
  );
}

export interface VerifyApiKeyInput {
  db: Db;
  rawKey: string;
  requiredPermission?: ApiKeyAction;
  now?: Date;
}

export type VerifyApiKeyFailureCode =
  | "API_KEY_REQUIRED"
  | "INVALID_API_KEY"
  | "API_KEY_DISABLED"
  | "API_KEY_EXPIRED"
  | "EMAIL_NOT_VERIFIED"
  | "INSUFFICIENT_PERMISSIONS";

export type VerifyApiKeyResult =
  | { ok: true; apiKey: VerifiedApiKey }
  | { ok: false; status: 401 | 403; code: VerifyApiKeyFailureCode; message: string };

export interface RequireApiKeyOptions {
  db: "read" | "write";
  permission: ApiKeyAction;
}

/**
 * Computes SHA-256(UTF-8(rawKey)) encoded as RFC 4648 base64url without `=` padding,
 * matching `@better-auth/api-key@1.7.27`'s `defaultKeyHasher`.
 */
export async function hashApiKey(rawKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawKey));
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function extractApiKeyFromHeaders(headers: Headers): string | null {
  const xApiKey = headers.get("x-api-key")?.trim();
  if (xApiKey && xApiKey.length > 0) {
    return xApiKey;
  }

  const authorization = headers.get("authorization")?.trim();
  if (authorization) {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    const token = match?.[1]?.trim();
    if (token && token.length > 0) {
      return token;
    }
  }

  return null;
}

/**
 * Custom zero-write API key verification directly against Better Auth's `"apikey"` table.
 * Performs a single read-only SELECT and never writes usage counters or timestamps.
 */
export async function verifyApiKey(input: VerifyApiKeyInput): Promise<VerifyApiKeyResult> {
  const rawKey = input.rawKey.trim();
  if (rawKey.length === 0) {
    return {
      ok: false,
      status: 401,
      code: "API_KEY_REQUIRED",
      message: "API key is required",
    };
  }

  const hashedKey = await hashApiKey(rawKey);
  const now = input.now ?? new Date();

  const row = await input.db
    .selectFrom("apikey")
    .innerJoin("user", "user.id", "apikey.referenceId")
    .select([
      "apikey.id",
      "apikey.referenceId",
      "apikey.name",
      "apikey.prefix",
      "apikey.start",
      "apikey.enabled",
      "apikey.expiresAt",
      "apikey.permissions",
      "user.emailVerified",
      "user.role",
    ])
    .where("apikey.key", "=", hashedKey)
    .where("apikey.configId", "=", DEFAULT_API_KEY_CONFIG_ID)
    .executeTakeFirst();

  if (!row) {
    return {
      ok: false,
      status: 401,
      code: "INVALID_API_KEY",
      message: "Invalid API key",
    };
  }

  if (row.enabled !== true) {
    return {
      ok: false,
      status: 401,
      code: "API_KEY_DISABLED",
      message: "API key is disabled",
    };
  }

  const expiresAt =
    row.expiresAt === null
      ? null
      : row.expiresAt instanceof Date
        ? row.expiresAt
        : new Date(row.expiresAt);

  if (expiresAt !== null && expiresAt.getTime() <= now.getTime()) {
    return {
      ok: false,
      status: 401,
      code: "API_KEY_EXPIRED",
      message: "API key has expired",
    };
  }

  const permissions = parseApiKeyPermissions(row.permissions);
  const canSubmit = permissions.media.includes("submit");
  const emailVerified = Boolean(row.emailVerified);
  const role = typeof row.role === "string" && row.role.length > 0 ? row.role : "user";

  if (input.requiredPermission === "submit" && !emailVerified) {
    return {
      ok: false,
      status: 403,
      code: "EMAIL_NOT_VERIFIED",
      message: "Email verification is required",
    };
  }

  if (input.requiredPermission && !permissions.media.includes(input.requiredPermission)) {
    return {
      ok: false,
      status: 403,
      code: "INSUFFICIENT_PERMISSIONS",
      message: "API key does not have required permission",
    };
  }

  return {
    ok: true,
    apiKey: {
      keyId: row.id,
      userId: row.referenceId,
      name: row.name,
      prefix: row.prefix,
      start: row.start,
      permissions,
      canSubmit,
      emailVerified,
      role,
      expiresAt,
    },
  };
}

export function requireApiKey(options: RequireApiKeyOptions): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const rawKey = extractApiKeyFromHeaders(c.req.raw.headers);
    if (!rawKey) {
      return c.json(
        {
          error: "API_KEY_REQUIRED",
          message: "API key is required",
        },
        401,
      );
    }

    const db = options.db === "read" ? c.get("dbRead") : c.get("dbWrite");
    const result = await verifyApiKey({
      db,
      rawKey,
      requiredPermission: options.permission,
      now: c.get("now")(),
    });

    if (!result.ok) {
      return c.json(
        {
          error: result.code,
          message: result.message,
        },
        result.status,
      );
    }

    c.set("apiKey", result.apiKey);
    await next();
  };
}

export function registerApiKeyRoutes(app: Hono<ApiEnv>): void {
  app.get("/v1/api-keys/me", requireApiKey({ db: "read", permission: "read" }), (c) => {
    const verified = c.get("apiKey");
    if (!verified) {
      return c.json({ error: "API_KEY_REQUIRED", message: "API key is required" }, 401);
    }

    return c.json(
      {
        keyId: verified.keyId,
        userId: verified.userId,
        name: verified.name,
        prefix: verified.prefix,
        start: verified.start,
        permissions: verified.permissions,
        canSubmit: verified.canSubmit,
        emailVerified: verified.emailVerified,
        role: verified.role,
        expiresAt: toIsoDate(verified.expiresAt),
      },
      200,
    );
  });

  app.post("/v1/api-keys", requireVerifiedUser, async (c) => {
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

    const parsed = parseCreateApiKeyRequest(rawBody);
    if (!parsed.ok) {
      return c.json({ error: parsed.code, message: parsed.message }, 400);
    }

    const permissions = buildApiKeyPermissions(parsed.value.canSubmit);

    // Server-side call WITHOUT `headers` so Better Auth permits server-only `permissions`.
    const created = await c.get("auth").api.createApiKey({
      body: {
        userId: session.user.id,
        name: parsed.value.name,
        permissions,
        expiresIn: parsed.value.expiresIn,
      },
    });

    const response: CreatedApiKeyResponse = {
      ...toApiKeySummary(created),
      key: created.key,
    };

    return c.json(response, 201);
  });

  app.get("/v1/api-keys", requireAuthenticatedSession, async (c) => {
    const listed = await c.get("auth").api.listApiKeys({
      headers: c.req.raw.headers,
    });

    const apiKeys = listed.apiKeys.map((item) => toApiKeySummary(item));
    return c.json(
      {
        apiKeys,
        total: listed.total,
      },
      200,
    );
  });

  app.delete("/v1/api-keys/:id", requireAuthenticatedSession, async (c) => {
    const keyId = c.req.param("id").trim();
    if (keyId.length === 0) {
      return c.json({ error: "INVALID_KEY_ID", message: "API key ID is required" }, 400);
    }

    try {
      await c.get("auth").api.deleteApiKey({
        body: { keyId },
        headers: c.req.raw.headers,
      });
    } catch (error) {
      if (isKeyNotFoundError(error)) {
        return c.json({ error: "API_KEY_NOT_FOUND", message: "API key not found" }, 404);
      }
      throw error;
    }

    return c.json({ success: true, id: keyId }, 200);
  });
}
