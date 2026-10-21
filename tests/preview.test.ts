import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClip, newProject } from "../src/lib/types";
import type { Asset } from "../src/lib/types";
import { Preview } from "../src/lib/preview";
import { subtitleCanvas } from "../src/lib/media";

vi.mock("../src/lib/media", () => ({
  subtitleCanvas: vi.fn(() => new FakeCanvas()),
}));

const activity: string[] = [];
let initialReadyState = 2;
let frameCallbacks = false;
class FakeMedia extends EventTarget {
  src = "";
  preload = "";
  paused = true;
  muted = false;
  volume = 1;
  playbackRate = 1;
  readyState = initialReadyState;
  seeking = false;
  private position = 0;
  seeks: number[] = [];
  constructor(readonly kind: string) {
    super();
  }
  get currentTime() {
    return this.position;
  }
  set currentTime(value: number) {
    this.position = value;
    this.seeking = true;
    this.seeks.push(value);
  }
  advancePlayback(value: number) {
    this.position = value;
  }
  finishSeek() {
    this.seeking = false;
    this.dispatchEvent(new Event("seeked"));
  }
  pause = vi.fn(() => {
    this.paused = true;
  });
  play = vi.fn(async () => {
    this.paused = false;
  });
  removeAttribute = vi.fn((name: string) => {
    if (name === "src") this.src = "";
  });
  load = vi.fn(() => {
    activity.push(`release:${this.kind}`);
  });
}
class FakeVideo extends FakeMedia {
  playsInline = false;
  videoWidth = 1920;
  videoHeight = 1080;
  constructor() {
    super("video");
  }
}
class FakeFrameVideo extends FakeVideo {
  callbacks = new Map<number, VideoFrameRequestCallback>();
  next = 0;
  requestVideoFrameCallback = vi.fn((callback: VideoFrameRequestCallback) => {
    this.callbacks.set(++this.next, callback);
    return this.next;
  });
  cancelVideoFrameCallback = vi.fn((id: number) => {
    this.callbacks.delete(id);
  });
  renderFrame(mediaTime: number) {
    for (const [id, callback] of [...this.callbacks]) {
      this.callbacks.delete(id);
      callback(0, { mediaTime } as VideoFrameCallbackMetadata);
    }
  }
}
class FakeAudio extends FakeMedia {
  constructor() {
    super("audio");
  }
}
class FakeImage extends EventTarget {
  src = "";
  decoding = "";
  complete = false;
  naturalWidth = 0;
  naturalHeight = 0;
  finishLoad(width = 800, height = 600) {
    this.naturalWidth = width;
    this.naturalHeight = height;
    this.complete = true;
    this.dispatchEvent(new Event("load"));
  }
  removeAttribute = vi.fn((name: string) => {
    if (name === "src") this.src = "";
  });
}
class FakeCanvas {
  width = 0;
  height = 0;
  frameTime?: number;
  context = {
    globalAlpha: 1,
    fillStyle: "",
    fillRect: vi.fn(() => {
      this.frameTime = undefined;
    }),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    drawImage: vi.fn((source: FakeMedia | FakeCanvas) => {
      const time =
        source instanceof FakeMedia
          ? source.currentTime
          : source instanceof FakeCanvas
            ? source.frameTime
            : undefined;
      if (time !== undefined) this.frameTime = time;
    }),
  };
  getContext = vi.fn(() => this.context);
}
const createdCanvases: FakeCanvas[] = [];
let createElement: ReturnType<typeof vi.fn>;
const asset = (kind: "video" | "audio" | "image", id = kind): Asset => ({
  id,
  name: `${id}.${kind === "video" ? "mov" : kind === "audio" ? "mp3" : "png"}`,
  blob: new Blob(),
  url: `blob:${id}`,
  kind,
  duration: 10,
  width: 1920,
  height: 1080,
});
const mediaCreates = () =>
  createElement.mock.calls.filter(
    ([kind]) => kind === "video" || kind === "audio",
  );
