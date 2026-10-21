import { FFmpeg, FFFSType } from "@ffmpeg/ffmpeg";
import coreURL from "@ffmpeg/core?url";
import wasmURL from "@ffmpeg/core/wasm?url";
import type { Asset, Project } from "./types";
import { endOf } from "./types";
import { subtitleCanvas } from "./media";
import {
  buildExportJoin,
  buildExportSegment,
  concatManifest,
  planExportSegments,
  visibleExportItems,
  type ExportOptions,
  type ExportSource,
} from "./export-plan";
export { tempo } from "./export-plan";
let engine: FFmpeg | null = null;
let loading: Promise<FFmpeg> | null = null;
export async function getEngine(status: (message: string) => void = () => {}) {
  if (engine?.loaded) return engine;
  if (loading) return loading;
  status("正在加载本地视频引擎…");
  loading = (async () => {
    const ff = new FFmpeg();
    engine = ff;
    try {
      await ff.load({ coreURL, wasmURL });
      engine = ff;
      return ff;
    } catch (error) {
      ff.terminate();
      throw error;
    } finally {
      loading = null;
    }
  })();
  return loading;
}
export function cancelEngine() {
  engine?.terminate();
  engine = null;
  loading = null;
}
const num = (n: number) => Number(n.toFixed(5)).toString();
export async function convertMedia(
  blob: Blob,
  name: string,
  status: (s: string) => void,
): Promise<Blob> {
  const ff = await getEngine(status);
  const input = `convert.${
    name
      .split(".")
      .pop()
      ?.replace(/[^a-z0-9]/gi, "") || "mpv"
  }`;
  try {
    status("正在转换媒体为 MP4…");
    await ff.writeFile(input, new Uint8Array(await blob.arrayBuffer()));
    if (
      (await ff.exec([
        "-i",
        input,
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        "-y",
        "converted.mp4",
      ])) !== 0
    )
      throw new Error("转换失败：文件可能损坏或编码不受支持");
    const data = (await ff.readFile("converted.mp4")) as Uint8Array;
    return new Blob([new Uint8Array(data)], { type: "video/mp4" });
  } finally {
    await Promise.allSettled([
      ff.deleteFile(input),
      ff.deleteFile("converted.mp4"),
    ]);
  }
}
export async function extractAudio(
  asset: Asset,
  status: (s: string) => void,
): Promise<Blob> {
  const ff = await getEngine(status);
  const input = `source.${asset.name.split(".").pop() || "mp4"}`;
  try {
    status("正在分离音轨…");
    await ff.writeFile(input, new Uint8Array(await asset.blob.arrayBuffer()));
    const code = await ff.exec([
      "-i",
      input,
      "-vn",
      "-c:a",
      "pcm_s16le",
      "-y",
      "extracted.wav",
    ]);
    if (code !== 0) throw new Error("此视频没有可分离的音轨");
    const data = (await ff.readFile("extracted.wav")) as Uint8Array;
    return new Blob([new Uint8Array(data)], { type: "audio/wav" });
  } finally {
    await Promise.allSettled([
      ff.deleteFile(input),
      ff.deleteFile("extracted.wav"),
    ]);
  }
}
/** Mount immutable Blobs directly in the worker: never duplicate entire videos in JS and MEMFS. */
async function mountSources(
  ff: FFmpeg,
  assets: Pick<Asset, "id" | "name" | "blob">[],
) {
  const path = `/media-${crypto.randomUUID()}`;
  const names = new Map<string, string>();
  const blobs = assets.map((asset, index) => {
    const extension =
      asset.name
        .split(".")
        .pop()
        ?.replace(/[^a-z0-9]/gi, "") || "mp4";
    const name = `asset-${index}.${extension}`;
    names.set(asset.id, `${path}/${name}`);
    return { name, data: asset.blob };
  });
  await ff.createDir(path);
  try {
    if (!(await ff.mount(FFFSType.WORKERFS, { blobs }, path))) {
      throw new Error(
        "浏览器视频引擎不支持直接读取本地素材，请更新浏览器后重试",
      );
    }
  } catch (error) {
    await ff.deleteDir(path).catch(() => {});
    throw error;
  }
  return {
    names,
    async close() {
      await ff.unmount(path).catch(() => {});
      await ff.deleteDir(path).catch(() => {});
    },
  };
}

