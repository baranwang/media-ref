import { describe, expect, test } from "vite-plus/test";
import {
  DEFAULT_BASE_URL,
  MAX_BATCH_MEDIA_KEYS,
  MediaRefApiError,
  createMediaRefClient,
  resolveEpisode,
  type BatchMediaItemResult,
  type BatchMediaResponse,
  type ExternalKey,
  type FetchLike,
  type GetMediaResponse,
  type MediaDocument,
  type ReportLeadResponse,
} from "../src/index.ts";

function createJujutsuKaisenDoc(): MediaDocument {
  return {
    media: {
      id: "00000000-0000-4000-8000-000000000001",
      type: "tv",
      baseline: "tmdb",
      snapshot: {
        title: "咒术回战",
        originalTitle: "呪術廻戦",
        year: 2020,
        type: "tv",
        seasons: [{ season: 1, episodeCount: 47, airYear: 2020 }],
      },
    },
    externalIds: [{ namespace: "tmdb", nativeId: "tv:95479" }],
    variants: [
      {
        id: "var-bili-orig",
        mediaId: "00000000-0000-4000-8000-000000000001",
        namespace: "bilibili",
        label: "原声",
        isDefault: true,
      },
    ],
    associations: [
      {
        id: "assoc-ss34430",
        mediaId: "00000000-0000-4000-8000-000000000001",
        namespace: "bilibili",
        nativeId: "ss34430",
        variantId: "var-bili-orig",
        status: "confirmed",
        segments: [
          {
            season: 1,
            episodeStart: 1,
            episodeEnd: 24,
            targetEpisodeStart: 1,
            baseline: "tmdb",
          },
        ],
      },
      {
        id: "assoc-ss45574",
        mediaId: "00000000-0000-4000-8000-000000000001",
        namespace: "bilibili",
        nativeId: "ss45574",
        variantId: "var-bili-orig",
        status: "confirmed",
        segments: [
          {
            season: 1,
            episodeStart: 25,
            episodeEnd: 47,
            targetEpisodeStart: 1,
            baseline: "tmdb",
          },
        ],
      },
    ],
    matchedAssociationIds: [],
    platformStatuses: {
      tencent: { status: "unchecked" },
      iqiyi: { status: "unchecked" },
      youku: { status: "unchecked" },
      bilibili: { status: "associated" },
      mgtv: { status: "unchecked" },
    },
  };
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    statusText: init?.statusText,
    headers,
  });
}

function parseJsonBody<T>(init?: RequestInit): T {
  expect(typeof init?.body).toBe("string");
  return JSON.parse(init?.body as string) as T;
}

