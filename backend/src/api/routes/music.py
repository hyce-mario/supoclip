"""Background music for the clip studio: the built-in library and creators' uploads."""

from __future__ import annotations

import logging
import mimetypes
import tempfile
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ... import music_library
from ...config import get_config
from ...database import get_db
from ...media_storage import STORAGE_ERRORS
from ...utils.async_helpers import run_in_thread
from .media import _get_authenticated_user_id

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/music", tags=["music"])

_CHUNK = 1024 * 1024


def _upload_row(row) -> dict:
    return {
        "source": "upload",
        "id": row["id"],
        "title": row["title"],
        "artist": None,
        "category": None,
        "duration": float(row["duration"]),
    }


async def _owned_upload(db: AsyncSession, user_id: str, track_id: str):
    result = await db.execute(
        text("SELECT id, title, duration, reference FROM user_music_tracks WHERE id = :id AND user_id = :user_id"),
        {"id": track_id, "user_id": user_id},
    )
    return result.mappings().first()


@router.get("")
async def list_music(request: Request, db: AsyncSession = Depends(get_db)):
    """The library and the caller's uploads."""
    user_id = await _get_authenticated_user_id(request, db)
    library = await run_in_thread(music_library.list_library)
    uploads = await db.execute(
        text("SELECT id, title, duration FROM user_music_tracks WHERE user_id = :user_id ORDER BY created_at DESC"),
        {"user_id": user_id},
    )
    return {
        "library": library,
        "uploads": [_upload_row(row) for row in uploads.mappings().all()],
        "limits": {"maxBytes": music_library.UPLOAD_MAX_BYTES, "maxSeconds": music_library.UPLOAD_MAX_SECONDS},
    }


@router.post("/uploads")
async def upload_music(
    request: Request,
    uploaded_file: UploadFile = File(..., alias="file"),
    db: AsyncSession = Depends(get_db),
):
    """Add one of the caller's own tracks (any common audio format, transcoded to AAC)."""
    user_id = await _get_authenticated_user_id(request, db)
    count = await db.execute(
        text("SELECT COUNT(*) FROM user_music_tracks WHERE user_id = :user_id"), {"user_id": user_id}
    )
    if int(count.scalar() or 0) >= music_library.UPLOADS_PER_USER:
        raise HTTPException(409, {"code": "too_many", "message": "Delete a track before adding another."})

    title = Path(uploaded_file.filename or "").stem.strip()[:200] or "Untitled"
    track_id = uuid.uuid4().hex
    scratch = Path(get_config().temp_dir) / "music-uploads"
    scratch.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=scratch) as work:
        raw = Path(work) / "upload"
        size = 0
        with raw.open("wb") as handle:
            while chunk := await uploaded_file.read(_CHUNK):
                size += len(chunk)
                if size > music_library.UPLOAD_MAX_BYTES:
                    raise HTTPException(413, {"code": "too_large", "message": "Tracks can be at most 30 MB."})
                handle.write(chunk)
        info = await run_in_thread(music_library.probe, raw)
        if info is None:
            raise HTTPException(400, {"code": "not_audio", "message": "That file has no audio we can read."})
        converted = Path(work) / f"{track_id}.m4a"
        try:
            await run_in_thread(music_library.transcode, raw, converted)
        except Exception:
            logger.warning("Music transcode failed for an upload", exc_info=True)
            raise HTTPException(400, {"code": "not_audio", "message": "That file has no audio we can read."})
        converted_info = await run_in_thread(music_library.probe, converted)
        if converted_info is None:
            raise HTTPException(400, {"code": "not_audio", "message": "That file has no audio we can read."})
        try:
            reference = await run_in_thread(music_library.store_upload, converted, user_id, track_id)
        except STORAGE_ERRORS:
            logger.exception("Storing a music upload failed")
            raise HTTPException(503, {"code": "storage", "message": "Storage is unavailable. Try again."})
        size_bytes = converted.stat().st_size if converted.exists() else size
    title = (info.get("title") or title)[:200]
    await db.execute(
        text(
            "INSERT INTO user_music_tracks (id, user_id, title, duration, size_bytes, reference) "
            "VALUES (:id, :user_id, :title, :duration, :size, :reference)"
        ),
        {
            "id": track_id, "user_id": user_id, "title": title,
            "duration": converted_info["duration"], "size": size_bytes, "reference": reference,
        },
    )
    await db.commit()
    return {"track": {"source": "upload", "id": track_id, "title": title, "artist": None, "category": None,
                      "duration": converted_info["duration"]}}


@router.delete("/uploads/{track_id}")
async def delete_music(track_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    """Remove one of the caller's tracks. Drafts that use it play without it."""
    user_id = await _get_authenticated_user_id(request, db)
    row = await _owned_upload(db, user_id, track_id)
    if not row:
        raise HTTPException(404, {"code": "not_found", "message": "Track not found."})
    await db.execute(text("DELETE FROM user_music_tracks WHERE id = :id"), {"id": track_id})
    await db.commit()
    try:
        await run_in_thread(music_library.delete_upload_file, row["reference"], track_id)
    except Exception:
        logger.warning("Could not delete music file for %s", track_id, exc_info=True)
    return {"ok": True}


def _audio_response(path: Path) -> FileResponse:
    media_type = mimetypes.guess_type(path.name)[0] or "audio/mp4"
    if path.suffix.lower() == ".m4a":
        media_type = "audio/mp4"
    return FileResponse(path, media_type=media_type, headers={"Cache-Control": "private, max-age=86400"})


@router.get("/library/{track_id}/file")
async def library_file(track_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    await _get_authenticated_user_id(request, db)
    path = await run_in_thread(music_library.library_path, track_id)
    if path is None:
        raise HTTPException(404, "Track not found")
    return _audio_response(path)


@router.get("/uploads/{track_id}/file")
async def upload_file(track_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    user_id = await _get_authenticated_user_id(request, db)
    row = await _owned_upload(db, user_id, track_id)
    await db.close()
    if not row:
        raise HTTPException(404, "Track not found")
    try:
        path = await run_in_thread(music_library.local_upload, row["reference"], track_id)
    except STORAGE_ERRORS:
        raise HTTPException(503, "Storage is unavailable")
    if path is None:
        raise HTTPException(404, "Track file is missing")
    return _audio_response(path)
