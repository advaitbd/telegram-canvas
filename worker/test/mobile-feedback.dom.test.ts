import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type ArtifactItem, type CanvasItem, type SessionItem } from "../public/api";
import * as interactions from "../public/interactions";
import type * as AppModule from "../public/app";

const BODY_HTML = new DOMParser().parseFromString(readFileSync("public/index.html", "utf8"), "text/html").body.innerHTML;

const session: SessionItem = { id: "session-1", title: "Session", artifact_count: 1, last_active_at: 1, expires_at: 999 };
const artifact: ArtifactItem = { id: "artifact-1", session_id: "session-1", title: "Canvas", current_revision_id: "rev-1", trashed_at: null, created_at: 1 };

let app: typeof AppModule;
let a: ArtifactItem;

const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

beforeAll(async () => {
  (globalThis as { __canvasSkipAutoInit?: boolean }).__canvasSkipAutoInit = true;
  document.body.innerHTML = BODY_HTML;
  // Dynamic import: app.ts binds DOM handlers at module load, so the jsdom body and
  // __canvasSkipAutoInit must exist first; the path is literal, not runtime-selected.
  app = await import("../public/app");
});

beforeEach(() => {
  app.clearTransientContent();
  a = { ...artifact };
  api.listPublicShares = vi.fn().mockResolvedValue([]);
  api.createPublicShare = vi.fn();
  api.listRevisions = vi.fn().mockResolvedValue([]);
  api.extendExpiry = vi.fn().mockResolvedValue(true);
  api.trashArtifact = vi.fn().mockResolvedValue(true);
  api.revokePublicShare = vi.fn().mockResolvedValue(true);
  api.getDownloadUrl = vi.fn().mockReturnValue("/api/artifacts/artifact-1/download");
  Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: undefined });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (window as { Telegram?: unknown }).Telegram;
  app.clearTransientContent();
});

afterAll(() => {
  delete (globalThis as { __canvasSkipAutoInit?: boolean }).__canvasSkipAutoInit;
});

describe("viewer action feedback", () => {
  it("shows immediate pending feedback then the success label", async () => {
    let finish!: (value: boolean) => void;
    api.extendExpiry = vi.fn().mockReturnValue(new Promise<boolean>((resolve) => { finish = resolve; }));
    app.wireViewerActions(session, a, 0);
    const button = element<HTMLButtonElement>("btn-extend");

    button.click();
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.textContent).toBe("Extending…");

    finish(true);
    await vi.waitFor(() => expect(button.textContent).toBe("Extended ✓"));
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute("aria-busy")).toBe(false);
  });

  it("ignores duplicate taps while a request is pending", async () => {
    let finish!: (value: boolean) => void;
    const extendExpiry = vi.fn().mockReturnValue(new Promise<boolean>((resolve) => { finish = resolve; }));
    api.extendExpiry = extendExpiry;
    app.wireViewerActions(session, a, 0);
    const button = element<HTMLButtonElement>("btn-extend");

    button.click();
    button.click();
    button.click();
    expect(extendExpiry).toHaveBeenCalledTimes(1);

    finish(true);
    await vi.waitFor(() => expect(button.textContent).toBe("Extended ✓"));
  });

  it("surfaces failures with an error label", async () => {
    api.extendExpiry = vi.fn().mockRejectedValue(new Error("network"));
    app.wireViewerActions(session, a, 0);
    const button = element<HTMLButtonElement>("btn-extend");

    button.click();
    await vi.waitFor(() => expect(button.textContent).toBe("Could not extend"));
    expect(button.disabled).toBe(false);
  });

  it("does not repaint shared UI when the render generation is stale", async () => {
    api.extendExpiry = vi.fn().mockResolvedValue(true);
    app.wireViewerActions(session, a, 999);
    const button = element<HTMLButtonElement>("btn-extend");

    button.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(button.textContent).toBe("Extending…");
    expect(button.disabled).toBe(false);
    expect(button.dataset.pending).toBeUndefined();
  });

  it("reports delete failure without leaving a stuck button", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    api.trashArtifact = vi.fn().mockResolvedValue(false);
    app.wireViewerActions(session, a, 0);
    const button = element<HTMLButtonElement>("btn-delete");

    button.click();
    await vi.waitFor(() => expect(button.textContent).toBe("Could not delete"));
    expect(button.disabled).toBe(false);
  });

  it("reports the download request honestly even though noopener returns null", () => {
    const open = vi.fn().mockReturnValue(null);
    vi.stubGlobal("open", open);
    app.wireViewerActions(session, a, 0);
    const button = element<HTMLButtonElement>("btn-download");

    button.click();
    expect(open).toHaveBeenCalledWith("/api/artifacts/artifact-1/download", "_blank", "noopener");
    expect(button.textContent).toBe("Download requested");
  });
});

