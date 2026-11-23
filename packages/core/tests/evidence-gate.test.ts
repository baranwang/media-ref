import { describe, expect, test } from "vite-plus/test";
import {
  evaluateEvidenceGate,
  evaluateEvidenceGateStep1,
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

  test("invokes pluggable Step 2 hook only after Step 1 passes", () => {
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

    // When Step 1 fails, Step 2 is NOT called
    const failedStep1 = evaluateEvidenceGate({
      catalog: makeTvCatalog(),
      collection: makeBilibiliCollection({ year: 1999 }),
      segments: [],
      evaluateStep2: step2Hook,
    });
    expect(failedStep1.decision).toBe("needs_review");
    expect(failedStep1.step2).toBeNull();
    expect(step2Called).toBe(0);

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
    expect(step2Called).toBe(1);
    expect(vetoedByStep2.step1.decision).toBe("pass");
    expect(vetoedByStep2.step2?.decision).toBe("needs_review");
    expect(vetoedByStep2.decision).toBe("needs_review");
    expect(vetoedByStep2.conflicts.some((c) => c.step === 2)).toBe(true);
  });
});
