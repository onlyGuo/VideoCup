<script setup lang="ts" vapor>
import { computed, onBeforeUnmount, ref } from "vue";
import Icon from "./Icon.vue";
import { assetTrackKind, assetTrimLimit } from "../lib/types";
import type { Editor } from "../lib/editor";
import type { Clip } from "../lib/types";
import { clipDuration, endOf, formatTime } from "../lib/types";
const { editor: e } = defineProps<{ editor: Editor }>();
const panel = ref<HTMLElement>();
let stopGesture: (() => void) | undefined;

function beginGesture(
  event: PointerEvent,
  onMove: (event: PointerEvent) => void,
) {
  stopGesture?.();
  event.preventDefault();
  window.getSelection()?.removeAllRanges();
  const captureTarget = panel.value!;
  const pointerId = event.pointerId;
  const root = document.documentElement;
  root.classList.add("timeline-pointer-active");

  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    ev.preventDefault();
    onMove(ev);
  };
  const finish = (ev: PointerEvent) => {
    if (ev.pointerId === pointerId) cleanup();
  };
  const cleanup = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
    window.removeEventListener("blur", cleanup);
    captureTarget.removeEventListener("lostpointercapture", finish);
    if (captureTarget.hasPointerCapture(pointerId))
      captureTarget.releasePointerCapture(pointerId);
    root.classList.remove("timeline-pointer-active");
    if (stopGesture === cleanup) stopGesture = undefined;
  };

  stopGesture = cleanup;
  window.addEventListener("pointermove", move, { passive: false });
  window.addEventListener("pointerup", finish);
  window.addEventListener("pointercancel", finish);
  window.addEventListener("blur", cleanup);
  captureTarget.addEventListener("lostpointercapture", finish);
  captureTarget.setPointerCapture(pointerId);
}

