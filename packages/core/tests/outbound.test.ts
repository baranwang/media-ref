import { describe, expect, test } from "vite-plus/test";
import { createFakeOutboundClient, createLiveOutboundClient } from "../src/index.ts";

function inputToUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

describe("OutboundClient live HTTP routing", () => {
  test("sends direct request to target URL when namespace has no proxy config", async () => {
    const captured: { url: string; init?: RequestInit }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      captured.push({ url: inputToUrl(input), init });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const outbound = createLiveOutboundClient({ fetchImpl });
    const response = await outbound.fetchExternal({
      kind: "platform",
      namespace: "bilibili",
      url: "https://api.bilibili.com/pgc/view/web/season?season_id=34430",
      headers: { accept: "application/json" },
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe("https://api.bilibili.com/pgc/view/web/season?season_id=34430");
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/json");
    expect(response.body).toBe('{"ok":true}');
  });

  test("forwards redirect mode and supports oauth target kind", async () => {
    const captured: { url: string; init?: RequestInit }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      captured.push({ url: inputToUrl(input), init });
      return new Response("", {
        status: 302,
        headers: { location: "https://example.invalid/redirect" },
      });
    };

    const outbound = createLiveOutboundClient({ fetchImpl });
    const response = await outbound.fetchExternal({
      kind: "oauth",
      namespace: "github",
      url: "https://github.com/login/oauth/access_token",
      method: "POST",
      redirect: "manual",
      body: "grant_type=authorization_code&code=abc",
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.init?.redirect).toBe("manual");
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe("https://example.invalid/redirect");
  });

  test("routes configured namespace through proxyBaseUrl and attaches proxy headers without changing caller", async () => {
    const captured: { url: string; headers: Headers }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      captured.push({
        url: inputToUrl(input),
        headers: new Headers(init?.headers),
      });
      return new Response("proxied-body", { status: 200 });
    };

    const outbound = createLiveOutboundClient({
      fetchImpl,
      proxyConfig: {
        iqiyi: {
          mode: "proxy",
          proxyBaseUrl: "https://proxy.mediaref.internal/fetch",
          headers: { "x-proxy-token": "secret-token" },
        },
        tmdb: { mode: "direct" },
      },
    });

    const proxiedRes = await outbound.fetchExternal({
      kind: "platform",
      namespace: "iqiyi",
      url: "https://www.iqiyi.com/a_19rrhl4335.html",
      headers: { "user-agent": "media-ref-bot" },
    });

    const directRes = await outbound.fetchExternal({
      kind: "catalog",
      namespace: "tmdb",
      url: "https://api.themoviedb.org/3/tv/95479",
    });

    expect(proxiedRes.body).toBe("proxied-body");
    expect(directRes.body).toBe("proxied-body");
    expect(captured).toHaveLength(2);
    expect(captured[0]?.url).toBe(
      "https://proxy.mediaref.internal/fetch?url=https%3A%2F%2Fwww.iqiyi.com%2Fa_19rrhl4335.html",
    );
    expect(captured[0]?.headers.get("x-proxy-token")).toBe("secret-token");
    expect(captured[0]?.headers.get("user-agent")).toBe("media-ref-bot");
    expect(captured[1]?.url).toBe("https://api.themoviedb.org/3/tv/95479");
  });

  test("routes egress namespace through the EGRESS binding with the target host in x-egress-host, following redirects", async () => {
    const sent: { url: string; host: string | null; ua: string | null; method?: string }[] = [];
    const egressFetcher = {
      async fetch(input: string, init?: RequestInit) {
        const headers = new Headers(init?.headers);
        sent.push({
          url: input,
          host: headers.get("x-egress-host"),
          ua: headers.get("user-agent"),
          method: init?.method,
        });
        if (sent.length === 1) {
          return new Response(null, {
            status: 302,
            headers: { location: "https://www.bilibili.com/bangumi/play/ss34430?from=api" },
          });
        }
        return new Response("season-body", { status: 200 });
      },
    };
    const fetchImpl: typeof fetch = async () => {
      throw new Error("direct fetch must not be used for egress namespaces");
    };

    const outbound = createLiveOutboundClient({
      fetchImpl,
      egressFetcher,
      proxyConfig: { bilibili: { mode: "egress" } },
    });
    const res = await outbound.fetchExternal({
      kind: "platform",
      namespace: "bilibili",
      url: "https://api.bilibili.com/pgc/view/web/season?season_id=34430",
      headers: { "user-agent": "media-ref-bot" },
    });

    expect(res.body).toBe("season-body");
    expect(res.url).toBe("https://www.bilibili.com/bangumi/play/ss34430?from=api");
    expect(sent).toEqual([
      {
        url: "http://egress/pgc/view/web/season?season_id=34430",
        host: "api.bilibili.com",
        ua: "media-ref-bot",
        method: "GET",
      },
      {
        url: "http://egress/bangumi/play/ss34430?from=api",
        host: "www.bilibili.com",
        ua: "media-ref-bot",
        method: "GET",
      },
    ]);
  });

  test("egress namespace without an EGRESS binding fails loudly instead of going direct", async () => {
    const outbound = createLiveOutboundClient({
      fetchImpl: async () => new Response("direct"),
      proxyConfig: { bilibili: { mode: "egress" } },
    });
    await expect(
      outbound.fetchExternal({
        kind: "platform",
        namespace: "bilibili",
        url: "https://api.bilibili.com/x",
      }),
    ).rejects.toThrow(/EGRESS binding/);
  });

  test("sends email via Cloudflare Email Service binding when emailBinding is configured", async () => {
    const sentPayloads: unknown[] = [];
    const emailBinding = {
      async send(builder: {
        from: string;
        to: string | string[];
        subject: string;
        text?: string;
        html?: string;
      }) {
        sentPayloads.push(builder);
        return { messageId: "msg_123" };
      },
    };

    const outbound = createLiveOutboundClient({
      emailBinding,
      defaultEmailFrom: "noreply@mediaref.org",
    });

    await outbound.sendEmail({
      to: "dev@example.com",
      subject: "Verify your email",
      text: "Open https://api.mediaref.org/api/auth/verify-email?token=abc",
      html: '<a href="https://api.mediaref.org/api/auth/verify-email?token=abc">Verify</a>',
    });

    expect(sentPayloads).toEqual([
      {
        from: "noreply@mediaref.org",
        to: "dev@example.com",
        subject: "Verify your email",
        text: "Open https://api.mediaref.org/api/auth/verify-email?token=abc",
        html: '<a href="https://api.mediaref.org/api/auth/verify-email?token=abc">Verify</a>',
      },
    ]);
  });

  test("rejects emailBinding delivery when neither message.from nor defaultEmailFrom is provided", async () => {
    const emailBinding = {
      async send() {
        return { messageId: "msg_123" };
      },
    };

    const outbound = createLiveOutboundClient({ emailBinding });

    await expect(
      outbound.sendEmail({
        to: "dev@example.com",
        subject: "Verify your email",
        text: "Hello",
      }),
    ).rejects.toThrow(/sender/i);
  });

  test("invokes Cloudflare Workers AI binding with AI Gateway options and normalizes multi-turn tool calls", async () => {
    const runCalls: Array<{
      model: string;
      input: Record<string, unknown>;
      options?: Record<string, unknown>;
    }> = [];

    const aiBinding = {
      async run(model: string, input: Record<string, unknown>, options?: Record<string, unknown>) {
        runCalls.push({ model, input, options });
        return {
          response: null,
          tool_calls: [
            {
              name: "search_platform",
              arguments: { keyword: "咒术回战", page: 1 },
            },
          ],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 24,
          },
        };
      },
    };

    const outbound = createLiveOutboundClient({
      aiBinding,
      aiGatewayId: "media-ref-gateway",
      aiProvider: "workers-ai",
      aiModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    });

    const response = await outbound.invokeModel({
      messages: [
        { role: "system", content: "You find candidate collections." },
        { role: "user", content: "Find Bilibili collection for 咒术回战 S1" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_prev", name: "search_platform", arguments: { keyword: "JJK" } }],
        },
        {
          role: "tool",
          toolCallId: "call_prev",
          name: "search_platform",
          content: '{"status":"ok","candidates":[]}',
        },
      ],
      tools: [
        {
          name: "search_platform",
          description: "Search platform collections",
          parameters: {
            type: "object",
            properties: { keyword: { type: "string" } },
            required: ["keyword"],
          },
        },
      ],
      temperature: 0,
      maxTokens: 512,
    });

    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]?.model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(runCalls[0]?.options).toEqual({
      gateway: { id: "media-ref-gateway" },
    });
    expect(runCalls[0]?.input).toMatchObject({
      temperature: 0,
      max_tokens: 512,
      tools: [
        {
          type: "function",
          function: {
            name: "search_platform",
            description: "Search platform collections",
          },
        },
      ],
    });
    expect(response).toEqual({
      content: null,
      text: null,
      toolCalls: [
        {
          id: "call_1",
          name: "search_platform",
          arguments: { keyword: "咒术回战", page: 1 },
        },
      ],
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      provider: "workers-ai",
      finishReason: "tool_calls",
      usage: {
        inputTokens: 120,
        outputTokens: 24,
      },
    });
  });

  test("routes non-workers-ai providers through Cloudflare AI Gateway binding purely by config", async () => {
    const gatewayCalls: Array<{
      gatewayId: string;
      data: {
        provider: string;
        endpoint: string;
        headers?: Record<string, string>;
        query: Record<string, unknown>;
      };
    }> = [];

    const aiBinding = {
      async run() {
        throw new Error("Should use gateway.run for external provider");
      },
      gateway(gatewayId: string) {
        return {
          async run(data: {
            provider: string;
            endpoint: string;
            headers?: Record<string, string>;
            query: Record<string, unknown>;
          }) {
            gatewayCalls.push({ gatewayId, data });
            if (data.provider === "openai") {
              return new Response(
                JSON.stringify({
                  model: "gpt-4o-mini",
                  choices: [
                    {
                      finish_reason: "tool_calls",
                      message: {
                        content: null,
                        tool_calls: [
                          {
                            id: "call_oa_1",
                            type: "function",
                            function: {
                              name: "inspect_collection",
                              arguments: '{"nativeId":"ss34430"}',
                            },
                          },
                        ],
                      },
                    },
                  ],
                  usage: { prompt_tokens: 88, completion_tokens: 19 },
                }),
                { status: 200, headers: { "content-type": "application/json" } },
              );
            }
            if (data.provider === "anthropic") {
              return new Response(
                JSON.stringify({
                  model: "claude-sonnet-4-5",
                  stop_reason: "tool_use",
                  content: [
                    { type: "text", text: "Checking ss34430" },
                    {
                      type: "tool_use",
                      id: "toolu_01",
                      name: "submit_candidate",
                      input: { nativeId: "ss34430", variantDescription: "原声" },
                    },
                  ],
                  usage: { input_tokens: 95, output_tokens: 31 },
                }),
                { status: 200, headers: { "content-type": "application/json" } },
              );
            }
            throw new Error(`Unexpected provider: ${data.provider}`);
          },
        };
      },
    };

    const openaiOutbound = createLiveOutboundClient({
      aiBinding,
      aiGatewayId: "prod-gateway",
      aiProvider: "openai",
      aiModel: "gpt-4o-mini",
    });

    const openaiRes = await openaiOutbound.invokeModel({
      messages: [{ role: "user", content: "inspect candidate" }],
      tools: [
        {
          name: "inspect_collection",
          description: "Inspect collection",
          parameters: { type: "object", properties: { nativeId: { type: "string" } } },
        },
      ],
    });

    expect(gatewayCalls[0]?.gatewayId).toBe("prod-gateway");
    expect(gatewayCalls[0]?.data.provider).toBe("openai");
    expect(gatewayCalls[0]?.data.endpoint).toBe("chat/completions");
    expect(openaiRes).toEqual({
      content: null,
      text: null,
      toolCalls: [
        {
          id: "call_oa_1",
          name: "inspect_collection",
          arguments: { nativeId: "ss34430" },
        },
      ],
      model: "gpt-4o-mini",
      provider: "openai",
      finishReason: "tool_calls",
      usage: { inputTokens: 88, outputTokens: 19 },
    });

    const anthropicOutbound = createLiveOutboundClient({
      aiBinding,
      aiGatewayId: "prod-gateway",
      aiProvider: "anthropic",
      aiModel: "claude-sonnet-4-5",
    });

    const anthropicRes = await anthropicOutbound.invokeModel({
      messages: [
        { role: "system", content: "System rule" },
        { role: "user", content: "submit ss34430" },
      ],
      tools: [
        {
          name: "submit_candidate",
          description: "Submit candidate",
          parameters: { type: "object", properties: { nativeId: { type: "string" } } },
        },
      ],
    });

    expect(gatewayCalls[1]?.data.provider).toBe("anthropic");
    expect(gatewayCalls[1]?.data.endpoint).toBe("v1/messages");
    expect(anthropicRes).toEqual({
      content: "Checking ss34430",
      text: "Checking ss34430",
      toolCalls: [
        {
          id: "toolu_01",
          name: "submit_candidate",
          arguments: { nativeId: "ss34430", variantDescription: "原声" },
        },
      ],
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      finishReason: "tool_calls",
      usage: { inputTokens: 95, outputTokens: 31 },
    });
  });
});

