/**
 * Per-API-key usage for the website's usage chart. Events are written to a Workers Analytics
 * Engine dataset (blob1 = event, blob2 = key id, double1 = count, index1 = user id) and read
 * back with the Analytics Engine SQL API.
 */

export type UsageEvent = "found" | "not_found" | "submitted";

export const USAGE_DATASET = "media_ref_api_usage";
export const DEFAULT_USAGE_DAYS = 14;
export const MAX_USAGE_DAYS = 90;

export interface UsageRecorder {
  record(input: { userId: string; keyId: string; event: UsageEvent; count?: number }): void;
}

export interface UsageReader {
  /** Runs an Analytics Engine SQL query and returns its rows. */
  query(sql: string): Promise<Array<Record<string, unknown>>>;
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

export function createAnalyticsUsageReader(input: {
  accountId: string | undefined;
  apiToken: string | undefined;
  fetchImpl?: typeof fetch;
}): UsageReader | undefined {
  const { accountId, apiToken } = input;
  if (!accountId || !apiToken) {
    return undefined;
  }
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  return {
    async query(sql) {
      const res = await fetchImpl(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
        { method: "POST", headers: { authorization: `Bearer ${apiToken}` }, body: sql },
      );
      if (!res.ok) {
        throw new Error(`Analytics Engine SQL failed with status ${res.status}`);
      }
      const body = (await res.json()) as { data?: Array<Record<string, unknown>> };
      return body.data ?? [];
    },
  };
}

function sqlString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface ApiUsageResult {
  days: Array<{ date: string; found: bigint; notFound: bigint; submitted: bigint }>;
  lastUsed: Array<{ keyId: string; lastUsedAt: string }>;
}

/**
 * Daily totals for the user's keys over the last `days` UTC days (oldest first, zero-filled),
 * plus each key's last use. Without a reader (token not configured) everything is zero.
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

  const lastUsed: ApiUsageResult["lastUsed"] = [];
  if (reader && input.keyIds.length > 0) {
    const where = `index1 = ${sqlString(input.userId)} AND blob2 IN (${input.keyIds.map(sqlString).join(", ")})`;
    const [daily, last] = await Promise.all([
      reader.query(
        `SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day, blob1 AS event, ` +
          `SUM(_sample_interval * double1) AS n FROM ${USAGE_DATASET} ` +
          `WHERE ${where} AND timestamp >= toDateTime(${sqlString(start.toISOString().slice(0, 19).replace("T", " "))}) ` +
          `GROUP BY day, event`,
      ),
      reader.query(
        `SELECT blob2 AS key_id, MAX(timestamp) AS last_used FROM ${USAGE_DATASET} ` +
          `WHERE ${where} GROUP BY key_id`,
      ),
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
        const at = new Date(`${row.last_used.replace(" ", "T")}Z`);
        if (!Number.isNaN(at.getTime())) {
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
