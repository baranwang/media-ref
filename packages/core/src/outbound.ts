import {
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type Tool,
} from "@earendil-works/pi-ai";
import {
  CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL,
  createAiBindingFetch,
  type AiBinding,
} from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { streamSimple as streamOpenAiCompletions } from "@earendil-works/pi-ai/api/openai-completions";
export type ExternalTargetKind = "platform" | "catalog" | "oauth";

export type ExternalHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";

export interface ExternalHttpRequest {
  kind: ExternalTargetKind;
  namespace: string;
  url: string;
  method?: ExternalHttpMethod;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  redirect?: "follow" | "error" | "manual";
}

export interface ExternalHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  bodyBytes?: Uint8Array;
  url: string;
}

export type NamespaceRouteConfig =
  | { mode: "direct" }
  | {
      mode: "proxy";
      proxyBaseUrl: string;
      headers?: Record<string, string>;
    }
  // Through the `egressFetcher` binding (Workers VPC `HK` → greencloud-hk gateway's outbound relay).
  | { mode: "egress" };

/** Header the egress relay reads to pick the HTTPS host it re-sends the request to. */
const EGRESS_HOST_HEADER = "x-egress-host";
const MAX_EGRESS_REDIRECTS = 5;

/** Minimal shape of a Workers VPC service binding. */
export interface EgressFetcher {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

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

/**
 * The Workers AI binding (`env.AI`). Model calls go through its `fetch` passthrough to AI Gateway
 * (pi's `createAiBindingFetch`), so no API token is needed inside the account.
 */
export type CloudflareAiBinding = AiBinding;

export const DEFAULT_AI_PROVIDER = "workers-ai";
export const DEFAULT_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export type ModelFinishReason = "stop" | "tool_calls" | "length" | "error" | "unknown";

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  name?: string;
  toolCalls?: ModelToolCall[];
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
  provider?: string;
  model?: string;
  gatewayId?: string;
  messages: ModelMessage[];
  tools?: ModelToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Keeps one conversation's calls together: sent as session-affinity headers so a dynamic route
   * stays on one model/replica and its prompt cache, and as `cf-aig-metadata` for gateway logs.
   */
  sessionId?: string;
  /** Extra AI Gateway log metadata (string values), e.g. demand and task ids. */
  metadata?: Record<string, string>;
  /** Let the model use its provider's built-in web search (magpie: `web_search_options`). */
  webSearch?: boolean;
}

export interface ModelInvocationResponse {
  content: string | null;
  text?: string | null;
  toolCalls: ModelToolCall[];
  model: string;
  provider?: string;
  finishReason?: ModelFinishReason;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

/** magpie's search MCP tools (`/mcp/magpie/web-search`). */
export type WebToolName = "web_search" | "web_fetch";

export interface OutboundClient {
  fetchExternal(request: ExternalHttpRequest): Promise<ExternalHttpResponse>;
  sendEmail(message: EmailMessage): Promise<void>;
  invokeModel(request: ModelInvocationRequest): Promise<ModelInvocationResponse>;
  /** Runs a magpie search MCP tool and returns its text; absent when magpie is not configured. */
  callWebTool?(
    name: WebToolName,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string>;
}

/** magpie on the HK machine, reached through the `HK` binding (`x-hk-service: magpie`). */
export interface MagpieConfig {
  fetcher: EgressFetcher;
  apiKey: string;
}

export interface LiveOutboundClientOptions {
  fetchImpl?: typeof fetch;
  proxyConfig?: OutboundProxyConfig;
  egressFetcher?: EgressFetcher;
  sendEmail?: (message: EmailMessage) => Promise<void>;
  emailBinding?: CloudflareSendEmailBinding;
  defaultEmailFrom?: string;
  invokeModel?: (request: ModelInvocationRequest) => Promise<ModelInvocationResponse>;
  aiBinding?: CloudflareAiBinding;
  aiGatewayId?: string;
  aiProvider?: string;
  aiModel?: string;
  aiHeaders?: Record<string, string>;
  /** When set, model calls and web tools go to magpie instead of AI Gateway. */
  magpie?: MagpieConfig;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key.toLowerCase()] = value;
  });
  return result;
}

/**
 * Send through the egress relay: the binding routes by its service config, so the URL host is a
 * placeholder and the real host travels in `x-egress-host`. Redirects are followed here, because a
 * `Location` points at the real host and must go back through the relay too.
 */
