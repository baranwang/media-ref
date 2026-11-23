import type { ChangeRequestStatus, Namespace, NormalizedSegment } from "@media-ref/client";
import { isPlatformNamespace } from "@media-ref/client";
import { AlertTriangleIcon, CheckIcon, XCircleIcon } from "./Icons";
import {
  BASELINE_LABELS,
  CHANGE_REQUEST_STATUS_META,
  NAMESPACE_LABELS,
} from "#/lib/change-requests-api";

export function StatusBadge({
  status,
  showCode = false,
}: {
  status: ChangeRequestStatus;
  showCode?: boolean;
}) {
  const meta = CHANGE_REQUEST_STATUS_META[status];
  const toneClass =
    meta.tone === "ok"
      ? "border-[var(--ok-border)] bg-[var(--ok-bg)] text-[var(--ok-ink)]"
      : meta.tone === "warn"
        ? "border-[var(--warn-border)] bg-[var(--warn-bg)] text-[var(--warn-ink)]"
        : meta.tone === "danger"
          ? "border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger-ink)]"
          : "border-[var(--chip-line)] bg-[var(--chip-bg)] text-[var(--lagoon-deep)]";

  const dotClass =
    meta.tone === "ok"
      ? "bg-emerald-500"
      : meta.tone === "warn"
        ? "bg-amber-500"
        : meta.tone === "danger"
          ? "bg-red-500"
          : "bg-[var(--lagoon)]";

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-bold whitespace-nowrap ${toneClass}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
      <span>{meta.label}</span>
      {showCode ? <span className="font-mono text-[11px] opacity-75">({status})</span> : null}
    </span>
  );
}

export function NamespaceBadge({ namespace }: { namespace: Namespace }) {
  const isPlatform = isPlatformNamespace(namespace);
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap text-[var(--sea-ink)]">
      <span>{NAMESPACE_LABELS[namespace]}</span>
      <span className="font-mono text-[11px] text-[var(--sea-ink-soft)]">
        {isPlatform ? `平台 · ${namespace}` : `目录 · ${namespace}`}
      </span>
    </span>
  );
}

