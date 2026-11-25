import { create } from "@bufbuild/protobuf";
import {
  createDomainConnectError,
  fromProtoMediaRef,
  fromProtoNamespaceGroup,
  isExternalIdNamespace,
  parseExternalKey,
  proto,
  toProtoBatchItemResult,
  toProtoMediaDocument,
  toProtoMediaQueryItem,
  toProtoMediaRef,
  type MediaDocument,
  type MediaRef,
  type NamespaceGroup,
} from "@media-ref/client";
import {
  computeDemandTargetsForBatchRead,
  computeDemandTargetsForRead,
  DEFAULT_DEMAND_NAMESPACE_GROUP,
  enqueueSeedEvidenceChecksForMedia,
  isAssociationNamespace,
  MAX_BATCH_MEDIA_KEYS,
  queryMediaBatch,
  queryMediaByKey,
  recordDemandForRead,
  recordDemandsForBatchRead,
  type BatchMediaQueryResult,
  type MediaQueryItem,
  type UnmatchedAssociationLookupKey,
} from "@media-ref/core";
import type { ServiceImpl } from "@connectrpc/connect";
import {
  authorizePublicRead,
  getRuntime,
  rethrowDomainError,
  scheduleBackgroundTask,
} from "./context.ts";

const MAX_SEASON_NUMBER = 2_147_483_647;

export interface MediaReadResponse {
  key: string;
  document: MediaDocument;
  matchedAssociationId: string | null;
  items: MediaQueryItem[];
}

export interface BatchMediaReadResponse {
  results: BatchMediaQueryResult[];
}

function validateSeasonParam(season: number | undefined): number | undefined {
  if (season === undefined) {
    return undefined;
  }
  if (!Number.isInteger(season) || season < 0 || season > MAX_SEASON_NUMBER) {
    throw createDomainConnectError({
      status: 400,
      code: "INVALID_QUERY",
      message: "season must be a non-negative integer",
    });
  }
  return season;
}

function resolveNamespaceGroupParam(group: proto.NamespaceGroup): NamespaceGroup {
  if (group === proto.NamespaceGroup.UNSPECIFIED) {
    return DEFAULT_DEMAND_NAMESPACE_GROUP;
  }
  const mapped = fromProtoNamespaceGroup(group);
  if (!mapped) {
    throw createDomainConnectError({
      status: 400,
      code: "INVALID_QUERY",
      message: "namespaceGroup must be either 'platform' or 'catalog'",
    });
  }
  return mapped;
}

