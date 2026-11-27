import { describe, expect, test } from "vite-plus/test";
import {
  evaluateEvidenceGate,
  evaluateEvidenceGateStep1,
  evaluateEvidenceGateStep2,
  isNonOriginalVariantDescription,
  normalizeTitleForComparison,
  type CatalogEvidence,
  type CollectionInfo,
  type EvidenceGateStep2Evaluator,
} from "../src/index.ts";

function makeTvCatalog(overrides: Partial<CatalogEvidence> = {}): CatalogEvidence {
  return {
    namespace: "tmdb",
    canonicalId: "tv:95479",
    mediaType: "tv",
    title: "咒术回战",
    originalTitle: "呪術廻戦",
    aliases: ["Jujutsu Kaisen"],
    year: 2020,
    seasons: [
      { season: 0, episodeCount: 5, airYear: 2020 },
      { season: 1, episodeCount: 24, airYear: 2020 },
    ],
    externalIds: {
      tmdb: "tv:95479",
      imdb: "tt12343534",
      tvdb: "377543",
      trakt: "show:159384",
    },
    ...overrides,
  };
}

function makeBilibiliCollection(overrides: Partial<CollectionInfo> = {}): CollectionInfo {
  return {
    namespace: "bilibili",
    canonicalId: "ss34430",
    title: "咒术回战",
    originalTitle: "呪術廻戦",
    year: 2020,
    mediaType: "tv",
    featureEpisodeCount: 24,
    featureEpisodes: Array.from({ length: 24 }, (_, idx) => ({ index: idx + 1 })),
    ...overrides,
  };
}

