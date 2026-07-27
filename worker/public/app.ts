/**
 * Canvas Mini App — main shell.
 *
 * Lifecycle:
 *   1. On load, exchange Telegram WebApp init data for session cookie
 *   2. Show session picker (only sessions with artifacts)
 *   3. On session select → show artifact gallery
 *   4. On artifact select → show viewer with revision selector
 *   5. Live update via WebSocket stream
 */

import { api } from "./api";
import { state, type ArtifactView } from "./state";

const $ = <T extends HTMLElement>(id: string): T =>
	document.getElementById(id) as T;

const webapp = (window as any).Telegram?.WebApp;

async function init(): Promise<void> {
	if (webapp) {
		webapp.ready();
		webapp.expand();
	}

	// Exchange init data
	const initData = webapp?.initData || "";
	if (!initData) {
		showError("Not running in Telegram WebView");
		return;
	}

	try {
		await api.login(initData);
	} catch {
		showError("Authentication failed");
		return;
	}

	await loadSessions();
}

// ── Session picker ───────────────────────────────────────────────────

async function loadSessions(): Promise<void> {
	showScreen("session-picker");
	const list = $<HTMLDivElement>("session-list");
	list.innerHTML = "";

	try {
		const sessions = await api.listSessions();
		if (sessions.length === 0) {
			list.innerHTML = '<p class="empty-state">No sessions yet — ask the agent to publish a canvas.</p>';
			return;
		}
		for (const s of sessions) {
			const el = document.createElement("div");
			el.className = "list-item";
			el.textContent = s.title || `Session ${s.id.slice(0, 8)}`;
			el.dataset.sessionId = s.id;
			el.addEventListener("click", () => loadArtifacts(s.id, s.title));
			list.appendChild(el);
		}
	} catch {
		showError("Failed to load sessions");
	}
}

// ── Artifact gallery ─────────────────────────────────────────────────

async function loadArtifacts(sessionId: string, title: string): Promise<void> {
	state.currentSessionId = sessionId;
	$("gallery-title").textContent = title;
	showScreen("artifact-gallery");
	const list = $<HTMLDivElement>("artifact-list");
	list.innerHTML = "";

	try {
		const artifacts = await api.listArtifacts(sessionId);
		if (artifacts.length === 0) {
			list.innerHTML = '<p class="empty-state">No artifacts in this session.</p>';
			return;
		}
		state.artifacts = artifacts;
		for (const a of artifacts) {
			const el = document.createElement("div");
			el.className = "list-item";
			el.textContent = a.title || `Artifact ${a.id.slice(0, 8)}`;
			el.dataset.artifactId = a.id;
			el.addEventListener("click", () => openViewer(a));
			list.appendChild(el);
		}
	} catch {
		showError("Failed to load artifacts");
	}
}

// ── Artifact viewer ──────────────────────────────────────────────────

async function openViewer(artifact: ArtifactView): Promise<void> {
	state.currentArtifactId = artifact.id;
	$("viewer-title").textContent = artifact.title || "Untitled";
	showScreen("artifact-viewer");

	// Load revisions
	try {
		const revisions = await api.listRevisions(artifact.id);
		const sel = $<HTMLSelectElement>("revision-selector");
		sel.innerHTML = "";
		for (const r of revisions) {
			const opt = document.createElement("option");
			opt.value = r.id;
			opt.textContent = `#${r.ordinal} — ${formatDate(r.created_at)}`;
			sel.appendChild(opt);
		}
		if (revisions.length > 0) {
			sel.value = revisions[0].id;
			loadDocument(artifact.id, revisions[0].id);
		}
		sel.addEventListener("change", () => {
			loadDocument(artifact.id, sel.value);
		});
	} catch {
		showError("Failed to load revisions");
	}

	// Wire controls
	$("btn-download").onclick = () => {
		window.open(api.getDownloadUrl(artifact.id), "_blank");
	};
	$("btn-extend").onclick = async () => {
		if (await api.extendExpiry(artifact.id)) {
			$("btn-extend").textContent = "Extended ✓";
		}
	};
	$("btn-delete").onclick = async () => {
		if (confirm("Delete this artifact?")) {
			if (await api.trashArtifact(artifact.id)) {
				const sid = state.currentSessionId;
				const title = $("gallery-title").textContent;
				if (sid) loadArtifacts(sid, title);
			}
		}
	};
}

function loadDocument(artifactId: string, revisionId: string): void {
	const iframe = $<HTMLIFrameElement>("artifact-iframe");
	iframe.src = api.getDocumentUrl(artifactId, revisionId);
}

// ── Helpers ──────────────────────────────────────────────────────────

function showScreen(id: string): void {
	for (const s of ["session-picker", "artifact-gallery", "artifact-viewer", "error-screen", "loading-screen"]) {
		$<HTMLDivElement>(s).classList.toggle("hidden", s !== id);
	}
}

function showError(msg: string): void {
	$("error-message").textContent = msg;
	showScreen("error-screen");
}

function formatDate(ts: number): string {
	return new Date(ts * 1000).toLocaleDateString();
}

// Navigation
$("back-to-sessions").onclick = () => loadSessions();
$("back-to-gallery").onclick = () => {
	if (state.currentSessionId) {
		loadArtifacts(state.currentSessionId, $("gallery-title").textContent);
	}
};
$("btn-retry").onclick = () => init();

// Boot
document.addEventListener("DOMContentLoaded", init);
