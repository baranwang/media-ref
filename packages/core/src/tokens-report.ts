/**
 * Exploration agent model usage, submitted to tokens.ci as client "pi" on its own device
 * "MediaRef" (same payload as douban-bridge's agent-match report).
 *
 * tokens.ci keeps the latest value per device, day and client (a smaller one is rejected as a
 * regression), so every submission carries the day's running total. That total lives on the day's
 * `exploration_daily_budget` row (`pi_usage`, per model); earlier days are already on tokens.ci.
 * shortcut: days are UTC (the budget row's day), so 00:00–08:00 Asia/Singapore lands on the
 * previous tokens.ci day; give pi_usage its own day key if that split matters.
 */

import type { Db } from "@media-ref/db";
import type { ModelInvocationResponse, OutboundClient } from "./outbound.ts";

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

/** `pi_usage` on the budget row: model → totals. */
export type PiUsageTotals = Record<string, Omit<PiUsageBucket, "model">>;

function whole(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), Number.MAX_SAFE_INTEGER) : 0;
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

// shortcut: cost is reported as 0 (magpie returns no price); add per-model pricing if cost matters.
/** One day's tokens.ci submission. */
export function buildPiSubmission(date: string, totals: PiUsageTotals, now: Date) {
  const clients = Object.entries(totals)
    .map(([model, t]) => ({
      client: "pi" as const,
      modelId: model,
      tokens: {
        input: whole(t.input),
        output: whole(t.output),
        cacheRead: whole(t.cacheRead),
        cacheWrite: whole(t.cacheWrite),
        reasoning: 0,
      },
      cost: 0,
      messages: whole(t.messages),
    }))
    .filter((c) => c.tokens.input + c.tokens.output + c.tokens.cacheRead + c.tokens.cacheWrite > 0)
    .sort((a, b) => a.modelId.localeCompare(b.modelId));
  if (clients.length === 0) {
    return undefined;
  }
  const sum = (key: "input" | "output" | "cacheRead" | "cacheWrite") =>
    clients.reduce((n, c) => n + c.tokens[key], 0);
  const tokens = {
    input: sum("input"),
    output: sum("output"),
    cacheRead: sum("cacheRead"),
    cacheWrite: sum("cacheWrite"),
    reasoning: 0,
  };
  const totalTokens = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  const messages = clients.reduce((n, c) => n + c.messages, 0);
  return {
    meta: {
      generatedAt: now.toISOString(),
      version: "media-ref",
      dateRange: { start: date, end: date },
    },
    device: { id: TOKENS_DEVICE_ID, name: TOKENS_DEVICE_NAME },
    summary: {
      totalTokens,
      totalCost: 0,
      totalDays: 1,
      activeDays: 1,
      averagePerDay: totalTokens,
      maxCostInSingleDay: 0,
      clients: ["pi"],
      models: clients.map((c) => c.modelId),
    },
    years: [
      { year: date.slice(0, 4), totalTokens, totalCost: 0, range: { start: date, end: date } },
    ],
    contributions: [
      {
        date,
        totals: { tokens: totalTokens, cost: 0, messages },
        intensity: 1,
        tokenBreakdown: tokens,
        clients,
      },
    ],
  };
}

/**
 * Adds one session's usage to the day's totals and, with a token, submits that day to tokens.ci.
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
    const date = options.now.toISOString().slice(0, 10);
    // Row lock: concurrent sessions must not overwrite each other's additions.
    const totals = await db.transaction().execute(async (trx) => {
      await trx
        .insertInto("exploration_daily_budget")
        .values({ budget_date: date, consumed: 0, updated_at: options.now })
        .onConflict((oc) => oc.column("budget_date").doNothing())
        .execute();
      const row = await trx
        .selectFrom("exploration_daily_budget")
        .select("pi_usage")
        .where("budget_date", "=", date)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const merged = { ...(row.pi_usage as PiUsageTotals) };
      for (const e of entries) {
        const t = merged[e.model] ?? {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          messages: 0,
        };
        merged[e.model] = {
          input: whole(t.input) + e.input,
          output: whole(t.output) + e.output,
          cacheRead: whole(t.cacheRead) + e.cacheRead,
          cacheWrite: whole(t.cacheWrite) + e.cacheWrite,
          messages: whole(t.messages) + e.messages,
        };
      }
      await trx
        .updateTable("exploration_daily_budget")
        .set({ pi_usage: JSON.stringify(merged), updated_at: options.now })
        .where("budget_date", "=", date)
        .execute();
      return merged;
    });
    if (!options.token) {
      return;
    }
    const payload = buildPiSubmission(date, totals, options.now);
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
