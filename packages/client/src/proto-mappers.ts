import { create, type JsonObject, type MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  ApiKeyAction as ProtoApiKeyAction,
  AssociationSchema,
  AssociationStatus as ProtoAssociationStatus,
  ChangeRequestStatus as ProtoChangeRequestStatus,
  ErrorInfoDetailSchema,
  ExplicitSegmentInputSchema,
  ExternalIdSchema,
  MediaDocumentSchema,
  MediaQueryItemSchema,
  MediaRefSchema,
  MediaSchema,
  MediaSnapshotSchema,
  MediaType as ProtoMediaType,
  NamespaceGroup as ProtoNamespaceGroup,
  Platform as ProtoPlatform,
  PlatformRefSchema,
  PlatformStatus as ProtoPlatformStatus,
  PlatformStatusEntrySchema,
  SeasonSnapshotSchema,
  SegmentInputSchema,
  SegmentSchema,
  SortOrder as ProtoSortOrder,
  SubmitterType as ProtoSubmitterType,
  TmdbRefSchema,
  TraktRefSchema,
  TvdbRefSchema,
  UnconfirmedAssociationSource as ProtoUnconfirmedAssociationSource,
  VariantSchema,
  WholeSeasonSegmentInputSchema,
  type Association as ProtoAssociation,
  type ErrorInfoDetail as ProtoErrorInfoDetail,
  type ExternalId as ProtoExternalId,
  type Media as ProtoMedia,
  type MediaDocument as ProtoMediaDocument,
  type MediaQueryItem as ProtoMediaQueryItem,
  type MediaRef as ProtoMediaRef,
  type MediaSnapshot as ProtoMediaSnapshot,
  type PlatformStatusEntry as ProtoPlatformStatusEntry,
  type SeasonSnapshot as ProtoSeasonSnapshot,
  type Segment as ProtoSegment,
  type SegmentInput as ProtoSegmentInput,
  type Variant as ProtoVariant,
} from "./gen/mediaref/v1/types_pb.ts";
import {
  BatchMediaItemErrorSchema,
  BatchMediaItemResultSchema,
  BatchMediaItemSuccessSchema,
  type BatchMediaItemResult as ProtoBatchMediaItemResult,
} from "./gen/mediaref/v1/media_pb.ts";
import { parseExternalKey } from "./external-key.ts";
import type {
  Association,
  AssociationStatus,
  BaselineSource,
  ChangeRequestStatus,
  ExplicitSegmentInput,
  ExternalId,
  ExternalIdNamespace,
  ExternalKey,
  Media,
  MediaDocument,
  MediaRef,
  MediaSnapshot,
  MediaType,
  Namespace,
  NamespaceGroup,
  NormalizedSegment,
  PlatformNamespace,
  PlatformStatusEntry,
  SeasonSnapshot,
  Segment,
  SegmentInput,
  UnconfirmedAssociationSource,
  Variant,
  WholeSeasonSegmentInput,
} from "./types.ts";
import { isPlatformNamespace } from "./types.ts";
import type { SegmentValidationError, SegmentValidationErrorCode } from "./validation.ts";

export interface ExtractedConnectErrorInfo {
  status: number;
  code: string;
  message: string;
  retryAfterSeconds: number | undefined;
  scope: string | undefined;
  limit: number | undefined;
  used: number | undefined;
  windowSeconds: number | undefined;
  validationErrors: SegmentValidationError[] | undefined;
}

export function httpStatusToConnectCode(status: number): Code {
  switch (status) {
    case 400:
      return Code.InvalidArgument;
    case 401:
      return Code.Unauthenticated;
    case 403:
      return Code.PermissionDenied;
    case 404:
      return Code.NotFound;
    case 409:
      return Code.FailedPrecondition;
    case 429:
      return Code.ResourceExhausted;
    case 501:
      return Code.Unimplemented;
    case 502:
    case 503:
      return Code.Unavailable;
    case 504:
      return Code.DeadlineExceeded;
    default:
      return status >= 400 && status < 500 ? Code.InvalidArgument : Code.Internal;
  }
}

export function connectCodeToHttpStatus(code: Code): number {
  switch (code) {
    case Code.InvalidArgument:
    case Code.OutOfRange:
      return 400;
    case Code.Unauthenticated:
      return 401;
    case Code.PermissionDenied:
      return 403;
    case Code.NotFound:
      return 404;
    case Code.AlreadyExists:
    case Code.FailedPrecondition:
    case Code.Aborted:
      return 409;
    case Code.ResourceExhausted:
      return 429;
    case Code.Canceled:
      return 499;
    case Code.Unimplemented:
      return 501;
    case Code.Unavailable:
      return 503;
    case Code.DeadlineExceeded:
      return 504;
    default:
      return 500;
  }
}

