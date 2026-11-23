import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { AlertTriangleIcon, CheckIcon, RefreshIcon } from "#/components/Icons";
import {
  BASELINE_LABELS,
  NAMESPACE_LABELS,
  PLATFORM_LABELS,
  PLATFORM_ORDER,
  fetchAnonymousMedia,
  isPlatformNamespace,
  type AnonymousMediaResult,
  type Association,
  type AssociationStatus,
  type MediaDocument,
  type PlatformNamespace,
  type PlatformStatusEntry,
  type Segment,
  type Variant,
} from "#/lib/media-internal";

export const Route = createFileRoute("/media/$key")({
  loader: async ({ params }): Promise<AnonymousMediaResult> => {
    return fetchAnonymousMedia({ data: { key: params.key } });
  },
  head: ({ loaderData }) => {
    if (loaderData?.status === "ok") {
      const { title, year } = loaderData.document.media.snapshot;
      const suffix = year ? ` (${year})` : "";
      return {
        meta: [{ title: `${title}${suffix} · media-ref` }],
      };
    }
    if (loaderData?.status === "not_found") {
      return { meta: [{ title: "未找到媒体 · media-ref" }] };
    }
    if (loaderData?.status === "rate_limited") {
      return { meta: [{ title: "访问频率受限 · media-ref" }] };
    }
    return { meta: [{ title: "媒体详情 · media-ref" }] };
  },
  component: AnonymousMediaPage,
});

function formatSeasonLabel(season: number): string {
  return season === 0 ? "特别篇 (S0)" : `第 ${season} 季 (S${season})`;
}

function formatEpisodeRange(segment: Segment): string {
  if (segment.episodeEnd === null) {
    return `第 ${segment.episodeStart} 集–连载中`;
  }
  if (segment.episodeStart === segment.episodeEnd) {
    return `第 ${segment.episodeStart} 集`;
  }
  return `第 ${segment.episodeStart}–${segment.episodeEnd} 集`;
}

function formatAssociationStatus(status: AssociationStatus): {
  label: string;
  tone: "ok" | "warn" | "danger";
} {
  switch (status) {
    case "confirmed":
      return { label: "已确认", tone: "ok" };
    case "seed_unconfirmed":
      return { label: "种子未确认", tone: "warn" };
    case "delisted":
      return { label: "已下架", tone: "danger" };
  }
}

function formatCheckedDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function statusPillClass(tone: "ok" | "warn" | "danger" | "neutral"): string {
  switch (tone) {
    case "ok":
      return "inline-flex items-center gap-1 rounded-full border border-[var(--ok-border)] bg-[var(--ok-bg)] px-2.5 py-0.5 text-xs font-bold whitespace-nowrap text-[var(--ok-ink)]";
    case "warn":
      return "inline-flex items-center gap-1 rounded-full border border-[var(--warn-border)] bg-[var(--warn-bg)] px-2.5 py-0.5 text-xs font-bold whitespace-nowrap text-[var(--warn-ink)]";
    case "danger":
      return "inline-flex items-center gap-1 rounded-full border border-[var(--danger-border)] bg-[var(--danger-bg)] px-2.5 py-0.5 text-xs font-bold whitespace-nowrap text-[var(--danger-ink)]";
    default:
      return "inline-flex items-center gap-1 rounded-full border border-[var(--line)] bg-[var(--chip-bg)] px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap text-[var(--sea-ink-soft)]";
  }
}

function formatPlatformStatusLabel(entry: PlatformStatusEntry | undefined): {
  label: string;
  tone: "ok" | "warn" | "neutral";
} {
  if (!entry || entry.status === "unchecked") {
    return { label: "尚未检查", tone: "neutral" };
  }
  if (entry.status === "associated") {
    return { label: "已有关联", tone: "ok" };
  }
  return {
    label: `找过没有（${formatCheckedDate(entry.checkedAt)}）`,
    tone: "warn",
  };
}

