import { createHighlighter } from "@tanstack/highlight/core";
import { go } from "@tanstack/highlight/languages/go";
import { json } from "@tanstack/highlight/languages/json";
import { python } from "@tanstack/highlight/languages/python";
import { shell } from "@tanstack/highlight/languages/shell";
import { ts } from "@tanstack/highlight/languages/ts";
import { rehypeHighlightCodeBlocks } from "@tanstack/highlight/rehype";
import { loader } from "fumadocs-core/source";
import { pageSchema } from "fumadocs-core/source/schema";
import { applyMdxPreset } from "fumadocs-mdx/config";
import { defineDocs } from "fumadocs-mdx/macro";
import { z } from "zod";

const docs = defineDocs({
  dir: "content/docs",
  docs: {
    schema: pageSchema.extend({
      /** Shown above the title, e.g. "文档 / 入门". */
      breadcrumb: z.string(),
      /** Small badges next to the title, e.g. ["只读", "支持 GET"]. */
      badges: z.array(z.string()).optional(),
    }),
    // Highlight code blocks at build time with TanStack Highlight instead of Fumadocs' Shiki.
    mdxOptions: applyMdxPreset({
      rehypeCodeOptions: false,
      rehypePlugins: (plugins) => [
        [
          rehypeHighlightCodeBlocks,
          { highlighter: createHighlighter({ languages: [go, json, python, shell, ts] }) },
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
