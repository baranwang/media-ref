import { useEffect, useState } from "react";
import { isPlatformNamespace } from "@media-ref/client";
import { Link, createFileRoute } from "@tanstack/react-router";
import {
  EvidencePanel,
  NamespaceBadge,
  ReasonCallout,
  SegmentsTable,
  StatusBadge,
} from "#/components/ChangeRequestDetails";
import {
  AlertTriangleIcon,
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  RefreshIcon,
  SendIcon,
  ShieldCheckIcon,
} from "#/components/Icons";
import { isReviewer, requireLogin } from "#/lib/auth";
import {
  CHANGE_REQUEST_STATUS_META,
  ChangeRequestApiError,
  fetchChangeRequest,
  formatChangeRequestApiError,
  formatDateTime,
  getChangeRequest,
  isUuid,
  type ChangeRequestRecord,
} from "#/lib/change-requests-api";

interface ChangeRequestLoaderData {
  changeRequest: ChangeRequestRecord | null;
  error: string | null;
  notFound: boolean;
}

export const Route = createFileRoute("/change-requests/$id")({
  beforeLoad: ({ context, location }) => requireLogin(context, location),
  loader: async ({ params }): Promise<ChangeRequestLoaderData> => {
    const id = params.id.trim();
    if (!isUuid(id)) {
      return {
        changeRequest: null,
        error: "变更单编号格式无效（应为标准 UUID）",
        notFound: false,
      };
    }

    try {
      const changeRequest = await fetchChangeRequest(id);
      return {
        changeRequest,
        error: null,
        notFound: false,
      };
    } catch (error) {
      if (error instanceof ChangeRequestApiError && error.status === 404) {
        return {
          changeRequest: null,
          error: "未找到对应的变更单",
          notFound: true,
        };
      }
      return {
        changeRequest: null,
        error: formatChangeRequestApiError(error, "加载变更单失败，请稍后重试"),
        notFound: false,
      };
    }
  },
  head: ({ params }) => ({
    meta: [{ title: `变更单 ${params.id.slice(0, 8)} · media-ref` }],
  }),
  component: ChangeRequestStatusPage,
});

