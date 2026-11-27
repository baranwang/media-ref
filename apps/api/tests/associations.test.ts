import {
  fromProtoAssociationStatus,
  fromProtoMediaDocument,
  proto,
  toProtoSegmentInput,
} from "@media-ref/client";
import {
  createAdapterRegistry,
  createFakeOutboundClient,
  runTmdbDailySync,
  type ExternalHttpRequest,
} from "@media-ref/core";
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
  approveInCore,
} from "./rpc-helpers.ts";

const TEST_AUTH_SECRET = "test-secret-for-media-ref-associations-locks-history-0123456789";

function createTmdbStub(overrides?: { imdbId95479?: string; tvdbId95479?: number }) {
  return (request: ExternalHttpRequest) => {
    if (request.kind === "catalog" && request.namespace === "tmdb") {
      if (request.url.includes("/tv/changes")) {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          url: request.url,
          body: JSON.stringify({
            results: [{ id: 95479, adult: false }],
            page: 1,
            total_pages: 1,
            total_results: 1,
          }),
        };
      }
      if (request.url.includes("/movie/changes")) {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          url: request.url,
          body: JSON.stringify({
            results: [],
            page: 1,
            total_pages: 1,
            total_results: 0,
          }),
        };
      }
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
            seasons: [{ season_number: 1, episode_count: 24, air_date: "2020-10-03" }],
            external_ids: {
              imdb_id: overrides?.imdbId95479 ?? "tt12343534",
              tvdb_id: overrides?.tvdbId95479 ?? 377543,
            },
          }),
        };
      }
      if (request.url.includes("/tv/108545")) {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          url: request.url,
          body: JSON.stringify({
            id: 108545,
            name: "三体",
            original_name: "三体",
            first_air_date: "2023-01-15",
            seasons: [{ season_number: 1, episode_count: 30, air_date: "2023-01-15" }],
            external_ids: {
              imdb_id: "tt20242042",
              tvdb_id: 400100,
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

describe("Association revision history, locking, and reviewer external ID overrides (#12)", () => {
  const handles: TestDbHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop();
      if (handle) {
        await handle.cleanup();
      }
    }
  });

  test("returns ordered association revision history via session and read API key, preserving full snapshots across revisions", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const outbound = createFakeOutboundClient({
      fetchExternal: createTmdbStub(),
    });
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      adapterRegistry: createAdapterRegistry(),
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });

    const contributor = await signUpUser(app, outbound, {
      email: "contrib-rev@example.com",
      password: "StrongPassword123!",
      name: "Contributor",
    });
    const reviewer = await signUpUser(app, outbound, {
      email: "reviewer-rev@example.com",
      password: "StrongPassword123!",
      name: "Reviewer",
    });
    await testDb.writeDb
      .updateTable("user")
      .set({ role: "reviewer" })
      .where("id", "=", reviewer.userId)
      .execute();

    const submitKey = await issueApiKeyRpc(app, contributor.cookie, {
      name: "Submit",
      canSubmit: true,
    });
    const readKey = await issueApiKeyRpc(app, contributor.cookie, {
      name: "Read",
      canSubmit: false,
    });

    const submitRpc = createRpcClients(app, { apiKey: submitKey.key });
    const readRpc = createRpcClients(app, { apiKey: readKey.key });

    // Submit & approve revision 1
    const cr1 = await submitRpc.changeRequest.createChangeRequest({
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
    });

    const approve1 = await approveInCore(
      { db: testDb.writeDb, outbound },
      {
        reviewerUserId: reviewer.userId,
        id: cr1.changeRequest!.id,
        reason: "Initial confirmation",
      },
    );

    // Submit & approve revision 2 on the same association (extended to E1-24)
    const cr2 = await submitRpc.changeRequest.createChangeRequest({
      target: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
      namespace: "bilibili",
      nativeId: "ss34430",
      variantDescription: "原声",
      segments: [
        toProtoSegmentInput({
          season: 1,
          episodeStart: 1,
          episodeEnd: 24,
          targetEpisodeStart: 1,
          baseline: "tmdb",
        }),
      ],
    });

    const approve2 = await approveInCore(
      { db: testDb.writeDb, outbound },
      {
        reviewerUserId: reviewer.userId,
        id: cr2.changeRequest!.id,
        reason: "Updated full season range",
      },
    );
    expect(approve2.associationId).toBe(approve1.associationId);

    // Unauthenticated request -> 401
    expect(
      (
        await expectRpcError(
          createRpcClients(app).association.listAssociationRevisions({
            associationId: approve1.associationId,
          }),
        )
      ).status,
    ).toBe(401);

    // Invalid UUID -> 400
    expect(
      (
        await expectRpcError(
          readRpc.association.listAssociationRevisions({ associationId: "not-a-uuid" }),
        )
      ).status,
    ).toBe(400);

    // Non-existent UUID -> 404
    expect(
      (
        await expectRpcError(
          readRpc.association.listAssociationRevisions({
            associationId: "00000000-0000-4000-8000-000000000999",
          }),
        )
      ).status,
    ).toBe(404);

    // Authenticated via read API key -> returns ordered revisions 1..2 with full snapshots
    const revBody = await readRpc.association.listAssociationRevisions({
      associationId: approve1.associationId,
    });

    expect(revBody.total).toBe(2);
    expect(revBody.association).toMatchObject({
      id: approve1.associationId,
      mediaId: approve1.mediaId,
      namespace: "bilibili",
      nativeId: "ss34430",
      locked: false,
      currentRevisionId: approve2.revisionId,
    });
    expect(fromProtoAssociationStatus(revBody.association!.status)).toBe("confirmed");

    expect(revBody.revisions.map((r) => r.revisionNumber)).toEqual([1, 2]);
    expect(revBody.revisions[0]).toMatchObject({
      id: approve1.revisionId,
      revisionNumber: 1,
      changeRequestId: cr1.changeRequest!.id,
      actorUserId: reviewer.userId,
      submitterUserId: contributor.userId,
      reviewerUserId: reviewer.userId,
      reason: "Initial confirmation",
    });
    expect(fromProtoAssociationStatus(revBody.revisions[0]!.status)).toBe("confirmed");
    expect(revBody.revisions[0]?.segments).toEqual([
      expect.objectContaining({ season: 1, episodeStart: 1, episodeEnd: 12 }),
    ]);

    expect(revBody.revisions[1]).toMatchObject({
      id: approve2.revisionId,
      revisionNumber: 2,
      changeRequestId: cr2.changeRequest!.id,
      actorUserId: reviewer.userId,
      submitterUserId: contributor.userId,
      reviewerUserId: reviewer.userId,
      reason: "Updated full season range",
    });
    expect(fromProtoAssociationStatus(revBody.revisions[1]!.status)).toBe("confirmed");
    expect(revBody.revisions[1]?.segments).toEqual([
      expect.objectContaining({ season: 1, episodeStart: 1, episodeEnd: 24 }),
    ]);

    // Authenticated via session cookie (desc order) -> works as well
    const revDesc = await createRpcClients(app, {
      cookie: contributor.cookie,
    }).association.listAssociationRevisions({
      associationId: approve1.associationId,
      order: proto.SortOrder.DESC,
    });
    expect(revDesc.revisions.map((r) => r.revisionNumber)).toEqual([2, 1]);
  });

  test("allows reviewers to lock/unlock associations and rejects non-reviewers with 403", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const outbound = createFakeOutboundClient({
      fetchExternal: createTmdbStub(),
    });
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      adapterRegistry: createAdapterRegistry(),
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });

    const user = await signUpUser(app, outbound, {
      email: "regular-lock@example.com",
      password: "StrongPassword123!",
      name: "Regular",
    });
    const reviewer = await signUpUser(app, outbound, {
      email: "reviewer-lock@example.com",
      password: "StrongPassword123!",
      name: "Reviewer",
    });
    await testDb.writeDb
      .updateTable("user")
      .set({ role: "reviewer" })
      .where("id", "=", reviewer.userId)
      .execute();

    const submitKey = await issueApiKeyRpc(app, user.cookie, { name: "Submit", canSubmit: true });
    const readKey = await issueApiKeyRpc(app, user.cookie, { name: "Read", canSubmit: false });

    const submitRpc = createRpcClients(app, { apiKey: submitKey.key });
    const readRpc = createRpcClients(app, { apiKey: readKey.key });
    const userRpc = createRpcClients(app, { cookie: user.cookie });
    const reviewerRpc = createRpcClients(app, { cookie: reviewer.cookie });

    const cr = await submitRpc.changeRequest.createChangeRequest({
      target: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
      namespace: "bilibili",
      nativeId: "ss34430",
      variantDescription: "原声",
      segments: [
        toProtoSegmentInput({
          season: 1,
          episodeStart: 1,
          episodeEnd: 24,
          targetEpisodeStart: 1,
          baseline: "tmdb",
        }),
      ],
    });
    const approved = await approveInCore(
      { db: testDb.writeDb, outbound },
      { id: cr.changeRequest!.id },
    );

    // Non-reviewer gets 403
    expect(
      (
        await expectRpcError(
          userRpc.reviewer.setAssociationLock({
            associationId: approved.associationId,
            locked: true,
          }),
        )
      ).status,
    ).toBe(403);

    // Reviewer locks with omitted locked field (defaults to true)
    const lockBody = await reviewerRpc.reviewer.setAssociationLock({
      associationId: approved.associationId,
    });
    expect(lockBody.locked).toBe(true);
    expect(lockBody.associationId).toBe(approved.associationId);
    expect(lockBody.association?.locked).toBe(true);

    // Read API reflects locked=true
    const docLocked = fromProtoMediaDocument(
      (await readRpc.media.getMedia({ ref: mediaRef({ tmdb: { type: "tv", id: 95479 } }) }))
        .document!,
    );
    expect(docLocked.associations[0]?.locked).toBe(true);

    // Reviewer unlocks with { locked: false }
    const unlockBody = await reviewerRpc.reviewer.setAssociationLock({
      associationId: approved.associationId,
      locked: false,
    });
    expect(unlockBody.locked).toBe(false);
    expect(unlockBody.association?.locked).toBe(false);

    const docUnlocked = fromProtoMediaDocument(
      (await readRpc.media.getMedia({ ref: mediaRef({ tmdb: { type: "tv", id: 95479 } }) }))
        .document!,
    );
    expect(docUnlocked.associations[0]?.locked).toBeUndefined();
  });

  test("allows reviewers to override and lock external IDs, rejects 403/409 conflicts, and preserves locked overrides across TMDB daily sync", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    let tmdbImdbId = "tt12343534";
    let tmdbTvdbId = 377543;
    const outbound = createFakeOutboundClient({
      fetchExternal(req) {
        return createTmdbStub({ imdbId95479: tmdbImdbId, tvdbId95479: tmdbTvdbId })(req);
      },
    });

    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      adapterRegistry: createAdapterRegistry(),
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });

    const user = await signUpUser(app, outbound, {
      email: "user-extid@example.com",
      password: "StrongPassword123!",
      name: "User",
    });
    const reviewer = await signUpUser(app, outbound, {
      email: "reviewer-extid@example.com",
      password: "StrongPassword123!",
      name: "Reviewer",
    });
    await testDb.writeDb
      .updateTable("user")
      .set({ role: "reviewer" })
      .where("id", "=", reviewer.userId)
      .execute();

    const submitKey = await issueApiKeyRpc(app, user.cookie, { name: "Submit", canSubmit: true });
    const readKey = await issueApiKeyRpc(app, user.cookie, { name: "Read", canSubmit: false });

    const submitRpc = createRpcClients(app, { apiKey: submitKey.key });
    const readRpc = createRpcClients(app, { apiKey: readKey.key });
    const userRpc = createRpcClients(app, { cookie: user.cookie });
    const reviewerRpc = createRpcClients(app, { cookie: reviewer.cookie });

    // Create two media items (95479 and 108545) via submit + approve
    const createMedia = async (tmdbKey: string, nativeId: string) => {
      const cr = await submitRpc.changeRequest.createChangeRequest({
        target: mediaRef(tmdbKey),
        namespace: "bilibili",
        nativeId,
        variantDescription: "原声",
        segments: [toProtoSegmentInput({ season: 1, baseline: "tmdb" })],
      });
      return approveInCore({ db: testDb.writeDb, outbound }, { id: cr.changeRequest!.id });
    };

    const mediaA = await createMedia("tmdb:tv:95479", "ss34430");
    await createMedia("tmdb:tv:108545", "ss43123");

    // Non-reviewer gets 403 on override and lock
    expect(
      (
        await expectRpcError(
          userRpc.reviewer.overrideMediaExternalId({
            mediaId: mediaA.mediaId,
            namespace: "imdb",
            nativeId: "tt99999999",
          }),
        )
      ).status,
    ).toBe(403);

    expect(
      (
        await expectRpcError(
          userRpc.reviewer.setMediaExternalIdLock({
            mediaId: mediaA.mediaId,
            namespace: "imdb",
            locked: true,
          }),
        )
      ).status,
    ).toBe(403);

    // Duplicate (namespace, native_id) already owned by another media -> 409
    expect(
      (
        await expectRpcError(
          reviewerRpc.reviewer.overrideMediaExternalId({
            mediaId: mediaA.mediaId,
            namespace: "imdb",
            nativeId: "tt20242042",
          }),
        )
      ).status,
    ).toBe(409);

    // Reviewer overrides IMDb on mediaA (locked defaults to true, source becomes 'reviewer')
    const overrideBody = await reviewerRpc.reviewer.overrideMediaExternalId({
      mediaId: mediaA.mediaId,
      namespace: "imdb",
      nativeId: "tt88887777",
    });
    expect(overrideBody.externalId).toMatchObject({
      mediaId: mediaA.mediaId,
      namespace: "imdb",
      nativeId: "tt88887777",
      locked: true,
      source: "reviewer",
    });

    // Read API returns overridden & locked IMDb ID and lookup by new external key works
    const readDoc = fromProtoMediaDocument(
      (await readRpc.media.getMedia({ ref: mediaRef({ imdb: "tt88887777" }) })).document!,
    );
    expect(readDoc.media.id).toBe(mediaA.mediaId);
    expect(readDoc.externalIds).toContainEqual({
      namespace: "imdb",
      nativeId: "tt88887777",
      locked: true,
    });

    // Run TMDB daily sync with upstream returning a different IMDb & TVDB ID:
    // locked IMDb MUST stay "tt88887777", unlocked TVDB gets updated to "999888"
    tmdbImdbId = "tt11110000";
    tmdbTvdbId = 999888;
    const syncResult = await runTmdbDailySync(testDb.writeDb, outbound, {
      now: new Date("2026-11-24T04:00:00.000Z"),
      tmdbConfig: { accessToken: "test-tmdb-token" },
    });
    expect(syncResult.tv.refreshedCount).toBe(1);

    const afterSyncDoc = fromProtoMediaDocument(
      (await readRpc.media.getMedia({ ref: mediaRef({ tmdb: { type: "tv", id: 95479 } }) }))
        .document!,
    );
    expect(afterSyncDoc.externalIds).toContainEqual({
      namespace: "imdb",
      nativeId: "tt88887777",
      locked: true,
    });
    expect(afterSyncDoc.externalIds).toContainEqual({
      namespace: "tvdb",
      nativeId: "999888",
    });

    // Reviewer can toggle lock on existing external ID via SetMediaExternalIdLock
    const toggleBody = await reviewerRpc.reviewer.setMediaExternalIdLock({
      mediaId: mediaA.mediaId,
      namespace: "imdb",
      locked: false,
    });
    expect(toggleBody.externalId?.locked).toBe(false);

    // After unlocking, a subsequent TMDB sync CAN update IMDb
    const syncAfterUnlock = await runTmdbDailySync(testDb.writeDb, outbound, {
      now: new Date("2026-11-25T04:00:00.000Z"),
      tmdbConfig: { accessToken: "test-tmdb-token" },
    });
    expect(syncAfterUnlock.tv.refreshedCount).toBe(1);

    const afterUnlockDoc = fromProtoMediaDocument(
      (await readRpc.media.getMedia({ ref: mediaRef({ tmdb: { type: "tv", id: 95479 } }) }))
        .document!,
    );
    expect(afterUnlockDoc.externalIds).toContainEqual({
      namespace: "imdb",
      nativeId: "tt11110000",
    });
  });
});
