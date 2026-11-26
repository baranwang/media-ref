/**
 * Exploration agent model usage, submitted to tokens.ci as client "pi" on its own device
 * "MediaRef" (same format as douban-bridge's agent-match report).
 *
 * Usage is summed per tokens.ci day and model in `pi_token_usage`, and the whole history is
 * submitted each time, so a retried or lost submission never double-counts.
 */

import { sql } from "kysely";
import type { Db } from "@media-ref/db";
import type { ModelInvocationResponse, OutboundClient } from "./outbound.ts";

// shortcut: day buckets follow the tokens.ci account's time zone (Asia/Singapore); change with it.
const TOKENS_DAY_TIME_ZONE = "Asia/Singapore";
const TOKENS_SUBMIT_URL = "https://tokens.ci/api/submit";
// A device of its own, so this never replaces what the laptop CLI or douban-bridge submitted.
const TOKENS_DEVICE_ID = "dev_1c17a68e84f942955ffbc1db2d2e5c0c";
const TOKENS_DEVICE_NAME = "MediaRef";

export interface PiUsageBucket {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  messages: number;
}

interface StoredPiUsage {
  day: string;
  model: string;
  input: string;
  output: string;
  cache_read: string;
  cache_write: string;
  messages: string;
}

function whole(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), Number.MAX_SAFE_INTEGER) : 0;
}

export function tokensDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TOKENS_DAY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Adds one model response to the per-model totals. */
export function addPiUsage(
  buckets: Map<string, PiUsageBucket>,
  response: ModelInvocationResponse,
): void {
  const u = response.usage;
  const input = whole(u?.inputTokens);
  const output = whole(u?.outputTokens);
  const cacheRead = whole(u?.cacheReadTokens);
  const cacheWrite = whole(u?.cacheWriteTokens);
  if (input + output + cacheRead + cacheWrite === 0) {
    return;
  }
  const model = response.model.trim() || "unknown";
  const b = buckets.get(model) ?? {
    model,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    messages: 0,
  };
  b.input += input;
  b.output += output;
  b.cacheRead += cacheRead;
  b.cacheWrite += cacheWrite;
  b.messages += 1;
  buckets.set(model, b);
}

type Tokens = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: 0;
};
const total = (t: Tokens) => t.input + t.output + t.cacheRead + t.cacheWrite;

// shortcut: cost is reported as 0 (magpie returns no price); add per-model pricing if cost matters.
export function buildPiSubmission(rows: readonly StoredPiUsage[], now: Date) {
  const days = new Map<
    string,
    {
      tokens: Tokens;
      messages: number;
      clients: Array<{ model: string; tokens: Tokens; messages: number }>;
    }
  >();
  for (const row of rows) {
    const tokens: Tokens = {
      input: whole(row.input),
      output: whole(row.output),
      cacheRead: whole(row.cache_read),
      cacheWrite: whole(row.cache_write),
      reasoning: 0,
    };
    if (total(tokens) === 0) {
      continue;
    }
    const day = days.get(row.day) ?? {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      messages: 0,
      clients: [],
    };
    day.tokens.input += tokens.input;
    day.tokens.output += tokens.output;
    day.tokens.cacheRead += tokens.cacheRead;
    day.tokens.cacheWrite += tokens.cacheWrite;
    day.messages += whole(row.messages);
    day.clients.push({ model: row.model || "unknown", tokens, messages: whole(row.messages) });
    days.set(row.day, day);
  }
  const dates = [...days.keys()].sort();
  if (dates.length === 0) {
    return undefined;
  }

  const contributions = dates.map((date) => {
    const day = days.get(date)!;
    return {
      date,
      totals: { tokens: total(day.tokens), cost: 0, messages: day.messages },
      intensity: 1,
      tokenBreakdown: day.tokens,
      clients: day.clients.map((c) => ({
        client: "pi" as const,
        modelId: c.model,
        tokens: c.tokens,
        cost: 0,
        messages: c.messages,
      })),
    };
  });
  const totalTokens = contributions.reduce((sum, d) => sum + d.totals.tokens, 0);
  const years = [...new Set(dates.map((d) => d.slice(0, 4)))].map((year) => {
    const yearDays = contributions.filter((d) => d.date.startsWith(year));
    return {
      year,
      totalTokens: yearDays.reduce((sum, d) => sum + d.totals.tokens, 0),
      totalCost: 0,
      range: { start: yearDays[0]!.date, end: yearDays[yearDays.length - 1]!.date },
    };
  });

  return {
    meta: {
      generatedAt: now.toISOString(),
      version: "media-ref",
      dateRange: { start: dates[0]!, end: dates[dates.length - 1]! },
    },
    device: { id: TOKENS_DEVICE_ID, name: TOKENS_DEVICE_NAME },
    summary: {
      totalTokens,
      totalCost: 0,
      totalDays: contributions.length,
      activeDays: contributions.length,
      averagePerDay: totalTokens / contributions.length,
      maxCostInSingleDay: 0,
      clients: ["pi"],
      models: [...new Set(contributions.flatMap((d) => d.clients.map((c) => c.modelId)))].sort(),
    },
    years,
    contributions,
  };
}

/**
 * Stores one session's usage and, with a token, submits the full history to tokens.ci.
 * Never throws: a failed report must not fail the exploration job.
 */
export async function reportPiUsage(
  db: Db,
  outbound: OutboundClient,
  entries: readonly PiUsageBucket[],
  options: { now: Date; token?: string },
): Promise<void> {
  if (entries.length === 0) {
    return;
  }
  try {
    const day = tokensDay(options.now);
    for (const e of entries) {
      await db
        .insertInto("pi_token_usage")
        .values({
          day,
          model: e.model,
          input: String(e.input),
          output: String(e.output),
          cache_read: String(e.cacheRead),
          cache_write: String(e.cacheWrite),
          messages: String(e.messages),
        })
        .onConflict((oc) =>
          oc.columns(["day", "model"]).doUpdateSet({
            input: sql`pi_token_usage.input + excluded.input`,
            output: sql`pi_token_usage.output + excluded.output`,
            cache_read: sql`pi_token_usage.cache_read + excluded.cache_read`,
            cache_write: sql`pi_token_usage.cache_write + excluded.cache_write`,
            messages: sql`pi_token_usage.messages + excluded.messages`,
          }),
        )
        .execute();
    }
    if (!options.token) {
      return;
    }
    const rows = await db
      .selectFrom("pi_token_usage")
      .selectAll()
      .orderBy("day")
      .orderBy("model")
      .execute();
    const payload = buildPiSubmission(rows, options.now);
    if (!payload) {
      return;
    }
    const response = await outbound.fetchExternal({
      kind: "platform",
      namespace: "tokens.ci",
      url: TOKENS_SUBMIT_URL,
      method: "POST",
      headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
      timeoutMs: 10_000,
    });
    if (response.status < 200 || response.status >= 300) {
      console.warn("exploration", { event: "tokens_report_failed", status: response.status });
    }
  } catch (error) {
    console.warn("exploration", {
      event: "tokens_report_failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
