import { create } from "@bufbuild/protobuf";
import {
  Code,
  ConnectError,
  createClient,
  type Interceptor,
  type Transport,
} from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { LeadService } from "./gen/mediaref/v1/lead_pb.ts";
import { MediaService } from "./gen/mediaref/v1/media_pb.ts";
import { MediaRefSchema, type MediaRef as ProtoMediaRef } from "./gen/mediaref/v1/types_pb.ts";
import {
  extractConnectErrorInfo,
  fromProtoBatchItemResult,
  fromProtoLead,
  fromProtoMediaDocument,
  fromProtoMediaQueryItem,
  fromProtoMediaRef,
  toProtoMediaRefFromInput,
  toProtoNamespaceGroup,
} from "./proto-mappers.ts";
import { resolveEpisode } from "./resolve.ts";
import type {
  CollectionOnlyResult,
  MappedEpisodeResult,
  ResolveEpisodeQuery,
  UnmappedEpisodeResult,
} from "./resolve.ts";
import { getNamespaceGroup } from "./types.ts";
import type { ExternalKey, MediaDocument, MediaRef, Namespace, NamespaceGroup } from "./types.ts";

export const DEFAULT_BASE_URL = "https://api.mediaref.org";
export const MAX_BATCH_MEDIA_KEYS = 100;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type MediaLookupKey = MediaRef | ProtoMediaRef | ExternalKey | string;

export interface MediaRefTransportOptions {
  apiKey?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  /** Defaults to `true` (binary Protobuf wire format). Set `false` for Connect JSON. */
  useBinaryFormat?: boolean;
  /** Enables Connect HTTP GET for side-effect-free read RPCs. Defaults to `false`. */
  useHttpGet?: boolean;
  interceptors?: Interceptor[];
}

export interface MediaRefClientOptions extends MediaRefTransportOptions {
  apiKey: string;
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
  ref: MediaRef | null;
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
  | { ref: MediaRef | null; key: string; ok: true; items: MediaQueryItem[] }
  | {
      ref: MediaRef | null;
      key: string;
      ok: false;
      error: BatchMediaItemErrorCode;
      message: string;
    };

export interface BatchMediaResponse {
  results: BatchMediaItemResult[];
}

export interface NotFoundResolutionResult {
  kind: "not_found";
  ref: MediaRef | null;
  key: string;
}

export type ResolveFromKeyResult =
  | NotFoundResolutionResult
  | (MappedEpisodeResult & { media: GetMediaResponse })
  | (CollectionOnlyResult & { media: GetMediaResponse })
  | (UnmappedEpisodeResult & { media: GetMediaResponse });

export interface ReportLeadInput {
  target: MediaLookupKey;
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
  target: MediaRef | null;
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
  readonly transport: Transport;
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

function toStrictProtoMediaRef(input: MediaLookupKey): ProtoMediaRef {
  const protoRef = toProtoMediaRefFromInput(input);
  if (!protoRef) {
    throw new RangeError("Invalid media reference");
  }
  const validated = fromProtoMediaRef(protoRef);
  if (!validated.ok) {
    throw new RangeError(validated.message);
  }
  return protoRef;
}

function toBatchProtoMediaRef(input: MediaLookupKey): ProtoMediaRef {
  return toProtoMediaRefFromInput(input) ?? create(MediaRefSchema);
}

function validateSeasonOption(season: number | null | undefined): void {
  if (season !== undefined && season !== null && (!Number.isInteger(season) || season < 0)) {
    throw new RangeError("season must be a non-negative integer");
  }
}

function toGlobalFetch(fetchFn: FetchLike): typeof globalThis.fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return fetchFn(url, init);
  }) as typeof globalThis.fetch;
}

function toMediaRefApiError(error: unknown): never {
  if (error instanceof MediaRefApiError) {
    throw error;
  }
  if (error instanceof ConnectError) {
    const info = extractConnectErrorInfo(error);
    throw new MediaRefApiError({
      status: info.status,
      code: info.code,
      message: info.message,
      retryAfterSeconds: info.retryAfterSeconds,
    });
  }
  throw error;
}

export function createMediaRefTransport(options: MediaRefTransportOptions = {}): Transport {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchFn: FetchLike | undefined =
    options.fetch ??
    (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined);

  if (!fetchFn) {
    throw new Error("No fetch implementation available; provide options.fetch");
  }

  const interceptors: Interceptor[] = [];
  const trimmedKey = options.apiKey?.trim();
  if (trimmedKey && trimmedKey.length > 0) {
    interceptors.push((next) => (req) => {
      if (!req.header.has("X-API-Key")) {
        req.header.set("X-API-Key", trimmedKey);
      }
      return next(req);
    });
  }
  if (options.interceptors && options.interceptors.length > 0) {
    interceptors.push(...options.interceptors);
  }

  return createConnectTransport({
    baseUrl,
    useBinaryFormat: options.useBinaryFormat ?? true,
    useHttpGet: options.useHttpGet ?? false,
    fetch: toGlobalFetch(fetchFn),
    interceptors,
  });
}

