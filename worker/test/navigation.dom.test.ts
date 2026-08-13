import { describe, expect, it, vi } from "vitest";
import {
  CanvasNavigator,
  type Artifact,
  type Canvas,
  type CanvasApiLike,
  type CanvasRenderer,
  type Session,
  type TelegramBackButton,
} from "../public/navigation";

const session = (id: string, last_active_at = 1): Session => ({ id, title: id, artifact_count: 1, last_active_at, expires_at: 999 });
const artifact = (id: string, session_id: string, created_at = 1): Artifact => ({
  id, session_id, title: id, current_revision_id: `revision-${id}`, created_at,
});

const canvas = (id: string, session_id: string, updated_at = 1): Canvas => ({
  ...artifact(id, session_id, updated_at), session_title: session_id, session_last_active_at: updated_at,
  session_expires_at: 999, revision_count: 1, current_revision_bytes: 512, updated_at,
});

function fixture(overrides: Partial<CanvasApiLike> = {}) {
  const api: CanvasApiLike = {
    bootstrap: vi.fn().mockResolvedValue(null),
    getCachedBootstrap: vi.fn().mockReturnValue(null),
    listSessions: vi.fn().mockResolvedValue([session("older", 1), session("newer", 2)]),
    listCanvases: vi.fn().mockResolvedValue([canvas("artifact-older", "older", 1), canvas("artifact-newer", "newer", 2)]),
    listArtifacts: vi.fn().mockImplementation(async (sessionId: string) => [artifact(`artifact-${sessionId}`, sessionId)]),
    listRevisions: vi.fn().mockResolvedValue([{ id: "revision", ordinal: 1, created_at: 1, status: "ready" }]),
    ...overrides,
  };
  const renderer: CanvasRenderer = {
    render: vi.fn(),
    showError: vi.fn(),
  };
  const backButton: TelegramBackButton = { show: vi.fn(), hide: vi.fn(), onClick: vi.fn(), offClick: vi.fn() };
  return { api, renderer, backButton, navigator: new CanvasNavigator(api, renderer, backButton) };
}

describe("CanvasNavigator", () => {
  it("opens the session-first picker sorted by recent activity", async () => {
    const { navigator, renderer } = fixture();
    await navigator.openDefault();
    expect(renderer.render).toHaveBeenLastCalledWith({ kind: "picker", sessions: [session("newer", 2), session("older", 1)] });
  });

  it("opens a session gallery and keeps all-canvases management secondary", async () => {
    const { navigator, renderer } = fixture();
    await navigator.openGallery(session("newer", 2));
    expect(renderer.render).toHaveBeenLastCalledWith({ kind: "gallery", session: session("newer", 2), artifacts: [artifact("artifact-newer", "newer")] });
    await navigator.openManagement();
    expect(renderer.render).toHaveBeenLastCalledWith({ kind: "management", canvases: [canvas("artifact-newer", "newer", 2), canvas("artifact-older", "older", 1)] });
  });

  it("shows the picker when the owner has no sessions", async () => {
    const { navigator, renderer } = fixture({ listSessions: vi.fn().mockResolvedValue([]) });
    await navigator.openDefault();
    expect(renderer.render).toHaveBeenLastCalledWith({ kind: "picker", sessions: [] });
  });

  it("backs from gallery to picker and replaces Telegram handlers", async () => {
    const { navigator, renderer, backButton } = fixture();
    await navigator.openGallery(session("newer", 2));
    navigator.back();
    await vi.waitFor(() => expect(renderer.render).toHaveBeenLastCalledWith({ kind: "picker", sessions: [session("newer", 2), session("older", 1)] }));
    expect(backButton.offClick).toHaveBeenCalled();
    expect(backButton.hide).toHaveBeenCalled();
  });

  it("does not repaint with a stale async gallery response", async () => {
    let resolveOlder!: (value: Artifact[]) => void;
    const olderArtifacts = new Promise<Artifact[]>((resolve) => { resolveOlder = resolve; });
    const { navigator, renderer } = fixture({
      listArtifacts: vi.fn().mockImplementation((id: string) => id === "older" ? olderArtifacts : Promise.resolve([artifact("fresh", "newer")])),
    });
    const olderLoad = navigator.openGallery(session("older"));
    await navigator.openGallery(session("newer"));
    resolveOlder([artifact("stale", "older")]);
    await olderLoad;
    expect(renderer.render).toHaveBeenLastCalledWith({ kind: "gallery", session: session("newer"), artifacts: [artifact("fresh", "newer")] });
  });

  it.each(["401 Unauthorized", "404 Not found"])("shows a precise recoverable error for %s", async (message) => {
    const { navigator, renderer } = fixture({ listSessions: vi.fn().mockRejectedValue(new Error(message)) });
    await navigator.openDefault();
    expect(renderer.showError).toHaveBeenCalledWith(message.startsWith("401")
      ? "Your Canvas session has expired. Please retry from Telegram."
      : "Could not load Canvas. Please try again.");
  });

});
