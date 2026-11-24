import { create } from "@bufbuild/protobuf";
import {
  fromProtoBatchItemResult,
  fromProtoMediaDocument,
  fromProtoMediaQueryItem,
  fromProtoMediaRef,
  proto,
  resolveEpisode,
} from "@media-ref/client";
import { createFakeOutboundClient, type ExternalHttpRequest } from "@media-ref/core";
import { createDb } from "@media-ref/db";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { createApiApp } from "../src/lib.ts";
import {
  createRpcClients,
  expectRpcError,
  issueApiKeyRpc,
  mediaRef,
  signUpUser,
  TEST_BASE_URL,
} from "./rpc-helpers.ts";

const TEST_AUTH_SECRET = "test-secret-for-media-ref-read-api-integration-tests-0123456789";

function createReadOnlyDb(connectionString: string) {
  const readOnlyUrl = new URL(connectionString);
  readOnlyUrl.searchParams.set("options", "-c default_transaction_read_only=on");
  return createDb(readOnlyUrl.toString());
}

function createCatalogStubHandler() {
  return (request: ExternalHttpRequest) => {
    if (request.kind === "catalog" && request.namespace === "tmdb") {
      if (request.url.includes("/tv/95479")) {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          url: request.url,
          body: JSON.stringify({
            id: 95479,
            name: "咒术回战",
            original_name: "呪術廻戦",
            first_air_date: "2020-10-03",
            seasons: [{ season_number: 1, episode_count: 47, air_date: "2020-10-03" }],
            external_ids: {
              imdb_id: "tt12343534",
              tvdb_id: 377543,
            },
          }),
        };
      }
      return {
        status: 404,
        headers: { "content-type": "application/json" },
        url: request.url,
        body: JSON.stringify({ status_code: 34, status_message: "Not found" }),
      };
    }

    if (request.kind === "catalog" && request.namespace === "trakt") {
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        url: request.url,
        body: "[]",
      };
    }

    throw new Error(
      `Unexpected outbound request: ${request.kind}:${request.namespace} ${request.url}`,
    );
  };
}

