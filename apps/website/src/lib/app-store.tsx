import { isPlatformNamespace, type Namespace, type PlatformNamespace } from "@media-ref/client";
import { createStore, useSelector, type Store } from "@tanstack/react-store";
import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from "react";
import { createBrowserClients, getApiBaseUrl } from "./api-client";
import {
  INITIAL_API_KEYS,
  INITIAL_CHANGE_REQUESTS,
  INITIAL_MEDIA_CATALOG,
  INITIAL_REVIEW_ALERTS,
  type ApiKeyItem,
  type ChangeRequestItem,
  type CoverageSegment,
  type MediaItem,
  type ReviewAlertItem,
} from "./catalog-data";
import { parseExternalInput, type ParsedExternalLink } from "./url-parser";

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  role: "user" | "reviewer" | "admin";
}

export interface SubmitContributionInput {
  mediaId: string;
  namespace: Namespace;
  nativeId: string;
  pageUrl: string;
  pageTitle: string;
  pageEpisodeCount?: number;
  variantLabel: string | null;
  season: number;
  episodeStart: number;
  episodeEnd: number;
  targetEpisodeStart: number;
}

export interface SearchLookupResult {
  kind: "url_match" | "title_matches";
  parsedLink?: ParsedExternalLink;
  directMatch?: MediaItem;
  matches: MediaItem[];
}

export interface AppState {
  user: CurrentUser | null;
  mediaList: MediaItem[];
  changeRequests: ChangeRequestItem[];
  reviewAlerts: ReviewAlertItem[];
  apiKeys: ApiKeyItem[];
  newlyCreatedKey: { name: string; secret: string } | null;
}

