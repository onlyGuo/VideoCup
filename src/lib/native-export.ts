import type { Asset, Project } from "./types";
import type { ExportOptions } from "./export-plan";
import { subtitleCanvas } from "./media";

export interface RenderCapabilities {
  available: boolean;
  preferredEncoder: string;
  encoders: string[];
  reason?: string;
}
export interface NativeExportResult {
  url: string;
  size: number;
  jobId: string;
  encoder: string;
}
const root = "/api/render/jobs";
async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    let message = `本机导出请求失败（${response.status}）`;
    try {
      const data = await response.json();
      if (typeof data.error === "string") message = data.error;
      else if (typeof data.error?.message === "string")
        message = data.error.message;
      else if (typeof data.message === "string") message = data.message;
    } catch {
      /* Preserve the HTTP error for a non-JSON response. */
    }
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
export async function nativeCapabilities(
  signal?: AbortSignal,
): Promise<RenderCapabilities> {
  try {
    return await json<RenderCapabilities>("/api/render/capabilities", {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
        : AbortSignal.timeout(5000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    return { available: false, preferredEncoder: "", encoders: [] };
  }
}
function wait(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}
export async function nativeExport(
  project: Project,
  assets: Asset[],
  options: ExportOptions,
  status: (message: string) => void,
  progress: (value: number) => void,
  signal: AbortSignal,
): Promise<NativeExportResult> {
  status("正在准备本机加速导出…");
  const job = await json<{
    jobId: string;
    requiredAssetIds: string[];
    requiredSubtitleIds: string[];
  }>(root, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      project,
      options,
      assets: assets.map((a) => ({
        id: a.id,
        name: a.name,
        kind: a.kind,
        size: a.blob.size,
        duration: a.duration,
        width: a.width,
        height: a.height,
      })),
    }),
  });
  const path = `${root}/${encodeURIComponent(job.jobId)}`;
  let completed = false;
  const cancel = () => {
    void fetch(path, { method: "DELETE", keepalive: true }).catch(
      () => undefined,
    );
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    const sources = job.requiredAssetIds.map((id) => {
      const asset = assets.find((a) => a.id === id);
      if (!asset) throw new Error("导出素材不存在，请重新导入");
      return asset;
    });
    const total = sources.reduce((n, a) => n + a.blob.size, 0);
    let written = 0;
    for (let i = 0; i < sources.length; i++) {
      const asset = sources[i]!;
      status(`正在准备本机素材 ${i + 1}/${sources.length} · 文件仅在本机传输`);
      await json(`${path}/assets/${encodeURIComponent(asset.id)}`, {
        method: "PUT",
        body: asset.blob,
        signal,
      });
      written += asset.blob.size;
      progress(total ? (written / total) * 10 : 10);
    }
    for (const id of job.requiredSubtitleIds) {
      signal.throwIfAborted();
      const clip = project.clips.find((c) => c.id === id);
      if (!clip) throw new Error("字幕片段不存在");
      const canvas = subtitleCanvas(
        clip.text ?? "",
        options.width,
        options.height,
        clip.fontSize,
        clip.color,
      );
      const png = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (blob) =>
            blob ? resolve(blob) : reject(new Error("字幕画面生成失败")),
          "image/png",
        ),
      );
      try {
        await json(`${path}/subtitles/${encodeURIComponent(id)}`, {
          method: "PUT",
          body: png,
          signal,
        });
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    }
    await json(`${path}/start`, { method: "POST", signal });
    for (;;) {
      signal.throwIfAborted();
      const result = await json<{
        phase: string;
        progress: number;
        fileSize: number;
        encoder: string;
        error?: string;
        hardwareFallback?: boolean;
      }>(`${path}/status`, { signal });
      if (result.phase === "failed")
        throw new Error(
          result.error || "本机导出失败，请重试或选择浏览器兼容模式",
        );
      if (result.phase === "cancelled")
        throw new DOMException("已取消导出", "AbortError");
      progress(10 + Math.max(0, Math.min(100, result.progress)) * 0.9);
      const mode =
        result.encoder === "h264_videotoolbox" ? "硬件加速" : "本机加速";
      status(
        result.phase === "joining"
          ? "正在合并视频与音轨…"
          : `正在${mode}导出${result.hardwareFallback ? "（软件编码）" : ""}…`,
      );
      if (result.phase === "completed") {
        completed = true;
        progress(100);
        return {
          url: `${path}/file`,
          size: result.fileSize,
          jobId: job.jobId,
          encoder: result.encoder,
        };
      }
      await wait(500, signal);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!completed) cancel();
  }
}
export function discardNativeExport(jobId: string) {
  void fetch(`${root}/${encodeURIComponent(jobId)}`, {
    method: "DELETE",
    keepalive: true,
  }).catch(() => undefined);
}
