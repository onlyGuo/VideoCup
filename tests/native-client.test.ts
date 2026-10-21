import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  discardNativeExport,
  nativeCapabilities,
  nativeExport,
} from "../src/lib/native-export";
import { createClip, newProject } from "../src/lib/types";
import type { Asset } from "../src/lib/types";

vi.mock("../src/lib/media", () => ({
  subtitleCanvas: vi.fn(() => ({
    width: 1920,
    height: 1080,
    toBlob: (callback: BlobCallback) =>
      callback(new Blob(["png"], { type: "image/png" })),
  })),
}));

const options = {
  width: 1920,
  height: 1080,
  audioOnly: false,
  subtitles: true,
  quality: "standard",
};
function fixture() {
  const project = newProject();
  const asset: Asset = {
    id: "source",
    kind: "image",
    name: "picture.png",
    blob: new Blob(["picture"], { type: "image/png" }),
    url: "blob:picture",
    duration: 5,
    width: 800,
    height: 600,
  };
  project.clips.push(createClip(project.tracks[1]!.id, asset));
  const subtitle = createClip(project.tracks[0]!.id, undefined);
  subtitle.text = "字幕";
  project.clips.push(subtitle);
  const controller = new AbortController(),
    status = vi.fn(),
    progress = vi.fn();
  return { project, asset, subtitle, controller, status, progress };
}
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("native renderer browser client", () => {
  it("accepts empty 204 upload responses and exposes the download URL without loading the rendered file", async () => {
    const f = fixture();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT" || init?.method === "DELETE")
        return new Response(null, { status: 204 });
      if (url === "/api/render/jobs")
        return Response.json(
          {
            jobId: "job",
            requiredAssetIds: [f.asset.id],
            requiredSubtitleIds: [f.subtitle.id],
          },
          { status: 201 },
        );
      if (url.endsWith("/start"))
        return Response.json({ phase: "queued" }, { status: 202 });
      return Response.json({
        phase: "completed",
        progress: 100,
        fileSize: 2048,
        encoder: "h264_videotoolbox",
      });
    });
    const result = await nativeExport(
      f.project,
      [f.asset],
      options,
      f.status,
      f.progress,
      f.controller.signal,
    );
    expect(result).toEqual({
      url: "/api/render/jobs/job/file",
      size: 2048,
      jobId: "job",
      encoder: "h264_videotoolbox",
    });
    const upload = fetchMock.mock.calls.find(([url]) =>
      url.endsWith(`/assets/${f.asset.id}`),
    );
    expect(upload![1].body).toBe(f.asset.blob);
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/file"))).toBe(
      false,
    );
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE"),
    ).toBe(false);
    expect(f.progress).toHaveBeenLastCalledWith(100);
    expect(f.asset.url).toBe("blob:picture");
    expect(f.project.clips).toHaveLength(2);
  });

  it("shows the server's structured error and deletes the failed temporary job", async () => {
    const f = fixture();
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST")
        return Response.json(
          {
            jobId: "failed",
            requiredAssetIds: [f.asset.id],
            requiredSubtitleIds: [],
          },
          { status: 201 },
        );
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json(
        { error: { message: "本机剩余空间不足", code: "disk_full" } },
        { status: 507 },
      );
    });
    await expect(
      nativeExport(
        f.project,
        [f.asset],
        options,
        f.status,
        f.progress,
        f.controller.signal,
      ),
    ).rejects.toThrow("本机剩余空间不足");
    expect(fetchMock).toHaveBeenCalledWith("/api/render/jobs/failed", {
      method: "DELETE",
      keepalive: true,
    });
  });

  it("removes a job even if cancellation arrives while its creation response is being read", async () => {
    const f = fixture();
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      const response = Response.json(
        { jobId: "cancelled", requiredAssetIds: [], requiredSubtitleIds: [] },
        { status: 201 },
      );
      const read = response.json.bind(response);
      response.json = async () => {
        const body = await read();
        f.controller.abort();
        return body;
      };
      return response;
    });
    await expect(
      nativeExport(
        f.project,
        [f.asset],
        options,
        f.status,
        f.progress,
        f.controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledWith("/api/render/jobs/cancelled", {
      method: "DELETE",
      keepalive: true,
    });
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "PUT"),
    ).toBe(false);
  });

  it("aborts an active upload and deletes only its temporary job", async () => {
    const f = fixture();
    let uploading!: () => void;
    const started = new Promise<void>((resolve) => {
      uploading = resolve;
    });
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST")
        return Response.json(
          {
            jobId: "upload",
            requiredAssetIds: [f.asset.id],
            requiredSubtitleIds: [],
          },
          { status: 201 },
        );
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener(
          "abort",
          () => reject(init!.signal!.reason),
          { once: true },
        );
        uploading();
      });
    });
    const pending = nativeExport(
      f.project,
      [f.asset],
      options,
      f.status,
      f.progress,
      f.controller.signal,
    );
    const rejection = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    await started;
    f.controller.abort();
    await rejection;
    expect(fetchMock).toHaveBeenCalledWith("/api/render/jobs/upload", {
      method: "DELETE",
      keepalive: true,
    });
    expect(await f.asset.blob.text()).toBe("picture");
  });

  it("cancels while waiting for status without continuing to poll", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let received!: () => void;
    const statusReceived = new Promise<void>((resolve) => {
      received = resolve;
    });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (url === "/api/render/jobs")
        return Response.json(
          { jobId: "poll", requiredAssetIds: [], requiredSubtitleIds: [] },
          { status: 201 },
        );
      if (url.endsWith("/start")) return Response.json({ phase: "queued" });
      received();
      return Response.json({
        phase: "encoding",
        progress: 30,
        encoder: "libx264",
      });
    });
    const pending = nativeExport(
      f.project,
      [f.asset],
      options,
      f.status,
      f.progress,
      f.controller.signal,
    );
    const rejection = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    await statusReceived;
    for (let i = 0; i < 5; i++) await Promise.resolve();
    f.controller.abort();
    await rejection;
    await vi.advanceTimersByTimeAsync(5000);
    expect(
      fetchMock.mock.calls.filter(([url]) => url.endsWith("/status")),
    ).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/render/jobs/poll", {
      method: "DELETE",
      keepalive: true,
    });
  });

  it("falls back when local capabilities are unavailable but propagates explicit cancellation", async () => {
    fetchMock.mockRejectedValue(new TypeError("offline"));
    await expect(nativeCapabilities()).resolves.toMatchObject({
      available: false,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(nativeCapabilities(controller.signal)).rejects.toThrow(
      "offline",
    );
  });

  it("safely encodes the job ID when discarding a previous result", () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    discardNativeExport("job/../outside");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/render/jobs/job%2F..%2Foutside",
      { method: "DELETE", keepalive: true },
    );
  });
});
