/** Local-only native FFmpeg renderer. Source assets never leave this computer. */
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  access,
  mkdtemp,
  open,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { cpus, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  buildExportJoin,
  buildExportSegment,
  concatManifest,
  planExportSegments,
  visibleExportItems,
} from "../src/lib/export-plan.ts";
import type { ExportOptions, ExportSource } from "../src/lib/export-plan.ts";
import type { Project } from "../src/lib/types.ts";

const MAX_ASSET_BYTES = 50 * 1024 ** 3;
const MAX_TOTAL_BYTES = 100 * 1024 ** 3;
const MAX_PNG_BYTES = 32 * 1024 ** 2;
const MAX_JSON_BYTES = 4 * 1024 ** 2;
const SAFE_ID = /^[a-zA-Z0-9_-]{1,80}$/;
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
// No playlist/concat/HLS/network demuxers for untrusted imported media.
const MEDIA_FORMATS =
  "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,mpeg,mpegvideo,mpegts,ogg,wav,mp3,flac,aac,image2,png_pipe,jpeg_pipe,webp_pipe,gif";
const safeInputArgs = [
  "-protocol_whitelist",
  "file,pipe",
  "-format_whitelist",
  MEDIA_FORMATS,
];
export type NativePhase =
  | "uploading"
  | "queued"
  | "rendering"
  | "joining"
  | "completed"
  | "failed"
  | "cancelled";
