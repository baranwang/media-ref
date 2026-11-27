import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { Route } from "../src/routes/img.douban.ts";

vi.mock("cloudflare:workers", () => ({ waitUntil: vi.fn() }));

const poster = "https://img.doubanio.com/poster";
const fetchImage = vi.fn<typeof fetch>();
const cache = { match: vi.fn(), put: vi.fn() };
const handlers = Route.options.server?.handlers as {
  GET: (context: { request: Request }) => Promise<Response>;
};

function requestImage() {
  return handlers.GET({ request: new Request(`https://site.test/img/douban?u=${poster}`) });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", fetchImage);
  vi.stubGlobal("caches", { open: async () => cache });
});
afterEach(() => vi.unstubAllGlobals());

test.each(["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"])(
  "serves and caches %s with restrictive headers",
  async (type) => {
    fetchImage.mockResolvedValue(new Response("poster", { headers: { "content-type": type } }));
    const response = await requestImage();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("poster");
    expect(response.headers.get("content-type")).toBe(type);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(cache.put).toHaveBeenCalledOnce();
  },
);

test.each([
  new Headers({ "content-type": "image/svg+xml" }),
  new Headers({ "content-type": "image/png", "content-length": String(5 * 1024 * 1024 + 1) }),
])("rejects an unsupported type or oversized declared length", async (headers) => {
  fetchImage.mockResolvedValue(new Response(null, { headers }));
  expect((await requestImage()).status).toBe(502);
  expect(cache.put).not.toHaveBeenCalled();
});

test("follows three allowed redirects and accepts the size boundary", async () => {
  for (const location of ["/one", "https://another.doubanio.com/two", "three"]) {
    fetchImage.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location } }));
  }
  fetchImage.mockResolvedValueOnce(
    new Response(null, {
      headers: { "content-type": "image/jpeg", "content-length": String(5 * 1024 * 1024) },
    }),
  );
  expect((await requestImage()).status).toBe(200);
  expect(fetchImage.mock.calls.map(([url, init]) => [url, init?.redirect])).toEqual([
    [poster, "manual"],
    ["https://img.doubanio.com/one", "manual"],
    ["https://another.doubanio.com/two", "manual"],
    ["https://another.doubanio.com/three", "manual"],
  ]);
});

test.each(["https://example.test/poster", "http://img.doubanio.com/poster"])(
  "rejects a disallowed redirect target before fetching it",
  async (location) => {
    fetchImage.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location } }));
    expect((await requestImage()).status).toBe(502);
    expect(fetchImage).toHaveBeenCalledTimes(1);
    expect(cache.put).not.toHaveBeenCalled();
  },
);

test("stops before following a fourth redirect", async () => {
  fetchImage.mockResolvedValue(new Response(null, { status: 302, headers: { location: "/next" } }));
  expect((await requestImage()).status).toBe(502);
  expect(fetchImage).toHaveBeenCalledTimes(4);
  expect(cache.put).not.toHaveBeenCalled();
});
