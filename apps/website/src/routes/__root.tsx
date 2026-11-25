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

const SITE_URL = "https://mediaref.org";
const SITE_TITLE = "MediaRef · 这部剧，在哪儿能看？";
const SITE_DESCRIPTION =
  "MediaRef 汇总 TMDB、豆瓣、Bangumi 等影视条目在哔哩哔哩、腾讯视频、爱奇艺、优酷、芒果 TV 上的播放链接与分集覆盖，一眼看到这部剧在哪儿能看。";

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: SITE_TITLE },
      { name: "description", content: SITE_DESCRIPTION },
      { name: "theme-color", content: "#0a0a0a" },
      { property: "og:site_name", content: "MediaRef" },
      { property: "og:type", content: "website" },
      { property: "og:locale", content: "zh_CN" },
      { property: "og:image", content: `${SITE_URL}/og-image.png` },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
      { rel: "icon", href: "/favicon.ico", sizes: "32x32" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
      // Google Fonts via <link> so Cloudflare Fonts can rewrite it to our own origin
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@700&family=Noto+Serif+SC:wght@700&display=swap",
      },
      { rel: "stylesheet", href: appCss },
    ],
    // Umami analytics; production only so local dev doesn't pollute the stats.
    scripts: import.meta.env.PROD
      ? [
          {
            src: "https://u.baran.wang/script.js",
            defer: true,
            "data-website-id": "a050b039-41fc-4d3a-9482-c733864df7af",
          },
        ]
      : [],
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
