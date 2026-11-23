export type MediaType = "movie" | "tv";

export const PLATFORM_NAMESPACES = ["tencent", "iqiyi", "youku", "bilibili", "mgtv"] as const;
export type PlatformNamespace = (typeof PLATFORM_NAMESPACES)[number];

export const CATALOG_NAMESPACES = ["tmdb", "douban", "imdb", "tvdb", "trakt", "bangumi"] as const;
export type CatalogNamespace = (typeof CATALOG_NAMESPACES)[number];

export const NAMESPACES = [...PLATFORM_NAMESPACES, ...CATALOG_NAMESPACES] as const;
export type Namespace = PlatformNamespace | CatalogNamespace;

export type NamespaceGroup = "platform" | "catalog";

export const BASELINE_PRIORITY = ["tmdb", "tvdb", "imdb", "bangumi", "douban"] as const;
export type BaselineSource = (typeof BASELINE_PRIORITY)[number];

export const EXTERNAL_ID_NAMESPACES = ["tmdb", "imdb", "tvdb", "trakt"] as const;
export type ExternalIdNamespace = (typeof EXTERNAL_ID_NAMESPACES)[number];

const PLATFORM_NAMESPACE_SET: ReadonlySet<string> = new Set(PLATFORM_NAMESPACES);
const CATALOG_NAMESPACE_SET: ReadonlySet<string> = new Set(CATALOG_NAMESPACES);
const BASELINE_SOURCE_SET: ReadonlySet<string> = new Set(BASELINE_PRIORITY);

export function isPlatformNamespace(value: string): value is PlatformNamespace {
  return PLATFORM_NAMESPACE_SET.has(value);
}

export function isCatalogNamespace(value: string): value is CatalogNamespace {
  return CATALOG_NAMESPACE_SET.has(value);
}

export function isNamespace(value: string): value is Namespace {
  return PLATFORM_NAMESPACE_SET.has(value) || CATALOG_NAMESPACE_SET.has(value);
}

export function isBaselineSource(value: string): value is BaselineSource {
  return BASELINE_SOURCE_SET.has(value);
}

export function getNamespaceGroup(namespace: Namespace): NamespaceGroup {
  return isPlatformNamespace(namespace) ? "platform" : "catalog";
}

export interface ExternalId {
  namespace: ExternalIdNamespace;
  nativeId: string;
  locked?: boolean;
}

export interface ExternalKey {
  namespace: Namespace;
  nativeId: string;
}

export interface SeasonSnapshot {
  season: number;
  episodeCount: number;
  airYear: number | null;
}

export interface MediaSnapshot {
  title: string;
  originalTitle: string | null;
  year: number | null;
  type: MediaType;
  seasons: readonly SeasonSnapshot[];
}

export interface Media {
  id: string;
  type: MediaType;
  baseline: BaselineSource | null;
  snapshot: MediaSnapshot;
}

export interface Variant {
  id: string;
  mediaId?: string;
  namespace: PlatformNamespace;
  label: string;
  isDefault: boolean;
}

export type AssociationStatus = "confirmed" | "seed_unconfirmed" | "delisted";

export type ChangeRequestStatus = "pending_evidence" | "approved" | "needs_review" | "rejected";

export type PlatformStatus = "associated" | "not_found" | "unchecked";

export type PlatformStatusEntry =
  | { status: "associated" }
  | { status: "not_found"; checkedAt: string }
  | { status: "unchecked" };

export interface Segment {
  season: number;
  episodeStart: number;
  episodeEnd: number | null;
  targetEpisodeStart: number;
  baseline: BaselineSource;
  nonLinear?: boolean;
  needsReview?: boolean;
}

export interface NormalizedSegment extends Segment {
  nonLinear: boolean;
  needsReview: boolean;
}

export interface WholeSeasonSegmentInput {
  season: number;
  baseline: BaselineSource;
  episodeStart?: undefined;
  episodeEnd?: undefined;
  targetEpisodeStart?: undefined;
  nonLinear?: boolean;
  needsReview?: boolean;
}

export interface ExplicitSegmentInput {
  season: number;
  episodeStart: number;
  episodeEnd?: number | null;
  targetEpisodeStart: number;
  baseline: BaselineSource;
  nonLinear?: boolean;
  needsReview?: boolean;
}

export type SegmentInput = WholeSeasonSegmentInput | ExplicitSegmentInput;

export interface Association {
  id: string;
  mediaId?: string;
  namespace: Namespace;
  nativeId: string;
  variantId: string | null;
  status: AssociationStatus;
  segments: readonly Segment[];
  needsReview?: boolean;
  locked?: boolean;
  unconfirmed?: boolean;
}

export interface MediaDocument {
  media: Media;
  externalIds: readonly ExternalId[];
  variants: readonly Variant[];
  associations: readonly Association[];
  matchedAssociationIds?: readonly string[];
  platformStatuses?: Partial<Record<PlatformNamespace, PlatformStatusEntry>>;
}
