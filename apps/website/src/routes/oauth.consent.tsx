import { Alert, AlertDescription, AlertTitle } from "@media-ref/ui/components/alert";
import { Button } from "@media-ref/ui/components/button";
import {
  RiCheckLine,
  RiErrorWarningLine,
  RiKey2Line,
  RiPlugLine,
  RiShieldCheckLine,
} from "@remixicon/react";
import { createFileRoute } from "@tanstack/react-router";
import { AuthLayout } from "#/components/auth-layout";
import { getApiBaseUrl } from "#/lib/api-client";
import { useAppStore } from "#/lib/app-store";

/**
 * The MCP OAuth consent page. The API checks the request, then sends the user here with
 * `consent`, a payload it signed; this page only reads it for display, and the API verifies
 * the signature again when the form posts back. Errors arrive as a fixed code, never as text.
 */

type Scope = "read" | "report" | "submit";

const SCOPE_LABELS: Record<Scope, string> = {
  read: "查询媒体、关联和变更单",
  report: "上报失效的关联",
  submit: "提交变更单",
};

const ERRORS = {
  unknown_client: {
    title: "无法识别这个应用",
    description: "应用的 client_id 无效，或者取不到它的元数据文档。",
  },
  redirect_mismatch: {
    title: "跳转地址不匹配",
    description: "应用要求跳回的地址不在它登记的地址里。",
  },
  invalid_request: {
    title: "授权请求不完整",
    description:
      "应用发来的授权请求缺了必要的参数（例如 PKCE S256）。回到应用重试，或者联系应用的开发者。",
  },
  email_not_verified: {
    title: "先验证邮箱",
    description:
      "授权 MCP 客户端和创建 API 密钥一样，需要先验证邮箱。打开注册时收到的验证邮件，然后回到客户端重新登录。",
  },
  expired: {
    title: "授权请求已失效",
    description: "回到 MCP 客户端，重新发起登录。",
  },
} as const;

type ErrorCode = keyof typeof ERRORS;

interface ConsentRequest {
  token: string;
  clientName: string;
  /** Host that published the client's metadata document; null for a dynamically registered one. */
  clientHost: string | null;
  redirectUri: string;
  scopes: Scope[];
}

interface ConsentSearch {
  consent?: string;
  error?: ErrorCode;
}

/** Reads the signed payload's body (base64url JSON) for display; the signature is the API's job. */
function readConsent(token: string): ConsentRequest | null {
  try {
    const body = token.split(".")[0] ?? "";
    const json = new TextDecoder().decode(
      Uint8Array.from(atob(body.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0)),
    );
    const payload = JSON.parse(json) as Record<string, unknown>;
    if (
      typeof payload.n !== "string" ||
      typeof payload.u !== "string" ||
      !Array.isArray(payload.sc)
    ) {
      return null;
    }
    return {
      token,
      clientName: payload.n,
      clientHost: typeof payload.h === "string" ? payload.h : null,
      redirectUri: payload.u,
      scopes: payload.sc.filter((scope): scope is Scope => scope in SCOPE_LABELS),
    };
  } catch {
    return null;
  }
}

function describeRedirect(uri: string): { origin: string; loopback: boolean } {
  try {
    const url = new URL(uri);
    return {
      origin: `${url.protocol}//${url.host}`,
      loopback:
        url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname),
    };
  } catch {
    return { origin: uri, loopback: false };
  }
}

export const Route = createFileRoute("/oauth/consent")({
  validateSearch: (search: Record<string, unknown>): ConsentSearch => ({
    consent: typeof search.consent === "string" ? search.consent : undefined,
    error:
      typeof search.error === "string" && search.error in ERRORS
        ? (search.error as ErrorCode)
        : undefined,
  }),
  // Never inside another site's frame: the allow button must not be clickjacked.
  headers: () => ({
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "frame-ancestors 'none'",
    "Cache-Control": "no-store",
  }),
  head: () => ({ meta: [{ title: "授权 MCP 客户端 · MediaRef" }] }),
  component: ConsentPage,
});

