import { Badge } from "@media-ref/ui/components/badge";
import { Button } from "@media-ref/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@media-ref/ui/components/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@media-ref/ui/components/empty";
import { Label } from "@media-ref/ui/components/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@media-ref/ui/components/tabs";
import { Textarea } from "@media-ref/ui/components/textarea";
import { cn } from "@media-ref/ui/lib/utils";
import { RiArrowRightUpLine } from "@remixicon/react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { NAMESPACE_LABELS, NamespaceLogo } from "#/components/brand-logos";
import { CheckItemRow } from "#/components/check-item-row";
import { CoverageLegend, CoverageRuler, CoverageTrack } from "#/components/coverage-bar";
import { TopNav } from "#/components/top-nav";
import { useAppStore } from "#/lib/app-store";

export const Route = createFileRoute("/review")({
  component: ReviewWorkbenchPage,
});

function ReviewWorkbenchPage() {
  const {
    changeRequests,
    reviewAlerts,
    getMediaById,
    approveChangeRequest,
    rejectChangeRequest,
    resolveAlert,
  } = useAppStore();
  const navigate = useNavigate();

  const pendingQueue = useMemo(
    () =>
      changeRequests.filter(
        (cr) => cr.status === "needs_review" || cr.status === "pending_evidence",
      ),
    [changeRequests],
  );
  const openAlerts = useMemo(() => reviewAlerts.filter((a) => !a.resolved), [reviewAlerts]);

  const [activeTab, setActiveTab] = useState<"queue" | "alerts">("queue");
  const [selectedId, setSelectedId] = useState<string | null>(pendingQueue[0]?.id ?? null);
  const [decisionNote, setDecisionNote] = useState(
    "第 13 个是完结篇预告，不算正片。正片 12 集和第 17–28 集对得上，可以通过。",
  );

  useEffect(() => {
    if (!pendingQueue.some((c) => c.id === selectedId)) {
      setSelectedId(pendingQueue[0]?.id ?? null);
    }
  }, [pendingQueue, selectedId]);

  const selectedCr = pendingQueue.find((c) => c.id === selectedId) ?? pendingQueue[0] ?? null;
  const selectedMedia = selectedCr ? getMediaById(selectedCr.mediaId) : undefined;

  const passedCount = selectedCr?.checks.filter((c) => c.status === "passed").length ?? 0;
  const failedCount = selectedCr?.checks.filter((c) => c.status === "failed").length ?? 0;
  const warnCount = selectedCr?.checks.filter((c) => c.status === "needs_confirm").length ?? 0;

  const handleApprove = () => {
    if (!selectedCr) return;
    approveChangeRequest(selectedCr.id, decisionNote);
    setDecisionNote("");
  };

  const handleReject = () => {
    if (!selectedCr) return;
    rejectChangeRequest(selectedCr.id, decisionNote);
    setDecisionNote("");
  };

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

        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as "queue" | "alerts")}
          className="mt-6"
        >
          <TabsList className="grid w-full max-w-xs grid-cols-2">
            <TabsTrigger value="queue" className="gap-1.5 px-3">
              <span>待审核</span>
              <span className="font-mono text-2xs text-muted-foreground">
                {pendingQueue.length}
              </span>
            </TabsTrigger>
            <TabsTrigger value="alerts" className="gap-1.5 px-3">
              <span>告警</span>
              <span className="font-mono text-2xs text-muted-foreground">{openAlerts.length}</span>
            </TabsTrigger>
          </TabsList>

          {/* 04A: Review Queue */}
          <TabsContent value="queue" className="mt-6">
            {pendingQueue.length === 0 ? (
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
                        const media = getMediaById(cr.mediaId);
                        const active = selectedCr?.id === cr.id;
                        return (
                          <button
                            key={cr.id}
                            type="button"
                            onClick={() => {
                              setSelectedId(cr.id);
                              setDecisionNote("");
                            }}
                            className={cn(
                              "flex w-full items-start gap-3 rounded-lg p-2.5 text-left transition-colors",
                              active ? "bg-accent ring-1 ring-border" : "hover:bg-muted/50",
                            )}
                          >
                            {media && (
                              <img
                                src={media.posterUrl}
                                alt={media.title}
                                className="h-13.5 w-9 shrink-0 rounded object-cover ring-1 ring-border/70"
                              />
                            )}
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center justify-between gap-2">
                                <span className="truncate text-sm font-medium text-foreground">
                                  {media?.title ?? cr.title}
                                </span>
                                <span className="shrink-0 text-2xs text-muted-foreground">
                                  {cr.relativeTime}
                                </span>
                              </div>
                              <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                                <NamespaceLogo namespace={cr.namespace} className="size-3.5" />
                                <span className="truncate">
                                  {NAMESPACE_LABELS[cr.namespace]} · 第 {cr.season} 季 第{" "}
                                  {cr.episodeStart}–{cr.episodeEnd} 集
                                </span>
                              </div>
                              <div className="mt-1.5 flex items-center gap-2">
                                {cr.conflictTag && (
                                  <Badge variant="warning">{cr.conflictTag}</Badge>
                                )}
                                <span className="truncate text-2xs text-muted-foreground">
                                  {cr.submitterName} 提交
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
                  <div className="flex min-w-0 flex-1 flex-col gap-10">
                    {/* Detail Header */}
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="flex items-start gap-5">
                        {selectedMedia && (
                          <img
                            src={selectedMedia.posterUrl}
                            alt={selectedMedia.title}
                            className="h-27 w-18 shrink-0 rounded-lg object-cover ring-1 ring-border"
                          />
                        )}
                        <div className="flex flex-col gap-1.5">
                          <div className="text-xs text-muted-foreground">
                            变更单 <span className="font-mono">#{selectedCr.id}</span> ·{" "}
                            {selectedCr.submitterName} 提交于 {selectedCr.relativeTime}
                          </div>
                          <h2 className="text-2xl leading-8 font-bold tracking-tight text-foreground">
                            {selectedMedia?.title ?? selectedCr.title} · 第 {selectedCr.season} 季
                          </h2>
                          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            <NamespaceLogo namespace={selectedCr.namespace} className="size-4.5" />
                            <span>
                              {NAMESPACE_LABELS[selectedCr.namespace]}
                              {selectedCr.variantLabel ? ` · ${selectedCr.variantLabel}` : ""} ·
                              补充第 {selectedCr.episodeStart}–{selectedCr.episodeEnd} 集
                            </span>
                          </div>
                          {selectedCr.conflictTag && (
                            <div className="pt-0.5">
                              <Badge variant="warning">{selectedCr.conflictTag}</Badge>
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-2">
                        {selectedMedia && (
                          <Button
                            variant="outline"
                            size="sm"
                            nativeButton={false}
                            render={
                              <Link to="/media/$mediaId" params={{ mediaId: selectedMedia.id }} />
                            }
                          >
                            看媒体详情
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          nativeButton={false}
                          render={<a href={selectedCr.pageUrl} target="_blank" rel="noreferrer" />}
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
                            第 {selectedCr.season} 季，以 TMDB 的 {selectedCr.totalSeasonEpisodes}{" "}
                            集为准。横条是{NAMESPACE_LABELS[selectedCr.namespace]}
                            {selectedCr.variantLabel ?? ""}收录的集数
                          </p>
                        </div>
                        <CoverageLegend labels={["已确认", "本次提交", "未收录"]} />
                      </div>

                      <Card>
                        <CardContent className="flex flex-col gap-3 pt-4">
                          <div className="flex items-center gap-3">
                            <div className="w-18 shrink-0" />
                            <div className="min-w-0 flex-1">
                              <CoverageRuler total={selectedCr.totalSeasonEpisodes} />
                            </div>
                          </div>

                          <div className="flex items-center gap-3">
                            <div className="w-18 shrink-0 text-xs">
                              <div className="font-medium text-foreground">现在</div>
                              <div className="text-2xs text-muted-foreground">
                                {selectedCr.existingSegments.length > 0
                                  ? `第 ${selectedCr.existingSegments[0]!.start}–${selectedCr.existingSegments[selectedCr.existingSegments.length - 1]!.end} 集`
                                  : "无记录"}
                              </div>
                            </div>
                            <div className="min-w-0 flex-1">
                              <CoverageTrack
                                total={selectedCr.totalSeasonEpisodes}
                                segments={selectedCr.existingSegments}
                              />
                            </div>
                          </div>

                          <div className="flex items-center gap-3">
                            <div className="w-18 shrink-0 text-xs">
                              <div className="font-medium text-foreground">通过后</div>
                              <div className="text-2xs text-muted-foreground">
                                第 1–{selectedCr.episodeEnd} 集
                              </div>
                            </div>
                            <div className="min-w-0 flex-1">
                              <CoverageTrack
                                total={selectedCr.totalSeasonEpisodes}
                                segments={[
                                  ...selectedCr.existingSegments,
                                  selectedCr.proposedSegment,
                                ]}
                              />
                            </div>
                          </div>

                          <div className="mt-1 border-t border-border/60 pt-3 text-xs">
                            <div className="flex items-start gap-3">
                              <span className="w-18 shrink-0 text-muted-foreground">提交内容</span>
                              <div className="min-w-0 flex-1">
                                <div className="font-medium text-foreground">
                                  {NAMESPACE_LABELS[selectedCr.namespace]}「{selectedCr.pageTitle}
                                  」页面上的第 {selectedCr.targetEpisodeStart}–
                                  {selectedCr.targetEpisodeStart +
                                    (selectedCr.episodeEnd - selectedCr.episodeStart)}{" "}
                                  集，就是第 {selectedCr.season} 季的第 {selectedCr.episodeStart}–
                                  {selectedCr.episodeEnd} 集
                                </div>
                                <div className="mt-0.5 font-mono text-2xs text-muted-foreground">
                                  {selectedCr.nativeId}
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
                          {selectedCr.checks.map((chk) => (
                            <CheckItemRow key={chk.id} item={chk} showBadge={false} />
                          ))}
                        </CardContent>
                      </Card>
                    </section>

                    {/* 你的决定 */}
                    <section className="flex flex-col gap-4">
                      <div className="flex flex-col gap-1">
                        <h3 className="text-xl leading-7 font-bold tracking-tight text-foreground">
                          你的决定
                        </h3>
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

                          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                            <span className="text-xs text-muted-foreground">
                              {selectedCr.effectSummary}
                            </span>
                            <div className="flex items-center gap-2">
                              <Button variant="outline" size="default" onClick={handleReject}>
                                驳回
                              </Button>
                              <Button variant="default" size="default" onClick={handleApprove}>
                                通过
                              </Button>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    </section>
                  </div>
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

              {openAlerts.length === 0 ? (
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
                          <NamespaceLogo
                            namespace={alert.namespace}
                            className="mt-0.5 size-7 shrink-0"
                          />
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge
                                variant={
                                  alert.severity === "destructive" ? "destructive" : "warning"
                                }
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
                            {alert.relativeTime}
                          </span>
                          <Button
                            variant="outline"
                            size="default"
                            onClick={() => {
                              if (alert.actionLabel === "下架这条记录") {
                                resolveAlert(alert.id);
                              } else {
                                void navigate({
                                  to: "/media/$mediaId",
                                  params: { mediaId: alert.mediaId },
                                });
                              }
                            }}
                          >
                            {alert.actionLabel}
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
