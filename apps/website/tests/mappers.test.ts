import type { MediaDocument } from "@media-ref/client";
import { expect, test } from "vite-plus/test";
import { changeRequestFromProto, mediaItemFrom } from "../src/lib/mappers.ts";

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

test("auto-check list shows Step 1 and Step 2 conflicts together when Step 1 fails", () => {
  // Only the fields the mapper reads; Step 2 now runs even when Step 1 fails.
  const cr = {
    id: "cr1",
    namespace: "bilibili",
    nativeId: "ss1",
    rawNativeId: "ss1",
    segments: [],
    evidence: {
      gate: {
        decision: "needs_review",
        step1: {
          decision: "needs_review",
          matchedBy: "fields",
          fieldChecks: { title: "mismatch" },
        },
        step2: {
          decision: "needs_review",
          conflicts: [{ step: 2, code: "segment_season_not_found", message: "Season 9 not found" }],
        },
      },
    },
  } as unknown as Parameters<typeof changeRequestFromProto>[0];

  expect(changeRequestFromProto(cr).checks).toMatchObject([
    { id: "cr1-title", title: "片名对不上", status: "failed" },
    { id: "cr1-step2-0", detail: "Season 9 not found", status: "needs_confirm" },
  ]);
});
