import { renderPlaceholder } from "fumadocs-core/mdx-plugins/remark-llms.runtime";
import { llms } from "fumadocs-core/source";
import type { ReactNode } from "react";
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

${page.data.description ? `> ${page.data.description}\n\n` : ""}${(await renderPlaceholder(await page.data.getText("processed"), placeholders)).replace(/^# .*\n+/, "")}`,
});

export const DOCS_LLMS_TXT = "/docs/llms.txt";

/** `Link` header pointing an agent from a Markdown file to the llms.txt that covers it. */
export const DESCRIBED_BY = `<${DOCS_LLMS_TXT}>; rel="describedby"`;

/** Page tree names are plain strings here (from frontmatter and meta.json). */
const label = (name: ReactNode) => (typeof name === "string" ? name : "");

function pageLink(url: string): string {
  const page = docsSource.getPages().find((p) => p.url === url);
  if (!page) return "";
  const { title, description } = page.data;
  return `- [${title}](${DOCS_SITE_URL}${url}.md)${description ? `: ${description}` : ""}`;
}

/**
 * `/docs/llms.txt` in the llmstxt.org v2 format: an H1, a summary blockquote, notes, then H2
 * sections of links, with the bulk files under the conventional "Optional" section.
 */
export function docsLlmsIndex(): string {
  const out = [
    "# MediaRef 开发者文档",
    "",
    "> MediaRef 的公开 API：用 TMDB、豆瓣、Bangumi 等编号查一部作品在各视频平台上对应哪个页面、分集怎么对上，也能提交和查询对应关系。",
    "",
    "接口地址是 https://api.mediaref.org，协议是 Connect（JSON 或 Protobuf），每个请求都要带 API 密钥。这里只收录公开的 mediaref.v1 接口。",
  ];
  const sections: string[] = [];
  let group = "";
  let open = "";
  const heading = (title: string) => {
    if (open === title) return;
    out.push("", `## ${title}`, "");
    open = title;
  };
  for (const node of docsSource.getPageTree().children) {
    if (node.type === "separator") {
      group = label(node.name);
    } else if (node.type === "page") {
      heading(group);
      out.push(pageLink(node.url));
    } else {
      const pages = node.children.filter((child) => child.type === "page");
      heading(`${group} · ${label(node.name)}`);
      for (const page of pages) out.push(pageLink(page.url));
      const first = pages[0];
      if (first) {
        const dir = first.url.slice(0, first.url.lastIndexOf("/"));
        sections.push(`- [${label(node.name)} 全文](${DOCS_SITE_URL}${dir}/llms-full.txt)`);
      }
    }
  }
  out.push(
    "",
    "## Optional",
    "",
    `- [全部文档](${DOCS_SITE_URL}/docs/llms-full.txt): 所有页面合在一份 Markdown 里`,
    ...sections,
  );
  return `${out.filter((line, i) => line !== "" || out[i - 1] !== "").join("\n")}\n`;
}

/** `/llms.txt`: what MediaRef is, pointing agents to the docs' own llms.txt. */
export function siteLlmsIndex(): string {
  return `# MediaRef

> MediaRef 汇总 TMDB、豆瓣、Bangumi 等影视条目在哔哩哔哩、腾讯视频、爱奇艺、优酷、芒果 TV 上的播放链接与分集覆盖，一眼看到这部剧在哪儿能看。

MediaRef 是一个开放的影视对应关系数据库：把目录站的条目对到各视频平台的具体页面，精确到季和集。数据通过公开 API 提供，调用需要 API 密钥。

## 开发者文档

- [开发者文档索引](${DOCS_SITE_URL}${DOCS_LLMS_TXT}): 公开 API 的全部文档，按入门、接口参考、接入方式分组
- [快速开始](${DOCS_SITE_URL}/docs/quickstart.md): 拿一把 API 密钥，查到某一集在哪个平台的哪个页面

## Optional

- [全部文档](${DOCS_SITE_URL}/docs/llms-full.txt): 所有文档页面合在一份 Markdown 里
`;
}

export function markdownResponse(body: string): Response {
  return new Response(body, {
    headers: { "Content-Type": "text/markdown; charset=utf-8", Link: DESCRIBED_BY },
  });
}
