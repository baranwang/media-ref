import { createAdapterRegistry, createFakeOutboundClient } from "@media-ref/core";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, expect, test } from "vite-plus/test";
import { createApiApp } from "../src/lib.ts";
import {
  createRpcClients,
  expectRpcError,
  issueApiKeyRpc,
  signUpUser,
  TEST_BASE_URL,
} from "./rpc-helpers.ts";

// People take part by commenting; the review agent acts on comments (ADR 0003 amendment 2).

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
      authSecret: "test-secret-for-media-ref-comment-tests-0123456789abcdef",
    },
  });
  const user = await signUpUser(app, outbound, {
    email: "commenter@example.com",
    password: "StrongPassword123!",
    name: "Commenter",
    verify: true,
  });
  const changeRequest = async (status: "needs_review" | "pending_evidence" | "approved") =>
    (
      await testDb.writeDb
        .insertInto("change_requests")
        .values({
          status,
          submitter_user_id: user.userId,
          target_external_key: "tmdb:tv:95479",
          namespace: "bilibili",
          raw_native_id: "ss1",
          native_id: "ss1",
          segments: JSON.stringify([]),
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
  const reviewJobs = () =>
    testDb.readDb
      .selectFrom("background_jobs")
      .select(["payload", "dedupe_key"])
      .where("job_type", "=", "review_agent")
      .execute();
  return { testDb, outbound, app, user, changeRequest, reviewJobs };
}

test("a signed-in user's comment is public on the change request and queues its review", async () => {
  const { app, outbound, user, changeRequest, reviewJobs } = await setup();
  const id = await changeRequest("approved");
  const rpc = createRpcClients(app, { cookie: user.cookie });

  const created = await rpc.contributor.createChangeRequestComment({
    changeRequestId: id,
    content: "  这个合集其实是第二季  ",
  });

  expect(created.comment).toMatchObject({
    changeRequestId: id,
    authorUserId: user.userId,
    authorName: "Commenter",
    content: "这个合集其实是第二季",
    replyToIds: [],
  });
  // Readable like the change request itself: here by someone else's read key.
  const other = await signUpUser(app, outbound, {
    email: "reader@example.com",
    password: "StrongPassword123!",
    name: "Reader",
    verify: true,
  });
  const key = await issueApiKeyRpc(app, other.cookie, { name: "read" });
  const listed = await createRpcClients(app, {
    apiKey: key.key,
  }).changeRequest.listChangeRequestComments({ changeRequestId: id });
  expect(listed.comments.map((c) => c.content)).toEqual(["这个合集其实是第二季"]);
  expect(await reviewJobs()).toEqual([
    { payload: { changeRequestId: id }, dedupe_key: `review_agent:${id}` },
  ]);
});

test("a comment while evidence is still being collected waits for the review: no job yet", async () => {
  const { app, user, changeRequest, reviewJobs } = await setup();
  const id = await changeRequest("pending_evidence");

  await createRpcClients(app, { cookie: user.cookie }).contributor.createChangeRequestComment({
    changeRequestId: id,
    content: "通过：分段对得上",
  });

  expect(await reviewJobs()).toEqual([]);
});

test("only signed-in users comment: not anonymously, not with an API key", async () => {
  const { app, user, changeRequest } = await setup();
  const id = await changeRequest("needs_review");
  const key = await issueApiKeyRpc(app, user.cookie, { name: "submit", canSubmit: true });

  const anonymous = await expectRpcError(
    createRpcClients(app).contributor.createChangeRequestComment({
      changeRequestId: id,
      content: "通过",
    }),
  );
  const withKey = await expectRpcError(
    createRpcClients(app, {
      apiKey: key.key,
      cookie: user.cookie,
    }).contributor.createChangeRequestComment({ changeRequestId: id, content: "通过" }),
  );

  expect(anonymous.status).toBe(401);
  expect(withKey).toMatchObject({ status: 403, code: "API_KEY_NOT_ALLOWED" });
});

test("comment content is trimmed, required and length-limited; the change request must exist", async () => {
  const { app, user, changeRequest } = await setup();
  const id = await changeRequest("needs_review");
  const rpc = createRpcClients(app, { cookie: user.cookie });
  const comment = (changeRequestId: string, content: string) =>
    expectRpcError(rpc.contributor.createChangeRequestComment({ changeRequestId, content }));

  expect(await comment(id, "   ")).toMatchObject({ status: 400, code: "INVALID_COMMENT" });
  expect(await comment(id, "长".repeat(1001))).toMatchObject({
    status: 400,
    code: "INVALID_COMMENT",
  });
  expect(await comment("00000000-0000-4000-8000-000000000000", "通过")).toMatchObject({
    status: 404,
    code: "CHANGE_REQUEST_NOT_FOUND",
  });
  await rpc.contributor.createChangeRequestComment({
    changeRequestId: id,
    content: "长".repeat(1000),
  });
});

test("each user has a daily comment cap", async () => {
  const { app, user, changeRequest } = await setup();
  const id = await changeRequest("needs_review");
  const rpc = createRpcClients(app, { cookie: user.cookie });

  for (let i = 0; i < 20; i += 1) {
    await rpc.contributor.createChangeRequestComment({ changeRequestId: id, content: `第 ${i}` });
  }
  const over = await expectRpcError(
    rpc.contributor.createChangeRequestComment({ changeRequestId: id, content: "再一条" }),
  );

  expect(over).toMatchObject({ status: 429, code: "COMMENT_LIMIT_REACHED" });
});

test("reviewers no longer approve or reject change requests: they are told to comment", async () => {
  const { app, testDb, user, changeRequest } = await setup();
  await testDb.writeDb
    .updateTable("user")
    .set({ role: "owner" })
    .where("id", "=", user.userId)
    .execute();
  const id = await changeRequest("needs_review");
  const rpc = createRpcClients(app, { cookie: user.cookie });

  const approve = await expectRpcError(rpc.reviewer.approveChangeRequest({ id }));
  const reject = await expectRpcError(rpc.reviewer.rejectChangeRequest({ id }));

  for (const error of [approve, reject]) {
    expect(error).toMatchObject({ status: 409, code: "DECIDED_BY_REVIEW_AGENT" });
    expect(error.connectError.code).toBe(9); // FailedPrecondition
    expect(error.connectError.rawMessage).toContain("请留言");
  }
  const cr = await testDb.readDb
    .selectFrom("change_requests")
    .select("status")
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
  expect(cr.status).toBe("needs_review");
});
