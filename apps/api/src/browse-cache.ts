import type { BrowseCache } from "@media-ref/core";

// Synthetic origin for cache keys; the Cache API only keys on URLs and never fetches them.
const CACHE_ORIGIN = "https://browse-cache.mediaref.internal/";

interface WorkersCacheStorage {
  default: {
    match(request: Request): Promise<Response | undefined>;
    put(request: Request, response: Response): Promise<void>;
  };
}

/**
 * Browse cache on the Workers Cache API (per data center). Returns undefined outside workerd,
 * where `caches.default` does not exist, so tests and Node run uncached.
 */
export function createWorkersBrowseCache(): BrowseCache | undefined {
  const storage = (globalThis as { caches?: Partial<WorkersCacheStorage> }).caches;
  const cache = storage?.default;
  if (!cache) {
    return undefined;
  }
  const toRequest = (key: string) => new Request(`${CACHE_ORIGIN}${encodeURIComponent(key)}`);
  return {
    async get(key) {
      const hit = await cache.match(toRequest(key));
      return hit ? ((await hit.json()) as unknown) : null;
    },
    async put(key, value, ttlSeconds) {
      await cache.put(
        toRequest(key),
        new Response(JSON.stringify(value), {
          headers: {
            "content-type": "application/json",
            "cache-control": `public, max-age=${ttlSeconds}`,
          },
        }),
      );
    },
  };
}
