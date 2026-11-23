import { formatExternalKey } from "./external-key.ts";
import { resolveEpisode } from "./resolve.ts";
import type {
  CollectionOnlyResult,
  MappedEpisodeResult,
  ResolveEpisodeQuery,
  UnmappedEpisodeResult,
} from "./resolve.ts";
import { getNamespaceGroup } from "./types.ts";
import type { ExternalKey, MediaDocument, Namespace, NamespaceGroup } from "./types.ts";

export const DEFAULT_BASE_URL = "https://api.mediaref.org";
export const MAX_BATCH_MEDIA_KEYS = 100;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type MediaLookupKey = string | ExternalKey;

export interface MediaRefClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
}

export interface GetMediaOptions {
  includeUnconfirmed?: boolean;
  season?: number;
  namespaceGroup?: NamespaceGroup;
  signal?: AbortSignal;
}

export interface MediaQueryItem {
  document: MediaDocument;
  matchedAssociationId: string | null;
}

export interface GetMediaResponse {
  key: string;
  document: MediaDocument;
  matchedAssociationId: string | null;
  items: MediaQueryItem[];
}

export interface GetMediaBatchOptions {
  includeUnconfirmed?: boolean;
  season?: number;
  namespaceGroup?: NamespaceGroup;
  autoChunk?: boolean;
  signal?: AbortSignal;
}

export type BatchMediaItemErrorCode = "INVALID_KEY" | "NOT_FOUND";

export type BatchMediaItemResult =
  | { key: string; ok: true; items: MediaQueryItem[] }
  | { key: string; ok: false; error: BatchMediaItemErrorCode; message: string };

export interface BatchMediaResponse {
  results: BatchMediaItemResult[];
}

export interface NotFoundResolutionResult {
  kind: "not_found";
  key: string;
}

export type ResolveFromKeyResult =
  | NotFoundResolutionResult
  | (MappedEpisodeResult & { media: GetMediaResponse })
  | (CollectionOnlyResult & { media: GetMediaResponse })
  | (UnmappedEpisodeResult & { media: GetMediaResponse });

export interface ReportLeadInput {
  targetExternalKey: MediaLookupKey;
  namespace: Namespace;
  nativeId: string;
  season?: number | null;
  variantDescription?: string | null;
  notes?: string | null;
}

export interface ReportLeadOptions {
  signal?: AbortSignal;
}

export interface LeadRecord {
  id: string;
  targetExternalKey: string;
  namespace: Namespace;
  nativeId: string;
  season: number | null;
  variantDescription: string | null;
  notes: string | null;
  createdAt: string;
}

export interface ReportLeadResponse {
  lead: LeadRecord;
}

export interface MediaRefApiErrorOptions {
  status: number;
  code: string;
  message: string;
  retryAfterSeconds?: number;
}

