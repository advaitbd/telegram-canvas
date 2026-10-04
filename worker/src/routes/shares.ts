import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { getOwnerFromCookie } from "./auth";
import * as Artifacts from "../db/artifacts";
import { jsonError, jsonOk } from "../lib/http";

const EXPECTED_ORIGIN = "https://canvas.advaitdeshpande.com";
const ALLOWED_TTLS = new Set([86400, 7 * 86400, 30 * 86400]);
const PUBLIC_DOCUMENT_CSP = [
	"default-src 'none'", "script-src https: 'unsafe-inline' 'unsafe-eval'", "style-src https: 'unsafe-inline'",
	"img-src https: data:", "font-src https: data:", "connect-src https:", "base-uri 'none'", "object-src 'none'",
	"form-action 'none'", "frame-ancestors 'self'", "sandbox allow-scripts",
].join("; ");

function csrfCheck(request: Request): Response | null {
	if (request.headers.get("Origin") !== EXPECTED_ORIGIN || request.headers.get("Sec-Fetch-Site") !== "same-origin" || !request.headers.get("X-CSRF-Token")) return jsonError(403, "Forbidden");
	return null;
}

function token(): string {
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function handleCreateShare(request: Request, db: D1Database, artifactId: string): Promise<Response> {
	const csrfError = csrfCheck(request);
	if (csrfError) return csrfError;
	const ownerHash = getOwnerFromCookie(request);
	if (!ownerHash) return jsonError(401, "Unauthorized");
	const artifact = await Artifacts.getArtifact(db, artifactId, ownerHash);
	if (!artifact || artifact.trashed_at) return jsonError(404, "Not found");
	const body = await request.json().catch(() => null) as { ttl_seconds?: unknown } | null;
	const ttl = typeof body?.ttl_seconds === "number" ? body.ttl_seconds : 30 * 86400;
	if (!ALLOWED_TTLS.has(ttl)) return jsonError(400, "Invalid share duration");
	// The newest ready revision is what the link serves today.
	const revision = (await Artifacts.listRevisions(db, artifactId)).find((item) => item.status === "ready");
	if (!revision) return jsonError(404, "Not found");
	const origin = new URL(request.url).origin;
	// A public link is artifact-scoped: one active link per artifact, always
	// serving the artifact's latest ready revision. Reuse it if present.
	const active = await selectActiveShare(db, artifactId);
	if (active) {
		return jsonOk({ token: active.token, revision_id: revision.id, url: `${origin}/s/${active.token}`, expires_at: active.expires_at });
	}
	// Race-safe insert: INSERT ... SELECT runs as one atomic SQLite statement,
	// so concurrent creates cannot both insert. The loser re-reads the winner.
	const shareToken = token();
	const expiresAt = Math.floor(Date.now() / 1000) + ttl;
	await db.prepare(
		`INSERT INTO public_shares (token, artifact_id, revision_id, expires_at)
		 SELECT ?, ?, ?, ? WHERE NOT EXISTS (
			SELECT 1 FROM public_shares WHERE artifact_id = ? AND expires_at > unixepoch())`,
	).bind(shareToken, artifactId, revision.id, expiresAt, artifactId).run();
	const winner = await selectActiveShare(db, artifactId);
	// No active link after the atomic insert means it was revoked concurrently;
	// never hand back a token that is not actually in the table.
	if (!winner) return jsonError(409, "Public link changed concurrently; retry");
	return jsonOk({ token: winner.token, revision_id: revision.id, url: `${origin}/s/${winner.token}`, expires_at: winner.expires_at }, winner.token === shareToken ? 201 : 200);
}

export async function handleListShares(request: Request, db: D1Database, artifactId: string): Promise<Response> {
	const ownerHash = getOwnerFromCookie(request);
	if (!ownerHash) return jsonError(401, "Unauthorized");
	const artifact = await Artifacts.getArtifact(db, artifactId, ownerHash);
	if (!artifact) return jsonError(404, "Not found");
	// revision_id reported is the artifact's live (newest ready) revision.
	const shares = await db.prepare(`SELECT token, expires_at FROM public_shares
		WHERE artifact_id = ? AND expires_at > unixepoch() ORDER BY expires_at ASC`)
		.bind(artifactId).all<{ token: string; expires_at: number }>();
	const rows = shares.results ?? [];
	const newestReady = rows.length
		? (await db.prepare(
			`SELECT id FROM artifact_revisions WHERE artifact_id = ? AND status = 'ready' ORDER BY ordinal DESC LIMIT 1`,
		).bind(artifactId).first<{ id: string }>())?.id ?? null
		: null;
	const origin = new URL(request.url).origin;
	return jsonOk({ shares: newestReady ? rows.map((share) => ({ ...share, revision_id: newestReady, url: `${origin}/s/${share.token}` })) : [] });
}

export async function handleRevokeShare(request: Request, db: D1Database, artifactId: string, shareToken: string): Promise<Response> {
	const csrfError = csrfCheck(request);
	if (csrfError) return csrfError;
	const ownerHash = getOwnerFromCookie(request);
	if (!ownerHash) return jsonError(401, "Unauthorized");
	const result = await db.prepare(`DELETE FROM public_shares WHERE token = ? AND artifact_id = ? AND artifact_id IN (
		SELECT a.id FROM artifacts a JOIN session_records s ON s.id = a.session_id WHERE a.id = ? AND s.owner_hash = ?)`)
		.bind(shareToken, artifactId, artifactId, ownerHash).run();
	return result.meta.changes ? jsonOk({ revoked: true }) : jsonError(404, "Not found");
}

/** The single active (non-expired) link for an artifact, if any. */
async function selectActiveShare(db: D1Database, artifactId: string) {
	return db.prepare(`SELECT token, expires_at FROM public_shares
		WHERE artifact_id = ? AND expires_at > unixepoch() ORDER BY expires_at ASC LIMIT 1`)
		.bind(artifactId).first<{ token: string; expires_at: number }>();
}

// A public link always renders the artifact's live revision: the newest ready
// revision by ordinal, regardless of a stale current_revision_id pointer.
// Trashed or purged artifacts are filtered out (cascade removes purged links).
async function getPublicShare(db: D1Database, shareToken: string) {
	return db.prepare(`SELECT ps.expires_at, a.title, a.trashed_at, r.r2_key, r.status
		FROM public_shares ps
		JOIN artifacts a ON a.id = ps.artifact_id
		JOIN artifact_revisions r ON r.artifact_id = a.id AND r.status = 'ready'
		WHERE ps.token = ? AND ps.expires_at > unixepoch()
		ORDER BY r.ordinal DESC
		LIMIT 1`).bind(shareToken).first<{ expires_at: number; title: string; trashed_at: number | null; r2_key: string; status: string }>();
}

function missingShare(): Response {
	return new Response("This canvas link has expired or been revoked.", { status: 404, headers: { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } });
}

export async function handlePublicShare(request: Request, db: D1Database, shareToken: string): Promise<Response> {
	const share = await getPublicShare(db, shareToken);
	if (!share || share.trashed_at || share.status !== "ready") return missingShare();
	const title = share.title.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
	const path = new URL(request.url).pathname;
	const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title || "Shared canvas"}</title><style>html,body,iframe{margin:0;width:100%;height:100%;border:0}body{background:#fff}</style><iframe title="${title || "Shared canvas"}" sandbox="allow-scripts" src="${path}/document"></iframe>`;
	return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" } });
}

export async function handlePublicDocument(db: D1Database, r2: R2Bucket, shareToken: string): Promise<Response> {
	const share = await getPublicShare(db, shareToken);
	if (!share || share.trashed_at || share.status !== "ready") return missingShare();
	const object = await r2.get(share.r2_key);
	if (!object) return missingShare();
	return new Response(await object.text(), { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": PUBLIC_DOCUMENT_CSP, "cache-control": "no-store", "x-content-type-options": "nosniff", "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" } });
}
