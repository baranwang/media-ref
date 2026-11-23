import {
  BASELINE_PRIORITY,
  CATALOG_NAMESPACES,
  PLATFORM_NAMESPACES,
  isPlatformNamespace,
  parseExternalKey,
  type BaselineSource,
  type CatalogNamespace,
  type ChangeRequestStatus,
  type ExternalKey,
  type Namespace,
  type NormalizedSegment,
  type PlatformNamespace,
  type SegmentInput,
  type SegmentValidationError,
} from "@media-ref/client";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { ApiError, formatApiError, getApiBaseUrl } from "./api";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AssociationCatalogNamespace = Extract<CatalogNamespace, "douban" | "bangumi">;
export type AssociationNamespace = PlatformNamespace | AssociationCatalogNamespace;

export const ASSOCIATION_CATALOG_NAMESPACES: readonly AssociationCatalogNamespace[] =
  CATALOG_NAMESPACES.filter(
    (ns): ns is AssociationCatalogNamespace => ns === "douban" || ns === "bangumi",
  );

export const ASSOCIATION_NAMESPACES: readonly AssociationNamespace[] = [
  ...PLATFORM_NAMESPACES,
  ...ASSOCIATION_CATALOG_NAMESPACES,
];

export const PLATFORM_NAMESPACE_LABELS: Record<PlatformNamespace, string> = {
  tencent: "腾讯视频",
  iqiyi: "爱奇艺",
  youku: "优酷",
  bilibili: "B 站",
  mgtv: "芒果 TV",
};

export const CATALOG_NAMESPACE_LABELS: Record<CatalogNamespace, string> = {
  tmdb: "TMDB",
  douban: "豆瓣",
  imdb: "IMDb",
  tvdb: "TVDB",
  trakt: "Trakt",
  bangumi: "Bangumi",
};

export const NAMESPACE_LABELS: Record<Namespace, string> = {
  ...PLATFORM_NAMESPACE_LABELS,
  ...CATALOG_NAMESPACE_LABELS,
};

export const BASELINE_LABELS: Record<BaselineSource, string> = {
  tmdb: "TMDB（默认）",
  tvdb: "TVDB",
  imdb: "IMDb",
  bangumi: "Bangumi",
  douban: "豆瓣",
};

export const BASELINE_OPTIONS: ReadonlyArray<{ value: BaselineSource; label: string }> =
  BASELINE_PRIORITY.map((baseline) => ({
    value: baseline,
    label: BASELINE_LABELS[baseline],
  }));

export interface ChangeRequestStatusMeta {
  status: ChangeRequestStatus;
  label: string;
  tone: "info" | "ok" | "warn" | "danger";
  description: string;
}

export const CHANGE_REQUEST_STATUS_META: Record<ChangeRequestStatus, ChangeRequestStatusMeta> = {
  pending_evidence: {
    status: "pending_evidence",
    label: "待取证",
    tone: "info",
    description: "变更单已受理，等待后台任务向平台或目录取证并通过证据门判定。",
  },
  approved: {
    status: "approved",
    label: "已通过",
    tone: "ok",
    description: "变更单已通过审核或证据门，关联与新版本已写入生效。",
  },
  needs_review: {
    status: "needs_review",
    label: "转人工",
    tone: "warn",
    description: "变更单已转入审核员队列，等待审核员人工核对与裁决。",
  },
  rejected: {
    status: "rejected",
    label: "已驳回",
    tone: "danger",
    description: "变更单已被驳回，未生效；不会出现在默认读接口结果中。",
  },
};

export const CHANGE_REQUEST_STATUS_LIST: readonly ChangeRequestStatus[] = [
  "needs_review",
  "pending_evidence",
  "approved",
  "rejected",
];

