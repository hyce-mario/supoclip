"""Moment search helpers: request validation, transcript slicing, sentence snapping."""

from types import SimpleNamespace

import pytest

from src.services.moments_service import (
    MomentsError,
    build_moments,
    clean_request,
    slice_transcript,
    steering_text,
)
from src.transcript_reader import snap_to_sentences

# Three sentences, one word per second: 0-1, 2-5, 6-7.
TEXTS = ["Hello", "there.", "We", "talk", "pricing", "today.", "Thanks", "all."]
WORDS = [[text, float(i), i + 0.8, 0] for i, text in enumerate(TEXTS)]
SENTENCES = [[0, 1], [2, 5], [6, 7]]
READER = {"words": WORDS, "sentences": SENTENCES}


def segment(start, end, score=50, title="A title"):
    return SimpleNamespace(
        start_time=start, end_time=end, hook_title=title, text="...", reasoning="why",
        virality=SimpleNamespace(total_score=score, virality_reasoning="hooky"),
    )


def test_clean_request():
    assert clean_request("quotes", None, None, None) == {"preset": "quotes", "prompt": None, "range": None}
    assert clean_request(None, "  money \n talk ", 0, 45)["prompt"] == "money talk"
    assert clean_request(None, "x", 0, 45)["range"] == (0.0, 45.0)
    for args, code in [
        (("nope", None, None, None), "invalid_preset"),
        ((None, "  ", None, None), "empty"),
        ((None, "x", 10, 5), "invalid_range"),
        ((None, "x", 0, 10), "range_too_short"),
        ((None, "x", "a", 5), "invalid_range"),
    ]:
        with pytest.raises(MomentsError) as error:
            clean_request(*args)
        assert error.value.code == code


def test_steering_combines_preset_and_prompt():
    assert steering_text("viral", None) is None
    assert steering_text("viral", "about money") == "about money"
    assert steering_text("advice", "about money").endswith("right away. about money")


def test_slice_transcript_keeps_overlapping_lines():
    transcript = "[00:00 - 00:09] A: one\n[00:10 - 00:20] A: two\n[01:00 - 01:05] A: three"
    assert slice_transcript(transcript, None) == transcript
    assert slice_transcript(transcript, (12, 30)) == "[00:10 - 00:20] A: two"


def test_snap_to_sentences_widens_to_whole_sentences():
    assert snap_to_sentences(WORDS, SENTENCES, 3, 4) == (2.0, 5.8)
    # A sentence mostly outside the range is left out; the end second counts.
    assert snap_to_sentences(WORDS, SENTENCES, 1, 6) == (2.0, 7.8)
    assert snap_to_sentences(WORDS, SENTENCES, 0, 6) == (0.0, 7.8)
    assert snap_to_sentences(WORDS, SENTENCES, 50, 60) is None


def test_build_moments_snaps_sorts_and_dedupes():
    moments = build_moments(
        [segment("00:03", "00:04", 40), segment("00:02", "00:05", 90), segment("00:06", "00:07", 70), segment("bad", "x")],
        READER,
        None,
    )
    # The second segment duplicates the first after snapping, so two remain, best first.
    assert [(m["start"], m["end"], m["score"]) for m in moments] == [(6.0, 7.8, 70), (2.0, 5.8, 40)]
    assert moments[0]["title"] == "A title" and moments[0]["reason"] == "hooky"


def test_build_moments_clamps_to_the_searched_range():
    moments = build_moments([segment("00:00", "00:07")], READER, (2.0, 5.0))
    assert (moments[0]["start"], moments[0]["end"]) == (2.0, 5.8)
