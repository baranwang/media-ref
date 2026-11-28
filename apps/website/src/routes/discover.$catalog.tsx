import { Alert, AlertDescription } from "@media-ref/ui/components/alert";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@media-ref/ui/components/breadcrumb";
import { Empty, EmptyHeader, EmptyTitle } from "@media-ref/ui/components/empty";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@media-ref/ui/components/select";
import { Tabs, TabsList, TabsTrigger } from "@media-ref/ui/components/tabs";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { NamespaceLogo } from "#/components/brand-logos";
import { MediaCard, MediaCardSkeleton } from "#/components/media-card";
import { TopNav } from "#/components/top-nav";
import { DISCOVERY_CATALOGS, isBrowseSlug } from "#/lib/catalogs";
import { trendingQuery } from "#/lib/queries";
import type { MediaCategory } from "#/lib/types";

const PAGE_SIZE = 40;

export const Route = createFileRoute("/discover/$catalog")({
  loader: async ({ params, context: { queryClient } }) => {
    if (!isBrowseSlug(params.catalog)) throw notFound();
    // prefetchQuery never throws: a failed load shows an in-page error instead.
    await queryClient.prefetchQuery(trendingQuery(params.catalog, "all", PAGE_SIZE));
    return { slug: params.catalog };
  },
  head: ({ loaderData }) => {
    const catalog = loaderData && DISCOVERY_CATALOGS[loaderData.slug];
    return catalog
      ? {
          meta: [
            { title: `${catalog.title} 热门 · MediaRef` },
            { name: "description", content: catalog.pageSubtitle },
          ],
        }
      : {};
  },
  component: DiscoverCatalogPage,
});

type CategoryFilter = "all" | MediaCategory;
type SortOption = "popular" | "missing";

const CATEGORY_TABS: Array<{ value: CategoryFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "tv", label: "剧集" },
  { value: "movie", label: "电影" },
  { value: "anime", label: "动画" },
];

function DiscoverCatalogPage() {
  const { slug: catalogKey } = Route.useLoaderData();
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [sortBy, setSortBy] = useState<SortOption>("popular");
  const config = DISCOVERY_CATALOGS[catalogKey];
  const { data: items, isPending, isError } = useQuery(trendingQuery(catalogKey, "all", PAGE_SIZE));

  const countOf = (value: CategoryFilter) =>
    value === "all"
      ? (items?.length ?? 0)
      : (items?.filter((item) => item.category === value).length ?? 0);

  const filteredItems = useMemo(() => {
    const list =
      category === "all" ? (items ?? []) : (items ?? []).filter((i) => i.category === category);
    return sortBy === "missing"
      ? [...list].sort((a, b) => a.platforms.length - b.platforms.length)
      : list;
  }, [items, category, sortBy]);

  return (
    <div className="flex-1 bg-background text-foreground">
      <TopNav />

      <main className="container flex flex-col pb-20">
        {/* Page Head */}
        <section className="flex flex-col gap-2 pt-8 sm:pt-12">
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
          <Tabs
            value={category}
            onValueChange={(v) => setCategory(v as CategoryFilter)}
            className="max-w-full min-w-0"
          >
            <TabsList className="no-scrollbar max-w-full justify-start overflow-x-auto overflow-y-hidden">
              {CATEGORY_TABS.map((tab) => (
                <TabsTrigger key={tab.value} value={tab.value} className="shrink-0 gap-1.5 px-3">
                  <span>{tab.label}</span>
                  {items && (
                    <span className="font-mono text-2xs text-muted-foreground">
                      {countOf(tab.value)}
                    </span>
                  )}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          <Select value={sortBy} onValueChange={(v) => v && setSortBy(v as SortOption)}>
            <SelectTrigger className="w-full sm:w-40">
              <SelectValue>{sortBy === "popular" ? config.sortLabel : "按缺平台优先"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="popular">{config.sortLabel}</SelectItem>
              <SelectItem value="missing">按缺平台优先</SelectItem>
            </SelectContent>
          </Select>
        </section>

        {/* 6-column Grid */}
        {isError ? (
          <Alert variant="destructive" className="mt-6">
            <AlertDescription>{config.title} 的热门内容暂时加载不出来，请稍后刷新</AlertDescription>
          </Alert>
        ) : !isPending && filteredItems.length === 0 ? (
          <Empty className="mt-6 border border-border">
            <EmptyHeader>
              <EmptyTitle>这个分类下暂时没有内容</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <section className="grid grid-cols-2 gap-x-3.5 gap-y-8 pt-6 sm:grid-cols-3 sm:gap-x-5 md:grid-cols-6">
            {isPending
              ? Array.from({ length: 12 }, (_, i) => <MediaCardSkeleton key={i} />)
              : filteredItems.map((item) => <MediaCard key={item.key} item={item} />)}
          </section>
        )}
      </main>
    </div>
  );
}
