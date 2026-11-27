import { create } from "@bufbuild/protobuf";
import { ConnectError, createClient, type Interceptor, type Transport } from "@connectrpc/connect";
import {
  createMediaRefTransport,
  extractConnectErrorInfo,
  proto,
  toProtoMediaRefFromInput,
  type ExtractedConnectErrorInfo,
  type MediaRef,
} from "@media-ref/client";
import {
  approveChangeRequestInTransaction,
  ensureReviewAgentUser,
  getChangeRequestById,
  MediaServiceError,
  resolveCatalogTargetSnapshot,
  type createFakeOutboundClient,
  type EmailMessage,
  type OutboundClient,
  type TmdbGatewayConfig,
} from "@media-ref/core";
import type { Db } from "@media-ref/db";
import { expect } from "vite-plus/test";
import type { ApiApp } from "../src/app.ts";
import { rethrowDomainError } from "../src/context.ts";
import { toProtoChangeRequest } from "../src/proto-records.ts";

export function mediaRef(input: MediaRef | proto.MediaRef | string): proto.MediaRef {
  return toProtoMediaRefFromInput(input) ?? create(proto.MediaRefSchema);
}

export const TEST_BASE_URL = "https://api.mediaref.org";

export function extractCookieHeader(response: Response): string {
  const setCookies = response.headers.getSetCookie();
  return setCookies
    .map((entry) => entry.split(";")[0]?.trim())
    .filter((pair): pair is string => Boolean(pair))
    .join("; ");
}

export function mergeCookies(...cookieHeaders: string[]): string {
  const jar = new Map<string, string>();
  for (const header of cookieHeaders) {
    for (const part of header.split(";")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex <= 0) continue;
      const name = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim();
      jar.set(name, value);
    }
  }
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

export function extractVerificationUrl(email: EmailMessage): string {
  const match = email.text.match(/https?:\/\/\S+\/api\/auth\/verify-email\?\S+/);
  if (!match) {
    throw new Error(`No verification URL found in email text: ${email.text}`);
  }
  return match[0];
}

export interface RpcClientOptions {
  baseUrl?: string;
  apiKey?: string;
  bearerToken?: string;
  cookie?: string;
  headers?: Record<string, string>;
  useBinaryFormat?: boolean;
  useHttpGet?: boolean;
}

export function createTestTransport(
  fetchImpl: (request: Request) => Promise<Response>,
  options: RpcClientOptions = {},
): Transport {
  const interceptors: Interceptor[] = [];
  interceptors.push((next) => (req) => {
    if (options.apiKey) {
      req.header.set("x-api-key", options.apiKey);
    }
    if (options.bearerToken) {
      req.header.set("authorization", `Bearer ${options.bearerToken}`);
    }
    if (options.cookie) {
      req.header.set("cookie", options.cookie);
    }
    if (options.headers) {
      for (const [k, v] of Object.entries(options.headers)) {
        req.header.set(k, v);
      }
    }
    return next(req);
  });

  return createMediaRefTransport({
    baseUrl: options.baseUrl ?? TEST_BASE_URL,
    useBinaryFormat: options.useBinaryFormat ?? true,
    useHttpGet: options.useHttpGet ?? false,
    fetch: (input, init) => fetchImpl(new Request(input, init)),
    interceptors,
  });
}

export function createRpcClients(
  appOrFetch: ApiApp | ((request: Request) => Promise<Response>),
  options: RpcClientOptions = {},
) {
  const fetchFn =
    typeof appOrFetch === "function" ? appOrFetch : (req: Request) => appOrFetch.fetch(req);
  const transport = createTestTransport(fetchFn, options);
  return {
    transport,
    media: createClient(proto.MediaService, transport),
    changeRequest: createClient(proto.ChangeRequestService, transport),
    association: createClient(proto.AssociationService, transport),
    account: createClient(proto.AccountService, transport),
    reviewer: createClient(proto.ReviewerService, transport),
    browse: createClient(proto.BrowseService, transport),
  };
}

export interface CaughtRpcError extends ExtractedConnectErrorInfo {
  connectError: ConnectError;
}

