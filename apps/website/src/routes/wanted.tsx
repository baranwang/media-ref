import { Button } from "@media-ref/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@media-ref/ui/components/empty";
import { Tabs, TabsList, TabsTrigger } from "@media-ref/ui/components/tabs";
import { infiniteQueryOptions, useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { NamespaceLogo } from "#/components/brand-logos";
import { TopNav } from "#/components/top-nav";
import { fetchDemands } from "#/lib/server-fns";

const PAGE_SIZE = 20;

const demandPagesQuery = infiniteQueryOptions({
  queryKey: ["demands", "pages", PAGE_SIZE],
  queryFn: ({ pageParam }) => fetchDemands({ data: { limit: PAGE_SIZE, offset: pageParam } }),
  initialPageParam: 0,
  // shortcut: a short page means the end; rows dropped by the mapper can end paging early.
  getNextPageParam: (lastPage, pages) =>
    lastPage.length < PAGE_SIZE ? undefined : pages.length * PAGE_SIZE,
  staleTime: 60_000,
});

export const Route = createFileRoute("/wanted")({
  loader: ({ context }) => context.queryClient.ensureInfiniteQueryData(demandPagesQuery),
  component: WantedPage,
});

type DemandTab = "all" | "tv" | "movie";

function WantedPage() {
  const [tab, setTab] = useState<DemandTab>("all");
  const { data, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(demandPagesQuery);

  const all = data.pages.flat();
  const counts = {
    all: all.length,
    tv: all.filter((d) => d.card.type === "tv").length,
    movie: all.filter((d) => d.card.type === "movie").length,
  };
  const shown = tab === "all" ? all : all.filter((d) => d.card.type === tab);

  return (
    <div className="flex-1 bg-background text-foreground">
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
                <span className="font-mono text-2xs text-muted-foreground">{counts.all}</span>
              </TabsTrigger>
              <TabsTrigger value="tv" className="gap-1.5 px-3">
                <span>剧集</span>
                <span className="font-mono text-2xs text-muted-foreground">{counts.tv}</span>
              </TabsTrigger>
              <TabsTrigger value="movie" className="gap-1.5 px-3">
                <span>电影</span>
                <span className="font-mono text-2xs text-muted-foreground">{counts.movie}</span>
              </TabsTrigger>
            </TabsList>
          </Tabs>

          <span className="text-sm text-muted-foreground">按累计被查询次数排序</span>
        </section>

        {/* Ranked Demand Card */}
        {shown.length === 0 ? (
          <Empty className="mt-5 rounded-xl border border-border bg-card py-16">
            <EmptyHeader>
              <EmptyTitle>暂时没有待贡献的媒体</EmptyTitle>
              <EmptyDescription>有人查过但还缺平台记录的媒体会出现在这里。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <section className="mt-5 overflow-hidden rounded-xl border border-border bg-card">
            <div className="divide-y divide-border/70">
              {shown.map((item, idx) => {
                const media = item.card;
                return (
                  <div
                    key={item.id}
                    className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 px-4 py-3.5 transition-colors hover:bg-muted/25 sm:px-5"
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-4">
                      <span className="min-w-5 shrink-0 text-center font-mono text-sm font-medium text-muted-foreground">
                        {idx + 1}
                      </span>

                      <Link
                        to="/media/$mediaId"
                        params={{ mediaId: media.id }}
                        className="flex min-w-0 flex-1 items-center gap-4"
                      >
                        {media.posterUrl ? (
                          <img
                            src={media.posterUrl}
                            alt={media.title}
                            loading="lazy"
                            referrerPolicy="no-referrer"
                            className="h-18 w-12 shrink-0 rounded-md object-cover ring-1 ring-border/70"
                          />
                        ) : (
                          <div className="h-18 w-12 shrink-0 rounded-md bg-muted ring-1 ring-border/70" />
                        )}
                        <div className="flex min-w-0 flex-col gap-1">
                          <span className="truncate text-base leading-5 font-medium text-foreground">
                            {media.title}
                          </span>
                          <span className="text-xs leading-4 text-muted-foreground">
                            {media.type === "movie" ? "电影" : "剧集"}
                            {media.year ? ` · ${media.year}` : ""}
                          </span>
                          <div className="flex items-center gap-2 pt-1 text-xs leading-4">
                            <span className="shrink-0 text-muted-foreground">大家在找</span>
                            <span className="truncate text-foreground/90">
                              {item.season === null ? "整部" : `第 ${item.season} 季`}
                            </span>
                          </div>
                        </div>
                      </Link>
                    </div>

                    {/* Below md: a second line under poster+title (rank min-w-5 + gap-4 = pl-9); 已收录 and 被查询 stack left, 补充 sits right */}
                    <div className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 pl-9 md:flex md:w-auto md:shrink-0 md:gap-4 md:pl-0">
                      <div className="flex items-center gap-1.5 md:w-44 md:flex-col md:items-start">
                        <span className="text-xs text-muted-foreground">已收录</span>
                        {media.platforms.length > 0 ? (
                          <div className="flex items-center gap-1.5 md:gap-2">
                            {media.platforms.map((ns) => (
                              <NamespaceLogo
                                key={ns}
                                namespace={ns}
                                className="size-4.5 md:size-7"
                              />
                            ))}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground/70">暂无</span>
                        )}
                      </div>

                      <div className="col-start-1 text-sm font-medium text-foreground md:w-30 md:text-right">
                        被查询 {item.demandCount} 次
                      </div>

                      <Button
                        variant="outline"
                        size="sm"
                        className="col-start-2 row-span-2 row-start-1"
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
        )}

        {hasNextPage && (
          <div className="mt-6 flex justify-center">
            <Button
              variant="ghost"
              size="default"
              disabled={isFetchingNextPage}
              onClick={() => void fetchNextPage()}
            >
              {isFetchingNextPage ? "加载中…" : "显示更多"}
            </Button>
          </div>
        )}
      </main>
    </div>
  );
}
