import { describe, expect, test } from "vite-plus/test";
import type { CollectionInfo } from "../src/adapters/index.ts";
import {
  checkSegmentsFitCollection,
  findFullSeasonTruncationMessage,
} from "../src/exploration-agent.ts";

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
  });
});

function isoDay(baseMs: number, addDays: number): string {
  return new Date(baseMs + addDays * 86_400_000).toISOString().slice(0, 10);
}

describe("findFullSeasonTruncationMessage", () => {
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
    expect(
      findFullSeasonTruncationMessage(seg(1, 12), batchDelayed, seasonOf24, catalog24),
    ).toBeNull();

    const weeklyDelayed: CollectionInfo = {
      ...batchDelayed,
      canonicalId: "cid_weekly_delayed",
      featureEpisodes: Array.from({ length: 12 }, (_, i) => ({
        index: i + 1,
        title: String(i + 1),
        airDate: isoDay(Date.parse("2024-04-01T00:00:00Z"), i * 7), // Apr 1 .. Jun 17
      })),
    };
    expect(
      findFullSeasonTruncationMessage(seg(1, 12), weeklyDelayed, seasonOf24, catalog24),
    ).toBeNull();

    const singleLateReupload: CollectionInfo = {
      ...batchDelayed,
      canonicalId: "cid_reupload",
      featureEpisodes: Array.from({ length: 12 }, (_, i) => ({
        index: i + 1,
        title: String(i + 1),
        airDate: i === 11 ? "2024-06-15" : isoDay(base24, i * 7),
      })),
    };
    expect(
      findFullSeasonTruncationMessage(seg(1, 12), singleLateReupload, seasonOf24, catalog24),
    ).toBeNull();
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
    expect(
      findFullSeasonTruncationMessage(seg(1, 10), delayedPart1, () => 20, varietyCatalog20),
    ).toBeNull();

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
    expect(
      findFullSeasonTruncationMessage(seg(1, 10), weeklyDelayedPart1, () => 20, genericCatalog20),
    ).toBeNull();
  });

  test("rejects truncated whole-season variety mappings via period numbers, titles, or schedule alignment", () => {
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
    expect(
      findFullSeasonTruncationMessage(seg(3, 20), tencent20NoDates, seasonOf47, catalogWithPeriods),
    ).toMatch(/第10期/);

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
      findFullSeasonTruncationMessage(
        seg(3, 20),
        tencentWithSubtitles,
        seasonOf47,
        catalogWithSubtitles,
      ),
    ).toMatch(/episode 20 matches season 3 episode 47/);

    // Generic TMDB titles + broadcast-structured schedule alignment (both simulcast and delayed full-season).
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
    expect(
      findFullSeasonTruncationMessage(seg(3, 20), simulcast20, seasonOf47, genericCatalog47),
    ).toMatch(/broadcast schedule/);

    const delayedFullSeason20: CollectionInfo = {
      ...tencent20NoDates,
      featureEpisodes: tencent20NoDates.featureEpisodes.map((ep, i) => ({
        ...ep,
        airDate: isoDay(Date.parse("2025-11-18T00:00:00Z"), Math.floor((i * 71) / 19)),
      })),
    };
    expect(
      findFullSeasonTruncationMessage(
        seg(3, 20),
        delayedFullSeason20,
        seasonOf47,
        genericCatalog47,
      ),
    ).toMatch(/broadcast schedule/);
  });
});