export async function expectRpcError(promise: Promise<unknown>): Promise<CaughtRpcError> {
  try {
    await promise;
    expect.unreachable("Expected ConnectRPC call to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ConnectError);
    const connectError = error as ConnectError;
    return {
      ...extractConnectErrorInfo(connectError),
      connectError,
    };
  }
}

export async function signUpUser(
  app: ApiApp,
  outbound: ReturnType<typeof createFakeOutboundClient>,
  input: { email: string; password: string; name: string; verify?: boolean },
): Promise<{ userId: string; cookie: string }> {
  const emailsBefore = outbound.sentEmails.length;
  const signUpRes = await app.fetch(
    new Request(`${TEST_BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: input.email,
        password: input.password,
        name: input.name,
      }),
    }),
  );
  expect(signUpRes.status).toBe(200);
  const signUpBody = (await signUpRes.json()) as { user: { id: string } };
  let cookie = extractCookieHeader(signUpRes);

  if (input.verify !== false) {
    const email = outbound.sentEmails[emailsBefore];
    expect(email).toBeDefined();
    const verifyRes = await app.fetch(
      new Request(extractVerificationUrl(email!), {
        method: "GET",
        headers: { cookie },
      }),
    );
    expect([200, 302]).toContain(verifyRes.status);
    const refreshed = extractCookieHeader(verifyRes);
    if (refreshed) {
      cookie = refreshed;
    }
  }

  return { userId: signUpBody.user.id, cookie };
}

export async function issueApiKeyRpc(
  app: ApiApp,
  cookie: string,
  options: { name?: string; canSubmit?: boolean; expiresIn?: number },
): Promise<{ id: string; key: string; start: string | null; canSubmit: boolean }> {
  const rpc = createRpcClients(app, { cookie });
  const created = await rpc.account.createApiKey({
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(options.canSubmit !== undefined ? { canSubmit: options.canSubmit } : {}),
    ...(options.expiresIn !== undefined ? { expiresIn: options.expiresIn } : {}),
  });
  return {
    id: created.apiKey!.id,
    key: created.key,
    start: created.apiKey!.start ?? null,
    canSubmit: created.apiKey!.canSubmit,
  };
}

/** Prefetches outside the transaction, then approves with the review agent's status and lock checks. */
export async function approveWithReviewChecks(
  deps: { db: Db; outbound: OutboundClient; tmdb?: TmdbGatewayConfig },
  input: { id: string; reason?: string; reviewerUserId?: string },
) {
  const cr = await getChangeRequestById(deps.db, input.id);
  if (!cr) throw new MediaServiceError("CHANGE_REQUEST_NOT_FOUND", 404, "Change request not found");
  const catalog =
    cr.mediaId === null
      ? await resolveCatalogTargetSnapshot(cr.targetExternalKey, deps.outbound, {
          tmdb: deps.tmdb ?? { accessToken: "test-tmdb-token" },
        })
      : null;
  if (catalog && catalog.status !== "found") {
    throw new Error(catalog.reason ?? `Cannot prefetch ${cr.targetExternalKey}`);
  }
  const reviewerUserId = input.reviewerUserId ?? (await ensureReviewAgentUser(deps.db));
  return deps.db.transaction().execute((trx) =>
    approveChangeRequestInTransaction(trx, {
      changeRequestId: cr.id,
      reviewerUserId,
      reason: input.reason,
      evidence: cr.evidence,
      conflictReason: cr.conflictReason,
      prefetchedCatalog: catalog?.target,
      allowedStatuses: ["needs_review", "rejected"],
      replacesAssociationId: cr.replacesAssociationId,
      enforceUnlockedCheck: true,
    }),
  );
}

/** Runs the review agent's lock-checked approval transaction and returns the old RPC's shape. */
export async function approveInCore(
  deps: Parameters<typeof approveWithReviewChecks>[0],
  input: Parameters<typeof approveWithReviewChecks>[1],
): Promise<proto.ApproveChangeRequestResponse> {
  try {
    const result = await approveWithReviewChecks(deps, input);
    return create(proto.ApproveChangeRequestResponseSchema, {
      changeRequest: toProtoChangeRequest(result.changeRequest),
      mediaId: result.mediaId,
      associationId: result.associationId,
      revisionId: result.revisionId,
    });
  } catch (error) {
    rethrowDomainError(error);
  }
}
