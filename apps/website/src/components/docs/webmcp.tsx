import { useNavigate } from "@tanstack/react-router";
import { fetchClient } from "fumadocs-core/search/client/fetch";
import { useEffect } from "react";

interface ModelContextTool<Input> {
  name: string;
  description: string;
  inputSchema?: object;
  execute: (input: Input) => Promise<unknown>;
}

declare global {
  interface Document {
    /** WebMCP (experimental), see https://webmachinelearning.github.io/webmcp/ */
    modelContext?: {
      registerTool: <Input>(
        tool: ModelContextTool<Input>,
        options?: { signal?: AbortSignal },
      ) => Promise<void>;
    };
  }
}

const urlInput = {
  type: "object",
  properties: { url: { type: "string" } },
  required: ["url"],
};

/** Exposes the docs to the browser's AI agent through WebMCP: search, read and open pages. */
export function WebMCP() {
  const navigate = useNavigate();

  useEffect(() => {
    const context = document.modelContext;
    if (!context) return;
    const controller = new AbortController();
    const client = fetchClient({ api: "/api/search" });

    const tools: ModelContextTool<never>[] = [
      {
        name: "search_docs",
        description: "Search the MediaRef API docs; returns matching pages and headings with URLs",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        execute: async ({ query }: { query: string }) => client.search(query),
      },
      {
        name: "read_page",
        description: "Read a MediaRef docs page as Markdown by its URL",
        inputSchema: urlInput,
        async execute({ url }: { url: string }) {
          // Search results carry a heading hash.
          const res = await fetch(`${url.replace(/[?#].*$/, "")}.md`);
          if (!res.ok) throw new Error(`page not found: ${url}`);
          return res.text();
        },
      },
      {
        name: "open_page",
        description: "Navigate to a MediaRef docs page by its URL",
        inputSchema: urlInput,
        async execute({ url }: { url: string }) {
          await navigate({ href: url });
          return `opened ${url}`;
        },
      },
    ];

    for (const tool of tools) {
      context.registerTool(tool, { signal: controller.signal }).catch((error: unknown) => {
        // Cleanup aborts pending registrations, e.g. under Strict Mode.
        if (error !== controller.signal.reason) console.error(error);
      });
    }
    return () => controller.abort();
  }, [navigate]);

  return null;
}
