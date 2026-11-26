import { describe, expect, test } from "vite-plus/test";
import { createAdapterRegistry, createFakeOutboundClient } from "../src/index.ts";
import type { CollectionInfo, Tier2Adapter } from "../src/adapters/types.ts";
import { runQueryTool, type ToolContext } from "../src/exploration-tools.ts";
import type { TmdbGateway } from "../src/tmdb.ts";

describe("get_collection", () => {
  test("pages through a long collection, fetching it once per session", async () => {
    let fetches = 0;
    const info: CollectionInfo = {
      namespace: "tencent",
      canonicalId: "long",
      title: "斗破苍穹年番",
      year: 2022,
      mediaType: "tv",
      featureEpisodeCount: 219,
      featureEpisodes: Array.from({ length: 219 }, (_, i) => ({ index: i + 1, title: `${i + 1}` })),
    };
    const adapter: Tier2Adapter<"tencent"> = {
      namespace: "tencent",
      tier: 2,
      parseInput: (raw) => ({ kind: "cover", id: raw, canonicalId: raw }),
      canonicalize: async (raw) => raw,
      fetchCollection: async () => {
        fetches += 1;
        return { status: "found", info };
      },
    };
    const registered: string[] = [];
    const ctx: ToolContext = {
      outbound: createFakeOutboundClient(),
      registry: createAdapterRegistry([adapter]),
      tmdb: {} as TmdbGateway,
      collectionNamespaces: ["tencent"],
      seasons: [],
      tmdbTvId: null,
      register: (i) => {
        registered.push(i.canonicalId);
        return false;
      },
      noteTransient: () => {},
    };
    const page = (fromIndex?: number) =>
      runQueryTool(ctx, "get_collection", {
        namespace: "tencent",
        id: "long",
        ...(fromIndex ? { fromIndex } : {}),
      }) as Promise<{
        featureEpisodeCount: number;
        episodes: Array<{ index: number }>;
        episodesTruncated?: { total: number; nextFromIndex: number };
      }>;

    const first = await page();
    expect(first.featureEpisodeCount).toBe(219);
    expect(first.episodes.map((e) => e.index)).toEqual(Array.from({ length: 80 }, (_, i) => i + 1));
    expect(first.episodesTruncated).toEqual({ total: 219, nextFromIndex: 81 });

    const second = await page(161);
    expect(second.episodes[0]!.index).toBe(161);
    expect(second.episodes.at(-1)!.index).toBe(219);
    expect(second.episodesTruncated).toBeUndefined();

    expect(fetches).toBe(1);
    expect(registered).toEqual(["long", "long"]);
  });
});
