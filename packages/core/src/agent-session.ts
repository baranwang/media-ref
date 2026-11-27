/**
 * One model session with query tools and conclusion tools, shared by the exploration agent
 * (ADR 0002) and the review agent (ADR 0003): a wall-clock, step and token budget, a wrap-up phase
 * that leaves only the conclusion tools, and per-model token totals. What a conclusion does, and
 * what an unfinished session means, stays with the caller.
 */

import { QUERY_TOOL_NAMES } from "./exploration-tools.ts";
import {
  combineAbortSignals,
  raceWithAbortSignal,
  type ModelMessage,
  type ModelToolCall,
  type ModelToolDefinition,
  type OutboundClient,
} from "./outbound.ts";
import { addPiUsage, type PiUsageBucket } from "./tokens-report.ts";

export const BUDGET_EXCEEDED = "exploration_time_budget_exceeded";
/**
 * The session switches to wrap-up (conclusions only, no more searching) once this share of the
 * time or token budget is left, or this many steps: an unfinished session otherwise ends without
 * a conclusion and its searching was for nothing.
 */
const WRAP_UP_REMAINING_SHARE = 0.25;
const WRAP_UP_STEPS = 3;
const TIME_UP_REPLY = { error: "TIME_UP", message: "No time left for searching." };

export interface SessionBudget {
  outbound: OutboundClient;
  signal: AbortSignal;
  expired(): boolean;
  remainingMs(): number;
  dispose(): void;
}

/** An outbound client whose calls all end when the deadline passes. */
export function createSessionBudget(
  outbound: OutboundClient,
  deadlineMs: number,
  clockMs: () => number,
): SessionBudget {
  const controller = new AbortController();
  const remainingMs = Math.max(0, deadlineMs - clockMs());
  const timer =
    remainingMs > 0
      ? setTimeout(() => controller.abort(new Error(BUDGET_EXCEEDED)), remainingMs)
      : undefined;
  if (remainingMs <= 0) {
    controller.abort(new Error(BUDGET_EXCEEDED));
  }
  const signal = controller.signal;
  return {
    signal,
    expired: () => signal.aborted || clockMs() >= deadlineMs,
    remainingMs: () => (signal.aborted ? 0 : Math.max(0, deadlineMs - clockMs())),
    dispose: () => clearTimeout(timer),
    outbound: {
      fetchExternal: (request) =>
        raceWithAbortSignal(
          outbound.fetchExternal({
            ...request,
            signal: combineAbortSignals(signal, request.timeoutMs),
          }),
          signal,
          BUDGET_EXCEEDED,
        ),
      sendEmail: (message) => outbound.sendEmail(message),
      ...(outbound.callWebTool
        ? {
            callWebTool: (name, args, callerSignal) =>
              raceWithAbortSignal(
                outbound.callWebTool!(
                  name,
                  args,
                  callerSignal ? AbortSignal.any([signal, callerSignal]) : signal,
                ),
                signal,
                BUDGET_EXCEEDED,
              ),
          }
        : {}),
      invokeModel: (request) =>
        raceWithAbortSignal(
          outbound.invokeModel({
            ...request,
            signal: combineAbortSignals(signal, request.timeoutMs),
          }),
          signal,
          BUDGET_EXCEEDED,
        ),
    },
  };
}

/** Totals for one agent session. */
export interface SessionUsage {
  tokens: number;
  /** Per routed model, for the tokens.ci report. */
  byModel: Map<string, PiUsageBucket>;
}

export interface SessionModelConfig {
  provider: string;
  model: string;
  gatewayId?: string;
  maxSteps: number;
  maxDurationMs: number;
  temperature: number;
  maxTokens: number;
  maxTaskTokens: number;
  webSearch: boolean;
}

/** Why the loop stopped: `concluded` once `done()` holds, otherwise the session ran out. */
export type SessionStop =
  | { kind: "concluded" }
  | { kind: "time_up" }
  | { kind: "tokens_exhausted" }
  | { kind: "steps_exhausted" }
  | { kind: "no_decision" }
  | { kind: "model_error"; reason: string };

