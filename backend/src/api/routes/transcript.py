"""The task page's Transcript view: the full source transcript, its video, and clips cut from it."""

from __future__ import annotations

import json
import logging
import math
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, RedirectResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ...config import get_config
from ...database import get_db
from ...media.transcription import load_cached_transcript_data
from ...media_storage import MediaStorage, STORAGE_ERRORS, is_s3
from ...services import moments_service as moments
from ...services import range_clip_service as range_clips
from ...services.moments_service import MomentsError
from ...services.range_clip_service import RangeClipError
from ...services.task_service import TaskService
from ...transcript_reader import build_reader_transcript, reader_clips
from ...utils.async_helpers import run_in_thread
from ...workers.job_queue import JobQueue
from ...youtube_utils import get_youtube_video_id
from .tasks import _require_task_owner

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/tasks", tags=["transcript"])

_PENDING_STATUSES = {"queued", "processing"}


def _json(value: Any) -> Any:
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            return None
    return value


async def _checkpoint_transcript(db: AsyncSession, task_id: str) -> Optional[Dict[str, Any]]:
    result = await db.execute(
        text("SELECT payload -> 'transcript_data' FROM task_processing_checkpoints WHERE task_id = :task_id"),
        {"task_id": task_id},
    )
    data = _json(result.scalar_one_or_none())
    return data if isinstance(data, dict) and data.get("words") else None


async def _cached_source_paths(db: AsyncSession, task: Dict[str, Any]) -> list[str]:
    """Stored source videos for the task's source, newest first."""
    source_url, source_type = task.get("source_url"), task.get("source_type")
    if not source_url or not source_type:
        return []
    result = await db.execute(
        text(
            """
            SELECT video_path FROM processing_cache
            WHERE source_url = :url AND source_type = :type AND video_path IS NOT NULL
            ORDER BY updated_at DESC
            """
        ),
        {"url": source_url, "type": source_type},
    )
    return [row for row in result.scalars().all() if row]


def _local_source(reference: str) -> Optional[Path]:
    """A local source file inside TEMP_DIR, or None (never serve paths outside it)."""
    if is_s3(reference):
        return None
    try:
        path = Path(reference).resolve()
        root = Path(get_config().temp_dir).resolve()
    except (OSError, RuntimeError):
        return None
    if root not in path.parents or not path.is_file():
        return None
    return path


async def _playable_source(db: AsyncSession, task: Dict[str, Any]) -> Optional[str]:
    """The stored source reference the browser can play: an S3 key or a local file."""
    for reference in await _cached_source_paths(db, task):
        if is_s3(reference) or _local_source(reference) is not None:
            return reference
    return None


