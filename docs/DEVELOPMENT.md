# VideoCup 开发与架构说明

[← 返回项目首页](../README.md)

Vite 8 + Vue **3.6.0-rc.12 纯 Vapor Mode** + TypeScript 本地视频剪辑工作台，IDEA 风格暗色界面。素材与预览在本机浏览器处理，导出优先使用本机 FFmpeg 加速，浏览器 WASM 作为兼容模式；内置 Edge 配音通过本地 Node 服务联网合成。

## 启动

需要 Node.js 24 LTS（或支持所需 Web API 的 22.12+）。

```sh
npm install
npm run dev
```

打开终端显示的本地地址。`npm install` 会通过 `ffmpeg-static` 下载当前系统对应的 FFmpeg，用于本机加速导出。

```sh
npm test          # 包含真实 FFmpeg WASM 合成与解码回归测试
npm run build    # 类型检查与生产构建
npm run preview  # 预览生产构建，包含内置 Edge API 和本机导出 API
```

## 剪辑与预览

- 选择文件或拖放导入 MP4、MPV、MP3、MOV、M4V、WebM、WAV、OGG、M4A、AAC，以及 PNG、JPG、JPEG、WebP、GIF、BMP、AVIF 图片；双击素材或拖到对应轨道开始剪辑。新增片段时播放头会定位到片段起点。
- 图片放在视频轨道，默认显示 5 秒，可拖动右边缘或在右侧“显示时长”调整。支持裁剪、透明度、移动、缩放、旋转和导出；GIF 等格式作为静态首帧导入。
- 视频、音频、字幕多轨道，支持静音、隐藏、锁定。上方视频轨道覆盖下方，同轨后添加片段在上；字幕在视频之上。
- 移动、边缘裁剪、分割、吸附、时间线缩放、撤销重做；支持 0.25–4 倍速、音量、不透明度、画面裁剪和视频音轨分离。
- **点击预览中的视频、图片或字幕选择元素**。拖动元素调整位置，拖四角缩放，拖上方圆形手柄旋转。Shift 缩放保持比例，Shift 旋转以 15° 步进。右侧也可输入中心位置、缩放和角度，或一键重置。
- 字幕使用紧文字边界选择，透明背景不会挡住下层视频。变换模型与导出共用，移动、缩放和旋转会保留到成片中。
- MOV 导入验证非零画面尺寸及可绘制视频帧；只有时长/声音可读的素材会回退到本地 H.264/AAC MP4 转码。恢复旧工程中的 MOV 时也会检查。其他异常素材可在视频属性中点击“修复黑屏 / 转换兼容格式”。具体编码支持取决于浏览器与 FFmpeg 构建。
- Canvas 实时预览，静止时不持续重绘。导出 MP4（H.264/AAC）、MP3，可烧录字幕，也可单独下载 SRT。编码完成后点击“下载文件”。
- IndexedDB 自动保存，刷新后恢复。Ctrl/⌘ S 下载含所有素材的 `.vcut` 工程，使用“文件 → 打开工程”恢复。

## 内置 Edge 配音

