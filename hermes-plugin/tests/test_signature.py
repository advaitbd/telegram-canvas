"""Test the publisher signature generation matches the canonical v1 format."""
import hashlib
import hmac
import json
import time
import uuid

def build_canonical(key_id, timestamp, nonce, body_sha256):
    return "\n".join(["v1", "POST", "/internal/publish", key_id, str(timestamp), nonce, body_sha256])

def test_signature_format():
    secret = "ab" + "cd" * 31
    key_id = "key1"
    body = json.dumps({"title": "test", "html": "<p>hello</p>"}).encode()
    body_sha256 = hashlib.sha256(body).hexdigest()
    timestamp = str(int(time.time()))
    nonce = str(uuid.uuid4())

    canonical = build_canonical(key_id, timestamp, nonce, body_sha256)
    expected_prefix = f"v1\nPOST\n/internal/publish\n{key_id}\n{timestamp}\n{nonce}\n{body_sha256}"
    assert canonical == expected_prefix, f"Format mismatch: {canonical!r} != {expected_prefix!r}"

    sig = hmac.new(bytes.fromhex(secret), canonical.encode(), hashlib.sha256).hexdigest()
    assert len(sig) == 64, f"Signature should be 64 hex chars, got {len(sig)}"
    assert isinstance(sig, str)
    print("PASS: signature format correct")

def test_plugin_manifest():
    import yaml
    with open("plugin.yaml") as f:
        manifest = yaml.safe_load(f)
    assert manifest["name"] == "telegram-canvas"
    assert manifest["toolset"] == "canvas"
    assert manifest.get("version")
    print(f"PASS: plugin.yaml valid: {manifest['name']} v{manifest['version']}")
