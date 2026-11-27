import { isPlatformNamespace, type Namespace, type SegmentInput } from "@media-ref/client";
import type { CollectionInfo } from "./adapters/types.ts";
import { broadcastInstallment, hasVarietyExtraMarker } from "./adapters/variety.ts";
import type { CatalogEvidence, EvidenceGateConflict } from "./evidence-gate.ts";
import type { TmdbGateway } from "./tmdb.ts";

export type SeasonEpisode = NonNullable<
  Awaited<ReturnType<TmdbGateway["fetchSeasonEpisodes"]>>
>[number];
type CoverageScope = { season: number; count: number; prefixEnd: number | null };

/** Split but contiguous linear segments describe the same prefix as a single segment. */
export function seasonCoverageScopes(
  catalog: CatalogEvidence,
  namespace: Namespace,
  segments: readonly SegmentInput[],
): CoverageScope[] {
  if (!segments.length || !isPlatformNamespace(namespace)) return [];
  const scopes: CoverageScope[] = [];
  for (const { season, episodeCount: count } of catalog.seasons) {
    const own = segments
      .filter((s) => s.season === season)
      .toSorted((a, b) => (a.episodeStart ?? 1) - (b.episodeStart ?? 1));
    if (!own.length) continue;
    if (own.some((s) => s.nonLinear)) {
      let end = 0;
      for (const s of own) {
        if ((s.episodeStart ?? 1) > end + 1) break;
        end = Math.max(end, s.episodeEnd ?? Infinity);
      }
      if (end === Infinity || (count > 0 && end >= count))
        scopes.push({ season, count, prefixEnd: null });
      continue;
    }
    if (own.length !== segments.length || count <= 0) continue;
    let end = 0;
    for (const s of own) {
      if (
        s.episodeEnd == null ||
        (s.episodeStart ?? 1) !== end + 1 ||
        (s.targetEpisodeStart ?? 1) !== end + 1
      ) {
        end = 0;
        break;
      }
      end = s.episodeEnd;
    }
    if (end > 0 && end < count) scopes.push({ season, count, prefixEnd: end });
  }
  return scopes;
}

/** Fetch a season once for all submitted and competing mappings; outages must not turn into proof. */
export async function fetchSegmentEpisodeEvidence(
  gateway: TmdbGateway,
  catalog: CatalogEvidence,
  mappings: readonly { namespace: Namespace; segments: readonly SegmentInput[] }[],
): Promise<CatalogEvidence> {
  const tmdbId = catalog.namespace === "tmdb" && catalog.canonicalId.match(/^tv:(\d+)$/)?.[1];
  if (!tmdbId) return catalog;
  const required = new Set(
    mappings.flatMap(({ namespace, segments }) =>
      seasonCoverageScopes(catalog, namespace, segments).map((s) => s.season),
    ),
  );
  const seasons = new Set([
    ...required,
    ...mappings.flatMap(({ segments }) =>
      segments.filter((s) => (s.episodeStart ?? 1) > 1).map((s) => s.season),
    ),
  ]);
  const seasonEpisodes: Record<number, readonly SeasonEpisode[]> = {};
  for (const season of seasons) {
    try {
      seasonEpisodes[season] = (await gateway.fetchSeasonEpisodes(tmdbId, season)) ?? [];
    } catch (error) {
      if (required.has(season)) throw error;
      // Without an episode-specific air year, use the season premiere year.
    }
  }
  return { ...catalog, seasonEpisodes };
}

function subtitle(label: string, collectionTitle: string): string | null {
  let text = label.normalize("NFKC").trim();
  collectionTitle = collectionTitle.normalize("NFKC").trim();
  if (text.startsWith(collectionTitle)) text = text.slice(collectionTitle.length).trim();
  text = text
    .replace(
      /^(?:第\s*\d+\s*[期集话話回]\s*(?:[上中下]|\([上中下]\))?|(?:s\d+\s*)?e(?:p(?:isode)?)?\s*\d+)\s*[:：\-\s]*/iu,
      "",
    )
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "");
  return text.length >= 4 &&
    !/^(?:\d+|\d{4}年\d{1,2}月\d{1,2}日?)$/u.test(text) &&
    !/^(?:part\d*|大结局|收官|seasonfinale|finale)$/u.test(text) &&
    !hasVarietyExtraMarker(text)
    ? text
    : null;
}

