import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type ArtifactItem, type SessionItem } from "../public/api";
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
