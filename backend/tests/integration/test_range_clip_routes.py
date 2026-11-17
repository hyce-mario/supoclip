"""Clips cut from a transcript range: the API rows and the worker job."""

from sqlalchemy import text

from src.services import range_clip_service
from tests.integration.test_transcript_routes import seed


async def test_create_validates_and_enqueues(app, client, db_session, auth_headers):
    task_id = await seed(db_session)
    queue = app.state.queue_adapter
    queue.enqueued_jobs.clear()

    too_short = await client.post(f"/tasks/{task_id}/clips/from-range", json={"start": 1, "end": 2}, headers=auth_headers)
    assert too_short.status_code == 400
    assert too_short.json()["detail"]["code"] == "too_short"
    past_end = await client.post(f"/tasks/{task_id}/clips/from-range", json={"start": 100, "end": 140}, headers=auth_headers)
    assert past_end.json()["detail"]["code"] == "out_of_bounds"
    garbage = await client.post(f"/tasks/{task_id}/clips/from-range", json={"start": "x", "end": 9}, headers=auth_headers)
    assert garbage.status_code == 400

    response = await client.post(
        f"/tasks/{task_id}/clips/from-range",
        json={"start": 10, "end": 42.5, "hook_title": "  The   pricing  secret "},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    job = response.json()["job"]
    assert job["status"] == "queued"
    assert (job["start"], job["end"], job["hook_title"]) == (10.0, 42.5, "The pricing secret")
    assert queue.enqueued_jobs[-1]["function_name"] == "create_range_clip"
    assert queue.enqueued_jobs[-1]["args"] == (job["id"],)

    listed = (await client.get(f"/tasks/{task_id}/clips/from-range", headers=auth_headers)).json()["jobs"]
    assert [item["id"] for item in listed] == [job["id"]]
    # A queued request cannot be dismissed.
    assert (await client.delete(f"/tasks/{task_id}/clips/from-range/{job['id']}", headers=auth_headers)).status_code == 404


async def test_limits_active_requests_and_busy_tasks(client, db_session, auth_headers):
    task_id = await seed(db_session)
    for i in range(range_clip_service.MAX_ACTIVE_PER_TASK):
        ok = await client.post(f"/tasks/{task_id}/clips/from-range", json={"start": i * 10, "end": i * 10 + 5}, headers=auth_headers)
        assert ok.status_code == 200
    blocked = await client.post(f"/tasks/{task_id}/clips/from-range", json={"start": 50, "end": 60}, headers=auth_headers)
    assert blocked.status_code == 429

    busy = await seed(db_session, status="processing", transcript=False)
    response = await client.post(f"/tasks/{busy}/clips/from-range", json={"start": 0, "end": 10}, headers=auth_headers)
    assert response.status_code == 409


async def test_other_users_cannot_create(client, db_session, auth_headers):
    task_id = await seed(db_session, user_id="someone-else")
    response = await client.post(f"/tasks/{task_id}/clips/from-range", json={"start": 0, "end": 10}, headers=auth_headers)
    assert response.status_code in (403, 404)


async def test_worker_appends_the_rendered_clip(client, db_session, auth_headers, monkeypatch, tmp_path):
    task_id = await seed(db_session)
    job = (await client.post(f"/tasks/{task_id}/clips/from-range", json={"start": 20, "end": 50}, headers=auth_headers)).json()["job"]

    rendered = tmp_path / "clip_range.mp4"
    rendered.write_bytes(b"video")
    seen = {}

    async def fake_render(service, task, claimed):
        seen["range"] = (claimed["start_seconds"], claimed["end_seconds"])
        return {
            "filename": rendered.name, "path": str(rendered), "start_time": "00:20", "end_time": "00:50",
            "duration": 29.4, "text": "Today we talk about pricing.", "hook_title": None,
        }

    monkeypatch.setattr(range_clip_service, "_render", fake_render)
    await range_clip_service.create_range_clip({}, job["id"])
    # Running it again does nothing: the row is no longer queued.
    await range_clip_service.create_range_clip({}, job["id"])

    assert seen["range"] == (20.0, 50.0)
    clips = (await db_session.execute(
        text("SELECT id, clip_order, reasoning, duration FROM generated_clips WHERE task_id = :t ORDER BY clip_order"),
        {"t": task_id},
    )).mappings().all()
    assert [c["clip_order"] for c in clips] == [1, 2]
    assert clips[1]["reasoning"] == "Created from the transcript"

    listed = (await client.get(f"/tasks/{task_id}/clips/from-range", headers=auth_headers)).json()["jobs"]
    assert listed[0]["status"] == "completed"
    assert listed[0]["clip_id"] == clips[1]["id"]
    assert (await client.delete(f"/tasks/{task_id}/clips/from-range/{job['id']}", headers=auth_headers)).status_code == 200


async def test_worker_records_a_failed_render(client, db_session, auth_headers, monkeypatch):
    task_id = await seed(db_session)
    job = (await client.post(f"/tasks/{task_id}/clips/from-range", json={"start": 20, "end": 50}, headers=auth_headers)).json()["job"]

    async def broken(*_args):
        raise ValueError("The source video is no longer available.")

    monkeypatch.setattr(range_clip_service, "_render", broken)
    await range_clip_service.create_range_clip({}, job["id"])
    listed = (await client.get(f"/tasks/{task_id}/clips/from-range", headers=auth_headers)).json()["jobs"]
    assert listed[0]["status"] == "failed"
    assert listed[0]["error"] == "The source video is no longer available."
    count = (await db_session.execute(text("SELECT COUNT(*) FROM generated_clips WHERE task_id = :t"), {"t": task_id})).scalar()
    assert count == 1
