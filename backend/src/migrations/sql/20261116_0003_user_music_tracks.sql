-- Background music creators upload for the clip studio (music_library.py).
CREATE TABLE IF NOT EXISTS user_music_tracks (
    id VARCHAR(36) PRIMARY KEY,
    user_id TEXT NOT NULL,
    title VARCHAR(200) NOT NULL,
    duration DOUBLE PRECISION NOT NULL,
    size_bytes BIGINT NOT NULL,
    reference TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_user_music_tracks_user_created
    ON user_music_tracks (user_id, created_at DESC);
