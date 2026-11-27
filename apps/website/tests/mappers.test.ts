import { proto, type MediaDocument } from "@media-ref/client";
import { expect, test } from "vite-plus/test";
import {
  apiKeyFromProto,
  changeRequestFromGetResponse,
  changeRequestFromProto,
  commentContent,
  commentThreadFrom,
  explorationFromProto,
  explorationResultText,
  mediaItemFrom,
  usageBarHeights,
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

test.each([
  [
    "bilibili",
    "ss38221",
    "https://example.invalid/page",
    "https://www.bilibili.com/bangumi/play/ss38221",
  ],
  [
    "bilibili",
    "ss38221",
    "https://www.bilibili.com/bangumi/play/ss9",
    "https://www.bilibili.com/bangumi/play/ss38221",
  ],
  ["tencent", "https://example.invalid/unrecognized", "https://example.invalid/unrecognized", null],
  ["tvdb", "episode:123", "123", "https://thetvdb.com/dereferrer/episode/123"],
  ["tvdb", "series:123", "123", "https://thetvdb.com/dereferrer/series/123"],
  ["tvdb", "series:123", "https://thetvdb.com/dereferrer/episode/123", null],
  ["tvdb", "123", "123", null],
  ["tvdb", "123", "https://thetvdb.com/dereferrer/episode/456", null],
  ["tvdb", "123", "https://thetvdb.com/series/123", null],
  ["tvdb", "123", "https://example.invalid/dereferrer/episode/123", null],
  ["tvdb", "123", "http://thetvdb.com/dereferrer/episode/123", null],
  [
    "iqiyi",
    "5328486914190101",
    "https://www.iqiyi.com/v_xkt6z3z798.html",
    "https://www.iqiyi.com/a_1fkgtbddd2x.html",
  ],
  [
    "iqiyi",
    "923452300",
    "https://www.iqiyi.com/v_19rrfe142o.html",
    "https://www.iqiyi.com/v_19rrfe142o.html",
  ],
] as const)(
  "maps stored %s ID %s and input %s without trusting the raw URL",
  (namespace, nativeId, rawNativeId, href) => {
    const cr = reviewedCr({ namespace, nativeId, rawNativeId });
    const expected = href ? { source: "entry", href } : null;
    expect(changeRequestFromProto(cr).pageLink).toEqual(expected);
    expect(
      changeRequestFromGetResponse({ changeRequest: cr } as proto.GetChangeRequestResponse)
        ?.pageLink,
    ).toEqual(expected);
  },
);

test.each([
  ["https://www.thetvdb.com/series/sample/episodes/123?lang=en#title", "episode"],
  ["https://thetvdb.com/dereferrer/series/123?lang=en", "series"],
  ["https://thetvdb.com/dereferrer/episode/123", "episode"],
])(
  "an explicit TVDB entry matching a bare ID is only a submitted link: %s",
  (rawNativeId, kind) => {
    const cr = changeRequestFromProto(
      reviewedCr({ namespace: "tvdb", nativeId: "123", rawNativeId }),
    );
    expect(cr.nativeId).toBe("123");
    expect(cr.pageLink).toEqual({
      source: "submission",
      href: `https://thetvdb.com/dereferrer/${kind}/123`,
    });
  },
);

test("a legacy TVDB URL cannot override evidence for the entry or borrow a type from its parent media", () => {
  const entry = {
    namespace: "tvdb",
    nativeId: "123",
    rawNativeId: "https://thetvdb.com/dereferrer/episode/123",
  };
  const collection = { namespace: "tvdb", canonicalId: "123", mediaType: "movie" };
  expect(
    changeRequestFromProto(reviewedCr({ ...entry, evidence: { collection } })).pageLink,
  ).toBeNull();
  expect(
    changeRequestFromProto(
      reviewedCr({ ...entry, rawNativeId: "123", evidence: { catalog: collection } }),
    ).pageLink,
  ).toBeNull();
  expect(
    changeRequestFromProto(
      reviewedCr({
        ...entry,
        rawNativeId: "123",
        evidence: { collection: { ...collection, mediaType: "tv" } },
      }),
    ).pageLink,
  ).toBeNull();
});

test("only the upstream-resolved episode for this iQiyi collection replaces its canonical album link", () => {
  const nativeId = "5328486914190101";
  const resolvedPage = { namespace: "iqiyi", nativeId, kind: "video_page", id: "xkt6z3z798" };
  const cr = { namespace: "iqiyi", nativeId, rawNativeId: "https://example.invalid/page" };
  const display = (proof: typeof resolvedPage) =>
    changeRequestFromProto(reviewedCr({ ...cr, evidence: { resolvedPage: proof } })).pageLink;
  expect(display(resolvedPage)).toEqual({
    source: "entry",
    href: "https://www.iqiyi.com/v_xkt6z3z798.html",
  });
  expect(display({ ...resolvedPage, nativeId: "923452300" })).toEqual({
    source: "entry",
    href: "https://www.iqiyi.com/a_1fkgtbddd2x.html",
  });
});

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

test("a rejected change request carries the other request its collection went live through", () => {
  const cr = changeRequestFromGetResponse({
    changeRequest: reviewedCr({ status: proto.ChangeRequestStatus.REJECTED }),
    liveChangeRequestId: "cr-live",
  } as unknown as Parameters<typeof changeRequestFromGetResponse>[0]);

  expect(cr?.status).toBe("rejected");
  expect(cr?.liveChangeRequestId).toBe("cr-live");
  expect(
    changeRequestFromGetResponse({
      changeRequest: reviewedCr({ status: proto.ChangeRequestStatus.REJECTED }),
    } as unknown as Parameters<typeof changeRequestFromGetResponse>[0])?.liveChangeRequestId,
  ).toBeNull();
});

test("maps API key summaries with lastUsedAt from GetApiUsage", () => {
  const lastUsed = new Map([["key-1", "2026-11-27T08:00:00.000Z"]]);
  const key = (overrides: Record<string, unknown>) =>
    ({
      id: "key-1",
      name: "Danmu Universal",
      prefix: "mref_",
      start: "mref_pnHVRf",
      enabled: true,
      canSubmit: true,
      createdAt: "2026-11-26T10:00:00.000Z",
      ...overrides,
    }) as unknown as proto.ApiKeySummary;

  expect(apiKeyFromProto(key({}), lastUsed)).toEqual({
    id: "key-1",
    name: "Danmu Universal",
    prefix: "mref_pnHVRf••••",
    canSubmit: true,
    createdAt: "2026-11-26T10:00:00.000Z",
    expiresAt: null,
    lastUsedAt: "2026-11-27T08:00:00.000Z",
  });
  expect(apiKeyFromProto(key({ id: "key-2", name: undefined }), lastUsed)).toMatchObject({
    id: "key-2",
    name: "未命名密钥",
    lastUsedAt: null,
  });
});

test("keeps a visible sliver for small non-zero chart segments without overflowing 100%", () => {
  expect(usageBarHeights({ found: 0, notFound: 0, submitted: 0 }, 10)).toEqual({
    foundPct: 0,
    notFoundPct: 0,
    submitPct: 0,
  });

  const small = usageBarHeights({ found: 1, notFound: 1, submitted: 1 }, 1000);
  expect(small).toEqual({ foundPct: 1.5, notFoundPct: 1.5, submitPct: 1.5 });

  const maxed = usageBarHeights({ found: 998, notFound: 1, submitted: 1 }, 1000);
  expect(maxed.notFoundPct).toBe(1.5);
  expect(maxed.submitPct).toBe(1.5);
  expect(maxed.foundPct + maxed.notFoundPct + maxed.submitPct).toBeCloseTo(100, 6);
});

test("catalogRows merges authority externalIds (tmdb, tvdb, imdb, trakt) with catalog associations in CATALOG_ORDER", () => {
  const movieDoc = {
    media: {
      id: "m-avengers",
      type: "movie",
      baseline: "tmdb",
      snapshot: { title: "复仇者联盟", originalTitle: "The Avengers", year: 2012, seasons: [] },
    },
    variants: [],
    externalIds: [
      { namespace: "trakt", nativeId: "movie:727" },
      { namespace: "imdb", nativeId: "tt0848228" },
      { namespace: "tmdb", nativeId: "movie:24428" },
    ],
    associations: [
      {
        id: "assoc-douban",
        namespace: "douban",
        nativeId: "1866479",
        title: "复仇者联盟",
        segments: [],
        status: "confirmed",
      },
    ],
  } as unknown as MediaDocument;

  const movieItem = mediaItemFrom("tmdb:movie:24428", movieDoc, null)!;
  expect(movieItem.catalogRows).toEqual([
    {
      id: "catalog:tmdb",
      namespace: "tmdb",
      isBaseline: true,
      roleLabel: "基准",
      wholeMediaNativeId: "movie:24428",
      wholeMediaLabel: "整部 · movie:24428",
    },
    {
      id: "catalog:imdb",
      namespace: "imdb",
      isBaseline: false,
      roleLabel: "1 个条目",
      wholeMediaNativeId: "tt0848228",
      wholeMediaLabel: "整部 · tt0848228",
      note: "IMDb 没有季编号，只有整部和单集（单集暂不收录）",
    },
    {
      id: "catalog:trakt",
      namespace: "trakt",
      isBaseline: false,
      roleLabel: "1 个条目",
      wholeMediaNativeId: "movie:727",
      wholeMediaLabel: "整部 · movie:727",
    },
    {
      id: "catalog:douban",
      namespace: "douban",
      isBaseline: false,
      roleLabel: "1 个条目",
      wholeMediaNativeId: "1866479",
      wholeMediaLabel: "整部 · 复仇者联盟",
    },
  ]);

  const withPending = {
    ...movieDoc,
    associations: [
      ...movieDoc.associations,
      {
        id: "change-request:cr-imdb",
        namespace: "imdb",
        nativeId: "tt0000001",
        variantId: null,
        status: "confirmed",
        unconfirmed: true,
        changeRequestId: "cr-imdb",
        segments: [],
      },
    ],
  } as unknown as MediaDocument;
  expect(
    mediaItemFrom("m-avengers", withPending, null)!.catalogRows.find((r) => r.namespace === "imdb"),
  ).toMatchObject({
    wholeMediaNativeId: "tt0848228",
    roleLabel: "2 个条目",
  });

  const tvDoc = {
    media: {
      id: "m-aot",
      type: "tv",
      baseline: "tmdb",
      snapshot: {
        title: "进击的巨人",
        originalTitle: "進撃の巨人",
        year: 2013,
        seasons: [
          { season: 1, episodeCount: 25 },
          { season: 2, episodeCount: 12 },
        ],
      },
    },
    variants: [],
    externalIds: [
      { namespace: "tmdb", nativeId: "tv:1429" },
      { namespace: "tvdb", nativeId: "267440" },
      { namespace: "imdb", nativeId: "tt2560140" },
      { namespace: "trakt", nativeId: "show:1417" },
    ],
    associations: [
      {
        id: "assoc-imdb-ep",
        namespace: "imdb",
        nativeId: "tt2822876",
        status: "confirmed",
        segments: [
          { season: 1, episodeStart: 1, episodeEnd: 1, targetEpisodeStart: 1, baseline: "tmdb" },
        ],
      },
      {
        id: "assoc-douban-s1",
        namespace: "douban",
        nativeId: "26647087",
        status: "confirmed",
        segments: [
          { season: 1, episodeStart: 1, episodeEnd: 25, targetEpisodeStart: 1, baseline: "tmdb" },
        ],
      },
      {
        id: "assoc-bgm-delisted",
        namespace: "bangumi",
        nativeId: "55770",
        status: "delisted",
        segments: [],
      },
    ],
  } as unknown as MediaDocument;

  const tvItem = mediaItemFrom("tmdb:tv:1429", tvDoc, null)!;
  expect(tvItem.catalogRows.map((r) => r.namespace)).toEqual([
    "tmdb",
    "tvdb",
    "imdb",
    "trakt",
    "douban",
  ]);
  expect(tvItem.catalogRows[2]).toMatchObject({
    namespace: "imdb",
    roleLabel: "整部 + 季",
    wholeMediaNativeId: "tt2560140",
    wholeMediaLabel: "整部 · tt2560140",
    note: "IMDb 没有季编号，只有整部和单集（单集暂不收录）",
  });
  expect(tvItem.catalogRows[2]?.segmentsBySeason?.[1]).toHaveLength(1);
});

test("exploration activity maps covered platforms and formats unambiguous summary text", () => {
  const mapped = explorationFromProto({
    id: "job-1",
    card: {
      key: "tmdb:movie:24428",
      mediaId: "m1",
      type: 1,
      title: "复仇者联盟",
      year: 2012,
      platforms: [],
    },
    startedAt: "2026-11-27T08:00:00.000Z",
    finishedAt: "2026-11-27T08:01:00.000Z",
    platforms: [
      {
        namespace: "iqiyi",
        status: "covered",
        reason: "此前提交时库里已有收录，当前已在库中生效",
        changeRequestId: "cr-rejected",
        liveChangeRequestId: "cr-live",
      },
      {
        namespace: "youku",
        status: "covered",
        reason: "此前已在库中收录",
      },
      {
        namespace: "bilibili",
        status: "covered",
        reason: "此前已在库中收录",
      },
      {
        namespace: "mgtv",
        status: "not_found",
        reason: "找到的合集都不是这部作品",
      },
      {
        namespace: "tencent",
        status: "approved",
        changeRequestId: "cr-tencent",
      },
    ],
  } as unknown as Parameters<typeof explorationFromProto>[0])!;

  expect(mapped.platforms[0]).toMatchObject({
    namespace: "iqiyi",
    status: "covered",
    changeRequestId: "cr-rejected",
    liveChangeRequestId: "cr-live",
  });

  const labels: Record<string, string> = {
    iqiyi: "爱奇艺",
    youku: "优酷",
    bilibili: "哔哩哔哩",
    mgtv: "芒果 TV",
    tencent: "腾讯视频",
  };
  expect(explorationResultText(mapped, (ns) => labels[ns] ?? ns)).toBe(
    "找到腾讯视频上的正片，已生效；爱奇艺、优酷、哔哩哔哩在库中已收录",
  );
});
