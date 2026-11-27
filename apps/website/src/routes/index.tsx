import { Alert, AlertDescription } from "@media-ref/ui/components/alert";
import { Button } from "@media-ref/ui/components/button";
import { Empty, EmptyHeader, EmptyTitle } from "@media-ref/ui/components/empty";
import { Skeleton } from "@media-ref/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { NamespaceLogo } from "#/components/brand-logos";
import { categoryLabelOf, MediaCard, MediaCardSkeleton } from "#/components/media-card";
import { SearchBox } from "#/components/search-box";
import { TopNav } from "#/components/top-nav";
import { BROWSE_SLUGS, DISCOVERY_CATALOGS, PLATFORM_COUNT, type BrowseSlug } from "#/lib/catalogs";
import { formatCount } from "#/lib/format";
import { demandsQuery, trendingQuery } from "#/lib/queries";

const SHELF_SIZE = 6;
const URGENT_SIZE = 4;

export const Route = createFileRoute("/")({
  // prefetchQuery never throws: a failing section shows its own error instead of failing the page.
  loader: ({ context: { queryClient } }) =>
    Promise.all([
      ...BROWSE_SLUGS.map((slug) =>
        queryClient.prefetchQuery(trendingQuery(slug, "all", SHELF_SIZE)),
      ),
      queryClient.prefetchQuery(demandsQuery(URGENT_SIZE)),
    ]),
  component: DiscoveryHomePage,
});

function DiscoveryHomePage() {
  const { data: tmdbTrending } = useQuery(trendingQuery("tmdb", "all", SHELF_SIZE));
  const backdropUrl = tmdbTrending?.find((card) => card.posterUrl)?.posterUrl;

  return (
    <div className="relative min-h-screen bg-background text-foreground">
      {/* Page-level atmospheric backdrop that fades smoothly behind the first shelf header */}
      {backdropUrl && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-115 overflow-hidden"
        >
          <img
            src={backdropUrl}
            alt=""
            referrerPolicy="no-referrer"
            className="h-full w-full scale-105 object-cover object-center opacity-30 blur-xs"
          />
          <div className="absolute inset-0 bg-linear-to-b from-background/0 from-25% to-background" />
        </div>
      )}

      <TopNav hideSearch transparent />

      {/* Hero Centerpiece — above <main> so the search dropdown overlaps the shelves (#133) */}
      <section className="relative z-20 container flex flex-col items-center pt-24 pb-10 text-center">
        <h1 className="font-display text-4xl leading-tight font-bold tracking-tight text-foreground sm:text-display">
          这部剧，在哪儿能看？
        </h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground sm:text-base">
          查一部电影或剧在哔哩哔哩、腾讯视频、爱奇艺、优酷、芒果 TV 上的位置，精确到第几季第几集
        </p>

        <div className="mt-7 w-full max-w-180 text-left">
          <SearchBox size="hero" placeholder="搜片名，或粘贴任意平台 / 资料站网址" />
        </div>
      </section>

      {/* Main Content */}
      <main className="relative z-10 container flex flex-col gap-14 pt-6 pb-20">
        {BROWSE_SLUGS.map((slug) => (
          <Shelf key={slug} slug={slug} />
        ))}

        {/* Urgent contributions section */}
        <section className="flex flex-col gap-5">
          <div className="flex items-end justify-between gap-4">
            <div className="flex flex-col gap-1">
              <h2 className="text-xl leading-7 font-bold tracking-tight text-foreground">
                急需补充
              </h2>
              <p className="text-sm text-muted-foreground">
                很多人查过，但平台记录还很少。补上一条，下一个人就能直接找到
              </p>
            </div>
            <Link
              to="/wanted"
              className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              查看全部
            </Link>
          </div>

          <UrgentList />
        </section>
      </main>
    </div>
  );
}

function Shelf({ slug }: { slug: BrowseSlug }) {
  const config = DISCOVERY_CATALOGS[slug];
  const { data, isPending, isError } = useQuery(trendingQuery(slug, "all", SHELF_SIZE));

  return (
    <section className="flex flex-col gap-5">
      <div className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <NamespaceLogo namespace={slug} className="size-6" />
            <h2 className="text-xl leading-7 font-bold tracking-tight text-foreground">
              {config.shelfTitle}
            </h2>
          </div>
          <p className="text-sm text-muted-foreground">{config.shelfSubtitle}</p>
        </div>

        <Link
          to="/discover/$catalog"
          params={{ catalog: slug }}
          className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          查看全部
        </Link>
      </div>

      {isError ? (
        <Alert variant="destructive">
          <AlertDescription>{config.title} 的热门内容暂时加载不出来，请稍后刷新</AlertDescription>
        </Alert>
      ) : data?.length === 0 ? (
        <Empty className="border border-border">
          <EmptyHeader>
            <EmptyTitle>暂时没有热门内容</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid grid-cols-2 gap-x-5 gap-y-6 sm:grid-cols-3 md:grid-cols-6">
          {isPending
            ? Array.from({ length: SHELF_SIZE }, (_, i) => <MediaCardSkeleton key={i} />)
            : data.map((item) => <MediaCard key={item.key} item={item} />)}
        </div>
      )}
    </section>
  );
}

function UrgentList() {
  const { data, isPending, isError } = useQuery(demandsQuery(URGENT_SIZE));

  if (isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>急需补充的列表暂时加载不出来，请稍后刷新</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      {data?.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>暂时没有急需补充的条目</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="divide-y divide-border/70">
          {isPending
            ? Array.from({ length: URGENT_SIZE }, (_, i) => (
                <div key={i} className="flex items-center gap-3.5 px-5 py-3.5">
                  <Skeleton className="h-12 w-8 shrink-0 rounded-md" />
                  <div className="flex flex-col gap-1.5">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-3 w-28" />
                  </div>
                </div>
              ))
            : data.map(({ id, card, demandCount }) => (
                <div
                  key={id}
                  className="flex items-center justify-between gap-4 px-5 py-3.5 transition-colors hover:bg-muted/25"
                >
                  <Link
                    to="/media/$mediaId"
                    params={{ mediaId: card.id }}
                    className="flex min-w-0 flex-1 items-center gap-3.5"
                  >
                    {card.posterUrl ? (
                      <img
                        src={card.posterUrl}
                        alt={card.title}
                        referrerPolicy="no-referrer"
                        className="h-12 w-8 shrink-0 rounded-md object-cover ring-1 ring-border/70"
                      />
                    ) : (
                      <div className="h-12 w-8 shrink-0 rounded-md bg-muted ring-1 ring-border/70" />
                    )}
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-foreground">
                        {card.title}
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {card.year ? `${card.year} · ` : ""}
                        {categoryLabelOf(card.category)} · 已收录 {card.platforms.length} /{" "}
                        {PLATFORM_COUNT}
                      </div>
                    </div>
                  </Link>

                  <div className="flex shrink-0 items-center gap-5">
                    <div className="text-right">
                      <div className="font-mono text-base font-bold text-foreground">
                        {formatCount(demandCount)} 次
                      </div>
                      <div className="text-2xs text-muted-foreground">被查询</div>
                    </div>

                    <Button
                      variant="outline"
                      size="default"
                      nativeButton={false}
                      render={
                        <Link
                          to="/media/$mediaId"
                          params={{ mediaId: card.id }}
                          search={{ contribute: 1 }}
                        />
                      }
                    >
                      去补充
                    </Button>
                  </div>
                </div>
              ))}
        </div>
      )}
    </div>
  );
}
