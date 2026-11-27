import type { Message, MessageBatch } from "@cloudflare/workers-types";
import type { Namespace, SegmentInput } from "@media-ref/client";
import {
  createChangeRequest,
  createDefaultAdapterRegistry,
  createLiveOutboundClient,
  type JobQueueMessage,
} from "@media-ref/core";
import { createTestDb } from "@media-ref/db/testing";
import { writeFileSync } from "node:fs";
import { afterAll, describe, expect, test } from "vite-plus/test";
import { createBackgroundWorker } from "../src/index.ts";
import cases from "./fixtures/review-agent-eval.json" with { type: "json" };

// Review agent evaluation (#78, ADR 0003): each labeled case goes through the real pipeline,
// submit → evidence check → review agent, against live platforms, TMDB and a real model, in a
// fresh local test database (production is never touched). Skipped unless asked for:
//
//   REVIEW_AGENT_EVAL=1 TMDB_ACCESS_TOKEN=… bunx vp test --run tests/review-agent.eval.test.ts
//
// Optional: REVIEW_AGENT_EVAL_MAGPIE (default http://127.0.0.1:3425, an OpenAI-compatible magpie),
// REVIEW_AGENT_EVAL_MODEL (default group/cheap-first, as in production),
// REVIEW_AGENT_EVAL_OUT (a JSON file for the per-case results), REVIEW_AGENT_EVAL_ONLY (case ids).

interface EvalCase {
  id: string;
  label: "accept" | "reject";
  kind: string;
  targetExternalKey: string;
  namespace: Namespace;
  nativeId: string;
  segments: Array<{
    season: number;
    episodeStart: number;
    episodeEnd: number | null;
    targetEpisodeStart: number;
  }>;
  note: string;
  /** For a wrong submission the agent can correct: the season (and segments) it should give. */
  expectedCorrection?: { season: number; segments?: unknown[] };
}

interface EvalResult {
  id: string;
  label: EvalCase["label"];
  kind: string;
  /** Where the request ended: approved / rejected, or unfinished (e.g. waiting on a retry). */
  outcome: "approved" | "rejected" | "unfinished" | "submit_refused";
  correct: boolean;
  /** For cases with an expected correction: whether the agent gave that one. */
  correctionMatched: boolean | null;
  gate: string | null;
  conflicts: string[];
  verdict: string | null;
  fallback: string | null;
  correction: unknown;
  opinion: string | null;
  tokens: number;
  ms: number;
  error?: string;
}

const enabled = Boolean(process.env.REVIEW_AGENT_EVAL);
const only = process.env.REVIEW_AGENT_EVAL_ONLY?.split(",").map((s) => s.trim());
const selected = (cases as EvalCase[]).filter((c) => !only || only.includes(c.id));
const results: EvalResult[] = [];

function queueBatch(body: JobQueueMessage): MessageBatch<JobQueueMessage> {
  const message: Message<JobQueueMessage> = {
    id: `eval-${body.jobId}-${body.leaseGeneration}`,
    timestamp: new Date(),
    body,
    attempts: 1,
    ack() {},
    retry() {},
  };
  return {
    queue: "media-ref-jobs",
    messages: [message],
    metadata: { metrics: { backlogCount: 1, backlogBytes: 0 } },
    ackAll() {},
    retryAll() {},
  };
}

function liveOutbound() {
  const origin = process.env.REVIEW_AGENT_EVAL_MAGPIE ?? "http://127.0.0.1:3425";
  return createLiveOutboundClient({
    // The worker reaches magpie through the HK binding; here the same requests go to a local one.
    magpie: {
      apiKey: process.env.REVIEW_AGENT_EVAL_MAGPIE_KEY ?? "local",
      fetcher: { fetch: (url, init) => fetch(url.replace(/^http:\/\/magpie/, origin), init) },
    },
  });
}

/** Whether the agent's correction is the one the case expects (season, and segments if given). */
function matchesCorrection(expected: EvalCase["expectedCorrection"], got: unknown): boolean {
  const g = got as { season?: number; segments?: Array<Record<string, unknown>> } | null;
  if (!expected || !g || g.season !== expected.season) {
    return false;
  }
  if (!expected.segments) {
    return true;
  }
  const key = (s: Record<string, unknown>) =>
    [s.season, s.episodeStart, s.episodeEnd ?? null, s.targetEpisodeStart].join(":");
  const want = (expected.segments as Array<Record<string, unknown>>).map(key).join();
  // An open end and the season's last episode mean the same here.
  return [want, want.replace(/:12:8$/, "::8")].includes((g.segments ?? []).map(key).join());
}

