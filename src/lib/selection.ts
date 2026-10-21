import type { Asset, Clip, ClipTransform, Project } from "./types";
import { subtitleCanvas } from "./media";
import { getVisualGeometry, normalizeTransform } from "./transform";
export interface SelectionBox {
  cx: number;
  cy: number;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  rotation: number;
}
const textBounds = new Map<
  string,
  { cx: number; cy: number; width: number; height: number }
>();
export function rotatePoint(x: number, y: number, degrees: number) {
  const radians = (degrees * Math.PI) / 180;
  return {
    x: x * Math.cos(radians) - y * Math.sin(radians),
    y: x * Math.sin(radians) + y * Math.cos(radians),
  };
}
export function getSelectionGeometry(
  clip: Clip,
  asset: Asset | undefined,
  project: Project,
): SelectionBox {
  const t = normalizeTransform(clip.transform);
  const geometry = getVisualGeometry(clip, asset, project);
  if (clip.text === undefined)
    return { ...geometry, offsetX: 0, offsetY: 0, rotation: t.rotation };
  const key = JSON.stringify([
    clip.text,
    clip.fontSize,
    project.width,
    project.height,
  ]);
  let bounds = textBounds.get(key);
  if (!bounds) {
    // Use the pixels from the same renderer as preview/export, including outlines
    // and wrapped Chinese text; a transparent full-frame PNG is not a hit target.
    const canvas = subtitleCanvas(
      clip.text,
      project.width,
      project.height,
      clip.fontSize,
      "#ffffff",
    );
    const pixels = canvas
      .getContext("2d")!
      .getImageData(0, 0, canvas.width, canvas.height).data;
    let left = canvas.width,
      right = -1,
      top = canvas.height,
      bottom = -1;
    for (let y = 0; y < canvas.height; y++)
      for (let x = 0; x < canvas.width; x++)
        if (pixels[(y * canvas.width + x) * 4 + 3]! > 16) {
          left = Math.min(left, x);
          right = Math.max(right, x);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
    bounds =
      right >= left
        ? {
            cx: (left + right + 1) / 2,
            cy: (top + bottom + 1) / 2,
            width: right - left + 1,
            height: bottom - top + 1,
          }
        : {
            cx: project.width / 2,
            cy: project.height * 0.9,
            width: Math.max(50, clip.fontSize),
            height: Math.max(30, clip.fontSize),
          };
    if (textBounds.size > 30) textBounds.clear();
    textBounds.set(key, bounds);
  }
  const offsetX = bounds.cx - project.width / 2,
    offsetY = bounds.cy - project.height / 2;
  const delta = rotatePoint(offsetX * t.scaleX, offsetY * t.scaleY, t.rotation);
  return {
    cx: geometry.cx + delta.x,
    cy: geometry.cy + delta.y,
    width: bounds.width * t.scaleX,
    height: bounds.height * t.scaleY,
    offsetX,
    offsetY,
    rotation: t.rotation,
  };
}
export function transformAtSelectionCenter(
  transform: ClipTransform,
  center: { x: number; y: number },
  offset: { x: number; y: number },
  project: Pick<Project, "width" | "height">,
): ClipTransform {
  const delta = rotatePoint(
    offset.x * transform.scaleX,
    offset.y * transform.scaleY,
    transform.rotation,
  );
  return normalizeTransform({
    ...transform,
    x: ((center.x - delta.x) / project.width) * 100,
    y: ((center.y - delta.y) / project.height) * 100,
  });
}
export function containsPoint(
  box: Pick<SelectionBox, "cx" | "cy" | "width" | "height" | "rotation">,
  point: { x: number; y: number },
  padding = 0,
) {
  const local = rotatePoint(point.x - box.cx, point.y - box.cy, -box.rotation);
  return (
    Math.abs(local.x) <= box.width / 2 + padding &&
    Math.abs(local.y) <= box.height / 2 + padding
  );
}
