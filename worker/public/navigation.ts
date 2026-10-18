/** Testable navigation and default-selection primitives for the Canvas shell. */

export interface Session {
  id: string;
  title: string;
  artifact_count: number;
  last_active_at: number;
  expires_at: number;
}

export interface Artifact {
  id: string;
  session_id: string;
  title: string;
  current_revision_id: string | null;
  created_at: number;
}

export interface Canvas extends Artifact {
	session_title: string;
	session_last_active_at: number;
	session_expires_at: number;
	revision_count: number;
	current_revision_bytes: number;
	updated_at: number;
}

export interface Revision {
  id: string;
  ordinal: number;
  created_at: number;
  status: string;
}

export interface BootstrapCanvas {
  session: Session;
  artifact: Artifact;
}

export interface CanvasApiLike {
  bootstrap(): Promise<BootstrapCanvas | null>;
  getCachedBootstrap(): BootstrapCanvas | null;
  listSessions(): Promise<Session[]>;
  listCanvases(): Promise<Canvas[]>;
  listArtifacts(sessionId: string): Promise<Artifact[]>;
  listRevisions(artifactId: string): Promise<Revision[]>;
}

export type NavigationView =
  | { kind: "picker"; sessions: Session[] }
  | { kind: "management"; canvases: Canvas[] }
  | { kind: "gallery"; session: Session; artifacts: Artifact[] }
  | { kind: "viewer"; session: Session; artifact: Artifact };

export interface TelegramBackButton {
  show(): void;
  hide(): void;
  onClick(callback: () => void): void;
  offClick(callback: () => void): void;
}

export interface CanvasRenderer {
  render(view: NavigationView): void;
  showLoading(message: string): void;
  showError(message: string): void;
}

interface PendingNavigation {
  key: string;
  generation: number;
  promise: Promise<void>;
}

const newestFirst = <T extends { id: string }>(items: T[], timestamp: keyof T): T[] =>
  [...items].sort((a, b) => Number(b[timestamp]) - Number(a[timestamp]) || b.id.localeCompare(a.id));

/** Select the newest artifact in the newest session that has one. */
export function resolveDefaultArtifact(sessions: Session[], artifactsBySession: Map<string, Artifact[]>): { session: Session; artifact: Artifact } | null {
  for (const candidate of newestFirst(sessions, "last_active_at")) {
    const artifact = newestFirst(artifactsBySession.get(candidate.id) ?? [], "created_at")[0];
    if (artifact) return { session: candidate, artifact };
  }
  return null;
}

/** Navigation state machine with a generation token to ignore stale async work. */
export class CanvasNavigator {
  private generation = 0;
  private readonly artifactsBySession = new Map<string, Artifact[]>();
  private current: NavigationView | null = null;
  private pending: PendingNavigation | null = null;
  private readonly onTelegramBack = () => this.back();

  constructor(
    private readonly api: CanvasApiLike,
    private readonly renderer: CanvasRenderer,
    private readonly backButton?: TelegramBackButton,
  ) {}

  async openDefault(): Promise<void> {
    await this.openPicker();
  }

  openPicker(): Promise<void> {
    return this.navigate("picker", "Loading sessions…", async (generation) => {
      const sessions = newestFirst(await this.api.listSessions(), "last_active_at");
      if (!this.isCurrent(generation)) return;
      this.setView({ kind: "picker", sessions });
    });
  }

  openManagement(): Promise<void> {
    return this.navigate("management", "Loading all canvases…", async (generation) => {
      const canvases = newestFirst(await this.api.listCanvases(), "updated_at");
      if (!this.isCurrent(generation)) return;
      this.setView({ kind: "management", canvases });
    });
  }

  openGallery(session: Session): Promise<void> {
    return this.navigate(`gallery:${session.id}`, "Loading session canvases…", async (generation) => {
      const artifacts = newestFirst(await this.api.listArtifacts(session.id), "created_at");
      if (!this.isCurrent(generation)) return;
      this.artifactsBySession.set(session.id, artifacts);
      this.setView({ kind: "gallery", session, artifacts });
    });
  }

  openViewer(session: Session, artifact: Artifact): void {
    this.nextGeneration();
    this.setView({ kind: "viewer", session, artifact });
  }

  back(): void {
    if (this.current?.kind === "viewer") {
      const artifacts = this.artifactsBySession.get(this.current.session.id);
      if (artifacts) {
        this.nextGeneration();
        this.setView({ kind: "gallery", session: this.current.session, artifacts });
      } else {
        void this.openGallery(this.current.session);
      }
    } else if (this.current?.kind === "gallery" || this.current?.kind === "management") {
      void this.openPicker();
    }
  }

  private navigate(
    key: string,
    message: string,
    load: (generation: number) => Promise<void>,
  ): Promise<void> {
    if (this.pending?.key === key && this.pending.generation === this.generation) return this.pending.promise;
    const generation = this.nextGeneration();
    this.renderer.showLoading(message);
    let promise!: Promise<void>;
    promise = (async () => {
      try {
        await load(generation);
      } catch (error) {
        if (this.isCurrent(generation)) this.renderer.showError(errorMessage(error));
      }
    })().finally(() => {
      if (this.pending?.promise === promise) this.pending = null;
    });
    this.pending = { key, generation, promise };
    return promise;
  }

  private nextGeneration(): number {
    this.generation += 1;
    return this.generation;
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  private setView(view: NavigationView): void {
    this.current = view;
    this.renderer.render(view);
    this.syncBackButton();
  }

  private syncBackButton(): void {
    if (!this.backButton) return;
    this.backButton.offClick(this.onTelegramBack);
    if (this.current?.kind === "picker") {
      this.backButton.hide();
    } else {
      this.backButton.onClick(this.onTelegramBack);
      this.backButton.show();
    }
  }
}


function errorMessage(error: unknown): string {
  return error instanceof Error && /401|unauthor/i.test(error.message)
    ? "Your Canvas session has expired. Please retry from Telegram."
    : "Could not load Canvas. Please try again.";
}
