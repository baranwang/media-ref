import { isCatalogNamespace, isNamespace, type MediaType, type Namespace } from "@media-ref/client";

export interface ParsedExternalLink {
  namespace: Namespace;
  nativeId: string;
  url: string;
  isCatalog: boolean;
  mediaTypeHint?: MediaType;
}

export function buildExternalUrl(
  namespace: Namespace,
  nativeId: string,
  mediaType: MediaType = "tv",
): string {
  switch (namespace) {
    case "bilibili": {
      if (nativeId.startsWith("ss") || nativeId.startsWith("ep")) {
        return `https://www.bilibili.com/bangumi/play/${nativeId}`;
      }
      if (nativeId.startsWith("md")) {
        return `https://www.bilibili.com/bangumi/media/${nativeId}`;
      }
      return `https://www.bilibili.com/bangumi/play/ss${nativeId}`;
    }
    case "tencent":
      return `https://v.qq.com/x/cover/${nativeId}.html`;
    case "iqiyi": {
      if (!/^\d+$/.test(nativeId)) return `https://www.iqiyi.com/a_${nativeId}.html`;
      // iQIYI page slugs are base36 of (id XOR "upiqgl"); movie/episode tvIds end in 00 and live on v_ pages.
      const slug = (BigInt(nativeId) ^ 0x75706971676cn).toString(36);
      return `https://www.iqiyi.com/${nativeId.endsWith("00") ? "v" : "a"}_${slug}.html`;
    }
    case "youku":
      return `https://v.youku.com/v_show/id_${nativeId}.html`;
    case "mgtv":
      return `https://www.mgtv.com/h/${nativeId}.html`;
    case "tmdb": {
      const m = nativeId.match(/^(tv|movie):(\d+)$/);
      if (m) return `https://www.themoviedb.org/${m[1]}/${m[2]}?language=zh-CN`;
      return `https://www.themoviedb.org/${mediaType}/${nativeId}?language=zh-CN`;
    }
    case "tvdb": {
      const clean = nativeId.replace(/^(series|movies):/, "");
      return `https://thetvdb.com/dereferrer/series/${clean}`;
    }
    case "imdb":
      return `https://www.imdb.com/title/${nativeId}/`;
    case "douban":
      return `https://movie.douban.com/subject/${nativeId}/`;
    case "trakt":
      return `https://trakt.tv/${mediaType === "movie" ? "movies" : "shows"}/${nativeId}`;
    case "bangumi":
      return `https://bgm.tv/subject/${nativeId}`;
  }
}

