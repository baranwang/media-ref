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
});
