import { api, type ArtifactItem, type CanvasItem, type PublicShare, type RevisionItem, type SessionItem } from "./api";
import { haptic, runPendingAction } from "./interactions";
import { CanvasNavigator, type CanvasRenderer, type TelegramBackButton } from "./navigation";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const webapp = (window as { Telegram?: { WebApp?: { initData?: string; ready(): void; expand(): void; BackButton?: TelegramBackButton } } }).Telegram?.WebApp;
let renderGeneration = 0;
// In-flight share-list reads are dropped once a direct render or cleanup supersedes them.
let shareListVersion = 0;
let shareListRequestedGeneration = -1;
let activeViewer: { artifact: ArtifactItem; generation: number } | null = null;
let managementCanvases: CanvasItem[] = [];
let managementQuery = "";

const renderer: CanvasRenderer = {
  showLoading(message) {
    renderGeneration += 1;
    activeViewer = null;
    shareListRequestedGeneration = -1;
    closeViewerMenu(false);
    $("loading-screen").textContent = message;
    showScreen("loading-screen");
  },
  render(view) {
    renderGeneration += 1;
    clearTransientContent();
    if (view.kind === "picker") renderPicker(view.sessions);
    if (view.kind === "management") renderManagement(view.canvases);
    if (view.kind === "gallery") renderGallery(view.session, view.artifacts);
    if (view.kind === "viewer") void renderViewer(view.session, view.artifact, renderGeneration);
  },
  showError(message) {
    renderGeneration += 1;
    clearTransientContent();
    $("error-message").textContent = message;
    showScreen("error-screen");
  },
};


const navigator = new CanvasNavigator(api, renderer, webapp?.BackButton);
async function init(): Promise<void> {
  const appWindow = window as Window & { __canvasInitToken?: number };
  const token = (appWindow.__canvasInitToken ?? 0) + 1;
  appWindow.__canvasInitToken = token;
  if (webapp) { webapp.ready(); webapp.expand(); }
  const initData = webapp?.initData || "";
  if (!initData) { renderer.showError("Open Canvas from Telegram to view your private artifacts."); return; }
  showScreen("loading-screen");
  try {
    await api.login(initData);
    if (appWindow.__canvasInitToken !== token) return;
    await navigator.openDefault();
  } catch {
    if (appWindow.__canvasInitToken === token) renderer.showError("Authentication failed. Please reopen Canvas from Telegram.");
  }
}

function renderPicker(sessions: SessionItem[]): void {
  showScreen("session-picker");
  const list = $<HTMLUListElement>("session-list");
  $("session-count").textContent = `${sessions.length} session${sessions.length === 1 ? "" : "s"}`;
  if (!sessions.length) { appendEmpty(list, "No sessions yet. Ask the agent to publish a canvas, then it will live here."); return; }
  for (const session of sessions) list.appendChild(sessionRow(session));
}

function sessionRow(session: SessionItem): HTMLLIElement {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "list-item";
  button.onclick = () => void navigator.openGallery(session);
  const title = document.createElement("span");
  title.className = "item-title";
  title.textContent = session.title || `Session ${session.id.slice(0, 8)}`;
  const meta = document.createElement("span");
  meta.className = "item-meta";
  meta.textContent = `${session.artifact_count} canvas${session.artifact_count === 1 ? "" : "es"} · active ${formatRelativeDate(session.last_active_at)} · expires ${formatRelativeDate(session.expires_at)}`;
  button.append(title, meta);
  item.appendChild(button);
  return item;
}

export function renderManagement(canvases: CanvasItem[]): void {
  managementCanvases = canvases;
  renderManagementList();
}

