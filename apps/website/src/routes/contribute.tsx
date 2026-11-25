import { Button } from "@media-ref/ui/components/button";
import { Tabs, TabsList, TabsTrigger } from "@media-ref/ui/components/tabs";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { NamespaceLogo } from "#/components/brand-logos";
import { TopNav } from "#/components/top-nav";
import { useAppStore } from "#/lib/app-store";
import { CONTRIBUTE_DEMANDS } from "#/lib/catalog-data";

export const Route = createFileRoute("/contribute")({
  component: ContributeQueuePage,
});

type DemandTab = "all" | "tv" | "movie";

function ContributeQueuePage() {
  const { getMediaById } = useAppStore();
  const [tab, setTab] = useState<DemandTab>("all");
  const [visibleCount, setVisibleCount] = useState(8);

  const filtered = useMemo(() => {
    return CONTRIBUTE_DEMANDS.filter((d) => {
      const m = getMediaById(d.mediaId);
      if (!m) return false;
      if (tab === "movie") return m.type === "movie";
      if (tab === "tv") return m.type === "tv";
      return true;
    });
  }, [getMediaById, tab]);

  const shown = filtered.slice(0, visibleCount);
  const hasMore = shown.length < filtered.length;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <TopNav />

      <main className="container flex flex-col pb-20">
        {/* Page Head */}
        <section className="flex flex-col gap-2 pt-12">
          <h1 className="text-3xl leading-9 font-bold tracking-tight text-foreground">待贡献</h1>
          <p className="text-sm text-muted-foreground">
            有人查过、但库里还缺平台记录的媒体。补上一条，下一个来查的人就能直接看到。
          </p>
        </section>

        {/* Filter Bar */}
        <section className="flex flex-wrap items-center justify-between gap-3 pt-7">
          <Tabs value={tab} onValueChange={(v) => setTab(v as DemandTab)}>
            <TabsList>
              <TabsTrigger value="all" className="gap-1.5 px-3">
                <span>全部</span>
                <span className="font-mono text-2xs text-muted-foreground">126</span>
              </TabsTrigger>
              <TabsTrigger value="tv" className="gap-1.5 px-3">
                <span>剧集</span>
                <span className="font-mono text-2xs text-muted-foreground">104</span>
              </TabsTrigger>
              <TabsTrigger value="movie" className="gap-1.5 px-3">
                <span>电影</span>
                <span className="font-mono text-2xs text-muted-foreground">22</span>
              </TabsTrigger>
            </TabsList>
          </Tabs>

          <span className="text-sm text-muted-foreground">最近 30 天 · 按被查询次数排序</span>
        </section>

        {/* Ranked Demand Card */}
        <section className="mt-5 overflow-hidden rounded-xl border border-border bg-card">
          <div className="divide-y divide-border/70">
            {shown.map((item, idx) => {
              const media = getMediaById(item.mediaId);
              if (!media) return null;

              return (
                <div
                  key={item.id}
                  className="flex flex-wrap items-center justify-between gap-4 px-5 py-3.5 transition-colors hover:bg-muted/25"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-4">
                    <span className="w-5 shrink-0 text-center font-mono text-sm font-medium text-muted-foreground">
                      {idx + 1}
                    </span>

                    <Link
                      to="/media/$mediaId"
                      params={{ mediaId: media.id }}
                      className="flex min-w-0 flex-1 items-center gap-4"
                    >
                      <img
                        src={media.posterUrl}
                        alt={media.title}
                        className="h-18 w-12 shrink-0 rounded-md object-cover ring-1 ring-border/70"
                      />
                      <div className="flex min-w-0 flex-col gap-1">
                        <span className="truncate text-base leading-5 font-medium text-foreground">
                          {media.title}
                        </span>
                        <span className="text-xs leading-4 text-muted-foreground">
                          {media.type === "movie" ? "电影" : "剧集"} · {media.year} · {media.region}
                        </span>
                        <div className="flex items-center gap-2 pt-1 text-xs leading-4">
                          <span className="shrink-0 text-muted-foreground">大家在找</span>
                          <span className="truncate text-foreground/90">{item.lookingFor}</span>
                        </div>
                      </div>
                    </Link>
                  </div>

                  <div className="flex shrink-0 items-center gap-4">
                    <div className="hidden w-44 flex-col items-start gap-1.5 sm:flex">
                      <span className="text-xs text-muted-foreground">已收录</span>
                      {item.existingPlatforms.length > 0 ? (
                        <div className="flex items-center gap-2">
                          {item.existingPlatforms.map((ns) => (
                            <NamespaceLogo key={ns} namespace={ns} className="size-7" />
                          ))}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground/70">暂无</span>
                      )}
                    </div>

                    <div className="w-30 text-right text-sm font-medium text-foreground">
                      被查询 {item.queryCount30d} 次
                    </div>

                    <Button
                      variant="outline"
                      size="sm"
                      nativeButton={false}
                      render={
                        <Link
                          to="/media/$mediaId"
                          params={{ mediaId: media.id }}
                          search={{ contribute: 1 }}
                        />
                      }
                    >
                      补充
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {hasMore && (
          <div className="mt-6 flex justify-center">
            <Button variant="ghost" size="default" onClick={() => setVisibleCount((n) => n + 8)}>
              显示更多
            </Button>
          </div>
        )}
      </main>
    </div>
  );
}
