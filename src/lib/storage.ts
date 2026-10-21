import { toRaw } from "vue";
import type { Asset, Project } from "./types";
import { normalizeTransform, TRANSFORM_LIMITS } from "./transform";

const MAGIC = new TextEncoder().encode("VCUTBIN2");
const PREFIX_SIZE = MAGIC.length + 4;
const MAX_HEADER_SIZE = 32 * 1024 * 1024;
const WRITE_CHUNK_SIZE = 8 * 1024 * 1024;
type AssetMetadata = Omit<Asset, "url" | "blob">;
type WorkspaceAsset = AssetMetadata & { blobKey: string };
type Workspace = { project: Project; assets: Asset[] };
type StoredWorkspace = {
  version: 2;
  savedAt: number;
  project: Project;
  assets: WorkspaceAsset[];
};
const blobKeys = new WeakMap<Blob, string>();
const persistedBlobs = new WeakSet<Blob>();
let workspaceWrite: Promise<void> = Promise.resolve();

const open = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("video-cup", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("workspace");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

function metadata(asset: Asset): AssetMetadata {
  const { url: _url, blob: _blob, ...data } = toRaw(asset);
  return JSON.parse(JSON.stringify(data));
}

/** Capture the small editing state now; media bytes remain immutable Blob references. */
function snapshot(project: Project, assets: Asset[]) {
  return {
    project: JSON.parse(JSON.stringify(project)) as Project,
    assets: assets.map((asset) => ({
      ...metadata(asset),
      blob: toRaw(asset.blob),
    })),
  };
}

/** Write media once, and commit metadata and recovery points in the same transaction. */
export function saveWorkspace(
  project: Project,
  assets: Asset[],
): Promise<void> {
  const captured = snapshot(project, assets);
  const save = async () => {
    const db = await open();
    const media = captured.assets.map(({ blob, ...asset }) => {
      let blobKey = blobKeys.get(blob);
      if (!blobKey) {
        blobKey = `media:${crypto.randomUUID()}`;
        blobKeys.set(blob, blobKey);
      }
      return { blob, blobKey, asset };
    });
    const data: StoredWorkspace = {
      version: 2,
      savedAt: Date.now(),
      project: captured.project,
      assets: media.map(({ blobKey, asset }) => ({ ...asset, blobKey })),
    };
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("workspace", "readwrite", {
          durability: "strict",
        });
        const store = tx.objectStore("workspace");
        const backup = store.get("recovery:before-v2");
        const previous = store.get("current");
        previous.onsuccess = () => {
          if (previous.result) {
            store.put(previous.result, "previous");
            // Keep the original legacy workspace permanently; never rewrite it.
            if (previous.result.version !== 2 && !backup.result)
              store.put(previous.result, "recovery:before-v2");
          }
          for (const { blob, blobKey } of media)
            if (!persistedBlobs.has(blob)) store.put(blob, blobKey);
          store.put(data, "current");
        };
        tx.oncomplete = () => {
          media.forEach(({ blob }) => persistedBlobs.add(blob));
          resolve();
        };
        tx.onerror = () => reject(tx.error || new Error("本地工程保存失败"));
        tx.onabort = () => reject(tx.error || new Error("本地工程保存已中止"));
      });
    } finally {
      db.close();
    }
  };
  const result = workspaceWrite.then(save);
  // A failed save must not stop later attempts from running.
  workspaceWrite = result.catch(() => undefined);
  return result;
}

