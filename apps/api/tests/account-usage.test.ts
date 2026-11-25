import { createFakeOutboundClient } from "@media-ref/core";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { createApiApp } from "../src/lib.ts";
import { readApiUsage, type UsageEvent, type UsageReader } from "../src/usage.ts";
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
});

describe("readApiUsage", () => {
  const now = new Date("2026-11-25T12:00:00Z");

  test("zero-fills the window when no reader is configured", async () => {
    const usage = await readApiUsage(undefined, { userId: "u", keyIds: ["k"], days: 3, now });
    expect(usage.days.map((d) => d.date)).toEqual(["2026-11-23", "2026-11-24", "2026-11-25"]);
    expect(usage.days.every((d) => d.found === 0n && d.notFound === 0n && d.submitted === 0n)).toBe(
      true,
    );
    expect(usage.lastUsed).toEqual([]);
  });

  test("aggregates Analytics Engine rows into days and reports last use per key", async () => {
    const queries: string[] = [];
    const reader: UsageReader = {
      async query(sql) {
        queries.push(sql);
        if (sql.includes("MAX(timestamp)")) {
          return [{ key_id: "k1", last_used: "2026-11-25 08:30:00" }];
        }
        return [
          { day: "2026-11-24 00:00:00", event: "found", n: 10 },
          { day: "2026-11-24 00:00:00", event: "not_found", n: 2 },
          { day: "2026-11-25 00:00:00", event: "submitted", n: 1 },
          { day: "2026-11-01 00:00:00", event: "found", n: 99 },
        ];
      },
    };
    const usage = await readApiUsage(reader, { userId: "u'1", keyIds: ["k1", "k2"], days: 2, now });
    expect(usage.days).toEqual([
      { date: "2026-11-24", found: 10n, notFound: 2n, submitted: 0n },
      { date: "2026-11-25", found: 0n, notFound: 0n, submitted: 1n },
    ]);
    expect(usage.lastUsed).toEqual([{ keyId: "k1", lastUsedAt: "2026-11-25T08:30:00.000Z" }]);
    // The user id is quoted, so a stray quote cannot break out of the string literal.
    expect(queries[0]).toContain("index1 = 'u\\'1'");
  });
});
