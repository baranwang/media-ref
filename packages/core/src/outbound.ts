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
  // Through the `egressFetcher` binding (Workers VPC → greencloud-hk egress relay).
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

export interface CloudflareAiGatewayRequest {
  provider: string;
  endpoint: string;
  headers?: Record<string, string>;
  query: Record<string, unknown>;
}

export interface CloudflareAiGatewayResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface CloudflareAiGatewayBinding {
  run(
    data: CloudflareAiGatewayRequest,
    options?: Record<string, unknown>,
  ): Promise<CloudflareAiGatewayResponse>;
}

export interface CloudflareAiBinding {
  run(
    model: string,
    input: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
  gateway?: (gatewayId: string) => CloudflareAiGatewayBinding;
}

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

export interface OutboundClient {
  fetchExternal(request: ExternalHttpRequest): Promise<ExternalHttpResponse>;
  sendEmail(message: EmailMessage): Promise<void>;
  invokeModel(request: ModelInvocationRequest): Promise<ModelInvocationResponse>;
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

function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return {};
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function normalizeFinishReason(raw: unknown, hasToolCalls: boolean): ModelFinishReason {
  if (typeof raw === "string") {
    const lower = raw.toLowerCase();
    if (lower === "tool_calls" || lower === "tool_use" || lower === "function_call") {
      return "tool_calls";
    }
    if (lower === "stop" || lower === "end_turn" || lower === "stop_sequence") {
      return "stop";
    }
    if (lower === "length" || lower === "max_tokens") {
      return "length";
    }
    if (lower === "error") {
      return "error";
    }
  }
  return hasToolCalls ? "tool_calls" : "stop";
}

function serializeOpenAiMessages(
  messages: readonly ModelMessage[],
): Array<Record<string, unknown>> {
  return messages.map((msg) => {
    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: msg.content.length > 0 ? msg.content : null,
        tool_calls: msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        })),
      };
    }
    if (msg.role === "tool") {
      return {
        role: "tool",
        ...(msg.toolCallId ? { tool_call_id: msg.toolCallId } : {}),
        ...(msg.name ? { name: msg.name } : {}),
        content: msg.content,
      };
    }
    return {
      role: msg.role,
      content: msg.content,
    };
  });
}

function serializeOpenAiTools(
  tools: readonly ModelToolDefinition[] | undefined,
): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function serializeAnthropicPayload(
  request: ModelInvocationRequest,
  model: string,
): Record<string, unknown> {
  const systemParts: string[] = [];
  const anthropicMessages: Array<Record<string, unknown>> = [];

  for (const msg of request.messages) {
    if (msg.role === "system") {
      if (msg.content.trim().length > 0) {
        systemParts.push(msg.content);
      }
      continue;
    }

    if (msg.role === "assistant") {
      const blocks: Array<Record<string, unknown>> = [];
      if (msg.content.length > 0) {
        blocks.push({ type: "text", text: msg.content });
      }
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        for (const tc of msg.toolCalls) {
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          });
        }
      }
      anthropicMessages.push({
        role: "assistant",
        content: blocks.length > 0 ? blocks : msg.content,
      });
      continue;
    }

    if (msg.role === "tool") {
      anthropicMessages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.toolCallId ?? "call_1",
            content: msg.content,
          },
        ],
      });
      continue;
    }

    anthropicMessages.push({
      role: "user",
      content: msg.content,
    });
  }

  return {
    model,
    max_tokens: request.maxTokens ?? 1024,
    ...(systemParts.length > 0 ? { system: systemParts.join("\n\n") } : {}),
    messages: anthropicMessages,
    ...(request.tools && request.tools.length > 0
      ? {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters,
          })),
        }
      : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
  };
}

