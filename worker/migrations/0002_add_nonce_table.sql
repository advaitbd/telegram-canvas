-- Migration 0002: Add publisher nonce store for HMAC replay protection.
--
-- The nonce table stores unique nonces from publisher requests.
-- Each nonce is inserted atomically; a UNIQUE constraint violation
-- means the nonce was already used (replay attack detected).
-- The expires_at column allows cron to clean up stale entries.

CREATE TABLE IF NOT EXISTS publisher_nonces (
    nonce      TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nonce_expires
    ON publisher_nonces(expires_at);