function connectCodeToFallbackErrorCode(code: Code): string {
  switch (code) {
    case Code.InvalidArgument:
      return "INVALID_ARGUMENT";
    case Code.Unauthenticated:
      return "UNAUTHORIZED";
    case Code.PermissionDenied:
      return "FORBIDDEN";
    case Code.NotFound:
      return "NOT_FOUND";
    case Code.AlreadyExists:
      return "ALREADY_EXISTS";
    case Code.FailedPrecondition:
      return "FAILED_PRECONDITION";
    case Code.ResourceExhausted:
      return "RATE_LIMITED";
    case Code.Unimplemented:
      return "UNIMPLEMENTED";
    case Code.Unavailable:
      return "UNAVAILABLE";
    case Code.DeadlineExceeded:
      return "DEADLINE_EXCEEDED";
    case Code.Canceled:
      return "CANCELED";
    default:
      return "INTERNAL_ERROR";
  }
}

export function parseRetryAfterHeaderValue(raw: string | null): number | undefined {
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

export function createDomainConnectError(input: {
  status: number;
  code: string;
  message: string;
  retryAfterSeconds?: number;
  scope?: string;
  limit?: number;
  used?: number;
  windowSeconds?: number;
  validationErrors?: readonly SegmentValidationError[];
  headers?: HeadersInit;
}): ConnectError {
  const headers = new Headers(input.headers);
  if (input.retryAfterSeconds !== undefined) {
    headers.set("Retry-After", String(input.retryAfterSeconds));
  }

  const detailInit: MessageInitShape<typeof ErrorInfoDetailSchema> = {
    errorCode: input.code,
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.used !== undefined ? { used: input.used } : {}),
    ...(input.windowSeconds !== undefined ? { windowSeconds: input.windowSeconds } : {}),
    ...(input.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: input.retryAfterSeconds }
      : {}),
    ...(input.validationErrors && input.validationErrors.length > 0
      ? {
          validationErrors: input.validationErrors.map((err) => ({
            code: err.code,
            message: err.message,
            ...(err.segmentIndex !== undefined ? { segmentIndex: err.segmentIndex } : {}),
          })),
        }
      : {}),
  };

  return new ConnectError(input.message, httpStatusToConnectCode(input.status), headers, [
    { desc: ErrorInfoDetailSchema, value: detailInit },
  ]);
}

export function extractConnectErrorInfo(error: ConnectError): ExtractedConnectErrorInfo {
  const detail: ProtoErrorInfoDetail | undefined = error.findDetails(ErrorInfoDetailSchema)[0];
  const retryFromHeader = parseRetryAfterHeaderValue(error.metadata.get("retry-after"));
  const retryAfterSeconds = retryFromHeader ?? detail?.retryAfterSeconds;

  let status = connectCodeToHttpStatus(error.code);
  let code = detail?.errorCode?.trim() || "";
  if (!code) {
    const httpMatch = error.rawMessage.match(/\bHTTP\s+(\d{3})\b/i);
    if (httpMatch) {
      const parsedStatus = Number.parseInt(httpMatch[1]!, 10);
      if (Number.isInteger(parsedStatus) && parsedStatus >= 400 && parsedStatus <= 599) {
        status = parsedStatus;
      }
      code = "HTTP_ERROR";
    } else {
      code = connectCodeToFallbackErrorCode(error.code);
    }
  }

  const validationErrors =
    detail && detail.validationErrors.length > 0
      ? detail.validationErrors.map((entry) => ({
          code: entry.code as SegmentValidationErrorCode,
          message: entry.message,
          ...(entry.segmentIndex !== undefined ? { segmentIndex: entry.segmentIndex } : {}),
        }))
      : undefined;

  return {
    status,
    code,
    message: error.rawMessage || error.message,
    retryAfterSeconds,
    scope: detail?.scope,
    limit: detail?.limit,
    used: detail?.used,
    windowSeconds: detail?.windowSeconds,
    validationErrors,
  };
}

export function toProtoMediaType(type: MediaType): ProtoMediaType {
  return type === "movie" ? ProtoMediaType.MOVIE : ProtoMediaType.TV;
}

export function fromProtoMediaType(type: ProtoMediaType): MediaType {
  return type === ProtoMediaType.MOVIE ? "movie" : "tv";
}

export function fromProtoOptionalMediaType(type: ProtoMediaType): MediaType | undefined {
  if (type === ProtoMediaType.MOVIE) {
    return "movie";
  }
  if (type === ProtoMediaType.TV) {
    return "tv";
  }
  return undefined;
}

export function toProtoPlatform(platform: PlatformNamespace): ProtoPlatform {
  switch (platform) {
    case "tencent":
      return ProtoPlatform.TENCENT;
    case "iqiyi":
      return ProtoPlatform.IQIYI;
    case "youku":
      return ProtoPlatform.YOUKU;
    case "bilibili":
      return ProtoPlatform.BILIBILI;
    case "mgtv":
      return ProtoPlatform.MGTV;
  }
}

