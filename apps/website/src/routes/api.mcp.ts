import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { createFileRoute } from "@tanstack/react-router";
import { registerSearchTool, registerSourceTools } from "fumadocs-core/mcp";
import { docsLlms } from "#/lib/docs-llms";
import { docsSearch } from "#/lib/docs-search";
import { docsSource } from "#/lib/docs-source";

/** MCP server for the docs: list, search and read pages. */
const handler = createMcpHandler(() => {
  const mcp = new McpServer(
    { name: "mediaref-docs", version: "1.0.0" },
    // The tools never change; a stream to watch them would hold the Worker request open.
    { capabilities: { tools: { listChanged: false } } },
  );
  registerSourceTools(mcp, docsSource, docsLlms);
  registerSearchTool(mcp, docsSearch);
  return mcp;
});

export const Route = createFileRoute("/api/mcp")({
  server: {
    handlers: {
      GET: ({ request }) => handler.fetch(request),
      POST: ({ request }) => handler.fetch(request),
      DELETE: ({ request }) => handler.fetch(request),
    },
  },
});
