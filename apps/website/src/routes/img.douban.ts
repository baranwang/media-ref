import { createFileRoute } from "@tanstack/react-router";

// Douban's image CDN answers 418 unless the request carries a Douban referer, so browsers on
// mediaref.org cannot load posters directly. This proxies doubanio.com images only.

const ALLOWED_HOST = /(^|\.)doubanio\.com$/i;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ONE_DAY = 86_400;

function isAllowedTarget(target: URL) {
  return target.protocol === "https:" && ALLOWED_HOST.test(target.hostname);
}

export const Route = createFileRoute("/img/douban")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const raw = new URL(request.url).searchParams.get("u");
        let target = URL.parse(raw ?? "");
        if (!target) {
          return new Response("bad image url", { status: 400 });
        }
        if (!isAllowedTarget(target)) {
          return new Response("host not allowed", { status: 400 });
        }
        // Earlier cache entries predate the response checks and security headers.
        const cache = await caches.open("douban-img-v2");
        const cacheKey = new Request(target.toString());
        const hit = await cache.match(cacheKey);
        if (hit) {
          return hit;
        }
        let upstream: Response;
        for (let redirects = 0; ; redirects++) {
          upstream = await fetch(target.toString(), {
            redirect: "manual",
            headers: {
              referer: "https://movie.douban.com/",
              "user-agent":
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
              accept: "image/avif,image/webp,image/*,*/*;q=0.8",
            },
          });
          if (!REDIRECT_STATUSES.has(upstream.status)) {
            break;
          }
          await upstream.body?.cancel();
          const location = upstream.headers.get("location");
          const next: URL | null = location ? URL.parse(location, target) : null;
          if (redirects >= MAX_REDIRECTS || !next || !isAllowedTarget(next)) {
            return new Response("image unavailable", { status: 502 });
          }
          target = next;
        }
        const contentType = upstream.headers
          .get("content-type")
          ?.split(";", 1)[0]
          .trim()
          .toLowerCase();
        if (
          !upstream.ok ||
          !contentType ||
          !IMAGE_TYPES.has(contentType) ||
          Number(upstream.headers.get("content-length")) > MAX_IMAGE_BYTES
        ) {
          await upstream.body?.cancel();
          return new Response("image unavailable", { status: 502 });
        }
        const response = new Response(upstream.body, {
          headers: {
            "content-type": contentType,
            "cache-control": `public, max-age=${ONE_DAY}, immutable`,
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; sandbox",
          },
        });
        // Imported lazily so `cloudflare:workers` never reaches the browser bundle.
        const { waitUntil } = await import("cloudflare:workers");
        waitUntil(cache.put(cacheKey, response.clone()));
        return response;
      },
    },
  },
});
