"""Telegram Canvas publish plugin for Hermes.

Adds a `canvas_publish` tool that signs and sends HTML artifacts
to the Canvas Cloudflare Worker.

Uses `gateway.session_context.get_session_env()` to read the
Telegram creator ID and session ID at runtime — never trusts
model-provided identity values.
"""

from __future__ import annotations
from datetime import datetime
import hashlib
import hmac
import json
import os
import re
import sqlite3
import time
import uuid

import httpx

# ---------------------------------------------------------------------------
# Plugin configuration — read from environment, never from code
# ---------------------------------------------------------------------------

def _worker_url() -> str:
    return os.environ.get("CANVAS_WORKER_URL", "").rstrip("/")

def _publisher_secret() -> str:
    return os.environ.get("CANVAS_PUBLISHER_SECRET", "")

def _key_id() -> str:
    return os.environ.get("CANVAS_KEY_ID", "key1")

_SHELL_TITLE_RE = re.compile(
    r"^(?:[$#]\s*)?(?:"
    r"cd|chmod|cp|curl|docker|echo|find|git|grep|head|ls|mkdir|mv|npx|npm|"
    r"pip|pkill|pwd|python(?:\d+(?:\.\d+)?)?|rg|rm|sed|sh|ssh|sudo|tail|"
    r"tar|touch|uv|wget|which|xargs"
    r")\b",
    re.IGNORECASE,
)


def cleanTitle(title: str, chat_name: str, last_activity_at: object) -> str:
    """Return a useful session title without exposing prompt/system text."""
    candidate = str(title or "").strip()
    lowered = candidate.casefold()
    unusable = (
        not candidate
        or len(candidate) > 90
        or lowered.startswith(("[note:", "[replying to:", "[advait] ", "system information"))
        or _SHELL_TITLE_RE.match(candidate) is not None
    )
    if not unusable:
        return candidate

    try:
        timestamp = float(last_activity_at)
        date = datetime.fromtimestamp(timestamp).strftime("%b %d")
    except (TypeError, ValueError, OSError, OverflowError):
        date = datetime.now().strftime("%b %d")
    return f"{str(chat_name or '').strip() or 'Chat'} · {date}"


def _read_session_metadata(session_id: str) -> tuple[str, str, object]:
    """Read persisted session metadata without ever opening state.db writable."""
    path = os.path.expanduser("~/.hermes/state.db")
    try:
        db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            row = db.execute(
                "SELECT title, display_name, last_activity_at FROM sessions WHERE id = ?",
                (session_id,),
            ).fetchone()
        finally:
            db.close()
    except (OSError, sqlite3.Error):
        return "", "", None
    return (str(row[0] or ""), str(row[1] or ""), row[2]) if row else ("", "", None)


def _session_title(session_id: str, chat_name: str) -> str:
    title, _display_name, last_activity_at = _read_session_metadata(session_id)
    return cleanTitle(title, chat_name, last_activity_at)

# ---------------------------------------------------------------------------
# Signing — matches the canonical v1 format in the Worker
# ---------------------------------------------------------------------------

def _sign_body(body: bytes, secret: str, key_id: str) -> tuple[str, str, str]:
    """Sign a request body and return (timestamp, nonce, signature_hex)."""
    timestamp = str(int(time.time()))
    nonce = str(uuid.uuid4())
    body_sha256 = hashlib.sha256(body).hexdigest()

    canonical = "\n".join([
        "v1",
        "POST",
        "/internal/publish",
        key_id,
        timestamp,
        nonce,
        body_sha256,
    ])

    signature = hmac.new(
        key=bytes.fromhex(secret),
        msg=canonical.encode("utf-8"),
        digestmod=hashlib.sha256,
    ).hexdigest()

    return timestamp, nonce, signature

# ---------------------------------------------------------------------------
# Tool handler
# ---------------------------------------------------------------------------

