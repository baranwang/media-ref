import { Skeleton } from "@media-ref/ui/components/skeleton";
import { Link } from "@tanstack/react-router";
import type { CardItem, MediaCategory } from "#/lib/types";
import { NamespaceLogo } from "./brand-logos";

export function categoryLabelOf(category: MediaCategory): string {
  return category === "movie" ? "电影" : category === "anime" ? "动画" : "剧集";
}

export function MediaCard({ item }: { item: CardItem }) {
  const categoryLabel = categoryLabelOf(item.category);

  return (
    <Link
      to="/media/$mediaId"
      params={{ mediaId: item.id }}
      className="group flex min-w-0 flex-col gap-2 focus-visible:outline-none"
    >
      <div className="relative aspect-2/3 w-full overflow-hidden rounded-lg bg-card ring-1 ring-border/70 transition-all duration-200 group-hover:ring-foreground/25 group-focus-visible:ring-2 group-focus-visible:ring-ring">
        {item.posterUrl ? (
          <img
            src={item.posterUrl}
            alt={item.title}
            loading="lazy"
            referrerPolicy="no-referrer"
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-103"
          />
        ) : (
          <div className="h-full w-full bg-muted" />
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-0.5">
        <h3 className="truncate text-sm leading-5 font-medium text-foreground transition-colors group-hover:text-primary">
          {item.title}
        </h3>
        <p className="text-xs leading-4 text-muted-foreground">
          {item.year ? `${item.year} · ${categoryLabel}` : categoryLabel}
        </p>
      </div>

      <div className="flex h-5 items-center gap-2">
        {item.platforms.map((ns) => (
          <NamespaceLogo key={ns} namespace={ns} className="size-5" />
        ))}
      </div>
    </Link>
  );
}

/** Same footprint as a `MediaCard`, shown while a grid loads. */
export function MediaCardSkeleton() {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Skeleton className="aspect-2/3 w-full rounded-lg" />
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-3 w-1/2" />
    </div>
  );
}
