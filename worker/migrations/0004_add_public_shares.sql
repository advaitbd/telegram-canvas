-- Public links point at one immutable, ready revision and expire automatically.
CREATE TABLE IF NOT EXISTS public_shares (
    token       TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    revision_id TEXT NOT NULL REFERENCES artifact_revisions(id) ON DELETE CASCADE,
    expires_at  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_public_shares_artifact
    ON public_shares(artifact_id, expires_at);

CREATE INDEX IF NOT EXISTS idx_public_shares_expiry
    ON public_shares(expires_at);
