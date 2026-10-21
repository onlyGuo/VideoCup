/**
 * Local port of https://github.com/ssrsss/ttsapi speech/signature logic.
 * Copyright (c) 2025 一只会飞的旺旺 — MIT; see third_party/ttsapi/LICENSE.
 */
export const MAX_TEXT_LENGTH = 5_000;
export const MAX_REQUEST_BYTES = 64 * 1024;
const ENDPOINT_URL =
  "https://dev.microsofttranslator.com/apps/endpoint?api-version=1.0";
const OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
const SIGNING_KEY =
  "oik6PdDdMnOXemTbwvMn9de/h9lFnfBaCWbGMMZqqoSaQaqUOqjVGm5NqsmjcBI1x+sS9ugjB55HEJWRiFXYFw==";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 Edg/127.0.0.0";

export const EDGE_STYLES = [
  "general",
  "assistant",
  "chat",
  "customerservice",
  "newscast",
  "affectionate",
  "calm",
  "cheerful",
  "gentle",
  "lyrical",
  "serious",
] as const;
const voiceRows = [
  ["Xiaoxiao", "晓晓 · 温柔", "female"],
  ["Yunxi", "云希 · 清朗", "male"],
  ["Yunyang", "云扬 · 阳光", "male"],
  ["Xiaoyi", "晓伊 · 甜美", "female"],
  ["Yunjian", "云健 · 稳重", "male"],
  ["Xiaochen", "晓辰 · 知性", "female"],
  ["Xiaohan", "晓涵 · 优雅", "female"],
  ["Xiaomeng", "晓梦 · 梦幻", "female"],
  ["Xiaomo", "晓墨 · 文艺", "female"],
  ["Xiaoqiu", "晓秋 · 成熟", "female"],
  ["Xiaorui", "晓睿 · 智慧", "female"],
  ["Xiaoshuang", "晓双 · 活泼", "female"],
  ["Xiaoxuan", "晓萱 · 清新", "female"],
  ["Xiaoyan", "晓颜 · 柔美", "female"],
  ["Xiaoyou", "晓悠 · 悠扬", "female"],
  ["Xiaozhen", "晓甄 · 端庄", "female"],
  ["Yunfeng", "云枫 · 磁性", "male"],
  ["Yunhao", "云皓 · 豪迈", "male"],
  ["Yunxia", "云夏 · 热情", "male"],
  ["Yunye", "云野 · 野性", "male"],
  ["Yunze", "云泽 · 深沉", "male"],
] as const;
export const EDGE_VOICES = voiceRows.map(([id, name, gender]) => ({
  id: `zh-CN-${id}Neural`,
  name,
  language: "zh-CN",
  gender,
  // Expressive-style availability ultimately depends on the upstream voice.
  styles: [...EDGE_STYLES],
}));

