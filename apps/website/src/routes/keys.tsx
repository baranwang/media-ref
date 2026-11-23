import { useEffect, useState, type FormEvent } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import EmailVerificationBanner from "#/components/EmailVerificationBanner";
import { AlertTriangleIcon, CheckIcon, CopyIcon, KeyIcon, RefreshIcon } from "#/components/Icons";
import {
  MAX_API_KEY_NAME_LENGTH,
  createApiKey,
  formatApiError,
  listApiKeys,
  revokeApiKey,
  type ApiKeySummary,
  type CreatedApiKey,
} from "#/lib/api";
import { fetchApiKeys, requireLogin } from "#/lib/auth";

const EXPIRATION_OPTIONS = [
  { label: "永不过期", value: "" },
  { label: "7 天", value: String(7 * 86_400) },
  { label: "30 天", value: String(30 * 86_400) },
  { label: "90 天", value: String(90 * 86_400) },
  { label: "180 天", value: String(180 * 86_400) },
  { label: "365 天（最长）", value: String(365 * 86_400) },
] as const;

interface KeysLoaderData {
  apiKeys: ApiKeySummary[];
  total: number;
  error: string | null;
}

function formatDateTime(iso: string | null): string {
  if (!iso) {
    return "永不过期";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function getKeyStatus(item: ApiKeySummary): { label: string; tone: "ok" | "warn" | "danger" } {
  if (!item.enabled) {
    return { label: "已停用", tone: "danger" };
  }
  if (item.expiresAt) {
    const expiresAtMs = Date.parse(item.expiresAt);
    if (!Number.isNaN(expiresAtMs) && expiresAtMs <= Date.now()) {
      return { label: "已过期", tone: "warn" };
    }
  }
  return { label: "生效中", tone: "ok" };
}

function formatKeyPrefix(item: ApiKeySummary): string {
  const visible = item.start ?? item.prefix ?? "mref_";
  return `${visible}••••••••`;
}

export const Route = createFileRoute("/keys")({
  beforeLoad: ({ context, location }) => requireLogin(context, location),
  loader: async (): Promise<KeysLoaderData> => {
    try {
      const result = await fetchApiKeys();
      return {
        apiKeys: result.apiKeys,
        total: result.total,
        error: null,
      };
    } catch (error) {
      return {
        apiKeys: [],
        total: 0,
        error: formatApiError(error, "加载接口密钥列表失败"),
      };
    }
  },
  head: () => ({
    meta: [{ title: "接口密钥 · media-ref" }],
  }),
  component: ApiKeysPage,
});

function ApiKeysPage() {
  const { user } = Route.useRouteContext();
  const loaderData = Route.useLoaderData();
  const router = useRouter();

  const [apiKeys, setApiKeys] = useState<ApiKeySummary[]>(loaderData.apiKeys);
  const [total, setTotal] = useState<number>(loaderData.total);
  const [listError, setListError] = useState<string | null>(loaderData.error);
  const [refreshing, setRefreshing] = useState(false);

  const [name, setName] = useState("");
  const [canSubmit, setCanSubmit] = useState(false);
  const [expiresInStr, setExpiresInStr] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Kept strictly in ephemeral React state; cleared on dismiss or navigation unmount.
  const [createdKey, setCreatedKey] = useState<CreatedApiKey | null>(null);
  const [copied, setCopied] = useState(false);

  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  useEffect(() => {
    setApiKeys(loaderData.apiKeys);
    setTotal(loaderData.total);
    setListError(loaderData.error);
  }, [loaderData]);

  useEffect(() => {
    return () => {
      setCreatedKey(null);
    };
  }, []);

  async function refreshKeysList() {
    setListError(null);
    const result = await listApiKeys();
    setApiKeys(result.apiKeys);
    setTotal(result.total);
  }

  async function handleRefreshAll() {
    setRefreshing(true);
    setListError(null);
    try {
      await Promise.all([router.invalidate(), refreshKeysList()]);
    } catch (error) {
      setListError(formatApiError(error, "刷新失败，请稍后重试"));
    } finally {
      setRefreshing(false);
    }
  }

  async function handleCreateKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user.emailVerified) {
      setCreateError("请先验证邮箱后再创建接口密钥");
      return;
    }

    setCreateError(null);
    const trimmedName = name.trim();
    if (trimmedName.length > MAX_API_KEY_NAME_LENGTH) {
      setCreateError(`密钥名称不能超过 ${MAX_API_KEY_NAME_LENGTH} 个字符`);
      return;
    }

    const expiresIn = expiresInStr ? Number.parseInt(expiresInStr, 10) : undefined;

    setCreating(true);
    try {
      const created = await createApiKey({
        ...(trimmedName ? { name: trimmedName } : {}),
        canSubmit,
        ...(expiresIn ? { expiresIn } : {}),
      });
      setCreatedKey(created);
      setCopied(false);
      setName("");
      setCanSubmit(false);
      setExpiresInStr("");

      const { key: _omitSecret, ...summary } = created;
      setApiKeys((prev) => [summary, ...prev.filter((item) => item.id !== summary.id)]);
      setTotal((prev) => prev + 1);

      try {
        await refreshKeysList();
      } catch (refreshError) {
        setListError(formatApiError(refreshError, "密钥已创建，但刷新列表失败，请点击右上角刷新"));
      }
    } catch (error) {
      setCreateError(formatApiError(error, "创建接口密钥失败，请稍后重试"));
    } finally {
      setCreating(false);
    }
  }

  async function handleCopyCreatedKey() {
    if (!createdKey) {
      return;
    }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(createdKey.key);
        setCopied(true);
        return;
      }
    } catch {
      // Fall through to legacy selection copy fallback.
    }

    try {
      const textarea = document.createElement("textarea");
      textarea.value = createdKey.key;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(ok);
    } catch {
      setCopied(false);
    }
  }

  async function handleConfirmRevoke(keyId: string) {
    setRevokingId(keyId);
    setRevokeError(null);
    try {
      await revokeApiKey(keyId);
      setConfirmRevokeId(null);
      if (createdKey?.id === keyId) {
        setCreatedKey(null);
        setCopied(false);
      }
      setApiKeys((prev) => prev.filter((item) => item.id !== keyId));
      setTotal((prev) => Math.max(0, prev - 1));

      try {
        await refreshKeysList();
      } catch (refreshError) {
        setListError(formatApiError(refreshError, "密钥已吊销，但刷新列表失败，请点击右上角刷新"));
      }
    } catch (error) {
      setRevokeError(formatApiError(error, "吊销密钥失败，请稍后重试"));
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <main className="page-wrap space-y-6 px-4 pt-8 pb-6 sm:pt-10">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1.5">
          <p className="island-kicker m-0">密钥管理</p>
          <h1 className="display-title m-0 text-3xl font-bold tracking-tight text-[var(--sea-ink)] sm:text-4xl">
            接口密钥
          </h1>
          <p className="m-0 max-w-2xl text-sm leading-relaxed text-[var(--sea-ink-soft)]">
            一个账号可创建多把密钥用于不同客户端或脚本。密钥吊销后，提交与上报立即失效，读请求约 75
            秒内失效。
          </p>
        </div>

        <button
          type="button"
          onClick={() => void handleRefreshAll()}
          disabled={refreshing}
          className="btn-secondary self-start sm:self-auto"
        >
          <RefreshIcon className={refreshing ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
          <span>{refreshing ? "刷新中..." : "刷新"}</span>
        </button>
      </header>

      {!user.emailVerified ? (
        <EmailVerificationBanner
          email={user.email}
          onRefreshStatus={handleRefreshAll}
          refreshing={refreshing}
        />
      ) : null}

      {createdKey ? (
        <section
          role="status"
          className="rise-in rounded-2xl border-2 border-[var(--ok-border)] bg-[var(--ok-bg)] p-5 sm:p-6"
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1 rounded-full border border-[var(--ok-border)] bg-[var(--surface-strong)] px-2.5 py-0.5 text-xs font-bold text-[var(--ok-ink)]">
                  <CheckIcon className="h-3.5 w-3.5" />
                  密钥已创建
                </span>
                <span className="text-sm font-bold text-[var(--sea-ink)]">
                  {createdKey.name || "未命名密钥"}
                </span>
                <span className="rounded-full border border-[var(--line)] bg-[var(--chip-bg)] px-2.5 py-0.5 text-xs font-semibold text-[var(--sea-ink-soft)]">
                  {createdKey.canSubmit ? "读、上报和提交" : "读和上报"}
                </span>
              </div>
              <p className="m-0 flex items-center gap-1.5 text-sm font-bold text-[var(--warn-ink)]">
                <AlertTriangleIcon className="h-4 w-4 shrink-0" />
                <span>此密钥仅显示一次，关闭后无法再次查看</span>
              </p>
            </div>

            <button
              type="button"
              onClick={() => {
                setCreatedKey(null);
                setCopied(false);
              }}
              className="btn-secondary self-start text-xs"
            >
              我已保存，关闭
            </button>
          </div>

          <div className="mt-4 flex flex-col gap-2.5 sm:flex-row sm:items-center">
            <code className="block flex-1 overflow-x-auto rounded-xl border border-[var(--line)] bg-[var(--surface-strong)] px-4 py-3 font-mono text-sm font-semibold break-all text-[var(--sea-ink)] select-all">
              {createdKey.key}
            </code>
            <button
              type="button"
              onClick={() => void handleCopyCreatedKey()}
              className="btn-primary shrink-0 py-3"
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
              <span>{copied ? "已复制" : "复制密钥"}</span>
            </button>
          </div>
        </section>
      ) : null}

      <section className="island-shell rounded-3xl p-6 sm:p-7">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="m-0 text-lg font-bold text-[var(--sea-ink)]">创建新密钥</h2>
            <p className="mt-1 mb-0 text-sm text-[var(--sea-ink-soft)]">
              按最小权限原则选择权限：嵌入客户端的密钥建议使用默认的「读和上报」。
            </p>
          </div>
          {!user.emailVerified ? (
            <span className="rounded-full border border-[var(--warn-border)] bg-[var(--warn-bg)] px-3 py-1 text-xs font-bold text-[var(--warn-ink)]">
              需验证邮箱后启用
            </span>
          ) : null}
        </div>

        {createError ? (
          <div
            role="alert"
            className="mb-4 flex items-start gap-2 rounded-xl border border-[var(--danger-border)] bg-[var(--danger-bg)] p-3.5 text-sm text-[var(--danger-ink)]"
          >
            <AlertTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{createError}</span>
          </div>
        ) : null}

        <form onSubmit={handleCreateKey}>
          <fieldset
            disabled={!user.emailVerified || creating}
            className="m-0 space-y-5 border-0 p-0 disabled:opacity-65"
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label
                  htmlFor="api-key-name"
                  className="block text-sm font-semibold text-[var(--sea-ink)]"
                >
                  密钥名称
                </label>
                <input
                  id="api-key-name"
                  name="name"
                  type="text"
                  maxLength={MAX_API_KEY_NAME_LENGTH}
                  placeholder="例如：播放器客户端、批量提交脚本"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="field-input"
                />
                <p className="m-0 text-xs text-[var(--sea-ink-soft)]">
                  选填，最多 {MAX_API_KEY_NAME_LENGTH} 个字符，便于区分各应用用途。
                </p>
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="api-key-expires"
                  className="block text-sm font-semibold text-[var(--sea-ink)]"
                >
                  有效期
                </label>
                <select
                  id="api-key-expires"
                  name="expiresIn"
                  value={expiresInStr}
                  onChange={(event) => setExpiresInStr(event.target.value)}
                  className="field-input"
                >
                  {EXPIRATION_OPTIONS.map((option) => (
                    <option key={option.label} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <p className="m-0 text-xs text-[var(--sea-ink-soft)]">
                  可选设置自动过期时间，最长 365 天。
                </p>
              </div>
            </div>

            <div className="space-y-3 rounded-2xl border border-[var(--line)] bg-[var(--chip-bg)] p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="text-sm font-bold text-[var(--sea-ink)]">
                    读和上报（<code>read_report</code>）
                  </span>
                  <p className="mt-0.5 mb-0 text-xs text-[var(--sea-ink-soft)]">
                    查询媒体文档、批量查询，以及上报失效合集和线索。默认包含。
                  </p>
                </div>
                <span className="rounded-full border border-[var(--chip-line)] bg-[var(--surface-strong)] px-2.5 py-0.5 text-xs font-bold text-[var(--lagoon-deep)]">
                  默认包含
                </span>
              </div>

              <div className="h-px bg-[var(--line)]" />

              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={canSubmit}
                  onChange={(event) => setCanSubmit(event.target.checked)}
                  className="mt-1 h-4 w-4 accent-[var(--lagoon-deep)]"
                />
                <span className="space-y-0.5">
                  <span className="block text-sm font-bold text-[var(--sea-ink)]">
                    允许提交（<code>submit</code>）
                  </span>
                  <span className="block text-xs leading-relaxed text-[var(--sea-ink-soft)]">
                    允许使用此密钥通过公开写接口提交变更单（与账号共用每小时提交上限）。请勿将带有提交权限的密钥嵌入公开客户端。
                  </span>
                </span>
              </label>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              {!user.emailVerified ? (
                <p className="m-0 text-xs font-semibold text-[var(--warn-ink)]">
                  完成邮箱验证后才能创建密钥。
                </p>
              ) : (
                <p className="m-0 text-xs text-[var(--sea-ink-soft)]">
                  创建后明文密钥仅展示一次，服务端仅保存哈希值。
                </p>
              )}

              <button type="submit" className="btn-primary">
                <KeyIcon className="h-4 w-4" />
                <span>{creating ? "创建中..." : "创建密钥"}</span>
              </button>
            </div>
          </fieldset>
        </form>
      </section>

      <section className="island-shell rounded-3xl p-6 sm:p-7">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="m-0 text-lg font-bold text-[var(--sea-ink)]">已有密钥</h2>
            <p className="mt-1 mb-0 text-sm text-[var(--sea-ink-soft)]">
              列表仅显示密钥前缀与元数据，不保存也不返回明文密钥。
            </p>
          </div>
          <span className="rounded-full border border-[var(--line)] bg-[var(--chip-bg)] px-3 py-1 text-xs font-bold text-[var(--sea-ink)]">
            共 {total} 把
          </span>
        </div>

        {listError ? (
          <div
            role="alert"
            className="mb-4 flex items-start gap-2 rounded-xl border border-[var(--danger-border)] bg-[var(--danger-bg)] p-3.5 text-sm text-[var(--danger-ink)]"
          >
            <AlertTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{listError}</span>
          </div>
        ) : null}

        {revokeError ? (
          <div
            role="alert"
            className="mb-4 flex items-start gap-2 rounded-xl border border-[var(--danger-border)] bg-[var(--danger-bg)] p-3.5 text-sm text-[var(--danger-ink)]"
          >
            <AlertTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{revokeError}</span>
          </div>
        ) : null}

        {apiKeys.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[var(--line)] bg-[var(--chip-bg)] px-6 py-12 text-center">
            <div className="mx-auto mb-3 inline-flex h-11 w-11 items-center justify-center rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] text-[var(--sea-ink-soft)]">
              <KeyIcon />
            </div>
            <p className="m-0 text-sm font-semibold text-[var(--sea-ink)]">还没有接口密钥</p>
            <p className="mt-1 mb-0 text-xs text-[var(--sea-ink-soft)]">
              {user.emailVerified
                ? "在上方表单中创建第一把密钥即可开始调用 media-ref 接口。"
                : "完成邮箱验证后即可在上方创建您的第一把接口密钥。"}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-[var(--line)]">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--line)] bg-[var(--chip-bg)] text-xs font-bold text-[var(--sea-ink-soft)]">
                  <th className="px-4 py-3">名称</th>
                  <th className="px-4 py-3">前缀</th>
                  <th className="px-4 py-3">权限</th>
                  <th className="px-4 py-3">状态</th>
                  <th className="px-4 py-3">创建时间</th>
                  <th className="px-4 py-3">过期时间</th>
                  <th className="px-4 py-3 text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--line)]">
                {apiKeys.map((item) => {
                  const status = getKeyStatus(item);
                  const isConfirming = confirmRevokeId === item.id;
                  const isRevoking = revokingId === item.id;

                  return (
                    <tr
                      key={item.id}
                      className="transition hover:bg-[color-mix(in_oklab,var(--lagoon)_6%,transparent)]"
                    >
                      <td className="px-4 py-3.5 font-semibold text-[var(--sea-ink)]">
                        {item.name || "未命名密钥"}
                      </td>
                      <td className="px-4 py-3.5">
                        <code className="font-mono text-xs text-[var(--sea-ink)]">
                          {formatKeyPrefix(item)}
                        </code>
                      </td>
                      <td className="px-4 py-3.5">
                        <span
                          className={
                            item.canSubmit
                              ? "inline-flex items-center rounded-full border border-[var(--warn-border)] bg-[var(--warn-bg)] px-2.5 py-0.5 text-xs font-bold whitespace-nowrap text-[var(--warn-ink)]"
                              : "inline-flex items-center rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-2.5 py-0.5 text-xs font-bold whitespace-nowrap text-[var(--sea-ink)]"
                          }
                        >
                          {item.canSubmit ? "读、上报和提交" : "读和上报"}
                        </span>
                      </td>
                      <td className="px-4 py-3.5">
                        <span
                          className={
                            status.tone === "ok"
                              ? "inline-flex items-center rounded-full border border-[var(--ok-border)] bg-[var(--ok-bg)] px-2.5 py-0.5 text-xs font-bold whitespace-nowrap text-[var(--ok-ink)]"
                              : status.tone === "warn"
                                ? "inline-flex items-center rounded-full border border-[var(--warn-border)] bg-[var(--warn-bg)] px-2.5 py-0.5 text-xs font-bold whitespace-nowrap text-[var(--warn-ink)]"
                                : "inline-flex items-center rounded-full border border-[var(--danger-border)] bg-[var(--danger-bg)] px-2.5 py-0.5 text-xs font-bold whitespace-nowrap text-[var(--danger-ink)]"
                          }
                        >
                          {status.label}
                        </span>
                      </td>
                      <td className="px-4 py-3.5 text-xs whitespace-nowrap text-[var(--sea-ink-soft)]">
                        <time dateTime={item.createdAt} suppressHydrationWarning>
                          {formatDateTime(item.createdAt)}
                        </time>
                      </td>
                      <td className="px-4 py-3.5 text-xs whitespace-nowrap text-[var(--sea-ink-soft)]">
                        {item.expiresAt ? (
                          <time dateTime={item.expiresAt} suppressHydrationWarning>
                            {formatDateTime(item.expiresAt)}
                          </time>
                        ) : (
                          "永不过期"
                        )}
                      </td>
                      <td className="px-4 py-3.5 text-right whitespace-nowrap">
                        {isConfirming ? (
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => void handleConfirmRevoke(item.id)}
                              disabled={isRevoking}
                              className="btn-danger"
                            >
                              {isRevoking ? "吊销中..." : "确认吊销"}
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmRevokeId(null)}
                              disabled={isRevoking}
                              className="btn-secondary px-2.5 py-1 text-xs"
                            >
                              取消
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setRevokeError(null);
                              setConfirmRevokeId(item.id);
                            }}
                            disabled={revokingId !== null}
                            className="btn-danger"
                          >
                            吊销
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