function normalizeModelPayload(
  raw: unknown,
  fallbackModel: string,
  provider: string,
): ModelInvocationResponse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    const content = typeof raw === "string" && raw.length > 0 ? raw : null;
    return {
      content,
      text: content,
      toolCalls: [],
      model: fallbackModel,
      provider,
      finishReason: "stop",
    };
  }

  const record = raw as Record<string, unknown>;
  const reportedModel =
    typeof record.model === "string" && record.model.trim().length > 0
      ? record.model.trim()
      : fallbackModel;

  // 1. OpenAI chat completions format (`choices[0].message`)
  if (Array.isArray(record.choices) && record.choices.length > 0) {
    const firstChoice = record.choices[0];
    const choiceObj =
      firstChoice && typeof firstChoice === "object" && !Array.isArray(firstChoice)
        ? (firstChoice as Record<string, unknown>)
        : {};
    const messageObj =
      choiceObj.message &&
      typeof choiceObj.message === "object" &&
      !Array.isArray(choiceObj.message)
        ? (choiceObj.message as Record<string, unknown>)
        : {};

    const content =
      typeof messageObj.content === "string" && messageObj.content.length > 0
        ? messageObj.content
        : null;

    const toolCalls: ModelToolCall[] = [];
    if (Array.isArray(messageObj.tool_calls)) {
      for (let idx = 0; idx < messageObj.tool_calls.length; idx += 1) {
        const entry = messageObj.tool_calls[idx];
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          continue;
        }
        const entryObj = entry as Record<string, unknown>;
        const fnObj =
          entryObj.function &&
          typeof entryObj.function === "object" &&
          !Array.isArray(entryObj.function)
            ? (entryObj.function as Record<string, unknown>)
            : null;
        const name =
          typeof fnObj?.name === "string"
            ? fnObj.name
            : typeof entryObj.name === "string"
              ? entryObj.name
              : "";
        if (!name) {
          continue;
        }
        const id =
          typeof entryObj.id === "string" && entryObj.id.length > 0
            ? entryObj.id
            : `call_${idx + 1}`;
        toolCalls.push({
          id,
          name,
          arguments: parseToolArguments(fnObj?.arguments ?? entryObj.arguments),
        });
      }
    }

    const usageObj =
      record.usage && typeof record.usage === "object" && !Array.isArray(record.usage)
        ? (record.usage as Record<string, unknown>)
        : null;
    const inputTokens =
      typeof usageObj?.prompt_tokens === "number"
        ? usageObj.prompt_tokens
        : typeof usageObj?.input_tokens === "number"
          ? usageObj.input_tokens
          : undefined;
    const outputTokens =
      typeof usageObj?.completion_tokens === "number"
        ? usageObj.completion_tokens
        : typeof usageObj?.output_tokens === "number"
          ? usageObj.output_tokens
          : undefined;

    return {
      content,
      text: content,
      toolCalls,
      model: reportedModel,
      provider,
      finishReason: normalizeFinishReason(choiceObj.finish_reason, toolCalls.length > 0),
      ...(inputTokens !== undefined || outputTokens !== undefined
        ? {
            usage: {
              ...(inputTokens !== undefined ? { inputTokens } : {}),
              ...(outputTokens !== undefined ? { outputTokens } : {}),
            },
          }
        : {}),
    };
  }

  // 2. Anthropic messages format (`content: [{ type: "text" | "tool_use", ... }]`)
  if (Array.isArray(record.content)) {
    const textParts: string[] = [];
    const toolCalls: ModelToolCall[] = [];

    for (let idx = 0; idx < record.content.length; idx += 1) {
      const block = record.content[idx];
      if (!block || typeof block !== "object" || Array.isArray(block)) {
        continue;
      }
      const blockObj = block as Record<string, unknown>;
      if (
        blockObj.type === "text" &&
        typeof blockObj.text === "string" &&
        blockObj.text.length > 0
      ) {
        textParts.push(blockObj.text);
      } else if (blockObj.type === "tool_use" && typeof blockObj.name === "string") {
        const id =
          typeof blockObj.id === "string" && blockObj.id.length > 0
            ? blockObj.id
            : `call_${idx + 1}`;
        toolCalls.push({
          id,
          name: blockObj.name,
          arguments: parseToolArguments(blockObj.input),
        });
      }
    }

    const content = textParts.length > 0 ? textParts.join("\n") : null;
    const usageObj =
      record.usage && typeof record.usage === "object" && !Array.isArray(record.usage)
        ? (record.usage as Record<string, unknown>)
        : null;
    const inputTokens =
      typeof usageObj?.input_tokens === "number" ? usageObj.input_tokens : undefined;
    const outputTokens =
      typeof usageObj?.output_tokens === "number" ? usageObj.output_tokens : undefined;

    return {
      content,
      text: content,
      toolCalls,
      model: reportedModel,
      provider,
      finishReason: normalizeFinishReason(record.stop_reason, toolCalls.length > 0),
      ...(inputTokens !== undefined || outputTokens !== undefined
        ? {
            usage: {
              ...(inputTokens !== undefined ? { inputTokens } : {}),
              ...(outputTokens !== undefined ? { outputTokens } : {}),
            },
          }
        : {}),
    };
  }

  // 3. Cloudflare Workers AI native format (`{ response, tool_calls, usage }`)
  const rawResponseText =
    typeof record.response === "string" && record.response.length > 0
      ? record.response
      : typeof record.content === "string" && record.content.length > 0
        ? record.content
        : null;

  const toolCalls: ModelToolCall[] = [];
  if (Array.isArray(record.tool_calls)) {
    for (let idx = 0; idx < record.tool_calls.length; idx += 1) {
      const entry = record.tool_calls[idx];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const entryObj = entry as Record<string, unknown>;
      const fnObj =
        entryObj.function &&
        typeof entryObj.function === "object" &&
        !Array.isArray(entryObj.function)
          ? (entryObj.function as Record<string, unknown>)
          : null;
      const name =
        typeof entryObj.name === "string"
          ? entryObj.name
          : typeof fnObj?.name === "string"
            ? fnObj.name
            : "";
      if (!name) {
        continue;
      }
      const id =
        typeof entryObj.id === "string" && entryObj.id.length > 0 ? entryObj.id : `call_${idx + 1}`;
      toolCalls.push({
        id,
        name,
        arguments: parseToolArguments(entryObj.arguments ?? fnObj?.arguments),
      });
    }
  }

  const usageObj =
    record.usage && typeof record.usage === "object" && !Array.isArray(record.usage)
      ? (record.usage as Record<string, unknown>)
      : null;
  const inputTokens =
    typeof usageObj?.prompt_tokens === "number"
      ? usageObj.prompt_tokens
      : typeof usageObj?.input_tokens === "number"
        ? usageObj.input_tokens
        : undefined;
  const outputTokens =
    typeof usageObj?.completion_tokens === "number"
      ? usageObj.completion_tokens
      : typeof usageObj?.output_tokens === "number"
        ? usageObj.output_tokens
        : undefined;

  return {
    content: rawResponseText,
    text: rawResponseText,
    toolCalls,
    model: reportedModel,
    provider,
    finishReason: normalizeFinishReason(record.finish_reason, toolCalls.length > 0),
    ...(inputTokens !== undefined || outputTokens !== undefined
      ? {
          usage: {
            ...(inputTokens !== undefined ? { inputTokens } : {}),
            ...(outputTokens !== undefined ? { outputTokens } : {}),
          },
        }
      : {}),
  };
}