export interface ChangeRequestRecord {
  id: string;
  status: ChangeRequestStatus;
  submitterUserId: string;
  submitterKeyId: string | null;
  submitterType: "human" | "agent";
  taskId: string | null;
  mediaId: string | null;
  targetExternalKey: string;
  namespace: AssociationNamespace;
  rawNativeId: string;
  nativeId: string;
  variantId: string | null;
  variantDescription: string | null;
  setDefaultVariant: boolean;
  segments: NormalizedSegment[];
  evidence: Record<string, unknown> | null;
  conflictReason: string | null;
  decisionReason: string | null;
  reviewerUserId: string | null;
  reviewedAt: string | null;
  appliedAssociationId: string | null;
  appliedRevisionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SubmitChangeRequestInput {
  targetExternalKey: string;
  namespace: AssociationNamespace;
  nativeId: string;
  rawNativeId?: string;
  variantId?: string | null;
  variantDescription?: string | null;
  setDefaultVariant?: boolean;
  segments?: SegmentInput[];
}

export interface ChangeRequestListResponse {
  changeRequests: ChangeRequestRecord[];
  total: number;
}

export interface ApproveChangeRequestResponse {
  changeRequest: ChangeRequestRecord;
  mediaId: string;
  associationId: string;
  revisionId: string;
}

export interface LockAssociationInput {
  locked?: boolean;
  reason?: string;
}

export interface LockAssociationResponse {
  associationId: string;
  locked: boolean;
}

export class ChangeRequestApiError extends ApiError {
  readonly details?: SegmentValidationError[];

  constructor(status: number, code: string, message: string, details?: SegmentValidationError[]) {
    super(status, code, message);
    this.name = "ChangeRequestApiError";
    this.details = details;
  }
}

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value.trim());
}

export function isAssociationNamespace(value: string): value is AssociationNamespace {
  return (
    isPlatformNamespace(value) ||
    ASSOCIATION_CATALOG_NAMESPACES.includes(value as AssociationCatalogNamespace)
  );
}

export type TargetMediaKeyValidation =
  | { valid: true; kind: "media_id"; mediaId: string; normalized: string }
  | { valid: true; kind: "external_key"; key: ExternalKey; normalized: string }
  | { valid: false; message: string };

export function validateTargetMediaKey(raw: string): TargetMediaKeyValidation {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { valid: false, message: "请填写目标媒体的外部键或媒体 UUID" };
  }

  if (isUuid(trimmed)) {
    return {
      valid: true,
      kind: "media_id",
      mediaId: trimmed,
      normalized: trimmed,
    };
  }

  if (trimmed.startsWith("media:")) {
    const candidateId = trimmed.slice("media:".length);
    if (isUuid(candidateId)) {
      return {
        valid: true,
        kind: "media_id",
        mediaId: candidateId,
        normalized: `media:${candidateId}`,
      };
    }
    return {
      valid: false,
      message: "media: 前缀后须填写合法的媒体 UUID",
    };
  }

  const parsed = parseExternalKey(trimmed);
  if (!parsed) {
    return {
      valid: false,
      message: "格式无效，请使用「命名空间:原生 ID」（例如 tmdb:tv:95479）或媒体 UUID",
    };
  }

  return {
    valid: true,
    kind: "external_key",
    key: parsed,
    normalized: `${parsed.namespace}:${parsed.nativeId}`,
  };
}

export function detectNamespaceFromUrl(raw: string): AssociationNamespace | null {
  const trimmed = raw.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return null;
  }

  let hostname: string;
  try {
    hostname = new URL(trimmed).hostname.toLowerCase();
  } catch {
    return null;
  }

  if (hostname === "v.qq.com" || hostname.endsWith(".v.qq.com") || hostname.endsWith("wetv.vip")) {
    return "tencent";
  }
  if (hostname === "iqiyi.com" || hostname.endsWith(".iqiyi.com") || hostname.endsWith(".iq.com")) {
    return "iqiyi";
  }
  if (hostname === "youku.com" || hostname.endsWith(".youku.com")) {
    return "youku";
  }
  if (hostname === "bilibili.com" || hostname.endsWith(".bilibili.com") || hostname === "b23.tv") {
    return "bilibili";
  }
  if (hostname === "mgtv.com" || hostname.endsWith(".mgtv.com")) {
    return "mgtv";
  }
  if (hostname === "douban.com" || hostname.endsWith(".douban.com")) {
    return "douban";
  }
  if (
    hostname === "bgm.tv" ||
    hostname.endsWith(".bgm.tv") ||
    hostname === "bangumi.tv" ||
    hostname.endsWith(".bangumi.tv") ||
    hostname === "chii.in" ||
    hostname.endsWith(".chii.in")
  ) {
    return "bangumi";
  }

  return null;
}

