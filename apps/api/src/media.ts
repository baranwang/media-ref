import { readMediaDocument } from "@media-ref/core";
import type { Hono } from "hono";
import { requireApiKey } from "./api-keys.ts";
import type { ApiEnv } from "./auth.ts";

export function registerMediaRoutes(app: Hono<ApiEnv>): void {
  app.get("/v1/media/:key", requireApiKey({ db: "read", permission: "read" }), async (c) => {
    const rawKey = c.req.param("key").trim();
    const result = await readMediaDocument(c.get("dbRead"), rawKey);

    if (result.kind === "invalid_key") {
      return c.json({ error: "INVALID_KEY", message: result.message }, 400);
    }

    if (result.kind === "not_found") {
      return c.json({ error: "MEDIA_NOT_FOUND", message: "Media not found" }, 404);
    }

    return c.json(
      {
        document: result.document,
        matchedAssociationId: result.matchedAssociationId,
      },
      200,
    );
  });
}
