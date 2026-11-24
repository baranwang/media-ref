import { create } from "@bufbuild/protobuf";
import { createDomainConnectError, fromProtoMediaRef, proto, toProtoLead } from "@media-ref/client";
import { recordLead, type Lead } from "@media-ref/core";
import type { ServiceImpl } from "@connectrpc/connect";
import { getRuntime, requireApiKeyAuth, rethrowDomainError } from "./context.ts";

export interface LeadResponse {
  id: string;
  targetExternalKey: string;
  namespace: Lead["namespace"];
  nativeId: string;
  season: number | null;
  variantDescription: string | null;
  notes: string | null;
  createdAt: string;
}

export interface CreateLeadResponse {
  lead: LeadResponse;
}

function toLeadResponse(lead: Lead): LeadResponse {
  return {
    id: lead.id,
    targetExternalKey: lead.targetExternalKey,
    namespace: lead.namespace,
    nativeId: lead.nativeId,
    season: lead.season,
    variantDescription: lead.variantDescription,
    notes: lead.notes,
    createdAt: lead.createdAt.toISOString(),
  };
}

export const leadServiceImpl: ServiceImpl<typeof proto.LeadService> = {
  async createLead(req, ctx) {
    const verified = await requireApiKeyAuth(ctx, { db: "write", permission: "report" });
    const runtime = getRuntime(ctx);

    const decodedTarget = fromProtoMediaRef(req.target, { mode: "target" });
    if (!decodedTarget.ok) {
      throw createDomainConnectError({
        status: 400,
        code: "INVALID_EXTERNAL_KEY",
        message: decodedTarget.message,
      });
    }

    try {
      const lead = await recordLead(runtime.dbWrite, {
        targetExternalKey: decodedTarget.key,
        namespace: req.namespace,
        nativeId: req.nativeId,
        season: req.season ?? null,
        variantDescription: req.variantDescription ?? null,
        notes: req.notes ?? null,
        reporterUserId: verified.userId,
        reporterKeyId: verified.keyId,
      });

      const leadResponse = toLeadResponse(lead);
      return create(proto.CreateLeadResponseSchema, {
        lead: toProtoLead({
          ...leadResponse,
          target: leadResponse.targetExternalKey,
        }),
      });
    } catch (error) {
      rethrowDomainError(error);
    }
  },
};
