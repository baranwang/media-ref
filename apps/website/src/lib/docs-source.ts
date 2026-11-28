import { createHighlighter } from "@tanstack/highlight/core";
import { go } from "@tanstack/highlight/languages/go";
import { json } from "@tanstack/highlight/languages/json";
import { python } from "@tanstack/highlight/languages/python";
import { shell } from "@tanstack/highlight/languages/shell";
import { ts } from "@tanstack/highlight/languages/ts";
import { yaml } from "@tanstack/highlight/languages/yaml";
import { rehypeHighlightCodeBlocks } from "@tanstack/highlight/rehype";
import { loader } from "fumadocs-core/source";
import { pageSchema } from "fumadocs-core/source/schema";
import { applyMdxPreset } from "fumadocs-mdx/config";
import { defineDocs } from "fumadocs-mdx/macro";
import { z } from "zod";

const docs = defineDocs({
  dir: "content/docs",
  docs: {
    // Each page compiles to its own chunk, so the browser only downloads the page it shows.
    async: true,
    schema: pageSchema.extend({
      /** Shown above the title, e.g. "文档 / 入门". */
      breadcrumb: z.string(),
      /** Small badges next to the title, e.g. ["只读", "支持 GET"]. */
      badges: z.array(z.string()).optional(),
    }),
    postprocess: {
      // Markdown for LLMs: our MDX components become placeholders, rendered in `docsLlms` below.
      includeProcessedMarkdown: {
        output: "string",
        headingIds: false,
        mdxAsPlaceholder: [
          "Callout",
          "Steps",
          "Hint",
          "Endpoint",
          "CodeBlock",
          "CodeTabs",
          "ApproachCard",
          "ButtonLink",
        ],
        // Layout-only wrappers: keep what is inside them.
        filterElement: (node) =>
          node.type === "mdxJsxFlowElement" && node.name === "div" ? "children-only" : true,
      },
    },
    // Highlight code blocks at build time with TanStack Highlight instead of Fumadocs' Shiki.
    mdxOptions: applyMdxPreset({
      rehypeCodeOptions: false,
      // Search indexes the text inside our components, not their JSX source.
      remarkStructureOptions: { filterElement: () => false },
      rehypePlugins: (plugins) => [
        [
          rehypeHighlightCodeBlocks,
          { highlighter: createHighlighter({ languages: [go, json, python, shell, ts, yaml] }) },
        ],
        ...plugins,
      ],
    }),
  },
});

export const docsSource = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
});

export const DOCS_SITE_URL = "https://mediaref.org";
