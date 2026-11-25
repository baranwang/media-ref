import { Button } from "@media-ref/ui/components/button";
import { createFileRoute, Link } from "@tanstack/react-router";
import { NamespaceLogo } from "#/components/brand-logos";
import { MediaCard } from "#/components/media-card";
import { SearchBox } from "#/components/search-box";
import { TopNav } from "#/components/top-nav";
import { useAppStore } from "#/lib/app-store";
import {
  DISCOVERY_CATALOGS,
  HOME_SHELF_MEDIA_IDS,
  HOME_URGENT_DEMANDS,
  TMDB_BACKDROP,
} from "#/lib/catalog-data";

export const Route = createFileRoute("/")({
  component: DiscoveryHomePage,
});

const SHELF_ORDER = ["tmdb", "douban", "bangumi", "trakt"] as const;

function DiscoveryHomePage() {
  const { getMediaById } = useAppStore();

  return (
    <div className="relative min-h-screen bg-background text-foreground">
      {/* Page-level atmospheric backdrop that fades smoothly behind the first shelf header */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-115 overflow-hidden"
      >
        <img
          src={TMDB_BACKDROP("zxfBtHz5UmSTfIEC4O4GngyjHwa.jpg")}
          alt=""
          className="h-full w-full scale-105 object-cover object-center opacity-30 blur-xs"
        />
        <div className="absolute inset-0 bg-linear-to-b from-background/0 from-25% to-background" />
      </div>

      <TopNav hideSearch transparent />

      {/* Hero Centerpiece */}
      <section className="relative z-10 container flex flex-col items-center pt-24 pb-10 text-center">
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
        {SHELF_ORDER.map((catalogKey) => {
          const config = DISCOVERY_CATALOGS[catalogKey];
          const items = HOME_SHELF_MEDIA_IDS[catalogKey]
            .map((id) => getMediaById(id))
            .filter((item): item is NonNullable<typeof item> => Boolean(item));

          return (
            <section key={catalogKey} className="flex flex-col gap-5">
              <div className="flex items-end justify-between gap-4">
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <NamespaceLogo namespace={catalogKey} className="size-6" />
                    <h2 className="text-xl leading-7 font-bold tracking-tight text-foreground">
                      {config.shelfTitle}
                    </h2>
                  </div>
                  <p className="text-sm text-muted-foreground">{config.shelfSubtitle}</p>
                </div>

                <Link
                  to="/discover/$catalog"
                  params={{ catalog: catalogKey }}
                  className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  查看全部
                </Link>
              </div>

              <div className="grid grid-cols-2 gap-x-5 gap-y-6 sm:grid-cols-3 md:grid-cols-6">
                {items.map((item) => (
                  <MediaCard key={`${catalogKey}-${item.id}`} item={item} />
                ))}
              </div>
            </section>
          );
        })}

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
              to="/contribute"
              className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              查看全部
            </Link>
          </div>

          <div className="overflow-hidden rounded-xl border border-border bg-card">
            <div className="divide-y divide-border/70">
              {HOME_URGENT_DEMANDS.map((demand) => {
                const media = getMediaById(demand.mediaId);
                if (!media) return null;
                const platformCount = new Set(media.platformRows.map((r) => r.namespace)).size;
                const categoryLabel =
                  media.type === "movie" ? "电影" : media.category === "anime" ? "动画" : "剧集";

                return (
                  <div
                    key={demand.id}
                    className="flex items-center justify-between gap-4 px-5 py-3.5 transition-colors hover:bg-muted/25"
                  >
                    <Link
                      to="/media/$mediaId"
                      params={{ mediaId: media.id }}
                      className="flex min-w-0 flex-1 items-center gap-3.5"
                    >
                      <img
                        src={media.posterUrl}
                        alt={media.title}
                        className="h-12 w-8 shrink-0 rounded-md object-cover ring-1 ring-border/70"
                      />
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-foreground">
                          {media.title}
                        </div>
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {media.year} · {categoryLabel} · 可看平台 {platformCount} / 5
                        </div>
                      </div>
                    </Link>

                    <div className="flex shrink-0 items-center gap-5">
                      <div className="text-right">
                        <div className="font-mono text-base font-bold text-foreground">
                          {(demand.queryCount7d ?? demand.queryCount30d).toLocaleString("en-US")} 次
                        </div>
                        <div className="text-2xs text-muted-foreground">近 7 天被查询</div>
                      </div>

                      <Button
                        variant="outline"
                        size="default"
                        nativeButton={false}
                        render={
                          <Link
                            to="/media/$mediaId"
                            params={{ mediaId: media.id }}
                            search={{ contribute: 1 }}
                          />
                        }
                      >
                        去补充
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
