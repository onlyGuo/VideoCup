<script setup lang="ts" vapor>
import { computed } from "vue";
import Icon from "./Icon.vue";
import type { Editor } from "../lib/editor";
import { assetTrimLimit, clipDuration, createClip } from "../lib/types";
import { normalizeTransform } from "../lib/transform";
import type { ClipTransform } from "../lib/types";
const { editor: e } = defineProps<{ editor: Editor }>();
const emptyClip = createClip("", undefined);
const viewedClip = computed(() => e.selected ?? emptyClip);
const transform = computed(() =>
  normalizeTransform(viewedClip.value.transform),
);
function setTransform(event: Event, field: keyof ClipTransform) {
  const n = Number((event.target as HTMLInputElement).value);
  if (Number.isFinite(n))
    e.updateClip({
      transform: normalizeTransform({
        ...transform.value,
        [field]: field === "scaleX" || field === "scaleY" ? n / 100 : n,
      }),
    });
}
const tab = computed(() => e.selectedTrack?.kind);
const isImage = computed(() => e.selectedAsset?.kind === "image");
function value(event: Event) {
  return Number((event.target as HTMLInputElement).value);
}
function trim(event: Event, field: "in" | "out") {
  if (!e.selected) return;
  if (e.selected.linkedId) return e.notify("请先解除关联再单独裁剪");
  const c = e.selected;
  const asset = e.assets.find((a) => a.id === c.assetId);
  const n = value(event);
  e.updateClip(
    field === "in"
      ? { in: Math.min(c.out - 0.1 * c.speed, Math.max(0, n)) }
      : {
          out: Math.max(
            c.in + 0.1 * c.speed,
            Math.min(assetTrimLimit(asset), n),
          ),
        },
  );
}
function crop(event: Event, field: "x" | "y" | "width" | "height") {
  if (!e.selected) return;
  const c = { ...e.selected.crop };
  c[field] = Math.max(
    field === "width" || field === "height" ? 1 : 0,
    Math.min(100, value(event)),
  );
  c.width = Math.min(c.width, 100 - c.x);
  c.height = Math.min(c.height, 100 - c.y);
  if (c.width < 1) c.x = 99;
  if (c.height < 1) c.y = 99;
  c.width = Math.max(1, c.width);
  c.height = Math.max(1, c.height);
  e.updateClip({ crop: c });
}
function unlink() {
  const c = e.selected;
  if (!c) return;
  e.checkpoint();
  const linked = e.project.clips.find((x) => x.id === c.linkedId);
  if (linked) linked.linkedId = undefined;
  c.linkedId = undefined;
}
</script>
<template>
  <aside class="inspector panel">
    <div class="panel-heading">
      <span>属性</span><Icon name="settings" :size="16" />
    </div>
    <template v-if="e.selected">
      <div class="inspector-tabs">
        <span class="active">{{
          tab === "subtitle"
            ? "字幕"
            : tab === "audio"
              ? "音频"
              : isImage
                ? "图片"
                : "视频"
        }}</span
        ><span class="muted">片段设置</span>
      </div>
      <div
        class="inspector-scroll"
        :class="{ readonly: e.selectedTrack?.locked || e.busy }"
      >
        <div class="property-section">
          <div class="property-title">
            {{ tab === "subtitle" ? "字幕内容" : "片段信息"
            }}<span class="tag">{{
              tab === "subtitle"
                ? "TEXT"
                : tab === "audio"
                  ? "AUDIO"
                  : isImage
                    ? "IMAGE"
                    : "VIDEO"
            }}</span>
          </div>
          <textarea
            v-if="tab === 'subtitle'"
            class="subtitle-input"
            aria-label="字幕文本"
            :value="viewedClip.text"
            @change="
              e.updateClip({
                text: ($event.target as HTMLTextAreaElement).value,
              })
            "
          ></textarea>
          <div v-else class="selected-file">
            <Icon
              :name="isImage ? 'image' : tab === 'video' ? 'video' : 'music'"
              :size="22"
            />
            <div>
              <b>{{ viewedClip.name }}</b
              ><small
                >{{ clipDuration(viewedClip).toFixed(2) }} 秒<span
                  class="footer-dot"
                  >·</span
                >{{
                  isImage
                    ? "静态图片"
                    : tab === "video"
                      ? "视频片段"
                      : "音频片段"
                }}</small
              >
            </div>
          </div>
          <label class="property-row"
            ><span>时间线位置</span>
            <div class="input-unit">
              <input
                type="number"
                aria-label="时间线位置"
                min="0"
                step="0.1"
                :value="viewedClip.start.toFixed(2)"
                @change="e.updateClip({ start: Math.max(0, value($event)) })"
              /><span>s</span>
            </div></label
          >
          <label v-if="isImage" class="property-row"
            ><span>显示时长</span>
            <div class="input-unit">
              <input
                type="number"
                aria-label="图片显示时长"
                min="0.1"
                max="3600"
                step="0.1"
                :value="clipDuration(viewedClip).toFixed(2)"
                @change="
                  e.updateClip({
                    out:
                      viewedClip.in +
                      Math.min(3600, Math.max(0.1, value($event))) *
                        viewedClip.speed,
                  })
                "
              /><span>s</span>
            </div>
          </label>
          <div v-else class="two-fields">
            <label
              >素材入点
              <div class="input-unit">
                <input
                  aria-label="素材入点"
                  type="number"
                  step="0.1"
                  min="0"
                  :value="viewedClip.in.toFixed(2)"
                  @change="trim($event, 'in')"
                /><span>s</span>
              </div></label
            ><label
              >素材出点
              <div class="input-unit">
                <input
                  aria-label="素材出点"
                  type="number"
                  step="0.1"
                  :value="viewedClip.out.toFixed(2)"
                  @change="trim($event, 'out')"
                /><span>s</span>
              </div></label
            >
          </div>
        </div>
        <div v-if="tab === 'subtitle'" class="property-section">
          <div class="property-title">文字样式</div>
          <label class="property-row"
            ><span>字号</span>
            <div class="input-unit">
              <input
                type="number"
                aria-label="字幕字号"
                min="16"
                max="160"
                :value="viewedClip.fontSize"
                @change="
                  e.updateClip({
                    fontSize: Math.min(160, Math.max(16, value($event))),
                  })
                "
              /><span>px</span>
            </div></label
          ><label class="property-row"
            ><span>文字颜色</span
            ><input
              type="color"
              aria-label="字幕颜色"
              :value="viewedClip.color"
              @change="
                e.updateClip({
                  color: ($event.target as HTMLInputElement).value,
                })
              "
          /></label>
        </div>
        <div v-if="tab !== 'audio'" class="property-section">
          <div class="property-title">
            位置与变换<button
              class="icon-button"
              title="重置元素变换"
              @click="e.updateClip({ transform: normalizeTransform() })"
            >
              <Icon name="reset" :size="14" />
            </button>
          </div>
          <div class="two-fields">
            <label
              >X 中心
              <div class="input-unit">
                <input
                  aria-label="元素 X 位置"
                  type="number"
                  min="-200"
                  max="300"
                  step="0.1"
                  :value="Number(transform.x.toFixed(2))"
                  @change="setTransform($event, 'x')"
                /><span>%</span>
              </div></label
            >
            <label
              >Y 中心
              <div class="input-unit">
                <input
                  aria-label="元素 Y 位置"
                  type="number"
                  min="-200"
                  max="300"
                  step="0.1"
                  :value="Number(transform.y.toFixed(2))"
                  @change="setTransform($event, 'y')"
                /><span>%</span>
              </div></label
            >
            <label
              >宽度缩放
              <div class="input-unit">
                <input
                  aria-label="元素宽度缩放"
                  type="number"
                  min="5"
                  max="400"
                  :value="Number((transform.scaleX * 100).toFixed(1))"
                  @change="setTransform($event, 'scaleX')"
                /><span>%</span>
              </div></label
            >
            <label
              >高度缩放
              <div class="input-unit">
                <input
                  aria-label="元素高度缩放"
                  type="number"
                  min="5"
                  max="400"
                  :value="Number((transform.scaleY * 100).toFixed(1))"
                  @change="setTransform($event, 'scaleY')"
                /><span>%</span>
              </div></label
            >
          </div>
          <label class="property-row"
            ><span>旋转</span>
            <div class="input-unit">
              <input
                aria-label="元素旋转"
                type="number"
                min="-180"
                max="180"
                step="1"
                :value="Number(transform.rotation.toFixed(1))"
                @change="setTransform($event, 'rotation')"
              /><span>°</span>
            </div></label
          >
          <p class="transform-tip">也可直接拖动预览画面中的元素和控制柄。</p>
        </div>
        <div v-if="!isImage" class="property-section">
          <div class="property-title">
            播放速度<span class="mono muted">{{ viewedClip.speed }}×</span>
          </div>
          <div class="speed-options">
            <button
              v-for="speed in [0.5, 1, 1.5, 2, 4]"
              :key="speed"
              :class="{ active: viewedClip.speed === speed }"
              @click="e.updateClip({ speed })"
            >
              {{ speed }}×
            </button>
          </div>
          <label class="property-row"
            ><span>自定义速度</span>
            <div class="input-unit">
              <input
                type="number"
                aria-label="播放速度"
                min="0.25"
                max="4"
                step="0.25"
                :value="viewedClip.speed"
                @change="
                  e.updateClip({
                    speed: Math.min(4, Math.max(0.25, value($event))),
                  })
                "
              /><span>×</span>
            </div></label
          >
        </div>
        <div v-if="tab === 'video'" class="property-section">
          <div class="property-title">
            画面裁剪<button
              class="icon-button"
              title="重置裁剪"
              @click="
                e.updateClip({ crop: { x: 0, y: 0, width: 100, height: 100 } })
              "
            >
              <Icon name="reset" :size="14" />
            </button>
          </div>
          <div class="two-fields">
            <label
              v-for="(label, key) in {
                x: 'X 位置',
                y: 'Y 位置',
                width: '宽度',
                height: '高度',
              }"
              :key="key"
              >{{ label }}
              <div class="input-unit">
                <input
                  :aria-label="label"
                  type="number"
                  min="0"
                  max="100"
                  :value="viewedClip.crop[key]"
                  @change="crop($event, key)"
                /><span>%</span>
              </div></label
            >
          </div>
        </div>
        <div v-if="tab !== 'subtitle' && !isImage" class="property-section">
          <div class="property-title">
            声音<span class="mono muted"
              >{{ Math.round(viewedClip.volume * 100) }}%</span
            >
          </div>
          <div class="range-row">
            <Icon
              :name="viewedClip.volume ? 'volume' : 'mute'"
              :size="16"
            /><input
              type="range"
              aria-label="片段音量"
              min="0"
              max="1"
              step="0.01"
              :value="viewedClip.volume"
              @change="e.updateClip({ volume: value($event) })"
            />
          </div>
          <button
            v-if="tab === 'video'"
            class="secondary-button full"
            @click="e.separate"
            :disabled="e.busy"
          >
            <Icon name="unlink" :size="15" />分离音轨
          </button>
          <button
            v-if="tab === 'video'"
            class="text-button full"
            :disabled="e.busy"
            @click="e.repairPreview()"
          >
            <Icon name="reset" :size="13" />修复黑屏 / 转换兼容格式
          </button>
        </div>
        <div v-if="tab !== 'audio'" class="property-section">
          <div class="property-title">
            不透明度<span class="mono muted"
              >{{ Math.round(viewedClip.opacity * 100) }}%</span
            >
          </div>
          <input
            type="range"
            aria-label="不透明度"
            min="0"
            max="1"
            step="0.01"
            :value="viewedClip.opacity"
            @change="e.updateClip({ opacity: value($event) })"
          />
        </div>
        <div v-if="tab === 'subtitle'" class="property-section ai-section">
          <div class="property-title">
            <span><Icon name="sparkles" :size="15" />AI 语音字幕</span
            ><span class="ai-tag">AI</span>
          </div>
          <p>将文字变成声音，字幕与配音自动对齐。</p>
          <button
            class="primary-button full"
            :disabled="e.voiceBusy || e.busy || !viewedClip.text?.trim()"
            @click="e.generateVoice"
          >
            <Icon name="sparkles" :size="15" />{{
              e.voiceBusy
                ? "正在生成配音…"
                : viewedClip.linkedId
                  ? "重新生成配音"
                  : "生成 AI 配音"
            }}</button
          ><button class="text-button full" @click="e.modal = 'settings'">
            配置配音服务<Icon name="chevron" :size="13" />
          </button>
        </div>
        <div v-if="viewedClip.linkedId" class="property-section">
          <button class="secondary-button full" @click="unlink">
            <Icon name="unlink" :size="14" />解除字幕与语音关联
          </button>
        </div>
      </div>
      <div v-if="e.selectedTrack?.locked" class="locked-message">
        <Icon name="lock" :size="14" />轨道已锁定，请先在时间线解锁
      </div>
    </template>
    <template v-else
      ><div class="inspector-tabs">
        <span class="active">项目</span><span class="muted">画布设置</span>
      </div>
      <div class="property-section">
        <div class="property-title">
          序列设置<span class="tag">SEQUENCE</span>
        </div>
        <label class="field-label"
          >项目名称<input
            v-model="e.project.name"
            aria-label="项目名称"
            maxlength="80" /></label
        ><label class="field-label"
          >画布比例<select
            aria-label="画布比例"
            :value="
              e.project.width / e.project.height > 1
                ? 'landscape'
                : e.project.width === e.project.height
                  ? 'square'
                  : 'portrait'
            "
            @change="
              e.checkpoint();
              Object.assign(
                e.project,
                ($event.target as HTMLSelectElement).value === 'landscape'
                  ? { width: 1920, height: 1080 }
                  : ($event.target as HTMLSelectElement).value === 'square'
                    ? { width: 1080, height: 1080 }
                    : { width: 1080, height: 1920 },
              );
            "
          >
            <option value="landscape">16:9 · 横屏</option>
            <option value="portrait">9:16 · 竖屏</option>
            <option value="square">1:1 · 方形</option>
          </select></label
        ><label class="property-row"
          ><span>帧率</span
          ><span class="value-pill">{{ e.project.fps }} fps</span></label
        ><label class="property-row"
          ><span>分辨率</span
          ><span class="mono muted"
            >{{ e.project.width }} × {{ e.project.height }}</span
          ></label
        >
      </div>
      <div class="inspector-empty">
        <div class="outline-icon"><Icon name="cursor" :size="23" /></div>
        <b>让每一帧恰到好处</b>
        <p>选择时间线上的片段<br />调整裁剪、速度与声音</p>
      </div>
      <div class="keyboard-hints">
        <span>快捷操作</span>
        <div>播放 / 暂停<kbd>Space</kbd></div>
        <div>分割片段<kbd>⌘ B</kbd></div>
        <div>撤销操作<kbd>⌘ Z</kbd></div>
      </div></template
    >
  </aside>
</template>
