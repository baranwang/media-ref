import { create } from "@bufbuild/protobuf";
import { createMediaRefClient, MediaRefApiError, proto, resolveEpisode } from "@media-ref/client";
import {
  createAdapterRegistry,
  createFakeOutboundClient,
  type ExternalHttpRequest,
} from "@media-ref/core";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
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

const TEST_AUTH_SECRET = "test-secret-for-media-ref-connect-protocol-e2e-tests-0123456789";

function createCatalogStub() {
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
            seasons: [{ season_number: 1, episode_count: 24, air_date: "2020-10-03" }],
            external_ids: { imdb_id: "tt12343534" },
          }),
        };
      }
    }
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      url: request.url,
      body: "[]",
    };
  };
}

describe("ConnectRPC Protobuf end-to-end protocol compatibility", () => {
  const handles: TestDbHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop();
      if (handle) {
        await handle.cleanup();
      }
    }
  });

  test("logs the method and cause of unexpected failures, not expected RPC errors or request data", async () => {
    const testDb = await createTestDb({ migrate: false });
    handles.push(testDb);
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound: createFakeOutboundClient(),
      config: {},
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const query = { ref: mediaRef("tmdb:tv:95479") };
      expect(await expectRpcError(createRpcClients(app).media.getMedia(query))).toMatchObject({
        code: "API_KEY_REQUIRED",
      });
      expect(log).not.toHaveBeenCalled();
      await expectRpcError(
        createRpcClients(app, { apiKey: crypto.randomUUID() }).media.getMedia(query),
      );
      expect(log.mock.calls).toEqual([
        ['RPC mediaref.v1.MediaService/GetMedia failed: relation "apikey" does not exist'],
      ]);
    } finally {
      log.mockRestore();
    }
  });

  test("interoperates with @media-ref/client over binary Protobuf, Connect JSON, and Connect HTTP GET, and enforces SegmentInput oneof", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const outbound = createFakeOutboundClient({
      fetchExternal: createCatalogStub(),
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

    const owner = await signUpUser(app, outbound, {
      email: "proto-e2e@example.com",
      password: "StrongPassword123!",
      name: "Proto Owner",
    });
    await testDb.writeDb
      .updateTable("user")
      .set({ role: "owner" })
      .where("id", "=", owner.userId)
      .execute();

    const submitKey = await issueApiKeyRpc(app, owner.cookie, {
      name: "Proto Submit Key",
      canSubmit: true,
    });
    const ownerRpc = createRpcClients(app, { cookie: owner.cookie });

    // Submit a change request with whole-season SegmentInput oneof via binary Protobuf
    const createdCr = await ownerRpc.changeRequest.createChangeRequest({
      target: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
      namespace: "bilibili",
      nativeId: "ss34430",
      variantDescription: "原声",
      segments: [
        create(proto.SegmentInputSchema, {
          kind: {
            case: "wholeSeason",
            value: create(proto.WholeSeasonSegmentInputSchema, {
              season: 1,
              baseline: "tmdb",
            }),
          },
        }),
      ],
    });
    const approved = await approveInCore(
      { db: testDb.writeDb, outbound },
      {
        id: createdCr.changeRequest!.id,
      },
    );

    // Reject empty SegmentInput oneof (neither wholeSeason nor explicit set)
    const emptyOneofErr = await expectRpcError(
      ownerRpc.changeRequest.createChangeRequest({
        target: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
        namespace: "tencent",
        nativeId: "mzc00200bad",
        variantDescription: "原声",
        segments: [create(proto.SegmentInputSchema, {})],
      }),
    );
    expect(emptyOneofErr.status).toBe(400);
    expect(emptyOneofErr.code).toBe("INVALID_SEGMENTS");

    // Reject explicit SegmentInput with invalid episodeStart: 0
    const badExplicitErr = await expectRpcError(
      ownerRpc.changeRequest.createChangeRequest({
        target: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
        namespace: "tencent",
        nativeId: "mzc00200zero",
        variantDescription: "原声",
        segments: [
          create(proto.SegmentInputSchema, {
            kind: {
              case: "explicit",
              value: create(proto.ExplicitSegmentInputSchema, {
                season: 1,
                episodeStart: 0,
                episodeEnd: 12,
                targetEpisodeStart: 1,
                baseline: "tmdb",
              }),
            },
          }),
        ],
      }),
    );
    expect(badExplicitErr.status).toBe(400);
    expect(badExplicitErr.code).toBe("INVALID_SEGMENTS");

    const observedContentTypes: string[] = [];
    const observedMethods: string[] = [];
    const customFetch = async (input: string, init?: RequestInit) => {
      const req = new Request(input, init);
      observedMethods.push(req.method);
      const res = await app.fetch(req);
      observedContentTypes.push(res.headers.get("content-type") ?? "");
      return res;
    };

    // 1. Default @media-ref/client uses binary Protobuf (application/proto) with structured MediaRef
    const binaryClient = createMediaRefClient({
      baseUrl: TEST_BASE_URL,
      apiKey: submitKey.key,
      fetch: customFetch,
    });
    const binaryMedia = await binaryClient.getMedia({ tmdb: { type: "tv", id: 95479 } });
    expect(binaryMedia).not.toBeNull();
    expect(binaryMedia!.ref).toEqual({ tmdb: { type: "tv", id: 95479 } });
    expect(binaryMedia!.document.media.id).toBe(approved.mediaId);
    expect(observedContentTypes.at(-1)).toContain("application/proto");
    expect(
      resolveEpisode(binaryMedia!.document, { namespace: "bilibili", season: 1, episode: 5 }),
    ).toMatchObject({ kind: "mapped", nativeId: "ss34430", targetEpisode: 5 });

    // Query directly by UUID MediaRef
    const uuidMedia = await binaryClient.getMedia({ mediaId: approved.mediaId });
    expect(uuidMedia).not.toBeNull();
    expect(uuidMedia!.ref).toEqual({ mediaId: approved.mediaId });
    expect(uuidMedia!.document.media.id).toBe(approved.mediaId);

    // 2. Connect JSON mode (useBinaryFormat: false -> application/json)
    const jsonClient = createMediaRefClient({
      baseUrl: TEST_BASE_URL,
      apiKey: submitKey.key,
      useBinaryFormat: false,
      fetch: customFetch,
    });
    const jsonMedia = await jsonClient.getMedia({ tmdb: { type: "tv", id: 95479 } });
    expect(jsonMedia).not.toBeNull();
    expect(jsonMedia!.document.media.id).toBe(approved.mediaId);
    expect(observedContentTypes.at(-1)).toContain("application/json");

    // 3. Connect HTTP GET mode for idempotent GetMedia (NO_SIDE_EFFECTS)
    const getClient = createMediaRefClient({
      baseUrl: TEST_BASE_URL,
      apiKey: submitKey.key,
      useHttpGet: true,
      fetch: customFetch,
    });
    const getMedia = await getClient.getMedia({ tmdb: { type: "tv", id: 95479 } });
    expect(getMedia).not.toBeNull();
    expect(getMedia!.document.media.id).toBe(approved.mediaId);
    expect(observedMethods.at(-1)).toBe("GET");

    // 4. Not-found returns null; invalid MediaRef throws structured MediaRefApiError on binary Protobuf
    expect(await binaryClient.getMedia({ tmdb: { type: "tv", id: 99999999 } })).toBeNull();
    const invalidRefErr = await expectRpcError(
      createRpcClients(app, { apiKey: submitKey.key }).media.getMedia({
        ref: create(proto.MediaRefSchema, {
          id: {
            case: "tmdb",
            value: create(proto.TmdbRefSchema, { type: proto.MediaType.UNSPECIFIED, id: 0 }),
          },
        }),
      }),
    );
    expect(invalidRefErr.status).toBe(400);
    expect(invalidRefErr.code).toBe("INVALID_KEY");

    await expect(binaryClient.getMedia("not-a-valid-key")).rejects.toThrow(RangeError);

    const batchRes = await binaryClient.getMediaBatch([
      { tmdb: { type: "tv", id: 95479 } },
      { tmdb: { type: "tv", id: 99999999 } },
    ]);
    expect(batchRes.results).toHaveLength(2);
    expect(batchRes.results[0]?.ok).toBe(true);
    expect(batchRes.results[1]).toMatchObject({ ok: false, error: "NOT_FOUND" });
    expect(MediaRefApiError).toBeDefined();
  });
});
