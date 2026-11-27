import { mergeMedia, verifyAndAutoMergeDuplicateMedia } from "@media-ref/core";
import { createTestDb } from "@media-ref/db/testing";
import { expect, onTestFinished, test } from "vite-plus/test";

test.each(["seed_unconfirmed", "delisted"] as const)(
  "checks the promoted %s platform scope before merging media or coalescing variants",
  async (status) => {
    const handle = await createTestDb();
    onTestFinished(() => handle.cleanup());
    const db = handle.writeDb;
    const media = { type: "tv", title: "同一部剧", year: 2026 } as const;
    const createMedia = (baseline: "tmdb" | "douban") =>
      db
        .insertInto("media")
        .values({ ...media, baseline })
        .returning("id")
        .executeTakeFirstOrThrow();
    const target = await createMedia("tmdb");
    const source = await createMedia("douban");
    const variant = (media_id: string, description: string) =>
      db
        .insertInto("variants")
        .values({ media_id, platform: "tencent", description })
        .returning("id")
        .executeTakeFirstOrThrow();
    const standard = await variant(target.id, "standard");
    const alternate = await variant(source.id, "alternate");
    const incomingStandard = await variant(source.id, "standard");
    const rows = await db
      .insertInto("associations")
      .values([
        {
          media_id: target.id,
          variant_id: standard.id,
          namespace: "tencent",
          native_id: "shared",
          status,
        },
        {
          media_id: source.id,
          variant_id: alternate.id,
          namespace: "tencent",
          native_id: "shared",
          status: "confirmed",
        },
        {
          media_id: target.id,
          variant_id: standard.id,
          namespace: "tencent",
          native_id: "sibling",
          status: "confirmed",
        },
      ])
      .returning(["id", "media_id", "native_id"])
      .execute();
    await db
      .insertInto("segments")
      .values(
        rows.map((r) => ({
          association_id: r.id,
          season: r.media_id === target.id && r.native_id === "shared" ? 1 : 2,
          episode_start: 1,
          episode_end: 10,
          target_episode_start: 1,
          baseline: "tmdb" as const,
        })),
      )
      .execute();
    const merge = () =>
      verifyAndAutoMergeDuplicateMedia(db, {
        mediaIdA: source.id,
        mediaIdB: target.id,
        actorUserId: null,
        reason: "platform variant coverage",
      });
    expect(await merge()).toMatchObject({
      merged: false,
      blockReason: `conflicting_variant:${standard.id}`,
    });
    await expect(
      mergeMedia(db, { sourceMediaId: source.id, targetMediaId: target.id, actorUserId: null }),
    ).rejects.toMatchObject({ code: "SEGMENT_OVERLAP", status: 409 });
    expect(
      await db
        .selectFrom("media")
        .select("merged_into_media_id")
        .where("id", "=", source.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ merged_into_media_id: null });

    // On a separate source variant, the sibling is safe unless the writer coalesces it into standard.
    await db
      .updateTable("associations")
      .set({ media_id: source.id, variant_id: incomingStandard.id })
      .where("native_id", "=", "sibling")
      .execute();
    expect(await merge()).toMatchObject({ merged: true, targetMediaId: target.id });
    expect(
      await db
        .selectFrom("associations as a")
        .innerJoin("segments as s", "a.id", "s.association_id")
        .select(["a.native_id", "a.variant_id", "s.season"])
        .where("a.media_id", "=", target.id)
        .where("a.status", "=", "confirmed")
        .orderBy("a.native_id")
        .execute(),
    ).toEqual([
      { native_id: "shared", variant_id: standard.id, season: 2 },
      { native_id: "sibling", variant_id: incomingStandard.id, season: 2 },
    ]);
  },
);