export interface EdgeSpeechInput {
  input: string;
  voice: string;
  speed: number;
  pitch: number;
  /** Relative volume change: 0 = unchanged, -1 = -100%, 1 = +100%. */
  volume: number;
  style: (typeof EDGE_STYLES)[number];
}
export class EdgeTtsError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "EdgeTtsError";
  }
}
function invalid(message: string): never {
  throw new EdgeTtsError(400, "invalid_request", message);
}
function numeric(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  name: string,
) {
  if (value === undefined) return fallback;
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value))
  ) {
    return invalid(`${name} 必须是 ${min} 到 ${max} 之间的数字。`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max)
    return invalid(`${name} 必须在 ${min} 到 ${max} 之间。`);
  return number;
}
export function validateSpeechInput(value: unknown): EdgeSpeechInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid("请求必须是 JSON 对象。");
  const data = value as Record<string, unknown>;
  if (typeof data.input !== "string" || !data.input.trim())
    return invalid("请输入要合成的文字。");
  if ([...data.input].length > MAX_TEXT_LENGTH)
    throw new EdgeTtsError(
      413,
      "text_too_long",
      `单次最多合成 ${MAX_TEXT_LENGTH} 字。`,
    );
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(data.input))
    return invalid("文字包含无法合成的控制字符。");
  const voice = data.voice ?? "zh-CN-XiaoxiaoNeural";
  if (
    typeof voice !== "string" ||
    !EDGE_VOICES.some((item) => item.id === voice)
  )
    return invalid("请选择支持的中文音色。");
  const style = data.style ?? "general";
  if (
    typeof style !== "string" ||
    !EDGE_STYLES.includes(style as EdgeSpeechInput["style"])
  )
    return invalid("请选择支持的声音风格。");
  return {
    input: data.input.trim(),
    voice,
    style: style as EdgeSpeechInput["style"],
    speed: numeric(data.speed, 1, 0.5, 2, "语速"),
    pitch: numeric(data.pitch, 0, -50, 50, "音调"),
    volume: numeric(data.volume, 0, -1, 1, "相对音量"),
  };
}
export function escapeSsml(text: string) {
  return text.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[char]!,
  );
}
export function buildSsml(input: EdgeSpeechInput) {
  const signed = (number: number, unit: string) =>
    `${number >= 0 ? "+" : ""}${number}${unit}`;
  const prosody = `<prosody rate="${signed(Math.round((input.speed - 1) * 100), "%")}" pitch="${signed(input.pitch, "Hz")}" volume="${signed(Math.round(input.volume * 100), "%")}">${escapeSsml(input.input)}</prosody>`;
  const content =
    input.style === "general"
      ? prosody
      : `<mstts:express-as style="${input.style}">${prosody}</mstts:express-as>`;
  return `<speak xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" version="1.0" xml:lang="zh-CN"><voice name="${input.voice}">${content}</voice></speak>`;
}

