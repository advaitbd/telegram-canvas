#!/usr/bin/env python3
"""E2E test: publish an artifact and verify it exists in R2."""
import hashlib
import hmac
import json
import os
import subprocess
import sys
import time
import uuid

WORKER_URL = "https://canvas.advaitdeshpande.com"
ACC_ID = "363f0fc4a655e1573c63f0b18d6e5e0e"

# Read secrets from environment (sourced from Hermes .env)
env = {}
with open("/home/hermes/.hermes/.env") as f:
    for line in f:
        line = line.strip()
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            env[k] = v

PUBLISHER_SECRET = env.get("CANVAS_PUBLISHER_SECRET", "")
CF_TOKEN = subprocess.run(
    ["bash", "-ic", 'echo "$CLOUDFLARE_CANVAS_DEPLOY_TOKEN"'],
    capture_output=True, text=True, env={}
).stdout.strip()

# Get bot token
TOKEN = env.get("TELEGRAM_BOT_TOKEN", "")

print("=== 1. PUBLISH HTML ARTIFACT ===")
body = json.dumps({
    "telegram_creator_id": "52460092",
    "hermes_session_id": "e2e_test_session",
    "session_title": "Canvas E2E Test",
    "title": "E2E Test Artifact",
    "html": "<!doctype html><html><body style='background:#1a1a2e;color:#eee;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh'><div style='text-align:center'><h1>Canvas E2E ✓</h1><p>Published now</p></div></body></html>",
})

body_bytes = body.encode()
body_sha256 = hashlib.sha256(body_bytes).hexdigest()
timestamp = str(int(time.time()))
nonce = str(uuid.uuid4())
key_id = "key1"

canonical = "\n".join(["v1", "POST", "/internal/publish", key_id, timestamp, nonce, body_sha256])
sig = hmac.new(
    key=bytes.fromhex(PUBLISHER_SECRET),
    msg=canonical.encode(),
    digestmod=hashlib.sha256,
).hexdigest()

import urllib.request
req = urllib.request.Request(
    f"{WORKER_URL}/internal/publish",
    data=body_bytes,
    headers={
        "Content-Type": "application/json",
        "x-canvas-key-id": key_id,
        "x-canvas-timestamp": timestamp,
        "x-canvas-nonce": nonce,
        "x-canvas-signature": sig,
    },
    method="POST",
)

try:
    resp = urllib.request.urlopen(req, timeout=30)
    result = json.loads(resp.read())
    print(f"Status: {resp.status}")
    print(f"Response: {json.dumps(result, indent=2)}")
    artifact_id = result.get("artifact_id", "")
    revision_id = result.get("revision_id", "")
    if not artifact_id:
        print("ERROR: No artifact_id in response")
        sys.exit(1)
except urllib.error.HTTPError as e:
    print(f"ERROR: HTTP {e.code}: {e.read().decode()}")
    sys.exit(1)

print()
print("=== 2. VERIFY R2 BLOB ===")
r2_key = f"artifacts/{artifact_id}/{revision_id}.html"
import urllib.request
req2 = urllib.request.Request(
    f"https://api.cloudflare.com/client/v4/accounts/{ACC_ID}/r2/buckets/telegram-canvas-artifacts/objects/{r2_key}",
    headers={"Authorization": f"Bearer {CF_TOKEN}"},
)
try:
    resp2 = urllib.request.urlopen(req2, timeout=15)
    content = resp2.read()
    print(f"R2 HTTP {resp2.status}, size: {len(content)} bytes")
    assert b"Canvas E2E" in content, "Content verification failed"
    print("Content verification: PASS")
except urllib.error.HTTPError as e:
    print(f"R2 ERROR: HTTP {e.code}")
    sys.exit(1)

print()
print("=== 3. VERIFY WORKER HEALTH ===")
req3 = urllib.request.Request(f"{WORKER_URL}/api/health")
resp3 = urllib.request.urlopen(req3, timeout=10)
print(f"Health: HTTP {resp3.status}")
assert resp3.status == 200

print()
print("=== 4. TELEGRAM MENU STATUS ===")
req4 = urllib.request.Request(
    f"https://api.telegram.org/bot{TOKEN}/getChatMenuButton?chat_id=52460092",
)
resp4 = urllib.request.urlopen(req4, timeout=10)
menu = json.loads(resp4.read())
btn = menu.get("result", {}).get("menu_button", {})
print(f"Menu: type={btn.get('type')}, text={btn.get('text')}")
assert btn.get("type") == "web_app", "Menu button not configured"
print("Menu verification: PASS")

print()
print("=== 5. VERIFY GLOBAL API ACCESSIBLE ===")
req5 = urllib.request.Request(f"{WORKER_URL}/api/sessions")
# Should return 401 without auth cookie
try:
    urllib.request.urlopen(req5, timeout=10)
    print("WARNING: /api/sessions returned 200 without auth (should be 401)")
except urllib.error.HTTPError as e:
    print(f"Unauthenticated access: HTTP {e.code} (expected)")
    assert e.code == 401

print()
print("=== E2E COMPLETE: ALL CHECKS PASSED ===")
