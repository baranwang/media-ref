import type { Namespace } from "@media-ref/client";
import { buildExternalUrl } from "./url-parser";

export type ChangeRequestLink = { href: string; source: "entry" | "submission" };

const decimal = /^[1-9]\d*$/;

const tvdbId = /^(series|tv|movie|episode|season):([1-9]\d*)$/;

function tvdbLink(
  id: string,
  raw: string,
  collection: Record<string, unknown> | null,
): ChangeRequestLink | null {
  const typed = tvdbId.exec(id);
  if (!typed && !decimal.test(id)) return null;
  let type = typed?.[1] === "tv" ? "series" : typed?.[1];
  const number = typed?.[2] ?? id;
  // Catalog/target evidence describes the media, not this association's entry.
  let tvCollection = false;
  if (collection?.namespace === "tvdb" && typeof collection.canonicalId === "string") {
    const checked = tvdbId.exec(collection.canonicalId);
    if ((checked?.[2] ?? collection.canonicalId) !== number) return null;
    const checkedType = checked?.[1] === "tv" ? "series" : checked?.[1];
    if (type && checkedType && type !== checkedType) return null;
    type ??= checkedType;
    tvCollection = collection.mediaType === "tv";
    if (
      (tvCollection && type === "movie") ||
      (collection.mediaType === "movie" && type && type !== "movie")
    )
      return null;
    if (collection.mediaType === "movie") type = "movie";
  }
  const url = raw.length <= 500 ? URL.parse(raw) : null;
  if (
    url &&
    !url.username &&
    !url.password &&
    (url.origin === "https://thetvdb.com" || url.origin === "https://www.thetvdb.com")
  ) {
    const direct = /^\/dereferrer\/(series|movie|episode|season)\/([1-9]\d*)\/?$/.exec(
      url.pathname,
    );
    const episode = /^\/series\/[a-z0-9-]+\/episodes\/([1-9]\d*)\/?$/.exec(url.pathname);
    const rawType = direct?.[1] ?? (episode ? "episode" : null);
    if (rawType) {
      if (
        (direct?.[2] ?? episode?.[1]) !== number ||
        (type && type !== rawType) ||
        (tvCollection && rawType === "movie")
      )
        return null;
      return {
        href: `https://thetvdb.com/dereferrer/${rawType}/${number}`,
        source: type ? "entry" : "submission",
      };
    }
  }
  return type
    ? { href: `https://thetvdb.com/dereferrer/${type}/${number}`, source: "entry" }
    : null;
}

/** Build a destination from an entry identity, never from an arbitrary stored URL. */
export function changeRequestLink(
  namespace: Namespace,
  nativeId: string,
  raw: string,
  resolved: Record<string, unknown> | null,
  collection: Record<string, unknown> | null,
): ChangeRequestLink | null {
  if (!nativeId || nativeId.length > 500) return null;
  if (namespace === "tvdb") return tvdbLink(nativeId, raw, collection);
  const page =
    resolved?.namespace === namespace && resolved.nativeId === nativeId ? resolved : null;
  const alias = typeof page?.id === "string" && page.id.length <= 500 ? page.id : "";
  let id = nativeId;
  switch (namespace) {
    case "bilibili":
      if (!/^ss[1-9]\d*$/i.test(id)) return null;
      if (decimal.test(alias) && (page?.kind === "episode" || page?.kind === "media"))
        id = (page.kind === "episode" ? "ep" : "md") + alias;
      break;
    case "iqiyi":
      if (!/^[1-9]\d{5,}$/.test(id)) return null;
      if (
        /^[a-z0-9]+$/i.test(alias) &&
        (page?.kind === "video_page" || page?.kind === "album_page")
      )
        id = (page.kind === "video_page" ? "v_" : "a_") + alias;
      break;
    case "youku":
      if (!/^[0-9a-f]{20}$/i.test(id)) return null;
      if (page?.kind === "video" && /^[A-Za-z0-9=_-]{2,64}$/.test(alias))
        return { href: `https://v.youku.com/v_show/id_${alias}.html`, source: "entry" };
      break;
    case "tencent":
      if (!/^[a-z0-9]{15}$/.test(id)) return null;
      break;
    case "mgtv":
    case "douban":
    case "bangumi":
      if (!decimal.test(id)) return null;
      break;
    case "imdb":
      if (!/^tt\d+$/.test(id)) return null;
      break;
    case "tmdb":
      if (!/^(tv|movie):[1-9]\d*$/.test(id)) return null;
      break;
    case "trakt": {
      const typed = /^(show|movie):([a-z0-9][a-z0-9-]*)$/.exec(id);
      return typed
        ? {
            href: buildExternalUrl(namespace, typed[2]!, typed[1] === "show" ? "tv" : "movie"),
            source: "entry",
          }
        : null;
    }
    default:
      return null;
  }
  return { href: buildExternalUrl(namespace, id), source: "entry" };
}
