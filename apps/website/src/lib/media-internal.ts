import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";

export type MediaType = "movie" | "tv";
export type PlatformNamespace = "tencent" | "iqiyi" | "youku" | "bilibili" | "mgtv";
export type CatalogNamespace = "tmdb" | "douban" | "imdb" | "tvdb" | "trakt" | "bangumi";
export type Namespace = PlatformNamespace | CatalogNamespace;
export type BaselineSource = "tmdb" | "tvdb" | "imdb" | "bangumi" | "douban";
export type ExternalIdNamespace = "tmdb" | "imdb" | "tvdb" | "trakt";
export type AssociationStatus = "confirmed" | "seed_unconfirmed" | "delisted";

export const PLATFORM_ORDER: PlatformNamespace[] = [
  "tencent",
  "iqiyi",
  "youku",
  "bilibili",
  "mgtv",
];

export const PLATFORM_LABELS: Record<PlatformNamespace, string> = {
  tencent: "腾讯视频",
  iqiyi: "爱奇艺",
  youku: "优酷",
  bilibili: "B 站",
  mgtv: "芒果 TV",
};

export const CATALOG_LABELS: Record<CatalogNamespace, string> = {
  tmdb: "TMDB",
  douban: "豆瓣",
  imdb: "IMDb",
  tvdb: "TVDB",
  trakt: "Trakt",
  bangumi: "Bangumi",
};

export const NAMESPACE_LABELS: Record<Namespace, string> = {
  ...PLATFORM_LABELS,
  ...CATALOG_LABELS,
};

export const BASELINE_LABELS: Record<BaselineSource, string> = {
  tmdb: "TMDB",
  tvdb: "TVDB",
  imdb: "IMDb",
  bangumi: "Bangumi",
  douban: "豆瓣",
};

export interface ExternalId {
  namespace: ExternalIdNamespace;
  nativeId: string;
  locked?: boolean;
}

export interface SeasonSnapshot {
  season: number;
  episodeCount: number;
  airYear: number | null;
}

export interface MediaSnapshot {
  title: string;
  originalTitle: string | null;
  year: number | null;
  type: MediaType;
  seasons: SeasonSnapshot[];
}

export interface Media {
  id: string;
  type: MediaType;
  baseline: BaselineSource | null;
  snapshot: MediaSnapshot;
}

export interface Variant {
  id: string;
  mediaId?: string;
  namespace: PlatformNamespace;
  label: string;
  isDefault: boolean;
}

export interface Segment {
  season: number;
  episodeStart: number;
  episodeEnd: number | null;
  targetEpisodeStart: number;
  baseline: BaselineSource;
  nonLinear?: boolean;
  needsReview?: boolean;
}

export interface Association {
  id: string;
  mediaId?: string;
  namespace: Namespace;
  nativeId: string;
  variantId: string | null;
  status: AssociationStatus;
  segments: Segment[];
  needsReview?: boolean;
  locked?: boolean;
  unconfirmed?: boolean;
}

export type PlatformStatusEntry =
  | { status: "associated" }
  | { status: "not_found"; checkedAt: string }
  | { status: "unchecked" };

export interface MediaDocument {
  media: Media;
  externalIds: ExternalId[];
  variants: Variant[];
  associations: Association[];
  matchedAssociationIds?: string[];
  platformStatuses?: Partial<Record<PlatformNamespace, PlatformStatusEntry>>;
}

export type AnonymousMediaResult =
  | {
      status: "ok";
      document: MediaDocument;
      matchedAssociationId: string | null;
    }
  | {
      status: "invalid_key";
      message: string;
    }
  | {
      status: "not_found";
      message: string;
    }
  | {
      status: "rate_limited";
      retryAfterSeconds: number | null;
      message: string;
    }
  | {
      status: "unavailable";
      message: string;
    }
  | {
      status: "error";
      code: string;
      message: string;
    };

interface ServiceBindingFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface WebsiteWorkerEnv {
  API_INTERNAL?: ServiceBindingFetcher;
  INTERNAL_API_BASE_URL?: string;
}

interface RawInternalResponseBody {
  document?: MediaDocument;
  matchedAssociationId?: string | null;
  error?: unknown;
  message?: unknown;
  retryAfter?: unknown;
}

const INTERNAL_MEDIA_ORIGIN = "https://internal.mediaref.org";
const CLOUDFLARE_WORKERS_SPECIFIER = "cloudflare:workers";

function readServerEnvVar(name: string): string | undefined {
  const maybeProcess = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  const value = maybeProcess?.env?.[name];
  if (!value || value.trim().length === 0) {
    return undefined;
  }
  return value.trim();
}

async function loadCloudflareWorkerEnv(): Promise<WebsiteWorkerEnv | null> {
  try {
    const mod = (await import(/* @vite-ignore */ CLOUDFLARE_WORKERS_SPECIFIER)) as {
      env?: WebsiteWorkerEnv;
    };
    return mod?.env ?? null;
  } catch {
    return null;
  }
}