function setup() {
  const canvas = new FakeCanvas(),
    invalidate = vi.fn();
  const preview = new Preview(
    canvas as unknown as HTMLCanvasElement,
    invalidate,
  );
  const project = newProject(),
    video = asset("video"),
    audio = asset("audio");
  const clip = createClip(project.tracks[1]!.id, video);
  project.clips.push(clip);
  const current = () => preview.elements.get(clip.id)! as unknown as FakeVideo;
  return { canvas, invalidate, preview, project, video, audio, clip, current };
}
beforeEach(() => {
  activity.length = 0;
  createdCanvases.length = 0;
  initialReadyState = 2;
  frameCallbacks = false;
  vi.clearAllMocks();
  createElement = vi.fn((kind: string) => {
    activity.push(`create:${kind}`);
    if (kind === "canvas") {
      const canvas = new FakeCanvas();
      createdCanvases.push(canvas);
      return canvas;
    }
    if (kind === "img") return new FakeImage();
    if (kind === "video")
      return frameCallbacks ? new FakeFrameVideo() : new FakeVideo();
    return new FakeAudio();
  });
  vi.stubGlobal("HTMLVideoElement", FakeVideo);
  vi.stubGlobal("document", { createElement });
});
afterEach(() => vi.unstubAllGlobals());

