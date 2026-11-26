import { describe, expect, test } from "vite-plus/test";
import { isBroadcastLabel, selectBroadcastEpisodes } from "../src/adapters/variety.ts";
import labels from "./fixtures/variety/episode-labels.json" with { type: "json" };

// Real episode lists (title, long title) as our adapters fetched them before filtering, 2026-11-26.
const lists = labels as unknown as Record<string, Array<[string | null, string | null]>>;
const episodes = (key: string) =>
  lists[key]!.map(([title, longTitle], i) => ({
    index: i + 1,
    ...(title ? { title } : {}),
    ...(longTitle ? { longTitle } : {}),
  }));

describe("selectBroadcastEpisodes on real variety collections", () => {
  test.each([
    ["mgtv:739911 乘风2025", 69, 24],
    ["mgtv:696137 再见爱人 第四季", 72, 26],
    ["tencent:mzc00200vyot3cs 喜人奇妙夜", 22, 22],
    ["iqiyi:2657274641350501 新说唱2025", 48, 33],
    ["bilibili:ss34053 说唱新世代", 35, 18],
    ["youku:bdfffb5af8834cdaa975 这！就是街舞 第六季", 26, 26],
  ])("%s: %i listed, %i broadcast parts", (key, listed, kept) => {
    const all = episodes(key);
    expect(all).toHaveLength(listed);
    const broadcast = selectBroadcastEpisodes(all);
    expect(broadcast).toHaveLength(kept);
    expect(broadcast.map((e) => e.index)).toEqual(broadcast.map((_, i) => i + 1));
    for (const ep of broadcast) {
      expect(`${ep.title ?? ""} ${ep.longTitle ?? ""}`).toMatch(/第\s*\d+\s*期/);
      expect(`${ep.title ?? ""} ${ep.longTitle ?? ""}`).not.toMatch(
        /纯享|加更|加长|福利|沉浸|训练/,
      );
    }
  });

  test("the first broadcast parts come first, in order", () => {
    const titles = selectBroadcastEpisodes(episodes("mgtv:696137 再见爱人 第四季")).map(
      (e) => e.longTitle?.split("：")[0],
    );
    expect(titles.slice(0, 4)).toEqual(["第1期上", "第1期下", "第2期上", "第2期下"]);
  });

  test("a drama is left untouched", () => {
    const all = episodes("tencent:mzc00200whsp9r6 繁花");
    expect(selectBroadcastEpisodes(all)).toEqual(all);
  });

  test("broadcast label shapes", () => {
    for (const ok of [
      "第1期",
      "第1期上",
      "第1期 下：x",
      "第1期（上）",
      "第12期上(一) 决赛",
      "第3期：x",
    ]) {
      expect(isBroadcastLabel(ok), ok).toBe(true);
    }
    for (const no of [
      "第1期纯享",
      "第5期陪看：x",
      "第2期加长版（上）",
      "第3期福利版",
      "加更版：x",
      "12",
    ]) {
      expect(isBroadcastLabel(no), no).toBe(false);
    }
  });
});
