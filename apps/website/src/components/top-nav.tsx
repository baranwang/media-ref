import { Avatar, AvatarFallback } from "@media-ref/ui/components/avatar";
import { Button } from "@media-ref/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@media-ref/ui/components/dropdown-menu";
import { cn } from "@media-ref/ui/lib/utils";
import {
  RiArrowDownSLine,
  RiCloseLine,
  RiFileList3Line,
  RiKey2Line,
  RiLogoutBoxRLine,
  RiMenuLine,
  RiSearchLine,
  RiShieldCheckLine,
} from "@remixicon/react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useAppStore } from "#/lib/app-store";
import { BrandLogo } from "./brand-logos";
import { SearchBox } from "./search-box";

interface TopNavProps {
  hideSearch?: boolean;
  transparent?: boolean;
}

export function TopNav({ hideSearch = false, transparent = false }: TopNavProps) {
  const { user, signOut } = useAppStore();
  const location = useLocation();
  const navigate = useNavigate();

  const pathname = location.pathname;
  const isReviewer = user?.role === "reviewer" || user?.role === "owner";
  const navItems = [
    { to: "/", label: "发现", active: pathname === "/" || pathname.startsWith("/discover") },
    { to: "/wanted", label: "待贡献", active: pathname.startsWith("/wanted") },
    { to: "/exploration", label: "探索动态", active: pathname.startsWith("/exploration") },
    { to: "/docs", label: "文档", active: pathname.startsWith("/docs") },
    ...(isReviewer
      ? [{ to: "/review", label: "审核", active: pathname.startsWith("/review") }]
      : []),
  ] as const;

  // Below md the bar holds only logo, search toggle and menu; links and account open in a panel under it.
  const [searchOpen, setSearchOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const searchToggleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setSearchOpen(false);
    setMenuOpen(false);
  }, [pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  const handleSignOut = async () => {
    setMenuOpen(false);
    await signOut();
    void navigate({ to: "/" });
  };

  return (
    <>
      <header
        className={cn(
          "sticky top-0 z-40 w-full border-b border-border backdrop-blur-md transition-colors",
          transparent ? "bg-card/85" : "bg-card/95",
        )}
      >
        <div className="container flex h-14 items-center justify-between gap-4">
          <div className="flex shrink-0 items-center gap-5">
            <Link
              to="/"
              aria-label="MediaRef 首页"
              className="-mx-2 flex px-2 py-2 transition-opacity hover:opacity-90 md:mx-0 md:px-0"
            >
              <BrandLogo />
            </Link>

            <nav aria-label="主导航" className="hidden items-center gap-1 md:flex">
              {navItems.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                    item.active
                      ? "bg-secondary text-secondary-foreground"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  )}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>

          {!hideSearch && (
            <div className="hidden max-w-md flex-1 md:block">
              <SearchBox size="nav" />
            </div>
          )}

          {/* Phones and small tablets */}
          <div className="flex items-center gap-1 md:hidden">
            {!hideSearch && (
              <Button
                ref={searchToggleRef}
                variant="ghost"
                size="icon"
                aria-label="搜索"
                aria-expanded={searchOpen}
                aria-controls="mobile-search"
                onClick={() => {
                  setMenuOpen(false);
                  setSearchOpen((v) => !v);
                }}
              >
                <RiSearchLine />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              aria-label={menuOpen ? "关闭菜单" : "打开菜单"}
              aria-expanded={menuOpen}
              aria-controls="mobile-menu"
              onClick={() => {
                setSearchOpen(false);
                setMenuOpen((v) => !v);
              }}
            >
              {menuOpen ? <RiCloseLine /> : <RiMenuLine />}
            </Button>
          </div>

          {/* md and up: unchanged desktop account area */}
          <div className="hidden shrink-0 items-center gap-2 md:flex">
            {user ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <button
                      type="button"
                      className="inline-flex h-7.5 items-center gap-1.5 rounded-lg border border-border bg-secondary/70 pr-2.5 pl-2 text-xs font-medium text-foreground transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none pointer-coarse:h-9"
                    />
                  }
                >
                  <Avatar size="sm" className="size-4.5">
                    <AvatarFallback className="bg-muted text-2xs font-semibold text-foreground uppercase">
                      {user.name.slice(0, 1)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="max-w-24 truncate">{user.name}</span>
                  <RiArrowDownSLine className="size-3.5 text-muted-foreground" />
                </DropdownMenuTrigger>

                <DropdownMenuContent align="end" className="min-w-44">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel className="truncate font-normal">
                      {user.email}
                    </DropdownMenuLabel>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => void navigate({ to: "/change-requests" })}>
                    <RiFileList3Line />
                    我的变更单
                  </DropdownMenuItem>
                  {isReviewer && (
                    <DropdownMenuItem onClick={() => void navigate({ to: "/review" })}>
                      <RiShieldCheckLine />
                      审核队列
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={() => void navigate({ to: "/api-keys" })}>
                    <RiKey2Line />
                    API 密钥
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => void handleSignOut()}>
                    <RiLogoutBoxRLine />
                    退出登录
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="default"
                  nativeButton={false}
                  render={<Link to="/login" />}
                >
                  登录
                </Button>
                <Button
                  variant="secondary"
                  size="default"
                  nativeButton={false}
                  render={<Link to="/signup" />}
                >
                  注册
                </Button>
              </>
            )}
          </div>
        </div>

        {!hideSearch && searchOpen && (
          <div
            id="mobile-search"
            className="container pb-3 md:hidden"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setSearchOpen(false);
                searchToggleRef.current?.focus();
              }
            }}
          >
            <SearchBox size="nav" autoFocus />
          </div>
        )}

        {menuOpen && (
          <div
            id="mobile-menu"
            className="absolute inset-x-0 top-full border-b border-border bg-card md:hidden"
          >
            <div className="container flex max-h-[calc(100dvh-3.5rem)] flex-col overflow-y-auto pb-4">
              <nav aria-label="主导航" className="flex flex-col divide-y divide-border/60">
                {navItems.map((item) => (
                  <Link
                    key={item.to}
                    to={item.to}
                    aria-current={item.active ? "page" : undefined}
                    onClick={() => setMenuOpen(false)}
                    className={cn(
                      "relative flex h-12 items-center pl-3 text-sm font-medium transition-colors",
                      item.active
                        ? "text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {item.active && (
                      <span className="absolute inset-y-3.5 left-0 w-0.5 rounded-full bg-primary" />
                    )}
                    {item.label}
                  </Link>
                ))}
              </nav>

              {user ? (
                <div className="flex flex-col divide-y divide-border/60 border-t border-border/60">
                  <div className="flex items-center gap-2.5 py-3 pl-3">
                    <Avatar size="sm" className="size-6">
                      <AvatarFallback className="bg-muted text-xs font-semibold text-foreground uppercase">
                        {user.name.slice(0, 1)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 text-xs">
                      <div className="truncate font-medium text-foreground">{user.name}</div>
                      <div className="truncate text-muted-foreground">{user.email}</div>
                    </div>
                  </div>
                  {(
                    [
                      { to: "/change-requests", label: "我的变更单", icon: RiFileList3Line },
                      { to: "/api-keys", label: "API 密钥", icon: RiKey2Line },
                    ] as const
                  ).map(({ to, label, icon: Icon }) => (
                    <Link
                      key={to}
                      to={to}
                      onClick={() => setMenuOpen(false)}
                      className="flex h-12 items-center gap-2.5 pl-3 text-sm text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <Icon className="size-4" />
                      {label}
                    </Link>
                  ))}
                  <button
                    type="button"
                    onClick={() => void handleSignOut()}
                    className="flex h-12 items-center gap-2.5 pl-3 text-left text-sm text-destructive"
                  >
                    <RiLogoutBoxRLine className="size-4" />
                    退出登录
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2 border-t border-border/60 pt-4">
                  <Button
                    variant="outline"
                    size="lg"
                    nativeButton={false}
                    render={<Link to="/login" onClick={() => setMenuOpen(false)} />}
                  >
                    登录
                  </Button>
                  <Button
                    size="lg"
                    nativeButton={false}
                    render={<Link to="/signup" onClick={() => setMenuOpen(false)} />}
                  >
                    注册
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}
      </header>
      {menuOpen && (
        // Outside <header>: its backdrop-blur would make it the box for fixed children.
        <div
          aria-hidden="true"
          className="fixed inset-x-0 top-14 bottom-0 z-30 bg-black/60 md:hidden"
          onClick={() => setMenuOpen(false)}
        />
      )}
    </>
  );
}
