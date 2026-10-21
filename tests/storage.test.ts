import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reactive } from "vue";
import {
  loadWorkspace,
  packProject,
  saveWorkspace,
  unpackProject,
  writeProjectToFile,
} from "../src/lib/storage";
import { createClip, newProject } from "../src/lib/types";
import type { Asset } from "../src/lib/types";

function media(
  blob = new Blob(["媒体 payload"], { type: "video/quicktime" }),
): Asset {
  return {
    id: "source",
    name: "素材.mov",
    kind: "video",
    blob,
    url: "blob:old",
    duration: 7,
    width: 1920,
    height: 1080,
    waveform: [0.1, 0.6],
    thumbnail: "data:image/png;base64,aGVsbG8=",
  };
}

async function withStore<T>(
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open("video-cup", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("workspace");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction("workspace", "readwrite");
      const req = run(tx.objectStore("workspace"));
      tx.oncomplete = () => resolve(req.result);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  await withStore((store) => store.clear());
});

describe("project persistence", () => {
  it("persists reactive media with waveforms and restores working blob URLs", async () => {
    const project = reactive(newProject());
    project.name = "可恢复工程";
    const blob = new Blob(["audio"], { type: "audio/wav" });
    const assets = reactive<Asset[]>([
      {
        id: "test",
        name: "test.wav",
        kind: "audio",
        blob,
        url: "blob:expired",
        duration: 6,
        width: 0,
        height: 0,
        waveform: [0.1, 0.5, 0.3],
      },
    ]);
    await saveWorkspace(project, assets);
    const restored = await loadWorkspace();
    expect(restored!.project.name).toBe("可恢复工程");
    expect(restored!.assets[0]!.waveform).toEqual([0.1, 0.5, 0.3]);
    expect(await restored!.assets[0]!.blob.text()).toBe("audio");
    expect(restored!.assets[0]!.url).toMatch(/^blob:/);
    expect(restored!.assets[0]!.url).not.toBe("blob:expired");
    URL.revokeObjectURL(restored!.assets[0]!.url);
  });
  it("rejects invalid project structure before importing data", async () => {
    const file = new File(
      [
        JSON.stringify({
          version: 1,
          project: {
            name: "broken",
            tracks: [],
            clips: [],
            width: -1,
            height: 1080,
            fps: 30,
          },
          assets: [],
        }),
      ],
      "broken.vcut",
    );
    await expect(unpackProject(file)).rejects.toThrow("有效的 VideoCup");
  });

  it("preserves the first legacy workspace and the previous revision while deduplicating media", async () => {
    const project = newProject();
    const asset = media();
    project.name = "升级前的真实剪辑";
    await withStore((store) =>
      store.put({ project, assets: [asset] }, "current"),
    );
    project.name = "新编辑一";
    await saveWorkspace(project, [asset]);
    project.name = "新编辑二";
    await saveWorkspace(project, [asset]);
    const original = await withStore((store) =>
      store.get("recovery:before-v2"),
    );
    const previous = await withStore((store) => store.get("previous"));
    const current = await withStore((store) => store.get("current"));
    const keys = await withStore((store) => store.getAllKeys());
    expect(original.project.name).toBe("升级前的真实剪辑");
    expect(await original.assets[0].blob.text()).toBe("媒体 payload");
    expect(previous.project.name).toBe("新编辑一");
    expect(current.version).toBe(2);
    expect(current.project.name).toBe("新编辑二");
    expect(current.assets[0].blob).toBeUndefined();
    expect(keys.filter((key) => String(key).startsWith("media:"))).toHaveLength(
      1,
    );
  });

  it("captures queued saves when requested and writes replacement blobs under a new key", async () => {
    const project = newProject();
    const asset = media();
    project.name = "第一版";
    const first = saveWorkspace(project, [asset]);
    project.name = "第二版";
    const second = saveWorkspace(project, [asset]);
    project.name = "尚未保存";
    await Promise.all([first, second]);
    expect(
      (await withStore((store) => store.get("previous"))).project.name,
    ).toBe("第一版");
    const restored = await loadWorkspace();
    expect(restored!.project.name).toBe("第二版");
    // Loaded Blobs retain their persistent key, including after URL restoration.
    await saveWorkspace(restored!.project, restored!.assets);
    let keys = await withStore((store) => store.getAllKeys());
    expect(keys.filter((key) => String(key).startsWith("media:"))).toHaveLength(
      1,
    );
    restored!.assets.forEach((a) => URL.revokeObjectURL(a.url));
    asset.blob = new Blob(["repaired mov"], { type: "video/mp4" });
    await saveWorkspace(project, [asset]);
    keys = await withStore((store) => store.getAllKeys());
    expect(keys.filter((key) => String(key).startsWith("media:"))).toHaveLength(
      2,
    );
  });

  it("rolls back a failed transaction without overwriting the last successful workspace", async () => {
    const project = newProject();
    const asset = media();
    project.name = "安全版本";
    await saveWorkspace(project, [asset]);
    const put = IDBObjectStore.prototype.put;
    const spy = vi
      .spyOn(IDBObjectStore.prototype, "put")
      .mockImplementation(function (
        this: IDBObjectStore,
        value: any,
        key?: IDBValidKey,
      ) {
        const req = put.call(this, value, key);
        if (key === "current") this.transaction.abort();
        return req;
      });
    project.name = "失败版本";
    await expect(saveWorkspace(project, [asset])).rejects.toThrow();
    spy.mockRestore();
    expect(
      (await withStore((store) => store.get("current"))).project.name,
    ).toBe("安全版本");
    expect(await withStore((store) => store.get("previous"))).toBeUndefined();
    project.name = "重试成功";
    await saveWorkspace(project, [asset]);
    expect(
      (await withStore((store) => store.get("current"))).project.name,
    ).toBe("重试成功");
  });

  it("recovers the previous revision when a current media reference is incomplete", async () => {
    const project = newProject();
    const asset = media();
    project.name = "可恢复版本";
    await saveWorkspace(project, [asset]);
    project.name = "后续版本";
    await saveWorkspace(project, [asset]);
    const current = await withStore((store) => store.get("current"));
    current.assets[0].blobKey = "media:missing";
    await withStore((store) => store.put(current, "current"));
    const restored = await loadWorkspace();
    expect(restored!.project.name).toBe("可恢复版本");
    expect(await restored!.assets[0]!.blob.text()).toBe("媒体 payload");
    restored!.assets.forEach((a) => URL.revokeObjectURL(a.url));
  });
});