async function fetchViaEgress(
  egress: EgressFetcher,
  request: ExternalHttpRequest,
  signal: AbortSignal | undefined,
): Promise<{ response: Response; url: string }> {
  let target = new URL(request.url);
  let method = request.method ?? "GET";
  let body = request.body;
  for (let hop = 0; ; hop += 1) {
    if (target.protocol !== "https:") {
      throw new Error(`Egress relay only forwards https URLs, got ${target.protocol}`);
    }
    const response = await egress.fetch(`http://egress${target.pathname}${target.search}`, {
      method,
      headers: { ...request.headers, [EGRESS_HOST_HEADER]: target.hostname },
      body,
      redirect: "manual",
      ...(signal !== undefined ? { signal } : {}),
    });
    const location = response.headers.get("location");
    const follow = request.redirect === undefined || request.redirect === "follow";
    if (!follow || !location || response.status < 300 || response.status >= 400) {
      if (
        request.redirect === "error" &&
        location &&
        response.status >= 300 &&
        response.status < 400
      ) {
        throw new Error(`Redirect from ${target} with redirect: "error"`);
      }
      return { response, url: target.toString() };
    }
    if (hop >= MAX_EGRESS_REDIRECTS) {
      throw new Error(`Too many redirects through egress relay (${request.url})`);
    }
    await response.body?.cancel();
    target = new URL(location, target);
    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) && method === "POST")
    ) {
      method = "GET";
      body = undefined;
    }
  }
}

function resolveExternalRequest(
  request: ExternalHttpRequest,
  proxyConfig?: OutboundProxyConfig,
): { url: string; headers?: Record<string, string> } {
  const route = proxyConfig?.[request.namespace];
  if (!route || route.mode === "direct" || route.mode === "egress") {
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

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Our model-agnostic transcript as a pi context. */
function toPiContext(request: ModelInvocationRequest, model: Model<"openai-completions">): Context {
  const now = Date.now();
  const system: string[] = [];
  const messages: Message[] = [];
  for (const msg of request.messages) {
    if (msg.role === "system") {
      system.push(msg.content);
    } else if (msg.role === "user") {
      messages.push({ role: "user", content: msg.content, timestamp: now });
    } else if (msg.role === "assistant") {
      const content: AssistantMessage["content"] = msg.content
        ? [{ type: "text", text: msg.content }]
        : [];
      for (const tc of msg.toolCalls ?? []) {
        content.push({ type: "toolCall", id: tc.id, name: tc.name, arguments: tc.arguments });
      }
      messages.push({
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: ZERO_USAGE,
        stopReason: msg.toolCalls?.length ? "toolUse" : "stop",
        timestamp: now,
      });
    } else {
      messages.push({
        role: "toolResult",
        toolCallId: msg.toolCallId ?? "",
        toolName: msg.name ?? "",
        content: [{ type: "text", text: msg.content }],
        isError: false,
        timestamp: now,
      });
    }
  }
  return {
    ...(system.length > 0 ? { systemPrompt: system.join("\n\n") } : {}),
    messages,
    ...(request.tools?.length
      ? {
          // Our tool parameters are plain JSON Schema, which is what TypeBox schemas are at runtime.
          tools: request.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters as unknown as Tool["parameters"],
          })),
        }
      : {}),
  };
}

const FINISH_REASONS: Partial<Record<AssistantMessage["stopReason"], ModelFinishReason>> = {
  stop: "stop",
  toolUse: "tool_calls",
  length: "length",
};

/** One streamed OpenAI chat-completions call through pi, mapped back to our response shape. */
async function invokeOpenAiCompatible(
  model: Model<"openai-completions">,
  request: ModelInvocationRequest,
  streamOptions: Parameters<typeof streamOpenAiCompletions>[2],
  provider: string,
  signal: AbortSignal | undefined,
  /** Names the transport in errors. */
  label: string,
): Promise<ModelInvocationResponse> {
  const message = await streamOpenAiCompletions(model, toPiContext(request, model), {
    ...streamOptions,
    ...(request.webSearch
      ? {
          onPayload: (payload: unknown) => ({
            ...(payload as Record<string, unknown>),
            web_search_options: {},
          }),
        }
      : {}),
    ...(request.sessionId ? { sessionId: request.sessionId } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
    ...(signal ? { signal } : {}),
  }).result();

  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new Error(
      `${label} (${model.id}) ${message.stopReason}: ${message.errorMessage ?? "no details"}`,
    );
  }
  const text = message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
  const toolCalls = message.content.flatMap((block) =>
    block.type === "toolCall"
      ? [{ id: block.id, name: block.name, arguments: block.arguments ?? {} }]
      : [],
  );
  return {
    content: text || null,
    text: text || null,
    toolCalls,
    model: message.responseModel ?? model.id,
    provider,
    finishReason: FINISH_REASONS[message.stopReason] ?? "unknown",
    usage: { inputTokens: message.usage.input, outputTokens: message.usage.output },
  };
}

