import { describe, expect, test } from "vite-plus/test";
import {
  normalizeSegment,
  validateSegment,
  validateSharedCollectionSegments,
  validateVariantSegments,
} from "../src/index.ts";
import type { SegmentInput } from "../src/index.ts";

describe("normalizeSegment", () => {
  test("expands whole-season shorthand to episodeStart=1, episodeEnd=null, targetEpisodeStart=1", () => {
    expect(normalizeSegment({ season: 2, baseline: "tmdb" })).toEqual({
      season: 2,
      episodeStart: 1,
      episodeEnd: null,
      targetEpisodeStart: 1,
      baseline: "tmdb",
      nonLinear: false,
      needsReview: false,
    });

    expect(normalizeSegment({ season: 1, baseline: "douban", nonLinear: true })).toEqual({
      season: 1,
      episodeStart: 1,
      episodeEnd: null,
      targetEpisodeStart: 1,
      baseline: "douban",
      nonLinear: true,
      needsReview: false,
    });
  });

  test("preserves explicit segment fields and normalizes omitted optional fields", () => {
    expect(
      normalizeSegment({
        season: 1,
        episodeStart: 25,
        episodeEnd: 47,
        targetEpisodeStart: 1,
        baseline: "tmdb",
      }),
    ).toEqual({
      season: 1,
      episodeStart: 25,
      episodeEnd: 47,
      targetEpisodeStart: 1,
      baseline: "tmdb",
      nonLinear: false,
      needsReview: false,
    });

    expect(
      normalizeSegment({
        season: 1,
        episodeStart: 25,
        targetEpisodeStart: 1,
        baseline: "tmdb",
        needsReview: true,
      }),
    ).toEqual({
      season: 1,
      episodeStart: 25,
      episodeEnd: null,
      targetEpisodeStart: 1,
      baseline: "tmdb",
      nonLinear: false,
      needsReview: true,
    });
  });
});

describe("validateSegment", () => {
  test("accepts valid finite, open-ended, season 0, and whole-season shorthand segments", () => {
    expect(
      validateSegment({
        season: 1,
        episodeStart: 1,
        episodeEnd: 24,
        targetEpisodeStart: 1,
        baseline: "tmdb",
      }),
    ).toEqual({ valid: true });

    expect(
      validateSegment({
        season: 0,
        episodeStart: 1,
        episodeEnd: 1,
        targetEpisodeStart: 1,
        baseline: "tvdb",
      }),
    ).toEqual({ valid: true });

    expect(
      validateSegment({
        season: 3,
        episodeStart: 13,
        episodeEnd: null,
        targetEpisodeStart: 1,
        baseline: "bangumi",
      }),
    ).toEqual({ valid: true });

    expect(validateSegment({ season: 2, baseline: "tmdb" })).toEqual({ valid: true });
  });

  test("rejects negative or non-integer season, episodeStart, episodeEnd, and targetEpisodeStart", () => {
    const negSeason = validateSegment({
      season: -1,
      episodeStart: 1,
      episodeEnd: 10,
      targetEpisodeStart: 1,
      baseline: "tmdb",
    });
    expect(negSeason.valid).toBe(false);
    if (!negSeason.valid) {
      expect(negSeason.errors.map((e) => e.code)).toContain("INVALID_SEASON");
    }

    const floatEpisode = validateSegment({
      season: 1,
      episodeStart: 1.5,
      episodeEnd: 10,
      targetEpisodeStart: 1,
      baseline: "tmdb",
    });
    expect(floatEpisode.valid).toBe(false);
    if (!floatEpisode.valid) {
      expect(floatEpisode.errors.map((e) => e.code)).toContain("INVALID_EPISODE_START");
    }

    const zeroStart = validateSegment({
      season: 1,
      episodeStart: 0,
      episodeEnd: 10,
      targetEpisodeStart: 1,
      baseline: "tmdb",
    });
    expect(zeroStart.valid).toBe(false);
    if (!zeroStart.valid) {
      expect(zeroStart.errors.map((e) => e.code)).toContain("INVALID_EPISODE_START");
    }

    const endBeforeStart = validateSegment({
      season: 1,
      episodeStart: 10,
      episodeEnd: 5,
      targetEpisodeStart: 1,
      baseline: "tmdb",
    });
    expect(endBeforeStart.valid).toBe(false);
    if (!endBeforeStart.valid) {
      expect(endBeforeStart.errors.map((e) => e.code)).toContain("EPISODE_END_BEFORE_START");
    }

    const zeroEnd = validateSegment({
      season: 1,
      episodeStart: 1,
      episodeEnd: 0,
      targetEpisodeStart: 1,
      baseline: "tmdb",
    });
    expect(zeroEnd.valid).toBe(false);
    if (!zeroEnd.valid) {
      expect(zeroEnd.errors.map((e) => e.code)).toContain("INVALID_EPISODE_END");
    }

    const zeroTarget = validateSegment({
      season: 1,
      episodeStart: 1,
      episodeEnd: 10,
      targetEpisodeStart: 0,
      baseline: "tmdb",
    });
    expect(zeroTarget.valid).toBe(false);
    if (!zeroTarget.valid) {
      expect(zeroTarget.errors.map((e) => e.code)).toContain("INVALID_TARGET_EPISODE_START");
    }

    const badBaseline = validateSegment({
      season: 1,
      episodeStart: 1,
      episodeEnd: 10,
      targetEpisodeStart: 1,
      baseline: "trakt",
    } as unknown as SegmentInput);
    expect(badBaseline.valid).toBe(false);
    if (!badBaseline.valid) {
      expect(badBaseline.errors.map((e) => e.code)).toContain("INVALID_BASELINE");
    }
  });
});

