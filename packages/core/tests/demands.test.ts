import { describe, expect, test } from "vite-plus/test";
import { createTestDb } from "@media-ref/db/testing";
import {
  computeDemandTargetsForRead,
  mergeExternalKeyDemandsIntoMedia,
  missingListedPlatforms,
  scheduleExplorationJobs,
} from "../src/index.ts";
import type { QueryMediaByKeyResult } from "../src/read-media.ts";

// Only the fields demand targeting reads.
function readResult(
  externalIds: Array<{ namespace: string; nativeId: string }>,
): QueryMediaByKeyResult {
  return {
    kind: "ok",
    key: "douban:1292000",
    items: [
      {
        document: {
          media: { id: "m1", type: "movie", snapshot: { seasons: [] } },
          externalIds,
          associations: [
            {
              namespace: "douban",
              nativeId: "1292000",
              status: "confirmed",
              unconfirmed: false,
              segments: [],
            },
          ],
        },
        matchedAssociationId: null,
      },
    ],
  } as unknown as QueryMediaByKeyResult;
}

describe("catalog-group demand", () => {
  test("a Douban association without the TMDB external ID is still a gap", () => {
    const targets = computeDemandTargetsForRead({
      rawKey: "douban:1292000",
      queryResult: readResult([{ namespace: "imdb", nativeId: "tt0137523" }]),
      namespaceGroup: "catalog",
    });
    expect(targets).toEqual([
      { kind: "media", mediaId: "m1", season: null, namespaceGroup: "catalog", delta: 1 },
    ]);
  });

  test("with the TMDB external ID the media is covered", () => {
    expect(
      computeDemandTargetsForRead({
        rawKey: "douban:1292000",
        queryResult: readResult([{ namespace: "tmdb", nativeId: "movie:550" }]),
        namespaceGroup: "catalog",
      }),
    ).toEqual([]);
  });
});

describe("platform coverage with a Douban subject (#130)", () => {
  const row = (namespace: string, seasons: number[], listedPlatforms: string[] | null = null) => ({
    namespace,
    seasons,
    listedPlatforms,
  });

  test("no platform covering the season wants every platform", () => {
    expect(missingListedPlatforms([row("douban", [4], ["tencent", "iqiyi"])], 4)).toBeNull();
  });

  test("a covered season still wants the platforms its Douban subject lists", () => {
    const rows = [row("douban", [4], ["tencent", "iqiyi"]), row("tencent", [4])];
    expect(missingListedPlatforms(rows, 4)).toEqual(["iqiyi"]);
    expect(missingListedPlatforms([...rows, row("iqiyi", [4])], 4)).toEqual([]);
  });

  test("another season's subject, an unfetched list and unknown vendors add nothing", () => {
    expect(missingListedPlatforms([row("douban", [3], ["iqiyi"]), row("tencent", [4])], 4)).toEqual(
      [],
    );
    expect(missingListedPlatforms([row("douban", [4], null), row("tencent", [4])], 4)).toEqual([]);
    expect(missingListedPlatforms([row("douban", [4], ["sohu"]), row("tencent", [4])], 4)).toEqual(
      [],
    );
  });

  test("a read of a season Douban says is also on iQIYI records a demand", () => {
    const queryResult = {
      kind: "ok",
      key: "tmdb:tv:68809",
      items: [
        {
          document: {
            media: { id: "m1", type: "tv", snapshot: { seasons: [] } },
            externalIds: [],
            associations: [
              {
                namespace: "douban",
                status: "confirmed",
                segments: [{ season: 4 }],
                listedPlatforms: ["tencent", "iqiyi"],
              },
              { namespace: "tencent", status: "confirmed", segments: [{ season: 4 }] },
            ],
          },
          matchedAssociationId: null,
        },
      ],
    } as unknown as QueryMediaByKeyResult;
    expect(
      computeDemandTargetsForRead({ rawKey: "tmdb:tv:68809", queryResult, season: 4 }),
    ).toEqual([{ kind: "media", mediaId: "m1", season: 4, namespaceGroup: "platform", delta: 1 }]);
  });
});

