import type { ReputationTier, SubmissionQuotaConfig } from "@media-ref/core";

export const DEFAULT_READ_KEY_LIMIT = 120;
export const DEFAULT_READ_IP_LIMIT = 300;
export const DEFAULT_READ_PERIOD_SECONDS = 60;
export const DEFAULT_READ_RETRY_AFTER_SECONDS = 60;

/**
 * Matches Cloudflare Workers Rate Limiting API binding contract:
 * https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
 */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export type ReadRateLimitScope = "api_key" | "ip";

export interface ReadRateLimitConfig {
  /** Fallback per-API-key limit per `readPeriodSeconds` when no Cloudflare binding is supplied. */
  readKeyLimit?: number;
  /** Fallback per-IP limit per `readPeriodSeconds` when no Cloudflare binding is supplied. */
  readIpLimit?: number;
  /** Fixed window period in seconds for fallback in-memory limiters (10 or 60 to match CF). */
  readPeriodSeconds?: number;
  /** Retry-After seconds returned on 429 read rate-limit responses. Default: 60. */
  readRetryAfterSeconds?: number;
}

export interface RateLimitConfig extends ReadRateLimitConfig, SubmissionQuotaConfig {
  /** Alias for `windowSeconds` in `SubmissionQuotaConfig`. */
  submitWindowSeconds?: number;
}

export interface RateLimitEnvVars {
  RATE_LIMIT_READ_KEY_LIMIT?: string;
  RATE_LIMIT_READ_IP_LIMIT?: string;
  RATE_LIMIT_READ_PERIOD_SECONDS?: string;
  RATE_LIMIT_READ_RETRY_AFTER_SECONDS?: string;
  RATE_LIMIT_SUBMIT_BASE_HOURLY?: string;
  RATE_LIMIT_SUBMIT_WINDOW_SECONDS?: string;
  RATE_LIMIT_REPUTATION_TIERS?: string;
  RATE_LIMIT_ROLE_HOURLY_LIMITS?: string;
}

export type ReadRateLimitEnvVars = Pick<
  RateLimitEnvVars,
  | "RATE_LIMIT_READ_KEY_LIMIT"
  | "RATE_LIMIT_READ_IP_LIMIT"
  | "RATE_LIMIT_READ_PERIOD_SECONDS"
  | "RATE_LIMIT_READ_RETRY_AFTER_SECONDS"
>;

export interface ReadRateLimitRuntime {
  keyLimiter: RateLimitBinding;
  ipLimiter: RateLimitBinding;
  retryAfterSeconds: number;
}

export interface InMemoryRateLimiterOptions {
  limit: number;
  periodSeconds: number;
  now?: () => Date;
}

const MAX_IN_MEMORY_BUCKETS = 10_000;

export function createInMemoryRateLimiter(options: InMemoryRateLimiterOptions): RateLimitBinding {
  const maxRequests = Math.max(0, Math.floor(options.limit));
  const periodMs = Math.max(1, Math.floor(options.periodSeconds)) * 1000;
  const getNow = options.now ?? (() => new Date());
  const buckets = new Map<string, { windowId: number; count: number }>();

  return {
    async limit({ key }: { key: string }): Promise<{ success: boolean }> {
      const nowMs = getNow().getTime();
      const windowId = Math.floor(nowMs / periodMs);
      const existing = buckets.get(key);

      if (!existing || existing.windowId !== windowId) {
        if (buckets.size >= MAX_IN_MEMORY_BUCKETS) {
          for (const [bucketKey, entry] of buckets) {
            if (entry.windowId !== windowId) {
              buckets.delete(bucketKey);
            }
          }
        }

        if (maxRequests <= 0) {
          return { success: false };
        }

        buckets.set(key, { windowId, count: 1 });
        return { success: true };
      }

      if (existing.count >= maxRequests) {
        return { success: false };
      }

      existing.count += 1;
      return { success: true };
    },
  };
}

export function extractRequestClientIp(headers: Headers): string {
  return headers.get("cf-connecting-ip")?.trim() || "unknown";
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw || raw.trim() === "") {
    return undefined;
  }
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function parseNonNegativeInt(raw: string | undefined): number | undefined {
  if (!raw || raw.trim() === "") {
    return undefined;
  }
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
}

function parseReputationTiers(raw: string | undefined): ReputationTier[] | undefined {
  if (!raw || raw.trim() === "") {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return undefined;
    }
    const tiers: ReputationTier[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const record = entry as Record<string, unknown>;
      if (
        typeof record.minReputation === "number" &&
        Number.isFinite(record.minReputation) &&
        typeof record.maxPerHour === "number" &&
        Number.isFinite(record.maxPerHour) &&
        record.maxPerHour >= 0
      ) {
        tiers.push({
          minReputation: Math.floor(record.minReputation),
          maxPerHour: Math.floor(record.maxPerHour),
        });
      }
    }
    return tiers.length > 0 ? tiers : undefined;
  } catch {
    return undefined;
  }
}

