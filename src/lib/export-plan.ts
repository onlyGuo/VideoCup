import type { Asset, Clip, Project, TrackKind } from "./types.ts";
import { endOf } from "./types.ts";
import { getVisualFilter } from "./transform.ts";

export const exportNumber = (value: number) =>
  Number(value.toFixed(7)).toString();
export interface ExportOptions {
  width: number;
  height: number;
  audioOnly: boolean;
  subtitles: boolean;
  quality: string;
}
/** Browser defaults remain bounded; native FFmpeg may choose hardware encoders and automatic threading. */
export interface ExportExecutionProfile {
  decoderThreads?: number;
  encoderThreads?: number;
  filterThreads?: number;
  videoEncoder?: "libx264" | "h264_videotoolbox";
  encoderArgs?: string[];
}
export interface ExportSource {
  name: string;
  hasAudio: boolean;
  asset?: Asset;
}
export interface ExportItem {
  clip: Clip;
  muted: boolean;
  kind: TrackKind;
}
export interface ExportSegment {
  start: number;
  end: number;
  frames: number;
}

export function tempo(speed: number) {
  const filters: string[] = [];
  while (speed > 2) {
    filters.push("atempo=2");
    speed /= 2;
  }
  while (speed < 0.5) {
    filters.push("atempo=0.5");
    speed /= 0.5;
  }
  filters.push(`atempo=${exportNumber(speed)}`);
  return filters.join(",");
}

/** Render only a short timeline window at once, rather than opening every clip's decoder. */
export function planExportSegments(
  project: Project,
  seconds = 12,
): ExportSegment[] {
  const duration = Math.max(0, ...project.clips.map(endOf));
  const totalFrames = Math.ceil(duration * project.fps - 1e-7);
  const chunkFrames = Math.max(1, Math.round(seconds * project.fps));
  const videoTracks = new Set(
    project.tracks
      .filter((track) => track.kind === "video" && !track.hidden)
      .map((track) => track.id),
  );
  const boundaries = new Set([0, totalFrames]);
  // A cut in a long source should close its previous decoder before opening the next one.
  for (const clip of project.clips) {
    if (!videoTracks.has(clip.trackId)) continue;
    for (const time of [clip.start, endOf(clip)])
      boundaries.add(
        Math.max(
          0,
          Math.min(totalFrames, Math.ceil(time * project.fps - 1e-7)),
        ),
      );
  }
  const cuts = [...boundaries].sort((a, b) => a - b);
  const result: ExportSegment[] = [];
  for (let cut = 0; cut < cuts.length - 1; cut++) {
    for (let frame = cuts[cut]!; frame < cuts[cut + 1]!; frame += chunkFrames) {
      const frames = Math.min(chunkFrames, cuts[cut + 1]! - frame);
      result.push({
        start: frame / project.fps,
        end: (frame + frames) / project.fps,
        frames,
      });
    }
  }
  return result;
}

export function visibleExportItems(project: Project): ExportItem[] {
  const items: ExportItem[] = [];
  for (const track of [...project.tracks].reverse()) {
    if (track.hidden) continue;
    for (const clip of project.clips.filter(
      (clip) => clip.trackId === track.id,
    )) {
      items.push({ clip, muted: track.muted, kind: track.kind });
    }
  }
  return items.sort(
    (a, b) => Number(a.kind === "subtitle") - Number(b.kind === "subtitle"),
  );
}

