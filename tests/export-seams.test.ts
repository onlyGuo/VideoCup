import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildExportJoin,
  buildExportSegment,
  concatManifest,
  planExportSegments,
  visibleExportItems,
  type ExportOptions,
  type ExportSource,
  type ExportExecutionProfile,
} from "../src/lib/export-plan";
import {
  createClip,
  newProject,
  type Asset,
  type Project,
} from "../src/lib/types";
import { getVisualFilter } from "../src/lib/transform";

interface Core {
  FS: {
    writeFile(name: string, bytes: Uint8Array): void;
    readFile(name: string): Uint8Array;
  };
  exec(...args: string[]): number;
  reset(): void;
  ret: number;
  setLogger(callback: (event: { message: string }) => void): void;
}

describe.sequential("actual CFR boundary frames and still-image export", () => {
  let ff: Core;
  const logs: string[] = [];
  const options: ExportOptions = {
    width: 64,
    height: 48,
    audioOnly: false,
    subtitles: false,
    quality: "normal",
  };
  const red: Asset = {
    id: "red",
    name: "red.mp4",
    kind: "video",
    blob: new Blob(),
    url: "",
    duration: 3,
    width: 64,
    height: 48,
  };
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
      if (logs.length > 40) logs.shift();
    });
    for (const color of ["red", "green"])
      run([
        "-f",
        "lavfi",
        "-i",
        `color=c=${color}:s=64x48:r=24000/1001:d=3`,
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-y",
        `${color}.mp4`,
      ]);
    run([
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=64x48:r=30:d=3",
      "-vf",
      "select='not(eq(mod(n,5),1))*not(eq(mod(n,5),2))'",
      "-vsync",
      "vfr",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-output_ts_offset",
      "3",
      "-y",
      "vfr.mp4",
    ]);
    const rgba = new Uint8Array(64 * 48 * 4);
    for (let y = 12; y < 36; y++)
      for (let x = 16; x < 48; x++)
        rgba.set([0, 0, 255, 255], (y * 64 + x) * 4);
    ff.FS.writeFile("image.rgba", rgba);
    run([
      "-f",
      "rawvideo",
      "-pixel_format",
      "rgba",
      "-video_size",
      "64x48",
      "-i",
      "image.rgba",
      "-frames:v",
      "1",
      "-y",
      "image.png",
    ]);
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
  function timeline(speed = 1, gap = 0, secondAsset = red) {
    const project = newProject();
    project.width = 64;
    project.height = 48;
    const track = project.tracks.find((track) => track.kind === "video")!;
    const first = createClip(track.id, red);
    first.in = 0.017;
    first.out = first.in + 0.37 * speed;
    first.speed = speed;
    const second = createClip(track.id, secondAsset, 0.37 + gap);
    second.in = 0.011;
    second.out = second.in + 0.37 * speed;
    second.speed = speed;
    project.clips = [first, second];
    return project;
  }
  function render(
    project: Project,
    sources: Map<string, ExportSource>,
    seconds = 12,
    profile?: ExportExecutionProfile,
  ) {
    const segments = planExportSegments(project, seconds);
    const videos: string[] = [],
      audio: string[] = [];
    for (let index = 0; index < segments.length; index++) {
      const video = `seam-${index}.mp4`,
        sound = `seam-${index}.flac`;
      run(
        buildExportSegment(
          project,
          options,
          segments[index]!,
          visibleExportItems(project),
          sources,
          new Map(),
          video,
          sound,
          profile,
        ),
      );
      videos.push(video);
      audio.push(sound);
    }
    ff.FS.writeFile(
      "video-segments.txt",
      new TextEncoder().encode(concatManifest(videos, segments)),
    );
    ff.FS.writeFile(
      "audio-segments.txt",
      new TextEncoder().encode(concatManifest(audio, segments)),
    );
    const duration = Math.max(
      ...project.clips.map(
        (clip) => clip.start + (clip.out - clip.in) / clip.speed,
      ),
    );
    run(buildExportJoin(options, duration, "seams.mp4"));
    run([
      "-i",
      "seams.mp4",
      "-map",
      "0:v:0",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-y",
      "frames.rgb",
    ]);
    const rgb = ff.FS.readFile("frames.rgb");
    const count = rgb.length / (64 * 48 * 3);
    return {
      count,
      pixel(frame: number, x = 32, y = 24) {
        const offset = frame * 64 * 48 * 3 + (y * 64 + x) * 3;
        return [...rgb.slice(offset, offset + 3)];
      },
    };
  }
  const source = () =>
    new Map([[red.id, { name: "red.mp4", asset: red, hasAudio: false }]]);

  it.each([0.5, 0.75, 1, 1.5, 2, 4, 8])(
    "preserves every visible frame across a fractional cut at %s×",
    (speed) => {
      const frame = render(timeline(speed), source());
      expect(frame.count).toBe(23);
      for (let index = 0; index < frame.count; index++)
        expect(frame.pixel(index)[0], `frame ${index}`).toBeGreaterThan(200);
    },
  );

  it("keeps actual timeline gaps black while retaining both adjacent visible edge frames", () => {
    const frame = render(timeline(1, 0.09), source());
    const black: number[] = [];
    for (let index = 0; index < frame.count; index++)
      if (Math.max(...frame.pixel(index)) < 40) black.push(index);
    expect(black).toEqual([12, 13]);
    expect(frame.pixel(11)[0]).toBeGreaterThan(200);
    expect(frame.pixel(14)[0]).toBeGreaterThan(200);
  });

  it("switches source colors at the correct output frame without inserting a transition frame", () => {
    const green: Asset = { ...red, id: "green", name: "green.mp4" };
    const sources = source();
    sources.set(green.id, { name: "green.mp4", asset: green, hasAudio: false });
    const frame = render(timeline(1, 0, green), sources);
    expect(frame.pixel(11)[0]).toBeGreaterThan(200);
    expect(frame.pixel(12)[0]).toBeLessThan(10);
    expect(frame.pixel(12)[1]).toBeGreaterThan(100);
  });

  it("samples VFR media with a nonzero stream start and preserves seams between fixed chunks", () => {
    const frame = render(
      timeline(0.75),
      new Map([[red.id, { name: "vfr.mp4", asset: red, hasAudio: false }]]),
      0.1,
    );
    expect(frame.count).toBe(23);
    for (let index = 0; index < frame.count; index++)
      expect(frame.pixel(index)[0], `VFR frame ${index}`).toBeGreaterThan(200);
  });

  it("loops a transformed transparent still image and does not add a soundtrack even with stale audio metadata", () => {
    const asset: Asset = {
      ...red,
      id: "still",
      name: "image.png",
      kind: "image",
      duration: 5,
    };
    const project = newProject();
    project.width = 64;
    project.height = 48;
    const track = project.tracks.find((track) => track.kind === "video")!;
    const clip = createClip(track.id, asset);
    clip.out = 0.3;
    clip.crop = { x: 10, y: 0, width: 80, height: 100 };
    clip.transform = { x: 60, y: 50, scaleX: 0.8, scaleY: 0.8, rotation: 15 };
    project.tracks.push({ ...track, id: "background" });
    const background = createClip("background", red);
    background.out = 0.3;
    project.clips = [background, clip];
    const sources = new Map([
      [red.id, { name: "red.mp4", asset: red, hasAudio: false }],
      [asset.id, { name: "image.png", asset, hasAudio: true }],
    ]);
    const args = buildExportSegment(
      project,
      options,
      planExportSegments(project)[0]!,
      visibleExportItems(project),
      sources,
      new Map(),
      "still.mp4",
      "still.flac",
    );
    expect(args).toContain("-loop");
    expect(args[args.indexOf("-filter_complex") + 1]).not.toContain("[3:a]");
    // Native and WASM execute the same image graph with their own encoder profile.
    const frame = render(project, sources, 0.1, {
      decoderThreads: 0,
      encoderThreads: 0,
      filterThreads: 1,
      videoEncoder: "libx264",
      encoderArgs: ["-preset", "veryfast", "-crf", "23", "-bf", "0"],
    });
    expect(frame.count).toBe(9);
    for (let index = 0; index < frame.count; index++) {
      expect(frame.pixel(index)[2], `still frame ${index}`).toBeGreaterThan(
        230,
      );
      expect(frame.pixel(index, 1, 1)[0]).toBeGreaterThan(200);
      expect(frame.pixel(index, 1, 1)[2]).toBeLessThan(20);
    }
  });

  it("keeps opaque video in YUV and preserves RGBA for opacity, rotation, and image transparency", () => {
    const clip = timeline().clips[0]!;
    const opaque = getVisualFilter(clip, red, options, { opaque: true }).filter;
    expect(opaque).toContain("format=yuv420p");
    expect(opaque).not.toContain("rgba");
    expect(opaque).not.toContain("colorchannelmixer");
    clip.opacity = 0.5;
    expect(
      getVisualFilter(clip, red, options, { opaque: true }).filter,
    ).toContain("format=rgba");
    clip.opacity = 1;
    clip.transform!.rotation = 15;
    expect(
      getVisualFilter(clip, red, options, { opaque: true }).filter,
    ).toContain("format=rgba");
  });

  it("exposes native encoder profiles without changing WASM's bounded defaults", () => {
    const project = timeline();
    const segment = planExportSegments(project)[0]!;
    const args = buildExportSegment(
      project,
      options,
      segment,
      visibleExportItems(project),
      source(),
      new Map(),
      "native.mp4",
      "native.flac",
      {
        decoderThreads: 0,
        encoderThreads: 0,
        filterThreads: 4,
        videoEncoder: "h264_videotoolbox",
        encoderArgs: ["-b:v", "5M", "-bf", "0"],
      },
    );
    expect(args).toContain("h264_videotoolbox");
    expect(args).not.toContain("-crf");
    expect(args).not.toContain("-preset");
    expect(args[args.indexOf("-filter_complex_threads") + 1]).toBe("4");
    const safe = buildExportSegment(
      project,
      options,
      segment,
      visibleExportItems(project),
      source(),
      new Map(),
      "safe.mp4",
      "safe.flac",
    );
    expect(safe[safe.indexOf("-threads") + 1]).toBe("1");
    expect(safe).toContain("libx264");
  });
});
