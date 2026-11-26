import type { FeatureEpisode } from "./types.ts";

/**
 * Variety collections list every broadcast part ("第1期上", "第1期下", …) next to extras such as
 * 加更, 纯享, 陪看 or 训练室 that platforms still flag as full episodes. Catalogs (TMDB) count only
 * the broadcast parts, so in a collection whose episodes are labelled "第N期…", only those
 * labels are feature episodes. Names vary endlessly, so this whitelists the label shape instead
 * of blacklisting extras.
 */

/** "第1期", "第1期上", "第1期 下", "第1期（上）", "第12期上(一)", then end, space or colon. */
const BROADCAST_LABEL_PATTERN =
  /^第\s*\d+\s*期\s*[上中下]?\s*(?:[（(]\s*[上中下一二三四五六七八九十]\s*[)）])?(?=$|[\s:：])/u;

/** Extras whose own label is "第N期：…" but whose other label names the extra (Mango TV). */
const EXTRA_PREFIX_PATTERN =
  /纯享|加更|加长|福利|训练|纪录|沉浸|悄悄话|陪看|夜聊|惩罚|花絮|彩蛋|幕后|直拍|抢先|超前|精编|看点|reaction/iu;

/** A collection is broadcast-structured when at least this many episodes carry such a label. */
const MIN_BROADCAST_LABELS = 2;

function labels(episode: FeatureEpisode): string[] {
  return [episode.title, episode.longTitle].flatMap((l) => (l && l.trim() ? [l.trim()] : []));
}

export function isBroadcastLabel(label: string): boolean {
  return BROADCAST_LABEL_PATTERN.test(label.trim());
}

function isBroadcastEpisode(episode: FeatureEpisode): boolean {
  const all = labels(episode);
  return (
    all.some(isBroadcastLabel) &&
    !all.some((l) => EXTRA_PREFIX_PATTERN.test(l.split(/[:：\s]/u, 1)[0] ?? ""))
  );
}

/**
 * Keeps only broadcast parts when the collection is broadcast-structured, renumbering them from 1;
 * any other collection is returned unchanged.
 */
export function selectBroadcastEpisodes(episodes: readonly FeatureEpisode[]): FeatureEpisode[] {
  if (episodes.filter((ep) => labels(ep).some(isBroadcastLabel)).length < MIN_BROADCAST_LABELS) {
    return [...episodes];
  }
  return episodes.filter(isBroadcastEpisode).map((ep, i) => ({ ...ep, index: i + 1 }));
}
