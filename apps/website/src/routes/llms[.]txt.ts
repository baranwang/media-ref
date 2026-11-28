import { createFileRoute } from "@tanstack/react-router";
import { markdownResponse, siteLlmsIndex } from "#/lib/docs-llms";

export const Route = createFileRoute("/llms.txt")({
  server: {
    handlers: {
      GET: () => markdownResponse(siteLlmsIndex()),
    },
  },
});
