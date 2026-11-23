import type { Database } from "@media-ref/db";
import { sql, type Transaction } from "kysely";

export interface ReputationTier {
  minReputation: number;
  maxPerHour: number;
}

export interface SubmissionQuotaConfig {
  /** Base hourly submission limit for new accounts (reputation 0). Defaults to 5. */
  submitBaseHourlyLimit?: number;
  /** Rolling window duration in seconds. Defaults to 3600 (1 hour). */
  windowSeconds?: number;
  /**
   * Reputation tiers mapping contributor reputation to hourly submission limits.
   * Defaults to:
   *   [{ minReputation: 0, maxPerHour: 5 }, { minReputation: 10, maxPerHour: 20 }, { minReputation: 50, maxPerHour: 100 }]
   * Reputation ONLY affects hourly submission quota and NEVER affects Evidence Gate.
   */
  reputationTiers?: readonly ReputationTier[];
  /**
   * Minimum hourly submission limits by user role (e.g. reviewer, owner).
   * Defaults to `{ reviewer: 100, owner: 500 }`.
   */
  roleHourlyLimits?: Partial<Record<string, number>>;
}

export const DEFAULT_SUBMIT_BASE_HOURLY_LIMIT = 5;
export const DEFAULT_SUBMISSION_WINDOW_SECONDS = 3600;

export const DEFAULT_REPUTATION_TIERS: readonly ReputationTier[] = [
  { minReputation: 0, maxPerHour: 5 },
  { minReputation: 10, maxPerHour: 20 },
  { minReputation: 50, maxPerHour: 100 },
];

export const DEFAULT_ROLE_HOURLY_LIMITS: Readonly<Record<string, number>> = {
  reviewer: 100,
  owner: 500,
};

export interface SubmissionQuotaExceededParams {
  limit: number;
  used: number;
  windowSeconds: number;
  retryAfterSeconds: number;
  message?: string;
}

export class SubmissionQuotaExceededError extends Error {
  readonly code = "SUBMISSION_RATE_LIMITED" as const;
  readonly status = 429 as const;
  readonly scope = "account" as const;
  readonly limit: number;
  readonly used: number;
  readonly windowSeconds: number;
  readonly retryAfterSeconds: number;

  constructor(params: SubmissionQuotaExceededParams) {
    super(
      params.message ??
        `Hourly submission limit (${params.limit} per ${params.windowSeconds}s) exceeded; retry after ${params.retryAfterSeconds}s`,
    );
    this.name = "SubmissionQuotaExceededError";
    this.limit = params.limit;
    this.used = params.used;
    this.windowSeconds = params.windowSeconds;
    this.retryAfterSeconds = params.retryAfterSeconds;
  }
}

export function resolveEffectiveReputationTiers(config?: SubmissionQuotaConfig): ReputationTier[] {
  if (config?.reputationTiers && config.reputationTiers.length > 0) {
    return [...config.reputationTiers]
      .filter(
        (tier) =>
          Number.isFinite(tier.minReputation) &&
          Number.isFinite(tier.maxPerHour) &&
          tier.maxPerHour >= 0,
      )
      .map((tier) => ({
        minReputation: Math.floor(tier.minReputation),
        maxPerHour: Math.floor(tier.maxPerHour),
      }))
      .sort((a, b) => a.minReputation - b.minReputation);
  }

  const baseLimit =
    config?.submitBaseHourlyLimit !== undefined && Number.isFinite(config.submitBaseHourlyLimit)
      ? Math.max(0, Math.floor(config.submitBaseHourlyLimit))
      : DEFAULT_SUBMIT_BASE_HOURLY_LIMIT;

  return DEFAULT_REPUTATION_TIERS.map((tier) =>
    tier.minReputation === 0
      ? { minReputation: 0, maxPerHour: baseLimit }
      : {
          minReputation: tier.minReputation,
          maxPerHour: Math.max(tier.maxPerHour, baseLimit),
        },
  );
}

