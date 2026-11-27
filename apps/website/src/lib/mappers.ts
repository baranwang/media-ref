import {
  fromProtoChangeRequestStatus,
  fromProtoMediaType,
  isCatalogNamespace,
  isPlatformNamespace,
  type Association,
  type CatalogNamespace,
  type MediaDocument,
  type Namespace,
  type PlatformNamespace,
  type proto,
} from "@media-ref/client";
import { formatDateTime } from "./format";
import type {
  ApiKeyItem,
  AutoCheckItem,
  CardItem,
  CatalogDirectoryRow,
  ChangeRequestItem,
  ChangeRequestSegmentView,
  ChangeRequestTimelineStep,
  CommentItem,
  CoverageSegment,
  DemandItem,
  ExplorationItem,
  ExplorationStatus,
  MediaItem,
  MediaSeasonInfo,
  PlatformVariantRow,
  ReviewAgentView,
  ReviewAlertItem,
} from "./types";
import { buildExternalUrl } from "./url-parser";

/** Shows with more seasons than this get the all-seasons overview. */
export const LONG_SERIES_SEASONS = 6;

type Json = Record<string, unknown>;

function asJson(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

/** Douban images need a Douban referer; send them through the site's `/img/douban` proxy. */
export function displayImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return /(^|\.)doubanio\.com$/i.test(new URL(url).hostname)
      ? `/img/douban?u=${encodeURIComponent(url)}`
      : url;
  } catch {
    return null;
  }
}

// ---------- Cards ----------

export function cardFromProto(card: proto.CatalogCard): CardItem {
  const type = fromProtoMediaType(card.type) ?? "tv";
  return {
    id: card.mediaId ?? card.key,
    mediaId: card.mediaId ?? null,
    key: card.key,
    title: card.title,
    originalTitle: card.originalTitle ?? null,
    year: card.year ?? null,
    type,
    category: card.isAnime ? "anime" : type,
    posterUrl: displayImageUrl(card.posterUrl),
    platforms: card.platforms.filter((p): p is PlatformNamespace => isPlatformNamespace(p)),
  };
}

export function demandFromProto(entry: proto.DemandEntry): DemandItem | null {
  if (!entry.card) return null;
  return {
    id: entry.id,
    card: cardFromProto(entry.card),
    demandCount: entry.demandCount,
    season: entry.season ?? null,
    lastDemandedAt: entry.lastDemandedAt,
  };
}

const EXPLORATION_STATUSES = new Set<ExplorationStatus>([
  "approved",
  "in_review",
  "rejected",
  "not_found",
  "retry",
  "searching",
]);

export function explorationFromProto(item: proto.ExplorationActivity): ExplorationItem | null {
  if (!item.card) return null;
  return {
    id: item.id,
    card: cardFromProto(item.card),
    season: item.season ?? null,
    startedAt: item.startedAt,
    finishedAt: item.finishedAt ?? null,
    platforms: item.platforms.map((p) => ({
      namespace: p.namespace as Namespace,
      status: EXPLORATION_STATUSES.has(p.status as ExplorationStatus)
        ? (p.status as ExplorationStatus)
        : "retry",
      reason: p.reason ?? null,
      changeRequestId: p.changeRequestId ?? null,
    })),
  };
}

// ---------- Media detail ----------

function seasonEpisodeCount(seasons: MediaSeasonInfo[], season: number): number {
  return seasons.find((s) => s.season === season)?.episodeCount ?? 0;
}

function associationStatus(assoc: Association): CoverageSegment["status"] {
  if (assoc.status === "delisted") return "muted";
  return assoc.unconfirmed || assoc.changeRequestId ? "pending" : "confirmed";
}

