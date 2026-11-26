import { describe, expect, test } from "vite-plus/test";
import { evaluateVarietyDateEvidence, isVarietyExtra } from "../src/variety.ts";

const weekly = (n: number, start = "2024-01-05") =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.parse(`${start}T00:00:00Z`) + i * 7 * 86_400_000);
    return d.toISOString().slice(0, 10);
  });

describe("variety air-date evidence", () => {
  const catalog = weekly(10).map((airDate, i) => ({ episode: i + 1, airDate }));

  test("split broadcasts and extras still line up by date", () => {
    const platform = weekly(10).flatMap((airDate, i) => [
      { index: 3 * i + 1, title: `第${i + 1}期上`, airDate },
      { index: 3 * i + 2, title: `第${i + 1}期下`, airDate },
      { index: 3 * i + 3, title: `第${i + 1}期加更`, airDate: "2030-01-01" },
    ]);
    expect(evaluateVarietyDateEvidence(catalog, platform)).toEqual({
      pass: true,
      matched: 10,
      total: 10,
      missingSamples: [],
    });
  });

  test("a one-day upload offset counts; extras on the right date do not", () => {
    const platform = weekly(10, "2024-01-06").map((airDate, i) => ({ index: i + 1, airDate }));
    expect(evaluateVarietyDateEvidence(catalog, platform).pass).toBe(true);
    const onlyExtras = weekly(10).map((airDate, i) => ({ index: i + 1, title: "纯享版", airDate }));
    expect(evaluateVarietyDateEvidence(catalog, onlyExtras).matched).toBe(0);
  });

  test("a missing last broadcast fails even when most others match", () => {
    const platform = weekly(9).map((airDate, i) => ({ index: i + 1, airDate }));
    const result = evaluateVarietyDateEvidence(catalog, platform);
    expect(result).toMatchObject({ pass: false, matched: 9, missingSamples: [10] });
  });

  test("no catalog dates is no evidence", () => {
    expect(evaluateVarietyDateEvidence([{ episode: 1, airDate: null }], []).pass).toBe(false);
  });

  test("extras are recognized by title", () => {
    expect(isVarietyExtra({ index: 1, title: "第3期加更" })).toBe(true);
    expect(isVarietyExtra({ index: 1, title: "第3期上" })).toBe(false);
  });
});
