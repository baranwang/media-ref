import { expect, test } from "vite-plus/test";
import { buildReviewCoveragePreview } from "#/lib/review-preview";
import type { ChangeRequestItem, CoverageSegment, MediaItem } from "#/lib/types";

function makeChangeRequest(overrides: Partial<ChangeRequestItem> = {}): ChangeRequestItem {
  return {
    id: "ce7c82d3-e5f6-4d87-8fa8-dd692c59abe6",
    status: "pending_evidence",
    mediaId: "m-1",
    targetKey: "tmdb:tv:1001",
    namespace: "youku",
    nativeId: "adaec02f09f9469ab8d8",
    pageLink: null,
    pageTitle: "沧元图",
    pageEpisodeCount: 121,
    variantLabel: "原声",
    segments: [{ season: 1, start: 1, end: 121, targetStart: 1 }],
    replacesAssociationId: null,
    conflictReason: null,
    decisionReason: null,
    reviewerUserId: null,
    reviewedByAgent: false,
    reviewAgent: null,
    submitterUserId: "69vU60Zc",
    createdAt: "2026-11-26T00:00:00.000Z",
    reviewedAt: null,
    checks: [],
    timeline: [],
    ...overrides,
  };
}

function makeMedia(segments: CoverageSegment[], overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: "m-1",
    mediaId: "m-1",
    catalogKey: "tmdb:tv:1001",
    title: "沧元图",
    originalTitle: null,
    year: 2023,
    yearRange: "2023–",
    type: "tv",
    category: "anime",
    region: "",
    statusLabel: "",
    genres: [],
    synopsis: "",
    credits: [],
    posterUrl: null,
    backdropUrl: null,
    baseline: "tmdb",
    seasons: [{ season: 1, episodeCount: 121 }],
    platformRows: [
      {
        id: "youku:v-1",
        namespace: "youku",
        label: "原声",
        isDefault: true,
        segmentsBySeason: { 1: segments },
        allSeasonSegments: segments,
      },
    ],
    catalogRows: [],
    ...overrides,
  };
}

test("issue #98 repro: pending CR injected by includeUnconfirmed is excluded from '现在' and shown only in '通过后'", () => {
  const cr = makeChangeRequest();
  const injectedSelfSegment: CoverageSegment = {
    id: `change-request:${cr.id}-0`,
    title: "沧元图",
    nativeId: cr.nativeId,
    start: 1,
    end: 121,
    targetStart: 1,
    status: "pending",
    changeRequestId: cr.id,
    associationId: `change-request:${cr.id}`,
  };
  const media = makeMedia([injectedSelfSegment]);

  const preview = buildReviewCoveragePreview(cr, media);

  expect(preview.season).toBe(1);
  expect(preview.totalSeasonEpisodes).toBe(121);
  expect(preview.existingSegments).toEqual([]);
  expect(preview.otherPendingCount).toBe(0);
  expect(preview.afterSegments).toEqual([
    {
      id: `${cr.id}-0`,
      title: "沧元图",
      nativeId: "adaec02f09f9469ab8d8",
      start: 1,
      end: 121,
      targetStart: 1,
      status: "pending",
      changeRequestId: cr.id,
    },
  ]);
});

test("preserves non-linear season coverage in the proposed bar", () => {
  const cr = makeChangeRequest({
    segments: [{ season: 1, start: 1, end: null, targetStart: 1, nonLinear: true }],
  });
  const preview = buildReviewCoveragePreview(cr, makeMedia([]));
  expect(preview.existingSegments).toEqual([]);
  expect(preview.afterSegments).toMatchObject([{ start: 1, end: 121, nonLinear: true }]);
});