function segmentsBySeason(
  assoc: Association,
  seasons: MediaSeasonInfo[],
  isMovie: boolean,
): Record<number, CoverageSegment[]> {
  const out: Record<number, CoverageSegment[]> = {};
  const bar = (id: string, start: number, end: number, targetStart?: number): CoverageSegment => ({
    id,
    title: assoc.title ?? assoc.nativeId,
    nativeId: assoc.nativeId,
    start,
    end,
    ...(targetStart !== undefined ? { targetStart } : {}),
    status: associationStatus(assoc),
    ...(assoc.changeRequestId ? { changeRequestId: assoc.changeRequestId } : {}),
    associationId: assoc.id,
  });
  // No segments = the association covers the whole media: one full bar per season (key 0 for movies).
  if (assoc.segments.length === 0) {
    if (isMovie || seasons.length === 0) {
      out[0] = [bar(`${assoc.id}-whole`, 1, 1)];
    } else {
      for (const s of seasons) {
        out[s.season] = [bar(`${assoc.id}-s${s.season}`, 1, Math.max(s.episodeCount, 1))];
      }
    }
    return out;
  }
  assoc.segments.forEach((seg, index) => {
    const season = isMovie ? 0 : seg.season;
    const end =
      seg.episodeEnd ?? (isMovie ? 1 : seasonEpisodeCount(seasons, seg.season) || seg.episodeStart);
    (out[season] ??= []).push(
      bar(`${assoc.id}-${index}`, seg.episodeStart, end, seg.targetEpisodeStart),
    );
  });
  for (const list of Object.values(out)) list.sort((a, b) => a.start - b.start);
  return out;
}

/** Collapses the seasons an association covers into consecutive season-range bars. */
function seasonRangeSegments(assocs: Association[], seasons: MediaSeasonInfo[]): CoverageSegment[] {
  const bars: CoverageSegment[] = [];
  for (const assoc of assocs) {
    // No segments = the association covers every season.
    const seasonNumbers =
      assoc.segments.length === 0
        ? seasons.map((s) => s.season)
        : assoc.segments.map((s) => s.season);
    const covered = [...new Set(seasonNumbers)].sort((a, b) => a - b);
    let start: number | null = null;
    let prev = 0;
    const flush = () => {
      if (start === null) return;
      bars.push({
        id: `${assoc.id}-s${start}`,
        title: start === prev ? `第 ${start} 季` : `第 ${start}–${prev} 季`,
        nativeId: assoc.nativeId,
        start,
        end: prev,
        status: associationStatus(assoc),
        associationId: assoc.id,
      });
    };
    for (const season of covered) {
      if (start !== null && season === prev + 1) {
        prev = season;
        continue;
      }
      flush();
      start = season;
      prev = season;
    }
    flush();
  }
  return bars.sort((a, b) => a.start - b.start);
}

function mergeSeasonMaps(
  maps: Array<Record<number, CoverageSegment[]>>,
): Record<number, CoverageSegment[]> {
  const out: Record<number, CoverageSegment[]> = {};
  for (const map of maps) {
    for (const [season, list] of Object.entries(map)) {
      (out[Number(season)] ??= []).push(...list);
    }
  }
  for (const list of Object.values(out)) list.sort((a, b) => a.start - b.start);
  return out;
}

function buildPlatformRows(
  document: MediaDocument,
  seasons: MediaSeasonInfo[],
  isMovie: boolean,
): PlatformVariantRow[] {
  const variants = new Map(document.variants.map((v) => [v.id, v]));
  const groups = new Map<
    string,
    { namespace: PlatformNamespace; variantId: string | null; assocs: Association[] }
  >();
  for (const assoc of document.associations) {
    if (!isPlatformNamespace(assoc.namespace) || assoc.status === "delisted") continue;
    const groupKey = `${assoc.namespace}:${assoc.variantId ?? ""}`;
    const group = groups.get(groupKey) ?? {
      namespace: assoc.namespace,
      variantId: assoc.variantId,
      assocs: [],
    };
    group.assocs.push(assoc);
    groups.set(groupKey, group);
  }
  const rows = [...groups.entries()].map(([groupKey, group]): PlatformVariantRow => {
    const variant = group.variantId ? variants.get(group.variantId) : undefined;
    return {
      id: groupKey,
      namespace: group.namespace,
      label: variant?.label ?? "默认版本",
      isDefault: variant?.isDefault ?? true,
      segmentsBySeason: mergeSeasonMaps(
        group.assocs.map((a) => segmentsBySeason(a, seasons, isMovie)),
      ),
      allSeasonSegments: seasonRangeSegments(group.assocs, seasons),
    };
  });
  // Default variant first within a platform, platforms in a stable order.
  return rows.sort((a, b) =>
    a.namespace === b.namespace
      ? Number(b.isDefault) - Number(a.isDefault)
      : a.namespace.localeCompare(b.namespace),
  );
}

const CATALOG_ORDER: CatalogNamespace[] = ["tmdb", "tvdb", "imdb", "trakt", "douban", "bangumi"];

