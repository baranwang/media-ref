import type { ExternalHttpRequest, ExternalHttpResponse, OutboundClient } from "../outbound.ts";

/**
 * Douban access through the WeChat mini program API (frodo), the way douban-bridge does it.
 * Tests set the delays to 0.
 *
 * Douban answers bursts with HTTP 400 (frodo after ~19 quick requests from one IP), so every
 * Douban request in this isolate waits for its slot, and a 400/403/429 is retried once.
 * shortcut: per-isolate config and pacing; a shared limiter (Durable Object) if isolates collide.
 */
export const DOUBAN_API: {
  apiKey: string | undefined;
  minIntervalMs: number;
  retryDelayMs: number;
} = {
  // The mini program's public frodo apiKey, base64 only to keep it out of plain-text searches.
  apiKey: atob("MGFjNDRhZTAxNjQ5MGRiMjIwNGNlMGEwNDJkYjI5MTY="),
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

/** The IMDb ID a Douban subject lists in its info table (frodo `/subject/<id>/desc` HTML). */
export function parseDoubanDescImdbId(html: string): string | null {
  return html.match(/<td>\s*IMDb\s*<\/td>\s*<td>\s*(tt\d+)\s*<\/td>/i)?.[1] ?? null;
}