describe("API Worker extended read API (#18)", () => {
  const handles: TestDbHandle[] = [];
  const extraDbs: Array<{ destroy: () => Promise<void> }> = [];

  afterEach(async () => {
    while (extraDbs.length > 0) {
      const db = extraDbs.pop();
      if (db) {
        await db.destroy();
      }
    }
    while (handles.length > 0) {
      const handle = handles.pop();
      if (handle) {
        await handle.cleanup();
      }
    }
  });

  test("returns all three platform statuses (associated, not_found with checkedAt, unchecked) on strict read-only dbRead", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);
    const readOnlyDb = createReadOnlyDb(testDb.connectionString);
    extraDbs.push(readOnlyDb);

    const outbound = createFakeOutboundClient({
      fetchExternal: createCatalogStubHandler(),
    });
    const app = createApiApp({
      dbRead: readOnlyDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });

    const user = await signUpUser(app, outbound, {
      email: "reader-status@example.com",
      password: "StrongPassword123!",
      name: "Reader",
      verify: true,
    });
    const readKey = await issueApiKeyRpc(app, user.cookie, {
      name: "Read Only Key",
      canSubmit: false,
    });
    const readRpc = createRpcClients(app, { apiKey: readKey.key });

    const media = await testDb.writeDb
      .insertInto("media")
      .values({
        type: "tv",
        baseline: "tmdb",
        title: "咒术回战",
        original_title: "呪術廻戦",
        year: 2020,
        seasons: JSON.stringify([{ season: 1, episodeCount: 47, airYear: 2020 }]),
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await testDb.writeDb
      .insertInto("associations")
      .values({
        status: "confirmed",
        is_external_id: true,
        media_id: media.id,
        namespace: "tmdb",
        native_id: "tv:95479",
      })
      .execute();

    // bilibili: confirmed association (even with a stale platform_checks row, associated must win)
    const biliVariant = await testDb.writeDb
      .insertInto("variants")
      .values({
        media_id: media.id,
        platform: "bilibili",
        description: "原声",
        is_default: true,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await testDb.writeDb
      .insertInto("associations")
      .values({
        media_id: media.id,
        namespace: "bilibili",
        native_id: "ss34430",
        variant_id: biliVariant.id,
        status: "confirmed",
      })
      .execute();

    // youku: only a seed_unconfirmed association (must NOT count as associated)
    const youkuVariant = await testDb.writeDb
      .insertInto("variants")
      .values({
        media_id: media.id,
        platform: "youku",
        description: "原声",
        is_default: true,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await testDb.writeDb
      .insertInto("associations")
      .values({
        media_id: media.id,
        namespace: "youku",
        native_id: "yk-seed-1",
        variant_id: youkuVariant.id,
        status: "seed_unconfirmed",
      })
      .execute();

    // mgtv: only a delisted association + platform_checks not_found -> must be not_found with checkedAt
    const mgtvVariant = await testDb.writeDb
      .insertInto("variants")
      .values({
        media_id: media.id,
        platform: "mgtv",
        description: "原声",
        is_default: true,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await testDb.writeDb
      .insertInto("associations")
      .values({
        media_id: media.id,
        namespace: "mgtv",
        native_id: "mgtv-old-1",
        variant_id: mgtvVariant.id,
        status: "delisted",
      })
      .execute();

    const iqiyiCheckedAt = new Date("2026-11-20T08:30:00.000Z");
    const mgtvCheckedAt = new Date("2026-11-21T09:45:00.000Z");
    await testDb.writeDb
      .insertInto("platform_checks")
      .values([
        {
          media_id: media.id,
          platform: "bilibili",
          status: "not_found",
          checked_at: new Date("2026-11-19T00:00:00.000Z"),
        },
        {
          media_id: media.id,
          platform: "iqiyi",
          status: "not_found",
          checked_at: iqiyiCheckedAt,
        },
        {
          media_id: media.id,
          platform: "mgtv",
          status: "not_found",
          checked_at: mgtvCheckedAt,
        },
      ])
      .execute();

    const body = await readRpc.media.getMedia({
      ref: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
    });
    const doc = fromProtoMediaDocument(body.document!);

    expect(fromProtoMediaRef(body.ref)).toMatchObject({
      ok: true,
      ref: { tmdb: { type: "tv", id: 95479 } },
      key: "tmdb:tv:95479",
    });
    expect(body.matchedAssociationId).toBeUndefined();
    expect(body.items).toHaveLength(1);
    expect(doc.platformStatuses).toEqual({
      bilibili: { status: "associated" },
      iqiyi: { status: "not_found", checkedAt: "2026-11-20T08:30:00.000Z" },
      mgtv: { status: "not_found", checkedAt: "2026-11-21T09:45:00.000Z" },
      tencent: { status: "unchecked" },
      youku: { status: "unchecked" },
    });
  });

  test("reverse lookup returns all media sharing a platform collection and deduplicates merged_into_media_id redirects", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);
    const readOnlyDb = createReadOnlyDb(testDb.connectionString);
    extraDbs.push(readOnlyDb);

    const outbound = createFakeOutboundClient({
      fetchExternal: createCatalogStubHandler(),
    });
    const app = createApiApp({
      dbRead: readOnlyDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });

    const user = await signUpUser(app, outbound, {
      email: "reader-reverse@example.com",
      password: "StrongPassword123!",
      name: "Reader Reverse",
      verify: true,
    });
    const readKey = await issueApiKeyRpc(app, user.cookie, {
      name: "Read Reverse Key",
      canSubmit: false,
    });
    const readRpc = createRpcClients(app, { apiKey: readKey.key });

    // Two distinct canonical media sharing one Bilibili collection ss99999 (disjoint target episode ranges)
    const mediaA = await testDb.writeDb
      .insertInto("media")
      .values({
        type: "tv",
        baseline: "tmdb",
        title: "第一部",
        original_title: "Part One",
        year: 2021,
        seasons: JSON.stringify([{ season: 1, episodeCount: 12, airYear: 2021 }]),
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const mediaB = await testDb.writeDb
      .insertInto("media")
      .values({
        type: "tv",
        baseline: "tmdb",
        title: "第二部",
        original_title: "Part Two",
        year: 2022,
        seasons: JSON.stringify([{ season: 1, episodeCount: 12, airYear: 2022 }]),
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    // A third media row merged into mediaA to verify redirect + deduplication
    const mergedIntoA = await testDb.writeDb
      .insertInto("media")
      .values({
        type: "tv",
        baseline: "tmdb",
        title: "第一部（旧）",
        original_title: "Part One Legacy",
        year: 2021,
        seasons: JSON.stringify([{ season: 1, episodeCount: 12, airYear: 2021 }]),
        merged_into_media_id: mediaA.id,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await testDb.writeDb
      .insertInto("associations")
      .values([
        {
          status: "confirmed",
          is_external_id: true,
          media_id: mediaA.id,
          namespace: "tmdb",
          native_id: "tv:1001",
        },
        {
          status: "confirmed",
          is_external_id: true,
          media_id: mediaB.id,
          namespace: "tmdb",
          native_id: "tv:1002",
        },
        {
          status: "confirmed",
          is_external_id: true,
          media_id: mergedIntoA.id,
          namespace: "imdb",
          native_id: "tt9991001",
        },
      ])
      .execute();

    const [varA, varB, varMerged] = await Promise.all([
      testDb.writeDb
        .insertInto("variants")
        .values({
          media_id: mediaA.id,
          platform: "bilibili",
          description: "原声",
          is_default: true,
        })
        .returning("id")
        .executeTakeFirstOrThrow(),
      testDb.writeDb
        .insertInto("variants")
        .values({
          media_id: mediaB.id,
          platform: "bilibili",
          description: "原声",
          is_default: true,
        })
        .returning("id")
        .executeTakeFirstOrThrow(),
      testDb.writeDb
        .insertInto("variants")
        .values({
          media_id: mergedIntoA.id,
          platform: "bilibili",
          description: "原声",
          is_default: true,
        })
        .returning("id")
        .executeTakeFirstOrThrow(),
    ]);

    const assocA = await testDb.writeDb
      .insertInto("associations")
      .values({
        media_id: mediaA.id,
        namespace: "bilibili",
        native_id: "ss99999",
        variant_id: varA.id,
        status: "confirmed",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const assocB = await testDb.writeDb
      .insertInto("associations")
      .values({
        media_id: mediaB.id,
        namespace: "bilibili",
        native_id: "ss99999",
        variant_id: varB.id,
        status: "confirmed",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    // Legacy association on mergedIntoA referencing the same collection must deduplicate into mediaA
    await testDb.writeDb
      .insertInto("associations")
      .values({
        media_id: mergedIntoA.id,
        namespace: "bilibili",
        native_id: "ss99999",
        variant_id: varMerged.id,
        status: "confirmed",
      })
      .execute();

    await testDb.writeDb
      .insertInto("segments")
      .values([
        {
          association_id: assocA.id,
          season: 1,
          episode_start: 1,
          episode_end: 12,
          target_episode_start: 1,
          baseline: "tmdb",
        },
        {
          association_id: assocB.id,
          season: 1,
          episode_start: 1,
          episode_end: 12,
          target_episode_start: 13,
          baseline: "tmdb",
        },
      ])
      .execute();

    const reverseBody = await readRpc.media.getMedia({
      ref: mediaRef({ platform: { platform: "bilibili", nativeId: "ss99999" } }),
    });
    const reverseItems = reverseBody.items.map(fromProtoMediaQueryItem);

    expect(fromProtoMediaRef(reverseBody.ref)).toMatchObject({
      ok: true,
      ref: { platform: { platform: "bilibili", nativeId: "ss99999" } },
      key: "bilibili:ss99999",
    });
    expect(reverseItems).toHaveLength(2);
    expect(reverseItems.map((item) => item.document.media.id)).toEqual([mediaA.id, mediaB.id]);
    expect(reverseItems[0]?.matchedAssociationId).toBe(assocA.id);
    expect(reverseItems[0]?.document.matchedAssociationIds).toEqual([assocA.id]);
    expect(reverseItems[1]?.matchedAssociationId).toBe(assocB.id);
    expect(reverseItems[1]?.document.matchedAssociationIds).toEqual([assocB.id]);
    // Backwards-compatible top-level fields mirror items[0]
    expect(reverseBody.document?.media?.id).toBe(mediaA.id);
    expect(reverseBody.matchedAssociationId).toBe(assocA.id);

    // Direct lookup by merged media UUID and legacy external ID redirects to canonical mediaA
    const byOldUuidBody = await readRpc.media.getMedia({
      ref: mediaRef({ mediaId: mergedIntoA.id }),
    });
    expect(byOldUuidBody.document?.media?.id).toBe(mediaA.id);
    expect(byOldUuidBody.items).toHaveLength(1);

    const byOldImdbBody = await readRpc.media.getMedia({
      ref: mediaRef({ imdb: "tt9991001" }),
    });
    expect(byOldImdbBody.document?.media?.id).toBe(mediaA.id);
  });

  test("omits unconfirmed content by default, includes seed_unconfirmed + pending_evidence + needs_review with includeUnconfirmed=true, and always excludes rejected and delisted", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);
    const readOnlyDb = createReadOnlyDb(testDb.connectionString);
    extraDbs.push(readOnlyDb);

    const outbound = createFakeOutboundClient({
      fetchExternal: createCatalogStubHandler(),
    });
    const app = createApiApp({
      dbRead: readOnlyDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });

    const user = await signUpUser(app, outbound, {
      email: "reader-unconfirmed@example.com",
      password: "StrongPassword123!",
      name: "Reader Unconfirmed",
      verify: true,
    });
    const readKey = await issueApiKeyRpc(app, user.cookie, {
      name: "Read Unconfirmed Key",
      canSubmit: false,
    });
    const readRpc = createRpcClients(app, { apiKey: readKey.key });

    const media = await testDb.writeDb
      .insertInto("media")
      .values({
        type: "tv",
        baseline: "tmdb",
        title: "咒术回战",
        original_title: "呪術廻戦",
        year: 2020,
        seasons: JSON.stringify([{ season: 1, episodeCount: 47, airYear: 2020 }]),
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await testDb.writeDb
      .insertInto("associations")
      .values({
        status: "confirmed",
        is_external_id: true,
        media_id: media.id,
        namespace: "tmdb",
        native_id: "tv:95479",
      })
      .execute();

    const [biliVariant, youkuVariant, mgtvVariant] = await Promise.all([
      testDb.writeDb
        .insertInto("variants")
        .values({
          media_id: media.id,
          platform: "bilibili",
          description: "原声",
          is_default: true,
        })
        .returning("id")
        .executeTakeFirstOrThrow(),
      testDb.writeDb
        .insertInto("variants")
        .values({
          media_id: media.id,
          platform: "youku",
          description: "原声",
          is_default: true,
        })
        .returning("id")
        .executeTakeFirstOrThrow(),
      testDb.writeDb
        .insertInto("variants")
        .values({
          media_id: media.id,
          platform: "mgtv",
          description: "原声",
          is_default: true,
        })
        .returning("id")
        .executeTakeFirstOrThrow(),
    ]);

    // 1. Confirmed association on bilibili
    const confirmedAssoc = await testDb.writeDb
      .insertInto("associations")
      .values({
        media_id: media.id,
        namespace: "bilibili",
        native_id: "ss34430",
        variant_id: biliVariant.id,
        status: "confirmed",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    // 2. Seed unconfirmed association on youku
    const seedAssoc = await testDb.writeDb
      .insertInto("associations")
      .values({
        media_id: media.id,
        namespace: "youku",
        native_id: "yk-seed-1",
        variant_id: youkuVariant.id,
        status: "seed_unconfirmed",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    // 3. Delisted association on mgtv (must NEVER be returned)
    await testDb.writeDb
      .insertInto("associations")
      .values({
        media_id: media.id,
        namespace: "mgtv",
        native_id: "mgtv-delisted-1",
        variant_id: mgtvVariant.id,
        status: "delisted",
      })
      .execute();

    await testDb.writeDb
      .insertInto("segments")
      .values([
        {
          association_id: confirmedAssoc.id,
          season: 1,
          episode_start: 1,
          episode_end: 24,
          target_episode_start: 1,
          baseline: "tmdb",
        },
        {
          association_id: seedAssoc.id,
          season: 1,
          episode_start: 1,
          episode_end: 24,
          target_episode_start: 1,
          baseline: "tmdb",
        },
      ])
      .execute();

    // 4. pending_evidence CR on iqiyi with a brand-new variantDescription (no persisted iqiyi variant yet)
    const pendingCr = await testDb.writeDb
      .insertInto("change_requests")
      .values({
        status: "pending_evidence",
        submitter_user_id: user.userId,
        media_id: media.id,
        target_external_key: "tmdb:tv:95479",
        namespace: "iqiyi",
        raw_native_id: "iq-pending-1",
        native_id: "iq-pending-1",
        variant_description: "原声",
        segments: JSON.stringify([
          {
            season: 1,
            episodeStart: 1,
            episodeEnd: 24,
            targetEpisodeStart: 1,
            baseline: "tmdb",
            nonLinear: false,
            needsReview: false,
          },
        ]),
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    // 5. needs_review CR on bilibili referencing existing variant, with media_id = null matched via target_external_key
    const needsReviewCr = await testDb.writeDb
      .insertInto("change_requests")
      .values({
        status: "needs_review",
        submitter_user_id: user.userId,
        media_id: null,
        target_external_key: "tmdb:tv:95479",
        namespace: "bilibili",
        raw_native_id: "ss45574",
        native_id: "ss45574",
        variant_description: "原声",
        segments: JSON.stringify([
          {
            season: 1,
            episodeStart: 25,
            episodeEnd: 47,
            targetEpisodeStart: 1,
            baseline: "tmdb",
            nonLinear: false,
            needsReview: false,
          },
        ]),
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    // 6. rejected CR on tencent (must NEVER be returned)
    await testDb.writeDb
      .insertInto("change_requests")
      .values({
        status: "rejected",
        submitter_user_id: user.userId,
        media_id: media.id,
        target_external_key: "tmdb:tv:95479",
        namespace: "tencent",
        raw_native_id: "tc-rejected-1",
        native_id: "tc-rejected-1",
        variant_description: "原声",
        segments: JSON.stringify([]),
      })
      .execute();

    // Default read: ONLY confirmed association
    const defaultDoc = fromProtoMediaDocument(
      (await readRpc.media.getMedia({ ref: mediaRef({ tmdb: { type: "tv", id: 95479 } }) }))
        .document!,
    );
    expect(defaultDoc.associations).toHaveLength(1);
    expect(defaultDoc.associations[0]).toMatchObject({
      id: confirmedAssoc.id,
      namespace: "bilibili",
      nativeId: "ss34430",
      status: "confirmed",
    });
    expect(defaultDoc.associations[0]?.unconfirmed).toBeUndefined();
    expect(defaultDoc.variants.some((v) => v.namespace === "iqiyi")).toBe(false);

    // Explicit includeUnconfirmed=true: returns confirmed + seed_unconfirmed + pending_evidence + needs_review
    const unconfirmedDoc = fromProtoMediaDocument(
      (
        await readRpc.media.getMedia({
          ref: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
          includeUnconfirmed: true,
        })
      ).document!,
    );
    const assocs = unconfirmedDoc.associations;

    expect(assocs).toHaveLength(4);
    expect(assocs.map((a) => a.nativeId)).toEqual(
      expect.arrayContaining(["ss34430", "yk-seed-1", "iq-pending-1", "ss45574"]),
    );
    // Delisted and rejected are strictly excluded even when includeUnconfirmed=true
    expect(assocs.some((a) => a.nativeId === "mgtv-delisted-1")).toBe(false);
    expect(assocs.some((a) => a.nativeId === "tc-rejected-1")).toBe(false);

    const seedEntry = assocs.find((a) => a.id === seedAssoc.id);
    expect(seedEntry).toMatchObject({
      id: seedAssoc.id,
      namespace: "youku",
      nativeId: "yk-seed-1",
      status: "seed_unconfirmed",
      unconfirmed: true,
      unconfirmedSource: "seed_unconfirmed",
    });

    const pendingEntry = assocs.find((a) => a.changeRequestId === pendingCr.id);
    expect(pendingEntry).toMatchObject({
      id: `change-request:${pendingCr.id}`,
      namespace: "iqiyi",
      nativeId: "iq-pending-1",
      unconfirmed: true,
      unconfirmedSource: "change_request",
      changeRequestId: pendingCr.id,
      changeRequestStatus: "pending_evidence",
    });
    expect(pendingEntry?.variantId).toBeTruthy();

    // Synthetic iqiyi variant is added so clients can inspect & resolve episodes against it
    const iqiyiVariant = unconfirmedDoc.variants.find((v) => v.id === pendingEntry?.variantId);
    expect(iqiyiVariant).toMatchObject({
      namespace: "iqiyi",
      label: "原声",
      isDefault: true,
      unconfirmed: true,
    });

    const needsReviewEntry = assocs.find((a) => a.changeRequestId === needsReviewCr.id);
    expect(needsReviewEntry).toMatchObject({
      id: `change-request:${needsReviewCr.id}`,
      namespace: "bilibili",
      nativeId: "ss45574",
      variantId: biliVariant.id,
      unconfirmed: true,
      unconfirmedSource: "change_request",
      changeRequestId: needsReviewCr.id,
      changeRequestStatus: "needs_review",
    });

    // platformStatuses still counts ONLY confirmed associations as associated
    expect(unconfirmedDoc.platformStatuses).toEqual({
      bilibili: { status: "associated" },
      iqiyi: { status: "unchecked" },
      mgtv: { status: "unchecked" },
      tencent: { status: "unchecked" },
      youku: { status: "unchecked" },
    });

    // Works seamlessly with @media-ref/client resolveEpisode
    expect(resolveEpisode(unconfirmedDoc, { namespace: "iqiyi", season: 1, episode: 5 })).toEqual({
      kind: "unmapped",
      reason: "no_association",
    });
    expect(
      resolveEpisode(unconfirmedDoc, {
        namespace: "iqiyi",
        season: 1,
        episode: 5,
        includeUnconfirmed: true,
      }),
    ).toMatchObject({
      kind: "mapped",
      nativeId: "iq-pending-1",
      targetEpisode: 5,
    });
    expect(
      resolveEpisode(unconfirmedDoc, {
        namespace: "bilibili",
        season: 1,
        episode: 30,
        includeUnconfirmed: true,
      }),
    ).toMatchObject({
      kind: "mapped",
      nativeId: "ss45574",
      targetEpisode: 6,
    });

    // Reverse lookup respects includeUnconfirmed flag and never leaks delisted/rejected
    expect(
      (
        await expectRpcError(
          readRpc.media.getMedia({
            ref: mediaRef({ platform: { platform: "youku", nativeId: "yk-seed-1" } }),
          }),
        )
      ).status,
    ).toBe(404);

    const reverseSeedRes = await readRpc.media.getMedia({
      ref: mediaRef({ platform: { platform: "youku", nativeId: "yk-seed-1" } }),
      includeUnconfirmed: true,
    });
    expect(reverseSeedRes.matchedAssociationId).toBe(seedAssoc.id);

    expect(
      (
        await expectRpcError(
          readRpc.media.getMedia({
            ref: mediaRef({ platform: { platform: "iqiyi", nativeId: "iq-pending-1" } }),
          }),
        )
      ).status,
    ).toBe(404);

    const reversePendingRes = await readRpc.media.getMedia({
      ref: mediaRef({ platform: { platform: "iqiyi", nativeId: "iq-pending-1" } }),
      includeUnconfirmed: true,
    });
    expect(reversePendingRes.matchedAssociationId).toBe(`change-request:${pendingCr.id}`);

    expect(
      (
        await expectRpcError(
          readRpc.media.getMedia({
            ref: mediaRef({ platform: { platform: "mgtv", nativeId: "mgtv-delisted-1" } }),
            includeUnconfirmed: true,
          }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await expectRpcError(
          readRpc.media.getMedia({
            ref: mediaRef({ platform: { platform: "tencent", nativeId: "tc-rejected-1" } }),
            includeUnconfirmed: true,
          }),
        )
      ).status,
    ).toBe(404);

    // Invalid boolean type in Connect JSON -> 400
    const badJsonRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/mediaref.v1.MediaService/GetMedia`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": readKey.key },
        body: JSON.stringify({
          ref: { tmdb: { type: "MEDIA_TYPE_TV", id: 95479 } },
          includeUnconfirmed: "maybe",
        }),
      }),
    );
    expect(badJsonRes.status).toBe(400);
  });

  test("MediaService.BatchGetMedia evaluates each key independently on strict read-only dbRead, honors includeUnconfirmed, enforces 1..100 limit, and exposes no search/dump endpoints", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);
    const readOnlyDb = createReadOnlyDb(testDb.connectionString);
    extraDbs.push(readOnlyDb);

    const outbound = createFakeOutboundClient({
      fetchExternal: createCatalogStubHandler(),
    });
    const app = createApiApp({
      dbRead: readOnlyDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });

    const user = await signUpUser(app, outbound, {
      email: "reader-batch@example.com",
      password: "StrongPassword123!",
      name: "Reader Batch",
      verify: true,
    });
    const readKey = await issueApiKeyRpc(app, user.cookie, {
      name: "Read Batch Key",
      canSubmit: false,
    });
    const readRpc = createRpcClients(app, { apiKey: readKey.key });

    const media1 = await testDb.writeDb
      .insertInto("media")
      .values({
        type: "tv",
        baseline: "tmdb",
        title: "剧集一",
        original_title: "Show One",
        year: 2021,
        seasons: JSON.stringify([{ season: 1, episodeCount: 12, airYear: 2021 }]),
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const media2 = await testDb.writeDb
      .insertInto("media")
      .values({
        type: "tv",
        baseline: "tmdb",
        title: "剧集二",
        original_title: "Show Two",
        year: 2022,
        seasons: JSON.stringify([{ season: 1, episodeCount: 12, airYear: 2022 }]),
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await testDb.writeDb
      .insertInto("associations")
      .values([
        {
          status: "confirmed",
          is_external_id: true,
          media_id: media1.id,
          namespace: "tmdb",
          native_id: "tv:2001",
        },
        {
          status: "confirmed",
          is_external_id: true,
          media_id: media2.id,
          namespace: "tmdb",
          native_id: "tv:2002",
        },
      ])
      .execute();

    const [var1, var2, var1Youku] = await Promise.all([
      testDb.writeDb
        .insertInto("variants")
        .values({
          media_id: media1.id,
          platform: "bilibili",
          description: "原声",
          is_default: true,
        })
        .returning("id")
        .executeTakeFirstOrThrow(),
      testDb.writeDb
        .insertInto("variants")
        .values({
          media_id: media2.id,
          platform: "bilibili",
          description: "原声",
          is_default: true,
        })
        .returning("id")
        .executeTakeFirstOrThrow(),
      testDb.writeDb
        .insertInto("variants")
        .values({
          media_id: media1.id,
          platform: "youku",
          description: "原声",
          is_default: true,
        })
        .returning("id")
        .executeTakeFirstOrThrow(),
    ]);

    const assoc1 = await testDb.writeDb
      .insertInto("associations")
      .values({
        media_id: media1.id,
        namespace: "bilibili",
        native_id: "ss-shared-batch",
        variant_id: var1.id,
        status: "confirmed",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const assoc2 = await testDb.writeDb
      .insertInto("associations")
      .values({
        media_id: media2.id,
        namespace: "bilibili",
        native_id: "ss-shared-batch",
        variant_id: var2.id,
        status: "confirmed",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const seedAssoc = await testDb.writeDb
      .insertInto("associations")
      .values({
        media_id: media1.id,
        namespace: "youku",
        native_id: "yk-seed-batch",
        variant_id: var1Youku.id,
        status: "seed_unconfirmed",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const pendingCr = await testDb.writeDb
      .insertInto("change_requests")
      .values({
        status: "pending_evidence",
        submitter_user_id: user.userId,
        media_id: media1.id,
        target_external_key: "tmdb:tv:2001",
        namespace: "iqiyi",
        raw_native_id: "iq-pending-batch",
        native_id: "iq-pending-batch",
        variant_description: "原声",
        segments: JSON.stringify([]),
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await testDb.writeDb
      .insertInto("platform_checks")
      .values({
        media_id: media1.id,
        platform: "tencent",
        status: "not_found",
        checked_at: new Date("2026-11-22T00:00:00.000Z"),
      })
      .execute();

    // Unauthenticated batch request -> 401
    expect(
      (
        await expectRpcError(
          createRpcClients(app).media.batchGetMedia({
            refs: [mediaRef({ tmdb: { type: "tv", id: 2001 } })],
          }),
        )
      ).status,
    ).toBe(401);

    // Mixed batch: valid hit, missing ref, invalid ref, shared collection hit, unconfirmed-only ref
    const mixedRefs = [
      mediaRef({ tmdb: { type: "tv", id: 2001 } }),
      mediaRef({ tmdb: { type: "tv", id: 999999 } }),
      create(proto.MediaRefSchema),
      mediaRef({ platform: { platform: "bilibili", nativeId: "ss-shared-batch" } }),
      mediaRef({ platform: { platform: "youku", nativeId: "yk-seed-batch" } }),
    ];
    const mixedBody = await readRpc.media.batchGetMedia({ refs: mixedRefs });
    const mixedResults = mixedBody.results.map(fromProtoBatchItemResult);

    expect(mixedResults).toHaveLength(5);
    expect(mixedResults[0]).toMatchObject({
      ref: { tmdb: { type: "tv", id: 2001 } },
      key: "tmdb:tv:2001",
      ok: true,
    });
    if (mixedResults[0]?.ok) {
      expect(mixedResults[0].items).toHaveLength(1);
      expect(mixedResults[0].items[0]?.document.media.id).toBe(media1.id);
      expect(mixedResults[0].items[0]?.document.associations).toHaveLength(1);
      expect(mixedResults[0].items[0]?.document.platformStatuses).toEqual({
        bilibili: { status: "associated" },
        tencent: { status: "not_found", checkedAt: "2026-11-22T00:00:00.000Z" },
        iqiyi: { status: "unchecked" },
        youku: { status: "unchecked" },
        mgtv: { status: "unchecked" },
      });
    }

    expect(mixedResults[1]).toMatchObject({
      ref: { tmdb: { type: "tv", id: 999999 } },
      key: "tmdb:tv:999999",
      ok: false,
      error: "NOT_FOUND",
    });

    expect(mixedResults[2]).toMatchObject({
      ref: null,
      ok: false,
      error: "INVALID_KEY",
    });

    expect(mixedResults[3]).toMatchObject({
      ref: { platform: { platform: "bilibili", nativeId: "ss-shared-batch" } },
      key: "bilibili:ss-shared-batch",
      ok: true,
    });
    if (mixedResults[3]?.ok) {
      expect(mixedResults[3].items).toHaveLength(2);
      expect(mixedResults[3].items.map((item) => item.document.media.id)).toEqual([
        media1.id,
        media2.id,
      ]);
      expect(mixedResults[3].items.map((item) => item.matchedAssociationId)).toEqual([
        assoc1.id,
        assoc2.id,
      ]);
    }

    // Seed-only ref is NOT_FOUND when includeUnconfirmed is omitted/false
    expect(mixedResults[4]).toMatchObject({
      ref: { platform: { platform: "youku", nativeId: "yk-seed-batch" } },
      key: "youku:yk-seed-batch",
      ok: false,
      error: "NOT_FOUND",
    });

    // Batch with includeUnconfirmed: true returns seed_unconfirmed + pending_evidence CR
    const unconfirmedBatchResults = (
      await readRpc.media.batchGetMedia({
        refs: [
          mediaRef({ tmdb: { type: "tv", id: 2001 } }),
          mediaRef({ platform: { platform: "youku", nativeId: "yk-seed-batch" } }),
          mediaRef({ platform: { platform: "iqiyi", nativeId: "iq-pending-batch" } }),
        ],
        includeUnconfirmed: true,
      })
    ).results.map(fromProtoBatchItemResult);

    expect(unconfirmedBatchResults[0]?.ok).toBe(true);
    if (unconfirmedBatchResults[0]?.ok) {
      const assocs = unconfirmedBatchResults[0].items[0]!.document.associations;
      expect(assocs).toHaveLength(3);
      expect(assocs.some((a) => a.id === seedAssoc.id && a.unconfirmed === true)).toBe(true);
      expect(assocs.some((a) => a.changeRequestId === pendingCr.id && a.unconfirmed === true)).toBe(
        true,
      );
    }
    expect(unconfirmedBatchResults[1]).toMatchObject({
      key: "youku:yk-seed-batch",
      ok: true,
      items: [{ matchedAssociationId: seedAssoc.id }],
    });
    expect(unconfirmedBatchResults[2]).toMatchObject({
      key: "iqiyi:iq-pending-batch",
      ok: true,
      items: [{ matchedAssociationId: `change-request:${pendingCr.id}` }],
    });

    // Exactly 100 refs succeeds with 100 results
    const refs100 = Array.from({ length: 100 }, (_, i) =>
      mediaRef({ tmdb: { type: "tv", id: i === 0 ? 2001 : 500000 + i } }),
    );
    const batch100Results = (await readRpc.media.batchGetMedia({ refs: refs100 })).results.map(
      fromProtoBatchItemResult,
    );
    expect(batch100Results).toHaveLength(100);
    expect(batch100Results[0]).toMatchObject({ key: "tmdb:tv:2001", ok: true });
    expect(batch100Results[99]).toMatchObject({ key: "tmdb:tv:500099", ok: false });

    // 101 refs rejected with 400 BATCH_LIMIT_EXCEEDED
    const refs101 = Array.from({ length: 101 }, (_, i) =>
      mediaRef({ tmdb: { type: "tv", id: 600000 + i } }),
    );
    const batch101Err = await expectRpcError(readRpc.media.batchGetMedia({ refs: refs101 }));
    expect(batch101Err.status).toBe(400);
    expect(batch101Err.code).toBe("BATCH_LIMIT_EXCEEDED");

    // Empty array rejected with 400 BATCH_LIMIT_EXCEEDED
    const emptyBatchErr = await expectRpcError(readRpc.media.batchGetMedia({ refs: [] }));
    expect(emptyBatchErr.status).toBe(400);
    expect(emptyBatchErr.code).toBe("BATCH_LIMIT_EXCEEDED");

    // No full-database dump endpoint and no search-by-title endpoint
    const dumpRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/mediaref.v1.MediaService/ListMedia`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": readKey.key },
        body: "{}",
      }),
    );
    expect(dumpRes.status).toBe(404);

    const invalidRefErr = await expectRpcError(
      readRpc.media.getMedia({ ref: create(proto.MediaRefSchema) }),
    );
    expect(invalidRefErr.status).toBe(400);
    expect(invalidRefErr.code).toBe("INVALID_KEY");
  });
});
