/**
 * Background music in the clip studio: placement and the gain curve.
 *
 * The gain of a piece at edit time `t` is volume × fades × duck(t). `duck`
 * dips to DUCK_LEVEL over speech (caption words on the edit timeline, merged
 * when the gap is too short to recover). The server export computes the same
 * curve in `backend/src/editor_music.py`; keep the two in step.
 */
import { clamp, editDuration, mappedWords, uid, type EditDocument, type MusicClip, type MusicTrackRef } from "./document";

export const DUCK_LEVEL = 0.3;
export const DUCK_ATTACK = 0.25;
export const DUCK_RELEASE = 0.5;
const DUCK_MERGE_GAP = DUCK_ATTACK + DUCK_RELEASE;
const MAX_DUCK_SPANS = 150;
export const MUSIC_MIN_SECONDS = 0.5;
export const DEFAULT_MUSIC_VOLUME = 0.3;

export type Span = [number, number];

export const musicOf = (doc: EditDocument) => doc.music ?? [];
export const musicDucks = (doc: EditDocument) => doc.musicDuck ?? true;

/** A track as the studio lists it. */
export interface MusicTrack extends MusicTrackRef {
  artist: string | null;
  category: string | null;
}

export const musicFileUrl = (track: Pick<MusicTrackRef, "source" | "id">) =>
  `/api/music/${track.source === "library" ? "library" : "uploads"}/${encodeURIComponent(track.id)}/file`;
export const musicTrackKey = (track: Pick<MusicTrackRef, "source" | "id">) => `${track.source}:${track.id}`;

/** Merged spans of speech in edit seconds. */
export function speechSpans(words: { start: number; end: number }[], mergeGap = DUCK_MERGE_GAP): Span[] {
  const spans: Span[] = [];
  for (const word of [...words].sort((a, b) => a.start - b.start)) {
    const last = spans[spans.length - 1];
    if (last && word.start - last[1] < mergeGap) last[1] = Math.max(last[1], word.end);
    else spans.push([word.start, word.end]);
  }
  if (spans.length > MAX_DUCK_SPANS) return speechSpans(spans.map(([start, end]) => ({ start, end })), mergeGap * 2);
  return spans.map(([a, b]) => [Math.round(a * 1000) / 1000, Math.round(b * 1000) / 1000]);
}

export const docSpeechSpans = (doc: EditDocument) => (musicDucks(doc) ? speechSpans(mappedWords(doc)) : []);

/** The ducking multiplier at `t` (1 = full volume). */
export function duckFactor(spans: Span[], t: number) {
  let depth = 0;
  for (const [start, end] of spans) {
    if (t > start - DUCK_ATTACK && t < end + DUCK_RELEASE)
      depth = Math.max(depth, Math.min(1, (t - (start - DUCK_ATTACK)) / DUCK_ATTACK, (end + DUCK_RELEASE - t) / DUCK_RELEASE));
  }
  return 1 - (1 - DUCK_LEVEL) * Math.max(0, depth);
}

/** Playable length of a piece inside an edit of `total` seconds. */
export function musicLength(piece: MusicClip, total: number) {
  let length = Math.min(piece.end, total) - piece.start;
  if (!piece.loop) length = Math.min(length, piece.track.duration - piece.offset);
  return Math.max(0, length);
}

/** Gain of a piece at edit time `t`, 0 outside it. */
export function musicGain(piece: MusicClip, t: number, spans: Span[], total: number) {
  const length = musicLength(piece, total);
  const local = t - piece.start;
  if (local < 0 || local >= length) return 0;
  const fadeIn = Math.min(piece.fadeIn, length / 2),
    fadeOut = Math.min(piece.fadeOut, length / 2);
  let gain = piece.volume;
  if (fadeIn > 0) gain *= Math.min(1, local / fadeIn);
  if (fadeOut > 0) gain *= Math.min(1, (length - local) / fadeOut);
  return gain * duckFactor(spans, t);
}

/** Where in the track a piece is at edit time `t`. */
export function musicPosition(piece: MusicClip, t: number) {
  const position = piece.offset + Math.max(0, t - piece.start);
  return piece.loop ? position % piece.track.duration : position;
}

/** Add a track at edit time `at`, filling to the end of the edit (or the track). */
export function addMusic(doc: EditDocument, track: MusicTrackRef, at: number, id = uid()): { doc: EditDocument; id: string } {
  const total = editDuration(doc);
  const start = clamp(at, 0, Math.max(0, total - MUSIC_MIN_SECONDS));
  const loop = track.duration < total - start;
  const end = Math.max(start + MUSIC_MIN_SECONDS, loop ? total : Math.min(total, start + track.duration));
  const piece: MusicClip = {
    id,
    start,
    end,
    offset: 0,
    volume: DEFAULT_MUSIC_VOLUME,
    fadeIn: 1,
    fadeOut: 1.5,
    loop,
    track: { source: track.source, id: track.id, title: track.title.slice(0, 200), duration: track.duration },
  };
  return { doc: { ...doc, music: [...musicOf(doc), piece] }, id };
}

export function updateMusic(doc: EditDocument, id: string, change: Partial<MusicClip>): EditDocument {
  return { ...doc, music: musicOf(doc).map((piece) => (piece.id === id ? { ...piece, ...change } : piece)) };
}

export const removeMusic = (doc: EditDocument, id: string): EditDocument => ({
  ...doc,
  music: musicOf(doc).filter((piece) => piece.id !== id),
});

/**
 * Drag a piece on the timeline: move it, or trim either edge. Trimming the
 * start moves the offset with it so the song stays where it was.
 */
export function placeMusic(piece: MusicClip, mode: "move" | "start" | "end", delta: number, total: number): MusicClip {
  const length = piece.end - piece.start;
  const trackRoom = piece.loop ? Infinity : piece.track.duration;
  if (mode === "move") {
    const start = clamp(piece.start + delta, 0, Math.max(0, total - MUSIC_MIN_SECONDS));
    return { ...piece, start, end: start + length };
  }
  if (mode === "start") {
    const lowest = Math.max(0, piece.start - piece.offset);
    const start = clamp(piece.start + delta, piece.loop ? 0 : lowest, piece.end - MUSIC_MIN_SECONDS);
    const offset = piece.loop
      ? (((piece.offset + start - piece.start) % piece.track.duration) + piece.track.duration) % piece.track.duration
      : piece.offset + start - piece.start;
    return { ...piece, start, offset: Math.max(0, offset) };
  }
  const end = clamp(piece.end + delta, piece.start + MUSIC_MIN_SECONDS, Math.min(Math.max(total, piece.start + MUSIC_MIN_SECONDS), piece.start + trackRoom - piece.offset));
  return { ...piece, end };
}