默认实现基于 [ssrsss/ttsapi](https://github.com/ssrsss/ttsapi)，将其合成核心移植到本地服务。**不需要安装或打开 Edge 浏览器，不需要填写模型或服务密钥。** 默认晓晓，可在设置中选择 21 个中文声音候选、搜索音色、筛选语言、调节语速、音调、音量与风格候选，并生成试听。

- 语速 0.5–2 倍，音调 -50–50 Hz，编辑器音量 0–2 倍。
- 风格是上游候选，不保证每个声音支持全部风格。
- 本地服务单次最多 5,000 个 Unicode 字符，JSON 请求最多 64 KiB。
- 生成的音频加入独立轨道，与字幕自动对齐、关联。移动、变速、分割和删除联动；修改文字移除旧配音，需重新生成。解除关联后可单独剪辑。
- 高级连接可改为自部署 ttsapi Worker 的完整 `/v1/audio/speech` 地址。

合成需要联网，仅要合成的字幕文本发送到微软语音服务，视频素材不发送。上游可能限流、拒绝某些音色/风格或暂时不可用，界面会反馈错误；开源实现不代表上游无限额度或可用性保证。

Vite 插件同时在开发和 `vite preview` 中提供同源、本机 API：

```http
GET /api/edge/voices
POST /api/edge/speech
Content-Type: application/json
```

```json
{
  "input": "你好，这是我的字幕。",
  "voice": "zh-CN-XiaoxiaoNeural",
  "speed": 1,
  "pitch": "0",
  "volume": "0",
  "style": "general"
}
```

接口 `volume` 沿用仓库协议，是相对增量：`0` 不变、`-1` 静音、`0.25` 增加 25%；适配器会换算编辑器的绝对倍数。返回 MP3 或错误 JSON。SSML 会转义，不把普通字幕当作 SSML 执行。

## 配音扩展机制

`src/lib/tts/types.ts` 定义 `SpeechProvider`，统一 `listVoices()` 和 `synthesize()`，通过 `registerSpeechProvider()` 注册实现。界面按 capability 显示模型、语言、风格、音调与音量；新增服务无需修改字幕、时间线逻辑。

已有实现：

1. `edge-tts`：默认内置实现，兼容 ssrsss/ttsapi 请求协议。
2. `audio-speech`：已授权兼容服务，POST `{model,input,voice,response_format:"mp3",speed}`。
3. `json-speech`：自建后端协议，POST `{text,voice,language,style,rate,pitch,volume,format:"mp3"}`。

可配置音色列表接口，返回数组、`{voices:[...]}` 或 `{data:[...]}`。每项支持 `id`（或 `voice_id`）、`name`、`language`、`gender`、`description`、`styles`（字符串或 `{id,name}` 数组）；也可填自定义音色 ID。跨域接口需要 CORS。不同域名的音色接口不会收到合成服务的密钥。

服务选择和非敏感配置保存在浏览器；API Key 仅保留在页面内存，不写入本地存储或工程，刷新后需重新填写。

## 快捷键

| 操作                    | 快捷键               |
| ----------------------- | -------------------- |
| 播放 / 暂停             | Space                |
| 导入素材                | Ctrl / ⌘ I           |
| 保存工程                | Ctrl / ⌘ S           |
| 分割片段                | Ctrl / ⌘ B           |
| 撤销 / 重做             | Ctrl / ⌘ Z / Shift Z |
| 删除片段及关联音频/字幕 | Delete / Backspace   |
| 逐帧移动播放头          | ← / →                |
| 移动一秒                | Shift ← / →          |
| 切换吸附                | N                    |
| 取消预览选择            | Escape               |

## 部署与数据

单线程 FFmpeg WASM 内核约 32 MB，随构建打包，不依赖运行时 CDN。需要 HTTP(S)，不能直接以 `file://` 打开；确保 `.wasm` 返回 `application/wasm`，保留 Worker 资源。当前适合短视频，可处理大小和编码速度受 CPU/内存影响。

仅部署静态 `dist/` 不含内置 Edge API 和本机导出服务，导出自动回退到浏览器兼容模式。本机生产构建使用 `npm run preview`；静态托管需要填写自部署 ttsapi Worker 地址，或提供相应 Node 后端。开发服务器不用于公网生产服务。

自动保存属于当前站点数据，清理浏览器数据会移除该副本。新 `.vcut` 使用二进制容器直接保存原始素材，不转 Base64；仍兼容旧 JSON 工程。Edge/Chrome 优先使用文件选择器按 8 MiB 分块写盘，其他浏览器提供低内存 Blob 下载。旧工程没有变换字段时按居中、100%、零旋转显示。

## 结构与许可

- `src/lib/editor.ts`：状态、历史、导入与修复、字幕配音和导出。
- `src/lib/media.ts`、`preview.ts`：解码验证、波形、字幕和多轨预览。
- `src/lib/transform.ts`、`selection.ts`：共用几何与文字选框。
- `src/components/PreviewControls.vue`、`Inspector.vue`、`Timeline.vue`：可视化编辑。
- `src/lib/tts/`：服务接口、注册表与适配器。
- `server/edge-tts.ts`、`server/vite-edge.ts`：Edge 服务与 Vite API。
- `src/lib/storage.ts`：自动保存、工程文件、数据验证。

ssrsss/ttsapi 的 MIT 许可和来源说明保留在 [third_party/ttsapi](../third_party/ttsapi/README.md)。FFmpeg 内核及编解码器包含 GPL 组件，分发时需遵守依赖许可。

## 大工程保存与导出

保存工程采用 `VCUTBIN2` 二进制格式（小 JSON 元数据 + 原始媒体字节）。自动保存将媒体按版本单独保存，仅更新编辑元数据，事务失败保留原记录；首次升级永久保留 `recovery:before-v2`，同时保留 `previous` 恢复点。本地工程读取失败时暂停自动保存，避免空工程覆盖原记录。

浏览器兼容导出通过 WORKERFS 直接读取本地 Blob，不先复制整段素材到 WASM 内存；按视频切点和最长 12 秒窗口依次处理，短段视频使用相同参数编码、音频以无损 FLAC 暂存，最后复制视频码流并只编码一次最终 AAC/MP3。完成后释放 Worker，保留所有原素材与编辑状态。预览仅为当前活跃片段及最多 2 个临近视觉片段分配解码器、只缓存当前字幕，保存和导出期间暂停预览解码。

## 本机加速导出

导出方式默认“自动 · 优先本机加速”。开发服务器和 `npm run preview` 提供本机 FFmpeg 服务，使用原生多线程软件编码；macOS 优先尝试 VideoToolbox，硬件不可用时自动回退到 `libx264`。硬件初始化有开销，短片不一定比软件编码快。可手动选择“浏览器兼容模式”。

本机服务仅接收回环地址的同源请求，素材从浏览器流式传到本机临时任务目录，成片直接下载，不将大视频复制回浏览器内存；所有视频处理均在这台电脑完成。按视频切点和最长 30 秒窗口分段，最后复制视频码流、统一编码音频。取消只终止当前任务并清理其临时文件，不改工程和原素材。导出结果闲置 1 小时后清理，请及时下载。

可用环境变量 `VIDEOCUP_FFMPEG_PATH` 指定已安装的 FFmpeg；否则依次查找 `ffmpeg-static` 和系统 PATH。后端缺失或不支持时自动使用 WASM。

```http
GET /api/render/capabilities
POST /api/render/jobs
PUT /api/render/jobs/:jobId/assets/:assetId
PUT /api/render/jobs/:jobId/subtitles/:clipId
POST /api/render/jobs/:jobId/start
GET /api/render/jobs/:jobId/status
GET /api/render/jobs/:jobId/file
DELETE /api/render/jobs/:jobId
```

任务创建接收 `{project, assets: [{id,name,kind,size,duration,width,height}], options}`，返回所需素材和字幕 ID。素材和字幕分别以二进制流上传；状态返回阶段、进度、编码器和错误。接口不接受任意文件路径或执行命令。

`src/lib/export-plan.ts` 是浏览器与本机服务共用的时间轴合成计划；`src/lib/native-export.ts` 是前端任务客户端；`server/native-export.ts` 和 `server/vite-native-export.ts` 提供本机任务生命周期及 Vite 接入。FFmpeg 原生二进制和 WASM 均包含 GPL 组件，分发请遵守对应依赖许可。
