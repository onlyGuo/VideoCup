import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import {
  buildExportJoin,
  buildExportSegment,
  concatManifest,
  planExportSegments,
  visibleExportItems,
  type ExportOptions,
  type ExportSource,
} from "../src/lib/export-plan";
import { createClip, newProject, type Asset } from "../src/lib/types";

interface Core {
  FS: {
    writeFile(name: string, bytes: Uint8Array): void;
    readFile(name: string): Uint8Array;
    readFile(name: string, options: { encoding: "utf8" }): string;
    unlink(name: string): void;
    mkdir(name: string): void;
    rmdir(name: string): void;
    mount(type: unknown, options: unknown, point: string): void;
    unmount(point: string): void;
    filesystems: { WORKERFS: unknown };
  };
  exec(...args: string[]): number;
  ffprobe(...args: string[]): number;
  ret: number;
  reset(): void;
  setLogger(callback: (event: { message: string }) => void): void;
  HEAPU8: Uint8Array;
}

describe.sequential(
  "bounded-memory timeline export with the real bundled WASM",
  () => {
    let ff: Core;
    const logs: string[] = [];
    beforeAll(async () => {
      const moduleName = "node:module",
        fsName = "node:fs";
      const [{ createRequire }, { readFileSync }] = await Promise.all([
        import(/* @vite-ignore */ moduleName),
        import(/* @vite-ignore */ fsName),
      ]);
      const require = createRequire(import.meta.url);
      vi.stubGlobal("self", { location: { href: "file:///ffmpeg-core.js" } });
      ff = await require("@ffmpeg/core")({
        wasmBinary: readFileSync(require.resolve("@ffmpeg/core/wasm")),
      });
      ff.setLogger(({ message }) => {
        logs.push(message);
        if (logs.length > 70) logs.shift();
      });
    });
    afterAll(() => vi.unstubAllGlobals());
    function run(args: string[]) {
      logs.length = 0;
      try {
        ff.exec(...args);
        expect(ff.ret, logs.join("\n")).toBe(0);
      } finally {
        ff.reset();
      }
    }
    function probe(name: string) {
      try {
        ff.ffprobe(
          "-v",
          "error",
          "-show_entries",
          "stream=codec_type,codec_name,width,height,nb_frames:format=duration",
          "-of",
          "json",
          name,
          "-o",
          "probe.json",
        );
      } finally {
        ff.reset();
      }
      return JSON.parse(ff.FS.readFile("probe.json", { encoding: "utf8" }));
    }

    it("exports repeated MOV trims at 4×, a rotated second video, subtitles and audio at 1080p; joins MP4 and MP3", () => {
      run([
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=3022x1952:r=10:d=0.8",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000:duration=0.8",
        "-c:v",
        "mpeg4",
        "-q:v",
        "4",
        "-c:a",
        "pcm_s16le",
        "-shortest",
        "-y",
        "large.mov",
      ]);
      run([
        "-f",
        "lavfi",
        "-i",
        "color=c=yellow:s=1920x1080:r=1:d=1",
        "-frames:v",
        "1",
        "-y",
        "subtitle.png",
      ]);
      const asset: Asset = {
        id: "large",
        name: "large.mov",
        kind: "video",
        blob: new Blob(),
        url: "",
        duration: 0.8,
        width: 3022,
        height: 1952,
      };
      const project = newProject();
      project.tracks = [
        {
          id: "sub",
          kind: "subtitle",
          name: "sub",
          hidden: false,
          muted: false,
          locked: false,
        },
        {
          id: "upper",
          kind: "video",
          name: "upper",
          hidden: false,
          muted: true,
          locked: false,
        },
        {
          id: "video",
          kind: "video",
          name: "video",
          hidden: false,
          muted: false,
          locked: false,
        },
      ];
      project.clips = Array.from({ length: 16 }, (_, index) => {
        const clip = createClip("video", asset, index * 0.1);
        clip.in = (index % 4) * 0.1;
        clip.out = clip.in + 0.4;
        clip.speed = 4;
        return clip;
      });
      const upper = createClip("upper", asset, 0.3);
      upper.out = 0.8;
      upper.speed = 2;
      upper.transform = {
        x: 70,
        y: 40,
        scaleX: 0.4,
        scaleY: 0.5,
        rotation: 30,
      };
      upper.crop = { x: 10, y: 0, width: 80, height: 100 };
      project.clips.push(upper);
      const subtitle = createClip("sub", undefined, 0.2);
      subtitle.out = 1.1;
      subtitle.text = "test";
      subtitle.opacity = 0.2;
      subtitle.transform = {
        x: 50,
        y: 50,
        scaleX: 0.25,
        scaleY: 0.25,
        rotation: -12,
      };
      project.clips.push(subtitle);
      const options: ExportOptions = {
        width: 1920,
        height: 1080,
        audioOnly: false,
        subtitles: true,
        quality: "normal",
      };
      const sources = new Map<string, ExportSource>([
        [asset.id, { asset, name: "large.mov", hasAudio: true }],
      ]);
      const subtitles = new Map([[subtitle.id, "subtitle.png"]]);
      const segments = planExportSegments(project, 0.4);
      expect(segments).toHaveLength(16);
      const videos: string[] = [],
        audio: string[] = [];
      segments.forEach((segment, index) => {
        const video = `v${index}.mp4`,
          sound = `a${index}.flac`;
        const args = buildExportSegment(
          project,
          options,
          segment,
          visibleExportItems(project),
          sources,
          subtitles,
          video,
          sound,
        );
        // A 16-way split of one long MOV must not open 16 simultaneous video decoders.
        expect(
          args.filter((arg) => arg === "large.mov").length,
        ).toBeLessThanOrEqual(2);
        run(args);
        videos.push(video);
        audio.push(sound);
      });
      ff.FS.writeFile(
        "video-segments.txt",
        new TextEncoder().encode(concatManifest(videos, segments)),
      );
      ff.FS.writeFile(
        "audio-segments.txt",
        new TextEncoder().encode(concatManifest(audio, segments)),
      );
      run(buildExportJoin(options, 1.6, "finished.mp4"));
      const mp4 = probe("finished.mp4");
      expect(
        mp4.streams.find(
          (stream: { codec_type: string }) => stream.codec_type === "video",
        ),
      ).toMatchObject({
        codec_name: "h264",
        width: 1920,
        height: 1080,
        nb_frames: "48",
      });
      expect(
        mp4.streams.find(
          (stream: { codec_type: string }) => stream.codec_type === "audio",
        ).codec_name,
      ).toBe("aac");
      expect(Number(mp4.format.duration)).toBeCloseTo(1.6, 1);
      run(
        buildExportJoin({ ...options, audioOnly: true }, 1.6, "finished.mp3"),
      );
      const mp3 = probe("finished.mp3");
      expect(mp3.streams).toHaveLength(1);
      expect(mp3.streams[0].codec_name).toBe("mp3");
      expect(Number(mp3.format.duration)).toBeCloseTo(1.6, 1);
      // Decode, rather than only trusting the container header and encoder status.
      run([
        "-i",
        "finished.mp4",
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-y",
        "frame.rgb",
      ]);
      expect(ff.FS.readFile("frame.rgb").length).toBe(1920 * 1080 * 3);
      run([
        "-i",
        "finished.mp4",
        "-map",
        "0:a:0",
        "-f",
        "s16le",
        "-y",
        "audio.pcm",
      ]);
      const pcm = ff.FS.readFile("audio.pcm");
      expect(pcm.some((value) => value !== 0)).toBe(true);
      console.info(
        "repeated MOV export WASM heap bytes",
        ff.HEAPU8.buffer.byteLength,
      );
    }, 120000);

    it("reads an immutable input through the actual WORKERFS range reader", () => {
      let reads = 0,
        largestRead = 0;
      class RangeBlob {
        readonly size: number;
        constructor(readonly bytes: Uint8Array) {
          this.size = bytes.length;
        }
        slice(start: number, end: number) {
          return new RangeBlob(this.bytes.subarray(start, end));
        }
      }
      vi.stubGlobal(
        "FileReaderSync",
        class {
          readAsArrayBuffer(blob: RangeBlob) {
            reads++;
            largestRead = Math.max(largestRead, blob.size);
            return blob.bytes.buffer.slice(
              blob.bytes.byteOffset,
              blob.bytes.byteOffset + blob.bytes.byteLength,
            );
          }
        },
      );
      const source = new RangeBlob(ff.FS.readFile("large.mov"));
      ff.FS.mkdir("/readonly-media");
      ff.FS.mount(
        ff.FS.filesystems.WORKERFS,
        { blobs: [{ name: "source.mov", data: source }] },
        "/readonly-media",
      );
      try {
        expect(
          probe("/readonly-media/source.mov").streams.some(
            (stream: { codec_name: string }) => stream.codec_name === "mpeg4",
          ),
        ).toBe(true);
        run([
          "-ss",
          "0.2",
          "-i",
          "/readonly-media/source.mov",
          "-map",
          "0:v:0",
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "-y",
          "mounted.rgb",
        ]);
        expect(ff.FS.readFile("mounted.rgb").length).toBe(3022 * 1952 * 3);
        expect(reads).toBeGreaterThan(0);
        expect(largestRead).toBeLessThan(source.size);
      } finally {
        ff.FS.unmount("/readonly-media");
        ff.FS.rmdir("/readonly-media");
      }
    });

    it("renders an audio-only window without opening video streams or leaving unused filter labels", () => {
      const asset: Asset = {
        id: "sound",
        name: "large.mov",
        kind: "video",
        blob: new Blob(),
        url: "",
        duration: 0.8,
        width: 3022,
        height: 1952,
      };
      const project = newProject();
      const track = project.tracks.find((track) => track.kind === "video")!;
      const clip = createClip(track.id, asset, 0.05);
      clip.in = 0.2;
      clip.out = 0.6;
      clip.speed = 2;
      project.clips = [clip];
      const options: ExportOptions = {
        width: 1920,
        height: 1080,
        audioOnly: true,
        subtitles: true,
        quality: "normal",
      };
      const segment = { start: 0, end: 0.3, frames: 9 };
      const args = buildExportSegment(
        project,
        options,
        segment,
        visibleExportItems(project),
        new Map([[asset.id, { asset, name: "large.mov", hasAudio: true }]]),
        new Map(),
        "unused.mp4",
        "audio-only.flac",
      );
      expect(args).not.toContain("[vout]");
      expect(args).not.toContain("unused.mp4");
      run(args);
      ff.FS.writeFile(
        "audio-segments.txt",
        new TextEncoder().encode(
          concatManifest(["audio-only.flac"], [segment]),
        ),
      );
      run(buildExportJoin(options, 0.3, "audio-only.mp3"));
      expect(probe("audio-only.mp3").streams[0].codec_name).toBe("mp3");
    });

    it("caps off-canvas RGBA rotation buffers for three overlapping 4× layers at 1080p", () => {
      const asset: Asset = {
        id: "scale",
        name: "large.mov",
        kind: "video",
        blob: new Blob(),
        url: "",
        duration: 0.8,
        width: 3022,
        height: 1952,
      };
      const project = newProject();
      const track = project.tracks.find((track) => track.kind === "video")!;
      project.clips = Array.from({ length: 3 }, () => {
        const clip = createClip(track.id, asset);
        clip.out = 0.1;
        clip.transform = { x: 50, y: 50, scaleX: 4, scaleY: 4, rotation: 45 };
        return clip;
      });
      const options: ExportOptions = {
        width: 1920,
        height: 1080,
        audioOnly: false,
        subtitles: true,
        quality: "normal",
      };
      const sources = new Map([
        [asset.id, { asset, name: "large.mov", hasAudio: true }],
      ]);
      const segment = planExportSegments(project)[0]!;
      run(
        buildExportSegment(
          project,
          options,
          segment,
          visibleExportItems(project),
          sources,
          new Map(),
          "scaled.mp4",
          "scaled.flac",
        ),
      );
      expect(probe("scaled.mp4").streams[0].width).toBe(1920);
      console.info(
        "three 4× rotated layers WASM heap bytes",
        ff.HEAPU8.buffer.byteLength,
      );
      expect(ff.HEAPU8.buffer.byteLength).toBeLessThan(2147483648);
    }, 120000);
  },
);
