<script setup lang="ts" vapor>
import {
  computed,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from "vue";
import Icon from "./components/Icon.vue";
import Timeline from "./components/Timeline.vue";
import Inspector from "./components/Inspector.vue";
import TtsSettings from "./components/TtsSettings.vue";
import PreviewControls from "./components/PreviewControls.vue";
import { useEditor } from "./lib/editor";
import { formatTime, srt } from "./lib/types";
import { Preview } from "./lib/preview";
import { download } from "./lib/media";
const e = reactive(useEditor());
const input = ref<HTMLInputElement>();
const projectInput = ref<HTMLInputElement>();
const canvas = ref<HTMLCanvasElement>();
const stage = ref<HTMLElement>();
const dragging = ref(false);
const inspectorOpen = ref(false);
let preview: Preview | undefined;
let frame = 0;
let last = 0;
let rendered = 0;
let redraw = true;
let previewSuspended = false;
const aspect = computed(() => `${e.project.width} / ${e.project.height}`);
const importInput = () => input.value?.click();
function exportSrt() {
  download(
    new Blob([srt(e.subtitles)], { type: "text/plain;charset=utf-8" }),
    e.project.name + ".srt",
  );
}
function togglePlay() {
  if (!e.duration) return e.notify("请先将素材添加到时间线");
  if (e.time >= e.duration) e.time = 0;
  e.playing = !e.playing;
}
function previewVoice() {
  if (!e.selected?.text) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(e.selected.text);
  utterance.lang = "zh-CN";
  speechSynthesis.speak(utterance);
  e.notify("正在使用系统语音试听，导出请生成 AI 配音");
}
function keydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement;
  if (
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
    target.isContentEditable ||
    e.modal ||
    e.busy
  )
    return;
  const mod = event.metaKey || event.ctrlKey;
  if (mod && event.key.toLowerCase() === "i") {
    event.preventDefault();
    importInput();
    return;
  }
  if (event.code === "Space") {
    event.preventDefault();
    togglePlay();
  } else if (mod && event.key.toLowerCase() === "z") {
    event.preventDefault();
    event.shiftKey ? e.redo() : e.undo();
  } else if (mod && event.key.toLowerCase() === "b") {
    event.preventDefault();
    e.split();
  } else if (mod && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void e.saveProject();
  } else if (event.key === "Delete" || event.key === "Backspace") {
    event.preventDefault();
    e.removeSelected();
  } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    e.playing = false;
    e.time = Math.max(
      0,
      Math.min(
        e.duration,
        e.time +
          (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 1 : 1 / 30),
      ),
    );
  } else if (event.key.toLowerCase() === "n") e.snapping = !e.snapping;
  else if (event.key === "Escape") e.selectedId = "";
}
watch(
  () => [e.project, e.assets, e.time, e.playing],
  () => {
    redraw = true;
  },
  { deep: true },
);
onMounted(() => {
  preview = new Preview(canvas.value!, () => {
    redraw = true;
  });
  const render = (now: number) => {
    // Encoding and large project saves should not compete with preview decoders.
    if (e.busy) {
      if (!previewSuspended) {
        preview?.dispose();
        previewSuspended = true;
      }
      last = now;
      frame = requestAnimationFrame(render);
      return;
    }
    if (previewSuspended) {
      redraw = true;
      previewSuspended = false;
    }
    if (e.playing) {
      e.time = Math.min(
        e.duration,
        e.time + (last ? Math.min(0.1, (now - last) / 1000) : 0),
      );
      if (e.time >= e.duration) e.playing = false;
    }
    if ((redraw || e.playing) && now - rendered >= 1000 / 30) {
      preview?.sync(e.project, e.assets, e.time, e.playing);
      rendered = now;
      redraw = false;
    }
    last = now;
    frame = requestAnimationFrame(render);
  };
  frame = requestAnimationFrame(render);
  window.addEventListener("keydown", keydown);
});
onBeforeUnmount(() => {
  cancelAnimationFrame(frame);
  preview?.dispose();
  window.removeEventListener("keydown", keydown);
  speechSynthesis.cancel();
});
function onDragLeave(event: DragEvent) {
  if (!(event.relatedTarget as Node)?.isConnected) dragging.value = false;
}
function openFile(event: Event) {
  const el = event.target as HTMLInputElement;
  if (el.files?.[0]) void e.openProject(el.files[0]);
  el.value = "";
}
function closeModal() {
  if (!e.busy && !e.voiceBusy) e.modal = "";
}
async function dropped(event: DragEvent) {
  dragging.value = false;
  if (event.dataTransfer?.files.length)
    await e.importFiles(event.dataTransfer.files);
}
</script>
<template>
  <div
    class="app-shell"
    @dragover.prevent="
      dragging = !!$event.dataTransfer?.types.includes('Files')
    "
    @drop.prevent="dropped"
    @dragleave="onDragLeave"
  >
    <input
      ref="input"
      hidden
      type="file"
      multiple
      accept=".mp4,.mpv,.mp3,.mov,.m4v,.webm,.wav,.ogg,.m4a,.aac,.png,.jpg,.jpeg,.webp,.gif,.bmp,.avif"
      @change="
        e.importFiles(($event.target as HTMLInputElement).files);
        ($event.target as HTMLInputElement).value = '';
      "
    />
    <input
      ref="projectInput"
      hidden
      type="file"
      accept=".vcut,.json"
      @change="openFile"
    />
    <header class="app-header">
      <a class="brand" href="#" aria-label="VideoCup 工作台"
        ><span class="brand-mark">V<span></span></span><strong>VideoCup</strong
        ><span class="brand-edition">LOCAL STUDIO</span></a
      >
      <nav class="main-menu">
        <details>
          <summary>文件</summary>
          <div class="dropdown">
            <button @click="e.modal = 'new'">新建项目</button
            ><button @click="projectInput?.click()">打开工程…</button
            ><button @click="e.saveProject">保存工程 <kbd>⌘ S</kbd></button>
            <hr />
            <button @click="importInput">导入素材…</button>
          </div>
        </details>
        <details>
          <summary>编辑</summary>
          <div class="dropdown">
            <button @click="e.undo" :disabled="!e.history.length">
              撤销 <kbd>⌘ Z</kbd></button
            ><button @click="e.redo" :disabled="!e.future.length">
              重做 <kbd>⌘ ⇧ Z</kbd></button
            ><button @click="e.split" :disabled="!e.selected">
              分割片段 <kbd>⌘ B</kbd>
            </button>
          </div>
        </details>
        <button @click="e.modal = 'help'">帮助</button>
      </nav>
      <div class="header-project">
        <span class="status-dot"></span>{{ e.project.name
        }}<span class="muted">.vcut</span><Icon name="chevrondown" :size="13" />
      </div>
      <div class="header-actions">
        <span class="local-badge"
          ><Icon name="shield" :size="14" />本地工作空间</span
        ><button
          class="icon-button"
          title="配音服务设置"
          @click="e.modal = 'settings'"
        >
          <Icon name="settings" /></button
        ><span class="divider"></span
        ><button
          class="primary-button export-button"
          @click="e.modal = 'export'"
          :disabled="e.busy || e.voiceBusy"
        >
          <Icon name="download" :size="15" />导出<span class="shortcut">↗</span>
        </button>
      </div>
    </header>
    <div class="workspace-bar">
      <div class="workspace-tab">
        <span class="tab-dot"></span>剪辑工作台<Icon name="close" :size="12" />
      </div>
      <div class="workspace-path">
        <Icon name="folder" :size="13" /><span>工作空间</span
        ><Icon name="chevron" :size="11" /><span>{{ e.project.name }}</span>
      </div>
      <div class="saved-state">
        <Icon name="check" :size="12" />{{ e.saveState }}
      </div>
    </div>
    <div v-if="e.restoreError" class="restore-error" role="alert">
      {{ e.restoreError }}
    </div>
    <div class="main-workspace" :class="{ 'show-inspector': inspectorOpen }">
      <nav class="activity-bar">
        <div>
          <button
            :class="{ active: e.library === 'media' }"
            title="媒体素材"
            @click="e.library = 'media'"
          >
            <Icon name="folder" :size="21" /></button
          ><button
            :class="{ active: e.library === 'subtitles' }"
            title="字幕与配音"
            @click="e.library = 'subtitles'"
          >
            <Icon name="text" :size="21" /></button
          ><button title="AI 配音设置" @click="e.modal = 'settings'">
            <Icon name="sparkles" :size="21" />
          </button>
        </div>
        <div>
          <button title="使用指南" @click="e.modal = 'help'">
            <Icon name="help" :size="20" /></button
          ><button title="应用设置" @click="e.modal = 'settings'">
            <Icon name="settings" :size="20" />
          </button>
        </div>
      </nav>
      <aside class="media-panel panel">
        <div class="panel-heading">
          <span>{{ e.library === "media" ? "项目素材" : "字幕与配音" }}</span
          ><span class="count-badge">{{
            e.library === "media" ? e.assets.length : e.subtitles.length
          }}</span
          ><button
            class="icon-button push-right"
            title="导入素材"
            @click="importInput"
          >
            <Icon name="plus" :size="16" />
          </button>
        </div>
        <template v-if="e.library === 'media'"
          ><div class="media-actions">
            <button
              class="import-button"
              :disabled="e.busy"
              @click="importInput"
            >
              <Icon name="upload" :size="16" />导入素材<span>⌘ I</span>
            </button>
            <div class="search-field">
              <Icon name="search" :size="14" /><input
                v-model="e.query"
                aria-label="搜索素材"
                placeholder="搜索素材…"
              /><kbd>⌕</kbd>
            </div>
            <div class="asset-filters">
              <button
                v-for="item in [
                  { id: 'all', label: '全部' },
                  { id: 'video', label: '视频' },
                  { id: 'audio', label: '音频' },
                  { id: 'image', label: '图片' },
                ]"
                :key="item.id"
                :class="{ active: e.filter === item.id }"
                @click="e.filter = item.id"
              >
                {{ item.label }}</button
              ><span class="push-right"><Icon name="grid" :size="14" /></span>
            </div>
          </div>
          <div class="asset-list">
            <div
              v-for="asset in e.filteredAssets"
              :key="asset.id"
              class="asset-card"
              draggable="true"
              @dragstart="
                $event.dataTransfer?.setData(
                  'application/videocup-asset',
                  asset.id,
                )
              "
              @dblclick="e.putAsset(asset)"
              tabindex="0"
              @keydown.enter="e.putAsset(asset)"
            >
              <div class="asset-thumbnail" :class="asset.kind">
                <img
                  v-if="asset.thumbnail"
                  :src="asset.thumbnail"
                  :alt="asset.kind === 'image' ? '图片缩略图' : '视频缩略图'"
                />
                <div v-else class="audio-art">
                  <Icon name="wave" :size="32" /><span>{{
                    asset.kind === "audio"
                      ? "AUDIO"
                      : asset.kind === "image"
                        ? "IMAGE"
                        : "VIDEO"
                  }}</span>
                </div>
                <span class="asset-type">{{
                  asset.name.split(".").pop()?.toUpperCase()
                }}</span
                ><span class="asset-duration mono">{{
                  formatTime(asset.duration)
                }}</span
                ><button
                  class="asset-add"
                  title="添加到时间线"
                  @click="e.putAsset(asset)"
                >
                  <Icon name="plus" :size="17" />
                </button>
              </div>
              <div class="asset-info">
                <Icon
                  :name="
                    asset.kind === 'image'
                      ? 'image'
                      : asset.kind === 'video'
                        ? 'video'
                        : 'music'
                  "
                  :size="13"
                /><span :title="asset.name">{{ asset.name }}</span>
              </div>
              <div class="asset-meta">
                {{
                  asset.kind !== "audio"
                    ? `${asset.width} × ${asset.height}`
                    : "音频素材"
                }}<span
                  >{{ (asset.blob.size / 1024 / 1024).toFixed(1) }} MB</span
                >
              </div>
            </div>
            <div v-if="!e.assets.length" class="library-empty">
              <div class="file-stack">
                <div></div>
                <div></div>
                <div><Icon name="video" :size="26" /></div>
              </div>
              <h3>好故事，从素材开始</h3>
              <p>导入你的视频、图片与声音<br />所有文件保留在你的设备上</p>
              <button class="text-button accent" @click="importInput">
                选择本地文件<Icon name="chevron" :size="13" /></button
              ><span class="format-label">MP4 · MOV · MP3 · PNG · JPG</span>
            </div>
            <p v-else-if="!e.filteredAssets.length" class="no-results">
              没有找到匹配的素材
            </p>
          </div>
          <div class="library-bottom">
            <Icon name="shield" :size="14" /><span>素材不上传，创作更安心</span>
          </div>
        </template>
        <template v-else
          ><div class="media-actions">
            <button
              class="import-button"
              :disabled="e.busy"
              @click="e.addSubtitle"
            >
              <Icon name="plus" :size="16" />添加字幕
            </button>
            <p class="subtitle-tip">写下文字，生成与字幕同步的 AI 配音。</p>
          </div>
          <div class="subtitle-list">
            <button
              v-for="(clip, i) in e.subtitles"
              :key="clip.id"
              :class="{ active: e.selectedId === clip.id }"
              @click="
                e.selectedId = clip.id;
                e.time = clip.start;
              "
            >
              <span class="subtitle-index mono">{{
                String(i + 1).padStart(2, "0")
              }}</span>
              <div>
                <p>{{ clip.text || "空字幕" }}</p>
                <small class="mono"
                  >{{ formatTime(clip.start) }} →
                  {{
                    formatTime(clip.start + (clip.out - clip.in) / clip.speed)
                  }}</small
                >
              </div>
              <Icon v-if="clip.linkedId" name="link" :size="13" />
            </button>
            <div v-if="!e.subtitles.length" class="subtitles-empty">
              <Icon name="text" :size="32" />
              <p>给故事加上文字与声音</p>
              <small>点击「添加字幕」开始</small>
            </div>
          </div>
          <button
            class="secondary-button srt-export"
            :disabled="!e.subtitles.length"
            @click="exportSrt"
          >
            <Icon name="download" :size="14" />导出 SRT 字幕
          </button></template
        >
      </aside>
      <main class="preview-panel">
        <div class="panel-heading">
          <span>预览</span>
          <div class="preview-sequence">
            <span class="tiny-label">SEQUENCE 01</span
            ><span class="small-dot"></span>{{ e.project.width }} ×
            {{ e.project.height }}<span class="muted">/</span
            >{{ e.project.fps }} FPS
          </div>
          <button
            class="icon-button mobile-properties"
            :class="{ accent: inspectorOpen }"
            title="片段属性"
            @click="inspectorOpen = !inspectorOpen"
          >
            <Icon name="settings" :size="16" /></button
          ><button
            class="icon-button push-right"
            title="全屏预览"
            @click="stage?.requestFullscreen()"
          >
            <Icon name="zoom" :size="16" />
          </button>
        </div>
        <div class="preview-area" ref="stage">
          <div
            class="canvas-wrap"
            :style="{
              aspectRatio: aspect,
              '--canvas-ratio': e.project.width / e.project.height,
            }"
          >
            <canvas
              ref="canvas"
              :width="e.project.width"
              :height="e.project.height"
              :class="{ invisible: !e.project.clips.length }"
            ></canvas>
            <PreviewControls v-if="e.project.clips.length" :editor="e" />
            <div v-if="!e.project.clips.length" class="preview-welcome">
              <div class="welcome-art">
                <svg viewBox="0 0 420 175" fill="none" aria-hidden="true">
                  <path
                    d="M0 150H420M0 112H420M0 74H420M0 36H420M55 0V175M132 0V175M209 0V175M286 0V175M363 0V175"
                    stroke="#ffffff"
                    stroke-opacity=".035"
                  />
                  <rect
                    x="117"
                    y="27"
                    width="180"
                    height="111"
                    rx="5"
                    transform="rotate(-8 117 27)"
                    fill="#20272a"
                    stroke="#3c4945"
                  />
                  <rect
                    x="132"
                    y="36"
                    width="180"
                    height="111"
                    rx="5"
                    transform="rotate(5 132 36)"
                    fill="#242e29"
                    stroke="#51634e"
                  />
                  <rect
                    x="126"
                    y="31"
                    width="174"
                    height="106"
                    rx="5"
                    fill="#26322a"
                    stroke="#89af6c"
                    stroke-opacity=".6"
                  />
                  <path
                    d="m127 117 41-40 38 29 40-51 53 62v19H127Z"
                    fill="#51654a"
                  />
                  <path
                    d="m127 129 39-31 44 27 33-22 56 24v9H127Z"
                    fill="#789366"
                  />
                  <circle cx="166" cy="58" r="10" fill="#b5d392" />
                  <rect
                    x="198"
                    y="66"
                    width="35"
                    height="35"
                    rx="17.5"
                    fill="#e2f4ce"
                  />
                  <path d="m212 76 10 7-10 7Z" fill="#30402d" />
                  <path
                    d="M110 20H94v16m214-16h16v16M94 131v16h16m198 0h16v-16"
                    stroke="#91b775"
                    stroke-width="1.5"
                  />
                </svg>
              </div>
              <h1>让灵感，剪辑成片。</h1>
              <p>一个安静的创作空间，专注你的下一个故事。</p>
              <div class="welcome-actions">
                <button
                  class="primary-button"
                  :disabled="e.busy"
                  @click="importInput"
                >
                  <Icon name="plus" :size="16" />导入第一段素材</button
                ><button
                  class="secondary-button"
                  :disabled="e.busy"
                  @click="e.demo"
                >
                  <Icon name="play" :size="14" />体验示例项目
                </button>
              </div>
              <span class="welcome-hint">或将本地文件拖放至窗口</span>
            </div>
          </div>
          <div class="preview-corner">
            <span class="corner-bracket"></span>本地预览<span
              class="small-dot"
            ></span
            >原始画质
          </div>
        </div>
        <div class="transport-bar">
          <div class="transport-time mono">
            {{ formatTime(e.time, true)
            }}<span>/ {{ formatTime(e.duration, true) }}</span>
          </div>
          <div class="playback-buttons">
            <button
              class="icon-button"
              title="回到开头"
              @click="
                e.time = 0;
                e.playing = false;
              "
            >
              <Icon name="prev" :size="17" /></button
            ><button
              class="play-button"
              :aria-label="e.playing ? '暂停' : '播放'"
              @click="togglePlay"
            >
              <Icon :name="e.playing ? 'pause' : 'play'" :size="19" /></button
            ><button
              class="icon-button"
              title="跳到结尾"
              @click="
                e.time = e.duration;
                e.playing = false;
              "
            >
              <Icon name="next" :size="17" />
            </button>
          </div>
          <div class="preview-scale">
            <span>适应</span><Icon name="chevrondown" :size="12" /><span
              class="divider"
            ></span
            ><Icon name="monitor" :size="16" />
          </div>
        </div>
      </main>
      <Inspector :editor="e" />
    </div>
    <Timeline :editor="e" />
    <footer class="app-statusbar">
      <span class="status-logo">V</span
      ><span>VideoCup <span class="muted">/</span> {{ e.project.name }}</span
      ><span v-if="e.busy" class="operation-status"
        ><i class="spinner"></i>{{ e.status }}</span
      ><span v-else class="status-ready"
        ><span class="status-dot"></span>就绪</span
      ><span class="status-right"
        ><Icon name="shield" :size="12" /> LOCAL FIRST
        <span class="status-separator"></span> Vue 3.6 Vapor
        <span class="status-separator"></span> UTF-8</span
      >
    </footer>
    <div v-if="dragging" class="drop-overlay">
      <Icon name="upload" :size="42" />
      <h2>将素材拖放到这里</h2>
      <p>视频、音频和 PNG / JPG / WebP 等图片</p>
    </div>
    <div v-if="e.toast" class="toast" role="status">
      <Icon name="check" :size="17" />{{ e.toast
      }}<button class="icon-button" @click="e.toast = ''">
        <Icon name="close" :size="13" />
      </button>
    </div>
    <div v-if="e.modal" class="modal-backdrop" @click.self="closeModal">
      <section
        class="modal"
        role="dialog"
        aria-modal="true"
        :aria-label="
          e.modal === 'export'
            ? '导出项目'
            : e.modal === 'settings'
              ? 'AI 配音设置'
              : '项目操作'
        "
      >
        <header class="modal-header">
          <div class="modal-icon">
            <Icon
              :name="
                e.modal === 'export'
                  ? 'download'
                  : e.modal === 'settings'
                    ? 'sparkles'
                    : e.modal === 'help'
                      ? 'help'
                      : 'folder'
              "
              :size="21"
            />
          </div>
          <div>
            <h2>
              {{
                e.modal === "export"
                  ? "导出你的故事"
                  : e.modal === "settings"
                    ? "AI 配音服务"
                    : e.modal === "project-save"
                      ? "保存完整工程"
                      : e.modal === "help"
                        ? "开始你的第一次剪辑"
                        : "新建项目"
              }}
            </h2>
            <p>
              {{
                e.modal === "export"
                  ? "在你的设备上完成编码，保留每一份创作。"
                  : e.modal === "settings"
                    ? "选择声音与音色，生成与字幕同步的配音。"
                    : e.modal === "project-save"
                      ? "包含全部素材、字幕和剪辑设置，不会改变当前工程。"
                      : e.modal === "help"
                        ? "从一段素材，到一个完整的故事。"
                        : "当前项目会被替换，请先下载工程保留素材。"
              }}
            </p>
          </div>
          <button
            class="icon-button push-right"
            :disabled="e.busy || e.voiceBusy"
            @click="e.modal = ''"
          >
            <Icon name="close" :size="18" />
          </button>
        </header>
        <div v-if="e.modal === 'export'" class="modal-body">
          <div class="export-summary">
            <Icon name="video" :size="28" />
            <div>
              <b>{{ e.project.name }}</b
              ><span
                >{{ formatTime(e.duration, true) }} ·
                {{ e.project.tracks.length }} 条轨道 ·
                {{ e.project.fps }} fps</span
              >
            </div>
            <span class="tag">{{
              e.exportOptions.audioOnly ? "MP3" : "MP4"
            }}</span>
          </div>
          <div v-if="e.exportResult" class="export-success">
            <Icon name="check" :size="22" />
            <div>
              <b>影片已准备就绪</b>
              <p>
                {{ e.exportResult?.name }} ·
                {{ ((e.exportResult?.size ?? 0) / 1024 / 1024).toFixed(2) }} MB
              </p>
            </div>
          </div>
          <fieldset v-else :disabled="e.busy">
            <label class="field-label"
              >导出方式<select v-model="e.exportOptions.engine">
                <option value="auto">自动 · 优先本机加速</option>
                <option value="browser">浏览器兼容模式</option>
              </select></label
            >
            <label class="field-label"
              >导出格式<select v-model="e.exportOptions.audioOnly">
                <option :value="false">MP4 视频 · H.264 + AAC</option>
                <option :value="true">MP3 音频 · 192 kbps</option>
              </select></label
            >
            <div v-if="!e.exportOptions.audioOnly" class="two-fields">
              <label class="field-label"
                >分辨率<select v-model="e.exportOptions.resolution">
                  <option value="1080">1080p</option>
                  <option value="720">720p</option>
                  <option value="480">480p</option>
                </select></label
              ><label class="field-label"
                >画质<select v-model="e.exportOptions.quality">
                  <option value="standard">标准 · 文件更小</option>
                  <option value="high">高画质</option>
                </select></label
              >
            </div>
            <label v-if="!e.exportOptions.audioOnly" class="checkbox-row"
              ><input
                v-model="e.exportOptions.subtitles"
                type="checkbox"
              />将字幕烧录到视频画面</label
            >
          </fieldset>
          <div v-if="e.busy" class="export-progress">
            <div>
              <span>{{ e.status }}</span
              ><b class="mono">{{ Math.floor(e.progress) }}%</b>
            </div>
            <progress :value="e.progress" max="100"></progress
            ><small>自动模式优先使用本机加速；首次导出需准备素材。</small>
          </div>
          <div
            v-if="e.exportError && !e.busy"
            class="export-error"
            role="alert"
          >
            {{ e.exportError }}
          </div>
          <div v-if="!e.busy" class="modal-note">
            <Icon
              name="shield"
              :size="16"
            />素材与导出文件均在本地处理，无需上传。
          </div>
          <div class="modal-buttons">
            <button
              v-if="e.busy"
              class="secondary-button"
              @click="e.cancelExport"
            >
              取消导出</button
            ><template v-else-if="e.exportResult"
              ><button class="secondary-button" @click="e.clearExportResult">
                调整设置</button
              ><a
                class="primary-button"
                :href="e.exportResult?.url"
                :download="e.exportResult?.name"
                ><Icon name="download" :size="16" />下载文件</a
              ></template
            ><template v-else
              ><button class="secondary-button" @click="e.modal = ''">
                取消</button
              ><button
                class="primary-button"
                :disabled="!e.duration"
                @click="e.runExport"
              >
                <Icon name="download" :size="16" />开始导出
              </button></template
            >
          </div>
        </div>
        <div v-else-if="e.modal === 'project-save'" class="modal-body">
          <div class="export-success">
            <Icon name="save" :size="22" />
            <div>
              <b>工程文件已准备就绪</b>
              <p>
                {{ e.projectFileResult?.name }} ·
                {{ ((e.projectFileResult?.size ?? 0) / 1048576).toFixed(1) }} MB
              </p>
            </div>
          </div>
          <p class="tts-description">
            工程使用二进制素材保存，避免大文件转成 Base64
            时占满内存。请保留下载的 .vcut 文件作为完整备份。
          </p>
          <div class="modal-buttons">
            <button class="secondary-button" @click="e.modal = ''">关闭</button
            ><a
              v-if="e.projectFileResult"
              class="primary-button"
              :href="e.projectFileResult?.url"
              :download="e.projectFileResult?.name"
              ><Icon name="download" :size="16" />下载完整工程</a
            >
          </div>
        </div>
        <TtsSettings v-else-if="e.modal === 'settings'" :editor="e" />
        <div v-else-if="e.modal === 'help'" class="modal-body">
          <ol class="help-steps">
            <li>
              <span>01</span>
              <div>
                <b>导入你的素材</b>
                <p>
                  导入视频、音频或图片，双击素材或拖到对应轨道。图片默认显示 5
                  秒，可在右侧调整时长。MPV 等浏览器不支持的编码会在本地转换。
                </p>
              </div>
            </li>
            <li>
              <span>02</span>
              <div>
                <b>在时间线上创作</b>
                <p>
                  拖动片段排序，拖动边缘裁剪。将播放头移动到片段中间，用 ⌘ B
                  分割，在右侧调整速度、画面和音量。
                </p>
              </div>
            </li>
            <li>
              <span>03</span>
              <div>
                <b>字幕，也可以有声音</b>
                <p>
                  添加字幕并配置配音服务，点击生成 AI
                  配音，语音会自动添加到音轨并与字幕关联。
                </p>
              </div>
            </li>
            <li>
              <span>04</span>
              <div>
                <b>保存并导出</b>
                <p>
                  项目自动保存在当前浏览器。⌘ S 下载包含素材的 .vcut
                  工程；导出支持 MP4、MP3，字幕可单独导出为 SRT。
                </p>
              </div>
            </li>
          </ol>
          <div class="modal-buttons">
            <button class="primary-button" @click="e.modal = ''">
              开始创作<Icon name="chevron" :size="14" />
            </button>
          </div>
        </div>
        <div v-else class="modal-body">
          <div class="modal-buttons">
            <button class="secondary-button" @click="e.saveProject">
              先保存工程</button
            ><button class="primary-button" @click="e.resetProject">
              创建空白项目
            </button>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
