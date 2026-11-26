import { proto } from "@media-ref/client";
import {
  createAdapterRegistry,
  createFakeOutboundClient,
  ensureReviewAgentUser,
  REVIEW_AGENT_USER_ID,
} from "@media-ref/core";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, expect, test } from "vite-plus/test";
import { createApiApp } from "../src/lib.ts";
import { createRpcClients, signUpUser, TEST_BASE_URL } from "./rpc-helpers.ts";

const handles: TestDbHandle[] = [];

afterEach(async () => {
  while (handles.length > 0) await handles.pop()!.cleanup();
});

test("reviewers can list the change requests the review agent approved", async () => {
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
      authSecret: "test-secret-for-media-ref-reviewer-list-tests-0123456789abcdef",
    },
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
  await ensureReviewAgentUser(testDb.writeDb);

  const approvedBy = async (nativeId: string, reviewer: string, reviewedAt: string) =>
    (
      await testDb.writeDb
        .insertInto("change_requests")
        .values({
          status: "approved",
          submitter_user_id: owner.userId,
          reviewer_user_id: reviewer,
          reviewed_at: new Date(reviewedAt),
          target_external_key: "tmdb:tv:95479",
          namespace: "bilibili",
          raw_native_id: nativeId,
          native_id: nativeId,
          segments: JSON.stringify([]),
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
  const older = await approvedBy("ss1", REVIEW_AGENT_USER_ID, "2026-11-01T00:00:00Z");
  await approvedBy("ss2", owner.userId, "2026-11-02T00:00:00Z");
  const newer = await approvedBy("ss3", REVIEW_AGENT_USER_ID, "2026-11-03T00:00:00Z");

  const ownerRpc = createRpcClients(app, { cookie: owner.cookie });
  const listed = await ownerRpc.reviewer.listChangeRequests({
    status: proto.ChangeRequestStatus.APPROVED,
    reviewerUserId: REVIEW_AGENT_USER_ID,
  });

  // Latest decisions first, so spot checks start with what the agent just did.
  expect(listed.changeRequests.map((cr) => cr.id)).toEqual([newer, older]);
  expect(listed.total).toBe(2);
});
