import { create } from "@bufbuild/protobuf";
import {
  createDomainConnectError,
  fromProtoChangeRequestStatus,
  fromProtoReviewAlertStatus,
  isBaselineSource,
  proto,
  type BaselineSource,
  type ChangeRequestStatus,
} from "@media-ref/client";
import {
  listChangeRequests,
  listNeedsReviewSegments,
  listReviewAlerts,
  mergeMedia,
  overrideMediaExternalId,
  resolveReviewAlert,
  setAssociationLock,
  setMediaExternalIdLock,
  switchMediaBaseline,
} from "@media-ref/core";
import type { ReviewAlertStatusRow } from "@media-ref/db";
import type { ServiceImpl } from "@connectrpc/connect";
import {
  getRuntime,
  requireOwnerAuth,
  requireReviewerAuth,
  rethrowDomainError,
} from "./context.ts";
import {
  toProtoAssociationSummary,
  toProtoChangeRequest,
  toProtoExternalIdRecord,
  toProtoNeedsReviewSegment,
  toProtoReviewAlert,
} from "./proto-records.ts";

function decidedByReviewAgent() {
  return createDomainConnectError({
    status: 409,
    code: "DECIDED_BY_REVIEW_AGENT",
    message: "变更单由证据门和审核 agent 判定，请留言",
  });
}

const ASSIGNABLE_ROLES = new Set(["user", "reviewer"]);

function validatePagination(
  limitRaw: number | undefined,
  offsetRaw: number | undefined,
): {
  limit: number;
  offset: number;
} {
  const limit = limitRaw ?? 50;
  const offset = offsetRaw ?? 0;

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw createDomainConnectError({
      status: 400,
      code: "INVALID_PAGINATION",
      message: "limit must be an integer between 1 and 100",
    });
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw createDomainConnectError({
      status: 400,
      code: "INVALID_PAGINATION",
      message: "offset must be an integer >= 0",
    });
  }

  return { limit, offset };
}

