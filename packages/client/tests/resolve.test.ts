import { describe, expect, test } from "vite-plus/test";
import { normalizeSegment, resolveEpisode } from "../src/index.ts";
import type { MediaDocument } from "../src/index.ts";

function createJujutsuKaisenDoc(): MediaDocument {
  return {
    media: {
      id: "00000000-0000-4000-8000-000000000001",
      type: "tv",
      baseline: "tmdb",
      snapshot: {
        title: "咒术回战",
        originalTitle: "呪術廻戦",
        year: 2020,
        type: "tv",
        seasons: [{ season: 1, episodeCount: 47, airYear: 2020 }],
      },
    },
    externalIds: [{ namespace: "tmdb", nativeId: "tv:95479" }],
    variants: [
      {
        id: "var-bili-orig",
        mediaId: "00000000-0000-4000-8000-000000000001",
        namespace: "bilibili",
        label: "原声",
        isDefault: true,
      },
      {
        id: "var-bili-dub",
        mediaId: "00000000-0000-4000-8000-000000000001",
        namespace: "bilibili",
        label: "中配",
        isDefault: false,
      },
    ],
    associations: [
      {
        id: "assoc-ss34430",
        namespace: "bilibili",
        nativeId: "ss34430",
        variantId: "var-bili-orig",
        status: "confirmed",
        segments: [
          {
            season: 1,
            episodeStart: 1,
            episodeEnd: 24,
            targetEpisodeStart: 1,
            baseline: "tmdb",
          },
        ],
      },
      {
        id: "assoc-ss45574",
        namespace: "bilibili",
        nativeId: "ss45574",
        variantId: "var-bili-orig",
        status: "confirmed",
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
      {
        id: "assoc-dub",
        namespace: "bilibili",
        nativeId: "ss99999",
        variantId: "var-bili-dub",
        status: "confirmed",
        segments: [
          {
            season: 1,
            episodeStart: 1,
            episodeEnd: 24,
            targetEpisodeStart: 1,
            baseline: "tmdb",
          },
        ],
      },
    ],
  };
}

describe("resolveEpisode — linear mapping and variants", () => {
  test("resolves Jujutsu Kaisen split-season worked example (S1E30 -> ss45574 targetEpisode 6)", () => {
    const doc = createJujutsuKaisenDoc();

    const s1e30 = resolveEpisode(doc, { namespace: "bilibili", season: 1, episode: 30 });
    expect(s1e30).toEqual({
      kind: "mapped",
      associationId: "assoc-ss45574",
      namespace: "bilibili",
      nativeId: "ss45574",
      variantId: "var-bili-orig",
      targetEpisode: 6,
      segment: doc.associations[1].segments[0],
    });

    // Check inclusive boundaries across both collections
    expect(resolveEpisode(doc, { namespace: "bilibili", season: 1, episode: 1 })).toMatchObject({
      kind: "mapped",
      nativeId: "ss34430",
      targetEpisode: 1,
    });
    expect(resolveEpisode(doc, { namespace: "bilibili", season: 1, episode: 24 })).toMatchObject({
      kind: "mapped",
      nativeId: "ss34430",
      targetEpisode: 24,
    });
    expect(resolveEpisode(doc, { namespace: "bilibili", season: 1, episode: 25 })).toMatchObject({
      kind: "mapped",
      nativeId: "ss45574",
      targetEpisode: 1,
    });
    expect(resolveEpisode(doc, { namespace: "bilibili", season: 1, episode: 47 })).toMatchObject({
      kind: "mapped",
      nativeId: "ss45574",
      targetEpisode: 23,
    });
  });

  test("uses default variant when variantId is omitted and explicit variant when provided", () => {
    const doc = createJujutsuKaisenDoc();

    expect(
      resolveEpisode(doc, {
        namespace: "bilibili",
        season: 1,
        episode: 5,
        variantId: "var-bili-dub",
      }),
    ).toMatchObject({
      kind: "mapped",
      associationId: "assoc-dub",
      nativeId: "ss99999",
      variantId: "var-bili-dub",
      targetEpisode: 5,
    });

    expect(
      resolveEpisode(doc, {
        namespace: "bilibili",
        season: 1,
        episode: 5,
        variantId: "var-unknown",
      }),
    ).toEqual({ kind: "unmapped", reason: "no_variant" });

    expect(resolveEpisode(doc, { namespace: "tencent", season: 1, episode: 1 })).toEqual({
      kind: "unmapped",
      reason: "no_variant",
    });
  });

  test("resolves multiple seasons merged into a single collection with target offsets", () => {
    const doc: MediaDocument = {
      media: {
        id: "m-merged",
        type: "tv",
        baseline: "tmdb",
        snapshot: {
          title: "Merged Show",
          originalTitle: null,
          year: 2021,
          type: "tv",
          seasons: [
            { season: 1, episodeCount: 12, airYear: 2021 },
            { season: 2, episodeCount: 12, airYear: 2022 },
          ],
        },
      },
      externalIds: [],
      variants: [{ id: "v1", namespace: "tencent", label: "原声", isDefault: true }],
      associations: [
        {
          id: "a1",
          namespace: "tencent",
          nativeId: "mzc00200merged",
          variantId: "v1",
          status: "confirmed",
          segments: [
            { season: 1, episodeStart: 1, episodeEnd: 12, targetEpisodeStart: 1, baseline: "tmdb" },
            {
              season: 2,
              episodeStart: 1,
              episodeEnd: 12,
              targetEpisodeStart: 13,
              baseline: "tmdb",
            },
          ],
        },
      ],
    };

    expect(resolveEpisode(doc, { namespace: "tencent", season: 1, episode: 12 })).toMatchObject({
      kind: "mapped",
      nativeId: "mzc00200merged",
      targetEpisode: 12,
    });
    expect(resolveEpisode(doc, { namespace: "tencent", season: 2, episode: 1 })).toMatchObject({
      kind: "mapped",
      nativeId: "mzc00200merged",
      targetEpisode: 13,
    });
    expect(resolveEpisode(doc, { namespace: "tencent", season: 2, episode: 5 })).toMatchObject({
      kind: "mapped",
      nativeId: "mzc00200merged",
      targetEpisode: 17,
    });
  });

  test("resolves whole-season shorthand and open-ended segments beyond snapshot episodeCount", () => {
    const doc: MediaDocument = {
      media: {
        id: "m-ongoing",
        type: "tv",
        baseline: "tmdb",
        snapshot: {
          title: "Ongoing Anime",
          originalTitle: null,
          year: 2026,
          type: "tv",
          seasons: [
            { season: 0, episodeCount: 2, airYear: 2026 },
            { season: 1, episodeCount: 10, airYear: 2026 },
          ],
        },
      },
      externalIds: [],
      variants: [{ id: "v1", namespace: "iqiyi", label: "原声", isDefault: true }],
      associations: [
        {
          id: "a-s1",
          namespace: "iqiyi",
          nativeId: "iqiyi-ongoing",
          variantId: "v1",
          status: "confirmed",
          segments: [
            normalizeSegment({ season: 1, baseline: "tmdb" }),
            {
              season: 0,
              episodeStart: 1,
              episodeEnd: 2,
              targetEpisodeStart: 101,
              baseline: "tmdb",
            },
          ],
        },
      ],
    };

    // Beyond snapshot count (10) still resolves because episodeEnd is null
    expect(resolveEpisode(doc, { namespace: "iqiyi", season: 1, episode: 15 })).toMatchObject({
      kind: "mapped",
      nativeId: "iqiyi-ongoing",
      targetEpisode: 15,
    });
    // Season 0 specials
    expect(resolveEpisode(doc, { namespace: "iqiyi", season: 0, episode: 2 })).toMatchObject({
      kind: "mapped",
      nativeId: "iqiyi-ongoing",
      targetEpisode: 102,
    });
  });

  test("resolves when both episodeStart and targetEpisodeStart are > 1", () => {
    const doc: MediaDocument = {
      media: {
        id: "m-offset",
        type: "tv",
        baseline: "tmdb",
        snapshot: {
          title: "Offset Show",
          originalTitle: null,
          year: 2024,
          type: "tv",
          seasons: [{ season: 1, episodeCount: 24, airYear: 2024 }],
        },
      },
      externalIds: [],
      variants: [{ id: "v1", namespace: "bilibili", label: "原声", isDefault: true }],
      associations: [
        {
          id: "a1",
          namespace: "bilibili",
          nativeId: "ss77777",
          variantId: "v1",
          status: "confirmed",
          segments: [
            {
              season: 1,
              episodeStart: 13,
              episodeEnd: 24,
              targetEpisodeStart: 5,
              baseline: "tmdb",
            },
          ],
        },
      ],
    };

    // 5 + (15 - 13) = 7
    expect(resolveEpisode(doc, { namespace: "bilibili", season: 1, episode: 15 })).toMatchObject({
      kind: "mapped",
      nativeId: "ss77777",
      targetEpisode: 7,
    });
  });
});

describe("resolveEpisode — collection_only, unmapped, status filtering, and catalogs", () => {
  test("returns collection_only (whole_media) without targetEpisode when association has segments: []", () => {
    const movieDoc: MediaDocument = {
      media: {
        id: "m-movie",
        type: "movie",
        baseline: "tmdb",
        snapshot: {
          title: "搏击俱乐部",
          originalTitle: "Fight Club",
          year: 1999,
          type: "movie",
          seasons: [],
        },
      },
      externalIds: [{ namespace: "tmdb", nativeId: "movie:550" }],
      variants: [{ id: "v-youku", namespace: "youku", label: "原声", isDefault: true }],
      associations: [
        {
          id: "a-youku",
          namespace: "youku",
          nativeId: "efbfbd1234",
          variantId: "v-youku",
          status: "confirmed",
          segments: [],
        },
      ],
    };

    const res = resolveEpisode(movieDoc, { namespace: "youku" });
    expect(res).toEqual({
      kind: "collection_only",
      reason: "whole_media",
      associationId: "a-youku",
      namespace: "youku",
      nativeId: "efbfbd1234",
      variantId: "v-youku",
    });
    expect("targetEpisode" in res).toBe(false);

    // Also works when season & episode are supplied for a whole-media TV association
    const resWithEpisode = resolveEpisode(movieDoc, {
      namespace: "youku",
      season: 1,
      episode: 1,
    });
    expect(resWithEpisode).toEqual(res);
  });

  test("returns collection_only (non_linear) without targetEpisode when segment has nonLinear: true", () => {
    const doc: MediaDocument = {
      media: {
        id: "m-variety",
        type: "tv",
        baseline: "tmdb",
        snapshot: {
          title: "明星大侦探",
          originalTitle: null,
          year: 2016,
          type: "tv",
          seasons: [{ season: 1, episodeCount: 12, airYear: 2016 }],
        },
      },
      externalIds: [],
      variants: [{ id: "v-mgtv", namespace: "mgtv", label: "原声", isDefault: true }],
      associations: [
        {
          id: "a-mgtv",
          namespace: "mgtv",
          nativeId: "305892",
          variantId: "v-mgtv",
          status: "confirmed",
          segments: [
            {
              season: 1,
              episodeStart: 1,
              episodeEnd: null,
              targetEpisodeStart: 1,
              baseline: "tmdb",
              nonLinear: true,
            },
          ],
        },
      ],
    };

    const res = resolveEpisode(doc, { namespace: "mgtv", season: 1, episode: 4 });
    expect(res).toEqual({
      kind: "collection_only",
      reason: "non_linear",
      associationId: "a-mgtv",
      namespace: "mgtv",
      nativeId: "305892",
      variantId: "v-mgtv",
      segment: doc.associations[0].segments[0],
    });
    expect("targetEpisode" in res).toBe(false);
  });

  test("returns collection_only (needs_review) without targetEpisode when segment/association needsReview or baseline mismatches", () => {
    const doc: MediaDocument = {
      media: {
        id: "m-review",
        type: "tv",
        baseline: "tmdb",
        snapshot: {
          title: "Rebased Show",
          originalTitle: null,
          year: 2022,
          type: "tv",
          seasons: [
            { season: 1, episodeCount: 12, airYear: 2022 },
            { season: 2, episodeCount: 12, airYear: 2023 },
          ],
        },
      },
      externalIds: [],
      variants: [{ id: "v-bili", namespace: "bilibili", label: "原声", isDefault: true }],
      associations: [
        {
          id: "a-stale-baseline",
          namespace: "bilibili",
          nativeId: "ss10001",
          variantId: "v-bili",
          status: "confirmed",
          segments: [
            {
              season: 1,
              episodeStart: 1,
              episodeEnd: 12,
              targetEpisodeStart: 1,
              baseline: "bangumi",
            },
          ],
        },
        {
          id: "a-flagged",
          namespace: "bilibili",
          nativeId: "ss10002",
          variantId: "v-bili",
          status: "confirmed",
          segments: [
            {
              season: 2,
              episodeStart: 1,
              episodeEnd: 12,
              targetEpisodeStart: 1,
              baseline: "tmdb",
              needsReview: true,
            },
          ],
        },
      ],
    };

    // Baseline switched from bangumi -> tmdb: returns collection attribution only
    const baselineMismatch = resolveEpisode(doc, { namespace: "bilibili", season: 1, episode: 3 });
    expect(baselineMismatch).toEqual({
      kind: "collection_only",
      reason: "needs_review",
      associationId: "a-stale-baseline",
      namespace: "bilibili",
      nativeId: "ss10001",
      variantId: "v-bili",
      segment: doc.associations[0].segments[0],
    });
    expect("targetEpisode" in baselineMismatch).toBe(false);

    // Explicit segment.needsReview = true
    const explicitReview = resolveEpisode(doc, { namespace: "bilibili", season: 2, episode: 5 });
    expect(explicitReview).toEqual({
      kind: "collection_only",
      reason: "needs_review",
      associationId: "a-flagged",
      namespace: "bilibili",
      nativeId: "ss10002",
      variantId: "v-bili",
      segment: doc.associations[1].segments[0],
    });
    expect("targetEpisode" in explicitReview).toBe(false);

    // Association-level needsReview = true also blocks targetEpisode calculation
    const assocFlaggedDoc: MediaDocument = {
      ...doc,
      associations: [
        {
          id: "a-assoc-review",
          namespace: "bilibili",
          nativeId: "ss10003",
          variantId: "v-bili",
          status: "confirmed",
          needsReview: true,
          segments: [
            { season: 1, episodeStart: 1, episodeEnd: 12, targetEpisodeStart: 1, baseline: "tmdb" },
          ],
        },
      ],
    };
    const assocReview = resolveEpisode(assocFlaggedDoc, {
      namespace: "bilibili",
      season: 1,
      episode: 2,
    });
    expect(assocReview.kind).toBe("collection_only");
    if (assocReview.kind === "collection_only") {
      expect(assocReview.reason).toBe("needs_review");
    }
    expect("targetEpisode" in assocReview).toBe(false);
  });

  test("returns unmapped for out-of-range episodes, missing episode coordinates, and delisted/unconfirmed associations", () => {
    const doc = createJujutsuKaisenDoc();
    expect(resolveEpisode(doc, { namespace: "bilibili", season: 1, episode: 48 })).toEqual({
      kind: "unmapped",
      reason: "episode_out_of_range",
    });
    expect(resolveEpisode(doc, { namespace: "bilibili", season: 2, episode: 1 })).toEqual({
      kind: "unmapped",
      reason: "episode_out_of_range",
    });
    expect(resolveEpisode(doc, { namespace: "bilibili", season: 1, episode: 0 })).toEqual({
      kind: "unmapped",
      reason: "episode_out_of_range",
    });
    expect(resolveEpisode(doc, { namespace: "bilibili", season: 1 })).toEqual({
      kind: "unmapped",
      reason: "missing_episode",
    });

    // Delisted associations are always skipped, even when includeUnconfirmed is true
    const delistedDoc: MediaDocument = {
      ...doc,
      associations: [
        {
          ...doc.associations[0],
          status: "delisted",
        },
      ],
    };
    expect(resolveEpisode(delistedDoc, { namespace: "bilibili", season: 1, episode: 1 })).toEqual({
      kind: "unmapped",
      reason: "no_association",
    });
    expect(
      resolveEpisode(delistedDoc, {
        namespace: "bilibili",
        season: 1,
        episode: 1,
        includeUnconfirmed: true,
      }),
    ).toEqual({
      kind: "unmapped",
      reason: "no_association",
    });

    // seed_unconfirmed associations are skipped by default and included only with includeUnconfirmed: true
    const seedDoc: MediaDocument = {
      ...doc,
      associations: [
        {
          ...doc.associations[0],
          status: "seed_unconfirmed",
        },
      ],
    };
    expect(resolveEpisode(seedDoc, { namespace: "bilibili", season: 1, episode: 1 })).toEqual({
      kind: "unmapped",
      reason: "no_association",
    });
    expect(
      resolveEpisode(seedDoc, {
        namespace: "bilibili",
        season: 1,
        episode: 1,
        includeUnconfirmed: true,
      }),
    ).toMatchObject({
      kind: "mapped",
      nativeId: "ss34430",
      targetEpisode: 1,
    });

    // Pending change-request association (unconfirmed: true) is skipped by default,
    // and confirmed associations take priority over unconfirmed ones when includeUnconfirmed: true
    const mixedConfirmationDoc: MediaDocument = {
      ...doc,
      associations: [
        {
          id: "a-pending",
          namespace: "bilibili",
          nativeId: "ss-pending",
          variantId: "var-bili-orig",
          status: "confirmed",
          unconfirmed: true,
          segments: [
            { season: 1, episodeStart: 1, episodeEnd: 24, targetEpisodeStart: 1, baseline: "tmdb" },
          ],
        },
        doc.associations[0],
      ],
    };
    expect(
      resolveEpisode(mixedConfirmationDoc, { namespace: "bilibili", season: 1, episode: 3 }),
    ).toMatchObject({
      kind: "mapped",
      associationId: "assoc-ss34430",
      nativeId: "ss34430",
      targetEpisode: 3,
    });
    expect(
      resolveEpisode(mixedConfirmationDoc, {
        namespace: "bilibili",
        season: 1,
        episode: 3,
        includeUnconfirmed: true,
      }),
    ).toMatchObject({
      kind: "mapped",
      associationId: "assoc-ss34430",
      nativeId: "ss34430",
      targetEpisode: 3,
    });

    // Media with null baseline treats any segmented association as needs_review
    const noBaselineDoc: MediaDocument = {
      ...doc,
      media: { ...doc.media, baseline: null },
    };
    const noBaselineRes = resolveEpisode(noBaselineDoc, {
      namespace: "bilibili",
      season: 1,
      episode: 1,
    });
    expect(noBaselineRes.kind).toBe("collection_only");
    if (noBaselineRes.kind === "collection_only") {
      expect(noBaselineRes.reason).toBe("needs_review");
    }
    expect("targetEpisode" in noBaselineRes).toBe(false);
  });

  test("two episodes in one platform entry: the second resolves to unmapped, later episodes shift back one", () => {
    // 银魂 on Bilibili opens with 「01-02」: episode 1 at position 1, episode 2 unmapped, 3–49 at 2–48.
    const doc = createJujutsuKaisenDoc();
    doc.associations = [
      {
        id: "assoc-merged",
        namespace: "bilibili",
        nativeId: "ss38157",
        variantId: "var-bili-orig",
        status: "confirmed",
        segments: [
          { season: 1, episodeStart: 1, episodeEnd: 1, targetEpisodeStart: 1, baseline: "tmdb" },
          { season: 1, episodeStart: 3, episodeEnd: 49, targetEpisodeStart: 2, baseline: "tmdb" },
        ],
      },
    ];
    const at = (episode: number) => {
      const r = resolveEpisode(doc, { namespace: "bilibili", season: 1, episode });
      return r.kind === "mapped" ? r.targetEpisode : r.kind === "unmapped" ? r.reason : r.kind;
    };

    expect([1, 2, 3, 49].map(at)).toEqual([1, "episode_out_of_range", 2, 48]);
  });

  test("resolves catalog associations (e.g. Douban one-entry-per-season) without requiring a platform variant", () => {
    const doc: MediaDocument = {
      media: {
        id: "m-douban",
        type: "tv",
        baseline: "tmdb",
        snapshot: {
          title: "三体",
          originalTitle: null,
          year: 2023,
          type: "tv",
          seasons: [
            { season: 1, episodeCount: 30, airYear: 2023 },
            { season: 2, episodeCount: 24, airYear: 2026 },
          ],
        },
      },
      externalIds: [{ namespace: "tmdb", nativeId: "tv:108545" }],
      variants: [],
      associations: [
        {
          id: "a-douban-s1",
          namespace: "douban",
          nativeId: "26647087",
          variantId: null,
          status: "confirmed",
          segments: [
            { season: 1, episodeStart: 1, episodeEnd: 30, targetEpisodeStart: 1, baseline: "tmdb" },
          ],
        },
        {
          id: "a-douban-s2",
          namespace: "douban",
          nativeId: "35902857",
          variantId: null,
          status: "confirmed",
          segments: [
            { season: 2, episodeStart: 1, episodeEnd: 24, targetEpisodeStart: 1, baseline: "tmdb" },
          ],
        },
      ],
    };

    expect(resolveEpisode(doc, { namespace: "douban", season: 2, episode: 7 })).toEqual({
      kind: "mapped",
      associationId: "a-douban-s2",
      namespace: "douban",
      nativeId: "35902857",
      variantId: null,
      targetEpisode: 7,
      segment: doc.associations[1].segments[0],
    });
  });
});