def _publish_handler(args: dict, **kwargs) -> str:
    """Handle a canvas_publish tool call.

    Args expected from the model:
        title (str): Display title for the artifact.
        html (str): Full HTML document to publish.
        artifact_id (str, optional): Existing artifact ID to revise.
    """
    # Read session context from Hermes gateway (set per-turn)
    try:
        from gateway.session_context import get_session_env
    except ImportError:
        return json.dumps({
            "error": "canvas_publish requires the Hermes gateway session context",
        })

    telegram_creator_id = get_session_env("HERMES_SESSION_USER_ID", "")
    hermes_session_id = get_session_env("HERMES_SESSION_ID", "")
    chat_name = get_session_env("HERMES_SESSION_CHAT_NAME", "")
    session_title = _session_title(hermes_session_id, chat_name)

    if not telegram_creator_id or not hermes_session_id:
        return json.dumps({
            "error": "Cannot determine session identity — not running in a gateway session",
        })

    title = args.get("title", "").strip()
    html = args.get("html", "").strip()
    artifact_id = args.get("artifact_id", "").strip() or None

    if not title:
        return json.dumps({"error": "Missing required field: title"})
    if not html:
        return json.dumps({"error": "Missing required field: html"})
    if len(title) > 160:
        return json.dumps({"error": "Title exceeds 160 characters"})

    # Enforce HTML document shape
    if not html.lower().startswith("<!doctype html") and not html.lower().startswith("<html"):
        html = "<!doctype html>\n" + html

    body = {
        "telegram_creator_id": telegram_creator_id,
        "hermes_session_id": hermes_session_id,
        "session_title": session_title,
        "title": title,
        "html": html,
    }
    if chat_name:
        body["chat_name"] = chat_name
    if artifact_id:
        body["artifact_id"] = artifact_id

    body_bytes = json.dumps(body).encode("utf-8")
    secret = _publisher_secret()
    key_id = _key_id()

    if not secret:
        return json.dumps({"error": "CANVAS_PUBLISHER_SECRET not configured"})

    url = _worker_url() + "/internal/publish"
    if not _worker_url():
        return json.dumps({"error": "CANVAS_WORKER_URL not configured"})

    timestamp, nonce, signature = _sign_body(body_bytes, secret, key_id)

    try:
        resp = httpx.post(
            url,
            content=body_bytes,
            headers={
                "content-type": "application/json",
                "x-canvas-key-id": key_id,
                "x-canvas-timestamp": timestamp,
                "x-canvas-nonce": nonce,
                "x-canvas-signature": signature,
            },
            timeout=30.0,
        )
    except httpx.TimeoutException:
        return json.dumps({"error": "Canvas Worker timed out"})
    except httpx.RequestError as e:
        return json.dumps({"error": f"Network error: {e}"})

    if resp.status_code == 401:
        return json.dumps({"error": "Canvas publish authentication failed — check CANVAS_PUBLISHER_SECRET"})
    if resp.status_code == 413:
        return json.dumps({"error": "Artifact HTML exceeds 5 MiB limit"})

    try:
        result = resp.json()
    except Exception:
        return json.dumps({"error": f"Canvas Worker returned HTTP {resp.status_code}"})

    if not result.get("ok"):
        return json.dumps({"error": result.get("error", "Unknown error")})

    # Return structured tool_result
    import json as _json
    return _json.dumps({
        "ok": True,
        "artifact_id": result["artifact_id"],
        "revision_id": result["revision_id"],
        "ordinal": result.get("ordinal", 1),
        "title": title,
        "action": result.get("action", "created"),
        "expires_at": result.get("expires_at"),
    })


def _check_fn() -> bool:
    """Service gate — only available when CANVAS_WORKER_URL is set."""
    return bool(_worker_url())


def register(ctx):
    """Register the canvas_publish tool."""
    ctx.register_tool(
        name="canvas_publish",
        toolset="canvas",
        schema={
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description": "Display title for the artifact (max 160 characters)",
                },
                "html": {
                    "type": "string",
                    "description": (
                        "Full HTML document to publish. "
                        "Use for diagrams, visualizations, mockups, and previews. "
                        "Supports external HTTPS scripts including Mermaid."
                    ),
                },
                "artifact_id": {
                    "type": "string",
                    "description": (
                        "Optional — existing artifact ID to create a new revision of. "
                        "Omit to create a new artifact."
                    ),
                },
            },
            "required": ["title", "html"],
        },
        handler=_publish_handler,
        check_fn=_check_fn,
        description=(
            "Publish an HTML artifact to the user's Canvas session. "
            "Use only for visual content: diagrams, architecture sketches, "
            "mockups, charts, Mermaid graphs, or interactive previews. "
            "The artifact renders in a sandboxed iframe in Telegram."
        ),
    )
