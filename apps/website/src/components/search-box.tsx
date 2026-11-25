import { InputGroup, InputGroupAddon, InputGroupInput } from "@media-ref/ui/components/input-group";
import { cn } from "@media-ref/ui/lib/utils";
import { RiSearchLine } from "@remixicon/react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { searchQuery } from "#/lib/queries";
import { parseExternalInput } from "#/lib/url-parser";
import { NAMESPACE_LABELS, NamespaceLogo } from "./brand-logos";
import { categoryLabelOf } from "./media-card";

const DEBOUNCE_MS = 250;

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
  const navigate = useNavigate();
  const [query, setQuery] = useState(initialQuery);
  const [debouncedQuery, setDebouncedQuery] = useState(initialQuery.trim());
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const trimmed = query.trim();
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(trimmed), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [trimmed]);

  const search = useQuery(searchQuery(debouncedQuery));
  // Only show results that belong to what is in the box right now.
  const result = debouncedQuery === trimmed ? search.data : undefined;
  const visibleMatches = result?.items.slice(0, 5) ?? [];
  const parsedLink = result?.matchedAsLink ? parseExternalInput(trimmed) : null;
  const linkLabel = parsedLink ? NAMESPACE_LABELS[parsedLink.namespace] : "";

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
      const chosen = visibleMatches[activeIndex];
      if (chosen) {
        openMedia(chosen.id);
      }
    }
  };

  const showDropdown = open && trimmed.length > 0;

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
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            {result?.matchedAsLink ? `这个${linkLabel}网址对应的媒体` : `片名里有「${trimmed}」`}
          </div>
          {search.isError && debouncedQuery === trimmed ? (
            <div className="px-2 py-4 text-center text-xs text-muted-foreground">
              搜索暂时不可用，请稍后重试
            </div>
          ) : !result ? (
            <div className="px-2 py-4 text-center text-xs text-muted-foreground">搜索中…</div>
          ) : visibleMatches.length > 0 ? (
            <div className="flex flex-col gap-0.5">
              {visibleMatches.map((item, idx) => (
                <button
                  key={item.key}
                  type="button"
                  onMouseEnter={() => setActiveIndex(idx)}
                  onClick={() => openMedia(item.id)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors",
                    idx === activeIndex ? "bg-accent" : "hover:bg-accent/60",
                  )}
                >
                  {item.posterUrl ? (
                    <img
                      src={item.posterUrl}
                      alt={item.title}
                      referrerPolicy="no-referrer"
                      className="h-12 w-8 shrink-0 rounded object-cover"
                    />
                  ) : (
                    <div className="h-12 w-8 shrink-0 rounded bg-muted" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">{item.title}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {item.year ? `${item.year} · ` : ""}
                      {categoryLabelOf(item.category)}
                      {item.originalTitle && item.originalTitle !== item.title
                        ? ` · ${item.originalTitle}`
                        : ""}
                    </div>
                  </div>
                  {item.platforms.length > 0 && (
                    <div className="flex shrink-0 items-center gap-1">
                      {item.platforms.map((ns) => (
                        <NamespaceLogo key={ns} namespace={ns} className="size-4.5" />
                      ))}
                    </div>
                  )}
                </button>
              ))}
            </div>
          ) : result.matchedAsLink ? (
            <div className="px-2 py-3 text-xs text-muted-foreground">
              这个链接还没有记录
              {parsedLink && (
                <>
                  （{linkLabel} 条目{" "}
                  <span className="font-mono text-foreground">{parsedLink.nativeId}</span>）
                </>
              )}
              。可以先搜索片名，再在媒体页补充这条关联。
            </div>
          ) : (
            <div className="px-2 py-4 text-center text-xs text-muted-foreground">
              没有找到片名包含「{trimmed}」的媒体
            </div>
          )}
          <div className="my-1 h-px bg-border/60" />
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            {!result?.matchedAsLink
              ? "也可以直接粘贴哔哩哔哩、腾讯视频、豆瓣等网站的网址"
              : visibleMatches.length > 0
                ? "按回车直接打开"
                : "输入片名可查找对应媒体并补充关联"}
          </div>
        </div>
      )}
    </div>
  );
}