describe("createFakeOutboundClient", () => {
  test("intercepts external HTTP, email, and model calls and records them without hitting the network", async () => {
    const fake = createFakeOutboundClient({
      fetchExternal: async (request) => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ namespace: request.namespace, matched: true }),
        url: request.url,
      }),
      invokeModel: async (request) => ({
        content: `reply:${request.messages[0]?.content ?? ""}`,
        toolCalls: [],
        model: request.model ?? "test-model",
      }),
    });

    const httpRes = await fake.fetchExternal({
      kind: "catalog",
      namespace: "tmdb",
      url: "https://api.themoviedb.org/3/tv/95479",
    });
    expect(httpRes.status).toBe(200);
    expect(JSON.parse(httpRes.body)).toEqual({ namespace: "tmdb", matched: true });
    expect(fake.httpRequests).toHaveLength(1);
    expect(fake.httpRequests[0]?.namespace).toBe("tmdb");

    await fake.sendEmail({
      to: "dev@example.com",
      subject: "Verify your email",
      text: "Click the link to verify.",
    });
    expect(fake.sentEmails).toEqual([
      {
        to: "dev@example.com",
        subject: "Verify your email",
        text: "Click the link to verify.",
      },
    ]);

    const modelRes = await fake.invokeModel({
      model: "workers-ai/test",
      messages: [{ role: "user", content: "find jujutsu kaisen" }],
    });
    expect(modelRes).toEqual({
      content: "reply:find jujutsu kaisen",
      toolCalls: [],
      model: "workers-ai/test",
    });
    expect(fake.modelRequests).toHaveLength(1);

    fake.reset();
    expect(fake.httpRequests).toHaveLength(0);
    expect(fake.sentEmails).toHaveLength(0);
    expect(fake.modelRequests).toHaveLength(0);
  });

  test("rejects unstubbed HTTP and model calls and propagates simulated errors", async () => {
    const unstubbed = createFakeOutboundClient();

    await expect(
      unstubbed.fetchExternal({
        kind: "platform",
        namespace: "tencent",
        url: "https://v.qq.com/x/cover/mzc00200test.html",
      }),
    ).rejects.toThrow(/tencent/);

    await expect(
      unstubbed.invokeModel({
        messages: [{ role: "user", content: "hello" }],
      }),
    ).rejects.toThrow(/model/i);

    const failing = createFakeOutboundClient({
      fetchExternal: async () => {
        throw new Error("Simulated upstream timeout");
      },
    });

    await expect(
      failing.fetchExternal({
        kind: "platform",
        namespace: "youku",
        url: "https://v.youku.com/v_show/id_test.html",
      }),
    ).rejects.toThrow("Simulated upstream timeout");
  });

  test("propagates AbortSignal and enforces hard timeoutMs on fetchExternal and invokeModel", async () => {
    let observedFetchSignal: AbortSignal | undefined;
    const hangingFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        observedFetchSignal = init?.signal ?? undefined;
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason ?? new Error("aborted"));
        });
      });

    const hangingAiBinding = {
      run: () => new Promise<never>(() => {}),
    };

    const live = createLiveOutboundClient({
      fetchImpl: hangingFetch,
      aiBinding: hangingAiBinding,
      aiProvider: "workers-ai",
      aiModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    });

    const httpController = new AbortController();
    const httpPromise = live.fetchExternal({
      kind: "platform",
      namespace: "bilibili",
      url: "https://api.bilibili.com/pgc/view/web/season?season_id=34430",
      signal: httpController.signal,
      timeoutMs: 5_000,
    });
    httpController.abort(new Error("caller_cancelled"));
    await expect(httpPromise).rejects.toThrow("caller_cancelled");
    expect(observedFetchSignal?.aborted).toBe(true);

    const start = Date.now();
    await expect(
      live.invokeModel({
        messages: [{ role: "user", content: "hang forever" }],
        timeoutMs: 40,
      }),
    ).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(500);
  });
});
