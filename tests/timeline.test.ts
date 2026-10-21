import { describe, expect, it } from "vitest";
import {
  clipDuration,
  createClip,
  endOf,
  newProject,
  splitClip,
  srt,
} from "../src/lib/types";
import { tempo } from "../src/lib/ffmpeg";
import type { Asset } from "../src/lib/types";
const asset: Asset = {
  id: "media",
  name: "source.mp4",
  kind: "video",
  duration: 20,
  width: 1920,
  height: 1080,
  blob: new Blob(),
  url: "blob:test",
};
describe("timeline source and sequence time", () => {
  it("splits a trimmed, accelerated clip without losing or duplicating source frames", () => {
    const c = { ...createClip("video", asset, 3), in: 4, out: 16, speed: 2 };
    const [a, b] = splitClip(c, 5)!;
    expect([a.in, a.out, b.in, b.out]).toEqual([4, 8, 8, 16]);
    expect(endOf(a)).toBe(b.start);
    expect(endOf(b)).toBe(endOf(c));
    expect(clipDuration(a) + clipDuration(b)).toBe(clipDuration(c));
    expect(b.id).not.toBe(a.id);
    expect(c.out).toBe(16);
  });
  it("rejects splitting at or outside clip boundaries", () => {
    const c = createClip("video", asset, 5);
    for (const t of [0, 5, 5.02, 24.98, 25, 30])
      expect(splitClip(c, t)).toBeNull();
  });
  it("serializes subtitles in chronological order using timeline speed and millisecond rounding", () => {
    const c = {
      ...createClip("s", undefined, 61.25),
      in: 2,
      out: 6,
      speed: 2,
      text: "你好\n世界",
    };
    const first = { ...c, start: 0, text: "开场" };
    expect(srt([c, first])).toBe(
      "1\n00:00:00,000 --> 00:00:02,000\n开场\n\n2\n00:01:01,250 --> 00:01:03,250\n你好\n世界\n",
    );
  });
  it("creates independent tracks for each new project", () => {
    const a = newProject(),
      b = newProject();
    expect(a.tracks.map((t) => t.kind)).toEqual(["subtitle", "video", "audio"]);
    expect(a.tracks[0]!.id).not.toBe(b.tracks[0]!.id);
  });
  it("builds valid chained audio tempo filters for the full supported speed range", () => {
    expect(tempo(0.25)).toBe("atempo=0.5,atempo=0.5");
    expect(tempo(4)).toBe("atempo=2,atempo=2");
    expect(tempo(1.5)).toBe("atempo=1.5");
  });
});
