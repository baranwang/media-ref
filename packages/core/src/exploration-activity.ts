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
  | "covered"
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
  liveChangeRequestId: string | null;
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
  no_imdb_id_for_tmdb_find: "暂时没有对应到 TMDB 条目",
  no_tmdb_candidates: "TMDB 上没有找到匹配的条目",
  tmdb_identity_unverified: "TMDB 上有相似条目，但缺少足够依据确认是同一部作品",
  imdb_not_on_tmdb: "TMDB 上没有这个 IMDb 编号",
  ambiguous_tmdb_find: "TMDB 上有多个可能的条目，没法确定",
  tmdb_imdb_mismatch: "TMDB 条目的 IMDb 编号对不上",
  tmdb_id_on_other_media: "这个 TMDB 编号已经属于另一部作品",
  already_confirmed: "此前已在库中收录",
  both_passed_evidence_gate: "库里已有这个平台的收录",
  locked_association_challenged: "提交的关联与已锁定的记录冲突",
  title_mismatch: "平台片名和资料站对不上",
  year_mismatch: "平台年份和资料站对不上",
  episode_count_mismatch: "平台集数和资料站对不上",
  media_type_mismatch: "平台作品类型和资料站对不上",
  shared_id_conflict: "平台上的外部编号属于另一部作品",
  segment_season_not_found: "提交的季数在平台合集里对不上",
  segment_episode_overflow: "提交的集数范围在平台合集里对不上",
  not_a_gate_conflict: "提交内容和自动核对规则不一致",
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

interface CrSnapshot {
  id: string;
  status: string;
  mediaId: string | null;
  namespace: string;
  nativeId: string;
  conflictReason: string | null;
  decisionReason: string | null;
  evidence: Record<string, unknown> | null;
}

