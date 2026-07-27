/**
 * Viewer artifact routes.
 *
 * All state-changing endpoints require CSRF validation:
 *   - X-CSRF-Token header must match the token previously issued
 *   - Origin must match https://canvas.advaitdeshpande.com
 *   - Sec-Fetch-Site must be same-origin
 *
 * Document serving is authorized by the shell session cookie (no
 * bearer token in the iframe URL — per corrected auth model).
 */

import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { getOwnerFromCookie } from "./auth";
import * as Artifacts from "../db/artifacts";
import * as Sessions from "../db/sessions";

import { jsonError, jsonOk } from "../lib/http";

const EXPECTED_ORIGIN = "https://canvas.advaitdeshpande.com";

// CSP for document responses — restrictive but allows HTTPS external resources
const DOCUMENT_CSP = [
	"default-src 'none'",
	"script-src https: 'unsafe-inline' 'unsafe-eval'",
	"style-src https: 'unsafe-inline'",
	"img-src https: data:",
	"font-src https: data:",
	"connect-src https:",
	"base-uri 'none'",
	"object-src 'none'",
	"form-action 'none'",
	"frame-ancestors 'self'",
].join("; ");

/** Shared CSRF check for state-changing requests. */
function csrfCheck(request: Request): Response | null {
	const origin = request.headers.get("Origin");
	if (origin !== EXPECTED_ORIGIN) {
		return jsonError(403, "Forbidden");
	}
	const secFetch = request.headers.get("Sec-Fetch-Site");
	if (secFetch !== "same-origin") {
		return jsonError(403, "Forbidden");
	}
	const csrfToken = request.headers.get("X-CSRF-Token");
	if (!csrfToken) {
		return jsonError(403, "Forbidden");
	}
	return null;
}

/**
 * GET /api/artifacts/:id — get artifact metadata.
 */
export async function handleGetArtifact(
	request: Request,
	db: D1Database,
	artifactId: string,
): Promise<Response> {
	const ownerHash = getOwnerFromCookie(request);
	if (!ownerHash) return jsonError(401, "Unauthorized");

	const artifact = await Artifacts.getArtifact(db, artifactId, ownerHash);
	if (!artifact) return jsonError(404, "Not found");

	return jsonOk({ artifact });
}

/**
 * GET /api/artifacts/:id/revisions — list revisions for an artifact.
 */
export async function handleListRevisions(
	request: Request,
	db: D1Database,
	artifactId: string,
): Promise<Response> {
	const ownerHash = getOwnerFromCookie(request);
	if (!ownerHash) return jsonError(401, "Unauthorized");

	const artifact = await Artifacts.getArtifact(db, artifactId, ownerHash);
	if (!artifact) return jsonError(404, "Not found");

	const revisions = await Artifacts.listRevisions(db, artifactId);
	return jsonOk({ revisions });
}

/**
 * GET /api/artifacts/:id/revisions/:revisionId/document
 *
 * Serves the HTML blob from R2. Authorized by the shell session cookie
 * (no bearer token in the URL — per corrected auth model).
 * Sets restrictive headers so artifact JS cannot exfiltrate credentials.
 */
export async function handleGetDocument(
	request: Request,
	env: { CANVAS_DB: D1Database; CANVAS_ARTIFACTS: R2Bucket },
	artifactId: string,
	revisionId: string,
): Promise<Response> {
	const ownerHash = getOwnerFromCookie(request);
	if (!ownerHash) return jsonError(401, "Unauthorized");

	// Verify artifact ownership
	const artifact = await Artifacts.getArtifact(env.CANVAS_DB, artifactId, ownerHash);
	if (!artifact) return jsonError(404, "Not found");

	// Get the revision to find the R2 key
	const revisions = await Artifacts.listRevisions(env.CANVAS_DB, artifactId);
	const revision = revisions.find((r) => r.id === revisionId);
	if (!revision) return jsonError(404, "Not found");

	// Check trash status
	if (artifact.trashed_at) {
		return jsonError(403, "Artifact is trashed");
	}

	// Get blob from R2
	const r2Obj = await env.CANVAS_ARTIFACTS.get(revision.r2_key);
	if (!r2Obj) return jsonError(404, "Not found");

	const body = await r2Obj.text();

	return new Response(body, {
		status: 200,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"content-security-policy": DOCUMENT_CSP,
			"x-content-type-options": "nosniff",
			"referrer-policy": "no-referrer",
			"cache-control": "private, no-store",
			"x-robots-tag": "noindex, nofollow",
		},
	});
}

/**
 * GET /api/artifacts/:id/download — return the current revision as an
 * attachment download.
 */
export async function handleDownload(
	request: Request,
	env: { CANVAS_DB: D1Database; CANVAS_ARTIFACTS: R2Bucket },
	artifactId: string,
): Promise<Response> {
	const ownerHash = getOwnerFromCookie(request);
	if (!ownerHash) return jsonError(401, "Unauthorized");

	const artifact = await Artifacts.getArtifact(env.CANVAS_DB, artifactId, ownerHash);
	if (!artifact) return jsonError(404, "Not found");

	if (!artifact.current_revision_id) {
		return jsonError(404, "No current revision");
	}

	const revisions = await Artifacts.listRevisions(env.CANVAS_DB, artifactId);
	const revision = revisions.find((r) => r.id === artifact.current_revision_id);
	if (!revision) return jsonError(404, "Not found");

	const r2Obj = await env.CANVAS_ARTIFACTS.get(revision.r2_key);
	if (!r2Obj) return jsonError(404, "Not found");

	const body = await r2Obj.text();
	const safeName = artifact.title.replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, 50) || "artifact";

	return new Response(body, {
		status: 200,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"content-disposition": `attachment; filename="${safeName}.html"`,
			"cache-control": "private, no-store",
		},
	});
}

/**
 * POST /api/artifacts/:id/extend — extend parent session expiry by 30 days.
 * Requires CSRF token.
 */
export async function handleExtend(
	request: Request,
	db: D1Database,
	artifactId: string,
): Promise<Response> {
	const csrfErr = csrfCheck(request);
	if (csrfErr) return csrfErr;

	const ownerHash = getOwnerFromCookie(request);
	if (!ownerHash) return jsonError(401, "Unauthorized");

	const artifact = await Artifacts.getArtifact(db, artifactId, ownerHash);
	if (!artifact) return jsonError(404, "Not found");

	await Sessions.touchSession(db, artifact.session_id, ownerHash);

	return jsonOk({ ok: true, extended: true });
}

/**
 * DELETE /api/artifacts/:id — trash an artifact (soft delete).
 * Requires CSRF token.
 */
export async function handleTrash(
	request: Request,
	db: D1Database,
	artifactId: string,
): Promise<Response> {
	const csrfErr = csrfCheck(request);
	if (csrfErr) return csrfErr;

	const ownerHash = getOwnerFromCookie(request);
	if (!ownerHash) return jsonError(401, "Unauthorized");

	const trashed = await Artifacts.trashArtifact(db, artifactId, ownerHash);
	if (!trashed) return jsonError(404, "Not found");

	return jsonOk({ ok: true, trashed: true });
}