export function fromProtoPlatform(platform: ProtoPlatform): PlatformNamespace | undefined {
  switch (platform) {
    case ProtoPlatform.TENCENT:
      return "tencent";
    case ProtoPlatform.IQIYI:
      return "iqiyi";
    case ProtoPlatform.YOUKU:
      return "youku";
    case ProtoPlatform.BILIBILI:
      return "bilibili";
    case ProtoPlatform.MGTV:
      return "mgtv";
    default:
      return undefined;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POSITIVE_INT32_MAX = 2_147_483_647;
const POSITIVE_INT_PATTERN = /^[1-9]\d*$/;
const TMDB_NATIVE_ID_PATTERN = /^(movie|tv):([1-9]\d*)$/i;
const TVDB_TYPED_PATTERN = /^(movie|series|tv):([1-9]\d*)$/i;
const TRAKT_TYPED_PATTERN = /^(movie|show):(.+)$/i;

function parsePositiveInt32(raw: string): number | null {
  if (!POSITIVE_INT_PATTERN.test(raw)) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > POSITIVE_INT32_MAX) {
    return null;
  }
  return parsed;
}

export function parseMediaRefFromKey(raw: string): MediaRef | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (UUID_PATTERN.test(trimmed)) {
    return { mediaId: trimmed };
  }

  if (trimmed.startsWith("media:")) {
    const candidateId = trimmed.slice("media:".length);
    if (UUID_PATTERN.test(candidateId)) {
      return { mediaId: candidateId };
    }
    return null;
  }

  const parsed = parseExternalKey(trimmed);
  if (!parsed) {
    return null;
  }

  switch (parsed.namespace) {
    case "tmdb": {
      const match = parsed.nativeId.match(TMDB_NATIVE_ID_PATTERN);
      if (!match) {
        return null;
      }
      const id = parsePositiveInt32(match[2]!);
      if (id === null) {
        return null;
      }
      return {
        tmdb: {
          type: match[1]!.toLowerCase() as MediaType,
          id,
        },
      };
    }
    case "imdb":
      return { imdb: parsed.nativeId };
    case "tvdb": {
      const plainId = parsePositiveInt32(parsed.nativeId);
      if (plainId !== null) {
        return { tvdb: { id: plainId } };
      }
      const typed = parsed.nativeId.match(TVDB_TYPED_PATTERN);
      if (!typed) {
        return null;
      }
      const id = parsePositiveInt32(typed[2]!);
      if (id === null) {
        return null;
      }
      const kind = typed[1]!.toLowerCase();
      return {
        tvdb: {
          id,
          type: kind === "movie" ? "movie" : "tv",
        },
      };
    }
    case "trakt": {
      const typed = parsed.nativeId.match(TRAKT_TYPED_PATTERN);
      if (typed) {
        const kind = typed[1]!.toLowerCase();
        const id = typed[2]!.trim();
        if (id.length === 0) {
          return null;
        }
        return {
          trakt: {
            id,
            type: kind === "movie" ? "movie" : "tv",
          },
        };
      }
      return { trakt: { id: parsed.nativeId } };
    }
    case "douban":
      return { douban: parsed.nativeId };
    case "bangumi":
      return { bangumi: parsed.nativeId };
    case "tencent":
    case "iqiyi":
    case "youku":
    case "bilibili":
    case "mgtv":
      return {
        platform: {
          platform: parsed.namespace,
          nativeId: parsed.nativeId,
        },
      };
  }
}

export function formatMediaRefKey(ref: MediaRef, options?: { mode?: "read" | "target" }): string {
  const mode = options?.mode ?? "read";
  if ("mediaId" in ref) {
    return `media:${ref.mediaId}`;
  }
  if ("tmdb" in ref) {
    return `tmdb:${ref.tmdb.type}:${ref.tmdb.id}`;
  }
  if ("imdb" in ref) {
    return `imdb:${ref.imdb}`;
  }
  if ("tvdb" in ref) {
    if (ref.tvdb.type === "movie") {
      return `tvdb:movie:${ref.tvdb.id}`;
    }
    if (ref.tvdb.type === "tv" && mode === "target") {
      return `tvdb:series:${ref.tvdb.id}`;
    }
    return `tvdb:${ref.tvdb.id}`;
  }
  if ("trakt" in ref) {
    if (ref.trakt.type === "movie") {
      return `trakt:movie:${ref.trakt.id}`;
    }
    if (ref.trakt.type === "tv") {
      return `trakt:show:${ref.trakt.id}`;
    }
    return `trakt:${ref.trakt.id}`;
  }
  if ("douban" in ref) {
    return `douban:${ref.douban}`;
  }
  if ("bangumi" in ref) {
    return `bangumi:${ref.bangumi}`;
  }
  return `${ref.platform.platform}:${ref.platform.nativeId}`;
}

export function isProtoMediaRef(value: unknown): value is ProtoMediaRef {
  return (
    typeof value === "object" &&
    value !== null &&
    "$typeName" in value &&
    (value as { $typeName?: unknown }).$typeName === "mediaref.v1.MediaRef"
  );
}

