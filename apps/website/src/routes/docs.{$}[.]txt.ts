import { createFileRoute } from "@tanstack/react-router";
import {
  DESCRIBED_BY,
  DOCS_LLMS_TXT,
  docsLlms,
  docsLlmsIndex,
  markdownResponse,
} from "#/lib/docs-llms";

export const Route = createFileRoute("/docs/{$}.txt")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { pathname } = new URL(request.url);
        if (pathname === DOCS_LLMS_TXT) return markdownResponse(docsLlmsIndex());
        if (pathname === "/docs/llms-full.txt") return markdownResponse(await docsLlms.full());
        // Per-service files, e.g. /docs/media-service/llms-full.txt.
        const file = await docsLlms.serve(pathname);
        if (!file) return new Response(null, { status: 404 });
        file.headers.set("Link", DESCRIBED_BY);
        return file;
      },
    },
  },
});
