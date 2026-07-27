-- Migration 0003: Add revision state machine column.
--
-- Revisions transition: pending -> ready (write R2 OK) or pending -> failed (write R2 error).
-- A scheduled reconciler resolves stuck pending rows.

ALTER TABLE artifact_revisions ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';

CREATE INDEX IF NOT EXISTS idx_revision_status
    ON artifact_revisions(status);
