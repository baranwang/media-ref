import { create, fromBinary, toBinary, toJsonString } from "@bufbuild/protobuf";
import { describe, expect, test } from "vite-plus/test";
import {
  DEFAULT_BASE_URL,
  MAX_BATCH_MEDIA_KEYS,
  MediaRefApiError,
  createMediaRefClient,
  proto,
  resolveEpisode,
  toProtoBatchItemResult,
  toProtoMediaDocument,
  toProtoMediaQueryItem,
  toProtoMediaRef,
  type BatchMediaItemResult,
  type ExternalKey,
  type FetchLike,
  type MediaDocument,
  type MediaRef,
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

function protoBinaryResponse(bytes: Uint8Array, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/proto");
  return new Response(bytes as BodyInit, {
    status: init?.status ?? 200,
    headers,
  });
}

function connectErrorResponse(input: {
  httpStatus: number;
  connectCode: string;
  message: string;
  errorCode?: string;
  retryAfterSeconds?: number;
  headers?: HeadersInit;
}): Response {
  const headers = new Headers(input.headers);
  headers.set("content-type", "application/json");
  const details = input.errorCode
    ? [
        {
          type: "mediaref.v1.ErrorInfoDetail",
          value: Buffer.from(
            toBinary(
              proto.ErrorInfoDetailSchema,
              create(proto.ErrorInfoDetailSchema, {
                errorCode: input.errorCode,
                ...(input.retryAfterSeconds !== undefined
                  ? { retryAfterSeconds: input.retryAfterSeconds }
                  : {}),
              }),
            ),
          ).toString("base64"),
        },
      ]
    : undefined;

  return new Response(
    JSON.stringify({
      code: input.connectCode,
      message: input.message,
      ...(details ? { details } : {}),
    }),
    {
      status: input.httpStatus,
      headers,
    },
  );
}

async function readBodyBytes(body: BodyInit | null | undefined): Promise<Uint8Array> {
  if (body instanceof Uint8Array) {
    return body;
  }
  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }
  if (typeof body === "string") {
    return new TextEncoder().encode(body);
  }
  const res = new Response(body);
  return new Uint8Array(await res.arrayBuffer());
}