describe("validateVariantSegments", () => {
  test("accepts adjacent non-overlapping segments across associations (Jujutsu Kaisen split season)", () => {
    expect(
      validateVariantSegments([
        {
          associationId: "a-ss34430",
          segments: [
            { season: 1, episodeStart: 1, episodeEnd: 24, targetEpisodeStart: 1, baseline: "tmdb" },
          ],
        },
        {
          associationId: "a-ss45574",
          segments: [
            {
              season: 1,
              episodeStart: 25,
              episodeEnd: 47,
              targetEpisodeStart: 1,
              baseline: "tmdb",
            },
          ],
        },
      ]),
    ).toEqual({ valid: true });

    // Adjacent finite + open-ended and distinct seasons are also valid
    expect(
      validateVariantSegments([
        [
          { season: 1, episodeStart: 1, episodeEnd: 24, targetEpisodeStart: 1, baseline: "tmdb" },
          { season: 2, baseline: "tmdb" },
        ],
        [
          {
            season: 1,
            episodeStart: 25,
            episodeEnd: null,
            targetEpisodeStart: 1,
            baseline: "tmdb",
          },
        ],
      ]),
    ).toEqual({ valid: true });
  });

  test("rejects overlapping segments including touching inclusive boundaries and open-ended overlaps", () => {
    // Touching inclusive endpoint (24 in both)
    const touching = validateVariantSegments([
      [{ season: 1, episodeStart: 1, episodeEnd: 24, targetEpisodeStart: 1, baseline: "tmdb" }],
      [{ season: 1, episodeStart: 24, episodeEnd: 47, targetEpisodeStart: 1, baseline: "tmdb" }],
    ]);
    expect(touching.valid).toBe(false);
    if (!touching.valid) {
      expect(touching.errors.map((e) => e.code)).toContain("OVERLAPPING_VARIANT_SEGMENTS");
    }

    // Open-ended overlapping a later finite segment
    const openEndedOverlap = validateVariantSegments([
      [{ season: 1, episodeStart: 1, episodeEnd: null, targetEpisodeStart: 1, baseline: "tmdb" }],
      [{ season: 1, episodeStart: 25, episodeEnd: 47, targetEpisodeStart: 1, baseline: "tmdb" }],
    ]);
    expect(openEndedOverlap.valid).toBe(false);
    if (!openEndedOverlap.valid) {
      expect(openEndedOverlap.errors.map((e) => e.code)).toContain("OVERLAPPING_VARIANT_SEGMENTS");
    }

    // Two whole-season shorthands for the same season
    const duplicateWholeSeason = validateVariantSegments([
      [{ season: 1, baseline: "tmdb" }],
      [{ season: 1, baseline: "tmdb" }],
    ]);
    expect(duplicateWholeSeason.valid).toBe(false);
    if (!duplicateWholeSeason.valid) {
      expect(duplicateWholeSeason.errors.map((e) => e.code)).toContain(
        "OVERLAPPING_VARIANT_SEGMENTS",
      );
    }

    // Overlapping segments within the same association
    const intraAssociation = validateVariantSegments([
      [
        { season: 1, episodeStart: 1, episodeEnd: 12, targetEpisodeStart: 1, baseline: "tmdb" },
        { season: 1, episodeStart: 10, episodeEnd: 20, targetEpisodeStart: 13, baseline: "tmdb" },
      ],
    ]);
    expect(intraAssociation.valid).toBe(false);
    if (!intraAssociation.valid) {
      expect(intraAssociation.errors.map((e) => e.code)).toContain("OVERLAPPING_VARIANT_SEGMENTS");
    }
  });

  test("allows a single whole-media association but rejects duplicate or mixed whole-media associations in one variant", () => {
    expect(validateVariantSegments([[]])).toEqual({ valid: true });
    expect(validateVariantSegments([])).toEqual({ valid: true });

    const duplicateWholeMedia = validateVariantSegments([[], []]);
    expect(duplicateWholeMedia.valid).toBe(false);
    if (!duplicateWholeMedia.valid) {
      expect(duplicateWholeMedia.errors.map((e) => e.code)).toContain(
        "CONFLICTING_WHOLE_MEDIA_ASSOCIATION",
      );
    }

    const mixedWholeAndSegmented = validateVariantSegments([
      [],
      [{ season: 1, episodeStart: 1, episodeEnd: 12, targetEpisodeStart: 1, baseline: "tmdb" }],
    ]);
    expect(mixedWholeAndSegmented.valid).toBe(false);
    if (!mixedWholeAndSegmented.valid) {
      expect(mixedWholeAndSegmented.errors.map((e) => e.code)).toContain(
        "CONFLICTING_WHOLE_MEDIA_ASSOCIATION",
      );
    }
  });

  test("rejects segments when media has no baseline (Trakt-only media), while allowing whole-media", () => {
    expect(validateVariantSegments([[]], { baseline: null })).toEqual({ valid: true });

    const withSegments = validateVariantSegments(
      [[{ season: 1, episodeStart: 1, episodeEnd: 12, targetEpisodeStart: 1, baseline: "tmdb" }]],
      { baseline: null },
    );
    expect(withSegments.valid).toBe(false);
    if (!withSegments.valid) {
      expect(withSegments.errors.map((e) => e.code)).toContain("BASELINE_REQUIRED_FOR_SEGMENTS");
    }
  });
});