describe("Evidence Gate Step 1", () => {
  test("passes immediately when platform and catalog share a consistent fetched external ID", () => {
    const catalog = makeTvCatalog();
    // Even if titles/years differ across locales, a verified shared ID from both sides passes Step 1
    const collection = makeBilibiliCollection({
      title: "Different Localized Title",
      originalTitle: null,
      year: 2021,
      featureEpisodeCount: 12,
      externalIds: {
        imdb: "tt12343534",
      },
    });

    const result = evaluateEvidenceGateStep1(catalog, collection);
    expect(result.decision).toBe("pass");
    expect(result.matchedBy).toBe("shared_id");
    expect(result.matchedSharedIds).toEqual([{ namespace: "imdb", value: "tt12343534" }]);
    expect(result.conflictingSharedIds).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  test("routes to needs_review when one shared ID matches but another shared ID conflicts", () => {
    const catalog = makeTvCatalog();
    const collection = makeBilibiliCollection({
      externalIds: {
        imdb: "tt12343534", // matches!
        tvdb: "999999", // conflicts with catalog's 377543!
      },
    });

    const result = evaluateEvidenceGateStep1(catalog, collection);
    expect(result.decision).toBe("needs_review");
    expect(result.matchedBy).toBeNull();
    expect(result.matchedSharedIds).toEqual([{ namespace: "imdb", value: "tt12343534" }]);
    expect(result.conflictingSharedIds).toEqual([
      {
        namespace: "tvdb",
        catalogValue: "377543",
        collectionValue: "999999",
      },
    ]);
    expect(result.conflicts.some((c) => c.code === "shared_id_conflict")).toBe(true);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  test("routes to needs_review when a single shared ID conflicts even if all 4 metadata fields match", () => {
    const catalog = makeTvCatalog();
    const collection = makeBilibiliCollection({
      externalIds: {
        imdb: "tt99999999",
      },
    });

    const result = evaluateEvidenceGateStep1(catalog, collection);
    expect(result.decision).toBe("needs_review");
    expect(result.conflicts.some((c) => c.code === "shared_id_conflict")).toBe(true);
  });

  test("passes when no shared IDs exist and all 4 fields match (TV and movie)", () => {
    // TV single season
    const tvResult = evaluateEvidenceGateStep1(makeTvCatalog(), makeBilibiliCollection());
    expect(tvResult.decision).toBe("pass");
    expect(tvResult.matchedBy).toBe("four_fields");
    expect(tvResult.fieldChecks).toEqual({
      mediaType: "matched",
      year: "matched",
      title: "matched",
      episodeCount: "matched",
    });

    // Multi-season TV matching Season 2 premiere year and Season 2 episode count
    const multiSeasonCatalog = makeTvCatalog({
      year: 2019,
      seasons: [
        { season: 1, episodeCount: 26, airYear: 2019 },
        { season: 2, episodeCount: 18, airYear: 2021 },
      ],
    });
    const season2Collection = makeBilibiliCollection({
      title: "咒术回战 第二季（中配）",
      year: 2021,
      featureEpisodeCount: 18,
    });
    expect(evaluateEvidenceGateStep1(multiSeasonCatalog, season2Collection).decision).toBe("pass");

    // Multi-season TV combined into a single platform collection (26 + 18 = 44 episodes)
    const combinedCollection = makeBilibiliCollection({
      year: 2019,
      featureEpisodeCount: 44,
    });
    expect(evaluateEvidenceGateStep1(multiSeasonCatalog, combinedCollection).decision).toBe("pass");

    // Movie matching with 1 feature episode
    const movieCatalog = makeTvCatalog({
      canonicalId: "movie:550",
      mediaType: "movie",
      title: "搏击俱乐部",
      originalTitle: "Fight Club",
      year: 1999,
      seasons: [],
      externalIds: { tmdb: "movie:550", imdb: "tt0137523" },
    });
    const movieCollection = makeBilibiliCollection({
      canonicalId: "ss28281",
      mediaType: "movie",
      title: "Fight Club!",
      originalTitle: null,
      year: 1999,
      featureEpisodeCount: 1,
      featureEpisodes: [{ index: 1 }],
    });
    expect(evaluateEvidenceGateStep1(movieCatalog, movieCollection).decision).toBe("pass");
  });

  test("handles title normalization across case, punctuation, whitespace, traditional/simplified, and edition qualifiers without false positives", () => {
    expect(normalizeTitleForComparison("Fight Club")).toBe(
      normalizeTitleForComparison("  fight: club! "),
    );
    expect(normalizeTitleForComparison("咒術迴戰")).toBe(normalizeTitleForComparison("咒术回战"));
    expect(normalizeTitleForComparison("呪術廻戦")).toBe(normalizeTitleForComparison("咒术回战"));

    // Traditional Chinese title matches Simplified Chinese catalog title
    const tradResult = evaluateEvidenceGateStep1(
      makeTvCatalog({ title: "咒术回战", originalTitle: null, aliases: [] }),
      makeBilibiliCollection({ title: "咒術迴戰", originalTitle: null, aliases: [] }),
    );
    expect(tradResult.decision).toBe("pass");

    // False positive checks: sequels, prequels, and distinct subtitles MUST NOT match
    const sequelResult = evaluateEvidenceGateStep1(
      makeTvCatalog({
        canonicalId: "movie:550",
        mediaType: "movie",
        title: "搏击俱乐部",
        originalTitle: null,
        aliases: [],
        year: 1999,
        seasons: [],
      }),
      makeBilibiliCollection({
        mediaType: "movie",
        title: "搏击俱乐部2",
        originalTitle: null,
        aliases: [],
        year: 1999,
        featureEpisodeCount: 1,
      }),
    );
    expect(sequelResult.decision).toBe("needs_review");
    expect(sequelResult.fieldChecks.title).toBe("mismatch");

    const distinctSubtitleResult = evaluateEvidenceGateStep1(
      makeTvCatalog({
        canonicalId: "movie:671",
        mediaType: "movie",
        title: "哈利·波特：魔法石",
        originalTitle: null,
        aliases: [],
        year: 2001,
        seasons: [],
      }),
      makeBilibiliCollection({
        mediaType: "movie",
        title: "哈利·波特：密室",
        originalTitle: null,
        aliases: [],
        year: 2001,
        featureEpisodeCount: 1,
      }),
    );
    expect(distinctSubtitleResult.decision).toBe("needs_review");
    expect(distinctSubtitleResult.fieldChecks.title).toBe("mismatch");
  });

  test("routes to needs_review when any of the 4 fields conflicts or is missing", () => {
    // 1. mediaType conflict
    const badType = evaluateEvidenceGateStep1(
      makeTvCatalog(),
      makeBilibiliCollection({ mediaType: "movie" }),
    );
    expect(badType.decision).toBe("needs_review");
    expect(badType.fieldChecks.mediaType).toBe("mismatch");
    expect(badType.conflicts.some((c) => c.code === "media_type_mismatch")).toBe(true);

    // 1b. mediaType missing
    const missingType = evaluateEvidenceGateStep1(
      makeTvCatalog(),
      makeBilibiliCollection({ mediaType: null }),
    );
    expect(missingType.decision).toBe("needs_review");
    expect(missingType.fieldChecks.mediaType).toBe("missing");

    // 2. year conflict
    const badYear = evaluateEvidenceGateStep1(
      makeTvCatalog(),
      makeBilibiliCollection({ year: 2022 }),
    );
    expect(badYear.decision).toBe("needs_review");
    expect(badYear.fieldChecks.year).toBe("mismatch");
    expect(badYear.conflicts.some((c) => c.code === "year_mismatch")).toBe(true);

    // 2b. year missing
    const missingYear = evaluateEvidenceGateStep1(
      makeTvCatalog(),
      makeBilibiliCollection({ year: null }),
    );
    expect(missingYear.decision).toBe("needs_review");
    expect(missingYear.fieldChecks.year).toBe("missing");

    // 3. title conflict
    const badTitle = evaluateEvidenceGateStep1(
      makeTvCatalog(),
      makeBilibiliCollection({ title: "完全不同的剧", originalTitle: null, aliases: [] }),
    );
    expect(badTitle.decision).toBe("needs_review");
    expect(badTitle.fieldChecks.title).toBe("mismatch");
    expect(badTitle.conflicts.some((c) => c.code === "title_mismatch")).toBe(true);

    // 4. episodeCount conflict
    const badEpisodes = evaluateEvidenceGateStep1(
      makeTvCatalog(),
      makeBilibiliCollection({ featureEpisodeCount: 12 }),
    );
    expect(badEpisodes.decision).toBe("needs_review");
    expect(badEpisodes.fieldChecks.episodeCount).toBe("mismatch");
    expect(badEpisodes.conflicts.some((c) => c.code === "episode_count_mismatch")).toBe(true);

    // 4b. episodeCount missing
    const missingEpisodes = evaluateEvidenceGateStep1(
      makeTvCatalog(),
      makeBilibiliCollection({ featureEpisodeCount: null }),
    );
    expect(missingEpisodes.decision).toBe("needs_review");
    expect(missingEpisodes.fieldChecks.episodeCount).toBe("missing");
  });

  test("ignores submitted IDs — only catalog-fetched and platform-fetched IDs count as evidence", () => {
    const catalog = makeTvCatalog();
    // Platform returned NO externalIds and a conflicting title — even if the submission targeted tmdb:tv:95479
    // or carried untrusted submitted metadata, Step 1 must NOT treat submitted target/fields as shared IDs.
    const collection = makeBilibiliCollection({
      title: "无关合集",
      originalTitle: null,
      aliases: [],
      externalIds: undefined,
    });

    const gate = evaluateEvidenceGate({
      catalog,
      collection,
      segments: [
        {
          season: 1,
          episodeStart: 1,
          episodeEnd: 24,
          targetEpisodeStart: 1,
          baseline: "tmdb",
          nonLinear: false,
          needsReview: false,
        },
      ],
    });
    expect(gate.decision).toBe("needs_review");
    expect(gate.step1.matchedSharedIds).toEqual([]);
    expect(gate.step1.fieldChecks.title).toBe("mismatch");
  });

  test("records Step 2 conflicts alongside Step 1 conflicts when Step 1 fails", () => {
    const gate = evaluateEvidenceGate({
      catalog: makeTvCatalog(),
      collection: makeBilibiliCollection({ title: "进击的巨人", originalTitle: null }),
      segments: [
        {
          season: 9,
          episodeStart: 1,
          episodeEnd: 24,
          targetEpisodeStart: 1,
          baseline: "tmdb",
          nonLinear: false,
          needsReview: false,
        },
      ],
    });
    expect(gate.decision).toBe("needs_review");
    expect(gate.step1.decision).toBe("needs_review");
    expect(gate.step2?.conflicts.map((c) => c.code)).toEqual(["segment_season_not_found"]);
    // Step 1 conflicts come first, so the primary conflict code is still Step 1's
    expect(gate.conflicts[0]?.step).toBe(1);
    expect(gate.conflicts.map((c) => c.step)).toContain(2);
    expect(gate.reasons).toHaveLength(gate.conflicts.length);
  });

  test("invokes pluggable Step 2 hook whether or not Step 1 passes", () => {
    let step2Called = 0;
    const step2Hook: EvidenceGateStep2Evaluator = (ctx) => {
      step2Called += 1;
      if (ctx.segments.length === 0) {
        return { decision: "pass", conflicts: [], reasons: [] };
      }
      return {
        decision: "needs_review",
        conflicts: [
          {
            step: 2,
            code: "segment_episode_count_mismatch",
            message: "Step 2 rejected segment count",
          },
        ],
        reasons: ["Step 2 rejected segment count"],
      };
    };

    // When Step 1 fails, Step 2 still runs and is recorded; the verdict stays needs_review
    const failedStep1 = evaluateEvidenceGate({
      catalog: makeTvCatalog(),
      collection: makeBilibiliCollection({ year: 1999 }),
      segments: [],
      evaluateStep2: step2Hook,
    });
    expect(failedStep1.decision).toBe("needs_review");
    expect(failedStep1.step2).toEqual({ decision: "pass", conflicts: [], reasons: [] });
    expect(step2Called).toBe(1);

    // When Step 1 passes, Step 2 runs and its decision determines final outcome
    const vetoedByStep2 = evaluateEvidenceGate({
      catalog: makeTvCatalog(),
      collection: makeBilibiliCollection(),
      segments: [
        {
          season: 1,
          episodeStart: 1,
          episodeEnd: 12,
          targetEpisodeStart: 1,
          baseline: "tmdb",
          nonLinear: false,
          needsReview: false,
        },
      ],
      evaluateStep2: step2Hook,
    });
    expect(step2Called).toBe(2);
    expect(vetoedByStep2.step1.decision).toBe("pass");
    expect(vetoedByStep2.step2?.decision).toBe("needs_review");
    expect(vetoedByStep2.decision).toBe("needs_review");
    expect(vetoedByStep2.conflicts.some((c) => c.step === 2)).toBe(true);
  });
});

describe("Evidence Gate Step 2", () => {
  test("skips Step 2 for movie media", () => {
    const movieCatalog = makeTvCatalog({
      canonicalId: "movie:550",
      mediaType: "movie",
      title: "搏击俱乐部",
      originalTitle: "Fight Club",
      year: 1999,
      seasons: [],
      externalIds: { tmdb: "movie:550", imdb: "tt0137523" },
    });
    const movieCollection = makeBilibiliCollection({
      canonicalId: "ss28281",
      mediaType: "movie",
      title: "搏击俱乐部",
      originalTitle: "Fight Club",
      year: 1999,
      featureEpisodeCount: 1,
      featureEpisodes: [{ index: 1 }],
    });

    const gate = evaluateEvidenceGate({
      catalog: movieCatalog,
      collection: movieCollection,
      segments: [],
      variantDescription: "原声",
    });

    expect(gate.decision).toBe("pass");
    expect(gate.step1.decision).toBe("pass");
    expect(gate.step2).toEqual({
      decision: "pass",
      skipped: true,
      conflicts: [],
      reasons: [],
    });

    // Direct Step 2 call on a movie skips segment verification even if segments were supplied
    const directStep2 = evaluateEvidenceGateStep2({
      catalog: movieCatalog,
      collection: movieCollection,
      segments: [
        {
          season: 1,
          episodeStart: 1,
          episodeEnd: 12,
          targetEpisodeStart: 2,
          baseline: "tmdb",
          nonLinear: false,
          needsReview: false,
        },
      ],
      step1: gate.step1,
    });
    expect(directStep2.decision).toBe("pass");
    expect(directStep2.skipped).toBe(true);
  });

  test("runs default Step 2 automatically in evaluateEvidenceGate and checks season year, targetEpisodeStart, and episode count", () => {
    const catalog = makeTvCatalog({
      year: 2020,
      seasons: [
        { season: 1, episodeCount: 24, airYear: 2020 },
        { season: 2, episodeCount: 23, airYear: 2023 },
      ],
    });

    // Matching S1 1..24 target 1 -> auto-passes Step 1 & Step 2
    const valid = evaluateEvidenceGate({
      catalog,
      collection: makeBilibiliCollection({ year: 2020, featureEpisodeCount: 24 }),
      segments: [
        {
          season: 1,
          episodeStart: 1,
          episodeEnd: 24,
          targetEpisodeStart: 1,
          baseline: "tmdb",
          nonLinear: false,
          needsReview: false,
        },
      ],
      variantDescription: "原声",
    });
    expect(valid.decision).toBe("pass");
    expect(valid.step2?.decision).toBe("pass");
    expect(valid.step2?.skipped).toBe(false);

    // Wrong season: S2 collection (2023, 23 eps) erroneously submitted as S1 (2020)
    const wrongSeason = evaluateEvidenceGate({
      catalog,
      collection: makeBilibiliCollection({ year: 2023, featureEpisodeCount: 23 }),
      segments: [
        {
          season: 1,
          episodeStart: 1,
          episodeEnd: 23,
          targetEpisodeStart: 1,
          baseline: "tmdb",
          nonLinear: false,
          needsReview: false,
        },
      ],
    });
    expect(wrongSeason.decision).toBe("needs_review");
    expect(wrongSeason.step1.decision).toBe("pass");
    expect(wrongSeason.step2?.decision).toBe("needs_review");
    expect(wrongSeason.step2?.conflicts.some((c) => c.code === "segment_year_mismatch")).toBe(true);

    // Non-existent season (Season 9)
    const missingSeason = evaluateEvidenceGate({
      catalog,
      collection: makeBilibiliCollection({ year: 2020, featureEpisodeCount: 24 }),
      segments: [
        {
          season: 9,
          episodeStart: 1,
          episodeEnd: 24,
          targetEpisodeStart: 1,
          baseline: "tmdb",
          nonLinear: false,
          needsReview: false,
        },
      ],
    });
    expect(missingSeason.decision).toBe("needs_review");
    expect(missingSeason.step2?.conflicts.some((c) => c.code === "segment_season_not_found")).toBe(
      true,
    );

    // Wrong targetEpisodeStart: 2 instead of 1 on a 24-ep collection
    const wrongTargetStart = evaluateEvidenceGate({
      catalog,
      collection: makeBilibiliCollection({ year: 2020, featureEpisodeCount: 24 }),
      segments: [
        {
          season: 1,
          episodeStart: 1,
          episodeEnd: 24,
          targetEpisodeStart: 2,
          baseline: "tmdb",
          nonLinear: false,
          needsReview: false,
        },
      ],
    });
    expect(wrongTargetStart.decision).toBe("needs_review");
    expect(wrongTargetStart.step1.decision).toBe("pass");
    expect(
      wrongTargetStart.step2?.conflicts.some((c) => c.code === "target_episode_start_mismatch"),
    ).toBe(true);

    // Wrong episode count: segment covers 12 eps on a 24-ep collection
    const wrongCount = evaluateEvidenceGate({
      catalog,
      collection: makeBilibiliCollection({ year: 2020, featureEpisodeCount: 24 }),
      segments: [
        {
          season: 1,
          episodeStart: 1,
          episodeEnd: 12,
          targetEpisodeStart: 1,
          baseline: "tmdb",
          nonLinear: false,
          needsReview: false,
        },
      ],
    });
    expect(wrongCount.decision).toBe("needs_review");
    expect(wrongCount.step1.decision).toBe("pass");
    expect(
      wrongCount.step2?.conflicts.some((c) => c.code === "segment_episode_count_mismatch"),
    ).toBe(true);

    // Segment episodeEnd exceeds catalog season episodeCount (shared ID passes Step 1)
    const outOfRange = evaluateEvidenceGate({
      catalog,
      collection: makeBilibiliCollection({
        year: 2020,
        featureEpisodeCount: 30,
        externalIds: { imdb: "tt12343534" },
      }),
      segments: [
        {
          season: 1,
          episodeStart: 1,
          episodeEnd: 30,
          targetEpisodeStart: 1,
          baseline: "tmdb",
          nonLinear: false,
          needsReview: false,
        },
      ],
    });
    expect(outOfRange.decision).toBe("needs_review");
    expect(outOfRange.step2?.conflicts.some((c) => c.code === "segment_episode_out_of_range")).toBe(
      true,
    );
  });

  test("harmonizes Step 1 and Step 2 for split seasons (e.g. S1 47 eps split into 1..24 and 25..47)", () => {
    const jjkSplitCatalog = makeTvCatalog({
      year: 2020,
      seasons: [{ season: 1, episodeCount: 47, airYear: 2020 }],
    });

    const part1 = evaluateEvidenceGate({
      catalog: jjkSplitCatalog,
      collection: makeBilibiliCollection({
        canonicalId: "ss34430",
        year: 2020,
        featureEpisodeCount: 24,
      }),
      segments: [
        {
          season: 1,
          episodeStart: 1,
          episodeEnd: 24,
          targetEpisodeStart: 1,
          baseline: "tmdb",
          nonLinear: false,
          needsReview: false,
        },
      ],
      variantDescription: "原声",
    });
    expect(part1.step1.decision).toBe("pass");
    expect(part1.step2?.decision).toBe("pass");
    expect(part1.decision).toBe("pass");

    const part2 = evaluateEvidenceGate({
      catalog: jjkSplitCatalog,
      collection: makeBilibiliCollection({
        canonicalId: "ss45574",
        year: 2020,
        featureEpisodeCount: 23,
      }),
      segments: [
        {
          season: 1,
          episodeStart: 25,
          episodeEnd: 47,
          targetEpisodeStart: 1,
          baseline: "tmdb",
          nonLinear: false,
          needsReview: false,
        },
      ],
      variantDescription: "原声",
    });
    expect(part2.step1.decision).toBe("pass");
    expect(part2.step2?.decision).toBe("pass");
    expect(part2.decision).toBe("pass");

    // Common mistake: setting targetEpisodeStart to 25 instead of 1 on the second split collection
    const wrongSplitTargetStart = evaluateEvidenceGate({
      catalog: jjkSplitCatalog,
      collection: makeBilibiliCollection({
        canonicalId: "ss45574",
        year: 2020,
        featureEpisodeCount: 23,
      }),
      segments: [
        {
          season: 1,
          episodeStart: 25,
          episodeEnd: 47,
          targetEpisodeStart: 25,
          baseline: "tmdb",
          nonLinear: false,
          needsReview: false,
        },
      ],
    });
    expect(wrongSplitTargetStart.step1.decision).toBe("pass");
    expect(wrongSplitTargetStart.decision).toBe("needs_review");
    expect(
      wrongSplitTargetStart.step2?.conflicts.some(
        (c) => c.code === "target_episode_start_mismatch",
      ),
    ).toBe(true);
  });

  test("verifies multi-season merged collections by summed episode count, earliest season year, and contiguous target offsets", () => {
    const multiSeasonCatalog = makeTvCatalog({
      year: 2022,
      seasons: [
        { season: 1, episodeCount: 12, airYear: 2022 },
        { season: 2, episodeCount: 12, airYear: 2024 },
      ],
    });

    const mergedCollection = makeBilibiliCollection({
      year: 2022,
      featureEpisodeCount: 24,
    });

    // Valid multi-season merged collection
    const validMerged = evaluateEvidenceGate({
      catalog: multiSeasonCatalog,
      collection: mergedCollection,
      segments: [
        {
          season: 1,
          episodeStart: 1,
          episodeEnd: 12,
          targetEpisodeStart: 1,
          baseline: "tmdb",
          nonLinear: false,
          needsReview: false,
        },
        {
          season: 2,
          episodeStart: 1,
          episodeEnd: 12,
          targetEpisodeStart: 13,
          baseline: "tmdb",
          nonLinear: false,
          needsReview: false,
        },
      ],
    });
    expect(validMerged.decision).toBe("pass");

    // Reversed input array order still passes when chronological target mapping is contiguous
    const reversedOrder = evaluateEvidenceGate({
      catalog: multiSeasonCatalog,
      collection: mergedCollection,
      segments: [
        {
          season: 2,
          episodeStart: 1,
          episodeEnd: 12,
          targetEpisodeStart: 13,
          baseline: "tmdb",
          nonLinear: false,
          needsReview: false,
        },
        {
          season: 1,
          episodeStart: 1,
          episodeEnd: 12,
          targetEpisodeStart: 1,
          baseline: "tmdb",
          nonLinear: false,
          needsReview: false,
        },
      ],
    });
    expect(reversedOrder.decision).toBe("pass");

    // Wrong year: collection year matches S2 (2024) instead of earliest season S1 (2022)
    const wrongYearMerged = evaluateEvidenceGate({
      catalog: multiSeasonCatalog,
      collection: makeBilibiliCollection({ year: 2024, featureEpisodeCount: 24 }),
      segments: [
        {
          season: 1,
          episodeStart: 1,
          episodeEnd: 12,
          targetEpisodeStart: 1,
          baseline: "tmdb",
          nonLinear: false,
          needsReview: false,
        },
        {
          season: 2,
          episodeStart: 1,
          episodeEnd: 12,
          targetEpisodeStart: 13,
          baseline: "tmdb",
          nonLinear: false,
          needsReview: false,
        },
      ],
    });
    expect(wrongYearMerged.decision).toBe("needs_review");
    expect(wrongYearMerged.step2?.conflicts.some((c) => c.code === "segment_year_mismatch")).toBe(
      true,
    );

    // Wrong second segment targetEpisodeStart (overlapping target slot 12 instead of 13)
    const overlappingTarget = evaluateEvidenceGate({
      catalog: multiSeasonCatalog,
      collection: mergedCollection,
      segments: [
        {
          season: 1,
          episodeStart: 1,
          episodeEnd: 12,
          targetEpisodeStart: 1,
          baseline: "tmdb",
          nonLinear: false,
          needsReview: false,
        },
        {
          season: 2,
          episodeStart: 1,
          episodeEnd: 12,
          targetEpisodeStart: 12,
          baseline: "tmdb",
          nonLinear: false,
          needsReview: false,
        },
      ],
    });
    expect(overlappingTarget.decision).toBe("needs_review");
    expect(
      overlappingTarget.step2?.conflicts.some((c) => c.code === "target_episode_start_mismatch"),
    ).toBe(true);

    // Swapped target starts (S1 mapped to 13, S2 mapped to 1)
    const swappedTargets = evaluateEvidenceGate({
      catalog: multiSeasonCatalog,
      collection: mergedCollection,
      segments: [
        {
          season: 1,
          episodeStart: 1,
          episodeEnd: 12,
          targetEpisodeStart: 13,
          baseline: "tmdb",
          nonLinear: false,
          needsReview: false,
        },
        {
          season: 2,
          episodeStart: 1,
          episodeEnd: 12,
          targetEpisodeStart: 1,
          baseline: "tmdb",
          nonLinear: false,
          needsReview: false,
        },
      ],
    });
    expect(swappedTargets.decision).toBe("needs_review");
    expect(
      swappedTargets.step2?.conflicts.some((c) => c.code === "target_episode_start_mismatch"),
    ).toBe(true);

    // Summed episode count mismatch (segments cover 12 + 6 = 18 eps, collection has 24 eps)
    const wrongMergedSum = evaluateEvidenceGate({
      catalog: multiSeasonCatalog,
      collection: mergedCollection,
      segments: [
        {
          season: 1,
          episodeStart: 1,
          episodeEnd: 12,
          targetEpisodeStart: 1,
          baseline: "tmdb",
          nonLinear: false,
          needsReview: false,
        },
        {
          season: 2,
          episodeStart: 1,
          episodeEnd: 6,
          targetEpisodeStart: 13,
          baseline: "tmdb",
          nonLinear: false,
          needsReview: false,
        },
      ],
    });
    expect(wrongMergedSum.decision).toBe("needs_review");
    expect(
      wrongMergedSum.step2?.conflicts.some((c) => c.code === "segment_episode_count_mismatch"),
    ).toBe(true);
  });

  test("checks each season's linear prefix against its own platform positions", () => {
    const broadcasts = Array.from({ length: 20 }, (_, i) => `第${i + 1}期`);
    const episodes = (titles: string[]) =>
      titles.map((title, i) => ({ episode: i + 1, title, airDate: null }));
    const catalog = makeTvCatalog({
      seasons: [
        { season: 1, episodeCount: 13, airYear: 2020 },
        { season: 2, episodeCount: 47, airYear: 2021 },
      ],
      seasonEpisodes: {
        1: episodes(broadcasts.slice(0, 13)),
        2: episodes([...broadcasts.slice(0, 19), ...Array<string>(27).fill("特辑"), "第20期"]),
      },
    });
    const first = {
      season: 1,
      episodeStart: 1,
      episodeEnd: 12,
      targetEpisodeStart: 1,
      baseline: "tmdb" as const,
      nonLinear: false,
      needsReview: false,
    };
    const check = (titles: string[]) =>
      evaluateEvidenceGate({
        catalog,
        collection: makeBilibiliCollection({
          featureEpisodeCount: titles.length,
          featureEpisodes: titles.map((title, i) => ({ index: i + 1, title })),
        }),
        segments: [first, { ...first, season: 2, episodeEnd: 20, targetEpisodeStart: 13 }],
      });

    expect(check([...broadcasts.slice(0, 12), ...broadcasts]).conflicts).toMatchObject([
      {
        code: "partial_segment_spans_full_season",
        message: expect.stringContaining("season 2 episode 47"),
      },
    ]);
    // S1's finale is only in S2's window, and S2's finale is only in S1's window.
    expect(
      check([...broadcasts.slice(0, 11), "第20期", ...broadcasts.slice(0, 19), "20"]).decision,
    ).toBe("pass");
  });

  test("handles open-ended ongoing seasons (episodeEnd: null) in both Step 1 and Step 2", () => {
    const ongoingCatalog = makeTvCatalog({
      year: 2026,
      seasons: [
        { season: 1, episodeCount: 24, airYear: 2026 },
        { season: 2, episodeCount: 12, airYear: 2027 },
      ],
    });

    // Ongoing S1 with 10 aired episodes <= 24 -> auto-passes Step 1 & Step 2
    const ongoingPass = evaluateEvidenceGate({
      catalog: ongoingCatalog,
      collection: makeBilibiliCollection({ year: 2026, featureEpisodeCount: 10 }),
      segments: [
        {
          season: 1,
          episodeStart: 1,
          episodeEnd: null,
          targetEpisodeStart: 1,
          baseline: "tmdb",
          nonLinear: false,
          needsReview: false,
        },
      ],
    });
    expect(ongoingPass.step1.decision).toBe("pass");
    expect(ongoingPass.step2?.decision).toBe("pass");
    expect(ongoingPass.decision).toBe("pass");

    // Split ongoing S1 (episodeStart 15..null -> max remaining 10 eps) with 8 eps -> pass
    const splitOngoingPass = evaluateEvidenceGate({
      catalog: ongoingCatalog,
      collection: makeBilibiliCollection({ year: 2026, featureEpisodeCount: 8 }),
      segments: [
        {
          season: 1,
          episodeStart: 15,
          episodeEnd: null,
          targetEpisodeStart: 1,
          baseline: "tmdb",
          nonLinear: false,
          needsReview: false,
        },
      ],
    });
    expect(splitOngoingPass.decision).toBe("pass");

    // Split ongoing exceeding remaining episodes (11 > 10) -> needs_review
    const splitOngoingTooMany = evaluateEvidenceGate({
      catalog: ongoingCatalog,
      collection: makeBilibiliCollection({ year: 2026, featureEpisodeCount: 11 }),
      segments: [
        {
          season: 1,
          episodeStart: 15,
          episodeEnd: null,
          targetEpisodeStart: 1,
          baseline: "tmdb",
          nonLinear: false,
          needsReview: false,
        },
      ],
    });
    expect(splitOngoingTooMany.decision).toBe("needs_review");

    // Ongoing season exceeding total season episodeCount (25 > 24) -> needs_review
    const ongoingExceeds = evaluateEvidenceGate({
      catalog: ongoingCatalog,
      collection: makeBilibiliCollection({
        year: 2026,
        featureEpisodeCount: 25,
        externalIds: { imdb: "tt12343534" },
      }),
      segments: [
        {
          season: 1,
          episodeStart: 1,
          episodeEnd: null,
          targetEpisodeStart: 1,
          baseline: "tmdb",
          nonLinear: false,
          needsReview: false,
        },
      ],
    });
    expect(ongoingExceeds.decision).toBe("needs_review");
    expect(
      ongoingExceeds.step2?.conflicts.some((c) => c.code === "segment_episode_count_mismatch"),
    ).toBe(true);

    // Ongoing season with wrong targetEpisodeStart (2 instead of 1) -> needs_review
    const ongoingBadTarget = evaluateEvidenceGate({
      catalog: ongoingCatalog,
      collection: makeBilibiliCollection({ year: 2026, featureEpisodeCount: 10 }),
      segments: [
        {
          season: 1,
          episodeStart: 1,
          episodeEnd: null,
          targetEpisodeStart: 2,
          baseline: "tmdb",
          nonLinear: false,
          needsReview: false,
        },
      ],
    });
    expect(ongoingBadTarget.decision).toBe("needs_review");
    expect(
      ongoingBadTarget.step2?.conflicts.some((c) => c.code === "target_episode_start_mismatch"),
    ).toBe(true);

    // Multi-season collection where S2 is ongoing (S1 24 eps + S2 5 aired = 29 eps, max 36)
    const multiOngoingPass = evaluateEvidenceGate({
      catalog: ongoingCatalog,
      collection: makeBilibiliCollection({ year: 2026, featureEpisodeCount: 29 }),
      segments: [
        {
          season: 1,
          episodeStart: 1,
          episodeEnd: 24,
          targetEpisodeStart: 1,
          baseline: "tmdb",
          nonLinear: false,
          needsReview: false,
        },
        {
          season: 2,
          episodeStart: 1,
          episodeEnd: null,
          targetEpisodeStart: 25,
          baseline: "tmdb",
          nonLinear: false,
          needsReview: false,
        },
      ],
    });
    expect(multiOngoingPass.decision).toBe("pass");
  });

  test("nonLinear season coverage requires fetched feature episodes, the correct year and a verified finale", () => {
    const varietyCatalog = makeTvCatalog({
      seasonEpisodes: {
        1: Array.from({ length: 12 }, (_, i) => ({
          episode: i + 1,
          title: i === 11 ? "雪地收官狂欢夜" : `第${i + 1}集`,
          airDate: null,
        })),
      },
      year: 2023,
      seasons: [
        { season: 1, episodeCount: 12, airYear: 2023 },
        { season: 2, episodeCount: 12, airYear: 2024 },
      ],
    });

    // Mismatched episode count (30 vs 12) + matching season year (2023) -> passes Step 1 & Step 2
    const nonLinearPass = evaluateEvidenceGate({
      catalog: varietyCatalog,
      collection: makeBilibiliCollection({
        year: 2023,
        featureEpisodeCount: 30,
        featureEpisodes: [
          { index: 1, title: "第1集" },
          { index: 2, title: "雪地收官狂欢夜" },
        ],
      }),
      segments: [
        {
          season: 1,
          episodeStart: 1,
          episodeEnd: null,
          targetEpisodeStart: 1,
          baseline: "tmdb",
          nonLinear: true,
          needsReview: false,
        },
      ],
    });
    expect(nonLinearPass.step1.decision).toBe("pass");
    expect(nonLinearPass.step1.fieldChecks.episodeCount).toBe("skipped");
    expect(nonLinearPass.step2?.decision).toBe("pass");
    expect(nonLinearPass.decision).toBe("pass");

    for (const [features, code] of [
      [[], "segment_episode_count_missing"],
      [[{ index: 1, title: "第1集" }], "season_finale_unverified"],
    ] as const) {
      const gate = evaluateEvidenceGate({
        catalog: varietyCatalog,
        collection: makeBilibiliCollection({ year: 2023, featureEpisodes: features }),
        segments: [
          {
            season: 1,
            episodeStart: 1,
            episodeEnd: null,
            targetEpisodeStart: 1,
            baseline: "tmdb",
            nonLinear: true,
            needsReview: false,
          },
        ],
      });
      expect(gate.conflicts.map((c) => c.code)).toContain(code);
    }

    // Non-linear segment with wrong season year (S1 2023 against 2024 collection) -> needs_review
    const nonLinearWrongYear = evaluateEvidenceGate({
      catalog: varietyCatalog,
      collection: makeBilibiliCollection({ year: 2024, featureEpisodeCount: 30 }),
      segments: [
        {
          season: 1,
          episodeStart: 1,
          episodeEnd: null,
          targetEpisodeStart: 1,
          baseline: "tmdb",
          nonLinear: true,
          needsReview: false,
        },
      ],
    });
    expect(nonLinearWrongYear.step1.decision).toBe("pass");
    expect(nonLinearWrongYear.decision).toBe("needs_review");
    expect(
      nonLinearWrongYear.step2?.conflicts.some((c) => c.code === "segment_year_mismatch"),
    ).toBe(true);

    // Non-linear segment whose episodeStart exceeds season episodeCount -> needs_review
    const nonLinearOutOfRange = evaluateEvidenceGate({
      catalog: varietyCatalog,
      collection: makeBilibiliCollection({ year: 2023, featureEpisodeCount: 30 }),
      segments: [
        {
          season: 1,
          episodeStart: 13,
          episodeEnd: null,
          targetEpisodeStart: 1,
          baseline: "tmdb",
          nonLinear: true,
          needsReview: false,
        },
      ],
    });
    expect(nonLinearOutOfRange.decision).toBe("needs_review");
    expect(
      nonLinearOutOfRange.step2?.conflicts.some((c) => c.code === "segment_episode_out_of_range"),
    ).toBe(true);
  });

  test.each([
    { episodeEnd: 12, targetEpisodeStart: 1, featureEpisodeCount: 12, conflicts: [] },
    {
      episodeEnd: 12,
      targetEpisodeStart: 2,
      featureEpisodeCount: 12,
      // The S0 finale at position 12 falls inside S1's window.
      conflicts: ["season_finale_unverified", "target_episode_start_mismatch"],
    },
    {
      episodeEnd: 25,
      targetEpisodeStart: 1,
      featureEpisodeCount: 24,
      conflicts: ["segment_episode_out_of_range"],
    },
    {
      episodeEnd: 12,
      targetEpisodeStart: 1,
      featureEpisodeCount: 13,
      conflicts: ["episode_count_mismatch", "segment_episode_count_mismatch"],
    },
  ])(
    "checks a mixed submission's linear span 1..$episodeEnd at position $targetEpisodeStart against $featureEpisodeCount episodes",
    ({ episodeEnd, targetEpisodeStart, featureEpisodeCount, conflicts }) => {
      const gate = evaluateEvidenceGate({
        catalog: makeTvCatalog({
          seasonEpisodes: {
            0: Array.from({ length: 5 }, (_, i) => ({
              episode: i + 1,
              title: i === 4 ? "特别来宾见面会" : `第${i + 1}集`,
              airDate: null,
            })),
          },
        }),
        collection: makeBilibiliCollection({
          featureEpisodeCount,
          featureEpisodes: Array.from({ length: featureEpisodeCount }, (_, i) => ({
            index: i + 1,
            title: i + 1 === featureEpisodeCount ? "特别来宾见面会" : `第${i + 1}集`,
          })),
        }),
        segments: [
          {
            season: 0,
            episodeStart: 1,
            episodeEnd: null,
            targetEpisodeStart: 1,
            baseline: "tmdb",
            nonLinear: true,
            needsReview: false,
          },
          {
            season: 1,
            episodeStart: 1,
            episodeEnd,
            targetEpisodeStart,
            baseline: "tmdb",
            nonLinear: false,
            needsReview: false,
          },
        ],
      });
      expect(gate.decision).toBe(conflicts.length ? "needs_review" : "pass");
      expect(gate.conflicts.map((c) => c.code)).toEqual(conflicts);
    },
  );

  test("handles whole-media TV associations, Season 0 specials, and missing Step 2 metadata", () => {
    const catalog = makeTvCatalog({
      year: 2020,
      seasons: [
        { season: 0, episodeCount: 5, airYear: 2021 },
        { season: 1, episodeCount: 24, airYear: 2020 },
        { season: 2, episodeCount: 23, airYear: 2023 },
      ],
    });

    // Whole-media TV with matching premiere year -> pass
    const wholeMediaPass = evaluateEvidenceGate({
      catalog,
      collection: makeBilibiliCollection({ year: 2020, featureEpisodeCount: 47 }),
      segments: [],
    });
    expect(wholeMediaPass.decision).toBe("pass");

    // Whole-media TV with S2 year (2023) instead of media premiere year (2020) -> needs_review
    const wholeMediaWrongYear = evaluateEvidenceGate({
      catalog,
      collection: makeBilibiliCollection({ year: 2023, featureEpisodeCount: 23 }),
      segments: [],
    });
    expect(wholeMediaWrongYear.decision).toBe("needs_review");
    expect(
      wholeMediaWrongYear.step2?.conflicts.some((c) => c.code === "segment_year_mismatch"),
    ).toBe(true);

    // Season 0 specials segment matches S0 airYear (2021) and episodeCount (5) -> pass
    const specialsPass = evaluateEvidenceGate({
      catalog,
      collection: makeBilibiliCollection({ year: 2021, featureEpisodeCount: 5 }),
      segments: [
        {
          season: 0,
          episodeStart: 1,
          episodeEnd: 5,
          targetEpisodeStart: 1,
          baseline: "tmdb",
          nonLinear: false,
          needsReview: false,
        },
      ],
    });
    expect(specialsPass.decision).toBe("pass");

    // Missing catalog season airYear -> needs_review (segment_year_missing)
    const missingAirYear = evaluateEvidenceGate({
      catalog: makeTvCatalog({
        year: 2020,
        seasons: [{ season: 1, episodeCount: 24, airYear: null }],
      }),
      collection: makeBilibiliCollection({ year: 2020, featureEpisodeCount: 24 }),
      segments: [
        {
          season: 1,
          episodeStart: 1,
          episodeEnd: 24,
          targetEpisodeStart: 1,
          baseline: "tmdb",
          nonLinear: false,
          needsReview: false,
        },
      ],
    });
    expect(missingAirYear.decision).toBe("needs_review");
    expect(missingAirYear.step2?.conflicts.some((c) => c.code === "segment_year_missing")).toBe(
      true,
    );

    // Missing collection.featureEpisodeCount for linear segments (shared ID passes Step 1) -> needs_review
    const missingFeatureCount = evaluateEvidenceGate({
      catalog,
      collection: makeBilibiliCollection({
        year: 2020,
        featureEpisodeCount: null,
        featureEpisodes: [],
        externalIds: { imdb: "tt12343534" },
      }),
      segments: [
        {
          season: 1,
          episodeStart: 1,
          episodeEnd: 24,
          targetEpisodeStart: 1,
          baseline: "tmdb",
          nonLinear: false,
          needsReview: false,
        },
      ],
    });
    expect(missingFeatureCount.decision).toBe("needs_review");
    expect(
      missingFeatureCount.step2?.conflicts.some((c) => c.code === "segment_episode_count_missing"),
    ).toBe(true);
  });

  test("routes non-original variants marked as setDefaultVariant=true to needs_review while allowing original, neutral, or non-default variants", () => {
    // Non-original descriptions (dubs, alternate cuts, simplified & traditional Chinese, English)
    for (const label of [
      "中配",
      "国配",
      "國配",
      "配音",
      "配音版",
      "粤语",
      "粵語版",
      "台配",
      "臺配",
      "英语配音",
      "日配",
      "国语版",
      "dub",
      "English Dub",
      "dubbed",
      "Director's Cut",
      "导演剪辑版",
      "導演剪輯版",
      "删减版",
      "精编版",
      "解说版",
      "原声导演剪辑版",
    ]) {
      expect(isNonOriginalVariantDescription(label), `expected non-original: ${label}`).toBe(true);
    }

    // Original or neutral descriptions
    for (const label of [
      "原声",
      "原声版",
      "原版",
      "日语原声",
      "粤语原声",
      "国语原声",
      "original",
      "Original Audio",
      "sub",
      "中字",
      "标准版",
      "正片",
      "",
      null,
      undefined,
    ]) {
      expect(isNonOriginalVariantDescription(label), `expected original/neutral: ${label}`).toBe(
        false,
      );
    }

    // TV submission marking "中配" as default -> needs_review (non_original_default_variant)
    const dubDefaultTv = evaluateEvidenceGate({
      catalog: makeTvCatalog(),
      collection: makeBilibiliCollection(),
      segments: [
        {
          season: 1,
          episodeStart: 1,
          episodeEnd: 24,
          targetEpisodeStart: 1,
          baseline: "tmdb",
          nonLinear: false,
          needsReview: false,
        },
      ],
      variantDescription: "中配",
      setDefaultVariant: true,
    });
    expect(dubDefaultTv.step1.decision).toBe("pass");
    expect(dubDefaultTv.decision).toBe("needs_review");
    expect(
      dubDefaultTv.step2?.conflicts.some((c) => c.code === "non_original_default_variant"),
    ).toBe(true);

    // Movie submission marking "中配" as default -> ALSO needs_review (non_original_default_variant)
    const dubDefaultMovie = evaluateEvidenceGate({
      catalog: makeTvCatalog({
        canonicalId: "movie:550",
        mediaType: "movie",
        title: "搏击俱乐部",
        originalTitle: "Fight Club",
        year: 1999,
        seasons: [],
      }),
      collection: makeBilibiliCollection({
        canonicalId: "ss28281",
        mediaType: "movie",
        title: "搏击俱乐部",
        originalTitle: "Fight Club",
        year: 1999,
        featureEpisodeCount: 1,
        featureEpisodes: [{ index: 1 }],
      }),
      segments: [],
      variantDescription: "中配",
      setDefaultVariant: true,
    });
    expect(dubDefaultMovie.decision).toBe("needs_review");
    expect(
      dubDefaultMovie.step2?.conflicts.some((c) => c.code === "non_original_default_variant"),
    ).toBe(true);

    // Non-original variant NOT marked as default (setDefaultVariant: false) -> passes
    const dubNonDefault = evaluateEvidenceGate({
      catalog: makeTvCatalog(),
      collection: makeBilibiliCollection(),
      segments: [
        {
          season: 1,
          episodeStart: 1,
          episodeEnd: 24,
          targetEpisodeStart: 1,
          baseline: "tmdb",
          nonLinear: false,
          needsReview: false,
        },
      ],
      variantDescription: "中配",
      setDefaultVariant: false,
    });
    expect(dubNonDefault.decision).toBe("pass");

    // Original variant marked as default -> passes
    const originalDefault = evaluateEvidenceGate({
      catalog: makeTvCatalog(),
      collection: makeBilibiliCollection(),
      segments: [
        {
          season: 1,
          episodeStart: 1,
          episodeEnd: 24,
          targetEpisodeStart: 1,
          baseline: "tmdb",
          nonLinear: false,
          needsReview: false,
        },
      ],
      variantDescription: "原声",
      setDefaultVariant: true,
    });
    expect(originalDefault.decision).toBe("pass");

    // Neutral variant marked as default -> passes
    const neutralDefault = evaluateEvidenceGate({
      catalog: makeTvCatalog(),
      collection: makeBilibiliCollection(),
      segments: [
        {
          season: 1,
          episodeStart: 1,
          episodeEnd: 24,
          targetEpisodeStart: 1,
          baseline: "tmdb",
          nonLinear: false,
          needsReview: false,
        },
      ],
      variantDescription: "标准版",
      setDefaultVariant: true,
    });
    expect(neutralDefault.decision).toBe("pass");
  });
});

describe("Evidence Gate rules from the needs_review queue", () => {
  test("诛仙 最终季 matches catalog title 诛仙", () => {
    const result = evaluateEvidenceGateStep1(
      makeTvCatalog({ title: "诛仙", originalTitle: null, aliases: [] }),
      makeBilibiliCollection({ namespace: "tencent", title: "诛仙 最终季", originalTitle: null }),
    );
    expect(result.fieldChecks.title).toBe("matched");
  });

  test("妻子的浪漫旅行2026 matches catalog title 妻子的浪漫旅行, but a trailing single digit still does not", () => {
    const catalog = makeTvCatalog({ title: "妻子的浪漫旅行", originalTitle: null, aliases: [] });
    const withYear = evaluateEvidenceGateStep1(
      catalog,
      makeBilibiliCollection({
        namespace: "mgtv",
        title: "妻子的浪漫旅行2026",
        originalTitle: null,
        year: 2026,
      }),
    );
    expect(withYear.fieldChecks.title).toBe("matched");

    const sequel = evaluateEvidenceGateStep1(
      catalog,
      makeBilibiliCollection({ namespace: "mgtv", title: "妻子的浪漫旅行2", originalTitle: null }),
    );
    expect(sequel.fieldChecks.title).toBe("mismatch");
  });

  test("银翼杀手2049 does not match 银翼杀手: a trailing number that is not the release year is part of the title", () => {
    const original = { title: "银翼杀手", originalTitle: null, aliases: [] };
    const sequel = { title: "银翼杀手2049", originalTitle: null, aliases: [] };
    const result = evaluateEvidenceGateStep1(
      makeTvCatalog({ ...original, year: 1982 }),
      makeBilibiliCollection({ ...sequel, year: 2017 }),
    );
    expect(result.fieldChecks.title).toBe("mismatch");

    const reversed = evaluateEvidenceGateStep1(
      makeTvCatalog({ ...sequel, year: 2017 }),
      makeBilibiliCollection({ ...original, year: 1982 }),
    );
    expect(reversed.fieldChecks.title).toBe("mismatch");
  });

  test("咒术回战 第二季 (TMDB S1 E25–47) compares the collection year with those episodes' air year", () => {
    // TMDB keeps 59 episodes in one season: E1–24 2020, E25–47 2023, E48–59 2026
    const episodeAirYears: Record<number, number> = {};
    for (let ep = 1; ep <= 59; ep += 1) {
      episodeAirYears[ep] = ep <= 24 ? 2020 : ep <= 47 ? 2023 : 2026;
    }
    const catalog = makeTvCatalog({
      year: 2020,
      seasons: [{ season: 1, episodeCount: 59, airYear: 2020 }],
      episodeAirYears: { 1: episodeAirYears },
    });
    const segments = [
      {
        season: 1,
        episodeStart: 25,
        episodeEnd: 47,
        targetEpisodeStart: 1,
        baseline: "tmdb" as const,
        nonLinear: false,
        needsReview: false,
      },
    ];
    const season2 = makeBilibiliCollection({
      canonicalId: "ss45574",
      title: "咒术回战 第二季",
      year: 2023,
      featureEpisodeCount: 23,
    });

    const result = evaluateEvidenceGate({ catalog, collection: season2, segments });
    expect(result.step1.fieldChecks.year).toBe("matched");
    expect(result.step2?.decision).toBe("pass");
    expect(result.decision).toBe("pass");

    // The same episodes listed under the season premiere year are now the wrong year
    const wrongYear = evaluateEvidenceGate({
      catalog,
      collection: { ...season2, year: 2020 },
      segments,
    });
    expect(wrongYear.decision).toBe("needs_review");
    expect(wrongYear.step2?.conflicts.map((c) => c.code)).toContain("segment_year_mismatch");
  });
});
