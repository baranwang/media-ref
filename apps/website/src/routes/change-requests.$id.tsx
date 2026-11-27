import { Code, ConnectError } from "@connectrpc/connect";
import { Alert, AlertDescription, AlertTitle } from "@media-ref/ui/components/alert";
import { Avatar, AvatarFallback } from "@media-ref/ui/components/avatar";
import { Badge } from "@media-ref/ui/components/badge";
import { Button } from "@media-ref/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@media-ref/ui/components/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@media-ref/ui/components/empty";
import { Skeleton } from "@media-ref/ui/components/skeleton";
import { cn } from "@media-ref/ui/lib/utils";
import { RiArrowLeftSLine, RiArrowRightUpLine } from "@remixicon/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { NAMESPACE_LABELS, NamespaceLogo } from "#/components/brand-logos";
import { CheckItemRow } from "#/components/check-item-row";
import { CommentComposer, CommentThread } from "#/components/comment-thread";
import { ReviewAgentNote } from "#/components/review-agent-note";
import { TopNav } from "#/components/top-nav";
import { useAppStore } from "#/lib/app-store";
import { formatDateTime, formatEpisodeRange } from "#/lib/format";
import { conflictTagFor } from "#/lib/mappers";
import { cardsByKeyQuery, changeRequestQuery } from "#/lib/queries";
import type { ChangeRequestItem } from "#/lib/types";

export const Route = createFileRoute("/change-requests/$id")({
  component: ChangeRequestDetailPage,
});

function isMissing(error: unknown): boolean {
  return (
    error instanceof ConnectError &&
    (error.code === Code.NotFound || error.code === Code.InvalidArgument)
  );
}

function segmentLabel(s: ChangeRequestItem["segments"][number]): string {
  return `第 ${s.season} 季 ${formatEpisodeRange(s.start, s.end)}`;
}

