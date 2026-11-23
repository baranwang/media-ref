import { isPlatformNamespace } from "./types.ts";
import type { Association, MediaDocument, Namespace, Segment } from "./types.ts";

export interface ResolveEpisodeQuery {
  namespace: Namespace;
  season?: number;
  episode?: number;
  variantId?: string;
  includeUnconfirmed?: boolean;
}

export type CollectionOnlyReason = "whole_media" | "non_linear" | "needs_review";

export type UnmappedReason =
  | "no_variant"
  | "no_association"
  | "episode_out_of_range"
  | "missing_episode";

export interface MappedEpisodeResult {
  kind: "mapped";
  associationId: string;
  namespace: Namespace;
  nativeId: string;
  variantId: string | null;
  targetEpisode: number;
  segment: Segment;
}

export interface CollectionOnlyResult {
  kind: "collection_only";
  reason: CollectionOnlyReason;
  associationId: string;
  namespace: Namespace;
  nativeId: string;
  variantId: string | null;
  segment?: Segment;
}

export interface UnmappedEpisodeResult {
  kind: "unmapped";
  reason: UnmappedReason;
}

export type ResolveEpisodeResult =
  | MappedEpisodeResult
  | CollectionOnlyResult
  | UnmappedEpisodeResult;

function isConfirmedAssociation(association: Association): boolean {
  return association.status === "confirmed" && association.unconfirmed !== true;
}

function selectActiveAssociations(
  associations: readonly Association[],
  predicate: (association: Association) => boolean,
  includeUnconfirmed: boolean,
): Association[] {
  const confirmed: Association[] = [];
  const unconfirmed: Association[] = [];

  for (const association of associations) {
    if (association.status === "delisted" || !predicate(association)) {
      continue;
    }

    if (isConfirmedAssociation(association)) {
      confirmed.push(association);
    } else if (includeUnconfirmed) {
      unconfirmed.push(association);
    }
  }

  return includeUnconfirmed ? [...confirmed, ...unconfirmed] : confirmed;
}

export function resolveEpisode(
  doc: MediaDocument,
  query: ResolveEpisodeQuery,
): ResolveEpisodeResult {
  const includeUnconfirmed = query.includeUnconfirmed === true;
  let candidates: Association[];

  if (isPlatformNamespace(query.namespace)) {
    const variant =
      query.variantId !== undefined
        ? doc.variants.find((v) => v.id === query.variantId && v.namespace === query.namespace)
        : doc.variants.find((v) => v.namespace === query.namespace && v.isDefault);

    if (!variant) {
      return { kind: "unmapped", reason: "no_variant" };
    }

    candidates = selectActiveAssociations(
      doc.associations,
      (a) => a.namespace === query.namespace && a.variantId === variant.id,
      includeUnconfirmed,
    );
  } else {
    if (query.variantId !== undefined) {
      return { kind: "unmapped", reason: "no_variant" };
    }

    candidates = selectActiveAssociations(
      doc.associations,
      (a) => a.namespace === query.namespace && a.variantId === null,
      includeUnconfirmed,
    );
  }

  if (candidates.length === 0) {
    return { kind: "unmapped", reason: "no_association" };
  }

  const wholeMediaCandidates = candidates.filter((a) => a.segments.length === 0);
  const segmentedCandidates = candidates.filter((a) => a.segments.length > 0);

  if (segmentedCandidates.length > 0 && query.season !== undefined && query.episode !== undefined) {
    if (
      !Number.isInteger(query.season) ||
      query.season < 0 ||
      !Number.isInteger(query.episode) ||
      query.episode < 1
    ) {
      return { kind: "unmapped", reason: "episode_out_of_range" };
    }

    for (const association of segmentedCandidates) {
      for (const segment of association.segments) {
        const matchesSeason = segment.season === query.season;
        const matchesStart = query.episode >= segment.episodeStart;
        const matchesEnd = segment.episodeEnd === null || query.episode <= segment.episodeEnd;

        if (!matchesSeason || !matchesStart || !matchesEnd) {
          continue;
        }

        const needsReview =
          segment.needsReview === true ||
          association.needsReview === true ||
          doc.media.baseline === null ||
          segment.baseline !== doc.media.baseline;

        if (needsReview) {
          return {
            kind: "collection_only",
            reason: "needs_review",
            associationId: association.id,
            namespace: association.namespace,
            nativeId: association.nativeId,
            variantId: association.variantId,
            segment,
          };
        }

        if (segment.nonLinear === true) {
          return {
            kind: "collection_only",
            reason: "non_linear",
            associationId: association.id,
            namespace: association.namespace,
            nativeId: association.nativeId,
            variantId: association.variantId,
            segment,
          };
        }

        return {
          kind: "mapped",
          associationId: association.id,
          namespace: association.namespace,
          nativeId: association.nativeId,
          variantId: association.variantId,
          targetEpisode: segment.targetEpisodeStart + (query.episode - segment.episodeStart),
          segment,
        };
      }
    }
  }

  if (wholeMediaCandidates.length > 0) {
    const whole = wholeMediaCandidates[0];
    return {
      kind: "collection_only",
      reason: whole.needsReview === true ? "needs_review" : "whole_media",
      associationId: whole.id,
      namespace: whole.namespace,
      nativeId: whole.nativeId,
      variantId: whole.variantId,
    };
  }

  if (query.season === undefined || query.episode === undefined) {
    return { kind: "unmapped", reason: "missing_episode" };
  }

  return { kind: "unmapped", reason: "episode_out_of_range" };
}
