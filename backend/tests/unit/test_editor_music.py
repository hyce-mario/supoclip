"""Background music in studio exports: ducking math, the ffmpeg mix and a real render."""

import json
import shutil
import subprocess

import pytest

from src.editor_document import render_document
from src.editor_music import (
    DUCK_LEVEL,
    duck_expression,
    duck_factor,
    music_key,
    music_mix,
    speech_spans,
)
from tests.unit.test_editor_document import document


def track(**changes):
    return {"source": "library", "id": "libabc", "title": "Song", "duration": 1.0, **changes}


def piece(**changes):
    return {"id": "m1", "start": 0, "end": 1.5, "volume": 1, "fadeIn": 0, "fadeOut": 0, "track": track(), **changes}


def test_speech_spans_merge_close_words():
    words = [{"start": 0, "end": 0.4}, {"start": 0.6, "end": 1}, {"start": 3, "end": 3.5}]
    assert speech_spans(words) == [(0.0, 1.0), (3.0, 3.5)]
    assert speech_spans([]) == []


def test_duck_factor_ramps_around_speech():
    spans = [(1.0, 2.0)]
    assert duck_factor(spans, 0.0) == 1
    assert duck_factor(spans, 1.5) == pytest.approx(DUCK_LEVEL)
    assert duck_factor(spans, 0.875) == pytest.approx(1 - (1 - DUCK_LEVEL) * 0.5)
    assert duck_factor(spans, 2.25) == pytest.approx(1 - (1 - DUCK_LEVEL) * 0.5)
    assert duck_factor(spans, 3.0) == 1


def test_duck_expression_matches_duck_factor():
    spans = speech_spans([{"start": 0.5, "end": 1.2}, {"start": 3, "end": 4}])
    expression = duck_expression(spans)

    def clip(value, low, high):
        return max(low, min(high, value))

    for step in range(0, 60):
        t = step / 10
        assert eval(expression, {"clip": clip, "min": min, "t": t}) == pytest.approx(duck_factor(spans, t), abs=1e-6)
    assert duck_expression([]) == "1"


def test_music_mix_skips_missing_files_and_trims_to_the_edit(tmp_path):
    doc = document(music=[piece(end=5)])
    assert music_mix(doc, {}, 1.5, 1, []) == ([], [], None)
    song = tmp_path / "song.m4a"
    inputs, filters, label = music_mix(doc, {music_key("library", "libabc"): song}, 1.5, 1, [])
    assert inputs == ["-i", str(song)] and label == "[music]"
    # Not looped: the piece stops where the one-second track ends.
    assert "atrim=start=0.000:duration=1.000" in filters[0]
    looped = document(music=[piece(end=5, loop=True)])
    inputs, filters, _ = music_mix(looped, {music_key("library", "libabc"): song}, 1.5, 3, [])
    assert inputs[:2] == ["-stream_loop", "-1"] and filters[0].startswith("[3:a]")
    assert "duration=1.500" in filters[0]


def test_music_needs_unique_ids_and_a_real_length():
    with pytest.raises(ValueError):
        document(music=[piece(), piece()]).validate_duration(10)
    with pytest.raises(ValueError):
        document(music=[piece(end=0.2)])


def _rms(path, start, end):
    import numpy as np

    pcm = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", str(start), "-t", str(end - start), "-i", str(path),
         "-f", "f32le", "-ac", "1", "-"],
        capture_output=True, check=True,
    ).stdout
    samples = np.frombuffer(pcm, dtype="float32")
    return float(np.sqrt(np.mean(samples ** 2))) if samples.size else 0.0


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg required")
@pytest.mark.parametrize("voice", [True, False])
def test_real_render_mixes_and_ducks_music(tmp_path, voice):
    args = ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=2"]
    if voice:
        args += ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2", "-c:a", "aac"]
    subprocess.run(args + ["-c:v", "libx264", "-pix_fmt", "yuv420p", str(tmp_path / "clean.mp4")], check=True)
    song = tmp_path / "song.wav"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=1", str(song)],
        check=True,
    )
    # The draft's only word plays at 0.25-0.75s of the edit; the voice is muted
    # so only the (looped, ducked) music is heard.
    doc = document(muted=True, music=[piece(loop=True)])
    render_document(tmp_path, "b" * 32, doc, "tiktok", music_files={music_key("library", "libabc"): song})
    output = tmp_path / f"export-{'b' * 32}.mp4"
    probe = json.loads(subprocess.run(
        ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(output)],
        check=True, capture_output=True, text=True,
    ).stdout)
    assert any(s["codec_type"] == "audio" for s in probe["streams"])
    assert float(probe["format"]["duration"]) == pytest.approx(1.5, abs=0.1)
    ducked, full = _rms(output, 0.35, 0.65), _rms(output, 1.3, 1.45)
    assert full > 0.05  # lavfi sine plays at 1/8 amplitude
    assert ducked / full == pytest.approx(DUCK_LEVEL, abs=0.08)
