import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultSpeechConfig,
  migrateSpeechConfig,
  registerSpeechProvider,
  speechProvider,
  speechProviders,
  synthesizeSpeech,
} from "../src/lib/tts";
import { fetchSpeechVoices, readSpeechResponse } from "../src/lib/tts/http";
const request = {
  text: "测试文字",
  voice: "test-voice",
  language: "zh-CN",
  style: "",
  rate: 1,
  pitch: 0,
  volume: 1,
};
afterEach(() => vi.unstubAllGlobals());
describe("speech provider mechanism", () => {
  it("defaults to the built-in Edge service without model or key", () => {
    const config = defaultSpeechConfig();
    expect(config).toMatchObject({
      providerId: "edge-tts",
      endpoint: "/api/edge/speech",
      voice: "zh-CN-XiaoxiaoNeural",
      key: "",
      model: "",
    });
    expect(speechProvider(config.providerId).capabilities.model).toBe(false);
    expect(speechProviders().map((p) => p.id)).toEqual([
      "edge-tts",
      "audio-speech",
      "json-speech",
    ]);
  });
  it("preserves a configured legacy speech endpoint while never restoring a stored key", () => {
    expect(
      migrateSpeechConfig({
        endpoint: "https://example.com/speech",
        voice: "alloy",
        model: "tts",
        key: "must-not-restore",
      }),
    ).toMatchObject({
      providerId: "audio-speech",
      endpoint: "https://example.com/speech",
      voice: "alloy",
      key: "",
    });
    expect(migrateSpeechConfig({ endpoint: "", voice: "alloy" })).toEqual(
      defaultSpeechConfig(),
    );
  });
  it("adds a provider without changing editor or subtitle logic", async () => {
    const synthesize = vi.fn(async () => ({
      blob: new Blob(["audio"], { type: "audio/mpeg" }),
      extension: "mp3" as const,
    }));
    const provider = {
      id: "test-provider",
      name: "test",
      description: "test",
      capabilities: {
        model: false,
        language: true,
        style: false,
        pitch: false,
        volume: false,
      },
      listVoices: async () => [{ id: "test-voice", name: "test" }],
      synthesize,
    };
    registerSpeechProvider(provider);
    const config = { ...defaultSpeechConfig(), providerId: provider.id };
    const abort = new AbortController();
    const result = await synthesizeSpeech(request, config, abort.signal);
    expect(await result.blob.text()).toBe("audio");
    expect(synthesize).toHaveBeenCalledWith(request, config, abort.signal);
    expect(() => registerSpeechProvider(provider)).toThrow("重复");
  });
  it("rejects malformed voice-list JSON with a useful message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("null", {
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    await expect(
      fetchSpeechVoices({
        ...defaultSpeechConfig(),
        endpoint: "https://example.com/speech",
        voicesEndpoint: "https://example.com/voices",
      }),
    ).rejects.toThrow("voices 数组");
  });
  it("surfaces the local Edge upstream error instead of suggesting an API key", async () => {
    const response = new Response(
      JSON.stringify({ error: { message: "语音服务响应超时，请稍后重试。" } }),
      { status: 504, headers: { "Content-Type": "application/json" } },
    );
    await expect(readSpeechResponse(response)).rejects.toThrow(
      "语音服务响应超时",
    );
  });
});