/** All timestamps in this graph are local to this segment; source trims remain in source seconds. */
export function buildExportSegment(
  project: Project,
  options: ExportOptions,
  segment: ExportSegment,
  items: ExportItem[],
  sources: Map<string, ExportSource>,
  subtitleNames: Map<string, string>,
  videoOutput: string,
  audioOutput: string,
  profile: ExportExecutionProfile = {},
) {
  const n = exportNumber;
  const duration = segment.end - segment.start;
  const args: string[] = [];
  const filters: string[] = [];
  let index = 0;
  let video = "vbase";
  if (!options.audioOnly) {
    args.push(
      "-f",
      "lavfi",
      "-i",
      `color=c=0x090b0c:s=${options.width}x${options.height}:r=${project.fps}:d=${n(duration)}`,
    );
    filters.push(`[${index++}:v]format=yuv420p[vbase]`);
  }
  args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
  filters.push(
    `[${index++}:a]atrim=duration=${n(duration)},asetpts=PTS-STARTPTS[abase]`,
  );
  const audio = ["abase"];
  for (const { clip, kind, muted } of items) {
    const start = Math.max(segment.start, clip.start);
    const end = Math.min(segment.end, endOf(clip));
    if (end <= start + 1e-7) continue;
    const localStart = start - segment.start;
    const localEnd = end - segment.start;
    const tag = index;
    if (kind === "subtitle") {
      const name = subtitleNames.get(clip.id);
      if (options.audioOnly || !options.subtitles || !name) continue;
      args.push(
        "-loop",
        "1",
        "-framerate",
        String(project.fps),
        "-t",
        n(duration),
        "-i",
        name,
      );
      const visual = getVisualFilter(clip, undefined, options);
      filters.push(
        `[${index++}:v]trim=end_frame=1,${visual.filter},loop=loop=-1:size=1:start=0,setpts=N/(${project.fps}*TB),trim=duration=${n(duration)}[s${tag}]`,
        `[${video}][s${tag}]overlay=x=${visual.x}:y=${visual.y}:format=yuv420:eof_action=repeat:repeatlast=1:enable='gte(t,${n(localStart)})*lt(t,${n(localEnd)})'[v${tag}]`,
      );
      video = `v${tag}`;
      continue;
    }
    const source = sources.get(clip.assetId ?? "");
    if (!source) throw new Error(`找不到素材：${clip.name}`);
    const isImage = source.asset?.kind === "image";
    const needsVideo = kind === "video" && !options.audioOnly;
    const needsAudio = !isImage && source.hasAudio && !muted && clip.volume > 0;
    if (!needsVideo && !needsAudio) continue;
    const sourceStart = clip.in + (start - clip.start) * clip.speed;
    // Include the preceding source frame for accurate VFR/CFR sampling at a seek,
    // plus one-frame lookahead at the end. Precise visibility is enforced below.
    const seek =
      needsVideo && !isImage ? Math.max(0, sourceStart - 1) : sourceStart;
    const preroll = sourceStart - seek;
    if (isImage) {
      args.push(
        "-loop",
        "1",
        "-framerate",
        String(project.fps),
        "-t",
        n(duration),
      );
    } else {
      args.push(
        "-ss",
        n(seek),
        "-t",
        n((end - start) * clip.speed + preroll + (needsVideo ? 1 : 0)),
      );
    }
    args.push("-threads", String(profile.decoderThreads ?? 1));
    if (!needsVideo) args.push("-vn");
    if (!needsAudio) args.push("-an");
    args.push("-i", source.name);
    if (needsVideo) {
      const visual = getVisualFilter(clip, source.asset, options, {
        opaque: !isImage,
      });
      const timestamps = isImage
        ? `trim=end_frame=1,${visual.filter},loop=loop=-1:size=1:start=0,settb=AVTB,setpts=N/(${project.fps}*TB)`
        : `settb=AVTB,setpts=(PTS-${n(preroll)}/TB)/${n(clip.speed)},fps=${project.fps}:start_time=0:round=near:eof_action=pass,${visual.filter}`;
      filters.push(
        `[${index}:v]${timestamps},trim=duration=${n(end - start)},tpad=stop_mode=clone:stop_duration=${n(duration)},setpts=PTS+${n(localStart)}/TB[c${tag}]`,
        `[${video}][c${tag}]overlay=x=${visual.x}:y=${visual.y}:format=yuv420:eof_action=repeat:repeatlast=1:enable='gte(t,${n(localStart)})*lt(t,${n(localEnd)})'[v${tag}]`,
      );
      video = `v${tag}`;
    }
    if (needsAudio) {
      filters.push(
        `[${index}:a]atrim=start=${n(preroll)}:duration=${n((end - start) * clip.speed)},asetpts=PTS-STARTPTS,${tempo(clip.speed)},atrim=duration=${n(end - start)},volume=${n(clip.volume)},aresample=48000,adelay=${Math.round(localStart * 48000)}S:all=1[a${tag}]`,
      );
      audio.push(`a${tag}`);
    }
    index++;
  }
  // Compensate limiter lookahead before writing exact-length, lossless audio segments.
  filters.push(
    `${audio.map((name) => `[${name}]`).join("")}amix=inputs=${audio.length}:duration=longest:normalize=0,alimiter=limit=0.95:latency=1,atrim=duration=${n(duration)},asetpts=PTS-STARTPTS[aout]`,
  );
  if (!options.audioOnly) filters.push(`[${video}]format=yuv420p[vout]`);
  args.push(
    "-filter_complex_threads",
    String(profile.filterThreads ?? 1),
    "-filter_complex",
    filters.join(";"),
  );
  if (!options.audioOnly) {
    args.push(
      "-map",
      "[vout]",
      "-an",
      "-c:v",
      profile.videoEncoder ?? "libx264",
      "-threads",
      String(profile.encoderThreads ?? 1),
      ...(profile.encoderArgs ??
        (profile.videoEncoder === "h264_videotoolbox"
          ? [
              "-q:v",
              options.quality === "high" ? "70" : "60",
              "-allow_sw",
              "1",
              "-realtime",
              "1",
              "-bf",
              "0",
            ]
          : [
              "-preset",
              "ultrafast",
              "-crf",
              options.quality === "high" ? "18" : "23",
            ])),
      "-r",
      String(project.fps),
      "-frames:v",
      String(segment.frames),
      "-video_track_timescale",
      "90000",
      "-y",
      videoOutput,
    );
  }
  args.push(
    "-map",
    "[aout]",
    "-vn",
    "-c:a",
    "flac",
    "-sample_fmt",
    "s16",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-t",
    n(duration),
    "-y",
    audioOutput,
  );
  return args;
}

export function concatManifest(names: string[], segments: ExportSegment[]) {
  return names
    .map(
      (name, index) =>
        `file '${name}'\nduration ${exportNumber(segments[index]!.end - segments[index]!.start)}\n`,
    )
    .join("");
}

export function buildExportJoin(
  options: ExportOptions,
  duration: number,
  output: string,
) {
  const args = options.audioOnly
    ? []
    : ["-f", "concat", "-safe", "0", "-i", "video-segments.txt"];
  args.push("-f", "concat", "-safe", "0", "-i", "audio-segments.txt");
  if (!options.audioOnly) args.push("-map", "0:v:0", "-c:v", "copy");
  args.push(
    "-map",
    options.audioOnly ? "0:a:0" : "1:a:0",
    "-c:a",
    options.audioOnly ? "libmp3lame" : "aac",
    "-b:a",
    "192k",
  );
  if (!options.audioOnly) args.push("-movflags", "+faststart");
  args.push("-t", exportNumber(duration), "-y", output);
  return args;
}