onBeforeUnmount(() => stopGesture?.());
const ticks = computed(() =>
  Array.from(
    { length: Math.ceil(e.timelineLength / (e.zoom < 30 ? 10 : 5)) + 1 },
    (_, i) => i * (e.zoom < 30 ? 10 : 5),
  ),
);
const assetOf = (clip: Clip) => e.assets.find((a) => a.id === clip.assetId);
function seek(event: PointerEvent) {
  if (event.button !== 0 || !event.isPrimary || e.busy) return;
  if ((event.target as HTMLElement).closest(".clip")) return;
  const lane = event.currentTarget as HTMLElement;
  const update = (ev: PointerEvent) => {
    e.time = Math.min(
      e.duration || e.timelineLength,
      Math.max(0, (ev.clientX - lane.getBoundingClientRect().left) / e.zoom),
    );
  };
  e.playing = false;
  beginGesture(event, update);
  update(event);
}
function snap(value: number, ignored: string[]) {
  if (!e.snapping) return value;
  const positions = [
    0,
    e.time,
    ...e.project.clips
      .filter((c) => !ignored.includes(c.id))
      .flatMap((c) => [c.start, endOf(c)]),
  ];
  const nearest = positions.reduce(
    (best, p) => (Math.abs(p - value) < Math.abs(best - value) ? p : best),
    Infinity,
  );
  return Math.abs(nearest - value) * e.zoom < 9 ? nearest : value;
}
function drag(
  event: PointerEvent,
  clip: Clip,
  mode: "move" | "left" | "right",
) {
  if (event.button !== 0 || !event.isPrimary || e.busy) return;
  const track = e.project.tracks.find((t) => t.id === clip.trackId)!;
  if (track.locked) return;
  e.selectedId = clip.id;
  e.playing = false;
  const startX = event.clientX;
  const before = {
    start: clip.start,
    in: clip.in,
    out: clip.out,
    trackId: clip.trackId,
  };
  const linked = e.project.clips.find((c) => c.id === clip.linkedId);
  const linkedStart = linked?.start ?? 0;
  if (linked && e.project.tracks.find((t) => t.id === linked.trackId)?.locked)
    return e.notify("关联轨道已锁定，请先解锁");
  if (mode !== "move" && linked)
    return e.notify("语音字幕已关联，请先解除关联再单独裁剪");
  let changed = false;
  const move = (ev: PointerEvent) => {
    if (Math.abs(ev.clientX - startX) < 3 && !changed) return;
    if (!changed) {
      e.checkpoint();
      changed = true;
    }
    const delta = (ev.clientX - startX) / e.zoom;
    if (mode === "move") {
      clip.start = Math.max(
        0,
        snap(before.start + delta, [clip.id, linked?.id ?? ""]),
      );
      const endSnap = snap(clip.start + clipDuration(clip), [
        clip.id,
        linked?.id ?? "",
      ]);
      if (endSnap !== clip.start + clipDuration(clip))
        clip.start = Math.max(0, endSnap - clipDuration(clip));
      if (linked)
        linked.start = Math.max(0, linkedStart + clip.start - before.start);
      const row = document
        .elementFromPoint(ev.clientX, ev.clientY)
        ?.closest("[data-track]") as HTMLElement | null;
      const target = e.project.tracks.find((t) => t.id === row?.dataset.track);
      if (target && target.kind === track.kind && !target.locked)
        clip.trackId = target.id;
    } else if (mode === "left") {
      const proposed = snap(before.start + delta, [clip.id]);
      const newIn = Math.min(
        before.out - 0.1 * clip.speed,
        Math.max(0, before.in + (proposed - before.start) * clip.speed),
      );
      clip.in = newIn;
      clip.start = Math.max(0, before.start + (newIn - before.in) / clip.speed);
      if (clip.start === 0)
        clip.in = Math.max(0, before.in - before.start * clip.speed);
    } else {
      const limit = assetTrimLimit(assetOf(clip));
      const newEnd = snap(
        before.start + (before.out - before.in) / clip.speed + delta,
        [clip.id],
      );
      clip.out = Math.min(
        limit,
        Math.max(
          clip.in + 0.1 * clip.speed,
          clip.in + (newEnd - clip.start) * clip.speed,
        ),
      );
    }
  };
  beginGesture(event, move);
}
function drop(event: DragEvent, trackId: string) {
  const track = e.project.tracks.find((t) => t.id === trackId)!;
  if (track.locked) return;
  const asset = e.assets.find(
    (a) => a.id === event.dataTransfer?.getData("application/videocup-asset"),
  );
  if (!asset) {
    if (event.dataTransfer?.files.length)
      void e.importFiles(event.dataTransfer.files);
    return;
  }
  if (assetTrackKind(asset) !== track.kind)
    return e.notify("请拖到对应的视频或音频轨道");
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  e.putAsset(
    asset,
    Math.max(0, snap((event.clientX - rect.left) / e.zoom, [])),
    trackId,
  );
}
</script>
<template>
  <section
    ref="panel"
    class="timeline-panel"
    @selectstart.prevent
    @dragstart.prevent
  >
    <div class="timeline-toolbar">
      <div class="timeline-title">
        <Icon name="video" :size="15" /><span>时间线</span
        ><span class="tiny-label">SEQUENCE 01</span>
      </div>
      <div class="timeline-tools">
        <button class="icon-button active" title="选择工具 (V)">
          <Icon name="cursor" :size="17" /></button
        ><span class="divider"></span
        ><button
          class="icon-button"
          :disabled="!e.history.length || e.busy"
          title="撤销 (⌘Z)"
          @click="e.undo"
        >
          <Icon name="undo" :size="16" /></button
        ><button
          class="icon-button"
          :disabled="!e.future.length || e.busy"
          title="重做 (⌘⇧Z)"
          @click="e.redo"
        >
          <Icon name="redo" :size="16" /></button
        ><span class="divider"></span
        ><button
          class="icon-button"
          :disabled="!e.selected || e.busy"
          title="在播放头处分割 (⌘B)"
          @click="e.split"
        >
          <Icon name="scissors" :size="17" /></button
        ><button
          class="icon-button"
          :disabled="!e.selected || e.busy"
          title="删除片段 (Delete)"
          @click="e.removeSelected"
        >
          <Icon name="trash" :size="17" /></button
        ><span class="divider"></span
        ><button
          class="icon-button"
          :class="{ accent: e.snapping }"
          title="吸附 (N)"
          @click="e.snapping = !e.snapping"
        >
          <Icon name="magnet" :size="17" />
        </button>
      </div>
      <div class="zoom-control">
        <Icon name="minus" :size="13" /><input
          v-model.number="e.zoom"
          aria-label="时间线缩放"
          type="range"
          min="12"
          max="120"
        /><Icon name="plus" :size="13" /><button
          class="text-button"
          @click="e.zoom = Math.max(12, Math.min(120, 850 / e.timelineLength))"
        >
          适应
        </button>
      </div>
    </div>
    <div class="timeline-scroll">
      <div
        class="timeline-content"
        :style="{ width: `calc(${e.timelineLength * e.zoom}px + 162px)` }"
      >
        <div class="ruler-row">
          <div class="ruler-label mono">{{ formatTime(e.time, true) }}</div>
          <div class="ruler" @pointerdown="seek">
            <span
              v-for="tick in ticks"
              :key="tick"
              :style="{ left: tick * e.zoom + 'px' }"
              >{{ formatTime(tick) }}</span
            >
            <div
              class="ruler-cursor"
              :style="{ left: e.time * e.zoom + 'px' }"
            ></div>
          </div>
        </div>
        <div
          v-for="track in e.project.tracks"
          :key="track.id"
          class="track-row"
          :class="{ locked: track.locked, dimmed: track.hidden }"
          :data-track="track.id"
        >
          <div class="track-label">
            <div class="track-name">
              <span class="track-kind" :class="track.kind"
                ><Icon
                  :name="
                    track.kind === 'subtitle'
                      ? 'text'
                      : track.kind === 'video'
                        ? 'video'
                        : 'music'
                  "
                  :size="14" /></span
              ><span>{{ track.name }}</span>
            </div>
            <div class="track-controls">
              <button
                :class="{ accent: track.hidden }"
                :title="track.hidden ? '显示轨道' : '隐藏轨道（也不参与导出）'"
                @click="e.toggleTrack(track.id, 'hidden')"
              >
                <Icon name="eye" :size="13" /></button
              ><button
                v-if="track.kind !== 'subtitle'"
                :class="{ accent: track.muted }"
                title="切换静音"
                @click="e.toggleTrack(track.id, 'muted')"
              >
                <Icon
                  :name="track.muted ? 'mute' : 'volume'"
                  :size="13"
                /></button
              ><button
                :class="{ accent: track.locked }"
                title="锁定轨道"
                @click="e.toggleTrack(track.id, 'locked')"
              >
                <Icon :name="track.locked ? 'lock' : 'unlock'" :size="12" />
              </button>
            </div>
          </div>
          <div
            class="track-lane"
            :class="track.kind"
            :style="{ '--grid-size': e.zoom * 5 + 'px' }"
            @pointerdown="seek"
            @dragover.prevent
            @drop.prevent="drop($event, track.id)"
          >
            <div
              v-for="clip in e.project.clips.filter(
                (c) => c.trackId === track.id,
              )"
              :key="clip.id"
              class="clip"
              :class="[track.kind, { selected: clip.id === e.selectedId }]"
              :style="{
                left: clip.start * e.zoom + 'px',
                width: Math.max(12, clipDuration(clip) * e.zoom) + 'px',
              }"
              @pointerdown.stop="drag($event, clip, 'move')"
            >
              <div
                v-if="assetOf(clip)?.thumbnail"
                class="clip-filmstrip"
                :style="{ backgroundImage: `url(${assetOf(clip)?.thumbnail})` }"
              ></div>
              <div v-if="track.kind === 'audio'" class="clip-waveform">
                <i
                  v-for="(h, i) in assetOf(clip)?.waveform ||
                  Array(40).fill(0.2)"
                  :key="i"
                  :style="{ height: Math.max(3, h * 80) + '%' }"
                ></i>
              </div>
              <div class="clip-caption">
                <Icon
                  v-if="track.kind === 'subtitle'"
                  name="text"
                  :size="12"
                /><Icon
                  v-else-if="clip.linkedId"
                  name="link"
                  :size="12"
                /><span>{{ clip.text ?? clip.name }}</span
                ><b v-if="clip.speed !== 1">{{ clip.speed }}×</b>
              </div>
              <span
                class="trim-handle left"
                @pointerdown.stop="drag($event, clip, 'left')"
              ></span
              ><span
                class="trim-handle right"
                @pointerdown.stop="drag($event, clip, 'right')"
              ></span>
            </div>
            <span
              v-if="!e.project.clips.some((c) => c.trackId === track.id)"
              class="empty-track"
              >{{
                track.kind === "subtitle"
                  ? "添加字幕，让故事被听见"
                  : track.kind === "video"
                    ? "将视频素材拖到这里"
                    : "将音乐、原声或 AI 配音拖到这里"
              }}</span
            >
          </div>
        </div>
        <div class="add-track-row">
          <details class="track-menu">
            <summary><Icon name="plus" :size="14" />添加轨道</summary>
            <div>
              <button @click="e.addTrack('video')">
                <Icon name="video" :size="14" />视频轨道</button
              ><button @click="e.addTrack('audio')">
                <Icon name="music" :size="14" />音频轨道</button
              ><button @click="e.addTrack('subtitle')">
                <Icon name="text" :size="14" />字幕轨道
              </button>
            </div>
          </details>
          <span>拖动片段调整位置 · 拖动边缘裁剪</span>
        </div>
        <div
          class="playhead"
          :style="{ left: 162 + e.time * e.zoom + 'px' }"
        ></div>
      </div>
    </div>
    <div class="timeline-footer">
      <span><i class="status-dot"></i>所有媒体均在本地处理</span
      ><span
        >{{ e.project.tracks.length }} 条轨道<span class="footer-dot">·</span
        >{{ e.project.clips.length }} 个片段<span class="footer-dot">·</span
        >总时长 {{ formatTime(e.duration, true) }}</span
      >
    </div>
  </section>
</template>
