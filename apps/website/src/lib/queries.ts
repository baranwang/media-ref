import { proto } from "@media-ref/client";
import { queryOptions } from "@tanstack/react-query";
import { createBrowserClients } from "./api-client";
import type { BrowseSlug } from "./catalogs";
import {
  changeRequestFromGetResponse,
  changeRequestFromProto,
  commentThreadFrom,
  REVIEW_AGENT_USER_ID,
  reviewAlertFromProto,
} from "./mappers";
import {
  fetchCardsByKey,
  fetchDemands,
  fetchMediaDetail,
  fetchSearch,
  fetchTrending,
  type BrowseFilter,
} from "./server-fns";
import type { ApiTrendDay } from "./types";

const FIVE_MINUTES = 5 * 60_000;

// ---------- Public reads (server functions → API over the service binding) ----------

export const trendingQuery = (namespace: BrowseSlug, type: BrowseFilter = "all", limit?: number) =>
  queryOptions({
    queryKey: ["trending", namespace, type, limit ?? null],
    queryFn: () => fetchTrending({ data: { namespace, type, ...(limit ? { limit } : {}) } }),
    staleTime: FIVE_MINUTES,
  });

export const demandsQuery = (limit = 20, offset = 0) =>
  queryOptions({
    queryKey: ["demands", limit, offset],
    queryFn: () => fetchDemands({ data: { limit, offset } }),
    staleTime: 60_000,
  });

export const searchQuery = (query: string) =>
  queryOptions({
    queryKey: ["search", query.trim()],
    queryFn: () => fetchSearch({ data: { query: query.trim() } }),
    enabled: query.trim().length > 0,
    staleTime: FIVE_MINUTES,
  });

export const mediaDetailQuery = (id: string) =>
  queryOptions({
    queryKey: ["media", id],
    queryFn: () => fetchMediaDetail({ data: { id } }),
    staleTime: 60_000,
  });

export const cardsByKeyQuery = (keys: string[]) =>
  queryOptions({
    queryKey: ["cards", [...new Set(keys)].sort()],
    queryFn: () => fetchCardsByKey({ data: { keys } }),
    enabled: keys.length > 0,
    staleTime: FIVE_MINUTES,
  });

// ---------- Signed-in reads (browser → api.mediaref.org with the session cookie) ----------

export function browserClients() {
  const clients = createBrowserClients();
  if (!clients) {
    throw new Error("未配置 API 服务地址");
  }
  return clients;
}

export const myChangeRequestsQuery = () =>
  queryOptions({
    queryKey: ["my-change-requests"],
    queryFn: async () => {
      const res = await browserClients().changeRequest.listMyChangeRequests({ limit: 100 });
      return res.changeRequests.map(changeRequestFromProto);
    },
  });

export const changeRequestQuery = (id: string) =>
  queryOptions({
    queryKey: ["change-request", id],
    queryFn: async () => {
      return changeRequestFromGetResponse(
        await browserClients().changeRequest.getChangeRequest({ id }),
      );
    },
  });

export const changeRequestCommentsQuery = (id: string) =>
  queryOptions({
    queryKey: ["change-request-comments", id],
    queryFn: async () => {
      const res = await browserClients().changeRequest.listChangeRequestComments({
        changeRequestId: id,
      });
      return commentThreadFrom(res.comments);
    },
    // The review agent answers within minutes: look again while a comment waits for it.
    refetchInterval: (query) => (query.state.data?.some((c) => c.waiting) ? 15_000 : false),
  });

export const reviewQueueQuery = () =>
  queryOptions({
    queryKey: ["review-queue"],
    queryFn: async () => {
      const reviewer = browserClients().reviewer;
      const [needsReview, pending] = await Promise.all([
        reviewer.listChangeRequests({ status: proto.ChangeRequestStatus.NEEDS_REVIEW, limit: 100 }),
        reviewer.listChangeRequests({
          status: proto.ChangeRequestStatus.PENDING_EVIDENCE,
          limit: 100,
        }),
      ]);
      return [...needsReview.changeRequests, ...pending.changeRequests]
        .map(changeRequestFromProto)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
  });

/** Change requests the review agent approved, latest first, for spot checks. */
export const agentApprovalsQuery = () =>
  queryOptions({
    queryKey: ["agent-approvals"],
    queryFn: async () => {
      const res = await browserClients().reviewer.listChangeRequests({
        status: proto.ChangeRequestStatus.APPROVED,
        reviewerUserId: REVIEW_AGENT_USER_ID,
        limit: 100,
      });
      return res.changeRequests.map(changeRequestFromProto);
    },
  });

export const reviewAlertsQuery = () =>
  queryOptions({
    queryKey: ["review-alerts"],
    queryFn: async () => {
      const res = await browserClients().reviewer.listReviewAlerts({
        status: proto.ReviewAlertStatus.OPEN,
        limit: 100,
      });
      return res.alerts.map(reviewAlertFromProto);
    },
  });

export interface ApiUsageData {
  days: ApiTrendDay[];
  lastUsed: Record<string, string>;
}

export const apiKeysQuery = () =>
  queryOptions({
    queryKey: ["api-keys"],
    queryFn: async () => {
      const res = await browserClients().account.listApiKeys({});
      return res.apiKeys;
    },
  });

export const apiUsageQuery = (days = 14) =>
  queryOptions({
    queryKey: ["api-usage", days],
    queryFn: async (): Promise<ApiUsageData> => {
      const res = await browserClients().account.getApiUsage({ days });
      return {
        days: res.days.map((d) => ({
          date: d.date.slice(5),
          found: Number(d.found),
          notFound: Number(d.notFound),
          submitted: Number(d.submitted),
        })),
        lastUsed: Object.fromEntries(res.lastUsed.map((u) => [u.keyId, u.lastUsedAt])),
      };
    },
  });

export const associationRevisionsQuery = (associationId: string) =>
  queryOptions({
    queryKey: ["association-revisions", associationId],
    queryFn: async () => {
      const res = await browserClients().association.listAssociationRevisions({
        associationId,
        limit: 50,
      });
      return res.revisions;
    },
  });
