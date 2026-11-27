export type MediaType = "movie" | "tv";

export type NamespaceGroup = "platform" | "catalog";

/**
 * How an association in a namespace gets trusted.
 * - `sync`: authority catalog; IDs arrive through upstream sync or a reviewer and skip the evidence gate.
 * - `evidence`: every association is proposed by a change request and passes the evidence gate.
 */
export type VerificationMode = "sync" | "evidence";

export interface NamespaceCapabilities {
  group: NamespaceGroup;
  /** Associations must belong to a variant (platforms only). */
  supportsVariants: boolean;
  /** Whole-media, season and episode associations may nest for one media (e.g. IMDb show + episode). */
  allowHierarchicalScopes: boolean;
  verificationMode: VerificationMode;
}

const PLATFORM = {
  group: "platform",
  supportsVariants: true,
  allowHierarchicalScopes: false,
  verificationMode: "evidence",
} as const satisfies NamespaceCapabilities;
const AUTHORITY_CATALOG = {
  group: "catalog",
  supportsVariants: false,
  allowHierarchicalScopes: true,
  verificationMode: "sync",
} as const satisfies NamespaceCapabilities;
const GATED_CATALOG = {
  group: "catalog",
  supportsVariants: false,
  allowHierarchicalScopes: false,
  verificationMode: "evidence",
} as const satisfies NamespaceCapabilities;

/** Single source of truth for namespaces; mirrored by the `namespaces` table (see ADR 0001). */
export const NAMESPACE_CAPABILITIES = {
  tencent: PLATFORM,
  iqiyi: PLATFORM,
  youku: PLATFORM,
  bilibili: PLATFORM,
  mgtv: PLATFORM,
  tmdb: AUTHORITY_CATALOG,
  douban: GATED_CATALOG,
  imdb: AUTHORITY_CATALOG,
  tvdb: AUTHORITY_CATALOG,
  trakt: AUTHORITY_CATALOG,
  bangumi: GATED_CATALOG,
} as const satisfies Record<string, NamespaceCapabilities>;

export type Namespace = keyof typeof NAMESPACE_CAPABILITIES;

type NamespacesWhere<C> = {
  [K in Namespace]: (typeof NAMESPACE_CAPABILITIES)[K] extends C ? K : never;
}[Namespace];

export type PlatformNamespace = NamespacesWhere<{ group: "platform" }>;
export type CatalogNamespace = NamespacesWhere<{ group: "catalog" }>;
/** Authority catalogs: their whole-media association is the media's External ID. */
export type ExternalIdNamespace = NamespacesWhere<{ verificationMode: "sync" }>;

export const NAMESPACES = Object.keys(NAMESPACE_CAPABILITIES) as readonly Namespace[];
export const PLATFORM_NAMESPACES: readonly PlatformNamespace[] = NAMESPACES.filter(
  (ns): ns is PlatformNamespace => NAMESPACE_CAPABILITIES[ns].group === "platform",
);
export const CATALOG_NAMESPACES: readonly CatalogNamespace[] = NAMESPACES.filter(
  (ns): ns is CatalogNamespace => NAMESPACE_CAPABILITIES[ns].group === "catalog",
);
export const EXTERNAL_ID_NAMESPACES: readonly ExternalIdNamespace[] = NAMESPACES.filter(
  (ns): ns is ExternalIdNamespace => NAMESPACE_CAPABILITIES[ns].verificationMode === "sync",
);

export const BASELINE_PRIORITY = ["tmdb", "tvdb", "imdb", "bangumi", "douban"] as const;
export type BaselineSource = (typeof BASELINE_PRIORITY)[number];

const BASELINE_SOURCE_SET: ReadonlySet<string> = new Set(BASELINE_PRIORITY);

export function isNamespace(value: string): value is Namespace {
  return Object.hasOwn(NAMESPACE_CAPABILITIES, value);
}

export function getNamespaceCapabilities(namespace: Namespace): NamespaceCapabilities {
  return NAMESPACE_CAPABILITIES[namespace];
}

export function isPlatformNamespace(value: string): value is PlatformNamespace {
  return isNamespace(value) && NAMESPACE_CAPABILITIES[value].group === "platform";
}

export function isCatalogNamespace(value: string): value is CatalogNamespace {
  return isNamespace(value) && NAMESPACE_CAPABILITIES[value].group === "catalog";
}

export function isExternalIdNamespace(value: string): value is ExternalIdNamespace {
  return isNamespace(value) && NAMESPACE_CAPABILITIES[value].verificationMode === "sync";
}

export function isBaselineSource(value: string): value is BaselineSource {
  return BASELINE_SOURCE_SET.has(value);
}

export function getNamespaceGroup(namespace: Namespace): NamespaceGroup {
  return NAMESPACE_CAPABILITIES[namespace].group;
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

export interface TmdbRef {
  type: MediaType;
  id: number;
}

export interface TvdbRef {
  id: number;
  type?: MediaType;
}

export interface TraktRef {
  id: string;
  type?: MediaType;
}

export interface PlatformRef {
  platform: PlatformNamespace;
  nativeId: string;
}

export type MediaRef =
  | { mediaId: string }
  | { tmdb: TmdbRef }
  | { imdb: string }
  | { tvdb: TvdbRef }
  | { trakt: TraktRef }
  | { douban: string }
  | { bangumi: string }
  | { platform: PlatformRef };

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
  unconfirmed?: boolean;
}

export type AssociationStatus = "confirmed" | "seed_unconfirmed" | "delisted";

export type ChangeRequestStatus = "pending_evidence" | "approved" | "needs_review" | "rejected";

export type UnconfirmedAssociationSource = "seed_unconfirmed" | "change_request";

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
  unconfirmedSource?: UnconfirmedAssociationSource;
  changeRequestId?: string;
  changeRequestStatus?: Extract<ChangeRequestStatus, "pending_evidence" | "needs_review">;
  /** Native title of the collection/entry, snapshotted from evidence check or upstream sync. */
  title?: string;
  /** Episode count of the collection/entry, snapshotted alongside `title`. */
  episodeCount?: number;
  /** Douban only: the platforms its "where to watch" lists, snapshotted alongside `title`. */
  listedPlatforms?: readonly PlatformNamespace[];
}

export interface MediaDocument {
  media: Media;
  externalIds: readonly ExternalId[];
  variants: readonly Variant[];
  associations: readonly Association[];
  matchedAssociationIds?: readonly string[];
  platformStatuses?: Partial<Record<PlatformNamespace, PlatformStatusEntry>>;
}
