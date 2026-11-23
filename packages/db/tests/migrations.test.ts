import { afterEach, describe, expect, test } from "vite-plus/test";
import { runMigrations } from "../src/index.ts";
import { createTestDb, type TestDbHandle } from "../src/testing.ts";

describe("packages/db migrations", () => {
  const handles: TestDbHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop();
      if (handle) {
        await handle.cleanup();
      }
    }
  });

  test("runs all migrations from scratch on an empty PostgreSQL 19 database", async () => {
    const testDb = await createTestDb({ migrate: false });
    handles.push(testDb);

    const results = await runMigrations(testDb.writeDb);

    expect(results).toEqual([
      {
        migrationName: "0001_initial",
        direction: "Up",
        status: "Success",
      },
      {
        migrationName: "0002_auth",
        direction: "Up",
        status: "Success",
      },
      {
        migrationName: "0003_background_jobs",
        direction: "Up",
        status: "Success",
      },
      {
        migrationName: "0004_api_keys",
        direction: "Up",
        status: "Success",
      },
    ]);

    const row = await testDb.readDb
      .selectFrom("schema_meta")
      .select(["key", "value"])
      .where("key", "=", "bootstrap_version")
      .executeTakeFirst();

    expect(row).toEqual({
      key: "bootstrap_version",
      value: "0001_initial",
    });

    const now = new Date();
    await testDb.writeDb
      .insertInto("user")
      .values({
        id: "user_1",
        name: "Test Developer",
        email: "dev@mediaref.org",
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      })
      .execute();

    await testDb.writeDb
      .insertInto("session")
      .values({
        id: "sess_1",
        userId: "user_1",
        token: "tok_1",
        expiresAt: new Date(now.getTime() + 60_000),
        createdAt: now,
        updatedAt: now,
      })
      .execute();

    await testDb.writeDb
      .insertInto("account")
      .values({
        id: "acc_1",
        userId: "user_1",
        accountId: "user_1",
        providerId: "credential",
        password: "hashed-password",
        createdAt: now,
        updatedAt: now,
      })
      .execute();

    await testDb.writeDb
      .insertInto("verification")
      .values({
        id: "ver_1",
        identifier: "dev@mediaref.org",
        value: "token-value",
        expiresAt: new Date(now.getTime() + 60_000),
        createdAt: now,
        updatedAt: now,
      })
      .execute();

    await testDb.writeDb
      .insertInto("apikey")
      .values({
        id: "key_1",
        configId: "default",
        name: "CLI Key",
        start: "mref_abcdef",
        referenceId: "user_1",
        prefix: "mref_",
        key: "hashed-key-digest",
        enabled: true,
        rateLimitEnabled: false,
        requestCount: 0,
        expiresAt: null,
        createdAt: now,
        updatedAt: now,
        permissions: JSON.stringify({ media: ["read", "report"] }),
      })
      .execute();

    const apiKeyRow = await testDb.readDb
      .selectFrom("apikey")
      .select(["id", "configId", "referenceId", "key", "enabled", "permissions"])
      .where("key", "=", "hashed-key-digest")
      .executeTakeFirst();

    expect(apiKeyRow).toEqual({
      id: "key_1",
      configId: "default",
      referenceId: "user_1",
      key: "hashed-key-digest",
      enabled: true,
      permissions: JSON.stringify({ media: ["read", "report"] }),
    });

    const userRow = await testDb.readDb
      .selectFrom("user")
      .select(["id", "email", "emailVerified", "role"])
      .where("id", "=", "user_1")
      .executeTakeFirst();

    expect(userRow).toEqual({
      id: "user_1",
      email: "dev@mediaref.org",
      emailVerified: false,
      role: "user",
    });

    const insertedJob = await testDb.writeDb
      .insertInto("background_jobs")
      .values({
        job_type: "echo",
        dedupe_key: "test:unique",
        status: "pending",
        payload: JSON.stringify({ hello: "world" }),
      })
      .returning([
        "id",
        "job_type",
        "status",
        "priority",
        "attempts",
        "max_attempts",
        "lease_generation",
      ])
      .executeTakeFirstOrThrow();

    expect(insertedJob).toMatchObject({
      job_type: "echo",
      status: "pending",
      priority: 0,
      attempts: 0,
      max_attempts: 5,
      lease_generation: 0,
    });

    // Active dedupe_key prevents duplicate active jobs
    await expect(
      testDb.writeDb
        .insertInto("background_jobs")
        .values({
          job_type: "echo",
          dedupe_key: "test:unique",
          status: "pending",
        })
        .execute(),
    ).rejects.toThrow();

    // Completing the job frees the partial unique index for future re-scheduling
    await testDb.writeDb
      .updateTable("background_jobs")
      .set({ status: "completed", completed_at: new Date() })
      .where("id", "=", insertedJob.id)
      .execute();

    const rescheduled = await testDb.writeDb
      .insertInto("background_jobs")
      .values({
        job_type: "echo",
        dedupe_key: "test:unique",
        status: "pending",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    expect(rescheduled.id).not.toBe(insertedJob.id);

    const rerunResults = await runMigrations(testDb.writeDb);
    expect(rerunResults).toEqual([]);
  });

  test("createTestDb provisions an already-migrated ephemeral database by default", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const row = await testDb.readDb
      .selectFrom("schema_meta")
      .select(["key", "value"])
      .where("key", "=", "bootstrap_version")
      .executeTakeFirst();

    expect(row).toEqual({
      key: "bootstrap_version",
      value: "0001_initial",
    });
  });
});
