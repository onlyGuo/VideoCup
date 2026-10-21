import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { edgeTtsPlugin } from "./server/vite-edge.ts";
import { nativeExportPlugin } from "./server/vite-native-export.ts";
export default defineConfig({
  plugins: [vue(), edgeTtsPlugin(), nativeExportPlugin()],
  optimizeDeps: { exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/core"] },
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
