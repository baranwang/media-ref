import type { Message, MessageBatch } from "@cloudflare/workers-types";
import { createApiApp } from "@media-ref/api/app";
import {
  createFakeOutboundClient,
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
  fromProtoChangeRequestStatus,
  getChangeRequestStateRpc,
  getMediaDocumentRpc,
  issueApiKeyRpc,
  mediaRef,
  signUpAndVerifyUser,
  TEST_BASE_URL,
  toProtoSegmentInput,
} from "./rpc-helpers.ts";
import { NamespaceGroup } from "@media-ref/client/proto";
import { DOUBAN_API } from "@media-ref/core";

// A test key, and no pacing delays against the fake Douban.
DOUBAN_API.apiKey = "test-douban-key";
DOUBAN_API.minIntervalMs = 0;
DOUBAN_API.retryDelayMs = 0;

const TEST_AUTH_SECRET = "test-secret-for-unified-associations-tests-0123456789abcdef";
const t0 = new Date("2026-11-24T10:00:00.000Z");

function jsonResponse(url: string, payload: unknown, status = 200): ExternalHttpResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
    url,
  };
}

const DOUBAN_ENTRIES: Record<string, { title: string; episodes: number }> = {
  "2001": { title: "咒术回战 Part.1", episodes: 12 },
  "2002": { title: "咒术回战 Part.2", episodes: 12 },
};

function stub(request: ExternalHttpRequest): ExternalHttpResponse {
  if (
    request.kind === "catalog" &&
    request.namespace === "tmdb" &&
    request.url.includes("/tv/95479")
  ) {
    return jsonResponse(request.url, {
      id: 95479,
      name: "咒术回战",
      original_name: "呪術廻戦",
      first_air_date: "2020-10-03",
      seasons: [{ season_number: 1, episode_count: 24, air_date: "2020-10-03" }],
      external_ids: { imdb_id: "tt12343534", tvdb_id: 377543 },
    });
  }
  if (request.kind === "catalog" && request.namespace === "douban") {
    const id = new URL(request.url).pathname.match(/\/subject\/(\d+)$/)?.[1];
    const entry = id ? DOUBAN_ENTRIES[id] : undefined;
    if (entry) {
      return jsonResponse(request.url, {
        id,
        title: entry.title,
        original_title: "呪術廻戦",
        year: "2020",
        type: "tv",
        is_tv: true,
        episodes_count: entry.episodes,
      });
    }
  }
  return jsonResponse(request.url, { status_code: 34 }, 404);
}

function queueBatch(bodies: JobQueueMessage[]): MessageBatch<JobQueueMessage> {
  const messages = bodies.map(
    (body, index) =>
      ({
        id: `msg-${index}-${body.jobId}`,
        timestamp: t0,
        body,
        attempts: 1,
        ack() {},
        retry() {},
      }) as Message<JobQueueMessage>,
  );
  return {
    queue: "media-ref-jobs",
    messages,
    metadata: { metrics: { backlogCount: messages.length, backlogBytes: 0 } },
    ackAll() {},
    retryAll() {},
  };
}

async function setup(testDb: TestDbHandle) {
  const outbound = createFakeOutboundClient({ fetchExternal: stub });
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
  const submitter = await signUpAndVerifyUser(app, outbound, {
    email: "unified-submitter@example.com",
    name: "Submitter",
  });
  const reviewer = await signUpAndVerifyUser(app, outbound, {
    email: "unified-reviewer@example.com",
    name: "Reviewer",
  });
  await testDb.writeDb
    .updateTable("user")
    .set({ role: "reviewer" })
    .where("id", "=", reviewer.userId)
    .execute();
  const submitKey = (
    await issueApiKeyRpc(app, submitter.cookie, { name: "Submit", canSubmit: true })
  ).key;
  const readKey = (await issueApiKeyRpc(app, submitter.cookie, { name: "Read", canSubmit: false }))
    .key;

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

  return {
    app,
    readKey,
    submitRpc: createRpcClients(app, { apiKey: submitKey }),
    approve: (input: { id: string; reason?: string }) =>
      approveInCore({ db: testDb.writeDb, outbound }, input),
    async drainEvidence() {
      await worker.scheduled({ scheduledTime: t0.getTime(), cron: "* * * * *", noRetry() {} });
      const evidence = emitted.filter((m) => m.jobType === "evidence_check");
      emitted.length = 0;
      if (evidence.length > 0) {
        await worker.queue(queueBatch(evidence));
      }
    },
  };
}