function openAiModel(
  id: string,
  baseUrl: string,
  request: ModelInvocationRequest,
): Model<"openai-completions"> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "openai-compatible",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: request.maxTokens ?? 1024,
    compat: { sendSessionAffinityHeaders: true, sessionAffinityFormat: "openai" },
  };
}

/**
 * One model call through AI Gateway's OpenAI-compatible endpoint over the AI binding, streamed
 * by pi. The model id is a gateway route (`dynamic/cheap`) or `provider/model`.
 */
async function invokeViaAiGateway(
  aiBinding: CloudflareAiBinding,
  request: ModelInvocationRequest,
  options: LiveOutboundClientOptions,
  signal: AbortSignal | undefined,
): Promise<ModelInvocationResponse> {
  const provider = (request.provider ?? options.aiProvider ?? DEFAULT_AI_PROVIDER).trim();
  const rawModel = (request.model ?? options.aiModel ?? DEFAULT_AI_MODEL).trim();
  const gatewayId = (request.gatewayId ?? options.aiGatewayId)?.trim();
  if (!gatewayId) {
    throw new Error("Outbound AI gateway id (AI_GATEWAY_ID) is not configured");
  }
  const modelId =
    rawModel.includes("/") && !rawModel.startsWith("@") ? rawModel : `${provider}/${rawModel}`;
  const model = openAiModel(
    modelId,
    `https://workers-binding.ai/ai-gateway/gateways/${encodeURIComponent(gatewayId)}/compat`,
    request,
  );
  const metadata = {
    ...request.metadata,
    ...(request.sessionId ? { "session.id": request.sessionId } : {}),
  };
  return invokeOpenAiCompatible(
    model,
    request,
    {
      fetch: createAiBindingFetch(aiBinding),
      headers: {
        // Binding calls are pre-authenticated; the sentinel only satisfies pi's auth check.
        "cf-aig-authorization": `Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`,
        Authorization: null,
        "x-api-key": null,
        ...(Object.keys(metadata).length > 0
          ? { "cf-aig-metadata": JSON.stringify(metadata) }
          : {}),
        ...options.aiHeaders,
      },
    },
    provider,
    signal,
    "AI Gateway",
  );
}

/** The HK binding routes by service, so the host is a placeholder; Caddy picks magpie by header. */
const MAGPIE_ORIGIN = "http://magpie";

