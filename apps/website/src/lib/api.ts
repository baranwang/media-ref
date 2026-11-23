export const DEFAULT_DEV_API_BASE_URL = "http://localhost:8787";
export const DEFAULT_PROD_API_BASE_URL = "https://api.mediaref.org";
export const MAX_API_KEY_NAME_LENGTH = 64;
export const MAX_API_KEY_EXPIRES_IN_SECONDS = 365 * 86_400;

export type ApiKeyAction = "read" | "report" | "submit";
export type OAuthProvider = "github" | "trakt";

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  role: string;
}

export interface ApiKeyPermissions {
  media: ApiKeyAction[];
}

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

export interface CreatedApiKey extends ApiKeySummary {
  key: string;
}

export interface ApiKeyListResponse {
  apiKeys: ApiKeySummary[];
  total: number;
}

export interface AuthSessionResponse {
  token: string | null;
  user: CurrentUser;
  redirect?: boolean;
  url?: string;
}

export interface OAuthSignInResponse {
  url: string;
  redirect?: boolean;
}

export interface CreateApiKeyInput {
  name?: string;
  canSubmit: boolean;
  expiresIn?: number;
}

export interface SignUpWithEmailInput {
  name: string;
  email: string;
  password: string;
  callbackURL?: string;
}

export interface SignInWithEmailInput {
  email: string;
  password: string;
  rememberMe?: boolean;
}

export interface StartOAuthSignInOptions {
  callbackURL?: string;
  errorCallbackURL?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

function readServerEnv(name: string): string | undefined {
  const maybeProcess = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  return maybeProcess?.env?.[name];
}

export function getApiBaseUrl(): string {
  const configured = readServerEnv("API_BASE_URL") ?? import.meta.env.VITE_API_BASE_URL;
  if (configured && configured.trim().length > 0) {
    return configured.trim().replace(/\/+$/, "");
  }
  return import.meta.env.DEV ? DEFAULT_DEV_API_BASE_URL : DEFAULT_PROD_API_BASE_URL;
}

interface RawErrorBody {
  error?: unknown;
  code?: unknown;
  message?: unknown;
}

async function parseErrorResponse(response: Response): Promise<ApiError> {
  let code = `HTTP_${response.status}`;
  let message = response.statusText || "请求失败";

  try {
    const raw = (await response.json()) as RawErrorBody;
    if (typeof raw.error === "string" && raw.error.length > 0) {
      code = raw.error;
    } else if (typeof raw.code === "string" && raw.code.length > 0) {
      code = raw.code;
    }
    if (typeof raw.message === "string" && raw.message.length > 0) {
      message = raw.message;
    }
  } catch {
    // Response was not JSON; keep HTTP status fallback.
  }

  return new ApiError(response.status, code, message);
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  cookieHeader?: string;
  signal?: AbortSignal;
}

async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers();
  headers.set("accept", "application/json");

  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  if (options.cookieHeader) {
    headers.set("cookie", options.cookieHeader);
  }

  let response: Response;
  try {
    response = await fetch(`${getApiBaseUrl()}${path}`, {
      method: options.method ?? "GET",
      headers,
      credentials: "include",
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });
  } catch {
    throw new ApiError(0, "NETWORK_ERROR", "无法连接到接口服务，请检查网络或稍后重试");
  }

  if (!response.ok) {
    throw await parseErrorResponse(response);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  if (!text) {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}

export function formatApiError(error: unknown, fallback = "操作失败，请稍后重试"): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "NETWORK_ERROR":
        return error.message;
      case "UNAUTHORIZED":
        return "登录状态已失效，请重新登录";
      case "EMAIL_NOT_VERIFIED":
        return "请先完成邮箱验证后再执行此操作";
      case "INVALID_EMAIL_OR_PASSWORD":
        return "邮箱或密码不正确";
      case "USER_ALREADY_EXISTS":
      case "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL":
        return "该邮箱已被注册，请直接登录或更换邮箱";
      case "INVALID_EMAIL":
        return "请输入有效的邮箱地址";
      case "PASSWORD_TOO_SHORT":
        return "密码长度不足（至少 8 位）";
      case "PASSWORD_TOO_LONG":
        return "密码长度超出限制";
      case "INVALID_NAME":
        return `密钥名称长度须在 1 到 ${MAX_API_KEY_NAME_LENGTH} 个字符之间`;
      case "INVALID_EXPIRES_IN":
        return "密钥有效期超出允许范围（最长 365 天）";
      case "INVALID_PERMISSIONS":
        return "所选密钥权限无效";
      case "API_KEY_NOT_FOUND":
        return "未找到该密钥，可能已被吊销";
      case "PROVIDER_NOT_FOUND":
        return "该第三方登录方式暂未在服务端启用";
      case "TOO_MANY_REQUESTS":
        return "请求过于频繁，请稍后再试";
      default:
        if (error.status === 404 && error.message.toLowerCase().includes("provider")) {
          return "该第三方登录方式暂未在服务端启用";
        }
        return error.message || fallback;
    }
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
}

