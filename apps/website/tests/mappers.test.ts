import type { MediaDocument } from "@media-ref/client";
import { expect, test } from "vite-plus/test";
import { mediaItemFrom } from "../src/lib/mappers.ts";

test("whole-media platform associations span every season in the all-seasons view", () => {
  // Only the fields the mapper reads.
  const document = {
    media: {
      id: "m1",
      type: "tv",
      baseline: "tmdb",
      snapshot: {
        title: "T",
        seasons: [
          { season: 1, episodeCount: 10 },
          { season: 2, episodeCount: 12 },
        ],
      },
    },
    variants: [],
    externalIds: [],
    associations: [
      { id: "a1", namespace: "tencent", nativeId: "abc", segments: [], status: "active" },
    ],
  } as unknown as MediaDocument;

  const row = mediaItemFrom("m1", document, null)!.platformRows[0]!;
  expect(row.allSeasonSegments).toMatchObject([{ start: 1, end: 2, nativeId: "abc" }]);
});
