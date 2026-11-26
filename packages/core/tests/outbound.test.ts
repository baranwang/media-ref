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

  test("streams model calls through AI Gateway's compat endpoint over the AI binding (pi)", async () => {
    const sent: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const chunks = [
      {
        id: "c1",
        model: "gpt-6-luna",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_a",
                  type: "function",
                  function: { name: "list_episodes", arguments: "" },
                },
              ],
            },
          },
        ],
      },
      {
        id: "c1",
        model: "gpt-6-luna",
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '{"canonicalId":' } }] },
          },
        ],
      },
      {
        id: "c1",
        model: "gpt-6-luna",
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '"ss34430"}' } }] },
          },
        ],
      },
      {
        id: "c1",
        model: "gpt-6-luna",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 120, completion_tokens: 24, total_tokens: 144 },
      },
    ];
    const aiBinding = {
      aiGatewayLogId: null,
      async fetch(input: Request | string | URL, init?: RequestInit) {
        const request = new Request(input, init);
        sent.push({
          url: request.url,
          headers: request.headers,
          body: (await request.json()) as Record<string, unknown>,
        });
        const sse =
          chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
        return new Response(sse, { headers: { "content-type": "text/event-stream" } });
      },
    };

    const outbound = createLiveOutboundClient({
      aiBinding,
      aiGatewayId: "gateway",
      aiModel: "dynamic/cheap",
    });
    const response = await outbound.invokeModel({
      messages: [
        { role: "system", content: "Pick a collection." },
        { role: "user", content: "咒术回战 S1" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_prev", name: "get_catalog_season", arguments: { season: 1 } }],
        },
        {
          role: "tool",
          toolCallId: "call_prev",
          name: "get_catalog_season",
          content: '{"episodeCount":24}',
        },
      ],
      tools: [
        {
          name: "list_episodes",
          description: "List episodes",
          parameters: {
            type: "object",
            properties: { canonicalId: { type: "string" } },
            required: ["canonicalId"],
          },
        },
      ],
      temperature: 0,
      maxTokens: 512,
      sessionId: "task-1",
      metadata: { demandId: "d-1" },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers.get("session_id")).toBe("task-1");
    expect(sent[0]!.headers.get("x-session-affinity")).toBe("task-1");
    expect(JSON.parse(sent[0]!.headers.get("cf-aig-metadata") ?? "{}")).toEqual({
      demandId: "d-1",
      "session.id": "task-1",
    });
    expect(sent[0]!.url).toBe(
      "https://workers-binding.ai/ai-gateway/gateways/gateway/compat/chat/completions",
    );
    expect(sent[0]!.headers.get("cf-aig-authorization")).toBe("Bearer cloudflare-gateway-binding");
    expect(sent[0]!.headers.get("authorization")).toBeNull();
    const body = sent[0]!.body;
    expect(body).toMatchObject({ model: "dynamic/cheap", stream: true, temperature: 0 });
    const roles = (body.messages as Array<{ role: string }>).map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "tool"]);
    expect(body.tools).toMatchObject([{ type: "function", function: { name: "list_episodes" } }]);

    expect(response).toEqual({
      content: null,
      text: null,
      toolCalls: [{ id: "call_a", name: "list_episodes", arguments: { canonicalId: "ss34430" } }],
      model: "gpt-6-luna",
      provider: "workers-ai",
      finishReason: "tool_calls",
      usage: { inputTokens: 120, outputTokens: 24 },
    });
  });

  test("a gateway error surfaces as a thrown error, not an empty answer", async () => {
    const outbound = createLiveOutboundClient({
      aiBinding: {
        aiGatewayLogId: null,
        fetch: async () => new Response('{"error":"rate limited"}', { status: 429 }),
      },
      aiGatewayId: "gateway",
      aiModel: "dynamic/cheap",
    });
    await expect(
      outbound.invokeModel({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/AI Gateway \(dynamic\/cheap\) error/);
  });

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
      aiGatewayLogId: null,
      fetch: (_input: Request | string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    };

    const live = createLiveOutboundClient({
      fetchImpl: hangingFetch,
      aiBinding: hangingAiBinding,
      aiGatewayId: "gateway",
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