describe("Unified association model (ADR 0001)", () => {
  const handles: TestDbHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      await handles.pop()?.cleanup();
    }
  });

  test("Douban splits one TMDB season into N entries and the read API returns each entry's native title", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);
    const ctx = await setup(testDb);

    const crIds: string[] = [];
    for (const [nativeId, start] of [
      ["2001", 1],
      ["2002", 13],
    ] as const) {
      const res = await ctx.submitRpc.changeRequest.createChangeRequest({
        target: mediaRef("tmdb:tv:95479"),
        namespace: "douban",
        nativeId,
        segments: [
          toProtoSegmentInput({
            season: 1,
            episodeStart: start,
            episodeEnd: start + 11,
            targetEpisodeStart: 1,
            baseline: "tmdb",
          }),
        ],
      });
      crIds.push(res.changeRequest!.id);
    }

    await ctx.drainEvidence();
    for (const id of crIds) {
      const cr = await getChangeRequestStateRpc(ctx.app, { apiKey: ctx.readKey }, id);
      if (cr.status === "needs_review") {
        await ctx.approve({ id, reason: "split season" });
      }
      expect((await getChangeRequestStateRpc(ctx.app, { apiKey: ctx.readKey }, id)).status).toBe(
        "approved",
      );
    }

    const byEntry = await getMediaDocumentRpc(ctx.app, ctx.readKey, "douban:2002");
    const doubanAssocs = byEntry.document.associations
      .filter((a) => a.namespace === "douban")
      .map((a) => ({
        nativeId: a.nativeId,
        title: a.title,
        episodeCount: a.episodeCount,
        segments: a.segments.map((s) => [
          s.season,
          s.episodeStart,
          s.episodeEnd,
          s.targetEpisodeStart,
        ]),
      }))
      .sort((a, b) => a.nativeId.localeCompare(b.nativeId));
    expect(doubanAssocs).toEqual([
      { nativeId: "2001", title: "咒术回战 Part.1", episodeCount: 12, segments: [[1, 1, 12, 1]] },
      { nativeId: "2002", title: "咒术回战 Part.2", episodeCount: 12, segments: [[1, 13, 24, 1]] },
    ]);

    // Unified catalog query: Douban entries are associations, TMDB/IMDb/TVDB stay External IDs.
    const catalogView = await getMediaDocumentRpc(ctx.app, ctx.readKey, "tmdb:tv:95479", {
      namespaceGroup: NamespaceGroup.CATALOG,
    });
    expect(catalogView.document.media.id).toBe(byEntry.document.media.id);
    expect(
      catalogView.document.externalIds.map((e) => `${e.namespace}:${e.nativeId}`).sort(),
    ).toEqual(["imdb:tt12343534", "tmdb:tv:95479", "tvdb:377543"]);
    expect(catalogView.document.associations.map((a) => a.nativeId).sort()).toEqual([
      "2001",
      "2002",
    ]);
  });

  test("IMDb show External ID coexists with season and single-episode entries", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);
    const ctx = await setup(testDb);

    // Whole-media IDs on authority catalogs are External IDs, never change requests.
    const wholeErr = await expectRpcError(
      ctx.submitRpc.changeRequest.createChangeRequest({
        target: mediaRef("tmdb:tv:95479"),
        namespace: "imdb",
        nativeId: "tt12343534",
        segments: [],
      }),
    );
    expect(wholeErr).toMatchObject({ status: 400, code: "INVALID_NAMESPACE" });

    const entries = [
      { nativeId: "tt90000001", season: 1, start: 1, end: null }, // hypothetical season-level entry
      { nativeId: "tt13624322", season: 1, start: 1, end: 1 },
      { nativeId: "tt13624323", season: 1, start: 2, end: 2 },
    ];
    for (const entry of entries) {
      const res = await ctx.submitRpc.changeRequest.createChangeRequest({
        target: mediaRef("tmdb:tv:95479"),
        namespace: "imdb",
        nativeId: entry.nativeId,
        segments: [
          toProtoSegmentInput({
            season: entry.season,
            episodeStart: entry.start,
            episodeEnd: entry.end,
            targetEpisodeStart: 1,
            baseline: "tmdb",
          }),
        ],
      });
      const cr = res.changeRequest!;
      // No evidence adapter for IMDb entries: they go straight to a reviewer.
      expect(fromProtoChangeRequestStatus(cr.status)).toBe("needs_review");
      await ctx.approve({ id: cr.id, reason: "imdb entry" });
    }

    const byEpisode = await getMediaDocumentRpc(ctx.app, ctx.readKey, "imdb:tt13624322");
    const episodeAssoc = byEpisode.document.associations.find((a) => a.nativeId === "tt13624322");
    expect(byEpisode.matchedAssociationId).toBe(episodeAssoc?.id);
    expect(episodeAssoc).toMatchObject({
      namespace: "imdb",
      variantId: null,
      status: "confirmed",
      segments: [expect.objectContaining({ season: 1, episodeStart: 1, episodeEnd: 1 })],
    });
    expect(
      byEpisode.document.associations.filter((a) => a.namespace === "imdb").map((a) => a.nativeId),
    ).toHaveLength(3);
    expect(byEpisode.document.externalIds).toContainEqual(
      expect.objectContaining({ namespace: "imdb", nativeId: "tt12343534" }),
    );

    const byShow = await getMediaDocumentRpc(ctx.app, ctx.readKey, "imdb:tt12343534");
    expect(byShow.document.media.id).toBe(byEpisode.document.media.id);
    expect(byShow.matchedAssociationId).toBeNull();
  });
});
