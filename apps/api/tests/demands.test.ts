import { create } from "@bufbuild/protobuf";
import type { ExecutionContext } from "@cloudflare/workers-types";
import { proto, toProtoSegmentInput } from "@media-ref/client";
import {
  createAdapterRegistry,
  createFakeOutboundClient,
  listDemands,
  type ExternalHttpRequest,
} from "@media-ref/core";
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

const TEST_AUTH_SECRET = "test-secret-for-media-ref-demands-integration-tests-0123456789";

function createReadOnlyDb(connectionString: string) {
  const readOnlyUrl = new URL(connectionString);
  readOnlyUrl.searchParams.set("options", "-c default_transaction_read_only=on");
  return createDb(readOnlyUrl.toString());
}

function createCatalogStubHandler() {
  return (request: ExternalHttpRequest) => {
    if (request.kind === "catalog" && request.namespace === "tmdb") {
      if (request.url.includes("/tv/77777")) {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          url: request.url,
          body: JSON.stringify({
            id: 77777,
            name: "测试新剧",
            original_name: "Test New Show",
            first_air_date: "2024-04-01",
            seasons: [
              { season_number: 0, episode_count: 2, air_date: "2024-03-01" },
              { season_number: 1, episode_count: 12, air_date: "2024-04-01" },
              { season_number: 2, episode_count: 12, air_date: "2025-04-01" },
            ],
            external_ids: {
              imdb_id: "tt7777700",
              tvdb_id: 777770,
            },
          }),
        };
      }
      if (request.url.includes("/movie/55555")) {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          url: request.url,
          body: JSON.stringify({
            id: 55555,
            title: "测试电影",
            original_title: "Test Movie",
            release_date: "2023-07-01",
            external_ids: {
              imdb_id: "tt5555500",
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

describe("API Worker demand recording on read misses (#27)", () => {
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

  test("Case 1: records demand only for uncovered season + namespaceGroup on existing media and increments count", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);
    const readOnlyDb = createReadOnlyDb(testDb.connectionString);
    extraDbs.push(readOnlyDb);

    const bgTasks: Promise<unknown>[] = [];
    const outbound = createFakeOutboundClient({
      fetchExternal: createCatalogStubHandler(),
    });
    const app = createApiApp({
      dbRead: readOnlyDb,
      dbWrite: testDb.writeDb,
      outbound,
      adapterRegistry: createAdapterRegistry(),
      onBackgroundTask: (task) => {
        bgTasks.push(task);
      },
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });

    const user = await signUpUser(app, outbound, {
      email: "demand-case1@example.com",
      password: "StrongPassword123!",
      name: "Demand Reader",
      verify: true,
    });
    const readKey = await issueApiKeyRpc(app, user.cookie, {
      name: "Demand Read Key",
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
        seasons: JSON.stringify([
          { season: 1, episodeCount: 24, airYear: 2020 },
          { season: 2, episodeCount: 23, airYear: 2023 },
        ]),
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

    const assoc = await testDb.writeDb
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

    await testDb.writeDb
      .insertInto("segments")
      .values({
        association_id: assoc.id,
        season: 1,
        episode_start: 1,
        episode_end: 24,
        target_episode_start: 1,
        baseline: "tmdb",
      })
      .execute();

    // Season 1 is already covered in platform group -> NO demand recorded
    await readRpc.media.getMedia({
      ref: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
      season: 1,
      namespaceGroup: proto.NamespaceGroup.PLATFORM,
    });
    await Promise.all(bgTasks);

    expect(await listDemands(testDb.readDb, { mediaId: media.id })).toEqual([]);

    // Season 2 is NOT covered in platform group -> called twice -> demandCount = 2
    for (let i = 0; i < 2; i++) {
      await readRpc.media.getMedia({
        ref: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
        season: 2,
        namespaceGroup: proto.NamespaceGroup.PLATFORM,
      });
    }
    await Promise.all(bgTasks);

    // Season 1 in catalog group has NO confirmed catalog association -> demandCount = 1
    await readRpc.media.getMedia({
      ref: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
      season: 1,
      namespaceGroup: proto.NamespaceGroup.CATALOG,
    });
    await Promise.all(bgTasks);

    const demands = await listDemands(testDb.readDb, { mediaId: media.id });
    expect(demands).toHaveLength(2);
    expect(demands[0]).toMatchObject({
      mediaId: media.id,
      externalKey: null,
      season: 2,
      namespaceGroup: "platform",
      demandCount: 2,
      status: "open",
    });
    expect(demands[1]).toMatchObject({
      mediaId: media.id,
      externalKey: null,
      season: 1,
      namespaceGroup: "catalog",
      demandCount: 1,
      status: "open",
    });

    // Invalid season / namespaceGroup inputs are rejected with 400 and record no demand
    expect(
      (
        await expectRpcError(
          readRpc.media.getMedia({
            ref: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
            season: -1,
          }),
        )
      ).status,
    ).toBe(400);
    const jsonTmdbRef = { tmdb: { type: "MEDIA_TYPE_TV", id: 95479 } };
    for (const badBody of [
      JSON.stringify({ ref: jsonTmdbRef, season: "abc" }),
      JSON.stringify({ ref: jsonTmdbRef, season: 1.5 }),
      JSON.stringify({ ref: jsonTmdbRef, namespaceGroup: "invalid" }),
    ]) {
      const badRes = await app.fetch(
        new Request(`${TEST_BASE_URL}/mediaref.v1.MediaService/GetMedia`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": readKey.key },
          body: badBody,
        }),
      );
      expect(badRes.status).toBe(400);
    }
    await Promise.all(bgTasks);
    expect(await listDemands(testDb.readDb, { mediaId: media.id })).toHaveLength(2);
  });

  test("Case 2: omits season -> records demand for every uncovered regular season (ignoring specials and unconfirmed) and uses season=null for movies", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);
    const readOnlyDb = createReadOnlyDb(testDb.connectionString);
    extraDbs.push(readOnlyDb);

    const bgTasks: Promise<unknown>[] = [];
    const outbound = createFakeOutboundClient({
      fetchExternal: createCatalogStubHandler(),
    });
    const app = createApiApp({
      dbRead: readOnlyDb,
      dbWrite: testDb.writeDb,
      outbound,
      adapterRegistry: createAdapterRegistry(),
      onBackgroundTask: (task) => {
        bgTasks.push(task);
      },
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });

    const user = await signUpUser(app, outbound, {
      email: "demand-case2@example.com",
      password: "StrongPassword123!",
      name: "Demand Case2",
      verify: true,
    });
    const readKey = await issueApiKeyRpc(app, user.cookie, {
      name: "Case 2 Read Key",
      canSubmit: false,
    });
    const readRpc = createRpcClients(app, { apiKey: readKey.key });

    // TV show with specials (0) + 3 regular seasons (1, 2, 3)
    const tvMedia = await testDb.writeDb
      .insertInto("media")
      .values({
        type: "tv",
        baseline: "tmdb",
        title: "咒术回战",
        original_title: "呪術廻戦",
        year: 2020,
        seasons: JSON.stringify([
          { season: 0, episodeCount: 2, airYear: 2020 },
          { season: 1, episodeCount: 24, airYear: 2020 },
          { season: 2, episodeCount: 23, airYear: 2023 },
          { season: 3, episodeCount: 12, airYear: 2026 },
        ]),
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await testDb.writeDb
      .insertInto("associations")
      .values({
        status: "confirmed",
        is_external_id: true,
        media_id: tvMedia.id,
        namespace: "tmdb",
        native_id: "tv:95479",
      })
      .execute();

    const biliVariant = await testDb.writeDb
      .insertInto("variants")
      .values({
        media_id: tvMedia.id,
        platform: "bilibili",
        description: "原声",
        is_default: true,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    // Season 1 is confirmed
    const s1Assoc = await testDb.writeDb
      .insertInto("associations")
      .values({
        media_id: tvMedia.id,
        namespace: "bilibili",
        native_id: "ss34430",
        variant_id: biliVariant.id,
        status: "confirmed",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    // Season 2 is seed_unconfirmed (must NOT suppress demand)
    const s2SeedAssoc = await testDb.writeDb
      .insertInto("associations")
      .values({
        media_id: tvMedia.id,
        namespace: "bilibili",
        native_id: "ss-seed-s2",
        variant_id: biliVariant.id,
        status: "seed_unconfirmed",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await testDb.writeDb
      .insertInto("segments")
      .values([
        {
          association_id: s1Assoc.id,
          season: 1,
          episode_start: 1,
          episode_end: 24,
          target_episode_start: 1,
          baseline: "tmdb",
        },
        {
          association_id: s2SeedAssoc.id,
          season: 2,
          episode_start: 1,
          episode_end: 23,
          target_episode_start: 1,
          baseline: "tmdb",
        },
      ])
      .execute();

    // Season 3 has only an unconfirmed pending_evidence CR (must NOT suppress demand even when includeUnconfirmed=true)
    await testDb.writeDb
      .insertInto("change_requests")
      .values({
        status: "pending_evidence",
        submitter_user_id: user.userId,
        media_id: tvMedia.id,
        target_external_key: "tmdb:tv:95479",
        namespace: "bilibili",
        raw_native_id: "ss-pending-s3",
        native_id: "ss-pending-s3",
        variant_id: biliVariant.id,
        segments: JSON.stringify([
          {
            season: 3,
            episodeStart: 1,
            episodeEnd: 12,
            targetEpisodeStart: 1,
            baseline: "tmdb",
            nonLinear: false,
            needsReview: false,
          },
        ]),
      })
      .execute();

    // Request omits season, passes namespaceGroup=PLATFORM & includeUnconfirmed=true
    await readRpc.media.getMedia({
      ref: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
      namespaceGroup: proto.NamespaceGroup.PLATFORM,
      includeUnconfirmed: true,
    });
    await Promise.all(bgTasks);

    const tvDemandsAfterFirst = await listDemands(testDb.readDb, { mediaId: tvMedia.id });
    expect(tvDemandsAfterFirst.map((d) => ({ season: d.season, count: d.demandCount }))).toEqual([
      { season: 2, count: 1 },
      { season: 3, count: 1 },
    ]);

    // Second request omits both season AND namespaceGroup (defaults to "platform")
    await readRpc.media.getMedia({ ref: mediaRef({ tmdb: { type: "tv", id: 95479 } }) });
    await Promise.all(bgTasks);

    const tvDemandsAfterSecond = await listDemands(testDb.readDb, { mediaId: tvMedia.id });
    expect(
      tvDemandsAfterSecond.map((d) => ({
        season: d.season,
        namespaceGroup: d.namespaceGroup,
        count: d.demandCount,
      })),
    ).toEqual([
      { season: 2, namespaceGroup: "platform", count: 2 },
      { season: 3, namespaceGroup: "platform", count: 2 },
    ]);

    // Movie media without confirmed platform association -> records season=null
    const movieMedia = await testDb.writeDb
      .insertInto("media")
      .values({
        type: "movie",
        baseline: "tmdb",
        title: "测试电影",
        original_title: "Test Movie",
        year: 2023,
        seasons: JSON.stringify([]),
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await testDb.writeDb
      .insertInto("associations")
      .values({
        status: "confirmed",
        is_external_id: true,
        media_id: movieMedia.id,
        namespace: "tmdb",
        native_id: "movie:55555",
      })
      .execute();

    await readRpc.media.getMedia({ ref: mediaRef({ tmdb: { type: "movie", id: 55555 } }) });
    await Promise.all(bgTasks);

    const movieDemands = await listDemands(testDb.readDb, { mediaId: movieMedia.id });
    expect(movieDemands).toHaveLength(1);
    expect(movieDemands[0]).toMatchObject({
      mediaId: movieMedia.id,
      externalKey: null,
      season: null,
      namespaceGroup: "platform",
      demandCount: 1,
    });

    // Adding a confirmed whole-media association (segments: []) suppresses further demands
    const movieVariant = await testDb.writeDb
      .insertInto("variants")
      .values({
        media_id: movieMedia.id,
        platform: "tencent",
        description: "原声",
        is_default: true,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await testDb.writeDb
      .insertInto("associations")
      .values({
        media_id: movieMedia.id,
        namespace: "tencent",
        native_id: "cid-movie-55555",
        variant_id: movieVariant.id,
        status: "confirmed",
      })
      .execute();

    await readRpc.media.getMedia({ ref: mediaRef({ tmdb: { type: "movie", id: 55555 } }) });
    await Promise.all(bgTasks);

    const movieDemandsAfterCover = await listDemands(testDb.readDb, { mediaId: movieMedia.id });
    expect(movieDemandsAfterCover[0]?.demandCount).toBe(1);
  });

  test("Case 3: records external-key demand without creating media, ignores unknown UUIDs, and merges onto media on creation", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);
    const readOnlyDb = createReadOnlyDb(testDb.connectionString);
    extraDbs.push(readOnlyDb);

    const bgTasks: Promise<unknown>[] = [];
    const outbound = createFakeOutboundClient({
      fetchExternal: createCatalogStubHandler(),
    });
    const app = createApiApp({
      dbRead: readOnlyDb,
      dbWrite: testDb.writeDb,
      outbound,
      adapterRegistry: createAdapterRegistry(),
      onBackgroundTask: (task) => {
        bgTasks.push(task);
      },
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });

    const reviewer = await signUpUser(app, outbound, {
      email: "demand-case3-reviewer@example.com",
      password: "StrongPassword123!",
      name: "Reviewer",
      verify: true,
    });
    await testDb.writeDb
      .updateTable("user")
      .set({ role: "reviewer" })
      .where("id", "=", reviewer.userId)
      .execute();

    const submitKey = await issueApiKeyRpc(app, reviewer.cookie, {
      name: "Submit + Read Key",
      canSubmit: true,
    });
    const submitRpc = createRpcClients(app, { apiKey: submitKey.key });
    const reviewerRpc = createRpcClients(app, { cookie: reviewer.cookie });

    // 1. Query uncreated tmdb:tv:77777 season=1 three times
    for (let i = 0; i < 3; i++) {
      expect(
        (
          await expectRpcError(
            submitRpc.media.getMedia({
              ref: mediaRef({ tmdb: { type: "tv", id: 77777 } }),
              season: 1,
              namespaceGroup: proto.NamespaceGroup.PLATFORM,
            }),
          )
        ).status,
      ).toBe(404);
    }

    // 2. Query uncreated tmdb:tv:77777 without season once (to test expansion on TV creation)
    expect(
      (
        await expectRpcError(
          submitRpc.media.getMedia({
            ref: mediaRef({ tmdb: { type: "tv", id: 77777 } }),
            namespaceGroup: proto.NamespaceGroup.PLATFORM,
          }),
        )
      ).status,
    ).toBe(404);

    // 3. Query uncreated imdb:tt7777700 season=1 twice (synced secondary external ID)
    for (let i = 0; i < 2; i++) {
      expect(
        (
          await expectRpcError(
            submitRpc.media.getMedia({
              ref: mediaRef({ imdb: "tt7777700" }),
              season: 1,
              namespaceGroup: proto.NamespaceGroup.PLATFORM,
            }),
          )
        ).status,
      ).toBe(404);
    }

    // 4. Random nonexistent UUID and invalid ref must NEVER record demands
    expect(
      (
        await expectRpcError(
          submitRpc.media.getMedia({
            ref: mediaRef({ mediaId: "11111111-1111-4111-8111-111111111111" }),
            season: 1,
            namespaceGroup: proto.NamespaceGroup.PLATFORM,
          }),
        )
      ).status,
    ).toBe(404);

    expect(
      (
        await expectRpcError(
          submitRpc.media.getMedia({ ref: create(proto.MediaRefSchema), season: 1 }),
        )
      ).status,
    ).toBe(400);

    await Promise.all(bgTasks);

    // Zero media rows created on read misses
    const mediaRowsBefore = await testDb.readDb.selectFrom("media").select("id").execute();
    expect(mediaRowsBefore).toEqual([]);

    const extDemandsBefore = await listDemands(testDb.readDb);
    expect(extDemandsBefore).toHaveLength(3);
    expect(
      extDemandsBefore.map((d) => ({
        mediaId: d.mediaId,
        externalKey: d.externalKey,
        season: d.season,
        namespaceGroup: d.namespaceGroup,
        demandCount: d.demandCount,
      })),
    ).toEqual([
      {
        mediaId: null,
        externalKey: "tmdb:tv:77777",
        season: 1,
        namespaceGroup: "platform",
        demandCount: 3,
      },
      {
        mediaId: null,
        externalKey: "imdb:tt7777700",
        season: 1,
        namespaceGroup: "platform",
        demandCount: 2,
      },
      {
        mediaId: null,
        externalKey: "tmdb:tv:77777",
        season: null,
        namespaceGroup: "platform",
        demandCount: 1,
      },
    ]);

    // 5. Submit change request for tmdb:tv:77777 and approve via reviewer RPC -> creates media & merges demands
    const submitBody = await submitRpc.changeRequest.createChangeRequest({
      target: mediaRef({ tmdb: { type: "tv", id: 77777 } }),
      namespace: "douban",
      nativeId: "35555777",
      segments: [toProtoSegmentInput({ season: 1, baseline: "tmdb" })],
    });

    const approveBody = await reviewerRpc.reviewer.approveChangeRequest({
      id: submitBody.changeRequest!.id,
      reason: "Verified TMDB show",
    });

    // Orphan external-key demands are completely gone
    expect(await listDemands(testDb.readDb, { externalKey: "tmdb:tv:77777" })).toEqual([]);
    expect(await listDemands(testDb.readDb, { externalKey: "imdb:tt7777700" })).toEqual([]);

    // Merged demands live on the new media.id with exact accumulated & expanded counts
    const mergedDemands = await listDemands(testDb.readDb, { mediaId: approveBody.mediaId });
    expect(
      mergedDemands.map((d) => ({
        mediaId: d.mediaId,
        externalKey: d.externalKey,
        season: d.season,
        namespaceGroup: d.namespaceGroup,
        demandCount: d.demandCount,
        status: d.status,
      })),
    ).toEqual([
      {
        mediaId: approveBody.mediaId,
        externalKey: null,
        season: 1,
        namespaceGroup: "platform",
        demandCount: 6,
        status: "open",
      },
      {
        mediaId: approveBody.mediaId,
        externalKey: null,
        season: 2,
        namespaceGroup: "platform",
        demandCount: 1,
        status: "open",
      },
    ]);

    // 6. Movie external-key demand merges with season=null when movie is created
    expect(
      (
        await expectRpcError(
          submitRpc.media.getMedia({
            ref: mediaRef({ tmdb: { type: "movie", id: 55555 } }),
            namespaceGroup: proto.NamespaceGroup.PLATFORM,
          }),
        )
      ).status,
    ).toBe(404);
    await Promise.all(bgTasks);

    const movieSubmitBody = await submitRpc.changeRequest.createChangeRequest({
      target: mediaRef({ tmdb: { type: "movie", id: 55555 } }),
      namespace: "douban",
      nativeId: "35555555",
      segments: [],
    });
    const movieApproveBody = await reviewerRpc.reviewer.approveChangeRequest({
      id: movieSubmitBody.changeRequest!.id,
      reason: "Verified movie",
    });

    expect(await listDemands(testDb.readDb, { externalKey: "tmdb:movie:55555" })).toEqual([]);
    expect(await listDemands(testDb.readDb, { mediaId: movieApproveBody.mediaId })).toEqual([
      expect.objectContaining({
        mediaId: movieApproveBody.mediaId,
        externalKey: null,
        season: null,
        namespaceGroup: "platform",
        demandCount: 1,
      }),
    ]);
  });

  test("Non-blocking: read RPC response returns immediately while PostgreSQL demands table is locked, and survives write failures", async () => {
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
      email: "demand-nonblocking@example.com",
      password: "StrongPassword123!",
      name: "Nonblocking Reader",
      verify: true,
    });
    const readKey = await issueApiKeyRpc(app, user.cookie, {
      name: "Nonblocking Read Key",
      canSubmit: false,
    });

    // Seed an existing demand row and hold a real PostgreSQL FOR UPDATE row lock in a separate
    // transaction so any concurrent ON CONFLICT DO UPDATE blocks inside PostgreSQL until released.
    await testDb.writeDb
      .insertInto("demands")
      .values({
        external_key: "tmdb:tv:77777",
        season: 1,
        namespace_group: "platform",
        demand_count: 1,
      })
      .execute();

    const lockConnection = createDb(testDb.connectionString, { max: 1 });
    extraDbs.push(lockConnection);

    let releaseLock!: () => void;
    let lockAcquired!: () => void;
    const lockReady = new Promise<void>((resolve) => {
      lockAcquired = resolve;
    });
    const lockReleaseGate = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    const lockTxPromise = lockConnection.transaction().execute(async (trx) => {
      await trx
        .selectFrom("demands")
        .select("id")
        .where("external_key", "=", "tmdb:tv:77777")
        .forUpdate()
        .execute();
      lockAcquired();
      await lockReleaseGate;
    });

    await lockReady;

    let backgroundSettled = false;
    const waitUntilPromises: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil(promise: Promise<unknown>) {
        waitUntilPromises.push(
          promise.finally(() => {
            backgroundSettled = true;
          }),
        );
      },
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;

    const lockedRpc = createRpcClients((req) => app.fetch(req, undefined, executionCtx), {
      apiKey: readKey.key,
    });

    try {
      const err = await expectRpcError(
        lockedRpc.media.getMedia({
          ref: mediaRef({ tmdb: { type: "tv", id: 77777 } }),
          season: 1,
          namespaceGroup: proto.NamespaceGroup.PLATFORM,
        }),
      );

      // RPC response resolved IMMEDIATELY while PostgreSQL still holds the FOR UPDATE row lock!
      expect(err.status).toBe(404);
      expect(waitUntilPromises).toHaveLength(1);
      expect(backgroundSettled).toBe(false);

      // Confirm the background demand write is genuinely blocked on the DB lock
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(backgroundSettled).toBe(false);
    } finally {
      releaseLock();
      await lockTxPromise;
    }

    // Once lock is released, the background task finishes incrementing the row in PostgreSQL
    await Promise.all(waitUntilPromises);
    expect(backgroundSettled).toBe(true);

    const demands = await listDemands(testDb.readDb, { externalKey: "tmdb:tv:77777" });
    expect(demands).toHaveLength(1);
    expect(demands[0]).toMatchObject({
      externalKey: "tmdb:tv:77777",
      season: 1,
      namespaceGroup: "platform",
      demandCount: 2,
    });

    // Real DB write failure (read-only dbWrite) must NEVER fail or crash a read RPC request
    const recordedErrors: unknown[] = [];
    const failingWriteApp = createApiApp({
      dbRead: readOnlyDb,
      dbWrite: readOnlyDb,
      outbound,
      onBackgroundTaskError: (error) => {
        recordedErrors.push(error);
      },
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });

    const failWaitUntil: Promise<unknown>[] = [];
    const failCtx = {
      waitUntil(promise: Promise<unknown>) {
        failWaitUntil.push(promise);
      },
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;

    const resilientErr = await expectRpcError(
      createRpcClients((req) => failingWriteApp.fetch(req, undefined, failCtx), {
        apiKey: readKey.key,
      }).media.getMedia({
        ref: mediaRef({ tmdb: { type: "tv", id: 77777 } }),
        season: 2,
        namespaceGroup: proto.NamespaceGroup.PLATFORM,
      }),
    );
    expect(resilientErr.status).toBe(404);
    await Promise.all(failWaitUntil);
    expect(recordedErrors).toHaveLength(1);
    expect(recordedErrors[0]).toBeInstanceOf(Error);
  });

  test("Batch read (MediaService.BatchGetMedia) records demands for missed keys and uncovered seasons without blocking", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);
    const readOnlyDb = createReadOnlyDb(testDb.connectionString);
    extraDbs.push(readOnlyDb);

    const bgTasks: Promise<unknown>[] = [];
    const outbound = createFakeOutboundClient({
      fetchExternal: createCatalogStubHandler(),
    });
    const app = createApiApp({
      dbRead: readOnlyDb,
      dbWrite: testDb.writeDb,
      outbound,
      adapterRegistry: createAdapterRegistry(),
      onBackgroundTask: (task) => {
        bgTasks.push(task);
      },
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });

    const user = await signUpUser(app, outbound, {
      email: "demand-batch@example.com",
      password: "StrongPassword123!",
      name: "Batch Reader",
      verify: true,
    });
    const readKey = await issueApiKeyRpc(app, user.cookie, {
      name: "Batch Read Key",
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
        seasons: JSON.stringify([
          { season: 1, episodeCount: 24, airYear: 2020 },
          { season: 2, episodeCount: 23, airYear: 2023 },
        ]),
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

    const variant = await testDb.writeDb
      .insertInto("variants")
      .values({
        media_id: media.id,
        platform: "bilibili",
        description: "原声",
        is_default: true,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const assoc = await testDb.writeDb
      .insertInto("associations")
      .values({
        media_id: media.id,
        namespace: "bilibili",
        native_id: "ss34430",
        variant_id: variant.id,
        status: "confirmed",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await testDb.writeDb
      .insertInto("segments")
      .values({
        association_id: assoc.id,
        season: 1,
        episode_start: 1,
        episode_end: 24,
        target_episode_start: 1,
        baseline: "tmdb",
      })
      .execute();

    // Batch with explicit season=2 and namespaceGroup="platform"
    await readRpc.media.batchGetMedia({
      refs: [
        mediaRef({ tmdb: { type: "tv", id: 95479 } }),
        mediaRef({ tmdb: { type: "tv", id: 88888 } }),
        mediaRef({ tmdb: { type: "tv", id: 88888 } }),
        mediaRef({ mediaId: "11111111-1111-4111-8111-111111111111" }),
        create(proto.MediaRefSchema),
      ],
      season: 2,
      namespaceGroup: proto.NamespaceGroup.PLATFORM,
    });
    await Promise.all(bgTasks);

    const demandsAfterBatch1 = await listDemands(testDb.readDb);
    expect(
      demandsAfterBatch1.map((d) => ({
        mediaId: d.mediaId,
        externalKey: d.externalKey,
        season: d.season,
        namespaceGroup: d.namespaceGroup,
        demandCount: d.demandCount,
      })),
    ).toEqual([
      {
        mediaId: null,
        externalKey: "tmdb:tv:88888",
        season: 2,
        namespaceGroup: "platform",
        demandCount: 2,
      },
      {
        mediaId: media.id,
        externalKey: null,
        season: 2,
        namespaceGroup: "platform",
        demandCount: 1,
      },
    ]);

    // Batch omitting season & namespaceGroup -> expands uncovered seasons on existing media (s2 -> count 2)
    // and records season=null for uncreated external key
    await readRpc.media.batchGetMedia({
      refs: [
        mediaRef({ tmdb: { type: "tv", id: 95479 } }),
        mediaRef({ tmdb: { type: "tv", id: 88888 } }),
      ],
    });
    await Promise.all(bgTasks);

    const demandsAfterBatch2 = await listDemands(testDb.readDb);
    expect(demandsAfterBatch2).toHaveLength(3);
    expect(
      demandsAfterBatch2.find((d) => d.mediaId === media.id && d.season === 2)?.demandCount,
    ).toBe(2);
    expect(
      demandsAfterBatch2.find((d) => d.externalKey === "tmdb:tv:88888" && d.season === null)
        ?.demandCount,
    ).toBe(1);

    // Invalid batch season / namespaceGroup rejected with 400
    expect(
      (
        await expectRpcError(
          readRpc.media.batchGetMedia({
            refs: [mediaRef({ tmdb: { type: "tv", id: 95479 } })],
            season: -1,
          }),
        )
      ).status,
    ).toBe(400);

    const jsonTmdbBatchRef = { tmdb: { type: "MEDIA_TYPE_TV", id: 95479 } };
    for (const invalidPayload of [
      { refs: [jsonTmdbBatchRef], season: "not-a-number" },
      { refs: [jsonTmdbBatchRef], namespaceGroup: "unknown" },
    ]) {
      const badBatchRes = await app.fetch(
        new Request(`${TEST_BASE_URL}/mediaref.v1.MediaService/BatchGetMedia`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": readKey.key,
          },
          body: JSON.stringify(invalidPayload),
        }),
      );
      expect(badBatchRes.status).toBe(400);
    }
  });
});