export interface NativeAssetMetadata {
  id: string;
  name: string;
  kind: "video" | "audio" | "image";
  size: number;
  duration: number;
  width: number;
  height: number;
}
export interface NativeJobInput {
  project: Project;
  assets: NativeAssetMetadata[];
  options: ExportOptions;
}
export interface NativeJobStatus {
  jobId: string;
  phase: NativePhase;
  progress: number;
  fileSize: number;
  encoder: string;
  error?: string;
  hardwareFallback?: boolean;
}
export interface NativeCapabilities {
  available: boolean;
  encoders: string[];
  preferredEncoder: string;
  platform: string;
  maxAssetBytes: number;
  reason?: string;
}
export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}
export interface ProcessOptions {
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs: number;
  onProgress?: (seconds: number) => void;
}
export type NativeProcessRunner = (
  binary: string,
  args: string[],
  options: ProcessOptions,
) => Promise<ProcessResult>;
export interface NativeExportServiceOptions {
  /** For tests or a trusted local configuration; never accepted in an HTTP body. */
  binaryPath?: string;
  runner?: NativeProcessRunner;
  platform?: string;
  tempRoot?: string;
  maxJobs?: number;
  ttlMs?: number;
  commandTimeoutMs?: number;
  jobTimeoutMs?: number;
}
class RenderError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
function invalid(message: string): never {
  throw new RenderError(400, "invalid_request", message);
}
function assertNumber(
  value: unknown,
  min: number,
  max: number,
  field: string,
  integer = false,
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  )
    invalid(`${field} 无效。`);
}
function assertId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SAFE_ID.test(value))
    invalid("素材或片段 ID 无效。");
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid("工程数据格式无效。");
  return value as Record<string, unknown>;
}
function validateInput(value: unknown): NativeJobInput {
  const data = record(value),
    project = record(data.project),
    options = record(data.options);
  if (
    !Array.isArray(project.tracks) ||
    !Array.isArray(project.clips) ||
    !Array.isArray(data.assets)
  )
    invalid("工程缺少轨道、片段或素材列表。");
  if (
    project.tracks.length > 128 ||
    project.clips.length > 5000 ||
    data.assets.length > 128 ||
    !project.clips.length
  )
    invalid("工程片段或素材数量超过限制。");
  assertNumber(project.width, 2, 7680, "工程宽度", true);
  assertNumber(project.height, 2, 7680, "工程高度", true);
  assertNumber(project.fps, 1, 120, "帧率");
  assertNumber(options.width, 2, 3840, "导出宽度", true);
  assertNumber(options.height, 2, 3840, "导出高度", true);
  if (options.width % 2 || options.height % 2)
    invalid("导出画面宽高必须是偶数。");
  if (
    typeof options.audioOnly !== "boolean" ||
    typeof options.subtitles !== "boolean" ||
    !["high", "standard", "normal"].includes(String(options.quality))
  )
    invalid("导出选项无效。");
  const tracks = new Map<string, string>();
  for (const value of project.tracks) {
    const track = record(value);
    assertId(track.id);
    if (
      tracks.has(track.id) ||
      !["video", "audio", "subtitle"].includes(String(track.kind)) ||
      typeof track.hidden !== "boolean" ||
      typeof track.muted !== "boolean"
    )
      invalid("轨道数据无效。");
    tracks.set(track.id, String(track.kind));
  }
  const clips = new Set<string>();
  let duration = 0;
  for (const value of project.clips) {
    const clip = record(value);
    assertId(clip.id);
    assertId(clip.trackId);
    if (clips.has(clip.id) || !tracks.has(clip.trackId))
      invalid("片段轨道或 ID 无效。");
    clips.add(clip.id);
    assertNumber(clip.start, 0, 21600, "片段开始时间");
    assertNumber(clip.in, 0, 21600, "入点");
    assertNumber(clip.out, 0, 43200, "出点");
    assertNumber(clip.speed, 0.1, 16, "播放速度");
    assertNumber(clip.volume, 0, 4, "音量");
    assertNumber(clip.opacity, 0, 1, "透明度");
    if (clip.out <= clip.in) invalid("片段出点必须晚于入点。");
    const end = clip.start + (clip.out - clip.in) / clip.speed;
    if (end > 21600) invalid("单次导出时长不能超过 6 小时。");
    duration = Math.max(duration, end);
    const crop = record(clip.crop);
    for (const name of ["x", "y", "width", "height"])
      assertNumber(
        crop[name],
        name === "width" || name === "height" ? 0.1 : 0,
        100,
        "裁剪范围",
      );
    if (clip.transform !== undefined) {
      const transform = record(clip.transform);
      assertNumber(transform.x, -200, 300, "横向位置");
      assertNumber(transform.y, -200, 300, "纵向位置");
      assertNumber(transform.scaleX, 0.05, 4, "横向缩放");
      assertNumber(transform.scaleY, 0.05, 4, "纵向缩放");
      assertNumber(transform.rotation, -36000, 36000, "旋转角度");
    }
    if (tracks.get(clip.trackId) !== "subtitle") assertId(clip.assetId);
    if (
      clip.text !== undefined &&
      (typeof clip.text !== "string" || clip.text.length > 50000)
    )
      invalid("字幕内容无效。");
  }
  if (!duration) invalid("请先添加片段。");
  const assetIds = new Set<string>();
  let totalBytes = 0;
  for (const value of data.assets) {
    const asset = record(value);
    assertId(asset.id);
    if (
      assetIds.has(asset.id) ||
      !["video", "audio", "image"].includes(String(asset.kind)) ||
      typeof asset.name !== "string" ||
      asset.name.length > 512
    )
      invalid("素材数据无效。");
    assetIds.add(asset.id);
    assertNumber(asset.size, 1, MAX_ASSET_BYTES, "素材大小", true);
    totalBytes += asset.size;
    assertNumber(asset.duration, 0, 43200, "素材时长");
    assertNumber(asset.width, 0, 16384, "素材宽度", true);
    assertNumber(asset.height, 0, 16384, "素材高度", true);
  }
  if (totalBytes > MAX_TOTAL_BYTES) invalid("单次导出素材总大小超过 100 GB。");
  const input = structuredClone(data) as unknown as NativeJobInput;
  for (const item of visibleExportItems(input.project)) {
    if (item.kind !== "subtitle" && !assetIds.has(item.clip.assetId ?? ""))
      invalid("工程引用了缺失的素材。");
  }
  return input;
}
interface Job {
  id: string;
  dir: string;
  input: NativeJobInput;
  status: NativeJobStatus;
  assets: Map<
    string,
    {
      metadata: NativeAssetMetadata;
      filename: string;
      uploaded: boolean;
      hasAudio: boolean;
    }
  >;
  subtitles: Map<string, { filename: string; uploaded: boolean }>;
  uploads: Set<string>;
  transfers: Set<Promise<void>>;
  controller: AbortController;
  task?: Promise<void>;
  touched: number;
  output: string;
}
export function renderErrorResponse(error: unknown): Response {
  const issue =
    error instanceof RenderError
      ? error
      : new RenderError(
          500,
          "native_render_error",
          "本地导出失败，请重试或使用浏览器引擎。",
        );
  return Response.json(
    { error: { message: issue.message, code: issue.code } },
    { status: issue.status, headers: { "Cache-Control": "no-store" } },
  );
}
export const runNativeProcess: NativeProcessRunner = async (
  binary,
  args,
  options,
) => {
  if (options.signal?.aborted)
    throw new RenderError(499, "cancelled", "导出已取消。");
  return new Promise((resolve, reject) => {
    const process = spawn(binary, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    let stdout = "",
      stderr = "",
      progressBuffer = "",
      timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = () => {
      process.kill("SIGTERM");
      killTimer = setTimeout(() => process.kill("SIGKILL"), 1000);
      killTimer.unref();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    timeout.unref();
    const abort = () => terminate();
    options.signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
    };
    process.stdout.setEncoding("utf8");
    process.stderr.setEncoding("utf8");
    process.stdout.on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-65536);
      progressBuffer += chunk;
      const lines = progressBuffer.split(/\r?\n/);
      progressBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const match = line.match(/^out_time_(?:us|ms)=(\d+)$/);
        if (match) options.onProgress?.(Number(match[1]) / 1e6);
      }
    });
    process.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-65536);
    });
    process.on("error", (error) => {
      cleanup();
      reject(error);
    });
    process.on("close", (code) => {
      cleanup();
      if (options.signal?.aborted)
        reject(new RenderError(499, "cancelled", "导出已取消。"));
      else if (timedOut)
        reject(
          new RenderError(
            504,
            "render_timeout",
            "本地视频引擎处理超时，请减少导出范围后重试。",
          ),
        );
      else resolve({ code: code ?? -1, stdout, stderr });
    });
  });
};