export function exportFailure(logs: string[]) {
  const memory = logs.find((line) =>
    /Cannot allocate|out of memory|memory access out of bounds/i.test(line),
  );
  const detail =
    memory ||
    [...logs]
      .reverse()
      .find((line: string) =>
        /Error while|Invalid argument|Cannot allocate|out of memory|memory access out of bounds|Error initializing|Failed to|does not contain|not found|No such/i.test(
          line,
        ),
      );
  return new Error(
    detail
      ? `导出失败：${detail.trim()}。编辑记录已保留。`
      : "导出失败，视频引擎未能完成编码。编辑记录已保留，请重试；详细原因见浏览器控制台。",
  );
}

export async function exportMedia(
  project: Project,
  assets: Asset[],
  options: ExportOptions,
  onStatus: (s: string) => void,
  onProgress: (n: number) => void,
): Promise<Blob> {
  const duration = Math.max(0, ...project.clips.map(endOf));
  if (!duration) throw new Error("请先添加片段");
  const ff = await getEngine(onStatus);
  const logs: string[] = [];
  const log = ({ message }: { message: string }) => {
    logs.push(message);
    if (logs.length > 80) logs.shift();
  };
  let phaseStart = 0;
  let phaseSpan = 0;
  let phaseDuration = duration;
  const progress = ({ time }: { time: number }) =>
    onProgress(
      Math.min(
        99,
        phaseStart +
          phaseSpan * Math.max(0, Math.min(1, time / 1e6 / phaseDuration)),
      ),
    );
  ff.on("log", log);
  ff.on("progress", progress);
  const files = new Set<string>();
  const write = async (name: string, bytes: Uint8Array) => {
    files.add(name);
    await ff.writeFile(name, bytes);
  };
  const execute = async (args: string[]) => {
    logs.length = 0;
    try {
      if ((await ff.exec(args)) !== 0) throw exportFailure(logs);
    } catch (error) {
      console.error("FFmpeg export failed", logs.join("\n"), error);
      if (error instanceof Error && error.message.startsWith("导出失败"))
        throw error;
      throw exportFailure([...logs, String(error)]);
    }
  };
  let mounted: Awaited<ReturnType<typeof mountSources>> | undefined;
  let mountedParts: Awaited<ReturnType<typeof mountSources>> | undefined;
  try {
    onStatus("准备直接读取本地素材…");
    const items = visibleExportItems(project);
    const used = new Set(
      items
        .filter((item) => item.kind !== "subtitle")
        .map((item) => item.clip.assetId),
    );
    mounted = await mountSources(
      ff,
      assets.filter((asset) => used.has(asset.id)),
    );
    const sources = new Map<string, ExportSource>();
    for (const asset of assets.filter((asset) => used.has(asset.id))) {
      const name = mounted.names.get(asset.id)!;
      if (asset.kind === "image") {
        sources.set(asset.id, { name, asset, hasAudio: false });
        continue;
      }
      const probeName = "export-probe.json";
      files.add(probeName);
      await ff.ffprobe([
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type",
        "-of",
        "json",
        name,
        "-o",
        probeName,
      ]);
      const text = (await ff.readFile(probeName, "utf8")) as string;
      const probe = JSON.parse(text) as { streams?: { codec_type: string }[] };
      if (!probe.streams?.length)
        throw new Error(`无法读取素材：${asset.name}`);
      sources.set(asset.id, {
        name,
        asset,
        hasAudio: probe.streams.some((stream) => stream.codec_type === "audio"),
      });
      await ff.deleteFile(probeName);
      files.delete(probeName);
    }
    const segments = planExportSegments(project);
    const videos: string[] = [];
    const audio: string[] = [];
    const parts: Pick<Asset, "id" | "name" | "blob">[] = [];
    const detachPart = async (name: string, type: string) => {
      const bytes = (await ff.readFile(name)) as Uint8Array<ArrayBuffer>;
      parts.push({ id: name, name, blob: new Blob([bytes], { type }) });
      await ff.deleteFile(name);
      files.delete(name);
    };
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index]!;
      const subtitleNames = new Map<string, string>();
      if (options.subtitles && !options.audioOnly) {
        for (const { clip, kind } of items) {
          if (
            kind !== "subtitle" ||
            !clip.text ||
            endOf(clip) <= segment.start ||
            clip.start >= segment.end
          )
            continue;
          const canvas = subtitleCanvas(
            clip.text,
            options.width,
            options.height,
            clip.fontSize,
            clip.color,
          );
          const blob = await new Promise<Blob>((resolve, reject) =>
            canvas.toBlob(
              (blob) =>
                blob ? resolve(blob) : reject(new Error("字幕渲染失败")),
              "image/png",
            ),
          );
          const name = `subtitle-${subtitleNames.size}.png`;
          await write(name, new Uint8Array(await blob.arrayBuffer()));
          // Release this canvas backing store immediately, even on long subtitle tracks.
          canvas.width = canvas.height = 1;
          subtitleNames.set(clip.id, name);
        }
      }
      const videoName = `segment-${index}.mp4`;
      const audioName = `segment-${index}.flac`;
      if (!options.audioOnly) {
        files.add(videoName);
        videos.push(videoName);
      }
      files.add(audioName);
      audio.push(audioName);
      onStatus(`正在分段编码 ${index + 1}/${segments.length}，请保持页面打开…`);
      phaseStart = (segment.start / duration) * 94;
      phaseSpan = ((segment.end - segment.start) / duration) * 94;
      phaseDuration = segment.end - segment.start;
      await execute(
        buildExportSegment(
          project,
          options,
          segment,
          items,
          sources,
          subtitleNames,
          videoName,
          audioName,
        ),
      );
      for (const name of subtitleNames.values()) {
        await ff.deleteFile(name);
        files.delete(name);
      }
      // Blob backing storage is shared with WORKERFS; avoid retaining every
      // intermediate output alongside the final MP4 in the worker's MEMFS.
      if (!options.audioOnly) await detachPart(videoName, "video/mp4");
      await detachPart(audioName, "audio/flac");
      onProgress(Math.min(94, (segment.end / duration) * 94));
    }
    mountedParts = await mountSources(ff, parts);
    const encoder = new TextEncoder();
    if (!options.audioOnly)
      await write(
        "video-segments.txt",
        encoder.encode(
          concatManifest(
            videos.map((name) => mountedParts!.names.get(name)!),
            segments,
          ),
        ),
      );
    await write(
      "audio-segments.txt",
      encoder.encode(
        concatManifest(
          audio.map((name) => mountedParts!.names.get(name)!),
          segments,
        ),
      ),
    );
    const output = options.audioOnly ? "export.mp3" : "export.mp4";
    files.add(output);
    onStatus("正在合并成片与音轨…");
    phaseStart = 94;
    phaseSpan = 5;
    phaseDuration = duration;
    await execute(buildExportJoin(options, duration, output));
    const data = (await ff.readFile(output)) as Uint8Array<ArrayBuffer>;
    const blob = new Blob([data], {
      type: options.audioOnly ? "audio/mpeg" : "video/mp4",
    });
    onProgress(100);
    return blob;
  } finally {
    ff.off("progress", progress);
    ff.off("log", log);
    await Promise.allSettled([...files].map((name) => ff.deleteFile(name)));
    await mountedParts?.close();
    await mounted?.close();
    // WASM heaps do not shrink after a large export; a fresh worker releases all decoder and output memory.
    ff.terminate();
    if (engine === ff) {
      engine = null;
      loading = null;
    }
  }
}