export function createMediaRefClient(options: MediaRefClientOptions): MediaRefClient {
  if (typeof options.apiKey !== "string" || options.apiKey.trim().length === 0) {
    throw new RangeError("apiKey must be a non-empty string");
  }

  const transport = createMediaRefTransport(options);
  const mediaRpc = createClient(MediaService, transport);
  const leadRpc = createClient(LeadService, transport);

  const getMedia = async (
    key: MediaLookupKey,
    getOptions?: GetMediaOptions,
  ): Promise<GetMediaResponse | null> => {
    const protoRef = toStrictProtoMediaRef(key);
    validateSeasonOption(getOptions?.season);

    try {
      const res = await mediaRpc.getMedia(
        {
          ref: protoRef,
          includeUnconfirmed: getOptions?.includeUnconfirmed ?? false,
          ...(getOptions?.season !== undefined ? { season: getOptions.season } : {}),
          namespaceGroup: toProtoNamespaceGroup(getOptions?.namespaceGroup),
        },
        {
          signal: getOptions?.signal,
        },
      );

      if (!res.document) {
        return null;
      }

      const decodedRef = fromProtoMediaRef(res.ref ?? protoRef);
      const document = fromProtoMediaDocument(res.document);
      const items = res.items.map(fromProtoMediaQueryItem);
      return {
        ref: decodedRef.ok ? decodedRef.ref : null,
        key: decodedRef.ok ? decodedRef.key : "",
        document,
        matchedAssociationId: res.matchedAssociationId ?? null,
        items,
      };
    } catch (error) {
      if (error instanceof ConnectError && error.code === Code.NotFound) {
        return null;
      }
      toMediaRefApiError(error);
    }
  };

  return {
    transport,
    getMedia,

    async getMediaBatch(
      keys: ReadonlyArray<MediaLookupKey>,
      batchOptions?: GetMediaBatchOptions,
    ): Promise<BatchMediaResponse> {
      validateSeasonOption(batchOptions?.season);

      if (keys.length === 0) {
        return { results: [] };
      }

      const protoRefs = keys.map(toBatchProtoMediaRef);
      const autoChunk = batchOptions?.autoChunk ?? true;
      if (!autoChunk && protoRefs.length > MAX_BATCH_MEDIA_KEYS) {
        throw new RangeError(
          `Batch size ${protoRefs.length} exceeds maximum of ${MAX_BATCH_MEDIA_KEYS} refs when autoChunk is disabled`,
        );
      }

      const allResults: BatchMediaItemResult[] = [];
      for (let offset = 0; offset < protoRefs.length; offset += MAX_BATCH_MEDIA_KEYS) {
        const chunkRefs = protoRefs.slice(offset, offset + MAX_BATCH_MEDIA_KEYS);
        try {
          const res = await mediaRpc.batchGetMedia(
            {
              refs: chunkRefs,
              includeUnconfirmed: batchOptions?.includeUnconfirmed ?? false,
              ...(batchOptions?.season !== undefined ? { season: batchOptions.season } : {}),
              namespaceGroup: toProtoNamespaceGroup(batchOptions?.namespaceGroup),
            },
            {
              signal: batchOptions?.signal,
            },
          );
          for (const entry of res.results) {
            allResults.push(fromProtoBatchItemResult(entry));
          }
        } catch (error) {
          toMediaRefApiError(error);
        }
      }

      return { results: allResults };
    },

    async resolveFromKey(
      key: MediaLookupKey,
      query: ResolveEpisodeQuery,
      getOptions?: GetMediaOptions,
    ): Promise<ResolveFromKeyResult> {
      const protoRef = toStrictProtoMediaRef(key);
      const decoded = fromProtoMediaRef(protoRef);
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

      const media = await getMedia(protoRef, {
        includeUnconfirmed: effectiveIncludeUnconfirmed,
        season: effectiveSeason,
        namespaceGroup: effectiveNamespaceGroup,
        signal: getOptions?.signal,
      });

      if (media === null) {
        return {
          kind: "not_found",
          ref: decoded.ok ? decoded.ref : null,
          key: decoded.ok ? decoded.key : "",
        };
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
      const protoTarget = toStrictProtoMediaRef(input.target);
      validateSeasonOption(input.season);

      try {
        const res = await leadRpc.createLead(
          {
            target: protoTarget,
            namespace: input.namespace,
            nativeId: input.nativeId,
            ...(input.season !== undefined && input.season !== null
              ? { season: input.season }
              : {}),
            ...(input.variantDescription !== undefined && input.variantDescription !== null
              ? { variantDescription: input.variantDescription }
              : {}),
            ...(input.notes !== undefined && input.notes !== null ? { notes: input.notes } : {}),
          },
          {
            signal: reportOptions?.signal,
          },
        );

        if (!res.lead) {
          throw new MediaRefApiError({
            status: 500,
            code: "INVALID_RESPONSE",
            message: "Server returned empty lead payload",
          });
        }

        return { lead: fromProtoLead(res.lead) };
      } catch (error) {
        toMediaRefApiError(error);
      }
    },
  };
}
