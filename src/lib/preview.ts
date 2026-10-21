import type { Asset, Clip, Project, Track } from "./types";
import { endOf } from "./types";
import { subtitleCanvas } from "./media";
import {
  getSourceCrop,
  getVisualGeometry,
  normalizeTransform,
} from "./transform";

const WARM_SECONDS = 1.5;
const MAX_WARM_LAYERS = 2;
const MAX_CACHED_FRAME_PIXELS = 1920 * 1080;
const EPSILON = 1e-6;
interface MediaState {
  element: HTMLMediaElement;
  source: string;
  kind: "video" | "audio";
  clip: Clip;
  desired: number;
  tolerance: number;
  frameTolerance: number;
  inFlight?: number;
  frameTarget?: number;
  frameCanvas?: HTMLCanvasElement;
  cachedTarget?: number;
  cachePixels: number;
  needsFrame: boolean;
  frameRequest?: number;
  seekGeneration: number;
  failed: boolean;
  disposed: boolean;
  listeners: [string, EventListener][];
}
interface ImageState {
  element: HTMLImageElement;
  source: string;
  failed: boolean;
  listeners: [string, EventListener][];
}
interface Layer {
  clip: Clip;
  asset?: Asset;
  track: Track;
}
interface Visual {
  clip: Clip;
  source: CanvasImageSource;
  width: number;
  height: number;
  sampleWidth?: number;
  sampleHeight?: number;
}

export class Preview {
  elements = new Map<string, HTMLMediaElement>();
  images = new Map<string, HTMLImageElement>();
  subtitles = new Map<string, HTMLCanvasElement>();
  audioErrors = new Set<string>();
  private media = new Map<string, MediaState>();
  private imageStates = new Map<string, ImageState>();
  private composition?: HTMLCanvasElement;
  private retrySignature = "";
  private frameRetries = 0;
  private lifecycle = 0;
  constructor(
    private canvas: HTMLCanvasElement,
    private invalidate: () => void = () => {},
  ) {}

