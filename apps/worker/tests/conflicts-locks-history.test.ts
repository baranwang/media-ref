import type { Message, MessageBatch, ScheduledController } from "@cloudflare/workers-types";
import { createApiApp } from "@media-ref/api/app";
import { resolveEpisode } from "@media-ref/client";
import {
  bilibiliAdapter,
  createAdapterRegistry,
  createFakeOutboundClient,
  createTier1Adapter,
  EVIDENCE_CHECK_JOB_TYPE,
  type ExternalHttpRequest,
  type ExternalHttpResponse,
  type JobQueueMessage,
} from "@media-ref/core";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { createBackgroundWorker } from "../src/index.ts";
import {
  approveInCore,
  createRpcClients,
  expectRpcError,
  fromProtoAssociationStatus,
  fromProtoChangeRequestStatus,
  fromProtoReviewAlertStatus,
  fromProtoSegment,
  getChangeRequestStateRpc,
  getMediaDocumentRpc,
  issueApiKeyRpc,
  mediaRef,
  proto,
  signUpAndVerifyUser,
  TEST_BASE_URL,
  toProtoSegmentInput,
} from "./rpc-helpers.ts";

const TEST_AUTH_SECRET = "test-secret-for-conflicts-locks-history-integration-0123456789";

function jsonResponse(url: string, payload: unknown, status = 200): ExternalHttpResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
    url,
  };
}

function makeBilibiliEpisodes(count: number) {
  const episodes: Array<Record<string, unknown>> = [];
  for (let i = 1; i <= count; i += 1) {
    episodes.push({
      id: 400000 + i,
      title: String(i),
      long_title: `第${i}话`,
      badge: "",
      badge_type: 0,
      section_type: 0,
      duration: 1435000,
    });
  }
  return episodes;
}

async function setupUser(
  app: ReturnType<typeof createApiApp>,
  outbound: ReturnType<typeof createFakeOutboundClient>,
  email: string,
) {
  const { userId, cookie } = await signUpAndVerifyUser(app, outbound, {
    email,
    name: email.split("@")[0] ?? "User",
  });
  const submitKey = await issueApiKeyRpc(app, cookie, { name: "Submit Key", canSubmit: true });
  const readKey = await issueApiKeyRpc(app, cookie, { name: "Read Key", canSubmit: false });

  return {
    userId,
    cookie,
    submitKey: submitKey.key,
    readKey: readKey.key,
  };
}

function createScheduledController(scheduledTime: Date): ScheduledController {
  return {
    scheduledTime: scheduledTime.getTime(),
    cron: "* * * * *",
    noRetry() {},
  };
}

function createQueueBatch(bodies: JobQueueMessage[], timestamp: Date = new Date()) {
  const tracked = bodies.map((body, index) => {
    const entry = {
      acked: false,
      retried: false,
      message: {
        id: `msg-${index + 1}-${body.jobId}-gen-${body.leaseGeneration}`,
        timestamp,
        body,
        attempts: 1,
        ack() {
          entry.acked = true;
        },
        retry() {
          entry.retried = true;
        },
      } as Message<JobQueueMessage>,
    };
    return entry;
  });

  const batch: MessageBatch<JobQueueMessage> = {
    queue: "media-ref-jobs",
    messages: tracked.map((entry) => entry.message),
    metadata: { metrics: { backlogCount: tracked.length, backlogBytes: 0 } },
    ackAll() {
      for (const entry of tracked) {
        entry.acked = true;
      }
    },
    retryAll() {
      for (const entry of tracked) {
        entry.retried = true;
      }
    },
  };

  return { batch, tracked };
}

function createConflictTestStub(
  customBilibili?: (seasonId: string, url: string) => ExternalHttpResponse | undefined,
) {
  return (request: ExternalHttpRequest): ExternalHttpResponse => {
    if (request.kind === "catalog" && request.namespace === "tmdb") {
      if (request.url.includes("/tv/95479")) {
        return jsonResponse(request.url, {
          id: 95479,
          name: "咒术回战",
          original_name: "呪術廻戦",
          first_air_date: "2020-10-03",
          seasons: [{ season_number: 1, episode_count: 24, air_date: "2020-10-03" }],
          external_ids: {
            imdb_id: "tt12343534",
            tvdb_id: 377543,
          },
        });
      }
      return jsonResponse(request.url, { status_code: 34, status_message: "Not found" }, 404);
    }

    if (request.kind === "catalog" && request.namespace === "trakt") {
      return jsonResponse(request.url, []);
    }

    if (request.kind === "platform" && request.namespace === "bilibili") {
      const match = request.url.match(/season_id=(\d+)/);
      const seasonId = match?.[1] ?? "";
      if (customBilibili) {
        const overridden = customBilibili(seasonId, request.url);
        if (overridden) {
          return overridden;
        }
      }

      if (seasonId === "34430" || seasonId === "34431") {
        // Passes Step 1 for TMDB tv:95479
        return jsonResponse(request.url, {
          code: 0,
          message: "success",
          result: {
            season_id: Number(seasonId),
            title: "咒术回战",
            jp_title: "呪術廻戦",
            type: 1,
            publish: { pub_time: "2020-10-03 01:25:00" },
            episodes: makeBilibiliEpisodes(24),
          },
        });
      }

      if (seasonId === "77777" || seasonId === "88888") {
        // Fails Step 1: wrong year (2024 vs 2020)
        return jsonResponse(request.url, {
          code: 0,
          message: "success",
          result: {
            season_id: Number(seasonId),
            title: "咒术回战",
            jp_title: "呪術廻戦",
            type: 1,
            publish: { pub_time: "2024-07-01 00:00:00" },
            episodes: makeBilibiliEpisodes(24),
          },
        });
      }

      if (seasonId === "404404") {
        return jsonResponse(request.url, { code: -404, message: "啥都木有" });
      }

      return jsonResponse(request.url, { code: -404, message: "not found" });
    }

    throw new Error(
      `Unexpected outbound request: ${request.kind}:${request.namespace} ${request.url}`,
    );
  };
}

