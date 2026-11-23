import type { Namespace } from "@media-ref/client";
import { bangumiAdapter } from "./bangumi.ts";
import { bilibiliAdapter } from "./bilibili.ts";
import { doubanAdapter } from "./douban.ts";
import type { AdapterRegistry, AdapterTier, MediaAdapter } from "./types.ts";

export { bangumiAdapter, parseBangumiInput } from "./bangumi.ts";
export { bilibiliAdapter, parseBilibiliInput } from "./bilibili.ts";
export { doubanAdapter, parseDoubanInput } from "./douban.ts";
export {
  AdapterTransientError,
  createTier1Adapter,
  InvalidNativeIdError,
  isTier2Adapter,
  isTier3Adapter,
  type AdapterRegistry,
  type AdapterSearchCandidate,
  type AdapterSearchQuery,
  type AdapterSearchResult,
  type AdapterTier,
  type CatalogAdapter,
  type CollectionEvidenceResult,
  type CollectionInfo,
  type CreateTier1AdapterOptions,
  type FeatureEpisode,
  type MediaAdapter,
  type ParsedNativeIdInput,
  type PlatformAdapter,
  type Tier1Adapter,
  type Tier2Adapter,
  type Tier3Adapter,
} from "./types.ts";

export function createAdapterRegistry(adapters: readonly MediaAdapter[] = []): AdapterRegistry {
  const byNamespace = new Map<Namespace, MediaAdapter>();
  for (const adapter of adapters) {
    byNamespace.set(adapter.namespace, adapter);
  }

  return {
    get(namespace) {
      return byNamespace.get(namespace);
    },
    has(namespace) {
      return byNamespace.has(namespace);
    },
    list() {
      return [...byNamespace.values()];
    },
    listByMinTier(minTier: AdapterTier) {
      return [...byNamespace.values()].filter((adapter) => adapter.tier >= minTier);
    },
  };
}

export function createDefaultAdapterRegistry(): AdapterRegistry {
  return createAdapterRegistry([bilibiliAdapter, doubanAdapter, bangumiAdapter]);
}
