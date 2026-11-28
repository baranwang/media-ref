import { redirect } from "@tanstack/react-router";
import { createMiddleware, createStart } from "@tanstack/react-start";
import { isMarkdownPreferred } from "fumadocs-core/negotiation";

/** Agents that ask for Markdown (`Accept: text/markdown`) get the `.md` of a docs page. */
const docsMarkdownMiddleware = createMiddleware().server(({ next, request }) => {
  const url = new URL(request.url);
  if (
    url.pathname.startsWith("/docs/") &&
    !/\.(md|txt)$/.test(url.pathname) &&
    isMarkdownPreferred(request)
  ) {
    url.pathname += ".md";
    // The same URL has two representations, so caches must key on Accept.
    throw redirect({ href: url.href, headers: { Vary: "Accept" } });
  }
  return next();
});

export const startInstance = createStart(() => ({
  requestMiddleware: [docsMarkdownMiddleware],
}));