async function seedConfirmedAssociation(
  app: ReturnType<typeof createApiApp>,
  worker: ReturnType<typeof createBackgroundWorker>,
  emitted: JobQueueMessage[],
  opts: {
    submitKey: string;
    reviewerCookie: string;
    nativeId: string;
    segments: Array<{
      season: number;
      episodeStart: number;
      episodeEnd: number | null;
      targetEpisodeStart: number;
      baseline: "tmdb";
      nonLinear?: boolean;
    }>;
    now: Date;
    /** Approve through core after the evidence check, as the review agent would. */
    approveManually?: Parameters<typeof approveInCore>[0];
  },
): Promise<{ mediaId: string; associationId: string; changeRequestId: string }> {
  const crRes = await createRpcClients(app, {
    apiKey: opts.submitKey,
  }).changeRequest.createChangeRequest({
    target: mediaRef("tmdb:tv:95479"),
    namespace: "bilibili",
    nativeId: opts.nativeId,
    variantDescription: "原声",
    segments: opts.segments.map(toProtoSegmentInput),
  });
  const crId = crRes.changeRequest!.id;

  await worker.scheduled(createScheduledController(opts.now));
  const messages = emitted.splice(0, emitted.length);
  expect(messages.length).toBeGreaterThanOrEqual(1);
  await worker.queue(createQueueBatch(messages, opts.now).batch);

  if (opts.approveManually) {
    const approved = await approveInCore(opts.approveManually, {
      id: crId,
      reason: "Seeded by reviewer",
    });
    return {
      mediaId: approved.mediaId,
      associationId: approved.associationId,
      changeRequestId: crId,
    };
  }

  const crCheck = await getChangeRequestStateRpc(app, { cookie: opts.reviewerCookie }, crId);
  expect(crCheck.status).toBe("approved");
  return {
    mediaId: crCheck.mediaId!,
    associationId: crCheck.appliedAssociationId!,
    changeRequestId: crId,
  };
}

