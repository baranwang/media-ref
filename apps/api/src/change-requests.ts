import { create } from "@bufbuild/protobuf";
import {
  createDomainConnectError,
  fromProtoMediaRef,
  fromProtoSegmentInput,
  proto,
  type SegmentInput,
} from "@media-ref/client";
import {
  createChangeRequest,
  createChangeRequestComment,
  getChangeRequestById,
  isUuid,
  listChangeRequestComments,
  listChangeRequests,
} from "@media-ref/core";
import type { ServiceImpl } from "@connectrpc/connect";
import { extractApiKeyFromHeaders } from "./api-keys.ts";
import {
  getRuntime,
  requireSessionAuth,
  requireVerifiedUserAuth,
  resolveChangeRequestReaderAuth,
  resolveSubmitterAuth,
  rethrowDomainError,
} from "./context.ts";
import { toProtoChangeRequest } from "./proto-records.ts";

export const changeRequestServiceImpl: ServiceImpl<typeof proto.ChangeRequestService> = {
  async createChangeRequest(req, ctx) {
    const submitter = await resolveSubmitterAuth(ctx);
    const runtime = getRuntime(ctx);

    const decodedTarget = fromProtoMediaRef(req.target, { mode: "target" });
    if (!decodedTarget.ok) {
      throw createDomainConnectError({
        status: 400,
        code: "INVALID_TARGET_KEY",
        message: decodedTarget.message,
      });
    }

    const segments: SegmentInput[] = [];
    for (let i = 0; i < req.segments.length; i += 1) {
      const converted = fromProtoSegmentInput(req.segments[i]!);
      if (!converted) {
        throw createDomainConnectError({
          status: 400,
          code: "INVALID_SEGMENTS",
          message: `Segment at index ${i} must specify either whole_season or explicit kind`,
        });
      }
      segments.push(converted);
    }

    try {
      const changeRequest = await createChangeRequest(
        runtime.dbWrite,
        {
          submitterUserId: submitter.userId,
          submitterKeyId: submitter.keyId,
          submitterType: "human",
          taskId: req.taskId ?? null,
          targetExternalKey: decodedTarget.key,
          namespace: req.namespace,
          nativeId: req.nativeId,
          rawNativeId: req.rawNativeId,
          variantId: req.variantId ?? null,
          variantDescription: req.variantDescription ?? null,
          setDefaultVariant: req.setDefaultVariant,
          replacesAssociationId: req.replacesAssociationId ?? null,
          segments,
          submissionQuota: runtime.submissionQuota,
          now: runtime.hasCustomClock ? runtime.now() : undefined,
        },
        {
          adapterRegistry: runtime.adapterRegistry,
          outbound: runtime.outbound,
          now: runtime.hasCustomClock ? runtime.now() : undefined,
        },
      );

      if (submitter.keyId !== null) {
        runtime.usageRecorder?.record({
          userId: submitter.userId,
          keyId: submitter.keyId,
          event: "submitted",
        });
      }

      return create(proto.CreateChangeRequestResponseSchema, {
        changeRequest: toProtoChangeRequest(changeRequest),
      });
    } catch (error) {
      rethrowDomainError(error);
    }
  },

  async getChangeRequest(req, ctx) {
    await resolveChangeRequestReaderAuth(ctx);
    const runtime = getRuntime(ctx);

    const id = req.id.trim();
    if (!isUuid(id)) {
      throw createDomainConnectError({
        status: 400,
        code: "INVALID_CHANGE_REQUEST_ID",
        message: "Change request ID must be a valid UUID",
      });
    }

    const changeRequest = await getChangeRequestById(runtime.dbWrite, id);
    if (!changeRequest) {
      throw createDomainConnectError({
        status: 404,
        code: "CHANGE_REQUEST_NOT_FOUND",
        message: "Change request not found",
      });
    }

    return create(proto.GetChangeRequestResponseSchema, {
      changeRequest: toProtoChangeRequest(changeRequest),
    });
  },

  async createChangeRequestComment(req, ctx) {
    // People comment; API callers submit and report instead (ADR 0003 amendment 2).
    if (extractApiKeyFromHeaders(ctx.requestHeader) !== null) {
      throw createDomainConnectError({
        status: 403,
        code: "API_KEY_NOT_ALLOWED",
        message: "Comments are written by signed-in users, not with an API key",
      });
    }
    const session = await requireVerifiedUserAuth(ctx);
    const runtime = getRuntime(ctx);
    try {
      const comment = await createChangeRequestComment(runtime.dbWrite, {
        changeRequestId: req.changeRequestId.trim(),
        authorUserId: session.user.id,
        content: req.content,
        now: runtime.hasCustomClock ? runtime.now() : undefined,
      });
      return create(proto.CreateChangeRequestCommentResponseSchema, {
        comment: create(proto.ChangeRequestCommentSchema, comment),
      });
    } catch (error) {
      rethrowDomainError(error);
    }
  },

  async listChangeRequestComments(req, ctx) {
    await resolveChangeRequestReaderAuth(ctx);
    const runtime = getRuntime(ctx);
    const comments = await listChangeRequestComments(runtime.dbWrite, req.changeRequestId.trim());
    return create(proto.ListChangeRequestCommentsResponseSchema, {
      comments: comments.map((c) => create(proto.ChangeRequestCommentSchema, c)),
    });
  },

  async listMyChangeRequests(req, ctx) {
    const session = await requireSessionAuth(ctx);
    const runtime = getRuntime(ctx);
    const listed = await listChangeRequests(runtime.dbWrite, {
      submitterUserId: session.user.id,
      limit: req.limit,
      offset: req.offset,
    });
    return create(proto.ListMyChangeRequestsResponseSchema, {
      changeRequests: listed.changeRequests.map(toProtoChangeRequest),
      total: listed.total,
    });
  },
};
