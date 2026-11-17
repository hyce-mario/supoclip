"""Background music in clip studio exports: speech ducking and the ffmpeg mix.

The gain of a music piece at edit time ``t`` is

    volume × fade_in(t) × fade_out(t) × duck(t)

``duck`` dips to ``DUCK_LEVEL`` over every span of speech (caption words on
the edit timeline, merged when the gap between them is too short to recover),
ramping down ``DUCK_ATTACK`` seconds before the first word and back up over
``DUCK_RELEASE`` after the last. ``frontend/src/lib/editor/music.ts`` computes
the same curve for the preview and the browser export; keep the two in step.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Iterable

if TYPE_CHECKING:
    from .editor_document import EditDocument

DUCK_LEVEL = 0.3
DUCK_ATTACK = 0.25
DUCK_RELEASE = 0.5
# Spans this close together share one dip, so ramps never overlap.
DUCK_MERGE_GAP = DUCK_ATTACK + DUCK_RELEASE
# Keeps the ffmpeg expression small on very talkative clips.
MAX_DUCK_SPANS = 150
MUSIC_SAMPLE_RATE = 48000


def speech_spans(words: Iterable[dict], merge_gap: float = DUCK_MERGE_GAP) -> list[tuple[float, float]]:
    """Merged ``(start, end)`` spans of speech in edit seconds."""
    spans: list[list[float]] = []
    for word in sorted(words, key=lambda w: w["start"]):
        start, end = float(word["start"]), float(word["end"])
        if spans and start - spans[-1][1] < merge_gap:
            spans[-1][1] = max(spans[-1][1], end)
        else:
            spans.append([start, end])
    if len(spans) > MAX_DUCK_SPANS:
        return speech_spans(({"start": a, "end": b} for a, b in spans), merge_gap * 2)
    return [(round(a, 3), round(b, 3)) for a, b in spans]


def duck_factor(spans: list[tuple[float, float]], t: float) -> float:
    """The ducking multiplier at ``t`` (1 = full volume)."""
    depth = 0.0
    for start, end in spans:
        if start - DUCK_ATTACK < t < end + DUCK_RELEASE:
            depth = max(depth, min(1.0, (t - (start - DUCK_ATTACK)) / DUCK_ATTACK, ((end + DUCK_RELEASE) - t) / DUCK_RELEASE))
    return 1 - (1 - DUCK_LEVEL) * max(0.0, depth)


def duck_expression(spans: list[tuple[float, float]]) -> str:
    """``duck_factor`` as an ffmpeg expression of ``t`` (spans never overlap after merging)."""
    if not spans:
        return "1"
    terms = "+".join(
        f"clip(min((t-{start - DUCK_ATTACK:.3f})/{DUCK_ATTACK},({end + DUCK_RELEASE:.3f}-t)/{DUCK_RELEASE}),0,1)"
        for start, end in spans
    )
    return f"1-{1 - DUCK_LEVEL:.3f}*min(1,{terms})"


def music_mix(
    document: "EditDocument",
    music_files: dict[str, Path],
    total: float,
    first_input: int,
    words: list[dict],
) -> tuple[list[str], list[str], str | None]:
    """ffmpeg inputs and filters mixing a draft's music into one stereo stream.

    Returns ``(input_args, filters, label)``; label is None when no piece plays
    (no music, or its files are missing). Pieces past the edit end are cut.
    """
    inputs: list[str] = []
    filters: list[str] = []
    labels: list[str] = []
    index = first_input
    for piece in sorted(document.music, key=lambda m: m.start):
        path = music_files.get(music_key(piece.track.source, piece.track.id))
        end = min(piece.end, total)
        length = end - piece.start
        if path is None or length < 0.05:
            continue
        if not piece.loop:
            length = min(length, piece.track.duration - piece.offset)
            if length < 0.05:
                continue
        inputs += (["-stream_loop", "-1"] if piece.loop else []) + ["-i", str(path)]
        chain = [
            f"aresample={MUSIC_SAMPLE_RATE}",
            "aformat=sample_fmts=fltp:channel_layouts=stereo",
            f"atrim=start={piece.offset:.3f}:duration={length:.3f}",
            "asetpts=PTS-STARTPTS",
        ]
        fade_in = min(piece.fadeIn, length / 2)
        fade_out = min(piece.fadeOut, length / 2)
        if fade_in > 0:
            chain.append(f"afade=t=in:st=0:d={fade_in:.3f}")
        if fade_out > 0:
            chain.append(f"afade=t=out:st={length - fade_out:.3f}:d={fade_out:.3f}")
        chain.append(f"volume={piece.volume:.4f}")
        delay = round(piece.start * 1000)
        if delay > 0:
            chain.append(f"adelay=delays={delay}:all=1")
        label = f"[music{len(labels)}]"
        filters.append(f"[{index}:a]" + ",".join(chain) + label)
        labels.append(label)
        index += 1
    if not labels:
        return [], [], None
    if len(labels) == 1:
        filters.append(f"{labels[0]}anull[musicmix]")
    else:
        filters.append("".join(labels) + f"amix=inputs={len(labels)}:normalize=0:duration=longest[musicmix]")
    spans = speech_spans(words) if document.musicDuck else []
    if spans:
        filters.append(f"[musicmix]volume='{duck_expression(spans)}':eval=frame[music]")
    else:
        filters.append("[musicmix]anull[music]")
    return inputs, filters, "[music]"


def music_key(source: str, track_id: str) -> str:
    return f"{source}:{track_id}"