describe("createMediaRefClient — getMedia (ConnectRPC Protobuf)", () => {
  test("queries by typed MediaRef (tmdb type+id, uuid, trakt) using binary Protobuf by default and feeds MediaDocument into resolveEpisode", async () => {
    const requests: Array<{
      url: string;
      method: string | undefined;
      contentType: string | null;
      apiKey: string | null;
      reqMsg: proto.GetMediaRequest;
    }> = [];
    const doc = createJujutsuKaisenDoc();
    const protoRes = create(proto.GetMediaResponseSchema, {
      ref: toProtoMediaRef({ tmdb: { type: "tv", id: 95479 } }),
      document: toProtoMediaDocument(doc),
      items: [toProtoMediaQueryItem({ document: doc, matchedAssociationId: null })],
    });

    const fakeFetch: FetchLike = async (url, init) => {
      const headers = new Headers(init?.headers);
      const bytes = await readBodyBytes(init?.body);
      requests.push({
        url,
        method: init?.method,
        contentType: headers.get("content-type"),
        apiKey: headers.get("x-api-key"),
        reqMsg: fromBinary(proto.GetMediaRequestSchema, bytes),
      });
      return protoBinaryResponse(toBinary(proto.GetMediaResponseSchema, protoRes));
    };

    const client = createMediaRefClient({
      apiKey: "mref_test_key_123",
      fetch: fakeFetch,
    });

    const response = await client.getMedia({ tmdb: { type: "tv", id: 95479 } });
    expect(response).not.toBeNull();
    expect(response?.ref).toEqual({ tmdb: { type: "tv", id: 95479 } });
    expect(response?.key).toBe("tmdb:tv:95479");
    expect(response?.matchedAssociationId).toBeNull();
    expect(response?.items).toHaveLength(1);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${DEFAULT_BASE_URL}/mediaref.v1.MediaService/GetMedia`);
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.contentType).toBe("application/proto");
    expect(requests[0]?.apiKey).toBe("mref_test_key_123");
    expect(requests[0]?.reqMsg.ref?.id.case).toBe("tmdb");
    if (requests[0]?.reqMsg.ref?.id.case === "tmdb") {
      expect(requests[0].reqMsg.ref.id.value.type).toBe(proto.MediaType.TV);
      expect(requests[0].reqMsg.ref.id.value.id).toBe(95479);
    }

    await client.getMedia({ mediaId: "00000000-0000-4000-8000-000000000001" });
    expect(requests[1]?.reqMsg.ref?.id).toEqual({
      case: "mediaId",
      value: "00000000-0000-4000-8000-000000000001",
    });

    await client.getMedia({ trakt: { id: "1390", type: "tv" } });
    expect(requests[2]?.reqMsg.ref?.id.case).toBe("trakt");
    if (requests[2]?.reqMsg.ref?.id.case === "trakt") {
      expect(requests[2].reqMsg.ref.id.value.id).toBe("1390");
      expect(requests[2].reqMsg.ref.id.value.type).toBe(proto.MediaType.TV);
    }

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

  test("supports Connect JSON mode when useBinaryFormat is false", async () => {
    const doc = createJujutsuKaisenDoc();
    let seenContentType: string | null = null;
    const protoRes = create(proto.GetMediaResponseSchema, {
      ref: toProtoMediaRef({ tmdb: { type: "tv", id: 95479 } }),
      document: toProtoMediaDocument(doc),
      items: [toProtoMediaQueryItem({ document: doc, matchedAssociationId: null })],
    });

    const fakeFetch: FetchLike = async (_url, init) => {
      seenContentType = new Headers(init?.headers).get("content-type");
      return new Response(toJsonString(proto.GetMediaResponseSchema, protoRes), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const client = createMediaRefClient({
      apiKey: "mref_json_key",
      useBinaryFormat: false,
      fetch: fakeFetch,
    });

    const response = await client.getMedia({ tmdb: { type: "tv", id: 95479 } });
    expect(seenContentType).toBe("application/json");
    expect(response?.document.media.snapshot.title).toBe("咒术回战");
  });

  test("accepts ExternalKey object, normalizes trailing slashes on baseUrl, and returns null on NotFound", async () => {
    const requests: string[] = [];
    const fakeFetch: FetchLike = async (url) => {
      requests.push(url);
      return connectErrorResponse({
        httpStatus: 404,
        connectCode: "not_found",
        errorCode: "MEDIA_NOT_FOUND",
        message: "Media not found",
      });
    };

    const client = createMediaRefClient({
      apiKey: "mref_test_key_123",
      baseUrl: "https://custom.mediaref.example/api///",
      fetch: fakeFetch,
    });

    const key: ExternalKey = { namespace: "douban", nativeId: "1292052" };
    const result = await client.getMedia(key);
    expect(result).toBeNull();
    expect(requests).toEqual([
      "https://custom.mediaref.example/api/mediaref.v1.MediaService/GetMedia",
    ]);
  });

  test("serializes includeUnconfirmed, season, and namespaceGroup into Protobuf request", async () => {
    const sentMessages: proto.GetMediaRequest[] = [];
    const doc = createJujutsuKaisenDoc();
    const protoRes = create(proto.GetMediaResponseSchema, {
      ref: toProtoMediaRef({ tmdb: { type: "tv", id: 95479 } }),
      document: toProtoMediaDocument(doc),
      items: [toProtoMediaQueryItem({ document: doc, matchedAssociationId: null })],
    });

    const fakeFetch: FetchLike = async (_url, init) => {
      const bytes = await readBodyBytes(init?.body);
      sentMessages.push(fromBinary(proto.GetMediaRequestSchema, bytes));
      return protoBinaryResponse(toBinary(proto.GetMediaResponseSchema, protoRes));
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

    expect(sentMessages).toHaveLength(2);
    expect(sentMessages[0]?.includeUnconfirmed).toBe(true);
    expect(sentMessages[0]?.season).toBe(1);
    expect(sentMessages[0]?.namespaceGroup).toBe(proto.NamespaceGroup.PLATFORM);

    expect(sentMessages[1]?.includeUnconfirmed).toBe(false);
    expect(sentMessages[1]?.season).toBe(0);
    expect(sentMessages[1]?.namespaceGroup).toBe(proto.NamespaceGroup.CATALOG);
  });

  test("rejects negative or non-integer season values locally", async () => {
    const fakeFetch: FetchLike = async () => protoBinaryResponse(new Uint8Array());
    const client = createMediaRefClient({ apiKey: "mref_key", fetch: fakeFetch });

    await expect(client.getMedia("tmdb:tv:95479", { season: -1 })).rejects.toThrow(RangeError);
    await expect(client.getMedia("tmdb:tv:95479", { season: 1.5 })).rejects.toThrow(RangeError);
  });

  test("throws typed MediaRefApiError on 401, 403, 429 (parsing Retry-After and ErrorInfoDetail), and 5xx", async () => {
    const responses: Response[] = [
      connectErrorResponse({
        httpStatus: 401,
        connectCode: "unauthenticated",
        errorCode: "INVALID_API_KEY",
        message: "Invalid API key",
      }),
      connectErrorResponse({
        httpStatus: 403,
        connectCode: "permission_denied",
        errorCode: "INSUFFICIENT_PERMISSIONS",
        message: "API key does not have required permission",
      }),
      connectErrorResponse({
        httpStatus: 429,
        connectCode: "resource_exhausted",
        errorCode: "RATE_LIMITED",
        retryAfterSeconds: 60,
        message: "API key read rate limit exceeded; retry after 45s",
        headers: { "Retry-After": "45" },
      }),
      connectErrorResponse({
        httpStatus: 429,
        connectCode: "resource_exhausted",
        errorCode: "RATE_LIMITED",
        message: "Too many requests",
        headers: { "Retry-After": new Date(Date.now() + 30_000).toUTCString() },
      }),
      new Response("Bad Gateway", {
        status: 502,
        statusText: "Bad Gateway",
        headers: { "content-type": "text/plain" },
      }),
    ];

    let index = 0;
    const fakeFetch: FetchLike = async () => responses[index++]!;
    const client = createMediaRefClient({ apiKey: "mref_key", fetch: fakeFetch });

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

  test("falls back to ErrorInfoDetail retryAfterSeconds on 429 and forwards AbortSignal", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;

    const fakeFetch: FetchLike = async (_url, init) => {
      receivedSignal = init?.signal;
      return connectErrorResponse({
        httpStatus: 429,
        connectCode: "resource_exhausted",
        errorCode: "RATE_LIMITED",
        retryAfterSeconds: 60,
        message: "Rate limit exceeded",
      });
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

    expect(receivedSignal).toBeDefined();
  });
});

describe("createMediaRefClient — getMediaBatch", () => {
  test("queries a single batch <= 100 keys over Protobuf and preserves per-key error outcomes", async () => {
    const doc = createJujutsuKaisenDoc();
    const sentMessages: proto.BatchGetMediaRequest[] = [];
    const sentUrls: string[] = [];

    const fakeFetch: FetchLike = async (url, init) => {
      sentUrls.push(url);
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("X-API-Key")).toBe("mref_batch_key");
      expect(headers.get("Content-Type")).toBe("application/proto");
      const req = fromBinary(proto.BatchGetMediaRequestSchema, await readBodyBytes(init?.body));
      sentMessages.push(req);

      const results: BatchMediaItemResult[] = [
        {
          ref: { tmdb: { type: "tv", id: 95479 } },
          key: "tmdb:tv:95479",
          ok: true,
          items: [{ document: doc, matchedAssociationId: null }],
        },
        {
          ref: { douban: "99999999" },
          key: "douban:99999999",
          ok: false,
          error: "NOT_FOUND",
          message: "Media not found",
        },
        {
          ref: null,
          key: "",
          ok: false,
          error: "INVALID_KEY",
          message: "Media reference is required",
        },
      ];

      const protoRes = create(proto.BatchGetMediaResponseSchema, {
        results: results.map((entry) =>
          entry.ok
            ? toProtoBatchItemResult({
                ref: entry.ref!,
                ok: true,
                items: entry.items,
              })
            : toProtoBatchItemResult({
                ref: entry.ref ?? create(proto.MediaRefSchema),
                ok: false,
                error: entry.error,
                message: entry.message,
              }),
        ),
      });
      return protoBinaryResponse(toBinary(proto.BatchGetMediaResponseSchema, protoRes));
    };

    const client = createMediaRefClient({ apiKey: "mref_batch_key", fetch: fakeFetch });

    const batch = await client.getMediaBatch(
      [{ tmdb: { type: "tv", id: 95479 } }, { douban: "99999999" }, "not-a-valid-key"],
      { includeUnconfirmed: true, season: 1, namespaceGroup: "platform" },
    );

    expect(sentUrls).toEqual([`${DEFAULT_BASE_URL}/mediaref.v1.MediaService/BatchGetMedia`]);
    expect(sentMessages[0]?.refs).toHaveLength(3);
    expect(sentMessages[0]?.refs[0]?.id.case).toBe("tmdb");
    expect(sentMessages[0]?.refs[1]?.id).toEqual({ case: "douban", value: "99999999" });
    expect(sentMessages[0]?.refs[2]?.id.case).toBeUndefined();
    expect(sentMessages[0]?.includeUnconfirmed).toBe(true);
    expect(sentMessages[0]?.season).toBe(1);
    expect(sentMessages[0]?.namespaceGroup).toBe(proto.NamespaceGroup.PLATFORM);

    expect(batch.results).toHaveLength(3);
    expect(batch.results[0]?.ok).toBe(true);
    if (batch.results[0]?.ok) {
      expect(batch.results[0].ref).toEqual({ tmdb: { type: "tv", id: 95479 } });
      expect(batch.results[0].items[0]?.document.media.snapshot.title).toBe("咒术回战");
    }
    expect(batch.results[1]).toEqual({
      ref: { douban: "99999999" },
      key: "douban:99999999",
      ok: false,
      error: "NOT_FOUND",
      message: "Media not found",
    });
    expect(batch.results[2]).toEqual({
      ref: null,
      key: "",
      ok: false,
      error: "INVALID_KEY",
      message: "Media reference is required",
    });
  });

  test("auto-chunks 150 refs into two BatchGetMedia calls (100 + 50) preserving exact order", async () => {
    expect(MAX_BATCH_MEDIA_KEYS).toBe(100);
    const doc = createJujutsuKaisenDoc();
    const chunkSizes: number[] = [];

    const fakeFetch: FetchLike = async (_url, init) => {
      const req = fromBinary(proto.BatchGetMediaRequestSchema, await readBodyBytes(init?.body));
      chunkSizes.push(req.refs.length);
      const protoRes = create(proto.BatchGetMediaResponseSchema, {
        results: req.refs.map((ref, idx) =>
          idx % 10 === 0
            ? toProtoBatchItemResult({
                ref,
                ok: false,
                error: "NOT_FOUND",
                message: "Media not found",
              })
            : toProtoBatchItemResult({
                ref,
                ok: true,
                items: [{ document: doc, matchedAssociationId: null }],
              }),
        ),
      });
      return protoBinaryResponse(toBinary(proto.BatchGetMediaResponseSchema, protoRes));
    };

    const refs: MediaRef[] = Array.from({ length: 150 }, (_, i) => ({
      tmdb: { type: "tv", id: 1000 + i },
    }));
    const client = createMediaRefClient({ apiKey: "mref_batch_key", fetch: fakeFetch });

    const batch = await client.getMediaBatch(refs);

    expect(chunkSizes).toEqual([100, 50]);
    expect(batch.results).toHaveLength(150);
    expect(batch.results.map((r) => r.ref)).toEqual(refs);
    expect(batch.results[0]?.ok).toBe(false);
    expect(batch.results[1]?.ok).toBe(true);
    expect(batch.results[100]?.ok).toBe(false);
    expect(batch.results[149]?.ok).toBe(true);
  });

  test("returns empty results without RPC calls for empty input and rejects >100 when autoChunk is false", async () => {
    let fetchCalls = 0;
    const fakeFetch: FetchLike = async () => {
      fetchCalls += 1;
      return protoBinaryResponse(new Uint8Array());
    };

    const client = createMediaRefClient({ apiKey: "mref_batch_key", fetch: fakeFetch });

    expect(await client.getMediaBatch([])).toEqual({ results: [] });
    expect(fetchCalls).toBe(0);

    const keys = Array.from({ length: 101 }, (_, i) => `tmdb:tv:${i + 1}`);
    await expect(client.getMediaBatch(keys, { autoChunk: false })).rejects.toThrow(RangeError);
    expect(fetchCalls).toBe(0);
  });

  test("throws MediaRefApiError when a batch chunk fails with rate-limit error", async () => {
    const fakeFetch: FetchLike = async () =>
      connectErrorResponse({
        httpStatus: 429,
        connectCode: "resource_exhausted",
        errorCode: "RATE_LIMITED",
        message: "Too many batch requests",
        headers: { "Retry-After": "12" },
      });

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

describe("createMediaRefClient — resolveFromKey and option validation", () => {
  test("resolveFromKey combines getMedia + resolveEpisode with full typing and forwards params", async () => {
    const doc = createJujutsuKaisenDoc();
    const sentMessages: proto.GetMediaRequest[] = [];

    const fakeFetch: FetchLike = async (_url, init) => {
      const req = fromBinary(proto.GetMediaRequestSchema, await readBodyBytes(init?.body));
      sentMessages.push(req);
      if (req.ref?.id.case === "tmdb" && req.ref.id.value.id === 9999999) {
        return connectErrorResponse({
          httpStatus: 404,
          connectCode: "not_found",
          errorCode: "MEDIA_NOT_FOUND",
          message: "Media not found",
        });
      }
      const protoRes = create(proto.GetMediaResponseSchema, {
        ref: toProtoMediaRef({ tmdb: { type: "tv", id: 95479 } }),
        document: toProtoMediaDocument(doc),
        items: [toProtoMediaQueryItem({ document: doc, matchedAssociationId: null })],
      });
      return protoBinaryResponse(toBinary(proto.GetMediaResponseSchema, protoRes));
    };

    const client = createMediaRefClient({ apiKey: "mref_key", fetch: fakeFetch });

    const mapped = await client.resolveFromKey(
      { tmdb: { type: "tv", id: 95479 } },
      {
        namespace: "bilibili",
        season: 1,
        episode: 30,
      },
    );

    expect(mapped.kind).toBe("mapped");
    if (mapped.kind === "mapped") {
      expect(mapped.nativeId).toBe("ss45574");
      expect(mapped.targetEpisode).toBe(6);
      expect(mapped.media.document.media.snapshot.title).toBe("咒术回战");
    }

    expect(sentMessages[0]?.season).toBe(1);
    expect(sentMessages[0]?.namespaceGroup).toBe(proto.NamespaceGroup.PLATFORM);

    const missing = await client.resolveFromKey(
      { tmdb: { type: "tv", id: 9999999 } },
      { namespace: "douban", season: 1, episode: 1, includeUnconfirmed: true },
    );
    expect(missing).toEqual({
      kind: "not_found",
      ref: { tmdb: { type: "tv", id: 9999999 } },
      key: "tmdb:tv:9999999",
    });

    expect(sentMessages[1]?.includeUnconfirmed).toBe(true);
    expect(sentMessages[1]?.season).toBe(1);
    expect(sentMessages[1]?.namespaceGroup).toBe(proto.NamespaceGroup.CATALOG);
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

    const protoRes = create(proto.GetMediaResponseSchema, {
      ref: toProtoMediaRef({ tmdb: { type: "tv", id: 95479 } }),
      document: toProtoMediaDocument(doc),
      items: [toProtoMediaQueryItem({ document: doc, matchedAssociationId: null })],
    });
    const fakeFetch: FetchLike = async () =>
      protoBinaryResponse(toBinary(proto.GetMediaResponseSchema, protoRes));

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

  test("validates client options and empty lookup keys", async () => {
    const fakeFetch: FetchLike = async () => protoBinaryResponse(new Uint8Array());
    expect(() => createMediaRefClient({ apiKey: "   ", fetch: fakeFetch })).toThrow(RangeError);
    expect(() =>
      createMediaRefClient({ apiKey: "mref_key", baseUrl: "   ", fetch: fakeFetch }),
    ).toThrow(RangeError);

    const client = createMediaRefClient({ apiKey: "mref_key", fetch: fakeFetch });
    await expect(client.getMedia("   ")).rejects.toThrow(RangeError);
    await expect(
      client.getMedia({ tmdb: { type: "tv", id: 95479 } }, { season: -1 }),
    ).rejects.toThrow(RangeError);
  });
});

test("an error's status matches the HTTP status Connect sends for it", async () => {
  const { codeToHttpStatus } = await import("@connectrpc/connect/protocol-connect");
  const { createDomainConnectError, extractConnectErrorInfo } = await import("../src/index.ts");
  for (const status of [400, 401, 403, 404, 409, 429, 503]) {
    const error = createDomainConnectError({ status, code: "X", message: "x" });
    expect(codeToHttpStatus(error.code)).toBe(status);
    expect(extractConnectErrorInfo(error).status).toBe(status);
  }
});