describe("Conflict resolution 4-way matrix, timeouts, locks, and revision history (#12)", () => {
  const handles: TestDbHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop();
      if (handle) {
        await handle.cleanup();
      }
    }
  });

  test("Matrix (new=PASS, old=FAIL): auto-replaces same-collection update and preserves revision 1 and revision 2 in history", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-23T10:00:00.000Z");
    const outbound = createFakeOutboundClient({
      fetchExternal: createConflictTestStub(),
    });
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => t0,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });

    const user = await setupUser(app, outbound, "same-coll-user@example.com");
    const reviewer = await setupUser(app, outbound, "same-coll-rev@example.com");
    await testDb.writeDb
      .updateTable("user")
      .set({ role: "reviewer" })
      .where("id", "=", reviewer.userId)
      .execute();

    // Uses the built-in Evidence Gate Step 2 (#11) to verify segment episode coverage on both sides
    const emitted: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
      config: {
        tmdb: { accessToken: "test-tmdb-token" },
        enableDailyTmdbSync: false,
        jobTypes: [EVIDENCE_CHECK_JOB_TYPE],
      },
      now: () => t0,
    });

    // Seed confirmed association rev 1 with outdated segments E1-12 (fails Step 2 because ss34430 has 24 eps)
    const seeded = await seedConfirmedAssociation(app, worker, emitted, {
      submitKey: user.submitKey,
      reviewerCookie: reviewer.cookie,
      nativeId: "ss34430",
      segments: [
        { season: 1, episodeStart: 1, episodeEnd: 12, targetEpisodeStart: 1, baseline: "tmdb" },
      ],
      now: t0,
      approveManually: { db: testDb.writeDb, outbound },
    });

    // Submit updated CR for the SAME ss34430 covering full E1-24 (passes Step 1 & Step 2)
    const updateRes = await createRpcClients(app, {
      apiKey: user.submitKey,
    }).changeRequest.createChangeRequest({
      target: mediaRef("tmdb:tv:95479"),
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
    const updateCr = updateRes.changeRequest!;
    expect(fromProtoChangeRequestStatus(updateCr.status)).toBe("pending_evidence");

    await worker.scheduled(createScheduledController(t0));
    const messages = emitted.splice(0, emitted.length);
    expect(messages).toHaveLength(1);
    const qSummary = await worker.queue(createQueueBatch(messages, t0).batch);
    expect(qSummary.completed).toBe(1);

    // CR auto-approved with both newEvidence and existingEvidence recorded
    const crState = await getChangeRequestStateRpc(app, { apiKey: user.readKey }, updateCr.id);
    expect(crState.status).toBe("approved");
    expect(crState.appliedAssociationId).toBe(seeded.associationId);
    expect(crState.evidence?.newEvidence).toBeDefined();
    expect(crState.evidence?.existingEvidence).toBeDefined();
    const existingEvidence = crState.evidence?.existingEvidence as {
      gate?: { step2?: { conflicts?: Array<{ code: string }> } };
    };
    expect(existingEvidence?.gate?.step2?.conflicts?.[0]?.code).toBe(
      "segment_episode_count_mismatch",
    );

    // Read API returns updated E1-24 segments
    const mediaBody = await getMediaDocumentRpc(app, user.readKey, "tmdb:tv:95479");
    const resolved = resolveEpisode(mediaBody.document, {
      namespace: "bilibili",
      season: 1,
      episode: 20,
    });
    expect(resolved).toMatchObject({ kind: "mapped", nativeId: "ss34430", targetEpisode: 20 });

    // Revision history preserves BOTH revision 1 (old E1-12) and revision 2 (new E1-24)
    const revBody = await createRpcClients(app, {
      apiKey: user.readKey,
    }).association.listAssociationRevisions({
      associationId: seeded.associationId,
    });
    expect(revBody.revisions.map((r) => r.revisionNumber)).toEqual([1, 2]);
    expect(fromProtoSegment(revBody.revisions[0]!.segments[0]!)).toMatchObject({
      episodeStart: 1,
      episodeEnd: 12,
    });
    expect(fromProtoSegment(revBody.revisions[1]!.segments[0]!)).toMatchObject({
      episodeStart: 1,
      episodeEnd: 24,
    });
  });

  test("Approving another season on an already-mapped collection keeps the seasons it does not speak for", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-27T10:00:00.000Z");
    const baseStub = createConflictTestStub();
    const outbound = createFakeOutboundClient({
      fetchExternal: (request) =>
        request.kind === "catalog" &&
        request.namespace === "tmdb" &&
        request.url.includes("/tv/95479")
          ? jsonResponse(request.url, {
              id: 95479,
              name: "咒术回战",
              original_name: "呪術廻戦",
              first_air_date: "2020-10-03",
              seasons: [
                { season_number: 1, episode_count: 24, air_date: "2020-10-03" },
                { season_number: 2, episode_count: 12, air_date: "2023-07-06" },
              ],
              external_ids: { imdb_id: "tt12343534", tvdb_id: 377543 },
            })
          : baseStub(request),
    });
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => t0,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });
    const user = await setupUser(app, outbound, "merge-user@example.com");
    const reviewer = await setupUser(app, outbound, "merge-rev@example.com");
    await testDb.writeDb
      .updateTable("user")
      .set({ role: "reviewer" })
      .where("id", "=", reviewer.userId)
      .execute();
    const emitted: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
      config: {
        tmdb: { accessToken: "test-tmdb-token" },
        enableDailyTmdbSync: false,
        jobTypes: [EVIDENCE_CHECK_JOB_TYPE],
      },
      now: () => t0,
    });

    // Lands a change request on ss34430 (24 entries) through the gate, approving it if it stops at review.
    const land = async (
      segments: Array<{
        season: number;
        episodeStart: number;
        episodeEnd: number;
        targetEpisodeStart: number;
      }>,
    ) => {
      const created = await createRpcClients(app, {
        apiKey: user.submitKey,
      }).changeRequest.createChangeRequest({
        target: mediaRef("tmdb:tv:95479"),
        namespace: "bilibili",
        nativeId: "ss34430",
        variantDescription: "原声",
        segments: segments.map((s) => toProtoSegmentInput({ ...s, baseline: "tmdb" })),
      });
      const crId = created.changeRequest!.id;
      await worker.scheduled(createScheduledController(t0));
      await worker.queue(createQueueBatch(emitted.splice(0, emitted.length), t0).batch);
      const state = await getChangeRequestStateRpc(app, { cookie: reviewer.cookie }, crId);
      if (state.status === "needs_review") {
        await approveInCore({ db: testDb.writeDb, outbound }, { id: crId, reason: "test" });
      } else {
        expect(state.status).toBe("approved");
      }
    };
    const resolve = async (season: number, episode: number) =>
      resolveEpisode((await getMediaDocumentRpc(app, user.readKey, "tmdb:tv:95479")).document, {
        namespace: "bilibili",
        season,
        episode,
      });

    // Season 1 on positions 1–12, then season 2 on positions 13–24 of the same collection.
    await land([{ season: 1, episodeStart: 1, episodeEnd: 12, targetEpisodeStart: 1 }]);
    await land([{ season: 2, episodeStart: 1, episodeEnd: 12, targetEpisodeStart: 13 }]);
    expect(await resolve(1, 5)).toMatchObject({
      kind: "mapped",
      nativeId: "ss34430",
      targetEpisode: 5,
    });
    expect(await resolve(2, 3)).toMatchObject({
      kind: "mapped",
      nativeId: "ss34430",
      targetEpisode: 15,
    });

    // A request that claims positions 1–24 for season 1 supersedes season 2 on those positions.
    await land([{ season: 1, episodeStart: 1, episodeEnd: 24, targetEpisodeStart: 1 }]);
    expect(await resolve(1, 20)).toMatchObject({ kind: "mapped", targetEpisode: 20 });
    expect(await resolve(2, 3)).not.toMatchObject({ kind: "mapped" });
  });

  test("Matrix (new=PASS, old=FAIL) via replacesAssociationId: auto-delists old collection, activates new one, preserves histories, and still rejects accidental overlap without replacesAssociationId", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-23T11:00:00.000Z");
    const outbound = createFakeOutboundClient({
      fetchExternal: createConflictTestStub(),
    });
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => t0,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });

    const user = await setupUser(app, outbound, "replace-user@example.com");
    const reviewer = await setupUser(app, outbound, "replace-rev@example.com");
    await testDb.writeDb
      .updateTable("user")
      .set({ role: "reviewer" })
      .where("id", "=", reviewer.userId)
      .execute();

    const emitted: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
      config: { tmdb: { accessToken: "test-tmdb-token" }, enableDailyTmdbSync: false },
      now: () => t0,
    });

    // Seed failing collection ss77777 (wrong year 2024) as confirmed
    const oldAssoc = await seedConfirmedAssociation(app, worker, emitted, {
      submitKey: user.submitKey,
      reviewerCookie: reviewer.cookie,
      nativeId: "ss77777",
      segments: [
        { season: 1, episodeStart: 1, episodeEnd: 24, targetEpisodeStart: 1, baseline: "tmdb" },
      ],
      now: t0,
      approveManually: { db: testDb.writeDb, outbound },
    });

    const submitRpc = createRpcClients(app, { apiKey: user.submitKey });
    const readRpc = createRpcClients(app, { apiKey: user.readKey });

    // Accidental overlapping submission WITHOUT replacesAssociationId is still rejected (US #38)
    const accidentalOverlapErr = await expectRpcError(
      submitRpc.changeRequest.createChangeRequest({
        target: mediaRef("tmdb:tv:95479"),
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
      }),
    );
    expect(accidentalOverlapErr.status).toBe(400);
    expect(accidentalOverlapErr.code).toBe("SEGMENT_OVERLAP");

    // Explicit challenge WITH replacesAssociationId is accepted
    const challengeRes = await submitRpc.changeRequest.createChangeRequest({
      target: mediaRef("tmdb:tv:95479"),
      namespace: "bilibili",
      nativeId: "ss34430",
      variantDescription: "原声",
      replacesAssociationId: oldAssoc.associationId,
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
    const challengeCr = challengeRes.changeRequest!;
    expect(challengeCr.replacesAssociationId).toBe(oldAssoc.associationId);

    await worker.scheduled(createScheduledController(t0));
    const messages = emitted.splice(0, emitted.length);
    await worker.queue(createQueueBatch(messages, t0).batch);

    const crAfter = await getChangeRequestStateRpc(app, { apiKey: user.readKey }, challengeCr.id);
    expect(crAfter.status).toBe("approved");
    expect(crAfter.appliedAssociationId).not.toBe(oldAssoc.associationId);
    expect(crAfter.evidence?.newEvidence).toBeDefined();
    expect(crAfter.evidence?.existingEvidence).toBeDefined();

    // Read API returns ONLY the new collection ss34430
    const mediaBody = await getMediaDocumentRpc(app, user.readKey, "tmdb:tv:95479");
    expect(mediaBody.document.associations).toHaveLength(1);
    expect(mediaBody.document.associations[0]?.nativeId).toBe("ss34430");

    // Old association's revision history preserves rev 1 (confirmed) and rev 2 (delisted)
    const oldRevBody = await readRpc.association.listAssociationRevisions({
      associationId: oldAssoc.associationId,
    });
    expect(fromProtoAssociationStatus(oldRevBody.association!.status)).toBe("delisted");
    expect(
      oldRevBody.revisions.map((r) => ({
        n: r.revisionNumber,
        s: fromProtoAssociationStatus(r.status),
      })),
    ).toEqual([
      { n: 1, s: "confirmed" },
      { n: 2, s: "delisted" },
    ]);
    expect(oldRevBody.revisions[1]?.changeRequestId).toBe(challengeCr.id);

    // New association's revision history starts at rev 1 (confirmed)
    const newRevBody = await readRpc.association.listAssociationRevisions({
      associationId: crAfter.appliedAssociationId!,
    });
    expect(newRevBody.association?.nativeId).toBe("ss34430");
    expect(fromProtoAssociationStatus(newRevBody.association!.status)).toBe("confirmed");
    expect(newRevBody.revisions).toHaveLength(1);
    expect(newRevBody.revisions[0]?.changeRequestId).toBe(challengeCr.id);
  });

  test("Matrix (new=PASS, old=PASS), (new=FAIL, old=PASS), and (new=FAIL, old=FAIL) all route to needs_review without changing existing association", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-23T12:00:00.000Z");
    const outbound = createFakeOutboundClient({
      fetchExternal: createConflictTestStub(),
    });
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => t0,
        tmdb: { accessToken: "test-tmdb-token" },
        submitBaseHourlyLimit: 20,
      },
    });

    const user = await setupUser(app, outbound, "matrix-user@example.com");
    const reviewer = await setupUser(app, outbound, "matrix-rev@example.com");
    await testDb.writeDb
      .updateTable("user")
      .set({ role: "reviewer" })
      .where("id", "=", reviewer.userId)
      .execute();

    const emitted: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
      config: { tmdb: { accessToken: "test-tmdb-token" }, enableDailyTmdbSync: false },
      now: () => t0,
    });

    // Seed PASSING association ss34430
    const passingAssoc = await seedConfirmedAssociation(app, worker, emitted, {
      submitKey: user.submitKey,
      reviewerCookie: reviewer.cookie,
      nativeId: "ss34430",
      segments: [
        { season: 1, episodeStart: 1, episodeEnd: 24, targetEpisodeStart: 1, baseline: "tmdb" },
      ],
      now: t0,
    });

    const submitRpc = createRpcClients(app, { apiKey: user.submitKey });

    const submitChallenge = async (nativeId: string, replacesAssociationId: string) => {
      const res = await submitRpc.changeRequest.createChangeRequest({
        target: mediaRef("tmdb:tv:95479"),
        namespace: "bilibili",
        nativeId,
        variantDescription: "原声",
        replacesAssociationId,
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
      await worker.scheduled(createScheduledController(t0));
      const messages = emitted.splice(0, emitted.length);
      await worker.queue(createQueueBatch(messages, t0).batch);
      return getChangeRequestStateRpc(app, { apiKey: user.readKey }, res.changeRequest!.id);
    };

    // Case 2: new=PASS (ss34431) vs old=PASS (ss34430) -> needs_review (both_passed_evidence_gate)
    const bothPass = await submitChallenge("ss34431", passingAssoc.associationId);
    expect(bothPass.status).toBe("needs_review");
    expect(bothPass.conflictReason).toBe("both_passed_evidence_gate");
    expect(bothPass.evidence?.newEvidence).toBeDefined();
    expect(bothPass.evidence?.existingEvidence).toBeDefined();

    // Case 3: new=FAIL (ss77777) vs old=PASS (ss34430) -> needs_review (new_failed_old_passed)
    const newFailOldPass = await submitChallenge("ss77777", passingAssoc.associationId);
    expect(newFailOldPass.status).toBe("needs_review");
    expect(newFailOldPass.conflictReason).toBe("new_failed_old_passed");
    expect(newFailOldPass.evidence?.newEvidence).toBeDefined();
    expect(newFailOldPass.evidence?.existingEvidence).toBeDefined();

    // Existing association ss34430 is COMPLETELY UNCHANGED
    const mediaAfterCases2And3 = await getMediaDocumentRpc(app, user.readKey, "tmdb:tv:95479");
    expect(mediaAfterCases2And3.document.associations).toHaveLength(1);
    expect(mediaAfterCases2And3.document.associations[0]?.nativeId).toBe("ss34430");

    // Now test Case 4: new=FAIL (ss88888) vs old=FAIL (ss77777) on a fresh variant "中配"
    const failingAssocRes = await submitRpc.changeRequest.createChangeRequest({
      target: mediaRef("tmdb:tv:95479"),
      namespace: "bilibili",
      nativeId: "ss77777",
      variantDescription: "中配",
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
    await worker.scheduled(createScheduledController(t0));
    await worker.queue(createQueueBatch(emitted.splice(0, emitted.length), t0).batch);
    const failingApproved = await approveInCore(
      { db: testDb.writeDb, outbound },
      {
        id: failingAssocRes.changeRequest!.id,
      },
    );

    const bothFailRes = await submitRpc.changeRequest.createChangeRequest({
      target: mediaRef("tmdb:tv:95479"),
      namespace: "bilibili",
      nativeId: "ss88888",
      variantDescription: "中配",
      replacesAssociationId: failingApproved.associationId,
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
    await worker.scheduled(createScheduledController(t0));
    await worker.queue(createQueueBatch(emitted.splice(0, emitted.length), t0).batch);

    const bothFailState = await getChangeRequestStateRpc(
      app,
      { apiKey: user.readKey },
      bothFailRes.changeRequest!.id,
    );
    expect(bothFailState.status).toBe("needs_review");
    expect(bothFailState.conflictReason).toBe("both_failed_evidence_gate");
    expect(bothFailState.evidence?.newEvidence).toBeDefined();
    expect(bothFailState.evidence?.existingEvidence).toBeDefined();

    // Failing old association ss77777 is STILL unchanged (not auto-delisted or replaced)
    const mediaAfterCase4 = await getMediaDocumentRpc(app, user.readKey, "tmdb:tv:95479");
    expect(mediaAfterCase4.document.associations.map((a) => a.nativeId).sort()).toEqual([
      "ss34430",
      "ss77777",
    ]);
  });

  test("Old record timeout (transient_error) retries instead of treating old as failed, leaving old association untouched until recovery", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    let now = new Date("2026-11-23T13:00:00.000Z");
    let oldShouldTimeout = false;

    const outbound = createFakeOutboundClient({
      fetchExternal: createConflictTestStub((seasonId, url) => {
        if (seasonId === "77777" && oldShouldTimeout) {
          return {
            status: 503,
            headers: { "content-type": "text/plain" },
            body: "upstream gateway timeout",
            url,
          };
        }
        return undefined;
      }),
    });

    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => now,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });

    const user = await setupUser(app, outbound, "timeout-user@example.com");
    const reviewer = await setupUser(app, outbound, "timeout-rev@example.com");
    await testDb.writeDb
      .updateTable("user")
      .set({ role: "reviewer" })
      .where("id", "=", reviewer.userId)
      .execute();

    const emitted: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
      config: {
        defaultRetryDelayMs: 60_000,
        tmdb: { accessToken: "test-tmdb-token" },
        enableDailyTmdbSync: false,
        jobTypes: [EVIDENCE_CHECK_JOB_TYPE],
      },
      now: () => now,
    });

    const oldAssoc = await seedConfirmedAssociation(app, worker, emitted, {
      submitKey: user.submitKey,
      reviewerCookie: reviewer.cookie,
      nativeId: "ss77777",
      segments: [
        { season: 1, episodeStart: 1, episodeEnd: 24, targetEpisodeStart: 1, baseline: "tmdb" },
      ],
      now,
      approveManually: { db: testDb.writeDb, outbound },
    });

    // Now make the old record return transient 503 during conflict re-check
    oldShouldTimeout = true;

    const challengeRes = await createRpcClients(app, {
      apiKey: user.submitKey,
    }).changeRequest.createChangeRequest({
      target: mediaRef("tmdb:tv:95479"),
      namespace: "bilibili",
      nativeId: "ss34430",
      variantDescription: "原声",
      replacesAssociationId: oldAssoc.associationId,
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
    const challengeCr = challengeRes.changeRequest!;

    // Attempt 1: new passes, old returns 503 -> MUST retry, NOT auto-replace!
    await worker.scheduled(createScheduledController(now));
    const retrySummary = await worker.queue(
      createQueueBatch(emitted.splice(0, emitted.length), now).batch,
    );
    expect(retrySummary.rescheduled).toBe(1);
    expect(retrySummary.completed).toBe(0);

    const crPending = await getChangeRequestStateRpc(app, { apiKey: user.readKey }, challengeCr.id);
    expect(crPending.status).toBe("pending_evidence");

    // Old association ss77777 is STILL active in read API!
    const mediaDuringTimeout = await getMediaDocumentRpc(app, user.readKey, "tmdb:tv:95479");
    expect(mediaDuringTimeout.document.associations).toHaveLength(1);
    expect(mediaDuringTimeout.document.associations[0]?.nativeId).toBe("ss77777");

    // Attempt 2: after backoff, old recovers with definitive failing response (year 2024) -> auto-replaces!
    oldShouldTimeout = false;
    now = new Date(now.getTime() + 65_000);
    await worker.scheduled(createScheduledController(now));
    const recoveredSummary = await worker.queue(
      createQueueBatch(emitted.splice(0, emitted.length), now).batch,
    );
    expect(recoveredSummary.completed).toBe(1);

    const crApproved = await getChangeRequestStateRpc(
      app,
      { apiKey: user.readKey },
      challengeCr.id,
    );
    expect(crApproved.status).toBe("approved");

    const mediaAfterRecovery = await getMediaDocumentRpc(app, user.readKey, "tmdb:tv:95479");
    expect(mediaAfterRecovery.document.associations).toHaveLength(1);
    expect(mediaAfterRecovery.document.associations[0]?.nativeId).toBe("ss34430");
  });

  test("A locked association emits an open review alert and refuses replacement until unlocked", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-23T14:00:00.000Z");
    const outbound = createFakeOutboundClient({
      fetchExternal: createConflictTestStub(),
    });
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => t0,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });

    const user = await setupUser(app, outbound, "locked-user@example.com");
    const reviewer = await setupUser(app, outbound, "locked-rev@example.com");
    await testDb.writeDb
      .updateTable("user")
      .set({ role: "reviewer" })
      .where("id", "=", reviewer.userId)
      .execute();

    const emitted: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
      config: {
        tmdb: { accessToken: "test-tmdb-token" },
        enableDailyTmdbSync: false,
        jobTypes: [EVIDENCE_CHECK_JOB_TYPE],
      },
      now: () => t0,
    });

    const submitRpc = createRpcClients(app, { apiKey: user.submitKey });
    const reviewerRpc = createRpcClients(app, { cookie: reviewer.cookie });

    // Seed failing collection ss77777 and LOCK it via reviewer endpoint
    const lockedAssoc = await seedConfirmedAssociation(app, worker, emitted, {
      submitKey: user.submitKey,
      reviewerCookie: reviewer.cookie,
      nativeId: "ss77777",
      segments: [
        { season: 1, episodeStart: 1, episodeEnd: 24, targetEpisodeStart: 1, baseline: "tmdb" },
      ],
      now: t0,
      approveManually: { db: testDb.writeDb, outbound },
    });

    const lockRes = await reviewerRpc.reviewer.setAssociationLock({
      associationId: lockedAssoc.associationId,
      locked: true,
    });
    expect(lockRes.locked).toBe(true);

    // Challenge locked ss77777 with PASSING ss34430
    const challengeRes = await submitRpc.changeRequest.createChangeRequest({
      target: mediaRef("tmdb:tv:95479"),
      namespace: "bilibili",
      nativeId: "ss34430",
      variantDescription: "原声",
      replacesAssociationId: lockedAssoc.associationId,
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
    const challengeCr = challengeRes.changeRequest!;

    await worker.scheduled(createScheduledController(t0));
    const qSummary = await worker.queue(
      createQueueBatch(emitted.splice(0, emitted.length), t0).batch,
    );
    expect(qSummary.completed).toBe(1);

    // MUST NOT auto-replace! Goes to needs_review with locked_association_challenged
    const crState = await getChangeRequestStateRpc(app, { apiKey: user.readKey }, challengeCr.id);
    expect(crState.status).toBe("needs_review");
    expect(crState.conflictReason).toBe("locked_association_challenged");

    // Read API STILL shows locked ss77777
    const mediaStillLocked = await getMediaDocumentRpc(app, user.readKey, "tmdb:tv:95479");
    expect(mediaStillLocked.document.associations).toHaveLength(1);
    expect(mediaStillLocked.document.associations[0]?.nativeId).toBe("ss77777");
    expect(mediaStillLocked.document.associations[0]?.locked).toBe(true);

    // Reviewer alerts endpoint surfaces the open locked_association_challenged alert
    const alertsBody = await reviewerRpc.reviewer.listReviewAlerts({
      status: proto.ReviewAlertStatus.OPEN,
      alertType: "locked_association_challenged",
    });
    expect(alertsBody.total).toBe(1);
    expect(alertsBody.alerts[0]).toMatchObject({
      alertType: "locked_association_challenged",
      mediaId: lockedAssoc.mediaId,
      associationId: lockedAssoc.associationId,
    });
    expect(fromProtoReviewAlertStatus(alertsBody.alerts[0]!.status)).toBe("open");
    expect((alertsBody.alerts[0]?.details as Record<string, unknown>)?.changeRequestId).toBe(
      challengeCr.id,
    );

    const approveReplacement = () =>
      approveInCore(
        { db: testDb.writeDb, outbound },
        {
          reviewerUserId: reviewer.userId,
          id: challengeCr.id,
          reason: "Verified ss34430 supersedes ss77777",
        },
      );
    await expect(approveReplacement()).rejects.toMatchObject({
      code: "ASSOCIATION_LOCKED",
      status: 409,
    });
    const unchanged = await getMediaDocumentRpc(app, user.readKey, "tmdb:tv:95479");
    expect(unchanged.document.associations).toMatchObject([
      { id: lockedAssoc.associationId, nativeId: "ss77777", locked: true },
    ]);

    await reviewerRpc.reviewer.setAssociationLock({
      associationId: lockedAssoc.associationId,
      locked: false,
    });
    await approveReplacement();

    const mediaAfterManualApprove = await getMediaDocumentRpc(app, user.readKey, "tmdb:tv:95479");
    expect(mediaAfterManualApprove.document.associations).toHaveLength(1);
    expect(mediaAfterManualApprove.document.associations[0]?.nativeId).toBe("ss34430");

    // Old locked association's history preserves rev 1 (confirmed) and rev 2 (delisted)
    const oldHistory = await reviewerRpc.association.listAssociationRevisions({
      associationId: lockedAssoc.associationId,
    });
    expect(fromProtoAssociationStatus(oldHistory.association!.status)).toBe("delisted");
    expect(oldHistory.revisions).toHaveLength(2);
    expect(oldHistory.revisions[1]).toMatchObject({
      revisionNumber: 2,
      actorUserId: reviewer.userId,
    });
    expect(fromProtoAssociationStatus(oldHistory.revisions[1]!.status)).toBe("delisted");

    // Submitting a challenge targeting the now-delisted association is rejected with 409
    const delistedChallengeErr = await expectRpcError(
      submitRpc.changeRequest.createChangeRequest({
        target: mediaRef("tmdb:tv:95479"),
        namespace: "bilibili",
        nativeId: "ss34431",
        replacesAssociationId: lockedAssoc.associationId,
        segments: [
          toProtoSegmentInput({
            season: 1,
            episodeStart: 1,
            episodeEnd: 24,
            targetEpisodeStart: 1,
            baseline: "tmdb",
          }),
        ],
      }),
    );
    expect(delistedChallengeErr.status).toBe(409);

    // Same-collection lock: lock the newly confirmed ss34430 and submit a segment update against it
    const newAssocId = mediaAfterManualApprove.document.associations[0]!.id;
    const lockNewRes = await reviewerRpc.reviewer.setAssociationLock({
      associationId: newAssocId,
      locked: true,
    });
    expect(lockNewRes.locked).toBe(true);

    const sameCollectionChallengeRes = await submitRpc.changeRequest.createChangeRequest({
      target: mediaRef("tmdb:tv:95479"),
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
    const sameCollectionCr = sameCollectionChallengeRes.changeRequest!;

    await worker.scheduled(createScheduledController(t0));
    await worker.queue(createQueueBatch(emitted.splice(0, emitted.length), t0).batch);

    const sameCollectionState = await getChangeRequestStateRpc(
      app,
      { apiKey: user.readKey },
      sameCollectionCr.id,
    );
    expect(sameCollectionState.status).toBe("needs_review");
    expect(sameCollectionState.conflictReason).toBe("locked_association_challenged");

    const allAlertsBody = await reviewerRpc.reviewer.listReviewAlerts({
      status: proto.ReviewAlertStatus.OPEN,
      alertType: "locked_association_challenged",
    });
    expect(allAlertsBody.total).toBe(2);
    expect(
      allAlertsBody.alerts.some(
        (a) =>
          a.associationId === newAssocId &&
          (a.details as Record<string, unknown>)?.changeRequestId === sameCollectionCr.id,
      ),
    ).toBe(true);
  });

  test("Conflict re-check resolves variantId description fallback for Step 2 non_original_default_variant protection", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-23T15:00:00.000Z");
    const outbound = createFakeOutboundClient({
      fetchExternal: createConflictTestStub(),
    });
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => t0,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });

    const user = await setupUser(app, outbound, "step2-conflict-user@example.com");
    const reviewer = await setupUser(app, outbound, "step2-conflict-rev@example.com");
    await testDb.writeDb
      .updateTable("user")
      .set({ role: "reviewer" })
      .where("id", "=", reviewer.userId)
      .execute();

    const emitted: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
      config: { tmdb: { accessToken: "test-tmdb-token" }, enableDailyTmdbSync: false },
      now: () => t0,
    });

    const submitRpc = createRpcClients(app, { apiKey: user.submitKey });

    // Seed an original default variant first
    await seedConfirmedAssociation(app, worker, emitted, {
      submitKey: user.submitKey,
      reviewerCookie: reviewer.cookie,
      nativeId: "ss34430",
      segments: [
        { season: 1, episodeStart: 1, episodeEnd: 24, targetEpisodeStart: 1, baseline: "tmdb" },
      ],
      now: t0,
    });

    // Seed a failing non-default dub association ("中配", ss77777 fails Step 1 wrong year 2024)
    const dubCrRes = await submitRpc.changeRequest.createChangeRequest({
      target: mediaRef("tmdb:tv:95479"),
      namespace: "bilibili",
      nativeId: "ss77777",
      variantDescription: "中配",
      setDefaultVariant: false,
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
    await worker.scheduled(createScheduledController(t0));
    await worker.queue(createQueueBatch(emitted.splice(0, emitted.length), t0).batch);
    const dubApproved = await approveInCore(
      { db: testDb.writeDb, outbound },
      {
        id: dubCrRes.changeRequest!.id,
      },
    );

    const mediaBefore = await getMediaDocumentRpc(app, user.readKey, "tmdb:tv:95479");
    const dubVariant = mediaBefore.document.variants.find((v) => v.label === "中配");
    expect(dubVariant?.isDefault).toBe(false);

    // Challenge failing dub association ss77777 with valid ss34431, referencing dub variantId and setDefaultVariant: true
    const challengeRes = await submitRpc.changeRequest.createChangeRequest({
      target: mediaRef("tmdb:tv:95479"),
      namespace: "bilibili",
      nativeId: "ss34431",
      variantId: dubVariant!.id,
      setDefaultVariant: true,
      replacesAssociationId: dubApproved.associationId,
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
    const challengeCr = challengeRes.changeRequest!;

    // Explicitly null out variant_description to verify DB fallback resolution from variantId in conflict path
    await testDb.writeDb
      .updateTable("change_requests")
      .set({ variant_description: null })
      .where("id", "=", challengeCr.id)
      .execute();

    await worker.scheduled(createScheduledController(t0));
    await worker.queue(createQueueBatch(emitted.splice(0, emitted.length), t0).batch);

    const crAfter = (await getChangeRequestStateRpc(
      app,
      { apiKey: user.readKey },
      challengeCr.id,
    )) as {
      status: string;
      conflictReason: string | null;
      evidence: {
        gate?: { step2?: { conflicts?: Array<{ code: string }> } };
      } | null;
    };

    // Even though old ss77777 fails Step 1, new CR MUST fail Step 2 (non_original_default_variant) -> needs_review!
    expect(crAfter.status).toBe("needs_review");
    expect(crAfter.conflictReason).toBe("both_failed_evidence_gate");
    expect(crAfter.evidence?.gate?.step2?.conflicts?.[0]?.code).toBe(
      "non_original_default_variant",
    );

    const mediaAfter = await getMediaDocumentRpc(app, user.readKey, "tmdb:tv:95479");
    expect(mediaAfter.document.variants.find((v) => v.label === "原声")?.isDefault).toBe(true);
    expect(mediaAfter.document.variants.find((v) => v.label === "中配")?.isDefault).toBe(false);
    expect(mediaAfter.document.associations.map((a) => a.nativeId).sort()).toEqual([
      "ss34430",
      "ss77777",
    ]);
  });

  test("evidence_check preserves replacesAssociationId in change_requests.evidence across non-conflict failure paths so reviewer approval still replaces target association", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-23T16:00:00.000Z");
    const outbound = createFakeOutboundClient({
      fetchExternal: createConflictTestStub(),
    });
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => t0,
        tmdb: { accessToken: "test-tmdb-token" },
      },
    });

    const user = await setupUser(app, outbound, "preserve-replace-user@example.com");
    const reviewer = await setupUser(app, outbound, "preserve-replace-rev@example.com");
    await testDb.writeDb
      .updateTable("user")
      .set({ role: "reviewer" })
      .where("id", "=", reviewer.userId)
      .execute();

    const emitted: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
      config: { tmdb: { accessToken: "test-tmdb-token" }, enableDailyTmdbSync: false },
      now: () => t0,
    });

    // Seed an existing confirmed association ss34430
    const existing = await seedConfirmedAssociation(app, worker, emitted, {
      submitKey: user.submitKey,
      reviewerCookie: reviewer.cookie,
      nativeId: "ss34430",
      segments: [
        { season: 1, episodeStart: 1, episodeEnd: 24, targetEpisodeStart: 1, baseline: "tmdb" },
      ],
      now: t0,
    });

    // Submit a replacement change request for a Tier 1 adapter (or collection_not_found on non-conflicting media)
    // Using a Tier 1 adapter registry hits the early Tier-1 branch in evidence-job.ts (which previously overwrote evidence!).
    const tier1Worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
      adapterRegistry: createAdapterRegistry([
        createTier1Adapter({
          namespace: "bilibili",
          parseInput: (raw) => bilibiliAdapter.parseInput(raw),
        }),
      ]),
      config: { tmdb: { accessToken: "test-tmdb-token" }, enableDailyTmdbSync: false },
      now: () => t0,
    });

    const replaceCrRes = await createRpcClients(app, {
      apiKey: user.submitKey,
    }).changeRequest.createChangeRequest({
      target: mediaRef("tmdb:tv:95479"),
      namespace: "bilibili",
      nativeId: "ss34431",
      variantDescription: "原声",
      replacesAssociationId: existing.associationId,
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
    const replaceCr = replaceCrRes.changeRequest!;

    // Run evidence_check via Tier-1 worker -> marks needs_review, MUST preserve replacesAssociationId!
    await tier1Worker.scheduled(createScheduledController(t0));
    const qSummary = await tier1Worker.queue(
      createQueueBatch(emitted.splice(0, emitted.length), t0).batch,
    );
    expect(qSummary.completed).toBe(1);

    const crAfterCheck = await getChangeRequestStateRpc(
      app,
      { apiKey: user.readKey },
      replaceCr.id,
    );
    expect(crAfterCheck.status).toBe("needs_review");
    expect(crAfterCheck.evidence?.replacesAssociationId).toBe(existing.associationId);
    expect(crAfterCheck.evidence?.adapterTier).toBe(1);

    // Reviewer approves -> MUST replace (delist) existing.associationId using preserved replacesAssociationId!
    await approveInCore(
      { db: testDb.writeDb, outbound },
      {
        id: replaceCr.id,
        reason: "Verified replacement after Tier 1 review",
      },
    );

    const mediaAfter = await getMediaDocumentRpc(app, user.readKey, "tmdb:tv:95479");
    expect(mediaAfter.document.associations).toHaveLength(1);
    expect(mediaAfter.document.associations[0]?.nativeId).toBe("ss34431");

    const oldAssoc = await testDb.readDb
      .selectFrom("associations")
      .select("status")
      .where("id", "=", existing.associationId)
      .executeTakeFirstOrThrow();
    expect(oldAssoc.status).toBe("delisted");
  });

  test("idempotent duplicate on the same unlocked confirmed collection auto-approves instead of triggering both_passed_evidence_gate", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-27T10:00:00.000Z");
    const outbound = createFakeOutboundClient({
      fetchExternal: createConflictTestStub(),
    });
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => t0,
        tmdb: { accessToken: "test-tmdb-token" },
        submitBaseHourlyLimit: 20,
      },
    });

    const user = await setupUser(app, outbound, "idem-user@example.com");

    const emitted: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
      config: { tmdb: { accessToken: "test-tmdb-token" }, enableDailyTmdbSync: false },
      now: () => t0,
    });

    const submitRpc = createRpcClients(app, { apiKey: user.submitKey });
    const mapping = {
      target: mediaRef("tmdb:tv:95479"),
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
    // Both requests precede confirmation. Only the first asks to change the default variant.
    const first = await submitRpc.changeRequest.createChangeRequest({
      ...mapping,
      setDefaultVariant: true,
    });
    await worker.scheduled(createScheduledController(t0));
    const firstBatch = emitted.splice(0);
    const dupRes = await submitRpc.changeRequest.createChangeRequest(mapping);
    await worker.queue(createQueueBatch(firstBatch, t0).batch);
    const firstState = await getChangeRequestStateRpc(
      app,
      { apiKey: user.readKey },
      first.changeRequest!.id,
    );
    expect(firstState.status).toBe("approved");
    await worker.scheduled(createScheduledController(t0));
    await worker.queue(createQueueBatch(emitted.splice(0), t0).batch);

    const dupState = await getChangeRequestStateRpc(
      app,
      { apiKey: user.readKey },
      dupRes.changeRequest!.id,
    );
    expect(dupState.status).toBe("approved");
    expect(dupState.conflictReason).toBeNull();
    expect(dupState.evidence?.conflict).toMatchObject({
      newPassed: true,
      oldPassed: true,
      outcome: "auto_replace",
    });
  });

  test("changing nonLinear flag on the same unlocked confirmed collection goes through conflict review instead of auto-approving", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const t0 = new Date("2026-11-27T10:00:00.000Z");
    const outbound = createFakeOutboundClient({
      fetchExternal: createConflictTestStub(),
    });
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        now: () => t0,
        tmdb: { accessToken: "test-tmdb-token" },
        submitBaseHourlyLimit: 20,
      },
    });

    const user = await setupUser(app, outbound, "nonlinear-user@example.com");
    const reviewer = await setupUser(app, outbound, "nonlinear-rev@example.com");
    await testDb.writeDb
      .updateTable("user")
      .set({ role: "reviewer" })
      .where("id", "=", reviewer.userId)
      .execute();

    const emitted: JobQueueMessage[] = [];
    const worker = createBackgroundWorker({
      db: testDb.writeDb,
      outbound,
      queue: {
        async send(message) {
          emitted.push(message);
        },
      },
      config: { tmdb: { accessToken: "test-tmdb-token" }, enableDailyTmdbSync: false },
      now: () => t0,
    });

    await seedConfirmedAssociation(app, worker, emitted, {
      submitKey: user.submitKey,
      reviewerCookie: reviewer.cookie,
      nativeId: "ss34430",
      segments: [
        {
          season: 1,
          episodeStart: 1,
          episodeEnd: 24,
          targetEpisodeStart: 1,
          baseline: "tmdb",
          nonLinear: true,
        },
      ],
      now: t0,
    });

    const submitRpc = createRpcClients(app, { apiKey: user.submitKey });
    const changeFlagRes = await submitRpc.changeRequest.createChangeRequest({
      target: mediaRef("tmdb:tv:95479"),
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
          nonLinear: false,
        }),
      ],
    });
    await worker.scheduled(createScheduledController(t0));
    await worker.queue(createQueueBatch(emitted.splice(0, emitted.length), t0).batch);

    const changeFlagState = await getChangeRequestStateRpc(
      app,
      { apiKey: user.readKey },
      changeFlagRes.changeRequest!.id,
    );
    expect(changeFlagState.status).toBe("needs_review");
    expect(changeFlagState.conflictReason).toBe("both_passed_evidence_gate");
  });
});
