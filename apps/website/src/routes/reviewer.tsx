import { useEffect, useState } from "react";
import { isPlatformNamespace, type ChangeRequestStatus } from "@media-ref/client";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
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
  ExternalLinkIcon,
  LockIcon,
  RefreshIcon,
  ShieldCheckIcon,
  XCircleIcon,
} from "#/components/Icons";
import { requireReviewer } from "#/lib/auth";
import {
  CHANGE_REQUEST_STATUS_LIST,
  CHANGE_REQUEST_STATUS_META,
  ChangeRequestApiError,
  approveChangeRequest,
  extractLinkedAssociationId,
  fetchReviewerChangeRequests,
  formatChangeRequestApiError,
  formatDateTime,
  listReviewerChangeRequests,
  lockAssociation,
  rejectChangeRequest,
  type ChangeRequestRecord,
} from "#/lib/change-requests-api";

interface ReviewerSearch {
  status?: ChangeRequestStatus;
}

interface ReviewerLoaderData {
  status: ChangeRequestStatus;
  changeRequests: ChangeRequestRecord[];
  total: number;
  error: string | null;
  forbidden: boolean;
}

interface LastActionNotice {
  kind: "approved" | "rejected" | "locked";
  changeRequestId: string;
  mediaId?: string | null;
  associationId?: string | null;
  message: string;
}

function isValidStatus(raw: unknown): raw is ChangeRequestStatus {
  return typeof raw === "string" && CHANGE_REQUEST_STATUS_LIST.includes(raw as ChangeRequestStatus);
}

export const Route = createFileRoute("/reviewer")({
  validateSearch: (search: Record<string, unknown>): ReviewerSearch => {
    const status = isValidStatus(search.status) ? search.status : undefined;
    return status ? { status } : {};
  },
  beforeLoad: ({ context, location }) => requireReviewer(context, location),
  loaderDeps: ({ search }) => ({
    status: search.status ?? ("needs_review" as ChangeRequestStatus),
  }),
  loader: async ({ deps }): Promise<ReviewerLoaderData> => {
    try {
      const result = await fetchReviewerChangeRequests(deps.status);
      return {
        status: deps.status,
        changeRequests: result.changeRequests,
        total: result.total,
        error: null,
        forbidden: false,
      };
    } catch (error) {
      if (error instanceof ChangeRequestApiError && error.status === 403) {
        return {
          status: deps.status,
          changeRequests: [],
          total: 0,
          error: "当前账号没有审核员权限，无法访问审核队列（403）",
          forbidden: true,
        };
      }
      return {
        status: deps.status,
        changeRequests: [],
        total: 0,
        error: formatChangeRequestApiError(error, "加载审核员队列失败"),
        forbidden: false,
      };
    }
  },
  head: () => ({
    meta: [{ title: "审核员队列 · media-ref" }],
  }),
  component: ReviewerQueuePage,
});

