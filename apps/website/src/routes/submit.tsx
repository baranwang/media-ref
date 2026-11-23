import { useMemo, useState, type FormEvent } from "react";
import {
  PLATFORM_NAMESPACES,
  isPlatformNamespace,
  normalizeSegment,
  validateSegment,
  validateVariantSegments,
  type BaselineSource,
  type NormalizedSegment,
  type SegmentInput,
  type SegmentValidationError,
} from "@media-ref/client";
import { Link, createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import EmailVerificationBanner from "#/components/EmailVerificationBanner";
import { AlertTriangleIcon, CheckIcon, PlusIcon, SendIcon, TrashIcon } from "#/components/Icons";
import { requireLogin } from "#/lib/auth";
import {
  ASSOCIATION_CATALOG_NAMESPACES,
  BASELINE_OPTIONS,
  NAMESPACE_LABELS,
  detectNamespaceFromUrl,
  formatChangeRequestApiError,
  formatSegmentValidationError,
  isAssociationNamespace,
  isUuid,
  submitChangeRequest,
  validateTargetMediaKey,
  type AssociationNamespace,
} from "#/lib/change-requests-api";

interface SubmitSearch {
  target?: string;
  namespace?: AssociationNamespace;
  replacesAssociationId?: string;
}

interface SegmentDraft {
  rowKey: string;
  season: string;
  episodeStart: string;
  episodeEnd: string;
  targetEpisodeStart: string;
  baseline: BaselineSource;
  nonLinear: boolean;
}

const VARIANT_PRESETS = ["原声", "中配", "粤语版", "导演剪辑版"] as const;

let segmentRowCounter = 1;

function nextSegmentRowKey(): string {
  segmentRowCounter += 1;
  return `seg-${segmentRowCounter}`;
}

function parseStrictNumericField(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return Number.NaN;
  }
  return Number(trimmed);
}

function buildSegmentInputFromDraft(draft: SegmentDraft): SegmentInput {
  const episodeEndTrimmed = draft.episodeEnd.trim();
  return {
    season: parseStrictNumericField(draft.season),
    episodeStart: parseStrictNumericField(draft.episodeStart),
    episodeEnd: episodeEndTrimmed === "" ? null : parseStrictNumericField(episodeEndTrimmed),
    targetEpisodeStart: parseStrictNumericField(draft.targetEpisodeStart),
    baseline: draft.baseline,
    nonLinear: draft.nonLinear,
  };
}

function describeLinearSegment(segment: NormalizedSegment): string {
  const seasonLabel = segment.season === 0 ? "第 0 季（特别篇）" : `第 ${segment.season} 季`;
  if (segment.nonLinear) {
    const rangeLabel =
      segment.episodeEnd === null
        ? `第 ${segment.episodeStart} 集起（连载至季末）`
        : `第 ${segment.episodeStart}–${segment.episodeEnd} 集`;
    return `${seasonLabel} ${rangeLabel} · 集号不对应（仅记录合集归属）`;
  }
  if (segment.episodeEnd === null) {
    return `${seasonLabel} 第 ${segment.episodeStart} 集起（连载至季末）→ 对方第 ${segment.targetEpisodeStart} 集起`;
  }
  const count = segment.episodeEnd - segment.episodeStart + 1;
  const targetEnd = segment.targetEpisodeStart + count - 1;
  return `${seasonLabel} 第 ${segment.episodeStart}–${segment.episodeEnd} 集 → 对方第 ${segment.targetEpisodeStart}–${targetEnd} 集（共 ${count} 集）`;
}

export const Route = createFileRoute("/submit")({
  validateSearch: (search: Record<string, unknown>): SubmitSearch => {
    const target =
      typeof search.target === "string" && search.target.trim().length > 0
        ? search.target.trim()
        : undefined;
    const rawNs = typeof search.namespace === "string" ? search.namespace.trim() : "";
    const namespace = isAssociationNamespace(rawNs) ? rawNs : undefined;
    const replacesAssociationId =
      typeof search.replacesAssociationId === "string" &&
      search.replacesAssociationId.trim().length > 0
        ? search.replacesAssociationId.trim()
        : undefined;
    return {
      ...(target ? { target } : {}),
      ...(namespace ? { namespace } : {}),
      ...(replacesAssociationId ? { replacesAssociationId } : {}),
    };
  },
  beforeLoad: ({ context, location }) => requireLogin(context, location),
  head: () => ({
    meta: [{ title: "提交关联 · media-ref" }],
  }),
  component: SubmitChangeRequestPage,
});