export function toProtoMediaRef(ref: MediaRef | ProtoMediaRef): ProtoMediaRef {
  if (isProtoMediaRef(ref)) {
    return ref;
  }
  if ("mediaId" in ref) {
    return create(MediaRefSchema, {
      id: { case: "mediaId", value: ref.mediaId },
    });
  }
  if ("tmdb" in ref) {
    return create(MediaRefSchema, {
      id: {
        case: "tmdb",
        value: create(TmdbRefSchema, {
          type: toProtoMediaType(ref.tmdb.type),
          id: ref.tmdb.id,
        }),
      },
    });
  }
  if ("imdb" in ref) {
    return create(MediaRefSchema, {
      id: { case: "imdb", value: ref.imdb },
    });
  }
  if ("tvdb" in ref) {
    return create(MediaRefSchema, {
      id: {
        case: "tvdb",
        value: create(TvdbRefSchema, {
          id: ref.tvdb.id,
          type:
            ref.tvdb.type !== undefined
              ? toProtoMediaType(ref.tvdb.type)
              : ProtoMediaType.UNSPECIFIED,
        }),
      },
    });
  }
  if ("trakt" in ref) {
    return create(MediaRefSchema, {
      id: {
        case: "trakt",
        value: create(TraktRefSchema, {
          id: ref.trakt.id,
          type:
            ref.trakt.type !== undefined
              ? toProtoMediaType(ref.trakt.type)
              : ProtoMediaType.UNSPECIFIED,
        }),
      },
    });
  }
  if ("douban" in ref) {
    return create(MediaRefSchema, {
      id: { case: "douban", value: ref.douban },
    });
  }
  if ("bangumi" in ref) {
    return create(MediaRefSchema, {
      id: { case: "bangumi", value: ref.bangumi },
    });
  }
  return create(MediaRefSchema, {
    id: {
      case: "platform",
      value: create(PlatformRefSchema, {
        platform: toProtoPlatform(ref.platform.platform),
        nativeId: ref.platform.nativeId,
      }),
    },
  });
}

export function toProtoMediaRefFromKey(raw: string): ProtoMediaRef | null {
  const parsed = parseMediaRefFromKey(raw);
  return parsed ? toProtoMediaRef(parsed) : null;
}

export function toProtoMediaRefFromInput(
  input: MediaRef | ProtoMediaRef | ExternalKey | string,
): ProtoMediaRef | null {
  if (typeof input === "string") {
    return toProtoMediaRefFromKey(input);
  }
  if (isProtoMediaRef(input)) {
    return input;
  }
  if ("namespace" in input && "nativeId" in input) {
    return toProtoMediaRefFromKey(`${input.namespace}:${input.nativeId}`);
  }
  return toProtoMediaRef(input);
}

export type DecodedMediaRefResult =
  | { ok: true; ref: MediaRef; key: string }
  | { ok: false; message: string };

export function fromProtoMediaRef(
  protoRef: ProtoMediaRef | undefined,
  options?: { mode?: "read" | "target" },
): DecodedMediaRefResult {
  if (!protoRef || protoRef.id.case === undefined) {
    return {
      ok: false,
      message:
        "Media reference is required (provide media_id, tmdb, imdb, tvdb, trakt, douban, bangumi, or platform)",
    };
  }

  let ref: MediaRef;
  switch (protoRef.id.case) {
    case "mediaId": {
      const trimmed = protoRef.id.value.trim();
      if (!UUID_PATTERN.test(trimmed)) {
        return { ok: false, message: "media_id must be a valid UUID" };
      }
      ref = { mediaId: trimmed };
      break;
    }
    case "tmdb": {
      const type = fromProtoOptionalMediaType(protoRef.id.value.type);
      const id = protoRef.id.value.id;
      if (!type || !Number.isInteger(id) || id <= 0) {
        return {
          ok: false,
          message: "tmdb reference requires type (movie or tv) and a positive integer id",
        };
      }
      ref = { tmdb: { type, id } };
      break;
    }
    case "imdb": {
      const trimmed = protoRef.id.value.trim();
      if (trimmed.length === 0) {
        return { ok: false, message: "imdb id must be a non-empty string" };
      }
      ref = { imdb: trimmed };
      break;
    }
    case "tvdb": {
      const id = protoRef.id.value.id;
      if (!Number.isInteger(id) || id <= 0) {
        return { ok: false, message: "tvdb reference requires a positive integer id" };
      }
      const rawType = protoRef.id.value.type;
      if (
        rawType !== ProtoMediaType.UNSPECIFIED &&
        rawType !== ProtoMediaType.MOVIE &&
        rawType !== ProtoMediaType.TV
      ) {
        return { ok: false, message: "tvdb media type must be movie, tv, or unspecified" };
      }
      const type = fromProtoOptionalMediaType(rawType);
      ref = { tvdb: { id, ...(type !== undefined ? { type } : {}) } };
      break;
    }
    case "trakt": {
      const trimmed = protoRef.id.value.id.trim();
      if (trimmed.length === 0) {
        return { ok: false, message: "trakt reference requires a non-empty id" };
      }
      const rawType = protoRef.id.value.type;
      if (
        rawType !== ProtoMediaType.UNSPECIFIED &&
        rawType !== ProtoMediaType.MOVIE &&
        rawType !== ProtoMediaType.TV
      ) {
        return { ok: false, message: "trakt media type must be movie, tv, or unspecified" };
      }
      const type = fromProtoOptionalMediaType(rawType);
      ref = { trakt: { id: trimmed, ...(type !== undefined ? { type } : {}) } };
      break;
    }
    case "douban": {
      const trimmed = protoRef.id.value.trim();
      if (trimmed.length === 0) {
        return { ok: false, message: "douban id must be a non-empty string" };
      }
      ref = { douban: trimmed };
      break;
    }
    case "bangumi": {
      const trimmed = protoRef.id.value.trim();
      if (trimmed.length === 0) {
        return { ok: false, message: "bangumi id must be a non-empty string" };
      }
      ref = { bangumi: trimmed };
      break;
    }
    case "platform": {
      const platform = fromProtoPlatform(protoRef.id.value.platform);
      const nativeId = protoRef.id.value.nativeId.trim();
      if (!platform) {
        return { ok: false, message: "platform reference requires a valid platform" };
      }
      if (nativeId.length === 0) {
        return { ok: false, message: "platform reference requires a non-empty native_id" };
      }
      ref = { platform: { platform, nativeId } };
      break;
    }
  }

  return {
    ok: true,
    ref,
    key: formatMediaRefKey(ref, options),
  };
}

