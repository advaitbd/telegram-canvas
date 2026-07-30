/**
 * Scheduled maintenance handler.
 *
 * Runs daily at 03:00 UTC (cron: 0 3 * * *).
 *
 * Tasks:
 *   1. Purge expired nonce records
 *   2. Mark expired sessions for cleanup
 *   3. Permanently delete artifacts past purge_after
 *   4. Delete associated R2 blobs
 *   5. Resolve stuck pending revisions (mark as failed)
 */

import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import * as Sessions from "../db/sessions";
import * as Artifacts from "../db/artifacts";

export async function handleMaintenance(
	env: { CANVAS_DB: D1Database; CANVAS_ARTIFACTS: R2Bucket },
): Promise<{ cleaned_sessions: number; cleaned_artifacts: number; cleaned_nonces: number; stuck_revisions: number }> {
	const results = { cleaned_sessions: 0, cleaned_artifacts: 0, cleaned_nonces: 0, stuck_revisions: 0 };

	try {
		// 1. Purge expired nonces
		const now = Math.floor(Date.now() / 1000);
		const nonceResult = await env.CANVAS_DB
			.prepare("DELETE FROM publisher_nonces WHERE expires_at <= ?")
			.bind(now)
			.run();
		results.cleaned_nonces = nonceResult.meta.changes;
		await env.CANVAS_DB.prepare("DELETE FROM public_shares WHERE expires_at <= ?").bind(now).run();

		// 2. Find and delete expired sessions + their artifacts + R2 blobs
		const expiredSessions = await Sessions.selectExpiredSessions(env.CANVAS_DB);
		for (const session of expiredSessions) {
			// Collect all artifact R2 keys before deleting
			const allArtifacts = await env.CANVAS_DB
				.prepare("SELECT id FROM artifacts WHERE session_id = ?")
				.bind(session.id)
				.all<{ id: string }>();

			for (const art of allArtifacts.results ?? []) {
				const r2Keys = await Artifacts.selectRevisionR2Keys(env.CANVAS_DB, art.id);
				// Delete R2 blobs (best-effort)
				for (const key of r2Keys) {
					try { await env.CANVAS_ARTIFACTS.delete(key); } catch { /* reconcile only */ }
				}
				// D1 cascade handles revision deletion; delete the artifact
				await Artifacts.deleteArtifactPermanent(env.CANVAS_DB, art.id);
				results.cleaned_artifacts++;
			}

			await Sessions.deleteSession(env.CANVAS_DB, session.id);
			results.cleaned_sessions++;
		}

		// 3. Purge trashed artifacts past their purge_after
		const purgeCandidates = await Artifacts.selectPurgeCandidates(env.CANVAS_DB);
		for (const candidate of purgeCandidates) {
			const r2Keys = await Artifacts.selectRevisionR2Keys(env.CANVAS_DB, candidate.id);
			for (const key of r2Keys) {
				try { await env.CANVAS_ARTIFACTS.delete(key); } catch { /* reconcile */ }
			}
			await Artifacts.deleteArtifactPermanent(env.CANVAS_DB, candidate.id);
			results.cleaned_artifacts++;
		}

		// 4. Resolve stuck pending revisions (older than 1 hour) as failed
		const oneHourAgo = now - 3600;
		const stuckResult = await env.CANVAS_DB
			.prepare("UPDATE artifact_revisions SET status = 'failed' WHERE status = 'pending' AND created_at <= ?")
			.bind(oneHourAgo)
			.run();
		results.stuck_revisions = stuckResult.meta.changes;

		// 5. Clean stale rate limit records (>24h old)
		const rateCutoff = now - 86400;
		const rateResult = await env.CANVAS_DB
			.prepare("DELETE FROM publisher_rate_limits WHERE window_start <= ?")
			.bind(rateCutoff)
			.run();
		results.cleaned_nonces += rateResult.meta.changes;

	} catch (err) {
		// Log but never throw — maintenance failure should not crash the cron
		console.error("Maintenance error:", err);
	}

	return results;
}
