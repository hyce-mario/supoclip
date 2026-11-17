-- AI searches for moments in the transcript reader (POST /tasks/{id}/moments).
-- Each run keeps its results so the side panel survives a reload.
CREATE TABLE IF NOT EXISTS transcript_moment_runs (
    id VARCHAR(36) PRIMARY KEY,
    task_id VARCHAR(36) NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    preset VARCHAR(32),
    prompt TEXT,
    range_start DOUBLE PRECISION,
    range_end DOUBLE PRECISION,
    -- queued | running | completed | failed
    status VARCHAR(16) NOT NULL DEFAULT 'queued',
    moments JSONB NOT NULL DEFAULT '[]'::jsonb,
    error TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_transcript_moment_runs_task_created
    ON transcript_moment_runs (task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_transcript_moment_runs_user_created
    ON transcript_moment_runs (user_id, created_at);
