import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { BrowseService, MediaService } from "@media-ref/client";
import { getRequestHeader } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";

// Server-only: imported dynamically from server-function handlers.

/** Must match `INTERNAL_VISITOR_IP_HEADER` in apps/api/src/app.ts. */
const VISITOR_IP_HEADER = "x-media-ref-visitor-ip";

/**
 * Clients for the API Worker's `InternalApi` entrypoint (service binding `API`). Public reads
 * need no API key there; the visitor IP is forwarded so the API still rate-limits per visitor.
 */
export function internalApiClients() {
  const binding = env.API;
  if (!binding) {
    throw new Error("The API service binding is not configured for this Worker");
  }
  const visitorIp = getRequestHeader("cf-connecting-ip") ?? "unknown";
  const transport = createConnectTransport({
    // The host is never resolved: requests go straight to the bound Worker.
    baseUrl: "https://api.internal",
    useBinaryFormat: true,
    fetch: (input, init) => {
      // connect-web sends `redirect: "error"`, which the Workers runtime rejects.
      const request = new Request(input, { ...init, redirect: "manual" });
      request.headers.set(VISITOR_IP_HEADER, visitorIp);
      return binding.fetch(request);
    },
  });
  return {
    browse: createClient(BrowseService, transport),
    media: createClient(MediaService, transport),
  };
}
