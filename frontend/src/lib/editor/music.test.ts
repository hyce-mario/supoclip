import { describe, expect, it } from "vitest";

import type { EditDocument, MusicClip } from "./document";
import {
  addMusic,
  DUCK_LEVEL,
  duckFactor,
  musicGain,
  musicLength,
  musicPosition,
  placeMusic,
  speechSpans,
} from "./music";

const piece = (change: Partial<MusicClip> = {}): MusicClip => ({
  id: "m1",
  start: 0,
  end: 1.5,
  offset: 0,
  volume: 1,
  fadeIn: 0,
  fadeOut: 0,
  loop: false,
  track: { source: "library", id: "libabc", title: "Song", duration: 1 },
  ...change,
});

describe("music ducking (same numbers as backend tests/unit/test_editor_music.py)", () => {
  it("merges close words into spans of speech", () => {
    expect(speechSpans([{ start: 0, end: 0.4 }, { start: 0.6, end: 1 }, { start: 3, end: 3.5 }])).toEqual([
      [0, 1],
      [3, 3.5],
    ]);
  });

  it("ramps down before speech and back up after it", () => {
    const spans: [number, number][] = [[1, 2]];
    expect(duckFactor(spans, 0)).toBe(1);
    expect(duckFactor(spans, 1.5)).toBeCloseTo(DUCK_LEVEL);
    expect(duckFactor(spans, 0.875)).toBeCloseTo(1 - (1 - DUCK_LEVEL) * 0.5);
    expect(duckFactor(spans, 2.25)).toBeCloseTo(1 - (1 - DUCK_LEVEL) * 0.5);
    expect(duckFactor(spans, 3)).toBe(1);
  });
});

describe("music pieces", () => {
  it("stops a non-looping piece where the track ends and fades its edges", () => {
    expect(musicLength(piece({ end: 5 }), 1.5)).toBe(1);
    expect(musicLength(piece({ end: 5, loop: true }), 1.5)).toBe(1.5);
    const faded = piece({ fadeIn: 0.5, fadeOut: 0.5 });
    expect(musicGain(faded, 0.25, [], 10)).toBeCloseTo(0.5);
    expect(musicGain(faded, 0.5, [], 10)).toBeCloseTo(1);
    expect(musicGain(faded, 1.2, [], 10)).toBe(0);
    expect(musicPosition(piece({ loop: true, offset: 0.5 }), 1)).toBeCloseTo(0.5);
  });

  it("adds a track at the playhead, looping when it is shorter than the rest of the edit", () => {
    const doc = { segments: [{ id: "a", start: 0, end: 10 }], words: [] } as unknown as EditDocument;
    const { doc: next, id } = addMusic(doc, { source: "upload", id: "t1", title: "Mine", duration: 4 }, 2, "fixed");
    expect(id).toBe("fixed");
    expect(next.music?.[0]).toMatchObject({ start: 2, end: 10, loop: true, offset: 0 });
    const long = addMusic(doc, { source: "library", id: "t2", title: "Long", duration: 60 }, 0, "x").doc;
    expect(long.music?.[0]).toMatchObject({ start: 0, end: 10, loop: false });
  });

  it("moves and trims on the timeline, keeping the song in place when the start moves", () => {
    const song = piece({ start: 2, end: 6, track: { source: "library", id: "x", title: "", duration: 30 } });
    expect(placeMusic(song, "move", 3, 10)).toMatchObject({ start: 5, end: 9 });
    expect(placeMusic(song, "start", 1, 10)).toMatchObject({ start: 3, offset: 1, end: 6 });
    // The start can't move before the song's beginning.
    expect(placeMusic(song, "start", -5, 10)).toMatchObject({ start: 2, offset: 0 });
    expect(placeMusic(song, "end", -10, 10).end).toBeCloseTo(2.5);
  });
});
