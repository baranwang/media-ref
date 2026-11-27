import {
  EXTERNAL_ID_NAMESPACES,
  formatExternalKey,
  type ExternalIdNamespace,
} from "@media-ref/client";
import type { Database } from "@media-ref/db";
import type { Transaction } from "kysely";

/** Report only keys confirmed on this media, including which ones this call inserted. */
export async function backfillMissingExternalIdsInTx(
  trx: Transaction<Database>,
  input: {
    mediaId: string;
    externalIds: Partial<Record<ExternalIdNamespace, string | null>>;
    requiredExistingKey?: string;
    now?: Date;
  },
): Promise<{ ownedKeys: string[]; insertedKeys: string[]; hasConflict: boolean }> {
  const candidates = EXTERNAL_ID_NAMESPACES.flatMap((namespace) => {
    const nativeId = input.externalIds[namespace];
    return nativeId ? [{ namespace, nativeId }] : [];
  });
  if (candidates.length === 0) {
    return {
      ownedKeys: [],
      insertedKeys: [],
      hasConflict: input.requiredExistingKey !== undefined,
    };
  }

  const rows = await trx
    .selectFrom("associations")
    .select(["media_id", "namespace", "native_id as nativeId", "is_external_id", "status"])
    .where(
      "namespace",
      "in",
      candidates.map((entry) => entry.namespace),
    )
    .where((eb) =>
      eb.or([
        eb.and({ media_id: input.mediaId, is_external_id: true }),
        ...candidates.map(({ namespace, nativeId }) => eb.and({ namespace, native_id: nativeId })),
      ]),
    )
    .orderBy("id")
    .forShare()
    .$narrowType<{ namespace: ExternalIdNamespace }>()
    .execute();
  const local = rows.filter((row) => row.media_id === input.mediaId);
  const ownedKeys = local
    .filter(
      (row) =>
        row.is_external_id &&
        row.status === "confirmed" &&
        row.nativeId === input.externalIds[row.namespace],
    )
    .map(formatExternalKey);
  // A regular association with the same key also occupies (media_id, namespace, native_id).
  const missing = candidates.filter(
    ({ namespace }) => !local.some((row) => row.namespace === namespace),
  );
  const hasConflict =
    (input.requiredExistingKey !== undefined && !ownedKeys.includes(input.requiredExistingKey)) ||
    local.some((row) => row.is_external_id && row.nativeId !== input.externalIds[row.namespace]) ||
    rows.some(
      (row) => row.media_id !== input.mediaId && (row.is_external_id || row.status === "confirmed"),
    );
  if (missing.length === 0 || hasConflict) {
    return { ownedKeys, insertedKeys: [], hasConflict };
  }

  // One insert makes a concurrent claim roll back the whole batch.
  const inserted = await trx
    .insertInto("associations")
    .values(
      missing.map(({ namespace, nativeId }) => ({
        media_id: input.mediaId,
        namespace,
        native_id: nativeId,
        status: "confirmed" as const,
        is_external_id: true,
        source: "sync" as const,
        ...(input.now ? { created_at: input.now, updated_at: input.now } : {}),
      })),
    )
    .returning(["namespace", "native_id as nativeId"])
    .execute();
  const insertedKeys = inserted.map(formatExternalKey);
  return { ownedKeys: [...ownedKeys, ...insertedKeys], insertedKeys, hasConflict: false };
}
