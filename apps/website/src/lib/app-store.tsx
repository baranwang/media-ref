import { createStore, useSelector, type Store } from "@tanstack/react-store";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createBrowserClients, getApiBaseUrl } from "./api-client";

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  role: "user" | "reviewer" | "owner";
}

export interface AppState {
  user: CurrentUser | null;
  /** False until the first session check has finished. */
  sessionChecked: boolean;
}

interface AppStoreActions {
  refreshUser: () => Promise<CurrentUser | null>;
  signIn: (email: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  signUp: (email: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  signOut: () => Promise<void>;
  resendVerificationEmail: (email: string) => Promise<{ ok: boolean; error?: string }>;
}

export type AppStoreValue = AppState & AppStoreActions;

interface AppStoreContextPayload {
  store: Store<AppState>;
  actions: AppStoreActions;
}

const AppStoreContext = createContext<AppStoreContextPayload | null>(null);

function toCurrentUser(u: {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  role: string;
}): CurrentUser {
  return {
    id: u.id,
    name: u.name || u.email.split("@")[0] || "user",
    email: u.email,
    emailVerified: u.emailVerified,
    role: u.role === "owner" || u.role === "reviewer" ? u.role : "user",
  };
}

export function AppStoreProvider({ children }: { children: ReactNode }) {
  const storeRef = useRef<Store<AppState> | null>(null);
  storeRef.current ??= createStore<AppState>({ user: null, sessionChecked: false });
  const store = storeRef.current;

  const refreshUser = useCallback(async () => {
    const clients = createBrowserClients();
    let user: CurrentUser | null = null;
    if (clients) {
      try {
        const current = await clients.account.getCurrentUser({});
        user = current.user ? toCurrentUser(current.user) : null;
      } catch {
        user = null;
      }
    }
    store.setState(() => ({ user, sessionChecked: true }));
    return user;
  }, [store]);

  useEffect(() => {
    void refreshUser();
  }, [refreshUser]);

  const authFetch = useCallback(async (path: string, body?: unknown) => {
    const apiBase = getApiBaseUrl();
    if (!apiBase) {
      throw new Error("未配置 API 服务地址");
    }
    return fetch(`${apiBase}/api/auth/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body ?? {}),
    });
  }, []);

  const signIn = useCallback(
    async (email: string, password: string) => {
      try {
        const res = await authFetch("sign-in/email", {
          email: email.trim().toLowerCase(),
          password,
        });
        if (!res.ok) {
          return { ok: false, error: "邮箱或密码不对" };
        }
        await refreshUser();
        return { ok: true };
      } catch {
        return { ok: false, error: "无法连接认证服务，请稍后重试" };
      }
    },
    [authFetch, refreshUser],
  );

  const signUp = useCallback(
    async (email: string, password: string) => {
      const trimmedEmail = email.trim().toLowerCase();
      if (!trimmedEmail.includes("@")) {
        return { ok: false, error: "请输入有效的邮箱地址" };
      }
      if (password.length < 8) {
        return { ok: false, error: "密码至少需要 8 位" };
      }
      try {
        const res = await authFetch("sign-up/email", {
          email: trimmedEmail,
          password,
          name: trimmedEmail.split("@")[0] || "member",
          callbackURL: `${window.location.origin}/`,
        });
        if (!res.ok) {
          return { ok: false, error: "注册失败，请检查邮箱是否已被注册" };
        }
        await refreshUser();
        return { ok: true };
      } catch {
        return { ok: false, error: "无法连接认证服务，请稍后重试" };
      }
    },
    [authFetch, refreshUser],
  );

  const signOut = useCallback(async () => {
    try {
      await authFetch("sign-out");
    } catch {
      // The local session is cleared either way.
    }
    store.setState((prev) => ({ ...prev, user: null }));
  }, [authFetch, store]);

  const resendVerificationEmail = useCallback(
    async (email: string) => {
      try {
        const res = await authFetch("send-verification-email", {
          email,
          callbackURL: `${window.location.origin}/`,
        });
        return res.ok ? { ok: true } : { ok: false, error: "发送失败，请稍后重试" };
      } catch {
        return { ok: false, error: "无法连接认证服务，请稍后重试" };
      }
    },
    [authFetch],
  );

  const actions = useMemo<AppStoreActions>(
    () => ({ refreshUser, signIn, signUp, signOut, resendVerificationEmail }),
    [refreshUser, signIn, signUp, signOut, resendVerificationEmail],
  );
  const contextValue = useMemo(() => ({ store, actions }), [store, actions]);

  return <AppStoreContext.Provider value={contextValue}>{children}</AppStoreContext.Provider>;
}

export function useAppStore(): AppStoreValue {
  const ctx = useContext(AppStoreContext);
  if (!ctx) {
    throw new Error("useAppStore must be used inside AppStoreProvider");
  }
  const state = useSelector(ctx.store, (s) => s);
  // The server never knows the session. Until this component has mounted, report the server's
  // view so hydration matches even when the session check finished before a lazy route hydrated.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const visible = mounted ? state : SERVER_STATE;
  return useMemo(() => ({ ...visible, ...ctx.actions }), [visible, ctx.actions]);
}

const SERVER_STATE: AppState = { user: null, sessionChecked: false };