export async function getCurrentUser(cookieHeader?: string): Promise<CurrentUser | null> {
  if (cookieHeader !== undefined && cookieHeader.trim().length === 0) {
    return null;
  }

  try {
    return await apiRequest<CurrentUser>("/v1/me", {
      method: "GET",
      cookieHeader,
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return null;
    }
    throw error;
  }
}

export async function signUpWithEmail(input: SignUpWithEmailInput): Promise<AuthSessionResponse> {
  return apiRequest<AuthSessionResponse>("/api/auth/sign-up/email", {
    method: "POST",
    body: {
      name: input.name.trim(),
      email: input.email.trim(),
      password: input.password,
      ...(input.callbackURL ? { callbackURL: input.callbackURL } : {}),
    },
  });
}

export async function signInWithEmail(input: SignInWithEmailInput): Promise<AuthSessionResponse> {
  return apiRequest<AuthSessionResponse>("/api/auth/sign-in/email", {
    method: "POST",
    body: {
      email: input.email.trim(),
      password: input.password,
      ...(input.rememberMe !== undefined ? { rememberMe: input.rememberMe } : {}),
    },
  });
}

export async function signOut(): Promise<{ success: boolean }> {
  const result = await apiRequest<{ success?: boolean } | undefined>("/api/auth/sign-out", {
    method: "POST",
    body: {},
  });
  return { success: result?.success ?? true };
}

export async function resendVerificationEmail(
  email: string,
  callbackURL?: string,
): Promise<{ status: boolean }> {
  const result = await apiRequest<{ status?: boolean } | undefined>(
    "/api/auth/send-verification-email",
    {
      method: "POST",
      body: {
        email: email.trim(),
        ...(callbackURL ? { callbackURL } : {}),
      },
    },
  );
  return { status: result?.status ?? true };
}

/**
 * Initiates an OAuth sign-in flow against Better Auth on `api.mediaref.org`.
 * Both GitHub (built-in social provider) and Trakt (genericOAuth plugin, Ticket #22)
 * accept `POST /api/auth/sign-in/social`, with an automatic fallback to
 * `POST /api/auth/sign-in/oauth2` for Trakt if only the generic endpoint is exposed.
 */
export async function startOAuthSignIn(
  provider: OAuthProvider,
  options: StartOAuthSignInOptions = {},
): Promise<OAuthSignInResponse> {
  const payload = {
    provider,
    ...(options.callbackURL ? { callbackURL: options.callbackURL } : {}),
    ...(options.errorCallbackURL ? { errorCallbackURL: options.errorCallbackURL } : {}),
  };

  try {
    const result = await apiRequest<OAuthSignInResponse>("/api/auth/sign-in/social", {
      method: "POST",
      body: payload,
    });
    if (!result?.url) {
      throw new ApiError(500, "OAUTH_URL_MISSING", "服务端未返回第三方授权地址");
    }
    return result;
  } catch (error) {
    if (provider === "trakt" && error instanceof ApiError && error.status === 404) {
      try {
        const fallback = await apiRequest<OAuthSignInResponse>("/api/auth/sign-in/oauth2", {
          method: "POST",
          body: {
            providerId: provider,
            ...(options.callbackURL ? { callbackURL: options.callbackURL } : {}),
            ...(options.errorCallbackURL ? { errorCallbackURL: options.errorCallbackURL } : {}),
          },
        });
        if (!fallback?.url) {
          throw new ApiError(500, "OAUTH_URL_MISSING", "服务端未返回第三方授权地址");
        }
        return fallback;
      } catch (fallbackError) {
        if (fallbackError instanceof ApiError && fallbackError.status === 404) {
          throw new ApiError(404, "PROVIDER_NOT_FOUND", "该第三方登录方式暂未在服务端启用");
        }
        throw fallbackError;
      }
    }
    if (error instanceof ApiError && error.status === 404) {
      throw new ApiError(404, "PROVIDER_NOT_FOUND", "该第三方登录方式暂未在服务端启用");
    }
    throw error;
  }
}

export async function listApiKeys(cookieHeader?: string): Promise<ApiKeyListResponse> {
  return apiRequest<ApiKeyListResponse>("/v1/api-keys", {
    method: "GET",
    cookieHeader,
  });
}

export async function createApiKey(input: CreateApiKeyInput): Promise<CreatedApiKey> {
  const trimmedName = input.name?.trim();
  return apiRequest<CreatedApiKey>("/v1/api-keys", {
    method: "POST",
    body: {
      ...(trimmedName ? { name: trimmedName } : {}),
      canSubmit: input.canSubmit,
      ...(input.expiresIn !== undefined ? { expiresIn: input.expiresIn } : {}),
    },
  });
}

export async function revokeApiKey(id: string): Promise<{ success: boolean; id: string }> {
  return apiRequest<{ success: boolean; id: string }>(
    `/v1/api-keys/${encodeURIComponent(id.trim())}`,
    {
      method: "DELETE",
    },
  );
}
