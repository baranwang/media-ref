/**
 * Public read of what the exploration agent is doing (the website's 探索动态 page).
 *
 * Reads exploration jobs from `background_jobs` and the change requests they produced. Nothing here
 * names the API caller behind a demand: only the media, the platforms and the outcome.
 */

import { sql } from "kysely";
import type { Db } from "@media-ref/db";
import { EXPLORATION_JOB_TYPE } from "./exploration-scheduler.ts";

export type ExplorationResultStatus =
  | "approved"
  | "in_review"
  | "rejected"
  | "not_found"
  | "retry"
  | "searching";

export interface ExplorationPlatformResult {
  namespace: string;
  status: ExplorationResultStatus;
  reason: string | null;
  changeRequestId: string | null;
}

export interface ExplorationActivityEntry {
  id: string;
  mediaId: string;
  season: number | null;
  startedAt: Date;
  finishedAt: Date | null;
  platforms: ExplorationPlatformResult[];
}

export interface ExplorationActivitySummary {
  explored: number;
  found: number;
  approved: number;
  inReview: number;
}

export type ExplorationActivityFilter = "all" | "found" | "not_found";

const MAX_REASON_LENGTH = 200;
const SUBMITTED_FILTER = sql<boolean>`result->'platformOutcomes' @> '[{"status":"submitted"}]'::jsonb`;

/** Internal outcome codes → what a visitor reads. */
const REASON_TEXT: Record<string, string> = {
  no_discovery_candidates: "各个来源都没有这部作品",
  candidates_not_on_platform: "找到的链接在平台上已经打不开",
  no_matching_candidate: "找到的合集都不是这部作品",
  max_steps_exhausted: "查了很多地方，没有找到",
  token_budget_exhausted: "查了很多地方，没有找到",
  discovery_source_error: "有来源暂时打不开，稍后再找",
  exploration_time_budget_exceeded: "这次时间用完了，稍后再找",
  model_finished_without_decision: "这次没有得出结论，稍后再找",
  youku_captcha_challenge: "平台要求验证码，稍后再找",
  imdb_not_on_tmdb: "TMDB 上没有这个 IMDb 编号",
  ambiguous_tmdb_find: "TMDB 上有多个可能的条目，没法确定",
  tmdb_imdb_mismatch: "TMDB 条目的 IMDb 编号对不上",
  tmdb_id_on_other_media: "这个 TMDB 编号已经属于另一部作品",
};

function reasonText(status: ExplorationResultStatus, raw: unknown): string | null {
  const code = typeof raw === "string" ? raw.trim() : "";
  const known = REASON_TEXT[code] ?? REASON_TEXT[code.split(":")[0] ?? ""];
  if (known) {
    return known;
  }
  // A transient reason is an internal error message (HTTP, model gateway): never shown as is.
  if (status === "retry") {
    return "暂时出了问题，稍后再找";
  }
  // The agent's own words, unless it is another snake_case code.
  if (status === "not_found" && code && !/^[a-z0-9_:.-]+$/i.test(code)) {
    return code.length > MAX_REASON_LENGTH ? `${code.slice(0, MAX_REASON_LENGTH - 1)}…` : code;
  }
  return status === "not_found" ? "没有找到" : null;
}

interface RawOutcome {
  namespace?: unknown;
  status?: unknown;
  reason?: unknown;
  changeRequestId?: unknown;
  directWrite?: unknown;
}

function crStatus(status: string | undefined): ExplorationResultStatus {
  return status === "approved" ? "approved" : status === "rejected" ? "rejected" : "in_review";
}