interface AppStoreActions {
  getMediaById: (id: string) => MediaItem | undefined;
  searchMedia: (query: string) => SearchLookupResult;
  signIn: (email: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  signUp: (email: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  signOut: () => Promise<void>;
  markEmailVerified: () => void;
  submitContribution: (input: SubmitContributionInput) => ChangeRequestItem;
  approveChangeRequest: (id: string, note: string) => void;
  rejectChangeRequest: (id: string, note: string) => void;
  resolveAlert: (id: string) => void;
  createApiKey: (input: {
    name: string;
    canRead: boolean;
    canSubmit: boolean;
    expiresInDays: number | null;
  }) => { item: ApiKeyItem; secret: string };
  dismissNewlyCreatedKey: () => void;
  renameApiKey: (id: string, name: string) => void;
  toggleApiKeySubmitScope: (id: string) => void;
  revokeApiKey: (id: string) => void;
}

export type AppStoreValue = AppState & AppStoreActions;

const DEFAULT_USER: CurrentUser = {
  id: "usr-demo-1",
  name: "linxiao",
  email: "hi@example.com",
  emailVerified: true,
  role: "reviewer",
};

function createInitialAppState(): AppState {
  return {
    user: DEFAULT_USER,
    mediaList: INITIAL_MEDIA_CATALOG,
    changeRequests: INITIAL_CHANGE_REQUESTS,
    reviewAlerts: INITIAL_REVIEW_ALERTS,
    apiKeys: INITIAL_API_KEYS,
    newlyCreatedKey: null,
  };
}

interface AppStoreContextPayload {
  store: Store<AppState>;
  actions: AppStoreActions;
}

const AppStoreContext = createContext<AppStoreContextPayload | null>(null);

export function AppStoreProvider({ children }: { children: ReactNode }) {
  const storeRef = useRef<Store<AppState> | null>(null);
  if (!storeRef.current) {
    storeRef.current = createStore<AppState>(createInitialAppState());
  }
  const store = storeRef.current;

  const getMediaById = useCallback(
    (id: string) => {
      const normalized = id.trim().toLowerCase();
      return store.state.mediaList.find(
        (m) =>
          m.id.toLowerCase() === normalized ||
          `tmdb:${m.type}:${m.tmdbId}` === normalized ||
          String(m.tmdbId) === normalized,
      );
    },
    [store],
  );

  const searchMedia = useCallback(
    (rawQuery: string): SearchLookupResult => {
      const q = rawQuery.trim();
      if (!q) {
        return { kind: "title_matches", matches: [] };
      }

      const mediaList = store.state.mediaList;
      const parsed = parseExternalInput(q);
      if (parsed) {
        const direct = mediaList.find((m) => {
          const ids = m.externalIds[parsed.namespace];
          if (ids?.some((id) => id.toLowerCase() === parsed.nativeId.toLowerCase())) {
            return true;
          }
          if (parsed.namespace === "tmdb" && parsed.nativeId === `${m.type}:${m.tmdbId}`) {
            return true;
          }
          return false;
        });

        return {
          kind: "url_match",
          parsedLink: parsed,
          directMatch: direct,
          matches: direct ? [direct] : [],
        };
      }

      const lower = q.toLowerCase();
      const matches = mediaList.filter(
        (m) =>
          m.title.toLowerCase().includes(lower) ||
          m.originalTitle.toLowerCase().includes(lower) ||
          m.genres.some((g) => g.toLowerCase().includes(lower)),
      );
      return { kind: "title_matches", matches };
    },
    [store],
  );

  const signIn = useCallback(
    async (email: string, password: string) => {
      const trimmedEmail = email.trim().toLowerCase();
      const apiBase = getApiBaseUrl();

      if (apiBase) {
        try {
          const res = await fetch(`${apiBase}/api/auth/sign-in/email`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ email: trimmedEmail, password }),
          });
          if (!res.ok) {
            return { ok: false, error: "邮箱或密码不对" };
          }
          const clients = createBrowserClients();
          if (clients) {
            const current = await clients.account.getCurrentUser({});
            if (current.user) {
              const u = current.user;
              store.setState((prev) => ({
                ...prev,
                user: {
                  id: u.id,
                  name: u.name || trimmedEmail.split("@")[0] || "user",
                  email: u.email,
                  emailVerified: u.emailVerified,
                  role: u.role === "admin" || u.role === "reviewer" ? u.role : "user",
                },
              }));
              return { ok: true };
            }
          }
        } catch {
          // Fall through to local validation when offline
        }
      }

      if (!trimmedEmail.includes("@") || password.length < 6 || password === "wrong") {
        return { ok: false, error: "邮箱或密码不对" };
      }

      store.setState((prev) => ({
        ...prev,
        user: {
          id: "usr-local",
          name: trimmedEmail.split("@")[0] || "linxiao",
          email: trimmedEmail,
          emailVerified: true,
          role: "reviewer",
        },
      }));
      return { ok: true };
    },
    [store],
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

