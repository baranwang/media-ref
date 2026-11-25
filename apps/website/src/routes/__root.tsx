import { Button } from "@media-ref/ui/components/button";
import { TooltipProvider } from "@media-ref/ui/components/tooltip";
import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRouteWithContext,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AppStoreProvider } from "#/lib/app-store";
import type { RouterContext } from "#/router";
import appCss from "../styles.css?url";

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "MediaRef · 这部剧，在哪儿能看？" },
    ],
    links: [
      // Google Fonts via <link> so Cloudflare Fonts can rewrite it to our own origin
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400..700&family=Noto+Serif+SC:wght@700&display=swap",
      },
      { rel: "stylesheet", href: appCss },
    ],
  }),
  component: RootLayout,
  shellComponent: RootDocument,
  notFoundComponent: RootNotFound,
});

function RootNotFound() {
  return (
    <main className="container flex min-h-svh flex-col items-center justify-center text-center">
      <h1 className="font-display text-4xl font-bold tracking-tight text-foreground">页面不存在</h1>
      <p className="mt-2 text-sm text-muted-foreground">你访问的地址没有对应的媒体或页面。</p>
      <Button className="mt-6" nativeButton={false} render={<Link to="/" />}>
        返回发现页
      </Button>
    </main>
  );
}

function RootLayout() {
  return (
    <TooltipProvider>
      <AppStoreProvider>
        <Outlet />
      </AppStoreProvider>
    </TooltipProvider>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" className="dark" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased selection:bg-primary/25 selection:text-foreground">
        {children}
        <Scripts />
      </body>
    </html>
  );
}