export async function listExplorationActivity(
  db: Db,
  options: {
    now: Date;
    limit: number;
    before?: Date | null;
    filter?: ExplorationActivityFilter;
    /** Running jobs and the 24-hour summary are read for the first page only. */
    includeLive?: boolean;
  },
): Promise<{
  running: ExplorationActivityEntry[];
  recent: ExplorationActivityEntry[];
  summary: ExplorationActivitySummary | null;
  nextBefore: Date | null;
}> {
  const filter = options.filter ?? "all";
  // shortcut: the cursor is the finish time alone; jobs finishing in the same millisecond at a
  // page edge can be skipped. Add the id to the cursor if that ever shows.
  let recentQuery = db
    .selectFrom("background_jobs")
    .select(["id", "payload", "result", "leased_at", "created_at", "completed_at"])
    .where("job_type", "=", EXPLORATION_JOB_TYPE)
    .where("status", "=", "completed")
    .where("completed_at", "is not", null)
    .where(sql<boolean>`result ? 'platformOutcomes'`)
    .orderBy("completed_at", "desc")
    .orderBy("id", "desc")
    .limit(options.limit + 1);
  if (options.before) {
    recentQuery = recentQuery.where("completed_at", "<", options.before);
  }
  if (filter === "found") {
    recentQuery = recentQuery.where(SUBMITTED_FILTER);
  } else if (filter === "not_found") {
    recentQuery = recentQuery.where(sql<boolean>`not (${SUBMITTED_FILTER})`);
  }
  const recentRows = await recentQuery.execute();
  const page = recentRows.slice(0, options.limit);

  const runningRows = options.includeLive
    ? await db
        .selectFrom("background_jobs")
        .select(["id", "payload", "result", "leased_at", "created_at", "completed_at"])
        .where("job_type", "=", EXPLORATION_JOB_TYPE)
        .where("status", "=", "leased")
        .where("lease_expires_at", ">", options.now)
        .orderBy("leased_at", "desc")
        .limit(5)
        .execute()
    : [];

  const crIds = page.flatMap((row) =>
    ((row.result?.platformOutcomes ?? []) as RawOutcome[]).flatMap((o) =>
      typeof o.changeRequestId === "string" ? [o.changeRequestId] : [],
    ),
  );
  const crStatuses = new Map(
    crIds.length === 0
      ? []
      : (
          await db
            .selectFrom("change_requests")
            .select(["id", "status"])
            .where("id", "in", crIds)
            .execute()
        ).map((r) => [r.id, r.status as string]),
  );

  const toEntry = (
    row: (typeof page)[number],
    running: boolean,
  ): ExplorationActivityEntry | null => {
    const payload = row.payload as {
      mediaId?: unknown;
      season?: unknown;
      targetNamespaces?: unknown;
    };
    const mediaId =
      typeof row.result?.mediaId === "string"
        ? row.result.mediaId
        : typeof payload.mediaId === "string"
          ? payload.mediaId
          : null;
    if (!mediaId) {
      return null;
    }
    const season = typeof payload.season === "number" ? payload.season : null;
    const platforms: ExplorationPlatformResult[] = running
      ? (Array.isArray(payload.targetNamespaces) ? payload.targetNamespaces : [])
          .filter((ns): ns is string => typeof ns === "string")
          .map((namespace) => ({
            namespace,
            status: "searching",
            reason: null,
            changeRequestId: null,
          }))
      : ((row.result?.platformOutcomes ?? []) as RawOutcome[]).flatMap((o) => {
          if (typeof o.namespace !== "string") {
            return [];
          }
          const crId = typeof o.changeRequestId === "string" ? o.changeRequestId : null;
          const status: ExplorationResultStatus =
            o.status === "submitted"
              ? o.directWrite === true
                ? "approved"
                : crStatus(crId ? crStatuses.get(crId) : undefined)
              : o.status === "not_found"
                ? "not_found"
                : "retry";
          return [
            {
              namespace: o.namespace,
              status,
              reason: reasonText(status, o.reason),
              changeRequestId: crId,
            },
          ];
        });
    return {
      id: row.id,
      mediaId,
      season,
      startedAt: row.leased_at ?? row.created_at,
      finishedAt: running ? null : row.completed_at,
      platforms,
    };
  };

  let summary: ExplorationActivitySummary | null = null;
  if (options.includeLive) {
    const since = new Date(options.now.getTime() - 24 * 60 * 60 * 1000);
    const jobs = await db
      .selectFrom("background_jobs")
      .select([
        sql<string>`count(*)`.as("explored"),
        sql<string>`count(*) filter (where ${SUBMITTED_FILTER})`.as("found"),
      ])
      .where("job_type", "=", EXPLORATION_JOB_TYPE)
      .where("status", "=", "completed")
      .where("completed_at", ">=", since)
      .where(sql<boolean>`result ? 'platformOutcomes'`)
      .executeTakeFirstOrThrow();
    const crs = await db
      .selectFrom("change_requests")
      .select([
        sql<string>`count(*) filter (where status = 'approved')`.as("approved"),
        sql<string>`count(*) filter (where status in ('pending_evidence', 'needs_review'))`.as(
          "in_review",
        ),
      ])
      .where("submitter_type", "=", "agent")
      .where("created_at", ">=", since)
      .executeTakeFirstOrThrow();
    summary = {
      explored: Number(jobs.explored),
      found: Number(jobs.found),
      approved: Number(crs.approved),
      inReview: Number(crs.in_review),
    };
  }

  return {
    running: runningRows.flatMap((r) => toEntry(r, true) ?? []),
    recent: page.flatMap((r) => toEntry(r, false) ?? []),
    summary,
    nextBefore: recentRows.length > options.limit ? (page.at(-1)?.completed_at ?? null) : null,
  };
}