export function toProtoNamespaceGroup(group: NamespaceGroup | undefined): ProtoNamespaceGroup {
  if (group === "platform") {
    return ProtoNamespaceGroup.PLATFORM;
  }
  if (group === "catalog") {
    return ProtoNamespaceGroup.CATALOG;
  }
  return ProtoNamespaceGroup.UNSPECIFIED;
}

export function fromProtoNamespaceGroup(group: ProtoNamespaceGroup): NamespaceGroup | undefined {
  if (group === ProtoNamespaceGroup.PLATFORM) {
    return "platform";
  }
  if (group === ProtoNamespaceGroup.CATALOG) {
    return "catalog";
  }
  return undefined;
}

export function toProtoAssociationStatus(status: AssociationStatus): ProtoAssociationStatus {
  switch (status) {
    case "confirmed":
      return ProtoAssociationStatus.CONFIRMED;
    case "seed_unconfirmed":
      return ProtoAssociationStatus.SEED_UNCONFIRMED;
    case "delisted":
      return ProtoAssociationStatus.DELISTED;
  }
}

export function fromProtoAssociationStatus(status: ProtoAssociationStatus): AssociationStatus {
  switch (status) {
    case ProtoAssociationStatus.SEED_UNCONFIRMED:
      return "seed_unconfirmed";
    case ProtoAssociationStatus.DELISTED:
      return "delisted";
    case ProtoAssociationStatus.CONFIRMED:
    default:
      return "confirmed";
  }
}

export function toProtoChangeRequestStatus(
  status: ChangeRequestStatus | undefined,
): ProtoChangeRequestStatus {
  switch (status) {
    case "pending_evidence":
      return ProtoChangeRequestStatus.PENDING_EVIDENCE;
    case "approved":
      return ProtoChangeRequestStatus.APPROVED;
    case "needs_review":
      return ProtoChangeRequestStatus.NEEDS_REVIEW;
    case "rejected":
      return ProtoChangeRequestStatus.REJECTED;
    default:
      return ProtoChangeRequestStatus.UNSPECIFIED;
  }
}

export function fromProtoChangeRequestStatus(
  status: ProtoChangeRequestStatus,
): ChangeRequestStatus | undefined {
  switch (status) {
    case ProtoChangeRequestStatus.PENDING_EVIDENCE:
      return "pending_evidence";
    case ProtoChangeRequestStatus.APPROVED:
      return "approved";
    case ProtoChangeRequestStatus.NEEDS_REVIEW:
      return "needs_review";
    case ProtoChangeRequestStatus.REJECTED:
      return "rejected";
    default:
      return undefined;
  }
}

export function toProtoUnconfirmedSource(
  source: UnconfirmedAssociationSource,
): ProtoUnconfirmedAssociationSource {
  return source === "seed_unconfirmed"
    ? ProtoUnconfirmedAssociationSource.SEED_UNCONFIRMED
    : ProtoUnconfirmedAssociationSource.CHANGE_REQUEST;
}

export function fromProtoUnconfirmedSource(
  source: ProtoUnconfirmedAssociationSource,
): UnconfirmedAssociationSource | undefined {
  if (source === ProtoUnconfirmedAssociationSource.SEED_UNCONFIRMED) {
    return "seed_unconfirmed";
  }
  if (source === ProtoUnconfirmedAssociationSource.CHANGE_REQUEST) {
    return "change_request";
  }
  return undefined;
}

export function toProtoSubmitterType(type: "human" | "agent"): ProtoSubmitterType {
  return type === "agent" ? ProtoSubmitterType.AGENT : ProtoSubmitterType.HUMAN;
}

export function fromProtoSubmitterType(type: ProtoSubmitterType): "human" | "agent" {
  return type === ProtoSubmitterType.AGENT ? "agent" : "human";
}

export function toProtoSortOrder(order: "asc" | "desc" | undefined): ProtoSortOrder {
  if (order === "desc") {
    return ProtoSortOrder.DESC;
  }
  if (order === "asc") {
    return ProtoSortOrder.ASC;
  }
  return ProtoSortOrder.UNSPECIFIED;
}

export function fromProtoSortOrder(order: ProtoSortOrder): "asc" | "desc" {
  return order === ProtoSortOrder.DESC ? "desc" : "asc";
}

export function toProtoApiKeyAction(action: "read" | "report" | "submit"): ProtoApiKeyAction {
  switch (action) {
    case "read":
      return ProtoApiKeyAction.READ;
    case "report":
      return ProtoApiKeyAction.REPORT;
    case "submit":
      return ProtoApiKeyAction.SUBMIT;
  }
}

