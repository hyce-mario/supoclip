"""Clips made from a range the user picked in the transcript reader.

``POST /tasks/{id}/clips/from-range`` stores a ``range_clip_jobs`` row and
enqueues ``create_range_clip`` on the video worker. The worker renders the
exact range with the task's settings (captions, cleanup, B-roll, plan
resolution) and appends the clip to the task. No minutes are charged: the
source was already metered when the task was created.
"""

from __future__ import annotations

import json
import logging
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..clip_cleanup import normalize_clip_cleanup_settings
from ..media_storage import media_work
from ..stream_transfer import run_stream_download
from ..stream_source import download_stream_sections
from ..utils.async_helpers import run_in_thread
from ..youtube_source import load_time_map, localize_segment, restore_clip_timeline

logger = logging.getLogger(__name__)

MIN_RANGE_SECONDS = 3.0
MAX_RANGE_SECONDS = 180.0
# Requests waiting or rendering for one task at a time.
MAX_ACTIVE_PER_TASK = 10
# A rendering row older than this lost its worker; it reads as failed.
STALE_RENDER_SECONDS = 45 * 60.0
HOOK_TITLE_MAX_CHARS = 80
RECENT_JOBS = 20

_COLUMNS = (
    "id, task_id, start_seconds, end_seconds, hook_title, status, clip_id, error, "
    "created_at, updated_at, "
    "(status = 'rendering' AND updated_at < NOW() - make_interval(secs => :stale)) AS stale"
)


class RangeClipError(ValueError):
    """A request the API rejects with a 4xx; ``code`` is stable for the client."""

    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code = code
        self.status = status


def validate_range(start: float, end: float, source_duration: Optional[float]) -> tuple[float, float]:
    """Round to milliseconds and check length and bounds."""
    start, end = round(float(start), 3), round(float(end), 3)
    if start < 0 or end <= start:
        raise RangeClipError("invalid_range", "The end must come after the start.")
    if source_duration and end > float(source_duration) + 1.0:
        raise RangeClipError("out_of_bounds", "The range runs past the end of the video.")
    length = end - start
    if length < MIN_RANGE_SECONDS:
        raise RangeClipError("too_short", f"Clips need at least {MIN_RANGE_SECONDS:.0f} seconds.")
    if length > MAX_RANGE_SECONDS:
        raise RangeClipError("too_long", f"Clips can be at most {MAX_RANGE_SECONDS / 60:.0f} minutes.")
    return start, end


