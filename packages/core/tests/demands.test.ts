import { describe, expect, test } from "vite-plus/test";
import { computeDemandTargetsForRead } from "../src/index.ts";
import type { QueryMediaByKeyResult } from "../src/read-media.ts";

// Only the fields demand targeting reads.
function readResult(
  externalIds: Array<{ namespace: string; nativeId: string }>,
): QueryMediaByKeyResult {
  return {
    kind: "ok",
    key: "douban:1292000",
    items: [
      {
        document: {
          media: { id: "m1", type: "movie", snapshot: { seasons: [] } },
          externalIds,
          associations: [
            {
              namespace: "douban",
              nativeId: "1292000",
              status: "confirmed",
              unconfirmed: false,
              segments: [],
            },
          ],
        },
        matchedAssociationId: null,
      },
    ],
  } as unknown as QueryMediaByKeyResult;
}

describe("catalog-group demand", () => {
  test("a Douban association without the TMDB external ID is still a gap", () => {
    const targets = computeDemandTargetsForRead({
      rawKey: "douban:1292000",
      queryResult: readResult([{ namespace: "imdb", nativeId: "tt0137523" }]),
      namespaceGroup: "catalog",
    });
    expect(targets).toEqual([
      { kind: "media", mediaId: "m1", season: null, namespaceGroup: "catalog", delta: 1 },
    ]);
  });

  test("with the TMDB external ID the media is covered", () => {
    expect(
      computeDemandTargetsForRead({
        rawKey: "douban:1292000",
        queryResult: readResult([{ namespace: "tmdb", nativeId: "movie:550" }]),
        namespaceGroup: "catalog",
      }),
    ).toEqual([]);
  });
});
