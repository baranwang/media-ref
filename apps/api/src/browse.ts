import { create } from "@bufbuild/protobuf";
import {
  createDomainConnectError,
  isPlatformNamespace,
  proto,
  toProtoMediaType,
  type MediaDocument,
} from "@media-ref/client";
import {
  getCatalogDetail,
  isBrowseNamespace,
  listDemands,
  listExplorationActivity,
  listTrending,
  queryMediaBatch,
  resolveLookupKeys,
  searchCatalogTitles,
  type BrowseType,
  type CatalogBrowseOptions,
  type CatalogCard,
} from "@media-ref/core";
import type { ServiceImpl } from "@connectrpc/connect";
import { authorizePublicRead, getRuntime, type ApiRequestRuntime } from "./context.ts";

const DEFAULT_TRENDING_LIMIT = 18;
const DEFAULT_SEARCH_LIMIT = 10;
const DEFAULT_DEMANDS_LIMIT = 20;
const DEFAULT_ACTIVITY_LIMIT = 20;
const MAX_ACTIVITY_LIMIT = 50;
const MAX_PAGE = 100;

interface InLibrary {
  mediaId: string;
  platforms: string[];
}

function browseOptions(runtime: ApiRequestRuntime): CatalogBrowseOptions {
  return {
    outbound: runtime.outbound,
    config: runtime.catalogConfig,
    cache: runtime.browseCache,
  };
}

function clampLimit(value: number | undefined, fallback: number): number {
  return Math.min(Math.max(Math.floor(value ?? fallback), 1), MAX_PAGE);
}

function fromProtoBrowseType(type: proto.BrowseType): BrowseType {
  switch (type) {
    case proto.BrowseType.MOVIE:
      return "movie";
    case proto.BrowseType.TV:
      return "tv";
    case proto.BrowseType.ANIME:
      return "anime";
    default:
      return "all";
  }
}

function confirmedPlatforms(document: MediaDocument): string[] {
  const platforms = document.associations
    .filter((a) => a.status === "confirmed" && !a.unconfirmed && isPlatformNamespace(a.namespace))
    .map((a) => a.namespace);
  return [...new Set(platforms)];
}

/** Which of these catalog keys already exist in MediaRef, keyed by the input key. */
async function lookupLibrary(
  runtime: ApiRequestRuntime,
  keys: string[],
): Promise<Map<string, { library: InLibrary; document: MediaDocument }>> {
  const unique = [...new Set(keys)];
  const found = new Map<string, { library: InLibrary; document: MediaDocument }>();
  if (unique.length === 0) {
    return found;
  }
  const results = await queryMediaBatch(runtime.dbRead, {
    keys: unique,
    includeUnconfirmed: false,
  });
  for (const entry of results) {
    const document = entry.ok ? entry.items[0]?.document : undefined;
    if (document) {
      found.set(entry.key, {
        library: { mediaId: document.media.id, platforms: confirmedPlatforms(document) },
        document,
      });
    }
  }
  return found;
}

function toProtoCard(card: CatalogCard, library?: InLibrary): proto.CatalogCard {
  return create(proto.CatalogCardSchema, {
    key: card.key,
    namespace: card.namespace,
    type: toProtoMediaType(card.type),
    isAnime: card.isAnime,
    title: card.title,
    ...(card.originalTitle ? { originalTitle: card.originalTitle } : {}),
    ...(card.year !== null ? { year: card.year } : {}),
    ...(card.posterUrl ? { posterUrl: card.posterUrl } : {}),
    ...(library ? { mediaId: library.mediaId, platforms: library.platforms } : {}),
  });
}

