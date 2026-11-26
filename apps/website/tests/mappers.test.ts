import { proto, type MediaDocument } from "@media-ref/client";
import { expect, test } from "vite-plus/test";
import {
  changeRequestFromProto,
  commentContent,
  commentThreadFrom,
  mediaItemFrom,
} from "../src/lib/mappers.ts";

test("whole-media platform associations span every season in the all-seasons view", () => {
  // Only the fields the mapper reads.
  const document = {
    media: {
      id: "m1",
      type: "tv",
      baseline: "tmdb",
      snapshot: {
        title: "T",
        seasons: [
          { season: 1, episodeCount: 10 },
          { season: 2, episodeCount: 12 },
        ],
      },
    },
    variants: [],
    externalIds: [],
    associations: [
      { id: "a1", namespace: "tencent", nativeId: "abc", segments: [], status: "active" },
    ],
  } as unknown as MediaDocument;

  const row = mediaItemFrom("m1", document, null)!.platformRows[0]!;
  expect(row.allSeasonSegments).toMatchObject([{ start: 1, end: 2, nativeId: "abc" }]);
});

test("auto-check list shows Step 1 and Step 2 conflicts together when Step 1 fails", () => {
  // Only the fields the mapper reads; Step 2 now runs even when Step 1 fails.
  const cr = {
    id: "cr1",
    namespace: "bilibili",
    nativeId: "ss1",
    rawNativeId: "ss1",
    segments: [],
    evidence: {
      gate: {
        decision: "needs_review",
        step1: {
          decision: "needs_review",
          matchedBy: "fields",
          fieldChecks: { title: "mismatch" },
        },
        step2: {
          decision: "needs_review",
          conflicts: [{ step: 2, code: "segment_season_not_found", message: "Season 9 not found" }],
        },
      },
    },
  } as unknown as Parameters<typeof changeRequestFromProto>[0];

  expect(changeRequestFromProto(cr).checks).toMatchObject([
    { id: "cr1-title", title: "片名对不上", status: "failed" },
    { id: "cr1-step2-0", detail: "Season 9 not found", status: "needs_confirm" },
  ]);
});

// Only the fields the mapper reads.
const reviewedCr = (overrides: Record<string, unknown>) =>
  ({
    id: "cr2",
    namespace: "bilibili",
    nativeId: "ss1",
    rawNativeId: "ss1",
    segments: [{ season: 1, episodeStart: 1, episodeEnd: 12, targetEpisodeStart: 1 }],
    createdAt: "2026-11-01T00:00:00Z",
    reviewedAt: "2026-11-01T01:00:00Z",
    ...overrides,
  }) as unknown as Parameters<typeof changeRequestFromProto>[0];

test("review agent approval shows the agent and its per-conflict reasons", () => {
  const cr = changeRequestFromProto(
    reviewedCr({
      status: proto.ChangeRequestStatus.APPROVED,
      reviewerUserId: "system:review-agent",
      decisionReason: "title_mismatch: 平台用了别名",
      evidence: {
        reviewAgent: {
          verdict: "approve",
          reasons: [{ code: "title_mismatch", reason: "平台用了别名" }],
          opinion: null,
        },
      },
    }),
  );

  expect(cr.reviewedByAgent).toBe(true);
  expect(cr.reviewAgent).toEqual({
    verdict: "approve",
    reasons: [{ code: "title_mismatch", reason: "平台用了别名" }],
    opinion: null,
    correction: null,
  });
  expect(cr.timeline.at(-1)).toMatchObject({
    label: "已生效",
    detail: "审核 agent 已批准，关联已经生效",
  });
});

