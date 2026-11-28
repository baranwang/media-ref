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
    // Code blocks are drawn by our own CodeBlock to match the design, so skip Shiki.
    mdxOptions: applyMdxPreset({ rehypeCodeOptions: false }),
  },
});

export const docsSource = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
});
