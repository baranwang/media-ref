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
});
