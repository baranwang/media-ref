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
  RiFileList3Line,
  RiKey2Line,
  RiLogoutBoxRLine,
  RiShieldCheckLine,
} from "@remixicon/react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
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
  const isDiscover = pathname === "/" || pathname.startsWith("/discover");
  const isWanted = pathname.startsWith("/wanted");
  const isReview = pathname.startsWith("/review");
  const isExploration = pathname.startsWith("/exploration");

  const handleSignOut = async () => {
    await signOut();
    void navigate({ to: "/" });
  };

  return (
    <header
      className={cn(
        "sticky top-0 z-40 h-14 w-full border-b border-border backdrop-blur-md transition-colors",
        transparent ? "bg-card/85" : "bg-card/95",
      )}
    >
      <div className="container flex h-full items-center justify-between gap-4">
        <div className="flex shrink-0 items-center gap-5">
          <Link to="/" className="flex transition-opacity hover:opacity-90">
            <BrandLogo />
          </Link>

          <nav aria-label="主导航" className="flex items-center gap-1">
            <Link
              to="/"
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                isDiscover
                  ? "bg-secondary text-secondary-foreground"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              发现
            </Link>
            <Link
              to="/wanted"
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                isWanted
                  ? "bg-secondary text-secondary-foreground"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              待贡献
            </Link>
            <Link
              to="/exploration"
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                isExploration
                  ? "bg-secondary text-secondary-foreground"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              探索动态
            </Link>
            {user && (user.role === "reviewer" || user.role === "owner") && (
              <Link
                to="/review"
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  isReview
                    ? "bg-secondary text-secondary-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
              >
                审核
              </Link>
            )}
          </nav>
        </div>

        {!hideSearch && (
          <div className="hidden max-w-md flex-1 md:block">
            <SearchBox size="nav" />
          </div>
        )}

        <div className="flex shrink-0 items-center gap-2">
          {user ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    type="button"
                    className="inline-flex h-7.5 items-center gap-1.5 rounded-lg border border-border bg-secondary/70 pr-2.5 pl-2 text-xs font-medium text-foreground transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
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
                {(user.role === "reviewer" || user.role === "owner") && (
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
    </header>
  );
}