export const reviewerServiceImpl: ServiceImpl<typeof proto.ReviewerService> = {
  async listChangeRequests(req, ctx) {
    await requireReviewerAuth(ctx);
    const runtime = getRuntime(ctx);

    let status: ChangeRequestStatus = "needs_review";
    if (req.status !== proto.ChangeRequestStatus.UNSPECIFIED) {
      const mapped = fromProtoChangeRequestStatus(req.status);
      if (!mapped) {
        throw createDomainConnectError({
          status: 400,
          code: "INVALID_STATUS",
          message: `Unsupported change request status: ${String(req.status)}`,
        });
      }
      status = mapped;
    }

    const { limit, offset } = validatePagination(req.limit, req.offset);
    const reviewerUserId = req.reviewerUserId?.trim() || undefined;
    const listed = await listChangeRequests(runtime.dbWrite, {
      status,
      reviewerUserId,
      limit,
      offset,
    });

    return create(proto.ListChangeRequestsResponseSchema, {
      changeRequests: listed.changeRequests.map(toProtoChangeRequest),
      total: listed.total,
    });
  },

  // People no longer decide change requests (ADR 0003 amendment 2): they comment, and the review
  // agent verifies and acts. Reviewers keep their other tools.
  async approveChangeRequest(_req, ctx) {
    await requireReviewerAuth(ctx);
    throw decidedByReviewAgent();
  },

  async rejectChangeRequest(_req, ctx) {
    await requireReviewerAuth(ctx);
    throw decidedByReviewAgent();
  },

  async setAssociationLock(req, ctx) {
    await requireReviewerAuth(ctx);
    const runtime = getRuntime(ctx);

    try {
      const result = await setAssociationLock(runtime.dbWrite, {
        associationId: req.associationId.trim(),
        locked: req.locked ?? true,
        now: runtime.now(),
      });

      return create(proto.SetAssociationLockResponseSchema, {
        association: toProtoAssociationSummary(result.association),
        associationId: result.associationId,
        locked: result.locked,
      });
    } catch (error) {
      rethrowDomainError(error);
    }
  },

  async overrideMediaExternalId(req, ctx) {
    await requireReviewerAuth(ctx);
    const runtime = getRuntime(ctx);

    if (req.nativeId.trim().length === 0) {
      throw createDomainConnectError({
        status: 400,
        code: "INVALID_NATIVE_ID",
        message: "nativeId must be a non-empty string",
      });
    }

    try {
      const externalId = await overrideMediaExternalId(runtime.dbWrite, {
        mediaId: req.mediaId.trim(),
        namespace: req.namespace.trim(),
        nativeId: req.nativeId,
        locked: req.locked ?? true,
        now: runtime.now(),
      });

      return create(proto.OverrideMediaExternalIdResponseSchema, {
        externalId: toProtoExternalIdRecord(externalId),
      });
    } catch (error) {
      rethrowDomainError(error);
    }
  },

  async setMediaExternalIdLock(req, ctx) {
    await requireReviewerAuth(ctx);
    const runtime = getRuntime(ctx);

    try {
      const externalId = await setMediaExternalIdLock(runtime.dbWrite, {
        mediaId: req.mediaId.trim(),
        namespace: req.namespace.trim(),
        locked: req.locked,
        now: runtime.now(),
      });

      return create(proto.SetMediaExternalIdLockResponseSchema, {
        externalId: toProtoExternalIdRecord(externalId),
      });
    } catch (error) {
      rethrowDomainError(error);
    }
  },

  async mergeMedia(req, ctx) {
    const session = await requireReviewerAuth(ctx);
    const runtime = getRuntime(ctx);

    const sourceMediaId = req.sourceMediaId.trim();
    const targetMediaId = req.targetMediaId.trim();
    if (sourceMediaId.length === 0 || targetMediaId.length === 0) {
      throw createDomainConnectError({
        status: 400,
        code: "INVALID_REQUEST",
        message: "sourceMediaId and targetMediaId are required strings",
      });
    }

    try {
      const result = await mergeMedia(runtime.dbWrite, {
        sourceMediaId,
        targetMediaId,
        actorUserId: session.user.id,
        reason: req.reason ?? null,
        now: runtime.now(),
      });

      return create(proto.MergeMediaResponseSchema, {
        sourceMediaId: result.sourceMediaId,
        targetMediaId: result.targetMediaId,
        movedExternalIdCount: result.movedExternalIdCount,
        movedVariantCount: result.movedVariantCount,
        movedAssociationCount: result.movedAssociationCount,
        flaggedSegmentCount: result.flaggedSegmentCount,
        resolvedAlertCount: result.resolvedAlertCount,
        alreadyMerged: result.alreadyMerged,
      });
    } catch (error) {
      rethrowDomainError(error);
    }
  },

  async switchMediaBaseline(req, ctx) {
    const session = await requireReviewerAuth(ctx);
    const runtime = getRuntime(ctx);

    let newBaseline: BaselineSource | null = null;
    if (req.baseline !== undefined && req.baseline !== "") {
      if (!isBaselineSource(req.baseline)) {
        throw createDomainConnectError({
          status: 400,
          code: "INVALID_BASELINE",
          message: "baseline must be null or one of: tmdb, tvdb, imdb, bangumi, douban",
        });
      }
      newBaseline = req.baseline;
    }

    try {
      const result = await switchMediaBaseline(runtime.dbWrite, {
        mediaId: req.mediaId.trim(),
        newBaseline,
        actorUserId: session.user.id,
        reason: req.reason ?? null,
        now: runtime.now(),
      });

      return create(proto.SwitchMediaBaselineResponseSchema, {
        mediaId: result.mediaId,
        ...(result.previousBaseline !== null ? { previousBaseline: result.previousBaseline } : {}),
        ...(result.baseline !== null ? { baseline: result.baseline } : {}),
        flaggedSegmentCount: result.flaggedSegmentCount,
      });
    } catch (error) {
      rethrowDomainError(error);
    }
  },

  async listReviewAlerts(req, ctx) {
    await requireReviewerAuth(ctx);
    const runtime = getRuntime(ctx);

    let status: ReviewAlertStatusRow = "open";
    if (req.status !== proto.ReviewAlertStatus.UNSPECIFIED) {
      const mapped = fromProtoReviewAlertStatus(req.status);
      if (!mapped) {
        throw createDomainConnectError({
          status: 400,
          code: "INVALID_STATUS",
          message: `Unsupported alert status: ${String(req.status)}`,
        });
      }
      status = mapped;
    }

    const { limit, offset } = validatePagination(req.limit, req.offset);
    const alertType = req.alertType?.trim() || undefined;
    const mediaId = req.mediaId?.trim() || undefined;

    try {
      const result = await listReviewAlerts(runtime.dbWrite, {
        status,
        alertType,
        mediaId,
        limit,
        offset,
      });

      return create(proto.ListReviewAlertsResponseSchema, {
        alerts: result.alerts.map(toProtoReviewAlert),
        total: result.total,
      });
    } catch (error) {
      rethrowDomainError(error);
    }
  },

  async resolveReviewAlert(req, ctx) {
    const session = await requireReviewerAuth(ctx);
    const runtime = getRuntime(ctx);

    try {
      const alert = await resolveReviewAlert(runtime.dbWrite, {
        alertId: req.alertId.trim(),
        reviewerUserId: session.user.id,
        now: runtime.now(),
      });

      return create(proto.ResolveReviewAlertResponseSchema, {
        alert: toProtoReviewAlert(alert),
      });
    } catch (error) {
      rethrowDomainError(error);
    }
  },

  async listNeedsReviewSegments(req, ctx) {
    await requireReviewerAuth(ctx);
    const runtime = getRuntime(ctx);

    const mediaId = req.mediaId?.trim() || undefined;
    const { limit, offset } = validatePagination(req.limit, req.offset);

    try {
      const result = await listNeedsReviewSegments(runtime.dbWrite, {
        mediaId,
        limit,
        offset,
      });

      return create(proto.ListNeedsReviewSegmentsResponseSchema, {
        segments: result.segments.map(toProtoNeedsReviewSegment),
        total: result.total,
      });
    } catch (error) {
      rethrowDomainError(error);
    }
  },

  async setUserRole(req, ctx) {
    await requireOwnerAuth(ctx);
    const runtime = getRuntime(ctx);

    const targetUserId = req.userId.trim();
    if (targetUserId.length === 0) {
      throw createDomainConnectError({
        status: 400,
        code: "INVALID_USER_ID",
        message: "User ID is required",
      });
    }

    const role = req.role.trim();
    if (!ASSIGNABLE_ROLES.has(role)) {
      throw createDomainConnectError({
        status: 400,
        code: "INVALID_ROLE",
        message: 'role must be either "user" or "reviewer"',
      });
    }

    const updated = await runtime.dbWrite
      .updateTable("user")
      .set({ role, updatedAt: runtime.now() })
      .where("id", "=", targetUserId)
      .returning(["id", "email", "name", "role"])
      .executeTakeFirst();

    if (!updated) {
      throw createDomainConnectError({
        status: 404,
        code: "USER_NOT_FOUND",
        message: "User not found",
      });
    }

    return create(proto.SetUserRoleResponseSchema, {
      user: create(proto.UpdatedUserRoleSchema, {
        id: updated.id,
        email: updated.email,
        name: updated.name,
        role: updated.role ?? role,
      }),
    });
  },
};