  private drawSource(draw: () => void) {
    try {
      draw();
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === "InvalidStateError")
        return false;
      throw error;
    }
  }
  private retryComposition(
    project: Project,
    layers: Layer[],
    time: number,
    playing: boolean,
  ) {
    const signature = JSON.stringify([
      time,
      project.width,
      project.height,
      layers.map(({ clip, asset }) => [clip, asset?.url]),
    ]);
    if (signature !== this.retrySignature) {
      this.retrySignature = signature;
      this.frameRetries = 0;
    }
    if (playing || this.frameRetries >= 2) return;
    this.frameRetries++;
    const lifecycle = this.lifecycle;
    // App clears its dirty flag after sync returns, so request retries afterwards.
    queueMicrotask(() => {
      if (lifecycle === this.lifecycle) this.invalidate();
    });
  }

  private cancelFrame(state: MediaState) {
    const video = state.element as HTMLVideoElement;
    if (
      state.frameRequest !== undefined &&
      typeof video.cancelVideoFrameCallback === "function"
    )
      video.cancelVideoFrameCallback(state.frameRequest);
    state.frameRequest = undefined;
  }
  private captureFrame(state: MediaState) {
    const video = state.element as HTMLVideoElement;
    if (
      state.kind !== "video" ||
      state.disposed ||
      state.failed ||
      state.inFlight !== undefined ||
      state.needsFrame ||
      video.seeking ||
      video.readyState < 2 ||
      !video.videoWidth ||
      !video.videoHeight
    )
      return;
    const scale = Math.min(
      1,
      Math.sqrt(state.cachePixels / (video.videoWidth * video.videoHeight)),
    );
    const width = Math.max(1, Math.floor(video.videoWidth * scale));
    const height = Math.max(1, Math.floor(video.videoHeight * scale));
    const previous = state.frameCanvas;
    const changedSize =
      !previous || previous.width !== width || previous.height !== height;
    const frame = changedSize ? document.createElement("canvas") : previous;
    if (changedSize) {
      frame.width = width;
      frame.height = height;
    }
    const context = frame.getContext("2d")!;
    if (!this.drawSource(() => context.drawImage(video, 0, 0, width, height))) {
      if (changedSize) {
        frame.width = 0;
        frame.height = 0;
      }
      return;
    }
    if (changedSize && previous) {
      previous.width = 0;
      previous.height = 0;
    }
    state.frameCanvas = frame;
    state.cachedTarget = video.currentTime;
  }
  private requestFrame(state: MediaState) {
    const video = state.element as HTMLVideoElement;
    if (
      state.kind !== "video" ||
      typeof video.requestVideoFrameCallback !== "function" ||
      state.frameRequest !== undefined ||
      state.disposed
    )
      return;
    const generation = state.seekGeneration;
    state.frameRequest = video.requestVideoFrameCallback((_now, metadata) => {
      if (state.disposed || generation !== state.seekGeneration) return;
      state.frameRequest = undefined;
      const target = state.frameTarget ?? state.desired;
      state.needsFrame =
        Math.abs(metadata.mediaTime - target) > state.frameTolerance;
      if (state.needsFrame) this.requestFrame(state);
      else if (state.inFlight === undefined && !video.seeking) {
        this.captureFrame(state);
        this.advanceSeek(state);
      }
      this.invalidate();
    });
  }
  private advanceSeek(state: MediaState) {
    const element = state.element;
    if (
      state.disposed ||
      state.failed ||
      state.needsFrame ||
      state.inFlight !== undefined ||
      element.seeking ||
      element.readyState < 1
    )
      return;
    if (Math.abs(element.currentTime - state.desired) <= state.tolerance)
      return;
    state.inFlight = state.desired;
    state.frameTarget = state.desired;
    state.needsFrame = true;
    state.seekGeneration++;
    this.cancelFrame(state);
    // Listen for the submitted frame before seeking; paused video can deliver it
    // before seeked, and registering afterwards could wait for a nonexistent next frame.
    this.requestFrame(state);
    try {
      element.currentTime = state.desired;
    } catch {
      state.inFlight = undefined;
      state.failed = true;
      this.cancelFrame(state);
      this.invalidate();
    }
  }
  private createMedia(layer: Layer): MediaState {
    const { clip, asset } = layer;
    const kind = asset!.kind === "video" ? "video" : "audio";
    const element = document.createElement(kind);
    element.preload = "auto";
    if (kind === "video") (element as HTMLVideoElement).playsInline = true;
    const state: MediaState = {
      element,
      source: asset!.url,
      kind,
      clip,
      desired: clip.in,
      tolerance: 0.025,
      frameTolerance: 0.05,
      needsFrame: false,
      cachePixels: MAX_CACHED_FRAME_PIXELS,
      seekGeneration: 0,
      failed: false,
      disposed: false,
      listeners: [],
    };
    const ready: EventListener = () => {
      if (Math.abs(element.currentTime - state.desired) <= state.tolerance)
        this.captureFrame(state);
      this.advanceSeek(state);
      this.invalidate();
    };
    const seeked: EventListener = () => {
      if (state.disposed) return;
      state.inFlight = undefined;
      if (
        state.kind !== "video" ||
        typeof (element as HTMLVideoElement).requestVideoFrameCallback !==
          "function"
      )
        state.needsFrame = false;
      if (!state.needsFrame) this.captureFrame(state);
      this.advanceSeek(state); // Preserve this completed frame before pursuing the latest target.
      if (state.needsFrame) this.requestFrame(state);
      this.invalidate();
    };
    const error: EventListener = () => {
      state.failed = true;
      this.cancelFrame(state);
      this.invalidate();
    };
    state.listeners = [
      ["loadedmetadata", ready],
      ["loadeddata", ready],
      ["canplay", ready],
      ["seeked", seeked],
      ["error", error],
    ];
    state.listeners.forEach(([event, listener]) =>
      element.addEventListener(event, listener),
    );
    this.media.set(clip.id, state);
    this.elements.set(clip.id, element);
    element.src = asset!.url;
    return state;
  }
  private releaseMedia(id: string, state: MediaState) {
    state.disposed = true;
    this.cancelFrame(state);
    state.listeners.forEach(([event, listener]) =>
      state.element.removeEventListener(event, listener),
    );
    state.element.pause();
    state.element.removeAttribute("src");
    state.element.load();
    if (state.frameCanvas) {
      state.frameCanvas.width = 0;
      state.frameCanvas.height = 0;
    }
    this.media.delete(id);
    this.elements.delete(id);
    this.audioErrors.delete(id);
  }
  private createImage(layer: Layer) {
    const element = document.createElement("img");
    element.decoding = "async";
    const state: ImageState = {
      element,
      source: layer.asset!.url,
      failed: false,
      listeners: [],
    };
    const ready: EventListener = () => this.invalidate();
    const error: EventListener = () => {
      state.failed = true;
      this.invalidate();
    };
    state.listeners = [
      ["load", ready],
      ["error", error],
    ];
    state.listeners.forEach(([event, listener]) =>
      element.addEventListener(event, listener),
    );
    this.imageStates.set(layer.clip.id, state);
    this.images.set(layer.clip.id, element);
    element.src = state.source;
    return state;
  }
  private releaseImage(id: string, state: ImageState) {
    state.listeners.forEach(([event, listener]) =>
      state.element.removeEventListener(event, listener),
    );
    state.element.removeAttribute("src");
    this.imageStates.delete(id);
    this.images.delete(id);
  }
  private continuous(previous: Clip, next: Clip) {
    return (
      previous.trackId === next.trackId &&
      previous.assetId === next.assetId &&
      Math.abs(endOf(previous) - next.start) < EPSILON &&
      Math.abs(previous.out - next.in) < EPSILON &&
      Math.abs(previous.speed - next.speed) < EPSILON
    );
  }
  private moveContinuous(layers: Layer[], time: number) {
    const desired = new Set(layers.map(({ clip }) => clip.id));
    for (const layer of layers) {
      if (layer.asset?.kind !== "video" || this.media.has(layer.clip.id))
        continue;
      for (const [id, state] of this.media) {
        if (
          desired.has(id) ||
          state.kind !== "video" ||
          state.source !== layer.asset.url ||
          !this.continuous(state.clip, layer.clip) ||
          time - layer.clip.start > 0.25
        )
          continue;
        this.media.delete(id);
        this.elements.delete(id);
        this.audioErrors.delete(id);
        state.clip = layer.clip;
        this.media.set(layer.clip.id, state);
        this.elements.set(layer.clip.id, state.element);
        break;
      }
    }
  }
  sync(project: Project, assets: Asset[], time: number, playing: boolean) {
    const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
    const layers: Layer[] = [];
    const warm: Layer[] = [];
    for (const track of [...project.tracks].reverse()) {
      if (track.hidden) continue;
      const clips = project.clips.filter((clip) => clip.trackId === track.id);
      const active = clips.filter(
        (clip) => time >= clip.start && time < endOf(clip),
      );
      active.forEach((clip) =>
        layers.push({ clip, track, asset: assetsById.get(clip.assetId!) }),
      );
      if (track.kind !== "video") continue;
      const next = clips
        .filter(
          (clip) =>
            clip.start > time &&
            clip.start - time <= WARM_SECONDS &&
            clip.text === undefined &&
            ["video", "image"].includes(
              assetsById.get(clip.assetId!)?.kind || "",
            ),
        )
        .sort((a, b) => a.start - b.start)[0];
      if (next && !active.some((clip) => this.continuous(clip, next)))
        warm.push({ clip: next, track, asset: assetsById.get(next.assetId!) });
    }
    warm.sort((a, b) => a.clip.start - b.clip.start);
    const kept = [...layers, ...warm.slice(0, MAX_WARM_LAYERS)].filter(
      (layer) => layer.asset && layer.clip.text === undefined,
    );
    this.moveContinuous(layers, time);
    const liveMedia = new Map(
      kept
        .filter((layer) => layer.asset!.kind !== "image")
        .map((layer) => [layer.clip.id, layer]),
    );
    const liveImages = new Map(
      kept
        .filter((layer) => layer.asset!.kind === "image")
        .map((layer) => [layer.clip.id, layer]),
    );
    for (const [id, state] of this.media)
      if (!liveMedia.has(id) || liveMedia.get(id)!.asset!.url !== state.source)
        this.releaseMedia(id, state);
    for (const [id, state] of this.imageStates)
      if (
        !liveImages.has(id) ||
        liveImages.get(id)!.asset!.url !== state.source
      )
        this.releaseImage(id, state);
    const activeIds = new Set(layers.map(({ clip }) => clip.id));
    for (const layer of kept) {
      const { clip, asset, track } = layer;
      if (asset!.kind === "image") {
        if (!this.imageStates.has(clip.id)) this.createImage(layer);
        continue;
      }
      const state = this.media.get(clip.id) || this.createMedia(layer);
      state.clip = clip;
      state.cachePixels = Math.min(
        MAX_CACHED_FRAME_PIXELS,
        project.width * project.height,
      );
      const element = state.element;
      const active = activeIds.has(clip.id);
      state.desired = active
        ? clip.in + (time - clip.start) * clip.speed
        : clip.in;
      state.tolerance =
        playing && active ? 0.16 : Math.min(0.025, 0.5 / project.fps);
      state.frameTolerance = Math.max(0.05, 1 / project.fps);
      element.muted = !active || track.muted || clip.volume === 0;
      element.volume = active ? Math.max(0, Math.min(1, clip.volume)) : 0;
      element.playbackRate = clip.speed;
      this.advanceSeek(state);
      const ready =
        !state.failed &&
        element.readyState >= 2 &&
        state.inFlight === undefined &&
        !state.needsFrame &&
        !element.seeking;
      if (playing && active && ready && element.paused)
        void element.play().catch(() => {
          if (!state.disposed && this.media.get(state.clip.id) === state)
            this.audioErrors.add(state.clip.id);
        });
      else if (!playing || !active || !ready) element.pause();
    }

    const visuals: Visual[] = [];
    let complete = true;
    const subtitleLayers = layers
      .filter(({ clip }) => clip.text !== undefined)
      .map(({ clip }) => clip);
    for (const { clip, asset } of layers) {
      if (!asset || clip.text !== undefined || asset.kind === "audio") continue;
      if (asset.kind === "image") {
        const state = this.imageStates.get(clip.id)!;
        if (state.failed) continue;
        if (!state.element.complete || !state.element.naturalWidth) {
          complete = false;
          continue;
        }
        visuals.push({
          clip,
          source: state.element,
          width: state.element.naturalWidth,
          height: state.element.naturalHeight,
        });
      } else {
        const state = this.media.get(clip.id)!;
        if (state.failed) continue;
        const video = state.element as HTMLVideoElement;
        if (
          state.inFlight !== undefined ||
          state.needsFrame ||
          video.seeking ||
          video.readyState < 2 ||
          !video.videoWidth
        ) {
          if (
            state.frameCanvas &&
            state.cachedTarget !== undefined &&
            state.cachedTarget >= clip.in - state.frameTolerance &&
            state.cachedTarget < clip.out
          ) {
            visuals.push({
              clip,
              source: state.frameCanvas,
              width: video.videoWidth,
              height: video.videoHeight,
              sampleWidth: state.frameCanvas.width,
              sampleHeight: state.frameCanvas.height,
            });
            continue;
          }
          complete = false;
          continue;
        }
        visuals.push({
          clip,
          source: video,
          width: video.videoWidth,
          height: video.videoHeight,
        });
      }
    }
    const subtitleKey = (clip: Clip) =>
      `${project.width}-${project.height}-${clip.text}-${clip.fontSize}-${clip.color}`;
    const subtitleKeys = new Set(subtitleLayers.map(subtitleKey));
    for (const [key, canvas] of this.subtitles)
      if (!subtitleKeys.has(key)) {
        canvas.width = 0;
        canvas.height = 0;
        this.subtitles.delete(key);
      }
    // All required visual sources must be ready before clearing either canvas.
    // A real empty interval has no pending visual source and commits its black background immediately.
    if (!complete) return;
    this.composition ||= document.createElement("canvas");
    const composition = this.composition;
    if (composition.width !== project.width) composition.width = project.width;
    if (composition.height !== project.height)
      composition.height = project.height;
    const context = composition.getContext("2d")!;
    context.globalAlpha = 1;
    context.fillStyle = "#090b0c";
    context.fillRect(0, 0, project.width, project.height);
    for (const visual of visuals) {
      const crop = getSourceCrop(visual.clip, visual.width, visual.height);
      const geometry = getVisualGeometry(visual.clip, visual, project);
      const transform = normalizeTransform(visual.clip.transform);
      context.save();
      let drawn = false;
      try {
        context.globalAlpha = visual.clip.opacity;
        context.translate(geometry.cx, geometry.cy);
        context.rotate((transform.rotation * Math.PI) / 180);
        drawn = this.drawSource(() =>
          context.drawImage(
            visual.source,
            (crop.x * (visual.sampleWidth ?? visual.width)) / visual.width,
            (crop.y * (visual.sampleHeight ?? visual.height)) / visual.height,
            (crop.width * (visual.sampleWidth ?? visual.width)) / visual.width,
            (crop.height * (visual.sampleHeight ?? visual.height)) /
              visual.height,
            -geometry.width / 2,
            -geometry.height / 2,
            geometry.width,
            geometry.height,
          ),
        );
      } finally {
        context.restore();
      }
      if (!drawn) {
        this.retryComposition(project, layers, time, playing);
        return;
      }
    }
    for (const clip of subtitleLayers) {
      const key = subtitleKey(clip);
      if (!this.subtitles.has(key))
        this.subtitles.set(
          key,
          subtitleCanvas(
            clip.text!,
            project.width,
            project.height,
            clip.fontSize,
            clip.color,
          ),
        );
      const geometry = getVisualGeometry(clip, undefined, project);
      const transform = normalizeTransform(clip.transform);
      context.save();
      let drawn = false;
      try {
        context.globalAlpha = clip.opacity;
        context.translate(geometry.cx, geometry.cy);
        context.rotate((transform.rotation * Math.PI) / 180);
        drawn = this.drawSource(() =>
          context.drawImage(
            this.subtitles.get(key)!,
            -geometry.width / 2,
            -geometry.height / 2,
            geometry.width,
            geometry.height,
          ),
        );
      } finally {
        context.restore();
      }
      if (!drawn) {
        this.retryComposition(project, layers, time, playing);
        return;
      }
    }
    context.globalAlpha = 1;
    if (this.canvas.width !== project.width) this.canvas.width = project.width;
    if (this.canvas.height !== project.height)
      this.canvas.height = project.height;
    const display = this.canvas.getContext("2d")!;
    display.globalAlpha = 1;
    display.drawImage(composition, 0, 0);
    if (!playing)
      for (const { clip, asset } of layers)
        if (asset?.kind === "video")
          this.captureFrame(this.media.get(clip.id)!);
    this.frameRetries = 0;
    this.retrySignature = "";
  }
  dispose() {
    this.lifecycle++;
    this.frameRetries = 0;
    this.retrySignature = "";
    for (const [id, state] of this.media) this.releaseMedia(id, state);
    for (const [id, state] of this.imageStates) this.releaseImage(id, state);
    this.subtitles.forEach((canvas) => {
      canvas.width = 0;
      canvas.height = 0;
    });
    this.subtitles.clear();
    this.audioErrors.clear();
    if (this.composition) {
      this.composition.width = 0;
      this.composition.height = 0;
      this.composition = undefined;
    }
  }
}
