import { describe, expect, test } from "vite-plus/test";
import {
  CATALOG_NAMESPACES,
  EXTERNAL_ID_NAMESPACES,
  NAMESPACE_CAPABILITIES,
  PLATFORM_NAMESPACES,
  getNamespaceCapabilities,
  isExternalIdNamespace,
  isNamespace,
  validateVariantSegments,
} from "../src/index.ts";
import type { SegmentInput } from "../src/index.ts";

const imdb = getNamespaceCapabilities("imdb");
const douban = getNamespaceCapabilities("douban");
const bilibili = getNamespaceCapabilities("bilibili");

describe("namespace capability registry (ADR 0001)", () => {
  test("derives namespace groups from capabilities", () => {
    expect(PLATFORM_NAMESPACES).toEqual(["tencent", "iqiyi", "youku", "bilibili", "mgtv"]);
    expect(CATALOG_NAMESPACES).toEqual(["tmdb", "douban", "imdb", "tvdb", "trakt", "bangumi"]);
    expect(EXTERNAL_ID_NAMESPACES).toEqual(["tmdb", "imdb", "tvdb", "trakt"]);
    expect(Object.keys(NAMESPACE_CAPABILITIES)).toHaveLength(11);
    expect(isExternalIdNamespace("douban")).toBe(false);
    expect(isNamespace("toString")).toBe(false);
  });

  test("only platforms support variants; only authority catalogs allow hierarchical scopes", () => {
    expect(bilibili).toMatchObject({ supportsVariants: true, allowHierarchicalScopes: false });
    expect(douban).toMatchObject({ supportsVariants: false, allowHierarchicalScopes: false });
    expect(imdb).toMatchObject({
      supportsVariants: false,
      allowHierarchicalScopes: true,
      verificationMode: "sync",
    });
  });
});

describe("validateVariantSegments scope rules", () => {
  const wholeSeason4: SegmentInput[] = [{ season: 4, baseline: "tmdb" }];
  const episode4x1: SegmentInput[] = [
    { season: 4, episodeStart: 1, episodeEnd: 1, targetEpisodeStart: 1, baseline: "tmdb" },
  ];

  test("hierarchical catalog: whole show + whole season + single episode coexist (IMDb)", () => {
    const result = validateVariantSegments(
      [
        { associationId: "tt2560140", segments: [] },
        { associationId: "season-4", segments: wholeSeason4 },
        { associationId: "tt13624322", segments: episode4x1 },
      ],
      { baseline: "tmdb", allowHierarchicalScopes: imdb.allowHierarchicalScopes },
    );
    expect(result).toEqual({ valid: true });
  });

  test("hierarchical catalog still rejects overlap inside one association", () => {
    const result = validateVariantSegments(
      [
        { associationId: "tt2560140", segments: [] },
        {
          associationId: "bad",
          segments: [
            { season: 1, episodeStart: 1, episodeEnd: 5, targetEpisodeStart: 1, baseline: "tmdb" },
            { season: 1, episodeStart: 5, episodeEnd: 6, targetEpisodeStart: 5, baseline: "tmdb" },
          ],
        },
      ],
      { baseline: "tmdb", allowHierarchicalScopes: true },
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toEqual([
        expect.objectContaining({ code: "OVERLAPPING_VARIANT_SEGMENTS", associationIndex: 1 }),
      ]);
    }
  });

  test("mutually-exclusive scopes reject the same nesting (platform variant, Douban)", () => {
    for (const caps of [bilibili, douban]) {
      const result = validateVariantSegments(
        [
          { associationId: "whole", segments: [] },
          { associationId: "season-4", segments: wholeSeason4 },
          { associationId: "episode", segments: episode4x1 },
        ],
        { baseline: "tmdb", allowHierarchicalScopes: caps.allowHierarchicalScopes },
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        const codes = result.errors.map((e) => e.code);
        expect(codes).toContain("CONFLICTING_WHOLE_MEDIA_ASSOCIATION");
        expect(codes).toContain("OVERLAPPING_VARIANT_SEGMENTS");
      }
    }
  });

  test("intra-season split: three Douban entries cover one TMDB season without overlap", () => {
    const split = (start: number, end: number): SegmentInput[] => [
      { season: 1, episodeStart: start, episodeEnd: end, targetEpisodeStart: 1, baseline: "tmdb" },
    ];
    expect(
      validateVariantSegments([split(1, 12), split(13, 24), split(25, 36)], {
        baseline: "tmdb",
        allowHierarchicalScopes: douban.allowHierarchicalScopes,
      }),
    ).toEqual({ valid: true });
    expect(
      validateVariantSegments([split(1, 12), split(12, 24)], {
        baseline: "tmdb",
        allowHierarchicalScopes: douban.allowHierarchicalScopes,
      }).valid,
    ).toBe(false);
  });
});