test("review agent rejection with a correction shows the corrected season and segments", () => {
  const cr = changeRequestFromProto(
    reviewedCr({
      status: proto.ChangeRequestStatus.REJECTED,
      reviewerUserId: "system:review-agent",
      evidence: {
        reviewAgent: {
          verdict: "reject_with_correction",
          reasons: [{ code: "segment_season_not_found", reason: "这是第二季" }],
          opinion: null,
          correction: {
            season: 2,
            segments: [
              { season: 2, episodeStart: 1, episodeEnd: 6, targetEpisodeStart: 1 },
              { season: 2, episodeStart: 7, episodeEnd: null, targetEpisodeStart: 8 },
            ],
          },
        },
      },
    }),
  );

  expect(cr.reviewedByAgent).toBe(true);
  expect(cr.reviewAgent?.correction).toEqual({
    season: 2,
    segments: [
      { season: 2, start: 1, end: 6, targetStart: 1 },
      { season: 2, start: 7, end: null, targetStart: 8 },
    ],
  });
  expect(cr.timeline.at(-1)).toMatchObject({
    label: "已驳回",
    detail: "审核 agent 驳回并改正为第 2 季，会按改正重新提交",
  });
});

test("a plain review agent rejection shows the agent and its reason", () => {
  const cr = changeRequestFromProto(
    reviewedCr({
      status: proto.ChangeRequestStatus.REJECTED,
      reviewerUserId: "system:review-agent",
      decisionReason: "集数对不上",
      evidence: {
        reviewAgent: { verdict: "reject", reasons: [], opinion: "集数对不上" },
      },
    }),
  );

  expect(cr.reviewedByAgent).toBe(true);
  expect(cr.reviewAgent).toMatchObject({ verdict: "reject", opinion: "集数对不上" });
  expect(cr.timeline.at(-1)).toMatchObject({
    label: "已驳回",
    detail: "审核 agent 驳回：集数对不上",
  });
});

test("a change request in needs_review waits for the review agent", () => {
  const cr = changeRequestFromProto(
    reviewedCr({ status: proto.ChangeRequestStatus.NEEDS_REVIEW, reviewedAt: undefined }),
  );

  expect(cr.timeline.map((s) => s.detail)).toEqual([
    "变更单已提交",
    "有拿不准的地方，已转交审核 agent",
    "等审核 agent 判定通过或驳回",
  ]);
});

test("comments and the review agent's replies read as one thread, oldest first; a comment no reply answers is still waiting", () => {
  const comment = (fields: Partial<proto.ChangeRequestComment>) =>
    fields as unknown as proto.ChangeRequestComment;
  const thread = commentThreadFrom([
    comment({
      id: "r1",
      authorUserId: "system:review-agent",
      authorName: "Review Agent",
      content: "结论：通过，关联已生效。",
      replyToIds: ["c1"],
      createdAt: "2026-11-27T08:05:00.000Z",
    }),
    comment({
      id: "c2",
      authorUserId: "u2",
      authorName: "小王",
      content: "驳回：第 7 集起错开一位",
      replyToIds: [],
      createdAt: "2026-11-27T09:00:00.000Z",
    }),
    comment({
      id: "c1",
      authorUserId: "u1",
      authorName: "小李",
      content: "通过：多出来的是中章",
      replyToIds: [],
      createdAt: "2026-11-27T08:00:00.000Z",
    }),
  ]);

  expect(thread).toEqual([
    {
      id: "c1",
      byAgent: false,
      author: "小李",
      content: "通过：多出来的是中章",
      createdAt: "2026-11-27T08:00:00.000Z",
      waiting: false,
    },
    {
      id: "r1",
      byAgent: true,
      author: "审核 agent",
      content: "结论：通过，关联已生效。",
      createdAt: "2026-11-27T08:05:00.000Z",
      waiting: false,
    },
    {
      id: "c2",
      byAgent: false,
      author: "小王",
      content: "驳回：第 7 集起错开一位",
      createdAt: "2026-11-27T09:00:00.000Z",
      waiting: true,
    },
  ]);
});

test("the 通过 and 驳回 shortcuts send a comment that starts with 「通过：」 or 「驳回：」", () => {
  expect(commentContent("  多出来的是中章 ", "approve")).toBe("通过：多出来的是中章");
  expect(commentContent("", "reject")).toBe("驳回：");
  expect(commentContent("驳回：季号错了", "reject")).toBe("驳回：季号错了");
  expect(commentContent("  这是第二季 ")).toBe("这是第二季");
});
