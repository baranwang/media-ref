import {
  createAdapterRegistry,
  createFakeOutboundClient,
  type ExternalHttpRequest,
} from "@media-ref/core";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { createApiApp, createInMemoryRateLimiter } from "../src/lib.ts";
import { approveInCore, issueApiKeyRpc, signUpUser, TEST_BASE_URL } from "./rpc-helpers.ts";

const TEST_AUTH_SECRET = "test-secret-for-media-ref-mcp-integration-tests-0123456789abcdef";

// Every unary RPC in proto/mediaref/v1, nothing from mediaref.internal.v1.
const TOOL_NAMES = [
  "batch_get_media",
  "create_change_request",
  "get_catalog_detail",
  "get_change_request",
  "get_current_api_key",
  "get_media",
  "list_association_revisions",
  "list_change_request_comments",
  "list_demands",
  "list_exploration_activity",
  "list_trending",
  "report_invalidation",
  "search",
];

const JJK = { tmdb: { type: "MEDIA_TYPE_TV", id: 95479 } };

function catalogStub(request: ExternalHttpRequest) {
  if (
    request.kind === "catalog" &&
    request.namespace === "tmdb" &&
    request.url.includes("/tv/95479")
  ) {
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      url: request.url,
      body: JSON.stringify({
        id: 95479,
        name: "咒术回战",
        original_name: "呪術廻戦",
        first_air_date: "2020-10-03",
        seasons: [{ season_number: 1, episode_count: 24, air_date: "2020-10-03" }],
        external_ids: { imdb_id: "tt12343534" },
      }),
    };
  }
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    url: request.url,
    body: "[]",
  };
}

type App = ReturnType<typeof createApiApp>;

let nextId = 1;