function parseRoleHourlyLimits(raw: string | undefined): Record<string, number> | undefined {
  if (!raw || raw.trim() === "") {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const limits: Record<string, number> = {};
    for (const [role, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        limits[role] = Math.floor(value);
      }
    }
    return limits;
  } catch {
    return undefined;
  }
}

export function parseReadRateLimitConfigFromEnv(
  env: ReadRateLimitEnvVars,
): ReadRateLimitConfig | undefined {
  const readKeyLimit = parseNonNegativeInt(env.RATE_LIMIT_READ_KEY_LIMIT);
  const readIpLimit = parseNonNegativeInt(env.RATE_LIMIT_READ_IP_LIMIT);
  const readPeriodSeconds = parsePositiveInt(env.RATE_LIMIT_READ_PERIOD_SECONDS);
  const readRetryAfterSeconds = parsePositiveInt(env.RATE_LIMIT_READ_RETRY_AFTER_SECONDS);

  if (
    readKeyLimit === undefined &&
    readIpLimit === undefined &&
    readPeriodSeconds === undefined &&
    readRetryAfterSeconds === undefined
  ) {
    return undefined;
  }

  return {
    ...(readKeyLimit !== undefined ? { readKeyLimit } : {}),
    ...(readIpLimit !== undefined ? { readIpLimit } : {}),
    ...(readPeriodSeconds !== undefined ? { readPeriodSeconds } : {}),
    ...(readRetryAfterSeconds !== undefined ? { readRetryAfterSeconds } : {}),
  };
}

export function parseRateLimitConfigFromEnv(env: RateLimitEnvVars): RateLimitConfig | undefined {
  const readConfig = parseReadRateLimitConfigFromEnv(env);
  const submitBaseHourlyLimit = parseNonNegativeInt(env.RATE_LIMIT_SUBMIT_BASE_HOURLY);
  const windowSeconds = parsePositiveInt(env.RATE_LIMIT_SUBMIT_WINDOW_SECONDS);
  const reputationTiers = parseReputationTiers(env.RATE_LIMIT_REPUTATION_TIERS);
  const roleHourlyLimits = parseRoleHourlyLimits(env.RATE_LIMIT_ROLE_HOURLY_LIMITS);

  if (
    !readConfig &&
    submitBaseHourlyLimit === undefined &&
    windowSeconds === undefined &&
    reputationTiers === undefined &&
    roleHourlyLimits === undefined
  ) {
    return undefined;
  }

  return {
    ...readConfig,
    ...(submitBaseHourlyLimit !== undefined ? { submitBaseHourlyLimit } : {}),
    ...(windowSeconds !== undefined ? { windowSeconds } : {}),
    ...(reputationTiers !== undefined ? { reputationTiers } : {}),
    ...(roleHourlyLimits !== undefined ? { roleHourlyLimits } : {}),
  };
}

export function resolveSubmissionQuotaConfig(input: {
  rateLimits?: RateLimitConfig;
  submitBaseHourlyLimit?: number;
  submitWindowSeconds?: number;
  reputationTiers?: readonly ReputationTier[];
  roleHourlyLimits?: Partial<Record<string, number>>;
}): SubmissionQuotaConfig | undefined {
  const submitBaseHourlyLimit =
    input.submitBaseHourlyLimit ?? input.rateLimits?.submitBaseHourlyLimit;
  const windowSeconds =
    input.submitWindowSeconds ??
    input.rateLimits?.submitWindowSeconds ??
    input.rateLimits?.windowSeconds;
  const reputationTiers = input.reputationTiers ?? input.rateLimits?.reputationTiers;
  const roleHourlyLimits = input.roleHourlyLimits ?? input.rateLimits?.roleHourlyLimits;

  if (
    submitBaseHourlyLimit === undefined &&
    windowSeconds === undefined &&
    reputationTiers === undefined &&
    roleHourlyLimits === undefined
  ) {
    return undefined;
  }

  return {
    ...(submitBaseHourlyLimit !== undefined ? { submitBaseHourlyLimit } : {}),
    ...(windowSeconds !== undefined ? { windowSeconds } : {}),
    ...(reputationTiers !== undefined ? { reputationTiers } : {}),
    ...(roleHourlyLimits !== undefined ? { roleHourlyLimits } : {}),
  };
}

