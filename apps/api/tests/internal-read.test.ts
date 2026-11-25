import { proto } from "@media-ref/client";
import { createFakeOutboundClient, listDemands } from "@media-ref/core";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { createApiApp } from "../src/lib.ts";
import { INTERNAL_VISITOR_IP_HEADER } from "../src/app.ts";
import { createRpcClients, expectRpcError, mediaRef, TEST_BASE_URL } from "./rpc-helpers.ts";

const TEST_AUTH_SECRET = "test-internal-read-secret-6b2f-1c7e-9a44-0d3b-5e8f-12ab34cd56ef";

describe("internal (service-binding) public reads", () => {
  const handles: TestDbHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      await handles.pop()?.cleanup();
    }
  });

  async function setup(bgTasks: Promise<unknown>[] = []) {
    const testDb = await createTestDb();
    handles.push(testDb);
    const app = createApiApp({
      onBackgroundTask: (task) => {
        bgTasks.push(task);
      },
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound: createFakeOutboundClient(),
      config: { baseUrl: TEST_BASE_URL, authSecret: TEST_AUTH_SECRET, readIpLimit: 1 },
    });
    return Object.assign(app, { testDb });
  }

  test("public entry still requires an API key for GetMedia", async () => {
    const app = await setup();
    const err = await expectRpcError(
      createRpcClients(app).media.getMedia({ ref: mediaRef("tmdb:tv:1") }),
    );
    expect(err.code).toBe("API_KEY_REQUIRED");
  });

  test("internal entry reads without a key and rate-limits by the forwarded visitor IP", async () => {
    const app = await setup();
    const internalFetch = (req: Request) => app.fetchInternal(req);

    const visitorA = createRpcClients(internalFetch, {
      headers: { [INTERNAL_VISITOR_IP_HEADER]: "203.0.113.7" },
    });
    // Unknown media: the key check is skipped, so the read reaches the lookup.
    const notFound = await expectRpcError(visitorA.media.getMedia({ ref: mediaRef("tmdb:tv:1") }));
    expect(notFound.code).toBe("MEDIA_NOT_FOUND");

    // readIpLimit is 1 per period: the same visitor is now limited...
    const limited = await expectRpcError(visitorA.media.getMedia({ ref: mediaRef("tmdb:tv:1") }));
    expect(limited.code).toBe("RATE_LIMITED");

    // ...while another visitor behind the same website server is not.
    const visitorB = createRpcClients(internalFetch, {
      headers: { [INTERNAL_VISITOR_IP_HEADER]: "198.51.100.9" },
    });
    const otherVisitor = await expectRpcError(
      visitorB.media.getMedia({ ref: mediaRef("tmdb:tv:1") }),
    );
    expect(otherVisitor.code).toBe("MEDIA_NOT_FOUND");
  });

  test("the visitor-IP header is ignored on the public entry", async () => {
    const app = await setup();
    const err = await expectRpcError(
      createRpcClients(app, {
        headers: { [INTERNAL_VISITOR_IP_HEADER]: "203.0.113.7" },
      }).media.getMedia({ ref: mediaRef("tmdb:tv:1") }),
    );
    expect(err.code).toBe("API_KEY_REQUIRED");
  });

  test("internal reads do not record demand for uncovered seasons", async () => {
    const bgTasks: Promise<unknown>[] = [];
    const app = await setup(bgTasks);
    const media = await app.testDb.writeDb
      .insertInto("media")
      .values({
        type: "tv",
        baseline: "tmdb",
        title: "咒术回战",
        year: 2020,
        seasons: JSON.stringify([{ season: 1, episodeCount: 24, airYear: 2020 }]),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await app.testDb.writeDb
      .insertInto("associations")
      .values({
        status: "confirmed",
        is_external_id: true,
        media_id: media.id,
        namespace: "tmdb",
        native_id: "tv:95479",
      })
      .execute();

    // Season 1 has no platform association: an API caller would create a demand here.
    await createRpcClients((req: Request) => app.fetchInternal(req)).media.getMedia({
      ref: mediaRef({ tmdb: { type: "tv", id: 95479 } }),
      season: 1,
      namespaceGroup: proto.NamespaceGroup.PLATFORM,
    });
    await Promise.all(bgTasks);

    expect(await listDemands(app.testDb.readDb, { mediaId: media.id })).toEqual([]);
  });
});