async function runCase(c: EvalCase): Promise<EvalResult> {
  const started = Date.now();
  const testDb = await createTestDb();
  try {
    const outbound = liveOutbound();
    const adapterRegistry = createDefaultAdapterRegistry();
    const accessToken = process.env.TMDB_ACCESS_TOKEN;
    const emitted: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      adapterRegistry,
      queue: { send: async (message) => void emitted.push(message) },
      config: {
        enableDailyTmdbSync: false,
        enableExplorationScheduling: false,
        tmdb: { accessToken },
        catalog: { tmdb: { accessToken } },
        reviewAgent: {
          dailyBudget: 1000,
          model: process.env.REVIEW_AGENT_EVAL_MODEL ?? "group/cheap-first",
        },
      },
    });

    await testDb.writeDb
      .insertInto("user")
      .values({
        id: "eval-submitter",
        name: "Eval",
        email: "eval@example.test",
        emailVerified: true,
        image: null,
        role: "user",
        reputation: 0,
      })
      .execute();
    let crId: string;
    try {
      const cr = await createChangeRequest(
        testDb.writeDb,
        {
          submitterUserId: "eval-submitter",
          submitterType: "human",
          targetExternalKey: c.targetExternalKey,
          namespace: c.namespace,
          nativeId: c.nativeId,
          variantDescription: "原声",
          setDefaultVariant: true,
          segments: c.segments.map((s): SegmentInput => ({ ...s, baseline: "tmdb" })),
        },
        { adapterRegistry, outbound },
      );
      crId = cr.id;
    } catch (error) {
      // Refused at submission: nothing goes live, which counts as a rejection.
      return {
        id: c.id,
        label: c.label,
        kind: c.kind,
        outcome: "submit_refused",
        correct: c.label === "reject",
        correctionMatched: c.expectedCorrection ? false : null,
        gate: null,
        conflicts: [],
        verdict: null,
        fallback: null,
        correction: null,
        opinion: null,
        tokens: 0,
        ms: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    // Evidence check, then the review (and nothing after it, with exploration off).
    for (let tick = 0; tick < 6; tick += 1) {
      emitted.length = 0;
      await worker.scheduled({ scheduledTime: Date.now(), cron: "* * * * *", noRetry() {} });
      if (emitted.length === 0) {
        break;
      }
      for (const message of emitted) {
        await worker.queue(queueBatch(message));
      }
    }

    const cr = await testDb.readDb
      .selectFrom("change_requests")
      .select(["status", "evidence"])
      .where("id", "=", crId)
      .executeTakeFirstOrThrow();
    const evidence = (cr.evidence ?? {}) as Record<string, any>;
    const agent = (evidence.reviewAgent ?? null) as Record<string, any> | null;
    const budget = await testDb.readDb
      .selectFrom("exploration_daily_budget")
      .select("tokens_used")
      .executeTakeFirst();
    const outcome = cr.status === "approved" || cr.status === "rejected" ? cr.status : "unfinished";
    return {
      id: c.id,
      label: c.label,
      kind: c.kind,
      outcome,
      correct: outcome === (c.label === "accept" ? "approved" : "rejected"),
      correctionMatched: c.expectedCorrection
        ? matchesCorrection(c.expectedCorrection, agent?.correction)
        : null,
      gate: evidence.gate?.decision ?? null,
      conflicts: [
        ...new Set<string>((evidence.gate?.conflicts ?? []).map((x: { code: string }) => x.code)),
      ],
      verdict: agent?.verdict ?? null,
      fallback: agent?.fallback ?? null,
      correction: agent?.correction ?? null,
      opinion: agent?.opinion ?? null,
      tokens: Number(budget?.tokens_used ?? 0),
      ms: Date.now() - started,
    };
  } finally {
    await testDb.cleanup();
  }
}

describe.skipIf(!enabled)("review agent evaluation (#78)", () => {
  afterAll(() => {
    const out = process.env.REVIEW_AGENT_EVAL_OUT;
    if (out) {
      writeFileSync(out, JSON.stringify(results, null, 2));
    }
    const count = (f: (r: EvalResult) => boolean) => results.filter(f).length;
    console.log(
      [
        `cases ${results.length}, correct ${count((r) => r.correct)}`,
        `false accepts (wrong mapping went live) ${count((r) => r.label === "reject" && r.outcome === "approved")}`,
        `false rejects ${count((r) => r.label === "accept" && r.outcome === "rejected")}`,
        `unfinished ${count((r) => r.outcome === "unfinished")}`,
        `corrections matched ${count((r) => r.correctionMatched === true)}/${count((r) => r.correctionMatched !== null)}`,
        `tokens ${results.reduce((n, r) => n + r.tokens, 0)}`,
      ].join("\n"),
    );
  });

  test.each(selected)(
    "$id ($kind, expect $label)",
    async (c) => {
      const result = await runCase(c);
      results.push(result);
      // The run records every outcome; it only fails on a broken pipeline, not a wrong verdict.
      expect(result.outcome).not.toBe("unfinished");
    },
    600_000,
  );
});