def clean_hook_title(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    title = " ".join(value.split())[:HOOK_TITLE_MAX_CHARS].strip()
    return title or None


def _public(row: Any) -> Dict[str, Any]:
    status = "failed" if row["stale"] else row["status"]
    return {
        "id": row["id"],
        "start": float(row["start_seconds"]),
        "end": float(row["end_seconds"]),
        "hook_title": row["hook_title"],
        "status": status,
        "clip_id": row["clip_id"],
        "error": row["error"] or ("The render stopped. Try again." if row["stale"] else None),
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
    }


async def create_job(
    db: AsyncSession, task_id: str, user_id: str, start: float, end: float, hook_title: Optional[str]
) -> Dict[str, Any]:
    active = await db.execute(
        text(
            "SELECT COUNT(*) FROM range_clip_jobs WHERE task_id = :task_id "
            "AND (status = 'queued' OR (status = 'rendering' "
            "AND updated_at >= NOW() - make_interval(secs => :stale)))"
        ),
        {"task_id": task_id, "stale": STALE_RENDER_SECONDS},
    )
    if int(active.scalar() or 0) >= MAX_ACTIVE_PER_TASK:
        raise RangeClipError(
            "too_many", "A few clips are already rendering. Wait for one to finish.", status=429
        )
    job_id = str(uuid.uuid4())
    result = await db.execute(
        text(
            "INSERT INTO range_clip_jobs (id, task_id, user_id, start_seconds, end_seconds, hook_title) "
            f"VALUES (:id, :task_id, :user_id, :start, :end, :hook_title) RETURNING {_COLUMNS}"
        ),
        {
            "id": job_id, "task_id": task_id, "user_id": user_id, "start": start, "end": end,
            "hook_title": hook_title, "stale": STALE_RENDER_SECONDS,
        },
    )
    row = result.mappings().one()
    await db.commit()
    return _public(row)


async def list_jobs(db: AsyncSession, task_id: str) -> List[Dict[str, Any]]:
    result = await db.execute(
        text(
            f"SELECT {_COLUMNS} FROM range_clip_jobs WHERE task_id = :task_id "
            "ORDER BY created_at DESC LIMIT :limit"
        ),
        {"task_id": task_id, "stale": STALE_RENDER_SECONDS, "limit": RECENT_JOBS},
    )
    return [_public(row) for row in result.mappings().all()]


async def dismiss_job(db: AsyncSession, task_id: str, job_id: str) -> bool:
    """Forget a finished or failed request. Running ones stay."""
    result = await db.execute(
        text(
            "DELETE FROM range_clip_jobs WHERE id = :id AND task_id = :task_id "
            "AND (status IN ('completed', 'failed') OR (status = 'rendering' "
            "AND updated_at < NOW() - make_interval(secs => :stale)))"
        ),
        {"id": job_id, "task_id": task_id, "stale": STALE_RENDER_SECONDS},
    )
    await db.commit()
    return bool(result.rowcount)


async def fail_job(db: AsyncSession, job_id: str, message: str) -> None:
    await db.execute(
        text(
            "UPDATE range_clip_jobs SET status = 'failed', error = :error, updated_at = NOW() "
            "WHERE id = :id AND status IN ('queued', 'rendering')"
        ),
        {"id": job_id, "error": message[:500]},
    )
    await db.commit()


async def _claim(db: AsyncSession, job_id: str) -> Optional[Dict[str, Any]]:
    result = await db.execute(
        text(
            "UPDATE range_clip_jobs SET status = 'rendering', updated_at = NOW() "
            "WHERE id = :id AND status = 'queued' "
            "RETURNING id, task_id, start_seconds, end_seconds, hook_title"
        ),
        {"id": job_id},
    )
    row = result.mappings().first()
    await db.commit()
    return dict(row) if row else None


def _segment(start: float, end: float, hook_title: Optional[str], mmss) -> Dict[str, Any]:
    """One planned segment: the exact range, with the task's cleanup but no snapping or extension."""
    return {
        "start_time": mmss(start),
        "end_time": mmss(end),
        "source_ranges": [(start, end)],
        "planned": True,
        "max_seconds": end - start,
        "text": "",
        "relevance_score": 0.5,
        "reasoning": "Created from the transcript",
        "virality_score": 0,
        "hook_score": 0,
        "engagement_score": 0,
        "value_score": 0,
        "shareability_score": 0,
        "hook_type": None,
        "hook_title": hook_title,
        "broll": [],
    }


async def _checkpoint_transcript(db: AsyncSession, task_id: str) -> Optional[Dict[str, Any]]:
    result = await db.execute(
        text("SELECT payload -> 'transcript_data' FROM task_processing_checkpoints WHERE task_id = :task_id"),
        {"task_id": task_id},
    )
    data = result.scalar_one_or_none()
    if isinstance(data, str):
        data = json.loads(data)
    return data if isinstance(data, dict) and data.get("words") else None


def _write_transcript_sidecar(video_path: Path, data: Dict[str, Any]) -> None:
    """Captions read the words next to the source; a cleaned-up sidecar comes back from the checkpoint."""
    from ..media.transcription import load_cached_transcript_data

    if load_cached_transcript_data(video_path):
        return
    sidecar = video_path.with_suffix(".transcript_cache.json")
    temporary = sidecar.with_suffix(".tmp")
    temporary.write_text(json.dumps(data), encoding="utf-8")
    temporary.replace(sidecar)
    logger.info("Restored the transcript next to %s from the task checkpoint", video_path)


@media_work
async def _render(service, task: Dict[str, Any], job: Dict[str, Any]) -> Dict[str, Any]:
    """Fetch the source like a regeneration does and render one clip; returns clip_info."""
    from .video_service import resolve_upload_for_edit
    from ..clip_duration import clip_duration, normalize_clip_length

    task_id = task["id"]
    source_url = task.get("source_url")
    source_type = task.get("source_type")
    if not source_url or not source_type:
        raise ValueError("This task has no source video to cut from.")
    start, end = float(job["start_seconds"]), float(job["end_seconds"])
    segment = _segment(start, end, job.get("hook_title"), service._seconds_to_mmss)

    metadata = await service._load_task_source_settings(task_id)
    cleanup = normalize_clip_cleanup_settings(
        metadata.get("cut_long_pauses"),
        metadata.get("pause_threshold_ms"),
        metadata.get("remove_filler_words"),
        metadata.get("filtered_words"),
    )
    download_quality, output_short_side = await service._media_limits(task.get("user_id"))

    if source_type == "youtube":
        downloaded = await service.video_service.download_video(
            source_url, quality=download_quality, task_id=task_id, ranges=[(start, end)],
        )
        if not downloaded:
            raise ValueError("Could not download the source video.")
        video_path = Path(downloaded)
    elif source_type in {"twitch", "kick"}:
        video_path = await run_stream_download(
            download_stream_sections, source_url, [segment],
            task.get("source_duration_seconds"), task_id,
        )
    else:
        video_path = await resolve_upload_for_edit(service.video_service, source_url)
        if not video_path.exists():
            raise ValueError("The source video is no longer available.")

    try:
        video_path = await service.video_service.prepare_source(video_path)
        time_map = await run_in_thread(load_time_map, video_path)
        if time_map is None:
            # The checkpoint is on the source timeline, like a full source file.
            transcript = await _checkpoint_transcript(service.db, task_id)
            if transcript:
                await run_in_thread(_write_transcript_sidecar, video_path, transcript)
        render_segment = localize_segment(segment, time_map) if time_map else segment
        clips_info = await service.video_service.create_video_clips(
            video_path,
            [render_segment],
            task.get("font_family") or None,
            task.get("font_size") or None,
            task.get("font_color") or None,
            task.get("caption_template") or "default",
            metadata.get("output_format", "vertical"),
            metadata.get("add_subtitles", True),
            cleanup,
            max_short_side=output_short_side,
            max_clip_seconds=max(
                MAX_RANGE_SECONDS,
                clip_duration(normalize_clip_length(metadata.get("clip_length"))).maximum,
            ),
            include_broll=bool(task.get("include_broll")),
        )
        if not clips_info:
            raise ValueError("The clip could not be rendered.")
        clip_info = clips_info[0]
        if time_map:
            await run_in_thread(restore_clip_timeline, clip_info, time_map, segment)
        return clip_info
    finally:
        if source_type in {"youtube", "twitch", "kick"}:
            service._cleanup_source_video(video_path, source_type, source_url)


async def create_range_clip(ctx, job_id: str) -> None:
    """Worker job: render a range_clip_jobs row and append the clip to its task."""
    from ..database import AsyncSessionLocal
    from ..repositories.edit_transaction import task_edit_transaction
    from .task_service import TaskService

    async with AsyncSessionLocal() as db:
        job = await _claim(db, job_id)
    if job is None:
        return
    task_id = job["task_id"]
    try:
        async with AsyncSessionLocal() as db:
            service = TaskService(db)
            task = await service.task_repo.get_task_by_id(db, task_id)
            if not task:
                raise ValueError("The task was deleted.")
            # Rendering takes minutes; the row lock is only held to add the clip.
            await db.rollback()
            clip_info = await _render(service, task, job)

            async with task_edit_transaction(db, task_id):
                orders = await db.execute(
                    text("SELECT COALESCE(MAX(clip_order), 0) FROM generated_clips WHERE task_id = :task_id"),
                    {"task_id": task_id},
                )
                clip_id = await service.clip_repo.create_clip(
                    db,
                    task_id=task_id,
                    filename=clip_info["filename"],
                    file_path=clip_info["path"],
                    start_time=clip_info["start_time"],
                    end_time=clip_info["end_time"],
                    duration=clip_info["duration"],
                    text=clip_info.get("text") or "",
                    relevance_score=clip_info.get("relevance_score", 0.5),
                    reasoning=clip_info.get("reasoning") or "Created from the transcript",
                    clip_order=int(orders.scalar() or 0) + 1,
                    hook_title=clip_info.get("hook_title"),
                )
                await service.clip_repo.reorder_task_clips(db, task_id)
                await db.execute(
                    text(
                        "UPDATE range_clip_jobs SET status = 'completed', clip_id = :clip_id, "
                        "error = NULL, updated_at = NOW() WHERE id = :id"
                    ),
                    {"id": job_id, "clip_id": clip_id},
                )
        logger.info("Range clip %s added to task %s as clip %s", job_id, task_id, clip_id)
    except Exception as exc:
        logger.exception("Range clip %s for task %s failed", job_id, task_id)
        message = str(exc) if isinstance(exc, ValueError) else "The clip could not be rendered."
        async with AsyncSessionLocal() as db:
            await fail_job(db, job_id, message)
