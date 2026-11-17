"""The full source transcript as a reader: words, sentences and paragraphs.

The task page's Transcript view reads a source's word-timed transcript, lets
the user select text by word, sentence or paragraph, and shades what is
already clipped. Transcripts come from the processing checkpoint (word times
in milliseconds) and are returned compactly, in seconds:

- ``words``: ``[text, start, end, speaker_index]``
- ``sentences``: ``[first_word, last_word]`` (inclusive word indexes)
- ``paragraphs``: ``[first_sentence, last_sentence]`` (inclusive sentence indexes)

Transcripts often carry a single utterance for a whole monologue, so
paragraphs are built from sentence ends, pauses and length, not from
utterances alone.
"""

from __future__ import annotations

import re
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from .clip_source_map import normalize_source_ranges

# A sentence ends on terminal punctuation, a long pause, a speaker change or
# when it runs this long without punctuation (some transcripts have none).
SENTENCE_PAUSE_SECONDS = 1.2
SENTENCE_MIN_WORDS_BEFORE_PAUSE = 3
SENTENCE_MAX_WORDS = 40
# Paragraphs break at sentence ends: always past the hard length, earlier on a
# pause once they are long enough to read as a block.
PARAGRAPH_MAX_SECONDS = 60.0
PARAGRAPH_SOFT_SECONDS = 25.0
PARAGRAPH_PAUSE_SECONDS = 0.8

_TERMINAL = re.compile(r"[.!?…。！？]+[\"'”’)\]]*$")
_ABBREVIATIONS = frozenset(
    "mr. mrs. ms. dr. st. vs. jr. sr. prof. e.g. i.e. etc. u.s. u.k. no. approx.".split()
)


def _seconds(value: Any) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number and number >= 0 else None


def normalize_words(transcript_data: Dict[str, Any]) -> Tuple[List[list], List[str]]:
    """Words as ``[text, start_s, end_s, speaker_index]`` in time order, and the speakers.

    Checkpoint words are in milliseconds. Words without usable times or text
    are dropped; an end before its start is clamped to the start.
    """
    speakers: List[str] = []
    speaker_index: Dict[str, int] = {}
    words: List[list] = []
    for word in transcript_data.get("words") or []:
        if not isinstance(word, dict):
            continue
        text = str(word.get("text") or "").strip()
        start, end = _seconds(word.get("start")), _seconds(word.get("end"))
        if not text or start is None or end is None:
            continue
        speaker = str(word.get("speaker") or "")
        if speaker not in speaker_index:
            speaker_index[speaker] = len(speakers)
            speakers.append(speaker)
        start_s = round(start / 1000.0, 3)
        end_s = round(max(end, start) / 1000.0, 3)
        words.append([text, start_s, end_s, speaker_index[speaker]])
    words.sort(key=lambda w: (w[1], w[2]))
    return words, speakers


def _ends_sentence(text: str) -> bool:
    if not _TERMINAL.search(text):
        return False
    return text.lower().strip("\"'“”()[]") not in _ABBREVIATIONS


def build_sentences(words: Sequence[list]) -> List[List[int]]:
    """Inclusive ``[first, last]`` word ranges covering every word once, in order."""
    sentences: List[List[int]] = []
    start = 0
    for index, word in enumerate(words):
        is_last = index == len(words) - 1
        length = index - start + 1
        boundary = is_last or _ends_sentence(word[0]) or length >= SENTENCE_MAX_WORDS
        if not boundary:
            following = words[index + 1]
            boundary = following[3] != word[3] or (
                following[1] - word[2] >= SENTENCE_PAUSE_SECONDS
                and length >= SENTENCE_MIN_WORDS_BEFORE_PAUSE
            )
        if boundary:
            sentences.append([start, index])
            start = index + 1
    return sentences


def build_paragraphs(words: Sequence[list], sentences: Sequence[List[int]]) -> List[List[int]]:
    """Inclusive ``[first, last]`` sentence ranges covering every sentence once, in order."""
    paragraphs: List[List[int]] = []
    start = 0
    for index, (first, last) in enumerate(sentences):
        if index == len(sentences) - 1:
            paragraphs.append([start, index])
            break
        next_first = sentences[index + 1][0]
        duration = words[last][2] - words[sentences[start][0]][1]
        gap = words[next_first][1] - words[last][2]
        speaker_change = words[next_first][3] != words[last][3]
        if (
            speaker_change
            or duration >= PARAGRAPH_MAX_SECONDS
            or (duration >= PARAGRAPH_SOFT_SECONDS and gap >= PARAGRAPH_PAUSE_SECONDS)
        ):
            paragraphs.append([start, index])
            start = index + 1
    return paragraphs


def build_reader_transcript(transcript_data: Dict[str, Any]) -> Dict[str, Any]:
    words, speakers = normalize_words(transcript_data)
    sentences = build_sentences(words)
    return {
        "language": transcript_data.get("language_code") or None,
        "speakers": speakers,
        "words": words,
        "sentences": sentences,
        "paragraphs": build_paragraphs(words, sentences),
    }


def parse_clip_time(value: Any) -> Optional[float]:
    """Seconds from a clip's ``MM:SS``/``HH:MM:SS`` label (or a number); None when unreadable."""
    parts = str(value or "").strip().split(":")
    if not 1 <= len(parts) <= 3:
        return None
    try:
        numbers = [float(part) for part in parts]
    except ValueError:
        return None
    if any(n < 0 or n != n for n in numbers):
        return None
    seconds = 0.0
    for number in numbers:
        seconds = seconds * 60 + number
    return seconds


def clip_source_ranges(clip: Dict[str, Any]) -> List[List[float]]:
    """The source seconds a clip covers, from its row alone (no file reads).

    Workflow clips carry their planned ranges; other clips their start/end
    labels. Good enough to shade what is already clipped.
    """
    planned = normalize_source_ranges((clip.get("workflow_meta") or {}).get("ranges"))
    if planned:
        return [[round(start, 3), round(end, 3)] for start, end in planned]
    start, end = parse_clip_time(clip.get("start_time")), parse_clip_time(clip.get("end_time"))
    if start is None or end is None or end <= start:
        return []
    return [[round(start, 3), round(end, 3)]]


def reader_clips(clips: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    result = []
    for clip in clips:
        ranges = clip_source_ranges(clip)
        if ranges:
            result.append(
                {
                    "id": clip["id"],
                    "title": clip.get("hook_title") or None,
                    "order": clip.get("clip_order"),
                    "ranges": ranges,
                }
            )
    return result



def snap_to_sentences(
    words: Sequence[list], sentences: Sequence[List[int]], start: float, end: float
) -> Optional[Tuple[float, float]]:
    """Widen a rough range (whole seconds, as the model writes it) to whole sentences.

    A sentence counts when at least half of it lies inside ``[start, end + 1)``:
    the model rounds times down, so the end second is included. With no such
    sentence, the one being spoken at ``start`` is used. None when no word is near.
    """
    window_end = end + 1.0
    kept = []
    for first, last in sentences:
        s_start, s_end = words[first][1], words[last][2]
        length = max(s_end - s_start, 0.001)
        overlap = min(s_end, window_end) - max(s_start, start)
        if overlap >= 0.5 * length:
            kept.append((first, last))
    if not kept:
        around = [(f, l) for f, l in sentences if words[f][1] <= start + 0.5 and words[l][2] >= start]
        if not around:
            return None
        kept = around[:1]
    return round(words[kept[0][0]][1], 3), round(words[kept[-1][1]][2], 3)
