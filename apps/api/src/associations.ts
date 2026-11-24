import { create } from "@bufbuild/protobuf";
import { createDomainConnectError, fromProtoSortOrder, proto } from "@media-ref/client";
import { listAssociationRevisions, reportInvalidAssociation } from "@media-ref/core";
import type { ServiceImpl } from "@connectrpc/connect";
import {
  getRuntime,
  resolveAssociationHistoryReaderAuth,
  resolveInvalidationReporterAuth,
  rethrowDomainError,
} from "./context.ts";
import { toProtoAssociationRevision, toProtoAssociationSummary } from "./proto-records.ts";

export const associationServiceImpl: ServiceImpl<typeof proto.AssociationService> = {
  async reportInvalidation(req, ctx) {
    const reporter = await resolveInvalidationReporterAuth(ctx);
    const runtime = getRuntime(ctx);

    try {
      const result = await reportInvalidAssociation(runtime.dbWrite, {
        ...reporter,
        associationId: req.associationId,
        reason: req.reason ?? null,
        anonymousInvalidationThreshold: runtime.anonymousInvalidationThreshold,
        now: runtime.hasCustomClock ? runtime.now() : undefined,
      });

      return create(proto.ReportInvalidationResponseSchema, {
        reportId: result.reportId,
        deduplicated: result.deduplicated,
        triggered: result.triggered,
        ...(result.jobId !== null ? { jobId: result.jobId } : {}),
        reportCount: result.reportCount,
        threshold: result.threshold,
      });
    } catch (error) {
      rethrowDomainError(error);
    }
  },

  async listAssociationRevisions(req, ctx) {
    const { useReadDb } = await resolveAssociationHistoryReaderAuth(ctx);
    const runtime = getRuntime(ctx);

    if (
      req.order !== proto.SortOrder.UNSPECIFIED &&
      req.order !== proto.SortOrder.ASC &&
      req.order !== proto.SortOrder.DESC
    ) {
      throw createDomainConnectError({
        status: 400,
        code: "INVALID_ORDER",
        message: 'order must be either "asc" or "desc"',
      });
    }

    const limit = req.limit ?? 50;
    const offset = req.offset ?? 0;

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

    try {
      const db = useReadDb ? runtime.dbRead : runtime.dbWrite;
      const result = await listAssociationRevisions(db, req.associationId.trim(), {
        order: fromProtoSortOrder(req.order),
        limit,
        offset,
      });

      return create(proto.ListAssociationRevisionsResponseSchema, {
        association: toProtoAssociationSummary(result.association),
        revisions: result.revisions.map(toProtoAssociationRevision),
        total: result.total,
      });
    } catch (error) {
      rethrowDomainError(error);
    }
  },
};
