import type { ExecutionContext, Hyperdrive } from "@cloudflare/workers-types";
import { fromProtoApiKeyAction, proto, toProtoSegmentInput } from "@media-ref/client";
import * as internalProto from "@media-ref/client/internal";
import { createAdapterRegistry, createFakeOutboundClient } from "@media-ref/core";
import { createDb } from "@media-ref/db";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, describe, expect, test } from "vite-plus/test";
import worker from "../src/index.ts";
import { createApiApp } from "../src/lib.ts";
import {
  createRpcClients,
  expectRpcError,
  mediaRef,
  signUpUser,
  TEST_BASE_URL,
} from "./rpc-helpers.ts";

const TEST_AUTH_SECRET = "test-secret-for-media-ref-api-key-integration-tests-0123456789";

function extractActions(perms?: proto.ApiKeyPermissions): string[] {
  return (perms?.media ?? [])
    .map(fromProtoApiKeyAction)
    .filter((a): a is "read" | "report" | "submit" => a !== undefined);
}

describe("API Worker API key management & verification (ConnectRPC)", () => {
  const handles: TestDbHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop();
      if (handle) {
        await handle.cleanup();
      }
    }
  });

  test("allows a verified user to create multiple keys with chosen permissions, list sanitized metadata, and revoke keys with ownership enforcement", async () => {
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

    const alice = await signUpUser(app, outbound, {
      email: "alice@example.com",
      password: "StrongPassword123!",
      name: "Alice",
      verify: true,
    });
    const bob = await signUpUser(app, outbound, {
      email: "bob@example.com",
      password: "StrongPassword456!",
      name: "Bob",
      verify: true,
    });

    const aliceRpc = createRpcClients(app, { cookie: alice.cookie });
    const bobRpc = createRpcClients(app, { cookie: bob.cookie });

    const readKeyRes = await aliceRpc.account.createApiKey({ name: "Player App" });
    const readKeySummary = readKeyRes.apiKey!;

    expect(readKeySummary.name).toBe("Player App");
    expect(readKeySummary.prefix).toBe("mref_");
    expect(readKeyRes.key.startsWith("mref_")).toBe(true);
    expect(readKeySummary.start).toBe(readKeyRes.key.slice(0, 11));
    expect(readKeySummary.enabled).toBe(true);
    expect(extractActions(readKeySummary.permissions)).toEqual(["read", "report"]);
    expect(readKeySummary.canSubmit).toBe(false);
    expect(readKeySummary.expiresAt).toBeUndefined();
    expect(Number.isNaN(Date.parse(readKeySummary.createdAt))).toBe(false);

    const submitKeyRes = await aliceRpc.account.createApiKey({
      name: "Batch Submitter",
      canSubmit: true,
      expiresIn: 86_400,
    });
    const submitKeySummary = submitKeyRes.apiKey!;

    expect(submitKeySummary.id).not.toBe(readKeySummary.id);
    expect(submitKeyRes.key).not.toBe(readKeyRes.key);
    expect(extractActions(submitKeySummary.permissions)).toEqual(["read", "report", "submit"]);
    expect(submitKeySummary.canSubmit).toBe(true);
    expect(submitKeySummary.expiresAt).toBeDefined();

    const listBody = await aliceRpc.account.listApiKeys({});
    expect(listBody.total).toBe(2);
    expect(listBody.apiKeys).toHaveLength(2);
    for (const item of listBody.apiKeys) {
      expect(item).not.toHaveProperty("key");
    }
    const serializedList = JSON.stringify(listBody);
    expect(serializedList).not.toContain(readKeyRes.key);
    expect(serializedList).not.toContain(submitKeyRes.key);

    const byId = new Map(listBody.apiKeys.map((item) => [item.id, item]));
    expect(byId.get(readKeySummary.id)).toMatchObject({
      id: readKeySummary.id,
      name: "Player App",
      prefix: "mref_",
      start: readKeySummary.start,
      enabled: true,
      canSubmit: false,
    });
    expect(extractActions(byId.get(readKeySummary.id)?.permissions)).toEqual(["read", "report"]);
    expect(byId.get(readKeySummary.id)?.expiresAt).toBeUndefined();

    expect(byId.get(submitKeySummary.id)).toMatchObject({
      id: submitKeySummary.id,
      name: "Batch Submitter",
      prefix: "mref_",
      start: submitKeySummary.start,
      enabled: true,
      canSubmit: true,
    });
    expect(extractActions(byId.get(submitKeySummary.id)?.permissions)).toEqual([
      "read",
      "report",
      "submit",
    ]);

    // Bob cannot see or revoke Alice's keys.
    const bobList = await bobRpc.account.listApiKeys({});
    expect(bobList.total).toBe(0);
    expect(bobList.apiKeys).toEqual([]);

    const bobDeleteErr = await expectRpcError(
      bobRpc.account.deleteApiKey({ id: readKeySummary.id }),
    );
    expect(bobDeleteErr.status).toBe(404);
    expect(bobDeleteErr.code).toBe("API_KEY_NOT_FOUND");

    // Alice revokes one key; the other remains.
    const deleteRes = await aliceRpc.account.deleteApiKey({ id: readKeySummary.id });
    expect(deleteRes).toMatchObject({ success: true, id: readKeySummary.id });

    const afterBody = await aliceRpc.account.listApiKeys({});
    expect(afterBody.total).toBe(1);
    expect(afterBody.apiKeys.map((k) => k.id)).toEqual([submitKeySummary.id]);
  });

  test("rejects unverified users creating keys and blocks direct /api/auth/api-key/create bypass", async () => {
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

    const unauthRpc = createRpcClients(app);
    expect((await expectRpcError(unauthRpc.account.createApiKey({ name: "No Auth" }))).status).toBe(
      401,
    );
    expect((await expectRpcError(unauthRpc.account.listApiKeys({}))).status).toBe(401);
    expect((await expectRpcError(unauthRpc.account.deleteApiKey({ id: "some-id" }))).status).toBe(
      401,
    );

    const unverified = await signUpUser(app, outbound, {
      email: "unverified@example.com",
      password: "StrongPassword123!",
      name: "Unverified Dev",
      verify: false,
    });

    const createErr = await expectRpcError(
      createRpcClients(app, { cookie: unverified.cookie }).account.createApiKey({
        name: "Blocked Key",
      }),
    );
    expect(createErr.status).toBe(403);
    expect(createErr.code).toBe("EMAIL_NOT_VERIFIED");
    expect(createErr.message).toBe("Email verification is required");

    // Direct Better Auth /api/auth/api-key/create must be disabled so unverified users cannot bypass.
    const directBypass = await app.fetch(
      new Request(`${TEST_BASE_URL}/api/auth/api-key/create`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: unverified.cookie,
        },
        body: JSON.stringify({ name: "Bypass Attempt" }),
      }),
    );
    expect(directBypass.status).toBe(404);
  });

  test("verifies Better Auth-issued keys with zero DB writes, supports Bearer and X-API-Key headers, and enforces read/report/submit permissions", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    // Enforce read-only transactions at the PostgreSQL session level on dbRead
    // to prove custom verification performs zero database writes.
    const readOnlyUrl = new URL(testDb.connectionString);
    readOnlyUrl.searchParams.set("options", "-c default_transaction_read_only=on");
    const readOnlyDb = createDb(readOnlyUrl.toString());

    try {
      const outbound = createFakeOutboundClient();
      const app = createApiApp({
        dbRead: readOnlyDb,
        dbWrite: testDb.writeDb,
        outbound,
        adapterRegistry: createAdapterRegistry(),
        config: {
          baseUrl: TEST_BASE_URL,
          authSecret: TEST_AUTH_SECRET,
        },
      });

      const dev = await signUpUser(app, outbound, {
        email: "dev@example.com",
        password: "StrongPassword123!",
        name: "Dev",
        verify: true,
      });

      const devRpc = createRpcClients(app, { cookie: dev.cookie });
      const readOnlyKeyRes = await devRpc.account.createApiKey({ name: "Read & Report Key" });
      const readOnlyKey = {
        id: readOnlyKeyRes.apiKey!.id,
        key: readOnlyKeyRes.key,
        start: readOnlyKeyRes.apiKey!.start!,
      };

      const submitKeyRes = await devRpc.account.createApiKey({
        name: "Submit Key",
        scopes: [internalProto.ApiKeyScope.READ_REPORT, internalProto.ApiKeyScope.SUBMIT],
      });
      const submitKey = {
        id: submitKeyRes.apiKey!.id,
        key: submitKeyRes.key,
      };

      const beforeRows = await testDb.readDb
        .selectFrom("apikey")
        .select(["id", "requestCount", "lastRequest", "updatedAt"])
        .where("id", "in", [readOnlyKey.id, submitKey.id])
        .execute();
      const beforeById = new Map(beforeRows.map((row) => [row.id, row]));

      // Read-only key works with Authorization: Bearer on GetCurrentApiKey (uses readOnlyDb).
      const bearerMe = await createRpcClients(app, {
        bearerToken: readOnlyKey.key,
      }).apiKey.getCurrentApiKey({});
      expect(bearerMe).toMatchObject({
        keyId: readOnlyKey.id,
        userId: dev.userId,
        name: "Read & Report Key",
        prefix: "mref_",
        start: readOnlyKey.start,
        canSubmit: false,
        emailVerified: true,
        role: "user",
      });
      expect(extractActions(bearerMe.permissions)).toEqual(["read", "report"]);
      expect(bearerMe.expiresAt).toBeUndefined();

      // Read-only key also works with X-API-Key header on GetCurrentApiKey and report RPC (ReportInvalidation).
      const readKeyRpc = createRpcClients(app, { apiKey: readOnlyKey.key });
      const xApiKeyMe = await readKeyRpc.apiKey.getCurrentApiKey({});
      expect(xApiKeyMe.keyId).toBe(readOnlyKey.id);

      const reportErr = await expectRpcError(
        readKeyRpc.association.reportInvalidation({
          associationId: "00000000-0000-4000-8000-000000000099",
        }),
      );
      expect(reportErr.status).toBe(404);
      expect(reportErr.code).toBe("ASSOCIATION_NOT_FOUND");

      // Read-only key is rejected with 403 INSUFFICIENT_PERMISSIONS on submit RPC (CreateChangeRequest).
      const submitPayload = {
        target: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
        namespace: "bilibili",
        nativeId: "ss34430",
        variantDescription: "原声",
        segments: [
          toProtoSegmentInput({
            season: 1,
            episodeStart: 1,
            episodeEnd: 12,
            targetEpisodeStart: 1,
            baseline: "tmdb",
          }),
        ],
      };

      const readKeySubmitErr = await expectRpcError(
        createRpcClients(app, { bearerToken: readOnlyKey.key }).changeRequest.createChangeRequest(
          submitPayload,
        ),
      );
      expect(readKeySubmitErr.status).toBe(403);
      expect(readKeySubmitErr.code).toBe("INSUFFICIENT_PERMISSIONS");
      expect(readKeySubmitErr.message).toBe("API key does not have required permission");

      // Submit key succeeds on read, report, and submit RPCs.
      const submitKeyApiRpc = createRpcClients(app, { apiKey: submitKey.key });
      const submitKeyBearerRpc = createRpcClients(app, { bearerToken: submitKey.key });
      expect((await submitKeyApiRpc.apiKey.getCurrentApiKey({})).canSubmit).toBe(true);
      const submitKeyReportErr = await expectRpcError(
        submitKeyBearerRpc.association.reportInvalidation({
          associationId: "00000000-0000-4000-8000-000000000099",
        }),
      );
      expect(submitKeyReportErr.status).toBe(404);
      expect(submitKeyReportErr.code).toBe("ASSOCIATION_NOT_FOUND");

      const submitRes = await submitKeyBearerRpc.changeRequest.createChangeRequest(submitPayload);
      expect(submitRes.changeRequest?.id).toBeTruthy();

      // Verify zero DB writes happened on apikey rows (requestCount, lastRequest, updatedAt untouched).
      const afterRows = await testDb.readDb
        .selectFrom("apikey")
        .select(["id", "requestCount", "lastRequest", "updatedAt"])
        .where("id", "in", [readOnlyKey.id, submitKey.id])
        .execute();

      for (const after of afterRows) {
        const before = beforeById.get(after.id)!;
        expect(after.requestCount).toBe(0);
        expect(after.lastRequest).toBeNull();
        expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
      }
    } finally {
      await readOnlyDb.destroy();
    }
  });

  test("immediately rejects revoked keys on dbWrite endpoints while leaving other keys active", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const outbound = createFakeOutboundClient();
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      adapterRegistry: createAdapterRegistry(),
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
      },
    });

    const user = await signUpUser(app, outbound, {
      email: "revoke@example.com",
      password: "StrongPassword123!",
      name: "Revoker",
      verify: true,
    });

    const userRpc = createRpcClients(app, { cookie: user.cookie });
    const keyA = await userRpc.account.createApiKey({ name: "Key A", canSubmit: true });
    const keyB = await userRpc.account.createApiKey({ name: "Key B", canSubmit: true });

    const submitPayload = (nativeId: string) => ({
      target: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
      namespace: "bilibili",
      nativeId,
      variantDescription: "原声",
      segments: [
        toProtoSegmentInput({
          season: 1,
          episodeStart: 1,
          episodeEnd: 12,
          targetEpisodeStart: 1,
          baseline: "tmdb",
        }),
      ],
    });

    expect(
      (
        await createRpcClients(app, { apiKey: keyA.key }).changeRequest.createChangeRequest(
          submitPayload("ss10001"),
        )
      ).changeRequest?.id,
    ).toBeTruthy();

    await userRpc.account.deleteApiKey({ id: keyA.apiKey!.id });

    // Immediately rejected on both submit and report dbWrite RPCs.
    const submitAfterRevoke = await expectRpcError(
      createRpcClients(app, { bearerToken: keyA.key }).changeRequest.createChangeRequest(
        submitPayload("ss10002"),
      ),
    );
    expect(submitAfterRevoke.status).toBe(401);
    expect(submitAfterRevoke.code).toBe("INVALID_API_KEY");
    expect(submitAfterRevoke.message).toBe("Invalid API key");

    const reportAfterRevoke = await expectRpcError(
      createRpcClients(app, { apiKey: keyA.key }).association.reportInvalidation({
        associationId: "00000000-0000-4000-8000-000000000099",
      }),
    );
    expect(reportAfterRevoke.status).toBe(401);
    expect(reportAfterRevoke.code).toBe("INVALID_API_KEY");
    expect(reportAfterRevoke.message).toBe("Invalid API key");

    // Key B owned by the same user continues working unaffected.
    const keyBSubmit = await createRpcClients(app, {
      apiKey: keyB.key,
    }).changeRequest.createChangeRequest(submitPayload("ss10003"));
    expect(keyBSubmit.changeRequest?.id).toBeTruthy();
  });

  test("rejects expired keys and disabled keys with 401", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    let currentTime = new Date();
    const outbound = createFakeOutboundClient();
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      adapterRegistry: createAdapterRegistry(),
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => currentTime,
      },
    });

    const user = await signUpUser(app, outbound, {
      email: "expiry@example.com",
      password: "StrongPassword123!",
      name: "Expiry Dev",
      verify: true,
    });

    const userRpc = createRpcClients(app, { cookie: user.cookie });
    const expiringKey = await userRpc.account.createApiKey({
      name: "Short Lived",
      canSubmit: true,
      expiresIn: 60,
    });
    const disableTarget = await userRpc.account.createApiKey({
      name: "Disable Me",
      canSubmit: true,
    });

    // Valid before expiration.
    expect(
      (await createRpcClients(app, { apiKey: expiringKey.key }).apiKey.getCurrentApiKey({})).keyId,
    ).toBe(expiringKey.apiKey!.id);

    // Advance clock past expiresAt.
    currentTime = new Date(Date.now() + 65_000);

    const expiredRead = await expectRpcError(
      createRpcClients(app, { apiKey: expiringKey.key }).apiKey.getCurrentApiKey({}),
    );
    expect(expiredRead.status).toBe(401);
    expect(expiredRead.code).toBe("API_KEY_EXPIRED");
    expect(expiredRead.message).toBe("API key has expired");

    const expiredWrite = await expectRpcError(
      createRpcClients(app, { bearerToken: expiringKey.key }).changeRequest.createChangeRequest({
        target: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
        namespace: "bilibili",
        nativeId: "ss34430",
        variantDescription: "原声",
        segments: [toProtoSegmentInput({ season: 1, baseline: "tmdb" })],
      }),
    );
    expect(expiredWrite.status).toBe(401);
    expect(expiredWrite.code).toBe("API_KEY_EXPIRED");
    expect(expiredWrite.message).toBe("API key has expired");

    // Disable key via Better Auth update endpoint and confirm custom verifier rejects it.
    const disableRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/api/auth/api-key/update`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: user.cookie },
        body: JSON.stringify({ keyId: disableTarget.apiKey!.id, enabled: false }),
      }),
    );
    expect(disableRes.status).toBe(200);

    const disabledCheck = await expectRpcError(
      createRpcClients(app, { apiKey: disableTarget.key }).changeRequest.createChangeRequest({
        target: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
        namespace: "bilibili",
        nativeId: "ss34430",
        variantDescription: "原声",
        segments: [toProtoSegmentInput({ season: 1, baseline: "tmdb" })],
      }),
    );
    expect(disabledCheck.status).toBe(401);
    expect(disabledCheck.code).toBe("API_KEY_DISABLED");
    expect(disabledCheck.message).toBe("API key is disabled");
  });

  test("routes read verification through dbRead and write/report verification through dbWrite independently", async () => {
    const primaryWriteDb = await createTestDb();
    const cachedReadDb = await createTestDb();
    handles.push(primaryWriteDb, cachedReadDb);

    const outbound = createFakeOutboundClient();
    const app = createApiApp({
      dbRead: cachedReadDb.readDb,
      dbWrite: primaryWriteDb.writeDb,
      outbound,
      adapterRegistry: createAdapterRegistry(),
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
      },
    });

    const user = await signUpUser(app, outbound, {
      email: "splitdb@example.com",
      password: "StrongPassword123!",
      name: "Split DB Dev",
      verify: true,
    });

    const userRpc = createRpcClients(app, { cookie: user.cookie });
    const created = await userRpc.account.createApiKey({ name: "Split Key", canSubmit: true });

    const keyRpc = createRpcClients(app, { apiKey: created.key });

    // Write/report RPCs hit dbWrite (primaryWriteDb) and succeed immediately.
    expect(
      (
        await keyRpc.changeRequest.createChangeRequest({
          target: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
          namespace: "bilibili",
          nativeId: "ss10001",
          variantDescription: "原声",
          segments: [toProtoSegmentInput({ season: 1, baseline: "tmdb" })],
        })
      ).changeRequest?.id,
    ).toBeTruthy();
    const splitReportBeforeRevoke = await expectRpcError(
      keyRpc.association.reportInvalidation({
        associationId: "00000000-0000-4000-8000-000000000099",
      }),
    );
    expect(splitReportBeforeRevoke.status).toBe(404);
    expect(splitReportBeforeRevoke.code).toBe("ASSOCIATION_NOT_FOUND");

    // Read RPC hits dbRead (cachedReadDb), which does not have the row yet.
    expect((await expectRpcError(keyRpc.apiKey.getCurrentApiKey({}))).status).toBe(401);

    // Copy the user and apikey rows into cachedReadDb to simulate cached read visibility.
    const userRow = await primaryWriteDb.readDb
      .selectFrom("user")
      .selectAll()
      .where("id", "=", user.userId)
      .executeTakeFirstOrThrow();
    const keyRow = await primaryWriteDb.readDb
      .selectFrom("apikey")
      .selectAll()
      .where("id", "=", created.apiKey!.id)
      .executeTakeFirstOrThrow();

    await cachedReadDb.writeDb.insertInto("user").values(userRow).execute();
    await cachedReadDb.writeDb.insertInto("apikey").values(keyRow).execute();

    // Now read RPC succeeds via dbRead.
    expect((await keyRpc.apiKey.getCurrentApiKey({})).keyId).toBe(created.apiKey!.id);

    // Revoke key (deletes on primaryWriteDb while cachedReadDb still holds stale cache entry).
    await userRpc.account.deleteApiKey({ id: created.apiKey!.id });

    // Write & report RPCs reject IMMEDIATELY because they query uncached dbWrite.
    expect(
      (
        await expectRpcError(
          keyRpc.changeRequest.createChangeRequest({
            target: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
            namespace: "bilibili",
            nativeId: "ss10002",
            variantDescription: "原声",
            segments: [toProtoSegmentInput({ season: 1, baseline: "tmdb" })],
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await expectRpcError(
          keyRpc.association.reportInvalidation({
            associationId: "00000000-0000-4000-8000-000000000099",
          }),
        )
      ).status,
    ).toBe(401);

    // Read RPC still sees the stale cached row on dbRead, confirming distinct connection routing.
    expect((await keyRpc.apiKey.getCurrentApiKey({})).keyId).toBe(created.apiKey!.id);
  });

  test("validates CreateApiKey input and rejects missing or malformed API key headers", async () => {
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
      email: "validator@example.com",
      password: "StrongPassword123!",
      name: "Validator",
      verify: true,
    });

    // Missing or non-Bearer auth headers return 401 API_KEY_REQUIRED.
    const missingErr = await expectRpcError(createRpcClients(app).apiKey.getCurrentApiKey({}));
    expect(missingErr.status).toBe(401);
    expect(missingErr.code).toBe("API_KEY_REQUIRED");
    expect(missingErr.message).toBe("API key is required");

    const basicAuthErr = await expectRpcError(
      createRpcClients(app, {
        headers: { authorization: "Basic dXNlcjpwYXNz" },
      }).apiKey.getCurrentApiKey({}),
    );
    expect(basicAuthErr.status).toBe(401);
    expect(basicAuthErr.code).toBe("API_KEY_REQUIRED");
    expect(basicAuthErr.message).toBe("API key is required");

    const wrongKeyErr = await expectRpcError(
      createRpcClients(app, { apiKey: "mref_nonexistent_key_value" }).apiKey.getCurrentApiKey({}),
    );
    expect(wrongKeyErr.status).toBe(401);
    expect(wrongKeyErr.code).toBe("INVALID_API_KEY");
    expect(wrongKeyErr.message).toBe("Invalid API key");

    // Malformed Connect JSON / unknown fields / invalid wire types return 400 at Protobuf decode.
    for (const badBody of [
      "{not-json",
      JSON.stringify({ name: "Raw Perms", permissions: { media: ["submit"] } }),
      JSON.stringify({ scopes: ["admin"] }),
      JSON.stringify({ expiresIn: 12.5 }),
    ]) {
      const res = await app.fetch(
        new Request(`${TEST_BASE_URL}/mediaref.internal.v1.AccountService/CreateApiKey`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: user.cookie },
          body: badBody,
        }),
      );
      expect(res.status).toBe(400);
    }

    // Domain-level validation errors return structured ConnectError codes.
    const userRpc = createRpcClients(app, { cookie: user.cookie });
    const invalidRpcCases: Array<{
      input: Parameters<typeof userRpc.account.createApiKey>[0];
      expectedCode: string;
    }> = [
      { input: { name: "   " }, expectedCode: "INVALID_NAME" },
      { input: { name: "a".repeat(65) }, expectedCode: "INVALID_NAME" },
      {
        input: { scopes: [internalProto.ApiKeyScope.UNSPECIFIED] },
        expectedCode: "INVALID_PERMISSIONS",
      },
      {
        input: {
          canSubmit: false,
          scopes: [internalProto.ApiKeyScope.READ_REPORT, internalProto.ApiKeyScope.SUBMIT],
        },
        expectedCode: "INVALID_PERMISSIONS",
      },
      { input: { expiresIn: 0 }, expectedCode: "INVALID_EXPIRES_IN" },
      { input: { expiresIn: 400 * 86_400 }, expectedCode: "INVALID_EXPIRES_IN" },
    ];

    for (const testCase of invalidRpcCases) {
      const err = await expectRpcError(userRpc.account.createApiKey(testCase.input));
      expect(err.status).toBe(400);
      expect(err.code).toBe(testCase.expectedCode);
    }
  });

  test("default Cloudflare Worker fetch entrypoint verifies API keys with X-API-Key header and CORS support", async () => {
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
      email: "worker-key@example.com",
      password: "StrongPassword123!",
      name: "Worker Key Dev",
      verify: true,
    });

    const created = await createRpcClients(app, { cookie: user.cookie }).account.createApiKey({
      name: "Worker Key",
    });

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

    let observedCorsOrigin: string | null = null;
    const workerEnv = {
      HYPERDRIVE_READ: hyperdrive,
      HYPERDRIVE_WRITE: hyperdrive,
      AUTH_SECRET: TEST_AUTH_SECRET,
      API_BASE_URL: TEST_BASE_URL,
      COOKIE_DOMAIN: "mediaref.org",
    };

    const workerRpc = createRpcClients(
      async (req) => {
        const res = await worker.fetch(req, workerEnv, ctx);
        observedCorsOrigin = res.headers.get("access-control-allow-origin");
        return res;
      },
      {
        apiKey: created.key,
        headers: { origin: "https://mediaref.org" },
      },
    );

    const me = await workerRpc.apiKey.getCurrentApiKey({});
    await Promise.all(pending);

    expect(observedCorsOrigin).toBe("https://mediaref.org");
    expect(me).toMatchObject({
      keyId: created.apiKey!.id,
      userId: user.userId,
      canSubmit: false,
    });
  });
});