export function extractLinkedAssociationId(cr: ChangeRequestRecord): string | null {
  if (cr.appliedAssociationId && isUuid(cr.appliedAssociationId)) {
    return cr.appliedAssociationId;
  }

  if (cr.evidence && typeof cr.evidence === "object") {
    const candidates = [
      cr.evidence.associationId,
      cr.evidence.existingAssociationId,
      cr.evidence.conflictingAssociationId,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && isUuid(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) {
    return "—";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function formatSegmentValidationError(error: SegmentValidationError): string {
  const rowPrefix =
    typeof error.segmentIndex === "number" ? `第 ${error.segmentIndex + 1} 段：` : "";

  switch (error.code) {
    case "INVALID_SEASON":
      return `${rowPrefix}季号必须是大于等于 0 的整数（0 表示特别篇）`;
    case "INVALID_EPISODE_START":
      return `${rowPrefix}起始集号（起）必须是大于等于 1 的整数`;
    case "INVALID_EPISODE_END":
      return `${rowPrefix}结束集号（止）必须留空或填写大于等于 1 的整数`;
    case "EPISODE_END_BEFORE_START":
      return `${rowPrefix}结束集号（止）不能小于起始集号（起）`;
    case "INVALID_TARGET_EPISODE_START":
      return `${rowPrefix}对方起始集号必须是大于等于 1 的整数`;
    case "INVALID_BASELINE":
      return `${rowPrefix}请选择有效的基准编号来源`;
    case "BASELINE_REQUIRED_FOR_SEGMENTS":
      return "该媒体暂无基准编号，关联只能留空段（整部对整部）";
    case "OVERLAPPING_VARIANT_SEGMENTS": {
      const match = error.message.match(/season (\d+): \[([^\]]+)\] overlaps \[([^\]]+)\]/);
      if (match) {
        return `${rowPrefix}第 ${match[1]} 季存在重叠段（[${match[2]}] 与 [${match[3]}] 重叠），同一变体下不能覆盖相同的集`;
      }
      return `${rowPrefix}同一变体下存在重叠的段，请调整起止集号`;
    }
    case "CONFLICTING_WHOLE_MEDIA_ASSOCIATION":
      return "同一变体下「整部对整部（无段）」不能与其他关联共存";
    case "SHARED_COLLECTION_OPEN_ENDED_SEGMENT":
      return `${rowPrefix}被多部媒体共用的合集不能省略结束集号（止）`;
    case "SHARED_COLLECTION_NON_LINEAR_SEGMENT":
      return `${rowPrefix}被多部媒体共用的合集不能标记「集号不对应」`;
    case "SHARED_COLLECTION_WHOLE_MEDIA":
      return "被多部媒体共用的合集必须明确填写段，不能整部对整部";
    case "OVERLAPPING_SHARED_COLLECTION_TARGET_RANGE":
      return `${rowPrefix}共用合集上的对方集号区间与其他媒体发生重叠`;
    default:
      return `${rowPrefix}${error.message}`;
  }
}

export function formatChangeRequestApiError(
  error: unknown,
  fallback = "操作失败，请稍后重试",
): string {
  if (error instanceof ChangeRequestApiError) {
    if (error.details && error.details.length > 0) {
      return error.details.map(formatSegmentValidationError).join("；");
    }

    switch (error.code) {
      case "INVALID_TARGET_KEY":
        return "目标媒体外部键无效。若媒体尚未建档，请使用 TMDB 外部键（例如 tmdb:tv:95479 或 tmdb:movie:603）";
      case "INVALID_NAMESPACE":
        return "所选命名空间不支持作为关联提交";
      case "INVALID_NATIVE_ID":
        return "平台网址或原生 ID 无效，或无法换算为规范 ID";
      case "VARIANT_REQUIRED":
        return "平台关联必须指定已有变体 ID 或填写变体说明（如「原声」「中配」）";
      case "VARIANT_NOT_ALLOWED":
        return "目录关联（豆瓣 / Bangumi）不能指定变体";
      case "INVALID_VARIANT":
        return "指定的变体 ID 无效，或不属于当前媒体与平台";
      case "INVALID_SEGMENTS":
        return `段参数校验未通过：${error.message}`;
      case "SEGMENT_OVERLAP":
        return `段与同一变体或共用合集里已有的段发生重叠：${error.message}`;
      case "MEDIA_NOT_FOUND":
        return "未找到指定的媒体 ID，请检查媒体 UUID 或改用 TMDB 外部键";
      case "CHANGE_REQUEST_NOT_FOUND":
        return "未找到该变更单，请检查变更单编号";
      case "INVALID_CHANGE_REQUEST_ID":
        return "变更单编号格式无效（应为 UUID）";
      case "INVALID_CHANGE_REQUEST_STATE":
        return "该变更单当前状态不允许此操作，请刷新后重试";
      case "TMDB_MEDIA_NOT_FOUND":
        return "TMDB 上未找到对应的电影或剧集，无法自动建档";
      case "TMDB_UPSTREAM_ERROR":
        return "连接 TMDB 获取媒体信息失败，请稍后重试";
      case "FORBIDDEN":
        return "需要审核员权限才能执行此操作";
      case "RATE_LIMIT_EXCEEDED":
        return "提交过于频繁，已达到当前账号的小时提交上限，请稍后再试";
      default:
        break;
    }
  }

  return formatApiError(error, fallback);
}

interface RawErrorBody {
  error?: unknown;
  code?: unknown;
  message?: unknown;
  details?: unknown;
}

async function parseErrorResponse(response: Response): Promise<ChangeRequestApiError> {
  let code = `HTTP_${response.status}`;
  let message = response.statusText || "请求失败";
  let details: SegmentValidationError[] | undefined;

  try {
    const raw = (await response.json()) as RawErrorBody;
    if (typeof raw.error === "string" && raw.error.length > 0) {
      code = raw.error;
    } else if (typeof raw.code === "string" && raw.code.length > 0) {
      code = raw.code;
    }
    if (typeof raw.message === "string" && raw.message.length > 0) {
      message = raw.message;
    }
    if (Array.isArray(raw.details)) {
      details = raw.details as SegmentValidationError[];
    }
  } catch {
    // Non-JSON response; keep HTTP status fallback.
  }

  return new ChangeRequestApiError(response.status, code, message, details);
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  cookieHeader?: string;
  signal?: AbortSignal;
}

async function changeRequestFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers();
  headers.set("accept", "application/json");

  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  if (options.cookieHeader) {
    headers.set("cookie", options.cookieHeader);
  }

  let response: Response;
  try {
    response = await fetch(`${getApiBaseUrl()}${path}`, {
      method: options.method ?? "GET",
      headers,
      credentials: "include",
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });
  } catch {
    throw new ChangeRequestApiError(0, "NETWORK_ERROR", "无法连接到接口服务，请检查网络或稍后重试");
  }

  if (!response.ok) {
    throw await parseErrorResponse(response);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  if (!text) {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}

export async function submitChangeRequest(
  payload: SubmitChangeRequestInput,
): Promise<ChangeRequestRecord> {
  const isPlatform = isPlatformNamespace(payload.namespace);
  const trimmedNativeId = payload.nativeId.trim();
  const trimmedRawNativeId = (payload.rawNativeId ?? payload.nativeId).trim();

  const body: Record<string, unknown> = {
    targetExternalKey: payload.targetExternalKey.trim(),
    namespace: payload.namespace,
    nativeId: trimmedNativeId,
    rawNativeId: trimmedRawNativeId || trimmedNativeId,
    segments: payload.segments ?? [],
  };

  if (isPlatform) {
    const trimmedVariantId = payload.variantId?.trim() || null;
    const trimmedVariantDescription = payload.variantDescription?.trim() || null;
    if (trimmedVariantId) {
      body.variantId = trimmedVariantId;
    }
    if (trimmedVariantDescription) {
      body.variantDescription = trimmedVariantDescription;
    }
    body.setDefaultVariant = Boolean(payload.setDefaultVariant);
  }

  const result = await changeRequestFetch<{ changeRequest: ChangeRequestRecord }>(
    "/v1/change-requests",
    {
      method: "POST",
      body,
    },
  );
  return result.changeRequest;
}

export async function getChangeRequest(
  id: string,
  cookieHeader?: string,
): Promise<ChangeRequestRecord> {
  const result = await changeRequestFetch<{ changeRequest: ChangeRequestRecord }>(
    `/v1/change-requests/${encodeURIComponent(id.trim())}`,
    {
      method: "GET",
      cookieHeader,
    },
  );
  return result.changeRequest;
}

export async function listReviewerChangeRequests(
  status?: ChangeRequestStatus,
  cookieHeader?: string,
  pagination?: { limit?: number; offset?: number },
): Promise<ChangeRequestListResponse> {
  const params = new URLSearchParams();
  if (status) {
    params.set("status", status);
  }
  if (pagination?.limit !== undefined) {
    params.set("limit", String(pagination.limit));
  }
  if (pagination?.offset !== undefined) {
    params.set("offset", String(pagination.offset));
  }
  const query = params.toString();
  const path = query ? `/v1/reviewer/change-requests?${query}` : "/v1/reviewer/change-requests";

  return changeRequestFetch<ChangeRequestListResponse>(path, {
    method: "GET",
    cookieHeader,
  });
}

export async function approveChangeRequest(
  id: string,
  reason?: string,
): Promise<ApproveChangeRequestResponse> {
  const trimmedReason = reason?.trim();
  return changeRequestFetch<ApproveChangeRequestResponse>(
    `/v1/reviewer/change-requests/${encodeURIComponent(id.trim())}/approve`,
    {
      method: "POST",
      body: trimmedReason ? { reason: trimmedReason } : {},
    },
  );
}

export async function rejectChangeRequest(
  id: string,
  reason: string,
): Promise<ChangeRequestRecord> {
  const trimmedReason = reason.trim();
  const result = await changeRequestFetch<{ changeRequest: ChangeRequestRecord }>(
    `/v1/reviewer/change-requests/${encodeURIComponent(id.trim())}/reject`,
    {
      method: "POST",
      body: trimmedReason ? { reason: trimmedReason } : {},
    },
  );
  return result.changeRequest;
}

/**
 * Locks or unlocks an association via the reviewer lock endpoint (Ticket #12).
 * Gracefully translates HTTP 404 route-not-ready responses when #12 is not yet deployed.
 */
export async function lockAssociation(
  associationId: string,
  options: LockAssociationInput = {},
): Promise<LockAssociationResponse> {
  const trimmedId = associationId.trim();
  const locked = options.locked ?? true;
  const trimmedReason = options.reason?.trim();

  try {
    const raw = await changeRequestFetch<
      | {
          association?: { id?: string; locked?: boolean };
          associationId?: string;
          locked?: boolean;
        }
      | undefined
    >(`/v1/reviewer/associations/${encodeURIComponent(trimmedId)}/lock`, {
      method: "POST",
      body: {
        locked,
        ...(trimmedReason ? { reason: trimmedReason } : {}),
      },
    });
    return {
      associationId: raw?.association?.id ?? raw?.associationId ?? trimmedId,
      locked: raw?.association?.locked ?? raw?.locked ?? locked,
    };
  } catch (error) {
    if (error instanceof ChangeRequestApiError && error.status === 404) {
      if (error.code === "HTTP_404") {
        throw new ChangeRequestApiError(
          404,
          "LOCK_ENDPOINT_NOT_AVAILABLE",
          "服务端尚未启用关联锁定接口（待锁定功能上线后即可使用）",
        );
      }
    }
    throw error;
  }
}

export const fetchChangeRequest = createIsomorphicFn()
  .server(async (id: string): Promise<ChangeRequestRecord> => {
    const cookieHeader = getRequestHeader("cookie");
    return getChangeRequest(id, cookieHeader);
  })
  .client(async (id: string): Promise<ChangeRequestRecord> => {
    return getChangeRequest(id);
  });

export const fetchReviewerChangeRequests = createIsomorphicFn()
  .server(
    async (status: ChangeRequestStatus = "needs_review"): Promise<ChangeRequestListResponse> => {
      const cookieHeader = getRequestHeader("cookie");
      return listReviewerChangeRequests(status, cookieHeader);
    },
  )
  .client(
    async (status: ChangeRequestStatus = "needs_review"): Promise<ChangeRequestListResponse> => {
      return listReviewerChangeRequests(status);
    },
  );