function getStored(db: IDBDatabase, key: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const request = db
      .transaction("workspace")
      .objectStore("workspace")
      .get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function restoreWorkspace(
  db: IDBDatabase,
  data: any,
): Promise<Workspace> {
  validateProject(data.project, data.assets);
  const restored: Asset[] = [];
  try {
    for (const asset of data.assets) {
      const blob =
        data.version === 2 ? await getStored(db, asset.blobKey) : asset.blob;
      if (!(blob instanceof Blob)) throw new Error("本地工程的媒体不完整");
      const { blobKey, url: _url, ...rest } = asset;
      if (data.version === 2) {
        blobKeys.set(blob, blobKey);
        persistedBlobs.add(blob);
      }
      restored.push({ ...rest, blob, url: URL.createObjectURL(blob) });
    }
    return { project: data.project, assets: restored };
  } catch (error) {
    restored.forEach((asset) => URL.revokeObjectURL(asset.url));
    throw error;
  }
}

export async function loadWorkspace(): Promise<Workspace | null> {
  const db = await open();
  let lastError: unknown;
  try {
    for (const key of ["current", "previous", "recovery:before-v2"]) {
      const data = await getStored(db, key);
      if (!data) continue;
      try {
        return await restoreWorkspace(db, data);
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) throw lastError;
    return null;
  } finally {
    db.close();
  }
}

function projectParts(project: Project, assets: Asset[]): BlobPart[] {
  const captured = snapshot(project, assets);
  let offset = 0;
  const files = captured.assets.map(({ blob, ...asset }) => {
    const entry = { ...asset, type: blob.type, offset, size: blob.size };
    offset += blob.size;
    if (!Number.isSafeInteger(offset)) throw new Error("工程素材过大");
    return entry;
  });
  const header = new TextEncoder().encode(
    JSON.stringify({ version: 2, project: captured.project, assets: files }),
  );
  if (header.length > MAX_HEADER_SIZE) throw new Error("工程元数据过大");
  const prefix = new Uint8Array(PREFIX_SIZE);
  prefix.set(MAGIC);
  new DataView(prefix.buffer).setUint32(MAGIC.length, header.length, true);
  return [prefix, header, ...captured.assets.map(({ blob }) => blob)];
}

/** Blob composition retains media references instead of base64/string copies. */
export async function packProject(
  project: Project,
  assets: Asset[],
): Promise<Blob> {
  return new Blob(projectParts(project, assets), {
    type: "application/x-videocup",
  });
}

export interface ProjectFileWritable {
  write(data: Blob | Uint8Array<ArrayBuffer>): Promise<unknown>;
  close(): Promise<unknown>;
  abort(reason?: unknown): Promise<unknown>;
}
export interface ProjectFileProgress {
  written: number;
  total: number;
}

/** Stream bounded Blob slices to a chosen file; close commits the completed file. */
export async function writeProjectToFile(
  project: Project,
  assets: Asset[],
  writable: ProjectFileWritable,
  onProgress?: (progress: ProjectFileProgress) => void,
): Promise<void> {
  try {
    const parts = projectParts(project, assets);
    const total = parts.reduce<number>(
      (size, part) =>
        size +
        (part instanceof Blob ? part.size : (part as Uint8Array).byteLength),
      0,
    );
    let written = 0;
    onProgress?.({ written, total });
    for (const part of parts) {
      if (part instanceof Blob) {
        for (let offset = 0; offset < part.size; offset += WRITE_CHUNK_SIZE) {
          const chunk = part.slice(offset, offset + WRITE_CHUNK_SIZE);
          await writable.write(chunk);
          written += chunk.size;
          onProgress?.({ written, total });
        }
      } else {
        await writable.write(part as Uint8Array<ArrayBuffer>);
        written += (part as Uint8Array).byteLength;
        onProgress?.({ written, total });
      }
    }
    await writable.close();
  } catch (error) {
    await writable.abort(error).catch(() => undefined);
    throw error;
  }
}

function validateProject(
  project: any,
  assets: any[],
): asserts project is Project {
  if (
    !project ||
    !Array.isArray(project.clips) ||
    !Array.isArray(project.tracks) ||
    !Array.isArray(assets) ||
    typeof project.name !== "string" ||
    ![project.width, project.height, project.fps].every(
      (n) => Number.isFinite(n) && n > 0,
    ) ||
    project.width > 3840 ||
    project.height > 3840 ||
    project.fps > 120
  )
    throw new Error("不是有效的 VideoCup 工程文件");
  const ids = new Set<string>();
  for (const asset of assets) {
    if (
      !asset ||
      typeof asset.id !== "string" ||
      ids.has(asset.id) ||
      typeof asset.name !== "string" ||
      !["video", "audio", "image"].includes(asset.kind) ||
      !Number.isFinite(asset.duration) ||
      asset.duration < 0
    )
      throw new Error("工程包含无效媒体");
    ids.add(asset.id);
  }
  if (
    project.tracks.some(
      (track: any) =>
        !track ||
        typeof track.id !== "string" ||
        !["video", "audio", "subtitle"].includes(track.kind),
    )
  )
    throw new Error("工程包含无效轨道");
  for (const clip of project.clips) {
    const transform = clip?.transform;
    if (
      transform !== undefined &&
      (!transform ||
        ![
          transform.x,
          transform.y,
          transform.scaleX,
          transform.scaleY,
          transform.rotation,
        ].every(Number.isFinite) ||
        transform.x < TRANSFORM_LIMITS.minPosition ||
        transform.x > TRANSFORM_LIMITS.maxPosition ||
        transform.y < TRANSFORM_LIMITS.minPosition ||
        transform.y > TRANSFORM_LIMITS.maxPosition ||
        transform.scaleX < TRANSFORM_LIMITS.minScale ||
        transform.scaleX > TRANSFORM_LIMITS.maxScale ||
        transform.scaleY < TRANSFORM_LIMITS.minScale ||
        transform.scaleY > TRANSFORM_LIMITS.maxScale)
    )
      throw new Error("工程包含无效的元素变换");
    if (
      !clip ||
      ![
        clip.start,
        clip.in,
        clip.out,
        clip.speed,
        clip.volume,
        clip.opacity,
        clip.fontSize,
        clip.crop?.x,
        clip.crop?.y,
        clip.crop?.width,
        clip.crop?.height,
      ].every(Number.isFinite) ||
      clip.start < 0 ||
      clip.in < 0 ||
      clip.out <= clip.in ||
      clip.speed < 0.25 ||
      clip.speed > 4 ||
      !project.tracks.some((track: any) => track.id === clip.trackId) ||
      (clip.assetId && !ids.has(clip.assetId))
    )
      throw new Error("工程包含无效片段");
    clip.transform = normalizeTransform(transform);
  }
}

export async function unpackProject(file: Blob): Promise<Workspace> {
  const prefix = new Uint8Array(await file.slice(0, PREFIX_SIZE).arrayBuffer());
  const binary = MAGIC.every((byte, index) => prefix[index] === byte);
  let data: any;
  let payloadStart = 0;
  if (binary) {
    if (prefix.length !== PREFIX_SIZE) throw new Error("工程文件头不完整");
    const length = new DataView(prefix.buffer).getUint32(MAGIC.length, true);
    if (
      length === 0 ||
      length > MAX_HEADER_SIZE ||
      PREFIX_SIZE + length > file.size
    )
      throw new Error("工程文件头长度无效");
    payloadStart = PREFIX_SIZE + length;
    data = JSON.parse(await file.slice(PREFIX_SIZE, payloadStart).text());
    if (data.version !== 2) throw new Error("不支持此 VideoCup 工程版本");
  } else {
    // A corrupt binary file must never fall back to reading gigabytes as JSON.
    const probe = await file.slice(0, 4096).text();
    if (!probe.trimStart().startsWith("{"))
      throw new Error("不是有效的 VideoCup 工程文件");
    data = JSON.parse(await file.text());
    if (data.version !== 1) throw new Error("不是有效的 VideoCup 工程文件");
  }
  validateProject(data.project, data.assets);
  if (binary) {
    let offset = 0;
    for (const asset of data.assets) {
      if (
        !Number.isSafeInteger(asset.offset) ||
        asset.offset !== offset ||
        !Number.isSafeInteger(asset.size) ||
        asset.size < 0 ||
        typeof asset.type !== "string"
      )
        throw new Error("工程包含无效的媒体范围");
      offset += asset.size;
      if (!Number.isSafeInteger(offset) || payloadStart + offset > file.size)
        throw new Error("工程媒体数据不完整");
    }
    if (payloadStart + offset !== file.size)
      throw new Error("工程媒体数据长度不匹配");
  }
  const assets: Asset[] = [];
  try {
    for (const asset of data.assets) {
      let blob: Blob;
      if (binary) {
        blob = file.slice(
          payloadStart + asset.offset,
          payloadStart + asset.offset + asset.size,
          asset.type,
        );
      } else {
        if (typeof asset.data !== "string" || !asset.data.startsWith("data:"))
          throw new Error("工程包含无效媒体");
        blob = await (await fetch(asset.data)).blob();
      }
      const {
        data: _data,
        type: _type,
        offset: _offset,
        size: _size,
        ...rest
      } = asset;
      assets.push({ ...rest, blob, url: URL.createObjectURL(blob) });
    }
    return { project: data.project, assets };
  } catch (error) {
    assets.forEach((asset) => URL.revokeObjectURL(asset.url));
    throw error;
  }
}
