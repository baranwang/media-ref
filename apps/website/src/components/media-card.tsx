import type { PlatformNamespace } from "@media-ref/client";
import { Link } from "@tanstack/react-router";
import type { MediaItem } from "#/lib/catalog-data";
import { NamespaceLogo } from "./brand-logos";

export function MediaCard({ item }: { item: MediaItem }) {
  const platforms: PlatformNamespace[] = [];
  for (const row of item.platformRows) {
    if (!platforms.includes(row.namespace)) {
      platforms.push(row.namespace);
    }
  }

  const categoryLabel =
    item.type === "movie" ? "电影" : item.category === "anime" ? "动画" : "剧集";

  return (
    <Link
      to="/media/$mediaId"
      params={{ mediaId: item.id }}
      className="group flex min-w-0 flex-col gap-2 focus-visible:outline-none"
    >
      <div className="relative aspect-2/3 w-full overflow-hidden rounded-lg bg-card ring-1 ring-border/70 transition-all duration-200 group-hover:ring-foreground/25 group-focus-visible:ring-2 group-focus-visible:ring-ring">
        <img
          src={item.posterUrl}
          alt={item.title}
          loading="lazy"
          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-103"
        />
      </div>

      <div className="flex min-w-0 flex-col gap-0.5">
        <h3 className="truncate text-sm leading-5 font-medium text-foreground transition-colors group-hover:text-primary">
          {item.title}
        </h3>
        <p className="text-xs leading-4 text-muted-foreground">
          {item.year} · {categoryLabel}
        </p>
      </div>

      <div className="flex h-5 items-center gap-2">
        {platforms.map((ns) => (
          <NamespaceLogo key={ns} namespace={ns} className="size-5" />
        ))}
      </div>
    </Link>
  );
}
