-- Migration 0006: make public links artifact-scoped (live) instead of pinned
-- to one immutable revision.
--
-- The revision_id foreign key cascaded on revision prune, which deleted the
-- public link as soon as the revision it was pinned to aged out of retention.
-- Rebuild public_shares without that FK; keep revision_id as creation-time
-- metadata only. Serving resolves the artifact's current ready revision.
--
-- Forward-only, data-preserving: every token, expiry and created_at is copied.

CREATE TABLE public_shares_new (
    token       TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    revision_id TEXT NOT NULL,
    expires_at  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO public_shares_new (token, artifact_id, revision_id, expires_at, created_at)
    SELECT token, artifact_id, revision_id, expires_at, created_at FROM public_shares;

DROP TABLE public_shares;

ALTER TABLE public_shares_new RENAME TO public_shares;

CREATE INDEX IF NOT EXISTS idx_public_shares_artifact
    ON public_shares(artifact_id, expires_at);

CREATE INDEX IF NOT EXISTS idx_public_shares_expiry
    ON public_shares(expires_at);
