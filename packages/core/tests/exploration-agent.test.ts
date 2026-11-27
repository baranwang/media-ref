import { describe, expect, test } from "vite-plus/test";
import type { CollectionInfo } from "../src/adapters/index.ts";
import { checkSegmentsFitCollection } from "../src/exploration-agent.ts";
import { seasonCoverageConflict, type SeasonEpisode } from "../src/season-coverage.ts";
import type { SegmentInput } from "@media-ref/client";

const collection = (episodes: number): CollectionInfo => ({
  namespace: "bilibili",
  canonicalId: "ss1",
  title: "t",
  year: 2020,
  mediaType: "tv",
  featureEpisodeCount: episodes,
  featureEpisodes: Array.from({ length: episodes }, (_, i) => ({ index: i + 1 })),
});
const seasonOf24 = (season: number) => (season === 1 ? 24 : null);

describe("checkSegmentsFitCollection", () => {
  const seg = (episodeEnd: number | null, targetEpisodeStart = 1) => ({
    season: 1,
    episodeStart: 1,
    episodeEnd,
    targetEpisodeStart,
    baseline: "tmdb" as const,
  });

  test("an open-ended segment covers the whole baseline season", () => {
    expect(checkSegmentsFitCollection([seg(null)], collection(1), seasonOf24)).toMatch(
      /episode 24/,
    );
    expect(checkSegmentsFitCollection([seg(null)], collection(24), seasonOf24)).toBeNull();
  });

  test("an open end with an unknown season length is refused", () => {
    expect(
      checkSegmentsFitCollection([{ ...seg(null), season: 2 }], collection(24), seasonOf24),
    ).toMatch(/episodeEnd is required/);
  });

  test("explicit ranges must fit after the target offset", () => {
    expect(checkSegmentsFitCollection([seg(12, 13)], collection(24), seasonOf24)).toBeNull();
    expect(checkSegmentsFitCollection([seg(12, 14)], collection(24), seasonOf24)).toMatch(
      /episode 25/,
    );
  });

  test("nonLinear segments link full-season collections with divergent episode counts", () => {
    const seasonOf47 = (season: number) => (season === 3 ? 47 : null);
    expect(
      checkSegmentsFitCollection([{ ...seg(null), nonLinear: true }], collection(20), () => 0),
    ).toBeNull();
    // 20 broadcast parts on Tencent covering a 47-entry TMDB season (e.g. 现在就出发 S3).
    expect(
      checkSegmentsFitCollection(
        [
          {
            season: 3,
            episodeStart: 1,
            episodeEnd: null,
            targetEpisodeStart: 1,
            baseline: "tmdb",
            nonLinear: true,
          },
        ],
        collection(20),
        seasonOf47,
      ),
    ).toBeNull();
    expect(
      checkSegmentsFitCollection(
        [
          {
            season: 3,
            episodeStart: 1,
            episodeEnd: null,
            targetEpisodeStart: 1,
            baseline: "tmdb",
            nonLinear: true,
          },
        ],
        collection(0),
        seasonOf47,
      ),
    ).toMatch(/0 fetched feature episodes/);
    expect(
      checkSegmentsFitCollection(
        [
          {
            season: 3,
            episodeStart: 1,
            episodeEnd: 50,
            targetEpisodeStart: 1,
            baseline: "tmdb",
            nonLinear: true,
          },
        ],
        collection(20),
        seasonOf47,
      ),
    ).toMatch(/exceeds season 3 length 47/);
    expect(
      checkSegmentsFitCollection(
        [
          {
            season: 1,
            episodeStart: 25,
            episodeEnd: null,
            targetEpisodeStart: 1,
            baseline: "tmdb",
            nonLinear: true,
          },
        ],
        collection(20),
        seasonOf24,
      ),
    ).toMatch(/episodeStart 25 exceeds season 1 length 24/);
  });
});

function isoDay(baseMs: number, addDays: number): string {
  return new Date(baseMs + addDays * 86_400_000).toISOString().slice(0, 10);
}

