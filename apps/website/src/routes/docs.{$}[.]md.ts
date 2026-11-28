import { createFileRoute } from "@tanstack/react-router";
import { DESCRIBED_BY, docsLlms } from "#/lib/docs-llms";

export const Route = createFileRoute("/docs/{$}.md")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const file = await docsLlms.serve(new URL(request.url).pathname);
        if (!file) return new Response(null, { status: 404 });
        file.headers.set("Link", DESCRIBED_BY);
        return file;
      },
    },
  },
});
