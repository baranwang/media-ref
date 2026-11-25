import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import {
  AccountService,
  AssociationService,
  ChangeRequestService,
  MediaService,
  ReviewerService,
} from "@media-ref/client";

export type SocialOAuthProvider = "github" | "trakt";

export function getApiBaseUrl(): string | null {
  const configured = import.meta.env.VITE_API_BASE_URL as string | undefined;
  if (!configured || configured.trim().length === 0) {
    return null;
  }
  return configured.trim().replace(/\/+$/, "");
}

export function resolveOAuthErrorMessage(code: string): string {
  const normalized = code.trim().toLowerCase();
  if (normalized === "access_denied" || normalized === "user_cancelled") {
    return "你取消了第三方账号授权";
  }
  if (normalized.includes("account_not_linked") || normalized.includes("email")) {
    return "该邮箱已有账号但尚未完成关联，请先用原方式登录";
  }
  return "第三方账号登录未完成，请重试";
}

export async function requestSocialSignInUrl(
  provider: SocialOAuthProvider,
  options?: {
    callbackURL?: string;
    errorCallbackURL?: string;
  },
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const apiBase = getApiBaseUrl();
  if (!apiBase) {
    return { ok: false, error: "未配置 API 服务地址" };
  }

  const origin = typeof window !== "undefined" ? window.location.origin : "https://mediaref.org";
  const callbackURL = options?.callbackURL ?? `${origin}/`;
  const errorCallbackURL = options?.errorCallbackURL ?? `${origin}/login`;
  const providerLabel = provider === "github" ? "GitHub" : "Trakt";

  try {
    const res = await fetch(`${apiBase}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        provider,
        callbackURL,
        errorCallbackURL,
      }),
    });

    if (!res.ok) {
      return { ok: false, error: `${providerLabel} 登录暂时不可用，请稍后重试` };
    }

    const payload = (await res.json()) as { url?: unknown };
    if (typeof payload.url !== "string" || payload.url.trim().length === 0) {
      return { ok: false, error: `未能获取 ${providerLabel} 授权地址` };
    }

    return { ok: true, url: payload.url };
  } catch {
    return { ok: false, error: "无法连接认证服务，请稍后重试" };
  }
}

export function createBrowserClients() {
  const baseUrl = getApiBaseUrl();
  if (!baseUrl) {
    return null;
  }

  const transport = createConnectTransport({
    baseUrl,
    useBinaryFormat: false,
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        credentials: "include",
      }),
  });

  return {
    baseUrl,
    account: createClient(AccountService, transport),
    media: createClient(MediaService, transport),
    changeRequest: createClient(ChangeRequestService, transport),
    association: createClient(AssociationService, transport),
    reviewer: createClient(ReviewerService, transport),
  };
}
