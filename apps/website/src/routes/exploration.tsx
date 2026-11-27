import type { Namespace } from "@media-ref/client";
import { Badge } from "@media-ref/ui/components/badge";
import { Button } from "@media-ref/ui/components/button";
import { Card, CardContent } from "@media-ref/ui/components/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@media-ref/ui/components/empty";
import { Tabs, TabsList, TabsTrigger } from "@media-ref/ui/components/tabs";
import { cn } from "@media-ref/ui/lib/utils";
import { RiArrowDownSLine, RiArrowRightUpLine } from "@remixicon/react";
import { infiniteQueryOptions, useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { NAMESPACE_LABELS, NamespaceLogo } from "#/components/brand-logos";
import { TopNav } from "#/components/top-nav";
import { useAppStore } from "#/lib/app-store";
import { formatRelativeTime } from "#/lib/format";
import { explorationResultText } from "#/lib/mappers";
import { fetchExplorationActivity, type ExplorationFilter } from "#/lib/server-fns";
import type { ExplorationItem, ExplorationPlatformView, ExplorationStatus } from "#/lib/types";

const PAGE_SIZE = 20;
const REFRESH_MS = 15_000;
/** A job's wall-clock budget; the running card's bar is drawn against it. */
const JOB_BUDGET_MS = 5 * 60_000;

const activityQuery = (filter: ExplorationFilter) =>
  infiniteQueryOptions({
    queryKey: ["exploration-activity", filter],
    queryFn: ({ pageParam }) =>
      fetchExplorationActivity({
        data: { filter, limit: PAGE_SIZE, ...(pageParam ? { before: pageParam } : {}) },
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextBefore,
    refetchInterval: REFRESH_MS,
  });

export const Route = createFileRoute("/exploration")({
  loader: ({ context }) => context.queryClient.ensureInfiniteQueryData(activityQuery("all")),
  head: () => ({ meta: [{ title: "探索动态 · MediaRef" }] }),
  component: ExplorationPage,
});

const STATUS_BADGE: Record<
  ExplorationStatus,
  { label: string; variant: "confirmed" | "warning" | "outline" | "secondary" | "destructive" }
> = {
  approved: { label: "已生效", variant: "confirmed" },
  covered: { label: "已收录", variant: "confirmed" },
  in_review: { label: "待审核", variant: "warning" },
  rejected: { label: "被驳回", variant: "destructive" },
  not_found: { label: "没有", variant: "outline" },
  retry: { label: "稍后再找", variant: "secondary" },
  searching: { label: "正在找", variant: "secondary" },
};

const HOW_IT_WORKS = [
  ["有人来查", "API 调用方查到一部作品还缺平台记录，就记下来"],
  ["去平台找", "先看豆瓣「在哪看」和 360 影视，再用平台搜索和网页搜索"],
  ["自动核对", "只能提交真的打开过的合集；片名、年份、集数都要对上"],
  ["生效", "对上了直接生效，拿不准的由审核 agent 判定"],
] as const;

function label(ns: Namespace): string {
  return NAMESPACE_LABELS[ns] ?? ns;
}

function scopeText(item: ExplorationItem): string {
  if (item.card.type === "movie") return "正片";
  return item.season === null ? "整部" : `第 ${item.season} 季`;
}

function metaText(item: ExplorationItem): string {
  return [
    item.card.type === "movie" ? "电影" : "剧集",
    item.card.year,
    item.card.type === "movie" ? null : scopeText(item),
  ]
    .filter(Boolean)
    .join(" · ");
}

const found = (p: ExplorationPlatformView) => p.status === "approved" || p.status === "in_review";

/** One sentence for a finished job, as the list row shows it. */
function resultText(item: ExplorationItem): string {
  return explorationResultText(item, label);
}

function durationText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
}

function Poster({ item, className }: { item: ExplorationItem; className: string }) {
  return item.card.posterUrl ? (
    <img
      src={item.card.posterUrl}
      alt={item.card.title}
      loading="lazy"
      referrerPolicy="no-referrer"
      className={cn("shrink-0 rounded-md object-cover ring-1 ring-border/70", className)}
    />
  ) : (
    <div className={cn("shrink-0 rounded-md bg-muted ring-1 ring-border/70", className)} />
  );
}

function SectionHeading({ title, sub }: { title: string; sub?: string }) {
  return (
    <div>
      <h2 className="text-xl leading-7 font-bold tracking-tight text-foreground">{title}</h2>
      {sub && <p className="mt-0.5 text-sm text-muted-foreground">{sub}</p>}
    </div>
  );
}

/**
 * Ticks every second so elapsed times move between refreshes. Null until mounted: the server's
 * clock would differ from the browser's and break hydration.
 */
function useNow(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function RunningCard({ item, now }: { item: ExplorationItem; now: number | null }) {
  const elapsed = now === null ? 0 : now - Date.parse(item.startedAt);
  const share = Math.min(100, Math.max(2, (elapsed / JOB_BUDGET_MS) * 100));
  return (
    <Card>
      <CardContent className="flex flex-col pt-4">
        <div className="flex gap-5 pb-4">
          <Poster item={item} className="h-27 w-18" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-primary">
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/60" />
                <span className="relative inline-flex size-2 rounded-full bg-primary" />
              </span>
              正在看{now !== null && ` · 开始于 ${durationText(elapsed)}前`}
            </div>
            <Link
              to="/media/$mediaId"
              params={{ mediaId: item.card.id }}
              className="truncate text-lg leading-7 font-bold text-foreground hover:underline"
            >
              {item.card.title}
              {item.card.type !== "movie" && item.season !== null ? ` 第 ${item.season} 季` : ""}
            </Link>
            <span className="text-xs text-muted-foreground">{metaText(item)}</span>
            <div className="flex flex-col gap-1 pt-2">
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary/70 transition-all duration-1000"
                  style={{ width: `${share}%` }}
                />
              </div>
              <div className="flex justify-between font-mono text-2xs text-muted-foreground">
                <span>0</span>
                <span>最多 5 分钟</span>
              </div>
            </div>
          </div>
        </div>
        <dl className="divide-y divide-border/60 border-t border-border/60 text-xs">
          {item.platforms.map((p) => (
            <div key={p.namespace} className="flex items-center gap-3 py-2.5 last:pb-0">
              <dt className="w-24 shrink-0 text-muted-foreground">{label(p.namespace)}</dt>
              <dd className="flex items-center gap-2 text-foreground">
                <NamespaceLogo namespace={p.namespace} className="size-4" />
                正在找…
              </dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

function ActivityRow({
  item,
  now,
  canSeeChangeRequests,
}: {
  item: ExplorationItem;
  now: number | null;
  canSeeChangeRequests: boolean;
}) {
  const [open, setOpen] = useState(false);
  const foundPlatforms = item.platforms.filter(found);
  const primaryChangeRequest =
    item.platforms.find((p) => p.status === "approved" && p.changeRequestId)?.changeRequestId ??
    item.platforms.find((p) => p.status === "in_review" && p.changeRequestId)?.changeRequestId ??
    item.platforms.find((p) => p.liveChangeRequestId)?.liveChangeRequestId ??
    item.platforms.find((p) => p.changeRequestId)?.changeRequestId;
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-4 px-5 py-3.5 text-left transition-colors hover:bg-muted/25"
      >
        <Poster item={item} className="h-15 w-10" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-sm font-medium text-foreground">{item.card.title}</span>
          <span className="text-xs text-muted-foreground">{metaText(item)}</span>
          <span className="flex min-w-0 gap-2 text-xs">
            <span className="shrink-0 text-muted-foreground">结果</span>
            <span className="truncate text-foreground/90">{resultText(item)}</span>
          </span>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <div className="flex h-4 items-center gap-2">
            {foundPlatforms.map((p) => (
              <NamespaceLogo key={p.namespace} namespace={p.namespace} className="size-4" />
            ))}
          </div>
          <span className="text-xs text-muted-foreground">
            {now !== null && formatRelativeTime(item.finishedAt, new Date(now))}
          </span>
        </div>
        <RiArrowDownSLine
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div className="flex flex-col pr-5 pb-4 pl-19">
          <ul className="divide-y divide-border/60">
            {item.platforms.map((p) => {
              const badge = STATUS_BADGE[p.status];
              return (
                <li key={p.namespace} className="flex gap-3 py-3">
                  <NamespaceLogo namespace={p.namespace} className="mt-0.5 size-4" />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex items-center gap-2 text-xs font-medium text-foreground">
                      {label(p.namespace)}
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                    </div>
                    {p.reason && (
                      <p className="text-xs leading-5 text-muted-foreground">{p.reason}</p>
                    )}
                    {canSeeChangeRequests && (p.changeRequestId || p.liveChangeRequestId) && (
                      <div className="flex flex-wrap gap-3 text-xs">
                        {p.liveChangeRequestId && (
                          <Link
                            to="/change-requests/$id"
                            params={{ id: p.liveChangeRequestId }}
                            className="inline-flex items-center gap-0.5 text-foreground/90 underline underline-offset-4 hover:text-foreground"
                          >
                            查看生效变更单
                            <RiArrowRightUpLine className="size-3" />
                          </Link>
                        )}
                        {p.changeRequestId && (
                          <Link
                            to="/change-requests/$id"
                            params={{ id: p.changeRequestId }}
                            className="inline-flex items-center gap-0.5 text-muted-foreground underline underline-offset-4 hover:text-foreground"
                          >
                            {p.liveChangeRequestId ? "查看原变更单" : "查看变更单"}
                            <RiArrowRightUpLine className="size-3" />
                          </Link>
                        )}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="flex gap-4 pt-2 text-xs font-medium">
            <Link
              to="/media/$mediaId"
              params={{ mediaId: item.card.id }}
              className="inline-flex items-center gap-1 text-foreground hover:underline"
            >
              打开作品页
              <RiArrowRightUpLine className="size-3.5" />
            </Link>
            {canSeeChangeRequests && primaryChangeRequest && (
              <Link
                to="/change-requests/$id"
                params={{ id: primaryChangeRequest }}
                className="inline-flex items-center gap-1 text-foreground hover:underline"
              >
                查看变更单
                <RiArrowRightUpLine className="size-3.5" />
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ExplorationPage() {
  const [filter, setFilter] = useState<ExplorationFilter>("all");
  const now = useNow();
  const { user } = useAppStore();
  const canSeeChangeRequests = !!user && (user.role === "reviewer" || user.role === "owner");
  const query = useInfiniteQuery(activityQuery(filter));
  // Running jobs and the 24-hour numbers come with the first page of the unfiltered list too,
  // so switching tabs keeps them from the last load.
  const allQuery = useInfiniteQuery({ ...activityQuery("all"), enabled: filter !== "all" });
  const first = query.data?.pages[0] ?? allQuery.data?.pages[0];
  const running = first?.running ?? [];
  const summary = first?.summary ?? null;
  const recent = query.data?.pages.flatMap((p) => p.recent) ?? [];
  const backdrop = (running[0] ?? recent[0])?.card.posterUrl;

  return (
    <div className="relative min-h-screen bg-background text-foreground">
      {backdrop && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-96 overflow-hidden"
        >
          <img
            src={backdrop}
            alt=""
            referrerPolicy="no-referrer"
            className="h-full w-full scale-105 object-cover object-center opacity-30 blur-xs"
          />
          <div className="absolute inset-0 bg-linear-to-b from-background/0 from-30% to-background" />
          <div className="absolute inset-0 bg-linear-to-r from-background via-background/85 via-30% to-background/15" />
        </div>
      )}

      <TopNav transparent />

      <section className="relative z-10 container flex flex-col gap-2 pt-12">
        <h1 className="text-3xl leading-9 font-bold tracking-tight text-foreground">探索动态</h1>
        <p className="text-sm text-muted-foreground">
          有人查了库里还没收录的作品，探索 agent
          就会去各个视频平台找。这里能看到它正在看什么、刚刚找到了什么。
        </p>
      </section>

      <main className="relative z-10 container grid grid-cols-1 gap-8 pt-10 pb-20 lg:grid-cols-12">
        <div className="flex flex-col gap-12 lg:col-span-8">
          <section className="flex flex-col gap-4">
            <SectionHeading title="正在看" sub="每次看一部作品，几个平台一起找，最多 5 分钟" />
            {running.length > 0 ? (
              running.map((item) => <RunningCard key={item.id} item={item} now={now} />)
            ) : (
              <Empty className="rounded-xl border border-border bg-card py-10">
                <EmptyHeader>
                  <EmptyTitle>现在没有在看的作品</EmptyTitle>
                  <EmptyDescription>有新的作品要找时，一分钟内就会开始。</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </section>

          <section className="flex flex-col gap-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <SectionHeading title="刚刚看完" sub="按完成时间排序" />
              <Tabs value={filter} onValueChange={(v) => setFilter(v as ExplorationFilter)}>
                <TabsList>
                  {(
                    [
                      ["all", "全部", summary?.explored],
                      ["found", "找到了", summary?.found],
                      [
                        "not_found",
                        "没找到",
                        summary ? summary.explored - summary.found : undefined,
                      ],
                    ] as const
                  ).map(([value, text, count]) => (
                    <TabsTrigger key={value} value={value} className="gap-1.5 px-3">
                      <span>{text}</span>
                      {count !== undefined && (
                        <span className="font-mono text-2xs text-muted-foreground">{count}</span>
                      )}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </div>

            {query.isPending ? (
              <div className="h-60 animate-pulse rounded-xl bg-card" />
            ) : recent.length === 0 ? (
              <Empty className="rounded-xl border border-border bg-card py-16">
                <EmptyHeader>
                  <EmptyTitle>这里还没有记录</EmptyTitle>
                  <EmptyDescription>探索 agent 看完一部作品后，结果会出现在这里。</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="divide-y divide-border/70 overflow-hidden rounded-xl bg-card">
                {recent.map((item) => (
                  <ActivityRow
                    key={item.id}
                    item={item}
                    now={now}
                    canSeeChangeRequests={canSeeChangeRequests}
                  />
                ))}
              </div>
            )}

            {query.hasNextPage && (
              <div className="flex justify-center">
                <Button
                  variant="ghost"
                  disabled={query.isFetchingNextPage}
                  onClick={() => void query.fetchNextPage()}
                >
                  {query.isFetchingNextPage ? "加载中…" : "显示更多"}
                </Button>
              </div>
            )}
          </section>
        </div>

        <aside className="flex flex-col gap-12 lg:col-span-4">
          <section className="flex flex-col gap-4">
            <SectionHeading title="最近 24 小时" />
            <Card>
              <CardContent className="grid grid-cols-2 gap-5 pt-4">
                {(
                  [
                    [summary?.explored, "看过的作品"],
                    [summary ? summary.approved + summary.inReview : undefined, "找到的平台页面"],
                    [summary?.approved, "已经生效"],
                    [summary?.inReview, "等审核 agent 判定"],
                  ] as const
                ).map(([value, text]) => (
                  <div key={text} className="flex flex-col gap-0.5">
                    <span className="text-2xl leading-8 font-bold text-foreground">
                      {value ?? "–"}
                    </span>
                    <span className="text-xs text-muted-foreground">{text}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          </section>

          <section className="flex flex-col gap-4">
            <SectionHeading
              title="它怎么找"
              sub="每一条都要过自动核对，拿不准的由审核 agent 判定"
            />
            <Card>
              <CardContent className="pt-4">
                <ol className="relative flex flex-col gap-5 before:absolute before:top-2 before:bottom-2 before:left-1.25 before:w-px before:bg-border">
                  {HOW_IT_WORKS.map(([title, detail], idx) => (
                    <li key={title} className="relative flex gap-3 pl-5">
                      <span className="absolute top-1.5 left-0 size-2.5 rounded-full bg-status-confirmed-fg ring-2 ring-card" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <span className="font-medium text-foreground">{title}</span>
                          <span className="shrink-0 font-mono text-2xs text-muted-foreground">
                            第 {idx + 1} 步
                          </span>
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          </section>
        </aside>
      </main>
    </div>
  );
}