describe("binary project files", () => {
  it("round trips editing data, media bytes and MIME types with a small header", async () => {
    const project = reactive(newProject());
    const asset = media();
    const clip = createClip(project.tracks[1]!.id, asset, 2.5);
    clip.speed = 2;
    clip.transform = { x: 22, y: 67, scaleX: 0.75, scaleY: 1.3, rotation: 33 };
    project.clips.push(clip);
    const packed = await packProject(project, reactive([asset]));
    expect(await packed.slice(0, 8).text()).toBe("VCUTBIN2");
    expect(packed.size - asset.blob.size).toBeLessThan(4096);
    const restored = await unpackProject(packed);
    expect(restored.project).toEqual(JSON.parse(JSON.stringify(project)));
    expect(await restored.assets[0]!.blob.text()).toBe("媒体 payload");
    expect(restored.assets[0]!.blob.type).toBe("video/quicktime");
    expect(restored.assets[0]!.waveform).toEqual([0.1, 0.6]);
    restored.assets.forEach((a) => URL.revokeObjectURL(a.url));
  });

  it("packs and streams a large Blob without reading or base64 encoding the source", async () => {
    class NoReadBlob extends Blob {
      override arrayBuffer(): Promise<ArrayBuffer> {
        throw new Error("source read");
      }
      override text(): Promise<string> {
        throw new Error("source read");
      }
      override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
        throw new Error("source read");
      }
    }
    const source = new NoReadBlob([new Uint8Array(17 * 1024 * 1024)]);
    const asset = media(source);
    const packed = await packProject(newProject(), [asset]);
    expect(packed.size).toBeGreaterThan(source.size);
    const sizes: number[] = [];
    const writer = {
      write: vi.fn(async (data: Blob | Uint8Array<ArrayBuffer>) => {
        sizes.push(data instanceof Blob ? data.size : data.byteLength);
      }),
      close: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    const progress: { written: number; total: number }[] = [];
    await writeProjectToFile(newProject(), [asset], writer, (value) =>
      progress.push(value),
    );
    expect(sizes.every((size) => size <= 8 * 1024 * 1024)).toBe(true);
    expect(sizes.slice(-3)).toEqual([
      8 * 1024 * 1024,
      8 * 1024 * 1024,
      1024 * 1024,
    ]);
    expect(writer.close).toHaveBeenCalledOnce();
    expect(writer.abort).not.toHaveBeenCalled();
    expect(progress[0]!.written).toBe(0);
    expect(progress.at(-1)!.written).toBe(progress.at(-1)!.total);
    expect(progress.at(-1)!.total).toBe(
      sizes.reduce((sum, size) => sum + size, 0),
    );
  });

  it("streams a valid complete project and aborts failed writes instead of committing partial data", async () => {
    const project = newProject();
    const asset = media();
    const parts: BlobPart[] = [];
    const writer = {
      write: vi.fn(async (part: Blob | Uint8Array<ArrayBuffer>) => {
        parts.push(part);
      }),
      close: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    await writeProjectToFile(project, [asset], writer);
    const restored = await unpackProject(new Blob(parts));
    expect(await restored.assets[0]!.blob.text()).toBe("媒体 payload");
    restored.assets.forEach((a) => URL.revokeObjectURL(a.url));
    writer.write.mockRejectedValueOnce(new Error("disk full"));
    writer.close.mockClear();
    await expect(writeProjectToFile(project, [asset], writer)).rejects.toThrow(
      "disk full",
    );
    expect(writer.close).not.toHaveBeenCalled();
    expect(writer.abort).toHaveBeenCalledOnce();
  });

  it("keeps reading legacy JSON v1 projects", async () => {
    const project = newProject();
    const { blob: _blob, url: _url, ...asset } = media();
    const file = new Blob([
      JSON.stringify({
        version: 1,
        project,
        assets: [
          {
            ...asset,
            type: "audio/wav",
            data: "data:audio/wav;base64,aGVsbG8=",
          },
        ],
      }),
    ]);
    const restored = await unpackProject(file);
    expect(await restored.assets[0]!.blob.text()).toBe("hello");
    expect(restored.assets[0]!.blob.type).toBe("audio/wav");
    restored.assets.forEach((a) => URL.revokeObjectURL(a.url));
  });

  it("rejects truncated headers and media without creating object URLs", async () => {
    const packed = await packProject(newProject(), [media()]);
    const createUrl = vi.spyOn(URL, "createObjectURL");
    await expect(unpackProject(packed.slice(0, 8))).rejects.toThrow(
      "文件头不完整",
    );
    await expect(unpackProject(packed.slice(0, 20))).rejects.toThrow(
      "文件头长度无效",
    );
    await expect(
      unpackProject(packed.slice(0, packed.size - 1)),
    ).rejects.toThrow("媒体数据不完整");
    await expect(unpackProject(new Blob([packed, "extra"]))).rejects.toThrow(
      "长度不匹配",
    );
    expect(createUrl).not.toHaveBeenCalled();
    createUrl.mockRestore();
  });

  it("cleans up earlier media URLs if a legacy asset fails during import", async () => {
    const { blob: _blob, url: _url, ...asset } = media();
    const file = new Blob([
      JSON.stringify({
        version: 1,
        project: newProject(),
        assets: [
          { ...asset, data: "data:audio/wav;base64,aGVsbG8=" },
          { ...asset, id: "second", data: "invalid" },
        ],
      }),
    ]);
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL");
    await expect(unpackProject(file)).rejects.toThrow("无效媒体");
    expect(revokeUrl).toHaveBeenCalledOnce();
    revokeUrl.mockRestore();
  });

  it("rejects bad binary magic before reading the whole file as legacy JSON", async () => {
    class NoWholeReadBlob extends Blob {
      override text(): Promise<string> {
        throw new Error("whole file read");
      }
    }
    const file = new NoWholeReadBlob(["VCUTBIN3", new Uint8Array(1024)]);
    await expect(unpackProject(file)).rejects.toThrow("有效的 VideoCup");
  });
});

it("preserves image payloads, extended durations and transforms through autosave and binary files", async () => {
  const asset: Asset = {
    ...media(new Blob(["png payload"], { type: "image/png" })),
    kind: "image",
    name: "still.png",
    duration: 5,
  };
  const project = newProject(),
    track = project.tracks.find((t) => t.kind === "video")!;
  const clip = createClip(track.id, asset);
  clip.out = 30;
  clip.transform = { x: 30, y: 60, scaleX: 0.5, scaleY: 0.5, rotation: 15 };
  project.clips = [clip];
  await saveWorkspace(project, [asset]);
  const workspace = await loadWorkspace();
  expect(workspace!.project).toEqual(project);
  expect(workspace!.assets[0]!.kind).toBe("image");
  const binary = await packProject(project, [asset]);
  const restored = await unpackProject(new File([binary], "image.vcut"));
  expect(restored.project).toEqual(project);
  expect(restored.assets[0]!.kind).toBe("image");
  expect(await restored.assets[0]!.blob.text()).toBe("png payload");
  workspace!.assets.forEach((a) => URL.revokeObjectURL(a.url));
  restored.assets.forEach((a) => URL.revokeObjectURL(a.url));
});
