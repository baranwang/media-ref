import { retryFailedSeedEvidenceChecks, SEED_EVIDENCE_CHECK_JOB_TYPE } from "@media-ref/core";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, describe, expect, test } from "vite-plus/test";

describe("retryFailedSeedEvidenceChecks", () => {
  const handles: TestDbHandle[] = [];
  afterEach(async () => {
    while (handles.length > 0) {
      await handles.pop()?.cleanup();
    }
  });

  test("requeues a failed check a day later, only while its seed is still unchecked", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);
    const db = testDb.writeDb;
    const failedAt = new Date("2026-11-25T18:36:46.000Z");

    const media = await db
      .insertInto("media")
      .values({
        type: "tv",
        baseline: "tmdb",
        title: "两京十五日",
        year: 2026,
        seasons: JSON.stringify([{ season: 1, episodeCount: 26, airYear: 2026 }]),
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const seed = async (
      nativeId: string,
      status: "seed_unconfirmed" | "confirmed",
      locked = false,
    ) =>
      db
        .insertInto("associations")
        .values({ media_id: media.id, namespace: "douban", native_id: nativeId, status, locked })
        .returning("id")
        .executeTakeFirstOrThrow();
    const failedJob = async (associationId: string, updatedAt = failedAt) =>
      db
        .insertInto("background_jobs")
        .values({
          job_type: SEED_EVIDENCE_CHECK_JOB_TYPE,
          dedupe_key: `${SEED_EVIDENCE_CHECK_JOB_TYPE}:${associationId}`,
          status: "failed",
          payload: JSON.stringify({ associationId, mediaId: media.id }),
          attempts: 5,
          error_message: "http_500",
          completed_at: updatedAt,
          updated_at: updatedAt,
        })
        .returning("id")
        .executeTakeFirstOrThrow();

    const due = await failedJob((await seed("35235320", "seed_unconfirmed")).id);
    const alreadyConfirmed = await failedJob((await seed("1", "confirmed")).id);
    const locked = await failedJob((await seed("2", "seed_unconfirmed", true)).id);

    // Within a day of the failure nothing is requeued.
    expect(
      await retryFailedSeedEvidenceChecks(db, { now: new Date("2026-11-26T12:00:00.000Z") }),
    ).toBe(0);

    const now = new Date("2026-11-27T12:00:00.000Z");
    expect(await retryFailedSeedEvidenceChecks(db, { now })).toBe(1);
    const jobs = await db
      .selectFrom("background_jobs")
      .select(["id", "status", "attempts", "run_after", "error_message"])
      .where("id", "in", [due.id, alreadyConfirmed.id, locked.id])
      .execute();
    const byId = new Map(jobs.map((j) => [j.id, j]));
    expect(byId.get(due.id)).toMatchObject({
      status: "pending",
      attempts: 0,
      run_after: now,
      error_message: null,
    });
    expect(byId.get(alreadyConfirmed.id)?.status).toBe("failed");
    expect(byId.get(locked.id)?.status).toBe("failed");

    // A requeued job is pending, so a second sweep leaves it alone.
    expect(await retryFailedSeedEvidenceChecks(db, { now })).toBe(0);
  });
});
