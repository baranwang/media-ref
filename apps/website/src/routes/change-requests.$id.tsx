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
import { cn } from "@media-ref/ui/lib/utils";
import { RiArrowLeftSLine, RiArrowRightUpLine } from "@remixicon/react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { NAMESPACE_LABELS, NamespaceLogo } from "#/components/brand-logos";
import { CheckItemRow } from "#/components/check-item-row";
import { CoverageRuler, CoverageTrack } from "#/components/coverage-bar";
import { TopNav } from "#/components/top-nav";
import { useAppStore } from "#/lib/app-store";

export const Route = createFileRoute("/change-requests/$id")({
  component: ChangeRequestDetailPage,
});

function ChangeRequestDetailPage() {
  const { id } = Route.useParams();
  const { changeRequests, getMediaById } = useAppStore();

  const cr = changeRequests.find((c) => c.id.toLowerCase() === id.toLowerCase());
  const media = cr ? getMediaById(cr.mediaId) : undefined;

  if (!cr) {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <TopNav />
        <main className="container flex flex-col items-center justify-center py-28 text-center">
          <h1 className="text-xl font-semibold">找不到这张变更单</h1>
          <p className="mt-2 text-sm text-muted-foreground">编号 #{id} 不存在或已被删除</p>
          <Button className="mt-6" nativeButton={false} render={<Link to="/change-requests" />}>
            返回我的变更单
          </Button>
        </main>
      </div>
    );
  }

  const statusMeta =
    cr.status === "approved"
      ? { label: "已通过", variant: "confirmed" as const }
      : cr.status === "rejected"
        ? { label: "已驳回", variant: "destructive" as const }
        : { label: "待审核", variant: "warning" as const };

  return (
    <div className="relative min-h-screen bg-background text-foreground">
      {/* Page-level backdrop with smooth fade matching Figma 03B */}
      {media && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-84 overflow-hidden"
        >
          <img
            src={media.backdropUrl}
            alt=""
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
          {media && (
            <img
              src={media.posterUrl}
              alt={media.title}
              className="h-39 w-26 shrink-0 rounded-lg object-cover shadow-lg ring-1 ring-white/10"
            />
          )}

          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="text-xs text-muted-foreground">变更单 · {cr.submittedAt} 提交</div>

            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-3xl leading-9 font-bold tracking-tight text-foreground">
                {cr.title}
              </h1>
              <Badge variant={statusMeta.variant}>{statusMeta.label}</Badge>
            </div>

            <p className="text-sm text-muted-foreground">
              {NAMESPACE_LABELS[cr.namespace]}
              {cr.variantLabel ? ` · ${cr.variantLabel.replace("（默认）", "")}` : ""} · 平台页面「
              {cr.pageTitle}」
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
          {/* 提交的内容 */}
          <section className="flex flex-col gap-3">
            <div>
              <h2 className="text-xl leading-7 font-bold tracking-tight text-foreground">
                提交的内容
              </h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                你把{NAMESPACE_LABELS[cr.namespace]}上的一个播放页，对应到这部剧的第 {cr.season}{" "}
                季第 {cr.episodeStart}–{cr.episodeEnd} 集
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
                    <dt className="w-24 shrink-0 text-muted-foreground">播放页</dt>
                    <dd className="min-w-0 flex-1">
                      <a
                        href={cr.pageUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex max-w-full items-center gap-1 truncate font-mono text-xs text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
                      >
                        <span className="truncate">{cr.pageUrl}</span>
                        <RiArrowRightUpLine className="size-3.5 shrink-0" />
                      </a>
                    </dd>
                  </div>
                  <div className="flex items-center gap-3 py-2.5">
                    <dt className="w-24 shrink-0 text-muted-foreground">页面标题</dt>
                    <dd className="min-w-0 flex-1 text-foreground">
                      {cr.pageTitle}
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
                    <dd className="min-w-0 flex-1 font-medium text-foreground">
                      第 {cr.season} 季 第 {cr.episodeStart}–{cr.episodeEnd} 集
                    </dd>
                  </div>
                </dl>

                {/* Embedded Coverage Preview */}
                <div className="flex flex-col gap-2 rounded-lg border border-border/80 bg-background/60 p-3.5">
                  <div className="text-xs text-muted-foreground">
                    第 {cr.season} 季 · {NAMESPACE_LABELS[cr.namespace]}
                    {cr.variantLabel ? ` · ${cr.variantLabel.replace("（默认）", "")}` : ""}
                  </div>
                  <CoverageRuler total={cr.totalSeasonEpisodes} />
                  <CoverageTrack
                    total={cr.totalSeasonEpisodes}
                    segments={[...cr.existingSegments, cr.proposedSegment]}
                  />
                  <div
                    className={cn(
                      "pt-1 text-xs",
                      cr.status === "approved"
                        ? "text-status-confirmed-fg"
                        : cr.status === "rejected"
                          ? "text-destructive"
                          : "text-muted-foreground",
                    )}
                  >
                    {cr.effectSummary}
                  </div>
                </div>
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

          {/* 审核员留言 */}
          {cr.reviewer && (
            <section className="flex flex-col gap-3">
              <h2 className="text-xl leading-7 font-bold tracking-tight text-foreground">
                审核员留言
              </h2>
              <Card>
                <CardContent className="flex items-start gap-3 pt-4">
                  <Avatar size="default">
                    <AvatarFallback className="bg-muted text-xs font-medium text-foreground">
                      {cr.reviewer.initial}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-medium text-foreground">{cr.reviewer.name}</span>
                      <span className="text-muted-foreground">{cr.reviewer.time}</span>
                    </div>
                    <p className="mt-1.5 text-sm leading-6 text-foreground/90">
                      {cr.reviewer.comment}
                    </p>
                  </div>
                </CardContent>
              </Card>
            </section>
          )}
        </div>

        {/* Right column: Timeline */}
        <aside className="flex flex-col gap-3 lg:col-span-4">
          <div>
            <h2 className="text-xl leading-7 font-bold tracking-tight text-foreground">进度</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {cr.status === "approved"
                ? "从提交到生效用了不到 13 小时"
                : cr.status === "rejected"
                  ? "本次变更单已被驳回"
                  : "正在等待审核员处理"}
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
