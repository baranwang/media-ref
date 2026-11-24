import { create } from "@bufbuild/protobuf";
import type { ExecutionContext, Hyperdrive } from "@cloudflare/workers-types";
import { fromProtoApiKeyAction, fromProtoMediaRef, proto } from "@media-ref/client";
import { createFakeOutboundClient, listLeadsForTarget } from "@media-ref/core";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, describe, expect, test } from "vite-plus/test";
import worker from "../src/index.ts";
import { createApiApp } from "../src/lib.ts";
import {
  createRpcClients,
  expectRpcError,
  issueApiKeyRpc,
  mediaRef,
  signUpUser,
  TEST_BASE_URL,
} from "./rpc-helpers.ts";

const TEST_AUTH_SECRET = "test-secret-for-media-ref-leads-integration-tests-0123456789";

describe("API Worker lead reporting (LeadService.CreateLead)", () => {
  const handles: TestDbHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop();
      if (handle) {
        await handle.cleanup();
      }
    }
  });

  test("allows a default read-only (read_report) API key to report leads and stores them for exploration lookup", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const outbound = createFakeOutboundClient();
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
      },
    });

    const user = await signUpUser(app, outbound, {
      email: "reporter@example.com",
      password: "StrongPassword123!",
      name: "Client Developer",
    });

    const createdKeyRes = await createRpcClients(app, { cookie: user.cookie }).account.createApiKey(
      { name: "Player Client" },
    );
    expect(createdKeyRes.apiKey!.canSubmit).toBe(false);
    expect(createdKeyRes.apiKey!.permissions?.media.map(fromProtoApiKeyAction)).toEqual([
      "read",
      "report",
    ]);

    const readOnlyKey = { id: createdKeyRes.apiKey!.id, key: createdKeyRes.key };

    // Report a full lead using X-API-Key header
    const createdBody = await createRpcClients(app, { apiKey: readOnlyKey.key }).lead.createLead({
      target: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
      namespace: "bilibili",
      nativeId: "ss34430",
      season: 1,
      variantDescription: "原声",
      notes: "Matched by title and release year",
    });

    const lead = createdBody.lead!;
    expect(fromProtoMediaRef(lead.target, { mode: "target" })).toMatchObject({
      ok: true,
      key: "tmdb:tv:95479",
    });
    expect(lead).toMatchObject({
      namespace: "bilibili",
      nativeId: "ss34430",
      season: 1,
      variantDescription: "原声",
      notes: "Matched by title and release year",
    });
    expect(lead.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(Number.isNaN(Date.parse(lead.createdAt))).toBe(false);

    // Report a minimal lead (without optional fields) using Authorization: Bearer
    const minimalBody = await createRpcClients(app, {
      bearerToken: readOnlyKey.key,
    }).lead.createLead({
      target: mediaRef({ douban: "1292052" }),
      namespace: "tencent",
      nativeId: "mzc00200xyz",
    });

    expect(fromProtoMediaRef(minimalBody.lead?.target, { mode: "target" })).toMatchObject({
      ok: true,
      key: "douban:1292052",
    });
    expect(minimalBody.lead).toMatchObject({
      namespace: "tencent",
      nativeId: "mzc00200xyz",
    });
    expect(minimalBody.lead?.season).toBeUndefined();
    expect(minimalBody.lead?.variantDescription).toBeUndefined();
    expect(minimalBody.lead?.notes).toBeUndefined();

    // Season 0 (specials) is accepted as a valid non-negative integer
    const specialsBody = await createRpcClients(app, { apiKey: readOnlyKey.key }).lead.createLead({
      target: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
      namespace: "bilibili",
      nativeId: "ss34431",
      season: 0,
    });
    expect(specialsBody.lead?.season).toBe(0);

    // Exploration helper retrieves stored leads with reporter metadata
    const bilibiliSeason1 = await listLeadsForTarget(testDb.readDb, {
      targetExternalKey: "tmdb:tv:95479",
      namespace: "bilibili",
      season: 1,
    });
    expect(bilibiliSeason1).toHaveLength(1);
    expect(bilibiliSeason1[0]).toMatchObject({
      id: lead.id,
      targetExternalKey: "tmdb:tv:95479",
      namespace: "bilibili",
      nativeId: "ss34430",
      season: 1,
      variantDescription: "原声",
      notes: "Matched by title and release year",
      reporterUserId: user.userId,
      reporterKeyId: readOnlyKey.id,
    });
    expect(bilibiliSeason1[0]!.createdAt).toBeInstanceOf(Date);
  });

  test("immediately rejects revoked keys via dbWrite even when dbRead still holds stale cached key rows", async () => {
    const primaryWriteDb = await createTestDb();
    const staleReadDb = await createTestDb();
    handles.push(primaryWriteDb, staleReadDb);

    const outbound = createFakeOutboundClient();
    const app = createApiApp({
      dbRead: staleReadDb.readDb,
      dbWrite: primaryWriteDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
      },
    });

    const user = await signUpUser(app, outbound, {
      email: "revoke-lead@example.com",
      password: "StrongPassword123!",
      name: "Revoke Tester",
    });

    const keyA = await issueApiKeyRpc(app, user.cookie, { name: "Revocable Client Key" });
    const submitKey = await issueApiKeyRpc(app, user.cookie, {
      name: "Submit Capable Key",
      canSubmit: true,
    });

    // Simulate cached dbRead still holding a snapshot of user + keyA.
    const userRow = await primaryWriteDb.readDb
      .selectFrom("user")
      .selectAll()
      .where("id", "=", user.userId)
      .executeTakeFirstOrThrow();
    const keyARow = await primaryWriteDb.readDb
      .selectFrom("apikey")
      .selectAll()
      .where("id", "=", keyA.id)
      .executeTakeFirstOrThrow();
    await staleReadDb.writeDb.insertInto("user").values(userRow).execute();
    await staleReadDb.writeDb.insertInto("apikey").values(keyARow).execute();

    // Before revocation, keyA can report a lead.
    const keyARpc = createRpcClients(app, { apiKey: keyA.key });
    const beforeLead = await keyARpc.lead.createLead({
      target: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
      namespace: "iqiyi",
      nativeId: "a_19rrk12345",
      season: 1,
    });
    expect(beforeLead.lead?.id).toBeTruthy();

    // Revoke keyA on dbWrite (staleReadDb still has the old cached row).
    await createRpcClients(app, { cookie: user.cookie }).account.deleteApiKey({ id: keyA.id });

    // Proof that staleReadDb still considers keyA valid on a read endpoint:
    expect((await keyARpc.account.getCurrentApiKey({})).keyId).toBe(keyA.id);

    // LeadService.CreateLead MUST verify against dbWrite and immediately reject the revoked key.
    const afterRevokeErr = await expectRpcError(
      keyARpc.lead.createLead({
        target: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
        namespace: "iqiyi",
        nativeId: "a_19rrk99999",
        season: 2,
      }),
    );
    expect(afterRevokeErr.status).toBe(401);
    expect(afterRevokeErr.code).toBe("INVALID_API_KEY");
    expect(afterRevokeErr.message).toBe("Invalid API key");

    // Submit-capable key (which also has report permission) still works on dbWrite.
    const submitKeyRes = await createRpcClients(app, {
      bearerToken: submitKey.key,
    }).lead.createLead({
      target: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
      namespace: "youku",
      nativeId: "yk_abc123",
      season: 1,
    });
    expect(submitKeyRes.lead?.id).toBeTruthy();

    // Earlier lead reported before revocation remains intact; rejected lead was not stored.
    const iqiyiLeads = await listLeadsForTarget(primaryWriteDb.readDb, {
      targetExternalKey: "tmdb:tv:95479",
      namespace: "iqiyi",
    });
    expect(iqiyiLeads.map((item) => item.id)).toEqual([beforeLead.lead!.id]);
  });

  test("rejects missing, invalid, disabled, expired, and permission-lacking API keys and invalid payloads", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    let currentTime = new Date();
    const outbound = createFakeOutboundClient();
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => currentTime,
      },
    });

    const validPayload = {
      target: mediaRef({ tmdb: { type: "movie", id: 550 } }),
      namespace: "bilibili",
      nativeId: "ss12345",
    };

    // Missing API key -> 401
    const missingKeyErr = await expectRpcError(createRpcClients(app).lead.createLead(validPayload));
    expect(missingKeyErr.status).toBe(401);
    expect(missingKeyErr.code).toBe("API_KEY_REQUIRED");
    expect(missingKeyErr.message).toBe("API key is required");

    // Unknown API key -> 401
    const unknownKeyErr = await expectRpcError(
      createRpcClients(app, { apiKey: "mref_nonexistent_key_value" }).lead.createLead(validPayload),
    );
    expect(unknownKeyErr.status).toBe(401);
    expect(unknownKeyErr.code).toBe("INVALID_API_KEY");
    expect(unknownKeyErr.message).toBe("Invalid API key");

    const user = await signUpUser(app, outbound, {
      email: "validate-lead@example.com",
      password: "StrongPassword123!",
      name: "Validation Tester",
    });

    const activeKey = await issueApiKeyRpc(app, user.cookie, { name: "Active Key" });
    const expiringKey = await issueApiKeyRpc(app, user.cookie, {
      name: "Expiring Key",
      expiresIn: 60,
    });
    const disabledKey = await issueApiKeyRpc(app, user.cookie, { name: "Disabled Key" });
    const readOnlyNoReportKey = await issueApiKeyRpc(app, user.cookie, {
      name: "No Report Perm Key",
    });

    // Disable key via Better Auth update endpoint
    const disableRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/api/auth/api-key/update`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: user.cookie },
        body: JSON.stringify({ keyId: disabledKey.id, enabled: false }),
      }),
    );
    expect(disableRes.status).toBe(200);

    const disabledErr = await expectRpcError(
      createRpcClients(app, { apiKey: disabledKey.key }).lead.createLead(validPayload),
    );
    expect(disabledErr.status).toBe(401);
    expect(disabledErr.code).toBe("API_KEY_DISABLED");
    expect(disabledErr.message).toBe("API key is disabled");

    // Restrict a key to ["read"] only in DB to verify report permission check
    await testDb.writeDb
      .updateTable("apikey")
      .set({ permissions: JSON.stringify({ media: ["read"] }) })
      .where("id", "=", readOnlyNoReportKey.id)
      .execute();

    const insufficientErr = await expectRpcError(
      createRpcClients(app, { apiKey: readOnlyNoReportKey.key }).lead.createLead(validPayload),
    );
    expect(insufficientErr.status).toBe(403);
    expect(insufficientErr.code).toBe("INSUFFICIENT_PERMISSIONS");
    expect(insufficientErr.message).toBe("API key does not have required permission");

    // Advance clock past expiringKey's expiration
    currentTime = new Date(Date.now() + 65_000);
    const expiredErr = await expectRpcError(
      createRpcClients(app, { apiKey: expiringKey.key }).lead.createLead(validPayload),
    );
    expect(expiredErr.status).toBe(401);
    expect(expiredErr.code).toBe("API_KEY_EXPIRED");
    expect(expiredErr.message).toBe("API key has expired");

    // Wire-level malformed Connect JSON / invalid field types -> 400
    const jsonTmdbTarget = { tmdb: { type: "MEDIA_TYPE_TV", id: 95479 } };
    for (const badBody of [
      "{not-json",
      JSON.stringify(["not-an-object"]),
      JSON.stringify({
        target: jsonTmdbTarget,
        namespace: "bilibili",
        nativeId: "ss34430",
        season: 1.5,
      }),
      JSON.stringify({
        target: jsonTmdbTarget,
        namespace: "bilibili",
        nativeId: "ss34430",
        season: "not-a-number",
      }),
      JSON.stringify({
        target: jsonTmdbTarget,
        namespace: "bilibili",
        nativeId: "ss34430",
        variantDescription: 42,
      }),
      JSON.stringify({
        target: jsonTmdbTarget,
        namespace: "bilibili",
        nativeId: "ss34430",
        notes: { hint: "bad" },
      }),
    ]) {
      const res = await app.fetch(
        new Request(`${TEST_BASE_URL}/mediaref.v1.LeadService/CreateLead`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": activeKey.key,
          },
          body: badBody,
        }),
      );
      expect(res.status).toBe(400);
    }

    // Domain validation errors via binary ConnectRPC -> 400 + structured error code
    const activeRpc = createRpcClients(app, { apiKey: activeKey.key });
    const invalidDomainCases: Array<{
      input: Parameters<typeof activeRpc.lead.createLead>[0];
      expectedCode: string;
    }> = [
      {
        input: {
          target: create(proto.MediaRefSchema),
          namespace: "bilibili",
          nativeId: "ss34430",
        },
        expectedCode: "INVALID_EXTERNAL_KEY",
      },
      {
        input: {
          target: create(proto.MediaRefSchema, {
            id: {
              case: "tmdb",
              value: create(proto.TmdbRefSchema, { type: proto.MediaType.TV, id: 0 }),
            },
          }),
          namespace: "bilibili",
          nativeId: "ss34430",
        },
        expectedCode: "INVALID_EXTERNAL_KEY",
      },
      {
        input: {
          target: mediaRef({ mediaId: "00000000-0000-4000-8000-000000000001" }),
          namespace: "bilibili",
          nativeId: "ss34430",
        },
        expectedCode: "INVALID_EXTERNAL_KEY",
      },
      {
        input: {
          target: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
          namespace: "netflix",
          nativeId: "80057281",
        },
        expectedCode: "INVALID_NAMESPACE",
      },
      {
        input: {
          target: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
          namespace: "bilibili",
          nativeId: "",
        },
        expectedCode: "INVALID_NATIVE_ID",
      },
      {
        input: {
          target: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
          namespace: "bilibili",
          nativeId: "   ",
        },
        expectedCode: "INVALID_NATIVE_ID",
      },
      {
        input: {
          target: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
          namespace: "bilibili",
          nativeId: "ss34430",
          season: -1,
        },
        expectedCode: "INVALID_SEASON",
      },
    ];

    for (const testCase of invalidDomainCases) {
      const err = await expectRpcError(activeRpc.lead.createLead(testCase.input));
      expect(err.status).toBe(400);
      expect(err.code).toBe(testCase.expectedCode);
    }

    const totalLeads = await testDb.readDb.selectFrom("leads").select("id").execute();
    expect(totalLeads).toHaveLength(0);
  });

  test("does not enqueue background jobs, invoke outbound calls, or expose leads on public read endpoints, and supports filtered lookup for exploration", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const outbound = createFakeOutboundClient();
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
      },
    });

    const user = await signUpUser(app, outbound, {
      email: "isolation@example.com",
      password: "StrongPassword123!",
      name: "Isolation Tester",
    });

    const key = await issueApiKeyRpc(app, user.cookie, { name: "Client App" });
    const keyRpc = createRpcClients(app, { apiKey: key.key });

    const payloads = [
      {
        target: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
        namespace: "bilibili",
        nativeId: "ss34430",
        season: 1,
        variantDescription: "原声",
      },
      {
        target: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
        namespace: "bilibili",
        nativeId: "ss45574",
        season: 2,
      },
      {
        target: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
        namespace: "bilibili",
        nativeId: "ss_series_hint",
        notes: "   ",
      },
      {
        target: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
        namespace: "tencent",
        nativeId: "mzc00200test",
        season: 1,
      },
      {
        target: mediaRef({ douban: "1292052" }),
        namespace: "mgtv",
        nativeId: "mg_999",
      },
    ];

    const createdIds: string[] = [];
    for (const payload of payloads) {
      const body = await keyRpc.lead.createLead(payload);
      createdIds.push(body.lead!.id);
    }

    // Reporting leads MUST NOT enqueue any background_jobs (cannot trigger exploration)
    const jobs = await testDb.readDb.selectFrom("background_jobs").select("id").execute();
    expect(jobs).toHaveLength(0);

    // Reporting leads MUST NOT trigger outbound HTTP or AI model calls
    expect(outbound.httpRequests).toHaveLength(0);
    expect(outbound.modelRequests).toHaveLength(0);

    // Leads are NOT exposed on public read endpoints
    const getLeadsRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/mediaref.v1.LeadService/ListLeads`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key.key },
        body: "{}",
      }),
    );
    expect(getLeadsRes.status).toBe(404);

    const healthRes = await app.fetch(new Request(`${TEST_BASE_URL}/health`));
    expect(healthRes.status).toBe(200);
    expect(await healthRes.text()).not.toContain("ss34430");

    const keyMe = await keyRpc.account.getCurrentApiKey({});
    expect(JSON.stringify(keyMe)).not.toContain("ss34430");

    // Exploration lookup helper filters cleanly by targetExternalKey, namespace, season, and limit
    const allForTmdb = await listLeadsForTarget(testDb.readDb, {
      targetExternalKey: "tmdb:tv:95479",
    });
    expect(allForTmdb).toHaveLength(4);

    const bilibiliOnly = await listLeadsForTarget(testDb.readDb, {
      targetExternalKey: "tmdb:tv:95479",
      namespace: "bilibili",
    });
    expect(bilibiliOnly).toHaveLength(3);
    expect(bilibiliOnly.map((item) => item.nativeId).sort()).toEqual([
      "ss34430",
      "ss45574",
      "ss_series_hint",
    ]);

    const bilibiliSeason1 = await listLeadsForTarget(testDb.readDb, {
      targetExternalKey: "tmdb:tv:95479",
      namespace: "bilibili",
      season: 1,
    });
    expect(bilibiliSeason1).toHaveLength(1);
    expect(bilibiliSeason1[0]!.id).toBe(createdIds[0]);

    const bilibiliNoSeason = await listLeadsForTarget(testDb.readDb, {
      targetExternalKey: "tmdb:tv:95479",
      namespace: "bilibili",
      season: null,
    });
    expect(bilibiliNoSeason).toHaveLength(1);
    expect(bilibiliNoSeason[0]).toMatchObject({
      id: createdIds[2],
      nativeId: "ss_series_hint",
      season: null,
      notes: null,
    });

    const limited = await listLeadsForTarget(testDb.readDb, {
      targetExternalKey: "tmdb:tv:95479",
      limit: 2,
    });
    expect(limited).toHaveLength(2);

    const unknownTarget = await listLeadsForTarget(testDb.readDb, {
      targetExternalKey: "tmdb:tv:99999999",
    });
    expect(unknownTarget).toEqual([]);
  });

  test("default Cloudflare Worker fetch entrypoint handles LeadService.CreateLead over HYPERDRIVE_WRITE", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const outbound = createFakeOutboundClient();
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
      },
    });

    const user = await signUpUser(app, outbound, {
      email: "worker-lead@example.com",
      password: "StrongPassword123!",
      name: "Worker Lead Dev",
    });
    const key = await issueApiKeyRpc(app, user.cookie, { name: "Worker Lead Key" });

    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;

    const hyperdrive = {
      connectionString: testDb.connectionString,
    } as Hyperdrive;

    const workerEnv = {
      HYPERDRIVE_READ: hyperdrive,
      HYPERDRIVE_WRITE: hyperdrive,
      AUTH_SECRET: TEST_AUTH_SECRET,
      API_BASE_URL: TEST_BASE_URL,
      COOKIE_DOMAIN: "mediaref.org",
    };

    const workerRpc = createRpcClients((req) => worker.fetch(req, workerEnv, ctx), {
      apiKey: key.key,
    });

    const body = await workerRpc.lead.createLead({
      target: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
      namespace: "bilibili",
      nativeId: "ss34430",
      season: 1,
    });
    await Promise.all(pending);

    expect(fromProtoMediaRef(body.lead?.target, { mode: "target" })).toMatchObject({
      ok: true,
      key: "tmdb:tv:95479",
    });
    expect(body.lead).toMatchObject({
      namespace: "bilibili",
      nativeId: "ss34430",
    });

    const stored = await listLeadsForTarget(testDb.readDb, {
      targetExternalKey: "tmdb:tv:95479",
      namespace: "bilibili",
      season: 1,
    });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.id).toBe(body.lead!.id);
  });
});
