from src.transcript_reader import (
    build_paragraphs,
    build_reader_transcript,
    build_sentences,
    clip_source_ranges,
    normalize_words,
    reader_clips,
)


def _words(spec, speaker="A"):
    """``spec``: (text, start_s, end_s) tuples -> checkpoint words in ms."""
    return [
        {"text": t, "start": int(s * 1000), "end": int(e * 1000), "speaker": speaker, "confidence": 0.9}
        for t, s, e in spec
    ]


def _timed(texts, start=0.0, step=0.4, gap_after=None):
    """Consecutive words ``step`` apart; ``gap_after`` maps word index -> extra pause."""
    spec, t = [], start
    for i, word in enumerate(texts):
        spec.append((word, t, t + step - 0.05))
        t += step + (gap_after or {}).get(i, 0.0)
    return spec


def test_words_are_seconds_sorted_and_cleaned():
    words, speakers = normalize_words(
        {
            "words": [
                {"text": "world", "start": 1500, "end": 1900, "speaker": "B"},
                {"text": "Hello", "start": 1000, "end": 900, "speaker": "A"},
                {"text": "  ", "start": 2000, "end": 2100},
                {"text": "bad", "start": None, "end": 10},
                "junk",
            ]
        }
    )
    assert words == [["Hello", 1.0, 1.0, 1], ["world", 1.5, 1.9, 0]]
    assert speakers == ["B", "A"]


def test_sentences_end_on_punctuation_but_not_abbreviations():
    words, _ = normalize_words({"words": _words(_timed("I met Dr. Smith today. He said hi!".split()))})
    sentences = build_sentences(words)
    assert [" ".join(w[0] for w in words[a : b + 1]) for a, b in sentences] == [
        "I met Dr. Smith today.",
        "He said hi!",
    ]


def test_sentences_end_on_long_pause_speaker_change_and_length():
    spec = _timed("so we went there and then".split(), gap_after={3: 2.0})
    words, _ = normalize_words({"words": _words(spec[:5]) + _words(spec[5:], speaker="B")})
    assert build_sentences(words) == [[0, 3], [4, 4], [5, 5]]

    long_run, _ = normalize_words({"words": _words(_timed(["word"] * 85))})
    sentences = build_sentences(long_run)
    assert [b - a + 1 for a, b in sentences] == [40, 40, 5]


def test_a_short_pause_inside_a_sentence_does_not_split_it():
    words, _ = normalize_words({"words": _words(_timed("um so".split(), gap_after={0: 2.0}))})
    assert build_sentences(words) == [[0, 1]]


def test_sentences_and_paragraphs_cover_everything_once():
    texts = []
    for i in range(60):
        texts += f"This is sentence number {i}.".split()
    words, _ = normalize_words({"words": _words(_timed(texts, step=0.5))})
    sentences = build_sentences(words)
    paragraphs = build_paragraphs(words, sentences)
    assert sentences[0][0] == 0 and sentences[-1][1] == len(words) - 1
    assert all(b[0] == a[1] + 1 for a, b in zip(sentences, sentences[1:]))
    assert paragraphs[0][0] == 0 and paragraphs[-1][1] == len(sentences) - 1
    assert all(b[0] == a[1] + 1 for a, b in zip(paragraphs, paragraphs[1:]))
    # A 150 s monologue with no pauses still breaks into readable blocks.
    assert len(paragraphs) >= 3
    for first, last in paragraphs[:-1]:
        span = words[sentences[last][1]][2] - words[sentences[first][0]][1]
        assert span < 60 + 5


def test_paragraph_breaks_on_a_pause_once_long_enough():
    texts = []
    gaps = {}
    for i in range(14):
        texts += "One two three four five six seven.".split()
        if i == 9:
            gaps[len(texts) - 1] = 1.5  # ~28 s in, then a pause
    words, _ = normalize_words({"words": _words(_timed(texts, gap_after=gaps))})
    sentences = build_sentences(words)
    paragraphs = build_paragraphs(words, sentences)
    assert paragraphs[0] == [0, 9]


def test_paragraph_breaks_on_speaker_change():
    words, _ = normalize_words(
        {"words": _words(_timed(["Hi."]), "A") + _words(_timed(["Hello."], start=1.0), "B")}
    )
    sentences = build_sentences(words)
    assert build_paragraphs(words, sentences) == [[0, 0], [1, 1]]


def test_empty_transcript():
    reader = build_reader_transcript({"words": [], "language_code": "en"})
    assert reader == {"language": "en", "speakers": [], "words": [], "sentences": [], "paragraphs": []}


def test_clip_ranges_prefer_planned_ranges_then_labels():
    assert clip_source_ranges({"start_time": "01:05", "end_time": "01:35", "workflow_meta": {}}) == [[65.0, 95.0]]
    planned = {"ranges": [[10, 20], [30, 40]]}
    assert clip_source_ranges({"start_time": "00:10", "end_time": "00:40", "workflow_meta": planned}) == [
        [10.0, 20.0],
        [30.0, 40.0],
    ]
    assert clip_source_ranges({"start_time": "bad", "end_time": "00:10"}) == []
    assert clip_source_ranges({"start_time": "00:20", "end_time": "00:10"}) == []
    assert clip_source_ranges({"start_time": "1:00:05", "end_time": "1:00:35.5"}) == [[3605.0, 3635.5]]


def test_reader_clips_skip_unplaceable_clips():
    clips = reader_clips(
        [
            {"id": "a", "start_time": "00:00", "end_time": "00:30", "hook_title": "Hook", "clip_order": 1},
            {"id": "b", "start_time": "??", "end_time": "??", "clip_order": 2},
        ]
    )
    assert clips == [{"id": "a", "title": "Hook", "order": 1, "ranges": [[0.0, 30.0]]}]


def test_range_clip_validation():
    import pytest
    from src.services.range_clip_service import RangeClipError, clean_hook_title, validate_range

    assert validate_range(1.23456, 40, 120) == (1.235, 40.0)
    for start, end, code in [(5, 4, "invalid_range"), (0, 2, "too_short"), (0, 200, "too_long"), (100, 130, "out_of_bounds")]:
        duration = 120 if code == "out_of_bounds" else 1000
        with pytest.raises(RangeClipError) as error:
            validate_range(start, end, duration)
        assert error.value.code == code
    # Unknown source length: only the clip length is checked.
    assert validate_range(500, 530, None) == (500.0, 530.0)
    assert clean_hook_title("  a\n b ") == "a b"
    assert clean_hook_title("   ") is None
    assert clean_hook_title(3) is None


def test_range_clip_restores_a_missing_transcript_sidecar(tmp_path):
    from src.media.transcription import load_cached_transcript_data
    from src.services.range_clip_service import _write_transcript_sidecar

    video = tmp_path / "full-1080.mp4"
    video.write_bytes(b"")
    data = {"version": 1, "words": [{"text": "Hi", "start": 0, "end": 300, "speaker": "A", "confidence": 1}],
            "utterances": [], "text": "Hi", "language_code": "en"}
    _write_transcript_sidecar(video, data)
    assert load_cached_transcript_data(video)["words"][0]["text"] == "Hi"
    # An existing sidecar is left alone.
    _write_transcript_sidecar(video, {**data, "words": [{**data["words"][0], "text": "Other"}]})
    assert load_cached_transcript_data(video)["words"][0]["text"] == "Hi"
