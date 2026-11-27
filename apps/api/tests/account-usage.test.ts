import type {
  AnalyticsSQLBinding,
  AnalyticsSQLQuery,
  ExecutionContext,
  Hyperdrive,
} from "@cloudflare/workers-types";
import { createFakeOutboundClient } from "@media-ref/core";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, describe, expect, test } from "vite-plus/test";
import worker, { type ApiWorkerEnv } from "../src/index.ts";
import { createApiApp } from "../src/lib.ts";
import {
  createAnalyticsUsageReader,
  parseAnalyticsTimestamp,
  readApiUsage,
  USAGE_SQL_DATASET,
  type UsageEvent,
  type UsageQueryRequest,
  type UsageReader,
} from "../src/usage.ts";
import {
  createRpcClients,
  expectRpcError,
  issueApiKeyRpc,
  mediaRef,
  signUpUser,
  TEST_BASE_URL,
} from "./rpc-helpers.ts";

const TEST_AUTH_SECRET = "test-account-usage-secret-0c9d-4e7f-a1b2-c3d4e5f60718293a4b5c";

describe("account: UpdateApiKey, ListMyChangeRequests, usage", () => {
  const handles: TestDbHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      await handles.pop()?.cleanup();
    }
  });

  async function setup(
    extra: Parameters<typeof createApiApp>[0] extends infer D ? Partial<D> : never = {},
  ) {
    const testDb = await createTestDb();
    handles.push(testDb);
    const outbound = createFakeOutboundClient();
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: { baseUrl: TEST_BASE_URL, authSecret: TEST_AUTH_SECRET },
      ...extra,
    });
    return { testDb, app, outbound };
  }

  test("UpdateApiKey renames and toggles submit, only on the owner's keys", async () => {
    const { app, outbound } = await setup();
    const owner = await signUpUser(app, outbound, {
      email: "owner@example.com",
      password: "pw-owner-12345",
      name: "Owner",
    });
    const other = await signUpUser(app, outbound, {
      email: "other@example.com",
      password: "pw-other-12345",
      name: "Other",
    });
    const key = await issueApiKeyRpc(app, owner.cookie, { name: "player", canSubmit: false });

    const rpc = createRpcClients(app, { cookie: owner.cookie });
    const renamed = await rpc.account.updateApiKey({
      id: key.id,
      name: "  家里的 Jellyfin  ",
      canSubmit: true,
    });
    expect(renamed.apiKey).toMatchObject({ id: key.id, name: "家里的 Jellyfin", canSubmit: true });

    const listed = await rpc.account.listApiKeys({});
    expect(listed.apiKeys.find((k) => k.id === key.id)).toMatchObject({
      name: "家里的 Jellyfin",
      canSubmit: true,
    });

    const foreign = await expectRpcError(
      createRpcClients(app, { cookie: other.cookie }).account.updateApiKey({
        id: key.id,
        name: "stolen",
      }),
    );
    expect(foreign.code).toBe("API_KEY_NOT_FOUND");

    const blank = await expectRpcError(rpc.account.updateApiKey({ id: key.id, name: "   " }));
    expect(blank.code).toBe("INVALID_NAME");
  });

  test("UpdateApiKey refuses to grant submit to an unverified user", async () => {
    const { testDb, app, outbound } = await setup();
    const user = await signUpUser(app, outbound, {
      email: "unverified@example.com",
      password: "pw-unver-12345",
      name: "U",
    });
    const key = await issueApiKeyRpc(app, user.cookie, { name: "k", canSubmit: false });
    await testDb.writeDb
      .updateTable("user")
      .set({ emailVerified: false })
      .where("id", "=", user.userId)
      .execute();

    const err = await expectRpcError(
      createRpcClients(app, { cookie: user.cookie }).account.updateApiKey({
        id: key.id,
        canSubmit: true,
      }),
    );
    expect(err.code).toBe("EMAIL_NOT_VERIFIED");
  });

  test("ListMyChangeRequests returns only the caller's requests, newest first", async () => {
    const { testDb, app, outbound } = await setup();
    const me = await signUpUser(app, outbound, {
      email: "me@example.com",
      password: "pw-me-1234567",
      name: "Me",
    });
    const them = await signUpUser(app, outbound, {
      email: "them@example.com",
      password: "pw-them-123456",
      name: "Them",
    });
    const base = {
      status: "needs_review" as const,
      target_external_key: "tmdb:tv:1",
      namespace: "bilibili" as const,
      raw_native_id: "ss1",
      native_id: "ss1",
      segments: JSON.stringify([]),
    };
    await testDb.writeDb
      .insertInto("change_requests")
      .values([
        { ...base, submitter_user_id: me.userId, created_at: new Date("2026-11-01T00:00:00Z") },
        {
          ...base,
          submitter_user_id: me.userId,
          native_id: "ss2",
          created_at: new Date("2026-11-02T00:00:00Z"),
        },
        { ...base, submitter_user_id: them.userId, native_id: "ss3" },
      ])
      .execute();

    const res = await createRpcClients(app, {
      cookie: me.cookie,
    }).changeRequest.listMyChangeRequests({});
    expect(res.total).toBe(2);
    expect(res.changeRequests.map((cr) => cr.nativeId)).toEqual(["ss2", "ss1"]);

    const anon = await expectRpcError(createRpcClients(app).changeRequest.listMyChangeRequests({}));
    expect(anon.code).toBe("UNAUTHORIZED");
  });

  test("keyed GetMedia reads are recorded per key as found / not found", async () => {
    const events: Array<{ keyId: string; event: UsageEvent; count?: number }> = [];
    const { app, outbound } = await setup({
      usageRecorder: {
        record: (e) => events.push({ keyId: e.keyId, event: e.event, count: e.count }),
      },
    });
    const user = await signUpUser(app, outbound, {
      email: "reader@example.com",
      password: "pw-reader-1234",
      name: "R",
    });
    const key = await issueApiKeyRpc(app, user.cookie, { name: "reader" });

    const keyed = createRpcClients(app, { apiKey: key.key });
    await expectRpcError(keyed.media.getMedia({ ref: mediaRef("tmdb:tv:1") }));
    expect(events).toEqual([{ keyId: key.id, event: "not_found", count: undefined }]);
  });

  test("worker.fetch records to API_USAGE and queries GetApiUsage via ANALYTICS_SQL without tokens", async () => {
    const { testDb, app, outbound } = await setup();
    const user = await signUpUser(app, outbound, {
      email: "worker-usage@example.com",
      password: "pw-worker-12345",
      name: "Worker Usage",
    });
    const key = await issueApiKeyRpc(app, user.cookie, { name: "Danmu Universal" });

    const writtenPoints: Array<{
      blobs?: string[];
      doubles?: number[];
      indexes?: string[];
      timestamp: string;
    }> = [];
    const executedQueries: AnalyticsSQLQuery[] = [];
    const waitUntilPromises: Promise<unknown>[] = [];

    const analyticsSql: AnalyticsSQLBinding = {
      async query<T extends Record<string, unknown>>(request: AnalyticsSQLQuery) {
        executedQueries.push(request);
        const params = (request.params ?? {}) as Record<string, unknown>;
        const userId = params.userId;
        const keyIds = new Set(
          Object.entries(params)
            .filter(([name]) => name.startsWith("k"))
            .map(([, value]) => value),
        );
        const matching = writtenPoints.filter(
          (point) => point.indexes?.[0] === userId && keyIds.has(point.blobs?.[1]),
        );

        if (request.query.includes("APPROX_MAX(timestamp)")) {
          const latestByKey = new Map<string, string>();
          for (const point of matching) {
            const keyId = point.blobs?.[1];
            if (!keyId) continue;
            const prev = latestByKey.get(keyId);
            if (!prev || point.timestamp > prev) {
              latestByKey.set(keyId, point.timestamp);
            }
          }
          const rows = [...latestByKey.entries()].map(([key_id, last_used]) => ({
            key_id,
            last_used,
          }));
          return {
            data: rows as unknown as T[],
            rows: rows.length,
            statistics: { elapsed_ms: 1, rows_read: rows.length, bytes_read: 64 },
          };
        }

        const counts = new Map<string, number>();
        for (const point of matching) {
          const event = point.blobs?.[0] ?? "";
          const day = `${point.timestamp.slice(0, 10)} 00:00:00`;
          const bucketKey = `${day}\0${event}`;
          counts.set(bucketKey, (counts.get(bucketKey) ?? 0) + (point.doubles?.[0] ?? 1));
        }
        const rows = [...counts.entries()].map(([bucketKey, n]) => {
          const [day, event] = bucketKey.split("\0");
          return { day, event, n };
        });
        return {
          data: rows as unknown as T[],
          rows: rows.length,
          statistics: { elapsed_ms: 1, rows_read: rows.length, bytes_read: 64 },
        };
      },
    };

    const env: ApiWorkerEnv = {
      HYPERDRIVE_READ: { connectionString: testDb.connectionString } as Hyperdrive,
      HYPERDRIVE_WRITE: { connectionString: testDb.connectionString } as Hyperdrive,
      AUTH_SECRET: TEST_AUTH_SECRET,
      API_BASE_URL: TEST_BASE_URL,
      API_USAGE: {
        writeDataPoint(point) {
          writtenPoints.push({
            ...point,
            timestamp: new Date().toISOString().slice(0, 19).replace("T", " "),
          });
        },
      },
      ANALYTICS_SQL: analyticsSql,
    };

    const ctx = {
      waitUntil(promise: Promise<unknown>) {
        waitUntilPromises.push(promise);
      },
      passThroughOnException() {},
    } as unknown as ExecutionContext;

    const workerFetch = (request: Request) => worker.fetch(request, env, ctx);
    const keyed = createRpcClients(workerFetch, { apiKey: key.key });
    const sessionRpc = createRpcClients(workerFetch, { cookie: user.cookie });

    await expectRpcError(keyed.media.getMedia({ ref: mediaRef("tmdb:tv:1") }));
    expect(writtenPoints).toHaveLength(1);
    expect(writtenPoints[0]).toMatchObject({
      blobs: ["not_found", key.id],
      doubles: [1],
      indexes: [user.userId],
    });

    const usage = await sessionRpc.account.getApiUsage({ days: 7 });
    await Promise.allSettled(waitUntilPromises);

    expect(executedQueries).toHaveLength(2);
    expect(executedQueries.every((q) => q.query.includes(USAGE_SQL_DATASET))).toBe(true);
    expect(usage.days).toHaveLength(7);
    expect(usage.days.reduce((sum, day) => sum + day.notFound, 0n)).toBe(1n);
    expect(usage.lastUsed).toHaveLength(1);
    expect(usage.lastUsed[0]?.keyId).toBe(key.id);
    expect(Date.parse(usage.lastUsed[0]!.lastUsedAt)).not.toBeNaN();
  });
});

