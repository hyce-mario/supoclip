"""Background music for the clip studio: the built-in library and creators' uploads.

**Library:** audio files dropped into ``backend/music/`` (subfolders become
categories) appear automatically, like fonts. Ids are derived from the path,
so a request never names a file.

**Uploads:** a creator's own tracks, transcoded to AAC and stored like other
media: in the bucket when ``MEDIA_STORAGE=s3`` (fetched to a per-machine cache
when a render needs them), else under ``TEMP_DIR/music``. Rows live in
``user_music_tracks``.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import shutil
import subprocess
import threading
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from .config import get_config
from .media_storage import MediaStorage, is_s3, owner_key

logger = logging.getLogger(__name__)

LIBRARY_DIR = Path(__file__).parent.parent / "music"
AUDIO_EXTENSIONS = {".mp3", ".m4a", ".aac", ".wav", ".ogg", ".oga", ".flac", ".opus"}
UPLOAD_MAX_BYTES = 30 * 1024 * 1024
UPLOAD_MAX_SECONDS = 15 * 60
UPLOADS_PER_USER = 100
_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

_library_cache: Dict[tuple, Dict[str, Any]] = {}
_library_lock = threading.Lock()


def probe(path: Path) -> Optional[Dict[str, Any]]:
    """Duration and tags of an audio file, or None when it has no audio."""
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error", "-select_streams", "a:0",
                "-show_entries", "stream=index:format=duration:format_tags=title,artist",
                "-of", "json", str(path),
            ],
            capture_output=True, text=True, timeout=30, check=True,
        )
        data = json.loads(result.stdout or "{}")
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    if not data.get("streams"):
        return None
    fmt = data.get("format") or {}
    try:
        duration = float(fmt.get("duration") or 0)
    except ValueError:
        duration = 0.0
    if duration <= 0:
        return None
    tags = {str(k).lower(): v for k, v in (fmt.get("tags") or {}).items()}
    return {"duration": round(duration, 3), "title": tags.get("title"), "artist": tags.get("artist")}


def _pretty(stem: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[_-]+", " ", stem)).strip().title() or "Untitled"


def library_id(relative: str) -> str:
    return "lib" + hashlib.sha256(relative.encode("utf-8")).hexdigest()[:20]


def list_library(root: Path | None = None) -> List[Dict[str, Any]]:
    """Every playable file under the library folder, sorted by category and title."""
    root = root or LIBRARY_DIR
    if not root.is_dir():
        return []
    tracks = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in AUDIO_EXTENSIONS or path.name.startswith("."):
            continue
        relative = path.relative_to(root).as_posix()
        stat = path.stat()
        key = (str(path), stat.st_mtime_ns, stat.st_size)
        with _library_lock:
            cached = _library_cache.get(key)
        if cached is None:
            info = probe(path)
            if info is None:
                logger.warning("Skipping music file without audio: %s", relative)
                continue
            parts = Path(relative).parts
            cached = {
                "source": "library",
                "id": library_id(relative),
                "title": info["title"] or _pretty(path.stem),
                "artist": info["artist"],
                "category": _pretty(parts[0]) if len(parts) > 1 else None,
                "duration": info["duration"],
            }
            with _library_lock:
                _library_cache[key] = cached
        tracks.append(cached)
    return sorted(tracks, key=lambda t: ((t["category"] or "").lower(), t["title"].lower()))


def library_path(track_id: str, root: Path | None = None) -> Optional[Path]:
    root = root or LIBRARY_DIR
    if not _ID.match(track_id or "") or not root.is_dir():
        return None
    for path in root.rglob("*"):
        if path.is_file() and path.suffix.lower() in AUDIO_EXTENSIONS:
            if library_id(path.relative_to(root).as_posix()) == track_id:
                return path
    return None


def transcode(source: Path, destination: Path) -> None:
    """Any audio (or video with sound) to stereo 48 kHz AAC, which every browser decodes."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ffmpeg", "-y", "-v", "error", "-i", str(source), "-vn", "-map", "0:a:0",
            "-t", str(UPLOAD_MAX_SECONDS), "-ac", "2", "-ar", "48000",
            "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(destination),
        ],
        capture_output=True, timeout=600, check=True,
    )


def store_upload(path: Path, user_id: str, track_id: str) -> str:
    """Save a transcoded upload; returns its storage reference."""
    storage = MediaStorage()
    if storage.enabled:
        key = storage.key("music", owner_key(user_id), f"{track_id}.m4a")
        return storage.upload_file(path, key)
    destination = Path(get_config().temp_dir) / "music" / f"{track_id}.m4a"
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(path), destination)
    return str(destination)


def local_upload(reference: str, track_id: str) -> Optional[Path]:
    """A local file for a stored upload, fetched into this machine's cache when needed."""
    if not is_s3(reference):
        path = Path(reference)
        return path if path.is_file() else None
    cached = Path(get_config().temp_dir) / "music-cache" / f"{track_id}.m4a"
    if cached.is_file():
        return cached
    partial = cached.with_name(f".{cached.name}.{uuid.uuid4().hex}")
    try:
        if not MediaStorage().fetch(reference, partial):
            return None
        partial.replace(cached)
        return cached
    finally:
        partial.unlink(missing_ok=True)


def delete_upload_file(reference: str, track_id: str) -> None:
    storage = MediaStorage()
    if is_s3(reference):
        storage.delete(reference)
        (Path(get_config().temp_dir) / "music-cache" / f"{track_id}.m4a").unlink(missing_ok=True)
    else:
        Path(reference).unlink(missing_ok=True)
