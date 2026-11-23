import { useState } from "react";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { signOut, type CurrentUser } from "#/lib/api";
import { isReviewer } from "#/lib/auth";
import ThemeToggle from "./ThemeToggle";

interface HeaderProps {
  user: CurrentUser | null;
}

export default function Header({ user }: HeaderProps) {
  const router = useRouter();
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await signOut();
    } catch {
      // Even if the session was already cleared server-side, continue to /login.
    } finally {
      await router.invalidate();
      await navigate({ to: "/login", search: {}, replace: true });
      setSigningOut(false);
    }
  }

  return (
    <header className="sticky top-0 z-50 border-b border-[var(--line)] bg-[var(--header-bg)] px-4 backdrop-blur-lg">
      <nav className="page-wrap flex flex-wrap items-center gap-x-4 gap-y-2 py-3 sm:py-3.5">
        <div className="shrink-0">
          <Link
            to={user ? "/" : "/login"}
            className="inline-flex items-center gap-2 rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3.5 py-1.5 text-sm font-bold tracking-tight text-[var(--sea-ink)] no-underline shadow-[0_6px_18px_rgba(30,90,72,0.07)]"
          >
            <span className="h-2 w-2 rounded-full bg-[linear-gradient(120deg,var(--lagoon),var(--palm))]" />
            <span>media-ref</span>
          </Link>
        </div>

        <div className="order-3 flex w-full flex-wrap items-center gap-x-5 gap-y-1 pb-1 text-sm font-semibold sm:order-none sm:w-auto sm:flex-nowrap sm:pb-0">
          {user ? (
            <>
              <Link
                to="/"
                className="nav-link"
                activeOptions={{ exact: true }}
                activeProps={{ className: "nav-link is-active" }}
              >
                工作台
              </Link>
              <Link
                to="/keys"
                className="nav-link"
                activeProps={{ className: "nav-link is-active" }}
              >
                接口密钥
              </Link>
            </>
          ) : (
            <>
              <Link
                to="/login"
                className="nav-link"
                activeProps={{ className: "nav-link is-active" }}
              >
                登录
              </Link>
              <Link
                to="/register"
                className="nav-link"
                activeProps={{ className: "nav-link is-active" }}
              >
                注册
              </Link>
            </>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {user ? (
            <>
              <div className="hidden items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--chip-bg)] px-3 py-1 text-xs sm:inline-flex">
                <span
                  className={
                    user.emailVerified
                      ? "h-2 w-2 rounded-full bg-emerald-500"
                      : "h-2 w-2 rounded-full bg-amber-500"
                  }
                  title={user.emailVerified ? "邮箱已验证" : "邮箱未验证"}
                />
                <span className="max-w-[11rem] truncate font-semibold text-[var(--sea-ink)]">
                  {user.name || user.email}
                </span>
                {isReviewer(user) ? (
                  <span className="rounded-full bg-[var(--ok-bg)] px-2 py-0.5 text-[11px] font-bold text-[var(--ok-ink)]">
                    审核员
                  </span>
                ) : null}
              </div>
              <button
                type="button"
                onClick={handleSignOut}
                disabled={signingOut}
                className="cursor-pointer rounded-full border border-[var(--line)] bg-[var(--chip-bg)] px-3 py-1.5 text-xs font-semibold text-[var(--sea-ink-soft)] transition hover:bg-[var(--link-bg-hover)] hover:text-[var(--sea-ink)] disabled:cursor-not-allowed disabled:opacity-55"
              >
                {signingOut ? "退出中..." : "退出登录"}
              </button>
            </>
          ) : null}

          <ThemeToggle />
        </div>
      </nav>
    </header>
  );
}
