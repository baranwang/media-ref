import { create } from "@bufbuild/protobuf";
import { ConnectError, createClient, type Interceptor, type Transport } from "@connectrpc/connect";
import type { ApiApp } from "@media-ref/api/app";
import {
  createMediaRefTransport,
  extractConnectErrorInfo,
  fromProtoAssociationStatus,
  fromProtoBatchItemResult,
  fromProtoChangeRequestStatus,
  fromProtoMediaDocument,
  fromProtoMediaQueryItem,
  fromProtoMediaRef,
  fromProtoReviewAlertStatus,
  fromProtoSegment,
  proto,
  toProtoChangeRequestStatus,
  toProtoMediaRefFromInput,
  toProtoReviewAlertStatus,
  toProtoSegmentInput,
  type ExtractedConnectErrorInfo,
  type MediaDocument,
  type MediaRef,
  type SegmentInput,
} from "@media-ref/client";
import type { createFakeOutboundClient, EmailMessage } from "@media-ref/core";
import { expect } from "vite-plus/test";

export const TEST_BASE_URL = "https://api.mediaref.org";

export function mediaRef(input: MediaRef | proto.MediaRef | string): proto.MediaRef {
  return toProtoMediaRefFromInput(input) ?? create(proto.MediaRefSchema);
}

export function extractCookieHeader(response: Response): string {
  const setCookies = response.headers.getSetCookie();
  return setCookies
    .map((entry) => entry.split(";")[0]?.trim())
    .filter((pair): pair is string => Boolean(pair))
    .join("; ");
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

export async function signUpAndVerifyUser(
  app: ApiApp,
  outbound: ReturnType<typeof createFakeOutboundClient>,
  input: { email: string; password?: string; name?: string },
): Promise<{ userId: string; cookie: string }> {
  const emailsBefore = outbound.sentEmails.length;
  const signUpRes = await app.fetch(
    new Request(`${TEST_BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: input.email,
        password: input.password ?? "StrongPassword123!",
        name: input.name ?? "Test User",
      }),
    }),
  );
  expect(signUpRes.status).toBe(200);
  const signUpBody = (await signUpRes.json()) as { user: { id: string } };
  let cookie = extractCookieHeader(signUpRes);

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

  return { userId: signUpBody.user.id, cookie };
}

export async function issueApiKeyRpc(
  app: ApiApp,
  cookie: string,
  options: { name?: string; canSubmit?: boolean; expiresIn?: number },
): Promise<{ id: string; key: string; canSubmit: boolean }> {
  const res = await createRpcClients(app, { cookie }).account.createApiKey({
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(options.canSubmit !== undefined ? { canSubmit: options.canSubmit } : {}),
    ...(options.expiresIn !== undefined ? { expiresIn: options.expiresIn } : {}),
  });
  return {
    id: res.apiKey!.id,
    key: res.key,
    canSubmit: res.apiKey!.canSubmit,
  };
}

export async function getMediaDocumentRpc(
  app: ApiApp,
  apiKey: string,
  refInput: MediaRef | proto.MediaRef | string,
  options?: {
    includeUnconfirmed?: boolean;
    season?: number;
    namespaceGroup?: proto.NamespaceGroup;
  },
): Promise<{
  ref: MediaRef | null;
  key: string;
  document: MediaDocument;
  matchedAssociationId: string | null;
}> {
  const res = await createRpcClients(app, { apiKey }).media.getMedia({
    ref: mediaRef(refInput),
    includeUnconfirmed: options?.includeUnconfirmed ?? false,
    ...(options?.season !== undefined ? { season: options.season } : {}),
    ...(options?.namespaceGroup !== undefined ? { namespaceGroup: options.namespaceGroup } : {}),
  });
  const decoded = fromProtoMediaRef(res.ref);
  return {
    ref: decoded.ok ? decoded.ref : null,
    key: decoded.ok ? decoded.key : "",
    document: fromProtoMediaDocument(res.document!),
    matchedAssociationId: res.matchedAssociationId ?? null,
  };
}

export async function getChangeRequestStateRpc(
  app: ApiApp,
  auth: { apiKey?: string; cookie?: string },
  id: string,
) {
  const res = await createRpcClients(app, auth).changeRequest.getChangeRequest({ id });
  const cr = res.changeRequest!;
  const decodedTarget = fromProtoMediaRef(cr.target, { mode: "target" });
  return {
    ...cr,
    status: fromProtoChangeRequestStatus(cr.status) ?? "pending_evidence",
    targetExternalKey: decodedTarget.ok ? decodedTarget.key : "",
    reviewerUserId: cr.reviewerUserId ?? null,
    decisionReason: cr.decisionReason ?? null,
    conflictReason: cr.conflictReason ?? null,
    mediaId: cr.mediaId ?? null,
    appliedAssociationId: cr.appliedAssociationId ?? null,
    appliedRevisionId: cr.appliedRevisionId ?? null,
    replacesAssociationId: cr.replacesAssociationId ?? null,
    evidence: (cr.evidence as Record<string, unknown> | undefined) ?? null,
    segments: cr.segments.map(fromProtoSegment),
  };
}

/** Uses the same lock-checked approval transaction as the review agent. */
export { approveWithReviewChecks as approveInCore } from "../../api/tests/rpc-helpers.ts";

export {
  fromProtoAssociationStatus,
  fromProtoBatchItemResult,
  fromProtoChangeRequestStatus,
  fromProtoMediaDocument,
  fromProtoMediaQueryItem,
  fromProtoMediaRef,
  fromProtoReviewAlertStatus,
  fromProtoSegment,
  proto,
  toProtoChangeRequestStatus,
  toProtoReviewAlertStatus,
  toProtoSegmentInput,
};
export type { MediaRef, SegmentInput };