describe("validateSharedCollectionSegments", () => {
  test("accepts disjoint finite linear target episode ranges across multiple media", () => {
    expect(
      validateSharedCollectionSegments([
        {
          mediaId: "media-a",
          associationId: "assoc-a",
          segments: [
            { season: 1, episodeStart: 1, episodeEnd: 12, targetEpisodeStart: 1, baseline: "tmdb" },
          ],
        },
        {
          mediaId: "media-b",
          associationId: "assoc-b",
          segments: [
            {
              season: 1,
              episodeStart: 1,
              episodeEnd: 12,
              targetEpisodeStart: 13,
              baseline: "tmdb",
            },
          ],
        },
      ]),
    ).toEqual({ valid: true });
  });

  test("rejects overlapping target episode intervals across media sharing one collection", () => {
    // Media A occupies target 1..12; Media B starts at target 12 -> overlaps at 12
    const touching = validateSharedCollectionSegments([
      {
        mediaId: "media-a",
        segments: [
          { season: 1, episodeStart: 1, episodeEnd: 12, targetEpisodeStart: 1, baseline: "tmdb" },
        ],
      },
      {
        mediaId: "media-b",
        segments: [
          { season: 1, episodeStart: 1, episodeEnd: 12, targetEpisodeStart: 12, baseline: "tmdb" },
        ],
      },
    ]);
    expect(touching.valid).toBe(false);
    if (!touching.valid) {
      expect(touching.errors.map((e) => e.code)).toContain(
        "OVERLAPPING_SHARED_COLLECTION_TARGET_RANGE",
      );
    }

    // Offset segment: Media A S1 5..10 -> target 10..15 (length 6); Media B S1 1..3 -> target 14..16
    const offsetOverlap = validateSharedCollectionSegments([
      {
        mediaId: "media-a",
        segments: [
          { season: 1, episodeStart: 5, episodeEnd: 10, targetEpisodeStart: 10, baseline: "tmdb" },
        ],
      },
      {
        mediaId: "media-b",
        segments: [
          { season: 1, episodeStart: 1, episodeEnd: 3, targetEpisodeStart: 14, baseline: "tmdb" },
        ],
      },
    ]);
    expect(offsetOverlap.valid).toBe(false);
    if (!offsetOverlap.valid) {
      expect(offsetOverlap.errors.map((e) => e.code)).toContain(
        "OVERLAPPING_SHARED_COLLECTION_TARGET_RANGE",
      );
    }
  });

  test("rejects open-ended, nonLinear, and whole-media entries on a shared collection", () => {
    const openEnded = validateSharedCollectionSegments([
      {
        mediaId: "media-a",
        segments: [
          { season: 1, episodeStart: 1, episodeEnd: 12, targetEpisodeStart: 1, baseline: "tmdb" },
        ],
      },
      {
        mediaId: "media-b",
        segments: [
          {
            season: 1,
            episodeStart: 1,
            episodeEnd: null,
            targetEpisodeStart: 13,
            baseline: "tmdb",
          },
        ],
      },
    ]);
    expect(openEnded.valid).toBe(false);
    if (!openEnded.valid) {
      expect(openEnded.errors.map((e) => e.code)).toContain("SHARED_COLLECTION_OPEN_ENDED_SEGMENT");
    }

    const nonLinear = validateSharedCollectionSegments([
      {
        mediaId: "media-a",
        segments: [
          {
            season: 1,
            episodeStart: 1,
            episodeEnd: 12,
            targetEpisodeStart: 1,
            baseline: "tmdb",
            nonLinear: true,
          },
        ],
      },
      {
        mediaId: "media-b",
        segments: [
          {
            season: 1,
            episodeStart: 1,
            episodeEnd: 12,
            targetEpisodeStart: 13,
            baseline: "tmdb",
          },
        ],
      },
    ]);
    expect(nonLinear.valid).toBe(false);
    if (!nonLinear.valid) {
      expect(nonLinear.errors.map((e) => e.code)).toContain("SHARED_COLLECTION_NON_LINEAR_SEGMENT");
    }

    const wholeMedia = validateSharedCollectionSegments([
      { mediaId: "media-a", segments: [] },
      {
        mediaId: "media-b",
        segments: [
          { season: 1, episodeStart: 1, episodeEnd: 12, targetEpisodeStart: 1, baseline: "tmdb" },
        ],
      },
    ]);
    expect(wholeMedia.valid).toBe(false);
    if (!wholeMedia.valid) {
      expect(wholeMedia.errors.map((e) => e.code)).toContain("SHARED_COLLECTION_WHOLE_MEDIA");
    }
  });

  test("allows open-ended, nonLinear, and whole-media when collection is NOT shared across multiple media", () => {
    expect(
      validateSharedCollectionSegments([
        {
          mediaId: "media-a",
          segments: [{ season: 1, baseline: "tmdb" }],
        },
      ]),
    ).toEqual({ valid: true });

    expect(
      validateSharedCollectionSegments([
        {
          mediaId: "media-a",
          segments: [{ season: 1, baseline: "tmdb", nonLinear: true }],
        },
      ]),
    ).toEqual({ valid: true });

    expect(
      validateSharedCollectionSegments([
        {
          mediaId: "media-a",
          segments: [],
        },
      ]),
    ).toEqual({ valid: true });

    // Even when not shared across multiple media, invalid segment fields are still rejected
    const invalidSingle = validateSharedCollectionSegments([
      {
        mediaId: "media-a",
        segments: [
          { season: 1, episodeStart: 10, episodeEnd: 5, targetEpisodeStart: 1, baseline: "tmdb" },
        ],
      },
    ]);
    expect(invalidSingle.valid).toBe(false);
    if (!invalidSingle.valid) {
      expect(invalidSingle.errors.map((e) => e.code)).toContain("EPISODE_END_BEFORE_START");
    }
  });
});