export function parseExternalInput(rawInput: string): ParsedExternalLink | null {
  const trimmed = rawInput.trim();
  if (!trimmed) return null;

  // Canonical key syntax: e.g. "tmdb:tv:1429", "douban:26647087", "bilibili:ss38221", "imdb:tt2560140"
  const canonicalMatch = trimmed.match(/^([a-z]+):(.+)$/i);
  if (canonicalMatch && !/^https?$/i.test(canonicalMatch[1]!)) {
    const ns = canonicalMatch[1]!.toLowerCase();
    const rest = canonicalMatch[2]!.trim();
    if (isNamespace(ns) && rest.length > 0) {
      const tmdbType =
        ns === "tmdb" && rest.startsWith("movie:")
          ? "movie"
          : ns === "tmdb" && rest.startsWith("tv:")
            ? "tv"
            : undefined;
      return {
        namespace: ns,
        nativeId: rest,
        url: buildExternalUrl(ns, rest, tmdbType),
        isCatalog: isCatalogNamespace(ns),
        ...(tmdbType ? { mediaTypeHint: tmdbType } : {}),
      };
    }
  }

  // Bare IMDb ID like tt2560140
  if (/^tt\d{6,}$/i.test(trimmed)) {
    return {
      namespace: "imdb",
      nativeId: trimmed.toLowerCase(),
      url: buildExternalUrl("imdb", trimmed.toLowerCase()),
      isCatalog: true,
    };
  }

  // Bare Bilibili ss / ep / md ID
  if (/^(ss|ep|md)\d+$/i.test(trimmed)) {
    const id = trimmed.toLowerCase();
    return {
      namespace: "bilibili",
      nativeId: id,
      url: buildExternalUrl("bilibili", id),
      isCatalog: false,
    };
  }

  // URL parsing
  let url: URL;
  try {
    url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  const path = url.pathname;

  if (host.includes("douban.com")) {
    const m = path.match(/\/subject\/(\d+)/);
    if (m) {
      return {
        namespace: "douban",
        nativeId: m[1]!,
        url: buildExternalUrl("douban", m[1]!),
        isCatalog: true,
      };
    }
  }

  if (host.includes("bilibili.com")) {
    const m = path.match(/\/bangumi\/(?:play|media)\/((?:ss|ep|md)\d+)/i);
    if (m) {
      const id = m[1]!.toLowerCase();
      return {
        namespace: "bilibili",
        nativeId: id,
        url: buildExternalUrl("bilibili", id),
        isCatalog: false,
      };
    }
  }

  if (host.includes("v.qq.com")) {
    const m =
      path.match(/\/x\/cover\/([a-z0-9]+)(?:\/|\.html|$)/i) ??
      path.match(/\/detail\/[a-z0-9]\/([a-z0-9]+)\.html/i);
    if (m) {
      return {
        namespace: "tencent",
        nativeId: m[1]!,
        url: buildExternalUrl("tencent", m[1]!),
        isCatalog: false,
      };
    }
  }

  if (host.includes("iqiyi.com")) {
    const m = path.match(/\/(a|v)_([a-z0-9]+)\.html/i);
    if (m) {
      return {
        namespace: "iqiyi",
        nativeId: m[2]!,
        url: `https://www.iqiyi.com/${m[1]!.toLowerCase()}_${m[2]!}.html`,
        isCatalog: false,
      };
    }
  }

  if (host.includes("youku.com")) {
    const m =
      path.match(/\/v_show\/id_([a-z0-9_=]+)\.html/i) ??
      path.match(/\/show\/id_([a-z0-9_=]+)\.html/i);
    if (m) {
      return {
        namespace: "youku",
        nativeId: m[1]!,
        url: buildExternalUrl("youku", m[1]!),
        isCatalog: false,
      };
    }
  }

  if (host.includes("mgtv.com")) {
    const m = path.match(/\/(?:h|b)\/(\d+)/i);
    if (m) {
      return {
        namespace: "mgtv",
        nativeId: m[1]!,
        url: buildExternalUrl("mgtv", m[1]!),
        isCatalog: false,
      };
    }
  }

  if (host.includes("themoviedb.org")) {
    const m = path.match(/\/(tv|movie)\/(\d+)/i);
    if (m) {
      const mt = m[1]!.toLowerCase() as MediaType;
      const nativeId = `${mt}:${m[2]!}`;
      return {
        namespace: "tmdb",
        nativeId,
        url: buildExternalUrl("tmdb", nativeId, mt),
        isCatalog: true,
        mediaTypeHint: mt,
      };
    }
  }

  if (host.includes("imdb.com")) {
    const m = path.match(/\/title\/(tt\d+)/i);
    if (m) {
      const id = m[1]!.toLowerCase();
      return {
        namespace: "imdb",
        nativeId: id,
        url: buildExternalUrl("imdb", id),
        isCatalog: true,
      };
    }
  }

  if (host.includes("thetvdb.com")) {
    const m = path.match(/\/(?:series|movies|dereferrer\/series)\/([a-z0-9-]+)/i);
    if (m) {
      return {
        namespace: "tvdb",
        nativeId: m[1]!,
        url: buildExternalUrl("tvdb", m[1]!),
        isCatalog: true,
      };
    }
  }

  if (host.includes("bgm.tv") || host.includes("bangumi.tv") || host.includes("chii.in")) {
    const m = path.match(/\/subject\/(\d+)/i);
    if (m) {
      return {
        namespace: "bangumi",
        nativeId: m[1]!,
        url: buildExternalUrl("bangumi", m[1]!),
        isCatalog: true,
      };
    }
  }

  if (host.includes("trakt.tv")) {
    const m = path.match(/\/(shows|movies)\/([a-z0-9-]+)/i);
    if (m) {
      const mt: MediaType = m[1]!.toLowerCase() === "movies" ? "movie" : "tv";
      return {
        namespace: "trakt",
        nativeId: m[2]!,
        url: buildExternalUrl("trakt", m[2]!, mt),
        isCatalog: true,
        mediaTypeHint: mt,
      };
    }
  }

  return null;
}

export function detectWebmailProvider(email: string): { label: string; url: string } {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  if (domain === "gmail.com" || domain === "googlemail.com") {
    return { label: "打开 Gmail", url: "https://mail.google.com" };
  }
  if (domain === "qq.com" || domain === "foxmail.com") {
    return { label: "打开 QQ 邮箱", url: "https://mail.qq.com" };
  }
  if (domain === "163.com" || domain === "126.com") {
    return { label: "打开网易邮箱", url: "https://mail.163.com" };
  }
  if (domain === "outlook.com" || domain === "hotmail.com" || domain === "live.com") {
    return { label: "打开 Outlook", url: "https://outlook.live.com" };
  }
  if (domain === "icloud.com" || domain === "me.com") {
    return { label: "打开 iCloud 邮箱", url: "https://www.icloud.com/mail" };
  }
  return { label: "打开 Gmail", url: "https://mail.google.com" };
}
