import { createAdapterRegistry, createFakeOutboundClient } from "@media-ref/core";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, expect, test } from "vite-plus/test";
import { createApiApp } from "../src/lib.ts";
import { createRpcClients, signUpUser, TEST_BASE_URL } from "./rpc-helpers.ts";

// A rejected change request whose collection later went live through another change request
// says so, so its page does not read as "this mapping is not in MediaRef".

const handles: TestDbHandle[] = [];

afterEach(async () => {
  while (handles.length > 0) await handles.pop()!.cleanup();
});

async function setup() {
  const testDb = await createTestDb();
  handles.push(testDb);
  const outbound = createFakeOutboundClient({
    fetchExternal: (request) => {
      throw new Error(`Unexpected outbound request: ${request.url}`);
    },
  });
  const app = createApiApp({
    dbRead: testDb.readDb,
    dbWrite: testDb.writeDb,
    outbound,
    adapterRegistry: createAdapterRegistry(),
    config: {
      baseUrl: TEST_BASE_URL,
      authSecret: "test-secret-for-media-ref-live-elsewhere-0123456789abcdef",
    },
  });
  const user = await signUpUser(app, outbound, {
    email: "submitter@example.com",
    password: "StrongPassword123!",
    name: "Submitter",
    verify: true,
  });
  const db = testDb.writeDb;

  // 斗破苍穹: TMDB tv:79481, live on tencent mzc0020027yzd9e as season 5.
  const media = await db
    .insertInto("media")
    .values({ type: "tv", baseline: "tmdb", title: "斗破苍穹", year: 2017 })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db
    .insertInto("associations")
    .values({
      status: "confirmed",
      is_external_id: true,
      media_id: media.id,
      namespace: "tmdb",
      native_id: "tv:79481",
    })
    .execute();
  const variant = await db
    .insertInto("variants")
    .values({ media_id: media.id, platform: "tencent", description: "原声", is_default: true })
    .returning("id")
    .executeTakeFirstOrThrow();
  const association = await db
    .insertInto("associations")
    .values({
      status: "confirmed",
      media_id: media.id,
      namespace: "tencent",
      native_id: "mzc0020027yzd9e",
      variant_id: variant.id,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  const changeRequest = async (values: {
    status: "approved" | "rejected" | "needs_review";
    mediaId?: string | null;
    nativeId?: string;
    appliedAssociationId?: string | null;
  }) =>
    (
      await db
        .insertInto("change_requests")
        .values({
          status: values.status,
          submitter_user_id: user.userId,
          target_external_key: "tmdb:tv:79481",
          media_id: values.mediaId ?? null,
          namespace: "tencent",
          raw_native_id: values.nativeId ?? "mzc0020027yzd9e",
          native_id: values.nativeId ?? "mzc0020027yzd9e",
          segments: JSON.stringify([]),
          applied_association_id: values.appliedAssociationId ?? null,
          reviewed_at: values.status === "needs_review" ? null : new Date(),
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;

  const live = await changeRequest({
    status: "approved",
    mediaId: media.id,
    appliedAssociationId: association.id,
  });
  const rpc = createRpcClients(app, { cookie: user.cookie });
  const get = (id: string) => rpc.changeRequest.getChangeRequest({ id });
  return { db, media, association, live, changeRequest, get };
}

test("a rejected request whose collection went live through another request points to it", async () => {
  const { live, changeRequest, get } = await setup();
  // Submitted before the media existed: only its target key ties it to the media.
  const rejected = await changeRequest({ status: "rejected" });

  expect((await get(rejected)).liveChangeRequestId).toBe(live);
  // The live request itself, and a request for another collection, point nowhere.
  expect((await get(live)).liveChangeRequestId).toBeUndefined();
  const other = await changeRequest({ status: "rejected", nativeId: "mzc00200other00" });
  expect((await get(other)).liveChangeRequestId).toBeUndefined();
});

test("once that association is taken down, the rejected request points nowhere", async () => {
  const { db, association, changeRequest, get } = await setup();
  const rejected = await changeRequest({ status: "rejected" });
  await db
    .updateTable("associations")
    .set({ status: "delisted" })
    .where("id", "=", association.id)
    .execute();

  expect((await get(rejected)).liveChangeRequestId).toBeUndefined();
});
