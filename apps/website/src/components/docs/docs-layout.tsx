import { cn } from "@media-ref/ui/lib/utils";
import { Link, useLocation } from "@tanstack/react-router";
import { AnchorProvider, TOCItem, type TOCItemType } from "fumadocs-core/toc";
import type { ReactNode } from "react";
import { TopNav } from "#/components/top-nav";

interface NavItem {
  label: string;
  /** Docs page slug under /docs; left out for pages not written yet (rendered as plain text). */
  page?: string;
  hash?: string;
  /** RPC names render in mono and indent under their service. */
  rpc?: boolean;
}

interface NavGroup {
  title: string;
  items: Array<NavItem | { service: string }>;
}

const QUICKSTART = "quickstart";

// Only public mediaref.v1 services belong here; mediaref.internal.v1 is website-only.
const NAV: NavGroup[] = [
  {
    title: "入门",
    items: [
      { label: "概览" },
      { label: "快速开始", page: QUICKSTART },
      { label: "鉴权与限流", page: QUICKSTART, hash: "auth" },
      { label: "错误处理", page: QUICKSTART, hash: "errors" },
    ],
  },
  {
    title: "接口参考",
    items: [
      { service: "MediaService" },
      { label: "GetMedia", page: "media-service/get-media", rpc: true },
      { label: "BatchGetMedia", page: "media-service/batch-get-media", rpc: true },
      { service: "BrowseService" },
      { label: "Search", page: "browse-service/search", rpc: true },
      { label: "GetCatalogDetail", page: "browse-service/get-catalog-detail", rpc: true },
      { service: "AssociationService" },
      {
        label: "ReportInvalidation",
        page: "association-service/report-invalidation",
        rpc: true,
      },
      {
        label: "ListAssociationRevisions",
        page: "association-service/list-association-revisions",
        rpc: true,
      },
      { service: "ChangeRequestService" },
      {
        label: "CreateChangeRequest",
        page: "change-request-service/create-change-request",
        rpc: true,
      },
      {
        label: "GetChangeRequest",
        page: "change-request-service/get-change-request",
        rpc: true,
      },
      { service: "ApiKeyService" },
      { label: "GetCurrentApiKey", page: "api-key-service/get-current-api-key", rpc: true },
    ],
  },
  {
    title: "接入方式",
    items: [
      { label: "TypeScript SDK", page: QUICKSTART, hash: "typescript-sdk" },
      { label: "从 proto 生成客户端", page: QUICKSTART, hash: "proto" },
      { label: "直接调用 HTTP", page: QUICKSTART, hash: "http" },
    ],
  },
  { title: "其他", items: [{ label: "更新日志" }] },
];

function SidebarItem({ item, pathname }: { item: NavItem; pathname: string }) {
  const active = item.page !== undefined && !item.hash && `/docs/${item.page}` === pathname;
  const className = cn(
    "flex h-8 items-center rounded-md pr-2.5",
    item.rpc ? "pl-4 font-mono text-xs" : "pl-2.5 text-sm",
    active ? "bg-accent text-foreground" : "text-muted-foreground",
  );
  if (!item.page) {
    return (
      <span className={className} title="还没写">
        {item.label}
      </span>
    );
  }
  return (
    <Link
      to="/docs/$"
      params={{ _splat: item.page }}
      hash={item.hash}
      aria-current={active ? "page" : undefined}
      className={cn(className, !active && "transition-colors hover:text-foreground")}
    >
      {item.label}
    </Link>
  );
}

function Sidebar() {
  const { pathname } = useLocation();
  return (
    <nav aria-label="文档导航" className="flex flex-col gap-6">
      {NAV.map((group) => (
        <div key={group.title} className="flex flex-col gap-1">
          <p className="pb-1 pl-2.5 text-xs font-medium text-muted-foreground">{group.title}</p>
          {group.items.map((item) =>
            "service" in item ? (
              <p
                key={item.service}
                className="pt-2 pb-0.5 pl-2.5 font-mono text-xs text-muted-foreground opacity-70"
              >
                {item.service}
              </p>
            ) : (
              <SidebarItem key={item.label} item={item} pathname={pathname} />
            ),
          )}
        </div>
      ))}
    </nav>
  );
}

function OnThisPage({ toc }: { toc: TOCItemType[] }) {
  return (
    <nav aria-label="本页内容" className="flex flex-col">
      <p className="pb-3 text-sm font-bold text-foreground">本页内容</p>
      {toc.map((item) => (
        <TOCItem
          key={item.url}
          href={item.url}
          className="flex min-h-7 items-center border-l-2 border-border py-1.5 pl-3 text-xs text-muted-foreground transition-colors hover:text-foreground data-[active=true]:border-primary data-[active=true]:text-foreground"
        >
          {item.title}
        </TOCItem>
      ))}
    </nav>
  );
}

export function DocsLayout({ toc, children }: { toc: TOCItemType[]; children: ReactNode }) {
  // Only top-level sections go in the TOC; the design lists one entry per H2.
  const sections = toc.filter((item) => item.depth === 2);
  return (
    <div className="min-h-screen bg-background text-foreground">
      <TopNav />
      <AnchorProvider toc={sections} single>
        <div className="container flex items-start gap-12 pt-12 pb-24">
          <aside className="hidden w-50 shrink-0 lg:block">
            <Sidebar />
          </aside>
          <main className="min-w-0 flex-1">{children}</main>
          <aside className="sticky top-26 hidden w-46 shrink-0 xl:block">
            <OnThisPage toc={sections} />
          </aside>
        </div>
      </AnchorProvider>
    </div>
  );
}