export class MediaRefApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSeconds: number | undefined;

  constructor(options: MediaRefApiErrorOptions) {
    super(options.message);
    this.name = "MediaRefApiError";
    this.status = options.status;
    this.code = options.code;
    this.retryAfterSeconds = options.retryAfterSeconds;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface MediaRefClient {
  getMedia(key: MediaLookupKey, options?: GetMediaOptions): Promise<GetMediaResponse | null>;
  getMediaBatch(
    keys: ReadonlyArray<MediaLookupKey>,
    options?: GetMediaBatchOptions,
  ): Promise<BatchMediaResponse>;
  resolveFromKey(
    key: MediaLookupKey,
    query: ResolveEpisodeQuery,
    options?: GetMediaOptions,
  ): Promise<ResolveFromKeyResult>;
  reportLead(input: ReportLeadInput, options?: ReportLeadOptions): Promise<ReportLeadResponse>;
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  const raw = (baseUrl ?? DEFAULT_BASE_URL).trim();
  if (raw.length === 0) {
    throw new RangeError("baseUrl must be a non-empty URL string");
  }
  return raw.replace(/\/+$/, "");
}

function serializeLookupKey(key: MediaLookupKey): string {
  return typeof key === "string" ? key : formatExternalKey(key);
}

function validateSeasonOption(season: number | null | undefined): void {
  if (season !== undefined && season !== null && (!Number.isInteger(season) || season < 0)) {
    throw new RangeError("season must be a non-negative integer");
  }
}

function parseRetryAfterHeader(raw: string | null): number | undefined {
  if (raw === null) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (/^\d+$/.test(trimmed)) {
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
  }
  const timestamp = Date.parse(trimmed);
  if (!Number.isNaN(timestamp)) {
    return Math.max(0, Math.ceil((timestamp - Date.now()) / 1000));
  }
  return undefined;
}

async function createApiErrorFromResponse(response: Response): Promise<MediaRefApiError> {
  let code = "HTTP_ERROR";
  let message = response.statusText
    ? `HTTP ${response.status}: ${response.statusText}`
    : `HTTP ${response.status}`;
  let retryAfterSeconds = parseRetryAfterHeader(response.headers.get("retry-after"));

  let rawText = "";
  try {
    rawText = await response.text();
  } catch {
    rawText = "";
  }

  if (rawText.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(rawText);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        if (typeof record.error === "string" && record.error.trim().length > 0) {
          code = record.error;
        } else if (typeof record.code === "string" && record.code.trim().length > 0) {
          code = record.code;
        }
        if (typeof record.message === "string" && record.message.trim().length > 0) {
          message = record.message;
        }
        if (
          retryAfterSeconds === undefined &&
          typeof record.retryAfterSeconds === "number" &&
          Number.isFinite(record.retryAfterSeconds) &&
          record.retryAfterSeconds >= 0
        ) {
          retryAfterSeconds = record.retryAfterSeconds;
        }
      }
    } catch {
      // Non-JSON response body (e.g. proxy/CDN error page); keep fallback code/message.
    }
  }

  return new MediaRefApiError({
    status: response.status,
    code,
    message,
    retryAfterSeconds,
  });
}

