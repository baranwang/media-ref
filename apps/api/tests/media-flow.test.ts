import { resolveEpisode, type MediaDocument } from "@media-ref/client";
import {
  createFakeOutboundClient,
  type EmailMessage,
  type ExternalHttpRequest,
} from "@media-ref/core";
import { createDb } from "@media-ref/db";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { createApiApp } from "../src/index.ts";

const TEST_BASE_URL = "https://api.mediaref.org";
const TEST_AUTH_SECRET = "test-secret-for-media-ref-media-flow-integration-tests-0123456789";

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
  input: { email: string; password: string; name: string; verify?: boolean },
): Promise<{ userId: string; cookie: string }> {
  const emailsBefore = outbound.sentEmails.length;
  const signUpRes = await app.fetch(
    new Request(`${TEST_BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: input.email,
        password: input.password,
        name: input.name,
      }),
    }),
  );
  expect(signUpRes.status).toBe(200);
  const signUpBody = (await signUpRes.json()) as { user: { id: string } };
  let cookie = extractCookieHeader(signUpRes);

  if (input.verify) {
    const email = outbound.sentEmails[emailsBefore];
    expect(email).toBeDefined();
    const verifyRes = await app.fetch(
      new Request(extractVerificationUrl(email!), {
        method: "GET",
        headers: { cookie },
      }),
    );
    expect([200, 302]).toContain(verifyRes.status);
    const refreshed = extractCookieHeader(verifyRes);
    if (refreshed) {
      cookie = refreshed;
    }
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
            seasons: [
              { season_number: 0, episode_count: 5, air_date: "2020-12-26" },
              { season_number: 1, episode_count: 47, air_date: "2020-10-03" },
            ],
            external_ids: {
              imdb_id: "tt12343534",
              tvdb_id: 377543,
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
      if (request.url.includes("/movie/550")) {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          url: request.url,
          body: JSON.stringify({
            id: 550,
            title: "搏击俱乐部",
            original_title: "Fight Club",
            release_date: "1999-10-15",
            external_ids: {
              imdb_id: "tt0137523",
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
      if (request.url.includes("/search/tmdb/95479?type=show")) {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          url: request.url,
          body: JSON.stringify([
            {
              type: "show",
              score: 1000,
              show: {
                title: "Jujutsu Kaisen",
                year: 2020,
                ids: {
                  trakt: 159384,
                  slug: "jujutsu-kaisen",
                  tvdb: 377543,
                  imdb: "tt12343534",
                  tmdb: 95479,
                },
              },
            },
          ]),
        };
      }
      if (request.url.includes("/search/tmdb/550?type=movie")) {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          url: request.url,
          body: JSON.stringify([
            {
              type: "movie",
              score: 1000,
              movie: {
                title: "Fight Club",
                year: 1999,
                ids: {
                  trakt: 727,
                  slug: "fight-club-1999",
                  imdb: "tt0137523",
                  tmdb: 550,
                },
              },
            },
          ]),
        };
      }
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

describe("API Worker core write -> review -> read media flow (#8)", () => {
  const handles: TestDbHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop();
      if (handle) {
        await handle.cleanup();
      }
    }
  });

  test("submits change requests for uncreated media, approves via reviewer creating TMDB snapshot + external IDs, reads MediaDocument, and resolves S1E30 -> ss45574 ep 6", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const outbound = createFakeOutboundClient({
      fetchExternal: createCatalogStubHandler(),
    });

    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        tmdb: {
          accessToken: "test-tmdb-token",
          traktClientId: "test-trakt-client-id",
        },
      },
    });

    const submitter = await signUpUser(app, outbound, {
      email: "contributor@example.com",
      password: "StrongPassword123!",
      name: "Contributor",
      verify: true,
    });
    const owner = await signUpUser(app, outbound, {
      email: "owner@example.com",
      password: "StrongPassword123!",
      name: "Owner",
      verify: true,
    });
    await testDb.writeDb
      .updateTable("user")
      .set({ role: "owner" })
      .where("id", "=", owner.userId)
      .execute();

    const submitKey = await createApiKey(app, submitter.cookie, {
      name: "Submit Key",
      canSubmit: true,
    });
    const readKey = await createApiKey(app, submitter.cookie, {
      name: "Read Key",
      canSubmit: false,
    });

    // Submit CR #1 for Jujutsu Kaisen (tmdb:tv:95479 does not exist in DB yet)
    const cr1Res = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": submitKey.key,
        },
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:95479",
          namespace: "bilibili",
          nativeId: "ss34430",
          variantDescription: "原声",
          segments: [
            {
              season: 1,
              episodeStart: 1,
              episodeEnd: 24,
              targetEpisodeStart: 1,
              baseline: "tmdb",
            },
          ],
        }),
      }),
    );
    expect(cr1Res.status).toBe(201);
    const cr1Body = (await cr1Res.json()) as {
      changeRequest: {
        id: string;
        status: string;
        mediaId: string | null;
        targetExternalKey: string;
        namespace: string;
        nativeId: string;
      };
    };
    expect(cr1Body.changeRequest.id).toBeTruthy();
    expect(cr1Body.changeRequest.status).toBe("needs_review");
    expect(cr1Body.changeRequest.mediaId).toBeNull();
    expect(cr1Body.changeRequest.targetExternalKey).toBe("tmdb:tv:95479");
    expect(cr1Body.changeRequest.namespace).toBe("bilibili");
    expect(cr1Body.changeRequest.nativeId).toBe("ss34430");

    // Media must NOT exist yet before reviewer approves
    const preApproveRead = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:95479`, {
        headers: { "x-api-key": readKey.key },
      }),
    );
    expect(preApproveRead.status).toBe(404);
    expect(outbound.httpRequests).toHaveLength(0);

    // Submitter can inspect the pending change request via GET /v1/change-requests/:id
    const inspectCr1Res = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests/${cr1Body.changeRequest.id}`, {
        headers: { "x-api-key": submitKey.key },
      }),
    );
    expect(inspectCr1Res.status).toBe(200);
    expect(await inspectCr1Res.json()).toMatchObject({
      changeRequest: {
        id: cr1Body.changeRequest.id,
        status: "needs_review",
      },
    });

    // Reviewer sees CR #1 in review queue
    const queueRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/reviewer/change-requests`, {
        headers: { cookie: owner.cookie },
      }),
    );
    expect(queueRes.status).toBe(200);
    const queueBody = (await queueRes.json()) as {
      changeRequests: Array<{ id: string; status: string }>;
      total: number;
    };
    expect(queueBody.total).toBe(1);
    expect(queueBody.changeRequests[0]?.id).toBe(cr1Body.changeRequest.id);

    // Reviewer approves CR #1 -> creates media with TMDB minimal snapshot + IMDb/TVDB/Trakt external IDs
    const approve1Res = await app.fetch(
      new Request(
        `${TEST_BASE_URL}/v1/reviewer/change-requests/${cr1Body.changeRequest.id}/approve`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: owner.cookie,
          },
          body: JSON.stringify({ reason: "Verified S1 part 1 on Bilibili" }),
        },
      ),
    );
    expect(approve1Res.status).toBe(200);
    const approve1Body = (await approve1Res.json()) as {
      changeRequest: { id: string; status: string; decisionReason: string | null };
      mediaId: string;
      associationId: string;
      revisionId: string;
    };
    expect(approve1Body.changeRequest.status).toBe("approved");
    expect(approve1Body.changeRequest.decisionReason).toBe("Verified S1 part 1 on Bilibili");
    expect(approve1Body.mediaId).toBeTruthy();
    expect(approve1Body.associationId).toBeTruthy();
    expect(approve1Body.revisionId).toBeTruthy();

    // Submit CR #2 for S1 E25-47 (ss45574) in the same default variant ("原声") and approve
    const cr2Res = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": submitKey.key,
        },
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:95479",
          namespace: "bilibili",
          nativeId: "ss45574",
          variantDescription: "原声",
          segments: [
            {
              season: 1,
              episodeStart: 25,
              episodeEnd: 47,
              targetEpisodeStart: 1,
              baseline: "tmdb",
            },
          ],
        }),
      }),
    );
    expect(cr2Res.status).toBe(201);
    const cr2Body = (await cr2Res.json()) as { changeRequest: { id: string } };

    const approve2Res = await app.fetch(
      new Request(
        `${TEST_BASE_URL}/v1/reviewer/change-requests/${cr2Body.changeRequest.id}/approve`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: owner.cookie,
          },
          body: JSON.stringify({ reason: "Verified S1 part 2 on Bilibili" }),
        },
      ),
    );
    expect(approve2Res.status).toBe(200);
    const approve2Body = (await approve2Res.json()) as { associationId: string };

    // Read by tmdb:tv:95479
    const byTmdbRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:95479`, {
        headers: { "x-api-key": readKey.key },
      }),
    );
    expect(byTmdbRes.status).toBe(200);
    const byTmdbBody = (await byTmdbRes.json()) as {
      document: MediaDocument;
      matchedAssociationId: string | null;
    };
    expect(byTmdbBody.matchedAssociationId).toBeNull();
    expect(byTmdbBody.document.media).toEqual({
      id: approve1Body.mediaId,
      type: "tv",
      baseline: "tmdb",
      snapshot: {
        title: "咒术回战",
        originalTitle: "呪術廻戦",
        year: 2020,
        type: "tv",
        seasons: [
          { season: 0, episodeCount: 5, airYear: 2020 },
          { season: 1, episodeCount: 47, airYear: 2020 },
        ],
      },
    });
    expect(byTmdbBody.document.externalIds).toEqual(
      expect.arrayContaining([
        { namespace: "tmdb", nativeId: "tv:95479" },
        { namespace: "imdb", nativeId: "tt12343534" },
        { namespace: "tvdb", nativeId: "377543" },
        { namespace: "trakt", nativeId: "show:159384" },
      ]),
    );
    expect(byTmdbBody.document.variants).toHaveLength(1);
    expect(byTmdbBody.document.variants[0]).toMatchObject({
      namespace: "bilibili",
      label: "原声",
      isDefault: true,
    });
    expect(byTmdbBody.document.associations).toHaveLength(2);

    // Read by media UUID, IMDb, TVDB, Trakt, and platform collection reverse key
    const byUuidRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/${approve1Body.mediaId}`, {
        headers: { authorization: `Bearer ${readKey.key}` },
      }),
    );
    expect(byUuidRes.status).toBe(200);
    const byUuidBody = (await byUuidRes.json()) as {
      document: MediaDocument;
      matchedAssociationId: string | null;
    };
    expect(byUuidBody.document.media.id).toBe(approve1Body.mediaId);
    expect(byUuidBody.matchedAssociationId).toBeNull();

    for (const extKey of ["imdb:tt12343534", "tvdb:377543", "trakt:show:159384"]) {
      const extRes = await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/media/${extKey}`, {
          headers: { "x-api-key": readKey.key },
        }),
      );
      expect(extRes.status).toBe(200);
      const extBody = (await extRes.json()) as { document: MediaDocument };
      expect(extBody.document.media.id).toBe(approve1Body.mediaId);
    }

    // Read by platform collection key marks matchedAssociationId
    const byCollectionRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/bilibili:ss45574`, {
        headers: { "x-api-key": readKey.key },
      }),
    );
    expect(byCollectionRes.status).toBe(200);
    const byCollectionBody = (await byCollectionRes.json()) as {
      document: MediaDocument;
      matchedAssociationId: string | null;
    };
    expect(byCollectionBody.matchedAssociationId).toBe(approve2Body.associationId);
    expect(byCollectionBody.document.matchedAssociationIds).toEqual([approve2Body.associationId]);

    // Pass returned MediaDocument directly into @media-ref/client's resolveEpisode!
    const resolvedS1E30 = resolveEpisode(byTmdbBody.document, {
      namespace: "bilibili",
      season: 1,
      episode: 30,
    });
    expect(resolvedS1E30).toMatchObject({
      kind: "mapped",
      associationId: approve2Body.associationId,
      namespace: "bilibili",
      nativeId: "ss45574",
      targetEpisode: 6,
    });
  });

  test("prevents concurrent approvals of overlapping segments in the same variant via PostgreSQL transaction locks", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const outbound = createFakeOutboundClient({
      fetchExternal: createCatalogStubHandler(),
    });
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        tmdb: { accessToken: "test-tmdb-token", traktClientId: "test-trakt-client-id" },
        submitBaseHourlyLimit: 20,
      },
    });

    const user = await signUpUser(app, outbound, {
      email: "concurrent@example.com",
      password: "StrongPassword123!",
      name: "Concurrent Submitter",
      verify: true,
    });
    const owner = await signUpUser(app, outbound, {
      email: "owner-concurrent@example.com",
      password: "StrongPassword123!",
      name: "Owner",
      verify: true,
    });
    await testDb.writeDb
      .updateTable("user")
      .set({ role: "owner" })
      .where("id", "=", owner.userId)
      .execute();

    const submitKey = await createApiKey(app, user.cookie, { name: "Submit", canSubmit: true });
    const readKey = await createApiKey(app, user.cookie, { name: "Read", canSubmit: false });

    // Seed an existing media + variant by approving a non-overlapping segment (S1 E1-10)
    const seedCrRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": submitKey.key },
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:95479",
          namespace: "bilibili",
          nativeId: "ss10001",
          variantDescription: "原声",
          segments: [
            { season: 1, episodeStart: 1, episodeEnd: 10, targetEpisodeStart: 1, baseline: "tmdb" },
          ],
        }),
      }),
    );
    expect(seedCrRes.status).toBe(201);
    const seedCr = (await seedCrRes.json()) as { changeRequest: { id: string } };

    const seedApprove = await app.fetch(
      new Request(
        `${TEST_BASE_URL}/v1/reviewer/change-requests/${seedCr.changeRequest.id}/approve`,
        {
          method: "POST",
          headers: { cookie: owner.cookie },
        },
      ),
    );
    expect(seedApprove.status).toBe(200);

    const mediaDocRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:95479`, {
        headers: { "x-api-key": readKey.key },
      }),
    );
    const mediaDoc = (await mediaDocRes.json()) as { document: MediaDocument };
    const variantId = mediaDoc.document.variants[0]!.id;

    // Submit two pending CRs with overlapping ranges in the same existing variant:
    // CR A: S1 E11-25, CR B: S1 E20-35 (overlap on E20-25). Neither is approved yet.
    const [crARes, crBRes] = await Promise.all([
      app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": submitKey.key },
          body: JSON.stringify({
            targetExternalKey: "tmdb:tv:95479",
            namespace: "bilibili",
            nativeId: "ss10002",
            variantId,
            segments: [
              {
                season: 1,
                episodeStart: 11,
                episodeEnd: 25,
                targetEpisodeStart: 1,
                baseline: "tmdb",
              },
            ],
          }),
        }),
      ),
      app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": submitKey.key },
          body: JSON.stringify({
            targetExternalKey: "tmdb:tv:95479",
            namespace: "bilibili",
            nativeId: "ss10003",
            variantId,
            segments: [
              {
                season: 1,
                episodeStart: 20,
                episodeEnd: 35,
                targetEpisodeStart: 1,
                baseline: "tmdb",
              },
            ],
          }),
        }),
      ),
    ]);
    expect(crARes.status).toBe(201);
    expect(crBRes.status).toBe(201);
    const crA = (await crARes.json()) as { changeRequest: { id: string } };
    const crB = (await crBRes.json()) as { changeRequest: { id: string } };

    // Approve BOTH concurrently against real PostgreSQL 19!
    const [approveARes, approveBRes] = await Promise.all([
      app.fetch(
        new Request(
          `${TEST_BASE_URL}/v1/reviewer/change-requests/${crA.changeRequest.id}/approve`,
          {
            method: "POST",
            headers: { cookie: owner.cookie },
          },
        ),
      ),
      app.fetch(
        new Request(
          `${TEST_BASE_URL}/v1/reviewer/change-requests/${crB.changeRequest.id}/approve`,
          {
            method: "POST",
            headers: { cookie: owner.cookie },
          },
        ),
      ),
    ]);

    const statuses = [approveARes.status, approveBRes.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);

    const failedRes = approveARes.status === 409 ? approveARes : approveBRes;
    expect(await failedRes.json()).toMatchObject({ error: "SEGMENT_OVERLAP" });

    // Confirm zero overlapping rows exist in the database / MediaDocument
    const afterDocRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:95479`, {
        headers: { "x-api-key": readKey.key },
      }),
    );
    expect(afterDocRes.status).toBe(200);
    const afterDoc = (await afterDocRes.json()) as { document: MediaDocument };
    expect(afterDoc.document.associations).toHaveLength(2);
    const nativeIds = afterDoc.document.associations.map((a) => a.nativeId);
    expect(nativeIds).toContain("ss10001");
    expect(nativeIds.includes("ss10002") !== nativeIds.includes("ss10003")).toBe(true);

    // Also test 4 concurrent overlapping approvals on a BRAND-NEW uncreated media (tmdb:tv:108545)
    const pendingNewMediaIds: string[] = [];
    for (let i = 1; i <= 4; i++) {
      const res = await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": submitKey.key },
          body: JSON.stringify({
            targetExternalKey: "tmdb:tv:108545",
            namespace: "tencent",
            nativeId: `mzc00200000000${i}`,
            variantDescription: "原声",
            segments: [
              {
                season: 1,
                episodeStart: 1,
                episodeEnd: 30,
                targetEpisodeStart: 1,
                baseline: "tmdb",
              },
            ],
          }),
        }),
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as { changeRequest: { id: string } };
      pendingNewMediaIds.push(body.changeRequest.id);
    }

    const concurrentNewResults = await Promise.all(
      pendingNewMediaIds.map(async (id) =>
        app.fetch(
          new Request(`${TEST_BASE_URL}/v1/reviewer/change-requests/${id}/approve`, {
            method: "POST",
            headers: { cookie: owner.cookie },
          }),
        ),
      ),
    );
    const newStatuses = concurrentNewResults.map((r) => r.status).sort((a, b) => a - b);
    expect(newStatuses).toEqual([200, 409, 409, 409]);

    const santiDocRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:108545`, {
        headers: { "x-api-key": readKey.key },
      }),
    );
    expect(santiDocRes.status).toBe(200);
    const santiDoc = (await santiDocRes.json()) as { document: MediaDocument };
    expect(santiDoc.document.variants).toHaveLength(1);
    expect(santiDoc.document.associations).toHaveLength(1);
  });

  test("rejects invalid and overlapping segments immediately at submission time, including shared-collection conflicts", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const outbound = createFakeOutboundClient({
      fetchExternal: createCatalogStubHandler(),
    });
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });

    const user = await signUpUser(app, outbound, {
      email: "validator@example.com",
      password: "StrongPassword123!",
      name: "Validator",
      verify: true,
    });
    const owner = await signUpUser(app, outbound, {
      email: "owner-val@example.com",
      password: "StrongPassword123!",
      name: "Owner",
      verify: true,
    });
    await testDb.writeDb
      .updateTable("user")
      .set({ role: "owner" })
      .where("id", "=", owner.userId)
      .execute();

    const submitKey = await createApiKey(app, user.cookie, { name: "Submit", canSubmit: true });

    // Invalid segment syntax (episodeEnd < episodeStart)
    const badSyntaxRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": submitKey.key },
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:95479",
          namespace: "bilibili",
          nativeId: "ss34430",
          variantDescription: "原声",
          segments: [
            { season: 1, episodeStart: 10, episodeEnd: 5, targetEpisodeStart: 1, baseline: "tmdb" },
          ],
        }),
      }),
    );
    expect(badSyntaxRes.status).toBe(400);
    expect(await badSyntaxRes.json()).toMatchObject({ error: "INVALID_SEGMENTS" });

    // Approve initial association ss34430 (S1 E1-24, target 1..24) on tmdb:tv:95479
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
            { season: 1, episodeStart: 1, episodeEnd: 24, targetEpisodeStart: 1, baseline: "tmdb" },
          ],
        }),
      }),
    );
    expect(cr1Res.status).toBe(201);
    const cr1 = (await cr1Res.json()) as { changeRequest: { id: string } };
    expect(
      (
        await app.fetch(
          new Request(
            `${TEST_BASE_URL}/v1/reviewer/change-requests/${cr1.changeRequest.id}/approve`,
            {
              method: "POST",
              headers: { cookie: owner.cookie },
            },
          ),
        )
      ).status,
    ).toBe(200);

    // Submitting a new overlapping association in the same variant is rejected immediately (400)
    const overlapSubmitRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": submitKey.key },
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:95479",
          namespace: "bilibili",
          nativeId: "ss88888",
          variantDescription: "原声",
          segments: [
            {
              season: 1,
              episodeStart: 20,
              episodeEnd: 30,
              targetEpisodeStart: 1,
              baseline: "tmdb",
            },
          ],
        }),
      }),
    );
    expect(overlapSubmitRes.status).toBe(400);
    expect(await overlapSubmitRes.json()).toMatchObject({ error: "SEGMENT_OVERLAP" });

    // Submitting the same collection ss34430 on ANOTHER media with overlapping target range [10..19] is rejected
    const sharedOverlapRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": submitKey.key },
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:108545",
          namespace: "bilibili",
          nativeId: "ss34430",
          variantDescription: "原声",
          segments: [
            {
              season: 1,
              episodeStart: 1,
              episodeEnd: 10,
              targetEpisodeStart: 10,
              baseline: "tmdb",
            },
          ],
        }),
      }),
    );
    expect(sharedOverlapRes.status).toBe(400);
    expect(await sharedOverlapRes.json()).toMatchObject({ error: "SEGMENT_OVERLAP" });
  });

  test("handles rejection, association revision updates, movie whole-media associations, catalog associations, and default variant switching", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const outbound = createFakeOutboundClient({
      fetchExternal: createCatalogStubHandler(),
    });
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        tmdb: { accessToken: "test-tmdb-token", traktClientId: "test-trakt-client-id" },
      },
    });

    const user = await signUpUser(app, outbound, {
      email: "editor@example.com",
      password: "StrongPassword123!",
      name: "Editor",
      verify: true,
    });
    const owner = await signUpUser(app, outbound, {
      email: "owner-ed@example.com",
      password: "StrongPassword123!",
      name: "Owner",
      verify: true,
    });
    await testDb.writeDb
      .updateTable("user")
      .set({ role: "owner" })
      .where("id", "=", owner.userId)
      .execute();

    const submitKey = await createApiKey(app, user.cookie, { name: "Submit", canSubmit: true });
    const readKey = await createApiKey(app, user.cookie, { name: "Read", canSubmit: false });

    // 1. Rejected change request does not create media or appear in GET /v1/media
    const rejectedCrRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": submitKey.key },
        body: JSON.stringify({
          targetExternalKey: "tmdb:tv:95479",
          namespace: "bilibili",
          nativeId: "ss99999",
          variantDescription: "原声",
          segments: [
            { season: 1, episodeStart: 1, episodeEnd: 24, targetEpisodeStart: 1, baseline: "tmdb" },
          ],
        }),
      }),
    );
    expect(rejectedCrRes.status).toBe(201);
    const rejectedCr = (await rejectedCrRes.json()) as { changeRequest: { id: string } };

    const rejectRes = await app.fetch(
      new Request(
        `${TEST_BASE_URL}/v1/reviewer/change-requests/${rejectedCr.changeRequest.id}/reject`,
        {
          method: "POST",
          headers: { "content-type": "application/json", cookie: owner.cookie },
          body: JSON.stringify({ reason: "Wrong collection ID" }),
        },
      ),
    );
    expect(rejectRes.status).toBe(200);
    expect(await rejectRes.json()).toMatchObject({
      changeRequest: {
        id: rejectedCr.changeRequest.id,
        status: "rejected",
        decisionReason: "Wrong collection ID",
        reviewerUserId: owner.userId,
      },
    });

    // Rejected CR cannot be approved afterwards and does not appear in GET /v1/media
    const approveRejectedRes = await app.fetch(
      new Request(
        `${TEST_BASE_URL}/v1/reviewer/change-requests/${rejectedCr.changeRequest.id}/approve`,
        {
          method: "POST",
          headers: { cookie: owner.cookie },
        },
      ),
    );
    expect(approveRejectedRes.status).toBe(409);

    const readAfterReject = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:95479`, {
        headers: { "x-api-key": readKey.key },
      }),
    );
    expect(readAfterReject.status).toBe(404);

    // 2. Movie whole-media submission + revision 2 update + default variant switch + catalog association
    const movieCr1Res = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: user.cookie },
        body: JSON.stringify({
          targetExternalKey: "tmdb:movie:550",
          namespace: "youku",
          nativeId: "cc001f06962411de83b1",
          variantDescription: "原声",
          segments: [],
        }),
      }),
    );
    expect(movieCr1Res.status).toBe(201);
    const movieCr1 = (await movieCr1Res.json()) as { changeRequest: { id: string } };

    const movieApp1Res = await app.fetch(
      new Request(
        `${TEST_BASE_URL}/v1/reviewer/change-requests/${movieCr1.changeRequest.id}/approve`,
        {
          method: "POST",
          headers: { "content-type": "application/json", cookie: owner.cookie },
          body: JSON.stringify({ reason: "Initial approval" }),
        },
      ),
    );
    expect(movieApp1Res.status).toBe(200);
    const movieApp1 = (await movieApp1Res.json()) as {
      associationId: string;
      revisionId: string;
    };

    // Submit a second CR updating the same collection -> creates revision 2
    const movieCr2Res = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": submitKey.key },
        body: JSON.stringify({
          targetExternalKey: "tmdb:movie:550",
          namespace: "youku",
          nativeId: "cc001f06962411de83b1",
          variantDescription: "国配",
          setDefaultVariant: true,
          segments: [],
        }),
      }),
    );
    expect(movieCr2Res.status).toBe(201);
    const movieCr2 = (await movieCr2Res.json()) as { changeRequest: { id: string } };

    const movieApp2Res = await app.fetch(
      new Request(
        `${TEST_BASE_URL}/v1/reviewer/change-requests/${movieCr2.changeRequest.id}/approve`,
        {
          method: "POST",
          headers: { "content-type": "application/json", cookie: owner.cookie },
          body: JSON.stringify({ reason: "Reclassified as Mandarin dub and set default" }),
        },
      ),
    );
    expect(movieApp2Res.status).toBe(200);
    const movieApp2 = (await movieApp2Res.json()) as {
      associationId: string;
      revisionId: string;
    };
    expect(movieApp2.associationId).toBe(movieApp1.associationId);
    expect(movieApp2.revisionId).not.toBe(movieApp1.revisionId);

    // Check revision history preserves both revisions
    const revisions = await testDb.readDb
      .selectFrom("association_revisions")
      .select(["id", "revision_number"])
      .where("association_id", "=", movieApp1.associationId)
      .orderBy("revision_number", "asc")
      .execute();
    expect(revisions.map((r) => r.revision_number)).toEqual([1, 2]);
    expect(revisions[1]?.id).toBe(movieApp2.revisionId);

    // Add a Douban catalog association (no variant)
    const doubanCrRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/change-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": submitKey.key },
        body: JSON.stringify({
          targetExternalKey: "tmdb:movie:550",
          namespace: "douban",
          nativeId: "1292052",
          segments: [],
        }),
      }),
    );
    expect(doubanCrRes.status).toBe(201);
    const doubanCr = (await doubanCrRes.json()) as { changeRequest: { id: string } };
    expect(
      (
        await app.fetch(
          new Request(
            `${TEST_BASE_URL}/v1/reviewer/change-requests/${doubanCr.changeRequest.id}/approve`,
            {
              method: "POST",
              headers: { cookie: owner.cookie },
            },
          ),
        )
      ).status,
    ).toBe(200);

    const movieDocRes = await app.fetch(
      new Request(`${TEST_BASE_URL}/v1/media/douban:1292052`, {
        headers: { "x-api-key": readKey.key },
      }),
    );
    expect(movieDocRes.status).toBe(200);
    const movieDocBody = (await movieDocRes.json()) as {
      document: MediaDocument;
      matchedAssociationId: string | null;
    };
    expect(movieDocBody.matchedAssociationId).toBeTruthy();
    expect(movieDocBody.document.media.snapshot).toEqual({
      title: "搏击俱乐部",
      originalTitle: "Fight Club",
      year: 1999,
      type: "movie",
      seasons: [],
    });
    expect(movieDocBody.document.externalIds).toEqual(
      expect.arrayContaining([
        { namespace: "tmdb", nativeId: "movie:550" },
        { namespace: "imdb", nativeId: "tt0137523" },
        { namespace: "trakt", nativeId: "movie:727" },
      ]),
    );
    const defaultYoukuVariants = movieDocBody.document.variants.filter(
      (v) => v.namespace === "youku" && v.isDefault,
    );
    expect(defaultYoukuVariants).toHaveLength(1);
    expect(defaultYoukuVariants[0]?.label).toBe("国配");

    expect(resolveEpisode(movieDocBody.document, { namespace: "youku" })).toMatchObject({
      kind: "collection_only",
      reason: "whole_media",
      nativeId: "cc001f06962411de83b1",
    });
    expect(resolveEpisode(movieDocBody.document, { namespace: "douban" })).toMatchObject({
      kind: "collection_only",
      reason: "whole_media",
      nativeId: "1292052",
      variantId: null,
    });
  });

  test("enforces auth, API key permissions, dbRead routing, reviewer authorization, and owner role assignment", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    // Use a strict PostgreSQL read-only session on dbRead to prove GET /v1/media/:key never writes
    const readOnlyUrl = new URL(testDb.connectionString);
    readOnlyUrl.searchParams.set("options", "-c default_transaction_read_only=on");
    const readOnlyDb = createDb(readOnlyUrl.toString());

    try {
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

      const unverified = await signUpUser(app, outbound, {
        email: "unverified@example.com",
        password: "StrongPassword123!",
        name: "Unverified",
        verify: false,
      });
      const regularUser = await signUpUser(app, outbound, {
        email: "regular@example.com",
        password: "StrongPassword123!",
        name: "Regular User",
        verify: true,
      });
      const owner = await signUpUser(app, outbound, {
        email: "owner-rbac@example.com",
        password: "StrongPassword123!",
        name: "Owner",
        verify: true,
      });
      await testDb.writeDb
        .updateTable("user")
        .set({ role: "owner" })
        .where("id", "=", owner.userId)
        .execute();

      const readOnlyKey = await createApiKey(app, regularUser.cookie, {
        name: "Read Only",
        canSubmit: false,
      });
      const submitKey = await createApiKey(app, regularUser.cookie, {
        name: "Submit",
        canSubmit: true,
      });

      const validPayload = JSON.stringify({
        targetExternalKey: "tmdb:tv:95479",
        namespace: "bilibili",
        nativeId: "ss34430",
        variantDescription: "原声",
        segments: [
          { season: 1, episodeStart: 1, episodeEnd: 24, targetEpisodeStart: 1, baseline: "tmdb" },
        ],
      });

      // Read without API key -> 401
      const noKeyRead = await app.fetch(new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:95479`));
      expect(noKeyRead.status).toBe(401);

      // Submit without auth -> 401
      const noAuthSubmit = await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: validPayload,
        }),
      );
      expect(noAuthSubmit.status).toBe(401);

      // Submit with read-only API key -> 403
      const readKeySubmit = await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": readOnlyKey.key,
          },
          body: validPayload,
        }),
      );
      expect(readKeySubmit.status).toBe(403);
      expect(await readKeySubmit.json()).toMatchObject({ error: "INSUFFICIENT_PERMISSIONS" });

      // Submit with unverified user session -> 403
      const unverifiedSubmit = await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: unverified.cookie,
          },
          body: validPayload,
        }),
      );
      expect(unverifiedSubmit.status).toBe(403);
      expect(await unverifiedSubmit.json()).toMatchObject({ error: "EMAIL_NOT_VERIFIED" });

      // Submit with valid submit API key -> 201
      const okSubmit = await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/change-requests`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": submitKey.key,
          },
          body: validPayload,
        }),
      );
      expect(okSubmit.status).toBe(201);
      const { changeRequest } = (await okSubmit.json()) as { changeRequest: { id: string } };

      // Regular user cannot list, approve, or reject reviewer queue -> 403
      expect(
        (
          await app.fetch(
            new Request(`${TEST_BASE_URL}/v1/reviewer/change-requests`, {
              headers: { cookie: regularUser.cookie },
            }),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await app.fetch(
            new Request(
              `${TEST_BASE_URL}/v1/reviewer/change-requests/${changeRequest.id}/approve`,
              {
                method: "POST",
                headers: { cookie: regularUser.cookie },
              },
            ),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await app.fetch(
            new Request(`${TEST_BASE_URL}/v1/reviewer/change-requests/${changeRequest.id}/reject`, {
              method: "POST",
              headers: { cookie: regularUser.cookie },
            }),
          )
        ).status,
      ).toBe(403);

      // Regular user cannot appoint reviewers -> 403
      const nonOwnerRoleRes = await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/admin/users/${regularUser.userId}/role`, {
          method: "PUT",
          headers: { "content-type": "application/json", cookie: regularUser.cookie },
          body: JSON.stringify({ role: "reviewer" }),
        }),
      );
      expect(nonOwnerRoleRes.status).toBe(403);

      // Owner appoints regularUser as reviewer -> 200
      const appointRes = await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/admin/users/${regularUser.userId}/role`, {
          method: "PUT",
          headers: { "content-type": "application/json", cookie: owner.cookie },
          body: JSON.stringify({ role: "reviewer" }),
        }),
      );
      expect(appointRes.status).toBe(200);
      expect(await appointRes.json()).toMatchObject({
        user: {
          id: regularUser.userId,
          role: "reviewer",
        },
      });

      // Appointed reviewer still cannot call owner-only admin endpoint -> 403
      expect(
        (
          await app.fetch(
            new Request(`${TEST_BASE_URL}/v1/admin/users/${unverified.userId}/role`, {
              method: "PUT",
              headers: { "content-type": "application/json", cookie: regularUser.cookie },
              body: JSON.stringify({ role: "reviewer" }),
            }),
          )
        ).status,
      ).toBe(403);

      // Newly appointed reviewer can now approve the change request!
      const newReviewerApprove = await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/reviewer/change-requests/${changeRequest.id}/approve`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: regularUser.cookie },
          body: JSON.stringify({ reason: "Approved by newly appointed reviewer" }),
        }),
      );
      expect(newReviewerApprove.status).toBe(200);

      // Read media via strict read-only dbRead connection succeeds!
      const readRes = await app.fetch(
        new Request(`${TEST_BASE_URL}/v1/media/tmdb:tv:95479`, {
          headers: { "x-api-key": readOnlyKey.key },
        }),
      );
      expect(readRes.status).toBe(200);
    } finally {
      await readOnlyDb.destroy();
    }
  });
});