async def _fallback_transcript(db: AsyncSession, task: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Tasks from before checkpoints: the transcript sidecar next to a local source."""
    for reference in await _cached_source_paths(db, task):
        path = _local_source(reference)
        if path is None:
            continue
        data = await run_in_thread(load_cached_transcript_data, path)
        if isinstance(data, dict) and data.get("words"):
            return data
    return None


def _media_descriptor(task_id: str, task: Dict[str, Any], playable: Optional[str]) -> Optional[Dict[str, Any]]:
    if playable:
        return {"kind": "file", "url": f"/tasks/{task_id}/source/media"}
    if task.get("source_type") == "youtube" and task.get("source_url"):
        video_id = get_youtube_video_id(task["source_url"])
        if video_id:
            return {"kind": "youtube", "video_id": video_id}
    return None


@router.get("/{task_id}/transcript")
async def get_transcript(task_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    """The full source transcript for the Transcript view, with clipped ranges and media."""
    service = TaskService(db)
    task = await _require_task_owner(request, service, db, task_id)

    data = await _checkpoint_transcript(db, task_id) or await _fallback_transcript(db, task)
    if not data:
        if task.get("status") in _PENDING_STATUSES:
            raise HTTPException(409, "The transcript is not ready yet")
        raise HTTPException(404, "No transcript is stored for this video")

    reader = await run_in_thread(build_reader_transcript, data)
    clips = await db.execute(
        text(
            """
            SELECT id, start_time, end_time, hook_title, clip_order, workflow_meta
            FROM generated_clips WHERE task_id = :task_id ORDER BY clip_order
            """
        ),
        {"task_id": task_id},
    )
    rows = []
    for row in clips.mappings().all():
        clip = dict(row)
        clip["workflow_meta"] = _json(clip.get("workflow_meta")) or {}
        rows.append(clip)

    words = reader["words"]
    duration = float(task.get("source_duration_seconds") or 0) or (words[-1][2] if words else 0.0)
    return {
        "task_id": task_id,
        "title": task.get("source_title"),
        "duration": duration,
        **reader,
        "clips": reader_clips(rows),
        "media": _media_descriptor(task_id, task, await _playable_source(db, task)),
    }


@router.get("/{task_id}/source/media")
async def get_source_media(task_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    """Stream the stored source video (range requests work) or redirect to its signed URL."""
    service = TaskService(db)
    task = await _require_task_owner(request, service, db, task_id)
    reference = await _playable_source(db, task)
    await db.close()
    if reference is None:
        raise HTTPException(404, "The source video is not stored")
    if is_s3(reference):
        try:
            url = await run_in_thread(MediaStorage().signed_url, reference, "source.mp4")
        except STORAGE_ERRORS as exc:
            logger.warning("Source media URL failed for task %s: %s", task_id, type(exc).__name__)
            raise HTTPException(503, "Source video storage is unavailable")
        return RedirectResponse(url, status_code=307)
    path = _local_source(reference)
    if path is None:
        raise HTTPException(404, "The source video is not stored")
    return FileResponse(path, media_type="video/mp4", headers={"Cache-Control": "private, max-age=3600"})


def _range_error(exc: RangeClipError) -> HTTPException:
    return HTTPException(exc.status, {"code": exc.code, "message": str(exc)})


@router.post("/{task_id}/clips/from-range")
async def create_clip_from_range(task_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    """Render a new clip from a source range and add it to the task (no minutes charged)."""
    service = TaskService(db)
    task = await _require_task_owner(request, service, db, task_id)
    if task.get("status") in _PENDING_STATUSES:
        raise HTTPException(409, {"code": "task_busy", "message": "Wait for processing to finish."})
    try:
        payload = await request.json()
    except ValueError:
        payload = None
    if not isinstance(payload, dict):
        raise HTTPException(400, {"code": "invalid_body", "message": "Send a JSON object."})
    try:
        start = float(payload.get("start"))
        end = float(payload.get("end"))
    except (TypeError, ValueError):
        raise HTTPException(400, {"code": "invalid_range", "message": "start and end must be numbers."})
    if not (math.isfinite(start) and math.isfinite(end)):
        raise HTTPException(400, {"code": "invalid_range", "message": "start and end must be numbers."})
    try:
        start, end = range_clips.validate_range(start, end, task.get("source_duration_seconds"))
        job = await range_clips.create_job(
            db, task_id, task["user_id"], start, end, range_clips.clean_hook_title(payload.get("hook_title"))
        )
    except RangeClipError as exc:
        raise _range_error(exc)
    try:
        queue = getattr(request.app.state, "queue_adapter", JobQueue)
        await queue.enqueue_job("create_range_clip", job["id"], _job_id=f"range-clip:{job['id']}")
    except Exception:
        logger.exception("Could not enqueue range clip %s", job["id"])
        await range_clips.fail_job(db, job["id"], "The render queue is unavailable. Try again.")
        raise HTTPException(503, {"code": "queue_unavailable", "message": "The render queue is unavailable."})
    return {"job": job}


@router.get("/{task_id}/clips/from-range")
async def list_range_clips(task_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    """Recent clip-from-range requests for the task, newest first."""
    service = TaskService(db)
    await _require_task_owner(request, service, db, task_id)
    return {"jobs": await range_clips.list_jobs(db, task_id)}


@router.delete("/{task_id}/clips/from-range/{job_id}")
async def dismiss_range_clip(task_id: str, job_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    """Hide a finished or failed request; a running one cannot be dismissed."""
    service = TaskService(db)
    await _require_task_owner(request, service, db, task_id)
    if not await range_clips.dismiss_job(db, task_id, job_id):
        raise HTTPException(404, {"code": "not_found", "message": "Nothing to dismiss."})
    return {"ok": True}


def _moments_error(exc: MomentsError) -> HTTPException:
    return HTTPException(exc.status, {"code": exc.code, "message": str(exc)})


@router.post("/{task_id}/moments")
async def find_moments(task_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    """Ask the AI for moments in the transcript (a preset and/or a request, optionally in a range)."""
    service = TaskService(db)
    task = await _require_task_owner(request, service, db, task_id)
    if task.get("status") in _PENDING_STATUSES:
        raise HTTPException(409, {"code": "task_busy", "message": "Wait for processing to finish."})
    try:
        payload = await request.json()
    except ValueError:
        payload = None
    if not isinstance(payload, dict):
        raise HTTPException(400, {"code": "invalid_body", "message": "Send a JSON object."})
    if not await _checkpoint_transcript(db, task_id):
        raise HTTPException(404, {"code": "no_transcript", "message": "No transcript is stored for this video."})
    try:
        cleaned = moments.clean_request(
            payload.get("preset"), payload.get("prompt"), payload.get("range_start"), payload.get("range_end")
        )
        run = await moments.create_run(db, task_id, task["user_id"], cleaned, get_config().moments_daily_limit)
    except MomentsError as exc:
        raise _moments_error(exc)
    try:
        queue = getattr(request.app.state, "queue_adapter", JobQueue)
        await queue.enqueue_job(
            "find_moments_job", run["id"], _job_id=f"moments:{run['id']}", _queue_name=moments.MOMENTS_QUEUE
        )
    except Exception:
        logger.exception("Could not enqueue moment search %s", run["id"])
        await moments._finish(db, run["id"], "failed", error="The AI queue is unavailable. Try again.")
        raise HTTPException(503, {"code": "queue_unavailable", "message": "The AI queue is unavailable."})
    return {"run": run}


@router.get("/{task_id}/moments")
async def list_moments(task_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    """Recent moment searches for the task with their results, newest first."""
    service = TaskService(db)
    await _require_task_owner(request, service, db, task_id)
    return {"runs": await moments.list_runs(db, task_id)}


@router.delete("/{task_id}/moments/{run_id}")
async def delete_moments(task_id: str, run_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    """Remove a finished search from the panel."""
    service = TaskService(db)
    await _require_task_owner(request, service, db, task_id)
    if not await moments.delete_run(db, task_id, run_id):
        raise HTTPException(404, {"code": "not_found", "message": "Nothing to remove."})
    return {"ok": True}
