import { enqueueTmdbLookupDemands } from "@media-ref/core";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, describe, expect, test } from "vite-plus/test";

describe("enqueueTmdbLookupDemands", () => {
  const handles: TestDbHandle[] = [];
  afterEach(async () => {
    while (handles.length > 0) {
      await handles.pop()?.cleanup();
    }
  });

  test("gives media without a TMDB external ID one catalog demand, once", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);
    const db = testDb.writeDb;
    const now = new Date("2026-11-27T12:00:00.000Z");

    const insertMedia = (values: {
      type: "tv" | "movie";
      baseline: "douban" | "tmdb";
      title: string;
    }) =>
      db
        .insertInto("media")
        .values({
          ...values,
          year: 2026,
          seasons: JSON.stringify(
            values.type === "tv"
              ? [
                  { season: 0, episodeCount: 2, airYear: 2026 },
                  { season: 1, episodeCount: 26, airYear: 2026 },
                ]
              : [],
          ),
        })
        .returning("id")
        .executeTakeFirstOrThrow();

    const doubanTv = await insertMedia({ type: "tv", baseline: "douban", title: "两京十五日" });
    const doubanMovie = await insertMedia({ type: "movie", baseline: "douban", title: "电影" });
    const withTmdb = await insertMedia({ type: "tv", baseline: "douban", title: "已补上 TMDB" });
    await db
      .insertInto("associations")
      .values({
        media_id: withTmdb.id,
        namespace: "tmdb",
        native_id: "tv:1",
        status: "confirmed",
        is_external_id: true,
        source: "sync",
      })
      .execute();
    // A media that already has a catalog demand is left alone.
    // TMDB-baseline media always carry the ID; they are not swept even if it is missing.
    await insertMedia({ type: "tv", baseline: "tmdb", title: "TMDB 起步" });
    const alreadyAsked = await insertMedia({ type: "tv", baseline: "douban", title: "已有需求" });
    await db
      .insertInto("demands")
      .values({
        media_id: alreadyAsked.id,
        season: 1,
        namespace_group: "catalog",
        status: "not_found",
      })
      .execute();

    expect(await enqueueTmdbLookupDemands(db, { now })).toBe(2);
    const demands = await db
      .selectFrom("demands")
      .select(["media_id", "season", "namespace_group", "status", "next_eligible_at"])
      .where("media_id", "in", [doubanTv.id, doubanMovie.id, withTmdb.id])
      .orderBy("season")
      .execute();
    expect(demands).toEqual([
      {
        media_id: doubanTv.id,
        season: 1,
        namespace_group: "catalog",
        status: "open",
        next_eligible_at: now,
      },
      {
        media_id: doubanMovie.id,
        season: null,
        namespace_group: "catalog",
        status: "open",
        next_eligible_at: now,
      },
    ]);

    expect(await enqueueTmdbLookupDemands(db, { now })).toBe(0);
  });
});
