import { Badge } from "@media-ref/ui/components/badge";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense, use } from "react";
import { DocsLayout } from "#/components/docs/docs-layout";
import { PageActions } from "#/components/docs/page-actions";
import { docsMdxComponents } from "#/components/docs/mdx-components";
import { codeThemeCss } from "#/lib/code-theme";
import { docsSource } from "#/lib/docs-source";

function getPage(splat: string | undefined) {
  return docsSource.getPage(splat ? splat.split("/") : []);
}

export const Route = createFileRoute("/docs/$")({
  loader: async ({ params }) => {
    const page = getPage(params._splat);
    if (!page) throw notFound();
    // Load the page's chunk before render so navigation doesn't flash a fallback.
    await page.data.preload();
    return { title: page.data.title, description: page.data.description, url: page.url };
  },
  head: ({ loaderData }) => ({
    styles: [{ children: codeThemeCss }],
    // Agents reading the HTML find the Markdown of the page here.
    links: loaderData
      ? [{ rel: "alternate", type: "text/markdown", href: `${loaderData.url}.md` }]
      : [],
    meta: loaderData
      ? [
          { title: `${loaderData.title} · MediaRef 文档` },
          ...(loaderData.description
            ? [{ name: "description", content: loaderData.description }]
            : []),
        ]
      : [],
  }),
  component: DocsPage,
});

function DocsPage() {
  // On first load the loader ran on the server only, so the chunk may still be loading here.
  return (
    <Suspense>
      <DocsContent />
    </Suspense>
  );
}

function DocsContent() {
  const { _splat } = Route.useParams();
  const page = getPage(_splat)!;
  const { title, description, breadcrumb, badges } = page.data;
  const { toc, body: Body } = use(page.data.load());

  return (
    <DocsLayout toc={toc}>
      <header className="flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">{breadcrumb}</p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">{title}</h1>
          {badges?.map((badge, i) => (
            <Badge key={badge} variant={i === 0 ? "secondary" : "outline"}>
              {badge}
            </Badge>
          ))}
        </div>
        {description && <p className="text-sm leading-6 text-muted-foreground">{description}</p>}
        <PageActions url={page.url} path={page.path} />
      </header>
      {/* Prose size and colour live here so <p> inside Hint/Callout/cards inherits theirs. */}
      <div className="mt-2 flex flex-col gap-4 text-sm leading-6 text-muted-foreground">
        <Body components={docsMdxComponents} />
      </div>
    </DocsLayout>
  );
}
