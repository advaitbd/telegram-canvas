import { describe, expect, it, vi } from "vitest";
import {
  CanvasNavigator,
  type Artifact,
  type CanvasApiLike,
  type CanvasRenderer,
  type Session,
  type TelegramBackButton,
} from "../public/navigation";

const session = (id: string, last_active_at = 1): Session => ({ id, title: id, artifact_count: 1, last_active_at, expires_at: 999 });
const artifact = (id: string, session_id: string, created_at = 1): Artifact => ({
  id, session_id, title: id, current_revision_id: `revision-${id}`, created_at,
});

function fixture(overrides: Partial<CanvasApiLike> = {}) {
  const api: CanvasApiLike = {
    bootstrap: vi.fn().mockResolvedValue({ session: session("newer", 2), artifact: artifact("artifact-newer", "newer") }),
    getCachedBootstrap: vi.fn().mockReturnValue(null),
    listSessions: vi.fn().mockResolvedValue([session("older", 1), session("newer", 2)]),
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
  it("opens the newest viewable artifact by default", async () => {
    const { navigator, renderer } = fixture();
    await navigator.openDefault();
    expect(renderer.render).toHaveBeenLastCalledWith({ kind: "viewer", session: session("newer", 2), artifact: artifact("artifact-newer", "newer") });
  });

  it("shows the picker when the owner has no viewable artifacts", async () => {
    const { navigator, renderer } = fixture({ bootstrap: vi.fn().mockResolvedValue(null), listSessions: vi.fn().mockResolvedValue([]) });
    await navigator.openDefault();
    expect(renderer.render).toHaveBeenLastCalledWith({ kind: "picker", sessions: [] });
  });

  it("backs from viewer to gallery then picker and replaces Telegram handlers", async () => {
    const { navigator, renderer, backButton } = fixture();
    await navigator.openDefault();
    navigator.back();
    await vi.waitFor(() => expect(renderer.render).toHaveBeenLastCalledWith({ kind: "gallery", session: session("newer", 2), artifacts: [artifact("artifact-newer", "newer")] }));
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

  it("renders a cached default while a refresh fails", async () => {
    const cached = { session: session("cached", 3), artifact: artifact("cached-artifact", "cached") };
    const { navigator, renderer } = fixture({
      getCachedBootstrap: vi.fn().mockReturnValue(cached),
      bootstrap: vi.fn().mockRejectedValue(new Error("offline")),
    });
    await navigator.openDefault();
    expect(renderer.render).toHaveBeenLastCalledWith({ kind: "viewer", ...cached });
    expect(renderer.showError).not.toHaveBeenCalled();
  });

  it.each(["401 Unauthorized", "404 Not found"])("shows a precise recoverable error for %s", async (message) => {
    const { navigator, renderer } = fixture({ bootstrap: vi.fn().mockRejectedValue(new Error(message)) });
    await navigator.openDefault();
    expect(renderer.showError).toHaveBeenCalledWith(message.startsWith("401")
      ? "Your Canvas session has expired. Please retry from Telegram."
      : "Could not load Canvas. Please try again.");
  });
});
