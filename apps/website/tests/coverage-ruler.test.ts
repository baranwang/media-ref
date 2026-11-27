import { expect, test } from "vite-plus/test";
import { computeRulerTicks } from "../src/components/coverage-bar.tsx";

test("ruler keeps long series readable (#126)", () => {
  const labels = computeRulerTicks(1155, "episode").map((t) => t.label);
  expect(labels).toEqual([
    "E1",
    "100",
    "200",
    "300",
    "400",
    "500",
    "600",
    "700",
    "800",
    "900",
    "1000",
    "1155",
  ]);
});

test("ruler keeps the existing steps for short series", () => {
  expect(computeRulerTicks(24, "episode").map((t) => t.label)).toEqual([
    "E1",
    "5",
    "10",
    "15",
    "20",
    "24",
  ]);
});
