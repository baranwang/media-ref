import type { PlatformNamespace } from "@media-ref/client";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@media-ref/ui/components/input-group";
import { cn } from "@media-ref/ui/lib/utils";
import { RiSearchLine } from "@remixicon/react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useAppStore } from "#/lib/app-store";
import { NAMESPACE_LABELS, NamespaceLogo } from "./brand-logos";

interface SearchBoxProps {
  placeholder?: string;
  size?: "nav" | "hero";
  className?: string;
  initialQuery?: string;
}

export function SearchBox({
  placeholder = "搜片名，或粘贴任意平台 / 目录网址",
  size = "nav",
  className,
  initialQuery = "",
}: SearchBoxProps) {
  const { searchMedia } = useAppStore();
  const navigate = useNavigate();
  const [query, setQuery] = useState(initialQuery);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const result = useMemo(() => searchMedia(query), [query, searchMedia]);
  const visibleMatches = result.matches.slice(0, 5);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const openMedia = (mediaId: string) => {
    setOpen(false);
    void navigate({ to: "/media/$mediaId", params: { mediaId } });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!open && query.trim()) {
      setOpen(true);
    }
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" && visibleMatches.length > 0) {
      event.preventDefault();
      setActiveIndex((prev) => (prev + 1) % visibleMatches.length);
      return;
    }
    if (event.key === "ArrowUp" && visibleMatches.length > 0) {
      event.preventDefault();
      setActiveIndex((prev) => (prev - 1 + visibleMatches.length) % visibleMatches.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (result.kind === "url_match" && result.directMatch) {
        openMedia(result.directMatch.id);
        return;
      }
      const chosen = visibleMatches[activeIndex];
      if (chosen) {
        openMedia(chosen.id);
      }
    }
  };

  const showDropdown = open && query.trim().length > 0;

  return (
    <div ref={containerRef} className={cn("relative w-full", className)}>
      <InputGroup
        className={cn(
          "rounded-lg",
          size === "hero"
            ? "h-11 border-input bg-input backdrop-blur-md dark:bg-input"
            : "h-8 border-input bg-input/30",
        )}
      >
        <InputGroupAddon align="inline-start" className={size === "hero" ? "pl-3.5" : "pl-2.5"}>
          <RiSearchLine className={size === "hero" ? "size-4" : "size-3.5"} />
        </InputGroupAddon>
        <InputGroupInput
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          aria-label="搜索媒体或粘贴链接"
          className={cn(
            "h-full",
            size === "hero" ? "pr-3.5 text-sm md:text-sm" : "pr-2.5 text-xs md:text-xs",
          )}
        />
      </InputGroup>

      {showDropdown && (
        <div
          role="listbox"
          className="absolute inset-x-0 top-full z-50 mt-1.5 overflow-hidden rounded-lg border border-border bg-popover/95 p-1 text-popover-foreground shadow-2xl backdrop-blur-xl"
        >
          {result.kind === "url_match" && result.parsedLink ? (
            <>
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                这个{NAMESPACE_LABELS[result.parsedLink.namespace]}网址对应的媒体
              </div>
              {result.directMatch ? (
                <button
                  type="button"
                  onClick={() => openMedia(result.directMatch!.id)}
                  className="flex w-full items-center gap-3 rounded-lg bg-accent/80 px-2 py-2 text-left transition-colors hover:bg-accent"
                >
                  <img
                    src={result.directMatch.posterUrl}
                    alt={result.directMatch.title}
                    className="h-12 w-8 shrink-0 rounded object-cover"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">
                      {result.directMatch.title}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {result.directMatch.year} ·{" "}
                      {result.directMatch.type === "movie"
                        ? "电影"
                        : result.directMatch.category === "anime"
                          ? "动画"
                          : "剧集"}{" "}
                      · {NAMESPACE_LABELS[result.parsedLink.namespace]}条目{" "}
                      {result.parsedLink.nativeId}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {getUniquePlatforms(result.directMatch.platformRows).map((ns) => (
                      <NamespaceLogo key={ns} namespace={ns} className="size-4.5" />
                    ))}
                  </div>
                </button>
              ) : (
                <div className="px-2 py-3 text-xs text-muted-foreground">
                  已识别为 {NAMESPACE_LABELS[result.parsedLink.namespace]} 条目{" "}
                  <span className="font-mono text-foreground">{result.parsedLink.nativeId}</span>
                  ，库中暂未记录。可以先搜索片名，再在媒体页补充这条关联。
                </div>
              )}
              <div className="my-1 h-px bg-border/60" />
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                {result.directMatch ? "按回车直接打开" : "输入片名可查找对应媒体并补充关联"}
              </div>
            </>
          ) : (
            <>
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                片名里有「{query.trim()}」
              </div>
              {visibleMatches.length > 0 ? (
                <div className="flex flex-col gap-0.5">
                  {visibleMatches.map((item, idx) => {
                    const platforms = getUniquePlatforms(item.platformRows);
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onMouseEnter={() => setActiveIndex(idx)}
                        onClick={() => openMedia(item.id)}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors",
                          idx === activeIndex ? "bg-accent" : "hover:bg-accent/60",
                        )}
                      >
                        <img
                          src={item.posterUrl}
                          alt={item.title}
                          className="h-12 w-8 shrink-0 rounded object-cover"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-foreground">
                            {item.title}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            {item.year} ·{" "}
                            {item.type === "movie"
                              ? "电影"
                              : item.category === "anime"
                                ? "动画"
                                : "剧集"}{" "}
                            · {item.region}
                          </div>
                        </div>
                        {platforms.length > 0 && (
                          <div className="flex shrink-0 items-center gap-1">
                            {platforms.map((ns) => (
                              <NamespaceLogo key={ns} namespace={ns} className="size-4.5" />
                            ))}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="px-2 py-4 text-center text-xs text-muted-foreground">
                  没有找到片名包含「{query.trim()}」的媒体
                </div>
              )}
              <div className="my-1 h-px bg-border/60" />
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                也可以直接粘贴哔哩哔哩、腾讯视频、豆瓣等网站的网址
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function getUniquePlatforms(rows: Array<{ namespace: PlatformNamespace }>): PlatformNamespace[] {
  const seen = new Set<PlatformNamespace>();
  for (const row of rows) {
    seen.add(row.namespace);
  }
  return [...seen];
}
