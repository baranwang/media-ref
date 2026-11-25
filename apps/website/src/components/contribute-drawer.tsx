import { isCatalogNamespace, type Namespace } from "@media-ref/client";
import { Button } from "@media-ref/ui/components/button";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@media-ref/ui/components/drawer";
import { Field, FieldDescription, FieldLabel } from "@media-ref/ui/components/field";
import { Input } from "@media-ref/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@media-ref/ui/components/select";
import { Tabs, TabsList, TabsTrigger } from "@media-ref/ui/components/tabs";
import { cn } from "@media-ref/ui/lib/utils";
import { RiAddLine, RiCheckLine, RiErrorWarningLine } from "@remixicon/react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "#/lib/app-store";
import type { CoverageSegment, MediaItem } from "#/lib/catalog-data";
import { parseExternalInput } from "#/lib/url-parser";
import { NAMESPACE_LABELS, NamespaceLogo } from "./brand-logos";
import { CoverageRuler, CoverageTrack } from "./coverage-bar";

type ScopeKind = "whole_media" | "whole_season" | "partial" | "single";

interface ContributeDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  media: MediaItem;
  initialSeason?: number;
  prefillUrl?: string;
  prefillVariant?: string;
}

export function ContributeDrawer({
  open,
  onOpenChange,
  media,
  initialSeason,
  prefillUrl,
  prefillVariant,
}: ContributeDrawerProps) {
  const { submitContribution } = useAppStore();
  const navigate = useNavigate();

  const defaultSeason = initialSeason ?? media.defaultSeason ?? media.seasons[0]?.season ?? 1;
  const defaultUrl =
    prefillUrl ?? (media.id === "aot" ? "https://v.qq.com/x/cover/mzc002009x8ab2.html" : "");

  const [urlInput, setUrlInput] = useState(defaultUrl);
  const [season, setSeason] = useState(defaultSeason);
  const [scope, setScope] = useState<ScopeKind>(
    media.type === "movie" ? "whole_media" : media.id === "aot" ? "partial" : "whole_season",
  );
  const [episodeStart, setEpisodeStart] = useState(media.id === "aot" ? 17 : 1);
  const [episodeEnd, setEpisodeEnd] = useState(
    media.id === "aot"
      ? 28
      : (media.seasons.find((s) => s.season === defaultSeason)?.episodeCount ?? 12),
  );
  const [targetStart, setTargetStart] = useState(1);
  const [editingOffset, setEditingOffset] = useState(false);

  const existingVariants = useMemo(() => {
    const set = new Set<string>();
    for (const row of media.platformRows) {
      set.add(row.isDefault ? `${row.label}（默认）` : row.label);
    }
    if (set.size === 0) {
      set.add(media.region === "日本" ? "日语原声（默认）" : "国语原声（默认）");
    }
    return [...set];
  }, [media.platformRows, media.region]);

  const [variant, setVariant] = useState(prefillVariant ?? existingVariants[0] ?? "默认版本");
  const [addingVariant, setAddingVariant] = useState(false);
  const [customVariant, setCustomVariant] = useState("");
  const [customVariants, setCustomVariants] = useState<string[]>([]);

  useEffect(() => {
    if (open) {
      const s = initialSeason ?? media.defaultSeason ?? media.seasons[0]?.season ?? 1;
      setSeason(s);
      if (prefillUrl !== undefined) {
        setUrlInput(prefillUrl);
      }
      if (prefillVariant) {
        setVariant(prefillVariant);
      }
    }
  }, [open, initialSeason, media.defaultSeason, media.seasons, prefillUrl, prefillVariant]);

  const parsed = useMemo(() => parseExternalInput(urlInput), [urlInput]);
  const currentSeasonInfo = media.seasons.find((s) => s.season === season);
  const totalEps = currentSeasonInfo?.episodeCount ?? 1;

  const effectiveRange = useMemo(() => {
    if (media.type === "movie" || scope === "whole_media" || scope === "whole_season") {
      return { start: 1, end: totalEps };
    }
    if (scope === "single") {
      const clamped = Math.max(1, Math.min(episodeStart, totalEps));
      return { start: clamped, end: clamped };
    }
    const s = Math.max(1, Math.min(episodeStart, totalEps));
    const e = Math.max(s, Math.min(episodeEnd, totalEps));
    return { start: s, end: e };
  }, [media.type, scope, episodeStart, episodeEnd, totalEps]);

  const spanLength = effectiveRange.end - effectiveRange.start + 1;
  const targetEnd = targetStart + spanLength - 1;

  const inferredPageTitle = useMemo(() => {
    if (!parsed) return "";
    if (parsed.nativeId === "mzc002009x8ab2" && media.id === "aot") {
      return "进击的巨人 最终季 Part.2";
    }
    if (media.type === "movie") return media.title;
    return `${media.title} 第 ${season} 季`;
  }, [media.id, media.title, media.type, parsed, season]);

  const cleanVariant = variant.replace("（默认）", "");
  const isCatalog = parsed ? isCatalogNamespace(parsed.namespace) : false;

  const existingSegments: CoverageSegment[] = useMemo(() => {
    if (!parsed || isCatalog) return [];
    const matchingRow = media.platformRows.find(
      (r) => r.namespace === parsed.namespace && r.label === cleanVariant,
    );
    return matchingRow?.segmentsBySeason[season] ?? [];
  }, [parsed, isCatalog, media.platformRows, cleanVariant, season]);

  const overlapInfo = useMemo(() => {
    const overlapping = existingSegments.filter(
      (seg) => effectiveRange.start <= seg.end && effectiveRange.end >= seg.start,
    );
    return {
      hasOverlap: overlapping.length > 0,
      existingRangeLabel:
        existingSegments.length > 0
          ? `${Math.min(...existingSegments.map((s) => s.start))}–${Math.max(...existingSegments.map((s) => s.end))}`
          : null,
    };
  }, [existingSegments, effectiveRange]);

  const previewSegments: CoverageSegment[] = useMemo(() => {
    const proposed: CoverageSegment = {
      id: "preview-proposed",
      title: `本次提交 · ${effectiveRange.start}–${effectiveRange.end}`,
      nativeId: parsed?.nativeId ?? "",
      start: effectiveRange.start,
      end: effectiveRange.end,
      status: "pending",
    };
    return [...existingSegments, proposed];
  }, [existingSegments, effectiveRange, parsed?.nativeId]);

  const allVariantOptions = [...existingVariants, ...customVariants];

  const handleAddVariant = () => {
    const trimmed = customVariant.trim();
    if (!trimmed) return;
    if (!allVariantOptions.includes(trimmed)) {
      setCustomVariants((prev) => [...prev, trimmed]);
    }
    setVariant(trimmed);
    setCustomVariant("");
    setAddingVariant(false);
  };

  const handleSubmit = () => {
    const ns: Namespace = parsed?.namespace ?? "tencent";
    const nativeId = parsed?.nativeId ?? "custom";
    const created = submitContribution({
      mediaId: media.id,
      namespace: ns,
      nativeId,
      pageUrl: parsed?.url ?? urlInput.trim(),
      pageTitle: inferredPageTitle || media.title,
      pageEpisodeCount: spanLength,
      variantLabel: isCatalog ? null : variant,
      season: media.type === "movie" ? 0 : season,
      episodeStart: effectiveRange.start,
      episodeEnd: effectiveRange.end,
      targetEpisodeStart: targetStart,
    });
    onOpenChange(false);
    void navigate({ to: "/change-requests/$id", params: { id: created.id } });
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange} swipeDirection="right">
      <DrawerContent className="w-full max-w-sm">
        <DrawerHeader className="border-b border-border/60 pb-3">
          <DrawerTitle>补充 / 修正关联</DrawerTitle>
          <DrawerDescription>
            {media.title}
            {media.type === "tv" ? ` · 第 ${season} 季` : ""}
          </DrawerDescription>
        </DrawerHeader>

        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
          {/* 1. URL */}
          <Field>
            <FieldLabel htmlFor="contribute-url">播放页或资料站网址</FieldLabel>
            <Input
              id="contribute-url"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="粘贴哔哩哔哩、腾讯视频、爱奇艺、豆瓣等网址"
            />
            {parsed ? (
              <div className="mt-1 flex items-center gap-2.5 rounded-lg border border-border bg-secondary/40 px-2.5 py-2">
                <NamespaceLogo namespace={parsed.namespace} className="size-6 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-foreground">
                    {inferredPageTitle}
                  </div>
                  <div className="truncate text-2xs text-muted-foreground">
                    {NAMESPACE_LABELS[parsed.namespace]}
                    {media.type === "tv" ? ` · 共 ${spanLength} 集` : ""} ·{" "}
                    <span className="font-mono">{parsed.nativeId}</span>
                  </div>
                </div>
              </div>
            ) : (
              urlInput.trim().length > 0 && (
                <p className="text-2xs text-destructive">
                  暂未识别这个网址，请输入哔哩哔哩、腾讯视频、爱奇艺、优酷、芒果 TV 或资料站链接
                </p>
              )
            )}
          </Field>

          {/* 2. Version / Variant */}
          <Field data-disabled={isCatalog ? "true" : undefined}>
            <FieldLabel>版本</FieldLabel>
            {isCatalog ? (
              <div className="rounded-md border border-border/60 bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
                资料站条目标记为通用目录，无需选择版本
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <Select value={variant} onValueChange={(v) => v && setVariant(v)}>
                    <SelectTrigger className="flex-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {allVariantOptions.map((opt) => (
                        <SelectItem key={opt} value={opt}>
                          {opt}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="outline"
                    size="default"
                    onClick={() => setAddingVariant((v) => !v)}
                  >
                    <RiAddLine />
                    新建版本
                  </Button>
                </div>

                {addingVariant && (
                  <div className="mt-1 flex items-center gap-2">
                    <Input
                      value={customVariant}
                      onChange={(e) => setCustomVariant(e.target.value)}
                      placeholder="例如：国语配音、沪语版、4K 修复"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleAddVariant();
                        }
                      }}
                    />
                    <Button type="button" variant="secondary" onClick={handleAddVariant}>
                      添加
                    </Button>
                  </div>
                )}
              </>
            )}
            <FieldDescription>资料站没有版本，会自动跳过这一步</FieldDescription>
          </Field>

          {/* 3. Episodes */}
          {media.type === "tv" && media.seasons.length > 0 && (
            <Field>
              <FieldLabel>对应的集数</FieldLabel>

              {media.seasons.length <= 8 ? (
                <Tabs
                  value={String(season)}
                  onValueChange={(v) => {
                    const num = Number(v);
                    const info = media.seasons.find((s) => s.season === num);
                    setSeason(num);
                    setEpisodeStart(1);
                    setEpisodeEnd(info?.episodeCount ?? 1);
                  }}
                >
                  <TabsList className="grid w-full grid-cols-4">
                    {media.seasons.map((s) => (
                      <TabsTrigger key={s.season} value={String(s.season)}>
                        第 {s.season} 季
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
              ) : (
                <Select
                  value={String(season)}
                  onValueChange={(v) => {
                    const num = Number(v);
                    if (!Number.isNaN(num)) {
                      setSeason(num);
                      const info = media.seasons.find((s) => s.season === num);
                      setEpisodeStart(1);
                      setEpisodeEnd(info?.episodeCount ?? 1);
                    }
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue>
                      第 {season} 季 · {totalEps} 集
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
              )}

              <Tabs value={scope} onValueChange={(v) => setScope(v as ScopeKind)}>
                <TabsList className="grid w-full grid-cols-4">
                  <TabsTrigger value="whole_media">整部</TabsTrigger>
                  <TabsTrigger value="whole_season">整季</TabsTrigger>
                  <TabsTrigger value="partial">部分集数</TabsTrigger>
                  <TabsTrigger value="single">单集</TabsTrigger>
                </TabsList>
              </Tabs>

              {scope === "partial" && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>第</span>
                  <Input
                    type="number"
                    min={1}
                    max={totalEps}
                    value={episodeStart}
                    onChange={(e) => setEpisodeStart(Number(e.target.value) || 1)}
                    className="w-16 text-center font-mono"
                  />
                  <span>集 至 第</span>
                  <Input
                    type="number"
                    min={episodeStart}
                    max={totalEps}
                    value={episodeEnd}
                    onChange={(e) => setEpisodeEnd(Number(e.target.value) || episodeStart)}
                    className="w-16 text-center font-mono"
                  />
                  <span>集</span>
                </div>
              )}

              {scope === "single" && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>第</span>
                  <Input
                    type="number"
                    min={1}
                    max={totalEps}
                    value={episodeStart}
                    onChange={(e) => setEpisodeStart(Number(e.target.value) || 1)}
                    className="w-16 text-center font-mono"
                  />
                  <span>集</span>
                </div>
              )}

              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  在这个{parsed ? NAMESPACE_LABELS[parsed.namespace] : "平台"}页面里是第{" "}
                  {targetStart}–{targetEnd} 集
                </span>
                <button
                  type="button"
                  onClick={() => setEditingOffset((v) => !v)}
                  className="text-foreground underline underline-offset-4 hover:text-primary"
                >
                  {editingOffset ? "完成" : "修改"}
                </button>
              </div>

              {editingOffset && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>平台页面起始集数：第</span>
                  <Input
                    type="number"
                    min={1}
                    value={targetStart}
                    onChange={(e) => setTargetStart(Math.max(1, Number(e.target.value) || 1))}
                    className="w-16 text-center font-mono"
                  />
                  <span>集</span>
                </div>
              )}

              {/* Live preview */}
              <div className="mt-1 flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
                <div className="text-2xs font-medium text-muted-foreground">
                  预览 · {parsed ? NAMESPACE_LABELS[parsed.namespace] : "腾讯视频"}
                  {!isCatalog ? ` · ${cleanVariant}` : ""}
                </div>
                <CoverageRuler total={totalEps} />
                <CoverageTrack total={totalEps} segments={previewSegments} />
                <div
                  className={cn(
                    "flex items-center gap-1.5 text-2xs",
                    overlapInfo.hasOverlap ? "text-status-warning-fg" : "text-muted-foreground",
                  )}
                >
                  {overlapInfo.hasOverlap ? (
                    <>
                      <RiErrorWarningLine className="size-3.5 shrink-0" />
                      <span>和已有的 {overlapInfo.existingRangeLabel} 集存在重叠，需审核确认</span>
                    </>
                  ) : overlapInfo.existingRangeLabel ? (
                    <>
                      <RiCheckLine className="size-3.5 shrink-0 text-status-confirmed-fg" />
                      <span>不和已有的 {overlapInfo.existingRangeLabel} 集重叠</span>
                    </>
                  ) : (
                    <>
                      <RiCheckLine className="size-3.5 shrink-0 text-status-confirmed-fg" />
                      <span>该版本尚无记录，提交后将建立首条关联</span>
                    </>
                  )}
                </div>
              </div>
            </Field>
          )}
        </div>

        <DrawerFooter className="border-t border-border/60 pt-3">
          <p className="text-xs text-muted-foreground">提交后会自动取证核对</p>
          <Button
            type="button"
            variant="default"
            size="lg"
            className="w-full"
            disabled={!parsed}
            onClick={handleSubmit}
          >
            提交变更单
          </Button>
          <DrawerClose
            render={
              <Button type="button" variant="outline" size="lg" className="w-full">
                取消
              </Button>
            }
          />
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