function ReviewerQueuePage() {
  const loaderData = Route.useLoaderData();
  const navigate = useNavigate();

  const [statusFilter, setStatusFilter] = useState<ChangeRequestStatus>(loaderData.status);
  const [items, setItems] = useState<ChangeRequestRecord[]>(loaderData.changeRequests);
  const [total, setTotal] = useState<number>(loaderData.total);
  const [listError, setListError] = useState<string | null>(loaderData.error);
  const [forbidden, setForbidden] = useState<boolean>(loaderData.forbidden);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const [reasonsById, setReasonsById] = useState<Record<string, string>>({});
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  const [busyById, setBusyById] = useState<Record<string, "approving" | "rejecting" | "locking">>(
    {},
  );
  const [lockedAssociations, setLockedAssociations] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<LastActionNotice | null>(null);
  const [lockingNoticeAssoc, setLockingNoticeAssoc] = useState(false);
  const [noticeLockError, setNoticeLockError] = useState<string | null>(null);

  useEffect(() => {
    setStatusFilter(loaderData.status);
    setItems(loaderData.changeRequests);
    setTotal(loaderData.total);
    setListError(loaderData.error);
    setForbidden(loaderData.forbidden);
  }, [loaderData]);

  async function reloadQueue(targetStatus: ChangeRequestStatus = statusFilter) {
    setRefreshing(true);
    setListError(null);
    try {
      const result = await listReviewerChangeRequests(targetStatus);
      setItems(result.changeRequests);
      setTotal(result.total);
      setForbidden(false);
    } catch (error) {
      if (error instanceof ChangeRequestApiError && error.status === 403) {
        setForbidden(true);
      }
      setListError(formatChangeRequestApiError(error, "刷新审核队列失败"));
    } finally {
      setRefreshing(false);
    }
  }

  async function handleLoadMore() {
    setLoadingMore(true);
    setListError(null);
    try {
      const result = await listReviewerChangeRequests(statusFilter, undefined, {
        limit: 50,
        offset: items.length,
      });
      setItems((prev) => {
        const existingIds = new Set(prev.map((item) => item.id));
        const appended = result.changeRequests.filter((item) => !existingIds.has(item.id));
        return [...prev, ...appended];
      });
      setTotal(result.total);
    } catch (error) {
      setListError(formatChangeRequestApiError(error, "加载更多变更单失败"));
    } finally {
      setLoadingMore(false);
    }
  }

  async function handleStatusChange(nextStatus: ChangeRequestStatus) {
    setStatusFilter(nextStatus);
    setNotice(null);
    setNoticeLockError(null);
    await navigate({
      to: "/reviewer",
      search: nextStatus === "needs_review" ? {} : { status: nextStatus },
      replace: true,
    });
  }

  function setCardReason(id: string, value: string) {
    setReasonsById((prev) => ({ ...prev, [id]: value }));
  }

  function clearCardError(id: string) {
    setCardErrors((prev) => {
      if (!(id in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  async function handleApprove(cr: ChangeRequestRecord) {
    clearCardError(cr.id);
    setNoticeLockError(null);
    setBusyById((prev) => ({ ...prev, [cr.id]: "approving" }));

    try {
      const reason = reasonsById[cr.id]?.trim() || undefined;
      const result = await approveChangeRequest(cr.id, reason);

      setItems((prev) => prev.filter((item) => item.id !== cr.id));
      setTotal((prev) => Math.max(0, prev - 1));
      setNotice({
        kind: "approved",
        changeRequestId: cr.id,
        mediaId: result.mediaId,
        associationId: result.associationId,
        message: `变更单 ${cr.id.slice(0, 8)} 已通过，关联与新版本已生效。`,
      });

      try {
        await reloadQueue(statusFilter);
      } catch {
        // Optimistic removal already updated the queue.
      }
    } catch (error) {
      setCardErrors((prev) => ({
        ...prev,
        [cr.id]: formatChangeRequestApiError(error, "通过变更单失败，请稍后重试"),
      }));
    } finally {
      setBusyById((prev) => {
        const next = { ...prev };
        delete next[cr.id];
        return next;
      });
    }
  }

  async function handleReject(cr: ChangeRequestRecord) {
    clearCardError(cr.id);
    setNoticeLockError(null);
    const reason = (reasonsById[cr.id] ?? "").trim();
    if (reason.length === 0) {
      setCardErrors((prev) => ({
        ...prev,
        [cr.id]: "驳回时请填写理由，便于提交者了解原因",
      }));
      return;
    }

    setBusyById((prev) => ({ ...prev, [cr.id]: "rejecting" }));
    try {
      await rejectChangeRequest(cr.id, reason);

      setItems((prev) => prev.filter((item) => item.id !== cr.id));
      setTotal((prev) => Math.max(0, prev - 1));
      setNotice({
        kind: "rejected",
        changeRequestId: cr.id,
        message: `变更单 ${cr.id.slice(0, 8)} 已驳回。`,
      });

      try {
        await reloadQueue(statusFilter);
      } catch {
        // Optimistic removal already updated the queue.
      }
    } catch (error) {
      setCardErrors((prev) => ({
        ...prev,
        [cr.id]: formatChangeRequestApiError(error, "驳回变更单失败，请稍后重试"),
      }));
    } finally {
      setBusyById((prev) => {
        const next = { ...prev };
        delete next[cr.id];
        return next;
      });
    }
  }

  async function handleLockForCard(cr: ChangeRequestRecord, associationId: string) {
    clearCardError(cr.id);
    setBusyById((prev) => ({ ...prev, [cr.id]: "locking" }));
    try {
      const reason = reasonsById[cr.id]?.trim() || undefined;
      await lockAssociation(associationId, { locked: true, reason });
      setLockedAssociations((prev) => ({ ...prev, [associationId]: true }));
      setNotice({
        kind: "locked",
        changeRequestId: cr.id,
        mediaId: cr.mediaId,
        associationId,
        message: `关联 ${associationId.slice(0, 8)} 已锁定，后续新提交将不会自动覆盖它。`,
      });
    } catch (error) {
      setCardErrors((prev) => ({
        ...prev,
        [cr.id]: formatChangeRequestApiError(error, "锁定关联失败"),
      }));
    } finally {
      setBusyById((prev) => {
        const next = { ...prev };
        delete next[cr.id];
        return next;
      });
    }
  }

  async function handleLockFromNotice(
    associationId: string,
    changeRequestId: string,
    mediaId?: string | null,
  ) {
    setLockingNoticeAssoc(true);
    setNoticeLockError(null);
    try {
      await lockAssociation(associationId, { locked: true });
      setLockedAssociations((prev) => ({ ...prev, [associationId]: true }));
      setNotice({
        kind: "locked",
        changeRequestId,
        mediaId,
        associationId,
        message: `关联 ${associationId.slice(0, 8)} 已锁定，后续新提交将不会自动覆盖它。`,
      });
    } catch (error) {
      setNoticeLockError(formatChangeRequestApiError(error, "锁定关联失败"));
    } finally {
      setLockingNoticeAssoc(false);
    }
  }

  return (
    <main className="page-wrap space-y-6 px-4 pt-8 pb-10 sm:pt-10">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1.5">
          <p className="island-kicker m-0">人工审核</p>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="display-title m-0 text-3xl font-bold tracking-tight text-[var(--sea-ink)] sm:text-4xl">
              审核员队列
            </h1>
            <span className="rounded-full border border-[var(--line)] bg-[var(--chip-bg)] px-3 py-1 text-xs font-bold text-[var(--sea-ink)]">
              当前队列 {total} 条
            </span>
          </div>
          <p className="m-0 max-w-2xl text-sm leading-relaxed text-[var(--sea-ink-soft)]">
            审阅证据门转人工的变更单，核对取证结果、冲突原因、变体与段，并执行通过、驳回或锁定关联操作。
          </p>
        </div>

        <button
          type="button"
          onClick={() => void reloadQueue(statusFilter)}
          disabled={refreshing}
          className="btn-secondary self-start sm:self-auto"
        >
          <RefreshIcon className={refreshing ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
          <span>{refreshing ? "刷新中..." : "刷新队列"}</span>
        </button>
      </header>

      {/* Status filter tabs */}
      <div
        role="tablist"
        aria-label="按变更单状态筛选"
        className="flex flex-wrap items-center gap-2"
      >
        {CHANGE_REQUEST_STATUS_LIST.map((st) => {
          const meta = CHANGE_REQUEST_STATUS_META[st];
          const active = statusFilter === st;
          return (
            <button
              key={st}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => void handleStatusChange(st)}
              className={
                active
                  ? "btn-primary px-4 py-2 text-xs sm:text-sm"
                  : "btn-secondary px-4 py-2 text-xs sm:text-sm"
              }
            >
              <span>{meta.label}</span>
              <span className="font-mono text-[11px] opacity-75">({st})</span>
            </button>
          );
        })}
      </div>

      {/* Recently completed action banner */}
      {notice ? (
        <section
          role="status"
          className="rise-in space-y-2.5 rounded-2xl border border-[var(--ok-border)] bg-[var(--ok-bg)] p-4 sm:p-5"
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-2 text-sm font-semibold text-[var(--ok-ink)]">
              <CheckIcon className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{notice.message}</span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Link
                to="/change-requests/$id"
                params={{ id: notice.changeRequestId }}
                className="btn-secondary px-3 py-1.5 text-xs"
              >
                查看变更单
              </Link>
              {notice.mediaId ? (
                <a
                  href={`/media/${encodeURIComponent(notice.mediaId)}`}
                  className="btn-secondary px-3 py-1.5 text-xs"
                >
                  <span>查看媒体页</span>
                  <ExternalLinkIcon className="h-3.5 w-3.5" />
                </a>
              ) : null}
              {notice.associationId && !lockedAssociations[notice.associationId] ? (
                <button
                  type="button"
                  onClick={() =>
                    void handleLockFromNotice(
                      notice.associationId!,
                      notice.changeRequestId,
                      notice.mediaId,
                    )
                  }
                  disabled={lockingNoticeAssoc}
                  className="btn-secondary px-3 py-1.5 text-xs"
                >
                  <LockIcon className="h-3.5 w-3.5" />
                  <span>{lockingNoticeAssoc ? "锁定中..." : "锁定该关联"}</span>
                </button>
              ) : null}
              {notice.associationId && lockedAssociations[notice.associationId] ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-[var(--ok-border)] bg-[var(--surface-strong)] px-2.5 py-1 text-xs font-bold text-[var(--ok-ink)]">
                  <LockIcon className="h-3 w-3" />
                  已锁定
                </span>
              ) : null}
            </div>
          </div>

          {noticeLockError ? (
            <p className="m-0 text-xs font-semibold text-[var(--warn-ink)]">{noticeLockError}</p>
          ) : null}
        </section>
      ) : null}

      {/* Forbidden or load error */}
      {forbidden ? (
        <section
          role="alert"
          className="island-shell rounded-3xl border-[var(--danger-border)] p-6 sm:p-8"
        >
          <div className="flex items-start gap-3 text-[var(--danger-ink)]">
            <AlertTriangleIcon className="mt-0.5 h-5 w-5 shrink-0" />
            <div className="space-y-2">
              <h2 className="m-0 text-base font-bold">403 · 无权访问审核员队列</h2>
              <p className="m-0 text-sm text-[var(--sea-ink)]">{listError}</p>
              <Link to="/" className="btn-secondary mt-2 inline-flex text-xs">
                返回工作台
              </Link>
            </div>
          </div>
        </section>
      ) : listError ? (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-2xl border border-[var(--danger-border)] bg-[var(--danger-bg)] p-4 text-sm text-[var(--danger-ink)]"
        >
          <AlertTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{listError}</span>
        </div>
      ) : null}

      {/* Empty queue state */}
      {!forbidden && !listError && items.length === 0 ? (
        <section className="island-shell rounded-3xl px-6 py-14 text-center">
          <div className="mx-auto mb-3 inline-flex h-12 w-12 items-center justify-center rounded-2xl border border-[var(--line)] bg-[var(--chip-bg)] text-[var(--lagoon-deep)]">
            <ShieldCheckIcon />
          </div>
          <h2 className="m-0 text-base font-bold text-[var(--sea-ink)]">
            当前「{CHANGE_REQUEST_STATUS_META[statusFilter].label}」队列为空
          </h2>
          <p className="mt-1.5 mb-0 text-xs text-[var(--sea-ink-soft)]">
            {statusFilter === "needs_review"
              ? "所有转人工变更单都已处理完毕。"
              : "没有符合该状态的变更单记录。"}
          </p>
        </section>
      ) : null}

      {/* Queue cards */}
      {!forbidden && items.length > 0 ? (
        <div className="space-y-5">
          {items.map((cr) => {
            const busyState = busyById[cr.id];
            const isBusy = busyState !== undefined;
            const cardError = cardErrors[cr.id];
            const reasonValue = reasonsById[cr.id] ?? "";
            const linkedAssociationId = extractLinkedAssociationId(cr);
            const isAssocLocked = linkedAssociationId
              ? Boolean(lockedAssociations[linkedAssociationId])
              : false;
            const canDecide = cr.status === "needs_review";

            return (
              <article
                key={cr.id}
                className="island-shell rise-in space-y-4 rounded-3xl p-5 sm:p-6"
              >
                {/* Card Header */}
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={cr.status} />
                      <NamespaceBadge namespace={cr.namespace} />
                      <span className="rounded-full border border-[var(--line)] bg-[var(--chip-bg)] px-2.5 py-0.5 text-xs font-semibold text-[var(--sea-ink-soft)]">
                        {cr.submitterType === "agent" ? "探索 agent" : "人工提交"}
                      </span>
                      {isPlatformNamespace(cr.namespace) && cr.setDefaultVariant ? (
                        <span className="rounded-full border border-[var(--warn-border)] bg-[var(--warn-bg)] px-2.5 py-0.5 text-xs font-bold text-[var(--warn-ink)]">
                          请求设为默认变体
                        </span>
                      ) : null}
                    </div>

                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--sea-ink-soft)]">
                      <span>
                        变更单：<code className="font-mono text-[var(--sea-ink)]">{cr.id}</code>
                      </span>
                      <span>
                        提交者：<code className="font-mono">{cr.submitterUserId}</code>
                      </span>
                      <span>
                        提交于：
                        <time dateTime={cr.createdAt} suppressHydrationWarning>
                          {formatDateTime(cr.createdAt)}
                        </time>
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      to="/change-requests/$id"
                      params={{ id: cr.id }}
                      className="btn-secondary px-3 py-1.5 text-xs"
                    >
                      详情页
                    </Link>
                    {cr.mediaId ? (
                      <a
                        href={`/media/${encodeURIComponent(cr.mediaId)}`}
                        className="btn-secondary px-3 py-1.5 text-xs"
                      >
                        <span>媒体页</span>
                        <ExternalLinkIcon className="h-3.5 w-3.5" />
                      </a>
                    ) : null}
                  </div>
                </div>

                {/* Core fields */}
                <dl className="m-0 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <div className="rounded-xl border border-[var(--line)] bg-[var(--chip-bg)] px-3.5 py-2.5">
                    <dt className="text-[11px] font-semibold text-[var(--sea-ink-soft)]">
                      目标媒体
                    </dt>
                    <dd className="m-0 mt-1 space-y-0.5">
                      <code className="block font-mono text-xs font-bold break-all text-[var(--sea-ink)]">
                        {cr.targetExternalKey}
                      </code>
                      {cr.mediaId ? (
                        <span className="block font-mono text-[11px] break-all text-[var(--sea-ink-soft)]">
                          ID: {cr.mediaId}
                        </span>
                      ) : (
                        <span className="block text-[11px] text-[var(--warn-ink)]">
                          尚未建档，通过时将按 TMDB 自动建档
                        </span>
                      )}
                    </dd>
                  </div>

                  <div className="rounded-xl border border-[var(--line)] bg-[var(--chip-bg)] px-3.5 py-2.5">
                    <dt className="text-[11px] font-semibold text-[var(--sea-ink-soft)]">
                      规范原生 ID
                    </dt>
                    <dd className="m-0 mt-1 space-y-0.5">
                      <code className="block font-mono text-xs font-bold break-all text-[var(--sea-ink)]">
                        {cr.nativeId}
                      </code>
                      {cr.rawNativeId !== cr.nativeId ? (
                        <span className="block text-[11px] break-all text-[var(--sea-ink-soft)]">
                          原始输入：{cr.rawNativeId}
                        </span>
                      ) : null}
                    </dd>
                  </div>

                  <div className="rounded-xl border border-[var(--line)] bg-[var(--chip-bg)] px-3.5 py-2.5">
                    <dt className="text-[11px] font-semibold text-[var(--sea-ink-soft)]">变体</dt>
                    <dd className="m-0 mt-1 space-y-0.5 text-xs text-[var(--sea-ink)]">
                      {isPlatformNamespace(cr.namespace) ? (
                        <>
                          <span className="font-bold">
                            {cr.variantDescription || "指定已有变体"}
                          </span>
                          {cr.variantId ? (
                            <span className="block font-mono text-[11px] break-all text-[var(--sea-ink-soft)]">
                              {cr.variantId}
                            </span>
                          ) : null}
                        </>
                      ) : (
                        <span className="text-[var(--sea-ink-soft)]">目录关联（无变体）</span>
                      )}
                    </dd>
                  </div>
                </dl>

                {/* Conflict / Decision reason */}
                <ReasonCallout
                  status={cr.status}
                  conflictReason={cr.conflictReason}
                  decisionReason={cr.decisionReason}
                />

                {/* Segments */}
                <div className="space-y-2">
                  <h3 className="m-0 text-xs font-bold tracking-wide text-[var(--sea-ink-soft)] uppercase">
                    段（{cr.segments.length} 项）
                  </h3>
                  <SegmentsTable segments={cr.segments} compact />
                </div>

                {/* Evidence */}
                <div className="space-y-2">
                  <h3 className="m-0 text-xs font-bold tracking-wide text-[var(--sea-ink-soft)] uppercase">
                    取证结果
                  </h3>
                  <EvidencePanel evidence={cr.evidence} />
                </div>

                {/* Inline Reviewer Controls */}
                {canDecide || linkedAssociationId ? (
                  <div className="space-y-3 border-t border-[var(--line)] pt-4">
                    {cardError ? (
                      <div
                        role="alert"
                        className="flex items-start gap-2 rounded-xl border border-[var(--danger-border)] bg-[var(--danger-bg)] p-3 text-xs font-semibold text-[var(--danger-ink)]"
                      >
                        <AlertTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>{cardError}</span>
                      </div>
                    ) : null}

                    {canDecide ? (
                      <div className="space-y-1.5">
                        <label
                          htmlFor={`review-reason-${cr.id}`}
                          className="block text-xs font-semibold text-[var(--sea-ink)]"
                        >
                          审核理由（通过可选填，驳回必填）
                        </label>
                        <textarea
                          id={`review-reason-${cr.id}`}
                          rows={2}
                          placeholder="说明通过依据或驳回原因，将展示在变更单状态页供提交者查看"
                          value={reasonValue}
                          onChange={(event) => {
                            setCardReason(cr.id, event.target.value);
                            clearCardError(cr.id);
                          }}
                          disabled={isBusy}
                          className="field-input resize-y text-sm"
                        />
                      </div>
                    ) : null}

                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        {canDecide ? (
                          <>
                            <button
                              type="button"
                              onClick={() => void handleApprove(cr)}
                              disabled={isBusy}
                              className="btn-primary px-4 py-2 text-xs sm:text-sm"
                            >
                              <CheckIcon className="h-4 w-4" />
                              <span>{busyState === "approving" ? "通过中..." : "通过变更单"}</span>
                            </button>

                            <button
                              type="button"
                              onClick={() => void handleReject(cr)}
                              disabled={isBusy}
                              className="btn-danger px-4 py-2 text-xs sm:text-sm"
                            >
                              <XCircleIcon className="h-4 w-4" />
                              <span>{busyState === "rejecting" ? "驳回中..." : "驳回"}</span>
                            </button>
                          </>
                        ) : null}
                      </div>

                      {linkedAssociationId ? (
                        isAssocLocked ? (
                          <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--ok-border)] bg-[var(--ok-bg)] px-3 py-1 text-xs font-bold text-[var(--ok-ink)]">
                            <LockIcon className="h-3.5 w-3.5" />
                            <span>关联已锁定</span>
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => void handleLockForCard(cr, linkedAssociationId)}
                            disabled={isBusy}
                            className="btn-secondary px-3.5 py-2 text-xs"
                          >
                            <LockIcon className="h-3.5 w-3.5" />
                            <span>{busyState === "locking" ? "锁定中..." : "锁定关联"}</span>
                          </button>
                        )
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </article>
            );
          })}

          {items.length < total ? (
            <div className="flex justify-center pt-2">
              <button
                type="button"
                onClick={() => void handleLoadMore()}
                disabled={loadingMore}
                className="btn-secondary px-5 py-2 text-sm"
              >
                {loadingMore ? "加载中..." : `加载更多（已显示 ${items.length} / ${total}）`}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </main>
  );
}