export function fromProtoApiKeyAction(
  action: ProtoApiKeyAction,
): "read" | "report" | "submit" | undefined {
  switch (action) {
    case ProtoApiKeyAction.READ:
      return "read";
    case ProtoApiKeyAction.REPORT:
      return "report";
    case ProtoApiKeyAction.SUBMIT:
      return "submit";
    default:
      return undefined;
  }
}

export function toProtoSegment(seg: Segment): ProtoSegment {
  return create(SegmentSchema, {
    season: seg.season,
    episodeStart: seg.episodeStart,
    ...(seg.episodeEnd !== null ? { episodeEnd: seg.episodeEnd } : {}),
    targetEpisodeStart: seg.targetEpisodeStart,
    baseline: seg.baseline,
    nonLinear: Boolean(seg.nonLinear),
    needsReview: Boolean(seg.needsReview),
  });
}

export function fromProtoSegment(seg: ProtoSegment): NormalizedSegment {
  return {
    season: seg.season,
    episodeStart: seg.episodeStart,
    episodeEnd: seg.episodeEnd ?? null,
    targetEpisodeStart: seg.targetEpisodeStart,
    baseline: seg.baseline as BaselineSource,
    nonLinear: seg.nonLinear,
    needsReview: seg.needsReview,
  };
}

export function toProtoSegmentInput(
  input:
    | SegmentInput
    | (Omit<WholeSeasonSegmentInput, "baseline"> & { baseline?: BaselineSource })
    | (Omit<ExplicitSegmentInput, "baseline"> & { baseline?: BaselineSource }),
): ProtoSegmentInput {
  if (input.episodeStart === undefined) {
    return create(SegmentInputSchema, {
      kind: {
        case: "wholeSeason",
        value: create(WholeSeasonSegmentInputSchema, {
          season: input.season,
          baseline: input.baseline ?? "",
          nonLinear: Boolean(input.nonLinear),
          needsReview: Boolean(input.needsReview),
        }),
      },
    });
  }

  return create(SegmentInputSchema, {
    kind: {
      case: "explicit",
      value: create(ExplicitSegmentInputSchema, {
        season: input.season,
        episodeStart: input.episodeStart,
        ...(input.episodeEnd !== undefined && input.episodeEnd !== null
          ? { episodeEnd: input.episodeEnd }
          : {}),
        targetEpisodeStart: input.targetEpisodeStart,
        baseline: input.baseline ?? "",
        nonLinear: Boolean(input.nonLinear),
        needsReview: Boolean(input.needsReview),
      }),
    },
  });
}

export function fromProtoSegmentInput(input: ProtoSegmentInput): SegmentInput | null {
  if (input.kind.case === "wholeSeason") {
    const ws = input.kind.value;
    const baseline = ws.baseline.trim();
    return {
      season: ws.season,
      ...(baseline.length > 0 ? { baseline: baseline as BaselineSource } : {}),
      nonLinear: ws.nonLinear,
      needsReview: ws.needsReview,
    } as SegmentInput;
  }
  if (input.kind.case === "explicit") {
    const ex = input.kind.value;
    const baseline = ex.baseline.trim();
    return {
      season: ex.season,
      episodeStart: ex.episodeStart,
      episodeEnd: ex.episodeEnd ?? null,
      targetEpisodeStart: ex.targetEpisodeStart,
      ...(baseline.length > 0 ? { baseline: baseline as BaselineSource } : {}),
      nonLinear: ex.nonLinear,
      needsReview: ex.needsReview,
    } as SegmentInput;
  }
  return null;
}

export function toProtoPlatformStatusEntry(entry: PlatformStatusEntry): ProtoPlatformStatusEntry {
  switch (entry.status) {
    case "associated":
      return create(PlatformStatusEntrySchema, {
        status: ProtoPlatformStatus.ASSOCIATED,
      });
    case "not_found":
      return create(PlatformStatusEntrySchema, {
        status: ProtoPlatformStatus.NOT_FOUND,
        checkedAt: entry.checkedAt,
      });
    case "unchecked":
      return create(PlatformStatusEntrySchema, {
        status: ProtoPlatformStatus.UNCHECKED,
      });
  }
}

export function fromProtoPlatformStatusEntry(entry: ProtoPlatformStatusEntry): PlatformStatusEntry {
  switch (entry.status) {
    case ProtoPlatformStatus.ASSOCIATED:
      return { status: "associated" };
    case ProtoPlatformStatus.NOT_FOUND:
      return { status: "not_found", checkedAt: entry.checkedAt ?? "" };
    case ProtoPlatformStatus.UNCHECKED:
    default:
      return { status: "unchecked" };
  }
}

