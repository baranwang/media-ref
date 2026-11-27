import type { ExecutionContext, Hyperdrive } from "@cloudflare/workers-types";
import { createFakeOutboundClient } from "@media-ref/core";
import { createTestDb, type TestDbHandle } from "@media-ref/db/testing";
import { afterEach, describe, expect, test } from "vite-plus/test";
import worker from "../src/index.ts";
import { createApiApp } from "../src/lib.ts";

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

  test.each([undefined, "", "  "])(
    "requires AUTH_SECRET before opening database pools (%s)",
    async (secret) => {
      const env = { AUTH_SECRET: secret } as Parameters<typeof worker.fetch>[1];
      await expect(
        worker.fetch(new Request("https://api.mediaref.org/health"), env, {} as ExecutionContext),
      ).rejects.toThrow("AUTH_SECRET is required");
    },
  );

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
        AUTH_SECRET: crypto.randomUUID(),
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
});
