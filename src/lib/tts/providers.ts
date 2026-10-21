import type { SpeechProvider } from "./types";
import {
  endpointUrl,
  fetchSpeechVoices,
  readSpeechResponse,
  requestHeaders,
} from "./http";
export const audioSpeechProvider: SpeechProvider = {
  id: "audio-speech",
  name: "Audio Speech 兼容服务",
  description:
    "兼容 model / input / voice / speed 请求格式的已授权服务。音色 ID 是否可用由具体模型决定。",
  capabilities: {
    model: true,
    language: false,
    style: false,
    pitch: false,
    volume: false,
  },
  async listVoices(config, signal) {
    if (config.voicesEndpoint.trim()) return fetchSpeechVoices(config, signal);
    return ["alloy", "echo", "fable", "onyx", "nova", "shimmer"].map((id) => ({
      id,
      name: id,
    }));
  },
  async synthesize(request, config, signal) {
    const url = endpointUrl(config.endpoint);
    if (!config.model.trim()) throw new Error("请填写语音模型 ID");
    return readSpeechResponse(
      await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...requestHeaders(config, url),
        },
        body: JSON.stringify({
          model: config.model,
          input: request.text,
          voice: request.voice,
          response_format: "mp3",
          speed: request.rate,
        }),
        signal,
      }),
    );
  },
};
export const jsonSpeechProvider: SpeechProvider = {
  id: "json-speech",
  name: "通用 JSON 语音服务",
  description:
    "用于自建代理或新增服务实现，支持语言、风格、语速、音调与音量；接口应遵循 VideoCup 语音协议。",
  capabilities: {
    model: false,
    language: true,
    style: true,
    pitch: true,
    volume: true,
  },
  async listVoices(config, signal) {
    return config.voicesEndpoint.trim()
      ? fetchSpeechVoices(config, signal)
      : [];
  },
  async synthesize(request, config, signal) {
    const url = endpointUrl(config.endpoint);
    return readSpeechResponse(
      await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...requestHeaders(config, url),
        },
        body: JSON.stringify({ ...request, format: "mp3" }),
        signal,
      }),
    );
  },
};