function buildCatalogRows(
  document: MediaDocument,
  seasons: MediaSeasonInfo[],
  isMovie: boolean,
): CatalogDirectoryRow[] {
  const byNamespace = new Map<CatalogNamespace, Association[]>();
  for (const assoc of document.associations) {
    if (!isCatalogNamespace(assoc.namespace)) continue;
    const list = byNamespace.get(assoc.namespace) ?? [];
    list.push(assoc);
    byNamespace.set(assoc.namespace, list);
  }
  const baseline = document.media.baseline;
  return CATALOG_ORDER.filter((ns) => byNamespace.has(ns)).map((namespace) => {
    const assocs = byNamespace.get(namespace)!;
    const whole = assocs.find((a) => a.segments.length === 0);
    const segmented = assocs.filter((a) => a.segments.length > 0);
    const isBaseline = baseline === namespace;
    const entryCount = assocs.length;
    return {
      id: `catalog:${namespace}`,
      namespace,
      isBaseline,
      roleLabel: isBaseline
        ? "基准"
        : whole && segmented.length > 0
          ? "整部 + 季"
          : `${entryCount} 个条目`,
      ...(whole
        ? {
            wholeMediaNativeId: whole.nativeId,
            wholeMediaLabel: `整部 · ${whole.title ?? whole.nativeId}`,
          }
        : {}),
      ...(segmented.length > 0
        ? {
            segmentsBySeason: mergeSeasonMaps(
              segmented.map((a) => segmentsBySeason(a, seasons, isMovie)),
            ),
            allSeasonSegments: seasonRangeSegments(segmented, seasons),
          }
        : {}),
      ...(namespace === "imdb" ? { note: "IMDb 没有季编号，只有整部和单集（单集暂不收录）" } : {}),
    };
  });
}

function yearRangeLabel(
  year: number | null,
  yearEnd: number | null,
  status: string | null,
): string {
  if (year === null) return "";
  if (status === "ongoing") return `${year}–`;
  if (yearEnd !== null && yearEnd !== year) return `${year}–${yearEnd}`;
  return String(year);
}

/**
 * Detail page model. `document` is the MediaRef record (null for titles not in the library yet);
 * `detail` is catalog presentation (null when the catalog lookup failed).
 */
export function mediaItemFrom(
  routeId: string,
  document: MediaDocument | null,
  detail: proto.CatalogDetail | null,
): MediaItem | null {
  const card = detail?.card;
  if (!document && !card) return null;

  const type = document?.media.type ?? fromProtoMediaType(card!.type) ?? "tv";
  const isMovie = type === "movie";
  const snapshot = document?.media.snapshot;
  const seasons: MediaSeasonInfo[] = isMovie
    ? []
    : (snapshot?.seasons ?? detail?.seasons ?? [])
        .filter((s) => s.season > 0)
        .map((s) => ({ season: s.season, episodeCount: s.episodeCount }));
  const year = snapshot?.year ?? card?.year ?? null;
  const tmdb = document?.externalIds.find((id) => id.namespace === "tmdb");
  const catalogKey =
    card?.key ?? (tmdb ? `tmdb:${tmdb.nativeId}` : (document?.media.id ?? routeId));

  return {
    id: routeId,
    mediaId: document?.media.id ?? card?.mediaId ?? null,
    catalogKey,
    type,
    category: card?.isAnime ? "anime" : type,
    title: snapshot?.title ?? card!.title,
    originalTitle: snapshot?.originalTitle ?? card?.originalTitle ?? null,
    yearRange: yearRangeLabel(year, detail?.yearEnd ?? null, detail?.status ?? null),
    year,
    region: detail?.regions.join(" / ") ?? "",
    statusLabel:
      detail?.status === "ongoing" ? "连载中" : detail?.status === "ended" ? "已完结" : "",
    genres: detail?.genres ?? [],
    synopsis: detail?.overview ?? "",
    credits: detail?.credits.map((c) => ({ role: c.role, name: c.name })) ?? [],
    posterUrl: displayImageUrl(card?.posterUrl),
    backdropUrl: displayImageUrl(detail?.backdropUrl),
    baseline: document?.media.baseline ?? null,
    seasons,
    totalEpisodes: seasons.reduce((sum, s) => sum + s.episodeCount, 0) || undefined,
    defaultSeason: seasons.at(-1)?.season,
    platformRows: document ? buildPlatformRows(document, seasons, isMovie) : [],
    catalogRows: document ? buildCatalogRows(document, seasons, isMovie) : [],
  };
}

