<script setup lang="ts" vapor>
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { Editor } from "../lib/editor";
import Icon from "./Icon.vue";
import {
  defaultSpeechConfig,
  speechProvider,
  speechProviders,
  synthesizeSpeech,
} from "../lib/tts";
import type { SpeechVoice } from "../lib/tts";
import { endpointUrl } from "../lib/tts/http";
const { editor: e } = defineProps<{ editor: Editor }>();
const providers = speechProviders();
const provider = computed(() => speechProvider(e.config.providerId));
const voices = ref<SpeechVoice[]>([]);
const loading = ref(false);
const previewing = ref(false);
const error = ref("");
const audioUrl = ref("");
const previewText = ref(
  e.selected?.text || "你好，欢迎来到 VideoCup。让灵感，剪辑成片。",
);
const languageFilter = ref("");
const voiceQuery = ref("");
const selectedVoice = computed(() =>
  voices.value.find((v) => v.id === e.config.voice),
);
const languages = computed(() => [
  ...new Set(
    voices.value.map((v) => v.language).filter((v): v is string => !!v),
  ),
]);
const filteredVoices = computed(() =>
  voices.value.filter(
    (v) =>
      (!languageFilter.value || v.language === languageFilter.value) &&
      `${v.name} ${v.id} ${v.gender || ""}`
        .toLowerCase()
        .includes(voiceQuery.value.toLowerCase()),
  ),
);
const manualVoice = computed(
  () => !voices.value.some((v) => v.id === e.config.voice),
);
let controller: AbortController | undefined;
let voiceRequest = 0;
async function loadVoices() {
  const request = ++voiceRequest;
  loading.value = true;
  error.value = "";
  try {
    const list = await provider.value.listVoices({ ...e.config });
    if (request !== voiceRequest) return;
    voices.value = list;
  } catch (err) {
    if (request === voiceRequest)
      error.value = err instanceof Error ? err.message : "无法读取音色列表";
  } finally {
    if (request === voiceRequest) loading.value = false;
  }
}
function chooseProvider(event: Event) {
  const id = (event.target as HTMLSelectElement).value;
  controller?.abort();
  Object.assign(
    e.config,
    defaultSpeechConfig(),
    id === "edge-tts"
      ? {}
      : {
          providerId: id,
          endpoint: "",
          voice: id === "audio-speech" ? "alloy" : "",
          style: "",
        },
  );
  voices.value = [];
  languageFilter.value = "";
  voiceQuery.value = "";
  void loadVoices();
}
function chooseVoice(event: Event) {
  const id = (event.target as HTMLSelectElement).value;
  e.config.voice = id === "__custom__" ? "" : id;
  e.config.style = "";
  const chosen = voices.value.find((v) => v.id === id);
  if (chosen?.language) e.config.language = chosen.language;
}
function save() {
  try {
    if (provider.value.unavailableReason)
      throw new Error(provider.value.unavailableReason);
    endpointUrl(e.config.endpoint);
    if (e.config.voicesEndpoint) endpointUrl(e.config.voicesEndpoint);
    if (provider.value.capabilities.model && !e.config.model.trim())
      throw new Error("请填写服务支持的模型 ID");
    if (!e.config.voice.trim()) throw new Error("请选择音色或填写音色 ID");
    const { key, ...safe } = e.config;
    localStorage.setItem("videocup-tts", JSON.stringify(safe));
    e.modal = "";
    e.notify("配音服务已保存，API Key 仅保留在当前会话");
  } catch (err) {
    error.value = err instanceof Error ? err.message : "设置保存失败";
  }
}
function clear() {
  controller?.abort();
  Object.assign(e.config, defaultSpeechConfig());
  localStorage.removeItem("videocup-tts");
  if (audioUrl.value) URL.revokeObjectURL(audioUrl.value);
  audioUrl.value = "";
  voices.value = [];
  void loadVoices();
  e.notify("配音配置已清除");
}
async function preview() {
  controller?.abort();
  controller = new AbortController();
  const current = controller;
  const timeout = setTimeout(() => current.abort(), 120000);
  previewing.value = true;
  error.value = "";
  try {
    const settings = { ...e.config };
    const result = await synthesizeSpeech(
      {
        text: previewText.value,
        voice: settings.voice,
        language: settings.language,
        style: settings.style,
        rate: settings.rate,
        pitch: settings.pitch,
        volume: settings.volume,
      },
      settings,
      current.signal,
    );
    if (current.signal.aborted) return;
    if (audioUrl.value) URL.revokeObjectURL(audioUrl.value);
    audioUrl.value = URL.createObjectURL(result.blob);
  } catch (err) {
    if (!current.signal.aborted)
      error.value =
        err instanceof Error
          ? err.message
          : "试听生成失败，请检查服务地址与跨域配置";
  } finally {
    clearTimeout(timeout);
    if (controller === current) previewing.value = false;
  }
}
onMounted(() => {
  if (!e.config.voicesEndpoint) void loadVoices();
});
onBeforeUnmount(() => {
  voiceRequest++;
  controller?.abort();
  if (audioUrl.value) URL.revokeObjectURL(audioUrl.value);
});
</script>
<template>
  <form class="modal-body tts-settings" @submit.prevent="save">
    <label class="field-label"
      >配音服务<select
        aria-label="配音服务"
        :value="e.config.providerId"
        @change="chooseProvider"
      >
        <option
          v-for="item in providers"
          :key="item.id"
          :value="item.id"
          :disabled="!!item.unavailableReason"
        >
          {{ item.name }}
        </option>
      </select></label
    >
    <p class="tts-description">{{ provider.description }}</p>
    <div v-if="e.config.providerId === 'edge-tts'" class="edge-service-note">
      <Icon name="sparkles" :size="16" /><span
        >内置 Edge 语音服务，可直接选择声音并生成，无需安装或打开 Edge。基于
        <a
          href="https://github.com/ssrsss/ttsapi"
          target="_blank"
          rel="noopener noreferrer"
          >ssrsss/ttsapi</a
        >；合成需要联网。</span
      >
    </div>
    <details v-if="e.config.providerId === 'edge-tts'" class="tts-advanced">
      <summary>服务连接（高级）</summary>
      <label class="field-label"
        >内置接口或自部署 Worker<input
          v-model="e.config.endpoint"
          type="text"
          aria-label="语音合成接口"
          placeholder="/api/edge/speech"
          required /></label
      ><small>可改为自部署 ttsapi Worker 的完整 /v1/audio/speech 地址。</small>
    </details>
    <label v-else class="field-label"
      >语音合成接口<input
        v-model="e.config.endpoint"
        type="url"
        aria-label="语音合成接口"
        placeholder="https://your-service.com/v1/audio/speech"
        required
    /></label>
    <label
      v-if="
        e.config.providerId !== 'edge-tts' ||
        !e.config.endpoint.startsWith('/api/')
      "
      class="field-label"
      >API Key<input
        v-model="e.config.key"
        type="password"
        aria-label="API Key"
        autocomplete="off"
        placeholder="仅在当前会话中使用"
    /></label>
    <label v-if="provider.capabilities.model" class="field-label"
      >模型<input
        v-model="e.config.model"
        aria-label="模型"
        placeholder="服务支持的模型 ID"
        required
    /></label>
    <label class="field-label"
      >音色列表接口（可选）<input
        v-model="e.config.voicesEndpoint"
        type="url"
        aria-label="音色列表接口"
        placeholder="https://your-service.com/voices"
    /></label>
    <div class="voice-list-toolbar">
      <label class="search-field"
        ><Icon name="search" :size="14" /><input
          v-model="voiceQuery"
          aria-label="搜索声音"
          placeholder="搜索声音 / 性别 / 音色 ID" /></label
      ><button
        type="button"
        class="secondary-button"
        :disabled="loading"
        @click="loadVoices"
      >
        {{ loading ? "加载中…" : "获取音色" }}
      </button>
    </div>
    <label v-if="languages.length" class="field-label"
      >筛选语言<select v-model="languageFilter" aria-label="筛选音色语言">
        <option value="">所有语言</option>
        <option v-for="lang in languages" :key="lang" :value="lang">
          {{ lang }}
        </option>
      </select></label
    >
    <label class="field-label"
      >声音 / 音色<select
        aria-label="声音与音色"
        :value="manualVoice ? '__custom__' : e.config.voice"
        @change="chooseVoice"
      >
        <option
          v-if="
            selectedVoice &&
            !filteredVoices.some((v) => v.id === selectedVoice?.id)
          "
          :value="selectedVoice?.id"
        >
          {{ selectedVoice?.name }}
        </option>
        <option
          v-for="voice in filteredVoices"
          :key="voice.id"
          :value="voice.id"
        >
          {{ voice.name }}{{ voice.gender ? " · " + voice.gender : ""
          }}{{ voice.language ? " · " + voice.language : "" }}
        </option>
        <option value="__custom__">自定义音色 ID…</option>
      </select></label
    >
    <label v-if="manualVoice" class="field-label"
      >音色 ID<input
        v-model="e.config.voice"
        aria-label="自定义音色 ID"
        placeholder="填写服务支持的音色 ID"
        required
    /></label>
    <p v-if="selectedVoice?.description" class="tts-description">
      {{ selectedVoice?.description }}
    </p>
    <div class="two-fields">
      <label class="field-label"
        >语速<select v-model.number="e.config.rate" aria-label="配音语速">
          <option
            v-for="rate in [0.5, 0.75, 1, 1.25, 1.5, 2]"
            :key="rate"
            :value="rate"
          >
            {{ rate }}×
          </option>
        </select></label
      ><label v-if="provider.capabilities.language" class="field-label"
        >生成语言<input
          v-model="e.config.language"
          aria-label="配音语言"
          placeholder="zh-CN"
      /></label>
    </div>
    <label v-if="provider.capabilities.style" class="field-label"
      >情感 / 风格<select v-model="e.config.style" aria-label="配音风格">
        <option value="">默认</option>
        <option
          v-for="style in selectedVoice?.styles || []"
          :key="style.id"
          :value="style.id"
        >
          {{ style.name }}
        </option>
      </select></label
    >
    <div class="two-fields">
      <label v-if="provider.capabilities.pitch" class="field-label"
        >{{ e.config.providerId === "edge-tts" ? "音调（Hz）" : "音调（半音）"
        }}<input
          v-model.number="e.config.pitch"
          type="number"
          :min="e.config.providerId === 'edge-tts' ? -50 : -12"
          :max="e.config.providerId === 'edge-tts' ? 50 : 12"
          step="1"
          aria-label="配音音调" /></label
      ><label v-if="provider.capabilities.volume" class="field-label"
        >音量<input
          v-model.number="e.config.volume"
          type="number"
          min="0"
          max="2"
          step="0.1"
          aria-label="配音音量"
      /></label>
    </div>
    <div class="tts-preview">
      <label class="field-label"
        >试听文本<textarea
          v-model="previewText"
          aria-label="配音试听文本"
          rows="2"
        ></textarea></label
      ><button
        type="button"
        class="secondary-button full"
        :disabled="previewing || !previewText.trim()"
        @click="preview"
      >
        <Icon name="play" :size="14" />{{
          previewing ? "正在生成试听…" : "用当前声音生成试听"
        }}</button
      ><audio
        v-if="audioUrl"
        :src="audioUrl"
        controls
        preload="metadata"
      ></audio
      ><small>试听会调用所选服务，可能计入额度。</small>
    </div>
    <div v-if="error" class="export-error" role="alert">{{ error }}</div>
    <div class="modal-note">
      <Icon name="shield" :size="16" /><span
        >仅字幕文本发送到所选服务。密钥不写入工程或本地存储；跨域接口需允许本站访问。不同域名的音色接口不会收到合成接口的密钥。</span
      >
    </div>
    <div class="modal-buttons">
      <button type="button" class="text-button clear-settings" @click="clear">
        清除配置</button
      ><button type="button" class="secondary-button" @click="e.modal = ''">
        取消</button
      ><button type="submit" class="primary-button">保存为默认服务</button>
    </div>
  </form>
</template>