export interface ToolSessionInput {
  budget: SessionBudget;
  config: SessionModelConfig;
  usage: SessionUsage;
  /** System and first user message; the loop appends the conversation. */
  messages: ModelMessage[];
  /** Query tools and conclusion tools, as offered to the model. */
  tools: ModelToolDefinition[];
  conclusionToolNames: ReadonlySet<string>;
  sessionId: string;
  metadata: Record<string, string>;
  runQuery(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** The user message that starts the wrap-up phase. */
  wrapUpMessage(): string;
  /** Reply to a query call during wrap-up. */
  wrapUpRefusal: string;
  /**
   * A query's own result was replied to the model in turn `step` (not a TIME_UP or wrap-up
   * refusal): the model sees it from turn `step + 1` on.
   */
  onQueryReplied?(call: ModelToolCall, result: unknown, step: number): void;
  /** Handles one conclusion call made in turn `step`; returns the tool reply. */
  conclude(call: ModelToolCall, step: number): Promise<unknown>;
  /**
   * When set, a turn with no tool call is answered once with this message and the session goes on
   * with only the conclusion tools; a second such turn ends it as `no_decision`.
   */
  noDecisionNudge?: () => string;
  done(): boolean;
}

export async function runToolSession(input: ToolSessionInput): Promise<SessionStop> {
  const { budget, config, usage, messages, tools } = input;
  const reply = (id: string, name: string, body: unknown) =>
    messages.push({ role: "tool", toolCallId: id, name, content: JSON.stringify(body) });

  let wrappingUp = false;
  let nudged = false;
  const conclusionTools = tools.filter((t) => input.conclusionToolNames.has(t.name));
  // Searching may use the time up to the wrap-up reserve, not beyond: a slow model turn or tool
  // batch started just before wrap-up would otherwise eat the reserve and end in a timeout.
  const searchLeftMs = () => budget.remainingMs() - config.maxDurationMs * WRAP_UP_REMAINING_SHARE;
  for (let step = 0; step < config.maxSteps; step += 1) {
    if (budget.expired()) {
      return { kind: "time_up" };
    }
    if (usage.tokens >= config.maxTaskTokens) {
      return { kind: "tokens_exhausted" };
    }
    if (
      !wrappingUp &&
      (searchLeftMs() <= 0 ||
        config.maxTaskTokens - usage.tokens <= config.maxTaskTokens * WRAP_UP_REMAINING_SHARE ||
        config.maxSteps - step <= WRAP_UP_STEPS)
    ) {
      wrappingUp = true;
      messages.push({ role: "user", content: input.wrapUpMessage() });
    }
    let response;
    try {
      response = await budget.outbound.invokeModel({
        provider: config.provider,
        model: config.model,
        ...(config.gatewayId ? { gatewayId: config.gatewayId } : {}),
        messages: [...messages],
        tools: wrappingUp ? conclusionTools : tools,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        webSearch: config.webSearch && !wrappingUp,
        // One session per job: every turn stays on the same routed model and its prompt cache.
        sessionId: input.sessionId,
        metadata: input.metadata,
        ...(wrappingUp ? {} : { timeoutMs: Math.max(1, searchLeftMs()) }),
      });
    } catch (error) {
      if (!wrappingUp && !budget.expired() && searchLeftMs() <= 0) {
        continue; // The search phase ran out mid-turn: the next step wraps up.
      }
      if (budget.expired()) {
        return { kind: "time_up" }; // The session's own deadline, not an outage.
      }
      return {
        kind: "model_error",
        reason: error instanceof Error ? error.message : "model_invocation_failed",
      };
    }
    const u = response.usage;
    usage.tokens +=
      (u?.inputTokens ?? 0) +
      (u?.outputTokens ?? 0) +
      (u?.cacheReadTokens ?? 0) +
      (u?.cacheWriteTokens ?? 0);
    addPiUsage(usage.byModel, response);

    const toolCalls = response.toolCalls ?? [];
    messages.push({
      role: "assistant",
      content: response.text ?? response.content ?? "",
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    });
    if (toolCalls.length === 0) {
      if (!input.noDecisionNudge || nudged) {
        return { kind: "no_decision" };
      }
      nudged = true;
      wrappingUp = true;
      messages.push({ role: "user", content: input.noDecisionNudge() });
      continue;
    }

    // Query tools of one turn run side by side, bounded by the search phase; conclusions below
    // stay in call order.
    const searchSignal = AbortSignal.any([
      budget.signal,
      AbortSignal.timeout(Math.max(1, searchLeftMs())),
    ]);
    const queryResults = new Map(
      wrappingUp
        ? []
        : toolCalls
            .filter((call) => QUERY_TOOL_NAMES.has(call.name))
            .map((call) => [
              call.id,
              raceWithAbortSignal(
                input.runQuery(call.name, call.arguments ?? {}),
                searchSignal,
                BUDGET_EXCEEDED,
              ).catch(() => TIME_UP_REPLY),
            ]),
    );

    for (const call of toolCalls) {
      if (wrappingUp && !input.conclusionToolNames.has(call.name)) {
        reply(call.id, call.name, { ok: false, error: "WRAP_UP", message: input.wrapUpRefusal });
        continue;
      }
      const pending = queryResults.get(call.id);
      if (pending) {
        // Catalog tools use a TMDB gateway built on the unbudgeted client: the race above still
        // ends a stalled call.
        const result = await pending;
        reply(call.id, call.name, result);
        if (result !== TIME_UP_REPLY) {
          input.onQueryReplied?.(call, result, step);
        }
        if (budget.expired()) {
          return { kind: "time_up" };
        }
        continue;
      }
      if (!input.conclusionToolNames.has(call.name)) {
        reply(call.id, call.name, { ok: false, error: "UNKNOWN_TOOL" });
        continue;
      }
      reply(call.id, call.name, await input.conclude(call, step));
    }
    if (input.done()) {
      return { kind: "concluded" };
    }
  }
  return { kind: "steps_exhausted" };
}