describe("readApiUsage and Analytics SQL binding", () => {
  const now = new Date("2026-11-25T12:00:00Z");

  test("zero-fills the window when no reader is configured", async () => {
    const usage = await readApiUsage(undefined, { userId: "u", keyIds: ["k"], days: 3, now });
    expect(usage.days.map((d) => d.date)).toEqual(["2026-11-23", "2026-11-24", "2026-11-25"]);
    expect(usage.days.every((d) => d.found === 0n && d.notFound === 0n && d.submitted === 0n)).toBe(
      true,
    );
    expect(usage.lastUsed).toEqual([]);
  });

  test("skips Analytics SQL queries when the user owns no API keys", async () => {
    let called = 0;
    const reader: UsageReader = {
      async query() {
        called += 1;
        return [];
      },
    };
    const usage = await readApiUsage(reader, { userId: "u", keyIds: [], days: 3, now });
    expect(called).toBe(0);
    expect(usage.days).toHaveLength(3);
    expect(usage.lastUsed).toEqual([]);
  });

  test("aggregates Analytics SQL rows with named params and reports last use per key", async () => {
    const requests: UsageQueryRequest[] = [];
    const reader: UsageReader = {
      async query(request) {
        requests.push(request);
        if (request.query.includes("APPROX_MAX(timestamp)")) {
          return [
            { key_id: "k1", last_used: "2026-11-25 08:30:00" },
            { key_id: "k2", last_used: "2026-11-25T09:15:00.000Z" },
          ];
        }
        return [
          { day: "2026-11-24 00:00:00", event: "found", n: 10 },
          { day: "2026-11-24 00:00:00", event: "not_found", n: 2 },
          { day: "2026-11-25 00:00:00", event: "submitted", n: 1 },
          { day: "2026-11-01 00:00:00", event: "found", n: 99 },
        ];
      },
    };
    const usage = await readApiUsage(reader, {
      userId: "u'1",
      keyIds: ["k1", "k2", "k1"],
      days: 2,
      now,
    });
    expect(usage.days).toEqual([
      { date: "2026-11-24", found: 10n, notFound: 2n, submitted: 0n },
      { date: "2026-11-25", found: 0n, notFound: 0n, submitted: 1n },
    ]);
    expect(usage.lastUsed).toEqual([
      { keyId: "k1", lastUsedAt: "2026-11-25T08:30:00.000Z" },
      { keyId: "k2", lastUsedAt: "2026-11-25T09:15:00.000Z" },
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.query).toContain(`FROM ${USAGE_SQL_DATASET}`);
    expect(requests[0]?.query).toContain("SUM(double1)");
    expect(requests[0]?.query).toContain("index1 = $userId AND blob2 IN ($k0, $k1)");
    expect(requests[0]?.params).toEqual({
      userId: "u'1",
      k0: "k1",
      k1: "k2",
      start: "2026-11-24T00:00:00.000Z",
    });
    expect(requests[1]?.query).toContain("APPROX_MAX(timestamp)");
    expect(requests[1]?.params).toEqual({
      userId: "u'1",
      k0: "k1",
      k1: "k2",
      start: "2026-08-27T12:00:00.000Z",
    });
  });

  test("parseAnalyticsTimestamp handles ClickHouse UTC and ISO timestamps with zones", () => {
    expect(parseAnalyticsTimestamp("2026-11-27 10:50:29")?.toISOString()).toBe(
      "2026-11-27T10:50:29.000Z",
    );
    expect(parseAnalyticsTimestamp("2026-11-27T10:50:29Z")?.toISOString()).toBe(
      "2026-11-27T10:50:29.000Z",
    );
    expect(parseAnalyticsTimestamp("2026-11-27T18:50:29+08:00")?.toISOString()).toBe(
      "2026-11-27T10:50:29.000Z",
    );
    expect(parseAnalyticsTimestamp("")).toBeNull();
    expect(parseAnalyticsTimestamp("not-a-date")).toBeNull();
  });

  test("createAnalyticsUsageReader retries once on retryable errors only", async () => {
    expect(createAnalyticsUsageReader(undefined)).toBeUndefined();

    let retryableAttempts = 0;
    const retryableBinding: AnalyticsSQLBinding = {
      async query<T extends Record<string, unknown>>() {
        retryableAttempts += 1;
        if (retryableAttempts === 1) {
          throw Object.assign(new Error("transient"), { retryable: true });
        }
        return {
          data: [{ ok: 1 }] as unknown as T[],
          rows: 1,
          statistics: { elapsed_ms: 1, rows_read: 1, bytes_read: 1 },
        };
      },
    };
    const reader = createAnalyticsUsageReader(retryableBinding, { retryDelayMs: 0 });
    await expect(reader!.query({ query: "SELECT 1" })).resolves.toEqual([{ ok: 1 }]);
    expect(retryableAttempts).toBe(2);

    let fatalAttempts = 0;
    const fatalBinding: AnalyticsSQLBinding = {
      async query() {
        fatalAttempts += 1;
        throw Object.assign(new Error("syntax error"), { retryable: false });
      },
    };
    const fatalReader = createAnalyticsUsageReader(fatalBinding, { retryDelayMs: 0 });
    await expect(fatalReader!.query({ query: "SELECT BAD" })).rejects.toThrow("syntax error");
    expect(fatalAttempts).toBe(1);
  });
});