describe("public link feedback", () => {
  const live = { token: "t2", url: "https://canvas.example/s/t2", expires_at: Math.floor(Date.now() / 1000) + 3600, revision_id: "rev-1" };

  it("copies and displays the link from one idempotent create call", async () => {
    api.createPublicShare = vi.fn().mockResolvedValue(live);
    api.listPublicShares = vi.fn().mockResolvedValue([live]);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText } });
    app.wireViewerActions(session, a, 0);

    element<HTMLButtonElement>("btn-share").click();
    await vi.waitFor(() => expect(element<HTMLButtonElement>("btn-share").textContent).toBe("Public link copied ✓"));
    expect(api.createPublicShare).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(live.url);
    expect(document.querySelector<HTMLInputElement>("#public-share-list input")?.value).toBe(live.url);
  });

  it("blocks duplicate share taps while the link request is pending", async () => {
    let finish!: (value: typeof live) => void;
    const createPublicShare = vi.fn().mockReturnValue(new Promise<typeof live>((resolve) => { finish = resolve; }));
    api.createPublicShare = createPublicShare;
    app.wireViewerActions(session, a, 0);
    const button = element<HTMLButtonElement>("btn-share");

    button.click();
    button.click();
    expect(createPublicShare).toHaveBeenCalledTimes(1);

    finish(live);
    await vi.waitFor(() => expect(button.textContent).toBe("Public link ready below"));
  });

  it("keeps the link visible when the clipboard is unavailable", async () => {
    api.createPublicShare = vi.fn().mockResolvedValue(live);
    api.listPublicShares = vi.fn().mockResolvedValue([live]);
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: undefined });
    app.wireViewerActions(session, a, 0);

    element<HTMLButtonElement>("btn-share").click();
    await vi.waitFor(() => expect(element<HTMLButtonElement>("btn-share").textContent).toBe("Public link ready below"));
    expect(document.querySelector<HTMLInputElement>("#public-share-list input")?.value).toBe(live.url);
  });

  it("shows an error label when the link request fails", async () => {
    api.createPublicShare = vi.fn().mockRejectedValue(new Error("boom"));
    app.wireViewerActions(session, a, 0);

    element<HTMLButtonElement>("btn-share").click();
    await vi.waitFor(() => expect(element<HTMLButtonElement>("btn-share").textContent).toBe("Could not create link"));
  });

  it("ignores a stale share-list read that resolves after a created link", async () => {
    let finishList!: (shares: (typeof live)[]) => void;
    api.listPublicShares = vi.fn().mockReturnValue(new Promise<(typeof live)[]>((resolve) => { finishList = resolve; }));
    api.createPublicShare = vi.fn().mockResolvedValue(live);
    app.wireViewerActions(session, a, 0);
    const shown = (): string | undefined => document.querySelector<HTMLInputElement>("#public-share-list input")?.value;

    const staleRead = app.renderPublicShares(a, 0); // opens the viewer's initial list fetch
    element<HTMLButtonElement>("btn-share").click();
    await vi.waitFor(() => expect(shown()).toBe(live.url));

    finishList([]); // the old, empty snapshot arrives after the fresh link rendered
    await staleRead;
    expect(shown()).toBe(live.url);
  });
});