function summarizeRejectedCrReason(cr: CrSnapshot): {
  reason: string | null;
  verdict: string | null;
  isDuplicateGateConflict: boolean;
} {
  const reviewAgent =
    cr.evidence && typeof cr.evidence.reviewAgent === "object" && cr.evidence.reviewAgent !== null
      ? (cr.evidence.reviewAgent as Record<string, unknown>)
      : null;
  const verdict = typeof reviewAgent?.verdict === "string" ? reviewAgent.verdict : null;
  const conflict = cr.conflictReason?.trim() ?? "";
  const isDuplicateGateConflict =
    conflict === "both_passed_evidence_gate" ||
    Boolean(cr.decisionReason?.includes("both_passed_evidence_gate"));

  if (isDuplicateGateConflict) {
    return {
      reason: REASON_TEXT.both_passed_evidence_gate!,
      verdict,
      isDuplicateGateConflict: true,
    };
  }

  if (conflict && REASON_TEXT[conflict]) {
    return { reason: REASON_TEXT[conflict]!, verdict, isDuplicateGateConflict: false };
  }

  const rawDecision = cr.decisionReason?.trim() ?? "";
  const strippedCode = rawDecision.replace(/^无法自动通过[:：]\s*/, "").trim();
  const knownDecision =
    REASON_TEXT[strippedCode] ?? REASON_TEXT[strippedCode.split(":")[0]?.trim() ?? ""];
  if (knownDecision) {
    return { reason: knownDecision, verdict, isDuplicateGateConflict: false };
  }
  return { reason: null, verdict, isDuplicateGateConflict: false };
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
  const crById = new Map<string, CrSnapshot>(
    crIds.length === 0
      ? []
      : (
          await db
            .selectFrom("change_requests")
            .select([
              "id",
              "status",
              "media_id",
              "namespace",
              "native_id",
              "conflict_reason",
              "decision_reason",
              "evidence",
            ])
            .where("id", "in", crIds)
            .execute()
        ).map((r) => [
          r.id,
          {
            id: r.id,
            status: r.status as string,
            mediaId: r.media_id,
            namespace: r.namespace as string,
            nativeId: r.native_id,
            conflictReason: r.conflict_reason,
            decisionReason: r.decision_reason,
            evidence:
              r.evidence && typeof r.evidence === "object" && !Array.isArray(r.evidence)
                ? (r.evidence as Record<string, unknown>)
                : null,
          },
        ]),
  );

  // Batch-load live confirmed associations + approved CRs for any rejected CR on this page, so
  // historical rejected submissions that already went live elsewhere read cleanly without N+1 queries.
  const rejectedMediaIds = new Set<string>();
  const rejectedNamespaces = new Set<string>();
  for (const row of page) {
    const payload = row.payload as { mediaId?: unknown };
    const jobMediaId =
      typeof row.result?.mediaId === "string"
        ? row.result.mediaId
        : typeof payload.mediaId === "string"
          ? payload.mediaId
          : undefined;
    for (const o of (row.result?.platformOutcomes ?? []) as RawOutcome[]) {
      const crId = typeof o.changeRequestId === "string" ? o.changeRequestId : null;
      const cr = crId ? crById.get(crId) : undefined;
      if (o.status === "rejected" || cr?.status === "rejected") {
        const mediaId = cr?.mediaId ?? jobMediaId;
        const ns = cr?.namespace ?? (typeof o.namespace === "string" ? o.namespace : null);
        if (mediaId && ns) {
          rejectedMediaIds.add(mediaId);
          rejectedNamespaces.add(ns);
        }
      }
    }
  }

  interface LiveAssocInfo {
    id: string;
    mediaId: string;
    namespace: string;
    nativeId: string;
    seasons: number[] | null;
    approvedCrId: string | null;
  }
  const liveAssocsByMediaNs = new Map<string, LiveAssocInfo[]>();
  if (rejectedMediaIds.size > 0 && rejectedNamespaces.size > 0) {
    const confirmedAssocs = await db
      .selectFrom("associations")
      .select(["id", "media_id", "namespace", "native_id"])
      .where("is_external_id", "=", false)
      .where("status", "=", "confirmed")
      .where("media_id", "in", [...rejectedMediaIds])
      .where("namespace", "in", [...rejectedNamespaces] as never)
      .execute();

    if (confirmedAssocs.length > 0) {
      const assocIds = confirmedAssocs.map((a) => a.id);
      const [segRows, approvedCrRows] = await Promise.all([
        db
          .selectFrom("segments")
          .select(["association_id", "season"])
          .where("association_id", "in", assocIds)
          .execute(),
        db
          .selectFrom("change_requests")
          .select(["id", "applied_association_id", "reviewed_at"])
          .where("status", "=", "approved")
          .where("applied_association_id", "in", assocIds)
          .orderBy("reviewed_at", "desc")
          .execute(),
      ]);

      const seasonsByAssoc = new Map<string, number[]>();
      for (const s of segRows) {
        const list = seasonsByAssoc.get(s.association_id) ?? [];
        list.push(s.season);
        seasonsByAssoc.set(s.association_id, list);
      }

      const approvedCrByAssoc = new Map<string, string>();
      for (const c of approvedCrRows) {
        if (c.applied_association_id && !approvedCrByAssoc.has(c.applied_association_id)) {
          approvedCrByAssoc.set(c.applied_association_id, c.id);
        }
      }

      for (const a of confirmedAssocs) {
        const key = `${a.media_id}:${a.namespace}`;
        const list = liveAssocsByMediaNs.get(key) ?? [];
        list.push({
          id: a.id,
          mediaId: a.media_id,
          namespace: a.namespace,
          nativeId: a.native_id,
          seasons: seasonsByAssoc.get(a.id) ?? null,
          approvedCrId: approvedCrByAssoc.get(a.id) ?? null,
        });
        liveAssocsByMediaNs.set(key, list);
      }
    }
  }

  const findLiveCoverage = (
    mediaId: string,
    namespace: string,
    crNativeId: string | null,
    season: number | null,
  ): { exactSameCollection: boolean; approvedCrId: string | null } | null => {
    const assocs = liveAssocsByMediaNs.get(`${mediaId}:${namespace}`);
    if (!assocs || assocs.length === 0) {
      return null;
    }
    const coversSeason = (a: LiveAssocInfo) =>
      season === null || a.seasons === null || a.seasons.includes(season);
    if (crNativeId) {
      const sameCollection = assocs.find((a) => a.nativeId === crNativeId && coversSeason(a));
      if (sameCollection) {
        return { exactSameCollection: true, approvedCrId: sameCollection.approvedCrId };
      }
    }
    const otherCovering = assocs.find(coversSeason);
    if (otherCovering) {
      return { exactSameCollection: false, approvedCrId: otherCovering.approvedCrId };
    }
    return null;
  };

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
    const rawSeason = row.result?.season ?? payload.season;
    const season = typeof rawSeason === "number" ? rawSeason : null;
    const platforms: ExplorationPlatformResult[] = running
      ? (Array.isArray(payload.targetNamespaces) ? payload.targetNamespaces : [])
          .filter((ns): ns is string => typeof ns === "string")
          .map((namespace) => ({
            namespace,
            status: "searching",
            reason: null,
            changeRequestId: null,
            liveChangeRequestId: null,
          }))
      : ((row.result?.platformOutcomes ?? []) as RawOutcome[]).flatMap(
          (o): ExplorationPlatformResult[] => {
            if (typeof o.namespace !== "string") {
              return [];
            }
            const crId = typeof o.changeRequestId === "string" ? o.changeRequestId : null;
            if (o.status === "already_confirmed") {
              return [
                {
                  namespace: o.namespace,
                  status: "covered",
                  reason: reasonText("covered", "already_confirmed"),
                  changeRequestId: null,
                  liveChangeRequestId: null,
                },
              ];
            }
            if (o.status === "submitted" && o.directWrite === true) {
              return [
                {
                  namespace: o.namespace,
                  status: "approved",
                  reason: reasonText("approved", o.reason),
                  changeRequestId: null,
                  liveChangeRequestId: null,
                },
              ];
            }
            if (o.status === "submitted" || o.status === "rejected") {
              const cr = crId ? crById.get(crId) : undefined;
              const resolvedStatus = crStatus(
                cr?.status ?? (o.status === "rejected" ? "rejected" : undefined),
              );
              if (resolvedStatus === "rejected") {
                const effectiveMediaId = cr?.mediaId ?? mediaId;
                const live = findLiveCoverage(
                  effectiveMediaId,
                  cr?.namespace ?? o.namespace,
                  cr?.nativeId ?? null,
                  season,
                );
                const details = cr ? summarizeRejectedCrReason(cr) : null;
                if (live) {
                  const liveChangeRequestId =
                    live.approvedCrId && live.approvedCrId !== crId ? live.approvedCrId : null;
                  const reason = details?.isDuplicateGateConflict
                    ? "此前提交时库里已有收录，当前已在库中生效"
                    : details?.verdict === "reject_with_correction"
                      ? "最初提交有误已被改正，当前该平台合集已生效"
                      : live.exactSameCollection
                        ? "最初提交未通过，但该合集当前已生效"
                        : "最初提交未通过，但该平台已有可用合集生效";
                  return [
                    {
                      namespace: o.namespace,
                      status: "covered",
                      reason,
                      changeRequestId: crId,
                      liveChangeRequestId,
                    },
                  ];
                }
                return [
                  {
                    namespace: o.namespace,
                    status: "rejected",
                    reason: details?.reason ?? reasonText("rejected", o.reason) ?? "未通过审核",
                    changeRequestId: crId,
                    liveChangeRequestId: null,
                  },
                ];
              }
              return [
                {
                  namespace: o.namespace,
                  status: resolvedStatus,
                  reason: reasonText(resolvedStatus, o.reason),
                  changeRequestId: crId,
                  liveChangeRequestId: null,
                },
              ];
            }
            const status: ExplorationResultStatus =
              o.status === "not_found" ? "not_found" : "retry";
            return [
              {
                namespace: o.namespace,
                status,
                reason: reasonText(status, o.reason),
                changeRequestId: crId,
                liveChangeRequestId: null,
              },
            ];
          },
        );
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
