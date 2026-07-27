/**
 * Canvas artifact lifecycle limits.
 *
 * These are enforced server-side before accepting new data.
 * Changing a limit here applies to new publishes; existing data
 * that exceeds the new limit must be reconciled by cron.
 */

/** Maximum HTML body size per revision, in bytes. */
export const MAX_REVISION_BYTES = 5 * 1024 * 1024; // 5 MiB

/** Maximum artifacts a single session may hold (trashed count toward this). */
export const MAX_ARTIFACTS_PER_SESSION = 100;

/** Maximum retained revisions per artifact. Older ones are pruned. */
export const MAX_REVISIONS_PER_ARTIFACT = 20;

/** Session expiry offset: last_active_at + this → expires_at. */
export const SESSION_EXPIRY_DAYS = 30;

/** Trash retention: trashed_at + this → purge_after. */
export const TRASH_RETENTION_DAYS = 7;

/** Maximum length for display titles (Unicode code points). */
export const MAX_TITLE_LENGTH = 160;
