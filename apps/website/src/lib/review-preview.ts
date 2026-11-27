import { isCatalogNamespace } from "@media-ref/client";
import type { ChangeRequestItem, CoverageSegment, MediaItem } from "./types";

export interface ReviewCoveragePreview {
  season: number;
  isMovie: boolean;
  totalSeasonEpisodes: number;
  variantLabel: string | null;
  /** Only currently confirmed coverage for this platform/variant (excludes pending CRs and seeds). */
  existingSegments: CoverageSegment[];
  /** Projected coverage after approving `cr` (removes replaced/updated bars, adds `cr`). */
  afterSegments: CoverageSegment[];
  /** Count of *other* pending change requests on this same row/season excluded from `existingSegments`. */
  otherPendingCount: number;
}

/**
 * Computes the before/after episode-coverage bars shown in ReviewDetail (`现在` vs `通过后`).
 *
 * `GetMedia` runs with `includeUnconfirmed: true`, which injects pending CRs (including `cr` itself)
 * into `media.platformRows` / `media.catalogRows` as `status: "pending"`. Keeping only `confirmed`
 * segments for `现在` prevents a pending CR from appearing as already present before approval.
 */
export function buildReviewCoveragePreview(
  cr: ChangeRequestItem,
  media: MediaItem | null | undefined,
): ReviewCoveragePreview {
  const isCatalog = isCatalogNamespace(cr.namespace);
  const primary = cr.segments[0];
  const isMovie = media?.type === "movie" && cr.segments.length === 0;
  const season = isMovie ? 0 : (primary?.season ?? media?.seasons[0]?.season ?? 1);
  const seasonSegments = cr.segments.filter((s) => s.season === season);
  const totalSeasonEpisodes = isMovie
    ? 1
    : media?.seasons.find((s) => s.season === season)?.episodeCount ||
      cr.pageEpisodeCount ||
      Math.max(1, ...seasonSegments.map((s) => s.end ?? s.start));

  const catalogRow = isCatalog
    ? media?.catalogRows.find((row) => row.namespace === cr.namespace)
    : undefined;
  const platformRow = !isCatalog
    ? media?.platformRows.find((row) => {
        if (row.namespace !== cr.namespace) return false;
        if (cr.variantId) return row.variantId === cr.variantId;
        return cr.variantLabel ? row.label === cr.variantLabel : row.isDefault;
      })
    : undefined;

  const rawExisting = platformRow?.segmentsBySeason[season] ?? [
    ...(catalogRow?.wholeMediaEntries ?? []).map((entry) => ({
      ...entry,
      start: 1,
      end: totalSeasonEpisodes,
    })),
    ...(catalogRow?.segmentsBySeason?.[season] ?? []),
  ];
  const existingSegments = rawExisting.filter((seg) => seg.status === "confirmed");

  const otherPendingIds = new Set(
    rawExisting
      .filter(
        (seg) => seg.status === "pending" && seg.changeRequestId && seg.changeRequestId !== cr.id,
      )
      .map((seg) => seg.changeRequestId!),
  );

  const proposedSegments: CoverageSegment[] =
    seasonSegments.length > 0
      ? seasonSegments.map((s, i) => ({
          id: `${cr.id}-${i}`,
          title: cr.pageTitle ?? cr.nativeId,
          nativeId: cr.nativeId,
          start: s.start,
          end: s.end ?? totalSeasonEpisodes,
          targetStart: s.targetStart,
          ...(s.nonLinear ? { nonLinear: true } : {}),
          status: "pending" as const,
          changeRequestId: cr.id,
        }))
      : cr.segments.length === 0
        ? [
            {
              id: `${cr.id}-whole`,
              title: cr.pageTitle ?? cr.nativeId,
              nativeId: cr.nativeId,
              start: 1,
              end: totalSeasonEpisodes,
              status: "pending" as const,
              changeRequestId: cr.id,
            },
          ]
        : [];

  // Mirror `mergeApprovedSegments`: explicit replacement delists the target association, and
  // updating the same collection in the requested season replaces that collection's bars here.
  const keptConfirmed =
    cr.status === "approved"
      ? existingSegments
      : existingSegments.filter((seg) => {
          if (seg.isExternalId) return true;
          if (cr.replacesAssociationId && seg.associationId === cr.replacesAssociationId) {
            return false;
          }
          if (seg.nativeId === cr.nativeId) {
            return false;
          }
          return true;
        });

  const afterSegments =
    cr.status === "approved"
      ? existingSegments
      : [...keptConfirmed, ...proposedSegments].sort((a, b) => a.start - b.start);

  return {
    season,
    isMovie,
    totalSeasonEpisodes,
    variantLabel: platformRow?.label ?? cr.variantLabel,
    existingSegments,
    afterSegments,
    otherPendingCount: otherPendingIds.size,
  };
}