function elapsedLabel(from: string, to: string): string {
  const minutes = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 60_000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} 小时` : `${Math.round(hours / 24)} 天`;
}

function ChangeRequestDetailPage() {
  const { id } = Route.useParams();
  const { user, sessionChecked } = useAppStore();
  const query = useQuery({ ...changeRequestQuery(id), enabled: !!user });
  const cr = query.data;
  const { data: cards } = useQuery(cardsByKeyQuery(cr ? [cr.targetKey] : []));
  const media = cr ? cards?.[cr.targetKey] : undefined;

  if (sessionChecked && !user) {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <TopNav />
        <main className="container py-28">
          <Empty>
            <EmptyHeader>
              <EmptyTitle>登录后查看这张变更单</EmptyTitle>
              <EmptyDescription>变更单只对提交者和审核员可见。</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button nativeButton={false} render={<Link to="/login" />}>
                登录
              </Button>
            </EmptyContent>
          </Empty>
        </main>
      </div>
    );
  }

  if (query.isError && !isMissing(query.error)) {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <TopNav />
        <main className="container py-28">
          <Alert variant="destructive">
            <AlertTitle>变更单加载失败</AlertTitle>
            <AlertDescription>请稍后刷新重试。</AlertDescription>
          </Alert>
        </main>
      </div>
    );
  }

  if (!query.isError && cr === undefined) {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <TopNav />
        <section className="container flex flex-col gap-6 pt-8 sm:flex-row sm:items-start">
          <Skeleton className="h-39 w-26 shrink-0 rounded-lg" />
          <div className="flex flex-1 flex-col gap-3">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-9 w-72" />
            <Skeleton className="h-4 w-56" />
          </div>
        </section>
      </div>
    );
  }

  if (!cr) {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <TopNav />
        <main className="container flex flex-col items-center justify-center py-28 text-center">
          <h1 className="text-xl font-semibold">找不到这张变更单</h1>
          <p className="mt-2 text-sm text-muted-foreground">编号 #{id} 不存在，或你没有查看权限</p>
          <Button className="mt-6" nativeButton={false} render={<Link to="/change-requests" />}>
            返回我的变更单
          </Button>
        </main>
      </div>
    );
  }

  const conflictTag = cr.status === "approved" ? null : conflictTagFor(cr.conflictReason);
  const segmentsText = cr.segments.map(segmentLabel).join("、");
  const statusMeta =
    cr.status === "approved"
      ? { label: "已通过", variant: "confirmed" as const }
      : cr.status === "rejected"
        ? { label: "已驳回", variant: "destructive" as const }
        : { label: "待审核", variant: "warning" as const };

  return (
    <div className="relative min-h-screen bg-background text-foreground">
      {/* Page-level backdrop with smooth fade matching Figma 03B */}
      {media?.posterUrl && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-84 overflow-hidden"
        >
          <img
            src={media.posterUrl}
            alt=""
            referrerPolicy="no-referrer"
            className="h-full w-full scale-105 object-cover object-center opacity-30 blur-xs"
          />
          <div className="absolute inset-0 bg-linear-to-b from-background/0 from-30% to-background" />
          <div className="absolute inset-0 bg-linear-to-r from-background via-background/85 via-30% to-background/15" />
        </div>
      )}

      <TopNav transparent />

      <section className="relative z-10 container flex flex-col gap-5 pt-8 pb-8">
        <Link
          to="/change-requests"
          className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <RiArrowLeftSLine className="size-4" />
          我的变更单
        </Link>

        <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
          {media?.posterUrl && (
            <img
              src={media.posterUrl}
              alt={media.title}
              referrerPolicy="no-referrer"
              className="h-39 w-26 shrink-0 rounded-lg object-cover shadow-lg ring-1 ring-white/10"
            />
          )}

          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="text-xs text-muted-foreground">
              变更单 · {formatDateTime(cr.createdAt)} 提交
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-3xl leading-9 font-bold tracking-tight text-foreground">
                {media?.title ?? cr.pageTitle ?? cr.nativeId}
              </h1>
              <Badge variant={statusMeta.variant}>{statusMeta.label}</Badge>
              {conflictTag && <Badge variant="warning">{conflictTag}</Badge>}
            </div>

            <p className="text-sm text-muted-foreground">
              {NAMESPACE_LABELS[cr.namespace]}
              {cr.variantLabel ? ` · ${cr.variantLabel.replace("（默认）", "")}` : ""}
              {cr.pageTitle ? ` · 平台页面「${cr.pageTitle}」` : ""}
            </p>

            <div className="text-xs text-muted-foreground">
              编号 <span className="font-mono text-foreground/85">#{cr.id}</span>
            </div>

            {media && (
              <div className="pt-2">
                <Button
                  variant="outline"
                  size="default"
                  nativeButton={false}
                  render={<Link to="/media/$mediaId" params={{ mediaId: media.id }} />}
                >
                  查看媒体页
                  <RiArrowRightUpLine />
                </Button>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Body Grid (Left detail cards + Right timeline) */}
      <main className="relative z-10 container grid grid-cols-1 gap-8 pb-20 lg:grid-cols-12">
        <div className="flex flex-col gap-8 lg:col-span-8">
          {cr.status !== "approved" && cr.liveChangeRequestId && (
            <Alert variant="confirmed">
              <AlertTitle>这个合集已经生效</AlertTitle>
              <AlertDescription>
                后来另一张变更单把它关联上了，按集查询已经能用。
                <Link
                  to="/change-requests/$id"
                  params={{ id: cr.liveChangeRequestId }}
                  className="ml-1 font-medium underline underline-offset-4"
                >
                  查看那张变更单
                </Link>
              </AlertDescription>
            </Alert>
          )}
          {/* 提交的内容 */}
          <section className="flex flex-col gap-3">
            <div>
              <h2 className="text-xl leading-7 font-bold tracking-tight text-foreground">
                提交的内容
              </h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                你把{NAMESPACE_LABELS[cr.namespace]}上的一个播放页，对应到
                {media?.type === "movie" ? "这部电影" : `这部剧的${segmentsText}`}
              </p>
            </div>

            <Card>
              <CardContent className="flex flex-col gap-4 pt-4">
                <dl className="divide-y divide-border/60 text-xs">
                  <div className="flex items-center gap-3 py-2.5 first:pt-0">
                    <dt className="w-24 shrink-0 text-muted-foreground">平台</dt>
                    <dd className="flex items-center gap-2 font-medium text-foreground">
                      <NamespaceLogo namespace={cr.namespace} className="size-5" />
                      {NAMESPACE_LABELS[cr.namespace]}
                    </dd>
                  </div>
                  <div className="flex items-center gap-3 py-2.5">
                    <dt className="w-24 shrink-0 text-muted-foreground">
                      {cr.pageLink?.source === "submission" ? "提交时的链接" : "条目链接"}
                    </dt>
                    <dd className="min-w-0 flex-1">
                      {cr.pageLink ? (
                        <a
                          href={cr.pageLink.href}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex max-w-full items-center gap-1 truncate font-mono text-xs text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
                        >
                          <span className="truncate">{cr.pageLink.href}</span>
                          <RiArrowRightUpLine className="size-3.5 shrink-0" />
                        </a>
                      ) : (
                        <span className="font-mono">{cr.nativeId}</span>
                      )}
                    </dd>
                  </div>
                  <div className="flex items-center gap-3 py-2.5">
                    <dt className="w-24 shrink-0 text-muted-foreground">页面标题</dt>
                    <dd className="min-w-0 flex-1 text-foreground">
                      {cr.pageTitle ?? cr.nativeId}
                      {cr.pageEpisodeCount ? ` · 共 ${cr.pageEpisodeCount} 集` : ""}
                    </dd>
                  </div>
                  {cr.variantLabel && (
                    <div className="flex items-center gap-3 py-2.5">
                      <dt className="w-24 shrink-0 text-muted-foreground">版本</dt>
                      <dd className="min-w-0 flex-1 text-foreground">{cr.variantLabel}</dd>
                    </div>
                  )}
                  <div className="flex items-center gap-3 py-2.5 last:pb-0">
                    <dt className="w-24 shrink-0 text-muted-foreground">对应集数</dt>
                    <dd className="flex min-w-0 flex-1 flex-col gap-1 font-medium text-foreground">
                      {cr.segments.map((s) => (
                        <span key={`${s.season}-${s.start}`}>
                          {segmentLabel(s)}
                          {s.targetStart !== s.start && (
                            <span className="font-normal text-muted-foreground">
                              {" "}
                              · 平台从第 {s.targetStart} 集起
                            </span>
                          )}
                        </span>
                      ))}
                    </dd>
                  </div>
                </dl>
              </CardContent>
            </Card>
          </section>

          {/* 自动核对 */}
          <section className="flex flex-col gap-3">
            <div>
              <h2 className="text-xl leading-7 font-bold tracking-tight text-foreground">
                自动核对
              </h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                提交后，系统自动打开平台页面核对了这 {cr.checks.length} 件事
              </p>
            </div>

            <Card>
              <CardContent className="divide-y divide-border/60 pt-4">
                {cr.checks.map((chk) => (
                  <CheckItemRow key={chk.id} item={chk} showBadge />
                ))}
              </CardContent>
            </Card>
          </section>

          {cr.reviewedByAgent && cr.reviewAgent ? (
            <section className="flex flex-col gap-3">
              <h2 className="text-xl leading-7 font-bold tracking-tight text-foreground">
                {cr.reviewAgent.verdict === "approve" || cr.reviewAgent.verdict === "keep"
                  ? "审核 agent 的理由"
                  : cr.reviewAgent.verdict.startsWith("revoke")
                    ? "审核 agent 撤下"
                    : "审核 agent 驳回"}
              </h2>
              <Card>
                <CardContent className="pt-4">
                  <ReviewAgentNote
                    agent={cr.reviewAgent}
                    time={cr.reviewedAt}
                    fallback={cr.decisionReason}
                  />
                </CardContent>
              </Card>
            </section>
          ) : (
            /* 审核员留言：自动生效时 decisionReason 是内部代码，不显示 */
            cr.reviewerUserId &&
            cr.decisionReason && (
              <section className="flex flex-col gap-3">
                <h2 className="text-xl leading-7 font-bold tracking-tight text-foreground">
                  审核员留言
                </h2>
                <Card>
                  <CardContent className="flex items-start gap-3 pt-4">
                    <Avatar size="default">
                      <AvatarFallback className="bg-muted text-xs font-medium text-foreground">
                        审
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-medium text-foreground">审核员</span>
                        <span className="text-muted-foreground">
                          {formatDateTime(cr.reviewedAt)}
                        </span>
                      </div>
                      <p className="mt-1.5 text-sm leading-6 text-foreground/90">
                        {cr.decisionReason}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              </section>
            )
          )}

          {/* 留言：人和审核 agent 的对话 */}
          <section className="flex flex-col gap-3">
            <div>
              <h2 className="text-xl leading-7 font-bold tracking-tight text-foreground">留言</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                觉得哪里不对，或者想让它通过、驳回，就在这里说。留言是给审核 agent 的线索，不是决定
              </p>
            </div>
            <Card>
              <CardContent className="flex flex-col gap-6 pt-4">
                <CommentThread changeRequestId={cr.id} />
                <CommentComposer changeRequestId={cr.id} />
              </CardContent>
            </Card>
          </section>
        </div>

        {/* Right column: Timeline */}
        <aside className="flex flex-col gap-3 lg:col-span-4">
          <div>
            <h2 className="text-xl leading-7 font-bold tracking-tight text-foreground">进度</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {cr.status === "approved"
                ? cr.reviewedAt
                  ? `${cr.reviewedByAgent ? "审核 agent 已批准，" : cr.reviewerUserId ? "" : "自动核对通过，"}从提交到生效用了 ${elapsedLabel(cr.createdAt, cr.reviewedAt)}`
                  : "关联已经生效"
                : cr.status === "rejected"
                  ? "本次变更单已被驳回"
                  : cr.status === "pending_evidence"
                    ? "正在自动核对平台页面"
                    : "正在等待审核 agent 判定"}
            </p>
          </div>

          <Card>
            <CardHeader className="sr-only">
              <CardTitle>处理进度</CardTitle>
              <CardDescription>变更单状态流转时间线</CardDescription>
            </CardHeader>
            <CardContent className="pt-4">
              <ol className="relative flex flex-col gap-5 before:absolute before:top-2 before:bottom-2 before:left-1.25 before:w-px before:bg-border">
                {cr.timeline.map((step, idx) => (
                  <li key={`${step.label}-${idx}`} className="relative flex gap-3 pl-5">
                    <span
                      className={cn(
                        "absolute top-1.5 left-0 size-2.5 rounded-full ring-2 ring-card",
                        step.state === "done"
                          ? "bg-status-confirmed-fg"
                          : step.state === "current"
                            ? "bg-status-warning-fg"
                            : "bg-muted-foreground/40",
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="font-medium text-foreground">{step.label}</span>
                        <span className="shrink-0 font-mono text-2xs text-muted-foreground">
                          {step.time}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">{step.detail}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </aside>
      </main>
    </div>
  );
}
