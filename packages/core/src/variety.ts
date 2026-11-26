import type { FeatureEpisode } from "./adapters/types.ts";

/**
 * Air-date evidence for variety shows (ADR 0002 §2.2). Platforms list a variety season by
 * broadcast ("期"), often split into 上/下 parts with extras mixed in, while TMDB lists one
 * episode per broadcast date. Such a season can only be associated as a whole (a non-linear
 * segment), and only when the platform's main episodes line up with TMDB's air dates.
 */

/** Extras that are never the broadcast itself. */
const VARIETY_EXTRA_PATTERN = /加更|纯享|花絮|预告|彩蛋|幕后|看点|抢先看|精编|直拍|reaction/iu;

const DAY_MS = 86_400_000;
/** Required share of dated TMDB episodes with a same-date main episode on the platform. */
export const VARIETY_MIN_MATCH_RATIO = 0.8;

export interface CatalogEpisodeDate {
  episode: number;
  airDate: string | null;
}

export interface VarietyDateEvidence {
  /** First, middle and last dated TMDB episodes all matched, and enough of the rest did. */
  pass: boolean;
  matched: number;
  total: number;
  /** TMDB episode numbers of the first / middle / last samples that found no match. */
  missingSamples: number[];
}

export function isVarietyExtra(episode: FeatureEpisode): boolean {
  return VARIETY_EXTRA_PATTERN.test(`${episode.title ?? ""} ${episode.longTitle ?? ""}`);
}

function dayNumber(date: string): number | null {
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(ms) ? null : Math.round(ms / DAY_MS);
}

export function evaluateVarietyDateEvidence(
  catalogEpisodes: readonly CatalogEpisodeDate[],
  platformEpisodes: readonly FeatureEpisode[],
): VarietyDateEvidence {
  const platformDays = new Set<number>();
  for (const ep of platformEpisodes) {
    const day = ep.airDate ? dayNumber(ep.airDate) : null;
    if (day !== null && !isVarietyExtra(ep)) {
      platformDays.add(day);
    }
  }

  const dated = catalogEpisodes.flatMap((ep) => {
    const day = ep.airDate ? dayNumber(ep.airDate) : null;
    return day === null ? [] : [{ episode: ep.episode, day }];
  });
  // Platforms date by upload, sometimes in UTC: one day either way still counts.
  const hit = (day: number) =>
    platformDays.has(day) || platformDays.has(day - 1) || platformDays.has(day + 1);

  const matched = dated.filter((ep) => hit(ep.day)).length;
  if (dated.length === 0) {
    return { pass: false, matched: 0, total: 0, missingSamples: [] };
  }
  const samples = [...new Set([0, Math.floor((dated.length - 1) / 2), dated.length - 1])].map(
    (i) => dated[i]!,
  );
  const missingSamples = samples.filter((ep) => !hit(ep.day)).map((ep) => ep.episode);
  return {
    pass: missingSamples.length === 0 && matched / dated.length >= VARIETY_MIN_MATCH_RATIO,
    matched,
    total: dated.length,
    missingSamples,
  };
}
