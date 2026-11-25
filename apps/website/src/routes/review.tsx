import { Alert, AlertDescription, AlertTitle } from "@media-ref/ui/components/alert";
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
import { Label } from "@media-ref/ui/components/label";
import { Skeleton } from "@media-ref/ui/components/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@media-ref/ui/components/tabs";
import { Textarea } from "@media-ref/ui/components/textarea";
import { cn } from "@media-ref/ui/lib/utils";
import { RiArrowRightUpLine } from "@remixicon/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { NAMESPACE_LABELS, NamespaceLogo } from "#/components/brand-logos";
import { CheckItemRow } from "#/components/check-item-row";
import { CoverageLegend, CoverageRuler, CoverageTrack } from "#/components/coverage-bar";
import { TopNav } from "#/components/top-nav";
import { useAppStore } from "#/lib/app-store";
import { formatEpisodeRange, formatRelativeTime } from "#/lib/format";
import { conflictTagFor } from "#/lib/mappers";
import {
  browserClients,
  cardsByKeyQuery,
  mediaDetailQuery,
  reviewAlertsQuery,
  reviewQueueQuery,
} from "#/lib/queries";
import type { CardItem, ChangeRequestItem, CoverageSegment } from "#/lib/types";

export const Route = createFileRoute("/review")({
  component: ReviewWorkbenchPage,
});

function queueTagFor(cr: ChangeRequestItem): string | null {
  return (
    conflictTagFor(cr.conflictReason) ?? (cr.status === "pending_evidence" ? "自动核对中" : null)
  );
}

/** "第 a–b 集" spanning every bar, or "无记录". */
function spanLabel(segments: CoverageSegment[]): string {
  if (segments.length === 0) return "无记录";
  return formatEpisodeRange(
    Math.min(...segments.map((s) => s.start)),
    Math.max(...segments.map((s) => s.end)),
  );
}

function ErrorAlert({ title, error }: { title: string; error: Error }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{error.message}</AlertDescription>
    </Alert>
  );
}