export function SegmentsTable({
  segments,
  compact = false,
}: {
  segments: readonly NormalizedSegment[];
  compact?: boolean;
}) {
  if (segments.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--line)] bg-[var(--chip-bg)] px-4 py-3 text-xs text-[var(--sea-ink-soft)]">
        <span className="font-semibold text-[var(--sea-ink)]">整部对整部</span>
        {" · "}未填写段，仅记录合集或条目归属，不换算集号。
      </div>
    );
  }

  const cellPad = compact ? "px-3 py-2" : "px-4 py-2.5";

  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--line)]">
      <table className="w-full border-collapse text-left text-xs sm:text-sm">
        <thead>
          <tr className="border-b border-[var(--line)] bg-[var(--chip-bg)] text-xs font-bold text-[var(--sea-ink-soft)]">
            <th className={cellPad}>季</th>
            <th className={cellPad}>起</th>
            <th className={cellPad}>止</th>
            <th className={cellPad}>对方起始集号</th>
            <th className={cellPad}>基准</th>
            <th className={cellPad}>标记</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--line)]">
          {segments.map((seg, index) => {
            const episodeCount =
              seg.episodeEnd !== null ? seg.episodeEnd - seg.episodeStart + 1 : null;
            const targetEnd =
              episodeCount !== null && !seg.nonLinear
                ? seg.targetEpisodeStart + episodeCount - 1
                : null;

            return (
              <tr
                key={`${seg.season}-${seg.episodeStart}-${seg.episodeEnd ?? "open"}-${seg.targetEpisodeStart}-${index}`}
                className="transition hover:bg-[color-mix(in_oklab,var(--lagoon)_5%,transparent)]"
              >
                <td className={`${cellPad} font-semibold whitespace-nowrap text-[var(--sea-ink)]`}>
                  {seg.season === 0 ? "第 0 季（特别篇）" : `第 ${seg.season} 季`}
                </td>
                <td className={`${cellPad} font-mono whitespace-nowrap text-[var(--sea-ink)]`}>
                  第 {seg.episodeStart} 集
                </td>
                <td className={`${cellPad} font-mono whitespace-nowrap text-[var(--sea-ink)]`}>
                  {seg.episodeEnd === null ? (
                    <span className="text-[var(--lagoon-deep)]">连载至季末</span>
                  ) : (
                    `第 ${seg.episodeEnd} 集`
                  )}
                </td>
                <td className={`${cellPad} font-mono whitespace-nowrap text-[var(--sea-ink)]`}>
                  {seg.nonLinear ? (
                    <span className="text-[var(--sea-ink-soft)]">不换算</span>
                  ) : targetEnd !== null ? (
                    `第 ${seg.targetEpisodeStart}–${targetEnd} 集`
                  ) : (
                    `第 ${seg.targetEpisodeStart} 集起`
                  )}
                </td>
                <td className={`${cellPad} whitespace-nowrap text-[var(--sea-ink-soft)]`}>
                  {BASELINE_LABELS[seg.baseline] ?? seg.baseline}
                </td>
                <td className={`${cellPad} whitespace-nowrap`}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {seg.nonLinear ? (
                      <span className="rounded-full border border-[var(--warn-border)] bg-[var(--warn-bg)] px-2 py-0.5 text-[11px] font-bold text-[var(--warn-ink)]">
                        集号不对应
                      </span>
                    ) : null}
                    {seg.needsReview ? (
                      <span className="rounded-full border border-[var(--danger-border)] bg-[var(--danger-bg)] px-2 py-0.5 text-[11px] font-bold text-[var(--danger-ink)]">
                        待复核
                      </span>
                    ) : null}
                    {!seg.nonLinear && !seg.needsReview ? (
                      <span className="text-xs text-[var(--sea-ink-soft)]">线性对应</span>
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface EvidenceSummaryEntry {
  label: string;
  value: string;
}

function summarizeEvidence(evidence: Record<string, unknown>): EvidenceSummaryEntry[] {
  const entries: EvidenceSummaryEntry[] = [];
  const tryPush = (label: string, raw: unknown) => {
    if (raw === null || raw === undefined) {
      return;
    }
    if (typeof raw === "string" && raw.trim().length > 0) {
      entries.push({ label, value: raw.trim() });
    } else if (typeof raw === "number" || typeof raw === "boolean") {
      entries.push({ label, value: String(raw) });
    }
  };

  tryPush("判定结果", evidence.outcome ?? evidence.verdict ?? evidence.decision);
  tryPush("取证标题", evidence.title ?? evidence.collectionTitle);
  tryPush("取证年份", evidence.year ?? evidence.airYear);
  tryPush("正片集数", evidence.episodeCount ?? evidence.featureEpisodeCount);
  tryPush("适配器级别", evidence.adapterTier ?? evidence.tier);
  tryPush("第一步结果", evidence.step1Status ?? evidence.identityMatch);
  tryPush("第二步结果", evidence.step2Status ?? evidence.segmentMatch);
  tryPush("取证时间", evidence.checkedAt ?? evidence.fetchedAt);

  if (entries.length === 0) {
    for (const [key, value] of Object.entries(evidence).slice(0, 6)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        entries.push({ label: key, value: String(value) });
      }
    }
  }

  return entries;
}

export function EvidencePanel({
  evidence,
  defaultOpenJson = false,
}: {
  evidence: Record<string, unknown> | null;
  defaultOpenJson?: boolean;
}) {
  if (!evidence) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--line)] bg-[var(--chip-bg)] px-4 py-3 text-xs text-[var(--sea-ink-soft)]">
        暂无取证记录。
      </div>
    );
  }

  const highlights = summarizeEvidence(evidence);
  const prettyJson = JSON.stringify(evidence, null, 2);

  return (
    <div className="space-y-3">
      {highlights.length > 0 ? (
        <dl className="m-0 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {highlights.map((item) => (
            <div
              key={`${item.label}-${item.value}`}
              className="rounded-xl border border-[var(--line)] bg-[var(--chip-bg)] px-3 py-2"
            >
              <dt className="text-[11px] font-semibold text-[var(--sea-ink-soft)]">{item.label}</dt>
              <dd className="m-0 mt-0.5 text-xs font-bold break-all text-[var(--sea-ink)]">
                {item.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      <details
        open={defaultOpenJson}
        className="rounded-xl border border-[var(--line)] bg-[var(--chip-bg)]"
      >
        <summary className="cursor-pointer px-3.5 py-2 text-xs font-semibold text-[var(--sea-ink)] select-none">
          查看完整取证 JSON（{Object.keys(evidence).length} 项字段）
        </summary>
        <pre className="m-0 max-h-80 overflow-auto border-t border-[var(--line)] p-3.5 font-mono text-xs leading-relaxed text-[var(--sea-ink)]">
          <code>{prettyJson}</code>
        </pre>
      </details>
    </div>
  );
}

export function ReasonCallout({
  status,
  conflictReason,
  decisionReason,
}: {
  status: ChangeRequestStatus;
  conflictReason: string | null;
  decisionReason: string | null;
}) {
  if (!conflictReason && !decisionReason && status !== "needs_review") {
    return null;
  }

  return (
    <div className="space-y-2.5">
      {conflictReason ? (
        <div className="flex items-start gap-2.5 rounded-xl border border-[var(--warn-border)] bg-[var(--warn-bg)] p-3.5 text-sm text-[var(--warn-ink)]">
          <AlertTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-0.5">
            <p className="m-0 text-xs font-bold tracking-wide uppercase">转人工 / 证据门冲突原因</p>
            <p className="m-0 text-sm leading-relaxed text-[var(--sea-ink)]">{conflictReason}</p>
          </div>
        </div>
      ) : null}

      {decisionReason ? (
        <div
          className={
            status === "approved"
              ? "flex items-start gap-2.5 rounded-xl border border-[var(--ok-border)] bg-[var(--ok-bg)] p-3.5 text-sm text-[var(--ok-ink)]"
              : status === "rejected"
                ? "flex items-start gap-2.5 rounded-xl border border-[var(--danger-border)] bg-[var(--danger-bg)] p-3.5 text-sm text-[var(--danger-ink)]"
                : "flex items-start gap-2.5 rounded-xl border border-[var(--warn-border)] bg-[var(--warn-bg)] p-3.5 text-sm text-[var(--warn-ink)]"
          }
        >
          {status === "approved" ? (
            <CheckIcon className="mt-0.5 h-4 w-4 shrink-0" />
          ) : status === "rejected" ? (
            <XCircleIcon className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <AlertTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          <div className="space-y-0.5">
            <p className="m-0 text-xs font-bold tracking-wide uppercase">
              {status === "approved" ? "通过理由" : status === "rejected" ? "驳回理由" : "判定说明"}
            </p>
            <p className="m-0 text-sm leading-relaxed text-[var(--sea-ink)]">{decisionReason}</p>
          </div>
        </div>
      ) : null}

      {status === "needs_review" && !conflictReason && !decisionReason ? (
        <div className="flex items-start gap-2.5 rounded-xl border border-[var(--warn-border)] bg-[var(--warn-bg)] p-3.5 text-sm text-[var(--warn-ink)]">
          <AlertTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-0.5">
            <p className="m-0 text-xs font-bold tracking-wide uppercase">等待人工审核</p>
            <p className="m-0 text-sm leading-relaxed text-[var(--sea-ink)]">
              该变更单已进入审核员队列，等待审核员核对媒体信息、变体与段后做出通过或驳回决定。
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
