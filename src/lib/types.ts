export type TrackKind = "video" | "audio" | "subtitle";
export type AssetKind = "video" | "audio" | "image";
export const assetTrackKind = (
  asset: Pick<Asset, "kind">,
): "video" | "audio" => (asset.kind === "audio" ? "audio" : "video");
export const assetTrimLimit = (asset?: Asset) =>
  asset?.kind === "image" ? 3600 : (asset?.duration ?? 3600);
export interface Asset {
  id: string;
  name: string;
  kind: AssetKind;
  blob: Blob;
  url: string;
  duration: number;
  width: number;
  height: number;
  thumbnail?: string;
  waveform?: number[];
}
export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  muted: boolean;
  hidden: boolean;
  locked: boolean;
}
export interface ClipTransform {
  /** Element center as a percentage of the project canvas. */
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  /** Clockwise rotation in degrees. */
  rotation: number;
}
export interface Clip {
  id: string;
  trackId: string;
  assetId?: string;
  name: string;
  start: number;
  in: number;
  out: number;
  speed: number;
  volume: number;
  opacity: number;
  text?: string;
  fontSize: number;
  color: string;
  linkedId?: string;
  crop: { x: number; y: number; width: number; height: number };
  transform?: ClipTransform;
}
export interface Project {
  name: string;
  tracks: Track[];
  clips: Clip[];
  width: number;
  height: number;
  fps: number;
}
export interface TtsConfig {
  endpoint: string;
  model: string;
  voice: string;
  key: string;
}
export const uid = () => crypto.randomUUID();
export const clipDuration = (clip: Clip) => (clip.out - clip.in) / clip.speed;
export const endOf = (clip: Clip) => clip.start + clipDuration(clip);
export const formatTime = (s: number, frames = false) => {
  s = Math.max(0, s);
  return `${Math.floor(s / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(s % 60)
    .toString()
    .padStart(2, "0")}${
    frames
      ? ":" +
        Math.floor((s % 1) * 30)
          .toString()
          .padStart(2, "0")
      : ""
  }`;
};
export const newProject = (): Project => ({
  name: "未命名项目",
  width: 1920,
  height: 1080,
  fps: 30,
  tracks: [
    {
      id: uid(),
      kind: "subtitle",
      name: "字幕 01",
      muted: false,
      hidden: false,
      locked: false,
    },
    {
      id: uid(),
      kind: "video",
      name: "视频 01",
      muted: false,
      hidden: false,
      locked: false,
    },
    {
      id: uid(),
      kind: "audio",
      name: "音频 01",
      muted: false,
      hidden: false,
      locked: false,
    },
  ],
  clips: [],
});
export function createClip(
  trackId: string,
  asset: Asset | undefined,
  start = 0,
): Clip {
  return {
    id: uid(),
    trackId,
    assetId: asset?.id,
    name: asset?.name ?? "新字幕",
    start,
    in: 0,
    out: asset?.duration ?? 4,
    speed: 1,
    volume: 1,
    opacity: 1,
    fontSize: 52,
    color: "#ffffff",
    crop: { x: 0, y: 0, width: 100, height: 100 },
    transform: { x: 50, y: 50, scaleX: 1, scaleY: 1, rotation: 0 },
  };
}
export function splitClip(clip: Clip, time: number): [Clip, Clip] | null {
  if (time <= clip.start + 0.05 || time >= endOf(clip) - 0.05) return null;
  const sourceTime = clip.in + (time - clip.start) * clip.speed;
  return [
    { ...structuredClone(clip), out: sourceTime },
    { ...structuredClone(clip), id: uid(), in: sourceTime, start: time },
  ];
}
export function srt(clips: Clip[]) {
  return clips
    .filter((c) => c.text?.trim())
    .sort((a, b) => a.start - b.start)
    .map(
      (c, i) =>
        `${i + 1}\n${stamp(c.start)} --> ${stamp(endOf(c))}\n${c.text}\n`,
    )
    .join("\n");
}
function stamp(t: number) {
  const ms = Math.round(t * 1000);
  return `${Math.floor(ms / 3600000)
    .toString()
    .padStart(2, "0")}:${Math.floor((ms / 60000) % 60)
    .toString()
    .padStart(2, "0")}:${Math.floor((ms / 1000) % 60)
    .toString()
    .padStart(2, "0")},${(ms % 1000).toString().padStart(3, "0")}`;
}
