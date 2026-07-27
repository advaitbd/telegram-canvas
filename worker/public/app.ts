import { api, type ArtifactItem, type RevisionItem, type SessionItem } from "./api";
import { CanvasNavigator, type CanvasRenderer, type NavigationView, type TelegramBackButton } from "./navigation";

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
  for (const session of sessions) {
    list.appendChild(listButton(session.title || `Session ${session.id.slice(0, 8)}`, `${session.artifact_count} artifact${session.artifact_count === 1 ? "" : "s"}`, () => void navigator.openGallery(session)));
  }
}

function renderGallery(session: SessionItem, artifacts: ArtifactItem[]): void {
  $("gallery-title").textContent = session.title || `Session ${session.id.slice(0, 8)}`;
  showScreen("artifact-gallery");
  const list = $<HTMLUListElement>("artifact-list");
  if (!artifacts.length) { appendEmpty(list, "No viewable artifacts remain in this session."); return; }
  for (const artifact of artifacts) {
    list.appendChild(listButton(artifact.title || `Artifact ${artifact.id.slice(0, 8)}`, `Created ${formatDate(artifact.created_at)}`, () => navigator.openViewer(session, artifact)));
  }
}

async function renderViewer(session: SessionItem, artifact: ArtifactItem, generation: number): Promise<void> {
  $("viewer-title").textContent = artifact.title || "Untitled canvas";
  $("viewer-session").textContent = session.title || "CANVAS";
  showScreen("artifact-viewer");
  const selector = $<HTMLSelectElement>("revision-selector");
  selector.replaceChildren();
  try {
    const revisions = await api.listRevisions(artifact.id);
    if (generation !== renderGeneration) return;
    for (const revision of revisions) selector.appendChild(revisionOption(revision));
    if (revisions[0]) loadDocument(artifact.id, revisions[0].id);
    else renderer.showError("This canvas no longer has a ready revision.");
    selector.onchange = () => loadDocument(artifact.id, selector.value);
  } catch {
    if (generation === renderGeneration) renderer.showError("Could not load canvas revisions. Please retry.");
  }
  $("btn-download").onclick = () => window.open(api.getDownloadUrl(artifact.id), "_blank", "noopener");
  $("btn-extend").onclick = async () => {
    if (await api.extendExpiry(artifact.id) && generation === renderGeneration) $("btn-extend").textContent = "Extended ✓";
  };
  $("btn-delete").onclick = async () => {
    if (confirm("Delete this artifact?") && await api.trashArtifact(artifact.id) && generation === renderGeneration) navigator.openGallery(session);
  };
}

function clearTransientContent(): void {
  $<HTMLIFrameElement>("artifact-iframe").src = "about:blank";
  $<HTMLUListElement>("session-list").replaceChildren();
  $<HTMLUListElement>("artifact-list").replaceChildren();
  $<HTMLSelectElement>("revision-selector").replaceChildren();
}

function listButton(title: string, meta: string, onClick: () => void): HTMLLIElement {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button"; button.className = "list-item"; button.onclick = onClick;
  const label = document.createElement("span"); label.className = "item-title"; label.textContent = title;
  const detail = document.createElement("span"); detail.className = "item-meta"; detail.textContent = meta;
  button.append(label, detail); item.appendChild(button); return item;
}

function appendEmpty(list: HTMLUListElement, message: string): void {
  const item = document.createElement("li"); item.className = "empty-state"; item.textContent = message; list.appendChild(item);
}

function revisionOption(revision: RevisionItem): HTMLOptionElement {
  const option = document.createElement("option"); option.value = revision.id; option.textContent = `#${revision.ordinal} — ${formatDate(revision.created_at)}`; return option;
}

function loadDocument(artifactId: string, revisionId: string): void { $<HTMLIFrameElement>("artifact-iframe").src = api.getDocumentUrl(artifactId, revisionId); }
function showScreen(id: string): void { for (const screen of ["session-picker", "artifact-gallery", "artifact-viewer", "error-screen", "loading-screen"]) $(screen).classList.toggle("hidden", screen !== id); }
function formatDate(timestamp: number): string { return new Date(timestamp * 1000).toLocaleDateString(); }

$("back-to-sessions").onclick = () => void navigator.openPicker();
$("back-to-gallery").onclick = () => navigator.back();
$("browse-all").onclick = () => void navigator.openPicker();
$("btn-retry").onclick = () => void init();
document.addEventListener("DOMContentLoaded", () => void init());
