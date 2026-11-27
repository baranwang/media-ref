import { describe, expect, test } from "vite-plus/test";
import type { CollectionInfo } from "../src/adapters/index.ts";
import { checkSegmentsFitCollection } from "../src/exploration-agent.ts";

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
