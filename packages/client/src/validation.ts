import { isBaselineSource } from "./types.ts";
import type { BaselineSource, NormalizedSegment, Segment, SegmentInput } from "./types.ts";

export type SegmentValidationErrorCode =
  | "INVALID_SEASON"
  | "INVALID_EPISODE_START"
  | "INVALID_EPISODE_END"
  | "EPISODE_END_BEFORE_START"
  | "INVALID_TARGET_EPISODE_START"
  | "INVALID_BASELINE"
  | "BASELINE_REQUIRED_FOR_SEGMENTS"
  | "OVERLAPPING_VARIANT_SEGMENTS"
  | "CONFLICTING_WHOLE_MEDIA_ASSOCIATION"
  | "SHARED_COLLECTION_OPEN_ENDED_SEGMENT"
  | "SHARED_COLLECTION_NON_LINEAR_SEGMENT"
  | "SHARED_COLLECTION_WHOLE_MEDIA"
  | "OVERLAPPING_SHARED_COLLECTION_TARGET_RANGE";

export interface SegmentValidationError {
  code: SegmentValidationErrorCode;
  message: string;
  associationIndex?: number;
  segmentIndex?: number;
  mediaId?: string;
  associationId?: string;
}

export type SegmentValidationResult =
  | { valid: true }
  | { valid: false; errors: SegmentValidationError[] };

export interface VariantAssociationSegments {
  readonly id?: string;
  readonly associationId?: string;
  readonly segments: readonly SegmentInput[];
}

export type VariantAssociationSegmentsInput = readonly SegmentInput[] | VariantAssociationSegments;

export interface ValidateVariantSegmentsOptions {
  baseline?: BaselineSource | null;
}

export interface SharedCollectionEntry {
  readonly mediaId: string;
  readonly associationId?: string;
  readonly segments: readonly SegmentInput[];
}

export function normalizeSegment(input: SegmentInput): NormalizedSegment {
  const isWholeSeasonShorthand =
    input.episodeStart === undefined &&
    input.episodeEnd === undefined &&
    input.targetEpisodeStart === undefined;

  if (isWholeSeasonShorthand) {
    return {
      season: input.season,
      episodeStart: 1,
      episodeEnd: null,
      targetEpisodeStart: 1,
      baseline: input.baseline,
      nonLinear: Boolean(input.nonLinear),
      needsReview: Boolean(input.needsReview),
    };
  }

  return {
    season: input.season,
    episodeStart: input.episodeStart as number,
    episodeEnd: input.episodeEnd ?? null,
    targetEpisodeStart: input.targetEpisodeStart as number,
    baseline: input.baseline,
    nonLinear: Boolean(input.nonLinear),
    needsReview: Boolean(input.needsReview),
  };
}

export function normalizeSegments(inputs: readonly SegmentInput[]): NormalizedSegment[] {
  return inputs.map(normalizeSegment);
}

