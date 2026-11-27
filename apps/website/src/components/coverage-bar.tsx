import { Tooltip, TooltipContent, TooltipTrigger } from "@media-ref/ui/components/tooltip";
import { cn } from "@media-ref/ui/lib/utils";
import { formatSegmentEpisodeLabel } from "#/lib/format";
import type { CoverageSegment } from "#/lib/types";

export function computeRulerTicks(
  total: number,
  mode: "episode" | "season",
): Array<{ pos: number; label: string }> {
  if (total <= 1) {
    return [{ pos: 0, label: mode === "season" ? "S1" : "E1" }];
  }
  const prefix = mode === "season" ? "S" : "E";
  // Smallest 1-2-5 step that keeps the ruler at <= 12 labels (1155 episodes -> every 100).
  const step =
    total <= 12 ? 2 : ([5, 10, 20, 50, 100, 200, 500, 1000].find((s) => total / s <= 12) ?? 2000);

  const ticks: Array<{ pos: number; label: string }> = [{ pos: 0, label: `${prefix}1` }];
  for (let n = step; n < total; n += step) {
    const pct = ((n - 1) / total) * 100;
    if (pct > 6 && pct < 93) {
      ticks.push({ pos: pct, label: mode === "season" ? `S${n}` : String(n) });
    }
  }
  ticks.push({ pos: 100, label: mode === "season" ? `S${total}` : String(total) });
  return ticks;
}

export function CoverageRuler({
  total,
  mode = "episode",
  className,
}: {
  total: number;
  mode?: "episode" | "season";
  className?: string;
}) {
  const ticks = computeRulerTicks(total, mode);
  return (
    <div className={cn("relative h-5 w-full select-none", className)}>
      {ticks.map((tick, idx) => {
        const isFirst = idx === 0;
        const isLast = idx === ticks.length - 1;
        return (
          <span
            key={`${tick.label}-${tick.pos}`}
            style={{ left: `${tick.pos}%` }}
            className={cn(
              "absolute top-1/2 -translate-y-1/2 font-mono text-2xs text-muted-foreground/80",
              isFirst ? "translate-x-0" : isLast ? "-translate-x-full" : "-translate-x-1/2",
            )}
          >
            {tick.label}
          </span>
        );
      })}
    </div>
  );
}

export function CoverageLegend({
  labels = ["已确认", "待审核", "未收录"],
}: {
  labels?: [string, string, string];
}) {
  return (
    <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-block h-2.5 w-3.5 rounded-xs bg-coverage" />
        {labels[0]}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="bg-pending-stripes inline-block h-2.5 w-3.5 rounded-xs" />
        {labels[1]}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-block h-2.5 w-3.5 rounded-xs bg-track ring-1 ring-border" />
        {labels[2]}
      </span>
    </div>
  );
}

interface CoverageTrackProps {
  total: number;
  segments: CoverageSegment[];
  mode?: "episode" | "season";
  compact?: boolean;
  onSegmentClick?: (segment: CoverageSegment) => void;
  className?: string;
}

export function CoverageTrack({
  total,
  segments,
  mode = "episode",
  compact = false,
  onSegmentClick,
  className,
}: CoverageTrackProps) {
  const safeTotal = Math.max(total, 1);
  const allWholeSeasonNonLinear =
    mode === "episode" &&
    segments.length > 0 &&
    segments.every((s) => s.nonLinear && s.start <= 1 && s.end >= safeTotal);
  const showDiscreteCells = safeTotal > 1 && safeTotal <= 36 && !allWholeSeasonNonLinear;

  return (
    <div
      className={cn(
        "relative w-full overflow-hidden rounded-sm",
        showDiscreteCells ? "bg-transparent" : "bg-track",
        compact ? "h-5" : "h-5.5",
        className,
      )}
    >
      {showDiscreteCells && (
        <div
          aria-hidden="true"
          style={{ gridTemplateColumns: `repeat(${safeTotal}, minmax(0, 1fr))` }}
          className="pointer-events-none absolute inset-0 grid gap-0.5"
        >
          {Array.from({ length: safeTotal }, (_, i) => (
            <span key={i} className="h-full w-full rounded-xs bg-track" />
          ))}
        </div>
      )}

      {segments.map((seg) => {
        const clampedStart = Math.max(1, Math.min(seg.start, safeTotal));
        const clampedEnd = Math.max(clampedStart, Math.min(seg.end, safeTotal));
        const leftPct = ((clampedStart - 1) / safeTotal) * 100;
        const widthPct = ((clampedEnd - clampedStart + 1) / safeTotal) * 100;
        const isNarrow = widthPct < 12;
        const isNonLinearEpisodeBar = mode === "episode" && Boolean(seg.nonLinear);
        const isWholeSeasonNonLinear =
          isNonLinearEpisodeBar && clampedStart === 1 && clampedEnd === safeTotal;

        const rangeText =
          mode === "season"
            ? clampedStart === clampedEnd
              ? `第 ${clampedStart} 季`
              : `第 ${clampedStart}–${clampedEnd} 季`
            : formatSegmentEpisodeLabel(clampedStart, clampedEnd, seg.nonLinear, safeTotal);

        const barClass =
          seg.status === "pending"
            ? "bg-pending-stripes text-pending-foreground border border-amber-700/50"
            : seg.status === "muted"
              ? "bg-coverage-muted text-coverage-muted-foreground border border-border"
              : "bg-coverage text-coverage-foreground border border-lime-700/40";

        return (
          <Tooltip key={seg.id}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={(e) => {
                    if (onSegmentClick) {
                      e.stopPropagation();
                      onSegmentClick(seg);
                    }
                  }}
                  style={{
                    left: `calc(${leftPct}% + 1px)`,
                    width: `calc(${widthPct}% - 2px)`,
                  }}
                  className={cn(
                    "transition-brightness absolute inset-y-0 flex items-center overflow-hidden rounded-sm text-left text-2xs font-semibold hover:brightness-115 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
                    isNarrow ? "justify-center px-0.5" : "px-2",
                    onSegmentClick ? "cursor-pointer" : "cursor-default",
                    barClass,
                  )}
                />
              }
            >
              <span className="truncate">{seg.title}</span>
              {isNonLinearEpisodeBar && !isNarrow && (
                <span className="ml-1.5 shrink-0 font-normal opacity-80">
                  {isWholeSeasonNonLinear ? "· 整季不拆集" : "· 不按集对应"}
                </span>
              )}
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs">
              <div className="flex flex-col gap-0.5 text-xs">
                <div className="font-medium">{seg.title}</div>
                <div className="text-2xs opacity-80">
                  {rangeText} · <span className="font-mono">{seg.nativeId}</span>
                </div>
                {isNonLinearEpisodeBar && (
                  <div className="text-2xs opacity-80">
                    分集与资料站不逐集对应，可直接打开平台合集观看
                  </div>
                )}
                <div className="text-2xs opacity-80">
                  {seg.status === "pending"
                    ? seg.changeRequestId
                      ? `审核中 · 变更单 #${seg.changeRequestId}`
                      : "待审核"
                    : "已确认"}
                </div>
              </div>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
