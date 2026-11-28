import { renderPlaceholder } from "fumadocs-core/mdx-plugins/remark-llms.runtime";
import { llms } from "fumadocs-core/source";
import { DOCS_SITE_URL, docsSource } from "./docs-source";

/** Markdown for each MDX component of the docs, see `mdx-components.tsx`. */
const placeholders: Parameters<typeof renderPlaceholder>[1] = {
  Callout: ({ attributes, children }) =>
    `> **${String(attributes.title)}**\n>\n> ${children.trim()}`,
  Steps: ({ children }) => children,
  Hint: ({ children }) => children,
  Endpoint: ({ attributes }) => `\`${String(attributes.method)} ${String(attributes.url)}\``,
  CodeBlock: ({ children }) => children,
  CodeTabs: ({ children }) => children,
  ApproachCard: ({ attributes, children }) =>
    `### [${String(attributes.title)}](${DOCS_SITE_URL}/docs/${String(attributes.page)})\n\n${children.trim()}\n\n\`\`\`\n${String(attributes.command)}\n\`\`\``,
  ButtonLink: ({ attributes, children }) =>
    `[${children.trim()}](${DOCS_SITE_URL}${String(attributes.to)})`,
};

/** The docs as Markdown for LLMs and agents: llms.txt, llms-full.txt and a `.md` for every page. */
export const docsLlms = llms(docsSource, {
  // Each service folder gets its own llms-full.txt at its folder URL, e.g. /docs/media-service/llms-full.txt.
  // Spelled out because a one-page folder would otherwise sit under that page's URL.
  section: (folder) => {
    const page = folder.children.find((node) => node.type === "page");
    return page ? { asPath: page.url.slice(0, page.url.lastIndexOf("/")) } : true;
  },
  renderPage: async (page) =>
    `# ${page.data.title} (${DOCS_SITE_URL}${page.url})

${page.data.description ? `> ${page.data.description}\n\n` : ""}${await renderPlaceholder(await page.data.getText("processed"), placeholders)}`,
});
