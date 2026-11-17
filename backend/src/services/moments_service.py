"""AI search for moments in the transcript reader.

``POST /tasks/{id}/moments`` stores a ``transcript_moment_runs`` row and
enqueues ``find_moments_job`` on the AI worker. The job runs the same
selection model as clip generation (``get_most_relevant_parts_by_transcript``)
on the stored transcript, steered by a preset and/or the creator's request,
optionally limited to a range. Results are snapped to whole sentences so a
moment turns into a clip with one click.

Imports stay light: the AI worker does not load the video pipeline.
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from typing import Any, Dict, List, Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..transcript_reader import build_reader_transcript, snap_to_sentences
from ..utils.async_helpers import run_in_thread

logger = logging.getLogger(__name__)

MOMENTS_QUEUE = "supoclip_ai"
MOMENTS_JOB_TIMEOUT_SECONDS = 900
PROMPT_MAX_CHARS = 500
MIN_RANGE_SECONDS = 30.0
# A running row older than this lost its worker; it reads as failed.
STALE_RUN_SECONDS = 20 * 60.0
RECENT_RUNS = 10
MAX_ACTIVE_PER_TASK = 2

# Steering for each preset; "viral" is the plain highlights selection.
PRESETS: Dict[str, Optional[str]] = {
    "viral": None,
    "quotes": "Find short, quotable lines that land on their own: memorable, punchy statements a viewer would repeat.",
    "stories": "Find complete stories or anecdotes, each with a setup and a payoff, that stand on their own.",
    "advice": "Find practical, actionable advice or tips a viewer can apply right away.",
    "hot_takes": "Find bold, surprising or controversial opinions that would make viewers react.",
}

_LINE = re.compile(r"^\[(\d{1,2}:\d{2}(?::\d{2})?) - (\d{1,2}:\d{2}(?::\d{2})?)\]")

_COLUMNS = (
    "id, preset, prompt, range_start, range_end, status, moments, error, created_at, "
    "(status = 'running' AND updated_at < NOW() - make_interval(secs => :stale)) AS stale"
)


class MomentsError(ValueError):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code = code
        self.status = status


def _clock(value: str) -> float:
    total = 0.0
    for part in value.split(":"):
        total = total * 60 + int(part)
    return total


def clean_request(preset: Any, prompt: Any, range_start: Any, range_end: Any) -> Dict[str, Any]:
    """Validate a search request; raises MomentsError."""
    if preset is not None and preset not in PRESETS:
        raise MomentsError("invalid_preset", "Unknown preset.")
    prompt = " ".join(prompt.split())[:PROMPT_MAX_CHARS] if isinstance(prompt, str) else ""
    if not preset and not prompt:
        raise MomentsError("empty", "Choose a preset or describe what to find.")
    bounds = None
    if range_start is not None or range_end is not None:
        try:
            start, end = float(range_start), float(range_end)
        except (TypeError, ValueError):
            raise MomentsError("invalid_range", "The range must be two numbers.")
        if not (start >= 0 and end > start):
            raise MomentsError("invalid_range", "The range end must come after its start.")
        if end - start < MIN_RANGE_SECONDS:
            raise MomentsError("range_too_short", "Select at least 30 seconds to search in.")
        bounds = (round(start, 3), round(end, 3))
    return {"preset": preset or None, "prompt": prompt or None, "range": bounds}


def steering_text(preset: Optional[str], prompt: Optional[str]) -> Optional[str]:
    parts = [part for part in (PRESETS.get(preset or "") if preset else None, prompt) if part]
    return " ".join(parts) or None


def slice_transcript(transcript: str, bounds: Optional[tuple]) -> str:
    """Keep the formatted transcript lines that overlap ``bounds``."""
    if not bounds:
        return transcript
    start, end = bounds
    kept = []
    for line in transcript.splitlines():
        match = _LINE.match(line.strip())
        if match and _clock(match.group(2)) >= start and _clock(match.group(1)) <= end:
            kept.append(line)
    return "\n".join(kept)


def build_moments(segments: List[Any], reader: Dict[str, Any], bounds: Optional[tuple]) -> List[Dict[str, Any]]:
    """Model segments → sentence-snapped moments, best first, without duplicates."""
    words, sentences = reader["words"], reader["sentences"]
    moments: List[Dict[str, Any]] = []
    for segment in segments:
        try:
            start, end = _clock(segment.start_time), _clock(segment.end_time)
        except (AttributeError, ValueError):
            continue
        if bounds:
            start, end = max(start, bounds[0]), min(end, bounds[1])
        if end <= start:
            continue
        snapped = snap_to_sentences(words, sentences, start, end)
        if not snapped:
            continue
        if any(min(m["end"], snapped[1]) - max(m["start"], snapped[0]) > 0.5 * (snapped[1] - snapped[0]) for m in moments):
            continue
        virality = getattr(segment, "virality", None)
        moments.append({
            "id": uuid.uuid4().hex[:12],
            "start": snapped[0],
            "end": snapped[1],
            "title": getattr(segment, "hook_title", None) or None,
            "reason": (getattr(virality, "virality_reasoning", None) or getattr(segment, "reasoning", "") or "")[:400],
            "score": int(getattr(virality, "total_score", 0) or 0),
            "text": (getattr(segment, "text", "") or "")[:600],
        })
    moments.sort(key=lambda m: m["score"], reverse=True)
    return moments


def _public(row: Any) -> Dict[str, Any]:
    moments = row["moments"]
    if isinstance(moments, str):
        moments = json.loads(moments)
    return {
        "id": row["id"],
        "preset": row["preset"],
        "prompt": row["prompt"],
        "range": [row["range_start"], row["range_end"]] if row["range_start"] is not None else None,
        "status": "failed" if row["stale"] else row["status"],
        "moments": moments or [],
        "error": row["error"] or ("The search stopped. Try again." if row["stale"] else None),
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
    }


async def create_run(
    db: AsyncSession, task_id: str, user_id: str, request: Dict[str, Any], daily_limit: int
) -> Dict[str, Any]:
    counts = (await db.execute(
        text(
            """
            SELECT
              COUNT(*) FILTER (WHERE user_id = :user_id AND status <> 'failed'
                               AND created_at >= NOW() - INTERVAL '1 day') AS daily,
              COUNT(*) FILTER (WHERE task_id = :task_id AND (status = 'queued' OR (status = 'running'
                               AND updated_at >= NOW() - make_interval(secs => :stale)))) AS active
            FROM transcript_moment_runs
            WHERE user_id = :user_id OR task_id = :task_id
            """
        ),
        {"user_id": user_id, "task_id": task_id, "stale": STALE_RUN_SECONDS},
    )).mappings().one()
    if int(counts["active"] or 0) >= MAX_ACTIVE_PER_TASK:
        raise MomentsError("busy", "A search is already running. Wait for it to finish.", status=429)
    if int(counts["daily"] or 0) >= daily_limit:
        raise MomentsError("daily_limit", "You've reached today's limit for AI searches.", status=429)
    bounds = request["range"]
    result = await db.execute(
        text(
            "INSERT INTO transcript_moment_runs (id, task_id, user_id, preset, prompt, range_start, range_end) "
            f"VALUES (:id, :task_id, :user_id, :preset, :prompt, :start, :end) RETURNING {_COLUMNS}"
        ),
        {
            "id": str(uuid.uuid4()), "task_id": task_id, "user_id": user_id,
            "preset": request["preset"], "prompt": request["prompt"],
            "start": bounds[0] if bounds else None, "end": bounds[1] if bounds else None,
            "stale": STALE_RUN_SECONDS,
        },
    )
    row = result.mappings().one()
    await db.commit()
    return _public(row)


async def list_runs(db: AsyncSession, task_id: str) -> List[Dict[str, Any]]:
    result = await db.execute(
        text(
            f"SELECT {_COLUMNS} FROM transcript_moment_runs WHERE task_id = :task_id "
            "ORDER BY created_at DESC LIMIT :limit"
        ),
        {"task_id": task_id, "stale": STALE_RUN_SECONDS, "limit": RECENT_RUNS},
    )
    return [_public(row) for row in result.mappings().all()]


async def delete_run(db: AsyncSession, task_id: str, run_id: str) -> bool:
    result = await db.execute(
        text(
            "DELETE FROM transcript_moment_runs WHERE id = :id AND task_id = :task_id "
            "AND (status IN ('completed', 'failed') OR (status = 'running' "
            "AND updated_at < NOW() - make_interval(secs => :stale)))"
        ),
        {"id": run_id, "task_id": task_id, "stale": STALE_RUN_SECONDS},
    )
    await db.commit()
    return bool(result.rowcount)


async def _finish(db: AsyncSession, run_id: str, status: str, moments=None, error=None) -> None:
    await db.execute(
        text(
            "UPDATE transcript_moment_runs SET status = :status, moments = CAST(:moments AS jsonb), "
            "error = :error, updated_at = NOW() WHERE id = :id"
        ),
        {"id": run_id, "status": status, "moments": json.dumps(moments or []), "error": error},
    )
    await db.commit()


async def _analyse(transcript: str, instructions: Optional[str]):
    """The clip-selection model; a seam for tests."""
    from ..ai import get_most_relevant_parts_by_transcript

    return await get_most_relevant_parts_by_transcript(transcript, instructions=instructions)


async def find_moments_job(ctx, run_id: str) -> None:
    """AI worker job: search a run's transcript and store the moments."""
    from ..database import AsyncSessionLocal

    async with AsyncSessionLocal() as db:
        claimed = (await db.execute(
            text(
                "UPDATE transcript_moment_runs SET status = 'running', updated_at = NOW() "
                "WHERE id = :id AND status = 'queued' "
                "RETURNING task_id, preset, prompt, range_start, range_end"
            ),
            {"id": run_id},
        )).mappings().first()
        await db.commit()
        if not claimed:
            return
        try:
            payload = (await db.execute(
                text(
                    "SELECT payload ->> 'transcript' AS transcript, payload -> 'transcript_data' AS data "
                    "FROM task_processing_checkpoints WHERE task_id = :task_id"
                ),
                {"task_id": claimed["task_id"]},
            )).mappings().first()
            await db.rollback()
            transcript = payload and payload["transcript"]
            data = payload and payload["data"]
            if isinstance(data, str):
                data = json.loads(data)
            if not isinstance(transcript, str) or not transcript.strip() or not isinstance(data, dict):
                raise ValueError("No transcript is stored for this video.")
            bounds = (
                (float(claimed["range_start"]), float(claimed["range_end"]))
                if claimed["range_start"] is not None else None
            )
            searched = slice_transcript(transcript, bounds)
            if not searched.strip():
                raise ValueError("Nothing is said in that part of the video.")

            analysis = await _analyse(searched, steering_text(claimed["preset"], claimed["prompt"]))
            reader = await run_in_thread(build_reader_transcript, data)
            moments = build_moments(list(getattr(analysis, "most_relevant_segments", []) or []), reader, bounds)
            await _finish(db, run_id, "completed", moments=moments)
            logger.info("Moment search %s found %d moments", run_id, len(moments))
        except Exception as exc:
            logger.exception("Moment search %s failed", run_id)
            message = str(exc) if isinstance(exc, ValueError) else "The search failed. Try again."
            await db.rollback()
            await _finish(db, run_id, "failed", error=message[:500])
