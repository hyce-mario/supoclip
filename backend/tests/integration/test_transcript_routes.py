"""The Transcript view's endpoints against PostgreSQL."""

import json

from sqlalchemy import text

from src.config import get_config
from tests.fixtures.factories import create_clip, create_source, create_task, create_user

SOURCE_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"


def _transcript_data():
    words = []
    t = 0
    for sentence in ("Hello there everyone.", "Today we talk about pricing."):
        for word in sentence.split():
            words.append({"text": word, "start": t, "end": t + 300, "speaker": "A", "confidence": 0.9})
            t += 400
    return {"version": 1, "words": words, "utterances": [], "text": "", "language_code": "en"}


async def seed(db_session, *, status="completed", transcript=True, user_id="user-1"):
    await create_user(db_session, user_id=user_id, email=f"{user_id}@example.com")
    source = await create_source(db_session, title="Talk", url=SOURCE_URL)
    task = await create_task(
        db_session, user_id=user_id, source_id=source["id"], status=status, source_duration_seconds=120
    )
    await create_clip(db_session, task_id=task["id"])
    if transcript:
        await db_session.execute(
            text(
                """
                INSERT INTO task_processing_checkpoints (task_id, input_key, payload)
                VALUES (:task_id, 'key', CAST(:payload AS jsonb))
                """
            ),
            {"task_id": task["id"], "payload": json.dumps({"transcript_data": _transcript_data()})},
        )
        await db_session.commit()
    return task["id"]


async def test_transcript_returns_words_structure_clips_and_youtube_media(client, db_session, auth_headers):
    task_id = await seed(db_session)
    response = await client.get(f"/tasks/{task_id}/transcript", headers=auth_headers)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["title"] == "Talk"
    assert body["duration"] == 120
    assert body["language"] == "en"
    assert body["words"][0] == ["Hello", 0.0, 0.3, 0]
    assert body["sentences"] == [[0, 2], [3, 7]]
    assert body["paragraphs"] == [[0, 1]]
    assert body["clips"][0]["ranges"] == [[0.0, 10.0]]
    # No stored source file: the YouTube player is the fallback.
    assert body["media"] == {"kind": "youtube", "video_id": "dQw4w9WgXcQ"}


async def test_transcript_prefers_a_stored_source_file(client, db_session, auth_headers, tmp_path):
    task_id = await seed(db_session)
    root = tmp_path / "temp"
    (root / "youtube-cache").mkdir(parents=True)
    source = root / "youtube-cache" / "full-1080.mp4"
    source.write_bytes(b"0123456789")
    get_config().temp_dir = str(root)
    await db_session.execute(
        text(
            """
            INSERT INTO processing_cache (cache_key, source_url, source_type, video_path)
            VALUES (:key, :url, 'youtube', :path)
            """
        ),
        {"key": f"transcript-test-{task_id}", "url": SOURCE_URL, "path": str(source)},
    )
    await db_session.commit()
    try:
        body = (await client.get(f"/tasks/{task_id}/transcript", headers=auth_headers)).json()
        assert body["media"] == {"kind": "file", "url": f"/tasks/{task_id}/source/media"}

        media = await client.get(f"/tasks/{task_id}/source/media", headers={**auth_headers, "Range": "bytes=2-5"})
        assert media.status_code == 206
        assert media.content == b"2345"
    finally:
        await db_session.execute(
            text("DELETE FROM processing_cache WHERE cache_key = :key"), {"key": f"transcript-test-{task_id}"}
        )
        await db_session.commit()


async def test_source_media_never_serves_files_outside_temp_dir(client, db_session, auth_headers, tmp_path):
    task_id = await seed(db_session)
    outside = tmp_path / "secret.mp4"
    outside.write_bytes(b"secret")
    get_config().temp_dir = str(tmp_path / "temp")
    await db_session.execute(
        text(
            """
            INSERT INTO processing_cache (cache_key, source_url, source_type, video_path)
            VALUES (:key, :url, 'youtube', :path)
            """
        ),
        {"key": f"transcript-outside-{task_id}", "url": SOURCE_URL, "path": str(outside)},
    )
    await db_session.commit()
    try:
        response = await client.get(f"/tasks/{task_id}/source/media", headers=auth_headers)
        assert response.status_code == 404
    finally:
        await db_session.execute(
            text("DELETE FROM processing_cache WHERE cache_key = :key"), {"key": f"transcript-outside-{task_id}"}
        )
        await db_session.commit()


async def test_transcript_status_codes(client, db_session, auth_headers):
    processing = await seed(db_session, status="processing", transcript=False)
    assert (await client.get(f"/tasks/{processing}/transcript", headers=auth_headers)).status_code == 409

    missing = await seed(db_session, transcript=False)
    assert (await client.get(f"/tasks/{missing}/transcript", headers=auth_headers)).status_code == 404


async def test_only_the_owner_can_read_the_transcript(client, db_session, auth_headers):
    await create_user(db_session, user_id="user-1", email="user-1@example.com")
    task_id = await seed(db_session, user_id="someone-else")
    assert (await client.get(f"/tasks/{task_id}/transcript", headers=auth_headers)).status_code == 403
    assert (await client.get(f"/tasks/{task_id}/source/media", headers=auth_headers)).status_code == 403