export function resolveHourlySubmissionLimit(input: {
  reputation: number;
  role?: string | null;
  config?: SubmissionQuotaConfig;
}): number {
  const tiers = resolveEffectiveReputationTiers(input.config);
  const fallbackBase =
    input.config?.submitBaseHourlyLimit !== undefined &&
    Number.isFinite(input.config.submitBaseHourlyLimit)
      ? Math.max(0, Math.floor(input.config.submitBaseHourlyLimit))
      : (tiers[0]?.maxPerHour ?? DEFAULT_SUBMIT_BASE_HOURLY_LIMIT);

  let limit = fallbackBase;
  for (const tier of tiers) {
    if (input.reputation >= tier.minReputation) {
      limit = tier.maxPerHour;
    } else {
      break;
    }
  }

  const roleLimits = input.config?.roleHourlyLimits ?? DEFAULT_ROLE_HOURLY_LIMITS;
  if (input.role && Object.prototype.hasOwnProperty.call(roleLimits, input.role)) {
    const roleLimit = roleLimits[input.role];
    if (typeof roleLimit === "number" && Number.isFinite(roleLimit)) {
      limit = Math.max(limit, Math.floor(roleLimit));
    }
  }

  return Math.max(0, Math.floor(limit));
}

export interface EnforceSubmissionQuotaInput {
  submitterUserId: string;
  config?: SubmissionQuotaConfig;
  now?: Date;
}

export interface SubmissionQuotaSnapshot {
  limit: number;
  used: number;
  windowSeconds: number;
  referenceNow: Date;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Enforces the rolling-window per-account submission quota inside the caller's PostgreSQL
 * transaction using an advisory transaction lock (`pg_advisory_xact_lock`).
 *
 * Must be executed inside the SAME transaction that inserts the new `change_requests` row so:
 * 1. Multiple API keys and browser sessions for the same account share one quota.
 * 2. Concurrent submissions from the same account serialize cleanly and cannot race past the limit.
 */
export async function enforceSubmissionQuotaInTx(
  trx: Transaction<Database>,
  input: EnforceSubmissionQuotaInput,
): Promise<SubmissionQuotaSnapshot> {
  const windowSeconds =
    input.config?.windowSeconds !== undefined &&
    Number.isFinite(input.config.windowSeconds) &&
    input.config.windowSeconds > 0
      ? Math.floor(input.config.windowSeconds)
      : DEFAULT_SUBMISSION_WINDOW_SECONDS;

  await sql`select pg_advisory_xact_lock(hashtext('submit-quota:' || ${input.submitterUserId}::text))`.execute(
    trx,
  );

  const userRow = await trx
    .selectFrom("user")
    .select(["reputation", "role"])
    .where("id", "=", input.submitterUserId)
    .executeTakeFirst();

  const limit = resolveHourlySubmissionLimit({
    reputation: userRow?.reputation ?? 0,
    role: userRow?.role ?? "user",
    config: input.config,
  });

  let recentCount: number;
  let oldestCreatedAt: Date | null;
  let referenceNow: Date;

  if (input.now) {
    referenceNow = input.now;
    const windowCutoff = new Date(referenceNow.getTime() - windowSeconds * 1000);
    const result = await sql<{
      recent_count: number;
      oldest_created_at: Date | string | null;
    }>`
      select
        count(*)::int as recent_count,
        min(created_at) as oldest_created_at
      from change_requests
      where submitter_user_id = ${input.submitterUserId}
        and created_at > ${windowCutoff}
    `.execute(trx);

    const row = result.rows[0];
    recentCount = Number(row?.recent_count ?? 0);
    oldestCreatedAt = row?.oldest_created_at ? toDate(row.oldest_created_at) : null;
  } else {
    const result = await sql<{
      recent_count: number;
      oldest_created_at: Date | string | null;
      db_now: Date | string;
    }>`
      select
        count(*)::int as recent_count,
        min(created_at) as oldest_created_at,
        now() as db_now
      from change_requests
      where submitter_user_id = ${input.submitterUserId}
        and created_at > now() - make_interval(secs => ${windowSeconds})
    `.execute(trx);

    const row = result.rows[0];
    recentCount = Number(row?.recent_count ?? 0);
    oldestCreatedAt = row?.oldest_created_at ? toDate(row.oldest_created_at) : null;
    referenceNow = row?.db_now ? toDate(row.db_now) : new Date();
  }

  if (recentCount >= limit) {
    let retryAfterSeconds = windowSeconds;
    if (oldestCreatedAt) {
      const slotOpensAtMs = oldestCreatedAt.getTime() + windowSeconds * 1000;
      const remainingMs = slotOpensAtMs - referenceNow.getTime();
      retryAfterSeconds = Math.min(windowSeconds, Math.max(1, Math.ceil(remainingMs / 1000)));
    }

    throw new SubmissionQuotaExceededError({
      limit,
      used: recentCount,
      windowSeconds,
      retryAfterSeconds,
    });
  }

  return {
    limit,
    used: recentCount,
    windowSeconds,
    referenceNow,
  };
}