describe("createMediaRefClient — getMedia", () => {
  test("queries by external key and feeds typed MediaDocument into resolveEpisode (S1E30 -> ss45574 ep 6)", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const doc = createJujutsuKaisenDoc();
    const payload: GetMediaResponse = {
      key: "tmdb:tv:95479",
      document: doc,
      matchedAssociationId: null,
      items: [{ document: doc, matchedAssociationId: null }],
    };

    const fakeFetch: FetchLike = async (url, init) => {
      requests.push({ url, init });
      return jsonResponse(payload);
    };

    const client = createMediaRefClient({
      apiKey: "mref_test_key_123",
      fetch: fakeFetch,
    });

    const response = await client.getMedia("tmdb:tv:95479");
    expect(response).not.toBeNull();
    expect(response?.key).toBe("tmdb:tv:95479");
    expect(response?.matchedAssociationId).toBeNull();
    expect(response?.items).toHaveLength(1);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${DEFAULT_BASE_URL}/v1/media/tmdb%3Atv%3A95479`);
    expect(requests[0]?.init?.method).toBe("GET");
    const sentHeaders = new Headers(requests[0]?.init?.headers);
    expect(sentHeaders.get("X-API-Key")).toBe("mref_test_key_123");

    const resolved = resolveEpisode(response!.document, {
      namespace: "bilibili",
      season: 1,
      episode: 30,
    });
    expect(resolved).toEqual({
      kind: "mapped",
      associationId: "assoc-ss45574",
      namespace: "bilibili",
      nativeId: "ss45574",
      variantId: "var-bili-orig",
      targetEpisode: 6,
      segment: doc.associations[1]!.segments[0],
    });
  });

  test("accepts ExternalKey object, normalizes trailing slashes on baseUrl, and returns null on 404", async () => {
    const requests: string[] = [];
    const fakeFetch: FetchLike = async (url) => {
      requests.push(url);
      return jsonResponse(
        { error: "MEDIA_NOT_FOUND", message: "Media not found" },
        { status: 404 },
      );
    };

    const client = createMediaRefClient({
      apiKey: "mref_test_key_123",
      baseUrl: "https://custom.mediaref.example/api///",
      fetch: fakeFetch,
    });

    const key: ExternalKey = { namespace: "douban", nativeId: "1292052" };
    const result = await client.getMedia(key);
    expect(result).toBeNull();
    expect(requests).toEqual(["https://custom.mediaref.example/api/v1/media/douban%3A1292052"]);
  });

  test("serializes includeUnconfirmed, season, and namespaceGroup query params", async () => {
    const requestedUrls: string[] = [];
    const doc = createJujutsuKaisenDoc();
    const fakeFetch: FetchLike = async (url) => {
      requestedUrls.push(url);
      return jsonResponse({
        key: "tmdb:tv:95479",
        document: doc,
        matchedAssociationId: null,
        items: [{ document: doc, matchedAssociationId: null }],
      });
    };

    const client = createMediaRefClient({ apiKey: "mref_key", fetch: fakeFetch });

    await client.getMedia("tmdb:tv:95479", {
      includeUnconfirmed: true,
      season: 1,
      namespaceGroup: "platform",
    });

    await client.getMedia("tmdb:tv:95479", {
      season: 0,
      namespaceGroup: "catalog",
    });

    expect(requestedUrls).toHaveLength(2);
    const first = new URL(requestedUrls[0]!);
    expect(first.pathname).toBe("/v1/media/tmdb%3Atv%3A95479");
    expect(first.searchParams.get("includeUnconfirmed")).toBe("true");
    expect(first.searchParams.get("season")).toBe("1");
    expect(first.searchParams.get("namespaceGroup")).toBe("platform");

    const second = new URL(requestedUrls[1]!);
    expect(second.searchParams.has("includeUnconfirmed")).toBe(false);
    expect(second.searchParams.get("season")).toBe("0");
    expect(second.searchParams.get("namespaceGroup")).toBe("catalog");
  });

  test("rejects negative or non-integer season values locally", async () => {
    const fakeFetch: FetchLike = async () => jsonResponse({});
    const client = createMediaRefClient({ apiKey: "mref_key", fetch: fakeFetch });

    await expect(client.getMedia("tmdb:tv:95479", { season: -1 })).rejects.toThrow(RangeError);
    await expect(client.getMedia("tmdb:tv:95479", { season: 1.5 })).rejects.toThrow(RangeError);
  });

  test("throws typed MediaRefApiError on 401, 403, 429 (parsing Retry-After), and 5xx", async () => {
    const responses: Response[] = [
      jsonResponse({ error: "INVALID_API_KEY", message: "Invalid API key" }, { status: 401 }),
      jsonResponse(
        { error: "INSUFFICIENT_PERMISSIONS", message: "API key does not have required permission" },
        { status: 403 },
      ),
      jsonResponse(
        {
          error: "RATE_LIMITED",
          scope: "api_key",
          retryAfterSeconds: 60,
          message: "API key read rate limit exceeded; retry after 45s",
        },
        { status: 429, headers: { "Retry-After": "45" } },
      ),
      jsonResponse(
        { error: "RATE_LIMITED", message: "Too many requests" },
        {
          status: 429,
          headers: { "Retry-After": new Date(Date.now() + 30_000).toUTCString() },
        },
      ),
      new Response("Bad Gateway", {
        status: 502,
        statusText: "Bad Gateway",
        headers: { "content-type": "text/plain" },
      }),
    ];

    let index = 0;
    const fakeFetch: FetchLike = async () => responses[index++]!;
    const client = createMediaRefClient({ apiKey: "mref_key", fetch: fakeFetch });

    // 401
    try {
      await client.getMedia("tmdb:tv:95479");
      expect.unreachable("expected 401 error");
    } catch (error) {
      expect(error).toBeInstanceOf(MediaRefApiError);
      const apiErr = error as MediaRefApiError;
      expect(apiErr.status).toBe(401);
      expect(apiErr.code).toBe("INVALID_API_KEY");
      expect(apiErr.message).toBe("Invalid API key");
      expect(apiErr.retryAfterSeconds).toBeUndefined();
    }

    // 403
    try {
      await client.getMedia("tmdb:tv:95479");
      expect.unreachable("expected 403 error");
    } catch (error) {
      expect(error).toBeInstanceOf(MediaRefApiError);
      const apiErr = error as MediaRefApiError;
      expect(apiErr.status).toBe(403);
      expect(apiErr.code).toBe("INSUFFICIENT_PERMISSIONS");
      expect(apiErr.message).toBe("API key does not have required permission");
    }

    // 429 with numeric Retry-After header (takes precedence)
    try {
      await client.getMedia("tmdb:tv:95479");
      expect.unreachable("expected 429 error");
    } catch (error) {
      expect(error).toBeInstanceOf(MediaRefApiError);
      const apiErr = error as MediaRefApiError;
      expect(apiErr.status).toBe(429);
      expect(apiErr.code).toBe("RATE_LIMITED");
      expect(apiErr.retryAfterSeconds).toBe(45);
    }

    // 429 with HTTP-date Retry-After header
    try {
      await client.getMedia("tmdb:tv:95479");
      expect.unreachable("expected 429 HTTP-date error");
    } catch (error) {
      expect(error).toBeInstanceOf(MediaRefApiError);
      const apiErr = error as MediaRefApiError;
      expect(apiErr.status).toBe(429);
      expect(apiErr.code).toBe("RATE_LIMITED");
      expect(apiErr.retryAfterSeconds).toBeGreaterThanOrEqual(28);
      expect(apiErr.retryAfterSeconds).toBeLessThanOrEqual(32);
    }

    // 502 non-JSON response
    try {
      await client.getMedia("tmdb:tv:95479");
      expect.unreachable("expected 502 error");
    } catch (error) {
      expect(error).toBeInstanceOf(MediaRefApiError);
      const apiErr = error as MediaRefApiError;
      expect(apiErr.status).toBe(502);
      expect(apiErr.code).toBe("HTTP_ERROR");
      expect(apiErr.message).toContain("502");
      expect(apiErr.retryAfterSeconds).toBeUndefined();
    }
  });

  test("falls back to JSON retryAfterSeconds on 429 when Retry-After header is absent and forwards AbortSignal", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;

    const fakeFetch: FetchLike = async (_url, init) => {
      receivedSignal = init?.signal;
      return jsonResponse(
        {
          error: "RATE_LIMITED",
          retryAfterSeconds: 60,
          message: "Rate limit exceeded",
        },
        { status: 429 },
      );
    };

    const client = createMediaRefClient({ apiKey: "mref_key", fetch: fakeFetch });

    try {
      await client.getMedia("tmdb:tv:95479", { signal: controller.signal });
      expect.unreachable("expected 429 error");
    } catch (error) {
      expect(error).toBeInstanceOf(MediaRefApiError);
      const apiErr = error as MediaRefApiError;
      expect(apiErr.status).toBe(429);
      expect(apiErr.code).toBe("RATE_LIMITED");
      expect(apiErr.retryAfterSeconds).toBe(60);
    }

    expect(receivedSignal).toBe(controller.signal);
  });
});

describe("createMediaRefClient — getMediaBatch", () => {
  test("queries a single batch <= 100 keys, sends options, and preserves per-key ok:false errors", async () => {
    const doc = createJujutsuKaisenDoc();
    const sentBodies: Array<Record<string, unknown>> = [];
    const sentUrls: string[] = [];

    const fakeFetch: FetchLike = async (url, init) => {
      sentUrls.push(url);
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("X-API-Key")).toBe("mref_batch_key");
      expect(headers.get("Content-Type")).toBe("application/json");
      const body = parseJsonBody<Record<string, unknown>>(init);
      sentBodies.push(body);

      const response: BatchMediaResponse = {
        results: [
          {
            key: "tmdb:tv:95479",
            ok: true,
            items: [{ document: doc, matchedAssociationId: null }],
          },
          {
            key: "douban:99999999",
            ok: false,
            error: "NOT_FOUND",
            message: "Media not found",
          },
          {
            key: "not-a-valid-key",
            ok: false,
            error: "INVALID_KEY",
            message: "Key must be a valid media UUID or external key (e.g. tmdb:tv:95479)",
          },
        ],
      };
      return jsonResponse(response);
    };

    const client = createMediaRefClient({ apiKey: "mref_batch_key", fetch: fakeFetch });

    const batch = await client.getMediaBatch(
      ["tmdb:tv:95479", { namespace: "douban", nativeId: "99999999" }, "not-a-valid-key"],
      { includeUnconfirmed: true, season: 1, namespaceGroup: "platform" },
    );

    expect(sentUrls).toEqual([`${DEFAULT_BASE_URL}/v1/media/batch`]);
    expect(sentBodies).toEqual([
      {
        keys: ["tmdb:tv:95479", "douban:99999999", "not-a-valid-key"],
        includeUnconfirmed: true,
        season: 1,
        namespaceGroup: "platform",
      },
    ]);

    expect(batch.results).toHaveLength(3);
    expect(batch.results[0]?.ok).toBe(true);
    if (batch.results[0]?.ok) {
      expect(batch.results[0].items[0]?.document.media.snapshot.title).toBe("咒术回战");
    }
    expect(batch.results[1]).toEqual({
      key: "douban:99999999",
      ok: false,
      error: "NOT_FOUND",
      message: "Media not found",
    });
    expect(batch.results[2]).toEqual({
      key: "not-a-valid-key",
      ok: false,
      error: "INVALID_KEY",
      message: "Key must be a valid media UUID or external key (e.g. tmdb:tv:95479)",
    });
  });

  test("auto-chunks 150 keys into two POST /v1/media/batch calls (100 + 50) preserving exact order", async () => {
    expect(MAX_BATCH_MEDIA_KEYS).toBe(100);
    const doc = createJujutsuKaisenDoc();
    const chunkSizes: number[] = [];

    const fakeFetch: FetchLike = async (_url, init) => {
      const body = parseJsonBody<{ keys: string[] }>(init);
      chunkSizes.push(body.keys.length);
      const results: BatchMediaItemResult[] = body.keys.map((key, idx) =>
        idx % 10 === 0
          ? { key, ok: false, error: "NOT_FOUND", message: "Media not found" }
          : { key, ok: true, items: [{ document: doc, matchedAssociationId: null }] },
      );
      return jsonResponse({ results });
    };

    const keys = Array.from({ length: 150 }, (_, i) => `tmdb:tv:${1000 + i}`);
    const client = createMediaRefClient({ apiKey: "mref_batch_key", fetch: fakeFetch });

    const batch = await client.getMediaBatch(keys);

    expect(chunkSizes).toEqual([100, 50]);
    expect(batch.results).toHaveLength(150);
    expect(batch.results.map((r) => r.key)).toEqual(keys);
    expect(batch.results[0]?.ok).toBe(false);
    expect(batch.results[1]?.ok).toBe(true);
    expect(batch.results[100]?.ok).toBe(false);
    expect(batch.results[149]?.ok).toBe(true);
  });

  test("returns empty results without HTTP calls for empty input and rejects >100 when autoChunk is false", async () => {
    let fetchCalls = 0;
    const fakeFetch: FetchLike = async () => {
      fetchCalls += 1;
      return jsonResponse({ results: [] });
    };

    const client = createMediaRefClient({ apiKey: "mref_batch_key", fetch: fakeFetch });

    expect(await client.getMediaBatch([])).toEqual({ results: [] });
    expect(fetchCalls).toBe(0);

    const keys = Array.from({ length: 101 }, (_, i) => `tmdb:tv:${i + 1}`);
    await expect(client.getMediaBatch(keys, { autoChunk: false })).rejects.toThrow(RangeError);
    expect(fetchCalls).toBe(0);
  });

  test("throws MediaRefApiError when a batch chunk fails with HTTP error", async () => {
    const fakeFetch: FetchLike = async () =>
      jsonResponse(
        { error: "RATE_LIMITED", message: "Too many batch requests" },
        { status: 429, headers: { "Retry-After": "12" } },
      );

    const client = createMediaRefClient({ apiKey: "mref_batch_key", fetch: fakeFetch });

    try {
      await client.getMediaBatch(["tmdb:tv:95479"]);
      expect.unreachable("expected batch 429 error");
    } catch (error) {
      expect(error).toBeInstanceOf(MediaRefApiError);
      const apiErr = error as MediaRefApiError;
      expect(apiErr.status).toBe(429);
      expect(apiErr.code).toBe("RATE_LIMITED");
      expect(apiErr.retryAfterSeconds).toBe(12);
    }
  });
});

describe("createMediaRefClient — resolveFromKey and reportLead", () => {
  test("resolveFromKey combines getMedia + resolveEpisode with full typing and forwards query params", async () => {
    const doc = createJujutsuKaisenDoc();
    const requestedUrls: string[] = [];

    const fakeFetch: FetchLike = async (url) => {
      requestedUrls.push(url);
      if (url.includes("9999999")) {
        return jsonResponse(
          { error: "MEDIA_NOT_FOUND", message: "Media not found" },
          { status: 404 },
        );
      }
      return jsonResponse({
        key: "tmdb:tv:95479",
        document: doc,
        matchedAssociationId: null,
        items: [{ document: doc, matchedAssociationId: null }],
      });
    };

    const client = createMediaRefClient({ apiKey: "mref_key", fetch: fakeFetch });

    const mapped = await client.resolveFromKey("tmdb:tv:95479", {
      namespace: "bilibili",
      season: 1,
      episode: 30,
    });

    expect(mapped.kind).toBe("mapped");
    if (mapped.kind === "mapped") {
      expect(mapped.nativeId).toBe("ss45574");
      expect(mapped.targetEpisode).toBe(6);
      expect(mapped.media.document.media.snapshot.title).toBe("咒术回战");
    }

    const firstUrl = new URL(requestedUrls[0]!);
    expect(firstUrl.searchParams.get("season")).toBe("1");
    expect(firstUrl.searchParams.get("namespaceGroup")).toBe("platform");

    const missing = await client.resolveFromKey(
      { namespace: "tmdb", nativeId: "tv:9999999" },
      { namespace: "douban", season: 1, episode: 1, includeUnconfirmed: true },
    );
    expect(missing).toEqual({
      kind: "not_found",
      key: "tmdb:tv:9999999",
    });

    const secondUrl = new URL(requestedUrls[1]!);
    expect(secondUrl.searchParams.get("includeUnconfirmed")).toBe("true");
    expect(secondUrl.searchParams.get("season")).toBe("1");
    expect(secondUrl.searchParams.get("namespaceGroup")).toBe("catalog");
  });

  test("resolveFromKey forwards options.includeUnconfirmed to resolveEpisode and preserves unmapped results", async () => {
    const baseDoc = createJujutsuKaisenDoc();
    const doc: MediaDocument = {
      ...baseDoc,
      associations: [
        ...baseDoc.associations,
        {
          id: "assoc-seed-douban",
          mediaId: baseDoc.media.id,
          namespace: "douban",
          nativeId: "34908023",
          variantId: null,
          status: "seed_unconfirmed",
          unconfirmed: true,
          unconfirmedSource: "seed_unconfirmed",
          segments: [],
        },
      ],
    };

    const fakeFetch: FetchLike = async () =>
      jsonResponse({
        key: "tmdb:tv:95479",
        document: doc,
        matchedAssociationId: null,
        items: [{ document: doc, matchedAssociationId: null }],
      });

    const client = createMediaRefClient({ apiKey: "mref_key", fetch: fakeFetch });

    const unconfirmedResult = await client.resolveFromKey(
      "tmdb:tv:95479",
      { namespace: "douban" },
      { includeUnconfirmed: true },
    );
    expect(unconfirmedResult.kind).toBe("collection_only");
    if (unconfirmedResult.kind === "collection_only") {
      expect(unconfirmedResult.nativeId).toBe("34908023");
      expect(unconfirmedResult.reason).toBe("whole_media");
    }

    const unmappedResult = await client.resolveFromKey("tmdb:tv:95479", {
      namespace: "tencent",
      season: 1,
      episode: 1,
    });
    expect(unmappedResult.kind).toBe("unmapped");
    if (unmappedResult.kind === "unmapped") {
      expect(unmappedResult.reason).toBe("no_variant");
      expect(unmappedResult.media.key).toBe("tmdb:tv:95479");
    }
  });

  test("reportLead posts to /v1/leads and returns typed LeadRecord", async () => {
    const requests: Array<{ url: string; method?: string; body?: unknown; apiKey: string | null }> =
      [];

    const fakeFetch: FetchLike = async (url, init) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url,
        method: init?.method,
        body: init?.body !== undefined ? parseJsonBody<unknown>(init) : undefined,
        apiKey: headers.get("X-API-Key"),
      });

      const response: ReportLeadResponse = {
        lead: {
          id: "lead-1",
          targetExternalKey: "tmdb:tv:95479",
          namespace: "bilibili",
          nativeId: "ss45574",
          season: 1,
          variantDescription: "原声",
          notes: "Season 1 part 2",
          createdAt: "2026-11-23T12:00:00.000Z",
        },
      };
      return jsonResponse(response, { status: 201 });
    };

    const client = createMediaRefClient({ apiKey: "mref_report_key", fetch: fakeFetch });

    const res = await client.reportLead({
      targetExternalKey: { namespace: "tmdb", nativeId: "tv:95479" },
      namespace: "bilibili",
      nativeId: "ss45574",
      season: 1,
      variantDescription: "原声",
      notes: "Season 1 part 2",
    });

    expect(res.lead.id).toBe("lead-1");
    expect(res.lead.targetExternalKey).toBe("tmdb:tv:95479");
    expect(res.lead.namespace).toBe("bilibili");
    expect(res.lead.nativeId).toBe("ss45574");
    expect(res.lead.season).toBe(1);
    expect(res.lead.createdAt).toBe("2026-11-23T12:00:00.000Z");

    expect(requests).toEqual([
      {
        url: `${DEFAULT_BASE_URL}/v1/leads`,
        method: "POST",
        apiKey: "mref_report_key",
        body: {
          targetExternalKey: "tmdb:tv:95479",
          namespace: "bilibili",
          nativeId: "ss45574",
          season: 1,
          variantDescription: "原声",
          notes: "Season 1 part 2",
        },
      },
    ]);
  });

  test("validates client options and empty lookup keys", async () => {
    const fakeFetch: FetchLike = async () => jsonResponse({});
    expect(() => createMediaRefClient({ apiKey: "   ", fetch: fakeFetch })).toThrow(RangeError);
    expect(() =>
      createMediaRefClient({ apiKey: "mref_key", baseUrl: "   ", fetch: fakeFetch }),
    ).toThrow(RangeError);

    const client = createMediaRefClient({ apiKey: "mref_key", fetch: fakeFetch });
    await expect(client.getMedia("   ")).rejects.toThrow(RangeError);
    await expect(
      client.reportLead({
        targetExternalKey: "tmdb:tv:95479",
        namespace: "bilibili",
        nativeId: "ss45574",
        season: -1,
      }),
    ).rejects.toThrow(RangeError);
  });

  test("reportLead throws MediaRefApiError on 401/400 responses", async () => {
    const fakeFetch: FetchLike = async () =>
      jsonResponse({ error: "API_KEY_DISABLED", message: "API key is disabled" }, { status: 401 });

    const client = createMediaRefClient({ apiKey: "mref_revoked", fetch: fakeFetch });

    try {
      await client.reportLead({
        targetExternalKey: "tmdb:tv:95479",
        namespace: "bilibili",
        nativeId: "ss45574",
      });
      expect.unreachable("expected 401 on reportLead");
    } catch (error) {
      expect(error).toBeInstanceOf(MediaRefApiError);
      const apiErr = error as MediaRefApiError;
      expect(apiErr.status).toBe(401);
      expect(apiErr.code).toBe("API_KEY_DISABLED");
    }
  });
});
