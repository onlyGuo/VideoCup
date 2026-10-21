import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClip } from "../src/lib/types";
import type { Asset } from "../src/lib/types";
import { getVisualFilter } from "../src/lib/transform";

interface FFmpegCore {
  FS: {
    writeFile(name: string, bytes: Uint8Array): void;
    readFile(name: string): Uint8Array;
    readFile(name: string, options: { encoding: "utf8" }): string;
  };
  exec(...args: string[]): number;
  ffprobe(...args: string[]): number;
  ret: number;
  reset(): void;
  setLogger(callback: (event: { message: string }) => void): void;
}

// Exercise the actual bundled WASM used for export without a browser, worker,
// downloaded binary, or native FFmpeg installation. Node built-ins are loaded
// dynamically so browser application type checking does not need @types/node.
describe.sequential("FFmpeg WASM media processing", () => {
  let ff: FFmpegCore;
  const logs: string[] = [];

  beforeAll(async () => {
    const moduleName = "node:module";
    const fsName = "node:fs";
    const [{ createRequire }, { readFileSync }] = await Promise.all([
      import(/* @vite-ignore */ moduleName),
      import(/* @vite-ignore */ fsName),
    ]);
    const require = createRequire(import.meta.url);
    vi.stubGlobal("self", { location: { href: "file:///ffmpeg-core.js" } });
    const createCore = require("@ffmpeg/core") as (options: {
      wasmBinary: Uint8Array;
    }) => Promise<FFmpegCore>;
    ff = await createCore({
      wasmBinary: readFileSync(require.resolve("@ffmpeg/core/wasm")),
    });
    ff.setLogger(({ message }) => {
      logs.push(message);
      if (logs.length > 30) logs.shift();
    });
  });

  afterAll(() => vi.unstubAllGlobals());

  function render(width: number, height: number, rotation = -30) {
    const asset: Asset = {
      id: "red-video",
      name: "red.mp4",
      kind: "video",
      blob: new Blob(),
      url: "",
      duration: 1,
      width: 200,
      height: 100,
    };
    const video = createClip("video", asset);
    video.transform = {
      x: 75,
      y: 44.444444,
      scaleX: 0.5,
      scaleY: 0.5,
      rotation: 30,
    };
    video.opacity = 0.5;
    const subtitle = createClip("subtitle", undefined);
    subtitle.text = "字幕";
    subtitle.transform = {
      x: 25,
      y: 50,
      scaleX: 0.5,
      scaleY: 0.5,
      rotation,
    };
    subtitle.opacity = 0.75;

    // A transparent subtitle canvas with a yellow glyph below its center.
    const rgba = new Uint8Array(width * height * 4);
    for (
      let y = Math.round((height * 150) / 180);
      y < Math.round((height * 170) / 180);
      y++
    )
      for (
        let x = Math.round((width * 150) / 320);
        x < Math.round((width * 170) / 320);
        x++
      )
        rgba.set([255, 255, 0, 255], (y * width + x) * 4);
    ff.FS.writeFile("subtitle.rgba", rgba);
    const v = getVisualFilter(video, asset, { width, height });
    const s = getVisualFilter(subtitle, undefined, { width, height });
    const filter = [
      "[0:v]format=yuva420p[base]",
      `[1:v]${v.filter}[visual]`,
      `[base][visual]overlay=x=${v.x}:y=${v.y}:format=auto:eof_action=pass[video]`,
      `[2:v]${s.filter}[subtitle]`,
      `[video][subtitle]overlay=x=${s.x}:y=${s.y}:format=auto:eof_action=pass,format=rgb24[out]`,
    ].join(";");
    logs.length = 0;
    try {
      ff.exec(
        "-f",
        "lavfi",
        "-i",
        `color=c=blue:s=${width}x${height}:r=30:d=0.1`,
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=200x100:r=30:d=0.1",
        "-f",
        "rawvideo",
        "-pixel_format",
        "rgba",
        "-video_size",
        `${width}x${height}`,
        "-framerate",
        "30",
        "-i",
        "subtitle.rgba",
        "-filter_complex_threads",
        "1",
        "-filter_complex",
        filter,
        "-map",
        "[out]",
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-y",
        "result.rgb",
      );
      expect(ff.ret, logs.join("\n")).toBe(0);
      const rgb = ff.FS.readFile("result.rgb");
      expect(rgb.length).toBe(width * height * 3);
      return {
        rgb,
        // Coordinates use the 320 × 180 reference canvas at either resolution.
        pixel(x: number, y: number) {
          const index =
            (Math.round((y * height) / 180) * width +
              Math.round((x * width) / 320)) *
            3;
          return Array.from(rgb.slice(index, index + 3));
        },
      };
    } finally {
      ff.reset();
    }
  }

  it.each([
    [320, 180],
    [640, 360],
  ])(
    "preserves position, scale, rotation, and opacity at %i × %i",
    (width, height) => {
      const frame = render(width!, height!);
      const blue = frame.pixel(5, 5);
      expect(blue[0]).toBeLessThan(5);
      expect(blue[1]).toBeLessThan(5);
      expect(blue[2]).toBeGreaterThan(240);

      const red = frame.pixel(240, 80);
      expect(red[0]).toBeGreaterThan(120);
      expect(red[0]).toBeLessThan(135);
      expect(red[1]).toBeLessThan(5);
      expect(red[2]).toBeGreaterThan(120);
      expect(red[2]).toBeLessThan(135);

      const yellow = frame.pixel(97, 120);
      expect(yellow[0]).toBeGreaterThan(185);
      expect(yellow[1]).toBeGreaterThan(185);
      expect(yellow[2]).toBeGreaterThan(55);
      expect(yellow[2]).toBeLessThan(70);
    },
  );

  it("normalizes a full turn and renders both half-turn boundaries identically", () => {
    expect(render(320, 180, 360).rgb).toEqual(render(320, 180, 0).rgb);
    const halfTurn = render(320, 180, 180);
    expect(halfTurn.rgb).toEqual(render(320, 180, -180).rgb);
    // The glyph began below the canvas center and must move above it.
    const glyph = halfTurn.pixel(80, 55);
    expect(glyph[0]).toBeGreaterThan(185);
    expect(glyph[1]).toBeGreaterThan(185);
    expect(glyph[2]).toBeLessThan(70);
  });

  it("converts an MPEG-4 Part 2 / PCM MOV to a decodable H.264 / AAC MP4", () => {
    const run = (args: string[], probe = false) => {
      logs.length = 0;
      try {
        if (probe) ff.ffprobe(...args);
        else ff.exec(...args);
        // The bundled ffprobe can leave ret at -1 after a successful run;
        // require its JSON stream metadata below rather than that return field.
        if (!probe) expect(ff.ret, logs.join("\n")).toBe(0);
      } finally {
        ff.reset();
      }
    };
    const probe = (name: string) => {
      run(
        [
          "-v",
          "error",
          "-show_entries",
          "stream=codec_type,codec_name,width,height,pix_fmt:format=duration",
          "-of",
          "json",
          name,
          "-o",
          "mov-probe.json",
        ],
        true,
      );
      return JSON.parse(
        ff.FS.readFile("mov-probe.json", { encoding: "utf8" }),
      ) as {
        streams: {
          codec_type: string;
          codec_name: string;
          width?: number;
          height?: number;
          pix_fmt?: string;
        }[];
        format: { duration: string };
      };
    };

    // Generate a tiny fixture locally and exercise the MOV conversion path.
    // Media mocks separately cover metadata-only/browser decode rejection;
    // this test makes no claim about a particular browser's codec support.
    run([
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=64x48:r=10:d=0.3",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=16000:duration=0.3",
      "-c:v",
      "mpeg4",
      "-q:v",
      "4",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "pcm_s16le",
      "-shortest",
      "-y",
      "compatibility.mov",
    ]);
    const source = probe("compatibility.mov");
    expect(source.streams.some((s) => s.codec_name === "mpeg4")).toBe(true);
    expect(source.streams.some((s) => s.codec_name === "pcm_s16le")).toBe(true);

    // Keep these arguments aligned with convertMedia in src/lib/ffmpeg.ts.
    run([
      "-i",
      "compatibility.mov",
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
    ]);
    const converted = probe("converted.mp4");
    expect(
      converted.streams.find((s) => s.codec_type === "video"),
    ).toMatchObject({
      codec_name: "h264",
      width: 64,
      height: 48,
      pix_fmt: "yuv420p",
    });
    expect(
      converted.streams.find((s) => s.codec_type === "audio"),
    ).toMatchObject({ codec_name: "aac" });
    expect(Number(converted.format.duration)).toBeGreaterThanOrEqual(0.3);
    expect(Number(converted.format.duration)).toBeLessThan(0.6);
    expect(ff.FS.readFile("converted.mp4").length).toBeGreaterThan(1000);

    run([
      "-i",
      "converted.mp4",
      "-map",
      "0:v:0",
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-y",
      "converted-frame.rgb",
    ]);
    const frame = ff.FS.readFile("converted-frame.rgb");
    expect(frame.length).toBe(64 * 48 * 3);
    expect(frame[0]).toBeGreaterThan(220);
    expect(frame[1]).toBeLessThan(30);
    expect(frame[2]).toBeLessThan(30);
  });
});
