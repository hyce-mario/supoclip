"""Transcript moment searches: the API rows and the AI worker job."""

from types import SimpleNamespace

from sqlalchemy import text

from src.config import get_config
from src.services import moments_service
from tests.integration.test_transcript_routes import seed

FORMATTED = (
    "[00:00 - 00:01] Speaker A: Hello there everyone.\n"
    "[00:01 - 00:03] Speaker A: Today we talk about pricing."
)


async def _add_formatted_transcript(db_session, task_id):
    await db_session.execute(
        text(
            "UPDATE task_processing_checkpoints SET payload = jsonb_set(payload, '{transcript}', "
            "to_jsonb(CAST(:t AS text))) WHERE task_id = :id"
        ),
        {"t": FORMATTED, "id": task_id},
    )
    await db_session.commit()


async def test_search_runs_and_stores_snapped_moments(app, client, db_session, auth_headers, monkeypatch):
    task_id = await seed(db_session)
    await _add_formatted_transcript(db_session, task_id)
    queue = app.state.queue_adapter
    queue.enqueued_jobs.clear()

    bad = await client.post(f"/tasks/{task_id}/moments", json={}, headers=auth_headers)
    assert bad.status_code == 400 and bad.json()["detail"]["code"] == "empty"

    response = await client.post(
        f"/tasks/{task_id}/moments", json={"preset": "quotes", "prompt": "pricing"}, headers=auth_headers
    )
    assert response.status_code == 200, response.text
    run = response.json()["run"]
    assert run["status"] == "queued"
    job = queue.enqueued_jobs[-1]
    assert job["function_name"] == "find_moments_job" and job["kwargs"]["_queue_name"] == "supoclip_ai"

    seen = {}

    async def fake_analyse(transcript, instructions):
        seen.update(transcript=transcript, instructions=instructions)
        return SimpleNamespace(most_relevant_segments=[SimpleNamespace(
            start_time="00:01", end_time="00:02", hook_title="Pricing talk", text="Today we talk about pricing.",
            reasoning="", virality=SimpleNamespace(total_score=77, virality_reasoning="Clear topic"),
        )])

    monkeypatch.setattr(moments_service, "_analyse", fake_analyse)
    await moments_service.find_moments_job({}, run["id"])
    assert "Today we talk about pricing." in seen["transcript"]
    assert seen["instructions"].endswith("pricing")

    runs = (await client.get(f"/tasks/{task_id}/moments", headers=auth_headers)).json()["runs"]
    assert runs[0]["status"] == "completed"
    moment = runs[0]["moments"][0]
    # The sentence starting at 1.2s ("Today we talk about pricing.") ends at 3.1s.
    assert (moment["start"], moment["end"], moment["score"], moment["title"]) == (1.2, 3.1, 77, "Pricing talk")
    assert (await client.delete(f"/tasks/{task_id}/moments/{run['id']}", headers=auth_headers)).status_code == 200


async def test_failed_search_and_daily_limit(client, db_session, auth_headers, monkeypatch):
    task_id = await seed(db_session)
    await _add_formatted_transcript(db_session, task_id)
    run = (await client.post(f"/tasks/{task_id}/moments", json={"preset": "viral"}, headers=auth_headers)).json()["run"]

    async def broken(*_args):
        raise RuntimeError("model down")

    monkeypatch.setattr(moments_service, "_analyse", broken)
    await moments_service.find_moments_job({}, run["id"])
    runs = (await client.get(f"/tasks/{task_id}/moments", headers=auth_headers)).json()["runs"]
    assert runs[0]["status"] == "failed" and runs[0]["error"] == "The search failed. Try again."

    config = get_config()
    previous = config.moments_daily_limit
    config.moments_daily_limit = 0
    try:
        limited = await client.post(f"/tasks/{task_id}/moments", json={"preset": "viral"}, headers=auth_headers)
        assert limited.status_code == 429 and limited.json()["detail"]["code"] == "daily_limit"
    finally:
        config.moments_daily_limit = previous


async def test_search_needs_a_transcript(client, db_session, auth_headers):
    task_id = await seed(db_session, transcript=False)
    response = await client.post(f"/tasks/{task_id}/moments", json={"preset": "viral"}, headers=auth_headers)
    assert response.status_code == 404