/** The read limits in effect: configured values, or the defaults. */
function resolveReadLimits(config: ReadRateLimitConfig | undefined): Required<ReadRateLimitConfig> {
  const positive = (value: number | undefined, fallback: number) =>
    value && value > 0 ? Math.floor(value) : fallback;
  const nonNegative = (value: number | undefined, fallback: number) =>
    value !== undefined ? Math.max(0, Math.floor(value)) : fallback;
  return {
    readPeriodSeconds: positive(config?.readPeriodSeconds, DEFAULT_READ_PERIOD_SECONDS),
    readRetryAfterSeconds: positive(
      config?.readRetryAfterSeconds,
      DEFAULT_READ_RETRY_AFTER_SECONDS,
    ),
    readKeyLimit: nonNegative(config?.readKeyLimit, DEFAULT_READ_KEY_LIMIT),
    readIpLimit: nonNegative(config?.readIpLimit, DEFAULT_READ_IP_LIMIT),
  };
}

const fallbackReadLimitersByConfig = new Map<string, ReadRateLimitRuntime>();

export function resolveModuleScopedReadRateLimitRuntime(input: {
  readKeyLimiter?: RateLimitBinding;
  readIpLimiter?: RateLimitBinding;
  config?: ReadRateLimitConfig;
}): ReadRateLimitRuntime {
  const { readPeriodSeconds, readRetryAfterSeconds, readKeyLimit, readIpLimit } = resolveReadLimits(
    input.config,
  );

  if (input.readKeyLimiter && input.readIpLimiter) {
    return {
      keyLimiter: input.readKeyLimiter,
      ipLimiter: input.readIpLimiter,
      retryAfterSeconds: readRetryAfterSeconds,
    };
  }

  const cacheKey = `${readKeyLimit}:${readIpLimit}:${readPeriodSeconds}:${readRetryAfterSeconds}`;
  let cached = fallbackReadLimitersByConfig.get(cacheKey);
  if (!cached) {
    cached = createReadRateLimitRuntime({ config: input.config });
    fallbackReadLimitersByConfig.set(cacheKey, cached);
  }

  return {
    keyLimiter: input.readKeyLimiter ?? cached.keyLimiter,
    ipLimiter: input.readIpLimiter ?? cached.ipLimiter,
    retryAfterSeconds: readRetryAfterSeconds,
  };
}

export function createReadRateLimitRuntime(input: {
  readKeyLimiter?: RateLimitBinding;
  readIpLimiter?: RateLimitBinding;
  config?: ReadRateLimitConfig;
  now?: () => Date;
}): ReadRateLimitRuntime {
  const { readPeriodSeconds, readRetryAfterSeconds, readKeyLimit, readIpLimit } = resolveReadLimits(
    input.config,
  );

  return {
    keyLimiter:
      input.readKeyLimiter ??
      createInMemoryRateLimiter({
        limit: readKeyLimit,
        periodSeconds: readPeriodSeconds,
        now: input.now,
      }),
    ipLimiter:
      input.readIpLimiter ??
      createInMemoryRateLimiter({
        limit: readIpLimit,
        periodSeconds: readPeriodSeconds,
        now: input.now,
      }),
    retryAfterSeconds: readRetryAfterSeconds,
  };
}

export type ReadRateLimitCheckResult =
  | { allowed: true }
  | {
      allowed: false;
      scope: ReadRateLimitScope;
      retryAfterSeconds: number;
      message: string;
    };

function ipBucket(headers: Headers): string {
  const ip = extractRequestClientIp(headers);
  if (!ip.includes(":")) return ip;
  try {
    // URL normalizes hex and dotted IPv4 tails; expand :: before taking the network prefix.
    const address = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
    const [left, right] = address.split("::");
    const words = left ? left.split(":") : [];
    if (right !== undefined) {
      const tail = right ? right.split(":") : [];
      words.push(...Array<string>(8 - words.length - tail.length).fill("0"), ...tail);
    }
    return `${words.slice(0, 4).join(":")}::/64`;
  } catch {
    return "unknown";
  }
}

export async function checkReadRateLimit(
  input: { runtime: ReadRateLimitRuntime } & ({ apiKeyId: string } | { headers: Headers }),
): Promise<ReadRateLimitCheckResult> {
  const { runtime } = input;
  const scope = "apiKeyId" in input ? "api_key" : "ip";
  const outcome =
    "apiKeyId" in input
      ? await runtime.keyLimiter.limit({ key: `read:key:${input.apiKeyId}` })
      : await runtime.ipLimiter.limit({ key: `read:ip:${ipBucket(input.headers)}` });
  return outcome.success
    ? { allowed: true }
    : {
        allowed: false,
        scope,
        retryAfterSeconds: runtime.retryAfterSeconds,
        message: `${scope === "ip" ? "IP" : "API key read"} rate limit exceeded; retry after ${runtime.retryAfterSeconds}s`,
      };
}
