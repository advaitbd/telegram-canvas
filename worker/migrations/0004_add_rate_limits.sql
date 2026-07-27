-- Migration 0004: Add rate limit tracking table.
--
-- Tracks per-owner and per-session publish request timestamps
-- for sliding-window rate limiting. Cleaned by daily maintenance cron.

CREATE TABLE IF NOT EXISTS publisher_rate_limits (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_hash  TEXT NOT NULL,
    session_id  TEXT NOT NULL,
    window_start INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_rate_owner
    ON publisher_rate_limits(owner_hash, window_start);

CREATE INDEX IF NOT EXISTS idx_rate_session
    ON publisher_rate_limits(session_id, window_start);