// ---------- Change requests ----------

const FIELD_LABELS: Record<string, string> = {
  mediaType: "类型对得上",
  year: "年份对得上",
  title: "片名对得上",
  episodeCount: "集数对得上",
};

function checksFromEvidence(id: string, evidence: Json | null): AutoCheckItem[] {
  const gate = asJson(evidence?.gate);
  const step1 = asJson(gate?.step1);
  if (!step1) return [];
  const checks: AutoCheckItem[] = [];
  if (step1.matchedBy === "shared_id") {
    checks.push({
      id: `${id}-shared-id`,
      title: "和资料站的 ID 对得上",
      detail: "平台页面上的外部 ID 和这部媒体一致",
      status: "passed",
    });
  }
  const fieldChecks = asJson(step1.fieldChecks) ?? {};
  for (const [field, label] of Object.entries(FIELD_LABELS)) {
    const status = fieldChecks[field];
    if (status === "skipped" || status === undefined) continue;
    checks.push({
      id: `${id}-${field}`,
      title: status === "matched" ? label : label.replace("对得上", "对不上"),
      detail:
        status === "matched"
          ? "自动核对通过"
          : status === "missing"
            ? "平台页面没有这项信息，需要人工确认"
            : "平台页面和资料站不一致",
      status: status === "matched" ? "passed" : status === "missing" ? "needs_confirm" : "failed",
    });
  }
  const step2 = asJson(gate?.step2);
  const step2Conflicts = Array.isArray(step2?.conflicts) ? step2.conflicts : [];
  step2Conflicts.forEach((raw, index) => {
    const conflict = asJson(raw);
    if (!conflict) return;
    checks.push({
      id: `${id}-step2-${index}`,
      title: "集数范围需要确认",
      detail:
        typeof conflict.message === "string" ? conflict.message : "提交的集数范围和平台页面不一致",
      status: "needs_confirm",
    });
  });
  return checks;
}

/** Same id as `REVIEW_AGENT_USER_ID` in `@media-ref/core`. */
export const REVIEW_AGENT_USER_ID = "system:review-agent";

type SegmentFields = Pick<
  proto.Segment,
  "season" | "episodeStart" | "episodeEnd" | "targetEpisodeStart"
>;

function segmentView(s: SegmentFields): ChangeRequestSegmentView {
  return {
    season: s.season,
    start: s.episodeStart,
    end: s.episodeEnd ?? null,
    targetStart: s.targetEpisodeStart,
  };
}

function reviewAgentFromEvidence(evidence: Json | null): ReviewAgentView | null {
  const raw = asJson(evidence?.reviewAgent);
  const verdicts = [
    "approve",
    "reject",
    "reject_with_correction",
    "keep",
    "revoke",
    "revoke_with_correction",
  ] as const;
  const verdict = verdicts.find((v) => v === raw?.verdict);
  if (!raw || !verdict) {
    return null;
  }
  const reasons = (Array.isArray(raw.reasons) ? raw.reasons : []).flatMap((r) => {
    const reason = asJson(r);
    return typeof reason?.code === "string" && typeof reason.reason === "string"
      ? [{ code: reason.code, reason: reason.reason }]
      : [];
  });
  const correction = asJson(raw.correction);
  return {
    verdict,
    reasons,
    opinion: typeof raw.opinion === "string" ? raw.opinion : null,
    correction:
      typeof correction?.season === "number" && Array.isArray(correction.segments)
        ? {
            season: correction.season,
            segments: (correction.segments as SegmentFields[]).map(segmentView),
          }
        : null,
  };
}

