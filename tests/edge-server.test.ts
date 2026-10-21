import { describe, expect, it, vi } from "vitest";
import {
  buildSsml,
  createEdgeHandler,
  createEdgeTtsService,
  EDGE_VOICES,
  MAX_REQUEST_BYTES,
  MAX_TEXT_LENGTH,
  validateSpeechInput,
} from "../server/edge-tts";
import { edgeTtsPlugin } from "../server/vite-edge";

const now = 1_800_000_000_000;
const mp3 = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x01]);
function tokenResponse(region = "eastus", expiry = now + 3_600_000) {
  const jwt = `header.${btoa(JSON.stringify({ exp: expiry / 1000 }))}.signature`;
  return Response.json({ r: region, t: `Bearer ${jwt}` });
}
function audioResponse() {
  return new Response(mp3, { headers: { "content-type": "audio/mpeg" } });
}
function post(value: unknown, options: RequestInit = {}) {
  return new Request("http://127.0.0.1:5173/api/edge/speech", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
    ...options,
  });
}
function mockUpstream() {
  return vi.fn<typeof fetch>(async (url) =>
    String(url).includes("/apps/endpoint") ? tokenResponse() : audioResponse(),
  );
}

describe("local Edge speech service", () => {
  it("escapes text and preserves speed, pitch and relative-volume semantics", () => {
    const input = validateSpeechInput({
      input: `<voice name="evil"> & 'test'`,
      speed: 1.25,
      pitch: "-12",
      volume: "0.25",
      style: "cheerful",
    });
    const ssml = buildSsml(input);
    expect(ssml).toContain(
      "&lt;voice name=&quot;evil&quot;&gt; &amp; &apos;test&apos;",
    );
    expect(ssml).toContain('rate="+25%" pitch="-12Hz" volume="+25%"');
    expect(ssml).toContain('<mstts:express-as style="cheerful">');
    expect(ssml.match(/<voice /g)).toHaveLength(1);
    const defaultSsml = buildSsml(validateSpeechInput({ input: "你好" }));
    expect(defaultSsml).toContain('volume="+0%"');
    expect(defaultSsml).not.toContain("<mstts:express-as");
  });

  it.each([
    { input: " " },
    { input: "ok", voice: '"><audio src="https://evil.test">' },
    { input: "ok", style: 'cheerful" attack="true' },
    { input: "ok", speed: 0.49 },
    { input: "ok", speed: "1garbage" },
    { input: "ok", speed: true },
    { input: "ok", pitch: -51 },
    { input: "ok", volume: 1.01 },
    { input: "ok\u0001" },
    { input: "ok", speed: null },
  ])(
    "rejects invalid payload before reaching an upstream: %j",
    async (payload) => {
      const upstream = mockUpstream();
      const handler = createEdgeHandler({ fetch: upstream, now: () => now });
      expect((await handler(post(payload))).status).toBe(400);
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it("bounds request size and Unicode text length", async () => {
    const handler = createEdgeHandler({ fetch: mockUpstream() });
    expect(
      (await handler(post({ input: "字".repeat(MAX_TEXT_LENGTH + 1) }))).status,
    ).toBe(413);
    expect(
      (await handler(post({ input: "a".repeat(MAX_REQUEST_BYTES) }))).status,
    ).toBe(413);
    expect(
      validateSpeechInput({ input: "😀".repeat(MAX_TEXT_LENGTH) }).input,
    ).toHaveLength(MAX_TEXT_LENGTH * 2);
  });

  it("returns the bundled voices without an upstream request, rejects methods and external origins", async () => {
    const upstream = mockUpstream();
    const handler = createEdgeHandler({ fetch: upstream });
    const response = await handler(
      new Request("http://127.0.0.1:5173/api/edge/voices"),
    );
    expect((await response.json()).voices).toEqual(EDGE_VOICES);
    expect(EDGE_VOICES).toHaveLength(21);
    const invalidMethod = await handler(
      new Request("http://127.0.0.1:5173/api/edge/speech"),
    );
    expect(invalidMethod.status).toBe(405);
    expect(invalidMethod.headers.get("allow")).toBe("POST");
    expect(
      (
        await handler(
          post(
            { input: "ok" },
            {
              headers: {
                origin: "https://evil.test",
                "content-type": "application/json",
              },
            },
          ),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handler(
          post({ input: "ok" }, { headers: { "content-type": "text/plain" } }),
        )
      ).status,
    ).toBe(415);
    expect((await handler(post({}, { body: "{" }))).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("coalesces concurrent token refreshes and caches the token", async () => {
    const upstream = mockUpstream();
    const handler = createEdgeHandler({ fetch: upstream, now: () => now });
    const responses = await Promise.all([
      handler(post({ input: "你好" })),
      handler(post({ input: "世界" })),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("audio/mpeg");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(mp3);
    }
    await handler(post({ input: "再次生成" }));
    const endpointCalls = upstream.mock.calls.filter(([url]) =>
      String(url).includes("/apps/endpoint"),
    );
    const speechCalls = upstream.mock.calls.filter(([url]) =>
      String(url).includes("/cognitiveservices/v1"),
    );
    expect(endpointCalls).toHaveLength(1);
    expect(speechCalls).toHaveLength(3);
    expect(endpointCalls[0]![1]!.headers).toHaveProperty("X-MT-Signature");
    expect(speechCalls[0]![1]!.headers).toHaveProperty("Authorization");
    expect(String(speechCalls[0]![0])).toBe(
      "https://eastus.tts.speech.microsoft.com/cognitiveservices/v1",
    );
  });

  it("refreshes an expired cached token before the next speech", async () => {
    let time = now;
    const upstream = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("/apps/endpoint")
        ? tokenResponse("eastus", time + 300_000)
        : audioResponse(),
    );
    const service = createEdgeTtsService({ fetch: upstream, now: () => time });
    await service.speech({ input: "你好" });
    time += 121_000;
    await service.speech({ input: "你好" });
    expect(
      upstream.mock.calls.filter(([url]) =>
        String(url).includes("/apps/endpoint"),
      ),
    ).toHaveLength(2);
  });

  it("refreshes once on an upstream authentication failure", async () => {
    let speechCalls = 0;
    const upstream = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes("/apps/endpoint")) return tokenResponse();
      return ++speechCalls === 1
        ? new Response("expired", { status: 401 })
        : audioResponse();
    });
    const handler = createEdgeHandler({ fetch: upstream, now: () => now });
    expect((await handler(post({ input: "你好" }))).status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(4);
  });

  it("reports rate limits without retrying or exposing upstream error text", async () => {
    const upstream = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("/apps/endpoint")
        ? tokenResponse()
        : new Response("private upstream details", { status: 429 }),
    );
    const handler = createEdgeHandler({ fetch: upstream, now: () => now });
    const response = await handler(post({ input: "你好" }));
    expect(response.status).toBe(429);
    expect(await response.text()).not.toContain("private upstream details");
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("rejects a URL injected into the upstream region", async () => {
    const upstream = vi.fn<typeof fetch>(async () =>
      tokenResponse("evil.test/path?"),
    );
    const handler = createEdgeHandler({ fetch: upstream, now: () => now });
    const response = await handler(post({ input: "你好" }));
    expect(response.status).toBe(502);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("cancels a waiting caller without cancelling the token refresh of another caller", async () => {
    let release!: (value: Response) => void;
    const upstream = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("/apps/endpoint")
        ? new Promise<Response>((resolve) => {
            release = resolve;
          })
        : audioResponse(),
    );
    const handler = createEdgeHandler({ fetch: upstream, now: () => now });
    const controller = new AbortController();
    const first = handler(
      post({ input: "你好" }, { signal: controller.signal }),
    );
    const second = handler(post({ input: "世界" }));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    controller.abort();
    expect((await first).status).toBe(499);
    release(tokenResponse());
    expect((await second).status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("aborts an in-flight synthesis when its caller cancels", async () => {
    let speechSignal: AbortSignal | undefined;
    const upstream = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).includes("/apps/endpoint")) return tokenResponse();
      speechSignal = init!.signal!;
      return new Promise<Response>((_resolve, reject) =>
        speechSignal!.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        ),
      );
    });
    const handler = createEdgeHandler({ fetch: upstream, now: () => now });
    const controller = new AbortController();
    const response = handler(
      post({ input: "你好" }, { signal: controller.signal }),
    );
    await vi.waitFor(() => expect(speechSignal).toBeDefined());
    controller.abort();
    expect((await response).status).toBe(499);
    expect(speechSignal!.aborted).toBe(true);
  });

  it("times out a stalled upstream and can retry on a later request", async () => {
    let stall = true;
    const upstream = vi.fn<typeof fetch>(async (_url, init) => {
      if (!stall) return tokenResponse();
      return new Promise<Response>((_resolve, reject) =>
        init!.signal!.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        ),
      );
    });
    const handler = createEdgeHandler({
      fetch: upstream,
      now: () => now,
      tokenTimeoutMs: 20,
    });
    const failed = await handler(post({ input: "你好" }));
    expect(failed.status).toBe(504);
    stall = false;
    // A second request reaches the upstream again instead of retaining a rejected refresh promise.
    await handler(post({ input: "你好" }));
    expect(
      upstream.mock.calls.filter(([url]) =>
        String(url).includes("/apps/endpoint"),
      ),
    ).toHaveLength(2);
  });

  it("wires the same API into Vite development and preview middleware", async () => {
    const upstream = mockUpstream();
    const plugin = edgeTtsPlugin({ fetch: upstream, now: () => now });
    const middlewares: unknown[] = [];
    const server = {
      middlewares: {
        use: (middleware: unknown) => middlewares.push(middleware),
      },
    };
    if (typeof plugin.configureServer === "function")
      plugin.configureServer.call({} as never, server as never);
    if (typeof plugin.configurePreviewServer === "function")
      plugin.configurePreviewServer.call({} as never, server as never);
    expect(middlewares).toHaveLength(2);
    expect(middlewares[0]).toBe(middlewares[1]);
    const middleware = middlewares[0] as (
      req: object,
      res: object,
      next: () => void,
    ) => Promise<void>;
    const createRequest = (url: string, host = "127.0.0.1:5173") => ({
      url,
      method: "POST",
      headers: { host, "content-type": "application/json" },
      on: vi.fn(),
      removeListener: vi.fn(),
      resume: vi.fn(),
      async *[Symbol.asyncIterator]() {
        yield new TextEncoder().encode(JSON.stringify({ input: "你好" }));
      },
    });
    let bytes: Uint8Array | undefined;
    const headers = new Map<string, string>();
    const response = {
      statusCode: 0,
      writableEnded: false,
      destroyed: false,
      on: vi.fn(),
      removeListener: vi.fn(),
      setHeader: (key: string, value: string) => headers.set(key, value),
      end: (value: Uint8Array) => {
        bytes = value;
      },
    };
    const next = vi.fn();
    await middleware(createRequest("/api/edge/speech"), response, next);
    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(200);
    expect(headers.get("content-type")).toBe("audio/mpeg");
    expect(bytes).toEqual(mp3);
    await middleware(createRequest("/other-path"), response, next);
    expect(next).toHaveBeenCalledOnce();
    await middleware(
      createRequest("/api/edge/speech", "external.test"),
      response,
      next,
    );
    expect(response.statusCode).toBe(403);
    expect(new TextDecoder().decode(bytes)).toContain("local_access_only");
    expect(upstream).toHaveBeenCalledTimes(2);
  });
});