function extractVisitorClientIp(): string | null {
  const cfConnectingIp = getRequestHeader("cf-connecting-ip")?.trim();
  if (cfConnectingIp) {
    return cfConnectingIp;
  }

  const forwardedFor = getRequestHeader("x-forwarded-for");
  if (forwardedFor) {
    const firstHop = forwardedFor.split(",")[0]?.trim();
    if (firstHop) {
      return firstHop;
    }
  }

  return null;
}

function parseRetryAfterSeconds(response: Response, body: RawInternalResponseBody): number | null {
  const headerRaw = response.headers.get("retry-after");
  if (headerRaw) {
    const parsedHeader = Number.parseInt(headerRaw.trim(), 10);
    if (Number.isFinite(parsedHeader) && parsedHeader > 0) {
      return parsedHeader;
    }
  }
  if (
    typeof body.retryAfter === "number" &&
    Number.isFinite(body.retryAfter) &&
    body.retryAfter > 0
  ) {
    return Math.ceil(body.retryAfter);
  }
  return null;
}

export function isPlatformNamespace(namespace: Namespace): namespace is PlatformNamespace {
  return (
    namespace === "tencent" ||
    namespace === "iqiyi" ||
    namespace === "youku" ||
    namespace === "bilibili" ||
    namespace === "mgtv"
  );
}

/**
 * Fetches a single confirmed media document anonymously via the private
 * `API_INTERNAL` Cloudflare Service Binding (`InternalMediaEntrypoint`).
 *
 * - Never sends an API key or user session cookie.
 * - Forwards the visitor's source IP (`X-Forwarded-Client-IP`) so the internal
 *   entrypoint enforces per-IP rate limiting independently of API keys.
 * - In local development without a Cloudflare service binding, optionally falls
 *   back to `INTERNAL_API_BASE_URL` if configured in the server environment.
 */
export const fetchAnonymousMedia = createServerFn({ method: "GET" })
  .validator((input: { key: string }): { key: string } => {
    const rawKey = typeof input?.key === "string" ? input.key.trim() : "";
    return { key: rawKey };
  })
  .handler(async ({ data }): Promise<AnonymousMediaResult> => {
    const trimmedKey = data.key.trim();
    if (trimmedKey.length === 0) {
      return {
        status: "invalid_key",
        message: "请提供有效的媒体 UUID 或外部键（例如 tmdb:tv:95479）。",
      };
    }

    const headers = new Headers({ accept: "application/json" });
    const visitorIp = extractVisitorClientIp();
    if (visitorIp) {
      headers.set("x-forwarded-client-ip", visitorIp);
      headers.set("cf-connecting-ip", visitorIp);
    }

    const encodedPath = `/internal/media/${encodeURIComponent(trimmedKey)}`;
    const workerEnv = await loadCloudflareWorkerEnv();

    let response: Response;
    try {
      if (workerEnv?.API_INTERNAL && typeof workerEnv.API_INTERNAL.fetch === "function") {
        response = await workerEnv.API_INTERNAL.fetch(
          new Request(`${INTERNAL_MEDIA_ORIGIN}${encodedPath}`, {
            method: "GET",
            headers,
          }),
        );
      } else {
        const localInternalBase =
          workerEnv?.INTERNAL_API_BASE_URL?.trim() || readServerEnvVar("INTERNAL_API_BASE_URL");
        if (!localInternalBase) {
          return {
            status: "unavailable",
            message:
              "未检测到 API_INTERNAL service binding。本地开发时请配置环境变量 INTERNAL_API_BASE_URL，或在 Cloudflare Workers 环境中绑定 media-ref-api 的 InternalMediaEntrypoint。",
          };
        }
        const normalizedBase = localInternalBase.replace(/\/+$/, "");
        response = await fetch(`${normalizedBase}${encodedPath}`, {
          method: "GET",
          headers,
        });
      }
    } catch {
      return {
        status: "error",
        code: "INTERNAL_SERVICE_UNREACHABLE",
        message: "暂时无法连接到内部媒体查询服务，请稍后重试。",
      };
    }

    const body = (await response.json().catch(() => ({}))) as RawInternalResponseBody;

    if (response.status === 200 && body.document) {
      return {
        status: "ok",
        document: body.document,
        matchedAssociationId: body.matchedAssociationId ?? null,
      };
    }

    if (response.status === 400) {
      return {
        status: "invalid_key",
        message:
          typeof body.message === "string" && body.message.length > 0
            ? body.message
            : "查询键格式无效，请使用媒体 UUID 或命名空间外部键（例如 tmdb:tv:95479）。",
      };
    }

    if (response.status === 404) {
      return {
        status: "not_found",
        message: "未找到对应的已确认媒体记录。",
      };
    }

    if (response.status === 429) {
      const retryAfterSeconds = parseRetryAfterSeconds(response, body);
      return {
        status: "rate_limited",
        retryAfterSeconds,
        message: retryAfterSeconds
          ? `当前 IP 访问过于频繁，请约 ${retryAfterSeconds} 秒后再试。`
          : "当前 IP 访问过于频繁，请稍后再试。",
      };
    }

    return {
      status: "error",
      code: typeof body.error === "string" ? body.error : `HTTP_${response.status}`,
      message:
        typeof body.message === "string" && body.message.length > 0
          ? body.message
          : "加载媒体页面时发生错误，请稍后重试。",
    };
  });
