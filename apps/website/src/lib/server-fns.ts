import { Code, ConnectError } from "@connectrpc/connect";
import {
  fromProtoMediaDocument,
  proto,
  toProtoMediaRefFromKey,
  type MediaDocument,
} from "@media-ref/client";
import { createServerFn } from "@tanstack/react-start";
import type { BrowseSlug } from "./catalogs";
import { cardFromProto, demandFromProto, explorationFromProto, mediaItemFrom } from "./mappers";
import type { CardItem, DemandItem, ExplorationItem, ExplorationPage, MediaItem } from "./types";

// Public reads, run on the website server and sent to the API over the service binding.
// The internal client is imported lazily so `cloudflare:workers` never reaches the browser bundle.

export type BrowseFilter = "all" | "movie" | "tv" | "anime";

const BROWSE_TYPE: Record<BrowseFilter, proto.BrowseType> = {
  all: proto.BrowseType.UNSPECIFIED,
  movie: proto.BrowseType.MOVIE,
  tv: proto.BrowseType.TV,
  anime: proto.BrowseType.ANIME,
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function clients() {
  const { internalApiClients } = await import("./internal-api.server");
  return internalApiClients();
}

function isNotFound(error: unknown): boolean {
  return error instanceof ConnectError && error.code === Code.NotFound;
}

export const fetchTrending = createServerFn({ method: "GET" })
  .validator((input: { namespace: BrowseSlug; type?: BrowseFilter; limit?: number }) => input)
  .handler(async ({ data }): Promise<CardItem[]> => {
    const { browse } = await clients();
    const res = await browse.listTrending({
      namespace: data.namespace,
      type: BROWSE_TYPE[data.type ?? "all"],
      ...(data.limit !== undefined ? { limit: data.limit } : {}),
    });
    return res.items.map(cardFromProto);
  });

export const fetchDemands = createServerFn({ method: "GET" })
  .validator((input: { limit?: number; offset?: number }) => input)
  .handler(async ({ data }): Promise<DemandItem[]> => {
    const { browse } = await clients();
    const res = await browse.listDemands(data);
    return res.demands.map(demandFromProto).filter((d): d is DemandItem => d !== null);
  });

export type ExplorationFilter = "all" | "found" | "not_found";

const EXPLORATION_FILTER: Record<ExplorationFilter, proto.ExplorationFilter> = {
  all: proto.ExplorationFilter.UNSPECIFIED,
  found: proto.ExplorationFilter.FOUND,
  not_found: proto.ExplorationFilter.NOT_FOUND,
};

export const fetchExplorationActivity = createServerFn({ method: "GET" })
  .validator((input: { filter: ExplorationFilter; before?: string; limit?: number }) => input)
  .handler(async ({ data }): Promise<ExplorationPage> => {
    const { browse } = await clients();
    const res = await browse.listExplorationActivity({
      filter: EXPLORATION_FILTER[data.filter],
      ...(data.before ? { before: data.before } : {}),
      ...(data.limit ? { limit: data.limit } : {}),
    });
    const items = (list: proto.ExplorationActivity[]) =>
      list.map(explorationFromProto).filter((a): a is ExplorationItem => a !== null);
    return {
      running: items(res.running),
      recent: items(res.recent),
      summary: res.last24h
        ? {
            explored: res.last24h.explored,
            found: res.last24h.found,
            approved: res.last24h.approved,
            inReview: res.last24h.inReview,
          }
        : null,
      nextBefore: res.nextBefore ?? null,
    };
  });

export const fetchSearch = createServerFn({ method: "GET" })
  .validator((input: { query: string; limit?: number }) => input)
  .handler(async ({ data }): Promise<{ items: CardItem[]; matchedAsLink: boolean }> => {
    const { browse } = await clients();
    const res = await browse.search(data);
    return { items: res.items.map(cardFromProto), matchedAsLink: res.matchedAsLink };
  });

async function loadDocument(
  media: Awaited<ReturnType<typeof clients>>["media"],
  ref: proto.MediaRef,
): Promise<MediaDocument | null> {
  try {
    const res = await media.getMedia({ ref, includeUnconfirmed: true });
    return res.document ? fromProtoMediaDocument(res.document) : null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** Catalog key to fetch presentation for a library title: its TMDB id, else a Douban/Bangumi entry. */
function presentationKey(document: MediaDocument): string | null {
  const tmdb = document.externalIds.find((id) => id.namespace === "tmdb");
  if (tmdb) return `tmdb:${tmdb.nativeId}`;
  const entry = document.associations.find(
    (a) => a.namespace === "douban" || a.namespace === "bangumi",
  );
  return entry ? `${entry.namespace}:${entry.nativeId}` : null;
}

/**
 * Detail page data. `id` is a media UUID (library title) or a catalog key such as
 * `tmdb:tv:1429` (any title the catalogs know, in the library or not).
 */
export const fetchMediaDetail = createServerFn({ method: "GET" })
  .validator((input: { id: string }) => input)
  .handler(async ({ data }): Promise<MediaItem | null> => {
    const { browse, media } = await clients();
    const id = data.id.trim();
    // Accepts a media UUID or any catalog key (`tmdb:tv:1429`, `douban:123`, ...).
    const ref = toProtoMediaRefFromKey(id);
    const document = ref ? await loadDocument(media, ref) : null;
    const detailKey = document ? presentationKey(document) : UUID_PATTERN.test(id) ? null : id;

    let detail: proto.CatalogDetail | null = null;
    if (detailKey) {
      try {
        detail = (await browse.getCatalogDetail({ key: detailKey })).detail ?? null;
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    return mediaItemFrom(id, document, detail);
  });

/**
 * Cards for a set of change-request targets (media UUIDs or catalog keys), keyed by the input.
 * Used to show titles and posters next to change requests.
 */
export const fetchCardsByKey = createServerFn({ method: "GET" })
  .validator((input: { keys: string[] }) => ({ keys: [...new Set(input.keys)].slice(0, 50) }))
  .handler(async ({ data }): Promise<Record<string, CardItem>> => {
    const { browse, media } = await clients();
    const entries = await Promise.all(
      data.keys.map(async (key): Promise<[string, CardItem] | null> => {
        let detailKey = key;
        let library: { mediaId: string; title: string; year: number | null } | null = null;
        if (UUID_PATTERN.test(key)) {
          const ref = toProtoMediaRefFromKey(key);
          const document = ref ? await loadDocument(media, ref) : null;
          if (!document) return null;
          library = {
            mediaId: document.media.id,
            title: document.media.snapshot.title,
            year: document.media.snapshot.year ?? null,
          };
          detailKey = presentationKey(document) ?? "";
        }
        try {
          const detail = detailKey
            ? (await browse.getCatalogDetail({ key: detailKey })).detail
            : undefined;
          if (detail?.card) {
            const card = cardFromProto(detail.card);
            return [
              key,
              library
                ? { ...card, id: library.mediaId, mediaId: library.mediaId, title: library.title }
                : card,
            ];
          }
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
        return library
          ? [
              key,
              {
                id: library.mediaId,
                mediaId: library.mediaId,
                key,
                title: library.title,
                originalTitle: null,
                year: library.year,
                type: "tv",
                category: "tv",
                posterUrl: null,
                platforms: [],
              },
            ]
          : null;
      }),
    );
    return Object.fromEntries(entries.filter((e): e is [string, CardItem] => e !== null));
  });
