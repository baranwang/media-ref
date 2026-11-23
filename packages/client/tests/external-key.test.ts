import { describe, expect, test } from "vite-plus/test";
import {
  BASELINE_PRIORITY,
  CATALOG_NAMESPACES,
  PLATFORM_NAMESPACES,
  formatExternalKey,
  getNamespaceGroup,
  parseExternalKey,
} from "../src/index.ts";

describe("namespaces and groups", () => {
  test("exposes canonical platform, catalog, and baseline priority lists", () => {
    expect(PLATFORM_NAMESPACES).toEqual(["tencent", "iqiyi", "youku", "bilibili", "mgtv"]);
    expect(CATALOG_NAMESPACES).toEqual(["tmdb", "douban", "imdb", "tvdb", "trakt", "bangumi"]);
    expect(BASELINE_PRIORITY).toEqual(["tmdb", "tvdb", "imdb", "bangumi", "douban"]);
  });

  test("classifies every namespace into platform or catalog", () => {
    for (const ns of PLATFORM_NAMESPACES) {
      expect(getNamespaceGroup(ns)).toBe("platform");
    }
    for (const ns of CATALOG_NAMESPACES) {
      expect(getNamespaceGroup(ns)).toBe("catalog");
    }
  });
});

describe("external keys", () => {
  test("parses simple and multi-colon native IDs cleanly", () => {
    expect(parseExternalKey("tmdb:tv:95479")).toEqual({
      namespace: "tmdb",
      nativeId: "tv:95479",
    });
    expect(parseExternalKey("tmdb:movie:550")).toEqual({
      namespace: "tmdb",
      nativeId: "movie:550",
    });
    expect(parseExternalKey("douban:1292052")).toEqual({
      namespace: "douban",
      nativeId: "1292052",
    });
    expect(parseExternalKey("bilibili:ss34430")).toEqual({
      namespace: "bilibili",
      nativeId: "ss34430",
    });
    expect(parseExternalKey("imdb:tt0137523")).toEqual({
      namespace: "imdb",
      nativeId: "tt0137523",
    });
  });

  test("returns null for malformed or unknown external keys", () => {
    expect(parseExternalKey("")).toBeNull();
    expect(parseExternalKey("tmdb")).toBeNull();
    expect(parseExternalKey("tmdb:")).toBeNull();
    expect(parseExternalKey("tmdb:   ")).toBeNull();
    expect(parseExternalKey(":tv:95479")).toBeNull();
    expect(parseExternalKey("unknown:123")).toBeNull();
    expect(parseExternalKey(" tmdb:tv:95479")).toBeNull();
    expect(parseExternalKey("tmdb: tv:95479")).toBeNull();
    expect(parseExternalKey("tmdb:tv:95479 ")).toBeNull();
  });

  test("formats external keys and round-trips with parseExternalKey", () => {
    const keys = [
      { namespace: "tmdb", nativeId: "tv:95479" },
      { namespace: "douban", nativeId: "123" },
      { namespace: "bilibili", nativeId: "ss45574" },
    ] as const;

    for (const key of keys) {
      const formatted = formatExternalKey(key);
      expect(parseExternalKey(formatted)).toEqual(key);
    }
    expect(formatExternalKey({ namespace: "tmdb", nativeId: "tv:95479" })).toBe("tmdb:tv:95479");
  });

  test("rejects formatting invalid external keys", () => {
    expect(() => formatExternalKey({ namespace: "tmdb", nativeId: "" })).toThrow(RangeError);
    expect(() => formatExternalKey({ namespace: "tmdb", nativeId: "   " })).toThrow(RangeError);
    expect(() => formatExternalKey({ namespace: "tmdb", nativeId: " tv:1" })).toThrow(RangeError);
  });
});
