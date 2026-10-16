"""Freeze all frontend files and verify their real Tauri native payloads."""
from __future__ import annotations

import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import subprocess

from public_assets import validate_frontend_tree


class Head(HTMLParser):
    def __init__(self):
        super().__init__()
        self.entries = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "script" and attrs.get("type") == "module":
            self.entries.append(attrs["src"].lstrip("/"))
        if tag == "link" and attrs.get("rel") == "stylesheet":
            self.entries.append(attrs["href"].lstrip("/"))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def freeze_frontend(dist):
    dist = Path(dist).resolve()
    validate_frontend_tree(dist)
    head = Head()
    head.feed((dist / "index.html").read_text(encoding="utf-8"))
    if not head.entries or not all((dist / name).is_file() for name in head.entries):
        raise RuntimeError("React entry modules or styles are missing")
    files = []
    for path in sorted(dist.rglob("*")):
        if path.is_symlink():
            raise RuntimeError("Frontend assets must not be symlinks")
        if path.is_file():
            files.append({"path": path.relative_to(dist).as_posix(), "bytes": path.stat().st_size,
                          "sha256": sha(path)})
    if not any(item["path"] == "fonts/font-notices.html" for item in files):
        raise RuntimeError("Font license page is missing")
    return {"frontend_files": files, "entry_assets": head.entries}


def verify_native_assets(release, binary, dist, manifest):
    """Require the frozen content, not just filenames, in the actual binary.

    The codegen directory alone is insufficient: each encoded resource must also
    occur in the binary being shipped. Tauri injects a CSP into index.html, so
    verify its embedded entry references and every other file's exact content.
    """
    dist = Path(dist).resolve()
    current = freeze_frontend(dist)
    if current != {key: manifest[key] for key in ("frontend_files", "entry_assets")}:
        raise RuntimeError("Frozen frontend changed after the input freeze")
    helper = Path(__file__).with_name("gui") / "decode-assets.mjs"
    # Node writes JSON as UTF-8, including the full multilingual font notices.
    # Windows Python otherwise selects cp1252 and its reader thread can fail.
    result = subprocess.run(["node", str(helper), str(release)], capture_output=True,
                            text=True, encoding="utf-8", errors="strict")
    if result.returncode:
        raise RuntimeError("Native frontend resource decoding failed")
    records = json.loads(result.stdout)
    decoded, html = {}, []
    for item in records:
        encoded = Path(item["file"]).read_bytes()
        if not encoded or encoded not in binary:
            continue
        decoded[item["decoded_sha256"]] = {
            "encoding": item["encoding"], "encoded_bytes": len(encoded),
            "encoded_sha256": hashlib.sha256(encoded).hexdigest(),
        }
        if item["html"] is not None:
            html.append(item["html"])
    checks = []
    for item in manifest["frontend_files"]:
        if item["path"] == "index.html":
            continue
        if item["sha256"] not in decoded:
            raise RuntimeError("Fresh frontend content is absent from the native binary: " + item["path"])
        checks.append({"path": item["path"], "sha256": item["sha256"], **decoded[item["sha256"]]})
    if not any(all("/" + entry in text for entry in manifest["entry_assets"]) for text in html):
        raise RuntimeError("Embedded entry HTML does not reference the frozen React modules/styles")
    if b"fonts/font-notices.html" not in binary:
        raise RuntimeError("Embedded font license page is missing its runtime route")
    return {"non_entry_assets_verified": len(checks), "entry_html_verified": True,
            "font_notice_full_html_verified": True, "assets": checks}