function GateMessage({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <Empty className="mt-6 rounded-xl border border-border bg-card py-16">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}

function ReviewWorkbenchPage() {
  const { user, sessionChecked } = useAppStore();
  const canReview = user?.role === "reviewer" || user?.role === "owner";
  const queryClient = useQueryClient();

  const queueQuery = useQuery({ ...reviewQueueQuery(), enabled: canReview });
  const alertsQuery = useQuery({ ...reviewAlertsQuery(), enabled: canReview });
  const pendingQueue = queueQuery.data ?? [];
  const openAlerts = alertsQuery.data ?? [];
  const cardsQuery = useQuery(cardsByKeyQuery(pendingQueue.map((cr) => cr.targetKey)));
  const cards = cardsQuery.data ?? {};

  const resolveAlert = useMutation({
    mutationFn: (alertId: string) => browserClients().reviewer.resolveReviewAlert({ alertId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: reviewAlertsQuery().queryKey }),
  });

  const [activeTab, setActiveTab] = useState<"queue" | "alerts">("queue");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selectedCr = pendingQueue.find((c) => c.id === selectedId) ?? pendingQueue[0] ?? null;

  const selectNextAfter = (id: string) => {
    const index = pendingQueue.findIndex((c) => c.id === id);
    setSelectedId(pendingQueue[index + 1]?.id ?? pendingQueue[index - 1]?.id ?? null);
  };

  let body: ReactNode;
  if (!sessionChecked) {
    body = <Skeleton className="mt-6 h-96 w-full rounded-xl" />;
  } else if (!user) {
    body = (
      <GateMessage
        title="登录后才能审核"
        description="审核工作台只对审核员开放，请先登录。"
        action={
          <Button nativeButton={false} render={<Link to="/login" />}>
            登录
          </Button>
        }
      />
    );
  } else if (!canReview) {
    body = (
      <GateMessage
        title="没有审核权限"
        description="你的账号还不是审核员。需要审核权限请联系管理员。"
      />
    );
  } else {
    body = (
      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as "queue" | "alerts")}
        className="mt-6"
      >
        <TabsList className="grid w-full max-w-xs grid-cols-2">
          <TabsTrigger value="queue" className="gap-1.5 px-3">
            <span>待审核</span>
            <span className="font-mono text-2xs text-muted-foreground">
              {queueQuery.data?.length}
            </span>
          </TabsTrigger>
          <TabsTrigger value="alerts" className="gap-1.5 px-3">
            <span>告警</span>
            <span className="font-mono text-2xs text-muted-foreground">
              {alertsQuery.data?.length}
            </span>
          </TabsTrigger>
        </TabsList>

        {/* 04A: Review Queue */}
        <TabsContent value="queue" className="mt-6">
          {queueQuery.isPending ? (
            <div className="flex flex-col items-start gap-8 lg:flex-row">
              <Skeleton className="h-96 w-full shrink-0 rounded-xl lg:w-96" />
              <Skeleton className="h-96 w-full min-w-0 flex-1 rounded-xl" />
            </div>
          ) : queueQuery.isError ? (
            <ErrorAlert title="审核队列加载失败" error={queueQuery.error} />
          ) : pendingQueue.length === 0 ? (
            <Empty className="rounded-xl border border-border bg-card py-16">
              <EmptyHeader>
                <EmptyTitle>当前没有待审核的变更单</EmptyTitle>
                <EmptyDescription>所有需要人工确认的变更单都已经处理完了。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="flex flex-col items-start gap-8 lg:flex-row">
              {/* Left Queue List */}
              <Card className="w-full shrink-0 overflow-hidden lg:w-96">
                <CardHeader className="border-b border-border/70 pb-3">
                  <CardTitle>{pendingQueue.length} 张变更单等你处理</CardTitle>
                  <CardDescription>最新提交的在最上面</CardDescription>
                </CardHeader>
                <CardContent className="p-2">
                  <div className="flex flex-col gap-1">
                    {pendingQueue.map((cr) => {
                      const card = cards[cr.targetKey];
                      const active = selectedCr?.id === cr.id;
                      const first = cr.segments[0];
                      const tag = queueTagFor(cr);
                      return (
                        <button
                          key={cr.id}
                          type="button"
                          onClick={() => setSelectedId(cr.id)}
                          className={cn(
                            "flex w-full items-start gap-3 rounded-lg p-2.5 text-left transition-colors",
                            active ? "bg-accent ring-1 ring-border" : "hover:bg-muted/50",
                          )}
                        >
                          {card?.posterUrl && (
                            <img
                              src={card.posterUrl}
                              alt={card.title}
                              className="h-13.5 w-9 shrink-0 rounded object-cover ring-1 ring-border/70"
                            />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <span className="truncate text-sm font-medium text-foreground">
                                {card?.title ?? cr.pageTitle ?? cr.nativeId}
                              </span>
                              <span className="shrink-0 text-2xs text-muted-foreground">
                                {formatRelativeTime(cr.createdAt)}
                              </span>
                            </div>
                            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                              <NamespaceLogo namespace={cr.namespace} className="size-3.5" />
                              <span className="truncate">
                                {NAMESPACE_LABELS[cr.namespace]}
                                {first &&
                                  ` · 第 ${first.season} 季 ${formatEpisodeRange(first.start, first.end)}`}
                              </span>
                            </div>
                            <div className="mt-1.5 flex items-center gap-2">
                              {tag && <Badge variant="warning">{tag}</Badge>}
                              <span className="truncate font-mono text-2xs text-muted-foreground">
                                {cr.submitterUserId.slice(0, 8)} 提交
                              </span>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>

              {/* Right Detail Inspection Pane */}
              {selectedCr && (
                <ReviewDetail
                  key={selectedCr.id}
                  cr={selectedCr}
                  card={cards[selectedCr.targetKey]}
                  onDecided={() => selectNextAfter(selectedCr.id)}
                />
              )}
            </div>
          )}
        </TabsContent>

        {/* 04B: Review Alerts */}
        <TabsContent value="alerts" className="mt-6">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <h2 className="text-xl leading-7 font-bold tracking-tight text-foreground">
                需要处理的告警
              </h2>
              <p className="text-sm text-muted-foreground">
                系统发现的问题，比如播放页打不开、两条记录重叠。处理完后会自动从这里消失
              </p>
            </div>

            {resolveAlert.isError && <ErrorAlert title="标记告警失败" error={resolveAlert.error} />}

            {alertsQuery.isPending ? (
              <Skeleton className="h-40 w-full rounded-xl" />
            ) : alertsQuery.isError ? (
              <ErrorAlert title="告警加载失败" error={alertsQuery.error} />
            ) : openAlerts.length === 0 ? (
              <Empty className="rounded-xl border border-border bg-card py-16">
                <EmptyHeader>
                  <EmptyTitle>所有告警都已处理</EmptyTitle>
                  <EmptyDescription>目前没有待处理的异常记录。</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="overflow-hidden rounded-xl border border-border bg-card">
                <div className="divide-y divide-border/70">
                  {openAlerts.map((alert) => (
                    <div
                      key={alert.id}
                      className="flex flex-wrap items-center justify-between gap-4 px-5 py-4"
                    >
                      <div className="flex min-w-0 flex-1 items-start gap-3.5">
                        {alert.namespace && (
                          <NamespaceLogo
                            namespace={alert.namespace}
                            className="mt-0.5 size-7 shrink-0"
                          />
                        )}
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge
                              variant={alert.severity === "destructive" ? "destructive" : "warning"}
                            >
                              {alert.badge}
                            </Badge>
                            <span className="text-sm font-medium text-foreground">
                              {alert.title}
                            </span>
                          </div>
                          <p className="mt-1 text-xs leading-5 text-muted-foreground">
                            {alert.description}
                          </p>
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-4">
                        <span className="text-xs text-muted-foreground">
                          {formatRelativeTime(alert.createdAt)}
                        </span>
                        <div className="flex items-center gap-2">
                          {alert.mediaId && (
                            <Button
                              variant="outline"
                              size="default"
                              nativeButton={false}
                              render={
                                <Link to="/media/$mediaId" params={{ mediaId: alert.mediaId }} />
                              }
                            >
                              去核对
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            size="default"
                            disabled={resolveAlert.isPending && resolveAlert.variables === alert.id}
                            onClick={() => resolveAlert.mutate(alert.id)}
                          >
                            标记为已处理
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <TopNav />

      <main className="container flex flex-col pb-20">
        {/* Page Head */}
        <section className="flex flex-col gap-2 pt-12">
          <h1 className="text-3xl leading-9 font-bold tracking-tight text-foreground">审核</h1>
          <p className="text-sm text-muted-foreground">
            自动核对拿不准的变更单，和需要有人处理的告警，都在这里。
          </p>
        </section>

        {body}
      </main>
    </div>
  );
}

function ReviewDetail({
  cr,
  card,
  onDecided,
}: {
  cr: ChangeRequestItem;
  card: CardItem | undefined;
  onDecided: () => void;
}) {
  const queryClient = useQueryClient();
  const [decisionNote, setDecisionNote] = useState("");

  // The catalog key also resolves on the detail route, so new titles still get a season length.
  const mediaQuery = useQuery({
    ...mediaDetailQuery(cr.mediaId ?? cr.targetKey),
    enabled: Boolean(cr.mediaId ?? cr.targetKey),
  });
  const media = mediaQuery.data;

  const decide = useMutation({
    mutationFn: async (approve: boolean) => {
      const reviewer = browserClients().reviewer;
      const reason = decisionNote.trim();
      const input = { id: cr.id, ...(reason ? { reason } : {}) };
      await (approve ? reviewer.approveChangeRequest(input) : reviewer.rejectChangeRequest(input));
    },
    onSuccess: async () => {
      onDecided();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: reviewQueueQuery().queryKey }),
        cr.mediaId &&
          queryClient.invalidateQueries({ queryKey: mediaDetailQuery(cr.mediaId).queryKey }),
      ]);
    },
  });

  const primary = cr.segments[0];
  const season = primary?.season ?? 1;
  const seasonSegments = cr.segments.filter((s) => s.season === season);
  const totalSeasonEpisodes =
    media?.seasons.find((s) => s.season === season)?.episodeCount ??
    cr.pageEpisodeCount ??
    Math.max(1, ...seasonSegments.map((s) => s.end ?? s.start));

  // Titles not yet in the library have no existing coverage.
  const platformRow = cr.mediaId
    ? media?.platformRows.find(
        (row) =>
          row.namespace === cr.namespace &&
          (cr.variantLabel ? row.label === cr.variantLabel : row.isDefault),
      )
    : undefined;
  const existingSegments = platformRow?.segmentsBySeason[season] ?? [];
  const proposedSegments: CoverageSegment[] = seasonSegments.map((s, i) => ({
    id: `${cr.id}-${i}`,
    title: cr.pageTitle ?? cr.nativeId,
    nativeId: cr.nativeId,
    start: s.start,
    end: s.end ?? totalSeasonEpisodes,
    targetStart: s.targetStart,
    status: "pending",
    changeRequestId: cr.id,
  }));
  const afterSegments = [...existingSegments, ...proposedSegments];

  const passedCount = cr.checks.filter((c) => c.status === "passed").length;
  const failedCount = cr.checks.filter((c) => c.status === "failed").length;
  const warnCount = cr.checks.filter((c) => c.status === "needs_confirm").length;

  const tag = queueTagFor(cr);
  const title = card?.title ?? media?.title ?? cr.pageTitle ?? cr.nativeId;
  const posterUrl = card?.posterUrl ?? media?.posterUrl;
  const detailId = cr.mediaId ?? card?.id;
  const platformLabel = `${NAMESPACE_LABELS[cr.namespace]}${cr.variantLabel ?? ""}`;

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-10">
      {/* Detail Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-5">
          {posterUrl && (
            <img
              src={posterUrl}
              alt={title}
              className="h-27 w-18 shrink-0 rounded-lg object-cover ring-1 ring-border"
            />
          )}
          <div className="flex flex-col gap-1.5">
            <div className="text-xs text-muted-foreground">
              变更单 <span className="font-mono">#{cr.id}</span> ·{" "}
              <span className="font-mono">{cr.submitterUserId.slice(0, 8)}</span> 提交于{" "}
              {formatRelativeTime(cr.createdAt)}
            </div>
            <h2 className="text-2xl leading-8 font-bold tracking-tight text-foreground">
              {title} · 第 {season} 季
            </h2>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <NamespaceLogo namespace={cr.namespace} className="size-4.5" />
              <span>
                {NAMESPACE_LABELS[cr.namespace]}
                {cr.variantLabel ? ` · ${cr.variantLabel}` : ""}
                {primary && ` · 补充${formatEpisodeRange(primary.start, primary.end)}`}
              </span>
            </div>
            {tag && (
              <div className="pt-0.5">
                <Badge variant="warning">{tag}</Badge>
              </div>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {detailId && (
            <Button
              variant="outline"
              size="sm"
              nativeButton={false}
              render={<Link to="/media/$mediaId" params={{ mediaId: detailId }} />}
            >
              看媒体详情
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<a href={cr.pageUrl} target="_blank" rel="noreferrer" />}
          >
            打开播放页
            <RiArrowRightUpLine />
          </Button>
        </div>
      </div>

      {/* 通过后会怎样 (Section Head outside Card, matching Figma 04A) */}
      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h3 className="text-xl leading-7 font-bold tracking-tight text-foreground">
              通过后会怎样
            </h3>
            <p className="text-sm text-muted-foreground">
              第 {season} 季，以 TMDB 的 {totalSeasonEpisodes} 集为准。横条是{platformLabel}
              收录的集数
            </p>
          </div>
          <CoverageLegend labels={["已确认", "本次提交", "未收录"]} />
        </div>

        <Card>
          <CardContent className="flex flex-col gap-3 pt-4">
            <div className="flex items-center gap-3">
              <div className="w-18 shrink-0" />
              <div className="min-w-0 flex-1">
                <CoverageRuler total={totalSeasonEpisodes} />
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="w-18 shrink-0 text-xs">
                <div className="font-medium text-foreground">现在</div>
                <div className="text-2xs text-muted-foreground">{spanLabel(existingSegments)}</div>
              </div>
              <div className="min-w-0 flex-1">
                <CoverageTrack total={totalSeasonEpisodes} segments={existingSegments} />
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="w-18 shrink-0 text-xs">
                <div className="font-medium text-foreground">通过后</div>
                <div className="text-2xs text-muted-foreground">{spanLabel(afterSegments)}</div>
              </div>
              <div className="min-w-0 flex-1">
                <CoverageTrack total={totalSeasonEpisodes} segments={afterSegments} />
              </div>
            </div>

            <div className="mt-1 border-t border-border/60 pt-3 text-xs">
              <div className="flex items-start gap-3">
                <span className="w-18 shrink-0 text-muted-foreground">提交内容</span>
                <div className="min-w-0 flex-1">
                  {cr.segments.map((s) => (
                    <div key={`${s.season}-${s.start}`} className="font-medium text-foreground">
                      {NAMESPACE_LABELS[cr.namespace]}
                      {cr.pageTitle ? `「${cr.pageTitle}」` : ""}页面上的
                      {formatEpisodeRange(
                        s.targetStart,
                        s.end === null ? null : s.targetStart + (s.end - s.start),
                      )}
                      ，就是第 {s.season} 季的{formatEpisodeRange(s.start, s.end)}
                    </div>
                  ))}
                  <div className="mt-0.5 font-mono text-2xs text-muted-foreground">
                    {cr.nativeId}
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* 自动核对结果 */}
      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h3 className="text-xl leading-7 font-bold tracking-tight text-foreground">
            自动核对结果
          </h3>
          <p className="text-sm text-muted-foreground">
            提交后系统按固定规则逐项核对：{passedCount} 项通过
            {failedCount > 0 ? `，${failedCount} 项没通过` : ""}
            {warnCount > 0 ? `，${warnCount} 项需要你看一眼` : ""}
          </p>
        </div>

        <Card>
          <CardContent className="divide-y divide-border/60 pt-4">
            {cr.checks.map((chk) => (
              <CheckItemRow key={chk.id} item={chk} showBadge={false} />
            ))}
          </CardContent>
        </Card>
      </section>

      {/* 你的决定 */}
      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h3 className="text-xl leading-7 font-bold tracking-tight text-foreground">你的决定</h3>
          <p className="text-sm text-muted-foreground">
            通过后这条记录立即生效；驳回时请写明原因，提交人会看到
          </p>
        </div>

        <Card>
          <CardContent className="flex flex-col gap-3 pt-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="review-note">审核备注</Label>
              <Textarea
                id="review-note"
                value={decisionNote}
                onChange={(e) => setDecisionNote(e.target.value)}
                placeholder="写明通过依据或驳回原因…"
                rows={3}
              />
            </div>

            {decide.isError && <ErrorAlert title="提交审核结果失败" error={decide.error} />}

            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <span className="text-xs text-muted-foreground">
                {primary &&
                  `通过后，${platformLabel}的第 ${season} 季会新增${formatEpisodeRange(primary.start, primary.end)}`}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="default"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate(false)}
                >
                  驳回
                </Button>
                <Button
                  variant="default"
                  size="default"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate(true)}
                >
                  通过
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
