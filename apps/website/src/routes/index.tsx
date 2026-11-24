import { useState, type FormEvent } from "react";
import { Link, createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import EmailVerificationBanner from "#/components/EmailVerificationBanner";
import {
  ArrowRightIcon,
  FileCheckIcon,
  KeyIcon,
  SendIcon,
  ShieldCheckIcon,
} from "#/components/Icons";
import { getApiBaseUrl } from "#/lib/api";
import { isReviewer, requireLogin } from "#/lib/auth";
import { isUuid } from "#/lib/change-requests-api";

export const Route = createFileRoute("/")({
  beforeLoad: ({ context, location }) => requireLogin(context, location),
  head: () => ({
    meta: [{ title: "工作台 · media-ref" }],
  }),
  component: DashboardPage,
});

function DashboardPage() {
  const { user } = Route.useRouteContext();
  const router = useRouter();
  const navigate = useNavigate();
  const [refreshing, setRefreshing] = useState(false);
  const [lookupId, setLookupId] = useState("");
  const [lookupError, setLookupError] = useState<string | null>(null);

  const reviewer = isReviewer(user);
  const apiBaseUrl = getApiBaseUrl();

  async function handleRefreshStatus() {
    setRefreshing(true);
    try {
      await router.invalidate();
    } finally {
      setRefreshing(false);
    }
  }

  async function handleLookupChangeRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = lookupId.trim();
    if (!isUuid(trimmed)) {
      setLookupError("请输入合法的变更单 UUID");
      return;
    }
    setLookupError(null);
    await navigate({
      to: "/change-requests/$id",
      params: { id: trimmed },
    });
  }

  return (
    <main className="page-wrap space-y-6 px-4 pt-8 pb-6 sm:pt-12">
      <section className="island-shell rise-in relative overflow-hidden rounded-3xl px-6 py-8 sm:px-9 sm:py-10">
        <div className="pointer-events-none absolute -top-24 -left-20 h-56 w-56 rounded-full bg-[radial-gradient(circle,rgba(79,184,178,0.28),transparent_68%)]" />
        <div className="pointer-events-none absolute -right-20 -bottom-24 h-56 w-56 rounded-full bg-[radial-gradient(circle,rgba(47,106,74,0.16),transparent_68%)]" />

        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2.5">
            <p className="island-kicker m-0">media-ref 工作台</p>
            <h1 className="display-title m-0 text-3xl font-bold tracking-tight text-[var(--sea-ink)] sm:text-4xl">
              欢迎回来，{user.name || user.email}
            </h1>
            <p className="m-0 max-w-2xl text-sm leading-relaxed text-[var(--sea-ink-soft)] sm:text-base">
              统一管理接口密钥，提交并追踪电影与剧集在各视频平台（腾讯视频、爱奇艺、优酷、B 站、芒果
              TV）与目录网站上的关联、变体与段。
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            <span
              className={
                user.emailVerified
                  ? "inline-flex items-center gap-1.5 rounded-full border border-[var(--ok-border)] bg-[var(--ok-bg)] px-3 py-1 text-xs font-bold text-[var(--ok-ink)]"
                  : "inline-flex items-center gap-1.5 rounded-full border border-[var(--warn-border)] bg-[var(--warn-bg)] px-3 py-1 text-xs font-bold text-[var(--warn-ink)]"
              }
            >
              <span
                className={
                  user.emailVerified
                    ? "h-1.5 w-1.5 rounded-full bg-emerald-500"
                    : "h-1.5 w-1.5 rounded-full bg-amber-500"
                }
              />
              {user.emailVerified ? "邮箱已验证" : "邮箱未验证"}
            </span>
            {reviewer ? (
              <span className="inline-flex items-center rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3 py-1 text-xs font-bold text-[var(--lagoon-deep)]">
                审核员
              </span>
            ) : null}
          </div>
        </div>

        <div className="relative mt-6 flex flex-wrap gap-3">
          <Link to="/submit" className="btn-primary">
            <SendIcon className="h-4 w-4" />
            <span>提交关联</span>
          </Link>
          <Link to="/keys" className="btn-secondary">
            <KeyIcon className="h-4 w-4" />
            <span>管理接口密钥</span>
          </Link>
          {reviewer ? (
            <Link to="/reviewer" className="btn-secondary">
              <ShieldCheckIcon className="h-4 w-4" />
              <span>审核员队列</span>
            </Link>
          ) : null}
        </div>
      </section>

      {!user.emailVerified ? (
        <EmailVerificationBanner
          email={user.email}
          onRefreshStatus={handleRefreshStatus}
          refreshing={refreshing}
        />
      ) : null}

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Link
          to="/submit"
          className="island-shell feature-card block rounded-2xl p-6 text-inherit no-underline"
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--chip-line)] bg-[var(--chip-bg)] text-[var(--lagoon-deep)]">
              <SendIcon />
            </span>
            <span className="rounded-full border border-[var(--ok-border)] bg-[var(--ok-bg)] px-2.5 py-0.5 text-[11px] font-bold text-[var(--ok-ink)]">
              可用
            </span>
          </div>
          <h2 className="m-0 mb-1.5 text-base font-bold text-[var(--sea-ink)]">提交关联</h2>
          <p className="m-0 text-sm leading-relaxed text-[var(--sea-ink-soft)]">
            粘贴平台网址或原生 ID，指定变体、默认变体与段，实时校验重叠段并生成变更单。
          </p>
        </Link>

        <Link
          to="/keys"
          className="island-shell feature-card block rounded-2xl p-6 text-inherit no-underline"
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--chip-line)] bg-[var(--chip-bg)] text-[var(--lagoon-deep)]">
              <KeyIcon />
            </span>
            <span className="rounded-full border border-[var(--ok-border)] bg-[var(--ok-bg)] px-2.5 py-0.5 text-[11px] font-bold text-[var(--ok-ink)]">
              可用
            </span>
          </div>
          <h2 className="m-0 mb-1.5 text-base font-bold text-[var(--sea-ink)]">接口密钥</h2>
          <p className="m-0 text-sm leading-relaxed text-[var(--sea-ink-soft)]">
            自助创建「读和上报」或「允许提交」权限的接口密钥，随时查看前缀并吊销泄露密钥。
          </p>
        </Link>

        <article className="island-shell rounded-2xl p-6">
          <div className="mb-3 flex items-center justify-between gap-2">
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--chip-line)] bg-[var(--chip-bg)] text-[var(--lagoon-deep)]">
              <FileCheckIcon />
            </span>
            <span className="rounded-full border border-[var(--ok-border)] bg-[var(--ok-bg)] px-2.5 py-0.5 text-[11px] font-bold text-[var(--ok-ink)]">
              可用
            </span>
          </div>
          <h2 className="m-0 mb-1.5 text-base font-bold text-[var(--sea-ink)]">查询变更单状态</h2>
          <p className="m-0 mb-3 text-sm leading-relaxed text-[var(--sea-ink-soft)]">
            输入变更单编号，查看待取证、已通过、转人工与已驳回状态及证据门判定理由。
          </p>
          <form onSubmit={handleLookupChangeRequest} className="space-y-1.5">
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="输入变更单 UUID"
                value={lookupId}
                onChange={(event) => {
                  setLookupId(event.target.value);
                  setLookupError(null);
                }}
                className="field-input py-1.5 font-mono text-xs"
              />
              <button type="submit" className="btn-secondary shrink-0 px-3 py-1.5 text-xs">
                <span>查看</span>
                <ArrowRightIcon className="h-3.5 w-3.5" />
              </button>
            </div>
            {lookupError ? (
              <p className="m-0 text-xs font-semibold text-[var(--danger-ink)]">{lookupError}</p>
            ) : null}
          </form>
        </article>

        {reviewer ? (
          <Link
            to="/reviewer"
            className="island-shell feature-card block rounded-2xl p-6 text-inherit no-underline sm:col-span-2 lg:col-span-3"
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--chip-line)] bg-[var(--chip-bg)] text-[var(--lagoon-deep)]">
                  <ShieldCheckIcon />
                </span>
                <span className="island-kicker">审核员队列</span>
              </div>
              <span className="rounded-full border border-[var(--ok-border)] bg-[var(--ok-bg)] px-2.5 py-0.5 text-[11px] font-bold text-[var(--ok-ink)]">
                可用
              </span>
            </div>
            <h2 className="m-0 mb-1.5 text-base font-bold text-[var(--sea-ink)]">人工审核队列</h2>
            <p className="m-0 text-sm leading-relaxed text-[var(--sea-ink-soft)]">
              仅审核员可见。用于处理证据门转人工的变更单、审阅取证结果与冲突项，并执行通过、驳回或锁定关联。
            </p>
          </Link>
        ) : null}
      </section>

      <section className="island-shell rounded-2xl p-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="island-kicker m-0 mb-1">接口调用方式</p>
            <h2 className="m-0 text-base font-bold text-[var(--sea-ink)]">使用接口密钥认证</h2>
          </div>
          <code className="text-xs">{apiBaseUrl}</code>
        </div>
        <p className="m-0 mb-3 text-sm text-[var(--sea-ink-soft)]">
          创建密钥后，在请求头传入 <code>X-API-Key</code> 或 <code>Authorization: Bearer</code>{" "}
          即可验证密钥状态并调用接口：
        </p>
        <pre className="m-0 overflow-x-auto rounded-xl border border-[var(--line)] bg-[var(--chip-bg)] p-4 text-xs leading-relaxed text-[var(--sea-ink)]">
          <code>{`curl -X POST -H "Content-Type: application/json" \\\n  -H "X-API-Key: mref_your_api_key_here" \\\n  -d '{}' \\\n  ${apiBaseUrl}/mediaref.v1.AccountService/GetCurrentApiKey`}</code>
        </pre>
      </section>
    </main>
  );
}