describe("atomic preview frames and seeking", () => {
  it("preserves the committed frame on transient drawable loss, restores context, and retries at most twice", async () => {
    const { preview, project, video, canvas, invalidate } = setup();
    preview.sync(project, [video], 0, false);
    const context = createdCanvases[0]!.context;
    context.drawImage.mockImplementation(() => {
      throw new DOMException("frame lost", "InvalidStateError");
    });
    for (let i = 0; i < 4; i++) {
      expect(() => preview.sync(project, [video], 0, false)).not.toThrow();
      await Promise.resolve();
    }
    expect(canvas.context.drawImage).toHaveBeenCalledOnce();
    expect(context.save).toHaveBeenCalledTimes(5);
    expect(context.restore).toHaveBeenCalledTimes(5);
    expect(invalidate).toHaveBeenCalledTimes(2);
    context.drawImage.mockImplementation(() => undefined);
    preview.sync(project, [video], 0, false);
    expect(canvas.context.drawImage).toHaveBeenCalledTimes(2);
    preview.dispose();
  });

  it("propagates programming errors from drawing while restoring the context", () => {
    const { preview, project, video, canvas } = setup();
    preview.sync(project, [video], 0, false);
    const context = createdCanvases[0]!.context;
    context.drawImage.mockImplementation(() => {
      throw new TypeError("broken renderer");
    });
    expect(() => preview.sync(project, [video], 0, false)).toThrow(
      "broken renderer",
    );
    expect(context.restore).toHaveBeenCalledTimes(2);
    expect(canvas.context.drawImage).toHaveBeenCalledOnce();
    preview.dispose();
  });

  it("does not deliver queued drawable retries after dispose", async () => {
    const { preview, project, video, invalidate } = setup();
    preview.sync(project, [video], 0, false);
    createdCanvases[0]!.context.drawImage.mockImplementation(() => {
      throw new DOMException("frame lost", "InvalidStateError");
    });
    preview.sync(project, [video], 0, false);
    preview.dispose();
    await Promise.resolve();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("renders a complete frame offscreen and commits it once, preserving transforms", () => {
    const { preview, project, video, clip, canvas, current } = setup();
    clip.speed = 2;
    clip.volume = 0.4;
    clip.transform = { x: 25, y: 75, scaleX: 0.5, scaleY: 1, rotation: 30 };
    preview.sync(project, [video], 0, false);
    const composition = createdCanvases[0]!;
    expect(composition.context.drawImage).toHaveBeenCalledWith(
      current(),
      0,
      0,
      1920,
      1080,
      -480,
      -540,
      960,
      1080,
    );
    expect(composition.context.translate).toHaveBeenCalledWith(480, 810);
    expect(composition.context.rotate).toHaveBeenCalledWith(Math.PI / 6);
    expect(canvas.context.fillRect).not.toHaveBeenCalled();
    expect(canvas.context.drawImage).toHaveBeenCalledExactlyOnceWith(
      composition,
      0,
      0,
    );
    expect(current().volume).toBe(0.4);
    expect(current().playbackRate).toBe(2);
    expect(canvas.width).toBe(1920);
    expect(canvas.height).toBe(1080);
    preview.dispose();
  });

  it("keeps the complete frame during scrub and coalesces many targets into one latest seek", () => {
    const { preview, project, video, canvas, current } = setup();
    preview.sync(project, [video], 0, false);
    preview.sync(project, [video], 3, false);
    preview.sync(project, [video], 5, false);
    preview.sync(project, [video], 7, false);
    expect(current().seeks).toEqual([3]);
    expect(canvas.frameTime).toBe(0);
    current().finishSeek();
    expect(current().seeks).toEqual([3, 7]);
    preview.sync(project, [video], 7, false);
    expect(canvas.frameTime).toBe(3);
    current().finishSeek();
    preview.sync(project, [video], 7, false);
    expect(canvas.frameTime).toBe(7);
    preview.dispose();
  });

  it("shows completed decoded frames during sustained faster-than-decode scrubbing", async () => {
    vi.useFakeTimers();
    frameCallbacks = true;
    const { preview, project, video, canvas, current } = setup();
    project.width = 320;
    project.height = 180;
    preview.sync(project, [video], 0, false);
    const element = current() as FakeFrameVideo;
    const shown = new Set<number | undefined>();
    let scheduledSeeks = 0;
    for (let i = 1; i <= 120; i++) {
      preview.sync(project, [video], (i * 0.037) % 5.8, false);
      shown.add(canvas.frameTime);
      if (element.seeks.length > scheduledSeeks) {
        scheduledSeeks = element.seeks.length;
        const decodedTarget = element.currentTime;
        setTimeout(() => {
          element.finishSeek();
          element.renderFrame(decodedTarget);
        }, 24);
      }
      await vi.advanceTimersByTimeAsync(8);
    }
    expect(shown.size).toBeGreaterThan(20);
    expect(element.seeks.length).toBeLessThan(60);
    expect(createdCanvases).toHaveLength(2); // One composite and one bounded decoded-frame sample.
    expect(
      createdCanvases[1]!.width * createdCanvases[1]!.height,
    ).toBeLessThanOrEqual(320 * 180);
    vi.clearAllTimers();
    for (let i = 0; i < 3; i++) {
      if (element.seeking) {
        const target = element.currentTime;
        element.finishSeek();
        element.renderFrame(target);
      }
      preview.sync(project, [video], (120 * 0.037) % 5.8, false);
    }
    expect(canvas.frameTime).toBeCloseTo((120 * 0.037) % 5.8);
    const cached = createdCanvases[1]!;
    preview.dispose();
    expect(cached.width).toBe(0);
    expect(cached.height).toBe(0);
  });

  it("does not commit an old decoded video frame merely because currentTime and readyState updated", () => {
    frameCallbacks = true;
    const { preview, project, video, canvas, current } = setup();
    preview.sync(project, [video], 0, false);
    preview.sync(project, [video], 2, false);
    const element = current() as FakeFrameVideo;
    element.finishSeek();
    preview.sync(project, [video], 2, false);
    expect(canvas.frameTime).toBe(0);
    element.renderFrame(0);
    preview.sync(project, [video], 2, false);
    expect(canvas.frameTime).toBe(0);
    element.renderFrame(2);
    preview.sync(project, [video], 2, false);
    expect(canvas.frameTime).toBe(2);
    preview.dispose();
  });

  it("accepts a submitted frame arriving before seeked without waiting for a nonexistent extra frame", () => {
    frameCallbacks = true;
    const { preview, project, video, canvas, current } = setup();
    preview.sync(project, [video], 0, false);
    preview.sync(project, [video], 1, false);
    const element = current() as FakeFrameVideo;
    element.renderFrame(1);
    preview.sync(project, [video], 1, false);
    expect(canvas.frameTime).toBe(0);
    element.finishSeek();
    preview.sync(project, [video], 1, false);
    expect(canvas.frameTime).toBe(1);
    preview.dispose();
  });

  it("resumes playback after a seek when the timeline advances slightly while decoding", () => {
    frameCallbacks = true;
    const { preview, project, video, canvas, current } = setup();
    preview.sync(project, [video], 0, true);
    preview.sync(project, [video], 3, true);
    preview.sync(project, [video], 3.1, true);
    const element = current() as FakeFrameVideo;
    element.finishSeek();
    element.renderFrame(3);
    preview.sync(project, [video], 3.1, true);
    expect(canvas.context.drawImage).toHaveBeenCalledTimes(2);
    expect(element.paused).toBe(false);
    expect(element.seeks).toEqual([3]);
    preview.dispose();
  });

  it("defers seeking until metadata and then seeks directly to the latest requested time", () => {
    initialReadyState = 0;
    const { preview, project, video, canvas, current } = setup();
    preview.sync(project, [video], 2, false);
    preview.sync(project, [video], 4, false);
    expect(current().seeks).toEqual([]);
    expect(canvas.context.drawImage).not.toHaveBeenCalled();
    current().readyState = 1;
    current().dispatchEvent(new Event("loadedmetadata"));
    expect(current().seeks).toEqual([4]);
    current().readyState = 2;
    current().finishSeek();
    preview.sync(project, [video], 4, false);
    expect(canvas.context.drawImage).toHaveBeenCalledOnce();
    preview.dispose();
  });

  it("commits a real empty interval immediately instead of freezing the previous video there", () => {
    const { preview, project, video, canvas, current } = setup();
    preview.sync(project, [video], 0, false);
    const original = current();
    preview.sync(project, [video], 10, false);
    expect(preview.elements.size).toBe(0);
    expect(original.src).toBe("");
    expect(canvas.context.drawImage).toHaveBeenCalledTimes(2);
    expect(createdCanvases[0]!.context.fillRect).toHaveBeenCalledTimes(2);
    expect(createdCanvases[0]!.context.drawImage).toHaveBeenCalledOnce();
    preview.dispose();
  });

  it("waits for every active visual layer rather than committing a partially ready composition", () => {
    const { preview, project, video, canvas, current } = setup();
    const upperTrack = { ...project.tracks[1]!, id: "upper" };
    project.tracks.push(upperTrack);
    const upper = createClip(upperTrack.id, video);
    project.clips.push(upper);
    initialReadyState = 0;
    preview.sync(project, [video], 0, false);
    current().readyState = 2;
    preview.sync(project, [video], 0, false);
    expect(canvas.context.drawImage).not.toHaveBeenCalled();
    const upperElement = preview.elements.get(
      upper.id,
    )! as unknown as FakeVideo;
    upperElement.readyState = 2;
    upperElement.dispatchEvent(new Event("loadeddata"));
    preview.sync(project, [video], 0, false);
    expect(canvas.context.drawImage).toHaveBeenCalledOnce();
    expect(createdCanvases[0]!.context.drawImage).toHaveBeenCalledTimes(2);
    preview.dispose();
  });
});

describe("bounded preparation and decoder lifetime", () => {
  it("excludes distant and hidden clips instead of preloading the entire project", () => {
    const { preview, project, video, audio, clip } = setup();
    for (let i = 0; i < 100; i++)
      project.clips.push(
        createClip(
          project.tracks[i % 2 ? 1 : 2]!.id,
          i % 2 ? video : audio,
          20 + i * 10,
        ),
      );
    const hidden = { ...project.tracks[1]!, id: "hidden", hidden: true };
    project.tracks.push(hidden);
    project.clips.push(createClip(hidden.id, video));
    preview.sync(project, [video, audio], 0, false);
    expect(mediaCreates()).toHaveLength(1);
    expect([...preview.elements.keys()]).toEqual([clip.id]);
    preview.dispose();
  });

  it("warms only the nearest next visual per visible video track, with at most two extra layers", () => {
    const { preview, project, video, audio } = setup();
    project.clips = [];
    for (let i = 0; i < 6; i++) {
      const track = { ...project.tracks[1]!, id: `track-${i}` };
      project.tracks.push(track);
      project.clips.push(
        createClip(track.id, video, 1),
        createClip(track.id, video, 1.2),
      );
    }
    project.clips.push(createClip(project.tracks[2]!.id, audio, 0.5));
    preview.sync(project, [video, audio], 0, true);
    expect(preview.elements.size).toBe(2);
    expect(mediaCreates().every(([kind]) => kind === "video")).toBe(true);
    for (const element of preview.elements.values()) {
      expect(element.paused).toBe(true);
      expect(element.muted).toBe(true);
      expect(element.volume).toBe(0);
    }
    preview.dispose();
  });

  it("uses the prepared decoder at a discontinuous cut without committing a black frame", () => {
    const { preview, project, video, clip, current, canvas } = setup();
    clip.out = 1;
    const next = createClip(project.tracks[1]!.id, video, 1);
    project.clips.push(next);
    preview.sync(project, [video], 0, true);
    expect(preview.elements.size).toBe(2);
    const prepared = preview.elements.get(next.id)!;
    current().advancePlayback(0.95);
    preview.sync(project, [video], 0.95, true);
    preview.sync(project, [video], 1, true);
    expect(preview.elements.get(next.id)).toBe(prepared);
    expect(canvas.context.drawImage).toHaveBeenCalledTimes(3);
    expect(mediaCreates()).toHaveLength(2);
    preview.dispose();
  });

  it("reuses a continuous video decoder across a split without allocating a second decoder", () => {
    const { preview, project, video, clip, current } = setup();
    clip.out = 1;
    const next = createClip(project.tracks[1]!.id, video, 1);
    next.in = 1;
    next.out = 3;
    project.clips.push(next);
    preview.sync(project, [video], 0, true);
    const element = current();
    expect(preview.elements.size).toBe(1);
    element.advancePlayback(1);
    preview.sync(project, [video], 1, true);
    expect(preview.elements.get(next.id)).toBe(element);
    expect(element.load).not.toHaveBeenCalled();
    expect(mediaCreates()).toHaveLength(1);
    preview.dispose();
  });

  it("releases hidden/replaced sources and detaches readiness listeners on dispose", () => {
    const { preview, project, video, current, invalidate } = setup();
    preview.sync(project, [video], 0, false);
    const original = current();
    project.tracks[1]!.hidden = true;
    preview.sync(project, [video], 0, false);
    expect(original.src).toBe("");
    expect(original.load).toHaveBeenCalledOnce();
    project.tracks[1]!.hidden = false;
    preview.sync(project, [video], 0, false);
    const second = current();
    video.url = "blob:repaired";
    preview.sync(project, [video], 0, false);
    expect(second.load).toHaveBeenCalledOnce();
    const third = current();
    preview.dispose();
    expect(third.src).toBe("");
    expect(preview.elements.size).toBe(0);
    original.dispatchEvent(new Event("loadeddata"));
    third.dispatchEvent(new Event("seeked"));
    expect(invalidate).not.toHaveBeenCalled();
    expect(createdCanvases[0]!.width).toBe(0);
  });

  it("keeps active audio playing but does not retain it beyond its clip", () => {
    const { preview, project, video, audio } = setup();
    const voice = createClip(project.tracks[2]!.id, audio);
    project.clips.push(voice);
    preview.sync(project, [video, audio], 0, true);
    const voiceElement = preview.elements.get(
      voice.id,
    )! as unknown as FakeAudio;
    expect(voiceElement.play).toHaveBeenCalledOnce();
    preview.sync(project, [video, audio], 10, false);
    expect(preview.elements.size).toBe(0);
    expect(voiceElement.src).toBe("");
    preview.dispose();
  });
});

describe("image and subtitle composition", () => {
  it("loads images as images and preserves the last complete frame until the picture is ready", () => {
    const { preview, project, video, clip, canvas } = setup();
    clip.out = 1;
    const photo = asset("image"),
      imageClip = createClip(project.tracks[1]!.id, photo, 1);
    imageClip.crop = { x: 25, y: 0, width: 50, height: 100 };
    imageClip.transform = {
      x: 50,
      y: 50,
      scaleX: 0.5,
      scaleY: 1,
      rotation: 45,
    };
    imageClip.opacity = 0.5;
    project.clips.push(imageClip);
    preview.sync(project, [video, photo], 0, false);
    expect(preview.images.size).toBe(1);
    preview.sync(project, [video, photo], 1, false);
    expect(canvas.context.drawImage).toHaveBeenCalledOnce();
    const image = preview.images.get(imageClip.id)! as unknown as FakeImage;
    image.finishLoad();
    preview.sync(project, [video, photo], 1, false);
    expect(canvas.context.drawImage).toHaveBeenCalledTimes(2);
    expect(createdCanvases[0]!.context.drawImage).toHaveBeenLastCalledWith(
      image,
      200,
      0,
      400,
      600,
      -180,
      -540,
      360,
      1080,
    );
    expect(createdCanvases[0]!.context.rotate).toHaveBeenCalledWith(
      Math.PI / 4,
    );
    expect(mediaCreates()).toHaveLength(1);
    preview.dispose();
    expect(image.src).toBe("");
    expect(preview.images.size).toBe(0);
  });

  it("retains only visible subtitle canvases, including simultaneous overlays", () => {
    const { preview, project, video } = setup();
    project.clips = [];
    const first = createClip(project.tracks[0]!.id, undefined);
    first.text = "第一句";
    first.out = 2;
    const second = createClip(project.tracks[0]!.id, undefined, 2);
    second.text = "第二句";
    second.out = 2;
    const overlay = createClip(project.tracks[0]!.id, undefined);
    overlay.text = "叠加字幕";
    project.clips.push(first, second, overlay);
    preview.sync(project, [video], 1, false);
    expect(preview.subtitles.size).toBe(2);
    const [firstCanvas, overlayCanvas] = [...preview.subtitles.values()];
    preview.sync(project, [video], 2, false);
    expect(preview.subtitles.size).toBe(2);
    expect([...preview.subtitles.values()]).toContain(overlayCanvas);
    expect(firstCanvas!.width).toBe(0);
    expect(firstCanvas!.height).toBe(0);
    expect(subtitleCanvas).toHaveBeenCalledTimes(3);
    preview.sync(project, [video], 4, false);
    expect(preview.subtitles.size).toBe(0);
    expect(overlayCanvas!.width).toBe(0);
    preview.dispose();
  });
});
