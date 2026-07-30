import { api, type ArtifactItem, type PublicShare, type RevisionItem, type SessionItem } from "./api";
import { CanvasNavigator, type CanvasRenderer, type TelegramBackButton } from "./navigation";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const webapp = (window as { Telegram?: { WebApp?: { initData?: string; ready(): void; expand(): void; BackButton?: TelegramBackButton } } }).Telegram?.WebApp;
let renderGeneration = 0;

const renderer: CanvasRenderer = {
  render(view) {
    renderGeneration += 1;
    clearTransientContent();
    if (view.kind === "picker") renderPicker(view.sessions);
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
  if (webapp) { webapp.ready(); webapp.expand(); }
  const initData = webapp?.initData || "";
  if (!initData) { renderer.showError("Open Canvas from Telegram to view your private artifacts."); return; }
  showScreen("loading-screen");
  try {
    await api.login(initData);
    await navigator.openDefault();
  } catch {
    renderer.showError("Authentication failed. Please reopen Canvas from Telegram.");
  }
}

function renderPicker(sessions: SessionItem[]): void {
  showScreen("session-picker");
  const list = $<HTMLUListElement>("session-list");
  if (!sessions.length) { appendEmpty(list, "No canvases yet — ask the agent to publish one."); return; }
  for (const session of sessions) list.appendChild(listButton(session.title || `Session ${session.id.slice(0, 8)}`, `${session.artifact_count} artifact${session.artifact_count === 1 ? "" : "s"}`, () => void navigator.openGallery(session)));
}

function renderGallery(session: SessionItem, artifacts: ArtifactItem[]): void {
  $("gallery-title").textContent = session.title || `Session ${session.id.slice(0, 8)}`;
  showScreen("artifact-gallery");
  const list = $<HTMLUListElement>("artifact-list");
  if (!artifacts.length) { appendEmpty(list, "No viewable artifacts remain in this session."); return; }
  for (const artifact of artifacts) list.appendChild(listButton(artifact.title || `Artifact ${artifact.id.slice(0, 8)}`, `Created ${formatDate(artifact.created_at)}`, () => navigator.openViewer(session, artifact)));
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
      try {
        const duration = Number($<HTMLSelectElement>("share-duration").value);
        const share = await api.createPublicShare(artifact.id, duration);
        if (window.navigator.clipboard?.writeText) {
          await window.navigator.clipboard.writeText(share.url);
          $("btn-share").textContent = "Public link copied ✓";
        } else {
          window.prompt("Copy your public link", share.url);
          $("btn-share").textContent = "Public link ready";
        }
        if (generation === renderGeneration) await renderPublicShares(artifact, generation);
      } catch { $("btn-share").textContent = "Could not create link"; }
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
  const detail = document.createElement("span");
  detail.className = "share-meta";
  detail.textContent = `Public until ${formatDate(share.expires_at)}`;
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

function listButton(title: string, meta: string, onClick: () => void): HTMLLIElement {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button"; button.className = "list-item"; button.onclick = onClick;
  const label = document.createElement("span"); label.className = "item-title"; label.textContent = title;
  const detail = document.createElement("span"); detail.className = "item-meta"; detail.textContent = meta;
  button.append(label, detail); item.appendChild(button); return item;
}
function appendEmpty(list: HTMLUListElement, message: string): void { const item = document.createElement("li"); item.className = "empty-state"; item.textContent = message; list.appendChild(item); }
function revisionOption(revision: RevisionItem): HTMLOptionElement { const option = document.createElement("option"); option.value = revision.id; option.textContent = `#${revision.ordinal} — ${formatDate(revision.created_at)}`; return option; }
function loadDocument(artifactId: string, revisionId: string): void { $<HTMLIFrameElement>("artifact-iframe").src = api.getDocumentUrl(artifactId, revisionId); }
function showScreen(id: string): void {
  for (const screen of ["session-picker", "artifact-gallery", "artifact-viewer", "error-screen", "loading-screen"]) $(screen).classList.toggle("hidden", screen !== id);
  document.body.classList.toggle("viewer-active", id === "artifact-viewer");
}
function formatDate(timestamp: number): string { return new Date(timestamp * 1000).toLocaleDateString(); }

$("back-to-sessions").onclick = () => void navigator.openPicker();
$("back-to-gallery").onclick = () => { closeViewerMenu(false); navigator.back(); };
$("browse-all").onclick = () => { clearTransientContent(); void navigator.openPicker(); };
$("viewer-menu-toggle").onclick = () => $("viewer-menu").hidden ? openViewerMenu() : closeViewerMenu();
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !$("viewer-menu").hidden) { event.preventDefault(); closeViewerMenu(); } });
document.addEventListener("pointerdown", (event) => {
  const target = event.target as Node;
  if (!$("viewer-menu").hidden && !$("viewer-menu").contains(target) && !$("viewer-menu-toggle").contains(target)) closeViewerMenu();
});
$("btn-retry").onclick = () => void init();
document.addEventListener("DOMContentLoaded", () => void init());