describe("season coverage", () => {
  function coverage(
    segments: SegmentInput[],
    info: CollectionInfo,
    count: (season: number) => number | null,
    episodes: SeasonEpisode[],
  ) {
    const season = segments[0]!.season;
    return seasonCoverageConflict(
      {
        namespace: "tmdb",
        canonicalId: "tv:1",
        title: info.title,
        year: info.year,
        mediaType: "tv",
        externalIds: {},
        seasons: [{ season, episodeCount: count(season)!, airYear: info.year }],
        seasonEpisodes: { [season]: episodes },
      },
      info,
      segments,
    );
  }
  const seg = (season: number, episodeEnd: number) => [
    {
      season,
      episodeStart: 1,
      episodeEnd,
      targetEpisodeStart: 1,
      baseline: "tmdb" as const,
    },
  ];
  const base24 = Date.parse("2024-01-01T00:00:00Z");
  const catalog24 = Array.from({ length: 24 }, (_, i) => ({
    episode: i + 1,
    title: `Episode ${i + 1}`,
    airDate: isoDay(base24, i * 7), // Jan 1 .. Jun 10 (E12 = Mar 18, E24 = Jun 10)
  }));

  test("allows delayed batch and staggered linear prefixes (e.g. episodes 1..12 of 24 published after finale)", () => {
    const batchDelayed: CollectionInfo = {
      namespace: "tencent",
      canonicalId: "cid_batch",
      title: "Split Drama Part 1",
      year: 2024,
      mediaType: "tv",
      featureEpisodeCount: 12,
      featureEpisodes: Array.from({ length: 12 }, (_, i) => ({
        index: i + 1,
        title: String(i + 1),
        airDate: "2024-07-15",
      })),
    };
    expect(coverage(seg(1, 12), batchDelayed, seasonOf24, catalog24)).toBeNull();

    const weeklyDelayed: CollectionInfo = {
      ...batchDelayed,
      canonicalId: "cid_weekly_delayed",
      featureEpisodes: Array.from({ length: 12 }, (_, i) => ({
        index: i + 1,
        title: String(i + 1),
        airDate: isoDay(Date.parse("2024-04-01T00:00:00Z"), i * 7), // Apr 1 .. Jun 17
      })),
    };
    expect(coverage(seg(1, 12), weeklyDelayed, seasonOf24, catalog24)).toBeNull();

    const singleLateReupload: CollectionInfo = {
      ...batchDelayed,
      canonicalId: "cid_reupload",
      featureEpisodes: Array.from({ length: 12 }, (_, i) => ({
        index: i + 1,
        title: String(i + 1),
        airDate: i === 11 ? "2024-06-15" : isoDay(base24, i * 7),
      })),
    };
    expect(coverage(seg(1, 12), singleLateReupload, seasonOf24, catalog24)).toBeNull();
  });

  test("allows a genuine split variety Part 1 even when published late", () => {
    const varietyCatalog20 = Array.from({ length: 20 }, (_, i) => ({
      episode: i + 1,
      title: `第${Math.floor(i / 2) + 1}期${i % 2 === 0 ? "上" : "下"}`,
      airDate: isoDay(base24, i * 4),
    }));
    const delayedPart1: CollectionInfo = {
      namespace: "tencent",
      canonicalId: "cid_part1",
      title: "综艺 Part 1",
      year: 2024,
      mediaType: "tv",
      featureEpisodeCount: 10,
      featureEpisodes: Array.from({ length: 10 }, (_, i) => ({
        index: i + 1,
        title: `第${Math.floor(i / 2) + 1}期${i % 2 === 0 ? "上" : "下"}`,
        airDate: "2024-08-01",
      })),
    };
    expect(coverage(seg(1, 10), delayedPart1, () => 20, varietyCatalog20)).toBeNull();

    // Even without 第N期 labels in TMDB, delayed Part 1 dates track prefix span, not full season.
    const genericCatalog20 = varietyCatalog20.map((ep, i) => ({
      ...ep,
      title: i === 0 ? "先导片" : `Episode ${ep.episode}`,
    }));
    const weeklyDelayedPart1: CollectionInfo = {
      ...delayedPart1,
      featureEpisodes: delayedPart1.featureEpisodes.map((ep, i) => ({
        ...ep,
        airDate: isoDay(Date.parse("2024-03-01T00:00:00Z"), i * 4),
      })),
    };
    expect(coverage(seg(1, 10), weeklyDelayedPart1, () => 20, genericCatalog20)).toBeNull();
  });

  test("recognizes a verified final installment or subtitle and never treats a publication schedule as finale evidence", () => {
    const seasonOf47 = (s: number) => (s === 3 ? 47 : null);
    const tencent20NoDates: CollectionInfo = {
      namespace: "tencent",
      canonicalId: "mzc00200znyfa5u",
      title: "现在就出发 第3季",
      year: 2025,
      mediaType: "tv",
      featureEpisodeCount: 20,
      featureEpisodes: Array.from({ length: 10 }, (_, p) =>
        (["上", "下"] as const).map((part, idx) => ({
          index: p * 2 + idx + 1,
          title: `第${p + 1}期${part}`,
        })),
      ).flat(),
    };
    const catalogWithPeriods = Array.from({ length: 47 }, (_, i) => ({
      episode: i + 1,
      title: i === 0 ? "先导片" : `第${Math.min(10, Math.floor((i * 10) / 46) + 1)}期`,
      airDate: null,
    }));
    expect(coverage(seg(3, 20), tencent20NoDates, seasonOf47, catalogWithPeriods)).toMatchObject({
      code: "partial_segment_spans_full_season",
      message: expect.stringContaining("第10期"),
    });

    // Subtitle match past episodeEnd without broadcast period overlap.
    const tencentWithSubtitles: CollectionInfo = {
      ...tencent20NoDates,
      featureEpisodes: tencent20NoDates.featureEpisodes.map((ep, i) => ({
        ...ep,
        title: i === 19 ? "第10期下：雪地收官狂欢夜" : `Episode ${i + 1}`,
      })),
    };
    const catalogWithSubtitles = Array.from({ length: 47 }, (_, i) => ({
      episode: i + 1,
      title: i === 46 ? "雪地收官狂欢夜" : `Episode ${i + 1}`,
      airDate: null,
    }));
    expect(
      coverage(seg(3, 20), tencentWithSubtitles, seasonOf47, catalogWithSubtitles),
    ).toMatchObject({
      code: "partial_segment_spans_full_season",
      message: expect.stringContaining("season 3 episode 47"),
    });

    // The same publication schedule could belong to a slower or delayed release of just Part 1.
    const base25 = Date.parse("2025-10-18T00:00:00Z");
    const genericCatalog47 = Array.from({ length: 47 }, (_, i) => ({
      episode: i + 1,
      title: i === 0 ? "先导片" : `Episode ${i + 1}`,
      airDate: isoDay(base25, Math.floor((i * 71) / 46)),
    }));
    const simulcast20: CollectionInfo = {
      ...tencent20NoDates,
      featureEpisodes: tencent20NoDates.featureEpisodes.map((ep, i) => ({
        ...ep,
        airDate: isoDay(base25, 7 + Math.floor((i * 64) / 19)),
      })),
    };
    expect(coverage(seg(3, 20), simulcast20, seasonOf47, genericCatalog47)).toBeNull();

    const delayedFullSeason20: CollectionInfo = {
      ...tencent20NoDates,
      featureEpisodes: tencent20NoDates.featureEpisodes.map((ep, i) => ({
        ...ep,
        airDate: isoDay(Date.parse("2025-11-18T00:00:00Z"), Math.floor((i * 71) / 19)),
      })),
    };
    expect(coverage(seg(3, 20), delayedFullSeason20, seasonOf47, genericCatalog47)).toBeNull();
  });
  test("distinguishes intermediate broadcasts and subtitles from a verified finale", () => {
    const titles = [
      "第1期上",
      "第1期下",
      "第2期上",
      "第2期下：中途聚会之夜",
      "第3期上",
      "第3期下：雪地收官狂欢夜",
      "第3期加更",
    ];
    const episodes = titles.map((title, i) => ({ episode: i + 1, title, airDate: null }));
    const part1 = {
      ...collection(2),
      featureEpisodes: [
        { index: 1, title: "第1期" },
        { index: 2, title: "第2期" },
      ],
    };
    const prefix = seg(1, 2);
    expect(coverage(prefix, part1, () => 7, episodes)?.code).toBe("partial_segment_outside_prefix");
    const whole = [{ ...prefix[0]!, episodeEnd: null, nonLinear: true }];
    expect(coverage(whole, part1, () => 7, episodes)?.code).toBe("season_finale_unverified");
    const middle = {
      ...part1,
      featureEpisodes: [
        { index: 1, title: "1" },
        { index: 2, longTitle: "中途聚会之夜" },
      ],
    };
    expect(coverage(prefix, middle, () => 7, episodes)?.code).toBe(
      "partial_segment_outside_prefix",
    );
    const all = {
      ...part1,
      featureEpisodes: [
        ...part1.featureEpisodes,
        { index: 3, title: "第3期上" },
        { index: 4, title: "第3期下：雪地收官狂欢夜" },
      ],
    };
    expect(coverage(whole, all, () => 7, episodes)).toBeNull();
    expect(coverage(seg(1, 5), all, () => 7, episodes)?.code).toBe(
      "partial_segment_spans_full_season",
    );
    expect(
      coverage(
        [
          { ...prefix[0]!, episodeEnd: 1 },
          { ...prefix[0]!, episodeStart: 2, targetEpisodeStart: 2 },
        ],
        all,
        () => 7,
        episodes,
      )?.code,
    ).toBe("partial_segment_spans_full_season");
    expect(
      coverage(
        whole,
        { ...all, featureEpisodes: all.featureEpisodes.slice(0, 3) },
        () => 7,
        episodes,
      )?.code,
    ).toBe("season_finale_unverified");
  });

  test("a split prefix at an offset only uses the platform positions it claims", () => {
    const first = { ...seg(2, 1)[0]!, targetEpisodeStart: 2 };
    const second = { ...first, episodeStart: 2, episodeEnd: 2, targetEpisodeStart: 3 };
    const episodes = ["第1期上", "第1期下", "第2期"].map((title, i) => ({
      episode: i + 1,
      title,
      airDate: null,
    }));
    const check = (position3: string) =>
      coverage(
        [second, first],
        {
          ...collection(4),
          featureEpisodes: ["第2期", "第1期", position3, "第2期"].map((title, i) => ({
            index: i + 1,
            title,
          })),
        },
        () => 3,
        episodes,
      );
    expect(check("3")).toBeNull();
    expect(check("第2期")?.code).toBe("partial_segment_spans_full_season");
  });

  test("a split final installment requires its last part", () => {
    const episodes = ["第1期", "第2期下（一）", "第2期下（二）"].map((title, i) => ({
      episode: i + 1,
      title,
      airDate: null,
    }));
    const info = {
      ...collection(2),
      featureEpisodes: episodes.slice(0, 2).map((e) => ({ index: e.episode, title: e.title })),
    };
    const whole = [{ ...seg(1, 2)[0]!, nonLinear: true, episodeEnd: null }];
    expect(coverage(whole, info, () => 3, episodes)?.code).toBe("season_finale_unverified");
    const combined = {
      ...info,
      featureEpisodes: [info.featureEpisodes[0]!, { index: 2, title: "第2期下" }],
    };
    expect(coverage(whole, combined, () => 3, episodes)).toBeNull();
    expect(coverage(seg(1, 2), combined, () => 3, episodes)?.code).toBe(
      "partial_segment_spans_full_season",
    );
    // The same combined label already in the catalog prefix cannot prove a later subpart.
    const withCombinedInPrefix = [
      episodes[0]!,
      { ...episodes[1]!, title: "第2期下" },
      episodes[2]!,
    ];
    expect(coverage(seg(1, 2), combined, () => 3, withCombinedInPrefix)).toBeNull();
    expect(
      coverage(
        whole,
        {
          ...info,
          featureEpisodes: [...info.featureEpisodes, { index: 3, title: episodes[2]!.title }],
        },
        () => 3,
        episodes,
      ),
    ).toBeNull();
  });

  test("date labels, bare numbers and repeated show titles cannot identify a finale", () => {
    for (const title of [
      "第20241124期",
      "２０２４１１２４",
      "Episode 06",
      "S01E06",
      "综艺2049",
      "第6集：综艺2049",
      "2024年11月24日",
    ]) {
      const episodes = Array.from({ length: 6 }, (_, i) => ({
        episode: i + 1,
        title: i === 5 ? title : `第${i + 1}集`,
        airDate: "2024-11-24",
      }));
      const info = {
        ...collection(2),
        title: "综艺2049",
        featureEpisodes: [
          { index: 1, title: "1" },
          { index: 2, title },
        ],
      };
      expect(coverage(seg(1, 2), info, () => 6, episodes)).toBeNull();
      expect(
        coverage([{ ...seg(1, 2)[0]!, nonLinear: true, episodeEnd: null }], info, () => 6, episodes)
          ?.code,
      ).toBe("season_finale_unverified");
    }
  });
  test("a substantive finale is distinct from a preview, a repeated period, and an ordinary episode titled Special Delivery", () => {
    const episodes = ["第1期", "第2期", "第2期"].map((title, i) => ({
      episode: i + 1,
      title,
      airDate: null,
    }));
    const info = {
      ...collection(2),
      featureEpisodes: [
        { index: 1, title: "第1期" },
        { index: 2, title: "第2期" },
      ],
    };
    const prefix = seg(1, 2);
    expect(coverage(prefix, info, () => 3, episodes)).toBeNull();
    const withPreview = {
      ...info,
      featureEpisodes: [
        ...info.featureEpisodes,
        { index: 3, title: "第3期", longTitle: "第3期：预告片" },
      ],
    };
    const three = [...episodes.slice(0, 2), { ...episodes[2]!, title: "第3期" }];
    expect(coverage(prefix, withPreview, () => 3, three)).toBeNull();
    expect(
      coverage(prefix, info, () => 3, [
        ...three.slice(0, 2),
        { ...three[2]!, title: "Special Delivery" },
      ]),
    ).toBeNull();
  });
});