function ConsentPage() {
  const search = Route.useSearch();
  const request = search.consent ? readConsent(search.consent) : null;
  const apiBaseUrl = getApiBaseUrl();
  const error: ErrorCode | null = search.error ?? (!request || !apiBaseUrl ? "expired" : null);

  return (
    <AuthLayout
      showcaseTitle="让 AI agent 直接查 MediaRef"
      showcaseDescription="授权后，MCP 客户端用你的账号调用公开接口：查询、上报失效，按需提交变更单。权限和限额跟你的 API 密钥一样。"
      showcaseFacts={[
        { icon: <RiPlugLine />, label: "MCP 一键接入" },
        { icon: <RiKey2Line />, label: "授权即一把 API 密钥" },
        { icon: <RiShieldCheckLine />, label: "删除密钥即撤销" },
      ]}
    >
      {error || !request || !apiBaseUrl ? (
        <ConsentError code={error ?? "expired"} />
      ) : (
        <ConsentForm request={request} action={`${apiBaseUrl}/oauth/authorize`} />
      )}
    </AuthLayout>
  );
}

function ConsentError({ code }: { code: ErrorCode }) {
  const { title, description } = ERRORS[code];
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-1.5 text-center">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">授权没有完成</h1>
        <p className="text-sm text-muted-foreground">MCP 客户端还没有拿到你的授权</p>
      </div>
      <Alert variant="destructive" className="px-3 py-2.5">
        <RiErrorWarningLine className="size-4" />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{description}</AlertDescription>
      </Alert>
    </div>
  );
}

function ConsentForm({ request, action }: { request: ConsentRequest; action: string }) {
  const { user } = useAppStore();
  const redirect = describeRedirect(request.redirectUri);

  return (
    // A plain form post: the API checks the signed payload against the session cookie.
    <form method="post" action={action} className="flex flex-col gap-6">
      <input type="hidden" name="consent" value={request.token} />

      <div className="flex flex-col items-center gap-4 text-center">
        <div className="flex size-11 items-center justify-center rounded-xl border border-border bg-card text-foreground">
          <RiShieldCheckLine className="size-5" />
        </div>
        <div className="flex flex-col gap-1.5">
          <h1 className="text-2xl font-bold tracking-tight break-words text-foreground">
            授权 {request.clientName}
          </h1>
          <p className="text-sm text-muted-foreground">
            {user ? (
              <>
                它将以 <span className="font-medium break-all text-foreground">{user.email}</span>{" "}
                的身份使用 MediaRef
              </>
            ) : (
              "它将以你的身份使用 MediaRef"
            )}
          </p>
        </div>
      </div>

      <dl className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 text-sm">
        <div className="flex flex-col gap-1">
          <dt className="text-xs text-muted-foreground">应用</dt>
          <dd className="font-medium break-words text-foreground">{request.clientName}</dd>
          <dd className="text-xs text-muted-foreground">
            {request.clientHost ? `元数据由 ${request.clientHost} 发布` : "动态注册，名称未经验证"}
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs text-muted-foreground">授权后跳转到</dt>
          <dd className="font-mono text-xs break-all text-foreground">{redirect.origin}</dd>
        </div>
        <div className="flex flex-col gap-1.5">
          <dt className="text-xs text-muted-foreground">权限</dt>
          {request.scopes.map((scope) => (
            <dd key={scope} className="flex items-center gap-2 text-foreground">
              <RiCheckLine className="size-4 shrink-0 text-muted-foreground" />
              {SCOPE_LABELS[scope]}
            </dd>
          ))}
        </div>
      </dl>

      {redirect.loopback && (
        <Alert className="px-3 py-2.5">
          <RiErrorWarningLine className="size-4" />
          <AlertTitle>跳回的是你本机上的地址</AlertTitle>
          <AlertDescription>
            只有你刚在这台电脑的 MCP 客户端里发起登录时，才点允许。
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-2.5">
        <Button type="submit" name="decision" value="approve" size="lg" className="w-full">
          允许
        </Button>
        <Button
          type="submit"
          name="decision"
          value="deny"
          variant="outline"
          size="lg"
          className="w-full"
        >
          拒绝
        </Button>
      </div>

      <p className="text-center text-xs leading-5 text-muted-foreground">
        允许后，你的 API 密钥列表里会多出一把「MCP: {request.clientName}」，90
        天后过期。删除这把密钥就撤销了授权。
      </p>
    </form>
  );
}