async function mcp(
  app: App,
  method: string,
  params: unknown,
  headers: Record<string, string> = {},
) {
  const res = await app.fetch(
    new Request(`${TEST_BASE_URL}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        "cf-connecting-ip": "203.0.113.7",
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    }),
  );
  const text = await res.text();
  // Streamable HTTP may answer as a one-event SSE stream.
  const body = text.startsWith("{") ? text : text.match(/^data: (.+)$/m)?.[1];
  return { status: res.status, body: body ? JSON.parse(body) : null };
}

async function callTool(app: App, key: string, name: string, args: Record<string, unknown> = {}) {
  const { status, body } = await mcp(
    app,
    "tools/call",
    { name, arguments: args },
    { authorization: `Bearer ${key}` },
  );
  expect(status).toBe(200);
  const result = body.result as { isError?: boolean; content: { type: string; text: string }[] };
  return { isError: result.isError === true, data: JSON.parse(result.content[0]!.text) };
}

describe("MCP server at /mcp", () => {
  const handles: TestDbHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) await handles.pop()?.cleanup();
  });

  async function setup(readKeyLimit = 100) {
    const testDb = await createTestDb();
    handles.push(testDb);
    const outbound = createFakeOutboundClient({ fetchExternal: catalogStub });
    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      adapterRegistry: createAdapterRegistry(),
      readKeyLimiter: createInMemoryRateLimiter({ limit: readKeyLimit, periodSeconds: 60 }),
      readIpLimiter: createInMemoryRateLimiter({ limit: 100, periodSeconds: 60 }),
      config: {
        baseUrl: TEST_BASE_URL,
        authSecret: TEST_AUTH_SECRET,
        tmdb: { accessToken: "test-tmdb-token" },
        readRetryAfterSeconds: 60,
      },
    });

    const user = await signUpUser(app, outbound, {
      email: "mcp@example.com",
      password: "StrongPassword123!",
      name: "MCP User",
    });
    const submitKey = await issueApiKeyRpc(app, user.cookie, { name: "submit", canSubmit: true });
    const readKey = await issueApiKeyRpc(app, user.cookie, { name: "read" });

    const created = await callTool(app, submitKey.key, "create_change_request", {
      target: JJK,
      namespace: "bilibili",
      nativeId: "ss34430",
      variantDescription: "原声",
      segments: [
        {
          explicit: {
            season: 1,
            episodeStart: 1,
            episodeEnd: 24,
            targetEpisodeStart: 1,
            baseline: "tmdb",
          },
        },
      ],
    });
    expect(created.isError).toBe(false);
    await approveInCore({ db: testDb.writeDb, outbound }, { id: created.data.changeRequest.id });

    return { app, readKey: readKey.key, submitKey: submitKey.key };
  }

  test("initializes and lists only the public tools", async () => {
    const { app, readKey } = await setup();
    const headers = { "x-api-key": readKey };

    const init = await mcp(
      app,
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
      headers,
    );
    expect(init.status).toBe(200);
    expect(init.body.result.serverInfo.name).toBe("mediaref");

    const list = await mcp(app, "tools/list", {}, headers);
    const tools = list.body.result.tools as {
      name: string;
      inputSchema: { properties: Record<string, any> };
      annotations: { readOnlyHint: boolean };
    }[];
    expect(tools.map((tool) => tool.name).sort()).toEqual(TOOL_NAMES);

    // Schemas and hints come from the proto descriptors.
    const getMedia = tools.find((tool) => tool.name === "get_media")!;
    expect(getMedia.annotations.readOnlyHint).toBe(true);
    expect(getMedia.inputSchema.properties.namespaceGroup.enum).toContain(
      "NAMESPACE_GROUP_PLATFORM",
    );
    expect(getMedia.inputSchema.properties.ref.properties.tmdb.description).toMatch(
      /^Set only one of: mediaId, tmdb, imdb/,
    );
    const create = tools.find((tool) => tool.name === "create_change_request")!;
    expect(create.annotations.readOnlyHint).toBe(false);
    expect(Object.keys(create.inputSchema.properties.segments.items.properties)).toEqual([
      "wholeSeason",
      "explicit",
    ]);
  });

  test("forwards get_media and returns the response as protobuf JSON", async () => {
    const { app, readKey } = await setup();

    const media = await callTool(app, readKey, "get_media", {
      ref: JJK,
      namespaceGroup: "NAMESPACE_GROUP_PLATFORM",
    });
    expect(media.isError).toBe(false);
    expect(media.data.document.media.snapshot.title).toBe("咒术回战");
    expect(media.data.document.associations).toEqual([
      expect.objectContaining({
        namespace: "bilibili",
        nativeId: "ss34430",
        status: "ASSOCIATION_STATUS_CONFIRMED",
      }),
    ]);

    const unknownField = await callTool(app, readKey, "get_media", { ref: JJK, season: 1, x: 1 });
    expect(unknownField).toMatchObject({ isError: true, data: { error: "INVALID_ARGUMENT" } });
  });

  test("rejects requests without a key and tool calls with an invalid key", async () => {
    const { app } = await setup();

    const missing = await mcp(app, "tools/list", {});
    expect(missing.status).toBe(401);
    expect(missing.body.code).toBe("API_KEY_REQUIRED");

    const invalid = await callTool(app, "mr_not-a-real-key", "get_media", { ref: JJK });
    expect(invalid).toMatchObject({
      isError: true,
      data: { error: "INVALID_API_KEY", status: 401 },
    });
  });

  test("denies create_change_request to a key without submit permission", async () => {
    const { app, readKey } = await setup();

    const denied = await callTool(app, readKey, "create_change_request", {
      target: JJK,
      namespace: "iqiyi",
      nativeId: "a_19rrh1ss1p",
      variantDescription: "国语",
      segments: [{ wholeSeason: { season: 1, baseline: "tmdb" } }],
    });
    expect(denied).toMatchObject({
      isError: true,
      data: { error: "INSUFFICIENT_PERMISSIONS", status: 403 },
    });
  });

  test("counts tool calls against the per-key read limit", async () => {
    const { app, readKey } = await setup(2);

    for (let i = 0; i < 2; i++) {
      expect((await callTool(app, readKey, "get_media", { ref: JJK })).isError).toBe(false);
    }
    const limited = await callTool(app, readKey, "batch_get_media", { refs: [JJK] });
    expect(limited).toMatchObject({
      isError: true,
      data: { error: "RATE_LIMITED", status: 429, retryAfterSeconds: 60 },
    });
  });
});