function ChangeRequestStatusPage() {
  const { user } = Route.useRouteContext();
  const { id } = Route.useParams();
  const loaderData = Route.useLoaderData();

  const [changeRequest, setChangeRequest] = useState<ChangeRequestRecord | null>(
    loaderData.changeRequest,
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(loaderData.error);
  const [notFound, setNotFound] = useState(loaderData.notFound);
  const [refreshing, setRefreshing] = useState(false);
  const [copiedId, setCopiedId] = useState(false);

  const reviewer = isReviewer(user);

  useEffect(() => {
    setChangeRequest(loaderData.changeRequest);
    setErrorMessage(loaderData.error);
    setNotFound(loaderData.notFound);
  }, [loaderData]);

  async function handleRefresh() {
    if (!isUuid(id)) {
      return;
    }
    setRefreshing(true);
    setErrorMessage(null);
    try {
      const latest = await getChangeRequest(id);
      setChangeRequest(latest);
      setNotFound(false);
    } catch (error) {
      if (error instanceof ChangeRequestApiError && error.status === 404) {
        setNotFound(true);
      }
      setErrorMessage(formatChangeRequestApiError(error, "刷新变更单状态失败"));
    } finally {
      setRefreshing(false);
    }
  }

  async function handleCopyId() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(id);
        setCopiedId(true);
        setTimeout(() => setCopiedId(false), 2000);
      }
    } catch {
      setCopiedId(false);
    }
  }

  return (
    <main className="page-wrap space-y-6 px-4 pt-8 pb-10 sm:pt-10">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1.5">
          <p className="island-kicker m-0">变更单状态</p>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="display-title m-0 text-3xl font-bold tracking-tight text-[var(--sea-ink)] sm:text-4xl">
              变更单详情
            </h1>
            {changeRequest ? <StatusBadge status={changeRequest.status} showCode /> : null}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--sea-ink-soft)]">
            <span>编号：</span>
            <code className="font-mono text-xs text-[var(--sea-ink)]">{id}</code>
            <button
              type="button"
              onClick={() => void handleCopyId()}
              className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-[var(--line)] bg-[var(--chip-bg)] px-2.5 py-0.5 text-xs font-semibold text-[var(--sea-ink-soft)] transition hover:text-[var(--sea-ink)]"
            >
              {copiedId ? <CheckIcon className="h-3 w-3" /> : <CopyIcon className="h-3 w-3" />}
              <span>{copiedId ? "已复制" : "复制编号"}</span>
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void handleRefresh()}
            disabled={refreshing || !isUuid(id)}
            className="btn-secondary"
          >
            <RefreshIcon className={refreshing ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            <span>{refreshing ? "刷新中..." : "刷新状态"}</span>
          </button>
          <Link to="/submit" className="btn-primary">
            <SendIcon className="h-4 w-4" />
            <span>继续提交</span>
          </Link>
          {reviewer ? (
            <Link to="/reviewer" className="btn-secondary">
              <ShieldCheckIcon className="h-4 w-4" />
              <span>审核员队列</span>
            </Link>
          ) : null}
        </div>
      </header>

      {errorMessage ? (
        <section
          role="alert"
          className="island-shell rounded-3xl border-[var(--danger-border)] p-6 sm:p-8"
        >
          <div className="flex items-start gap-3 text-[var(--danger-ink)]">
            <AlertTriangleIcon className="mt-0.5 h-5 w-5 shrink-0" />
            <div className="space-y-2">
              <h2 className="m-0 text-base font-bold">
                {notFound ? "未找到变更单" : "无法加载变更单"}
              </h2>
              <p className="m-0 text-sm text-[var(--sea-ink)]">{errorMessage}</p>
              <div className="flex flex-wrap gap-2 pt-2">
                <Link to="/submit" className="btn-primary text-xs">
                  提交新关联
                </Link>
                <Link to="/" className="btn-secondary text-xs">
                  返回工作台
                </Link>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {changeRequest ? (
        <>
          {/* Status overview & reasons */}
          <section className="island-shell rise-in space-y-4 rounded-3xl p-6 sm:p-7">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={changeRequest.status} showCode />
                  <NamespaceBadge namespace={changeRequest.namespace} />
                </div>
                <p className="m-0 pt-1 text-sm text-[var(--sea-ink-soft)]">
                  {CHANGE_REQUEST_STATUS_META[changeRequest.status].description}
                </p>
              </div>

              {changeRequest.mediaId ? (
                <a
                  href={`/media/${encodeURIComponent(changeRequest.mediaId)}`}
                  className="btn-secondary self-start text-xs sm:self-auto"
                >
                  <span>查看媒体页</span>
                  <ExternalLinkIcon className="h-3.5 w-3.5" />
                </a>
              ) : null}
            </div>

            {changeRequest.status === "pending_evidence" ? (
              <p className="m-0 rounded-xl border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3.5 py-2.5 text-xs text-[var(--sea-ink-soft)]">
                取证由后台任务异步执行，完成后状态会自动变为「已通过」或「转人工」。您可以随时点击右上角「刷新状态」查看进展。
              </p>
            ) : null}

            <ReasonCallout
              status={changeRequest.status}
              conflictReason={changeRequest.conflictReason}
              decisionReason={changeRequest.decisionReason}
            />
          </section>

          {/* Submitted details */}
          <section className="island-shell space-y-5 rounded-3xl p-6 sm:p-7">
            <h2 className="m-0 text-lg font-bold text-[var(--sea-ink)]">提交内容</h2>

            <dl className="m-0 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div className="rounded-2xl border border-[var(--line)] bg-[var(--chip-bg)] p-4">
                <dt className="text-xs font-semibold text-[var(--sea-ink-soft)]">目标外部键</dt>
                <dd className="m-0 mt-1 font-mono text-sm font-bold break-all text-[var(--sea-ink)]">
                  {changeRequest.targetExternalKey}
                </dd>
              </div>

              <div className="rounded-2xl border border-[var(--line)] bg-[var(--chip-bg)] p-4">
                <dt className="text-xs font-semibold text-[var(--sea-ink-soft)]">关联媒体</dt>
                <dd className="m-0 mt-1 text-sm text-[var(--sea-ink)]">
                  {changeRequest.mediaId ? (
                    <a
                      href={`/media/${encodeURIComponent(changeRequest.mediaId)}`}
                      className="inline-flex items-center gap-1 font-mono text-xs font-bold break-all"
                    >
                      <span>{changeRequest.mediaId}</span>
                      <ExternalLinkIcon className="h-3.5 w-3.5 shrink-0" />
                    </a>
                  ) : (
                    <span className="text-xs text-[var(--sea-ink-soft)]">
                      尚未建档（通过时按目标目录自动建档）
                    </span>
                  )}
                </dd>
              </div>

              <div className="rounded-2xl border border-[var(--line)] bg-[var(--chip-bg)] p-4">
                <dt className="text-xs font-semibold text-[var(--sea-ink-soft)]">
                  规范原生 ID（nativeId）
                </dt>
                <dd className="m-0 mt-1 space-y-1">
                  <code className="block font-mono text-sm font-bold break-all text-[var(--sea-ink)]">
                    {changeRequest.nativeId}
                  </code>
                  {changeRequest.rawNativeId !== changeRequest.nativeId ? (
                    <span className="block text-xs break-all text-[var(--sea-ink-soft)]">
                      原始输入：{changeRequest.rawNativeId}
                    </span>
                  ) : null}
                </dd>
              </div>

              <div className="rounded-2xl border border-[var(--line)] bg-[var(--chip-bg)] p-4">
                <dt className="text-xs font-semibold text-[var(--sea-ink-soft)]">变体</dt>
                <dd className="m-0 mt-1 space-y-1 text-sm text-[var(--sea-ink)]">
                  {isPlatformNamespace(changeRequest.namespace) ? (
                    <>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-bold">
                          {changeRequest.variantDescription || "已有变体"}
                        </span>
                        {changeRequest.setDefaultVariant ? (
                          <span className="rounded-full border border-[var(--warn-border)] bg-[var(--warn-bg)] px-2 py-0.5 text-[11px] font-bold text-[var(--warn-ink)]">
                            设为默认变体
                          </span>
                        ) : null}
                      </div>
                      {changeRequest.variantId ? (
                        <code className="block font-mono text-xs break-all text-[var(--sea-ink-soft)]">
                          {changeRequest.variantId}
                        </code>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-xs text-[var(--sea-ink-soft)]">目录关联（无变体）</span>
                  )}
                </dd>
              </div>

              <div className="rounded-2xl border border-[var(--line)] bg-[var(--chip-bg)] p-4">
                <dt className="text-xs font-semibold text-[var(--sea-ink-soft)]">提交来源与时间</dt>
                <dd className="m-0 mt-1 space-y-0.5 text-xs text-[var(--sea-ink)]">
                  <div>
                    来源：
                    <span className="font-semibold">
                      {changeRequest.submitterType === "agent" ? "探索 agent" : "人工提交"}
                    </span>
                  </div>
                  <div className="text-[var(--sea-ink-soft)]">
                    创建：
                    <time dateTime={changeRequest.createdAt} suppressHydrationWarning>
                      {formatDateTime(changeRequest.createdAt)}
                    </time>
                  </div>
                  <div className="text-[var(--sea-ink-soft)]">
                    更新：
                    <time dateTime={changeRequest.updatedAt} suppressHydrationWarning>
                      {formatDateTime(changeRequest.updatedAt)}
                    </time>
                  </div>
                </dd>
              </div>

              <div className="rounded-2xl border border-[var(--line)] bg-[var(--chip-bg)] p-4">
                <dt className="text-xs font-semibold text-[var(--sea-ink-soft)]">审核与生效记录</dt>
                <dd className="m-0 mt-1 space-y-0.5 text-xs text-[var(--sea-ink)]">
                  {changeRequest.reviewedAt ? (
                    <div className="text-[var(--sea-ink-soft)]">
                      审核时间：
                      <time dateTime={changeRequest.reviewedAt} suppressHydrationWarning>
                        {formatDateTime(changeRequest.reviewedAt)}
                      </time>
                    </div>
                  ) : (
                    <div className="text-[var(--sea-ink-soft)]">尚未完成审核</div>
                  )}
                  {changeRequest.appliedAssociationId ? (
                    <div className="break-all">
                      生效关联：
                      <code className="font-mono text-[11px]">
                        {changeRequest.appliedAssociationId}
                      </code>
                    </div>
                  ) : null}
                  {changeRequest.appliedRevisionId ? (
                    <div className="break-all">
                      关联版本：
                      <code className="font-mono text-[11px]">
                        {changeRequest.appliedRevisionId}
                      </code>
                    </div>
                  ) : null}
                </dd>
              </div>
            </dl>

            <div className="space-y-2.5">
              <h3 className="m-0 text-sm font-bold text-[var(--sea-ink)]">
                段列表（{changeRequest.segments.length} 项）
              </h3>
              <SegmentsTable segments={changeRequest.segments} />
            </div>
          </section>

          {/* Evidence panel */}
          <section className="island-shell space-y-3 rounded-3xl p-6 sm:p-7">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="m-0 text-lg font-bold text-[var(--sea-ink)]">取证结果</h2>
                <p className="mt-0.5 mb-0 text-xs text-[var(--sea-ink-soft)]">
                  由后台取证任务从平台与目录取回的原始核对依据，供证据门与审核员判定。
                </p>
              </div>
            </div>

            <EvidencePanel
              evidence={changeRequest.evidence}
              defaultOpenJson={Boolean(changeRequest.evidence)}
            />
          </section>
        </>
      ) : null}
    </main>
  );
}
