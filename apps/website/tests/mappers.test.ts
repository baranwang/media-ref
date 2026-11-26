import { proto, type MediaDocument } from "@media-ref/client";
import { expect, test } from "vite-plus/test";
import { changeRequestFromProto, mediaItemFrom } from "../src/lib/mappers.ts";

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

test("a change request the agent kept for a human keeps its opinion and the human's decision", () => {
  const cr = changeRequestFromProto(
    reviewedCr({
      status: proto.ChangeRequestStatus.APPROVED,
      reviewerUserId: "u-human",
      evidence: {
        reviewAgent: { verdict: "keep_for_human", reasons: [], opinion: "集数对不上，需要人看" },
      },
    }),
  );

  expect(cr.reviewedByAgent).toBe(false);
  expect(cr.reviewAgent).toMatchObject({
    verdict: "keep_for_human",
    opinion: "集数对不上，需要人看",
  });
  expect(cr.timeline.at(-1)?.detail).toBe("审核员已批准，关联已经生效");
});