export function createNativeExportService(
  options: NativeExportServiceOptions = {},
) {
  const runner = options.runner ?? runNativeProcess;
  const hostPlatform = options.platform ?? platform();
  const jobs = new Map<string, Job>();
  const serviceController = new AbortController();
  let creating = 0;
  let binary = "",
    active: string | undefined,
    disposed = false;
  let capabilitiesPromise: Promise<NativeCapabilities> | undefined;
  const ttl = options.ttlMs ?? 3600000;
  const reap = setInterval(
    () => {
      for (const job of jobs.values())
        if (!job.task && Date.now() - job.touched > ttl)
          void removeJob(job).catch(() => {});
    },
    Math.min(ttl, 60000),
  );
  reap.unref();
  async function capabilities(): Promise<NativeCapabilities> {
    if (!capabilitiesPromise)
      capabilitiesPromise = (async () => {
        const candidates = [
          options.binaryPath,
          process.env.VIDEOCUP_FFMPEG_PATH,
        ];
        try {
          const require = createRequire(import.meta.url);
          const bundled: unknown = require("ffmpeg-static");
          if (typeof bundled === "string") candidates.push(bundled);
        } catch {
          /* PATH remains available. */
        }
        candidates.push("ffmpeg");
        for (const candidate of [
          ...new Set(
            candidates.filter((value): value is string => Boolean(value)),
          ),
        ]) {
          try {
            if (candidate !== "ffmpeg") await access(candidate, constants.X_OK);
            const result = await runner(
              candidate,
              ["-hide_banner", "-encoders"],
              { timeoutMs: 10000, signal: serviceController.signal },
            );
            if (result.code !== 0) continue;
            const encoders = [
              ...new Set(
                [
                  ...`${result.stdout}\n${result.stderr}`.matchAll(
                    /^\s*[VAS][A-Z.]{5}\s+(\S+)/gm,
                  ),
                ].map((match) => match[1]!),
              ),
            ];
            if (
              !encoders.includes("libx264") &&
              !encoders.includes("h264_videotoolbox")
            )
              continue;
            binary = candidate;
            return {
              available: true,
              encoders,
              preferredEncoder:
                hostPlatform === "darwin" &&
                encoders.includes("h264_videotoolbox")
                  ? "h264_videotoolbox"
                  : "libx264",
              platform: hostPlatform,
              maxAssetBytes: MAX_ASSET_BYTES,
            };
          } catch {
            /* Try the next trusted local candidate. */
          }
        }
        return {
          available: false,
          encoders: [],
          preferredEncoder: "",
          platform: hostPlatform,
          maxAssetBytes: MAX_ASSET_BYTES,
          reason: "未找到可用的本地 FFmpeg，将使用浏览器视频引擎。",
        };
      })();
    return capabilitiesPromise;
  }
  function getJob(id: string) {
    if (!SAFE_ID.test(id))
      throw new RenderError(404, "job_not_found", "导出任务不存在。");
    const job = jobs.get(id);
    if (!job)
      throw new RenderError(404, "job_not_found", "导出任务不存在或已经清理。");
    job.touched = Date.now();
    return job;
  }
  async function removeJob(job: Job) {
    job.controller.abort();
    await Promise.allSettled([
      ...(job.task ? [job.task] : []),
      ...job.transfers,
    ]);
    await rm(job.dir, { recursive: true, force: true });
    jobs.delete(job.id);
  }
  async function create(value: unknown) {
    if (disposed)
      throw new RenderError(503, "service_closed", "本地导出服务已经关闭。");
    const input = validateInput(value);
    const support = await capabilities();
    if (!support.available)
      throw new RenderError(503, "ffmpeg_unavailable", support.reason!);
    if (disposed)
      throw new RenderError(503, "service_closed", "本地导出服务已经关闭。");
    if (jobs.size + creating >= (options.maxJobs ?? 3))
      throw new RenderError(
        429,
        "too_many_jobs",
        "本地导出任务过多，请完成或取消其他任务。",
      );
    const id = crypto.randomUUID();
    let dir: string;
    creating++;
    try {
      dir = await mkdtemp(
        join(options.tempRoot ?? tmpdir(), "video-cup-render-"),
      );
    } finally {
      creating--;
    }
    if (disposed) {
      await rm(dir, { recursive: true, force: true });
      throw new RenderError(503, "service_closed", "本地导出服务已经关闭。");
    }
    const used = new Set(
      visibleExportItems(input.project)
        .filter((item) => item.kind !== "subtitle")
        .map((item) => item.clip.assetId),
    );
    const assets: Job["assets"] = new Map();
    for (const [index, metadata] of input.assets.entries()) {
      if (!used.has(metadata.id)) continue;
      const extension = metadata.name.split(".").pop()?.toLowerCase();
      const safeExtension =
        extension && /^[a-z0-9]{1,8}$/.test(extension)
          ? extension
          : metadata.kind === "audio"
            ? "mp3"
            : metadata.kind === "image"
              ? "png"
              : "mp4";
      assets.set(metadata.id, {
        metadata,
        filename: `asset-${index}.${safeExtension}`,
        uploaded: false,
        hasAudio: false,
      });
    }
    const subtitles: Job["subtitles"] = new Map();
    if (input.options.subtitles && !input.options.audioOnly)
      for (const item of visibleExportItems(input.project)) {
        if (item.kind === "subtitle" && item.clip.text?.trim())
          subtitles.set(item.clip.id, {
            filename: `subtitle-${subtitles.size}.png`,
            uploaded: false,
          });
      }
    const status: NativeJobStatus = {
      jobId: id,
      phase: "uploading",
      progress: 0,
      fileSize: 0,
      encoder: input.options.audioOnly
        ? "libmp3lame"
        : support.preferredEncoder,
    };
    const job: Job = {
      id,
      dir,
      input,
      status,
      assets,
      subtitles,
      uploads: new Set(),
      transfers: new Set(),
      controller: new AbortController(),
      touched: Date.now(),
      output: input.options.audioOnly ? "export.mp3" : "export.mp4",
    };
    jobs.set(id, job);
    return {
      jobId: id,
      requiredAssetIds: [...assets.keys()],
      requiredSubtitleIds: [...subtitles.keys()],
    };
  }
  async function upload(job: Job, type: string, id: string, request: Request) {
    if (job.status.phase !== "uploading")
      throw new RenderError(
        409,
        "job_started",
        "导出已开始，不能继续上传素材。",
      );
    const target =
      type === "assets" ? job.assets.get(id) : job.subtitles.get(id);
    if (!target)
      throw new RenderError(404, "asset_not_found", "任务不需要此素材或字幕。");
    const key = `${type}/${id}`;
    if (target.uploaded || job.uploads.has(key))
      throw new RenderError(
        409,
        "already_uploaded",
        "此素材已经上传或正在上传。",
      );
    const expected =
      type === "assets" ? job.assets.get(id)!.metadata.size : undefined;
    const max = expected ?? MAX_PNG_BYTES;
    const declared = request.headers.get("content-length");
    if (
      declared &&
      (Number(declared) > max ||
        (expected !== undefined && Number(declared) !== expected))
    )
      throw new RenderError(
        413,
        "upload_size_mismatch",
        "素材上传大小与工程记录不一致。",
      );
    if (!request.body)
      throw new RenderError(400, "empty_upload", "没有收到素材内容。");
    const path = join(job.dir, target.filename),
      partial = `${path}.part`;
    job.uploads.add(key);
    const task = (async () => {
      const file = await open(partial, "wx");
      const reader = request.body!.getReader();
      const signal = AbortSignal.any([request.signal, job.controller.signal]);
      let bytes = 0,
        prefix = new Uint8Array(0);
      const abort = () => {
        void reader.cancel().catch(() => {});
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        while (true) {
          if (signal.aborted)
            throw new RenderError(499, "cancelled", "素材上传已取消。");
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > max)
            throw new RenderError(
              413,
              "upload_too_large",
              "素材上传超过预期大小。",
            );
          if (prefix.length < 24) {
            const next = new Uint8Array(
              Math.min(24, prefix.length + value.length),
            );
            next.set(prefix);
            next.set(
              value.subarray(0, next.length - prefix.length),
              prefix.length,
            );
            prefix = next;
          }
          let offset = 0;
          while (offset < value.length)
            offset += (await file.write(value, offset, value.length - offset))
              .bytesWritten;
          job.touched = Date.now();
        }
        if (signal.aborted)
          throw new RenderError(499, "cancelled", "素材上传已取消。");
        if (!bytes || (expected !== undefined && bytes !== expected))
          throw new RenderError(
            400,
            "upload_size_mismatch",
            "素材上传不完整，请重试。",
          );
        if (type === "subtitles") {
          const view = new DataView(prefix.buffer);
          if (
            prefix.length < 24 ||
            !PNG.every((byte, index) => byte === prefix[index]) ||
            new TextDecoder().decode(prefix.subarray(12, 16)) !== "IHDR"
          )
            invalid("字幕上传必须是 PNG 图片。");
          const width = view.getUint32(16),
            height = view.getUint32(20);
          if (
            !width ||
            !height ||
            width > 8192 ||
            height > 8192 ||
            width * height > 36000000
          )
            invalid("字幕图片尺寸过大。");
        }
        await file.close();
        await rename(partial, path);
        target.uploaded = true;
      } finally {
        signal.removeEventListener("abort", abort);
        await reader.cancel().catch(() => {});
        reader.releaseLock();
        await file.close().catch(() => {});
        await rm(partial, { force: true });
        job.uploads.delete(key);
      }
    })();
    job.transfers.add(task);
    try {
      await task;
    } finally {
      job.transfers.delete(task);
    }
  }
  async function execute(job: Job) {
    const timeout = setTimeout(() => {
      job.status.error = "导出任务处理超时。";
      job.controller.abort();
    }, options.jobTimeoutMs ?? 7200000);
    timeout.unref();
    const run = async (
      args: string[],
      onProgress?: (seconds: number) => void,
    ) => {
      const result = await runner(
        binary,
        [
          "-nostdin",
          "-hide_banner",
          "-loglevel",
          "warning",
          "-progress",
          "pipe:1",
          "-nostats",
          ...args,
        ],
        {
          cwd: job.dir,
          signal: job.controller.signal,
          timeoutMs: options.commandTimeoutMs ?? 300000,
          onProgress,
        },
      );
      if (result.code !== 0) {
        const detail = result.stderr
          .split(/\r?\n/)
          .filter((line) =>
            /error|failed|invalid|not found|cannot|videotoolbox/i.test(line),
          )
          .slice(-3)
          .join(" ")
          .slice(-600);
        throw new RenderError(
          500,
          "ffmpeg_failed",
          `本地导出失败：${detail || `FFmpeg 状态 ${result.code}`}。`,
        );
      }
      return result;
    };
    try {
      job.status.phase = "rendering";
      const { project, options: exportOptions } = job.input;
      for (const source of job.assets.values()) {
        if (source.metadata.kind === "image") continue;
        const result = await runner(
          binary,
          ["-nostdin", "-hide_banner", ...safeInputArgs, "-i", source.filename],
          { cwd: job.dir, signal: job.controller.signal, timeoutMs: 15000 },
        );
        source.hasAudio = /Stream[^\r\n]*Audio:/i.test(
          `${result.stderr}\n${result.stdout}`,
        );
        if (
          !/Stream[^\r\n]*(?:Audio|Video):/i.test(
            `${result.stderr}\n${result.stdout}`,
          )
        )
          throw new RenderError(
            400,
            "invalid_media",
            "素材无法被本地视频引擎识别，请检查文件是否损坏。",
          );
      }
      const items = visibleExportItems(project);
      const sources = new Map<string, ExportSource>();
      for (const [id, source] of job.assets)
        sources.set(id, {
          name: source.filename,
          hasAudio: source.hasAudio,
          asset: { ...source.metadata, blob: new Blob(), url: "" },
        });
      const subtitles = new Map(
        [...job.subtitles].map(([id, value]) => [id, value.filename]),
      );
      // Native memory is independent of the browser heap; longer windows avoid
      // repeatedly opening decoders/encoders on long uninterrupted clips.
      const segments = planExportSegments(project, 30);
      if (!segments.length)
        throw new RenderError(400, "empty_timeline", "工程没有可导出的片段。");
      const duration = segments.at(-1)!.end;
      const videoNames = segments.map((_, i) => `video-${i}.mp4`),
        audioNames = segments.map((_, i) => `audio-${i}.flac`);
      const inputNames = new Set(
        [...job.assets.values()]
          .map((source) => source.filename)
          .concat(
            [...job.subtitles.values()].map((subtitle) => subtitle.filename),
          ),
      );
      const renderSegments = async () => {
        for (const [index, segment] of segments.entries()) {
          if (job.controller.signal.aborted)
            throw new RenderError(499, "cancelled", "导出已取消。");
          const hardware = job.status.encoder === "h264_videotoolbox";
          const args = buildExportSegment(
            project,
            exportOptions,
            segment,
            items,
            sources,
            subtitles,
            videoNames[index]!,
            audioNames[index]!,
            {
              decoderThreads: 0,
              encoderThreads: 0,
              filterThreads: Math.max(1, Math.min(8, cpus().length)),
              videoEncoder: hardware ? "h264_videotoolbox" : "libx264",
              encoderArgs: hardware
                ? [
                    "-q:v",
                    exportOptions.quality === "high" ? "70" : "60",
                    "-allow_sw",
                    "1",
                    "-realtime",
                    "1",
                  ]
                : [
                    "-preset",
                    "veryfast",
                    "-crf",
                    exportOptions.quality === "high" ? "18" : "23",
                  ],
            },
          );
          const guarded: string[] = [];
          for (let at = 0; at < args.length; at++) {
            if (args[at] === "-i" && inputNames.has(args[at + 1] ?? ""))
              guarded.push(...safeInputArgs);
            guarded.push(args[at]!);
          }
          await run(guarded, (seconds) => {
            job.status.progress = Math.min(
              94.9,
              (95 *
                (segment.start +
                  Math.min(segment.end - segment.start, seconds))) /
                duration,
            );
          });
          job.status.progress = (95 * segment.end) / duration;
        }
      };
      try {
        await renderSegments();
      } catch (error) {
        if (
          job.controller.signal.aborted ||
          job.status.encoder !== "h264_videotoolbox" ||
          !(await capabilities()).encoders.includes("libx264") ||
          !/videotoolbox|vtcompression|hardware|encoder|Error while opening/i.test(
            String(error),
          )
        )
          throw error;
        job.status.encoder = "libx264";
        job.status.hardwareFallback = true;
        job.status.progress = 0;
        for (const filename of [...videoNames, ...audioNames])
          await rm(join(job.dir, filename), { force: true });
        await renderSegments();
      }
      await writeFile(
        join(job.dir, "video-segments.txt"),
        concatManifest(videoNames, segments),
      );
      await writeFile(
        join(job.dir, "audio-segments.txt"),
        concatManifest(audioNames, segments),
      );
      job.status.phase = "joining";
      await run(
        buildExportJoin(exportOptions, duration, job.output),
        (seconds) => {
          job.status.progress = Math.min(99.9, 95 + (5 * seconds) / duration);
        },
      );
      const result = await stat(join(job.dir, job.output));
      if (!result.size)
        throw new RenderError(500, "empty_output", "本地视频引擎未生成文件。");
      job.status.fileSize = result.size;
      job.status.phase = "completed";
      job.status.progress = 100;
      // Segments are disposable; keep only original uploads and the downloadable result until TTL/delete.
      for (const filename of [
        ...videoNames,
        ...audioNames,
        "video-segments.txt",
        "audio-segments.txt",
      ])
        await rm(join(job.dir, filename), { force: true });
    } catch (error) {
      job.status.phase = job.controller.signal.aborted ? "cancelled" : "failed";
      job.status.error =
        job.status.error ??
        (error instanceof Error ? error.message : "本地导出失败。");
    } finally {
      clearTimeout(timeout);
      job.touched = Date.now();
      job.task = undefined;
      if (active === job.id) active = undefined;
    }
  }
  async function start(job: Job) {
    if (job.status.phase !== "uploading")
      throw new RenderError(409, "job_started", "此任务已经开始或结束。");
    if (
      job.uploads.size ||
      [...job.assets.values(), ...job.subtitles.values()].some(
        (value) => !value.uploaded,
      )
    )
      throw new RenderError(409, "missing_uploads", "请先完成素材和字幕上传。");
    if (active)
      throw new RenderError(
        409,
        "renderer_busy",
        "另一个本地导出任务正在处理中。",
      );
    active = job.id;
    job.status.phase = "queued";
    job.task = execute(job);
  }
  async function handle(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url),
        origin = request.headers.get("origin");
      if (
        !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname) ||
        (origin && origin !== url.origin) ||
        request.headers.get("sec-fetch-site") === "cross-site"
      )
        throw new RenderError(
          403,
          "local_access_only",
          "本地导出接口仅限当前电脑上的编辑器使用。",
        );
      const path = url.pathname;
      if (path === "/api/render/capabilities" && request.method === "GET")
        return Response.json(await capabilities(), {
          headers: { "Cache-Control": "no-store" },
        });
      if (path === "/api/render/jobs" && request.method === "POST") {
        if (
          !/^application\/json(?:\s*;|$)/i.test(
            request.headers.get("content-type") ?? "",
          )
        )
          throw new RenderError(
            415,
            "unsupported_media_type",
            "请使用 JSON 创建导出任务。",
          );
        if (Number(request.headers.get("content-length")) > MAX_JSON_BYTES)
          throw new RenderError(413, "request_too_large", "工程数据过大。");
        const reader = request.body?.getReader();
        if (!reader) invalid("缺少工程数据。");
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > MAX_JSON_BYTES)
              throw new RenderError(413, "request_too_large", "工程数据过大。");
            chunks.push(value);
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        let value: unknown;
        try {
          value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          invalid("工程 JSON 格式无效。");
        }
        return Response.json(await create(value), { status: 201 });
      }
      const match = path.match(
        /^\/api\/render\/jobs\/([a-zA-Z0-9_-]+)(?:\/(status|start|file|assets|subtitles)(?:\/([a-zA-Z0-9_-]+))?)?$/,
      );
      if (!match) throw new RenderError(404, "not_found", "导出接口不存在。");
      const job = getJob(match[1]!);
      const action = match[2],
        item = match[3];
      if (!action && request.method === "DELETE") {
        await removeJob(job);
        return new Response(null, { status: 204 });
      }
      if (action === "status" && request.method === "GET")
        return Response.json(job.status, {
          headers: { "Cache-Control": "no-store" },
        });
      if (
        (action === "assets" || action === "subtitles") &&
        item &&
        request.method === "PUT"
      ) {
        await upload(job, action, item, request);
        return new Response(null, { status: 204 });
      }
      if (action === "start" && request.method === "POST") {
        await start(job);
        return Response.json(job.status, { status: 202 });
      }
      if (action === "file" && request.method === "GET") {
        if (job.status.phase !== "completed")
          throw new RenderError(409, "not_completed", "导出尚未完成。");
        const file = createReadStream(join(job.dir, job.output), {
          signal: request.signal,
        });
        return new Response(
          Readable.toWeb(file) as ReadableStream<Uint8Array>,
          {
            headers: {
              "Content-Type": job.input.options.audioOnly
                ? "audio/mpeg"
                : "video/mp4",
              "Content-Length": String(job.status.fileSize),
              "Content-Disposition": `attachment; filename="video-cup.${job.input.options.audioOnly ? "mp3" : "mp4"}"`,
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
            },
          },
        );
      }
      throw new RenderError(405, "method_not_allowed", "导出请求方法无效。");
    } catch (error) {
      return renderErrorResponse(error);
    }
  }
  async function dispose() {
    disposed = true;
    serviceController.abort();
    clearInterval(reap);
    await Promise.allSettled([...jobs.values()].map(removeJob));
  }
  return { handle, capabilities, dispose };
}
