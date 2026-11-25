import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@media-ref/ui/components/breadcrumb";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@media-ref/ui/components/select";
import { Tabs, TabsList, TabsTrigger } from "@media-ref/ui/components/tabs";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { NamespaceLogo } from "#/components/brand-logos";
import { MediaCard } from "#/components/media-card";
import { TopNav } from "#/components/top-nav";
import { useAppStore } from "#/lib/app-store";
import {
  DISCOVERY_CATALOGS,
  DOUBAN_CATALOG_MEDIA_IDS,
  HOME_SHELF_MEDIA_IDS,
} from "#/lib/catalog-data";

export const Route = createFileRoute("/discover/$catalog")({
  component: DiscoverCatalogPage,
});

type CategoryFilter = "all" | "tv" | "movie" | "anime";
type SortOption = "popular" | "newest" | "missing";

function DiscoverCatalogPage() {
  const { catalog } = Route.useParams();
  const { mediaList, getMediaById } = useAppStore();
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [sortBy, setSortBy] = useState<SortOption>("popular");

  const catalogKey =
    catalog === "tmdb" || catalog === "douban" || catalog === "bangumi" || catalog === "trakt"
      ? catalog
      : "douban";
  const config = DISCOVERY_CATALOGS[catalogKey];

  const baseItems = useMemo(() => {
    const preferredIds =
      catalogKey === "douban" ? DOUBAN_CATALOG_MEDIA_IDS : HOME_SHELF_MEDIA_IDS[catalogKey];
    const preferred = preferredIds
      .map((id) => getMediaById(id))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    const seen = new Set(preferred.map((i) => i.id));
    const extras = mediaList.filter((m) => !seen.has(m.id));
    return [...preferred, ...extras].slice(0, 18);
  }, [catalogKey, getMediaById, mediaList]);

  const filteredItems = useMemo(() => {
    const list =
      category === "all"
        ? baseItems
        : baseItems.filter((item) => {
            if (category === "movie") return item.type === "movie";
            if (category === "anime") return item.category === "anime";
            return item.category === "tv";
          });

    if (sortBy === "newest") {
      return [...list].sort((a, b) => b.year - a.year);
    }
    if (sortBy === "missing") {
      return [...list].sort((a, b) => a.platformRows.length - b.platformRows.length);
    }
    return list;
  }, [baseItems, category, sortBy]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <TopNav />

      <main className="container flex flex-col pb-20">
        {/* Page Head */}
        <section className="flex flex-col gap-2 pt-12">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink render={<Link to="/" />}>发现</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator>/</BreadcrumbSeparator>
              <BreadcrumbItem>
                <BreadcrumbPage>{config.title}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>

          <div className="mt-1 flex items-center gap-3">
            <NamespaceLogo namespace={catalogKey} className="size-10" />
            <h1 className="font-display text-4xl leading-tight font-bold tracking-tight text-foreground sm:text-display">
              {config.title}
            </h1>
          </div>

          <p className="text-sm text-muted-foreground">{config.pageSubtitle}</p>
        </section>

        {/* Filter Bar */}
        <section className="flex flex-wrap items-center justify-between gap-3 pt-7">
          <Tabs value={category} onValueChange={(v) => setCategory(v as CategoryFilter)}>
            <TabsList>
              <TabsTrigger value="all" className="gap-1.5 px-3">
                <span>全部</span>
                <span className="font-mono text-2xs text-muted-foreground">
                  {config.counts.all.toLocaleString("en-US")}
                </span>
              </TabsTrigger>
              <TabsTrigger value="tv" className="gap-1.5 px-3">
                <span>剧集</span>
                <span className="font-mono text-2xs text-muted-foreground">
                  {config.counts.tv.toLocaleString("en-US")}
                </span>
              </TabsTrigger>
              <TabsTrigger value="movie" className="gap-1.5 px-3">
                <span>电影</span>
                <span className="font-mono text-2xs text-muted-foreground">
                  {config.counts.movie.toLocaleString("en-US")}
                </span>
              </TabsTrigger>
              <TabsTrigger value="anime" className="gap-1.5 px-3">
                <span>动画</span>
                <span className="font-mono text-2xs text-muted-foreground">
                  {config.counts.anime.toLocaleString("en-US")}
                </span>
              </TabsTrigger>
            </TabsList>
          </Tabs>

          <Select value={sortBy} onValueChange={(v) => v && setSortBy(v as SortOption)}>
            <SelectTrigger className="w-40">
              <SelectValue>
                {sortBy === "popular"
                  ? config.sortLabel
                  : sortBy === "newest"
                    ? "按年份最新"
                    : "按缺平台优先"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="popular">{config.sortLabel}</SelectItem>
              <SelectItem value="newest">按年份最新</SelectItem>
              <SelectItem value="missing">按缺平台优先</SelectItem>
            </SelectContent>
          </Select>
        </section>

        {/* 6-column Grid */}
        <section className="grid grid-cols-2 gap-x-5 gap-y-8 pt-6 sm:grid-cols-3 md:grid-cols-6">
          {filteredItems.map((item) => (
            <MediaCard key={item.id} item={item} />
          ))}
        </section>
      </main>
    </div>
  );
}