      const name = trimmedEmail.split("@")[0] || "member";
      const apiBase = getApiBaseUrl();
      if (apiBase) {
        try {
          const res = await fetch(`${apiBase}/api/auth/sign-up/email`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ email: trimmedEmail, password, name }),
          });
          if (!res.ok) {
            return { ok: false, error: "注册失败，请检查邮箱是否已被注册" };
          }
        } catch {
          // Fallback locally
        }
      }

      store.setState((prev) => ({
        ...prev,
        user: {
          id: `usr-${Date.now()}`,
          name,
          email: trimmedEmail,
          emailVerified: false,
          role: "user",
        },
      }));
      return { ok: true };
    },
    [store],
  );

  const signOut = useCallback(async () => {
    const apiBase = getApiBaseUrl();
    if (apiBase) {
      try {
        await fetch(`${apiBase}/api/auth/sign-out`, {
          method: "POST",
          credentials: "include",
        });
      } catch {
        // Ignore network errors on sign-out
      }
    }
    store.setState((prev) => ({ ...prev, user: null }));
  }, [store]);

  const markEmailVerified = useCallback(() => {
    store.setState((prev) => ({
      ...prev,
      user: prev.user ? { ...prev.user, emailVerified: true } : prev.user,
    }));
  }, [store]);

  const submitContribution = useCallback(
    (input: SubmitContributionInput): ChangeRequestItem => {
      const snapshot = store.state;
      const media = snapshot.mediaList.find((m) => m.id === input.mediaId);
      const seasonInfo = media?.seasons.find((s) => s.season === input.season);
      const totalSeasonEpisodes = seasonInfo?.episodeCount ?? Math.max(input.episodeEnd, 1);

      const crNum = 232 + snapshot.changeRequests.length;
      const crId = `CR-${crNum}`;

      const existingRow = media?.platformRows.find(
        (r) =>
          r.namespace === input.namespace &&
          (!input.variantLabel || r.label === input.variantLabel.replace("（默认）", "")),
      );
      const existingSegments = existingRow?.segmentsBySeason[input.season] ?? [];

      const proposedSegment: CoverageSegment = {
        id: `seg-${crId}`,
        title: `本次提交 · ${input.episodeStart}–${input.episodeEnd}`,
        nativeId: input.nativeId,
        start: input.episodeStart,
        end: input.episodeEnd,
        targetStart: input.targetEpisodeStart,
        status: "pending",
        changeRequestId: crId,
      };

      const hasOverlap = existingSegments.some(
        (seg) => input.episodeStart <= seg.end && input.episodeEnd >= seg.start,
      );

      const newCr: ChangeRequestItem = {
        id: crId,
        mediaId: input.mediaId,
        title:
          media?.type === "movie"
            ? `${media.title} 正片`
            : `${media?.title ?? input.mediaId} 第 ${input.season} 季 第 ${input.episodeStart}–${input.episodeEnd} 集`,
        namespace: input.namespace,
        nativeId: input.nativeId,
        pageUrl: input.pageUrl,
        pageTitle: input.pageTitle,
        pageEpisodeCount: input.pageEpisodeCount ?? input.episodeEnd - input.episodeStart + 1,
        variantLabel: input.variantLabel,
        season: input.season,
        episodeStart: input.episodeStart,
        episodeEnd: input.episodeEnd,
        targetEpisodeStart: input.targetEpisodeStart,
        totalSeasonEpisodes,
        status: "needs_review",
        conflictTag: hasOverlap ? "和已有记录重叠" : "待人工确认",
        submitterName: snapshot.user?.name ?? "匿名用户",
        submittedAt: "刚刚",
        relativeTime: "刚刚",
        existingSegments,
        proposedSegment,
        effectSummary: `待审核：通过后将补充第 ${input.season} 季第 ${input.episodeStart}–${input.episodeEnd} 集的关联记录`,
        checks: [
          {
            id: `${crId}-c1`,
            title: "平台页面标题与媒体匹配",
            detail: `页面标题「${input.pageTitle}」已解析，等待审核员确认对应关系`,
            status: "needs_confirm",
          },
          {
            id: `${crId}-c2`,
            title: "集数一致",
            detail: `提交范围共 ${input.episodeEnd - input.episodeStart + 1} 集，已记录对应偏移`,
            status: "passed",
          },
          {
            id: `${crId}-c3`,
            title: hasOverlap ? "与已有记录重叠" : "不与已有记录重叠",
            detail: hasOverlap
              ? "所选集数范围与该版本已有记录存在重叠，需要审核员确认是否替换"
              : "未发现与同版本已有记录的重叠",
            status: hasOverlap ? "failed" : "passed",
          },
        ],
        timeline: [
          { label: "已提交", time: "刚刚", detail: "你提交了这张变更单", state: "done" },
          {
            label: "自动核对",
            time: "刚刚",
            detail: hasOverlap ? "发现集数重叠，已转交人工核对" : "基础校验完成，转交审核员确认",
            state: "done",
          },
          { label: "待审核", time: "进行中", detail: "已进入审核队列", state: "current" },
        ],
      };

      store.setState((prev) => {
        let nextMediaList = prev.mediaList;
        if (isPlatformNamespace(input.namespace)) {
          const ns: PlatformNamespace = input.namespace;
          const cleanVariant = (input.variantLabel ?? "默认版本").replace("（默认）", "");
          nextMediaList = prev.mediaList.map((m) => {
            if (m.id !== input.mediaId) return m;
            const matchIdx = m.platformRows.findIndex(
              (r) => r.namespace === ns && r.label === cleanVariant,
            );
            if (matchIdx >= 0) {
              const rows = [...m.platformRows];
              const target = rows[matchIdx]!;
              const prevSegs = target.segmentsBySeason[input.season] ?? [];
              rows[matchIdx] = {
                ...target,
                segmentsBySeason: {
                  ...target.segmentsBySeason,
                  [input.season]: [...prevSegs, proposedSegment],
                },
              };
              return { ...m, platformRows: rows };
            }
            return {
              ...m,
              platformRows: [
                ...m.platformRows,
                {
                  id: `row-${crId}`,
                  namespace: ns,
                  label: cleanVariant,
                  isDefault: m.platformRows.every((r) => r.namespace !== ns),
                  segmentsBySeason: {
                    [input.season]: [proposedSegment],
                  },
                },
              ],
            };
          });
        }

        return {
          ...prev,
          changeRequests: [newCr, ...prev.changeRequests],
          mediaList: nextMediaList,
        };
      });

      return newCr;
    },
    [store],
  );

  const approveChangeRequest = useCallback(
    (id: string, note: string) => {
      store.setState((prev) => {
        const target = prev.changeRequests.find((c) => c.id === id);
        const reviewerName = prev.user?.name ?? "linhai";
        const nextCrs = prev.changeRequests.map((cr) => {
          if (cr.id !== id) return cr;
          return {
            ...cr,
            status: "approved" as const,
            proposedSegment: { ...cr.proposedSegment, status: "confirmed" as const },
            effectSummary: `已生效：${cr.title} 已通过审核`,
            reviewer: {
              name: reviewerName,
              initial: reviewerName.slice(0, 1).toUpperCase(),
              time: "审核员 · 刚刚",
              comment: note.trim() || "核对无误，通过。",
            },
            timeline: [
              ...cr.timeline.map((t) => ({ ...t, state: "done" as const })),
              {
                label: "已通过",
                time: "刚刚",
                detail: `审核员 ${reviewerName} 通过，已经生效`,
                state: "done" as const,
              },
            ],
          };
        });

        let nextMediaList = prev.mediaList;
        if (target && isPlatformNamespace(target.namespace)) {
          nextMediaList = prev.mediaList.map((m) => {
            if (m.id !== target.mediaId) return m;
            return {
              ...m,
              platformRows: m.platformRows.map((row) => {
                if (row.namespace !== target.namespace) return row;
                const segs = row.segmentsBySeason[target.season] ?? [];
                const updated = segs.map((s) =>
                  s.changeRequestId === id ? { ...s, status: "confirmed" as const } : s,
                );
                return {
                  ...row,
                  segmentsBySeason: {
                    ...row.segmentsBySeason,
                    [target.season]: updated,
                  },
                };
              }),
            };
          });
        }

        return {
          ...prev,
          changeRequests: nextCrs,
          mediaList: nextMediaList,
        };
      });
    },
    [store],
  );

  const rejectChangeRequest = useCallback(
    (id: string, note: string) => {
      store.setState((prev) => {
        const reviewerName = prev.user?.name ?? "linhai";
        return {
          ...prev,
          changeRequests: prev.changeRequests.map((cr) => {
            if (cr.id !== id) return cr;
            return {
              ...cr,
              status: "rejected" as const,
              reviewer: {
                name: reviewerName,
                initial: reviewerName.slice(0, 1).toUpperCase(),
                time: "审核员 · 刚刚",
                comment: note.trim() || "提交信息与页面核对不符，请修正后重新提交。",
              },
              timeline: [
                ...cr.timeline.map((t) => ({ ...t, state: "done" as const })),
                {
                  label: "已驳回",
                  time: "刚刚",
                  detail: `审核员 ${reviewerName} 驳回`,
                  state: "done" as const,
                },
              ],
            };
          }),
        };
      });
    },
    [store],
  );

  const resolveAlert = useCallback(
    (id: string) => {
      store.setState((prev) => ({
        ...prev,
        reviewAlerts: prev.reviewAlerts.map((a) => (a.id === id ? { ...a, resolved: true } : a)),
      }));
    },
    [store],
  );

  const createApiKey = useCallback(
    (input: {
      name: string;
      canRead: boolean;
      canSubmit: boolean;
      expiresInDays: number | null;
    }) => {
      const randHex = Array.from({ length: 24 }, () =>
        Math.floor(Math.random() * 16).toString(16),
      ).join("");
      const shortPrefix = randHex.slice(0, 4);
      const secret = `mr_live_${shortPrefix}_${randHex.slice(4)}`;
      const today = new Date().toISOString().slice(0, 10);
      const item: ApiKeyItem = {
        id: `key-${Date.now()}`,
        name: input.name.trim() || "未命名密钥",
        prefix: `mr_live_${shortPrefix}••••`,
        canRead: input.canRead,
        canSubmit: input.canSubmit,
        createdAt: today,
        lastUsed: "尚未使用",
        expiresInDays: input.expiresInDays,
      };
      store.setState((prev) => ({
        ...prev,
        apiKeys: [item, ...prev.apiKeys],
        newlyCreatedKey: { name: item.name, secret },
      }));
      return { item, secret };
    },
    [store],
  );

  const dismissNewlyCreatedKey = useCallback(() => {
    store.setState((prev) => ({ ...prev, newlyCreatedKey: null }));
  }, [store]);

  const renameApiKey = useCallback(
    (id: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      store.setState((prev) => ({
        ...prev,
        apiKeys: prev.apiKeys.map((k) => (k.id === id ? { ...k, name: trimmed } : k)),
      }));
    },
    [store],
  );

  const toggleApiKeySubmitScope = useCallback(
    (id: string) => {
      store.setState((prev) => ({
        ...prev,
        apiKeys: prev.apiKeys.map((k) => (k.id === id ? { ...k, canSubmit: !k.canSubmit } : k)),
      }));
    },
    [store],
  );

  const revokeApiKey = useCallback(
    (id: string) => {
      store.setState((prev) => ({
        ...prev,
        apiKeys: prev.apiKeys.filter((k) => k.id !== id),
      }));
    },
    [store],
  );

  const actions = useMemo<AppStoreActions>(
    () => ({
      getMediaById,
      searchMedia,
      signIn,
      signUp,
      signOut,
      markEmailVerified,
      submitContribution,
      approveChangeRequest,
      rejectChangeRequest,
      resolveAlert,
      createApiKey,
      dismissNewlyCreatedKey,
      renameApiKey,
      toggleApiKeySubmitScope,
      revokeApiKey,
    }),
    [
      getMediaById,
      searchMedia,
      signIn,
      signUp,
      signOut,
      markEmailVerified,
      submitContribution,
      approveChangeRequest,
      rejectChangeRequest,
      resolveAlert,
      createApiKey,
      dismissNewlyCreatedKey,
      renameApiKey,
      toggleApiKeySubmitScope,
      revokeApiKey,
    ],
  );

  const contextValue = useMemo(() => ({ store, actions }), [store, actions]);

  return <AppStoreContext.Provider value={contextValue}>{children}</AppStoreContext.Provider>;
}

export function useAppSelector<T>(selector: (state: AppState) => T): T {
  const ctx = useContext(AppStoreContext);
  if (!ctx) {
    throw new Error("useAppSelector must be used inside AppStoreProvider");
  }
  return useSelector(ctx.store, selector);
}

export function useAppStore(): AppStoreValue {
  const ctx = useContext(AppStoreContext);
  if (!ctx) {
    throw new Error("useAppStore must be used inside AppStoreProvider");
  }
  const state = useSelector(ctx.store, (s) => s);
  return useMemo(() => ({ ...state, ...ctx.actions }), [state, ctx.actions]);
}
