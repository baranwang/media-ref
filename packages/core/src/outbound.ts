export type ExternalTargetKind = "platform" | "catalog";

export type ExternalHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";

export interface ExternalHttpRequest {
  kind: ExternalTargetKind;
  namespace: string;
  url: string;
  method?: ExternalHttpMethod;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface ExternalHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  url: string;
}

export type NamespaceRouteConfig =
  | { mode: "direct" }
  | {
      mode: "proxy";
      proxyBaseUrl: string;
      headers?: Record<string, string>;
    };

export type OutboundProxyConfig = Partial<Record<string, NamespaceRouteConfig>>;

export interface EmailMessage {
  to: string;
  from?: string;
  subject: string;
  text: string;
  html?: string;
}

export interface CloudflareSendEmailPayload {
  from: string;
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
}

export interface CloudflareSendEmailBinding {
  send(builder: CloudflareSendEmailPayload): Promise<unknown>;
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  name?: string;
}

export interface ModelToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ModelInvocationRequest {
  model?: string;
  messages: ModelMessage[];
  tools?: ModelToolDefinition[];
  temperature?: number;
  maxTokens?: number;
}

export interface ModelInvocationResponse {
  content: string | null;
  toolCalls: ModelToolCall[];
  model: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface OutboundClient {
  fetchExternal(request: ExternalHttpRequest): Promise<ExternalHttpResponse>;
  sendEmail(message: EmailMessage): Promise<void>;
  invokeModel(request: ModelInvocationRequest): Promise<ModelInvocationResponse>;
}

export interface LiveOutboundClientOptions {
  fetchImpl?: typeof fetch;
  proxyConfig?: OutboundProxyConfig;
  sendEmail?: (message: EmailMessage) => Promise<void>;
  emailBinding?: CloudflareSendEmailBinding;
  defaultEmailFrom?: string;
  invokeModel?: (request: ModelInvocationRequest) => Promise<ModelInvocationResponse>;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key.toLowerCase()] = value;
  });
  return result;
}

function resolveExternalRequest(
  request: ExternalHttpRequest,
  proxyConfig?: OutboundProxyConfig,
): { url: string; headers?: Record<string, string> } {
  const route = proxyConfig?.[request.namespace];
  if (!route || route.mode === "direct") {
    return {
      url: request.url,
      headers: request.headers,
    };
  }

  const target = new URL(route.proxyBaseUrl);
  target.searchParams.set("url", request.url);

  const mergedHeaders =
    request.headers || route.headers
      ? {
          ...request.headers,
          ...route.headers,
        }
      : undefined;

  return {
    url: target.toString(),
    headers: mergedHeaders,
  };
}

export function createLiveOutboundClient(options: LiveOutboundClientOptions = {}): OutboundClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  return {
    async fetchExternal(request) {
      const resolved = resolveExternalRequest(request, options.proxyConfig);
      const response = await fetchImpl(resolved.url, {
        method: request.method ?? "GET",
        headers: resolved.headers,
        body: request.body,
        signal:
          request.timeoutMs !== undefined ? AbortSignal.timeout(request.timeoutMs) : undefined,
      });

      return {
        status: response.status,
        headers: headersToRecord(response.headers),
        body: await response.text(),
        url: response.url || resolved.url,
      };
    },

    async sendEmail(message) {
      if (options.sendEmail) {
        await options.sendEmail(message);
        return;
      }

      if (options.emailBinding) {
        const from = message.from ?? options.defaultEmailFrom;
        if (!from) {
          throw new Error("Outbound email sender address is not configured");
        }
        await options.emailBinding.send({
          from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          ...(message.html !== undefined ? { html: message.html } : {}),
        });
        return;
      }

      throw new Error("Outbound email transport is not configured");
    },

    async invokeModel(request) {
      if (!options.invokeModel) {
        throw new Error("Outbound model transport is not configured");
      }
      return options.invokeModel(request);
    },
  };
}

export interface FakeOutboundHandlers {
  fetchExternal?: (
    request: ExternalHttpRequest,
  ) => ExternalHttpResponse | Promise<ExternalHttpResponse>;
  sendEmail?: (message: EmailMessage) => void | Promise<void>;
  invokeModel?: (
    request: ModelInvocationRequest,
  ) => ModelInvocationResponse | Promise<ModelInvocationResponse>;
}

export interface FakeOutboundClient extends OutboundClient {
  readonly httpRequests: ExternalHttpRequest[];
  readonly sentEmails: EmailMessage[];
  readonly modelRequests: ModelInvocationRequest[];
  reset(): void;
}

export function createFakeOutboundClient(handlers: FakeOutboundHandlers = {}): FakeOutboundClient {
  const httpRequests: ExternalHttpRequest[] = [];
  const sentEmails: EmailMessage[] = [];
  const modelRequests: ModelInvocationRequest[] = [];

  return {
    httpRequests,
    sentEmails,
    modelRequests,

    reset() {
      httpRequests.length = 0;
      sentEmails.length = 0;
      modelRequests.length = 0;
    },

    async fetchExternal(request) {
      httpRequests.push(request);
      if (!handlers.fetchExternal) {
        throw new Error(
          `Unexpected outbound HTTP request for namespace "${request.namespace}" (${request.url})`,
        );
      }
      return handlers.fetchExternal(request);
    },

    async sendEmail(message) {
      sentEmails.push(message);
      if (handlers.sendEmail) {
        await handlers.sendEmail(message);
      }
    },

    async invokeModel(request) {
      modelRequests.push(request);
      if (!handlers.invokeModel) {
        throw new Error("Unexpected outbound model invocation without a stubbed handler");
      }
      return handlers.invokeModel(request);
    },
  };
}

export function parseOutboundProxyConfig(raw: string | undefined): OutboundProxyConfig {
  if (!raw || raw.trim() === "") {
    return {};
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("OUTBOUND_PROXY_CONFIG must be a JSON object");
  }
  return parsed as OutboundProxyConfig;
}