function renderManagementList(): void {
  showScreen("canvas-management");
  const query = managementQuery.trim().toLowerCase();
  const canvases = query
    ? managementCanvases.filter((canvas) => `${canvas.title} ${canvas.session_title}`.toLowerCase().includes(query))
    : managementCanvases;
  $("management-count").textContent = query
    ? `${canvases.length} of ${managementCanvases.length} canvases`
    : `${canvases.length} canvas${canvases.length === 1 ? "" : "es"}`;
  $<HTMLButtonElement>("clear-canvas-search").disabled = !query;
  const list = $<HTMLUListElement>("canvas-list");
  list.replaceChildren();
  if (!canvases.length) {
    appendEmpty(list, query ? "No canvases match your search." : "No canvases yet. Ask the agent to publish one, then it will live here.");
    return;
  }
  for (const canvas of canvases) list.appendChild(canvasCard(canvas));
}

function canvasCard(canvas: CanvasItem): HTMLLIElement {
  const item = document.createElement("li"); item.className = "canvas-card";
  const open = document.createElement("button"); open.type = "button"; open.className = "canvas-open";
  open.onclick = () => navigator.openViewer(toSession(canvas), canvas);
  const title = document.createElement("span"); title.className = "item-title"; title.textContent = canvas.title || "Untitled canvas";
  const session = document.createElement("span"); session.className = "canvas-session"; session.textContent = canvas.session_title || "Untitled session";
  const meta = document.createElement("span"); meta.className = "canvas-meta";
  meta.textContent = `${canvas.revision_count} revision${canvas.revision_count === 1 ? "" : "s"} · ${formatBytes(canvas.current_revision_bytes)} · updated ${formatRelativeDate(canvas.updated_at ?? canvas.created_at)} · expires ${formatRelativeDate(canvas.session_expires_at)}`;
  open.append(title, session, meta);
  const remove = document.createElement("button"); remove.type = "button"; remove.className = "canvas-delete"; remove.textContent = "Delete";
  remove.onclick = () => {
    if (!confirm(`Delete “${canvas.title || "Untitled canvas"}”? You can restore it only by republishing.`)) return;
    const generation = renderGeneration;
    void runPendingAction(remove, async () => {
      if (!await api.trashArtifact(canvas.id)) return false;
      api.clearCachedBootstrap();
      if (generation === renderGeneration) {
        managementCanvases = managementCanvases.filter((item) => item.id !== canvas.id);
        renderManagementList();
      }
      return "Deleted ✓";
    }, { busy: "Deleting…", error: "Could not delete" }, () => generation === renderGeneration);
  };
  item.append(open, remove); return item;
}

function toSession(canvas: CanvasItem): SessionItem {
  return { id: canvas.session_id, title: canvas.session_title, artifact_count: 1, last_active_at: canvas.session_last_active_at, expires_at: canvas.session_expires_at };
}

function renderGallery(session: SessionItem, artifacts: ArtifactItem[]): void {
  $("gallery-title").textContent = session.title || `Session ${session.id.slice(0, 8)}`;
  showScreen("artifact-gallery");
  const list = $<HTMLUListElement>("artifact-list");
  if (!artifacts.length) { appendEmpty(list, "No viewable artifacts remain in this session."); return; }
  for (const artifact of artifacts) {
    const item = document.createElement("li");
    item.className = "gallery-row";
    item.appendChild(listButton(artifact.title || `Artifact ${artifact.id.slice(0, 8)}`, `Created ${formatDate(artifact.created_at)}`, () => navigator.openViewer(session, artifact)));
    item.appendChild(shareButton(artifact));
    list.appendChild(item);
  }
}

function shareButton(artifact: ArtifactItem): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "gallery-share secondary-button";
  button.textContent = "Copy public link";
  let urlInput: HTMLInputElement | null = null;
  const showUrl = (url: string): void => {
    if (!urlInput) {
      urlInput = document.createElement("input");
      urlInput.className = "share-url gallery-share-url";
      urlInput.type = "url";
      urlInput.readOnly = true;
      urlInput.setAttribute("aria-label", "Public canvas link, select and copy");
      button.parentElement?.appendChild(urlInput);
    }
    if (urlInput.value !== url) urlInput.value = url;
  };
  button.onclick = () => {
    const generation = renderGeneration;
    void runPendingAction(button, async () => {
      // create is idempotent server-side: one call reuses the artifact's active link.
      const share = await api.createPublicShare(artifact.id, 30 * 86400);
      if (generation !== renderGeneration) return false;
      showUrl(share.url);
      return await copyText(share.url) ? "Link copied ✓" : "Link ready below";
    }, { busy: "Creating…", error: "Could not create link" }, () => generation === renderGeneration);
  };
  return button;
}

