<script setup lang="ts" vapor>
withDefaults(defineProps<{ name: string; size?: number }>(), { size: 18 });
const paths: Record<string, string> = {
  folder: "M3 7V5a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v12H3V7Z",
  video: "M4 4h16v16H4z M4 8h16M4 16h16M8 4v4m8-4v4M8 16v4m8-4v4",
  image: "M3 3h18v18H3ZM3 17l6-6 4 4 3-3 5 5M8 8h.01",
  music:
    "M9 18V5l12-2v13M9 8l12-2M9 18c0 2-6 3-6 0s6-3 6 0Zm12-2c0 2-6 3-6 0s6-3 6 0Z",
  text: "M4 5h16M12 5v15M8 20h8",
  upload: "M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6",
  download: "M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5",
  plus: "M12 5v14M5 12h14",
  search: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 6 6",
  chevron: "m9 5 7 7-7 7",
  chevrondown: "m6 9 6 6 6-6",
  close: "m6 6 12 12M6 18 18 6",
  play: "m7 4 14 8-14 8Z",
  pause: "M8 5v14M16 5v14",
  prev: "M5 5v14M19 5 7 12l12 7Z",
  next: "M19 5v14M5 5l12 7-12 7Z",
  undo: "M4 9h11a6 6 0 0 1 0 12M4 9l5-5M4 9l5 5",
  redo: "M20 9H9a6 6 0 0 0 0 12m11-12-5-5m5 5-5 5",
  scissors:
    "M4 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM4 14a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM7 8l14 12M7 16 21 4",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7",
  link: "m9 15 6-6M7 17l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2 0 1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0",
  unlink: "m4 4 16 16M8 8l-3 3a4 4 0 0 0 6 6l1-1m4-4 3-3a4 4 0 0 0-6-6l-1 1",
  volume: "M4 9h4l5-5v16l-5-5H4ZM17 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14",
  mute: "M4 9h4l5-5v16l-5-5H4ZM17 9l6 6m-6 0 6-6",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
  lock: "M5 10h14v11H5ZM8 10V6a4 4 0 0 1 8 0v4",
  unlock: "M5 10h14v11H5ZM8 10V6a4 4 0 0 1 8 0",
  sparkles:
    "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5ZM20 2v4m-2-2h4",
  settings: "M4 7h16M4 17h16M8 4v6m8 4v6",
  save: "M4 3h13l4 4v14H3V3h1ZM7 3v6h10V3M7 21v-8h10v8",
  check: "m5 12 4 4L19 6",
  shield: "M12 3 3 6v6c0 5 9 9 9 9s9-4 9-9V6ZM8 12l3 3 5-6",
  zoom: "M4 8V4h4m8 0h4v4M4 16v4h4m8 0h4v-4",
  minus: "M5 12h14",
  magnet: "M4 4v10a8 8 0 0 0 16 0V4h-5v10a3 3 0 0 1-6 0V4ZM4 9h5m6 0h5",
  cursor: "m5 3 14 10-7 1-3 7Z",
  help: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM9 8a3 3 0 1 1 5 2c-2 1-2 2-2 4m0 3v1",
  monitor: "M3 4h18v13H3ZM12 17v4m-5 0h10",
  grid: "M3 3h7v7H3Zm11 0h7v7h-7ZM3 14h7v7H3Zm11 0h7v7h-7Z",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-16v6l4 2",
  headphones: "M4 14v-3a8 8 0 0 1 16 0v3M4 12h3v9H3v-9h1Zm16 0h1v9h-4v-9Z",
  file: "M5 2h9l5 5v15H5ZM14 2v6h5M8 12h8m-8 4h8",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  wave: "M3 10v4m3-7v10m3-13v16m3-11v6m3-12v18m3-16v14m3-10v6",
  reset: "M3 11a9 9 0 1 1 2 7M3 4v7h7",
};
</script>
<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="paths[name] || paths.file" />
  </svg>
</template>
