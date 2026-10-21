import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { edgeSpeechProvider } from "../src/lib/tts/edge-provider";
import type { SpeechConfig, SpeechRequest } from "../src/lib/tts/types";

const config: SpeechConfig = {
  providerId: "edge-tts",
  endpoint: "https://tts.example/v1/audio/speech",
  voicesEndpoint: "",
  key: "",
  model: "ignored-model",
  voice: "zh-CN-XiaoxiaoNeural",
  language: "zh-CN",
  style: "general",
  rate: 1,
  pitch: 0,
  volume: 1,
};
const request: SpeechRequest = {
  text: "你好，欢迎使用 VideoCup。",
  voice: config.voice,
  language: "zh-CN",
  style: "general",
  rate: 1,
  pitch: 0,
  volume: 1,
};
const audioResponse = () =>
  new Response(new Uint8Array([73, 68, 51]), {
    headers: { "Content-Type": "audio/mpeg" },
  });

describe("built-in Edge TTS adapter", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("location", {
      href: "http://localhost:5173/",
      origin: "http://localhost:5173",
    });
    fetchMock.mockResolvedValue(audioResponse());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("offers 21 independent Chinese voice records offline with candidate styles", async () => {
    const voices = await edgeSpeechProvider.listVoices(config);
    expect(voices).toHaveLength(21);
    expect(new Set(voices.map((voice) => voice.id)).size).toBe(21);
    expect(new Set(voices.map((voice) => voice.gender))).toEqual(
      new Set(["Female", "Male"]),
    );
    expect(voices.every((voice) => voice.language === "zh-CN")).toBe(true);
    expect(voices.every((voice) => voice.description?.includes("上游"))).toBe(
      true,
    );
    expect(voices[0]!.styles).toContainEqual({
      id: "cheerful",
      name: "愉快欢乐（候选）",
    });
    voices[0]!.styles![0]!.name = "changed";
    const fresh = await edgeSpeechProvider.listVoices(config);
    expect(fresh[0]!.styles![0]!.name).toBe("通用风格");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps common speech parameters to the repository protocol without a model", async () => {
    const controller = new AbortController();
    const result = await edgeSpeechProvider.synthesize(
      { ...request, rate: 1.25, pitch: -25, volume: 1.2, style: "cheerful" },
      { ...config, key: "service-key" },
      controller.signal,
    );
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(config.endpoint);
    expect(options).toMatchObject({
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer service-key",
      },
    });
    expect(JSON.parse(String(options?.body))).toEqual({
      input: request.text,
      voice: request.voice,
      speed: 1.25,
      pitch: "-25",
      volume: "0.2",
      style: "cheerful",
    });
    expect(result.extension).toBe("mp3");
    expect(result.blob.size).toBe(3);
  });

  it("uses the built-in local endpoint, default style and zero relative volume", async () => {
    await edgeSpeechProvider.synthesize(
      { ...request, style: "  " },
      { ...config, endpoint: "" },
    );
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("http://localhost:5173/api/edge/speech");
    expect(JSON.parse(String(options?.body))).toMatchObject({
      style: "general",
      volume: "0",
      pitch: "0",
    });
  });

  it.each([
    [0, "-1"],
    [0.5, "-0.5"],
    [2, "1"],
  ])(
    "maps %s absolute volume to %s relative volume",
    async (volume, expected) => {
      await edgeSpeechProvider.synthesize({ ...request, volume }, config);
      const options = fetchMock.mock.calls[0]![1];
      expect(JSON.parse(String(options?.body)).volume).toBe(expected);
    },
  );

  it.each([
    [{ text: " " }, "字幕文本"],
    [{ voice: " " }, "声音"],
    [{ style: "unsupported-style" }, "风格"],
    [{ rate: 0.25 }, "语速"],
    [{ rate: 4 }, "语速"],
    [{ rate: Number.NaN }, "语速"],
    [{ pitch: -51 }, "音调"],
    [{ pitch: Number.POSITIVE_INFINITY }, "音调"],
    [{ volume: 2.1 }, "音量"],
  ])(
    "rejects invalid parameters %j before fetching",
    async (override, message) => {
      await expect(
        edgeSpeechProvider.synthesize({ ...request, ...override }, config),
      ).rejects.toThrow(message);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("can load a custom voice endpoint without disclosing a secret to another host", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        voices: [{ id: "custom-voice", name: "Custom", language: "en-US" }],
      }),
    );
    const controller = new AbortController();
    const voices = await edgeSpeechProvider.listVoices(
      {
        ...config,
        key: "service-key",
        voicesEndpoint: "https://catalog.example/voices",
      },
      controller.signal,
    );
    expect(voices[0]?.id).toBe("custom-voice");
    expect(fetchMock.mock.calls[0]![1]).toEqual({
      headers: {},
      signal: controller.signal,
    });
  });

  it("surfaces HTTP errors and rejects successful JSON responses as invalid audio", async () => {
    fetchMock.mockResolvedValueOnce(new Response("throttled", { status: 429 }));
    await expect(
      edgeSpeechProvider.synthesize(request, config),
    ).rejects.toThrow("限流");
    fetchMock.mockResolvedValueOnce(Response.json({ error: "not audio" }));
    await expect(
      edgeSpeechProvider.synthesize(request, config),
    ).rejects.toThrow("有效音频");
  });

  it("honors pre-cancelled requests and cancels a pending synthesis fetch", async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      edgeSpeechProvider.listVoices(config, cancelled.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      edgeSpeechProvider.synthesize(request, config, cancelled.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockImplementationOnce(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () =>
            reject(options.signal?.reason),
          );
        }),
    );
    const pending = new AbortController();
    const result = edgeSpeechProvider.synthesize(
      request,
      config,
      pending.signal,
    );
    pending.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  });
});