async function copyText(text: string): Promise<boolean> {
  if (!window.navigator.clipboard?.writeText) return false;
  try { await window.navigator.clipboard.writeText(text); return true; } catch { return false; }
}

export async function renderViewer(session: SessionItem, artifact: ArtifactItem, generation: number): Promise<void> {
  const title = artifact.title || "Untitled canvas";
  activeViewer = { artifact, generation };
  $("viewer-title").textContent = title;
  $<HTMLIFrameElement>("artifact-iframe").title = title;
  showScreen("artifact-viewer");
  if (artifact.current_revision_id) loadDocument(artifact.id, artifact.current_revision_id);
  wireViewerActions(session, artifact, generation);
  void loadViewerRevisions(artifact, generation);
}

async function loadViewerRevisions(artifact: ArtifactItem, generation: number): Promise<void> {
  if (generation !== renderGeneration) return;
  const selector = $<HTMLSelectElement>("revision-selector");
  const retry = $<HTMLButtonElement>("btn-retry-revisions");
  setRevisionStatus("Loading revisions…", false);
  retry.onclick = () => void loadViewerRevisions(artifact, generation);
  try {
    const revisions = await api.listRevisions(artifact.id);
    if (generation !== renderGeneration) return;
    selector.replaceChildren(...revisions.map(revisionOption));
    if (!revisions.length) {
      setRevisionStatus("No ready revisions are available. Retry to check again.", true);
      return;
    }
    if (!artifact.current_revision_id) loadDocument(artifact.id, revisions[0].id);
    else selector.value = artifact.current_revision_id;
    selector.onchange = () => loadDocument(artifact.id, selector.value);
    setRevisionStatus("", false);
  } catch {
    if (generation === renderGeneration) setRevisionStatus("Could not load revisions. Retry to check again.", true);
  }
}

function setRevisionStatus(message: string, retry: boolean): void {
  const status = $("revision-status");
  status.textContent = message;
  status.hidden = !message;
  $("btn-retry-revisions").hidden = !retry;
}

/** Bind the viewer action buttons with pending feedback and generation guards. */
export function wireViewerActions(session: SessionItem, artifact: ArtifactItem, generation: number): void {
  const isCurrent = (): boolean => generation === renderGeneration;
  $("btn-download").onclick = () => {
    haptic("light");
    // noopener makes window.open return null even on success, so report the request, not a result.
    window.open(api.getDownloadUrl(artifact.id), "_blank", "noopener");
    if (isCurrent()) $("btn-download").textContent = "Download requested";
  };
  $("btn-extend").onclick = () => void runPendingAction($("btn-extend"), async () =>
    await api.extendExpiry(artifact.id) ? "Extended ✓" : false,
    { busy: "Extending…", error: "Could not extend" }, isCurrent);
  $("btn-share").onclick = () => void runPendingAction($("btn-share"), async () => {
    // create is idempotent server-side: one call reuses the artifact's active link.
    const duration = Number($<HTMLSelectElement>("share-duration").value);
    const share = await api.createPublicShare(artifact.id, duration);
    const copied = isCurrent() ? await copyText(share.url) : false;
    if (isCurrent()) renderShareList(artifact, [share], generation);
    return copied ? "Public link copied ✓" : "Public link ready below";
  }, { busy: "Creating…", error: "Could not create link" }, isCurrent);
  $("btn-delete").onclick = () => {
    if (!confirm("Delete this artifact?")) return;
    void runPendingAction($("btn-delete"), async () => {
      if (!await api.trashArtifact(artifact.id)) return false;
      api.clearCachedBootstrap();
      if (isCurrent()) { closeViewerMenu(false); navigator.openGallery(session); }
      return "Deleted ✓";
    }, { busy: "Deleting…", error: "Could not delete" }, isCurrent);
  };
}

