import { getEngine } from "./ffmpeg";
import type { Asset } from "./types";
import { uid } from "./types";
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function waitForMedia(
  element: HTMLMediaElement,
  ready: () => boolean,
  timeoutMessage: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const events = [
      "loadedmetadata",
      "loadeddata",
      "canplay",
      "durationchange",
      "resize",
      "seeked",
    ];
    const cleanup = () => {
      clearTimeout(timeout);
      events.forEach((event) => element.removeEventListener(event, check));
      element.removeEventListener("error", fail);
    };
    const fail = () => {
      cleanup();
      reject(new Error("浏览器无法解码此媒体"));
    };
    const check = () => {
      if (element.error) fail();
      else if (ready()) {
        cleanup();
        resolve();
      }
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(timeoutMessage));
    }, 15000);
    events.forEach((event) => element.addEventListener(event, check));
    element.addEventListener("error", fail);
    // Metadata/data may already be cached before listeners are attached.
    check();
  });
}

export const imageFile = (blob: Blob, name: string) =>
  blob.type.startsWith("image/") ||
  /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(name);

async function readImageAsset(blob: Blob, name: string): Promise<Asset> {
  let url = URL.createObjectURL(blob);
  const image = document.createElement("img");
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        image.onload = null;
        image.onerror = null;
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("图片读取超时"));
      }, 15000);
      image.onload = () => {
        cleanup();
        image.naturalWidth > 0 && image.naturalHeight > 0
          ? resolve()
          : reject(new Error("图片尺寸无效"));
      };
      image.onerror = () => {
        cleanup();
        reject(new Error("无法解码此图片"));
      };
      image.src = url;
    });
    // Normalize less widely supported/animated formats to a static PNG frame.
    // Original files stay untouched; the project stores the decoded still.
    if (
      !/\.(png|jpe?g|webp)$/i.test(name) &&
      !["image/png", "image/jpeg", "image/webp"].includes(blob.type)
    ) {
      const full = document.createElement("canvas");
      full.width = image.naturalWidth;
      full.height = image.naturalHeight;
      const context = full.getContext("2d");
      if (!context) throw new Error("浏览器无法绘制图片");
      context.drawImage(image, 0, 0);
      blob = await new Promise<Blob>((resolve, reject) =>
        full.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("图片转换失败"))),
          "image/png",
        ),
      );
      URL.revokeObjectURL(url);
      url = URL.createObjectURL(blob);
      name = name.replace(/\.[^.]+$/, "") + ".png";
    }
    const thumbnail = document.createElement("canvas");
    const scale = Math.min(
      1,
      320 / image.naturalWidth,
      180 / image.naturalHeight,
    );
    thumbnail.width = Math.max(1, Math.round(image.naturalWidth * scale));
    thumbnail.height = Math.max(1, Math.round(image.naturalHeight * scale));
    thumbnail
      .getContext("2d")
      ?.drawImage(image, 0, 0, thumbnail.width, thumbnail.height);
    return {
      id: uid(),
      name,
      blob,
      url,
      kind: "image",
      duration: 5,
      width: image.naturalWidth,
      height: image.naturalHeight,
      thumbnail: thumbnail.toDataURL("image/png"),
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  } finally {
    image.removeAttribute("src");
  }
}

