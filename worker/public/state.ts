/** Minimal app state for the Canvas Mini App. */

export interface ArtifactView {
	id: string;
	session_id: string;
	title: string;
	current_revision_id: string | null;
	trashed_at: number | null;
	created_at: number;
}

class AppState {
	currentSessionId: string | null = null;
	currentArtifactId: string | null = null;
	artifacts: ArtifactView[] = [];
}

export const state = new AppState();