describe("navigation cleanup", () => {
  it("resets pending state and chrome, and a late result cannot revive a reused button", async () => {
    let finish!: (value: boolean) => void;
    api.extendExpiry = vi.fn().mockReturnValue(new Promise<boolean>((resolve) => { finish = resolve; }));
    app.wireViewerActions(session, a, 0);
    element<HTMLIFrameElement>("artifact-iframe").src = "https://canvas.example/doc";
    element<HTMLUListElement>("artifact-list").innerHTML = "<li>stale</li>";
    const button = element<HTMLButtonElement>("btn-extend");
    button.click();
    expect(button.disabled).toBe(true);

    app.clearTransientContent();
    expect(button.disabled).toBe(false);
    expect(button.dataset.pending).toBeUndefined();
    expect(button.textContent).toBe("Extend 30d");
    expect(element<HTMLIFrameElement>("artifact-iframe").src).toBe("about:blank");
    expect(element<HTMLUListElement>("artifact-list").childElementCount).toBe(0);
    expect(element("viewer-menu").hidden).toBe(true);

    finish(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Extend 30d");
  });
});

describe("viewer open performance", () => {
  it("defers public-share listing until the action menu opens", async () => {
    api.listRevisions = vi.fn().mockResolvedValue([{ id: "rev-1", ordinal: 1, created_at: 1, status: "ready" }]);
    api.listPublicShares = vi.fn().mockResolvedValue([]);

    await app.renderViewer(session, a, 0);
    expect(api.listPublicShares).not.toHaveBeenCalled();

    element<HTMLButtonElement>("viewer-menu-toggle").click();
    await vi.waitFor(() => expect(api.listPublicShares).toHaveBeenCalledTimes(1));
  });

  it("retries share-list failures when the action menu reopens", async () => {
    api.listPublicShares = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue([]);
    await app.renderViewer(session, a, 0);
    element<HTMLButtonElement>("viewer-menu-toggle").click();
    await vi.waitFor(() => expect(element("public-share-list").textContent).toContain("Reopen"));
    element<HTMLButtonElement>("viewer-menu-toggle").click();
    element<HTMLButtonElement>("viewer-menu-toggle").click();
    await vi.waitFor(() => expect(api.listPublicShares).toHaveBeenCalledTimes(2));
    expect(element("public-share-list").textContent).toBe("");
  });

  it("keeps the eager document and safe actions available when revisions fail", async () => {
    api.listRevisions = vi.fn().mockRejectedValue(new Error("revisions unavailable"));
    api.extendExpiry = vi.fn().mockResolvedValue(true);

    await app.renderViewer(session, a, 0);
    const iframe = element<HTMLIFrameElement>("artifact-iframe");
    expect(iframe.src).toContain("/api/artifacts/artifact-1/revisions/rev-1/document");
    expect(element("error-screen").classList.contains("hidden")).toBe(true);

    element<HTMLButtonElement>("btn-extend").click();
    await vi.waitFor(() => expect(api.extendExpiry).toHaveBeenCalledWith("artifact-1"));
    await vi.waitFor(() => expect(element("revision-status").textContent).toContain("Retry"));
    expect(element<HTMLButtonElement>("btn-retry-revisions").hidden).toBe(false);
  });
  it("closes the viewer menu through the bound back handler", async () => {
    api.listRevisions = vi.fn().mockResolvedValue([]);
    await app.renderViewer(session, a, 0);
    element<HTMLButtonElement>("viewer-menu-toggle").click();
    expect(element("viewer-menu").hidden).toBe(false);

    element<HTMLButtonElement>("back-to-gallery").click();
    expect(element("viewer-menu").hidden).toBe(true);
    expect(element<HTMLButtonElement>("viewer-menu-toggle").getAttribute("aria-expanded")).toBe("false");
  });
});

describe("archive search", () => {
  const managed = (id: string, title: string, sessionTitle: string): CanvasItem => ({
    ...a,
    id,
    title,
    session_id: `session-${id}`,
    session_title: sessionTitle,
    session_last_active_at: 1,
    session_expires_at: 999,
    revision_count: 1,
    current_revision_bytes: 512,
    updated_at: 1,
  });

  it("filters locally with a visible count, clear control, and empty state", () => {
    app.renderManagement([managed("needle", "Needle canvas", "First session"), managed("other", "Other canvas", "Second session")]);
    const search = element<HTMLInputElement>("canvas-search");
    search.value = "second";
    search.dispatchEvent(new Event("input", { bubbles: true }));

    expect(element("management-count").textContent).toBe("1 of 2 canvases");
    expect(document.querySelectorAll(".canvas-card")).toHaveLength(1);
    expect(element<HTMLButtonElement>("clear-canvas-search").disabled).toBe(false);

    search.value = "missing";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(document.querySelector(".empty-state")?.textContent).toBe("No canvases match your search.");

    element<HTMLButtonElement>("clear-canvas-search").click();
    expect(search.value).toBe("");
    expect(document.querySelectorAll(".canvas-card")).toHaveLength(2);
  });

  it("retains pending deletion and failure feedback while search changes", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    let finish!: (value: boolean) => void;
    api.trashArtifact = vi.fn().mockReturnValue(new Promise<boolean>((resolve) => { finish = resolve; }));
    app.renderManagement([managed("needle", "Needle canvas", "First session")]);
    element<HTMLButtonElement>("clear-canvas-search").click();
    const button = document.querySelector<HTMLButtonElement>(".canvas-delete")!;
    button.click();
    const search = element<HTMLInputElement>("canvas-search");
    search.value = "missing";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    search.value = "needle";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(document.querySelector(".canvas-delete")).toBe(button);
    expect(button.disabled).toBe(true);
    button.click();
    expect(api.trashArtifact).toHaveBeenCalledTimes(1);
    finish(false);
    await vi.waitFor(() => expect(button.textContent).toBe("Could not delete"));
    element<HTMLButtonElement>("clear-canvas-search").click();
    expect(document.querySelector(".canvas-delete")?.textContent).toBe("Could not delete");
  });

  it("deletes in the archive without losing the search", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    api.trashArtifact = vi.fn().mockResolvedValue(true);
    app.renderManagement([managed("needle", "Needle canvas", "First session"), managed("other", "Other canvas", "Second session")]);
    const search = element<HTMLInputElement>("canvas-search");
    search.value = "needle";
    search.dispatchEvent(new Event("input", { bubbles: true }));

    document.querySelector<HTMLButtonElement>(".canvas-delete")?.click();
    await vi.waitFor(() => expect(api.trashArtifact).toHaveBeenCalledWith("needle"));
    expect(element("canvas-management").classList.contains("hidden")).toBe(false);
    expect(search.value).toBe("needle");
    expect(document.querySelectorAll(".canvas-card")).toHaveLength(0);
  });
});

describe("telegram haptics", () => {
  it("routes to haptic feedback when available and no-ops otherwise", () => {
    const impactOccurred = vi.fn();
    const notificationOccurred = vi.fn();
    (window as { Telegram?: unknown }).Telegram = { WebApp: { HapticFeedback: { impactOccurred, notificationOccurred } } };

    interactions.haptic("success");
    expect(notificationOccurred).toHaveBeenCalledWith("success");
    interactions.haptic("light");
    expect(impactOccurred).toHaveBeenCalledWith("light");

    delete (window as { Telegram?: unknown }).Telegram;
    expect(() => interactions.haptic("error")).not.toThrow();
  });
});
