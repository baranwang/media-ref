import type {
  BaselineSource,
  CatalogNamespace,
  ChangeRequestStatus,
  MediaType,
  Namespace,
  PlatformNamespace,
} from "@media-ref/client";

/** One bar on a coverage track. */
export interface CoverageSegment {
  id: string;
  title: string;
  nativeId: string;
  /** 1-based start episode (or season in all-seasons mode) */
  start: number;
  /** 1-based inclusive end episode (or season in all-seasons mode) */
  end: number;
  targetStart?: number;
  status: "confirmed" | "pending" | "muted";
  changeRequestId?: string;
  /** Association that backs this bar (for version history). */
  associationId?: string;
}

export interface PlatformVariantRow {
  id: string;
  namespace: PlatformNamespace;
  label: string;
  isDefault?: boolean;
  /** Season-keyed coverage segments; key 0 represents whole-movie coverage */
  segmentsBySeason: Record<number, CoverageSegment[]>;
  /** All-seasons summary segments (season ranges) */
  allSeasonSegments?: CoverageSegment[];
}

export interface CatalogDirectoryRow {
  id: string;
  namespace: CatalogNamespace;
  roleLabel: string;
  /** Replaces roleLabel when the all-seasons overview is shown */
  allSeasonsRoleLabel?: string;
  isBaseline?: boolean;
  wholeMediaNativeId?: string;
  wholeMediaLabel?: string;
  note?: string;
  segmentsBySeason?: Record<number, CoverageSegment[]>;
  allSeasonSegments?: CoverageSegment[];
  externalUrl?: string;
}

export interface MediaSeasonInfo {
  season: number;
  episodeCount: number;
}

export type MediaCategory = "tv" | "movie" | "anime";

/** A title on a list/grid. `id` is the route param for `/media/$mediaId`. */
export interface CardItem {
  id: string;
  /** Set when the title exists in MediaRef. */
  mediaId: string | null;
  /** Catalog key, e.g. `tmdb:tv:1429`; also the change-request target for new titles. */
  key: string;
  title: string;
  originalTitle: string | null;
  year: number | null;
  type: MediaType;
  category: MediaCategory;
  posterUrl: string | null;
  platforms: PlatformNamespace[];
}

/** Media detail page model: MediaRef coverage (when in the library) + catalog presentation. */
export interface MediaItem {
  /** Route param: the media UUID when in the library, otherwise the catalog key. */
  id: string;
  mediaId: string | null;
  /** Catalog key for presentation lookups and as the change-request target. */
  catalogKey: string;
  type: MediaType;
  category: MediaCategory;
  title: string;
  originalTitle: string | null;
  yearRange: string;
  year: number | null;
  region: string;
  statusLabel: string;
  genres: string[];
  synopsis: string;
  credits: Array<{ role: string; name: string }>;
  posterUrl: string | null;
  backdropUrl: string | null;
  baseline: BaselineSource | null;
  seasons: MediaSeasonInfo[];
  totalEpisodes?: number;
  defaultSeason?: number;
  platformRows: PlatformVariantRow[];
  catalogRows: CatalogDirectoryRow[];
  catalogNote?: string;
}

export interface DemandItem {
  id: string;
  card: CardItem;
  demandCount: number;
  season: number | null;
  lastDemandedAt: string;
}

export interface AutoCheckItem {
  id: string;
  title: string;
  detail: string;
  status: "passed" | "needs_confirm" | "failed";
}

export interface ChangeRequestTimelineStep {
  label: string;
  time: string;
  detail: string;
  state: "done" | "current" | "pending";
}

export interface ChangeRequestSegmentView {
  season: number;
  start: number;
  end: number | null;
  targetStart: number;
}

export interface ChangeRequestItem {
  id: string;
  status: ChangeRequestStatus;
  /** Media in the library, when the target already exists. */
  mediaId: string | null;
  /** Change-request target key (catalog key or media id). */
  targetKey: string;
  namespace: Namespace;
  nativeId: string;
  pageUrl: string;
  /** Title of the platform page, from the evidence check. */
  pageTitle: string | null;
  pageEpisodeCount: number | null;
  variantLabel: string | null;
  segments: ChangeRequestSegmentView[];
  conflictReason: string | null;
  decisionReason: string | null;
  submitterUserId: string;
  createdAt: string;
  reviewedAt: string | null;
  checks: AutoCheckItem[];
  timeline: ChangeRequestTimelineStep[];
}

export interface ReviewAlertItem {
  id: string;
  alertType: string;
  namespace: Namespace | null;
  badge: string;
  severity: "destructive" | "warning";
  title: string;
  description: string;
  createdAt: string;
  mediaId: string | null;
  associationId: string | null;
}

export interface ApiKeyItem {
  id: string;
  name: string;
  prefix: string;
  canSubmit: boolean;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

export interface ApiTrendDay {
  /** `MM-DD` */
  date: string;
  found: number;
  notFound: number;
  submitted: number;
}