function magpieFetch(magpie: MagpieConfig): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    headers.set("x-hk-service", "magpie");
    headers.set("authorization", `Bearer ${magpie.apiKey}`);
    const url = new URL(request.url);
    return magpie.fetcher.fetch(`${MAGPIE_ORIGIN}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      ...(request.method !== "GET" && request.method !== "HEAD"
        ? { body: await request.text() }
        : {}),
      signal: init?.signal ?? request.signal,
    });
  };
}

/** One model call to magpie's OpenAI-compatible gateway; the model id is a magpie model or group. */
async function invokeViaMagpie(
  magpie: MagpieConfig,
  request: ModelInvocationRequest,
  options: LiveOutboundClientOptions,
  signal: AbortSignal | undefined,
): Promise<ModelInvocationResponse> {
  const modelId = (request.model ?? options.aiModel ?? DEFAULT_AI_MODEL).trim();
  return invokeOpenAiCompatible(
    openAiModel(modelId, `${MAGPIE_ORIGIN}/v1`, request),
    request,
    { fetch: magpieFetch(magpie), apiKey: magpie.apiKey },
    "magpie",
    signal,
    "magpie",
  );
}

/** A magpie search MCP tool call (stateless JSON-RPC `tools/call`). */
async function callMagpieWebTool(
  magpie: MagpieConfig,
  name: WebToolName,
  args: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<string> {
  const response = await magpieFetch(magpie)(`${MAGPIE_ORIGIN}/mcp/magpie/web-search`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
    ...(signal ? { signal } : {}),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`magpie ${name} HTTP ${response.status}: ${raw.slice(0, 200)}`);
  }
  // A streamable-HTTP server may answer as SSE; the JSON-RPC reply is then the last data line.
  const body = raw.trimStart().startsWith("{")
    ? raw
    : (raw
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .pop()
        ?.slice(5) ?? "");
  const parsed = JSON.parse(body) as {
    result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
    error?: { message?: string };
  };
  if (parsed.error) {
    throw new Error(`magpie ${name}: ${parsed.error.message ?? "error"}`);
  }
  const text = (parsed.result?.content ?? [])
    .flatMap((c) => (c.type === "text" && c.text ? [c.text] : []))
    .join("\n");
  if (parsed.result?.isError) {
    throw new Error(`magpie ${name}: ${text.slice(0, 200)}`);
  }
  return text;
}

export function combineAbortSignals(
  signal?: AbortSignal,
  timeoutMs?: number,
): AbortSignal | undefined {
  const timeoutSignal =
    timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? AbortSignal.timeout(Math.ceil(timeoutMs))
      : undefined;
  if (signal && timeoutSignal) {
    return AbortSignal.any([signal, timeoutSignal]);
  }
  return signal ?? timeoutSignal;
}

export function raceWithAbortSignal<T>(
  work: Promise<T>,
  signal?: AbortSignal,
  reasonMessage = "Operation aborted",
): Promise<T> {
  if (!signal) {
    return work;
  }
  if (signal.aborted) {
    const err = signal.reason instanceof Error ? signal.reason : new Error(reasonMessage);
    work.catch(() => {});
    return Promise.reject(err);
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      const err = signal.reason instanceof Error ? signal.reason : new Error(reasonMessage);
      reject(err);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function createLiveOutboundClient(options: LiveOutboundClientOptions = {}): OutboundClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  return {
    async fetchExternal(request) {
      const signal = combineAbortSignals(request.signal, request.timeoutMs);
      let resolved: { url: string; headers?: Record<string, string> };
      let response: Response;
      if (options.proxyConfig?.[request.namespace]?.mode === "egress") {
        if (!options.egressFetcher) {
          throw new Error(
            `Namespace "${request.namespace}" routes via egress but no HK binding is configured`,
          );
        }
        const sent = await fetchViaEgress(options.egressFetcher, request, signal);
        response = sent.response;
        resolved = { url: sent.url };
      } else {
        resolved = resolveExternalRequest(request, options.proxyConfig);
        response = await fetchImpl(resolved.url, {
          method: request.method ?? "GET",
          headers: resolved.headers,
          body: request.body,
          ...(request.redirect !== undefined ? { redirect: request.redirect } : {}),
          ...(signal !== undefined ? { signal } : {}),
        });
      }

      const headers = headersToRecord(response.headers);
      const contentType = headers["content-type"] ?? "";
      const isBinaryResponse =
        contentType.includes("gzip") ||
        contentType.includes("octet-stream") ||
        resolved.url.endsWith(".gz");

      if (isBinaryResponse) {
        const buffer = new Uint8Array(await response.arrayBuffer());
        const hasGzipMagic = buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
        return {
          status: response.status,
          headers,
          body: hasGzipMagic ? "" : new TextDecoder().decode(buffer),
          bodyBytes: buffer,
          url: response.url || resolved.url,
        };
      }

      return {
        status: response.status,
        headers,
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
      const signal = combineAbortSignals(request.signal, request.timeoutMs);
      if (options.invokeModel) {
        return raceWithAbortSignal(
          options.invokeModel(signal ? { ...request, signal } : request),
          signal,
          "Model invocation aborted",
        );
      }
      if (options.magpie) {
        return raceWithAbortSignal(
          invokeViaMagpie(options.magpie, request, options, signal),
          signal,
          "Model invocation aborted",
        );
      }
      if (options.aiBinding) {
        return raceWithAbortSignal(
          invokeViaAiGateway(options.aiBinding, request, options, signal),
          signal,
          "Model invocation aborted",
        );
      }
      throw new Error("Outbound model transport is not configured");
    },

    ...(options.magpie
      ? {
          callWebTool: (name: WebToolName, args: Record<string, unknown>, signal?: AbortSignal) =>
            callMagpieWebTool(options.magpie!, name, args, signal),
        }
      : {}),
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
  callWebTool?: (name: WebToolName, args: Record<string, unknown>) => string | Promise<string>;
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

    ...(handlers.callWebTool
      ? {
          callWebTool: async (name: WebToolName, args: Record<string, unknown>) =>
            handlers.callWebTool!(name, args),
        }
      : {}),
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
