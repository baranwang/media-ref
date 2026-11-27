import type { AnalyticsSQLBinding, AnalyticsSQLParameter } from "@cloudflare/workers-types";

/**
 * Per-API-key usage for the website's usage chart. Events are written to a Workers Analytics
 * Engine dataset (`blob1` = event, `blob2` = key id, `double1` = count, `index1` = user id) and
 * queried directly through the Worker's Analytics SQL binding (`events.analyticsEngine.<dataset>`)
 * without managing an API token.
 */

export type UsageEvent = "found" | "not_found" | "submitted";

export const USAGE_DATASET = "media_ref_api_usage";
export const USAGE_SQL_DATASET = `events.analyticsEngine.${USAGE_DATASET}`;
export const DEFAULT_USAGE_DAYS = 14;
export const MAX_USAGE_DAYS = 90;

const DAY_MS = 86_400_000;
const DEFAULT_RETRY_DELAY_MS = 150;

export interface UsageRecorder {
  record(input: { userId: string; keyId: string; event: UsageEvent; count?: number }): void;
}

export interface UsageQueryRequest {
  query: string;
  params?: Readonly<Record<string, AnalyticsSQLParameter>>;
}

export interface UsageReader {
  /** Runs a parameterized Analytics SQL query scoped to the Worker's account. */
  query(request: UsageQueryRequest): Promise<Array<Record<string, unknown>>>;
}

interface AnalyticsEngineDataset {
  writeDataPoint(point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void;
}

export function createAnalyticsUsageRecorder(
  dataset: AnalyticsEngineDataset | undefined,
): UsageRecorder | undefined {
  if (!dataset) {
    return undefined;
  }
  return {
    record({ userId, keyId, event, count = 1 }) {
      if (count <= 0) return;
      dataset.writeDataPoint({ blobs: [event, keyId], doubles: [count], indexes: [userId] });
    },
  };
}

function isRetryableAnalyticsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "retryable" in error &&
    (error as { retryable?: unknown }).retryable === true
  );
}

export function createAnalyticsUsageReader(
  binding: AnalyticsSQLBinding | undefined,
  options?: { retryDelayMs?: number },
): UsageReader | undefined {
  if (!binding) {
    return undefined;
  }
  const retryDelayMs = options?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  return {
    async query(request) {
      try {
        const result = await binding.query(request);
        return result.data ?? [];
      } catch (error) {
        if (!isRetryableAnalyticsError(error)) {
          throw error;
        }
        if (retryDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
        const result = await binding.query(request);
        return result.data ?? [];
      }
    },
  };
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function parseAnalyticsTimestamp(raw: string): Date | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const normalized = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
  const hasTimeZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
  const at = new Date(hasTimeZone ? normalized : `${normalized}Z`);
  return Number.isNaN(at.getTime()) ? null : at;
}

export interface ApiUsageResult {
  days: Array<{ date: string; found: bigint; notFound: bigint; submitted: bigint }>;
  lastUsed: Array<{ keyId: string; lastUsedAt: string }>;
}

/**
 * Daily totals for the user's keys over the last `days` UTC days (oldest first, zero-filled),
 * plus each key's last use. Without a reader (e.g. unit tests without the binding) everything is
 * zero.
 */
export async function readApiUsage(
  reader: UsageReader | undefined,
  input: { userId: string; keyIds: readonly string[]; days: number; now: Date },
): Promise<ApiUsageResult> {
  const start = new Date(
    Date.UTC(input.now.getUTCFullYear(), input.now.getUTCMonth(), input.now.getUTCDate()),
  );
  start.setUTCDate(start.getUTCDate() - (input.days - 1));
  const buckets = new Map<string, { found: bigint; notFound: bigint; submitted: bigint }>();
  for (let i = 0; i < input.days; i += 1) {
    const day = new Date(start);
    day.setUTCDate(start.getUTCDate() + i);
    buckets.set(utcDay(day), { found: 0n, notFound: 0n, submitted: 0n });
  }

  const uniqueKeyIds = [...new Set(input.keyIds)];
  const lastUsed: ApiUsageResult["lastUsed"] = [];
  if (reader && uniqueKeyIds.length > 0) {
    const keyParams: Record<string, string> = {};
    const keyPlaceholders = uniqueKeyIds.map((keyId, index) => {
      const paramName = `k${index}`;
      keyParams[paramName] = keyId;
      return `$${paramName}`;
    });
    const where = `index1 = $userId AND blob2 IN (${keyPlaceholders.join(", ")})`;
    const dailyStart = start.toISOString();
    const retentionStart = new Date(input.now.getTime() - MAX_USAGE_DAYS * DAY_MS).toISOString();

    const [daily, last] = await Promise.all([
      reader.query({
        query:
          `SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day, blob1 AS event, ` +
          `SUM(double1) AS n FROM ${USAGE_SQL_DATASET} ` +
          `WHERE ${where} AND timestamp >= $start ` +
          `GROUP BY day, event`,
        params: { userId: input.userId, ...keyParams, start: dailyStart },
      }),
      reader.query({
        query:
          `SELECT blob2 AS key_id, APPROX_MAX(timestamp) AS last_used FROM ${USAGE_SQL_DATASET} ` +
          `WHERE ${where} AND timestamp >= $start ` +
          `GROUP BY key_id`,
        params: { userId: input.userId, ...keyParams, start: retentionStart },
      }),
    ]);
    for (const row of daily) {
      const bucket = buckets.get(String(row.day).slice(0, 10));
      const n = BigInt(Math.round(Number(row.n) || 0));
      if (!bucket) continue;
      if (row.event === "found") bucket.found += n;
      else if (row.event === "not_found") bucket.notFound += n;
      else if (row.event === "submitted") bucket.submitted += n;
    }
    for (const row of last) {
      if (typeof row.key_id === "string" && typeof row.last_used === "string") {
        const at = parseAnalyticsTimestamp(row.last_used);
        if (at) {
          lastUsed.push({ keyId: row.key_id, lastUsedAt: at.toISOString() });
        }
      }
    }
  }

  return {
    days: [...buckets].map(([date, counts]) => ({ date, ...counts })),
    lastUsed,
  };
}
