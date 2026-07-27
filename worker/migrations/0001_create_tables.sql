-- Migration 0001: Create session, artifact, and revision tables
-- Applied via `wrangler d1 migrations apply telegram-canvas [--local|--remote]`
-- or loaded by `readD1Migrations` in tests.

CREATE TABLE IF NOT EXISTS session_records (
	id            TEXT PRIMARY KEY,
	owner_hash    TEXT NOT NULL,
	session_hash  TEXT NOT NULL,
	title         TEXT NOT NULL DEFAULT '',
	last_active_at INTEGER NOT NULL DEFAULT (unixepoch()),
	expires_at    INTEGER NOT NULL DEFAULT (unixepoch() + 2592000),
	created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
	updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_owner_hash
	ON session_records(owner_hash, session_hash);

CREATE INDEX IF NOT EXISTS idx_session_expires
	ON session_records(owner_hash, expires_at);

CREATE TABLE IF NOT EXISTS artifacts (
	id                  TEXT PRIMARY KEY,
	session_id          TEXT NOT NULL REFERENCES session_records(id) ON DELETE CASCADE,
	title               TEXT NOT NULL DEFAULT '',
	current_revision_id TEXT,
	trashed_at          INTEGER,
	purge_after         INTEGER,
	created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
	updated_at          INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_artifacts_session_trash
	ON artifacts(session_id, trashed_at);

CREATE INDEX IF NOT EXISTS idx_artifacts_owner_lookup
	ON artifacts(id, session_id);

CREATE TABLE IF NOT EXISTS artifact_revisions (
	id            TEXT PRIMARY KEY,
	artifact_id   TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
	ordinal       INTEGER NOT NULL,
	r2_key        TEXT NOT NULL,
	content_bytes INTEGER NOT NULL,
	created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_revision_ordinal
	ON artifact_revisions(artifact_id, ordinal);

CREATE INDEX IF NOT EXISTS idx_revision_created
	ON artifact_revisions(artifact_id, created_at);
