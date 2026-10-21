import { describe, expect, it } from "vitest";
import { createClip, newProject } from "../src/lib/types";
import type { Asset, ClipTransform } from "../src/lib/types";
import {
  getSourceCrop,
  getVisualFilter,
  getVisualGeometry,
  normalizeTransform,
} from "../src/lib/transform";
import { unpackProject } from "../src/lib/storage";

const asset: Asset = {
  id: "video",
  name: "portrait.mov",
  kind: "video",
  blob: new Blob(),
  url: "blob:video",
  duration: 3,
  width: 1080,
  height: 1920,
};

describe("visual transforms", () => {
  it("preserves old projects and fits a cropped portrait video before applying scale", () => {
    const project = newProject();
    const clip = createClip(project.tracks[1]!.id, asset);
    delete clip.transform;
    expect(getVisualGeometry(clip, asset, project)).toEqual({
      cx: 960,
      cy: 540,
      width: 607.5,
      height: 1080,
    });
    clip.crop = { x: 0, y: 25, width: 100, height: 50 };
    clip.transform = { x: 25, y: 75, scaleX: 2, scaleY: 0.5, rotation: 30 };
    expect(getVisualGeometry(clip, asset, project)).toEqual({
      cx: 480,
      cy: 810,
      width: 2430,
      height: 540,
    });
  });

  it("keeps position and size proportional when the export resolution changes", () => {
    const clip = createClip("video", asset);
    clip.transform = { x: 30, y: 40, scaleX: 0.5, scaleY: 0.75, rotation: 45 };
    const full = getVisualGeometry(clip, asset, { width: 1920, height: 1080 });
    const half = getVisualGeometry(clip, asset, { width: 960, height: 540 });
    expect(half).toEqual({
      cx: full.cx / 2,
      cy: full.cy / 2,
      width: full.width / 2,
      height: full.height / 2,
    });
  });

  it("transforms subtitles about the same full-canvas center used by the preview", () => {
    const clip = createClip("subtitle", undefined);
    clip.text = "字幕";
    clip.transform = { x: 20, y: 30, scaleX: 0.6, scaleY: 0.7, rotation: -15 };
    expect(
      getVisualGeometry(clip, undefined, { width: 1000, height: 500 }),
    ).toEqual({
      cx: 200,
      cy: 150,
      width: 600,
      height: 350,
    });
    const ff = getVisualFilter(clip, undefined, { width: 1000, height: 500 });
    expect(ff.filter).toContain("scale=600:350");
    expect(ff.filter).toContain("rotate=-15*PI/180");
    expect(ff.filter).toContain(":c=none");
    expect(ff.filter).not.toContain("crop=");
    expect(ff.x).toBe("200-overlay_w/2");
    expect(ff.y).toBe("150-overlay_h/2");
  });

  it("exports transparent rotated element bounds without covering lower video layers", () => {
    const clip = createClip("video", asset);
    clip.transform = { x: 70, y: 40, scaleX: 0.4, scaleY: 0.4, rotation: 30 };
    clip.opacity = 0.5;
    const ff = getVisualFilter(clip, asset, { width: 1920, height: 1080 });
    expect(ff.filter).toContain("format=rgba,crop=1080:1920:0:0:exact=1");
    expect(ff.filter).toContain("scale=243:432");
    expect(ff.filter).toContain("ow='ceil(rotw(30*PI/180))'");
    expect(ff.filter).toContain("colorchannelmixer=aa=0.5");
    expect(ff.filter).not.toContain("pad=");
    expect(ff.x).toBe("1344-overlay_w/2");
    expect(ff.y).toBe("432-overlay_h/2");
  });

  it("normalizes incomplete values and contains source crops within the media", () => {
    expect(
      normalizeTransform({
        x: NaN,
        y: 500,
        scaleX: -1,
        scaleY: Infinity,
        rotation: 450,
      }),
    ).toEqual({
      x: 50,
      y: 300,
      scaleX: 0.05,
      scaleY: 1,
      rotation: 90,
    });
    const clip = createClip("video", asset);
    clip.crop = { x: 75, y: 90, width: 80, height: 50 };
    expect(getSourceCrop(clip, 1000, 500)).toEqual({
      x: 750,
      y: 450,
      width: 250,
      height: 50,
    });
  });
});

describe("transform project import", () => {
  function file(transform: ClipTransform | undefined) {
    const project = newProject();
    const clip = createClip(project.tracks[0]!.id, undefined);
    clip.text = "字幕";
    clip.transform = transform;
    project.clips.push(clip);
    return new File(
      [JSON.stringify({ version: 1, project, assets: [] })],
      "project.vcut",
    );
  }

  it("restores the default transform for legacy project files", async () => {
    const data = await unpackProject(file(undefined));
    expect(data.project.clips[0]!.transform).toEqual(normalizeTransform());
  });

  it.each([
    { scaleX: 0 },
    { scaleY: -1 },
    { scaleX: 100 },
    { x: 301 },
    { rotation: Infinity },
  ])("rejects invalid imported element transforms: %j", async (patch) => {
    await expect(
      unpackProject(file({ ...normalizeTransform(), ...patch })),
    ).rejects.toThrow("无效的元素变换");
  });
});
