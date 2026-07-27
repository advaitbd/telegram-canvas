import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = {
  login: vi.fn(),
  listSessions: vi.fn(),
  listArtifacts: vi.fn(),
  listRevisions: vi.fn(),
  getDocumentUrl: vi.fn(),
  getDownloadUrl: vi.fn(),
  extendExpiry: vi.fn(),
  trashArtifact: vi.fn(),
};

vi.mock("../public/api", () => ({ api }));

const session = { id: "session-1", title: "Session", artifact_count: 1, last_active_at: 1, expires_at: 9 };
const artifact = { id: "artifact-1", session_id: session.id, title: "Diagram", current_revision_id: "revision-1", created_at: 1 };

async function mount(): Promise<void> {
  document.documentElement.innerHTML = readFileSync("public/index.html", "utf8");
  Object.defineProperty(window, "Telegram", { configurable: true, value: { WebApp: { initData: "telegram-init", ready: vi.fn(), expand: vi.fn() } } });
  api.login.mockResolvedValue(undefined);
  api.listSessions.mockResolvedValue([session]);
  api.listArtifacts.mockResolvedValue([artifact]);
  api.listRevisions.mockResolvedValue([{ id: "revision-1", ordinal: 1, created_at: 1, status: "ready" }]);
  api.getDocumentUrl.mockReturnValue("/documents/artifact-1/revision-1");
  api.getDownloadUrl.mockReturnValue("/downloads/artifact-1");
  api.extendExpiry.mockResolvedValue(true);
  api.trashArtifact.mockResolvedValue(true);
  vi.resetModules();
  await import("../public/app");
  document.dispatchEvent(new Event("DOMContentLoaded"));
  await vi.waitFor(() => expect(document.body.classList.contains("viewer-active")).toBe(true));
}

describe("fullscreen canvas viewer", () => {
  beforeEach(() => { vi.clearAllMocks(); document.body.className = ""; });

  it("enters fullscreen viewer mode and preserves the strict iframe sandbox", async () => {
    await mount();
    const iframe = document.querySelector<HTMLIFrameElement>("#artifact-iframe")!;
    expect(document.querySelector("#artifact-viewer")!.classList.contains("hidden")).toBe(false);
    expect(document.body.classList.contains("viewer-active")).toBe(true);
    expect(iframe.title).toBe("Diagram");
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe.src).toContain("/documents/artifact-1/revision-1");
  });

  it("opens the labelled disclosure panel, focuses it, and restores focus on Escape or outside tap", async () => {
    await mount();
    const toggle = document.querySelector<HTMLButtonElement>("#viewer-menu-toggle")!;
    const menu = document.querySelector<HTMLElement>("#viewer-menu")!;
    toggle.click();
    expect(toggle.getAttribute("aria-controls")).toBe("viewer-menu");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(menu.hidden).toBe(false);
    expect(document.activeElement).toBe(document.querySelector("#revision-selector"));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menu.hidden).toBe(true);
    expect(document.activeElement).toBe(toggle);
    toggle.click();
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(menu.hidden).toBe(true);
    expect(document.activeElement).toBe(toggle);
  });

  it("clears the iframe and old artifact handlers before navigating away", async () => {
    await mount();
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    document.querySelector<HTMLButtonElement>("#browse-all")!.click();
    await vi.waitFor(() => expect(document.querySelector("#session-picker")!.classList.contains("hidden")).toBe(false));
    expect(document.body.classList.contains("viewer-active")).toBe(false);
    expect(document.querySelector<HTMLIFrameElement>("#artifact-iframe")!.src).toBe("about:blank");
    document.querySelector<HTMLButtonElement>("#btn-download")!.click();
    expect(open).not.toHaveBeenCalled();
  });

  it("uses navigator back from the persistent back control", async () => {
    await mount();
    document.querySelector<HTMLButtonElement>("#back-to-gallery")!.click();
    expect(document.querySelector("#artifact-gallery")!.classList.contains("hidden")).toBe(false);
    expect(document.body.classList.contains("viewer-active")).toBe(false);
  });
});
