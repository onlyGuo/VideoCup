import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNativeExportService,
  runNativeProcess,
} from "../server/native-export.ts";
import type {
  NativeProcessRunner,
  NativeExportServiceOptions,
} from "../server/native-export.ts";
import { nativeExportPlugin } from "../server/vite-native-export.ts";
import { createClip, newProject } from "../src/lib/types";

const origin = "http://127.0.0.1:5173";
const encoders =
  " V....D libx264 H.264\n V....D h264_videotoolbox H.264 (VideoToolbox)\n A....D aac AAC\n A....D flac FLAC\n A....D libmp3lame MP3";
const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
function input(audioOnly = false, subtitle = false) {
  const project = newProject();
  project.width = 320;
  project.height = 180;
  const video = project.tracks.find((track) => track.kind === "video")!;
  project.clips.push({
    ...createClip(video.id, undefined),
    id: "clip-1",
    assetId: "asset-1",
    name: "Source.mov",
    out: 1,
  });
  if (subtitle)
    project.clips.push({
      ...createClip(project.tracks[0]!.id, undefined),
      id: "subtitle-1",
      text: "字幕",
      out: 1,
    });
  return {
    project,
    assets: [
      {
        id: "asset-1",
        name: "Source.mov",
        kind: "video",
        size: bytes.length,
        duration: 1,
        width: 320,
        height: 180,
      },
    ],
    options: {
      width: 320,
      height: 180,
      audioOnly,
      subtitles: true,
      quality: "standard",
    },
  };
}
function request(
  path: string,
  method = "GET",
  body?: unknown,
  headers?: HeadersInit,
) {
  return new Request(`${origin}/api/render/${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers:
      headers ??
      (body === undefined ? {} : { "content-type": "application/json" }),
  });
}
function makeRunner() {
  return vi.fn<NativeProcessRunner>(async (_binary, args, options) => {
    if (args.includes("-encoders"))
      return { code: 0, stdout: encoders, stderr: "" };
    if (!args.includes("-progress"))
      return {
        code: 1,
        stdout: "",
        stderr: "Stream #0:0: Video: h264\nStream #0:1: Audio: aac",
      };
    options.onProgress?.(0.5);
    for (const filename of args.filter((arg) =>
      /^(?:video-\d+\.mp4|audio-\d+\.flac|export\.(?:mp4|mp3))$/.test(arg),
    ))
      await writeFile(join(options.cwd!, filename), "native-result");
    return {
      code: 0,
      stdout: "out_time_us=1000000\nprogress=end\n",
      stderr: "",
    };
  });
}

describe("local native FFmpeg export", () => {
  let root: string;
  let services: ReturnType<typeof createNativeExportService>[];
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "video-cup-native-test-"));
    services = [];
  });
  afterEach(async () => {
    await Promise.all(services.map((service) => service.dispose()));
    await rm(root, { recursive: true, force: true });
  });
  function service(options: NativeExportServiceOptions = {}) {
    const result = createNativeExportService({
      runner: makeRunner(),
      tempRoot: root,
      platform: "darwin",
      ...options,
    });
    services.push(result);
    return result;
  }
  async function create(svc: ReturnType<typeof service>, value = input()) {
    const response = await svc.handle(request("jobs", "POST", value));
    expect(response.status).toBe(201);
    return (await response.json()) as {
      jobId: string;
      requiredAssetIds: string[];
      requiredSubtitleIds: string[];
    };
  }
  async function upload(svc: ReturnType<typeof service>, id: string) {
    return svc.handle(
      new Request(`${origin}/api/render/jobs/${id}/assets/asset-1`, {
        method: "PUT",
        body: bytes,
        headers: { "content-length": String(bytes.length) },
      }),
    );
  }
  async function completed(svc: ReturnType<typeof service>, id: string) {
    await vi.waitFor(async () => {
      const response = await svc.handle(request(`jobs/${id}/status`));
      expect((await response.json()).phase).toBe("completed");
    });
  }

  it("detects hardware encoders once and exposes a cached local capability", async () => {
    const runner = makeRunner(),
      svc = service({ runner });
    const [first, second] = await Promise.all([
      svc.capabilities(),
      svc.capabilities(),
    ]);
    expect(first).toEqual(second);
    expect(first.available).toBe(true);
    expect(first.preferredEncoder).toBe("h264_videotoolbox");
    expect(runner).toHaveBeenCalledOnce();
    const response = await svc.handle(
      new Request("http://evil.test/api/render/capabilities"),
    );
    expect(response.status).toBe(403);
    expect(
      (
        await svc.handle(
          request("capabilities", "GET", undefined, {
            origin: "https://evil.test",
          }),
        )
      ).status,
    ).toBe(403);
  });

  it("reports an unavailable engine without creating a temp job", async () => {
    const svc = service({
      runner: async () => {
        throw new Error("ENOENT");
      },
    });
    expect((await svc.capabilities()).available).toBe(false);
    expect((await svc.handle(request("jobs", "POST", input()))).status).toBe(
      503,
    );
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects unsafe identifiers, malformed timelines, dimensions and missing sources", async () => {
    const svc = service();
    const values = [
      (() => {
        const value = input();
        value.assets[0]!.id = "../outside";
        return value;
      })(),
      (() => {
        const value = input();
        value.project.clips[0]!.speed = 0;
        return value;
      })(),
      (() => {
        const value = input();
        value.options.width = 319;
        return value;
      })(),
      (() => {
        const value = input();
        value.project.clips[0]!.assetId = "missing";
        return value;
      })(),
      (() => {
        const value = input();
        value.project.clips[0]!.transform!.rotation = NaN;
        return value;
      })(),
    ];
    for (const value of values)
      expect((await svc.handle(request("jobs", "POST", value))).status).toBe(
        400,
      );
    expect(await readdir(root)).toEqual([]);
  });

  it("streams uploads to only its temp directory, checks size, and allows a retry after a partial upload", async () => {
    const svc = service(),
      job = await create(svc);
    expect(job.requiredAssetIds).toEqual(["asset-1"]);
    expect(
      (await svc.handle(request(`jobs/${job.jobId}/start`, "POST"))).status,
    ).toBe(409);
    const short = await svc.handle(
      new Request(`${origin}/api/render/jobs/${job.jobId}/assets/asset-1`, {
        method: "PUT",
        body: bytes.slice(0, 3),
      }),
    );
    expect(short.status).toBe(400);
    const dir = join(root, (await readdir(root))[0]!);
    expect(await readdir(dir)).toEqual([]);
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks++;
        if (chunks === 1) controller.enqueue(bytes.slice(0, 3));
        else if (chunks === 2) controller.enqueue(bytes.slice(3));
        else controller.close();
      },
    });
    const init: RequestInit & { duplex: "half" } = {
      method: "PUT",
      body,
      duplex: "half",
    };
    expect(
      (
        await svc.handle(
          new Request(
            `${origin}/api/render/jobs/${job.jobId}/assets/asset-1`,
            init,
          ),
        )
      ).status,
    ).toBe(204);
    expect(new Uint8Array(await readFile(join(dir, "asset-0.mov")))).toEqual(
      bytes,
    );
    expect((await upload(svc, job.jobId)).status).toBe(409);
    expect(
      (
        await svc.handle(
          new Request(`${origin}/api/render/jobs/${job.jobId}/assets/unknown`, {
            method: "PUT",
            body: bytes,
          }),
        )
      ).status,
    ).toBe(404);
  });

  it("validates subtitle PNGs and requires all requested uploads before rendering", async () => {
    const svc = service(),
      job = await create(svc, input(false, true));
    expect(job.requiredSubtitleIds).toEqual(["subtitle-1"]);
    expect((await upload(svc, job.jobId)).status).toBe(204);
    const path = `${origin}/api/render/jobs/${job.jobId}/subtitles/subtitle-1`;
    expect(
      (
        await svc.handle(
          new Request(path, { method: "PUT", body: "not a png" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await svc.handle(request(`jobs/${job.jobId}/start`, "POST"))).status,
    ).toBe(409);
    const png = new Uint8Array(24);
    png.set([137, 80, 78, 71, 13, 10, 26, 10]);
    png.set(new TextEncoder().encode("IHDR"), 12);
    const view = new DataView(png.buffer);
    view.setUint32(16, 320);
    view.setUint32(20, 180);
    expect(
      (await svc.handle(new Request(path, { method: "PUT", body: png })))
        .status,
    ).toBe(204);
    expect(
      (await svc.handle(request(`jobs/${job.jobId}/start`, "POST"))).status,
    ).toBe(202);
    await completed(svc, job.jobId);
  });

  it("renders hardware segments, copies final video, encodes audio once, and streams the retained result", async () => {
    const runner = makeRunner(),
      svc = service({ runner }),
      job = await create(svc);
    await upload(svc, job.jobId);
    expect(
      (await svc.handle(request(`jobs/${job.jobId}/start`, "POST"))).status,
    ).toBe(202);
    await completed(svc, job.jobId);
    const calls = runner.mock.calls.map(([, args]) => args);
    const render = calls.find((args) => args.includes("h264_videotoolbox"))!;
    expect(render).toContain("-protocol_whitelist");
    expect(render).toContain("-format_whitelist");
    const final = calls.find((args) => args.at(-1) === "export.mp4")!;
    expect(final).toContain("copy");
    expect(final).toContain("aac");
    expect(calls.filter((args) => args.includes("aac"))).toHaveLength(1);
    const response = await svc.handle(request(`jobs/${job.jobId}/file`));
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(await response.text()).toBe("native-result");
    const status = await (
      await svc.handle(request(`jobs/${job.jobId}/status`))
    ).json();
    expect(status.progress).toBe(100);
    expect(status.fileSize).toBe(13);
    expect((await svc.handle(request(`jobs/${job.jobId}/file`))).status).toBe(
      200,
    );
  });

  it("falls back to libx264 when VideoToolbox cannot initialize", async () => {
    const base = makeRunner();
    let failed = false;
    const runner = vi.fn<NativeProcessRunner>(async (binary, args, options) => {
      if (args.includes("h264_videotoolbox") && !failed) {
        failed = true;
        return {
          code: 1,
          stdout: "",
          stderr: "h264_videotoolbox: Error initializing output encoder",
        };
      }
      return base(binary, args, options);
    });
    const svc = service({ runner }),
      job = await create(svc);
    await upload(svc, job.jobId);
    await svc.handle(request(`jobs/${job.jobId}/start`, "POST"));
    await completed(svc, job.jobId);
    const status = await (
      await svc.handle(request(`jobs/${job.jobId}/status`))
    ).json();
    expect(status.encoder).toBe("libx264");
    expect(status.hardwareFallback).toBe(true);
    expect(runner.mock.calls.some(([, args]) => args.includes("libx264"))).toBe(
      true,
    );
  });

  it("exports MP3 without video encoding and leaves no artifacts on dispose", async () => {
    const runner = makeRunner(),
      svc = service({ runner }),
      job = await create(svc, input(true));
    await upload(svc, job.jobId);
    await svc.handle(request(`jobs/${job.jobId}/start`, "POST"));
    await completed(svc, job.jobId);
    expect(
      runner.mock.calls.some(([, args]) => args.includes("libmp3lame")),
    ).toBe(true);
    expect(runner.mock.calls.some(([, args]) => args.includes("-c:v"))).toBe(
      false,
    );
    expect(
      (await svc.handle(request(`jobs/${job.jobId}/file`))).headers.get(
        "content-type",
      ),
    ).toBe("audio/mpeg");
    await svc.dispose();
    expect(await readdir(root)).toEqual([]);
  });

  it("cancels only its job and preserves all files outside the generated job directory", async () => {
    await writeFile(join(root, "original.mov"), "keep source");
    const base = makeRunner();
    let renderStarted = false;
    const runner: NativeProcessRunner = async (binary, args, options) => {
      if (!args.includes("-progress")) return base(binary, args, options);
      renderStarted = true;
      return new Promise((_resolve, reject) =>
        options.signal!.addEventListener(
          "abort",
          () => reject(new Error("Aborted")),
          { once: true },
        ),
      );
    };
    const svc = service({ runner }),
      first = await create(svc),
      second = await create(svc);
    await upload(svc, first.jobId);
    await upload(svc, second.jobId);
    await svc.handle(request(`jobs/${first.jobId}/start`, "POST"));
    await vi.waitFor(() => expect(renderStarted).toBe(true));
    expect(
      (await svc.handle(request(`jobs/${second.jobId}/start`, "POST"))).status,
    ).toBe(409);
    expect(
      (await svc.handle(request(`jobs/${first.jobId}`, "DELETE"))).status,
    ).toBe(204);
    expect(
      (await svc.handle(request(`jobs/${first.jobId}/status`))).status,
    ).toBe(404);
    expect(await readFile(join(root, "original.mov"), "utf8")).toBe(
      "keep source",
    );
    expect(
      (await svc.handle(request(`jobs/${second.jobId}/status`))).status,
    ).toBe(200);
  });

  it("keeps FFmpeg failures in job status without replacing source files", async () => {
    const base = makeRunner();
    const svc = service({
      platform: "linux",
      runner: async (binary, args, options) =>
        args.includes("-progress")
          ? {
              code: 1,
              stdout: "",
              stderr: "Error while decoding stream: Invalid data",
            }
          : base(binary, args, options),
    });
    const job = await create(svc);
    await upload(svc, job.jobId);
    await svc.handle(request(`jobs/${job.jobId}/start`, "POST"));
    await vi.waitFor(async () => {
      const status = await (
        await svc.handle(request(`jobs/${job.jobId}/status`))
      ).json();
      expect(status.phase).toBe("failed");
      expect(status.error).toContain("Invalid data");
    });
    expect((await svc.handle(request(`jobs/${job.jobId}/file`))).status).toBe(
      409,
    );
    const dir = join(root, (await readdir(root))[0]!);
    expect(new Uint8Array(await readFile(join(dir, "asset-0.mov")))).toEqual(
      bytes,
    );
  });

  it("registers native middleware in development and preview, with lifecycle cleanup", async () => {
    const plugin = nativeExportPlugin({ runner: makeRunner(), tempRoot: root });
    const handlers: unknown[] = [],
      callbacks: unknown[] = [];
    const server = {
      middlewares: { use: (handler: unknown) => handlers.push(handler) },
      httpServer: {
        once: (_event: string, callback: unknown) => callbacks.push(callback),
      },
    };
    if (typeof plugin.configureServer === "function")
      plugin.configureServer.call({} as never, server as never);
    if (typeof plugin.configurePreviewServer === "function")
      plugin.configurePreviewServer.call({} as never, server as never);
    expect(handlers).toHaveLength(2);
    expect(handlers[0]).toBe(handlers[1]);
    expect(callbacks).toHaveLength(2);
    if (typeof plugin.closeBundle === "function")
      await plugin.closeBundle.call({} as never);
  });

  it("enforces the job limit for concurrent create requests", async () => {
    const svc = service({ maxJobs: 1 });
    const responses = await Promise.all(
      Array.from({ length: 3 }, () =>
        svc.handle(request("jobs", "POST", input())),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 429, 429,
    ]);
    expect(await readdir(root)).toHaveLength(1);
  });

  it("cancels a streaming upload and removes its partial file", async () => {
    const svc = service(),
      job = await create(svc);
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(bytes.slice(0, 4));
      },
    });
    const init: RequestInit & { duplex: "half" } = {
      method: "PUT",
      body,
      duplex: "half",
      signal: controller.signal,
    };
    const response = svc.handle(
      new Request(
        `${origin}/api/render/jobs/${job.jobId}/assets/asset-1`,
        init,
      ),
    );
    const dir = join(root, (await readdir(root))[0]!);
    await vi.waitFor(async () =>
      expect((await readdir(dir)).some((name) => name.endsWith(".part"))).toBe(
        true,
      ),
    );
    controller.abort();
    expect((await response).status).toBe(499);
    expect(await readdir(dir)).toEqual([]);
    expect((await upload(svc, job.jobId)).status).toBe(204);
  });

  it("terminates a stalled child process within its timeout", async () => {
    await expect(
      runNativeProcess(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { timeoutMs: 30 },
      ),
    ).rejects.toMatchObject({ status: 504 });
  });
});
