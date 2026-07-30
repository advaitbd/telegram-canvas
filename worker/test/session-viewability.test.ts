import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import type { D1Database } from "@cloudflare/workers-types";

import { handleBootstrap, handleListArtifacts, handleListCanvases, handleListSessions } from "../src/routes/sessions";

declare module "cloudflare:test" {
  interface ProvidedEnv { CANVAS_DB: D1Database; }
}

const cookieFor = (owner: string) => `__Host-canvas_session=test.${owner}`;
const requestFor = (path: string, owner: string) => new Request(`https://canvas.example${path}`, {
  headers: { Cookie: cookieFor(owner) },
});

describe("viewable Canvas listings", () => {
  let db: D1Database;

  beforeAll(async () => {
    db = env.CANVAS_DB;
    await db.prepare(`CREATE TABLE IF NOT EXISTS session_records (
      id TEXT PRIMARY KEY, owner_hash TEXT NOT NULL, session_hash TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '', last_active_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`).run();
    await db.prepare(`CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
      current_revision_id TEXT, trashed_at INTEGER, purge_after INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`).run();
    await db.prepare(`CREATE TABLE IF NOT EXISTS artifact_revisions (
      id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
      r2_key TEXT NOT NULL, content_bytes INTEGER NOT NULL, status TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`).run();
  });

  it("orders eligible sessions and artifacts deterministically and hides non-ready current revisions", async () => {
    const owner = `owner_viewable_${crypto.randomUUID()}`;
    const now = Math.floor(Date.now() / 1000);
    const insertSession = (id: string, lastActive: number) => db.prepare(
      "INSERT INTO session_records VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(id, owner, `hash_${id}`, id, lastActive, now + 3600, now, now).run();
    const insertArtifact = (id: string, sessionId: string, revisionId: string | null, createdAt: number) => db.prepare(
      "INSERT INTO artifacts VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)"
    ).bind(id, sessionId, id, revisionId, createdAt, createdAt).run();
    const insertRevision = (id: string, artifactId: string, status: string) => db.prepare(
      "INSERT INTO artifact_revisions VALUES (?, ?, 1, ?, 1, ?, ?)"
    ).bind(id, artifactId, `r2/${id}`, status, now).run();

    await insertSession("session-a", 100);
    await insertSession("session-b", 100);
    await insertSession("session-empty", 200);
    await insertArtifact("artifact-a", "session-a", "revision-a", 50);
    await insertArtifact("artifact-b", "session-a", "revision-b", 50);
    await insertArtifact("artifact-pending", "session-a", "revision-pending", 90);
    await insertArtifact("artifact-ready-b", "session-b", "revision-ready-b", 70);
    await insertArtifact("artifact-no-revision", "session-empty", null, 100);
    await insertRevision("revision-a", "artifact-a", "ready");
    await insertRevision("revision-b", "artifact-b", "ready");
    await insertRevision("revision-pending", "artifact-pending", "pending");
    await insertRevision("revision-ready-b", "artifact-ready-b", "ready");

    const bootstrap = await (await handleBootstrap(requestFor("/api/bootstrap", owner), db)).json() as {
      canvas: { session: { id: string }; artifact: { id: string; current_revision_id: string } };
    };
    expect(bootstrap.canvas).toEqual({
      session: { id: "session-b", title: "session-b", artifact_count: 1, last_active_at: 100, expires_at: now + 3600 },
      artifact: { id: "artifact-ready-b", session_id: "session-b", title: "artifact-ready-b", current_revision_id: "revision-ready-b", trashed_at: null, created_at: 70 },
    });

    const sessions = await (await handleListSessions(requestFor("/api/sessions", owner), db)).json() as {
      sessions: Array<{ id: string; artifact_count: number }>;
    };
    expect(sessions.sessions).toEqual([
      { id: "session-b", title: "session-b", artifact_count: 1, last_active_at: 100, expires_at: now + 3600 },
      { id: "session-a", title: "session-a", artifact_count: 2, last_active_at: 100, expires_at: now + 3600 },
    ]);

    const canvases = await (await handleListCanvases(requestFor("/api/canvases", owner), db)).json() as {
      canvases: Array<{ id: string; revision_count: number; current_revision_bytes: number; session_title: string }>;
    };
    expect(canvases.canvases.map(({ id, revision_count, current_revision_bytes, session_title }) => ({ id, revision_count, current_revision_bytes, session_title }))).toEqual([
      { id: "artifact-ready-b", revision_count: 1, current_revision_bytes: 1, session_title: "session-b" },
      { id: "artifact-b", revision_count: 1, current_revision_bytes: 1, session_title: "session-a" },
      { id: "artifact-a", revision_count: 1, current_revision_bytes: 1, session_title: "session-a" },
    ]);

    const artifacts = await (await handleListArtifacts(requestFor("/api/sessions/session-a/artifacts", owner), db, "session-a")).json() as {
      artifacts: Array<{ id: string }>;
    };
    expect(artifacts.artifacts.map(({ id }) => id)).toEqual(["artifact-b", "artifact-a"]);
  });
});