interface Endpoint {
  region: string;
  authorization: string;
  expiresAt: number;
}
export interface EdgeTtsOptions {
  fetch?: typeof fetch;
  now?: () => number;
  /** Includes upstream response-body reads, not just connection time. */
  timeoutMs?: number;
  tokenTimeoutMs?: number;
}
function abortError() {
  return new EdgeTtsError(499, "request_cancelled", "语音生成已取消。");
}
function waitWithSignal<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
async function timed<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  callerSignal?: AbortSignal,
): Promise<T> {
  if (callerSignal?.aborted) throw abortError();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abort = () => controller.abort();
  callerSignal?.addEventListener("abort", abort, { once: true });
  try {
    return await run(controller.signal);
  } catch (error) {
    if (callerSignal?.aborted) throw abortError();
    if (timedOut)
      throw new EdgeTtsError(
        504,
        "upstream_timeout",
        "语音服务响应超时，请稍后重试。",
      );
    if (error instanceof EdgeTtsError) throw error;
    throw new EdgeTtsError(
      502,
      "upstream_unavailable",
      "无法连接语音服务，请检查网络后重试。",
    );
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abort);
  }
}
async function signEndpoint(now: number) {
  const id = crypto.randomUUID().replace(/-/g, "");
  const date = new Date(now).toUTCString().toLowerCase();
  const input =
    `MSTranslatorAndroidApp${encodeURIComponent(ENDPOINT_URL.split("://")[1]!)}${date}${id}`.toLowerCase();
  const bytes = Uint8Array.from(atob(SIGNING_KEY), (char) =>
    char.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    bytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input)),
  );
  return `MSTranslatorAndroidApp::${btoa(String.fromCharCode(...signature))}::${date}::${id}`;
}
async function readBytes(
  response: Response,
  max: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body)
    throw new EdgeTtsError(
      502,
      "empty_upstream_response",
      "语音服务返回了空内容。",
    );
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > max) {
        await reader.cancel();
        throw new EdgeTtsError(
          502,
          "upstream_response_too_large",
          "语音服务返回的内容过大。",
        );
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}
export function createEdgeTtsService(options: EdgeTtsOptions = {}) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 90_000;
  const tokenTimeoutMs = options.tokenTimeoutMs ?? 15_000;
  let cached: Endpoint | undefined;
  let pending: Promise<Endpoint> | undefined;
  function getEndpoint(signal?: AbortSignal) {
    if (cached && now() < cached.expiresAt - 180_000)
      return waitWithSignal(Promise.resolve(cached), signal);
    if (!pending) {
      // Cancellation by one caller must not abort a refresh shared by other callers.
      pending = timed(async (timeoutSignal) => {
        const response = await fetcher(ENDPOINT_URL, {
          method: "POST",
          redirect: "error",
          signal: timeoutSignal,
          headers: {
            "Accept-Language": "zh-Hans",
            "X-ClientVersion": "4.0.530a 5fe1dc6c",
            "X-UserId": "0f04d16a175c411e",
            "X-HomeGeographicRegion": "zh-Hans-CN",
            "X-ClientTraceId": crypto.randomUUID().replace(/-/g, ""),
            "X-MT-Signature": await signEndpoint(now()),
            "User-Agent": USER_AGENT,
            "Content-Type": "application/json; charset=utf-8",
          },
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new EdgeTtsError(
            response.status === 429 ? 429 : 502,
            "endpoint_rejected",
            "语音服务暂时无法获取授权，请稍后重试。",
          );
        }
        let data: { r?: unknown; t?: unknown };
        try {
          data = JSON.parse(
            new TextDecoder().decode(await readBytes(response, 64 * 1024)),
          );
        } catch (error) {
          if (error instanceof EdgeTtsError) throw error;
          throw new EdgeTtsError(
            502,
            "invalid_endpoint",
            "语音服务返回了无效授权。",
          );
        }
        // Only accept a region label, never a client-provided upstream URL or host.
        if (
          typeof data.r !== "string" ||
          !/^[a-z][a-z0-9-]{0,40}$/.test(data.r) ||
          typeof data.t !== "string" ||
          data.t.length > 16_384 ||
          /[\r\n]/.test(data.t)
        ) {
          throw new EdgeTtsError(
            502,
            "invalid_endpoint",
            "语音服务返回了无效区域或授权。",
          );
        }
        let exp: number;
        try {
          const encoded = data.t.replace(/^Bearer\s+/i, "").split(".")[1]!;
          const decoded = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
          exp = Number(JSON.parse(decoded).exp) * 1000;
          if (!Number.isFinite(exp) || exp <= now()) throw new Error("expired");
        } catch {
          throw new EdgeTtsError(
            502,
            "invalid_endpoint",
            "语音服务返回了无效或过期授权。",
          );
        }
        cached = {
          region: data.r,
          authorization: /^Bearer\s/i.test(data.t)
            ? data.t
            : `Bearer ${data.t}`,
          expiresAt: exp,
        };
        return cached;
      }, tokenTimeoutMs).finally(() => {
        pending = undefined;
      });
    }
    return waitWithSignal(pending, signal);
  }
  async function speech(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const input = validateSpeechInput(value);
    return timed(
      async (timeoutSignal) => {
        for (let attempt = 0; attempt < 2; attempt++) {
          const endpoint = await getEndpoint(timeoutSignal);
          const response = await fetcher(
            `https://${endpoint.region}.tts.speech.microsoft.com/cognitiveservices/v1`,
            {
              method: "POST",
              redirect: "error",
              signal: timeoutSignal,
              headers: {
                Authorization: endpoint.authorization,
                "Content-Type": "application/ssml+xml",
                "User-Agent": USER_AGENT,
                "X-Microsoft-OutputFormat": OUTPUT_FORMAT,
              },
              body: buildSsml(input),
            },
          );
          if (
            (response.status === 401 || response.status === 403) &&
            attempt === 0
          ) {
            await response.body?.cancel();
            if (cached === endpoint) cached = undefined;
            continue;
          }
          if (!response.ok) {
            await response.body?.cancel();
            const status = response.status === 429 ? 429 : 502;
            throw new EdgeTtsError(
              status,
              "speech_rejected",
              status === 429
                ? "语音服务请求过于频繁，请稍后重试。"
                : `语音服务生成失败（${response.status}），请稍后重试。`,
            );
          }
          const contentType = response.headers.get("content-type") ?? "";
          if (
            !contentType.startsWith("audio/") &&
            !contentType.startsWith("application/octet-stream")
          ) {
            await response.body?.cancel();
            throw new EdgeTtsError(
              502,
              "invalid_audio",
              "语音服务返回了无法识别的音频内容。",
            );
          }
          const bytes = await readBytes(response, 20 * 1024 * 1024);
          if (!bytes.length)
            throw new EdgeTtsError(502, "empty_audio", "语音服务未生成音频。");
          return bytes;
        }
        throw new EdgeTtsError(
          502,
          "speech_rejected",
          "语音服务授权失败，请稍后重试。",
        );
      },
      timeoutMs,
      signal,
    );
  }
  return { speech };
}
export function edgeErrorResponse(error: unknown): Response {
  const issue =
    error instanceof EdgeTtsError
      ? error
      : new EdgeTtsError(500, "internal_error", "本地语音服务发生错误。");
  return Response.json(
    {
      error: {
        message: issue.message,
        code: issue.code,
        type: "edge_tts_error",
      },
    },
    {
      status: issue.status,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
export function createEdgeHandler(options: EdgeTtsOptions = {}) {
  const service = createEdgeTtsService(options);
  return async function handle(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (
        url.pathname !== "/api/edge/speech" &&
        url.pathname !== "/api/edge/voices"
      )
        return new Response("Not Found", { status: 404 });
      const origin = request.headers.get("origin");
      if (
        (origin && origin !== url.origin) ||
        request.headers.get("sec-fetch-site") === "cross-site"
      )
        throw new EdgeTtsError(
          403,
          "cross_origin_request",
          "本地语音接口仅支持当前编辑器使用。",
        );
      const method = url.pathname.endsWith("/voices") ? "GET" : "POST";
      if (request.method !== method) {
        const response = edgeErrorResponse(
          new EdgeTtsError(
            405,
            "method_not_allowed",
            `请使用 ${method} 请求。`,
          ),
        );
        response.headers.set("Allow", method);
        return response;
      }
      if (method === "GET")
        return Response.json(
          {
            voices: EDGE_VOICES,
            styles: EDGE_STYLES,
            maxTextLength: MAX_TEXT_LENGTH,
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      if (
        !/^application\/json(?:\s*;|$)/i.test(
          request.headers.get("content-type") ?? "",
        )
      )
        throw new EdgeTtsError(
          415,
          "unsupported_media_type",
          "请使用 application/json 请求。",
        );
      const bytes = await readRequestBytes(request);
      let payload: unknown;
      try {
        payload = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
      } catch {
        throw new EdgeTtsError(400, "invalid_json", "请求不是有效的 JSON。");
      }
      const audio = await service.speech(payload, request.signal);
      return new Response(audio, {
        headers: {
          "Content-Type": "audio/mpeg",
          "Content-Length": String(audio.byteLength),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      return edgeErrorResponse(error);
    }
  };
}
async function readRequestBytes(request: Request) {
  if (Number(request.headers.get("content-length")) > MAX_REQUEST_BYTES)
    throw new EdgeTtsError(413, "request_too_large", "语音请求内容过大。");
  const reader = request.body?.getReader();
  if (!reader)
    throw new EdgeTtsError(400, "empty_request", "请输入要合成的文字。");
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      if (request.signal.aborted) throw abortError();
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new EdgeTtsError(413, "request_too_large", "语音请求内容过大。");
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}
