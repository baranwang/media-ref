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
