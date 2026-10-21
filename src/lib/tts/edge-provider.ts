import {
  endpointUrl,
  fetchSpeechVoices,
  readSpeechResponse,
  requestHeaders,
} from "./http";
import type { SpeechConfig, SpeechProvider, SpeechVoice } from "./types";

// Voice/style candidates from https://github.com/ssrsss/ttsapi (MIT).
// Its source has a global style selector, not a per-voice support matrix.
const styleCandidates = [
  ["general", "通用风格"],
  ["assistant", "智能助手"],
  ["chat", "聊天对话"],
  ["customerservice", "客服专业"],
  ["newscast", "新闻播报"],
  ["affectionate", "亲切温暖"],
  ["calm", "平静舒缓"],
  ["cheerful", "愉快欢乐"],
  ["gentle", "温和柔美"],
  ["lyrical", "抒情诗意"],
  ["serious", "严肃正式"],
] as const;
const styleIds = new Set<string>(styleCandidates.map(([id]) => id));
const voiceCandidates = [
  ["Xiaoxiao", "晓晓", "Female", "温柔"],
  ["Yunxi", "云希", "Male", "清朗"],
  ["Yunyang", "云扬", "Male", "阳光"],
  ["Xiaoyi", "晓伊", "Female", "甜美"],
  ["Yunjian", "云健", "Male", "稳重"],
  ["Xiaochen", "晓辰", "Female", "知性"],
  ["Xiaohan", "晓涵", "Female", "优雅"],
  ["Xiaomeng", "晓梦", "Female", "梦幻"],
  ["Xiaomo", "晓墨", "Female", "文艺"],
  ["Xiaoqiu", "晓秋", "Female", "成熟"],
  ["Xiaorui", "晓睿", "Female", "智慧"],
  ["Xiaoshuang", "晓双", "Female", "活泼"],
  ["Xiaoxuan", "晓萱", "Female", "清新"],
  ["Xiaoyan", "晓颜", "Female", "柔美"],
  ["Xiaoyou", "晓悠", "Female", "悠扬"],
  ["Xiaozhen", "晓甄", "Female", "端庄"],
  ["Yunfeng", "云枫", "Male", "磁性"],
  ["Yunhao", "云皓", "Male", "豪迈"],
  ["Yunxia", "云夏", "Male", "热情"],
  ["Yunye", "云野", "Male", "野性"],
  ["Yunze", "云泽", "Male", "深沉"],
] as const;

function serviceConfig(config: SpeechConfig): SpeechConfig {
  return { ...config, endpoint: config.endpoint.trim() || "/api/edge/speech" };
}

export const edgeSpeechProvider: SpeechProvider = {
  id: "edge-tts",
  name: "Microsoft Edge TTS（内置）",
  description:
    "通过本地服务连接 Microsoft Edge TTS，无需填写模型。内置声音和风格来自开源仓库候选列表，实际可用性由上游服务决定。",
  website: "https://github.com/ssrsss/ttsapi",
  capabilities: {
    model: false,
    language: false,
    style: true,
    pitch: true,
    volume: true,
  },
  async listVoices(config, signal): Promise<SpeechVoice[]> {
    signal?.throwIfAborted();
    if (config.voicesEndpoint.trim())
      return fetchSpeechVoices(serviceConfig(config), signal);
    return voiceCandidates.map(([id, name, gender, character]) => ({
      id: `zh-CN-${id}Neural`,
      name: `${name} · ${gender === "Female" ? "女声" : "男声"} · ${character}`,
      gender,
      language: "zh-CN",
      description:
        "仓库提供的声音候选；风格同为候选，是否支持及实际效果由上游决定。",
      styles: styleCandidates.map(([id, name]) => ({
        id,
        name: id === "general" ? name : `${name}（候选）`,
      })),
    }));
  },
  async synthesize(request, config, signal) {
    signal?.throwIfAborted();
    if (!request.text.trim()) throw new Error("请先填写字幕文本");
    if (!request.voice.trim()) throw new Error("请选择声音或填写音色 ID");
    if (
      !Number.isFinite(request.rate) ||
      request.rate < 0.5 ||
      request.rate > 2
    )
      throw new Error("Edge TTS 语速须在 0.5 至 2 倍之间");
    if (
      !Number.isFinite(request.pitch) ||
      request.pitch < -50 ||
      request.pitch > 50
    )
      throw new Error("Edge TTS 音调须在 -50 至 50 Hz 之间");
    if (
      !Number.isFinite(request.volume) ||
      request.volume < 0 ||
      request.volume > 2
    )
      throw new Error("Edge TTS 音量须在 0 至 2 倍之间");
    const style = request.style.trim() || "general";
    if (!styleIds.has(style)) throw new Error("Edge TTS 不支持所选语音风格");
    const targetConfig = serviceConfig(config);
    const url = endpointUrl(targetConfig.endpoint);
    return readSpeechResponse(
      await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...requestHeaders(targetConfig, url),
        },
        body: JSON.stringify({
          input: request.text,
          voice: request.voice.trim(),
          speed: request.rate,
          pitch: String(request.pitch),
          // The upstream protocol uses relative gain: 0 = unchanged, -1 = mute.
          volume: String(Number((request.volume - 1).toFixed(6))),
          style,
        }),
        signal,
      }),
    );
  },
};