function SegmentList({ segments }: { segments: readonly Segment[] }) {
  if (segments.length === 0) {
    return (
      <span className="inline-flex items-center rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-2.5 py-0.5 text-xs font-semibold text-[var(--sea-ink)]">
        整部对整部
      </span>
    );
  }

  return (
    <ul className="m-0 list-none space-y-2 p-0">
      {segments.map((segment, index) => (
        <li
          key={`${segment.season}-${segment.episodeStart}-${segment.episodeEnd ?? "ongoing"}-${segment.targetEpisodeStart}-${index}`}
          className="flex flex-wrap items-center gap-1.5 rounded-xl border border-[var(--line)] bg-[var(--chip-bg)] px-3 py-2 text-xs"
        >
          <span className="font-bold text-[var(--sea-ink)]">
            {formatSeasonLabel(segment.season)}
          </span>
          <span className="text-[var(--sea-ink-soft)]">·</span>
          <span className="font-semibold text-[var(--sea-ink)]">{formatEpisodeRange(segment)}</span>

          {segment.nonLinear ? (
            <span className={statusPillClass("warn")}>集号不对应</span>
          ) : (
            <>
              <span className="text-[var(--sea-ink-soft)]">→</span>
              <span className="font-mono text-[var(--lagoon-deep)]">
                合集第 {segment.targetEpisodeStart} 集起
              </span>
            </>
          )}

          <span className="rounded-md border border-[var(--line)] bg-[var(--surface-strong)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--sea-ink-soft)]">
            基准：{BASELINE_LABELS[segment.baseline]}
          </span>

          {segment.needsReview ? <span className={statusPillClass("warn")}>待复核</span> : null}
        </li>
      ))}
    </ul>
  );
}

