import { proto, toProtoSegment, type Association, type MediaDocument } from "@media-ref/client";
import { expect, test } from "vite-plus/test";
import { changeRequestFromProto, mediaItemFrom } from "#/lib/mappers";
import { buildReviewCoveragePreview } from "#/lib/review-preview";
import type { ChangeRequestItem, CoverageSegment, MediaItem } from "#/lib/types";

function segment(season: number, episodeStart: number, episodeEnd: number) {
  return { season, episodeStart, episodeEnd, targetEpisodeStart: 1, baseline: "tmdb" as const };
}

const submitted: proto.ChangeRequest = {
  $typeName: "mediaref.v1.ChangeRequest",
  id: "ce7c82d3-e5f6-4d87-8fa8-dd692c59abe6",
  status: proto.ChangeRequestStatus.PENDING_EVIDENCE,
  mediaId: "m-1",
  namespace: "youku",
  nativeId: "adaec02f09f9469ab8d8",
  rawNativeId: "adaec02f09f9469ab8d8",
  evidence: { collection: { title: "沧元图", featureEpisodeCount: 121 } },
  variantDescription: "原声",
  setDefaultVariant: false,
  segments: [toProtoSegment(segment(1, 1, 121))],
  submitterType: proto.SubmitterType.HUMAN,
  submitterUserId: "69vU60Zc",
  createdAt: "2026-11-26T00:00:00.000Z",
  updatedAt: "2026-11-26T00:00:00.000Z",
};

function makeChangeRequest(overrides: Partial<ChangeRequestItem> = {}): ChangeRequestItem {
  return { ...changeRequestFromProto(submitted), ...overrides };
}

function makeMedia(segments: CoverageSegment[], overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    ...mappedMedia("tv", []),
    platformRows: [
      {
        id: "youku:v-1",
        variantId: "v-1",
        namespace: "youku",
        label: "原声",
        isDefault: true,
        segmentsBySeason: { 1: segments },
        allSeasonSegments: segments,
      },
    ],
    ...overrides,
  };
}

function mappedMedia(
  type: MediaDocument["media"]["type"],
  associations: Association[],
  variants: MediaDocument["variants"] = [],
) {
  return mediaItemFrom(
    "m-1",
    {
      media: {
        id: "m-1",
        type,
        baseline: "tmdb",
        snapshot: {
          title: "T",
          originalTitle: null,
          year: null,
          type,
          seasons:
            type === "movie"
              ? []
              : [
                  { season: 1, episodeCount: 121, airYear: null },
                  { season: 2, episodeCount: 12, airYear: null },
                  { season: 3, episodeCount: 0, airYear: null },
                ],
        },
      },
      externalIds: [],
      associations,
      variants,
    },
    null,
  )!;
}

test.each([
  ["movie", "douban", 0, 1],
  ["tv", "bangumi", 2, 12],
  ["tv", "douban", 3, 6],
] as const)("previews whole %s entries from the %s directory", (type, namespace, season, end) => {
  const live: Association = {
    id: "live",
    namespace,
    nativeId: "101",
    variantId: null,
    status: "confirmed",
    segments: [],
  };
  const segments = type === "movie" ? [] : [segment(season, 3, 6)];
  const cr = changeRequestFromProto({
    ...submitted,
    namespace,
    rawNativeId: "102",
    nativeId: "102",
    variantDescription: undefined,
    evidence: undefined,
    replacesAssociationId: live.id,
    segments: segments.map(toProtoSegment),
  });
  const pending: Association = {
    ...live,
    id: "change-request:other",
    nativeId: "103",
    unconfirmed: true,
    unconfirmedSource: "change_request",
    changeRequestId: "other",
  };
  const media = mappedMedia(type, [
    { ...live, id: "seed", nativeId: "105", status: "seed_unconfirmed" },
    live,
    { ...live, id: "removed", nativeId: "104", status: "delisted" },
    pending,
    { ...pending, id: "change-request:another", nativeId: "106", changeRequestId: "another" },
    {
      ...pending,
      id: `change-request:${cr.id}`,
      nativeId: cr.nativeId,
      changeRequestId: cr.id,
      segments,
    },
  ]);

  expect(buildReviewCoveragePreview(cr, media)).toMatchObject({
    season,
    existingSegments: [
      { associationId: "live", nativeId: "101", status: "confirmed", start: 1, end },
    ],
    otherPendingCount: 2,
    afterSegments: [{ nativeId: "102", status: "pending", changeRequestId: cr.id }],
  });
  const [row] = media.catalogRows;
  expect(row.wholeMediaLabel).toBe("整部 · 105");
  expect(row.segmentsBySeason?.[season]?.map((s) => s.nativeId) ?? []).toEqual(
    type === "movie" ? [] : ["102"],
  );
});

test("previews the submitted variant ID even when the description names another variant", () => {
  const original = {
    namespace: "bilibili",
    id: "10000000-0000-4000-8000-000000000001",
    label: "原声",
    isDefault: true,
  } as const;
  const dub = {
    ...original,
    id: "10000000-0000-4000-8000-000000000002",
    label: "中配",
    isDefault: false,
  };
  const live: Association = {
    namespace: "bilibili",
    id: "original",
    variantId: original.id,
    nativeId: "ss1",
    status: "confirmed",
    segments: [segment(1, 1, 1)],
  };
  const media = mappedMedia(
    "tv",
    [live, { ...live, id: "dub", variantId: dub.id, nativeId: "ss2" }],
    [original, dub],
  );
  const request = {
    ...submitted,
    namespace: "bilibili",
    nativeId: "ss3",
    rawNativeId: "ss3",
    segments: [toProtoSegment(segment(1, 2, 2))],
    variantDescription: original.label,
  };

  expect(
    buildReviewCoveragePreview(changeRequestFromProto({ ...request, variantId: dub.id }), media),
  ).toMatchObject({
    variantLabel: "中配",
    existingSegments: [{ nativeId: "ss2" }],
  });
  expect(buildReviewCoveragePreview(changeRequestFromProto(request), media)).toMatchObject({
    variantLabel: "原声",
    existingSegments: [{ nativeId: "ss1" }],
  });
});

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
  const cr = makeChangeRequest({ mediaId: null, targetKey: "tmdb:tv:1001" });
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
        variantId: "v-1",
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
