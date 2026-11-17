"""Studio music: library listing, uploads and their files."""

import shutil
import subprocess

import pytest

from src import music_library
from src.config import get_config
from tests.fixtures.factories import create_user

pytestmark = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg required")


def _tone(path, seconds=2):
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}", str(path)],
        check=True,
    )


async def test_library_upload_play_and_delete(client, db_session, auth_headers, tmp_path, monkeypatch):
    await create_user(db_session, user_id="user-1", email="user-1@example.com")
    library = tmp_path / "music"
    (library / "chill").mkdir(parents=True)
    _tone(library / "chill" / "sunset_drive.wav")
    (library / "notes.txt").write_text("not audio")
    monkeypatch.setattr(music_library, "LIBRARY_DIR", library)
    get_config().temp_dir = str(tmp_path / "temp")

    listing = (await client.get("/music", headers=auth_headers)).json()
    assert [(t["title"], t["category"]) for t in listing["library"]] == [("Sunset Drive", "Chill")]
    track = listing["library"][0]
    played = await client.get(f"/music/library/{track['id']}/file", headers=auth_headers)
    assert played.status_code == 200 and played.content[:4] == b"RIFF"
    assert (await client.get("/music/library/lib0000/file", headers=auth_headers)).status_code == 404

    song = tmp_path / "My Song.mp3"
    _tone(song, 3)
    with song.open("rb") as handle:
        uploaded = await client.post("/music/uploads", files={"file": ("My Song.mp3", handle, "audio/mpeg")}, headers=auth_headers)
    assert uploaded.status_code == 200, uploaded.text
    mine = uploaded.json()["track"]
    assert mine["title"] == "My Song" and mine["duration"] == pytest.approx(3, abs=0.1)
    assert [t["id"] for t in (await client.get("/music", headers=auth_headers)).json()["uploads"]] == [mine["id"]]
    file = await client.get(f"/music/uploads/{mine['id']}/file", headers=auth_headers)
    assert file.status_code == 200 and file.headers["content-type"] == "audio/mp4"

    text_file = tmp_path / "notes.txt"
    text_file.write_text("hello")
    with text_file.open("rb") as handle:
        rejected = await client.post("/music/uploads", files={"file": ("notes.txt", handle, "text/plain")}, headers=auth_headers)
    assert rejected.status_code == 400 and rejected.json()["detail"]["code"] == "not_audio"

    assert (await client.delete(f"/music/uploads/{mine['id']}", headers=auth_headers)).status_code == 200
    assert (await client.get(f"/music/uploads/{mine['id']}/file", headers=auth_headers)).status_code == 404