function matchesSeasonEpisodes(
  info: CollectionInfo,
  episodes: readonly SeasonEpisode[],
  scope: CoverageScope,
  catalog: CatalogEvidence,
) {
  const byEpisode = [...new Map(episodes.map((ep) => [ep.episode, ep])).values()].sort(
    (a, b) => a.episode - b.episode,
  );
  const completeCatalog =
    scope.count > 0 &&
    byEpisode.length === scope.count &&
    byEpisode.every((ep, i) => ep.episode === i + 1);
  const regular = byEpisode.filter(
    (ep) => !ep.title || scope.season === 0 || !hasVarietyExtraMarker(ep.title),
  );
  const finale = completeCatalog ? regular.at(-1) : undefined;
  const platformTitles = new Set<string>();
  const periods = new Map<number, Set<string>>();
  const labeledEpisodes = new Set<number>();
  for (const ep of info.featureEpisodes) {
    const labels = [ep.title, ep.longTitle];
    if (scope.season !== 0 && labels.some((label) => label && hasVarietyExtraMarker(label)))
      continue;
    for (const label of labels) {
      if (!label) continue;
      platformTitles.add(label.trim());
      const installment = broadcastInstallment(label);
      if (installment) {
        labeledEpisodes.add(ep.index);
        const parts = periods.get(installment.number) ?? new Set<string>();
        parts.add(installment.part);
        periods.set(installment.number, parts);
      }
    }
  }
  const titles = new Set(
    [...platformTitles].map((label) => subtitle(label, info.title)).filter(Boolean),
  );
  for (const name of [
    catalog.title,
    catalog.originalTitle,
    ...(catalog.aliases ?? []),
    info.title,
    info.originalTitle,
    ...(info.aliases ?? []),
  ]) {
    if (name) titles.delete(subtitle(name, ""));
  }
  const catalogTitles = new Map<string, number | null>();
  const prefixInstallments = new Set<string>();
  let coversBroadcasts = true;
  let matchedEpisode = 0;
  let finalePeriod: number | null = null;
  for (const ep of regular) {
    const title = subtitle(ep.title ?? "", info.title);
    if (title) catalogTitles.set(title, catalogTitles.has(title) ? null : ep.episode);
    const installment = broadcastInstallment(ep.title ?? "");
    if (!installment) continue;
    const { number, part } = installment;
    const parts = periods.get(number);
    const covered =
      parts?.has("") || (part ? parts?.has(part) : parts?.has("上") && parts.has("下"));
    if (!covered) coversBroadcasts = false;
    const key = `${number}:${part}`;
    if (scope.prefixEnd !== null && ep.episode <= scope.prefixEnd) prefixInstallments.add(key);
    if (covered && !prefixInstallments.has(key) && !prefixInstallments.has(`${number}:`)) {
      matchedEpisode = Math.max(matchedEpisode, ep.episode);
      if (ep === finale) finalePeriod = number;
    }
  }
  let matchedTitleEpisode = 0;
  for (const [title, episode] of catalogTitles) {
    if (episode && titles.has(title)) matchedTitleEpisode = Math.max(matchedTitleEpisode, episode);
  }
  // Season zero has specials rather than a broadcast finale; the list itself can verify every title.
  const allSpecials =
    scope.season === 0 &&
    completeCatalog &&
    new Set(regular.map((ep) => ep.title)).size === regular.length &&
    regular.every((ep) => ep.title && !/^\d+$/u.test(ep.title) && platformTitles.has(ep.title));
  const titleMatchesFinale =
    matchedTitleEpisode === finale?.episode &&
    (labeledEpisodes.size < info.featureEpisodes.length || coversBroadcasts) &&
    (regular.length === 1 || info.featureEpisodes.length > 1);
  return {
    finale,
    matchedEpisode: Math.max(matchedEpisode, matchedTitleEpisode),
    finalePeriod,
    reachesFinale: allSpecials || titleMatchesFinale || (coversBroadcasts && finalePeriod !== null),
  };
}

export function seasonCoverageConflict(
  catalog: CatalogEvidence,
  info: CollectionInfo,
  segments: readonly SegmentInput[],
): Pick<EvidenceGateConflict, "code" | "message"> | null {
  for (const scope of seasonCoverageScopes(catalog, info.namespace, segments)) {
    const sameBaseline = segments.every(
      (s) => s.season !== scope.season || s.baseline === catalog.namespace,
    );
    const episodes = sameBaseline ? (catalog.seasonEpisodes?.[scope.season] ?? []) : [];
    const { finale, matchedEpisode, finalePeriod, reachesFinale } = matchesSeasonEpisodes(
      info,
      episodes,
      scope,
      catalog,
    );
    if (scope.prefixEnd === null) {
      if (!reachesFinale)
        return {
          code: "season_finale_unverified",
          message: `${info.canonicalId} has no verified coverage through season ${scope.season}'s final broadcast. Submit only the verified episode range.`,
        };
    } else if (reachesFinale && finale && finale.episode > scope.prefixEnd) {
      return {
        code: "partial_segment_spans_full_season",
        message: `${info.canonicalId} matches season ${scope.season} episode ${finale.episode}${finalePeriod === null ? "" : ` (第${finalePeriod}期)`}, beyond 1..${scope.prefixEnd}. If the collection covers the complete season with different episode numbering, use a whole-season nonLinear segment.`,
      };
    } else if (matchedEpisode > scope.prefixEnd) {
      return {
        code: "partial_segment_outside_prefix",
        message: `${info.canonicalId} reaches season ${scope.season} episode ${matchedEpisode}, beyond 1..${scope.prefixEnd}. Submit the verified finite range, using nonLinear when numbering differs.`,
      };
    }
  }
  return null;
}
