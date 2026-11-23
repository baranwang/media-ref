import { useState, type FormEvent } from "react";
import { Link, createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { AlertTriangleIcon, CheckIcon, KeyIcon, MailIcon } from "#/components/Icons";
import {
  formatApiError,
  resendVerificationEmail,
  signUpWithEmail,
  type CurrentUser,
} from "#/lib/api";
import { sanitizeRedirectPath } from "#/lib/auth";

interface RegisterSearch {
  redirect?: string;
}

export const Route = createFileRoute("/register")({
  validateSearch: (search: Record<string, unknown>): RegisterSearch => {
    const safeRedirect = sanitizeRedirectPath(search.redirect);
    return safeRedirect ? { redirect: safeRedirect } : {};
  },
  beforeLoad: ({ context, search }) => {
    if (context.user?.emailVerified) {
      const target = search.redirect ?? "/keys";
      throw redirect(target.includes("?") ? { href: target } : { to: target });
    }
  },
  head: () => ({
    meta: [{ title: "注册 · media-ref" }],
  }),
  component: RegisterPage,
});

function RegisterPage() {
  const { user: existingUser } = Route.useRouteContext();
  const search = Route.useSearch();
  const router = useRouter();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [registeredUser, setRegisteredUser] = useState<CurrentUser | null>(null);

  const [resending, setResending] = useState(false);
  const [resendFeedback, setResendFeedback] = useState<string | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);

  const pendingVerificationUser =
    registeredUser ?? (existingUser && !existingUser.emailVerified ? existingUser : null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);

    const trimmedName = name.trim();
    const trimmedEmail = email.trim();

    if (!trimmedName) {
      setErrorMessage("请输入显示名称");
      return;
    }
    if (!trimmedEmail) {
      setErrorMessage("请输入邮箱地址");
      return;
    }
    if (password.length < 8) {
      setErrorMessage("密码至少需要 8 位字符");
      return;
    }
    if (password !== confirmPassword) {
      setErrorMessage("两次输入的密码不一致");
      return;
    }

    setSubmitting(true);
    try {
      const callbackURL = `${window.location.origin}${search.redirect ?? "/keys"}`;
      const result = await signUpWithEmail({
        name: trimmedName,
        email: trimmedEmail,
        password,
        callbackURL,
      });
      setRegisteredUser(result.user);
      void router.invalidate();
    } catch (error) {
      setErrorMessage(formatApiError(error, "注册失败，请检查输入信息后重试"));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResend(targetEmail: string) {
    setResending(true);
    setResendFeedback(null);
    setResendError(null);
    try {
      const callbackURL = `${window.location.origin}${search.redirect ?? "/keys"}`;
      await resendVerificationEmail(targetEmail, callbackURL);
      setResendFeedback(`验证邮件已重新发送至 ${targetEmail}，请查收邮箱。`);
    } catch (error) {
      setResendError(formatApiError(error, "重新发送验证邮件失败，请稍后重试"));
    } finally {
      setResending(false);
    }
  }

  if (pendingVerificationUser) {
    return (
      <main className="page-wrap flex min-h-[calc(100vh-11rem)] items-center justify-center px-4 py-10">
        <section className="island-shell rise-in w-full max-w-lg rounded-3xl p-6 sm:p-8">
          <div className="mb-4 inline-flex h-11 w-11 items-center justify-center rounded-2xl border border-[var(--ok-border)] bg-[var(--ok-bg)] text-[var(--ok-ink)]">
            <MailIcon className="h-5 w-5" />
          </div>

          <p className="island-kicker m-0 mb-1.5">{registeredUser ? "注册成功" : "待验证邮箱"}</p>
          <h1 className="display-title m-0 mb-3 text-3xl font-bold tracking-tight text-[var(--sea-ink)]">
            请查收验证邮件
          </h1>
          <p className="m-0 mb-4 text-sm leading-relaxed text-[var(--sea-ink)] sm:text-base">
            验证邮件已发送，请查收邮箱后即可创建密钥和提交关联。
          </p>

          <div className="mb-6 rounded-2xl border border-[var(--line)] bg-[var(--chip-bg)] p-4 text-sm text-[var(--sea-ink-soft)]">
            <p className="m-0">
              收件邮箱：
              <code className="font-semibold text-[var(--sea-ink)]">
                {pendingVerificationUser.email}
              </code>
            </p>
            <p className="mt-2 mb-0 text-xs leading-relaxed">
              点击邮件中的验证链接后，系统会自动更新您的验证状态。在完成验证前，您仍可先浏览控制台，但无法创建接口密钥或提交关联。
            </p>
          </div>

          {resendFeedback ? (
            <div className="mb-4 flex items-center gap-2 rounded-xl border border-[var(--ok-border)] bg-[var(--ok-bg)] px-3.5 py-2.5 text-xs font-semibold text-[var(--ok-ink)]">
              <CheckIcon className="h-4 w-4 shrink-0" />
              <span>{resendFeedback}</span>
            </div>
          ) : null}

          {resendError ? (
            <div
              role="alert"
              className="mb-4 flex items-center gap-2 rounded-xl border border-[var(--danger-border)] bg-[var(--danger-bg)] px-3.5 py-2.5 text-xs font-semibold text-[var(--danger-ink)]"
            >
              <AlertTriangleIcon className="h-4 w-4 shrink-0" />
              <span>{resendError}</span>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-3">
            <Link to="/keys" className="btn-primary">
              <KeyIcon className="h-4 w-4" />
              <span>前往密钥管理</span>
            </Link>
            <button
              type="button"
              onClick={() => void handleResend(pendingVerificationUser.email)}
              disabled={resending}
              className="btn-secondary"
            >
              <MailIcon className="h-4 w-4" />
              <span>{resending ? "发送中..." : "重新发送验证邮件"}</span>
            </button>
            <Link to="/" className="btn-secondary">
              进入工作台
            </Link>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="page-wrap flex min-h-[calc(100vh-11rem)] items-center justify-center px-4 py-10">
      <section className="island-shell rise-in w-full max-w-md rounded-3xl p-6 sm:p-8">
        <div className="mb-6 space-y-2">
          <p className="island-kicker m-0">创建账号</p>
          <h1 className="display-title m-0 text-3xl font-bold tracking-tight text-[var(--sea-ink)]">
            注册 media-ref
          </h1>
          <p className="m-0 text-sm text-[var(--sea-ink-soft)]">
            使用邮箱和密码注册账号，验证邮箱后即可自助创建接口密钥与提交关联。
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

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label
              htmlFor="register-name"
              className="block text-sm font-semibold text-[var(--sea-ink)]"
            >
              名称
            </label>
            <input
              id="register-name"
              name="name"
              type="text"
              required
              autoComplete="name"
              placeholder="例如：Alice 或项目名"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={submitting}
              className="field-input"
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="register-email"
              className="block text-sm font-semibold text-[var(--sea-ink)]"
            >
              邮箱
            </label>
            <input
              id="register-email"
              name="email"
              type="email"
              required
              autoComplete="email"
              placeholder="developer@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={submitting}
              className="field-input"
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="register-password"
              className="block text-sm font-semibold text-[var(--sea-ink)]"
            >
              密码
            </label>
            <input
              id="register-password"
              name="password"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              placeholder="至少 8 位字符"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={submitting}
              className="field-input"
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="register-password-confirm"
              className="block text-sm font-semibold text-[var(--sea-ink)]"
            >
              确认密码
            </label>
            <input
              id="register-password-confirm"
              name="confirmPassword"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              placeholder="再次输入密码"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              disabled={submitting}
              className="field-input"
            />
          </div>

          <button type="submit" disabled={submitting} className="btn-primary w-full py-2.5">
            {submitting ? "正在注册..." : "注册账号"}
          </button>
        </form>

        <p className="mt-6 mb-0 text-center text-sm text-[var(--sea-ink-soft)]">
          已有账号？{" "}
          <Link
            to="/login"
            search={search.redirect ? { redirect: search.redirect } : {}}
            className="font-semibold"
          >
            前往登录
          </Link>
        </p>
      </section>
    </main>
  );
}
