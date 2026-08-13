-- Migration 0005: Preserve the Telegram chat name for each owner-scoped session.
ALTER TABLE session_records ADD COLUMN chat_name TEXT NOT NULL DEFAULT '';
