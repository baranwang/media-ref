import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecutionContext } from "@cloudflare/workers-types";
import { describe, expect, test } from "vite-plus/test";
import workerDefault, { type BackgroundWorkerEnv } from "../src/index.ts";

function readBooleanFlag(name: string): boolean | undefined {
  const path = resolve(dirname(fileURLToPath(import.meta.url)), "../wrangler.jsonc");
  const source = readFileSync(path, "utf8");
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const match = withoutComments.match(new RegExp(`"${name}"\\s*:\\s*(true|false)\\b`));
  if (!match?.[1]) {
    return undefined;
  }
  return match[1] === "true";
}

describe("background worker HTTP surface", () => {
  test("workers.dev and version URLs are disabled", () => {
    expect(readBooleanFlag("workers_dev")).toBe(false);
    expect(readBooleanFlag("preview_urls")).toBe(false);
  });

  test("an HTTP request is a 404 and does not read bindings", async () => {
    const env = new Proxy({} as BackgroundWorkerEnv, {
      get() {
        throw new Error("fetch handler read env");
      },
    });
    const response = await workerDefault.fetch(
      new Request("https://media-ref-worker.example/"),
      env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });
});
