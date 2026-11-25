import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import {
  AccountService,
  AssociationService,
  ChangeRequestService,
  MediaService,
  ReviewerService,
} from "@media-ref/client";

export function getApiBaseUrl(): string | null {
  const configured = import.meta.env.VITE_API_BASE_URL as string | undefined;
  if (!configured || configured.trim().length === 0) {
    return null;
  }
  return configured.trim().replace(/\/+$/, "");
}

export function createBrowserClients() {
  const baseUrl = getApiBaseUrl();
  if (!baseUrl) {
    return null;
  }

  const transport = createConnectTransport({
    baseUrl,
    useBinaryFormat: false,
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        credentials: "include",
      }),
  });

  return {
    baseUrl,
    account: createClient(AccountService, transport),
    media: createClient(MediaService, transport),
    changeRequest: createClient(ChangeRequestService, transport),
    association: createClient(AssociationService, transport),
    reviewer: createClient(ReviewerService, transport),
  };
}
