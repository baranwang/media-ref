import { createFileRoute } from "@tanstack/react-router";

// Douban's image CDN answers 418 unless the request carries a Douban referer, so browsers on
// mediaref.org cannot load posters directly. This proxies doubanio.com images only.

const ALLOWED_HOST = /(^|\.)doubanio\.com$/i;
const ONE_DAY = 86_400;

export const Route = createFileRoute("/img/douban")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const raw = new URL(request.url).searchParams.get("u");
        let target: URL;
        try {
          target = new URL(raw ?? "");
        } catch {
          return new Response("bad image url", { status: 400 });
        }
        if (target.protocol !== "https:" || !ALLOWED_HOST.test(target.hostname)) {
          return new Response("host not allowed", { status: 400 });
        }
        // Per-colo Workers cache, keyed on the upstream URL; absent outside workerd (vite dev).
        const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
        const cacheKey = new Request(target.toString());
        const hit = await cache?.match(cacheKey);
        if (hit) {
          return hit;
        }
        const upstream = await fetch(target.toString(), {
          headers: {
            referer: "https://movie.douban.com/",
            "user-agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
            accept: "image/avif,image/webp,image/*,*/*;q=0.8",
          },
        });
        const contentType = upstream.headers.get("content-type") ?? "";
        if (!upstream.ok || !contentType.startsWith("image/")) {
          return new Response("image unavailable", { status: 502 });
        }
        const response = new Response(upstream.body, {
          headers: {
            "content-type": contentType,
            "cache-control": `public, max-age=${ONE_DAY}, immutable`,
          },
        });
        if (cache) {
          // Imported lazily so `cloudflare:workers` never reaches the browser bundle.
          const { waitUntil } = await import("cloudflare:workers");
          waitUntil(cache.put(cacheKey, response.clone()));
        }
        return response;
      },
    },
  },
});
