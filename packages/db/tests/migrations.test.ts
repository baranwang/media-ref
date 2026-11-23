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

  test("runs initial migration from scratch on an empty PostgreSQL 19 database", async () => {
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
        migrationName: "0003_background_jobs",
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
