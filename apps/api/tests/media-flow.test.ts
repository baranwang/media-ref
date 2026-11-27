import {
  extractConnectErrorInfo,
  fromProtoChangeRequestStatus,
  fromProtoMediaDocument,
  fromProtoMediaRef,
  resolveEpisode,
  toProtoSegmentInput,
  type MediaRef,
} from "@media-ref/client";
import {
  approveChangeRequest,
  bilibiliAdapter,
  createAdapterRegistry,
  createFakeOutboundClient,
  rejectChangeRequest,
  resolveCatalogTargetSnapshot,
  type ExternalHttpRequest,
} from "@media-ref/core";
import { createDb } from "@media-ref/db";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { createApiApp } from "../src/lib.ts";
import { toProtoChangeRequest } from "../src/proto-records.ts";
import {
  createRpcClients,
  expectRpcError,
  issueApiKeyRpc,
  mediaRef,
  signUpUser,
  TEST_BASE_URL,
  approveInCore,
} from "./rpc-helpers.ts";

const TMDB = { accessToken: "test-tmdb-token", traktClientId: "test-trakt-client-id" };

const TEST_AUTH_SECRET = "test-secret-for-media-ref-media-flow-integration-tests-0123456789";

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
      adapterRegistry: createAdapterRegistry(),
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

    const submitKey = await issueApiKeyRpc(app, submitter.cookie, {
      name: "Submit Key",
      canSubmit: true,
    });
    const readKey = await issueApiKeyRpc(app, submitter.cookie, {
      name: "Read Key",
      canSubmit: false,
    });

    const submitRpc = createRpcClients(app, { apiKey: submitKey.key });
    const readRpc = createRpcClients(app, { apiKey: readKey.key });
    const ownerRpc = createRpcClients(app, { cookie: owner.cookie });

    // Submit CR #1 for Jujutsu Kaisen (tmdb:tv:95479 does not exist in DB yet)
    const cr1Body = await submitRpc.changeRequest.createChangeRequest({
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
    const cr1 = cr1Body.changeRequest!;
    expect(cr1.id).toBeTruthy();
    expect(fromProtoChangeRequestStatus(cr1.status)).toBe("needs_review");
    expect(cr1.mediaId).toBeUndefined();
    expect(fromProtoMediaRef(cr1.target, { mode: "target" })).toMatchObject({
      ok: true,
      key: "tmdb:tv:95479",
    });
    expect(cr1.namespace).toBe("bilibili");
    expect(cr1.nativeId).toBe("ss34430");

    // Media must NOT exist yet before reviewer approves
    expect(
      (
        await expectRpcError(
          readRpc.media.getMedia({ ref: mediaRef({ tmdb: { type: "tv", id: 95479 } }) }),
        )
      ).status,
    ).toBe(404);
    expect(outbound.httpRequests).toHaveLength(0);

    // Submitter can inspect the pending change request via GetChangeRequest
    const inspectCr1 = await submitRpc.changeRequest.getChangeRequest({ id: cr1.id });
    expect(inspectCr1.changeRequest?.id).toBe(cr1.id);
    expect(fromProtoChangeRequestStatus(inspectCr1.changeRequest!.status)).toBe("needs_review");

    // Reviewer sees CR #1 in review queue
    const queueBody = await ownerRpc.reviewer.listChangeRequests({});
    expect(queueBody.total).toBe(1);
    expect(queueBody.changeRequests[0]?.id).toBe(cr1.id);

    // Reviewer approves CR #1 -> creates media with TMDB minimal snapshot + IMDb/TVDB/Trakt external IDs
    const approve1Body = await approveInCore(
      { db: testDb.writeDb, outbound, tmdb: TMDB },
      {
        id: cr1.id,
        reason: "Verified S1 part 1 on Bilibili",
      },
    );
    expect(fromProtoChangeRequestStatus(approve1Body.changeRequest!.status)).toBe("approved");
    expect(approve1Body.changeRequest!.decisionReason).toBe("Verified S1 part 1 on Bilibili");
    expect(approve1Body.mediaId).toBeTruthy();
    expect(approve1Body.associationId).toBeTruthy();
    expect(approve1Body.revisionId).toBeTruthy();

    // Submit CR #2 for S1 E25-47 (ss45574) in the same default variant ("原声") and approve
    const cr2Body = await submitRpc.changeRequest.createChangeRequest({
      target: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
      namespace: "bilibili",
      nativeId: "ss45574",
      variantDescription: "原声",
      segments: [
        toProtoSegmentInput({
          season: 1,
          episodeStart: 25,
          episodeEnd: 47,
          targetEpisodeStart: 1,
          baseline: "tmdb",
        }),
      ],
    });
    const approve2Body = await approveInCore(
      { db: testDb.writeDb, outbound, tmdb: TMDB },
      {
        id: cr2Body.changeRequest!.id,
        reason: "Verified S1 part 2 on Bilibili",
      },
    );

    // Read by tmdb:tv:95479
    const byTmdbRes = await readRpc.media.getMedia({
      ref: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
    });
    const byTmdbDoc = fromProtoMediaDocument(byTmdbRes.document!);
    expect(byTmdbRes.matchedAssociationId).toBeUndefined();
    expect(byTmdbDoc.media).toEqual({
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
    expect(byTmdbDoc.externalIds).toEqual(
      expect.arrayContaining([
        { namespace: "tmdb", nativeId: "tv:95479" },
        { namespace: "imdb", nativeId: "tt12343534" },
        { namespace: "tvdb", nativeId: "377543" },
        { namespace: "trakt", nativeId: "show:159384" },
      ]),
    );
    expect(byTmdbDoc.variants).toHaveLength(1);
    expect(byTmdbDoc.variants[0]).toMatchObject({
      namespace: "bilibili",
      label: "原声",
      isDefault: true,
    });
    expect(byTmdbDoc.associations).toHaveLength(2);

    // Read by media UUID, IMDb, TVDB, Trakt, and platform collection reverse ref
    const byUuidRes = await createRpcClients(app, {
      bearerToken: readKey.key,
    }).media.getMedia({ ref: mediaRef({ mediaId: approve1Body.mediaId }) });
    expect(byUuidRes.document?.media?.id).toBe(approve1Body.mediaId);
    expect(byUuidRes.matchedAssociationId).toBeUndefined();

    const extRefs: MediaRef[] = [
      { imdb: "tt12343534" },
      { tvdb: { id: 377543 } },
      { trakt: { id: "159384", type: "tv" } },
    ];
    for (const extRef of extRefs) {
      const extRes = await readRpc.media.getMedia({ ref: mediaRef(extRef) });
      expect(extRes.document?.media?.id).toBe(approve1Body.mediaId);
    }

    // Read by platform collection ref marks matchedAssociationId
    const byCollectionRes = await readRpc.media.getMedia({
      ref: mediaRef({ platform: { platform: "bilibili", nativeId: "ss45574" } }),
    });
    expect(byCollectionRes.matchedAssociationId).toBe(approve2Body.associationId);
    expect(byCollectionRes.document?.matchedAssociationIds).toEqual([approve2Body.associationId]);

    // Pass returned MediaDocument directly into @media-ref/client's resolveEpisode!
    const resolvedS1E30 = resolveEpisode(byTmdbDoc, {
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
      adapterRegistry: createAdapterRegistry(),
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

    const submitKey = await issueApiKeyRpc(app, user.cookie, { name: "Submit", canSubmit: true });
    const readKey = await issueApiKeyRpc(app, user.cookie, { name: "Read", canSubmit: false });

    const submitRpc = createRpcClients(app, { apiKey: submitKey.key });
    const readRpc = createRpcClients(app, { apiKey: readKey.key });

    // Seed an existing media + variant by approving a non-overlapping segment (S1 E1-10)
    const seedCr = await submitRpc.changeRequest.createChangeRequest({
      target: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
      namespace: "bilibili",
      nativeId: "ss10001",
      variantDescription: "原声",
      segments: [
        toProtoSegmentInput({
          season: 1,
          episodeStart: 1,
          episodeEnd: 10,
          targetEpisodeStart: 1,
          baseline: "tmdb",
        }),
      ],
    });
    await approveInCore(
      { db: testDb.writeDb, outbound, tmdb: TMDB },
      { id: seedCr.changeRequest!.id },
    );

    const mediaDoc = fromProtoMediaDocument(
      (await readRpc.media.getMedia({ ref: mediaRef({ tmdb: { type: "tv", id: 95479 } }) }))
        .document!,
    );
    const variantId = mediaDoc.variants[0]!.id;

    // Submit two pending CRs with overlapping ranges in the same existing variant:
    // CR A: S1 E11-25, CR B: S1 E20-35 (overlap on E20-25). Neither is approved yet.
    const [crA, crB] = await Promise.all([
      submitRpc.changeRequest.createChangeRequest({
        target: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
        namespace: "bilibili",
        nativeId: "ss10002",
        variantId,
        segments: [
          toProtoSegmentInput({
            season: 1,
            episodeStart: 11,
            episodeEnd: 25,
            targetEpisodeStart: 1,
            baseline: "tmdb",
          }),
        ],
      }),
      submitRpc.changeRequest.createChangeRequest({
        target: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
        namespace: "bilibili",
        nativeId: "ss10003",
        variantId,
        segments: [
          toProtoSegmentInput({
            season: 1,
            episodeStart: 20,
            episodeEnd: 35,
            targetEpisodeStart: 1,
            baseline: "tmdb",
          }),
        ],
      }),
    ]);

    // Approve BOTH concurrently against real PostgreSQL 19!
    const approveAttempt = async (id: string) => {
      try {
        await approveInCore({ db: testDb.writeDb, outbound, tmdb: TMDB }, { id });
        return { status: 200 as const, code: null as string | null };
      } catch (err) {
        const info = await expectRpcError(Promise.reject(err));
        return { status: info.status, code: info.code };
      }
    };

    const [approveARes, approveBRes] = await Promise.all([
      approveAttempt(crA.changeRequest!.id),
      approveAttempt(crB.changeRequest!.id),
    ]);

    const statuses = [approveARes.status, approveBRes.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);

    const failed = approveARes.status === 409 ? approveARes : approveBRes;
    expect(failed.code).toBe("SEGMENT_OVERLAP");

    // Confirm zero overlapping rows exist in the database / MediaDocument
    const afterDoc = fromProtoMediaDocument(
      (await readRpc.media.getMedia({ ref: mediaRef({ tmdb: { type: "tv", id: 95479 } }) }))
        .document!,
    );
    expect(afterDoc.associations).toHaveLength(2);
    const nativeIds = afterDoc.associations.map((a) => a.nativeId);
    expect(nativeIds).toContain("ss10001");
    expect(nativeIds.includes("ss10002") !== nativeIds.includes("ss10003")).toBe(true);

    // Also test 4 concurrent overlapping approvals on a BRAND-NEW uncreated media (tmdb:tv:108545)
    const pendingNewMediaIds: string[] = [];
    for (let i = 1; i <= 4; i++) {
      const res = await submitRpc.changeRequest.createChangeRequest({
        target: mediaRef({ tmdb: { type: "tv", id: 108545 } }),
        namespace: "tencent",
        nativeId: `mzc00200000000${i}`,
        variantDescription: "原声",
        segments: [
          toProtoSegmentInput({
            season: 1,
            episodeStart: 1,
            episodeEnd: 30,
            targetEpisodeStart: 1,
            baseline: "tmdb",
          }),
        ],
      });
      pendingNewMediaIds.push(res.changeRequest!.id);
    }

    const concurrentNewResults = await Promise.all(pendingNewMediaIds.map(approveAttempt));
    const newStatuses = concurrentNewResults.map((r) => r.status).sort((a, b) => a - b);
    expect(newStatuses).toEqual([200, 409, 409, 409]);

    const santiDoc = fromProtoMediaDocument(
      (await readRpc.media.getMedia({ ref: mediaRef({ tmdb: { type: "tv", id: 108545 } }) }))
        .document!,
    );
    expect(santiDoc.variants).toHaveLength(1);
    expect(santiDoc.associations).toHaveLength(1);
  });

  test("bounds change request inputs and stores only verified platform links", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);
    const outbound = createFakeOutboundClient();
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      adapterRegistry: createAdapterRegistry([bilibiliAdapter]),
      config: { baseUrl: TEST_BASE_URL, authSecret: TEST_AUTH_SECRET, tmdb: TMDB },
    });
    const { cookie } = await signUpUser(app, outbound, {
      email: "bounds@example.com",
      password: "StrongPassword123!",
      name: "Contributor",
      verify: true,
    });
    const rpc = createRpcClients(app, { cookie }).changeRequest;
    const segments = Array.from({ length: 201 }, (_, index) =>
      toProtoSegmentInput({
        season: 1,
        episodeStart: index + 1,
        episodeEnd: index + 1,
        targetEpisodeStart: index + 1,
        baseline: "tmdb",
      }),
    );
    const request = {
      target: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
      namespace: "tencent",
      nativeId: "a".repeat(500),
      rawNativeId: "b".repeat(500),
      variantDescription: "版".repeat(512),
      segments: segments.slice(0, 200),
    };
    for (const [change, code] of [
      [{ nativeId: request.nativeId + " " }, "INVALID_NATIVE_ID"],
      [{ rawNativeId: request.rawNativeId + " " }, "INVALID_NATIVE_ID"],
      [{ variantDescription: request.variantDescription + " " }, "INVALID_VARIANT"],
      [{ segments }, "INVALID_SEGMENTS"],
      [{ nativeId: "https://example.invalid/collection" }, "INVALID_NATIVE_ID"],
    ] as const) {
      expect(
        await expectRpcError(rpc.createChangeRequest({ ...request, ...change })),
      ).toMatchObject({ status: 400, code });
    }
    const atLimits = await rpc.createChangeRequest(request);
    expect(atLimits.changeRequest).toMatchObject({
      nativeId: request.nativeId,
      rawNativeId: request.nativeId,
      variantDescription: request.variantDescription,
    });

    const platform = { ...request, namespace: "bilibili", nativeId: "ss34430", segments: [] };
    const page = "https://www.bilibili.com/bangumi/play/ss34430";
    for (const [index, [rawNativeId, stored]] of (
      [
        [page, page],
        ["https://www.bilibili.com/bangumi/play/ss45574", platform.nativeId],
        ["https://example.invalid/collection", platform.nativeId],
      ] as const
    ).entries()) {
      const result = await rpc.createChangeRequest({
        ...platform,
        rawNativeId,
        variantDescription: index === 0 ? "原声" : `原声-${index}`,
      });
      expect(result.changeRequest?.rawNativeId).toBe(stored);
    }
    expect(outbound.httpRequests).toHaveLength(0);
  });

  test("accepts a 1 MiB Connect body and rejects one extra byte", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound: createFakeOutboundClient(),
      config: { baseUrl: TEST_BASE_URL, authSecret: TEST_AUTH_SECRET, tmdb: TMDB },
    });
    const body = "{}".padEnd(1024 * 1024);
    const send = (payload: string) =>
      app.fetch(
        new Request(`${TEST_BASE_URL}/mediaref.v1.ChangeRequestService/GetChangeRequest`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: payload,
        }),
      );
    expect((await send(body)).status).toBe(401);
    const oversized = await send(body + " ");
    expect(await oversized.json()).toMatchObject({ code: "resource_exhausted" });
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
      adapterRegistry: createAdapterRegistry(),
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

    const submitKey = await issueApiKeyRpc(app, user.cookie, { name: "Submit", canSubmit: true });
    const submitRpc = createRpcClients(app, { apiKey: submitKey.key });

    // Invalid segment syntax (episodeEnd < episodeStart)
    const badSyntaxErr = await expectRpcError(
      submitRpc.changeRequest.createChangeRequest({
        target: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
        namespace: "bilibili",
        nativeId: "ss34430",
        variantDescription: "原声",
        segments: [
          toProtoSegmentInput({
            season: 1,
            episodeStart: 10,
            episodeEnd: 5,
            targetEpisodeStart: 1,
            baseline: "tmdb",
          }),
        ],
      }),
    );
    expect(badSyntaxErr.status).toBe(400);
    expect(badSyntaxErr.code).toBe("INVALID_SEGMENTS");

    // Approve initial association ss34430 (S1 E1-24, target 1..24) on tmdb:tv:95479
    const cr1 = await submitRpc.changeRequest.createChangeRequest({
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
    await approveInCore(
      { db: testDb.writeDb, outbound, tmdb: TMDB },
      { id: cr1.changeRequest!.id },
    );

    // Submitting a new overlapping association in the same variant is rejected immediately (400)
    const overlapErr = await expectRpcError(
      submitRpc.changeRequest.createChangeRequest({
        target: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
        namespace: "bilibili",
        nativeId: "ss88888",
        variantDescription: "原声",
        segments: [
          toProtoSegmentInput({
            season: 1,
            episodeStart: 20,
            episodeEnd: 30,
            targetEpisodeStart: 1,
            baseline: "tmdb",
          }),
        ],
      }),
    );
    expect(overlapErr.status).toBe(400);
    expect(overlapErr.code).toBe("SEGMENT_OVERLAP");

    // Submitting the same collection ss34430 on ANOTHER media with overlapping target range [10..19] is rejected
    const sharedOverlapErr = await expectRpcError(
      submitRpc.changeRequest.createChangeRequest({
        target: mediaRef({ tmdb: { type: "tv", id: 108545 } }),
        namespace: "bilibili",
        nativeId: "ss34430",
        variantDescription: "原声",
        segments: [
          toProtoSegmentInput({
            season: 1,
            episodeStart: 1,
            episodeEnd: 10,
            targetEpisodeStart: 10,
            baseline: "tmdb",
          }),
        ],
      }),
    );
    expect(sharedOverlapErr.status).toBe(400);
    expect(sharedOverlapErr.code).toBe("SEGMENT_OVERLAP");
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
      adapterRegistry: createAdapterRegistry(),
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

    const submitKey = await issueApiKeyRpc(app, user.cookie, { name: "Submit", canSubmit: true });
    const readKey = await issueApiKeyRpc(app, user.cookie, { name: "Read", canSubmit: false });

    const submitRpc = createRpcClients(app, { apiKey: submitKey.key });
    const userSessionRpc = createRpcClients(app, { cookie: user.cookie });
    const readRpc = createRpcClients(app, { apiKey: readKey.key });

    // 1. Rejected change request does not create media or appear in GetMedia
    const rejectedCr = await submitRpc.changeRequest.createChangeRequest({
      target: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
      namespace: "bilibili",
      nativeId: "ss99999",
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

    const rejectRes = {
      changeRequest: toProtoChangeRequest(
        await rejectChangeRequest(testDb.writeDb, {
          changeRequestId: rejectedCr.changeRequest!.id,
          reviewerUserId: owner.userId,
          reason: "Wrong collection ID",
        }),
      ),
    };
    expect(rejectRes.changeRequest).toMatchObject({
      id: rejectedCr.changeRequest!.id,
      decisionReason: "Wrong collection ID",
      reviewerUserId: owner.userId,
    });
    expect(fromProtoChangeRequestStatus(rejectRes.changeRequest!.status)).toBe("rejected");

    expect(
      (
        await expectRpcError(
          readRpc.media.getMedia({ ref: mediaRef({ tmdb: { type: "tv", id: 95479 } }) }),
        )
      ).status,
    ).toBe(404);

    // 2. Movie whole-media submission + revision 2 update + default variant switch + catalog association
    const movieCr1 = await userSessionRpc.changeRequest.createChangeRequest({
      target: mediaRef({ tmdb: { type: "movie", id: 550 } }),
      namespace: "youku",
      nativeId: "cc001f06962411de83b1",
      variantDescription: "原声",
      segments: [],
    });
    const movieApp1 = await approveInCore(
      { db: testDb.writeDb, outbound, tmdb: TMDB },
      {
        id: movieCr1.changeRequest!.id,
        reason: "Initial approval",
      },
    );

    // Submit a second CR updating the same collection -> creates revision 2
    const movieCr2 = await submitRpc.changeRequest.createChangeRequest({
      target: mediaRef({ tmdb: { type: "movie", id: 550 } }),
      namespace: "youku",
      nativeId: "cc001f06962411de83b1",
      variantDescription: "国配",
      setDefaultVariant: true,
      segments: [],
    });
    const movieApp2 = await approveInCore(
      { db: testDb.writeDb, outbound, tmdb: TMDB },
      {
        id: movieCr2.changeRequest!.id,
        reason: "Reclassified as Mandarin dub and set default",
      },
    );
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
    const doubanCr = await submitRpc.changeRequest.createChangeRequest({
      target: mediaRef({ tmdb: { type: "movie", id: 550 } }),
      namespace: "douban",
      nativeId: "1292052",
      segments: [],
    });
    await approveInCore(
      { db: testDb.writeDb, outbound, tmdb: TMDB },
      { id: doubanCr.changeRequest!.id },
    );

    const movieDocRes = await readRpc.media.getMedia({ ref: mediaRef({ douban: "1292052" }) });
    const movieDoc = fromProtoMediaDocument(movieDocRes.document!);
    expect(movieDocRes.matchedAssociationId).toBeTruthy();
    expect(movieDoc.media.snapshot).toEqual({
      title: "搏击俱乐部",
      originalTitle: "Fight Club",
      year: 1999,
      type: "movie",
      seasons: [],
    });
    expect(movieDoc.externalIds).toEqual(
      expect.arrayContaining([
        { namespace: "tmdb", nativeId: "movie:550" },
        { namespace: "imdb", nativeId: "tt0137523" },
        { namespace: "trakt", nativeId: "movie:727" },
      ]),
    );
    const defaultYoukuVariants = movieDoc.variants.filter(
      (v) => v.namespace === "youku" && v.isDefault,
    );
    expect(defaultYoukuVariants).toHaveLength(1);
    expect(defaultYoukuVariants[0]?.label).toBe("国配");

    expect(resolveEpisode(movieDoc, { namespace: "youku" })).toMatchObject({
      kind: "collection_only",
      reason: "whole_media",
      nativeId: "cc001f06962411de83b1",
    });
    expect(resolveEpisode(movieDoc, { namespace: "douban" })).toMatchObject({
      kind: "collection_only",
      reason: "whole_media",
      nativeId: "1292052",
      variantId: null,
    });
  });

  test("enforces auth, API key permissions, dbRead routing, reviewer authorization, and owner role assignment", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    // Use a strict PostgreSQL read-only session on dbRead to prove GetMedia never writes
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
        adapterRegistry: createAdapterRegistry(),
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

      const readOnlyKey = await issueApiKeyRpc(app, regularUser.cookie, {
        name: "Read Only",
        canSubmit: false,
      });
      const submitKey = await issueApiKeyRpc(app, regularUser.cookie, {
        name: "Submit",
        canSubmit: true,
      });

      const validPayload = {
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
      };

      const unauthRpc = createRpcClients(app);
      const readKeyRpc = createRpcClients(app, { apiKey: readOnlyKey.key });
      const submitKeyRpc = createRpcClients(app, { apiKey: submitKey.key });
      const unverifiedRpc = createRpcClients(app, { cookie: unverified.cookie });
      const regularRpc = createRpcClients(app, { cookie: regularUser.cookie });
      const ownerRpc = createRpcClients(app, { cookie: owner.cookie });

      // Read without API key -> 401
      expect(
        (
          await expectRpcError(
            unauthRpc.media.getMedia({ ref: mediaRef({ tmdb: { type: "tv", id: 95479 } }) }),
          )
        ).status,
      ).toBe(401);

      // Submit without auth -> 401
      expect(
        (await expectRpcError(unauthRpc.changeRequest.createChangeRequest(validPayload))).status,
      ).toBe(401);

      // Submit with read-only API key -> 403
      const readKeySubmitErr = await expectRpcError(
        readKeyRpc.changeRequest.createChangeRequest(validPayload),
      );
      expect(readKeySubmitErr.status).toBe(403);
      expect(readKeySubmitErr.code).toBe("INSUFFICIENT_PERMISSIONS");

      // Submit with unverified user session -> 403
      const unverifiedErr = await expectRpcError(
        unverifiedRpc.changeRequest.createChangeRequest(validPayload),
      );
      expect(unverifiedErr.status).toBe(403);
      expect(unverifiedErr.code).toBe("EMAIL_NOT_VERIFIED");

      // Submit with valid submit API key -> succeeds
      const okSubmit = await submitKeyRpc.changeRequest.createChangeRequest(validPayload);
      const crId = okSubmit.changeRequest!.id;

      // Regular user cannot list, approve, or reject reviewer queue -> 403
      expect((await expectRpcError(regularRpc.reviewer.listChangeRequests({}))).status).toBe(403);
      expect(
        (await expectRpcError(regularRpc.reviewer.approveChangeRequest({ id: crId }))).status,
      ).toBe(403);
      expect(
        (await expectRpcError(regularRpc.reviewer.rejectChangeRequest({ id: crId }))).status,
      ).toBe(403);

      // Regular user cannot appoint reviewers -> 403
      expect(
        (
          await expectRpcError(
            regularRpc.reviewer.setUserRole({ userId: regularUser.userId, role: "reviewer" }),
          )
        ).status,
      ).toBe(403);

      // Owner appoints regularUser as reviewer -> succeeds
      const appointRes = await ownerRpc.reviewer.setUserRole({
        userId: regularUser.userId,
        role: "reviewer",
      });
      expect(appointRes.user).toMatchObject({
        id: regularUser.userId,
        role: "reviewer",
      });

      // Appointed reviewer still cannot call owner-only SetUserRole -> 403
      expect(
        (
          await expectRpcError(
            regularRpc.reviewer.setUserRole({ userId: unverified.userId, role: "reviewer" }),
          )
        ).status,
      ).toBe(403);

      // The appointed reviewer passes the role check, but people no longer approve: they comment
      // (ADR 0003 amendment 2). The approval goes through core instead.
      expect(
        await expectRpcError(regularRpc.reviewer.approveChangeRequest({ id: crId })),
      ).toMatchObject({ status: 409, code: "DECIDED_BY_REVIEW_AGENT" });
      const approved = await approveInCore(
        { db: testDb.writeDb, outbound, tmdb: TMDB },
        {
          id: crId,
          reason: "Approved by newly appointed reviewer",
        },
      );
      expect(approved.mediaId).toBeTruthy();

      // Read media via strict read-only dbRead connection succeeds!
      const readRes = await readKeyRpc.media.getMedia({
        ref: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
      });
      expect(readRes.document?.media?.id).toBe(approved.mediaId);
    } finally {
      await readOnlyDb.destroy();
    }
  });

  test("rejects duplicate in-flight and no-op change requests (#98) while allowing real updates", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const outbound = createFakeOutboundClient({
      fetchExternal: createCatalogStubHandler(),
    });
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      adapterRegistry: createAdapterRegistry([bilibiliAdapter]),
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        tmdb: TMDB,
      },
    });

    const contributor = await signUpUser(app, outbound, {
      email: "noop-contributor@example.com",
      password: "StrongPassword123!",
      name: "Contributor",
      verify: true,
    });
    const secondUser = await signUpUser(app, outbound, {
      email: "noop-other@example.com",
      password: "StrongPassword123!",
      name: "Other User",
      verify: true,
    });
    const key1 = await issueApiKeyRpc(app, contributor.cookie, { name: "k1", canSubmit: true });
    const key2 = await issueApiKeyRpc(app, secondUser.cookie, { name: "k2", canSubmit: true });
    const rpc1 = createRpcClients(app, { apiKey: key1.key });
    const rpc2 = createRpcClients(app, { apiKey: key2.key });

    const basePayload = {
      target: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
      namespace: "bilibili",
      nativeId: "https://www.bilibili.com/bangumi/play/ss34430",
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
    };

    // 1. Concurrent identical submissions race cleanly: only 1 succeeds, the rest reject as 409 DUPLICATE_CHANGE_REQUEST
    const concurrentResults = await Promise.allSettled([
      rpc1.changeRequest.createChangeRequest(basePayload),
      rpc2.changeRequest.createChangeRequest({
        ...basePayload,
        nativeId: "https://m.bilibili.com/bangumi/play/ss34430?from=share",
      }),
      rpc2.changeRequest.createChangeRequest({
        ...basePayload,
        nativeId: "ss34430",
      }),
    ]);
    const fulfilled = concurrentResults.filter((r) => r.status === "fulfilled");
    const rejected = concurrentResults.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    for (const rej of rejected) {
      expect(extractConnectErrorInfo(rej.reason)).toMatchObject({
        status: 409,
        code: "DUPLICATE_CHANGE_REQUEST",
      });
    }
    const firstCrId = fulfilled[0]!.value.changeRequest!.id;

    // 1b. Concurrent identical submissions sharing the same taskId stay idempotent (all return the same CR)
    const sharedTaskId = crypto.randomUUID();
    const taskPayload = {
      ...basePayload,
      taskId: sharedTaskId,
      variantDescription: "粤语",
    };
    const concurrentTaskResults = await Promise.all([
      rpc1.changeRequest.createChangeRequest(taskPayload),
      rpc1.changeRequest.createChangeRequest(taskPayload),
      rpc1.changeRequest.createChangeRequest(taskPayload),
    ]);
    const taskCrIds = new Set(concurrentTaskResults.map((r) => r.changeRequest?.id));
    expect(taskCrIds.size).toBe(1);
    expect([...taskCrIds][0]).toBeTruthy();

    // Different segment range on the same in-flight collection IS allowed
    const extendedPendingRes = await rpc1.changeRequest.createChangeRequest({
      ...basePayload,
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
    expect(extendedPendingRes.changeRequest?.id).toBeTruthy();

    // Clean up extended CR by rejecting it, then approve firstCr so collection is confirmed
    await rejectChangeRequest(testDb.writeDb, {
      changeRequestId: extendedPendingRes.changeRequest!.id,
      reviewerUserId: contributor.userId,
      reason: "Superseded for test setup",
      allowedStatuses: ["pending_evidence"],
    });
    const prefetched = await resolveCatalogTargetSnapshot("tmdb:tv:95479", outbound, {
      tmdb: TMDB,
    });
    if (prefetched.status !== "found") {
      throw new Error("Expected catalog snapshot for tmdb:tv:95479");
    }
    const approved = await approveChangeRequest(testDb.writeDb, outbound, {
      changeRequestId: firstCrId,
      reviewerUserId: null,
      reason: "Confirm E1-12",
      prefetchedCatalog: prefetched.target,
      allowedStatuses: ["pending_evidence"],
    });

    // 2. Submitting the exact same confirmed mapping (either by variantDescription or variantId) rejects with 409 NO_CHANGE
    const mediaDoc = await rpc1.media.getMedia({
      ref: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
    });
    const variantId = mediaDoc.document?.variants[0]?.id;
    expect(variantId).toBeTruthy();

    expect(
      await expectRpcError(
        rpc1.changeRequest.createChangeRequest({
          ...basePayload,
          target: mediaRef(approved.mediaId),
          nativeId: "ss34430",
        }),
      ),
    ).toMatchObject({ status: 409, code: "NO_CHANGE" });

    expect(
      await expectRpcError(
        rpc2.changeRequest.createChangeRequest({
          ...basePayload,
          variantDescription: undefined,
          variantId,
          setDefaultVariant: true, // variant is already default
        }),
      ),
    ).toMatchObject({ status: 409, code: "NO_CHANGE" });

    // 3. Valid modifications against the confirmed collection remain allowed:
    // extending episode range (1-12 -> 1-24) or switching to a new variant description ("中配")
    const extendConfirmedRes = await rpc1.changeRequest.createChangeRequest({
      ...basePayload,
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
    expect(extendConfirmedRes.changeRequest?.id).toBeTruthy();

    const newVariantRes = await rpc2.changeRequest.createChangeRequest({
      ...basePayload,
      variantDescription: "中配",
    });
    expect(newVariantRes.changeRequest?.id).toBeTruthy();

    // 4. Rejecting a CR does not block a fresh re-submission of the same payload later
    await rejectChangeRequest(testDb.writeDb, {
      changeRequestId: newVariantRes.changeRequest!.id,
      reviewerUserId: secondUser.userId,
      reason: "Transient check failure",
      allowedStatuses: ["pending_evidence"],
    });
    const resubmittedAfterReject = await rpc2.changeRequest.createChangeRequest({
      ...basePayload,
      variantDescription: "中配",
    });
    expect(resubmittedAfterReject.changeRequest?.id).not.toBe(newVariantRes.changeRequest!.id);
  });
});
