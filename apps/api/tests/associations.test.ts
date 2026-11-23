import type { MediaDocument } from "@media-ref/client";
import {
  createAdapterRegistry,
  createFakeOutboundClient,
  runTmdbDailySync,
  type EmailMessage,
  type ExternalHttpRequest,
} from "@media-ref/core";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { createApiApp } from "../src/app.ts";

const TEST_BASE_URL = "https://api.mediaref.org";
const TEST_AUTH_SECRET = "test-secret-for-media-ref-associations-locks-history-0123456789";

function extractCookieHeader(response: Response): string {
  const setCookies = response.headers.getSetCookie();
  return setCookies
    .map((entry) => entry.split(";")[0]?.trim())
    .filter((pair): pair is string => Boolean(pair))
    .join("; ");
}

function extractVerificationUrl(email: EmailMessage): string {
  const match = email.text.match(/https?:\/\/\S+\/api\/auth\/verify-email\?\S+/);
  if (!match) {
    throw new Error(`No verification URL found in email text: ${email.text}`);
  }
  return match[0];
}

async function signUpUser(
  app: ReturnType<typeof createApiApp>,
  outbound: ReturnType<typeof createFakeOutboundClient>,
  input: { email: string; password: string; name: string },
): Promise<{ userId: string; cookie: string }> {
  const emailsBefore = outbound.sentEmails.length;
  const signUpRes = await app.fetch(
    new Request(`${TEST_BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  expect(signUpRes.status).toBe(200);
  const signUpBody = (await signUpRes.json()) as { user: { id: string } };
  let cookie = extractCookieHeader(signUpRes);

  const verificationEmail = outbound.sentEmails[emailsBefore];
  expect(verificationEmail).toBeDefined();
  const verifyRes = await app.fetch(
    new Request(extractVerificationUrl(verificationEmail!), {
      method: "GET",
      headers: { cookie },
    }),
  );
  expect([200, 302]).toContain(verifyRes.status);
  const refreshed = extractCookieHeader(verifyRes);
  if (refreshed) {
    cookie = refreshed;
  }

  return { userId: signUpBody.user.id, cookie };
}

async function createApiKey(
  app: ReturnType<typeof createApiApp>,
  cookie: string,
  options: { name: string; canSubmit?: boolean },
): Promise<{ id: string; key: string }> {
  const res = await app.fetch(
    new Request(`${TEST_BASE_URL}/v1/api-keys`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        name: options.name,
        canSubmit: options.canSubmit ?? false,
      }),
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; key: string };
}

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

    const submitKey = await createApiKey(app, contributor.cookie, {
      name: "Submit",
      canSubmit: true,
    });
    const readKey = await createApiKey(app, contributor.cookie, {
      name: "Read",
      canSubmit: false,
    });

    // Submit & approve revision 1
    const cr1Res = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": submitKey.key },
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:95479",
          namespace: "bilibili",
          nativeId: "ss34430",
          variantDescription: "原声",
          segments: [
            { season: 1, episodeStart: 1, episodeEnd: 12, targetEpisodeStart: 1, baseline: "tmdb" },
          ],
        }),
      }),
    );
    expect(cr1Res.status).toBe(201);
    const cr1 = (await cr1Res.json()) as { changeRequest: { id: string } };

    const approve1Res = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/reviewer/change-requests/${cr1.changeRequest.id}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: reviewer.cookie },
        body: JSON.stringify({ reason: "Initial confirmation" }),
      }),
    );
    expect(approve1Res.status).toBe(200);
    const approve1 = (await approve1Res.json()) as {
      mediaId: string;
      associationId: string;
      revisionId: string;
    };

    // Submit & approve revision 2 on the same association (extended to E1-24)
    const cr2Res = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": submitKey.key },
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:95479",
          namespace: "bilibili",
          nativeId: "ss34430",
          variantDescription: "原声",
          segments: [
            { season: 1, episodeStart: 1, episodeEnd: 24, targetEpisodeStart: 1, baseline: "tmdb" },
          ],
        }),
      }),
    );
    expect(cr2Res.status).toBe(201);
    const cr2 = (await cr2Res.json()) as { changeRequest: { id: string } };

    const approve2Res = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/reviewer/change-requests/${cr2.changeRequest.id}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: reviewer.cookie },
        body: JSON.stringify({ reason: "Updated full season range" }),
      }),
    );
    expect(approve2Res.status).toBe(200);
    const approve2 = (await approve2Res.json()) as { associationId: string; revisionId: string };
    expect(approve2.associationId).toBe(approve1.associationId);

    // Unauthenticated request -> 401
    const unauthRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/associations/${approve1.associationId}/revisions`),
    );
    expect(unauthRes.status).toBe(401);

    // Invalid UUID -> 400
    const badIdRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/associations/not-a-uuid/revisions`, {
        headers: { "x-api-key": readKey.key },
      }),
    );
    expect(badIdRes.status).toBe(400);

    // Non-existent UUID -> 404
    const missingRes = await app.fetch(
      new Request(
        `${TEST_BASE_URL}/v1/associations/00000000-0000-4000-8000-000000000999/revisions`,
        {
          headers: { "x-api-key": readKey.key },
        },
      ),
    );
    expect(missingRes.status).toBe(404);

    // Authenticated via read API key -> returns ordered revisions 1..2 with full snapshots
    const revByKeyRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/associations/${approve1.associationId}/revisions`, {
        headers: { "x-api-key": readKey.key },
      }),
    );
    expect(revByKeyRes.status).toBe(200);
    const revBody = (await revByKeyRes.json()) as {
      association: {
        id: string;
        mediaId: string;
        namespace: string;
        nativeId: string;
        status: string;
        locked: boolean;
        currentRevisionId: string;
      };
      revisions: Array<{
        id: string;
        revisionNumber: number;
        changeRequestId: string | null;
        status: string;
        segments: Array<{ season: number; episodeStart: number; episodeEnd: number | null }>;
        actorUserId: string | null;
        submitterUserId: string | null;
        reviewerUserId: string | null;
        reason: string | null;
      }>;
      total: number;
    };

    expect(revBody.total).toBe(2);
    expect(revBody.association.id).toBe(approve1.associationId);
    expect(revBody.association.mediaId).toBe(approve1.mediaId);
    expect(revBody.association.namespace).toBe("bilibili");
    expect(revBody.association.nativeId).toBe("ss34430");
    expect(revBody.association.status).toBe("confirmed");
    expect(revBody.association.locked).toBe(false);
    expect(revBody.association.currentRevisionId).toBe(approve2.revisionId);

    expect(revBody.revisions.map((r) => r.revisionNumber)).toEqual([1, 2]);
    expect(revBody.revisions[0]).toMatchObject({
      id: approve1.revisionId,
      revisionNumber: 1,
      changeRequestId: cr1.changeRequest.id,
      status: "confirmed",
      actorUserId: reviewer.userId,
      submitterUserId: contributor.userId,
      reviewerUserId: reviewer.userId,
      reason: "Initial confirmation",
    });
    expect(revBody.revisions[0]?.segments).toEqual([
      expect.objectContaining({ season: 1, episodeStart: 1, episodeEnd: 12 }),
    ]);

    expect(revBody.revisions[1]).toMatchObject({
      id: approve2.revisionId,
      revisionNumber: 2,
      changeRequestId: cr2.changeRequest.id,
      status: "confirmed",
      actorUserId: reviewer.userId,
      submitterUserId: contributor.userId,
      reviewerUserId: reviewer.userId,
      reason: "Updated full season range",
    });
    expect(revBody.revisions[1]?.segments).toEqual([
      expect.objectContaining({ season: 1, episodeStart: 1, episodeEnd: 24 }),
    ]);

    // Authenticated via session cookie (desc order) -> works as well
    const revBySessionRes = await app.fetch(
      new Request(
        `${TEST_BASE_URL}/v1/associations/${approve1.associationId}/revisions?order=desc`,
        {
          headers: { cookie: contributor.cookie },
        },
      ),
    );
    expect(revBySessionRes.status).toBe(200);
    const revDesc = (await revBySessionRes.json()) as {
      revisions: Array<{ revisionNumber: number }>;
    };
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

    const submitKey = await createApiKey(app, user.cookie, { name: "Submit", canSubmit: true });
    const readKey = await createApiKey(app, user.cookie, { name: "Read", canSubmit: false });

    const crRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": submitKey.key },
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:95479",
          namespace: "bilibili",
          nativeId: "ss34430",
          variantDescription: "原声",
          segments: [
            { season: 1, episodeStart: 1, episodeEnd: 24, targetEpisodeStart: 1, baseline: "tmdb" },
          ],
        }),
      }),
    );
    const cr = (await crRes.json()) as { changeRequest: { id: string } };
    const approved = (await (
      await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/reviewer/change-requests/${cr.changeRequest.id}/approve`, {
          method: "POST",
          headers: { cookie: reviewer.cookie },
        }),
      )
    ).json()) as { associationId: string };

    // Non-reviewer gets 403
    const forbiddenRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/reviewer/associations/${approved.associationId}/lock`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: user.cookie },
        body: JSON.stringify({ locked: true }),
      }),
    );
    expect(forbiddenRes.status).toBe(403);

    // Reviewer locks with default body (empty body defaults locked=true)
    const lockRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/reviewer/associations/${approved.associationId}/lock`, {
        method: "POST",
        headers: { cookie: reviewer.cookie },
      }),
    );
    expect(lockRes.status).toBe(200);
    const lockBody = (await lockRes.json()) as {
      association: { id: string; locked: boolean };
      associationId: string;
      locked: boolean;
    };
    expect(lockBody.locked).toBe(true);
    expect(lockBody.associationId).toBe(approved.associationId);
    expect(lockBody.association.locked).toBe(true);

    // Read API reflects locked=true
    const docLocked = (await (
      await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:95479`, {
          headers: { "x-api-key": readKey.key },
        }),
      )
    ).json()) as { document: MediaDocument };
    expect(docLocked.document.associations[0]?.locked).toBe(true);

    // Reviewer unlocks with { locked: false }
    const unlockRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/reviewer/associations/${approved.associationId}/lock`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: reviewer.cookie },
        body: JSON.stringify({ locked: false }),
      }),
    );
    expect(unlockRes.status).toBe(200);
    const unlockBody = (await unlockRes.json()) as {
      association: { id: string; locked: boolean };
      locked: boolean;
    };
    expect(unlockBody.locked).toBe(false);
    expect(unlockBody.association.locked).toBe(false);

    const docUnlocked = (await (
      await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:95479`, {
          headers: { "x-api-key": readKey.key },
        }),
      )
    ).json()) as { document: MediaDocument };
    expect(docUnlocked.document.associations[0]?.locked).toBeUndefined();
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

    const submitKey = await createApiKey(app, user.cookie, { name: "Submit", canSubmit: true });
    const readKey = await createApiKey(app, user.cookie, { name: "Read", canSubmit: false });

    // Create two media items (95479 and 108545) via submit + approve
    const createMedia = async (tmdbKey: string, nativeId: string) => {
      const crRes = await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": submitKey.key },
          body: JSON.stringify({
            targetExternalKey: tmdbKey,
            namespace: "bilibili",
            nativeId,
            variantDescription: "原声",
            segments: [{ season: 1, baseline: "tmdb" }],
          }),
        }),
      );
      const cr = (await crRes.json()) as { changeRequest: { id: string } };
      const approveRes = await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/reviewer/change-requests/${cr.changeRequest.id}/approve`, {
          method: "POST",
          headers: { cookie: reviewer.cookie },
        }),
      );
      expect(approveRes.status).toBe(200);
      return (await approveRes.json()) as { mediaId: string };
    };

    const mediaA = await createMedia("tmdb:tv:95479", "ss34430");
    await createMedia("tmdb:tv:108545", "ss43123");

    // Non-reviewer gets 403 on PUT override and POST lock
    expect(
      (
        await app.fetch(
          new Request(`${TEST_BASE_URL}/v1/reviewer/media/${mediaA.mediaId}/external-ids/imdb`, {
            method: "PUT",
            headers: { "content-type": "application/json", cookie: user.cookie },
            body: JSON.stringify({ nativeId: "tt99999999" }),
          }),
        )
      ).status,
    ).toBe(403);

    expect(
      (
        await app.fetch(
          new Request(
            `${TEST_BASE_URL}/v1/reviewer/media/${mediaA.mediaId}/external-ids/imdb/lock`,
            {
              method: "POST",
              headers: { "content-type": "application/json", cookie: user.cookie },
              body: JSON.stringify({ locked: true }),
            },
          ),
        )
      ).status,
    ).toBe(403);

    // Duplicate (namespace, native_id) already owned by another media -> 409
    const duplicateRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/reviewer/media/${mediaA.mediaId}/external-ids/imdb`, {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: reviewer.cookie },
        body: JSON.stringify({ nativeId: "tt20242042" }),
      }),
    );
    expect(duplicateRes.status).toBe(409);

    // Reviewer overrides IMDb on mediaA (locked defaults to true, source becomes 'reviewer')
    const overrideRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/reviewer/media/${mediaA.mediaId}/external-ids/imdb`, {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: reviewer.cookie },
        body: JSON.stringify({ nativeId: "tt88887777" }),
      }),
    );
    expect(overrideRes.status).toBe(200);
    const overrideBody = (await overrideRes.json()) as {
      externalId: {
        mediaId: string;
        namespace: string;
        nativeId: string;
        locked: boolean;
        source: string;
      };
    };
    expect(overrideBody.externalId).toMatchObject({
      mediaId: mediaA.mediaId,
      namespace: "imdb",
      nativeId: "tt88887777",
      locked: true,
      source: "reviewer",
    });

    // Read API returns overridden & locked IMDb ID and lookup by new external key works
    const readByNewImdb = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/imdb:tt88887777`, {
        headers: { "x-api-key": readKey.key },
      }),
    );
    expect(readByNewImdb.status).toBe(200);
    const readDoc = (await readByNewImdb.json()) as { document: MediaDocument };
    expect(readDoc.document.media.id).toBe(mediaA.mediaId);
    expect(readDoc.document.externalIds).toContainEqual({
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

    const afterSyncDoc = (await (
      await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:95479`, {
          headers: { "x-api-key": readKey.key },
        }),
      )
    ).json()) as { document: MediaDocument };
    expect(afterSyncDoc.document.externalIds).toContainEqual({
      namespace: "imdb",
      nativeId: "tt88887777",
      locked: true,
    });
    expect(afterSyncDoc.document.externalIds).toContainEqual({
      namespace: "tvdb",
      nativeId: "999888",
    });

    // Reviewer can toggle lock on existing external ID via POST .../lock
    const toggleLockRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/reviewer/media/${mediaA.mediaId}/external-ids/imdb/lock`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: reviewer.cookie },
        body: JSON.stringify({ locked: false }),
      }),
    );
    expect(toggleLockRes.status).toBe(200);
    const toggleBody = (await toggleLockRes.json()) as {
      externalId: { namespace: string; nativeId: string; locked: boolean };
    };
    expect(toggleBody.externalId.locked).toBe(false);

    // After unlocking, a subsequent TMDB sync CAN update IMDb
    const syncAfterUnlock = await runTmdbDailySync(testDb.writeDb, outbound, {
      now: new Date("2026-11-25T04:00:00.000Z"),
      tmdbConfig: { accessToken: "test-tmdb-token" },
    });
    expect(syncAfterUnlock.tv.refreshedCount).toBe(1);

    const afterUnlockDoc = (await (
      await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:95479`, {
          headers: { "x-api-key": readKey.key },
        }),
      )
    ).json()) as { document: MediaDocument };
    expect(afterUnlockDoc.document.externalIds).toContainEqual({
      namespace: "imdb",
      nativeId: "tt11110000",
    });
  });
});
