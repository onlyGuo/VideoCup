import type { SpeechConfig, SpeechProvider, SpeechRequest } from "./types";
import { audioSpeechProvider, jsonSpeechProvider } from "./providers";
import { edgeSpeechProvider } from "./edge-provider";
export type {
  SpeechConfig,
  SpeechProvider,
  SpeechRequest,
  SpeechVoice,
  SpeechAudio,
} from "./types";
const registry = new Map<string, SpeechProvider>();
export function registerSpeechProvider(provider: SpeechProvider) {
  if (!provider.id || registry.has(provider.id))
    throw new Error(`重复或无效的语音服务 ID：${provider.id}`);
  registry.set(provider.id, provider);
}
[edgeSpeechProvider, audioSpeechProvider, jsonSpeechProvider].forEach(
  registerSpeechProvider,
);
export function speechProviders() {
  return [...registry.values()];
}
export function speechProvider(id: string) {
  const provider = registry.get(id);
  if (!provider) throw new Error("找不到所选语音服务，请重新选择");
  return provider;
}
export function defaultSpeechConfig(): SpeechConfig {
  return {
    providerId: edgeSpeechProvider.id,
    endpoint: "/api/edge/speech",
    voicesEndpoint: "",
    key: "",
    model: "",
    voice: "zh-CN-XiaoxiaoNeural",
    language: "zh-CN",
    style: "general",
    rate: 1,
    pitch: 0,
    volume: 1,
  };
}
export function migrateSpeechConfig(value: unknown): SpeechConfig {
  const result = defaultSpeechConfig();
  if (!value || typeof value !== "object") return result;
  const previous = value as Record<string, unknown>;
  if (
    (!previous.providerId && !previous.endpoint) ||
    (previous.providerId && !registry.has(String(previous.providerId)))
  )
    return result;
  if (
    !previous.providerId &&
    typeof previous.endpoint === "string" &&
    previous.endpoint
  )
    result.providerId = audioSpeechProvider.id;
  for (const key of [
    "endpoint",
    "voicesEndpoint",
    "model",
    "voice",
    "language",
    "style",
  ] as const)
    if (typeof previous[key] === "string") result[key] = previous[key];
  if (
    typeof previous.providerId === "string" &&
    registry.has(previous.providerId) &&
    !registry.get(previous.providerId)?.unavailableReason
  )
    result.providerId = previous.providerId;
  for (const key of ["rate", "pitch", "volume"] as const)
    if (typeof previous[key] === "number" && Number.isFinite(previous[key]))
      result[key] = previous[key];
  result.rate = Math.max(
    result.providerId === "edge-tts" ? 0.5 : 0.25,
    Math.min(result.providerId === "edge-tts" ? 2 : 4, result.rate),
  );
  result.pitch = Math.max(-50, Math.min(50, result.pitch));
  result.volume = Math.max(0, Math.min(2, result.volume));
  return result;
}
export async function synthesizeSpeech(
  request: SpeechRequest,
  config: SpeechConfig,
  signal?: AbortSignal,
) {
  const provider = speechProvider(config.providerId);
  if (provider.unavailableReason) throw new Error(provider.unavailableReason);
  if (!request.text.trim()) throw new Error("请先填写字幕文本");
  if (!request.voice.trim()) throw new Error("请选择声音或填写音色 ID");
  if (
    !Number.isFinite(request.rate) ||
    request.rate < 0.25 ||
    request.rate > 4 ||
    !Number.isFinite(request.pitch) ||
    request.pitch < -50 ||
    request.pitch > 50 ||
    !Number.isFinite(request.volume) ||
    request.volume < 0 ||
    request.volume > 2
  )
    throw new Error("配音参数超出支持范围");
  return provider.synthesize(request, config, signal);
}
