import type { ExecutionContext, Hyperdrive } from "@cloudflare/workers-types";
import { createFakeOutboundClient } from "@media-ref/core";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, describe, expect, test } from "vite-plus/test";
import worker, { createApiApp } from "../src/index.ts";

describe("API Worker HTTP entrypoint", () => {
  const handles: TestDbHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop();
      if (handle) {
        await handle.cleanup();
      }
    }
  });

  test("GET /health verifies connectivity against migrated PostgreSQL 19", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound: createFakeOutboundClient(),
      config: {},
    });

    const response = await app.fetch(new Request("https://api.mediaref.org/health"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      database: "ok",
    });
  });

  test("GET /health/outbound routes through OutboundClient and is intercepted by fake double when enabled", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const outbound = createFakeOutboundClient({
      fetchExternal: async (request) => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          collectionId: "ss45574",
          title: "Jujutsu Kaisen",
          requestedUrl: request.url,
        }),
        url: request.url,
      }),
    });

    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: { enableHealthOutboundProbe: true },
    });

    const targetUrl = "https://api.bilibili.com/pgc/view/web/season?season_id=45574";
    const response = await app.fetch(
      new Request(
        `https://api.mediaref.org/health/outbound?kind=platform&namespace=bilibili&url=${encodeURIComponent(targetUrl)}`,
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      kind: "platform",
      namespace: "bilibili",
      upstreamStatus: 200,
      bodyPreview: JSON.stringify({
        collectionId: "ss45574",
        title: "Jujutsu Kaisen",
        requestedUrl: targetUrl,
      }),
    });
    expect(outbound.httpRequests).toEqual([
      {
        kind: "platform",
        namespace: "bilibili",
        url: targetUrl,
        method: "GET",
      },
    ]);
  });

  test("GET /health/outbound returns 404 when probe is not enabled", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound: createFakeOutboundClient(),
      config: {},
    });

    const response = await app.fetch(
      new Request(
        "https://api.mediaref.org/health/outbound?kind=catalog&namespace=tmdb&url=https%3A%2F%2Fapi.themoviedb.org%2F3%2Ftv%2F95479",
      ),
    );

    expect(response.status).toBe(404);
  });

  test("default Cloudflare Worker fetch entrypoint serves GET /health via Hyperdrive bindings", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;

    const hyperdrive = {
      connectionString: testDb.connectionString,
    } as Hyperdrive;

    const response = await worker.fetch(
      new Request("https://api.mediaref.org/health"),
      {
        HYPERDRIVE_READ: hyperdrive,
        HYPERDRIVE_WRITE: hyperdrive,
      },
      ctx,
    );

    await Promise.all(pending);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      database: "ok",
    });
  });

  test("GET /health returns 503 when database migrations have not run", async () => {
    const testDb = await createTestDb({ migrate: false });
    handles.push(testDb);

    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound: createFakeOutboundClient(),
      config: {},
    });

    const response = await app.fetch(new Request("https://api.mediaref.org/health"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      database: "error",
    });
  });

  test("GET /health/outbound returns 502 when OutboundClient throws", async () => {
    const testDb = await createTestDb();
    handles.push(testDb);

    const outbound = createFakeOutboundClient({
      fetchExternal: async () => {
        throw new Error("Simulated upstream timeout");
      },
    });

    const app = createApiApp({
      dbRead: testDb.readDb,
      dbWrite: testDb.writeDb,
      outbound,
      config: { enableHealthOutboundProbe: true },
    });

    const response = await app.fetch(
      new Request(
        "https://api.mediaref.org/health/outbound?kind=platform&namespace=bilibili&url=https%3A%2F%2Fapi.bilibili.com%2Ftest",
      ),
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      ok: false,
      error: "upstream_error",
    });
  });
});