function renderShareRow(artifact: ArtifactItem, share: PublicShare, generation: number): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "share-row";
  const detail = document.createElement("div");
  detail.className = "share-detail";
  const expiry = document.createElement("span");
  expiry.className = "share-meta";
  expiry.textContent = `Public until ${formatDate(share.expires_at)}`;
  const url = document.createElement("input");
  url.className = "share-url";
  url.type = "url";
  url.readOnly = true;
  url.value = share.url;
  url.setAttribute("aria-label", "Public canvas link, select and copy");
  detail.append(expiry, url);
  const revoke = document.createElement("button");
  revoke.type = "button";
  revoke.className = "danger-button share-revoke";
  revoke.textContent = "Unshare";
  revoke.onclick = () => {
    if (!confirm("Unshare this public link? Anyone with it will lose access immediately.")) return;
    void runPendingAction(revoke, async () => {
      if (!await api.revokePublicShare(artifact.id, share.token)) return false;
      if (generation === renderGeneration) await renderPublicShares(artifact, generation);
      return "Unshared ✓";
    }, { busy: "Unsharing…", error: "Could not unshare" }, () => generation === renderGeneration);
  };
  row.append(detail, revoke);
  return row;
}

function renderShareList(artifact: ArtifactItem, shares: PublicShare[], generation: number): void {
  shareListVersion += 1; // a direct render supersedes any in-flight list read
  const list = $("public-share-list");
  list.replaceChildren();
  if (!shares.length) return;
  const label = document.createElement("p");
  label.className = "share-label";
  label.textContent = "Public link · always latest";
  list.append(label, ...shares.map((share) => renderShareRow(artifact, share, generation)));
}

export async function renderPublicShares(artifact: ArtifactItem, generation: number): Promise<void> {
  const version = ++shareListVersion;
  try {
    const shares = await api.listPublicShares(artifact.id);
    // Drop the read if cleanup, a direct render, or navigation superseded it.
    if (version !== shareListVersion || generation !== renderGeneration) return;
    renderShareList(artifact, shares, generation);
  } catch {
    // A failed refresh must never hide a link the user already has on screen.
  }
}

/** Navigation cleanup: drop pending state so a stale async completion cannot revive a reused button. */
export function clearTransientContent(): void {
  shareListVersion += 1; // supersede any in-flight share-list read
  shareListRequestedGeneration = -1;
  activeViewer = null;
  closeViewerMenu(false);
  $<HTMLIFrameElement>("artifact-iframe").src = "about:blank";
  $<HTMLUListElement>("session-list").replaceChildren();
  $<HTMLUListElement>("canvas-list").replaceChildren();
  $<HTMLUListElement>("artifact-list").replaceChildren();
  $("public-share-list").replaceChildren();
  const selector = $<HTMLSelectElement>("revision-selector");
  selector.replaceChildren();
  selector.onchange = null;
  $("revision-status").textContent = "";
  $("revision-status").hidden = true;
  $<HTMLButtonElement>("btn-retry-revisions").onclick = null;
  $<HTMLButtonElement>("btn-retry-revisions").hidden = true;
  for (const id of ["btn-download", "btn-extend", "btn-share", "btn-delete"]) {
    const button = $<HTMLButtonElement>(id);
    button.onclick = null;
    button.disabled = false;
    button.removeAttribute("aria-busy");
    delete button.dataset.pending;
  }
  $("btn-download").textContent = "Download";
  $("btn-extend").textContent = "Extend 30d";
  $("btn-share").textContent = "Create public link";
  $("btn-delete").textContent = "Delete";
}