describe("external-key demand merge", () => {
  test.each(["leased", "invalid_key"] as const)(
    "opens every season of a %s external-key demand immediately",
    async (status) => {
      const handle = await createTestDb();
      try {
        const db = handle.writeDb;
        const now = new Date("2026-11-23T12:00:00Z");
        const later = new Date("2026-12-23T12:00:00Z");
        const media = await db
          .insertInto("media")
          .values({ type: "tv", title: "Season merge", baseline: "tmdb" })
          .returning("id")
          .executeTakeFirstOrThrow();
        await db
          .insertInto("demands")
          .values({
            external_key: "tmdb:tv:123",
            namespace_group: "platform",
            status,
            lease_expires_at: status === "leased" ? later : null,
            next_eligible_at: later,
            demand_count: 3,
          })
          .execute();
        const result = await mergeExternalKeyDemandsIntoMedia(db, {
          mediaId: media.id,
          externalKeys: ["tmdb:tv:123"],
          seasons: [1, 2],
          mediaType: "tv",
          now,
        });
        expect(result.mergedSourceCount).toBe(1);
        expect(result.demands).toMatchObject(
          [1, 2].map((season) => ({
            season,
            mediaId: media.id,
            status: "open",
            demandCount: 3,
            nextEligibleAt: now.toISOString(),
            leaseExpiresAt: null,
          })),
        );
      } finally {
        await handle.cleanup();
      }
    },
  );

  test("keeps the merged demand's change requests linked to the new media demand", async () => {
    const handle = await createTestDb();
    try {
      const db = handle.writeDb;
      const media = await db
        .insertInto("media")
        .values({ type: "movie", title: "Linked merge", baseline: "douban" })
        .returning("id")
        .executeTakeFirstOrThrow();
      const source = await db
        .insertInto("demands")
        .values({ external_key: "douban:1292000", namespace_group: "platform", status: "leased" })
        .returning("id")
        .executeTakeFirstOrThrow();
      await db
        .insertInto("user")
        .values({
          id: "submitter",
          name: "Submitter",
          email: "s@example.test",
          emailVerified: true,
        })
        .execute();
      const cr = await db
        .insertInto("change_requests")
        .values({
          status: "needs_review",
          submitter_user_id: "submitter",
          submitter_key_id: null,
          task_id: null,
          demand_id: source.id,
          media_id: null,
          target_external_key: "douban:1292000",
          namespace: "iqiyi",
          raw_native_id: "a_1",
          native_id: "a_1",
          variant_id: null,
          variant_description: null,
          segments: JSON.stringify([]),
          evidence: null,
          conflict_reason: null,
          decision_reason: null,
          reviewer_user_id: null,
          reviewed_at: null,
          applied_association_id: null,
          applied_revision_id: null,
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      const result = await mergeExternalKeyDemandsIntoMedia(db, {
        mediaId: media.id,
        externalKeys: ["douban:1292000"],
        mediaType: "movie",
      });
      expect(result.demands).toHaveLength(1);
      const linked = await db
        .selectFrom("change_requests")
        .select("demand_id")
        .where("id", "=", cr.id)
        .executeTakeFirstOrThrow();
      expect(linked.demand_id).toBe(result.demands[0]!.id);
      expect(
        await db.selectFrom("demands").select("id").where("id", "=", source.id).execute(),
      ).toEqual([]);
    } finally {
      await handle.cleanup();
    }
  });

  test("the scheduler recovers a media demand merged before lease normalization", async () => {
    const handle = await createTestDb();
    try {
      const db = handle.writeDb;
      const media = await db
        .insertInto("media")
        .values({ type: "movie", title: "Legacy merge", baseline: "tmdb" })
        .returning("id")
        .executeTakeFirstOrThrow();
      const demand = await db
        .insertInto("demands")
        .values({
          media_id: media.id,
          namespace_group: "platform",
          status: "leased",
          lease_expires_at: null,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const scheduled = await scheduleExplorationJobs(db);
      expect(scheduled.jobs).toMatchObject([
        { payload: { demandId: demand.id, demandLeaseGeneration: 1 } },
      ]);
    } finally {
      await handle.cleanup();
    }
  });
});