function AssociationsTable({
  associations,
  matchedAssociationId,
}: {
  associations: readonly Association[];
  matchedAssociationId: string | null;
}) {
  if (associations.length === 0) {
    return (
      <p className="m-0 rounded-xl border border-dashed border-[var(--line)] bg-[var(--chip-bg)] px-4 py-3 text-xs text-[var(--sea-ink-soft)]">
        该分组暂无已确认的关联。
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-2xl border border-[var(--line)]">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-[var(--line)] bg-[var(--chip-bg)] text-xs font-bold text-[var(--sea-ink-soft)]">
            <th className="px-4 py-3">合集 / 条目原生 ID</th>
            <th className="px-4 py-3">状态与标记</th>
            <th className="px-4 py-3">段（季集对应）</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--line)]">
          {associations.map((association) => {
            const status = formatAssociationStatus(association.status);
            const isMatched = matchedAssociationId === association.id;
            const externalKey = `${association.namespace}:${association.nativeId}`;

            return (
              <tr
                key={association.id}
                className={
                  isMatched
                    ? "bg-[color-mix(in_oklab,var(--lagoon)_12%,transparent)]"
                    : "transition hover:bg-[color-mix(in_oklab,var(--lagoon)_5%,transparent)]"
                }
              >
                <td className="px-4 py-3.5 align-top">
                  <div className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <code className="font-mono text-xs font-semibold text-[var(--sea-ink)]">
                        {association.nativeId}
                      </code>
                      {isMatched ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-[var(--chip-line)] bg-[var(--surface-strong)] px-2 py-0.5 text-[11px] font-bold text-[var(--lagoon-deep)]">
                          <CheckIcon className="h-3 w-3" />
                          当前命中
                        </span>
                      ) : null}
                    </div>
                    <span className="font-mono text-[11px] text-[var(--sea-ink-soft)]">
                      {externalKey}
                    </span>
                  </div>
                </td>
                <td className="px-4 py-3.5 align-top">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className={statusPillClass(status.tone)}>{status.label}</span>
                    {association.needsReview ? (
                      <span className={statusPillClass("warn")}>待复核</span>
                    ) : null}
                    {association.locked ? (
                      <span className="inline-flex items-center rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-2.5 py-0.5 text-xs font-bold whitespace-nowrap text-[var(--lagoon-deep)]">
                        锁定
                      </span>
                    ) : null}
                  </div>
                </td>
                <td className="px-4 py-3.5 align-top">
                  <SegmentList segments={association.segments} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface PlatformGroup {
  platform: PlatformNamespace;
  variants: Array<{
    variant: Variant;
    associations: Association[];
  }>;
  ungroupedAssociations: Association[];
}

function buildPlatformGroups(doc: MediaDocument): {
  platformGroups: PlatformGroup[];
  catalogAssociations: Association[];
} {
  const variantsByPlatform = new Map<PlatformNamespace, Variant[]>();
  for (const variant of doc.variants) {
    const list = variantsByPlatform.get(variant.namespace) ?? [];
    list.push(variant);
    variantsByPlatform.set(variant.namespace, list);
  }

  const associationsByVariantId = new Map<string, Association[]>();
  const ungroupedByPlatform = new Map<PlatformNamespace, Association[]>();
  const catalogAssociations: Association[] = [];

  for (const association of doc.associations) {
    if (!isPlatformNamespace(association.namespace)) {
      catalogAssociations.push(association);
      continue;
    }

    if (association.variantId) {
      const list = associationsByVariantId.get(association.variantId) ?? [];
      list.push(association);
      associationsByVariantId.set(association.variantId, list);
    } else {
      const list = ungroupedByPlatform.get(association.namespace) ?? [];
      list.push(association);
      ungroupedByPlatform.set(association.namespace, list);
    }
  }

  const platformGroups: PlatformGroup[] = [];
  for (const platform of PLATFORM_ORDER) {
    const variants = (variantsByPlatform.get(platform) ?? []).slice().sort((a, b) => {
      if (a.isDefault !== b.isDefault) {
        return a.isDefault ? -1 : 1;
      }
      return a.label.localeCompare(b.label, "zh-CN");
    });
    const ungroupedAssociations = ungroupedByPlatform.get(platform) ?? [];

    if (variants.length === 0 && ungroupedAssociations.length === 0) {
      continue;
    }

    platformGroups.push({
      platform,
      variants: variants.map((variant) => ({
        variant,
        associations: associationsByVariantId.get(variant.id) ?? [],
      })),
      ungroupedAssociations,
    });
  }

  return { platformGroups, catalogAssociations };
}

function AnonymousMediaPage() {
  const { user } = Route.useRouteContext();
  const { key } = Route.useParams();
  const result = Route.useLoaderData();
  const router = useRouter();

  const currentMediaPath = `/media/${encodeURIComponent(key)}`;

  if (result.status !== "ok") {
    const isRateLimited = result.status === "rate_limited";
    const isNotFound = result.status === "not_found";
    const isInvalidKey = result.status === "invalid_key";

    const kicker = isRateLimited
      ? "429 · 访问频率受限"
      : isNotFound
        ? "404 · 未找到媒体"
        : isInvalidKey
          ? "400 · 无效查询键"
          : "媒体页暂不可用";

    const heading = isRateLimited
      ? "当前 IP 请求过于频繁"
      : isNotFound
        ? "未找到这部媒体"
        : isInvalidKey
          ? "媒体查询键格式不正确"
          : "暂时无法加载媒体详情";

    return (
      <main className="page-wrap px-4 py-12 sm:py-16">
        <section className="island-shell rise-in mx-auto max-w-xl rounded-3xl p-6 sm:p-9">
          <p className="island-kicker m-0 mb-2">{kicker}</p>
          <h1 className="display-title m-0 mb-3 text-2xl font-bold text-[var(--sea-ink)] sm:text-3xl">
            {heading}
          </h1>

          <div
            role="alert"
            className={
              isRateLimited
                ? "mb-5 flex items-start gap-2.5 rounded-2xl border border-[var(--warn-border)] bg-[var(--warn-bg)] p-4 text-sm text-[var(--warn-ink)]"
                : "mb-5 flex items-start gap-2.5 rounded-2xl border border-[var(--line)] bg-[var(--chip-bg)] p-4 text-sm text-[var(--sea-ink-soft)]"
            }
          >
            <AlertTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="space-y-1">
              <p className="m-0 font-semibold">{result.message}</p>
              <p className="m-0 text-xs opacity-85">
                查询键：<code>{key}</code>
              </p>
              {isInvalidKey ? (
                <p className="m-0 text-xs opacity-85">
                  支持媒体 UUID 或外部键，例如 <code>tmdb:tv:95479</code>、
                  <code>imdb:tt12343534</code>、<code>bilibili:ss34430</code>。
                </p>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {isRateLimited || result.status === "error" || result.status === "unavailable" ? (
              <button
                type="button"
                onClick={() => void router.invalidate()}
                className="btn-primary"
              >
                <RefreshIcon className="h-4 w-4" />
                <span>重新加载</span>
              </button>
            ) : null}

            {user ? (
              <Link to="/" className="btn-secondary">
                返回工作台
              </Link>
            ) : (
              <>
                <Link to="/login" search={{ redirect: currentMediaPath }} className="btn-primary">
                  登录后提交关联
                </Link>
                <Link
                  to="/register"
                  search={{ redirect: currentMediaPath }}
                  className="btn-secondary"
                >
                  注册账号
                </Link>
              </>
            )}
          </div>

          <p className="mt-5 mb-0 text-xs text-[var(--sea-ink-soft)]">
            匿名访问仅支持通过准确链接打开单个媒体页，不提供站内搜索与媒体列表。
          </p>
        </section>
      </main>
    );
  }

  const { document: doc, matchedAssociationId } = result;
  const { media } = doc;
  const { snapshot } = media;
  const { platformGroups, catalogAssociations } = buildPlatformGroups(doc);
  const matchedAssociation = matchedAssociationId
    ? doc.associations.find((assoc) => assoc.id === matchedAssociationId)
    : undefined;

  return (
    <main className="page-wrap space-y-6 px-4 pt-8 pb-10 sm:pt-10">
      {/* 1. Media Minimal Snapshot */}
      <section className="island-shell rise-in relative overflow-hidden rounded-3xl px-6 py-7 sm:px-9 sm:py-9">
        <div className="pointer-events-none absolute -top-24 -left-20 h-56 w-56 rounded-full bg-[radial-gradient(circle,rgba(79,184,178,0.25),transparent_68%)]" />
        <div className="pointer-events-none absolute -right-20 -bottom-24 h-56 w-56 rounded-full bg-[radial-gradient(circle,rgba(47,106,74,0.14),transparent_68%)]" />

        <div className="relative space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="island-kicker">媒体详情 · 只读快照</span>
            <span className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-2.5 py-0.5 text-xs font-bold text-[var(--lagoon-deep)]">
              {media.type === "tv" ? "剧集" : "电影"}
            </span>
            {snapshot.year ? (
              <span className="rounded-full border border-[var(--line)] bg-[var(--chip-bg)] px-2.5 py-0.5 text-xs font-semibold text-[var(--sea-ink)]">
                {snapshot.year} 年
              </span>
            ) : null}
            <span className="rounded-full border border-[var(--line)] bg-[var(--chip-bg)] px-2.5 py-0.5 text-xs font-semibold text-[var(--sea-ink-soft)]">
              {media.baseline
                ? `基准：${BASELINE_LABELS[media.baseline]}`
                : "暂无基准（仅整部对整部）"}
            </span>
          </div>

          <div className="space-y-1.5">
            <h1 className="display-title m-0 text-3xl font-bold tracking-tight text-[var(--sea-ink)] sm:text-4xl">
              {snapshot.title}
            </h1>
            {snapshot.originalTitle && snapshot.originalTitle !== snapshot.title ? (
              <p className="m-0 text-sm font-medium text-[var(--sea-ink-soft)] sm:text-base">
                原名：{snapshot.originalTitle}
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-[var(--sea-ink-soft)]">
            <span>
              媒体 ID：<code className="font-mono text-[var(--sea-ink)]">{media.id}</code>
            </span>
            {matchedAssociation ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-[var(--ok-border)] bg-[var(--ok-bg)] px-2.5 py-0.5 font-semibold text-[var(--ok-ink)]">
                <CheckIcon className="h-3.5 w-3.5" />
                查询键命中 {NAMESPACE_LABELS[matchedAssociation.namespace]}：
                <code className="border-0 bg-transparent p-0 font-mono text-inherit">
                  {matchedAssociation.nativeId}
                </code>
              </span>
            ) : null}
          </div>

          {media.type === "tv" && snapshot.seasons.length > 0 ? (
            <div className="pt-2">
              <p className="m-0 mb-2 text-xs font-bold text-[var(--sea-ink-soft)]">
                季集概览（共 {snapshot.seasons.length} 季）
              </p>
              <div className="flex flex-wrap gap-2">
                {snapshot.seasons.map((season) => (
                  <div
                    key={season.season}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--line)] bg-[var(--chip-bg)] px-3 py-1.5 text-xs"
                  >
                    <span className="font-bold text-[var(--sea-ink)]">
                      {formatSeasonLabel(season.season)}
                    </span>
                    <span className="text-[var(--sea-ink-soft)]">{season.episodeCount} 集</span>
                    {season.airYear ? (
                      <span className="text-[var(--sea-ink-soft)]">· {season.airYear}</span>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </section>

      {/* 2. External IDs */}
      <section className="island-shell rounded-3xl p-6 sm:p-7">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="island-kicker m-0 mb-1">External IDs</p>
            <h2 className="m-0 text-lg font-bold text-[var(--sea-ink)]">外部编号</h2>
          </div>
          <span className="rounded-full border border-[var(--line)] bg-[var(--chip-bg)] px-3 py-1 text-xs font-bold text-[var(--sea-ink)]">
            共 {doc.externalIds.length} 项
          </span>
        </div>

        {doc.externalIds.length === 0 ? (
          <p className="m-0 text-sm text-[var(--sea-ink-soft)]">暂无外部编号记录。</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {doc.externalIds.map((ext) => (
              <div
                key={`${ext.namespace}:${ext.nativeId}`}
                className="flex flex-col gap-1.5 rounded-2xl border border-[var(--line)] bg-[var(--chip-bg)] px-4 py-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold text-[var(--sea-ink-soft)]">
                    {NAMESPACE_LABELS[ext.namespace]}
                  </span>
                  {ext.locked ? (
                    <span className="rounded-full border border-[var(--chip-line)] bg-[var(--surface-strong)] px-2 py-0.5 text-[11px] font-bold text-[var(--lagoon-deep)]">
                      锁定
                    </span>
                  ) : null}
                </div>
                <code className="font-mono text-xs font-semibold break-all text-[var(--sea-ink)]">
                  {ext.namespace}:{ext.nativeId}
                </code>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 3. Platform Variants, Associations & Segments */}
      <section className="island-shell space-y-6 rounded-3xl p-6 sm:p-7">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="island-kicker m-0 mb-1">Platforms · Variants · Segments</p>
            <h2 className="m-0 text-lg font-bold text-[var(--sea-ink)]">平台变体、关联与段</h2>
            <p className="mt-1 mb-0 text-sm text-[var(--sea-ink-soft)]">
              仅展示已确认的平台关联。同一平台下按变体分组，并标出查询未指定变体时采用的默认变体。
            </p>
          </div>
          <span className="self-start rounded-full border border-[var(--line)] bg-[var(--chip-bg)] px-3 py-1 text-xs font-bold text-[var(--sea-ink)] sm:self-auto">
            {doc.variants.length} 个变体 · {doc.associations.length} 条关联
          </span>
        </div>

        {/* Platform status strip */}
        {doc.platformStatuses ? (
          <div className="grid gap-2.5 sm:grid-cols-5">
            {PLATFORM_ORDER.map((platform) => {
              const statusInfo = formatPlatformStatusLabel(doc.platformStatuses?.[platform]);
              return (
                <div
                  key={platform}
                  className="flex items-center justify-between gap-2 rounded-2xl border border-[var(--line)] bg-[var(--chip-bg)] px-3.5 py-2.5 sm:flex-col sm:items-start"
                >
                  <span className="text-xs font-bold text-[var(--sea-ink)]">
                    {PLATFORM_LABELS[platform]}
                  </span>
                  <span className={statusPillClass(statusInfo.tone)}>{statusInfo.label}</span>
                </div>
              );
            })}
          </div>
        ) : null}

        {platformGroups.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[var(--line)] bg-[var(--chip-bg)] px-6 py-10 text-center">
            <p className="m-0 text-sm font-semibold text-[var(--sea-ink)]">
              暂无已确认的视频平台关联
            </p>
            <p className="mt-1 mb-0 text-xs text-[var(--sea-ink-soft)]">
              登录后可为这部媒体提交腾讯视频、爱奇艺、优酷、B 站或芒果 TV 的合集关联与段。
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {platformGroups.map((group) => (
              <div
                key={group.platform}
                className="space-y-4 rounded-2xl border border-[var(--line)] bg-[color-mix(in_oklab,var(--surface-strong)_70%,transparent)] p-4 sm:p-5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--line)] pb-3">
                  <div className="flex items-center gap-2">
                    <h3 className="m-0 text-base font-bold text-[var(--sea-ink)]">
                      {PLATFORM_LABELS[group.platform]}
                    </h3>
                    <code className="font-mono text-xs text-[var(--sea-ink-soft)]">
                      {group.platform}
                    </code>
                  </div>
                  <span className="text-xs font-semibold text-[var(--sea-ink-soft)]">
                    {group.variants.length} 个变体
                  </span>
                </div>

                {group.variants.map(({ variant, associations }) => (
                  <div key={variant.id} className="space-y-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-bold text-[var(--sea-ink)]">
                        变体：{variant.label}
                      </span>
                      {variant.isDefault ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-[var(--ok-border)] bg-[var(--ok-bg)] px-2.5 py-0.5 text-xs font-bold text-[var(--ok-ink)]">
                          <CheckIcon className="h-3.5 w-3.5" />
                          默认
                        </span>
                      ) : null}
                      <span className="text-xs text-[var(--sea-ink-soft)]">
                        （{associations.length} 条关联）
                      </span>
                    </div>

                    <AssociationsTable
                      associations={associations}
                      matchedAssociationId={matchedAssociationId}
                    />
                  </div>
                ))}

                {group.ungroupedAssociations.length > 0 ? (
                  <div className="space-y-2.5">
                    <span className="block text-sm font-bold text-[var(--sea-ink-soft)]">
                      未分组关联
                    </span>
                    <AssociationsTable
                      associations={group.ungroupedAssociations}
                      matchedAssociationId={matchedAssociationId}
                    />
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 4. Catalog Associations (Douban / Bangumi) */}
      {catalogAssociations.length > 0 ? (
        <section className="island-shell space-y-4 rounded-3xl p-6 sm:p-7">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="island-kicker m-0 mb-1">Catalog Associations</p>
              <h2 className="m-0 text-lg font-bold text-[var(--sea-ink)]">目录关联</h2>
            </div>
            <span className="rounded-full border border-[var(--line)] bg-[var(--chip-bg)] px-3 py-1 text-xs font-bold text-[var(--sea-ink)]">
              共 {catalogAssociations.length} 条
            </span>
          </div>

          <AssociationsTable
            associations={catalogAssociations}
            matchedAssociationId={matchedAssociationId}
          />
        </section>
      ) : null}

      {/* 5. CTA Card (no search bar, no media list) */}
      <section className="island-shell rounded-3xl p-6 sm:p-7">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <p className="island-kicker m-0">参与维护</p>
            <h2 className="m-0 text-base font-bold text-[var(--sea-ink)]">
              发现缺失合集、段对应有误或合集已失效？
            </h2>
            <p className="m-0 text-sm text-[var(--sea-ink-soft)]">
              {user
                ? "你已登录，可通过工作台和接口密钥提交新变更单或上报失效合集。"
                : "登录验证邮箱后，即可提交更正变更单、补充新变体与段，或通过接口密钥上报失效合集。"}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {user ? (
              <>
                <Link to="/keys" className="btn-primary">
                  管理接口密钥
                </Link>
                <Link to="/" className="btn-secondary">
                  返回工作台
                </Link>
              </>
            ) : (
              <>
                <Link to="/login" search={{ redirect: currentMediaPath }} className="btn-primary">
                  登录以提交更正
                </Link>
                <Link
                  to="/register"
                  search={{ redirect: currentMediaPath }}
                  className="btn-secondary"
                >
                  注册账号
                </Link>
              </>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
