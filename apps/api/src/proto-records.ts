import { create } from "@bufbuild/protobuf";
import {
  proto,
  toOptionalJsonObject,
  toProtoApiKeyAction,
  toProtoAssociationStatus,
  toProtoChangeRequestStatus,
  toProtoMediaRefFromKey,
  toProtoMediaType,
  toProtoReviewAlertStatus,
  toProtoSegment,
  toProtoSubmitterType,
} from "@media-ref/client";
import type {
  AssociationRevisionRecord,
  AssociationSummaryRecord,
  ChangeRequestRecord,
  ExternalIdRecord,
  NeedsReviewSegmentItem,
  ReviewAlertRecord,
} from "@media-ref/core";
import type { ApiKeySummary } from "./api-keys.ts";

export function toProtoChangeRequest(record: ChangeRequestRecord): proto.ChangeRequest {
  const evidence = toOptionalJsonObject(record.evidence);
  return create(proto.ChangeRequestSchema, {
    id: record.id,
    status: toProtoChangeRequestStatus(record.status),
    submitterUserId: record.submitterUserId,
    ...(record.submitterKeyId !== null ? { submitterKeyId: record.submitterKeyId } : {}),
    submitterType: toProtoSubmitterType(record.submitterType),
    ...(record.taskId !== null ? { taskId: record.taskId } : {}),
    ...(record.mediaId !== null ? { mediaId: record.mediaId } : {}),
    target: toProtoMediaRefFromKey(record.targetExternalKey) ?? create(proto.MediaRefSchema),
    namespace: record.namespace,
    rawNativeId: record.rawNativeId,
    nativeId: record.nativeId,
    ...(record.variantId !== null ? { variantId: record.variantId } : {}),
    ...(record.variantDescription !== null
      ? { variantDescription: record.variantDescription }
      : {}),
    setDefaultVariant: record.setDefaultVariant,
    segments: record.segments.map(toProtoSegment),
    ...(evidence !== undefined ? { evidence } : {}),
    ...(record.conflictReason !== null ? { conflictReason: record.conflictReason } : {}),
    ...(record.decisionReason !== null ? { decisionReason: record.decisionReason } : {}),
    ...(record.reviewerUserId !== null ? { reviewerUserId: record.reviewerUserId } : {}),
    ...(record.reviewedAt !== null ? { reviewedAt: record.reviewedAt } : {}),
    ...(record.appliedAssociationId !== null
      ? { appliedAssociationId: record.appliedAssociationId }
      : {}),
    ...(record.appliedRevisionId !== null ? { appliedRevisionId: record.appliedRevisionId } : {}),
    ...(record.replacesAssociationId !== null
      ? { replacesAssociationId: record.replacesAssociationId }
      : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function toProtoAssociationSummary(
  record: AssociationSummaryRecord,
): proto.AssociationSummary {
  return create(proto.AssociationSummarySchema, {
    id: record.id,
    mediaId: record.mediaId,
    namespace: record.namespace,
    nativeId: record.nativeId,
    ...(record.variantId !== null ? { variantId: record.variantId } : {}),
    status: toProtoAssociationStatus(record.status),
    needsReview: record.needsReview,
    locked: record.locked,
    ...(record.currentRevisionId !== null ? { currentRevisionId: record.currentRevisionId } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function toProtoAssociationRevision(
  record: AssociationRevisionRecord,
): proto.AssociationRevision {
  return create(proto.AssociationRevisionSchema, {
    id: record.id,
    associationId: record.associationId,
    revisionNumber: record.revisionNumber,
    ...(record.changeRequestId !== null ? { changeRequestId: record.changeRequestId } : {}),
    ...(record.variantId !== null ? { variantId: record.variantId } : {}),
    status: toProtoAssociationStatus(record.status),
    segments: record.segments.map(toProtoSegment),
    ...(record.actorUserId !== null ? { actorUserId: record.actorUserId } : {}),
    ...(record.submitterUserId !== null ? { submitterUserId: record.submitterUserId } : {}),
    ...(record.reviewerUserId !== null ? { reviewerUserId: record.reviewerUserId } : {}),
    ...(record.reason !== null ? { reason: record.reason } : {}),
    createdAt: record.createdAt,
  });
}

export function toProtoExternalIdRecord(record: ExternalIdRecord): proto.ExternalIdRecord {
  return create(proto.ExternalIdRecordSchema, {
    id: record.id,
    mediaId: record.mediaId,
    namespace: record.namespace,
    nativeId: record.nativeId,
    locked: record.locked,
    source: record.source,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function toProtoReviewAlert(record: ReviewAlertRecord): proto.ReviewAlert {
  return create(proto.ReviewAlertSchema, {
    id: record.id,
    alertType: record.alertType,
    ...(record.mediaId !== null ? { mediaId: record.mediaId } : {}),
    ...(record.associationId !== null ? { associationId: record.associationId } : {}),
    status: toProtoReviewAlertStatus(record.status),
    details: toOptionalJsonObject(record.details) ?? {},
    createdAt: record.createdAt,
    ...(record.resolvedAt !== null ? { resolvedAt: record.resolvedAt } : {}),
    ...(record.resolvedByUserId !== null ? { resolvedByUserId: record.resolvedByUserId } : {}),
  });
}

export function toProtoNeedsReviewSegment(
  record: NeedsReviewSegmentItem,
): proto.NeedsReviewSegment {
  return create(proto.NeedsReviewSegmentSchema, {
    segmentId: record.segmentId,
    associationId: record.associationId,
    mediaId: record.mediaId,
    mediaTitle: record.mediaTitle,
    mediaType: toProtoMediaType(record.mediaType),
    ...(record.mediaBaseline !== null ? { mediaBaseline: record.mediaBaseline } : {}),
    namespace: record.namespace,
    nativeId: record.nativeId,
    ...(record.variantId !== null ? { variantId: record.variantId } : {}),
    season: record.season,
    episodeStart: record.episodeStart,
    ...(record.episodeEnd !== null ? { episodeEnd: record.episodeEnd } : {}),
    targetEpisodeStart: record.targetEpisodeStart,
    baseline: record.baseline,
    nonLinear: record.nonLinear,
    needsReview: record.needsReview,
    updatedAt: record.updatedAt,
  });
}

export function toProtoApiKeySummary(summary: ApiKeySummary): proto.ApiKeySummary {
  return create(proto.ApiKeySummarySchema, {
    id: summary.id,
    ...(summary.name !== null ? { name: summary.name } : {}),
    ...(summary.prefix !== null ? { prefix: summary.prefix } : {}),
    ...(summary.start !== null ? { start: summary.start } : {}),
    enabled: summary.enabled,
    permissions: create(proto.ApiKeyPermissionsSchema, {
      media: summary.permissions.media.map(toProtoApiKeyAction),
    }),
    canSubmit: summary.canSubmit,
    createdAt: summary.createdAt,
    ...(summary.expiresAt !== null ? { expiresAt: summary.expiresAt } : {}),
  });
}
