import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAsset } from "../src/lib/media";

class MediaElement extends EventTarget {
  src = "";
  preload = "";
  playsInline = false;
  duration = 8;
  readyState = 0;
  videoWidth = 0;
  videoHeight = 0;
  currentTime = 0;
  error: object | null = null;
  load = vi.fn();
  removeAttribute = vi.fn();

  metadata() {
    this.readyState = 1;
    this.dispatchEvent(new Event("loadedmetadata"));
  }

  frame() {
    this.readyState = 2;
    this.videoWidth = 1920;
    this.videoHeight = 1080;
    this.dispatchEvent(new Event("loadeddata"));
  }
}

describe("media import decode validation", () => {
  let media: MediaElement;
  let drawImage: ReturnType<typeof vi.fn>;
  let toDataURL: ReturnType<typeof vi.fn>;
  let revoke: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    media = new MediaElement();
    drawImage = vi.fn();
    toDataURL = vi.fn(() => "data:image/jpeg;test");
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test-media");
    revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.stubGlobal("document", {
      createElement: vi.fn((tag: string) =>
        tag === "canvas"
          ? { getContext: () => ({ drawImage }), toDataURL }
          : media,
      ),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("accepts a decodable MOV after its first frame loads at time zero", async () => {
    const result = readAsset(new Blob(), "camera.mov");
    media.metadata();
    await Promise.resolve();
    expect(drawImage).not.toHaveBeenCalled();
    media.frame();
    const asset = await result;
    expect(asset).toMatchObject({
      kind: "video",
      width: 1920,
      height: 1080,
      duration: 8,
      thumbnail: "data:image/jpeg;test",
    });
    expect(media.currentTime).toBe(0);
    expect(drawImage).toHaveBeenCalledOnce();
    expect(media.removeAttribute).toHaveBeenCalledWith("src");
    expect(media.load).toHaveBeenCalledOnce();
    expect(revoke).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects metadata-only MOV instead of accepting audio metadata as video", async () => {
    const result = readAsset(new Blob(), "unsupported-codec.mov");
    const rejected = expect(result).rejects.toThrow("无法解码视频画面");
    media.metadata();
    await Promise.resolve();
    // Some containers report a current audio frame but no video dimensions.
    media.readyState = 2;
    media.dispatchEvent(new Event("loadeddata"));
    await vi.advanceTimersByTimeAsync(15000);
    await rejected;
    expect(drawImage).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith("blob:test-media");
    expect(media.load).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects video decoder errors after metadata and releases the object URL", async () => {
    const result = readAsset(new Blob(), "broken.mov");
    const rejected = expect(result).rejects.toThrow("浏览器无法解码此媒体");
    media.metadata();
    await Promise.resolve();
    media.error = {};
    media.dispatchEvent(new Event("error"));
    await rejected;
    expect(revoke).toHaveBeenCalledWith("blob:test-media");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates an undrawable video frame so the importer can transcode", async () => {
    drawImage.mockImplementation(() => {
      throw new Error("The video has no current frame");
    });
    const result = readAsset(new Blob(), "undrawable.mov");
    media.metadata();
    media.frame();
    await expect(result).rejects.toThrow("no current frame");
    expect(revoke).toHaveBeenCalledWith("blob:test-media");
  });

  it("keeps a decoded video when only thumbnail encoding fails", async () => {
    toDataURL.mockImplementation(() => {
      throw new Error("Thumbnail encoding failed");
    });
    // Cached data can be ready before either loaded event is observed.
    media.frame();
    const asset = await readAsset(new Blob(), "cached.mp4");
    expect(asset.width).toBe(1920);
    expect(asset.thumbnail).toBeUndefined();
    expect(revoke).not.toHaveBeenCalled();
  });

  it("imports audio without requiring video data and still builds its waveform", async () => {
    const close = vi.fn(async () => {});
    vi.stubGlobal(
      "AudioContext",
      class {
        decodeAudioData = async () => ({
          getChannelData: () => new Float32Array([0.25, -0.5, 0.75]),
        });
        close = close;
      },
    );
    const result = readAsset(new Blob(), "sound.mp3");
    media.metadata();
    const asset = await result;
    expect(asset.kind).toBe("audio");
    expect(asset.waveform?.slice(0, 3)).toEqual([0.25, 0.5, 0.75]);
    expect(close).toHaveBeenCalledOnce();
    expect(drawImage).not.toHaveBeenCalled();
  });
});

describe("still image import", () => {
  class ImageElement {
    src = "";
    naturalWidth = 1200;
    naturalHeight = 800;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    removeAttribute = vi.fn();
  }
  let image: ImageElement;
  let drawImage: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    image = new ImageElement();
    drawImage = vi.fn();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:image");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.stubGlobal("document", {
      createElement: vi.fn((tag: string) =>
        tag === "img"
          ? image
          : {
              width: 0,
              height: 0,
              getContext: () => ({ drawImage }),
              toDataURL: () => "data:image/png;thumbnail",
              toBlob: (done: (b: Blob) => void) =>
                done(new Blob(["decoded"], { type: "image/png" })),
            },
      ),
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it.each(["photo.png", "photo.JPG", "photo.webp"])(
    "imports %s on the video track without media decoding",
    async (name) => {
      const blob = new Blob(["raw"], { type: "" });
      const pending = readAsset(blob, name);
      image.onload!();
      const asset = await pending;
      expect(asset).toMatchObject({
        name,
        kind: "image",
        duration: 5,
        width: 1200,
        height: 800,
        thumbnail: "data:image/png;thumbnail",
      });
      expect(asset.blob).toBe(blob);
      expect(drawImage).toHaveBeenCalledOnce();
      expect(image.removeAttribute).toHaveBeenCalledWith("src");
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("stores less widely supported/animated images as a static PNG frame", async () => {
    const pending = readAsset(
      new Blob(["gif"], { type: "image/gif" }),
      "animation.gif",
    );
    image.onload!();
    const asset = await pending;
    expect(asset).toMatchObject({
      name: "animation.png",
      kind: "image",
      duration: 5,
    });
    expect(asset.blob.type).toBe("image/png");
    expect(await asset.blob.text()).toBe("decoded");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:image");
  });
  it("rejects broken images and frees temporary URLs without trying video conversion", async () => {
    const pending = readAsset(new Blob(), "broken.png");
    const rejected = expect(pending).rejects.toThrow("无法解码此图片");
    image.onerror!();
    await rejected;
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:image");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cleans up stalled image loads", async () => {
    const pending = readAsset(new Blob(), "stalled.png");
    const rejected = expect(pending).rejects.toThrow("图片读取超时");
    await vi.advanceTimersByTimeAsync(15000);
    await rejected;
    expect(image.onload).toBeNull();
    expect(image.onerror).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:image");
  });
});
