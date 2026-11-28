import { expect, test } from "vite-plus/test";
import { highlightLine } from "../src/lib/code-highlight.ts";

test("string values are accented, JSON keys stay plain", () => {
  expect(highlightLine(`  "ref": { "type": "MEDIA_TYPE_TV", "id": 95479 },`)).toEqual([
    { text: `  "ref": { "type": `, kind: "plain" },
    { text: `"MEDIA_TYPE_TV"`, kind: "string" },
    { text: `, "id": 95479 },`, kind: "plain" },
  ]);
});

test("a header string with a colon inside is still a value", () => {
  expect(highlightLine(`  -H "Authorization: Bearer $KEY" \\`)).toEqual([
    { text: "  -H ", kind: "plain" },
    { text: `"Authorization: Bearer $KEY"`, kind: "string" },
    { text: " \\", kind: "plain" },
  ]);
});

test("escaped quotes stay inside one string", () => {
  expect(highlightLine(`x("a\\"b")`).map((t) => t.kind)).toEqual(["plain", "string", "plain"]);
});

test("comment lines are muted whole", () => {
  expect(highlightLine(`// ep.kind 是 "mapped"`)).toEqual([
    { text: `// ep.kind 是 "mapped"`, kind: "comment" },
  ]);
  expect(highlightLine(`# 查第 1 季`)[0]?.kind).toBe("comment");
});
