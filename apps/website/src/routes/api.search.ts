import { createFileRoute } from "@tanstack/react-router";
import { docsSearch } from "#/lib/docs-search";

export const Route = createFileRoute("/api/search")({
  server: {
    handlers: {
      GET: ({ request }) => docsSearch.GET(request),
    },
  },
});
