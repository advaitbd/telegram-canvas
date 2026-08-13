import { api, type ArtifactItem, type CanvasItem, type PublicShare, type RevisionItem, type SessionItem } from "./api";
import { CanvasNavigator, type CanvasRenderer, type TelegramBackButton } from "./navigation";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const webapp = (window as { Telegram?: { WebApp?: { initData?: string; ready(): void; expand(): void; BackButton?: TelegramBackButton } } }).Telegram?.WebApp;
let renderGeneration = 0;

const renderer: CanvasRenderer = {
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

function renderManagement(canvases: CanvasItem[]): void {
  showScreen("canvas-management");
  const list = $<HTMLUListElement>("canvas-list");
  $("management-count").textContent = `${canvases.length} canvas${canvases.length === 1 ? "" : "es"}`;
  if (!canvases.length) { appendEmpty(list, "No canvases yet. Ask the agent to publish one, then it will live here."); return; }
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
  remove.onclick = async () => {
    if (!confirm(`Delete “${canvas.title || "Untitled canvas"}”? You can restore it only by republishing.`)) return;
    remove.disabled = true;
    if (await api.trashArtifact(canvas.id)) { api.clearCachedBootstrap(); void navigator.openPicker(); }
    else { remove.disabled = false; remove.textContent = "Try again"; }
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
  button.onclick = async () => {
    button.disabled = true;
    try {
      const shares = await api.listPublicShares(artifact.id);
      const share = shares.find((candidate) => candidate.revision_id === artifact.current_revision_id)
        ?? await api.createPublicShare(artifact.id, 30 * 86400);
      try {
        if (!window.navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
        await window.navigator.clipboard.writeText(share.url);
        button.textContent = "Link copied ✓";
      } catch {
        button.textContent = "Link ready below";
        const url = document.createElement("input");
        url.className = "share-url gallery-share-url";
        url.type = "url";
        url.readOnly = true;
        url.value = share.url;
        url.setAttribute("aria-label", "Public canvas link, select and copy");
        button.parentElement?.appendChild(url);
      }
    } catch {
      button.textContent = "Could not create link";
    } finally {
      button.disabled = false;
    }
  };
  return button;
}

async function renderViewer(session: SessionItem, artifact: ArtifactItem, generation: number): Promise<void> {
  const title = artifact.title || "Untitled canvas";
  $("viewer-title").textContent = title;
  $<HTMLIFrameElement>("artifact-iframe").title = title;
  showScreen("artifact-viewer");
  if (artifact.current_revision_id) loadDocument(artifact.id, artifact.current_revision_id);
  const selector = $<HTMLSelectElement>("revision-selector");
  try {
    const revisions = await api.listRevisions(artifact.id);
    if (generation !== renderGeneration) return;
    for (const revision of revisions) selector.appendChild(revisionOption(revision));
    if (revisions[0]) {
      if (!artifact.current_revision_id) loadDocument(artifact.id, revisions[0].id);
    } else { renderer.showError("This canvas no longer has a ready revision."); return; }
    selector.onchange = () => loadDocument(artifact.id, selector.value);
    void renderPublicShares(artifact, generation);
    $("btn-download").onclick = () => window.open(api.getDownloadUrl(artifact.id), "_blank", "noopener");
    $("btn-extend").onclick = async () => {
      if (await api.extendExpiry(artifact.id) && generation === renderGeneration) $("btn-extend").textContent = "Extended ✓";
    };
    $("btn-share").onclick = async () => {
      const shareButton = $<HTMLButtonElement>("btn-share");
      shareButton.disabled = true;
      try {
        const duration = Number($<HTMLSelectElement>("share-duration").value);
        const shares = await api.listPublicShares(artifact.id);
        const share = shares.find((candidate) => candidate.revision_id === artifact.current_revision_id)
          ?? await api.createPublicShare(artifact.id, duration);
        try {
          if (!window.navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
          await window.navigator.clipboard.writeText(share.url);
          shareButton.textContent = "Public link copied ✓";
        } catch {
          shareButton.textContent = "Public link ready below";
        }
        if (generation === renderGeneration) await renderPublicShares(artifact, generation);
      } catch { shareButton.textContent = "Could not create link"; }
      finally { shareButton.disabled = false; }
    };
    $("btn-delete").onclick = async () => {
      closeViewerMenu(false);
      if (confirm("Delete this artifact?") && await api.trashArtifact(artifact.id) && generation === renderGeneration) {
        api.clearCachedBootstrap();
        navigator.openGallery(session);
      }
    };
  } catch {
    if (generation === renderGeneration) renderer.showError("Could not load canvas revisions. Please retry.");
  }
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
  revoke.onclick = async () => {
    if (!confirm("Unshare this public link? Anyone with it will lose access immediately.")) return;
    revoke.disabled = true;
    if (await api.revokePublicShare(artifact.id, share.token) && generation === renderGeneration) await renderPublicShares(artifact, generation);
    else revoke.disabled = false;
  };
  row.append(detail, revoke);
  return row;
}

async function renderPublicShares(artifact: ArtifactItem, generation: number): Promise<void> {
  const list = $("public-share-list");
  try {
    const shares = await api.listPublicShares(artifact.id);
    if (generation !== renderGeneration) return;
    list.replaceChildren();
    if (!shares.length) return;
    const label = document.createElement("p");
    label.className = "share-label";
    label.textContent = "Active public links";
    list.append(label, ...shares.map((share) => renderShareRow(artifact, share, generation)));
  } catch {
    if (generation === renderGeneration) list.replaceChildren();
  }
}

function clearTransientContent(): void {
  closeViewerMenu(false);
  $<HTMLIFrameElement>("artifact-iframe").src = "about:blank";
  $<HTMLUListElement>("session-list").replaceChildren();
  $<HTMLUListElement>("canvas-list").replaceChildren();
  $<HTMLUListElement>("artifact-list").replaceChildren();
  $("public-share-list").replaceChildren();
  const selector = $<HTMLSelectElement>("revision-selector");
  selector.replaceChildren();
  selector.onchange = null;
  for (const id of ["btn-download", "btn-extend", "btn-share", "btn-delete"]) $(id).onclick = null;
  $("btn-extend").textContent = "Extend 30d";
  $("btn-share").textContent = "Create public link";
}

function openViewerMenu(): void {
  const menu = $("viewer-menu");
  menu.hidden = false;
  $("viewer-menu-toggle").setAttribute("aria-expanded", "true");
  $<HTMLSelectElement>("revision-selector").focus();
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
$("open-management").onclick = () => void navigator.openManagement();
$("back-to-gallery").onclick = () => { closeViewerMenu(false); navigator.back(); };
$("browse-all").onclick = () => { clearTransientContent(); void navigator.openManagement(); };
$("viewer-menu-toggle").onclick = () => $("viewer-menu").hidden ? openViewerMenu() : closeViewerMenu();
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !$("viewer-menu").hidden) { event.preventDefault(); closeViewerMenu(); } });
document.addEventListener("pointerdown", (event) => {
  const target = event.target as Node;
  if (!$("viewer-menu").hidden && !$("viewer-menu").contains(target) && !$("viewer-menu-toggle").contains(target)) closeViewerMenu();
});
$("btn-retry").onclick = () => void init();
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void init());
} else {
  void init();
}