export function toProtoMediaDocument(doc: MediaDocument): ProtoMediaDocument {
  const platformStatuses: Record<string, ProtoPlatformStatusEntry> = {};
  if (doc.platformStatuses) {
    for (const [ns, entry] of Object.entries(doc.platformStatuses)) {
      if (entry) {
        platformStatuses[ns] = toProtoPlatformStatusEntry(entry);
      }
    }
  }

  return create(MediaDocumentSchema, {
    media: create(MediaSchema, {
      id: doc.media.id,
      type: toProtoMediaType(doc.media.type),
      ...(doc.media.baseline !== null ? { baseline: doc.media.baseline } : {}),
      snapshot: create(MediaSnapshotSchema, {
        title: doc.media.snapshot.title,
        ...(doc.media.snapshot.originalTitle !== null
          ? { originalTitle: doc.media.snapshot.originalTitle }
          : {}),
        ...(doc.media.snapshot.year !== null ? { year: doc.media.snapshot.year } : {}),
        type: toProtoMediaType(doc.media.snapshot.type),
        seasons: doc.media.snapshot.seasons.map((s) =>
          create(SeasonSnapshotSchema, {
            season: s.season,
            episodeCount: s.episodeCount,
            ...(s.airYear !== null ? { airYear: s.airYear } : {}),
          }),
        ),
      }),
    }),
    externalIds: doc.externalIds.map((ext) =>
      create(ExternalIdSchema, {
        namespace: ext.namespace,
        nativeId: ext.nativeId,
        ...(ext.locked !== undefined ? { locked: ext.locked } : {}),
      }),
    ),
    variants: doc.variants.map((variant) =>
      create(VariantSchema, {
        id: variant.id,
        ...(variant.mediaId !== undefined ? { mediaId: variant.mediaId } : {}),
        namespace: variant.namespace,
        label: variant.label,
        isDefault: variant.isDefault,
        ...(variant.unconfirmed !== undefined ? { unconfirmed: variant.unconfirmed } : {}),
      }),
    ),
    associations: doc.associations.map((assoc) =>
      create(AssociationSchema, {
        id: assoc.id,
        ...(assoc.mediaId !== undefined ? { mediaId: assoc.mediaId } : {}),
        namespace: assoc.namespace,
        nativeId: assoc.nativeId,
        ...(assoc.variantId !== null ? { variantId: assoc.variantId } : {}),
        status: toProtoAssociationStatus(assoc.status),
        segments: assoc.segments.map(toProtoSegment),
        ...(assoc.needsReview !== undefined ? { needsReview: assoc.needsReview } : {}),
        ...(assoc.locked !== undefined ? { locked: assoc.locked } : {}),
        ...(assoc.unconfirmed !== undefined ? { unconfirmed: assoc.unconfirmed } : {}),
        ...(assoc.unconfirmedSource !== undefined
          ? { unconfirmedSource: toProtoUnconfirmedSource(assoc.unconfirmedSource) }
          : {}),
        ...(assoc.changeRequestId !== undefined ? { changeRequestId: assoc.changeRequestId } : {}),
        ...(assoc.changeRequestStatus !== undefined
          ? { changeRequestStatus: toProtoChangeRequestStatus(assoc.changeRequestStatus) }
          : {}),
        ...(assoc.title !== undefined ? { title: assoc.title } : {}),
        ...(assoc.episodeCount !== undefined ? { episodeCount: assoc.episodeCount } : {}),
      }),
    ),
    matchedAssociationIds: doc.matchedAssociationIds ? [...doc.matchedAssociationIds] : [],
    platformStatuses,
  });
}

