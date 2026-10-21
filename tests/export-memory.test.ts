import { afterEach, describe, expect, it, vi } from "vitest";
import { createClip, newProject, type Asset } from "../src/lib/types";

const mock = vi.hoisted(() => {
  const worker = {
    loaded: false,
    load: vi.fn(async () => {
      worker.loaded = true;
      return true;
    }),
    createDir: vi.fn(async () => true),
    deleteDir: vi.fn(async () => true),
    mount: vi.fn(
      async (
        _type: string,
        _options: { blobs: { name: string; data: Blob }[] },
        _path: string,
      ) => true,
    ),
    unmount: vi.fn(
      async (
        _type: string,
        _options: { blobs: { name: string; data: Blob }[] },
        _path: string,
      ) => true,
    ),
    ffprobe: vi.fn(async () => 0),
    exec: vi.fn(async (_args: string[]) => 0),
    writeFile: vi.fn(async () => true),
    readFile: vi.fn(async (name: string) =>
      name.endsWith(".json")
        ? JSON.stringify({
            streams: [{ codec_type: "video" }, { codec_type: "audio" }],
          })
        : new Uint8Array([1, 2, 3]),
    ),
    deleteFile: vi.fn(async () => true),
    terminate: vi.fn(() => {
      worker.loaded = false;
    }),
    on: vi.fn(),
    off: vi.fn(),
  };
  return { worker };
});
vi.mock("@ffmpeg/ffmpeg", () => ({
  FFmpeg: class {
    constructor() {
      return mock.worker;
    }
  },
  FFFSType: { WORKERFS: "WORKERFS" },
}));
import { exportFailure, exportMedia } from "../src/lib/ffmpeg";

afterEach(() => vi.clearAllMocks());

describe("large-project export input memory and recovery", () => {
  it("mounts a reused Blob once without calling its arrayBuffer; exports only bounded active windows and releases its worker", async () => {
    const blob = new Blob(["large source"]);
    const read = vi
      .spyOn(blob, "arrayBuffer")
      .mockRejectedValue(new Error("must never duplicate the entire input"));
    const asset: Asset = {
      id: "long",
      name: "large.mov",
      kind: "video",
      blob,
      url: "",
      duration: 1400,
      width: 3022,
      height: 1952,
    };
    const project = newProject();
    const track = project.tracks.find((track) => track.kind === "video")!;
    project.clips = Array.from({ length: 16 }, (_, index) => {
      const clip = createClip(track.id, asset, index * 3);
      clip.in = index * 12;
      clip.out = clip.in + 12;
      clip.speed = 4;
      return clip;
    });
    const blobOutput = await exportMedia(
      project,
      [asset],
      {
        width: 1920,
        height: 1080,
        audioOnly: false,
        subtitles: false,
        quality: "normal",
      },
      vi.fn(),
      vi.fn(),
    );
    expect(blobOutput.type).toBe("video/mp4");
    expect(read).not.toHaveBeenCalled();
    expect(mock.worker.mount).toHaveBeenCalledTimes(2);
    expect(mock.worker.mount.mock.calls[0]?.[1]).toEqual({
      blobs: [{ name: "asset-0.mov", data: blob }],
    });
    const renderCalls = mock.worker.exec.mock.calls.filter(([args]) =>
      args.includes("-filter_complex"),
    );
    expect(renderCalls).toHaveLength(16);
    for (const [args] of renderCalls) {
      const sourceInputs = args.filter((arg: string) =>
        arg.endsWith("/asset-0.mov"),
      );
      expect(sourceInputs).toHaveLength(1);
    }
    expect(mock.worker.unmount).toHaveBeenCalledTimes(2);
    expect(mock.worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("exports still images without probing them as an audio/video source", async () => {
    const asset: Asset = {
      id: "picture",
      name: "picture.png",
      kind: "image",
      blob: new Blob(["png"]),
      url: "",
      duration: 5,
      width: 640,
      height: 480,
    };
    const project = newProject();
    const track = project.tracks.find((track) => track.kind === "video")!;
    project.clips = [createClip(track.id, asset)];
    await exportMedia(
      project,
      [asset],
      {
        width: 1920,
        height: 1080,
        audioOnly: false,
        subtitles: false,
        quality: "normal",
      },
      vi.fn(),
      vi.fn(),
    );
    expect(mock.worker.ffprobe).not.toHaveBeenCalled();
    const render = mock.worker.exec.mock.calls.find(([args]) =>
      args.includes("-filter_complex"),
    )![0];
    expect(render).toContain("-loop");
    expect(render[render.indexOf("-filter_complex") + 1]).not.toContain(
      "[2:a]",
    );
  });

  it("retains the actual memory failure rather than claiming all encoder errors are resolution failures", () => {
    const error = exportFailure([
      "Failed to inject frame into filter network: Out of memory",
      "Conversion failed!",
    ]);
    expect(error.message).toContain("Out of memory");
    expect(error.message).toContain("编辑记录已保留");
  });
});
