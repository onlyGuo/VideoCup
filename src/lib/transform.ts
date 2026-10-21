import type { Asset, Clip, ClipTransform, Project } from "./types.ts";

export const TRANSFORM_LIMITS = {
  minPosition: -200,
  maxPosition: 300,
  minScale: 0.05,
  maxScale: 4,
} as const;

const finite = (value: number | undefined, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

/** Defaults also preserve the appearance of projects saved before transforms existed. */
export function normalizeTransform(
  transform?: Partial<ClipTransform>,
): ClipTransform {
  const rotation = finite(transform?.rotation, 0);
  return {
    x: clamp(
      finite(transform?.x, 50),
      TRANSFORM_LIMITS.minPosition,
      TRANSFORM_LIMITS.maxPosition,
    ),
    y: clamp(
      finite(transform?.y, 50),
      TRANSFORM_LIMITS.minPosition,
      TRANSFORM_LIMITS.maxPosition,
    ),
    scaleX: clamp(
      finite(transform?.scaleX, 1),
      TRANSFORM_LIMITS.minScale,
      TRANSFORM_LIMITS.maxScale,
    ),
    scaleY: clamp(
      finite(transform?.scaleY, 1),
      TRANSFORM_LIMITS.minScale,
      TRANSFORM_LIMITS.maxScale,
    ),
    rotation: ((((rotation + 180) % 360) + 360) % 360) - 180,
  };
}

/** Source-space crop shared by the canvas preview and FFmpeg export. */
export function getSourceCrop(clip: Clip, width: number, height: number) {
  const x = clamp(finite(clip.crop?.x, 0), 0, 99.9);
  const y = clamp(finite(clip.crop?.y, 0), 0, 99.9);
  return {
    x: (width * x) / 100,
    y: (height * y) / 100,
    width: (width * clamp(finite(clip.crop?.width, 100), 0.1, 100 - x)) / 100,
    height:
      (height * clamp(finite(clip.crop?.height, 100), 0.1, 100 - y)) / 100,
  };
}

/**
 * Unrotated visible rectangle in project pixels, with scale already applied.
 * Subtitles transform their transparent project-sized canvas about its center.
 */
export function getVisualGeometry(
  clip: Clip,
  asset: Pick<Asset, "width" | "height"> | undefined,
  project: Pick<Project, "width" | "height">,
) {
  const transform = normalizeTransform(clip.transform);
  let width = project.width;
  let height = project.height;
  if (clip.text === undefined && asset && asset.width > 0 && asset.height > 0) {
    const crop = getSourceCrop(clip, asset.width, asset.height);
    const contain = Math.min(
      project.width / crop.width,
      project.height / crop.height,
    );
    width = crop.width * contain;
    height = crop.height * contain;
  }
  return {
    cx: (project.width * transform.x) / 100,
    cy: (project.height * transform.y) / 100,
    width: width * transform.scaleX,
    height: height * transform.scaleY,
  };
}

const num = (n: number) => Number(n.toFixed(6)).toString();

/** Transparent element filter; overlay at its center without a canvas-sized pad. */
export function getVisualFilter(
  clip: Clip,
  asset: Pick<Asset, "width" | "height"> | undefined,
  project: Pick<Project, "width" | "height">,
  rendering?: { opaque?: boolean },
) {
  const geometry = getVisualGeometry(clip, asset, project);
  const transform = normalizeTransform(clip.transform);
  let cx = geometry.cx;
  let cy = geometry.cy;
  let invisible = false;
  const opaque =
    rendering?.opaque === true && transform.rotation === 0 && clip.opacity >= 1;
  const filters = [opaque ? "format=yuv420p" : "format=rgba"];
  if (clip.text === undefined && asset) {
    const crop = getSourceCrop(clip, asset.width, asset.height);
    filters.push(
      `crop=${num(crop.width)}:${num(crop.height)}:${num(crop.x)}:${num(crop.y)}:exact=1`,
    );
  }
  // RGBA permits odd sizes; the final composed frame is converted to yuv420p.
  filters.push(
    `scale=${Math.max(1, Math.round(geometry.width))}:${Math.max(1, Math.round(geometry.height))}`,
    "setsar=1",
  );
  // A 4× full-HD layer can otherwise rotate into a 288 MB RGBA frame.
  // Discard pixels outside the inverse-projected viewport before rotation.
  // Keep a two-pixel border for interpolation at the visible edges.
  const scaledWidth = Math.max(1, Math.round(geometry.width));
  const scaledHeight = Math.max(1, Math.round(geometry.height));
  if (scaledWidth > project.width * 2 || scaledHeight > project.height * 2) {
    const radians = (transform.rotation * Math.PI) / 180;
    const cos = Math.cos(radians),
      sin = Math.sin(radians);
    const points = [
      [0, 0],
      [project.width, 0],
      [0, project.height],
      [project.width, project.height],
    ];
    const xs = points.map(
      ([x, y]) => cos * (x! - cx) + sin * (y! - cy) + scaledWidth / 2,
    );
    const ys = points.map(
      ([x, y]) => -sin * (x! - cx) + cos * (y! - cy) + scaledHeight / 2,
    );
    const left = Math.max(0, Math.floor(Math.min(...xs)) - 2);
    const top = Math.max(0, Math.floor(Math.min(...ys)) - 2);
    const right = Math.min(scaledWidth, Math.ceil(Math.max(...xs)) + 2);
    const bottom = Math.min(scaledHeight, Math.ceil(Math.max(...ys)) + 2);
    if (right <= left || bottom <= top) {
      filters.push("crop=1:1:0:0:exact=1");
      invisible = true;
    } else {
      const width = right - left,
        height = bottom - top;
      filters.push(`crop=${width}:${height}:${left}:${top}:exact=1`);
      const dx = left + width / 2 - scaledWidth / 2;
      const dy = top + height / 2 - scaledHeight / 2;
      cx += cos * dx - sin * dy;
      cy += sin * dx + cos * dy;
    }
  }
  if (transform.rotation !== 0) {
    const angle = `${num(transform.rotation)}*PI/180`;
    filters.push(
      `rotate=${angle}:ow='ceil(rotw(${angle}))':oh='ceil(roth(${angle}))':c=none`,
    );
  }
  if (!opaque)
    filters.push(`colorchannelmixer=aa=${num(invisible ? 0 : clip.opacity)}`);
  return {
    filter: filters.join(","),
    x: `${num(cx)}-overlay_w/2`,
    y: `${num(cy)}-overlay_h/2`,
  };
}