export function fromProtoMediaDocument(proto: ProtoMediaDocument): MediaDocument {
  const protoMedia: ProtoMedia | undefined = proto.media;
  const protoSnapshot: ProtoMediaSnapshot | undefined = protoMedia?.snapshot;

  const seasons: SeasonSnapshot[] = (protoSnapshot?.seasons ?? []).map(
    (s: ProtoSeasonSnapshot) => ({
      season: s.season,
      episodeCount: s.episodeCount,
      airYear: s.airYear ?? null,
    }),
  );

  const snapshot: MediaSnapshot = {
    title: protoSnapshot?.title ?? "",
    originalTitle: protoSnapshot?.originalTitle ?? null,
    year: protoSnapshot?.year ?? null,
    type: fromProtoMediaType(protoSnapshot?.type ?? ProtoMediaType.TV),
    seasons,
  };

  const media: Media = {
    id: protoMedia?.id ?? "",
    type: fromProtoMediaType(protoMedia?.type ?? ProtoMediaType.TV),
    baseline: (protoMedia?.baseline as BaselineSource | undefined) ?? null,
    snapshot,
  };

  const externalIds: ExternalId[] = proto.externalIds.map((ext: ProtoExternalId) => ({
    namespace: ext.namespace as ExternalIdNamespace,
    nativeId: ext.nativeId,
    ...(ext.locked !== undefined ? { locked: ext.locked } : {}),
  }));

  const variants: Variant[] = proto.variants.map((v: ProtoVariant) => ({
    id: v.id,
    ...(v.mediaId !== undefined ? { mediaId: v.mediaId } : {}),
    namespace: v.namespace as PlatformNamespace,
    label: v.label,
    isDefault: v.isDefault,
    ...(v.unconfirmed !== undefined ? { unconfirmed: v.unconfirmed } : {}),
  }));

  const associations: Association[] = proto.associations.map((a: ProtoAssociation) => {
    const crStatus =
      a.changeRequestStatus !== undefined
        ? fromProtoChangeRequestStatus(a.changeRequestStatus)
        : undefined;
    const unconfirmedSource =
      a.unconfirmedSource !== undefined
        ? fromProtoUnconfirmedSource(a.unconfirmedSource)
        : undefined;

    return {
      id: a.id,
      ...(a.mediaId !== undefined ? { mediaId: a.mediaId } : {}),
      namespace: a.namespace as Namespace,
      nativeId: a.nativeId,
      variantId: a.variantId ?? null,
      status: fromProtoAssociationStatus(a.status),
      segments: a.segments.map((s) => ({
        season: s.season,
        episodeStart: s.episodeStart,
        episodeEnd: s.episodeEnd ?? null,
        targetEpisodeStart: s.targetEpisodeStart,
        baseline: s.baseline as BaselineSource,
        ...(s.nonLinear ? { nonLinear: true } : {}),
        ...(s.needsReview ? { needsReview: true } : {}),
      })),
      ...(a.needsReview !== undefined ? { needsReview: a.needsReview } : {}),
      ...(a.locked !== undefined ? { locked: a.locked } : {}),
      ...(a.unconfirmed !== undefined ? { unconfirmed: a.unconfirmed } : {}),
      ...(unconfirmedSource !== undefined ? { unconfirmedSource } : {}),
      ...(a.changeRequestId !== undefined ? { changeRequestId: a.changeRequestId } : {}),
      ...(crStatus === "pending_evidence" || crStatus === "needs_review"
        ? { changeRequestStatus: crStatus }
        : {}),
      ...(a.title !== undefined ? { title: a.title } : {}),
      ...(a.episodeCount !== undefined ? { episodeCount: a.episodeCount } : {}),
    };
  });

  const platformStatuses: Partial<Record<PlatformNamespace, PlatformStatusEntry>> = {};
  for (const [ns, entry] of Object.entries(proto.platformStatuses)) {
    if (isPlatformNamespace(ns)) {
      platformStatuses[ns] = fromProtoPlatformStatusEntry(entry);
    }
  }

  return {
    media,
    externalIds,
    variants,
    associations,
    matchedAssociationIds: [...proto.matchedAssociationIds],
    ...(Object.keys(platformStatuses).length > 0 ? { platformStatuses } : {}),
  };
}

export function toProtoMediaQueryItem(item: {
  document: MediaDocument;
  matchedAssociationId: string | null;
}): ProtoMediaQueryItem {
  return create(MediaQueryItemSchema, {
    document: toProtoMediaDocument(item.document),
    ...(item.matchedAssociationId !== null
      ? { matchedAssociationId: item.matchedAssociationId }
      : {}),
  });
}

export function fromProtoMediaQueryItem(item: ProtoMediaQueryItem): {
  document: MediaDocument;
  matchedAssociationId: string | null;
} {
  return {
    document: fromProtoMediaDocument(item.document ?? create(MediaDocumentSchema)),
    matchedAssociationId: item.matchedAssociationId ?? null,
  };
}

export function toProtoBatchItemResult(
  entry:
    | {
        ref: MediaRef | ProtoMediaRef | string;
        ok: true;
        items: Array<{ document: MediaDocument; matchedAssociationId: string | null }>;
      }
    | {
        ref: MediaRef | ProtoMediaRef | string;
        ok: false;
        error: "INVALID_KEY" | "NOT_FOUND";
        message: string;
      },
): ProtoBatchMediaItemResult {
  const protoRef = toProtoMediaRefFromInput(entry.ref) ?? create(MediaRefSchema);
  if (entry.ok) {
    return create(BatchMediaItemResultSchema, {
      ref: protoRef,
      outcome: {
        case: "success",
        value: create(BatchMediaItemSuccessSchema, {
          items: entry.items.map(toProtoMediaQueryItem),
        }),
      },
    });
  }

  return create(BatchMediaItemResultSchema, {
    ref: protoRef,
    outcome: {
      case: "error",
      value: create(BatchMediaItemErrorSchema, {
        code: entry.error,
        message: entry.message,
      }),
    },
  });
}

export function fromProtoBatchItemResult(entry: ProtoBatchMediaItemResult):
  | {
      ref: MediaRef | null;
      key: string;
      ok: true;
      items: Array<{ document: MediaDocument; matchedAssociationId: string | null }>;
    }
  | {
      ref: MediaRef | null;
      key: string;
      ok: false;
      error: "INVALID_KEY" | "NOT_FOUND";
      message: string;
    } {
  const decoded = fromProtoMediaRef(entry.ref);
  const ref = decoded.ok ? decoded.ref : null;
  const key = decoded.ok ? decoded.key : "";

  if (entry.outcome.case === "success") {
    return {
      ref,
      key,
      ok: true,
      items: entry.outcome.value.items.map(fromProtoMediaQueryItem),
    };
  }
  if (entry.outcome.case === "error") {
    return {
      ref,
      key,
      ok: false,
      error: entry.outcome.value.code === "INVALID_KEY" ? "INVALID_KEY" : "NOT_FOUND",
      message: entry.outcome.value.message,
    };
  }
  return {
    ref,
    key,
    ok: false,
    error: "NOT_FOUND",
    message: "Media not found",
  };
}

export function toOptionalJsonObject(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as JsonObject;
}