export function validateSegment(segment: Segment | SegmentInput): SegmentValidationResult {
  const normalized = normalizeSegment(segment);
  const errors: SegmentValidationError[] = [];

  if (!Number.isInteger(normalized.season) || normalized.season < 0) {
    errors.push({
      code: "INVALID_SEASON",
      message: `season must be an integer >= 0, got ${String(normalized.season)}`,
    });
  }

  const episodeStartValid =
    Number.isInteger(normalized.episodeStart) && normalized.episodeStart >= 1;
  if (!episodeStartValid) {
    errors.push({
      code: "INVALID_EPISODE_START",
      message: `episodeStart must be an integer >= 1, got ${String(normalized.episodeStart)}`,
    });
  }

  if (normalized.episodeEnd !== null) {
    const episodeEndValid = Number.isInteger(normalized.episodeEnd) && normalized.episodeEnd >= 1;
    if (!episodeEndValid) {
      errors.push({
        code: "INVALID_EPISODE_END",
        message: `episodeEnd must be null or an integer >= 1, got ${String(normalized.episodeEnd)}`,
      });
    } else if (episodeStartValid && normalized.episodeEnd < normalized.episodeStart) {
      errors.push({
        code: "EPISODE_END_BEFORE_START",
        message: `episodeEnd (${normalized.episodeEnd}) must be >= episodeStart (${normalized.episodeStart})`,
      });
    }
  }

  if (!Number.isInteger(normalized.targetEpisodeStart) || normalized.targetEpisodeStart < 1) {
    errors.push({
      code: "INVALID_TARGET_EPISODE_START",
      message: `targetEpisodeStart must be an integer >= 1, got ${String(normalized.targetEpisodeStart)}`,
    });
  }

  if (typeof normalized.baseline !== "string" || !isBaselineSource(normalized.baseline)) {
    errors.push({
      code: "INVALID_BASELINE",
      message: `baseline must be a valid baseline source, got ${String(normalized.baseline)}`,
    });
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

interface NormalizedAssociationEntry {
  associationIndex: number;
  associationId?: string;
  segments: readonly SegmentInput[];
}

function normalizeVariantAssociationInput(
  item: VariantAssociationSegmentsInput,
  associationIndex: number,
): NormalizedAssociationEntry {
  if (Array.isArray(item)) {
    return { associationIndex, segments: item };
  }
  const entry = item as VariantAssociationSegments;
  return {
    associationIndex,
    associationId: entry.associationId ?? entry.id,
    segments: entry.segments,
  };
}

function formatEpisodeRange(start: number, end: number | null): string {
  return end === null ? `${start}..` : `${start}..${end}`;
}

export function validateVariantSegments(
  associationsSegments: readonly VariantAssociationSegmentsInput[],
  options?: ValidateVariantSegmentsOptions,
): SegmentValidationResult {
  if (associationsSegments.length === 0) {
    return { valid: true };
  }

  const entries = associationsSegments.map(normalizeVariantAssociationInput);
  const errors: SegmentValidationError[] = [];

  if (entries.length > 1) {
    for (const entry of entries) {
      if (entry.segments.length === 0) {
        errors.push({
          code: "CONFLICTING_WHOLE_MEDIA_ASSOCIATION",
          message:
            "A whole-media association (segments: []) cannot coexist with other associations in the same variant",
          associationIndex: entry.associationIndex,
          ...(entry.associationId !== undefined ? { associationId: entry.associationId } : {}),
        });
      }
    }
  }

  interface IndexedSegment {
    associationIndex: number;
    associationId?: string;
    segmentIndex: number;
    segment: NormalizedSegment;
  }

  const bySeason = new Map<number, IndexedSegment[]>();

  for (const entry of entries) {
    if (options?.baseline === null && entry.segments.length > 0) {
      errors.push({
        code: "BASELINE_REQUIRED_FOR_SEGMENTS",
        message: "Media without a baseline cannot have segmented associations",
        associationIndex: entry.associationIndex,
        ...(entry.associationId !== undefined ? { associationId: entry.associationId } : {}),
      });
    }

    for (let segmentIndex = 0; segmentIndex < entry.segments.length; segmentIndex++) {
      const raw = entry.segments[segmentIndex];
      const check = validateSegment(raw);
      if (!check.valid) {
        for (const err of check.errors) {
          errors.push({
            ...err,
            associationIndex: entry.associationIndex,
            segmentIndex,
            ...(entry.associationId !== undefined ? { associationId: entry.associationId } : {}),
          });
        }
        continue;
      }

      const normalized = normalizeSegment(raw);
      const list = bySeason.get(normalized.season) ?? [];
      list.push({
        associationIndex: entry.associationIndex,
        associationId: entry.associationId,
        segmentIndex,
        segment: normalized,
      });
      bySeason.set(normalized.season, list);
    }
  }

  for (const [season, items] of bySeason) {
    items.sort((a, b) => {
      if (a.segment.episodeStart !== b.segment.episodeStart) {
        return a.segment.episodeStart - b.segment.episodeStart;
      }
      return (
        (a.segment.episodeEnd ?? Number.POSITIVE_INFINITY) -
        (b.segment.episodeEnd ?? Number.POSITIVE_INFINITY)
      );
    });

    let maxEnd = -1;
    let maxEndItem: IndexedSegment | null = null;

    for (const item of items) {
      const currEnd = item.segment.episodeEnd ?? Number.POSITIVE_INFINITY;
      if (maxEndItem !== null && item.segment.episodeStart <= maxEnd) {
        errors.push({
          code: "OVERLAPPING_VARIANT_SEGMENTS",
          message: `Overlapping segments in season ${season}: [${formatEpisodeRange(maxEndItem.segment.episodeStart, maxEndItem.segment.episodeEnd)}] overlaps [${formatEpisodeRange(item.segment.episodeStart, item.segment.episodeEnd)}]`,
          associationIndex: item.associationIndex,
          segmentIndex: item.segmentIndex,
          ...(item.associationId !== undefined ? { associationId: item.associationId } : {}),
        });
      }
      if (currEnd > maxEnd) {
        maxEnd = currEnd;
        maxEndItem = item;
      }
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

export function validateSharedCollectionSegments(
  entries: readonly SharedCollectionEntry[],
): SegmentValidationResult {
  if (entries.length === 0) {
    return { valid: true };
  }

  const errors: SegmentValidationError[] = [];
  const distinctMediaIds = new Set(entries.map((entry) => entry.mediaId));
  const isSharedAcrossMedia = distinctMediaIds.size >= 2;

  interface TargetRange {
    mediaId: string;
    associationId?: string;
    associationIndex: number;
    segmentIndex: number;
    targetStart: number;
    targetEnd: number;
  }

  const targetRanges: TargetRange[] = [];

  for (let associationIndex = 0; associationIndex < entries.length; associationIndex++) {
    const entry = entries[associationIndex];

    if (isSharedAcrossMedia && entry.segments.length === 0) {
      errors.push({
        code: "SHARED_COLLECTION_WHOLE_MEDIA",
        message: "A collection shared across multiple media cannot have a whole-media association",
        mediaId: entry.mediaId,
        associationIndex,
        ...(entry.associationId !== undefined ? { associationId: entry.associationId } : {}),
      });
      continue;
    }

    for (let segmentIndex = 0; segmentIndex < entry.segments.length; segmentIndex++) {
      const raw = entry.segments[segmentIndex];
      const check = validateSegment(raw);
      if (!check.valid) {
        for (const err of check.errors) {
          errors.push({
            ...err,
            mediaId: entry.mediaId,
            associationIndex,
            segmentIndex,
            ...(entry.associationId !== undefined ? { associationId: entry.associationId } : {}),
          });
        }
        continue;
      }

      if (!isSharedAcrossMedia) {
        continue;
      }

      const normalized = normalizeSegment(raw);

      if (normalized.episodeEnd === null) {
        errors.push({
          code: "SHARED_COLLECTION_OPEN_ENDED_SEGMENT",
          message: "Segments on a collection shared across multiple media must specify episodeEnd",
          mediaId: entry.mediaId,
          associationIndex,
          segmentIndex,
          ...(entry.associationId !== undefined ? { associationId: entry.associationId } : {}),
        });
      }

      if (normalized.nonLinear) {
        errors.push({
          code: "SHARED_COLLECTION_NON_LINEAR_SEGMENT",
          message: "A collection shared across multiple media cannot contain nonLinear segments",
          mediaId: entry.mediaId,
          associationIndex,
          segmentIndex,
          ...(entry.associationId !== undefined ? { associationId: entry.associationId } : {}),
        });
      }

      if (normalized.episodeEnd !== null && !normalized.nonLinear) {
        const targetStart = normalized.targetEpisodeStart;
        const targetEnd =
          normalized.targetEpisodeStart + (normalized.episodeEnd - normalized.episodeStart);
        targetRanges.push({
          mediaId: entry.mediaId,
          associationId: entry.associationId,
          associationIndex,
          segmentIndex,
          targetStart,
          targetEnd,
        });
      }
    }
  }

  if (isSharedAcrossMedia && targetRanges.length > 1) {
    targetRanges.sort((a, b) => {
      if (a.targetStart !== b.targetStart) {
        return a.targetStart - b.targetStart;
      }
      return a.targetEnd - b.targetEnd;
    });

    let maxTargetEnd = -1;
    let maxRange: TargetRange | null = null;

    for (const range of targetRanges) {
      if (maxRange !== null && range.targetStart <= maxTargetEnd) {
        errors.push({
          code: "OVERLAPPING_SHARED_COLLECTION_TARGET_RANGE",
          message: `Overlapping target episode intervals on shared collection: [${maxRange.targetStart}..${maxRange.targetEnd}] (${maxRange.mediaId}) overlaps [${range.targetStart}..${range.targetEnd}] (${range.mediaId})`,
          mediaId: range.mediaId,
          associationIndex: range.associationIndex,
          segmentIndex: range.segmentIndex,
          ...(range.associationId !== undefined ? { associationId: range.associationId } : {}),
        });
      }
      if (range.targetEnd > maxTargetEnd) {
        maxTargetEnd = range.targetEnd;
        maxRange = range;
      }
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}