function timelineFor(
  cr: proto.ChangeRequest,
  status: ChangeRequestItem["status"],
  agent: ReviewAgentView | null,
): ChangeRequestTimelineStep[] {
  const byAgent = cr.reviewerUserId === REVIEW_AGENT_USER_ID;
  const steps: ChangeRequestTimelineStep[] = [
    { label: "已提交", time: formatDateTime(cr.createdAt), detail: "变更单已提交", state: "done" },
  ];
  if (status === "pending_evidence") {
    steps.push({
      label: "自动核对",
      time: "进行中",
      detail: "正在抓取平台页面并核对",
      state: "current",
    });
    steps.push({ label: "生效", time: "", detail: "核对通过后自动生效", state: "pending" });
    return steps;
  }
  steps.push({
    label: "自动核对",
    time: "",
    detail: status === "needs_review" ? "有拿不准的地方，已转交审核 agent" : "核对完成",
    state: "done",
  });
  if (status === "needs_review") {
    steps.push({
      label: "待审核",
      time: "进行中",
      detail: "等审核 agent 判定通过或驳回",
      state: "current",
    });
  } else if (status === "approved") {
    steps.push({
      label: "已生效",
      time: formatDateTime(cr.reviewedAt),
      detail: byAgent
        ? "审核 agent 已批准，关联已经生效"
        : cr.reviewerUserId
          ? "审核员已批准，关联已经生效"
          : "自动核对通过，已自动生效",
      state: "done",
    });
  } else if (status === "rejected") {
    const revoked = agent?.verdict === "revoke" || agent?.verdict === "revoke_with_correction";
    steps.push({
      label: revoked ? "已撤下" : "已驳回",
      time: formatDateTime(cr.reviewedAt),
      detail: agent?.correction
        ? `审核 agent ${revoked ? "撤下" : "驳回"}并改正为第 ${agent.correction.season} 季，会按改正重新提交`
        : revoked
          ? "审核 agent 按留言核实后撤下了这条关联"
          : byAgent
            ? `审核 agent 驳回${cr.decisionReason ? `：${cr.decisionReason}` : ""}`
            : (cr.decisionReason ?? "审核员驳回了这张变更单"),
      state: "done",
    });
  }
  return steps;
}

export function changeRequestFromProto(cr: proto.ChangeRequest): ChangeRequestItem {
  const status = fromProtoChangeRequestStatus(cr.status) ?? "needs_review";
  const evidence = asJson(cr.evidence);
  const collection = asJson(evidence?.collection);
  const namespace = cr.namespace as Namespace;
  const rawIsUrl = /^https?:\/\//i.test(cr.rawNativeId);
  const reviewAgent = reviewAgentFromEvidence(evidence);
  return {
    id: cr.id,
    status,
    mediaId: cr.mediaId ?? null,
    targetKey: cr.mediaId ?? targetKeyOf(cr.target),
    namespace,
    nativeId: cr.nativeId,
    pageUrl: rawIsUrl ? cr.rawNativeId : buildExternalUrl(namespace, cr.nativeId, "tv"),
    pageTitle: typeof collection?.title === "string" ? collection.title : null,
    pageEpisodeCount:
      typeof collection?.featureEpisodeCount === "number" ? collection.featureEpisodeCount : null,
    variantLabel: cr.variantDescription ?? null,
    segments: cr.segments.map(segmentView),
    conflictReason: cr.conflictReason ?? null,
    decisionReason: cr.decisionReason ?? null,
    reviewerUserId: cr.reviewerUserId ?? null,
    reviewedByAgent: cr.reviewerUserId === REVIEW_AGENT_USER_ID,
    reviewAgent,
    submitterUserId: cr.submitterUserId,
    createdAt: cr.createdAt,
    reviewedAt: cr.reviewedAt ?? null,
    checks: checksFromEvidence(cr.id, evidence),
    timeline: timelineFor(cr, status, reviewAgent),
  };
}

/**
 * Comments and the review agent's replies as one thread, oldest first. A person's comment is
 * `waiting` until a reply answers it.
 */
export function commentThreadFrom(comments: proto.ChangeRequestComment[]): CommentItem[] {
  const answered = new Set(comments.flatMap((c) => c.replyToIds));
  return [...comments]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((c) => {
      const byAgent = c.authorUserId === REVIEW_AGENT_USER_ID;
      return {
        id: c.id,
        byAgent,
        author: byAgent ? "审核 agent" : c.authorName || "用户",
        content: c.content,
        createdAt: c.createdAt,
        waiting: !byAgent && !answered.has(c.id),
      };
    });
}

const SHORTCUT_PREFIX = { approve: "通过：", reject: "驳回：" } as const;

/** A comment's content; the 通过 and 驳回 shortcuts start it with 「通过：」 or 「驳回：」. */
export function commentContent(note: string, shortcut?: keyof typeof SHORTCUT_PREFIX): string {
  const text = note.trim();
  if (!shortcut) return text;
  const prefix = SHORTCUT_PREFIX[shortcut];
  return text.startsWith(prefix) ? text : `${prefix}${text}`;
}

