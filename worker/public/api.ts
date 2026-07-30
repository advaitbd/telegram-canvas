/** API client for the Canvas Worker viewer endpoints. */

const API_BASE = "";

export interface SessionItem {
	id: string;
	title: string;
	artifact_count: number;
	last_active_at: number;
	expires_at: number;
}

export interface ArtifactItem {
	id: string;
	session_id: string;
	title: string;
	current_revision_id: string | null;
	trashed_at: number | null;
	created_at: number;
	updated_at?: number;
}

export interface CanvasItem extends ArtifactItem {
	session_title: string;
	session_last_active_at: number;
	session_expires_at: number;
	revision_count: number;
	current_revision_bytes: number;
}

export interface RevisionItem {
	id: string;
	ordinal: number;
	r2_key: string;
	content_bytes: number;
	status: string;
	created_at: number;
}

interface LoginResponse {
	ok: boolean;
	user: { id: number; first_name: string };
}

interface PublishResponse {
	ok: boolean;
	artifact_id: string;
	revision_id: string;
	ordinal: number;
	action: "created" | "updated";
}

export interface PublicShare {
	token: string;
	url: string;
	expires_at: number;
}

export interface BootstrapCanvas {
	session: SessionItem;
	artifact: ArtifactItem;
}

const BOOTSTRAP_CACHE_KEY = "canvas_bootstrap_v1";
const BOOTSTRAP_CACHE_TTL_MS = 60_000;

export class CanvasApi {
	/** Exchange Telegram WebApp init data for a session cookie. */
	async login(initData: string): Promise<LoginResponse> {
		const form = new FormData();
		form.set("init_data", initData);
		const res = await fetch(`${API_BASE}/api/auth/telegram`, {
			method: "POST",
			body: form,
			credentials: "include",
		});
		if (!res.ok) throw new Error("Login failed");
		return res.json();
	}

	async bootstrap(): Promise<BootstrapCanvas | null> {
		const res = await fetch(`${API_BASE}/api/bootstrap`, { credentials: "include" });
		if (!res.ok) throw new Error("Failed to bootstrap Canvas");
		const body = await res.json() as { canvas?: BootstrapCanvas | null };
		if (body.canvas) this.setCachedBootstrap(body.canvas);
		else sessionStorage.removeItem(BOOTSTRAP_CACHE_KEY);
		return body.canvas ?? null;
	}

	getCachedBootstrap(): BootstrapCanvas | null {
		try {
			const stored = JSON.parse(sessionStorage.getItem(BOOTSTRAP_CACHE_KEY) ?? "null") as { cached_at: number; canvas: BootstrapCanvas } | null;
			return stored && Date.now() - stored.cached_at <= BOOTSTRAP_CACHE_TTL_MS ? stored.canvas : null;
		} catch { return null; }
	}

	clearCachedBootstrap(): void {
		sessionStorage.removeItem(BOOTSTRAP_CACHE_KEY);
	}

	private setCachedBootstrap(canvas: BootstrapCanvas): void {
		sessionStorage.setItem(BOOTSTRAP_CACHE_KEY, JSON.stringify({ cached_at: Date.now(), canvas }));
	}

	/** List eligible sessions. */
	async listSessions(): Promise<SessionItem[]> {
		const res = await fetch(`${API_BASE}/api/sessions`, {
			credentials: "include",
		});
		if (!res.ok) throw new Error("Failed to list sessions");
		const body = await res.json();
		return body.sessions ?? [];
	}

	/** List all viewable canvases with enough metadata for archive management. */
	async listCanvases(): Promise<CanvasItem[]> {
		const res = await fetch(`${API_BASE}/api/canvases`, { credentials: "include" });
		if (!res.ok) throw new Error("Failed to list canvases");
		const body = await res.json();
		return body.canvases ?? [];
	}

	/** List artifacts in a session. */
	async listArtifacts(sessionId: string): Promise<ArtifactItem[]> {
		const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/artifacts`, {
			credentials: "include",
		});
		if (!res.ok) throw new Error("Failed to list artifacts");
		const body = await res.json();
		return body.artifacts ?? [];
	}

	/** List revisions for an artifact. */
	async listRevisions(artifactId: string): Promise<RevisionItem[]> {
		const res = await fetch(`${API_BASE}/api/artifacts/${artifactId}/revisions`, {
			credentials: "include",
		});
		if (!res.ok) throw new Error("Failed to list revisions");
		const body = await res.json();
		return body.revisions ?? [];
	}

	/** Get the document URL for a specific revision. */
	getDocumentUrl(artifactId: string, revisionId: string): string {
		return `${API_BASE}/api/artifacts/${artifactId}/revisions/${revisionId}/document`;
	}

	/** Extend session expiry. Requires CSRF token. */
	async extendExpiry(artifactId: string): Promise<boolean> {
		const csrf = this._getCsrfToken();
		const res = await fetch(`${API_BASE}/api/artifacts/${artifactId}/extend`, {
			method: "POST",
			credentials: "include",
			headers: {
				Origin: window.location.origin,
				"Sec-Fetch-Site": "same-origin",
				"X-CSRF-Token": csrf,
			},
		});
		return res.ok;
	}

	/** Trash an artifact. Requires CSRF token. */
	async trashArtifact(artifactId: string): Promise<boolean> {
		const csrf = this._getCsrfToken();
		const res = await fetch(`${API_BASE}/api/artifacts/${artifactId}`, {
			method: "DELETE",
			credentials: "include",
			headers: {
				Origin: window.location.origin,
				"Sec-Fetch-Site": "same-origin",
				"X-CSRF-Token": csrf,
			},
		});
		return res.ok;
	}

	/** Create a public link to the current immutable revision. */
	async createPublicShare(artifactId: string, ttlSeconds: number): Promise<PublicShare> {
		const res = await fetch(`${API_BASE}/api/artifacts/${artifactId}/shares`, {
			method: "POST",
			credentials: "include",
			headers: { "content-type": "application/json", ...this._csrfHeaders() },
			body: JSON.stringify({ ttl_seconds: ttlSeconds }),
		});
		if (!res.ok) throw new Error("Failed to create public share");
		return res.json();
	}

	async listPublicShares(artifactId: string): Promise<PublicShare[]> {
		const res = await fetch(`${API_BASE}/api/artifacts/${artifactId}/shares`, { credentials: "include" });
		if (!res.ok) throw new Error("Failed to list public shares");
		const body = await res.json();
		return body.shares ?? [];
	}

	async revokePublicShare(artifactId: string, token: string): Promise<boolean> {
		const res = await fetch(`${API_BASE}/api/artifacts/${artifactId}/shares/${token}`, {
			method: "DELETE", credentials: "include", headers: this._csrfHeaders(),
		});
		return res.ok;
	}

	/** Download the current revision as an attachment. */
	getDownloadUrl(artifactId: string): string {
		return `${API_BASE}/api/artifacts/${artifactId}/download`;
	}

	private _csrfHeaders(): Record<string, string> {
		return { Origin: window.location.origin, "Sec-Fetch-Site": "same-origin", "X-CSRF-Token": this._getCsrfToken() };
	}

	private _getCsrfToken(): string {
		const stored = sessionStorage.getItem("csrf_token");
		if (stored) return stored;
		const bytes = new Uint8Array(32);
		crypto.getRandomValues(bytes);
		const token = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
		sessionStorage.setItem("csrf_token", token);
		return token;
	}
}

export const api = new CanvasApi();