function openViewerMenu(): void {
  const menu = $("viewer-menu");
  menu.hidden = false;
  $("viewer-menu-toggle").setAttribute("aria-expanded", "true");
  $<HTMLSelectElement>("revision-selector").focus();
  if (activeViewer && activeViewer.generation === renderGeneration && shareListRequestedGeneration !== renderGeneration) {
    shareListRequestedGeneration = renderGeneration;
    void renderPublicShares(activeViewer.artifact, renderGeneration);
  }
}

function closeViewerMenu(returnFocus = true): void {
  const menu = $("viewer-menu");
  const wasOpen = !menu.hidden;
  menu.hidden = true;
  $("viewer-menu-toggle").setAttribute("aria-expanded", "false");
  if (wasOpen && returnFocus) $<HTMLButtonElement>("viewer-menu-toggle").focus();
}

function listButton(title: string, meta: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button"; button.className = "list-item"; button.onclick = onClick;
  const label = document.createElement("span"); label.className = "item-title"; label.textContent = title;
  const detail = document.createElement("span"); detail.className = "item-meta"; detail.textContent = meta;
  button.append(label, detail);
  return button;
}
function appendEmpty(list: HTMLUListElement, message: string): void { const item = document.createElement("li"); item.className = "empty-state"; item.textContent = message; list.appendChild(item); }
function revisionOption(revision: RevisionItem): HTMLOptionElement { const option = document.createElement("option"); option.value = revision.id; option.textContent = `#${revision.ordinal} — ${formatDate(revision.created_at)}`; return option; }
function showScreen(id: string): void {
  for (const screen of ["session-picker", "canvas-management", "artifact-gallery", "artifact-viewer", "error-screen", "loading-screen"]) $(screen).classList.toggle("hidden", screen !== id);
  document.body.classList.toggle("viewer-active", id === "artifact-viewer");
}
function formatDate(timestamp: number): string { return new Date(timestamp * 1000).toLocaleDateString(); }
function formatRelativeDate(timestamp: number): string {
  const days = Math.round((timestamp * 1000 - Date.now()) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return days > 0 ? `in ${days}d` : `${Math.abs(days)}d ago`;
}
function formatBytes(bytes: number): string { return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`; }

$("gallery-back-to-sessions").onclick = () => void navigator.openPicker();
function loadDocument(artifactId: string, revisionId: string): void {
  $<HTMLIFrameElement>("artifact-iframe").src = api.getDocumentUrl(artifactId, revisionId);
}
$("back-to-management").onclick = () => void navigator.openPicker();
$("back-to-gallery").onclick = () => { closeViewerMenu(false); navigator.back(); };
$("open-management").onclick = () => void navigator.openManagement();
$("canvas-search").oninput = () => {
  managementQuery = $<HTMLInputElement>("canvas-search").value;
  renderManagementList();
};
$("clear-canvas-search").onclick = () => {
  managementQuery = "";
  $<HTMLInputElement>("canvas-search").value = "";
  renderManagementList();
  $<HTMLInputElement>("canvas-search").focus();
};
$("browse-all").onclick = () => void navigator.openManagement();
$("viewer-menu-toggle").onclick = () => $("viewer-menu").hidden ? openViewerMenu() : closeViewerMenu();
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !$("viewer-menu").hidden) { event.preventDefault(); closeViewerMenu(); } });
document.addEventListener("pointerdown", (event) => {
  const target = event.target as Node;
  if (!$("viewer-menu").hidden && !$("viewer-menu").contains(target) && !$("viewer-menu-toggle").contains(target)) closeViewerMenu();
});
$("btn-retry").onclick = () => void init();
// Tests set __canvasSkipAutoInit to import the handlers without booting the app.
const skipAutoInit = (globalThis as { __canvasSkipAutoInit?: boolean }).__canvasSkipAutoInit;
if (!skipAutoInit) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void init());
  } else {
    void init();
  }
}