async function invokeCloudflareAiBinding(
  aiBinding: CloudflareAiBinding,
  request: ModelInvocationRequest,
  options: LiveOutboundClientOptions,
): Promise<ModelInvocationResponse> {
  const provider = (request.provider ?? options.aiProvider ?? DEFAULT_AI_PROVIDER).trim();
  const model = (request.model ?? options.aiModel ?? DEFAULT_AI_MODEL).trim();
  const gatewayId = (request.gatewayId ?? options.aiGatewayId)?.trim() || undefined;

  if (!model) {
    throw new Error("Outbound AI model name is not configured");
  }

  // Route external providers through Cloudflare AI Gateway when gateway binding + gatewayId are configured
  if (provider !== "workers-ai" && gatewayId && typeof aiBinding.gateway === "function") {
    const gateway = aiBinding.gateway(gatewayId);
    const isAnthropic = provider === "anthropic";
    const endpoint = isAnthropic ? "v1/messages" : "chat/completions";
    const query: Record<string, unknown> = isAnthropic
      ? serializeAnthropicPayload(request, model)
      : {
          model,
          messages: serializeOpenAiMessages(request.messages),
          ...(serializeOpenAiTools(request.tools)
            ? { tools: serializeOpenAiTools(request.tools) }
            : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
        };

    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(isAnthropic ? { "anthropic-version": "2023-06-01" } : {}),
      ...options.aiHeaders,
    };

    const response = await gateway.run({
      provider,
      endpoint,
      headers,
      query,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `AI Gateway (${provider}/${model}) returned HTTP ${response.status}${errorText ? `: ${errorText.slice(0, 200)}` : ""}`,
      );
    }

    const payload: unknown = await response.json();
    return normalizeModelPayload(payload, model, provider);
  }

  // Workers AI direct (or routed through AI Gateway via options.gateway.id)
  const effectiveModel =
    provider !== "workers-ai" && !model.includes("/") ? `${provider}/${model}` : model;
  const serializedTools = serializeOpenAiTools(request.tools);
  const input: Record<string, unknown> = {
    messages: serializeOpenAiMessages(request.messages),
    ...(serializedTools ? { tools: serializedTools } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
  };

  const runOptions = gatewayId ? { gateway: { id: gatewayId } } : undefined;
  const raw = await aiBinding.run(effectiveModel, input, runOptions);
  return normalizeModelPayload(raw, model, provider);
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
            `Namespace "${request.namespace}" routes via egress but no EGRESS binding is configured`,
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
      if (options.aiBinding) {
        return raceWithAbortSignal(
          invokeCloudflareAiBinding(options.aiBinding, request, options),
          signal,
          "Model invocation aborted",
        );
      }
      throw new Error("Outbound model transport is not configured");
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
