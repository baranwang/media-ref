import { create } from "@bufbuild/protobuf";
import { createDomainConnectError, proto, toProtoApiKeyAction } from "@media-ref/client";
import type { Db } from "@media-ref/db";
import type { ServiceImpl } from "@connectrpc/connect";
import {
  getRuntime,
  requireApiKeyAuth,
  requireSessionAuth,
  requireVerifiedUserAuth,
} from "./context.ts";
import { toProtoApiKeySummary } from "./proto-records.ts";

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

export const accountServiceImpl: ServiceImpl<typeof proto.AccountService> = {
  async getCurrentUser(_req, ctx) {
    const session = await requireSessionAuth(ctx);
    return create(proto.GetCurrentUserResponseSchema, {
      user: create(proto.UserSchema, {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        emailVerified: session.user.emailVerified,
        role: session.user.role,
      }),
    });
  },

  async getCurrentApiKey(_req, ctx) {
    const verified = await requireApiKeyAuth(ctx, { db: "read", permission: "read" });
    const expiresAt = toIsoDate(verified.expiresAt);
    return create(proto.GetCurrentApiKeyResponseSchema, {
      keyId: verified.keyId,
      userId: verified.userId,
      ...(verified.name !== null ? { name: verified.name } : {}),
      ...(verified.prefix !== null ? { prefix: verified.prefix } : {}),
      ...(verified.start !== null ? { start: verified.start } : {}),
      permissions: create(proto.ApiKeyPermissionsSchema, {
        media: verified.permissions.media.map(toProtoApiKeyAction),
      }),
      canSubmit: verified.canSubmit,
      emailVerified: verified.emailVerified,
      role: verified.role,
      ...(expiresAt !== null ? { expiresAt } : {}),
    });
  },

  async createApiKey(req, ctx) {
    const session = await requireVerifiedUserAuth(ctx);
    const runtime = getRuntime(ctx);

    let name: string | undefined;
    if (req.name !== undefined) {
      const trimmed = req.name.trim();
      if (trimmed.length === 0 || trimmed.length > MAX_API_KEY_NAME_LENGTH) {
        throw createDomainConnectError({
          status: 400,
          code: "INVALID_NAME",
          message: `API key name must be between 1 and ${MAX_API_KEY_NAME_LENGTH} characters`,
        });
      }
      name = trimmed;
    }

    let canSubmitFromScopes: boolean | undefined;
    if (req.scopes.length > 0) {
      for (const scope of req.scopes) {
        if (scope !== proto.ApiKeyScope.READ_REPORT && scope !== proto.ApiKeyScope.SUBMIT) {
          throw createDomainConnectError({
            status: 400,
            code: "INVALID_PERMISSIONS",
            message: `Unsupported scope: ${String(scope)}`,
          });
        }
      }
      canSubmitFromScopes = req.scopes.includes(proto.ApiKeyScope.SUBMIT);
    }

    if (
      req.canSubmit !== undefined &&
      canSubmitFromScopes !== undefined &&
      req.canSubmit !== canSubmitFromScopes
    ) {
      throw createDomainConnectError({
        status: 400,
        code: "INVALID_PERMISSIONS",
        message: "canSubmit and scopes disagree on submit permission",
      });
    }

    const canSubmit = req.canSubmit ?? canSubmitFromScopes ?? false;

    let expiresIn: number | undefined;
    if (req.expiresIn !== undefined) {
      if (
        !Number.isInteger(req.expiresIn) ||
        req.expiresIn < 1 ||
        req.expiresIn > MAX_API_KEY_EXPIRES_IN_SECONDS
      ) {
        throw createDomainConnectError({
          status: 400,
          code: "INVALID_EXPIRES_IN",
          message: `expiresIn must be an integer between 1 and ${MAX_API_KEY_EXPIRES_IN_SECONDS} seconds`,
        });
      }
      expiresIn = req.expiresIn;
    }

    const permissions = buildApiKeyPermissions(canSubmit);

    // Server-side call WITHOUT `headers` so Better Auth permits server-only `permissions`.
    const created = await runtime.getAuth().api.createApiKey({
      body: {
        userId: session.user.id,
        name,
        permissions,
        expiresIn,
      },
    });

    const summary = toApiKeySummary(created);
    return create(proto.CreateApiKeyResponseSchema, {
      apiKey: toProtoApiKeySummary(summary),
      key: created.key,
    });
  },

  async listApiKeys(_req, ctx) {
    await requireSessionAuth(ctx);
    const runtime = getRuntime(ctx);
    const listed = await runtime.getAuth().api.listApiKeys({
      headers: ctx.requestHeader,
    });

    const apiKeys = listed.apiKeys.map((item) => toProtoApiKeySummary(toApiKeySummary(item)));
    return create(proto.ListApiKeysResponseSchema, {
      apiKeys,
      total: listed.total,
    });
  },

  async deleteApiKey(req, ctx) {
    await requireSessionAuth(ctx);
    const runtime = getRuntime(ctx);
    const keyId = req.id.trim();
    if (keyId.length === 0) {
      throw createDomainConnectError({
        status: 400,
        code: "INVALID_KEY_ID",
        message: "API key ID is required",
      });
    }

    try {
      await runtime.getAuth().api.deleteApiKey({
        body: { keyId },
        headers: ctx.requestHeader,
      });
    } catch (error) {
      if (isKeyNotFoundError(error)) {
        throw createDomainConnectError({
          status: 404,
          code: "API_KEY_NOT_FOUND",
          message: "API key not found",
        });
      }
      throw error;
    }

    return create(proto.DeleteApiKeyResponseSchema, {
      success: true,
      id: keyId,
    });
  },
};