/** One change request as GetChangeRequest returns it, with the request its collection went live through. */
export function changeRequestFromGetResponse(
  res: proto.GetChangeRequestResponse,
): ChangeRequestItem | null {
  return res.changeRequest
    ? {
        ...changeRequestFromProto(res.changeRequest),
        liveChangeRequestId: res.liveChangeRequestId ?? null,
      }
    : null;
}

/** Catalog key for a change-request target ref, e.g. `tmdb:tv:1429`. */
export function targetKeyOf(ref: proto.MediaRef | undefined): string {
  const id = ref?.id;
  switch (id?.case) {
    case "mediaId":
      return id.value;
    case "tmdb":
      return `tmdb:${id.value.type === 1 ? "movie" : "tv"}:${id.value.id}`;
    case "imdb":
      return `imdb:${id.value}`;
    case "douban":
      return `douban:${id.value}`;
    case "bangumi":
      return `bangumi:${id.value}`;
    case "tvdb":
      return `tvdb:${id.value.id}`;
    case "trakt":
      return `trakt:${id.value.type === 1 ? "movie" : "show"}:${id.value.id}`;
    default:
      return "";
  }
}

/** Short Chinese label for a conflict reason code, for queue tags. */
export function conflictTagFor(reason: string | null): string | null {
  if (!reason) return null;
  if (reason.includes("overlap")) return "和已有记录重叠";
  if (reason.includes("episode")) return "集数对不上";
  if (reason.includes("year")) return "年份对不上";
  if (reason.includes("title")) return "片名对不上";
  if (reason.includes("lock")) return "挑战已锁定记录";
  return "自动核对有冲突";
}

// ---------- Review alerts ----------

const ALERT_LABELS: Record<
  string,
  { badge: string; title: string; severity: ReviewAlertItem["severity"] }
> = {
  locked_association_delisted: {
    badge: "页面打不开",
    title: "已锁定的播放页打不开了",
    severity: "destructive",
  },
  locked_association_challenged: {
    badge: "记录被质疑",
    title: "有人提交了和已锁定记录冲突的变更",
    severity: "warning",
  },
  association_content_mismatch: {
    badge: "内容不符",
    title: "播放页内容和记录不一致",
    severity: "warning",
  },
  segments_needs_review: {
    badge: "分季变化",
    title: "资料站的分季或集数变了",
    severity: "warning",
  },
  tmdb_missing_or_merged: {
    badge: "资料站缺失",
    title: "TMDB 上找不到这部媒体了",
    severity: "destructive",
  },
  seed_evidence_failed: {
    badge: "导入待核对",
    title: "导入的关联没能自动核对",
    severity: "warning",
  },
};

export function reviewAlertFromProto(alert: proto.ReviewAlert): ReviewAlertItem {
  const details = asJson(alert.details) ?? {};
  const label = ALERT_LABELS[alert.alertType] ?? {
    badge: "需要处理",
    title: alert.alertType,
    severity: "warning" as const,
  };
  const namespace = typeof details.namespace === "string" ? (details.namespace as Namespace) : null;
  const subject =
    typeof details.mediaTitle === "string"
      ? `《${details.mediaTitle}》`
      : namespace && typeof details.nativeId === "string"
        ? `${namespace}:${details.nativeId}`
        : "";
  const reason = typeof details.reason === "string" ? details.reason : "";
  return {
    id: alert.id,
    alertType: alert.alertType,
    namespace,
    badge: label.badge,
    severity: label.severity,
    title: subject ? `${subject} ${label.title}` : label.title,
    description: reason,
    createdAt: alert.createdAt,
    mediaId: alert.mediaId ?? null,
    associationId: alert.associationId ?? null,
  };
}

// ---------- API keys ----------

export function apiKeyFromProto(
  key: proto.ApiKeySummary,
  lastUsed: Map<string, string>,
): ApiKeyItem {
  return {
    id: key.id,
    name: key.name ?? "未命名密钥",
    prefix: `${key.start ?? key.prefix ?? ""}••••`,
    canSubmit: key.canSubmit,
    createdAt: key.createdAt,
    expiresAt: key.expiresAt ?? null,
    lastUsedAt: lastUsed.get(key.id) ?? null,
  };
}