/** Card for a title that exists in MediaRef: snapshot text plus catalog artwork when available. */
async function cardForDocument(
  runtime: ApiRequestRuntime,
  document: MediaDocument,
): Promise<proto.CatalogCard> {
  const tmdb = document.externalIds.find((id) => id.namespace === "tmdb");
  const baseline = document.associations.find(
    (a) => a.namespace === "douban" || a.namespace === "bangumi",
  );
  const key = tmdb
    ? `tmdb:${tmdb.nativeId}`
    : baseline
      ? `${baseline.namespace}:${baseline.nativeId}`
      : `media:${document.media.id}`;
  const detail = key.startsWith("media:")
    ? null
    : await getCatalogDetail(key, browseOptions(runtime));
  const snapshot = document.media.snapshot;
  return toProtoCard(
    {
      key,
      namespace: detail?.namespace ?? "tmdb",
      type: document.media.type,
      isAnime: detail?.isAnime ?? false,
      title: snapshot.title,
      originalTitle: snapshot.originalTitle ?? null,
      year: snapshot.year ?? null,
      posterUrl: detail?.posterUrl ?? null,
    },
    { mediaId: document.media.id, platforms: confirmedPlatforms(document) },
  );
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export const browseServiceImpl: ServiceImpl<typeof proto.BrowseService> = {
  async listTrending(req, ctx) {
    await authorizePublicRead(ctx);
    const runtime = getRuntime(ctx);
    if (!isBrowseNamespace(req.namespace)) {
      throw createDomainConnectError({
        status: 400,
        code: "INVALID_QUERY",
        message: "namespace must be one of tmdb, douban, bangumi, trakt",
      });
    }
    const cards = await listTrending(
      req.namespace,
      fromProtoBrowseType(req.type),
      clampLimit(req.limit, DEFAULT_TRENDING_LIMIT),
      browseOptions(runtime),
    );
    const library = await lookupLibrary(
      runtime,
      cards.map((c) => c.key),
    );
    return create(proto.ListTrendingResponseSchema, {
      items: cards.map((card) => toProtoCard(card, library.get(card.key)?.library)),
    });
  },

  async getCatalogDetail(req, ctx) {
    await authorizePublicRead(ctx);
    const runtime = getRuntime(ctx);
    const detail = await getCatalogDetail(req.key, browseOptions(runtime));
    if (!detail) {
      throw createDomainConnectError({
        status: 404,
        code: "CATALOG_ENTRY_NOT_FOUND",
        message: "Catalog entry not found",
      });
    }
    const library = (await lookupLibrary(runtime, [detail.key])).get(detail.key)?.library;
    return create(proto.GetCatalogDetailResponseSchema, {
      detail: create(proto.CatalogDetailSchema, {
        card: toProtoCard(detail, library),
        ...(detail.backdropUrl ? { backdropUrl: detail.backdropUrl } : {}),
        ...(detail.overview ? { overview: detail.overview } : {}),
        genres: detail.genres,
        regions: detail.regions,
        credits: detail.credits.map((c) => create(proto.CatalogCreditSchema, c)),
        ...(detail.status ? { status: detail.status } : {}),
        ...(detail.yearEnd !== null ? { yearEnd: detail.yearEnd } : {}),
        seasons: detail.seasons.map((s) =>
          create(proto.CatalogSeasonSchema, { season: s.season, episodeCount: s.episodeCount }),
        ),
      }),
    });
  },

  async search(req, ctx) {
    await authorizePublicRead(ctx);
    const runtime = getRuntime(ctx);
    const limit = clampLimit(req.limit, DEFAULT_SEARCH_LIMIT);
    const query = req.query.trim();
    if (query.length === 0) {
      return create(proto.SearchResponseSchema, { items: [], matchedAsLink: false });
    }

    const linkKeys = resolveLookupKeys(query, runtime.adapterRegistry);
    if (linkKeys.length > 0) {
      const library = await lookupLibrary(runtime, linkKeys);
      const items: proto.CatalogCard[] = [];
      const seenMedia = new Set<string>();
      for (const key of linkKeys) {
        const hit = library.get(key);
        if (hit) {
          if (!seenMedia.has(hit.library.mediaId)) {
            seenMedia.add(hit.library.mediaId);
            items.push(await cardForDocument(runtime, hit.document));
          }
          continue;
        }
        // Not in MediaRef yet: catalog links can still open a detail page; platform links cannot.
        const detail = await getCatalogDetail(key, browseOptions(runtime));
        if (detail) {
          items.push(toProtoCard(detail));
        }
      }
      return create(proto.SearchResponseSchema, {
        items: items.slice(0, limit),
        matchedAsLink: true,
      });
    }

    const pattern = `%${escapeLike(query)}%`;
    const rows = await runtime.dbRead
      .selectFrom("media")
      .select("id")
      .where("merged_into_media_id", "is", null)
      .where((eb) => eb.or([eb("title", "ilike", pattern), eb("original_title", "ilike", pattern)]))
      .orderBy("updated_at", "desc")
      .limit(limit)
      .execute();
    const local = await lookupLibrary(
      runtime,
      rows.map((r) => r.id),
    );
    const items: proto.CatalogCard[] = [];
    const seenMedia = new Set<string>();
    for (const row of rows) {
      const hit = local.get(row.id);
      if (hit && !seenMedia.has(hit.library.mediaId)) {
        seenMedia.add(hit.library.mediaId);
        items.push(await cardForDocument(runtime, hit.document));
      }
    }

    if (items.length < limit) {
      const remote = await searchCatalogTitles(query, browseOptions(runtime));
      const remoteLibrary = await lookupLibrary(
        runtime,
        remote.map((c) => c.key),
      );
      for (const card of remote) {
        const library = remoteLibrary.get(card.key)?.library;
        if (library && seenMedia.has(library.mediaId)) {
          continue;
        }
        if (library) seenMedia.add(library.mediaId);
        items.push(toProtoCard(card, library));
        if (items.length >= limit) break;
      }
    }

    return create(proto.SearchResponseSchema, { items, matchedAsLink: false });
  },

  async listDemands(req, ctx) {
    await authorizePublicRead(ctx);
    const runtime = getRuntime(ctx);
    const demands = await listDemands(runtime.dbRead, {
      status: ["open", "leased"],
      namespaceGroup: "platform",
      limit: clampLimit(req.limit, DEFAULT_DEMANDS_LIMIT),
      offset: Math.max(Math.floor(req.offset ?? 0), 0),
    });

    const keys = demands.map((d) => d.mediaId ?? d.externalKey).filter((k): k is string => !!k);
    const library = await lookupLibrary(runtime, keys);

    const entries = await Promise.all(
      demands.map(async (demand) => {
        const key = demand.mediaId ?? demand.externalKey;
        if (!key) return null;
        const hit = library.get(key);
        let card: proto.CatalogCard | null = null;
        if (hit) {
          card = await cardForDocument(runtime, hit.document);
        } else {
          const detail = await getCatalogDetail(key, browseOptions(runtime));
          card = detail ? toProtoCard(detail) : null;
        }
        if (!card) return null;
        return create(proto.DemandEntrySchema, {
          id: demand.id,
          demandCount: demand.demandCount,
          ...(demand.season !== null ? { season: demand.season } : {}),
          lastDemandedAt: demand.lastDemandedAt,
          card,
        });
      }),
    );

    return create(proto.ListDemandsResponseSchema, {
      demands: entries.filter((e): e is proto.DemandEntry => e !== null),
    });
  },

  async listExplorationActivity(req, ctx) {
    await authorizePublicRead(ctx);
    const runtime = getRuntime(ctx);
    const before = req.before ? new Date(req.before) : null;
    if (before && Number.isNaN(before.getTime())) {
      throw createDomainConnectError({
        status: 400,
        code: "INVALID_QUERY",
        message: "before must be an ISO timestamp",
      });
    }
    const activity = await listExplorationActivity(runtime.dbRead, {
      now: new Date(),
      limit: Math.min(clampLimit(req.limit, DEFAULT_ACTIVITY_LIMIT), MAX_ACTIVITY_LIMIT),
      before,
      filter:
        req.filter === proto.ExplorationFilter.FOUND
          ? "found"
          : req.filter === proto.ExplorationFilter.NOT_FOUND
            ? "not_found"
            : "all",
      includeLive: !before,
    });

    const all = [...activity.running, ...activity.recent];
    const library = await lookupLibrary(
      runtime,
      all.map((a) => a.mediaId),
    );
    const cards = new Map<string, proto.CatalogCard>();
    await Promise.all(
      [...library].map(async ([mediaId, hit]) => {
        cards.set(mediaId, await cardForDocument(runtime, hit.document));
      }),
    );
    const toProto = (a: (typeof all)[number]) => {
      const card = cards.get(a.mediaId);
      if (!card) return [];
      return [
        create(proto.ExplorationActivitySchema, {
          id: a.id,
          card,
          ...(a.season !== null ? { season: a.season } : {}),
          startedAt: a.startedAt.toISOString(),
          ...(a.finishedAt ? { finishedAt: a.finishedAt.toISOString() } : {}),
          platforms: a.platforms.map((p) =>
            create(proto.ExplorationPlatformResultSchema, {
              namespace: p.namespace,
              status: p.status,
              ...(p.reason ? { reason: p.reason } : {}),
              ...(p.changeRequestId ? { changeRequestId: p.changeRequestId } : {}),
            }),
          ),
        }),
      ];
    };

    return create(proto.ListExplorationActivityResponseSchema, {
      running: activity.running.flatMap(toProto),
      recent: activity.recent.flatMap(toProto),
      ...(activity.summary
        ? {
            last24h: create(proto.ExplorationSummarySchema, {
              explored: activity.summary.explored,
              found: activity.summary.found,
              approved: activity.summary.approved,
              inReview: activity.summary.inReview,
            }),
          }
        : {}),
      ...(activity.nextBefore ? { nextBefore: activity.nextBefore.toISOString() } : {}),
    });
  },
};
