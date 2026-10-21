import { describe, expect, it } from "vitest";
import {
  containsPoint,
  rotatePoint,
  transformAtSelectionCenter,
} from "../src/lib/selection";
import { normalizeTransform } from "../src/lib/transform";
describe("preview selection geometry", () => {
  it("hit-tests in the rotated element coordinate system", () => {
    const box = { cx: 100, cy: 100, width: 100, height: 20, rotation: 90 };
    expect(containsPoint(box, { x: 100, y: 140 })).toBe(true);
    expect(containsPoint(box, { x: 140, y: 100 })).toBe(false);
  });
  it("keeps a subtitle visual center fixed while scaling its transparent canvas", () => {
    const t = transformAtSelectionCenter(
      { ...normalizeTransform(), scaleX: 2, scaleY: 2 },
      { x: 960, y: 960 },
      { x: 0, y: 420 },
      { width: 1920, height: 1080 },
    );
    expect(t.x).toBe(50);
    expect((t.y * 1080) / 100 + 420 * t.scaleY).toBeCloseTo(960);
  });
  it("keeps the text center fixed while rotating about the selection", () => {
    const t = transformAtSelectionCenter(
      { ...normalizeTransform(), rotation: 90 },
      { x: 960, y: 960 },
      { x: 0, y: 420 },
      { width: 1920, height: 1080 },
    );
    const offset = rotatePoint(0, 420, t.rotation);
    expect((t.x * 1920) / 100 + offset.x).toBeCloseTo(960);
    expect((t.y * 1080) / 100 + offset.y).toBeCloseTo(960);
  });
  it("preserves a video center because its content has no transparent offset", () => {
    const t = transformAtSelectionCenter(
      { ...normalizeTransform(), scaleX: 0.5, rotation: -30 },
      { x: 480, y: 270 },
      { x: 0, y: 0 },
      { width: 1920, height: 1080 },
    );
    expect(t).toMatchObject({ x: 25, y: 25, scaleX: 0.5, rotation: -30 });
  });
});
