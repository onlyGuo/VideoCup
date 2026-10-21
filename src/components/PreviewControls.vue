<script setup lang="ts" vapor>
import { computed, onBeforeUnmount, ref } from "vue";
import type { Editor } from "../lib/editor";
import type { Clip } from "../lib/types";
import { endOf } from "../lib/types";
import { normalizeTransform, TRANSFORM_LIMITS } from "../lib/transform";
import {
  containsPoint,
  getSelectionGeometry,
  rotatePoint,
  transformAtSelectionCenter,
} from "../lib/selection";
import Icon from "./Icon.vue";
const { editor: e } = defineProps<{ editor: Editor }>();
const overlay = ref<HTMLElement>();
const active = computed(() =>
  e.project.tracks.flatMap((track) =>
    !track.hidden && track.kind !== "audio"
      ? e.project.clips
          .filter(
            (c) =>
              c.trackId === track.id && e.time >= c.start && e.time < endOf(c),
          )
          .reverse()
      : [],
  ),
);
const selected = computed(() =>
  active.value.find((c) => c.id === e.selectedId),
);
const box = computed(() =>
  selected.value ? geometry(selected.value) : undefined,
);
const boxStyle = computed(() => {
  const b = box.value;
  return b
    ? {
        left: (b.cx / e.project.width) * 100 + "%",
        top: (b.cy / e.project.height) * 100 + "%",
        width: (b.width / e.project.width) * 100 + "%",
        height: (b.height / e.project.height) * 100 + "%",
        transform: `translate(-50%,-50%) rotate(${b.rotation}deg)`,
      }
    : {};
});
const corners = [
  { x: -1, y: -1, name: "左上", key: "nw" },
  { x: 1, y: -1, name: "右上", key: "ne" },
  { x: -1, y: 1, name: "左下", key: "sw" },
  { x: 1, y: 1, name: "右下", key: "se" },
];
let stopGesture: (() => void) | undefined;
function geometry(clip: Clip) {
  return getSelectionGeometry(
    clip,
    e.assets.find((a) => a.id === clip.assetId),
    e.project,
  );
}
function point(event: PointerEvent) {
  const rect = overlay.value!.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * e.project.width,
    y: ((event.clientY - rect.top) / rect.height) * e.project.height,
  };
}
function selectAt(event: PointerEvent) {
  if (event.button !== 0 || !event.isPrimary || e.busy) return;
  const p = point(event);
  const layers = [
    ...active.value.filter((c) => c.text !== undefined),
    ...active.value.filter((c) => c.text === undefined),
  ];
  const clip = layers.find((c) => containsPoint(geometry(c), p));
  if (!clip) {
    e.selectedId = "";
    return;
  }
  e.selectedId = clip.id;
  begin(event, "move", clip);
}
function begin(
  event: PointerEvent,
  mode: "move" | "resize" | "rotate",
  clip = selected.value,
  corner = { x: 1, y: 1 },
) {
  if (event.button !== 0 || !event.isPrimary || !clip || e.busy) return;
  if (e.project.tracks.find((t) => t.id === clip.trackId)?.locked) {
    e.notify("轨道已锁定，请先解锁");
    return;
  }
  event.preventDefault();
  stopGesture?.();
  e.playing = false;
  const root = overlay.value!;
  const id = event.pointerId;
  const t = normalizeTransform(clip.transform),
    b = geometry(clip),
    start = point(event);
  const fromAngle = Math.atan2(start.y - b.cy, start.x - b.cx);
  const opposite = rotatePoint(
    (-corner.x * b.width) / 2,
    (-corner.y * b.height) / 2,
    b.rotation,
  );
  const anchor = { x: b.cx + opposite.x, y: b.cy + opposite.y };
  let changed = false;
  document.documentElement.classList.add("preview-pointer-active");
  window.getSelection()?.removeAllRanges();
  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return;
    ev.preventDefault();
    const p = point(ev);
    if (!changed && Math.hypot(p.x - start.x, p.y - start.y) < 2) return;
    if (!changed) {
      e.checkpoint();
      changed = true;
    }
    if (mode === "move")
      clip.transform = normalizeTransform({
        ...t,
        x: t.x + ((p.x - start.x) / e.project.width) * 100,
        y: t.y + ((p.y - start.y) / e.project.height) * 100,
      });
    else if (mode === "rotate") {
      let angle =
        t.rotation +
        ((Math.atan2(p.y - b.cy, p.x - b.cx) - fromAngle) * 180) / Math.PI;
      if (ev.shiftKey) angle = Math.round(angle / 15) * 15;
      clip.transform = transformAtSelectionCenter(
        { ...t, rotation: angle },
        { x: b.cx, y: b.cy },
        { x: b.offsetX, y: b.offsetY },
        e.project,
      );
    } else {
      const local = rotatePoint(p.x - anchor.x, p.y - anchor.y, -b.rotation);
      const rawX = (corner.x * local.x) / b.width,
        rawY = (corner.y * local.y) / b.height;
      let sx = Math.max(
        TRANSFORM_LIMITS.minScale,
        Math.min(TRANSFORM_LIMITS.maxScale, t.scaleX * rawX),
      );
      let sy = Math.max(
        TRANSFORM_LIMITS.minScale,
        Math.min(TRANSFORM_LIMITS.maxScale, t.scaleY * rawY),
      );
      if (ev.shiftKey) {
        const ratio = Math.max(rawX, rawY);
        sx = Math.max(0.05, Math.min(4, t.scaleX * ratio));
        sy = Math.max(0.05, Math.min(4, t.scaleY * ratio));
      }
      const width = (b.width * sx) / t.scaleX,
        height = (b.height * sy) / t.scaleY;
      const delta = rotatePoint(
        (corner.x * width) / 2,
        (corner.y * height) / 2,
        b.rotation,
      );
      clip.transform = transformAtSelectionCenter(
        { ...t, scaleX: sx, scaleY: sy },
        { x: anchor.x + delta.x, y: anchor.y + delta.y },
        { x: b.offsetX, y: b.offsetY },
        e.project,
      );
    }
  };
  const end = (ev: PointerEvent) => {
    if (ev.pointerId === id) cleanup();
  };
  const cleanup = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
    window.removeEventListener("blur", cleanup);
    root.removeEventListener("lostpointercapture", end);
    if (root.hasPointerCapture(id)) root.releasePointerCapture(id);
    document.documentElement.classList.remove("preview-pointer-active");
    if (stopGesture === cleanup) stopGesture = undefined;
  };
  stopGesture = cleanup;
  window.addEventListener("pointermove", move, { passive: false });
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
  window.addEventListener("blur", cleanup);
  root.addEventListener("lostpointercapture", end);
  root.setPointerCapture(id);
}
onBeforeUnmount(() => stopGesture?.());
</script>
<template>
  <div
    ref="overlay"
    class="preview-interaction"
    aria-label="预览画布元素编辑"
    @pointerdown="selectAt"
    @selectstart.prevent
    @dragstart.prevent
  >
    <div
      v-if="box"
      class="preview-selection"
      :style="boxStyle"
      :class="{ locked: e.selectedTrack?.locked }"
    >
      <span class="selection-name">{{
        selected?.text !== undefined ? "字幕" : selected?.name
      }}</span>
      <template v-if="!e.selectedTrack?.locked && !e.busy"
        ><button
          v-for="corner in corners"
          :key="corner.key"
          type="button"
          class="resize-handle"
          :class="corner.key"
          :aria-label="corner.name + '缩放'"
          :title="corner.name + '缩放，Shift 保持比例'"
          @pointerdown.stop="begin($event, 'resize', selected, corner)"
        ></button
        ><span class="rotation-stem"></span
        ><button
          type="button"
          class="rotation-handle"
          aria-label="旋转元素"
          title="拖动旋转，Shift 每次旋转 15°"
          @pointerdown.stop="begin($event, 'rotate')"
        >
          <Icon name="reset" :size="11" /></button
      ></template>
    </div>
    <div class="preview-edit-hint" v-if="selected">
      拖动移动 · 角点缩放 · 上方手柄旋转
    </div>
  </div>
</template>