test("excludes other pending CRs and seeds from '现在' while reporting otherPendingCount", () => {
  const cr = makeChangeRequest();
  const confirmedSeg: CoverageSegment = {
    id: "assoc-confirmed-0",
    title: "part1",
    nativeId: "other1111111111111111",
    start: 1,
    end: 26,
    targetStart: 1,
    status: "confirmed",
    associationId: "assoc-confirmed",
  };
  const otherPendingSeg: CoverageSegment = {
    id: "change-request:other-cr-0",
    title: "other",
    nativeId: "other2222222222222222",
    start: 27,
    end: 52,
    targetStart: 1,
    status: "pending",
    changeRequestId: "other-cr",
    associationId: "change-request:other-cr",
  };
  const selfPendingSeg: CoverageSegment = {
    id: `change-request:${cr.id}-0`,
    title: "沧元图",
    nativeId: cr.nativeId,
    start: 53,
    end: 121,
    targetStart: 1,
    status: "pending",
    changeRequestId: cr.id,
    associationId: `change-request:${cr.id}`,
  };
  const media = makeMedia([confirmedSeg, otherPendingSeg, selfPendingSeg]);

  const preview = buildReviewCoveragePreview(
    makeChangeRequest({ segments: [{ season: 1, start: 53, end: 121, targetStart: 1 }] }),
    media,
  );

  expect(preview.existingSegments).toEqual([confirmedSeg]);
  expect(preview.otherPendingCount).toBe(1);
  expect(preview.afterSegments).toHaveLength(2);
  expect(preview.afterSegments[0]).toEqual(confirmedSeg);
  expect(preview.afterSegments[1]?.changeRequestId).toBe(cr.id);
});

test("finds existing confirmed coverage even when cr.mediaId is null at submission time", () => {
  const cr = makeChangeRequest({ mediaId: null });
  const confirmedSeg: CoverageSegment = {
    id: "assoc-1-0",
    title: "已有第1-20集",
    nativeId: "other-native-id",
    start: 1,
    end: 20,
    targetStart: 1,
    status: "confirmed",
    associationId: "assoc-1",
  };
  const media = makeMedia([confirmedSeg]);

  const preview = buildReviewCoveragePreview(cr, media);
  expect(preview.existingSegments).toEqual([confirmedSeg]);
  expect(preview.afterSegments).toHaveLength(2);
});

test("replaces replaced association or same-collection segments in '通过后'", () => {
  const cr = makeChangeRequest({
    replacesAssociationId: "assoc-old",
    nativeId: "newcollection00000001",
    segments: [{ season: 1, start: 1, end: 121, targetStart: 1 }],
  });
  const replacedSeg: CoverageSegment = {
    id: "assoc-old-0",
    title: "旧合集",
    nativeId: "oldcollection00000001",
    start: 1,
    end: 60,
    targetStart: 1,
    status: "confirmed",
    associationId: "assoc-old",
  };
  const keptSeg: CoverageSegment = {
    id: "assoc-keep-0",
    title: "保留合集",
    nativeId: "keepcollection0000001",
    start: 100,
    end: 121,
    targetStart: 1,
    status: "confirmed",
    associationId: "assoc-keep",
  };
  const media = makeMedia([replacedSeg, keptSeg]);

  const preview = buildReviewCoveragePreview(cr, media);
  expect(preview.existingSegments).toEqual([replacedSeg, keptSeg]);
  expect(preview.afterSegments.map((s) => s.nativeId)).toEqual([
    "newcollection00000001",
    "keepcollection0000001",
  ]);
});

test("handles movie whole-media change requests cleanly", () => {
  const cr = makeChangeRequest({
    segments: [],
    pageEpisodeCount: null,
  });
  const confirmedMovieSeg: CoverageSegment = {
    id: "assoc-movie-whole",
    title: "电影",
    nativeId: "adaec02f09f9469ab8d8",
    start: 1,
    end: 1,
    status: "confirmed",
    associationId: "assoc-movie",
  };
  const media = makeMedia([], {
    type: "movie",
    seasons: [],
    platformRows: [
      {
        id: "youku:v-1",
        namespace: "youku",
        label: "原声",
        isDefault: true,
        segmentsBySeason: { 0: [confirmedMovieSeg] },
        allSeasonSegments: [],
      },
    ],
  });

  const preview = buildReviewCoveragePreview(cr, media);
  expect(preview.isMovie).toBe(true);
  expect(preview.season).toBe(0);
  expect(preview.totalSeasonEpisodes).toBe(1);
  expect(preview.existingSegments).toEqual([confirmedMovieSeg]);
  expect(preview.afterSegments).toHaveLength(1);
  expect(preview.afterSegments[0]).toMatchObject({
    status: "pending",
    start: 1,
    end: 1,
    changeRequestId: cr.id,
  });
});
