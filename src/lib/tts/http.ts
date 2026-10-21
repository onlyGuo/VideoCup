import type { SpeechAudio, SpeechConfig, SpeechVoice } from "./types";
export function endpointUrl(value: string): URL {
  let url: URL;
  try {
    const localPath = value.startsWith("/") && !value.startsWith("//");
    url = localPath
      ? new URL(
          value,
          typeof location !== "undefined"
            ? location.origin
            : "http://localhost",
        )
      : new URL(value);
  } catch {
    throw new Error("请填写完整的语音服务 HTTP(S) 接口地址");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("语音服务地址必须是 HTTP(S)，且不能在地址中包含凭据");
  return url;
}
export function requestHeaders(
  config: SpeechConfig,
  target: URL,
): Record<string, string> {
  // A separate metadata host must never receive the synthesis service's secret.
  const authorizedOrigin = endpointUrl(config.endpoint).origin;
  return config.key && target.origin === authorizedOrigin
    ? { Authorization: `Bearer ${config.key}` }
    : {};
}
export async function fetchSpeechVoices(
  config: SpeechConfig,
  signal?: AbortSignal,
): Promise<SpeechVoice[]> {
  const url = endpointUrl(config.voicesEndpoint);
  const response = await fetch(url, {
    headers: requestHeaders(config, url),
    signal,
  });
  if (!response.ok)
    throw new Error(`音色列表加载失败（HTTP ${response.status}）`);
  const data = await response.json();
  const rows = Array.isArray(data)
    ? data
    : data && typeof data === "object"
      ? (data.voices ?? data.data)
      : undefined;
  if (!Array.isArray(rows))
    throw new Error("音色接口应返回数组，或包含 voices 数组的 JSON");
  const seen = new Set<string>();
  const result: SpeechVoice[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const id =
      typeof row.id === "string"
        ? row.id
        : typeof row.voice_id === "string"
          ? row.voice_id
          : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      name: typeof row.name === "string" ? row.name : id,
      language: typeof row.language === "string" ? row.language : undefined,
      gender: typeof row.gender === "string" ? row.gender : undefined,
      description:
        typeof row.description === "string" ? row.description : undefined,
      styles: Array.isArray(row.styles)
        ? row.styles
            .filter(
              (s: unknown) =>
                typeof s === "string" ||
                (!!s &&
                  typeof s === "object" &&
                  typeof (s as { id: unknown }).id === "string"),
            )
            .map((s: string | { id: string; name?: string }) =>
              typeof s === "string"
                ? { id: s, name: s }
                : { id: s.id, name: s.name ?? s.id },
            )
        : undefined,
    });
  }
  if (!result.length) throw new Error("服务没有返回有效的音色");
  return result;
}
export async function readSpeechResponse(
  response: Response,
): Promise<SpeechAudio> {
  if (!response.ok) {
    const description =
      response.status === 401 || response.status === 403
        ? "请检查服务授权和 API Key"
        : response.status === 429
          ? "服务已限流或额度不足，请稍后重试"
          : "请检查服务配置";
    let detail = description;
    try {
      const body = await response.clone().json();
      const message = body?.error?.message ?? body?.message;
      if (typeof message === "string" && message.trim())
        detail = message.slice(0, 240);
    } catch {
      /* Non-JSON errors use the status explanation. */
    }
    throw new Error(`配音失败（HTTP ${response.status}）：${detail}`);
  }
  const blob = await response.blob();
  const mime = blob.type.split(";")[0]?.toLowerCase() ?? "";
  if (
    !blob.size ||
    (!mime.startsWith("audio/") &&
      !["application/octet-stream", ""].includes(mime))
  )
    throw new Error("配音服务未返回有效音频，请检查接口响应格式");
  return {
    blob,
    extension: mime.includes("wav")
      ? "wav"
      : mime.includes("ogg")
        ? "ogg"
        : "mp3",
  };
}