export async function readAsset(
  blob: Blob,
  name: string,
  durationHint?: number,
): Promise<Asset> {
  if (imageFile(blob, name)) return readImageAsset(blob, name);
  const kind =
    /\.(mp3|wav|ogg|m4a|aac)$/i.test(name) || blob.type.startsWith("audio/")
      ? "audio"
      : "video";
  const url = URL.createObjectURL(blob);
  const el = document.createElement(kind === "video" ? "video" : "audio");
  el.preload = "auto";
  if (kind === "video") (el as HTMLVideoElement).playsInline = true;
  el.src = url;
  try {
    await waitForMedia(
      el,
      () => el.readyState >= 1,
      "无法读取媒体时长，请尝试其他文件或转换格式",
    );
    const duration = Number.isFinite(el.duration) ? el.duration : durationHint;
    if (!duration || duration <= 0) throw new Error("媒体时长无效");
    const video = el as HTMLVideoElement;
    let thumbnail: string | undefined;
    if (kind === "video") {
      // A MOV container can expose duration/audio metadata even when its video
      // codec is unsupported. Require a drawable frame so import can transcode.
      await waitForMedia(
        el,
        () =>
          video.readyState >= 2 &&
          video.videoWidth > 0 &&
          video.videoHeight > 0,
        "无法解码视频画面，请尝试转换格式",
      );
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 180;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("浏览器无法绘制视频画面");
      // Do not seek solely for a thumbnail: a video at time zero does not emit
      // seeked, and metadata alone is not sufficient for drawImage.
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      try {
        thumbnail = canvas.toDataURL("image/jpeg", 0.7);
      } catch {
        /* A thumbnail encoding failure does not invalidate a decoded frame. */
      }
    }
    const asset: Asset = {
      id: uid(),
      name,
      blob,
      url,
      kind,
      duration,
      width: video.videoWidth || 0,
      height: video.videoHeight || 0,
      ...(thumbnail ? { thumbnail } : {}),
    };
    if (kind === "audio") {
      try {
        const ctx = new AudioContext();
        try {
          const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
          const samples = audio.getChannelData(0);
          asset.waveform = Array.from({ length: 90 }, (_, i) => {
            const step = Math.max(1, Math.floor(samples.length / 90));
            let peak = 0;
            for (
              let j = i * step;
              j < Math.min(samples.length, (i + 1) * step);
              j += Math.max(1, Math.floor(step / 100))
            )
              peak = Math.max(peak, Math.abs(samples[j]!));
            return peak;
          });
        } finally {
          await ctx.close();
        }
      } catch {
        /* Some audio formats cannot be decoded for a waveform. */
      }
    }
    return asset;
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  } finally {
    el.removeAttribute("src");
    el.load();
  }
}
export function subtitleCanvas(
  text: string,
  width: number,
  height: number,
  fontSize: number,
  color: string,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const size = (fontSize * height) / 1080;
  ctx.font = `600 ${size}px system-ui, "PingFang SC", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.lineJoin = "round";
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const char of paragraph) {
      if (ctx.measureText(line + char).width > width * 0.85 && line) {
        lines.push(line);
        line = "";
      }
      line += char;
    }
    lines.push(line);
  }
  lines.forEach((line, i) => {
    const y = height * 0.91 - (lines.length - 1 - i) * size * 1.45;
    ctx.strokeStyle = "rgba(0,0,0,.85)";
    ctx.lineWidth = size * 0.12;
    ctx.strokeText(line, width / 2, y);
    ctx.fillStyle = color;
    ctx.fillText(line, width / 2, y);
  });
  return canvas;
}
export async function makeDemo(): Promise<{ video: Asset; audio: Asset }> {
  const canvas = document.createElement("canvas");
  canvas.width = 960;
  canvas.height = 540;
  const ctx = canvas.getContext("2d")!;
  const sky = ctx.createLinearGradient(0, 0, 0, 540);
  sky.addColorStop(0, "#a7c4c5");
  sky.addColorStop(0.65, "#f1e2b9");
  sky.addColorStop(1, "#7caa9a");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 960, 540);
  ctx.fillStyle = "#f9efd3";
  ctx.beginPath();
  ctx.arc(684, 150, 45, 0, Math.PI * 2);
  ctx.fill();
  const ridge = (color: string, base: number, peak: number, shift: number) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, 540);
    for (let x = 0; x <= 1000; x += 8)
      ctx.lineTo(
        x,
        base -
          Math.sin((x + shift) / 220) * peak -
          Math.sin((x + shift) / 77) * peak * 0.15,
      );
    ctx.lineTo(960, 540);
    ctx.fill();
  };
  ridge("#7e9c99", 325, 83, 90);
  ridge("#456e68", 405, 65, 400);
  ridge("#214e47", 500, 70, 120);
  ctx.fillStyle = "#ffffffb0";
  ctx.font = "12px monospace";
  ctx.fillText("VIDEOCUP / LOCAL DEMO", 34, 36);
  const image = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("示例画面生成失败"))),
      "image/png",
    ),
  );
  const ff = await getEngine();
  let video: Asset;
  try {
    await ff.writeFile("demo.png", new Uint8Array(await image.arrayBuffer()));
    const code = await ff.exec([
      "-loop",
      "1",
      "-i",
      "demo.png",
      "-vf",
      "zoompan=z='min(zoom+0.0003,1.05)':d=144:s=960x540:fps=24",
      "-t",
      "6",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-an",
      "-y",
      "demo.mp4",
    ]);
    if (code !== 0) throw new Error("示例生成失败，请导入本地媒体");
    const bytes = (await ff.readFile("demo.mp4")) as Uint8Array;
    video = await readAsset(
      new Blob([new Uint8Array(bytes)], { type: "video/mp4" }),
      "山间来信.mp4",
    );
  } finally {
    await Promise.allSettled([
      ff.deleteFile("demo.png"),
      ff.deleteFile("demo.mp4"),
    ]);
  }
  const rate = 22050;
  const length = rate * 6;
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const str = (at: number, value: string) =>
    [...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  str(0, "RIFF");
  view.setUint32(4, 36 + length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, "data");
  view.setUint32(40, length * 2, true);
  for (let i = 0; i < length; i++) {
    const t = i / rate;
    const fade = Math.min(t, 6 - t, 1);
    const tone =
      Math.sin(t * Math.PI * 2 * 220) * 0.07 +
      Math.sin(t * Math.PI * 2 * 330) * 0.035 +
      Math.sin(t * Math.PI * 2 * 440) * 0.025;
    view.setInt16(44 + i * 2, tone * fade * 32767, true);
  }
  return {
    video,
    audio: await readAsset(
      new Blob([buffer], { type: "audio/wav" }),
      "山间 · 氛围音.wav",
    ),
  };
}
