import { createFileRoute } from "@tanstack/react-router";
import { docsLlms } from "#/lib/docs-llms";

export const Route = createFileRoute("/llms-full.txt")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        (await docsLlms.serve(new URL(request.url).pathname)) ??
        new Response(null, { status: 404 }),
    },
  },
});