export function createMediaRefClient(options: MediaRefClientOptions): MediaRefClient {
  if (typeof options.apiKey !== "string" || options.apiKey.trim().length === 0) {
    throw new RangeError("apiKey must be a non-empty string");
  }

  const apiKey = options.apiKey.trim();
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchFn: FetchLike | undefined =
    options.fetch ??
    (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined);

  if (!fetchFn) {
    throw new Error("No fetch implementation available; provide options.fetch");
  }

  const getMedia = async (
    key: MediaLookupKey,
    getOptions?: GetMediaOptions,
  ): Promise<GetMediaResponse | null> => {
    const keyStr = serializeLookupKey(key);
    if (keyStr.trim().length === 0) {
      throw new RangeError("Media lookup key must be a non-empty string");
    }
    validateSeasonOption(getOptions?.season);

    const params = new URLSearchParams();
    if (getOptions?.includeUnconfirmed !== undefined) {
      params.set("includeUnconfirmed", String(getOptions.includeUnconfirmed));
    }
    if (getOptions?.season !== undefined) {
      params.set("season", String(getOptions.season));
    }
    if (getOptions?.namespaceGroup !== undefined) {
      params.set("namespaceGroup", getOptions.namespaceGroup);
    }

    const queryString = params.toString();
    const url = `${baseUrl}/v1/media/${encodeURIComponent(keyStr)}${queryString.length > 0 ? `?${queryString}` : ""}`;
    const response = await fetchFn(url, {
      method: "GET",
      headers: {
        "X-API-Key": apiKey,
        Accept: "application/json",
      },
      signal: getOptions?.signal,
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw await createApiErrorFromResponse(response);
    }

    return (await response.json()) as GetMediaResponse;
  };

  return {
    getMedia,

    async getMediaBatch(
      keys: ReadonlyArray<MediaLookupKey>,
      batchOptions?: GetMediaBatchOptions,
    ): Promise<BatchMediaResponse> {
      validateSeasonOption(batchOptions?.season);

      if (keys.length === 0) {
        return { results: [] };
      }

      const serializedKeys = keys.map(serializeLookupKey);
      const autoChunk = batchOptions?.autoChunk ?? true;
      if (!autoChunk && serializedKeys.length > MAX_BATCH_MEDIA_KEYS) {
        throw new RangeError(
          `Batch size ${serializedKeys.length} exceeds maximum of ${MAX_BATCH_MEDIA_KEYS} keys when autoChunk is disabled`,
        );
      }

      const allResults: BatchMediaItemResult[] = [];
      for (let offset = 0; offset < serializedKeys.length; offset += MAX_BATCH_MEDIA_KEYS) {
        const chunkKeys = serializedKeys.slice(offset, offset + MAX_BATCH_MEDIA_KEYS);
        const body: Record<string, unknown> = { keys: chunkKeys };
        if (batchOptions?.includeUnconfirmed !== undefined) {
          body.includeUnconfirmed = batchOptions.includeUnconfirmed;
        }
        if (batchOptions?.season !== undefined) {
          body.season = batchOptions.season;
        }
        if (batchOptions?.namespaceGroup !== undefined) {
          body.namespaceGroup = batchOptions.namespaceGroup;
        }

        const response = await fetchFn(`${baseUrl}/v1/media/batch`, {
          method: "POST",
          headers: {
            "X-API-Key": apiKey,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(body),
          signal: batchOptions?.signal,
        });

        if (!response.ok) {
          throw await createApiErrorFromResponse(response);
        }

        const chunkData = (await response.json()) as BatchMediaResponse;
        allResults.push(...chunkData.results);
      }

      return { results: allResults };
    },

    async resolveFromKey(
      key: MediaLookupKey,
      query: ResolveEpisodeQuery,
      getOptions?: GetMediaOptions,
    ): Promise<ResolveFromKeyResult> {
      const keyStr = serializeLookupKey(key);
      const effectiveIncludeUnconfirmed =
        getOptions?.includeUnconfirmed ?? query.includeUnconfirmed;
      const effectiveSeason =
        getOptions?.season !== undefined
          ? getOptions.season
          : query.season !== undefined && Number.isInteger(query.season) && query.season >= 0
            ? query.season
            : undefined;
      const effectiveNamespaceGroup =
        getOptions?.namespaceGroup ?? getNamespaceGroup(query.namespace);

      const media = await getMedia(keyStr, {
        includeUnconfirmed: effectiveIncludeUnconfirmed,
        season: effectiveSeason,
        namespaceGroup: effectiveNamespaceGroup,
        signal: getOptions?.signal,
      });

      if (media === null) {
        return { kind: "not_found", key: keyStr };
      }

      const resolution = resolveEpisode(media.document, {
        ...query,
        ...(effectiveIncludeUnconfirmed !== undefined
          ? { includeUnconfirmed: effectiveIncludeUnconfirmed }
          : {}),
      });

      return { ...resolution, media };
    },

    async reportLead(
      input: ReportLeadInput,
      reportOptions?: ReportLeadOptions,
    ): Promise<ReportLeadResponse> {
      validateSeasonOption(input.season);

      const body: Record<string, unknown> = {
        targetExternalKey: serializeLookupKey(input.targetExternalKey),
        namespace: input.namespace,
        nativeId: input.nativeId,
      };
      if (input.season !== undefined) {
        body.season = input.season;
      }
      if (input.variantDescription !== undefined) {
        body.variantDescription = input.variantDescription;
      }
      if (input.notes !== undefined) {
        body.notes = input.notes;
      }

      const response = await fetchFn(`${baseUrl}/v1/leads`, {
        method: "POST",
        headers: {
          "X-API-Key": apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: reportOptions?.signal,
      });

      if (!response.ok) {
        throw await createApiErrorFromResponse(response);
      }

      return (await response.json()) as ReportLeadResponse;
    },
  };
}
