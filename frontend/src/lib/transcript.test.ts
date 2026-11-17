import { describe, expect, it } from "vitest";

import {
  clipCoverage,
  findPhrase,
  formatClock,
  lengthWarning,
  paragraphSelection,
  selectionText,
  selectionTimes,
  sentenceSelection,
  snapToSentences,
  wordAt,
  type TranscriptData,
  type TranscriptWord,
} from "./transcript";

// "Hello there. We talk pricing today. Thanks all." — one word per second.
const texts = ["Hello", "there.", "We", "talk", "pricing", "today.", "Thanks", "all."];
const words: TranscriptWord[] = texts.map((text, i) => [text, i, i + 0.8, 0]);
const data: Pick<TranscriptData, "words" | "sentences" | "paragraphs"> = {
  words,
  sentences: [[0, 1], [2, 5], [6, 7]],
  paragraphs: [[0, 1], [2, 2]],
};

describe("transcript maths", () => {
  it("finds the word being spoken", () => {
    expect(wordAt(words, -1)).toBe(-1);
    expect(wordAt(words, 0)).toBe(0);
    expect(wordAt(words, 3.5)).toBe(3);
    expect(wordAt(words, 100)).toBe(7);
  });

  it("selects sentences and paragraphs around a word", () => {
    expect(sentenceSelection(data, 4)).toEqual({ first: 2, last: 5 });
    expect(paragraphSelection(data, 0)).toEqual({ first: 0, last: 5 });
    expect(paragraphSelection(data, 7)).toEqual({ first: 6, last: 7 });
  });

  it("snaps a selection out to whole sentences", () => {
    expect(snapToSentences(data, { first: 1, last: 3 })).toEqual({ first: 0, last: 5 });
    expect(snapToSentences(data, { first: 6, last: 6 })).toEqual({ first: 6, last: 7 });
  });

  it("measures and reads a selection", () => {
    expect(selectionTimes(words, { first: 2, last: 5 })).toEqual({ start: 2, end: 5.8, duration: 3.8 });
    expect(selectionText(words, { first: 2, last: 5 })).toBe("We talk pricing today.");
  });

  it("warns about clip lengths", () => {
    expect(lengthWarning(2)).toBe("tooShort");
    expect(lengthWarning(8)).toBe("short");
    expect(lengthWarning(30)).toBeNull();
    expect(lengthWarning(200)).toBe("tooLong");
  });

  it("marks words covered by clips by their midpoint", () => {
    const coverage = clipCoverage(words, [{ id: "c1", title: null, order: 1, ranges: [[2, 4.3]] }]);
    expect(coverage).toEqual([null, null, "c1", "c1", null, null, null, null]);
  });

  it("finds phrases ignoring case and punctuation, with a prefix last word", () => {
    expect(findPhrase(words, "PRICING")).toEqual([{ first: 4, last: 4 }]);
    expect(findPhrase(words, "hello there")).toEqual([{ first: 0, last: 1 }]);
    expect(findPhrase(words, "talk pri")).toEqual([{ first: 3, last: 4 }]);
    expect(findPhrase(words, "  ")).toEqual([]);
  });

  it("formats clock times", () => {
    expect(formatClock(5)).toBe("0:05");
    expect(formatClock(65.9)).toBe("1:05");
    expect(formatClock(3725)).toBe("1:02:05");
  });
});
