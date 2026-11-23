import type { CatalogNamespace, MediaType, Namespace, PlatformNamespace } from "@media-ref/client";
import type { OutboundClient } from "../outbound.ts";

export type AdapterTier = 1 | 2 | 3;

export class InvalidNativeIdError extends Error {
  readonly code = "INVALID_NATIVE_ID" as const;
  readonly namespace: Namespace;
  readonly rawInput: string;
  readonly reason: string;

  constructor(namespace: Namespace, rawInput: string, reason: string) {
    super(`Invalid native ID for ${namespace}: ${reason}`);
    this.name = "InvalidNativeIdError";
    this.namespace = namespace;
    this.rawInput = rawInput;
    this.reason = reason;
  }
}

export class AdapterTransientError extends Error {
  readonly code = "ADAPTER_TRANSIENT_ERROR" as const;
  readonly namespace: Namespace;
  readonly reason: string;
  readonly retryAfterMs?: number;

  constructor(namespace: Namespace, reason: string, retryAfterMs?: number) {
    super(`Transient error from ${namespace}: ${reason}`);
    this.name = "AdapterTransientError";
    this.namespace = namespace;
    this.reason = reason;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface ParsedNativeIdInput {
  kind: string;
  id: string;
  /** Canonical ID when determinable synchronously without outbound resolution; otherwise null. */
  canonicalId: string | null;
}

export interface FeatureEpisode {
  /** 1-based ordinal in the feature episode list (excluding trailers/previews/extras). */
  index: number;
  nativeEpisodeId?: string;
  title?: string;
  longTitle?: string;
  durationSeconds?: number | null;
  airDate?: string | null;
}

export interface CollectionInfo {
  namespace: Namespace;
  canonicalId: string;
  title: string;
  originalTitle?: string | null;
  aliases?: readonly string[];
  year: number | null;
  mediaType: MediaType | null;
  featureEpisodeCount: number | null;
  featureEpisodes: readonly FeatureEpisode[];
  /**
   * External IDs fetched directly from the platform/catalog during evidence check.
   * NEVER populated from submission input.
   */
  externalIds?: Partial<Record<Namespace, string>>;
}

export type CollectionEvidenceResult =
  | {
      status: "found";
      info: CollectionInfo;
    }
  | {
      status: "not_found";
      reason?: string;
    }
  | {
      status: "transient_error";
      reason: string;
      retryAfterMs?: number;
    };

export interface AdapterSearchQuery {
  title: string;
  originalTitle?: string | null;
  aliases?: readonly string[];
  year?: number | null;
  mediaType?: MediaType;
  season?: number | null;
  limit?: number;
}

export interface AdapterSearchCandidate {
  canonicalId: string;
  title: string;
  originalTitle?: string | null;
  year?: number | null;
  mediaType?: MediaType | null;
  episodeCount?: number | null;
  url?: string;
}

export type AdapterSearchResult =
  | {
      status: "ok";
      candidates: readonly AdapterSearchCandidate[];
    }
  | {
      status: "transient_error";
      reason: string;
      retryAfterMs?: number;
    };

export interface Tier1Adapter<N extends Namespace = Namespace> {
  readonly namespace: N;
  readonly tier: 1;
  parseInput(raw: string): ParsedNativeIdInput | null;
  canonicalize(raw: string, outbound: OutboundClient): Promise<string>;
}

export interface Tier2Adapter<N extends Namespace = Namespace> {
  readonly namespace: N;
  readonly tier: 2;
  parseInput(raw: string): ParsedNativeIdInput | null;
  canonicalize(raw: string, outbound: OutboundClient): Promise<string>;
  fetchCollection(canonicalId: string, outbound: OutboundClient): Promise<CollectionEvidenceResult>;
}

export interface Tier3Adapter<N extends Namespace = Namespace> {
  readonly namespace: N;
  readonly tier: 3;
  parseInput(raw: string): ParsedNativeIdInput | null;
  canonicalize(raw: string, outbound: OutboundClient): Promise<string>;
  fetchCollection(canonicalId: string, outbound: OutboundClient): Promise<CollectionEvidenceResult>;
  search(query: AdapterSearchQuery, outbound: OutboundClient): Promise<AdapterSearchResult>;
}

export type MediaAdapter<N extends Namespace = Namespace> =
  | Tier1Adapter<N>
  | Tier2Adapter<N>
  | Tier3Adapter<N>;

export type PlatformAdapter<N extends PlatformNamespace = PlatformNamespace> = MediaAdapter<N>;
export type CatalogAdapter<N extends CatalogNamespace = CatalogNamespace> = MediaAdapter<N>;

export function isTier2Adapter<N extends Namespace>(
  adapter: MediaAdapter<N>,
): adapter is Tier2Adapter<N> | Tier3Adapter<N> {
  return adapter.tier >= 2;
}

export function isTier3Adapter<N extends Namespace>(
  adapter: MediaAdapter<N>,
): adapter is Tier3Adapter<N> {
  return adapter.tier === 3;
}

export interface AdapterRegistry {
  get(namespace: Namespace): MediaAdapter | undefined;
  has(namespace: Namespace): boolean;
  list(): readonly MediaAdapter[];
  listByMinTier(minTier: AdapterTier): readonly MediaAdapter[];
}

export interface CreateTier1AdapterOptions<N extends Namespace = Namespace> {
  namespace: N;
  parseInput(raw: string): ParsedNativeIdInput | null;
  resolveToCanonical?: (parsed: ParsedNativeIdInput, outbound: OutboundClient) => Promise<string>;
}

export function createTier1Adapter<N extends Namespace>(
  options: CreateTier1AdapterOptions<N>,
): Tier1Adapter<N> {
  return {
    namespace: options.namespace,
    tier: 1,
    parseInput(raw) {
      return options.parseInput(raw);
    },
    async canonicalize(raw, outbound) {
      const parsed = options.parseInput(raw);
      if (!parsed) {
        throw new InvalidNativeIdError(
          options.namespace,
          raw,
          `Unrecognized ${options.namespace} URL or ID`,
        );
      }
      if (parsed.canonicalId !== null) {
        return parsed.canonicalId;
      }
      if (!options.resolveToCanonical) {
        throw new InvalidNativeIdError(
          options.namespace,
          raw,
          `Cannot canonicalize ${options.namespace} input of kind "${parsed.kind}"`,
        );
      }
      return options.resolveToCanonical(parsed, outbound);
    },
  };
}
