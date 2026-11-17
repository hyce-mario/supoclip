/**
 * The task page's Transcript view: the full source transcript from
 * `GET /tasks/{id}/transcript`, and the word/sentence/paragraph maths the
 * reader uses. All times are source seconds.
 */

/** `[text, start, end, speakerIndex]` */
export type TranscriptWord = [string, number, number, number];
/** Inclusive `[first, last]` indexes. */
export type IndexRange = [number, number];

export type TranscriptMedia =
  | { kind: "file"; url: string }
  | { kind: "youtube"; video_id: string };

export interface TranscriptClip {
  id: string;
  title: string | null;
  order: number | null;
  ranges: [number, number][];
}

export interface TranscriptData {
  task_id: string;
  title: string | null;
  duration: number;
  language: string | null;
  speakers: string[];
  words: TranscriptWord[];
  /** Word ranges. */
  sentences: IndexRange[];
  /** Sentence ranges. */
  paragraphs: IndexRange[];
  clips: TranscriptClip[];
  media: TranscriptMedia | null;
}

/** A word selection, inclusive and ordered. */
export interface WordSelection {
  first: number;
  last: number;
}

export const MIN_CLIP_SECONDS = 3;
export const SHORT_CLIP_SECONDS = 10;
export const MAX_CLIP_SECONDS = 180;

/** Index of the last item whose `key` is <= `value`, or -1. Items must be sorted by key. */
function lastAtOrBefore<T>(items: readonly T[], value: number, key: (item: T) => number): number {
  let low = 0;
  let high = items.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (key(items[mid]) <= value) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/** The word being spoken at `time`: the last one started by then, or -1 before the first. */
export function wordAt(words: readonly TranscriptWord[], time: number): number {
  return lastAtOrBefore(words, time, (word) => word[1]);
}

/** The sentence containing word `index`. */
export function sentenceOf(sentences: readonly IndexRange[], index: number): number {
  return Math.max(0, lastAtOrBefore(sentences, index, (sentence) => sentence[0]));
}

/** The paragraph containing sentence `index`. */
export function paragraphOf(paragraphs: readonly IndexRange[], sentence: number): number {
  return Math.max(0, lastAtOrBefore(paragraphs, sentence, (paragraph) => paragraph[0]));
}

export function orderedSelection(a: number, b: number): WordSelection {
  return a <= b ? { first: a, last: b } : { first: b, last: a };
}

export function sentenceSelection(data: Pick<TranscriptData, "sentences">, word: number): WordSelection {
  const [first, last] = data.sentences[sentenceOf(data.sentences, word)];
  return { first, last };
}

export function paragraphSelection(data: Pick<TranscriptData, "sentences" | "paragraphs">, word: number): WordSelection {
  const [firstSentence, lastSentence] = data.paragraphs[paragraphOf(data.paragraphs, sentenceOf(data.sentences, word))];
  return { first: data.sentences[firstSentence][0], last: data.sentences[lastSentence][1] };
}

/** Widen a selection to whole sentences. */
export function snapToSentences(data: Pick<TranscriptData, "sentences">, selection: WordSelection): WordSelection {
  return {
    first: data.sentences[sentenceOf(data.sentences, selection.first)][0],
    last: data.sentences[sentenceOf(data.sentences, selection.last)][1],
  };
}

export function selectionTimes(words: readonly TranscriptWord[], selection: WordSelection) {
  const start = words[selection.first][1];
  const end = Math.max(start, words[selection.last][2]);
  return { start, end, duration: end - start };
}

export function selectionText(words: readonly TranscriptWord[], selection: WordSelection): string {
  return words.slice(selection.first, selection.last + 1).map((word) => word[0]).join(" ");
}

export type LengthWarning = "tooShort" | "short" | "tooLong" | null;

export function lengthWarning(duration: number): LengthWarning {
  if (duration < MIN_CLIP_SECONDS) return "tooShort";
  if (duration > MAX_CLIP_SECONDS) return "tooLong";
  if (duration < SHORT_CLIP_SECONDS) return "short";
  return null;
}

/** For each word, the clip covering its midpoint (or null). */
export function clipCoverage(words: readonly TranscriptWord[], clips: readonly TranscriptClip[]): (string | null)[] {
  const covered: (string | null)[] = new Array(words.length).fill(null);
  for (const clip of clips) {
    for (const [start, end] of clip.ranges) {
      let index = Math.max(0, wordAt(words, start) - 1);
      for (; index < words.length && words[index][1] < end; index += 1) {
        const middle = (words[index][1] + words[index][2]) / 2;
        if (middle >= start && middle <= end && covered[index] === null) covered[index] = clip.id;
      }
    }
  }
  return covered;
}

const normalizeToken = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");

/** Word ranges where `query` (one or more words, punctuation and case ignored) appears. */
export function findPhrase(words: readonly TranscriptWord[], query: string): WordSelection[] {
  const tokens = query.split(/\s+/).map(normalizeToken).filter(Boolean);
  if (tokens.length === 0) return [];
  const normalized = words.map((word) => normalizeToken(word[0]));
  const matches: WordSelection[] = [];
  for (let index = 0; index + tokens.length <= normalized.length; index += 1) {
    let ok = true;
    for (let offset = 0; offset < tokens.length; offset += 1) {
      const word = normalized[index + offset];
      // The last query token may be a prefix, so results show while typing.
      const matched = offset === tokens.length - 1 ? word.startsWith(tokens[offset]) : word === tokens[offset];
      if (!matched) {
        ok = false;
        break;
      }
    }
    if (ok) matches.push({ first: index, last: index + tokens.length - 1 });
  }
  return matches;
}

export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}
