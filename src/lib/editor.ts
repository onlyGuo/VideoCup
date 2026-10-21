import {
  computed,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from "vue";
import type { Asset, Clip, TrackKind, Project } from "./types";
import {
  assetTrackKind,
  clipDuration,
  createClip,
  endOf,
  newProject,
  splitClip,
  uid,
} from "./types";
import { download, imageFile, makeDemo, readAsset } from "./media";
import {
  defaultSpeechConfig,
  migrateSpeechConfig,
  speechProvider,
  synthesizeSpeech,
} from "./tts";
import {
  loadWorkspace,
  packProject,
  saveWorkspace,
  unpackProject,
  writeProjectToFile,
} from "./storage";
import type { ProjectFileWritable } from "./storage";
import {
  cancelEngine,
  convertMedia,
  exportMedia,
  extractAudio,
} from "./ffmpeg";
import {
  discardNativeExport,
  nativeCapabilities,
  nativeExport,
} from "./native-export";
export function useEditor() {
  const project = ref(newProject());
  const assets = ref<Asset[]>([]);
  const selectedId = ref("");
  const time = ref(0);
  const playing = ref(false);
  const zoom = ref(48);
  const snapping = ref(true);
  const query = ref("");
  const filter = ref("all");
  const library = ref("media");
  const modal = ref("");
  const toast = ref("");
  const busy = ref(false);
  const status = ref("");
  const progress = ref(0);
  const saveState = ref("本地自动保存");
  const ready = ref(false);
  const restoreError = ref("");
  const projectFileResult = ref<{
    url: string;
    name: string;
    size: number;
  } | null>(null);
  const config = reactive(defaultSpeechConfig());
  const exportOptions = reactive({
    engine: "auto",
    resolution: "1080",
    audioOnly: false,
    subtitles: true,
    quality: "standard",
  });
  const voiceBusy = ref(false);
  const exportError = ref("");
  const exportResult = ref<{
    url: string;
    name: string;
    size: number;
    nativeJobId?: string;
  } | null>(null);
  let exportCancelled = false;
  let exportController: AbortController | undefined;
  const selected = computed(() =>
    project.value.clips.find((c) => c.id === selectedId.value),
  );
  const selectedTrack = computed(() =>
    project.value.tracks.find((t) => t.id === selected.value?.trackId),
  );
  const selectedAsset = computed(() =>
    assets.value.find((a) => a.id === selected.value?.assetId),
  );
  const duration = computed(() =>
    Math.max(0, ...project.value.clips.map(endOf)),
  );
  const timelineLength = computed(() =>
    Math.max(30, Math.ceil((duration.value + 8) / 10) * 10),
  );
  const filteredAssets = computed(() =>
    assets.value.filter(
      (a) =>
        (filter.value === "all" || a.kind === filter.value) &&
        a.name.toLowerCase().includes(query.value.toLowerCase()),
    ),
  );
  const subtitles = computed(() =>
    project.value.clips
      .filter((c) => c.text !== undefined)
      .sort((a, b) => a.start - b.start),
  );
  const history = ref<string[]>([]);
  const future = ref<string[]>([]);
  let toastTimer = 0;
  let saveTimer = 0;
  let alive = true;
  function notify(message: string) {
    toast.value = message;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (toast.value = ""), 4200);
  }
  const snapshot = () => JSON.stringify(project.value);
  function checkpoint() {
    history.value.push(snapshot());
    if (history.value.length > 80) history.value.shift();
    future.value = [];
  }
  function undo() {
    if (!history.value.length || busy.value) return;
    future.value.push(snapshot());
    project.value = JSON.parse(history.value.pop()!);
    selectedId.value = "";
  }
  function redo() {
    if (!future.value.length || busy.value) return;
    history.value.push(snapshot());
    project.value = JSON.parse(future.value.pop()!);
    selectedId.value = "";
  }
  function addTrack(kind: TrackKind, above = false) {
    checkpoint();
    const track = {
      id: uid(),
      kind,
      name: `${kind === "video" ? "视频" : kind === "audio" ? "音频" : "字幕"} ${String(project.value.tracks.filter((t) => t.kind === kind).length + 1).padStart(2, "0")}`,
      muted: false,
      hidden: false,
      locked: false,
    };
    const order = { subtitle: 0, video: 1, audio: 2 };
    const idx = project.value.tracks.findIndex((t) =>
      above ? order[t.kind] >= order[kind] : order[t.kind] > order[kind],
    );
    project.value.tracks.splice(
      idx < 0 ? project.value.tracks.length : idx,
      0,
      track,
    );
    return track;
  }
  function putAsset(asset: Asset, at = time.value, targetTrack?: string) {
    const kind = assetTrackKind(asset);
    let track = project.value.tracks.find(
      (t) => t.id === targetTrack && t.kind === kind && !t.locked,
    );
    if (!track)
      track = project.value.tracks.find(
        (t) =>
          t.kind === kind &&
          !t.locked &&
          !project.value.clips.some(
            (c) =>
              c.trackId === t.id &&
              c.start < at + asset.duration &&
              endOf(c) > at,
          ),
      );
    if (!track) track = addTrack(kind, asset.kind === "image");
    checkpoint();
    const clip = createClip(track.id, asset, Math.max(0, at));
    project.value.clips.push(clip);
    selectedId.value = clip.id;
    playing.value = false;
    time.value = clip.start;
    return clip;
  }
  async function importFiles(files: FileList | File[] | null) {
    if (!files || busy.value) return;
    busy.value = true;
    let count = 0;
    try {
      for (const file of Array.from(files)) {
        if (
          !imageFile(file, file.name) &&
          !/\.(mp4|mpv|mp3|mov|m4v|webm|wav|ogg|m4a|aac)$/i.test(file.name)
        ) {
          notify(`不支持的格式：${file.name}`);
          continue;
        }
        try {
          status.value = `正在导入 ${file.name}`;
          let asset: Asset;
          try {
            asset = await readAsset(file, file.name);
          } catch (error) {
            if (imageFile(file, file.name)) throw error;
            asset = await readAsset(
              await convertMedia(file, file.name, (s) => (status.value = s)),
              file.name.replace(/\.[^.]+$/, "") + ".mp4",
            );
          }
          assets.value.push(asset);
          count++;
        } catch (error) {
          notify(
            `${file.name}：${error instanceof Error ? error.message : "导入失败"}`,
          );
        }
      }
      if (count) notify(`已导入 ${count} 个素材，双击或拖入时间线开始剪辑`);
    } finally {
      busy.value = false;
      status.value = "";
    }
  }
  async function repairPreview(
    assetId = selected.value?.assetId,
    validateFirst = false,
  ) {
    const asset = assets.value.find((a) => a.id === assetId);
    if (!asset || asset.kind !== "video" || busy.value) return;
    busy.value = true;
    playing.value = false;
    status.value = `正在检查 ${asset.name} 的视频画面…`;
    try {
      let repaired: Asset | undefined;
      if (validateFirst) {
        try {
          repaired = await readAsset(asset.blob, asset.name);
        } catch {
          /* Transcode unsupported frames below. */
        }
      }
      if (!repaired) {
        const blob = await convertMedia(
          asset.blob,
          asset.name,
          (message) => (status.value = message),
        );
        repaired = await readAsset(
          blob,
          asset.name.replace(/\.[^.]+$/, "") + ".mp4",
        );
      }
      if (!alive) {
        URL.revokeObjectURL(repaired.url);
        return;
      }
      const previousUrl = asset.url;
      Object.assign(asset, repaired, { id: asset.id });
      URL.revokeObjectURL(previousUrl);
      if (!validateFirst) notify("预览素材已转换为兼容的 MP4，剪辑设置已保留");
    } catch (error) {
      notify(
        error instanceof Error
          ? error.message
          : "素材预览修复失败，请检查源文件",
      );
    } finally {
      busy.value = false;
      status.value = "";
    }
  }
  function addSubtitle() {
    let track = project.value.tracks.find(
      (t) => t.kind === "subtitle" && !t.locked,
    );
    if (!track) track = addTrack("subtitle");
    checkpoint();
    const clip = createClip(track.id, undefined, time.value);
    clip.text = "在这里，写下你的故事。";
    clip.name = clip.text;
    project.value.clips.push(clip);
    selectedId.value = clip.id;
    library.value = "subtitles";
  }
  function linkedLocked(clip: Clip) {
    const linked = project.value.clips.find((c) => c.id === clip.linkedId);
    return (
      linked &&
      project.value.tracks.find((t) => t.id === linked.trackId)?.locked
    );
  }
  function updateClip(patch: Partial<Clip>) {
    const clip = selected.value;
    if (!clip || selectedTrack.value?.locked) return;
    if (linkedLocked(clip)) return notify("关联轨道已锁定，请先解锁");
    checkpoint();
    const previousStart = clip.start;
    const previousSpeed = clip.speed;
    Object.assign(clip, patch);
    if (clip.text !== undefined) clip.name = clip.text.slice(0, 24) || "空字幕";
    const linked = project.value.clips.find((c) => c.id === clip.linkedId);
    if (linked) {
      if (patch.start !== undefined) linked.start += clip.start - previousStart;
      if (patch.speed !== undefined) {
        linked.in = clip.in;
        linked.speed *= clip.speed / previousSpeed;
        linked.out = Math.min(
          assets.value.find((a) => a.id === linked.assetId)?.duration ??
            Infinity,
          linked.in + clipDuration(clip) * linked.speed,
        );
      }
      if (patch.text !== undefined && linked.assetId) {
        project.value.clips = project.value.clips.filter(
          (c) => c.id !== linked.id,
        );
        clip.linkedId = undefined;
        notify("字幕已更新，请重新生成配音");
      }
    }
  }
  function removeSelected() {
    if (!selected.value || selectedTrack.value?.locked) return;
    if (linkedLocked(selected.value)) return notify("关联轨道已锁定，请先解锁");
    checkpoint();
    const ids = [selected.value.id, selected.value.linkedId];
    project.value.clips = project.value.clips.filter(
      (c) => !ids.includes(c.id),
    );
    selectedId.value = "";
  }
  function split() {
    const clip = selected.value;
    if (!clip || selectedTrack.value?.locked) return;
    if (linkedLocked(clip)) return notify("关联轨道已锁定，请先解锁");
    const parts = splitClip(JSON.parse(JSON.stringify(clip)), time.value);
    if (!parts) return notify("请将播放头移到片段中间");
    checkpoint();
    const linked = project.value.clips.find((c) => c.id === clip.linkedId);
    const linkedParts = linked
      ? splitClip(JSON.parse(JSON.stringify(linked)), time.value)
      : null;
    if (linked && linkedParts) {
      parts[0].linkedId = linkedParts[0].id;
      parts[1].linkedId = linkedParts[1].id;
      linkedParts[0].linkedId = parts[0].id;
      linkedParts[1].linkedId = parts[1].id;
    } else {
      parts.forEach((p) => (p.linkedId = undefined));
    }
    const removed = new Set([
      clip.id,
      ...(linkedParts && linked ? [linked.id] : []),
    ]);
    project.value.clips = [
      ...project.value.clips.filter((c) => !removed.has(c.id)),
      ...(linkedParts || []),
      ...parts,
    ];
    selectedId.value = parts[1].id;
  }
  async function separate() {
    const clip = selected.value;
    const asset = assets.value.find((a) => a.id === clip?.assetId);
    if (
      !clip ||
      !asset ||
      asset.kind !== "video" ||
      busy.value ||
      selectedTrack.value?.locked
    )
      return;
    playing.value = false;
    busy.value = true;
    try {
      const audio = await readAsset(
        await extractAudio(asset, (s) => (status.value = s)),
        asset.name.replace(/\.[^.]+$/, "") + " · 音轨.wav",
      );
      assets.value.push(audio);
      const added = putAsset(audio, clip.start);
      Object.assign(added, {
        in: clip.in,
        out: clip.out,
        speed: clip.speed,
        volume: clip.volume,
      });
      clip.volume = 0;
      selectedId.value = clip.id;
      notify("音轨已分离，视频原声已静音");
    } catch (error) {
      notify(error instanceof Error ? error.message : "分离失败");
    } finally {
      busy.value = false;
      status.value = "";
    }
  }
  function toggleTrack(id: string, prop: "muted" | "hidden" | "locked") {
    checkpoint();
    const track = project.value.tracks.find((t) => t.id === id)!;
    track[prop] = !track[prop];
  }
  async function demo() {
    if (busy.value) return;
    busy.value = true;
    status.value = "正在本地生成 6 秒示例项目…";
    try {
      const { video, audio } = await makeDemo();
      const start = duration.value;
      assets.value.push(video, audio);
      putAsset(video, start);
      putAsset(audio, start);
      time.value = start + 0.1;
      addSubtitle();
      updateClip({
        text: "慢下来，听见山野的声音。",
        start: start + 0.5,
        out: 5.2,
      });
      notify("示例已就绪，试试分割、变速或导出");
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "当前浏览器不支持生成示例",
      );
    } finally {
      busy.value = false;
      status.value = "";
    }
  }
  async function saveProject() {
    if (busy.value) return;
    busy.value = true;
    playing.value = false;
    status.value = "正在准备保存工程…";
    const capturedProject = JSON.parse(
      JSON.stringify(project.value),
    ) as Project;
    const capturedAssets = [...assets.value];
    const name = `${capturedProject.name || "未命名项目"}.vcut`;
    type SaveHandle = { createWritable(): Promise<ProjectFileWritable> };
    const picker = (
      window as Window & {
        showSaveFilePicker?: (options: {
          suggestedName: string;
          types: { description: string; accept: Record<string, string[]> }[];
        }) => Promise<SaveHandle>;
      }
    ).showSaveFilePicker;
    try {
      // Invoke the picker before the first await, while the user's click is active.
      const handle = picker
        ? await picker.call(window, {
            suggestedName: name,
            types: [
              {
                description: "VideoCup 工程",
                accept: { "application/x-videocup": [".vcut"] },
              },
            ],
          })
        : undefined;
      try {
        if (ready.value && !restoreError.value) {
          await saveWorkspace(capturedProject, capturedAssets);
          saveState.value = "已保存至本地";
        }
      } catch {
        saveState.value = "本地存储写入失败，请保留工程文件";
      }
      if (handle) {
        status.value = "正在保存工程文件…";
        await writeProjectToFile(
          capturedProject,
          capturedAssets,
          await handle.createWritable(),
          ({ written, total }) => {
            status.value = `保存工程 ${Math.floor((written / Math.max(1, total)) * 100)}% · ${(written / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`;
          },
        );
        notify("工程已保存，包含全部素材和剪辑记录");
      } else {
        const blob = await packProject(capturedProject, capturedAssets);
        if (projectFileResult.value)
          URL.revokeObjectURL(projectFileResult.value.url);
        projectFileResult.value = {
          url: URL.createObjectURL(blob),
          name,
          size: blob.size,
        };
        modal.value = "project-save";
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError"))
        notify(
          error instanceof Error
            ? error.message
            : "工程保存失败，原编辑记录仍保留在本地",
        );
    } finally {
      busy.value = false;
      status.value = "";
    }
  }
  async function openProject(file: File) {
    if (busy.value) return;
    busy.value = true;
    playing.value = false;
    try {
      const data = await unpackProject(file);
      checkpoint();
      assets.value.forEach((a) => URL.revokeObjectURL(a.url));
      assets.value = data.assets;
      project.value = data.project;
      restoreError.value = "";
      ready.value = true;
      history.value = [];
      future.value = [];
      time.value = 0;
      selectedId.value = "";
      notify("工程已打开");
    } catch (error) {
      notify(error instanceof Error ? error.message : "打开工程失败");
    } finally {
      busy.value = false;
    }
    for (const asset of assets.value.filter((a) => /\.mov$/i.test(a.name)))
      await repairPreview(asset.id, true);
  }
  function resetProject() {
    playing.value = false;
    project.value = newProject();
    restoreError.value = "";
    ready.value = true;
    assets.value.forEach((a) => URL.revokeObjectURL(a.url));
    assets.value = [];
    history.value = [];
    future.value = [];
    selectedId.value = "";
    time.value = 0;
    modal.value = "";
    notify("已创建新项目");
  }
  async function generateVoice() {
    const clip = selected.value;
    if (
      !clip?.text?.trim() ||
      voiceBusy.value ||
      busy.value ||
      selectedTrack.value?.locked
    )
      return;
    if (
      !config.endpoint ||
      (speechProvider(config.providerId).capabilities.model && !config.model)
    ) {
      modal.value = "settings";
      return;
    }
    voiceBusy.value = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 120000);
    const text = clip.text;
    try {
      const settings = { ...config };
      const result = await synthesizeSpeech(
        {
          text,
          voice: settings.voice,
          language: settings.language,
          style: settings.style,
          rate: settings.rate,
          pitch: settings.pitch,
          volume: settings.volume,
        },
        settings,
        controller.signal,
      );
      const asset = await readAsset(
        result.blob,
        `AI 配音 · ${text.slice(0, 12)}.${result.extension}`,
      );
      if (
        clip.text !== text ||
        !project.value.clips.some((c) => c.id === clip.id)
      ) {
        URL.revokeObjectURL(asset.url);
        throw new Error("字幕已变化，请重新生成");
      }
      checkpoint();
      if (clip.linkedId)
        project.value.clips = project.value.clips.filter(
          (c) => c.id !== clip.linkedId,
        );
      assets.value.push(asset);
      const track =
        project.value.tracks.find(
          (t) =>
            t.kind === "audio" &&
            !t.locked &&
            !project.value.clips.some(
              (c) =>
                c.trackId === t.id &&
                c.start < clip.start + asset.duration &&
                endOf(c) > clip.start,
            ),
        ) || addTrack("audio");
      const audio = createClip(track.id, asset, clip.start);
      audio.linkedId = clip.id;
      clip.linkedId = audio.id;
      clip.in = 0;
      clip.out = asset.duration;
      clip.speed = 1;
      project.value.clips.push(audio);
      notify("配音已生成，字幕时长已与语音对齐");
      modal.value = "";
    } catch (error) {
      notify(
        error instanceof Error
          ? error.message
          : "配音请求失败，请检查接口的跨域配置",
      );
    } finally {
      clearTimeout(timeout);
      voiceBusy.value = false;
    }
  }
  function clearExportResult() {
    if (exportResult.value?.nativeJobId)
      discardNativeExport(exportResult.value.nativeJobId);
    else if (exportResult.value) URL.revokeObjectURL(exportResult.value.url);
    exportResult.value = null;
  }
  async function runExport() {
    if (!duration.value || busy.value) return;
    playing.value = false;
    busy.value = true;
    progress.value = 0;
    exportError.value = "";
    exportCancelled = false;
    clearExportResult();
    exportController = new AbortController();
    const signal = exportController.signal;
    try {
      if (ready.value && !restoreError.value)
        await saveWorkspace(project.value, assets.value);
      signal.throwIfAborted();
      const height = Number(exportOptions.resolution);
      const ratio = project.value.width / project.value.height;
      const width = Math.round((height * ratio) / 2) * 2;
      const captured = JSON.parse(JSON.stringify(project.value)) as Project;
      const media = [...assets.value];
      const options = {
        width,
        height,
        audioOnly: exportOptions.audioOnly,
        subtitles: exportOptions.subtitles,
        quality: exportOptions.quality,
      };
      status.value = "正在检测本机加速…";
      const native =
        exportOptions.engine !== "browser" &&
        (await nativeCapabilities(signal)).available;
      signal.throwIfAborted();
      const name = `${captured.name}.${options.audioOnly ? "mp3" : "mp4"}`;
      if (native) {
        const result = await nativeExport(
          captured,
          media,
          options,
          (s) => (status.value = s),
          (n) => (progress.value = n),
          signal,
        );
        exportResult.value = {
          url: result.url,
          name,
          size: result.size,
          nativeJobId: result.jobId,
        };
      } else {
        status.value = "正在使用浏览器兼容模式导出…";
        const blob = await exportMedia(
          captured,
          media,
          options,
          (s) => (status.value = s),
          (n) => (progress.value = n),
        );
        signal.throwIfAborted();
        exportResult.value = {
          url: URL.createObjectURL(blob),
          name,
          size: blob.size,
        };
      }
      notify("导出完成，点击下载文件保存到设备");
    } catch (error) {
      if (exportCancelled) {
        exportError.value = "";
        notify("导出已取消");
        return;
      }
      exportError.value =
        error instanceof Error ? error.message : String(error);
      console.error("Export failed", error);
      notify(exportError.value);
    } finally {
      exportController = undefined;
      busy.value = false;
      status.value = "";
    }
  }
  function cancelExport() {
    exportCancelled = true;
    exportController?.abort();
    cancelEngine();
    notify("导出已取消");
  }
  const persist = () => {
    if (!ready.value) return;
    saveState.value = "保存中…";
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      void saveWorkspace(project.value, assets.value)
        .then(() => (saveState.value = "已保存至本地"))
        .catch(() => (saveState.value = "自动保存失败，请下载工程"));
    }, 700);
  };
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (saveState.value !== "保存中…" && !busy.value) return;
    event.preventDefault();
    event.returnValue = "";
  };
  watch(project, persist, { deep: true });
  watch(assets, persist, { deep: true });
  watch(duration, (d) => {
    if (time.value > d && d > 0) time.value = d;
  });
  onMounted(async () => {
    window.addEventListener("beforeunload", beforeUnload);
    try {
      Object.assign(
        config,
        migrateSpeechConfig(
          JSON.parse(localStorage.getItem("videocup-tts") || "{}"),
        ),
      );
    } catch {
      /* Ignore invalid stored settings. */
    }
    try {
      const data = await loadWorkspace();
      if (!alive) {
        data?.assets.forEach((a) => URL.revokeObjectURL(a.url));
        return;
      }
      if (data) {
        project.value = data.project;
        assets.value = data.assets;
      }
    } catch {
      restoreError.value =
        "本地工程读取失败，已暂停自动保存以保护原记录。请保留当前页面和备份文件，不要新建工程。";
      saveState.value = "原记录受保护，自动保存已暂停";
      notify(restoreError.value);
      return;
    }
    ready.value = true;
    for (const asset of assets.value.filter((a) => /\.mov$/i.test(a.name)))
      await repairPreview(asset.id, true);
  });
  onBeforeUnmount(() => {
    window.removeEventListener("beforeunload", beforeUnload);
    if (ready.value)
      void saveWorkspace(project.value, assets.value).catch(() => undefined);
    alive = false;
    exportController?.abort();
    clearExportResult();
    if (projectFileResult.value)
      URL.revokeObjectURL(projectFileResult.value.url);
    clearTimeout(saveTimer);
    clearTimeout(toastTimer);
    assets.value.forEach((a) => URL.revokeObjectURL(a.url));
  });
  return {
    project,
    assets,
    selectedId,
    time,
    playing,
    zoom,
    snapping,
    query,
    filter,
    library,
    modal,
    toast,
    busy,
    status,
    progress,
    saveState,
    restoreError,
    projectFileResult,
    config,
    exportOptions,
    voiceBusy,
    exportError,
    exportResult,
    clearExportResult,
    selected,
    selectedTrack,
    selectedAsset,
    duration,
    timelineLength,
    filteredAssets,
    subtitles,
    history,
    future,
    notify,
    checkpoint,
    undo,
    redo,
    addTrack,
    putAsset,
    importFiles,
    repairPreview,
    addSubtitle,
    updateClip,
    removeSelected,
    split,
    separate,
    toggleTrack,
    demo,
    saveProject,
    openProject,
    resetProject,
    generateVoice,
    runExport,
    cancelExport,
  };
}
export type Editor = import("vue").UnwrapNestedRefs<
  ReturnType<typeof useEditor>
>;
