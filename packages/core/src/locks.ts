import type { Database } from "@media-ref/db";
import { sql, type Transaction } from "kysely";

/**
 * Centralized registry of PostgreSQL transaction advisory lock classes
 * (`pg_advisory_xact_lock(lockClass::int4, hashtext(lockKey::text))`).
 *
 * Every advisory lock in the codebase MUST use a unique class constant from this registry
 * so unrelated domains can never accidentally serialize or collide on the same integer class.
 */
export const ADVISORY_LOCK_CLASSES = {
  MEDIA_KEY: 1001,
  MEDIA_NAMESPACE: 1002,
  VARIANT: 1003,
  COLLECTION: 1004,
  TASK_ID: 1005,
  EXTERNAL_ID_MEDIA: 1006,
  EXTERNAL_ID_KEY: 1007,
  MEDIA_MERGE: 1008,
  SUBMIT_QUOTA: 1009,
  INVALIDATION: 1010,
  REVIEW_CORRECTION: 1011,
} as const;

export type AdvisoryLockClass = (typeof ADVISORY_LOCK_CLASSES)[keyof typeof ADVISORY_LOCK_CLASSES];

export async function acquireAdvisoryLock(
  trx: Transaction<Database>,
  lockClass: AdvisoryLockClass,
  lockKey: string,
): Promise<void> {
  await sql`select pg_advisory_xact_lock(${lockClass}::int4, hashtext(${lockKey}::text))`.execute(
    trx,
  );
}