function SubmitChangeRequestPage() {
  const { user } = Route.useRouteContext();
  const search = Route.useSearch();
  const router = useRouter();
  const navigate = useNavigate();

  const [refreshingUser, setRefreshingUser] = useState(false);

  const [targetExternalKey, setTargetExternalKey] = useState(search.target ?? "");
  const [namespace, setNamespace] = useState<AssociationNamespace>(
    search.namespace ?? PLATFORM_NAMESPACES[0],
  );
  const [nativeIdInput, setNativeIdInput] = useState("");
  const [replacesAssociationId, setReplacesAssociationId] = useState(
    search.replacesAssociationId ?? "",
  );

  const [variantMode, setVariantMode] = useState<"description" | "id">("description");
  const [variantDescription, setVariantDescription] = useState("原声");
  const [variantId, setVariantId] = useState("");
  const [setDefaultVariant, setSetDefaultVariant] = useState(false);

  const [segmentDrafts, setSegmentDrafts] = useState<SegmentDraft[]>([]);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [attemptedSubmit, setAttemptedSubmit] = useState(false);

  const isPlatform = isPlatformNamespace(namespace);

  const targetValidation = useMemo(
    () => validateTargetMediaKey(targetExternalKey),
    [targetExternalKey],
  );

  const detectedUrlNamespace = useMemo(
    () => detectNamespaceFromUrl(nativeIdInput),
    [nativeIdInput],
  );

  // Live validation using @media-ref/client's exact validateSegment, validateVariantSegments, and normalizeSegment
  const segmentValidation = useMemo(() => {
    const rowErrors = new Map<number, SegmentValidationError[]>();
    const candidates: SegmentInput[] = [];
    const normalizedPreviews = new Map<number, NormalizedSegment>();

    for (let i = 0; i < segmentDrafts.length; i++) {
      const candidate = buildSegmentInputFromDraft(segmentDrafts[i]);
      candidates.push(candidate);

      const singleResult = validateSegment(candidate);
      if (!singleResult.valid) {
        rowErrors.set(
          i,
          singleResult.errors.map((err) => ({ ...err, segmentIndex: i })),
        );
      } else {
        normalizedPreviews.set(i, normalizeSegment(candidate));
      }
    }

    const variantResult = validateVariantSegments([candidates]);
    const overlapErrors: SegmentValidationError[] = [];

    if (!variantResult.valid) {
      for (const err of variantResult.errors) {
        if (err.code === "OVERLAPPING_VARIANT_SEGMENTS") {
          overlapErrors.push(err);
          if (typeof err.segmentIndex === "number") {
            const existing = rowErrors.get(err.segmentIndex) ?? [];
            rowErrors.set(err.segmentIndex, [...existing, err]);
          }
        }
      }
    }

    const allErrors: SegmentValidationError[] = [];
    if (!variantResult.valid) {
      allErrors.push(...variantResult.errors);
    }

    const normalizedSegments: NormalizedSegment[] = variantResult.valid
      ? candidates.map((candidate) => normalizeSegment(candidate))
      : [];

    return {
      valid: variantResult.valid,
      rowErrors,
      overlapErrors,
      allErrors,
      normalizedPreviews,
      normalizedSegments,
    };
  }, [segmentDrafts]);

  const variantValidationError = useMemo(() => {
    if (!isPlatform) {
      return null;
    }
    if (variantMode === "id") {
      if (variantId.trim().length === 0) {
        return "请填写已有变体的 UUID，或切换为「填写变体说明」";
      }
      if (!isUuid(variantId)) {
        return "变体 ID 必须是合法的 UUID";
      }
      return null;
    }
    if (variantDescription.trim().length === 0) {
      return "请填写变体说明（例如：原声、中配、粤语版）";
    }
    return null;
  }, [isPlatform, variantMode, variantId, variantDescription]);

  const nativeIdError = useMemo(() => {
    if (nativeIdInput.trim().length === 0) {
      return isPlatform ? "请粘贴平台网址或填写合集原生 ID" : "请粘贴目录网址或填写条目原生 ID";
    }
    return null;
  }, [nativeIdInput, isPlatform]);

  const replacesAssociationIdError = useMemo(() => {
    const trimmed = replacesAssociationId.trim();
    if (trimmed.length === 0) {
      return null;
    }
    if (!isUuid(trimmed)) {
      return "拟替换的关联 ID 必须是合法的 UUID";
    }
    return null;
  }, [replacesAssociationId]);

  async function handleRefreshUserStatus() {
    setRefreshingUser(true);
    try {
      await router.invalidate();
    } finally {
      setRefreshingUser(false);
    }
  }

  function handleAddSegment() {
    setSegmentDrafts((prev) => {
      if (prev.length === 0) {
        return [
          {
            rowKey: nextSegmentRowKey(),
            season: "1",
            episodeStart: "1",
            episodeEnd: "",
            targetEpisodeStart: "1",
            baseline: "tmdb",
            nonLinear: false,
          },
        ];
      }

      const last = prev[prev.length - 1];
      const lastSeason = Number.parseInt(last.season, 10);
      const lastEnd = Number.parseInt(last.episodeEnd, 10);
      const validSeason = Number.isInteger(lastSeason) && lastSeason >= 0 ? lastSeason : 1;

      const nextSeason = Number.isInteger(lastEnd) && lastEnd >= 1 ? validSeason : validSeason + 1;
      const nextStart = Number.isInteger(lastEnd) && lastEnd >= 1 ? lastEnd + 1 : 1;

      return [
        ...prev,
        {
          rowKey: nextSegmentRowKey(),
          season: String(nextSeason),
          episodeStart: String(nextStart),
          episodeEnd: "",
          targetEpisodeStart: "1",
          baseline: last.baseline,
          nonLinear: false,
        },
      ];
    });
  }

  function handleUpdateSegment(rowKey: string, patch: Partial<Omit<SegmentDraft, "rowKey">>) {
    setSegmentDrafts((prev) =>
      prev.map((row) => (row.rowKey === rowKey ? { ...row, ...patch } : row)),
    );
  }

  function handleRemoveSegment(rowKey: string) {
    setSegmentDrafts((prev) => prev.filter((row) => row.rowKey !== rowKey));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAttemptedSubmit(true);
    setSubmitError(null);

    if (!user.emailVerified) {
      setSubmitError("请先完成邮箱验证后再提交变更单");
      return;
    }

    if (!targetValidation.valid) {
      setSubmitError(targetValidation.message);
      return;
    }

    if (nativeIdError) {
      setSubmitError(nativeIdError);
      return;
    }

    if (variantValidationError) {
      setSubmitError(variantValidationError);
      return;
    }

    if (replacesAssociationIdError) {
      setSubmitError(replacesAssociationIdError);
      return;
    }

    if (!segmentValidation.valid) {
      setSubmitError(segmentValidation.allErrors.map(formatSegmentValidationError).join("；"));
      return;
    }

    setSubmitting(true);
    try {
      const trimmedReplaces = replacesAssociationId.trim();
      const created = await submitChangeRequest({
        targetExternalKey: targetValidation.normalized,
        namespace,
        nativeId: nativeIdInput.trim(),
        rawNativeId: nativeIdInput.trim(),
        ...(isPlatform
          ? variantMode === "id"
            ? {
                variantId: variantId.trim(),
                setDefaultVariant,
              }
            : {
                variantDescription: variantDescription.trim(),
                setDefaultVariant,
              }
          : {}),
        ...(trimmedReplaces.length > 0 ? { replacesAssociationId: trimmedReplaces } : {}),
        segments: segmentValidation.normalizedSegments,
      });

      await navigate({
        to: "/change-requests/$id",
        params: { id: created.id },
      });
    } catch (error) {
      setSubmitError(formatChangeRequestApiError(error, "提交变更单失败，请检查表单后重试"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="page-wrap space-y-6 px-4 pt-8 pb-10 sm:pt-10">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1.5">
          <p className="island-kicker m-0">公开写接口 · 变更单</p>
          <h1 className="display-title m-0 text-3xl font-bold tracking-tight text-[var(--sea-ink)] sm:text-4xl">
            提交关联
          </h1>
          <p className="m-0 max-w-2xl text-sm leading-relaxed text-[var(--sea-ink-soft)]">
            为电影或剧集提交平台合集或目录条目的关联。提交后立即生成变更单编号，可前往状态页追踪取证与证据门判定结果。
          </p>
        </div>

        <Link to="/" className="btn-secondary self-start sm:self-auto">
          返回工作台
        </Link>
      </header>

      {!user.emailVerified ? (
        <EmailVerificationBanner
          email={user.email}
          onRefreshStatus={handleRefreshUserStatus}
          refreshing={refreshingUser}
        />
      ) : null}

      <section className="island-shell rise-in rounded-3xl p-6 sm:p-8">
        {submitError ? (
          <div
            role="alert"
            className="mb-6 flex items-start gap-2.5 rounded-xl border border-[var(--danger-border)] bg-[var(--danger-bg)] p-4 text-sm text-[var(--danger-ink)]"
          >
            <AlertTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{submitError}</span>
          </div>
        ) : null}

        <form onSubmit={handleSubmit} noValidate>
          <fieldset
            disabled={!user.emailVerified || submitting}
            className="m-0 space-y-7 border-0 p-0 disabled:opacity-65"
          >
            {/* 1. Target Media & Namespace */}
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="m-0 text-base font-bold text-[var(--sea-ink)]">
                  1. 目标媒体与命名空间
                </h2>
                {!user.emailVerified ? (
                  <span className="rounded-full border border-[var(--warn-border)] bg-[var(--warn-bg)] px-3 py-0.5 text-xs font-bold text-[var(--warn-ink)]">
                    需验证邮箱后提交
                  </span>
                ) : null}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label
                    htmlFor="submit-target-key"
                    className="block text-sm font-semibold text-[var(--sea-ink)]"
                  >
                    目标媒体（外部键或媒体 UUID）
                  </label>
                  <input
                    id="submit-target-key"
                    name="targetExternalKey"
                    type="text"
                    required
                    placeholder="例如：tmdb:tv:95479、tmdb:movie:603 或媒体 UUID"
                    value={targetExternalKey}
                    onChange={(event) => setTargetExternalKey(event.target.value)}
                    className="field-input font-mono text-sm"
                  />
                  {targetExternalKey.trim().length > 0 ? (
                    targetValidation.valid ? (
                      <p className="m-0 flex items-center gap-1.5 text-xs font-semibold text-[var(--ok-ink)]">
                        <CheckIcon className="h-3.5 w-3.5 shrink-0" />
                        <span>
                          {targetValidation.kind === "media_id"
                            ? `已识别媒体 UUID：${targetValidation.mediaId}`
                            : `已识别外部键：${NAMESPACE_LABELS[targetValidation.key.namespace]} · ${targetValidation.key.nativeId}`}
                        </span>
                      </p>
                    ) : (
                      <p className="m-0 text-xs font-semibold text-[var(--danger-ink)]">
                        {targetValidation.message}
                      </p>
                    )
                  ) : attemptedSubmit ? (
                    <p className="m-0 text-xs font-semibold text-[var(--danger-ink)]">
                      {targetValidation.valid ? null : targetValidation.message}
                    </p>
                  ) : (
                    <p className="m-0 text-xs text-[var(--sea-ink-soft)]">
                      库里尚未建档的媒体可使用目录外部键自动建档（支持
                      TMDB、TVDB、IMDb、Bangumi、豆瓣、Trakt，例如 <code>tmdb:tv:&lt;id&gt;</code>、
                      <code>tvdb:series:&lt;id&gt;</code>、<code>imdb:tt&lt;id&gt;</code>、
                      <code>bangumi:&lt;id&gt;</code>、<code>douban:&lt;id&gt;</code>、
                      <code>trakt:show:&lt;id&gt;</code>）。
                    </p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="submit-namespace"
                    className="block text-sm font-semibold text-[var(--sea-ink)]"
                  >
                    命名空间
                  </label>
                  <select
                    id="submit-namespace"
                    name="namespace"
                    value={namespace}
                    onChange={(event) => {
                      const next = event.target.value;
                      if (isAssociationNamespace(next)) {
                        setNamespace(next);
                      }
                    }}
                    className="field-input"
                  >
                    <optgroup label="平台（需指定变体）">
                      {PLATFORM_NAMESPACES.map((ns) => (
                        <option key={ns} value={ns}>
                          {NAMESPACE_LABELS[ns]}（{ns}）
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="目录（条目关联 · 无变体）">
                      {ASSOCIATION_CATALOG_NAMESPACES.map((ns) => (
                        <option key={ns} value={ns}>
                          {NAMESPACE_LABELS[ns]}（{ns}）
                        </option>
                      ))}
                    </optgroup>
                  </select>
                  <p className="m-0 text-xs text-[var(--sea-ink-soft)]">
                    {isPlatform
                      ? "视频平台合集归属于一个变体（如原声、中配）。"
                      : "豆瓣与 Bangumi 属于目录条目关联，不设变体，可按季填写段。"}
                  </p>
                </div>
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="submit-native-id"
                  className="block text-sm font-semibold text-[var(--sea-ink)]"
                >
                  粘贴平台网址或原生 ID
                </label>
                <input
                  id="submit-native-id"
                  name="nativeId"
                  type="text"
                  required
                  placeholder={
                    isPlatform
                      ? "粘贴平台网址或合集原生 ID，例如 ss34430 或 https://www.bilibili.com/bangumi/play/ss34430"
                      : "粘贴目录网址或条目原生 ID，例如 1292052 或 https://movie.douban.com/subject/1292052/"
                  }
                  value={nativeIdInput}
                  onChange={(event) => setNativeIdInput(event.target.value)}
                  className="field-input font-mono text-sm"
                />
                {detectedUrlNamespace && detectedUrlNamespace !== namespace ? (
                  <div className="flex flex-wrap items-center gap-2 pt-1 text-xs">
                    <span className="text-[var(--warn-ink)]">
                      检测到该网址属于「{NAMESPACE_LABELS[detectedUrlNamespace]}」：
                    </span>
                    <button
                      type="button"
                      onClick={() => setNamespace(detectedUrlNamespace)}
                      className="cursor-pointer rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-2.5 py-0.5 text-xs font-bold text-[var(--lagoon-deep)] transition hover:bg-[var(--link-bg-hover)]"
                    >
                      切换到 {NAMESPACE_LABELS[detectedUrlNamespace]}
                    </button>
                  </div>
                ) : null}
                {attemptedSubmit && nativeIdError ? (
                  <p className="m-0 text-xs font-semibold text-[var(--danger-ink)]">
                    {nativeIdError}
                  </p>
                ) : (
                  <p className="m-0 text-xs text-[var(--sea-ink-soft)]">
                    服务端会将网址或常见写法换算为规范 ID；无法换算的网址将被直接拒收。
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="submit-replaces-association-id"
                  className="block text-sm font-semibold text-[var(--sea-ink)]"
                >
                  拟替换的现有关联 ID（可选，UUID）
                </label>
                <input
                  id="submit-replaces-association-id"
                  name="replacesAssociationId"
                  type="text"
                  placeholder="更正已有错误关联时填写旧关联的 UUID，新提交新增关联时留空"
                  value={replacesAssociationId}
                  onChange={(event) => setReplacesAssociationId(event.target.value)}
                  className="field-input font-mono text-sm"
                />
                {replacesAssociationIdError ? (
                  <p className="m-0 text-xs font-semibold text-[var(--danger-ink)]">
                    {replacesAssociationIdError}
                  </p>
                ) : (
                  <p className="m-0 text-xs text-[var(--sea-ink-soft)]">
                    填写后，证据门与审核流程会将其作为针对该关联的更正提案处理；通过后旧关联将被下架替换。
                  </p>
                )}
              </div>
            </div>

            <div className="h-px bg-[var(--line)]" />

            {/* 2. Variant Section */}
            <div className="space-y-4">
              <div className="space-y-1">
                <h2 className="m-0 text-base font-bold text-[var(--sea-ink)]">2. 变体与默认变体</h2>
                <p className="m-0 text-xs text-[var(--sea-ink-soft)]">
                  变体描述一部媒体在同一平台上的呈现方式（如原声、中配、粤语版、导演剪辑版）。「默认」只属于变体维度。
                </p>
              </div>

              {isPlatform ? (
                <div className="space-y-4 rounded-2xl border border-[var(--line)] bg-[var(--chip-bg)] p-4 sm:p-5">
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setVariantMode("description")}
                      className={
                        variantMode === "description"
                          ? "btn-primary px-3.5 py-1.5 text-xs"
                          : "btn-secondary px-3.5 py-1.5 text-xs"
                      }
                    >
                      填写变体说明（新建或复用同名）
                    </button>
                    <button
                      type="button"
                      onClick={() => setVariantMode("id")}
                      className={
                        variantMode === "id"
                          ? "btn-primary px-3.5 py-1.5 text-xs"
                          : "btn-secondary px-3.5 py-1.5 text-xs"
                      }
                    >
                      指定已有变体 ID
                    </button>
                  </div>

                  {variantMode === "description" ? (
                    <div className="space-y-2">
                      <label
                        htmlFor="submit-variant-description"
                        className="block text-sm font-semibold text-[var(--sea-ink)]"
                      >
                        变体说明
                      </label>
                      <input
                        id="submit-variant-description"
                        name="variantDescription"
                        type="text"
                        placeholder="例如：原声、中配、粤语版、导演剪辑版"
                        value={variantDescription}
                        onChange={(event) => setVariantDescription(event.target.value)}
                        className="field-input"
                      />
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-xs text-[var(--sea-ink-soft)]">常用说明：</span>
                        {VARIANT_PRESETS.map((preset) => (
                          <button
                            key={preset}
                            type="button"
                            onClick={() => setVariantDescription(preset)}
                            className={
                              variantDescription.trim() === preset
                                ? "cursor-pointer rounded-full border border-[var(--lagoon-deep)] bg-[color-mix(in_oklab,var(--lagoon)_22%,var(--surface-strong))] px-2.5 py-0.5 text-xs font-bold text-[var(--sea-ink)]"
                                : "cursor-pointer rounded-full border border-[var(--line)] bg-[var(--surface-strong)] px-2.5 py-0.5 text-xs font-semibold text-[var(--sea-ink-soft)] transition hover:text-[var(--sea-ink)]"
                            }
                          >
                            {preset}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      <label
                        htmlFor="submit-variant-id"
                        className="block text-sm font-semibold text-[var(--sea-ink)]"
                      >
                        已有变体 ID（UUID）
                      </label>
                      <input
                        id="submit-variant-id"
                        name="variantId"
                        type="text"
                        placeholder="输入目标媒体在此平台下已有变体的 UUID"
                        value={variantId}
                        onChange={(event) => setVariantId(event.target.value)}
                        className="field-input font-mono text-sm"
                      />
                      <p className="m-0 text-xs text-[var(--sea-ink-soft)]">
                        当一季被拆成多个合集时，可填入同一变体 ID 让多条关联归属同一变体。
                      </p>
                    </div>
                  )}

                  {attemptedSubmit && variantValidationError ? (
                    <p className="m-0 text-xs font-semibold text-[var(--danger-ink)]">
                      {variantValidationError}
                    </p>
                  ) : null}

                  <div className="h-px bg-[var(--line)]" />

                  <label className="flex cursor-pointer items-start gap-3">
                    <input
                      type="checkbox"
                      checked={setDefaultVariant}
                      onChange={(event) => setSetDefaultVariant(event.target.checked)}
                      className="mt-1 h-4 w-4 accent-[var(--lagoon-deep)]"
                    />
                    <span className="space-y-0.5">
                      <span className="block text-sm font-bold text-[var(--sea-ink)]">
                        设为默认变体
                      </span>
                      <span className="block text-xs leading-relaxed text-[var(--sea-ink-soft)]">
                        查询未指定变体时将采用默认变体。将非原声版标为默认时，变更单将转交审核员确认。
                      </span>
                    </span>
                  </label>
                </div>
              ) : (
                <div className="rounded-2xl border border-dashed border-[var(--line)] bg-[var(--chip-bg)] px-4 py-3.5 text-sm text-[var(--sea-ink-soft)]">
                  当前所选命名空间为目录（{NAMESPACE_LABELS[namespace]}
                  ），目录条目关联不归属于变体，无需填写变体信息。
                </div>
              )}
            </div>

            <div className="h-px bg-[var(--line)]" />

            {/* 3. Segments Editor */}
            <div className="space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <h2 className="m-0 text-base font-bold text-[var(--sea-ink)]">
                    3. 段（季与集的对应）
                  </h2>
                  <p className="m-0 text-xs leading-relaxed text-[var(--sea-ink-soft)]">
                    不添加段表示<strong>整部对整部</strong>
                    （不换算集号，适合电影或整部合集）。剧集可添加多个段，支持一季拆多合集、多季并一合集、连载季止集留空及「集号不对应」。
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {segmentDrafts.length > 0 ? (
                    <button
                      type="button"
                      onClick={() => setSegmentDrafts([])}
                      className="btn-secondary px-3 py-1.5 text-xs"
                    >
                      清空为整部对整部
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={handleAddSegment}
                    className="btn-secondary px-3.5 py-1.5 text-xs"
                  >
                    <PlusIcon className="h-3.5 w-3.5" />
                    <span>添加段</span>
                  </button>
                </div>
              </div>

              {segmentValidation.overlapErrors.length > 0 ? (
                <div
                  role="alert"
                  className="flex items-start gap-2.5 rounded-xl border border-[var(--danger-border)] bg-[var(--danger-bg)] p-3.5 text-sm text-[var(--danger-ink)]"
                >
                  <AlertTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" />
                  <div className="space-y-1">
                    <p className="m-0 font-bold">检测到重叠的段（已由客户端校验拦下）</p>
                    <ul className="m-0 list-disc space-y-0.5 pl-4 text-xs">
                      {segmentValidation.overlapErrors.map((err, idx) => (
                        <li key={`${err.code}-${err.segmentIndex ?? idx}-${idx}`}>
                          {formatSegmentValidationError(err)}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              ) : null}

              {segmentDrafts.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-[var(--line)] bg-[var(--chip-bg)] px-6 py-8 text-center">
                  <p className="m-0 text-sm font-semibold text-[var(--sea-ink)]">
                    当前为「整部对整部」（segments: []）
                  </p>
                  <p className="mt-1 mb-4 text-xs text-[var(--sea-ink-soft)]">
                    适用于电影或不需要按集换算的合集。如需精确到季与集的对应，请点击下方添加段。
                  </p>
                  <button
                    type="button"
                    onClick={handleAddSegment}
                    className="btn-secondary px-3.5 py-2 text-xs"
                  >
                    <PlusIcon className="h-3.5 w-3.5" />
                    <span>添加第一个段</span>
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  {segmentDrafts.map((draft, index) => {
                    const errorsForRow = segmentValidation.rowErrors.get(index) ?? [];
                    const hasRowError = errorsForRow.length > 0;
                    const preview = segmentValidation.normalizedPreviews.get(index);

                    return (
                      <div
                        key={draft.rowKey}
                        className={
                          hasRowError
                            ? "space-y-3 rounded-2xl border-2 border-[var(--danger-border)] bg-[var(--danger-bg)] p-4"
                            : "space-y-3 rounded-2xl border border-[var(--line)] bg-[var(--chip-bg)] p-4"
                        }
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="inline-flex items-center rounded-full border border-[var(--chip-line)] bg-[var(--surface-strong)] px-2.5 py-0.5 text-xs font-bold text-[var(--sea-ink)]">
                              第 {index + 1} 段
                            </span>
                            {preview && !hasRowError ? (
                              <span className="text-xs font-medium text-[var(--lagoon-deep)]">
                                {describeLinearSegment(preview)}
                              </span>
                            ) : null}
                          </div>

                          <button
                            type="button"
                            onClick={() => handleRemoveSegment(draft.rowKey)}
                            className="btn-danger px-2.5 py-1 text-xs"
                          >
                            <TrashIcon className="h-3.5 w-3.5" />
                            <span>删除</span>
                          </button>
                        </div>

                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                          <div className="space-y-1">
                            <label
                              htmlFor={`${draft.rowKey}-season`}
                              className="block text-xs font-semibold text-[var(--sea-ink)]"
                            >
                              季（season）
                            </label>
                            <input
                              id={`${draft.rowKey}-season`}
                              type="number"
                              min={0}
                              step={1}
                              value={draft.season}
                              onChange={(event) =>
                                handleUpdateSegment(draft.rowKey, { season: event.target.value })
                              }
                              className="field-input py-2 font-mono text-sm"
                            />
                          </div>

                          <div className="space-y-1">
                            <label
                              htmlFor={`${draft.rowKey}-start`}
                              className="block text-xs font-semibold text-[var(--sea-ink)]"
                            >
                              起（episodeStart）
                            </label>
                            <input
                              id={`${draft.rowKey}-start`}
                              type="number"
                              min={1}
                              step={1}
                              value={draft.episodeStart}
                              onChange={(event) =>
                                handleUpdateSegment(draft.rowKey, {
                                  episodeStart: event.target.value,
                                })
                              }
                              className="field-input py-2 font-mono text-sm"
                            />
                          </div>

                          <div className="space-y-1">
                            <label
                              htmlFor={`${draft.rowKey}-end`}
                              className="block text-xs font-semibold text-[var(--sea-ink)]"
                            >
                              止（episodeEnd）
                            </label>
                            <input
                              id={`${draft.rowKey}-end`}
                              type="number"
                              min={1}
                              step={1}
                              placeholder="留空=连载至季末"
                              value={draft.episodeEnd}
                              onChange={(event) =>
                                handleUpdateSegment(draft.rowKey, {
                                  episodeEnd: event.target.value,
                                })
                              }
                              className="field-input py-2 font-mono text-sm"
                            />
                          </div>

                          <div className="space-y-1">
                            <label
                              htmlFor={`${draft.rowKey}-target-start`}
                              className="block text-xs font-semibold text-[var(--sea-ink)]"
                            >
                              对方起始集号
                            </label>
                            <input
                              id={`${draft.rowKey}-target-start`}
                              type="number"
                              min={1}
                              step={1}
                              value={draft.targetEpisodeStart}
                              onChange={(event) =>
                                handleUpdateSegment(draft.rowKey, {
                                  targetEpisodeStart: event.target.value,
                                })
                              }
                              className="field-input py-2 font-mono text-sm"
                            />
                          </div>

                          <div className="space-y-1">
                            <label
                              htmlFor={`${draft.rowKey}-baseline`}
                              className="block text-xs font-semibold text-[var(--sea-ink)]"
                            >
                              基准（baseline）
                            </label>
                            <select
                              id={`${draft.rowKey}-baseline`}
                              value={draft.baseline}
                              onChange={(event) =>
                                handleUpdateSegment(draft.rowKey, {
                                  baseline: event.target.value as BaselineSource,
                                })
                              }
                              className="field-input py-2 text-sm"
                            >
                              {BASELINE_OPTIONS.map((opt) => (
                                <option key={opt.value} value={opt.value}>
                                  {opt.label}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>

                        <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-semibold text-[var(--sea-ink)]">
                          <input
                            type="checkbox"
                            checked={draft.nonLinear}
                            onChange={(event) =>
                              handleUpdateSegment(draft.rowKey, {
                                nonLinear: event.target.checked,
                              })
                            }
                            className="h-4 w-4 accent-[var(--lagoon-deep)]"
                          />
                          <span>集号不对应（nonLinear）</span>
                          <span className="font-normal text-[var(--sea-ink-soft)]">
                            — 集号不成线性对应（如综艺分上下期），仅确认合集归属、不换算集号
                          </span>
                        </label>

                        {hasRowError ? (
                          <ul className="m-0 list-disc space-y-0.5 pl-4 text-xs font-semibold text-[var(--danger-ink)]">
                            {errorsForRow.map((err, errIdx) => (
                              <li key={`${err.code}-${errIdx}`}>
                                {formatSegmentValidationError(err)}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="h-px bg-[var(--line)]" />

            {/* Submit Bar */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-xs text-[var(--sea-ink-soft)]">
                {!user.emailVerified ? (
                  <span className="font-semibold text-[var(--warn-ink)]">
                    完成邮箱验证后才能提交变更单。
                  </span>
                ) : !segmentValidation.valid ? (
                  <span className="font-semibold text-[var(--danger-ink)]">
                    请先修正上方段校验错误后再提交。
                  </span>
                ) : (
                  <span>
                    提交将调用 <code>POST /v1/change-requests</code>，成功后立即跳转至变更单状态页。
                  </span>
                )}
              </div>

              <button
                type="submit"
                disabled={!user.emailVerified || submitting || !segmentValidation.valid}
                className="btn-primary px-6 py-2.5"
              >
                <SendIcon className="h-4 w-4" />
                <span>{submitting ? "提交中..." : "提交变更单"}</span>
              </button>
            </div>
          </fieldset>
        </form>
      </section>
    </main>
  );
}
