import type { ExternalHttpRequest, ExternalHttpResponse, OutboundClient } from "../outbound.ts";

/**
 * Douban access through the WeChat mini program API (frodo), the way douban-bridge does it,
 * except IMDb lookups (see fetchDoubanImdbLookup).
 * Tests set the delays to 0.
 *
 * Douban answers bursts with HTTP 400 (frodo after ~19 quick requests from one IP), so every
 * Douban request in this isolate waits for its slot, and a 400/403/429 is retried once.
 * shortcut: per-isolate config and pacing; a shared limiter (Durable Object) if isolates collide.
 */
// Douban's public mini program apikey. frodo and the v2 IMDb lookup both accept it.
const DOUBAN_PUBLIC_API_KEY = "0ac44ae016490db2204ce0a042db2916";

export const DOUBAN_API: {
  apiKey: string | undefined;
  minIntervalMs: number;
  retryDelayMs: number;
} = {
  apiKey: DOUBAN_PUBLIC_API_KEY,
  minIntervalMs: 1200,
  retryDelayMs: 3000,
};

export const DOUBAN_FRODO_BASE_URL = "https://frodo.douban.com/api/v2";
const MINI_PROGRAM_HEADERS = {
  referer: "https://servicewechat.com/wx2f9b06c1de1ccfca/99/page-frame.html",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Mac MacWechat/WMPF MacWechat/3.8.7(0x13080712) UnifiedPCMacWechat(0xf264101d) XWEB/16390",
};

const RATE_LIMIT_STATUSES = new Set([400, 403, 429]);
let nextSlotMs = 0;

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

function requireApiKey(): string {
  if (!DOUBAN_API.apiKey) {
    throw new Error("Douban frodo apiKey is not configured");
  }
  return DOUBAN_API.apiKey;
}

async function paced(outbound: OutboundClient, request: ExternalHttpRequest) {
  const now = Date.now();
  const slot = Math.max(now, nextSlotMs);
  nextSlotMs = slot + DOUBAN_API.minIntervalMs;
  await sleep(slot - now);
  return outbound.fetchExternal(request);
}

/** Any Douban request, paced and retried once on a rate-limit answer. */
export async function fetchDoubanPaced(
  outbound: OutboundClient,
  request: ExternalHttpRequest,
): Promise<ExternalHttpResponse> {
  const first = await paced(outbound, request);
  if (!RATE_LIMIT_STATUSES.has(first.status)) {
    return first;
  }
  await sleep(DOUBAN_API.retryDelayMs);
  return paced(outbound, request);
}

/** GET a frodo path (`/subject/1292000`) with the apiKey and mini program headers. */
export function fetchDoubanFrodo(
  outbound: OutboundClient,
  path: string,
  options: { kind: ExternalHttpRequest["kind"]; baseUrl?: string; timeoutMs?: number },
): Promise<ExternalHttpResponse> {
  const url = new URL(`${(options.baseUrl ?? DOUBAN_FRODO_BASE_URL).replace(/\/+$/, "")}${path}`);
  url.searchParams.set("apiKey", requireApiKey());
  return fetchDoubanPaced(outbound, {
    kind: options.kind,
    namespace: "douban",
    url: url.toString(),
    method: "GET",
    headers: { ...MINI_PROGRAM_HEADERS, accept: "application/json" },
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
}

// frodo search needs a login after ~18 queries, so IMDb lookups use the older v2 endpoint. It
// rejects the mini program referer, so it sends a mobile UA, and always the public key: tests and
// config may point `DOUBAN_API.apiKey` elsewhere.
const DOUBAN_IMDB_API = "https://api.douban.com/v2/movie/imdb";
const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

/** POST the IMDb lookup (`tt…` → `{ id: "https://api.douban.com/movie/<subject>" }`), paced. */
export function fetchDoubanImdbLookup(
  outbound: OutboundClient,
  imdbId: string,
  options: { kind: ExternalHttpRequest["kind"]; timeoutMs?: number },
): Promise<ExternalHttpResponse> {
  return fetchDoubanPaced(outbound, {
    kind: options.kind,
    namespace: "douban",
    url: `${DOUBAN_IMDB_API}/${encodeURIComponent(imdbId)}`,
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": MOBILE_UA },
    body: JSON.stringify({ apikey: DOUBAN_PUBLIC_API_KEY }),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
}
