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
  getChangeRequestById,
  isUuid,
  listChangeRequests,
} from "@media-ref/core";
import type { ServiceImpl } from "@connectrpc/connect";
import {
  getRuntime,
  requireSessionAuth,
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
