import { redirect } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { getCurrentUser, listApiKeys, type ApiKeyListResponse, type CurrentUser } from "./api";

export interface AuthContext {
  user: CurrentUser | null;
}

export interface AuthLocationLike {
  pathname: string;
  href?: string;
}

const PUBLIC_EXACT_PATHS = new Set(["/login", "/register"]);

/**
 * Per Spec #1 and Tickets #23/#25, all routes require authentication EXCEPT:
 * - `/login` and `/register`
 * - `/media/:key` anonymous single-media pages (implemented in #25)
 */
export function isPublicPathname(pathname: string): boolean {
  const normalized =
    pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  if (PUBLIC_EXACT_PATHS.has(normalized)) {
    return true;
  }
  return normalized.startsWith("/media/") && normalized.length > "/media/".length;
}

export function sanitizeRedirectPath(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return undefined;
  }
  if (trimmed === "/login" || trimmed.startsWith("/login?")) {
    return undefined;
  }
  return trimmed;
}

export function isReviewer(user: CurrentUser | null | undefined): boolean {
  return user?.role === "reviewer" || user?.role === "owner";
}

export const fetchCurrentUser = createIsomorphicFn()
  .server(async (): Promise<CurrentUser | null> => {
    const cookieHeader = getRequestHeader("cookie");
    if (!cookieHeader) {
      return null;
    }
    return getCurrentUser(cookieHeader);
  })
  .client(async (): Promise<CurrentUser | null> => {
    return getCurrentUser();
  });

export const fetchApiKeys = createIsomorphicFn()
  .server(async (): Promise<ApiKeyListResponse> => {
    const cookieHeader = getRequestHeader("cookie");
    if (!cookieHeader) {
      return { apiKeys: [], total: 0 };
    }
    return listApiKeys(cookieHeader);
  })
  .client(async (): Promise<ApiKeyListResponse> => {
    return listApiKeys();
  });

/**
 * Reusable `beforeLoad` guard for authenticated routes (including Ticket #24 routes).
 * Returns a narrowed `{ user: CurrentUser }` context or throws a redirect to `/login`.
 */
export function requireLogin(
  context: AuthContext,
  location: AuthLocationLike,
): { user: CurrentUser } {
  if (!context.user) {
    const target = sanitizeRedirectPath(location.href ?? location.pathname);
    throw redirect({
      to: "/login",
      search: target && target !== "/" ? { redirect: target } : {},
    });
  }

  return { user: context.user };
}

/**
 * Reusable `beforeLoad` guard for reviewer-only routes (such as the review queue in Ticket #24).
 */
export function requireReviewer(
  context: AuthContext,
  location: AuthLocationLike,
): { user: CurrentUser } {
  const { user } = requireLogin(context, location);
  if (!isReviewer(user)) {
    throw redirect({ to: "/" });
  }
  return { user };
}
