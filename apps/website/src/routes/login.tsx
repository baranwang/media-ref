import { useEffect, useState, type FormEvent } from "react";
import { Link, createFileRoute, redirect, useNavigate, useRouter } from "@tanstack/react-router";
import { AlertTriangleIcon, GitHubIcon, TraktIcon } from "#/components/Icons";
import { formatApiError, signInWithEmail, startOAuthSignIn, type OAuthProvider } from "#/lib/api";
import { sanitizeRedirectPath } from "#/lib/auth";

interface LoginSearch {
  redirect?: string;
  error?: string;
}

function formatOAuthQueryError(rawError?: string): string | null {
  if (!rawError) {
    return null;
  }
  switch (rawError) {
    case "oauth_failed":
      return "第三方登录未能完成，请重试或改用邮箱密码登录。";
    case "access_denied":
      return "您已取消第三方授权。";
    case "account_not_linked":
      return "该邮箱已关联其他登录方式且未满足自动关联条件，请先使用原方式登录并验证邮箱。";
    default:
      return `登录遇到问题（${rawError}），请重试。`;
  }
}

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): LoginSearch => {
    const safeRedirect = sanitizeRedirectPath(search.redirect);
    const error =
      typeof search.error === "string" && search.error.trim().length > 0
        ? search.error.trim()
        : undefined;
    return {
      ...(safeRedirect ? { redirect: safeRedirect } : {}),
      ...(error ? { error } : {}),
    };
  },
  beforeLoad: ({ context, search }) => {
    if (context.user) {
      const target = search.redirect ?? "/keys";
      throw redirect(target.includes("?") ? { href: target } : { to: target });
    }
  },
  head: () => ({
    meta: [{ title: "登录 · media-ref" }],
  }),
  component: LoginPage,
});

function LoginPage() {
  const search = Route.useSearch();
  const router = useRouter();
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [oauthLoading, setOauthLoading] = useState<OAuthProvider | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(() =>
    formatOAuthQueryError(search.error),
  );

  const redirectTarget = search.redirect ?? "/keys";
  const busy = submitting || oauthLoading !== null;

  useEffect(() => {
    if (search.error) {
      setErrorMessage(formatOAuthQueryError(search.error));
    }
  }, [search.error]);

  async function handleEmailSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);

    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setErrorMessage("请填写邮箱和密码");
      return;
    }

    setSubmitting(true);
    try {
      await signInWithEmail({
        email: trimmedEmail,
        password,
      });
      await router.invalidate();
      await navigate(
        redirectTarget.includes("?")
          ? { href: redirectTarget, replace: true }
          : { to: redirectTarget, replace: true },
      );
    } catch (error) {
      setErrorMessage(formatApiError(error, "登录失败，请检查邮箱和密码"));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleOAuthSignIn(provider: OAuthProvider) {
    setErrorMessage(null);
    setOauthLoading(provider);
    try {
      const origin = window.location.origin;
      const result = await startOAuthSignIn(provider, {
        callbackURL: `${origin}${redirectTarget}`,
        errorCallbackURL: `${origin}/login?error=oauth_failed`,
      });
      window.location.assign(result.url);
    } catch (error) {
      setErrorMessage(formatApiError(error, `无法启动 ${provider} 登录，请稍后重试`));
      setOauthLoading(null);
    }
  }

  return (
    <main className="page-wrap flex min-h-[calc(100vh-11rem)] items-center justify-center px-4 py-10">
      <section className="island-shell rise-in w-full max-w-md rounded-3xl p-6 sm:p-8">
        <div className="mb-6 space-y-2">
          <p className="island-kicker m-0">账号登录</p>
          <h1 className="display-title m-0 text-3xl font-bold tracking-tight text-[var(--sea-ink)]">
            登录 media-ref
          </h1>
          <p className="m-0 text-sm text-[var(--sea-ink-soft)]">
            登录后可管理接口密钥、提交关联并查看变更单状态。
          </p>
        </div>

        {errorMessage ? (
          <div
            role="alert"
            className="mb-5 flex items-start gap-2.5 rounded-xl border border-[var(--danger-border)] bg-[var(--danger-bg)] p-3.5 text-sm text-[var(--danger-ink)]"
          >
            <AlertTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{errorMessage}</span>
          </div>
        ) : null}

        <div className="grid gap-2.5">
          <button
            type="button"
            onClick={() => void handleOAuthSignIn("github")}
            disabled={busy}
            className="btn-secondary w-full justify-center py-2.5"
          >
            <GitHubIcon className="h-4 w-4" />
            <span>{oauthLoading === "github" ? "正在前往 GitHub..." : "使用 GitHub 登录"}</span>
          </button>

          <button
            type="button"
            onClick={() => void handleOAuthSignIn("trakt")}
            disabled={busy}
            className="btn-secondary w-full justify-center py-2.5"
          >
            <TraktIcon className="h-4 w-4" />
            <span>{oauthLoading === "trakt" ? "正在前往 Trakt..." : "使用 Trakt 登录"}</span>
          </button>
          <p className="m-0 text-center text-xs text-[var(--sea-ink-soft)]">
            GitHub 已验证主邮箱将自动通过验证；Trakt 登录后需查收验证邮件。
          </p>
        </div>

        <div className="my-6 flex items-center gap-3 text-xs text-[var(--sea-ink-soft)]">
          <span className="h-px flex-1 bg-[var(--line)]" />
          <span>或使用邮箱密码登录</span>
          <span className="h-px flex-1 bg-[var(--line)]" />
        </div>

        <form onSubmit={handleEmailSignIn} className="space-y-4">
          <div className="space-y-1.5">
            <label
              htmlFor="login-email"
              className="block text-sm font-semibold text-[var(--sea-ink)]"
            >
              邮箱
            </label>
            <input
              id="login-email"
              name="email"
              type="email"
              required
              autoComplete="email"
              placeholder="developer@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={busy}
              className="field-input"
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="login-password"
              className="block text-sm font-semibold text-[var(--sea-ink)]"
            >
              密码
            </label>
            <input
              id="login-password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              placeholder="输入登录密码"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
              className="field-input"
            />
          </div>

          <button type="submit" disabled={busy} className="btn-primary w-full py-2.5">
            {submitting ? "登录中..." : "邮箱密码登录"}
          </button>
        </form>

        <p className="mt-6 mb-0 text-center text-sm text-[var(--sea-ink-soft)]">
          还没有账号？{" "}
          <Link
            to="/register"
            search={search.redirect ? { redirect: search.redirect } : {}}
            className="font-semibold"
          >
            立即注册
          </Link>
        </p>
      </section>
    </main>
  );
}
