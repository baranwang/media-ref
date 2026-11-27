import { Badge } from "@media-ref/ui/components/badge";
import { Button } from "@media-ref/ui/components/button";
import { ButtonGroup } from "@media-ref/ui/components/button-group";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@media-ref/ui/components/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@media-ref/ui/components/empty";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@media-ref/ui/components/select";
import { Skeleton } from "@media-ref/ui/components/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@media-ref/ui/components/tabs";
import { cn } from "@media-ref/ui/lib/utils";
import {
  RiAddLine,
  RiArrowLeftSLine,
  RiArrowRightSLine,
  RiArrowRightUpLine,
} from "@remixicon/react";
import { useQueries, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { NAMESPACE_LABELS, NamespaceLogo } from "#/components/brand-logos";
import { ContributeDrawer } from "#/components/contribute-drawer";
import { CoverageLegend, CoverageRuler, CoverageTrack } from "#/components/coverage-bar";
import { TopNav } from "#/components/top-nav";
import { useAppStore } from "#/lib/app-store";
import { PLATFORM_COUNT } from "#/lib/catalogs";
import { formatDate, formatSegmentEpisodeLabel } from "#/lib/format";
import { LONG_SERIES_SEASONS } from "#/lib/mappers";
import { associationRevisionsQuery, mediaDetailQuery } from "#/lib/queries";
import type { CoverageSegment, PlatformVariantRow } from "#/lib/types";
import { buildExternalUrl, parseExternalInput } from "#/lib/url-parser";

interface MediaDetailSearch {
  season?: number;
  view?: "season" | "all";
  contribute?: number;
}

export const Route = createFileRoute("/media/$mediaId")({
  validateSearch: (search: Record<string, unknown>): MediaDetailSearch => ({
    season:
      typeof search.season === "number"
        ? search.season
        : typeof search.season === "string" && !Number.isNaN(Number(search.season))
          ? Number(search.season)
          : undefined,
    view: search.view === "all" ? "all" : undefined,
    contribute: search.contribute === 1 || search.contribute === "1" ? 1 : undefined,
  }),
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(mediaDetailQuery(params.mediaId)),
  head: ({ loaderData: media }) =>
    media
      ? {
          meta: [
            { title: `${media.title}${media.year ? ` (${media.year})` : ""} 在哪儿看 · MediaRef` },
            {
              name: "description",
              content: `${media.title} 在各视频平台的播放链接与分集覆盖情况。`,
            },
          ],
        }
      : {},
  component: MediaDetailPage,
});

function MediaDetailPage() {
  const { mediaId } = Route.useParams();
  const search = Route.useSearch();

  const { data: media } = useSuspenseQuery(mediaDetailQuery(mediaId));
  const initialSeason = search.season ?? media?.defaultSeason ?? media?.seasons[0]?.season ?? 1;

  const [selectedSeason, setSelectedSeason] = useState(initialSeason);
  const [viewMode, setViewMode] = useState<"season" | "all">(search.view ?? "season");
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(search.contribute === 1);
  const [drawerPrefill, setDrawerPrefill] = useState<{
    url?: string;
    variant?: string;
  }>({});
  const [history, setHistory] = useState<{
    row: PlatformVariantRow;
    segments: CoverageSegment[];
  } | null>(null);

  useEffect(() => {
    if (!media) return;
    setSelectedSeason(search.season ?? media.defaultSeason ?? media.seasons[0]?.season ?? 1);
    setViewMode(search.view ?? "season");
    setExpandedRowId(null);
    if (search.contribute === 1) {
      setDrawerOpen(true);
    }
  }, [media, search.season, search.view, search.contribute]);

  const currentSeasonInfo = useMemo(
    () => media?.seasons.find((s) => s.season === selectedSeason),
    [media, selectedSeason],
  );

  if (!media) {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <TopNav />
        <main className="container flex flex-col items-center justify-center py-28 text-center">
          <h1 className="text-xl font-semibold">找不到这部媒体</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            可以返回发现页搜索片名，或粘贴视频平台网址查找
          </p>
          <Button className="mt-6" nativeButton={false} render={<Link to="/" />}>
            返回发现页
          </Button>
        </main>
      </div>
    );
  }

  const isMovie = media.type === "movie" || media.seasons.length === 0;
  const isLongSeries = media.seasons.length > LONG_SERIES_SEASONS;
  const isAllSeasons = !isMovie && isLongSeries && viewMode === "all";
  const seasonCount = media.seasons.length;
  const totalEpisodesForAxis = isMovie
    ? 1
    : isAllSeasons
      ? seasonCount
      : (currentSeasonInfo?.episodeCount ?? 1);

  const segmentsInView = (row: (typeof media.platformRows)[number]): CoverageSegment[] =>
    isMovie
      ? (row.segmentsBySeason[0] ?? [])
      : isAllSeasons
        ? (row.allSeasonSegments ?? [])
        : (row.segmentsBySeason[selectedSeason] ?? []);
  // A platform with nothing for this season has no page to link to, so it gets no row here.
  const platformRows = media.platformRows.filter((row) => segmentsInView(row).length > 0);
  const platformSegments = platformRows.flatMap(segmentsInView);
  const hasNonLinearPlatform =
    !isMovie && !isAllSeasons && platformSegments.some((s) => s.nonLinear);
  const allNonLinearPlatform =
    !isMovie &&
    !isAllSeasons &&
    platformSegments.length > 0 &&
    platformSegments.every((s) => s.nonLinear && s.start <= 1 && s.end >= totalEpisodesForAxis);

  const availablePlatformCount = new Set(media.platformRows.map((r) => r.namespace)).size;
  const catalogLink = parseExternalInput(media.catalogKey);

  const catalogSegmentsInView = (row: (typeof media.catalogRows)[number]) =>
    (isMovie
      ? row.segmentsBySeason?.[0]
      : isAllSeasons
        ? row.allSeasonSegments
        : row.segmentsBySeason?.[selectedSeason]) ?? [];
  // Same as platforms: a catalog with no whole entry and nothing for this season has no link.
  const catalogRows = media.catalogRows.filter(
    (row) => row.externalUrl || row.wholeMediaNativeId || catalogSegmentsInView(row).length > 0,
  );

  const showCatalogRuler =
    !isMovie &&
    (platformRows.length === 0 || isLongSeries || allNonLinearPlatform) &&
    catalogRows.some((r) => catalogSegmentsInView(r).length > 0);

  const openContribute = (prefill?: { url?: string; variant?: string }) => {
    setDrawerPrefill(prefill ?? {});
    setDrawerOpen(true);
  };

  return (
    <div className="relative min-h-screen bg-background text-foreground">
      {/* Page-level backdrop with vertical & horizontal fade matching Figma 02A */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-126 overflow-hidden"
      >
        {media.backdropUrl && (
          <img
            src={media.backdropUrl}
            alt=""
            referrerPolicy="no-referrer"
            className="h-full w-full scale-105 object-cover object-center opacity-30 blur-xs"
          />
        )}
        <div className="absolute inset-0 bg-linear-to-b from-background/0 from-30% to-background" />
        <div className="absolute inset-0 bg-linear-to-r from-background via-background/85 via-30% to-background/15" />
      </div>

      <TopNav transparent />

      {/* Hero Section (02A / 02B / 02E) */}
      <section className="relative z-10 container flex flex-col gap-8 pt-12 pb-10 md:flex-row md:gap-10">
        {/* 240x360 Poster */}
        <div className="aspect-2/3 w-50 shrink-0 overflow-hidden rounded-xl bg-card shadow-2xl ring-1 ring-white/10 md:aspect-auto md:h-90 md:w-60">
          {media.posterUrl && (
            <img
              src={media.posterUrl}
              alt={media.title}
              referrerPolicy="no-referrer"
              className="h-full w-full object-cover"
            />
          )}
        </div>

        {/* Right Info Column aligned with bottom of poster */}
        <div className="flex min-w-0 flex-1 flex-col justify-between gap-5 md:min-h-90">
          <div className="flex flex-col gap-3.5">
            {/* Metadata line */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              {[
                media.type === "movie" ? "电影" : "剧集",
                media.yearRange,
                media.region,
                isMovie
                  ? ""
                  : `${seasonCount} 季 · ${media.totalEpisodes ?? totalEpisodesForAxis} 集`,
                media.statusLabel,
              ]
                .filter(Boolean)
                .flatMap((part, i) => [
                  ...(i > 0 ? [<span key={`sep-${i}`}>·</span>] : []),
                  <span key={part}>{part}</span>,
                ])}
            </div>

            {/* Display Serif Title (44px) + Original Title */}
            <div className="flex flex-col gap-1.5">
              <h1 className="font-display text-4xl leading-tight font-bold tracking-tight text-foreground md:text-display">
                {media.title}
              </h1>
              {media.originalTitle && (
                <p className="text-base leading-5 text-muted-foreground">{media.originalTitle}</p>
              )}
            </div>

            {/* Genres */}
            <div className="flex flex-wrap items-center gap-1.5">
              {media.genres.map((genre) => (
                <Badge key={genre} variant="secondary" className="rounded-md px-2 py-0.5 text-2xs">
                  {genre}
                </Badge>
              ))}
            </div>

            {/* Synopsis clamped to 3 lines */}
            <p className="line-clamp-3 max-w-3xl text-sm leading-6 text-foreground/85">
              {media.synopsis}
            </p>

            {/* Credits + Platform count */}
            <div className="flex flex-wrap items-center gap-x-8 gap-y-2 pt-1">
              {media.credits.map((credit) => (
                <div key={credit.role} className="flex flex-col gap-0.5">
                  <span className="text-2xs text-muted-foreground">{credit.role}</span>
                  <span className="text-sm font-medium text-foreground">{credit.name}</span>
                </div>
              ))}
              <div className="flex flex-col gap-0.5">
                <span className="text-2xs text-muted-foreground">可看平台</span>
                <span className="font-mono text-sm font-medium text-foreground">
                  {availablePlatformCount} / {PLATFORM_COUNT}
                </span>
              </div>
            </div>
          </div>

          {/* Action buttons aligned to poster bottom */}
          <div className="flex flex-wrap items-center gap-2.5">
            <Button variant="default" size="lg" onClick={() => openContribute()} className="px-3.5">
              <RiAddLine />
              补充关联
            </Button>
            {catalogLink && (
              <Button
                variant="outline"
                size="lg"
                nativeButton={false}
                render={<a href={catalogLink.url} target="_blank" rel="noreferrer" />}
                className="px-3.5"
              >
                在 {NAMESPACE_LABELS[catalogLink.namespace]} 查看
                <RiArrowRightUpLine />
              </Button>
            )}
          </div>
        </div>
      </section>

      {/* Main Content Body */}
      <main className="relative z-10 container flex flex-col pb-20">
        {/* Season Switcher */}
        {!isMovie && (
          <div className="pt-2">
            {!isLongSeries ? (
              <Tabs
                value={String(selectedSeason)}
                onValueChange={(v) => {
                  setSelectedSeason(Number(v));
                  setViewMode("season");
                }}
              >
                <TabsList>
                  {media.seasons.map((s) => (
                    <TabsTrigger key={s.season} value={String(s.season)} className="gap-1.5 px-3">
                      <span>第 {s.season} 季</span>
                      <span className="font-mono text-2xs text-muted-foreground">
                        {s.episodeCount}
                      </span>
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <ButtonGroup>
                  <Button
                    variant="outline"
                    size="icon"
                    disabled={selectedSeason <= 1}
                    aria-label="上一季"
                    onClick={() => {
                      setViewMode("season");
                      setSelectedSeason((s) => Math.max(1, s - 1));
                    }}
                  >
                    <RiArrowLeftSLine />
                  </Button>

                  <Select
                    value={String(selectedSeason)}
                    onValueChange={(v) => {
                      if (!v) return;
                      setViewMode("season");
                      setSelectedSeason(Number(v));
                    }}
                  >
                    <SelectTrigger className="min-w-36">
                      <SelectValue>
                        第 {selectedSeason} 季 · {currentSeasonInfo?.episodeCount ?? 0} 集
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {media.seasons.map((s) => (
                        <SelectItem key={s.season} value={String(s.season)}>
                          第 {s.season} 季 · {s.episodeCount} 集
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <Button
                    variant="outline"
                    size="icon"
                    disabled={selectedSeason >= seasonCount}
                    aria-label="下一季"
                    onClick={() => {
                      setViewMode("season");
                      setSelectedSeason((s) => Math.min(seasonCount, s + 1));
                    }}
                  >
                    <RiArrowRightSLine />
                  </Button>
                </ButtonGroup>

                <Button
                  variant={isAllSeasons ? "secondary" : "outline"}
                  size="default"
                  onClick={() => setViewMode((m) => (m === "all" ? "season" : "all"))}
                >
                  全部 {seasonCount} 季
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Section 1: 在哪看 */}
        <section className="flex flex-col gap-3 pt-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex flex-col gap-1">
              <h2 className="text-xl leading-7 font-bold tracking-tight text-foreground">在哪看</h2>
              <p className="text-sm text-muted-foreground">
                {platformRows.length === 0
                  ? isMovie
                    ? "还没有任何平台记录"
                    : `第 ${selectedSeason} 季 · 还没有任何平台记录`
                  : isMovie
                    ? "以下平台可看正片"
                    : isAllSeasons
                      ? `全部 ${seasonCount} 季 · 看哪几季缺。切回单季看每一集`
                      : allNonLinearPlatform
                        ? `第 ${selectedSeason} 季 · 整季按合集收录，不按 TMDB 的 ${totalEpisodesForAxis} 集逐集拆分，点击「去看」即可`
                        : hasNonLinearPlatform
                          ? `第 ${selectedSeason} 季${isLongSeries ? ` · ${totalEpisodesForAxis} 集` : ""} · 以 TMDB 的集数为准；标有「整季不拆集」的平台直接打开合集观看`
                          : `第 ${selectedSeason} 季${isLongSeries ? ` · ${totalEpisodesForAxis} 集` : ""} · 以 TMDB 的集数为准，横条是每个平台收录的集数`}
              </p>
            </div>
            {platformRows.length > 0 && !isMovie && <CoverageLegend />}
          </div>

          {platformRows.length === 0 ? (
            <Empty className="rounded-xl border border-border bg-card py-14">
              <EmptyHeader>
                <EmptyTitle>
                  还没有人记录{media.platformRows.length > 0 ? "这一季" : "这部剧"}在哪看
                </EmptyTitle>
                <EmptyDescription>
                  知道在哪个平台能看？贴一个播放页网址就行，审核通过后所有人都能查到。
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button variant="outline" size="default" onClick={() => openContribute()}>
                  <RiAddLine />
                  {media.platformRows.length > 0 ? "补充这一季的平台" : "补充第一个平台"}
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <div className="flex flex-col">
              {/* Axis Ruler outside the card, aligned to the coverage track (matching Figma 02A) */}
              {!isMovie && !allNonLinearPlatform && (
                <div className="flex items-center gap-4 px-5 pb-1.5">
                  <div className="w-52 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <CoverageRuler
                      total={totalEpisodesForAxis}
                      mode={isAllSeasons ? "season" : "episode"}
                    />
                  </div>
                  <div className="w-16 shrink-0" />
                </div>
              )}

              <div className="overflow-hidden rounded-xl border border-border bg-card">
                <div className="divide-y divide-border/70">
                  {platformRows.map((row) => {
                    const segments = segmentsInView(row);
                    const externalUrl = buildExternalUrl(
                      row.namespace,
                      segments[0]!.nativeId,
                      media.type,
                    );
                    const isExpanded =
                      expandedRowId === row.id && segments.length > 0 && !isAllSeasons;

                    return (
                      <div key={row.id} className="transition-colors">
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() =>
                            segments.length > 0 &&
                            !isAllSeasons &&
                            setExpandedRowId((cur) => (cur === row.id ? null : row.id))
                          }
                          onKeyDown={(e) => {
                            if (
                              (e.key === "Enter" || e.key === " ") &&
                              segments.length > 0 &&
                              !isAllSeasons
                            ) {
                              e.preventDefault();
                              setExpandedRowId((cur) => (cur === row.id ? null : row.id));
                            }
                          }}
                          className={cn(
                            "flex items-center gap-4 px-5 py-3.5 transition-colors",
                            segments.length > 0 && !isAllSeasons
                              ? "cursor-pointer hover:bg-muted/35"
                              : "cursor-default",
                          )}
                        >
                          {/* Platform Identity */}
                          <div className="flex w-52 shrink-0 items-center gap-3">
                            <NamespaceLogo namespace={row.namespace} className="size-7 shrink-0" />
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium text-foreground">
                                {NAMESPACE_LABELS[row.namespace]}
                              </div>
                              <div className="truncate text-xs text-muted-foreground">
                                {row.label}
                                {row.isDefault ? " · 默认" : ""}
                              </div>
                            </div>
                          </div>

                          {/* Coverage Bar */}
                          <div className="min-w-0 flex-1">
                            <CoverageTrack
                              total={totalEpisodesForAxis}
                              segments={segments}
                              mode={isAllSeasons ? "season" : "episode"}
                            />
                          </div>

                          {/* External Link */}
                          <div className="flex w-16 shrink-0 justify-end">
                            <a
                              href={externalUrl}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="inline-flex items-center gap-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
                            >
                              去看
                              <RiArrowRightUpLine className="size-3.5" />
                            </a>
                          </div>
                        </div>

                        {/* Expanded Segment Details (aligned directly under coverage track, matching 02A) */}
                        {isExpanded && (
                          <div className="flex gap-4 border-t border-border/40 bg-background/25 px-5 py-2">
                            <div className="w-52 shrink-0" />
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-col divide-y divide-border/40">
                                {segments.map((seg) => {
                                  const segUrl = buildExternalUrl(
                                    row.namespace,
                                    seg.nativeId,
                                    media.type,
                                  );
                                  return (
                                    <div
                                      key={seg.id}
                                      className="flex items-center gap-4 py-2 text-xs"
                                    >
                                      <span className="w-28 shrink-0 truncate text-sm font-medium text-foreground">
                                        {seg.title}
                                      </span>
                                      <span className="w-24 shrink-0 truncate font-mono text-xs text-muted-foreground">
                                        {seg.nativeId}
                                      </span>
                                      <span className="w-36 shrink-0 text-xs text-muted-foreground">
                                        {!isMovie
                                          ? formatSegmentEpisodeLabel(
                                              seg.start,
                                              seg.end,
                                              seg.nonLinear,
                                              totalEpisodesForAxis,
                                            )
                                          : "正片"}
                                      </span>
                                      <div className="min-w-0 flex-1">
                                        {seg.status === "pending" ? (
                                          <span className="inline-flex items-center gap-1.5 text-status-warning-fg/90">
                                            <span className="size-1.5 rounded-full bg-status-warning-fg" />
                                            {seg.changeRequestId ? (
                                              <Link
                                                to="/change-requests/$id"
                                                params={{ id: seg.changeRequestId }}
                                                className="underline-offset-4 hover:underline"
                                              >
                                                审核中 · 变更单 #{seg.changeRequestId}
                                              </Link>
                                            ) : (
                                              "待审核"
                                            )}
                                          </span>
                                        ) : (
                                          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                                            <span className="size-1.5 rounded-full bg-status-confirmed-fg" />
                                            已确认
                                          </span>
                                        )}
                                      </div>

                                      <a
                                        href={segUrl}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="inline-flex w-16 shrink-0 items-center justify-end gap-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
                                      >
                                        去看
                                        <RiArrowRightUpLine className="size-3.5" />
                                      </a>
                                    </div>
                                  );
                                })}
                              </div>

                              <div className="mt-1 flex items-center gap-5 border-t border-border/40 pt-2.5 pb-1 text-xs text-muted-foreground">
                                <button
                                  type="button"
                                  onClick={() => setHistory({ row, segments })}
                                  className="transition-colors hover:text-foreground"
                                >
                                  版本历史
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    openContribute({
                                      url: buildExternalUrl(
                                        row.namespace,
                                        segments[0]!.nativeId,
                                        media.type,
                                      ),
                                      variant: row.isDefault ? `${row.label}（默认）` : row.label,
                                    })
                                  }
                                  className="transition-colors hover:text-foreground"
                                >
                                  修正这条关联
                                </button>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </section>

        {/* Section 2: 资料目录 */}
        {catalogRows.length > 0 && (
          <section className="flex flex-col gap-3 pt-12">
            <div className="flex flex-col gap-1">
              <h2 className="text-xl leading-7 font-bold tracking-tight text-foreground">
                资料目录
              </h2>
              <p className="text-sm text-muted-foreground">
                {isAllSeasons
                  ? `全部 ${seasonCount} 季`
                  : (media.catalogNote ?? "同一部剧在各资料站的条目，权威资料站自动同步")}
              </p>
            </div>

            <div className="flex flex-col">
              {/* Show ruler outside card for catalog when where-to-watch is empty or in long-series mode */}
              {showCatalogRuler && (
                <div className="flex items-center gap-4 px-5 pb-1.5">
                  <div className="w-52 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <CoverageRuler
                      total={totalEpisodesForAxis}
                      mode={isAllSeasons ? "season" : "episode"}
                    />
                  </div>
                  <div className="w-16 shrink-0" />
                </div>
              )}

              <div className="overflow-hidden rounded-xl border border-border bg-card">
                <div className="divide-y divide-border/70">
                  {catalogRows.map((cat) => {
                    const seasonSegments = catalogSegmentsInView(cat);

                    const openUrl =
                      cat.externalUrl ??
                      buildExternalUrl(
                        cat.namespace,
                        cat.wholeMediaNativeId ?? seasonSegments[0]!.nativeId,
                        media.type,
                      );

                    const hasWholeTrack = Boolean(cat.wholeMediaLabel);
                    const hasSeasonTrack = seasonSegments.length > 0;

                    return (
                      <div key={cat.id} className="flex items-center gap-4 px-5 py-3.5">
                        <div className="flex w-52 shrink-0 items-center gap-3">
                          <NamespaceLogo namespace={cat.namespace} className="size-7 shrink-0" />
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-foreground">
                              {NAMESPACE_LABELS[cat.namespace]}
                            </div>
                            <div className="truncate text-xs text-muted-foreground">
                              {isAllSeasons
                                ? (cat.allSeasonsRoleLabel ?? cat.roleLabel)
                                : cat.roleLabel}
                            </div>
                          </div>
                        </div>

                        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                          {hasWholeTrack && (
                            <div className="flex h-5.5 w-full items-center rounded-sm bg-coverage-muted px-2.5 text-2xs font-semibold text-coverage-muted-foreground">
                              <span className="truncate">{cat.wholeMediaLabel}</span>
                            </div>
                          )}

                          {hasSeasonTrack && (
                            <CoverageTrack
                              total={totalEpisodesForAxis}
                              segments={seasonSegments}
                              mode={isAllSeasons ? "season" : "episode"}
                            />
                          )}

                          {cat.note && <p className="text-2xs text-muted-foreground">{cat.note}</p>}
                        </div>

                        <div className="flex w-16 shrink-0 justify-end">
                          <a
                            href={openUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
                          >
                            打开
                            <RiArrowRightUpLine className="size-3.5" />
                          </a>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </section>
        )}
      </main>

      {/* Right-side Mira Drawer (02D) */}
      <ContributeDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        media={media}
        initialSeason={selectedSeason}
        prefillUrl={drawerPrefill.url}
        prefillVariant={drawerPrefill.variant}
      />

      {/* Revision History Dialog */}
      <Dialog open={Boolean(history)} onOpenChange={(v) => !v && setHistory(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              版本历史 · {history ? NAMESPACE_LABELS[history.row.namespace] : ""}
            </DialogTitle>
            <DialogDescription>
              {media.title} · {history?.row.label}
            </DialogDescription>
          </DialogHeader>
          {history && <RevisionHistory segments={history.segments} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Revisions of every association behind a platform row's bars, newest first. */
function RevisionHistory({ segments }: { segments: CoverageSegment[] }) {
  const { user, sessionChecked } = useAppStore();
  const titles = new Map(
    segments.flatMap((s) => (s.associationId ? [[s.associationId, s.title] as const] : [])),
  );
  const results = useQueries({
    queries: [...titles.keys()].map((id) => ({
      ...associationRevisionsQuery(id),
      enabled: Boolean(user),
    })),
  });

  if (!user) {
    return sessionChecked ? (
      <p className="py-2.5 text-xs text-muted-foreground">
        <Link to="/login" className="text-foreground underline underline-offset-4">
          登录
        </Link>
        后可以查看版本历史
      </p>
    ) : (
      <Skeleton className="h-12 w-full" />
    );
  }
  if (results.some((r) => r.isPending)) {
    return (
      <div className="flex flex-col gap-2 py-2.5">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }
  if (results.some((r) => r.isError)) {
    return <p className="py-2.5 text-xs text-destructive">版本历史加载失败，请稍后再试</p>;
  }

  const revisions = results
    .flatMap((r) => r.data ?? [])
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (revisions.length === 0) {
    return <p className="py-2.5 text-xs text-muted-foreground">还没有修订记录</p>;
  }

  return (
    <div className="flex flex-col divide-y divide-border/70 text-xs">
      {revisions.map((rev) => (
        <div key={rev.id} className="flex items-start justify-between gap-3 py-2.5">
          <div>
            <div className="font-medium text-foreground">
              修订 #{rev.revisionNumber} ·{" "}
              {rev.segments.length === 0
                ? "整部"
                : rev.segments
                    .map((s) => {
                      const epLabel = formatSegmentEpisodeLabel(
                        s.episodeStart,
                        s.episodeEnd ?? null,
                        s.nonLinear,
                      );
                      return s.season > 0 ? `第 ${s.season} 季 ${epLabel}` : epLabel;
                    })
                    .join("、")}
            </div>
            <div className="mt-0.5 text-muted-foreground">
              {[titles.get(rev.associationId), rev.reason].filter(Boolean).join(" · ")}
              {rev.changeRequestId && (
                <>
                  {" · "}
                  <Link
                    to="/change-requests/$id"
                    params={{ id: rev.changeRequestId }}
                    className="underline-offset-4 hover:underline"
                  >
                    变更单 #{rev.changeRequestId}
                  </Link>
                </>
              )}
            </div>
          </div>
          <span className="shrink-0 text-muted-foreground">{formatDate(rev.createdAt)}</span>
        </div>
      ))}
    </div>
  );
}