export const mediaServiceImpl: ServiceImpl<typeof proto.MediaService> = {
  async getMedia(req, ctx) {
    const apiKey = await authorizePublicRead(ctx);

    const runtime = getRuntime(ctx);
    const season = validateSeasonParam(req.season);
    const namespaceGroup = resolveNamespaceGroupParam(req.namespaceGroup);
    const decoded = fromProtoMediaRef(req.ref, { mode: "read" });
    if (!decoded.ok) {
      throw createDomainConnectError({
        status: 400,
        code: "INVALID_KEY",
        message: decoded.message,
      });
    }
    const rawKey = decoded.key;

    const result = await queryMediaByKey(runtime.dbRead, rawKey, {
      includeUnconfirmed: req.includeUnconfirmed,
    });

    if (result.kind === "invalid_key") {
      throw createDomainConnectError({
        status: 400,
        code: "INVALID_KEY",
        message: result.message,
      });
    }

    const demandInput = {
      rawKey,
      queryResult: result,
      season,
      namespaceGroup,
    };
    if (computeDemandTargetsForRead(demandInput).length > 0) {
      const dbWrite = runtime.dbWrite;
      const now = runtime.now();
      scheduleBackgroundTask(runtime, () =>
        recordDemandForRead(dbWrite, {
          ...demandInput,
          now,
        }),
      );
    }

    if (apiKey) {
      runtime.usageRecorder?.record({
        userId: apiKey.userId,
        keyId: apiKey.keyId,
        event: result.kind === "not_found" ? "not_found" : "found",
      });
    }

    if (result.kind === "not_found") {
      const parsedMissingKey = parseExternalKey(rawKey);
      if (
        parsedMissingKey &&
        isAssociationNamespace(parsedMissingKey.namespace) &&
        !isExternalIdNamespace(parsedMissingKey.namespace)
      ) {
        const missingNamespace = parsedMissingKey.namespace;
        const missingNativeId = parsedMissingKey.nativeId;
        const dbWrite = runtime.dbWrite;
        const now = runtime.now();
        scheduleBackgroundTask(runtime, () =>
          enqueueSeedEvidenceChecksForMedia(dbWrite, [], {
            now,
            unmatchedAssociationKeys: [
              {
                namespace: missingNamespace,
                nativeId: missingNativeId,
              },
            ],
          }),
        );
      }
      throw createDomainConnectError({
        status: 404,
        code: "MEDIA_NOT_FOUND",
        message: "Media not found",
      });
    }

    const resolvedMediaIds = [...new Set(result.items.map((item) => item.document.media.id))];
    if (resolvedMediaIds.length > 0) {
      const dbWrite = runtime.dbWrite;
      const now = runtime.now();
      scheduleBackgroundTask(runtime, () =>
        enqueueSeedEvidenceChecksForMedia(dbWrite, resolvedMediaIds, { now }),
      );
    }

    const primary = result.items[0]!;
    return create(proto.GetMediaResponseSchema, {
      ref: toProtoMediaRef(decoded.ref),
      document: toProtoMediaDocument(primary.document),
      ...(primary.matchedAssociationId !== null
        ? { matchedAssociationId: primary.matchedAssociationId }
        : {}),
      items: result.items.map(toProtoMediaQueryItem),
    });
  },

  async batchGetMedia(req, ctx) {
    const apiKey = await authorizePublicRead(ctx);

    const runtime = getRuntime(ctx);
    if (req.refs.length === 0 || req.refs.length > MAX_BATCH_MEDIA_KEYS) {
      throw createDomainConnectError({
        status: 400,
        code: "BATCH_LIMIT_EXCEEDED",
        message: `refs must contain between 1 and ${MAX_BATCH_MEDIA_KEYS} items`,
      });
    }

    const season = validateSeasonParam(req.season);
    const namespaceGroup = resolveNamespaceGroupParam(req.namespaceGroup);

    const decodedEntries: Array<
      | { ok: true; index: number; ref: MediaRef; key: string }
      | { ok: false; index: number; rawRef: proto.MediaRef; message: string }
    > = [];
    const validKeys: string[] = [];

    for (let i = 0; i < req.refs.length; i += 1) {
      const rawRef = req.refs[i]!;
      const decoded = fromProtoMediaRef(rawRef, { mode: "read" });
      if (decoded.ok) {
        decodedEntries.push({ ok: true, index: i, ref: decoded.ref, key: decoded.key });
        validKeys.push(decoded.key);
      } else {
        decodedEntries.push({ ok: false, index: i, rawRef, message: decoded.message });
      }
    }

    try {
      const queryResults: BatchMediaQueryResult[] =
        validKeys.length > 0
          ? await queryMediaBatch(runtime.dbRead, {
              keys: validKeys,
              includeUnconfirmed: req.includeUnconfirmed,
            })
          : [];

      if (apiKey && queryResults.length > 0) {
        const found = queryResults.filter((entry) => entry.ok).length;
        const notFound = queryResults.filter((e) => !e.ok && e.error === "NOT_FOUND").length;
        const usage = { userId: apiKey.userId, keyId: apiKey.keyId };
        runtime.usageRecorder?.record({ ...usage, event: "found", count: found });
        runtime.usageRecorder?.record({ ...usage, event: "not_found", count: notFound });
      }

      if (queryResults.length > 0) {
        const batchDemandInput = {
          results: queryResults,
          season,
          namespaceGroup,
        };
        if (computeDemandTargetsForBatchRead(batchDemandInput).length > 0) {
          const dbWrite = runtime.dbWrite;
          const now = runtime.now();
          scheduleBackgroundTask(runtime, () =>
            recordDemandsForBatchRead(dbWrite, {
              ...batchDemandInput,
              now,
            }),
          );
        }

        const resolvedBatchMediaIds: string[] = [];
        const unmatchedBatchAssocKeys: UnmatchedAssociationLookupKey[] = [];
        for (const entry of queryResults) {
          if (entry.ok) {
            for (const item of entry.items) {
              resolvedBatchMediaIds.push(item.document.media.id);
            }
          } else if (entry.error === "NOT_FOUND") {
            const parsedKey = parseExternalKey(entry.key.trim());
            if (
              parsedKey &&
              isAssociationNamespace(parsedKey.namespace) &&
              !isExternalIdNamespace(parsedKey.namespace)
            ) {
              unmatchedBatchAssocKeys.push({
                namespace: parsedKey.namespace,
                nativeId: parsedKey.nativeId,
              });
            }
          }
        }
        if (resolvedBatchMediaIds.length > 0 || unmatchedBatchAssocKeys.length > 0) {
          const dbWrite = runtime.dbWrite;
          const now = runtime.now();
          scheduleBackgroundTask(runtime, () =>
            enqueueSeedEvidenceChecksForMedia(dbWrite, resolvedBatchMediaIds, {
              now,
              unmatchedAssociationKeys: unmatchedBatchAssocKeys,
            }),
          );
        }
      }

      const protoResults: proto.BatchMediaItemResult[] = [];
      let validCursor = 0;
      for (const entry of decodedEntries) {
        if (!entry.ok) {
          protoResults.push(
            toProtoBatchItemResult({
              ref: entry.rawRef,
              ok: false,
              error: "INVALID_KEY",
              message: entry.message,
            }),
          );
          continue;
        }
        const queryEntry = queryResults[validCursor++]!;
        if (queryEntry.ok) {
          protoResults.push(
            toProtoBatchItemResult({
              ref: entry.ref,
              ok: true,
              items: queryEntry.items,
            }),
          );
        } else {
          protoResults.push(
            toProtoBatchItemResult({
              ref: entry.ref,
              ok: false,
              error: queryEntry.error,
              message: queryEntry.message,
            }),
          );
        }
      }

      return create(proto.BatchGetMediaResponseSchema, {
        results: protoResults,
      });
    } catch (error) {
      rethrowDomainError(error);
    }
  },
};
