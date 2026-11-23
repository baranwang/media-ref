import type { ReactNode } from "react";
import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRoute,
  redirect,
} from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { TanStackDevtools } from "@tanstack/react-devtools";
import Footer from "#/components/Footer";
import Header from "#/components/Header";
import type { CurrentUser } from "#/lib/api";
import { fetchCurrentUser, isPublicPathname, sanitizeRedirectPath } from "#/lib/auth";
import appCss from "../styles.css?url";

const THEME_INIT_SCRIPT = `(function(){try{var stored=window.localStorage.getItem('theme');var mode=(stored==='light'||stored==='dark'||stored==='auto')?stored:'auto';var prefersDark=window.matchMedia('(prefers-color-scheme: dark)').matches;var resolved=mode==='auto'?(prefersDark?'dark':'light'):mode;var root=document.documentElement;root.classList.remove('light','dark');root.classList.add(resolved);if(mode==='auto'){root.removeAttribute('data-theme')}else{root.setAttribute('data-theme',mode)}root.style.colorScheme=resolved;}catch(e){}})();`;

export const Route = createRootRoute({
  beforeLoad: async ({ location }) => {
    let user: CurrentUser | null = null;
    try {
      user = await fetchCurrentUser();
    } catch {
      user = null;
    }

    if (!user && !isPublicPathname(location.pathname)) {
      const target = sanitizeRedirectPath(location.href ?? location.pathname);
      throw redirect({
        to: "/login",
        search: target && target !== "/" ? { redirect: target } : {},
      });
    }

    return { user };
  },

  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        title: "media-ref · 媒体与平台关联的开放数据库",
      },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),

  component: RootLayout,
  notFoundComponent: NotFoundView,
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <HeadContent />
      </head>
      <body className="font-sans [overflow-wrap:anywhere] antialiased selection:bg-[rgba(79,184,178,0.24)]">
        {children}
        {import.meta.env.DEV ? (
          <TanStackDevtools
            config={{
              position: "bottom-right",
            }}
            plugins={[
              {
                name: "TanStack Router",
                render: <TanStackRouterDevtoolsPanel />,
              },
            ]}
          />
        ) : null}
        <Scripts />
      </body>
    </html>
  );
}

function RootLayout() {
  const { user } = Route.useRouteContext();

  return (
    <div className="flex min-h-screen flex-col">
      <Header user={user} />
      <div className="flex-1">
        <Outlet />
      </div>
      <Footer />
    </div>
  );
}

function NotFoundView() {
  return (
    <main className="page-wrap px-4 py-16">
      <section className="island-shell mx-auto max-w-lg rounded-3xl p-8 text-center">
        <p className="island-kicker mb-2">404</p>
        <h1 className="display-title m-0 mb-3 text-3xl font-bold text-[var(--sea-ink)]">
          页面不存在
        </h1>
        <p className="m-0 mb-6 text-sm text-[var(--sea-ink-soft)]">
          未找到对应的路由，请返回工作台或密钥管理页。
        </p>
        <div className="flex justify-center gap-3">
          <Link to="/keys" className="btn-primary">
            前往接口密钥
          </Link>
          <Link to="/" className="btn-secondary">
            返回工作台
          </Link>
        </div>
      </section>
    </main>
  );
}
