-- Clips made from a transcript selection (POST /tasks/{id}/clips/from-range).
-- One row per request. The worker renders it and adds the clip to the task.
CREATE TABLE IF NOT EXISTS range_clip_jobs (
    id VARCHAR(36) PRIMARY KEY,
    task_id VARCHAR(36) NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    start_seconds DOUBLE PRECISION NOT NULL,
    end_seconds DOUBLE PRECISION NOT NULL,
    hook_title TEXT,
    -- queued | rendering | completed | failed
    status VARCHAR(16) NOT NULL DEFAULT 'queued',
    clip_id VARCHAR(36),
    error TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_range_clip_jobs_task_created
    ON range_clip_jobs (task_id, created_at DESC);
