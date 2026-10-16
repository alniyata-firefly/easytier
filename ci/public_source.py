#!/usr/bin/env python3
"""Reject local deployment material in the current tracked public source tree.

This is a conservative publication gate, not a general secret-discovery service:
it checks tracked working-tree files (including unstaged edits), not Git history,
untracked files or arbitrary encrypted/encoded credentials. Findings contain only
the repository-relative path and a rule identifier, never matching content.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess


# These five public upstream fixtures were individually compared, byte-for-byte,
# with this baseline. A path alone is never a waiver for replacement credentials.
UPSTREAM_BASELINE = "8b7f1f0196edb5b580829ed5f135050fb5853478"
UPSTREAM_FIXTURES = {
    "easytier-gui/src-tauri/gen/android/app/upload-keystore.jks":
        "8b7bcc904fb23813b7ea16fbdd4ebecadce925060dd17401b94203e2deeb6aad",
    "easytier-gui/src-tauri/gen/android/keystore.properties":
        "a993435e3e5037b0a4d7449c565ba95fd8569a6fa0821f2a2f077ec57e4255b0",
    "easytier-contrib/easytier-uptime/.env":
        "f0db29b0a8aebfe74c5b6b8238fe8caf46757ceeb5e9822c0ba4755408db8b5a",
    "easytier-contrib/easytier-uptime/.env.development":
        "f0db29b0a8aebfe74c5b6b8238fe8caf46757ceeb5e9822c0ba4755408db8b5a",
    "easytier-contrib/easytier-uptime/.env.production":
        "06630d1282687b06abed8aee460ca555cc872ba8a915c008c440b0590a3a08fa",
}

# Source modules legitimately named runtime/build are not deployment directories.
# Runtime state at repository root is forbidden; generated caches are forbidden
# at every depth. In particular, keep easytier-js/runtime and proto/build usable.
LOCAL_ROOTS = {"private", "runtime", "artifacts", "release-assets", "downloaded-packages",
               "downloaded-web", "data", "logs", "backups", "root-target"}
GENERATED_PARTS = {"private", "node_modules", "dist", "target", "__pycache__", ".venv", "venv",
                   ".gradle", ".pnpm-store", ".cache", "test-results", "playwright-report",
                   ".ssh", ".aws", ".kube", ".terraform"}
PRIVATE_SUFFIXES = {".jks", ".keystore", ".p12", ".pfx", ".p8", ".db", ".sqlite", ".sqlite3",
                    ".har", ".log", ".pyc", ".pyo", ".bak", ".orig"}
BUILD_SUFFIXES = {".apk", ".aab", ".exe", ".msi", ".dmg", ".deb", ".rpm", ".so", ".dylib",
                  ".dll", ".a", ".o", ".obj", ".pdb", ".wasm", ".jar", ".zip", ".7z",
                  ".tar", ".gz", ".bz2", ".xz"}
# Upstream build inputs are dependencies, rather than our release outputs. This
# exemption affects the binary/output suffix rule only; content rules still run.
VENDORED_INPUTS = {
    "easytier-contrib/easytier-ohrs/ohpm_crypto.zip",
    "easytier-go/internal/artifact/easytier_core.wasm",
    "easytier-go/testdata/wasi_socket_guest.wasm",
    "easytier-gui/src-tauri/gen/android/gradle/wrapper/gradle-wrapper.jar",
    *{f"easytier/third_party/{arch}/{name}.dll" for arch in ("arm64", "i686", "x86_64")
      for name in ("Packet", "wintun")},
}
SIGNING_PROPERTIES = {"keystore.properties", "signing.properties", "release.properties",
                      "android-release.properties"}
SSH_PRIVATE_NAMES = {"id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "id_ecdsa_sk", "id_ed25519_sk"}
ENV_FILE = re.compile(r"\.env(?:\.|$)", re.I)

# Require a complete plausible block, rather than a header mentioned in docs or
# in a scanner's own source. Public certificates and PUBLIC KEY blocks are safe.
PRIVATE_KEY = re.compile(
    rb"-----BEGIN (?P<kind>(?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY)-----"
    rb"[A-Za-z0-9+/=:\r\n\t ,\-]{64,}-----END (?P=kind)-----"
)
PUBLIC_PEM = re.compile(rb"-----BEGIN (?:RSA PUBLIC KEY|PUBLIC KEY|CERTIFICATE|X509 CRL)-----")
PUBLIC_SSH = re.compile(rb"^(?:ssh-(?:rsa|ed25519)|ecdsa-sha2-[^ ]+|sk-ssh-ed25519@openssh.com) [A-Za-z0-9+/=]+(?: |\r?$)", re.M)
WIREGUARD_PRIVATE = re.compile(
    rb"(?mi)^[ \t]*(?:PrivateKey|PresharedKey)[ \t]*=[ \t]*[A-Za-z0-9+/]{43}=[ \t]*(?:[#;][^\r\n]*)?$"
)
ENROLLMENT_TOKEN_URL = re.compile(
    rb"\b(?:udp|tcp|ws|wss)://(?:[A-Za-z0-9._-]+|\[[0-9A-Fa-f:]+\]):[0-9]{1,5}/[A-Za-z0-9_-]{30,}(?![A-Za-z0-9_-])"
)
PROVIDER_TOKEN = re.compile(
    rb"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[baprs]-[A-Za-z0-9-]{20,})\b"
)
SIGNED_JWT = re.compile(rb"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{16,}\b")


def path_rules(relative: str) -> list[str]:
    path = PurePosixPath(relative)
    parts = tuple(part.lower() for part in path.parts)
    rules = []
    if (not parts or path.is_absolute() or ".." in parts or "\\" in relative
            or path.as_posix() != relative):
        return ["unsafe-tracked-path"]
    if (parts[0] in LOCAL_ROOTS or any(part in GENERATED_PARTS or part.startswith("target-")
                                      for part in parts[:-1])):
        rules.append("local-or-generated-directory")
    name = parts[-1]
    if ENV_FILE.search(name) and not name.endswith((".example", ".sample", ".template")):
        rules.append("deployment-environment-file")
    if path.suffix.lower() in PRIVATE_SUFFIXES or name.endswith((".db-wal", ".db-shm", ".sqlite-wal", ".sqlite-shm", ".sqlite3-wal", ".sqlite3-shm")):
        rules.append("private-or-runtime-file")
    if name in SIGNING_PROPERTIES or name in SSH_PRIVATE_NAMES or name in {"credentials-defaults.json", ".netrc", "terraform.tfstate"}:
        rules.append("credential-file")
    if relative not in VENDORED_INPUTS and path.suffix.lower() in BUILD_SUFFIXES:
        rules.append("compiled-or-archive-output")
    return rules


def content_rules(relative: str, data: bytes) -> list[str]:
    rules = []
    if PRIVATE_KEY.search(data):
        rules.append("private-key-material")
    if data.startswith(b"SQLite format 3\x00"):
        rules.append("sqlite-database-content")
    if WIREGUARD_PRIVATE.search(data):
        rules.append("wireguard-private-key")
    if ENROLLMENT_TOKEN_URL.search(data):
        rules.append("embedded-enrollment-token")
    if PROVIDER_TOKEN.search(data):
        rules.append("provider-access-token")
    if SIGNED_JWT.search(data):
        rules.append("embedded-signed-token")
    if PurePosixPath(relative).suffix.lower() in {".pem", ".key"} and not (PUBLIC_PEM.search(data) or PUBLIC_SSH.search(data)):
        rules.append("nonpublic-key-file")
    return rules


def scan(root: Path) -> dict:
    root = Path(root).resolve()
    # -z preserves unusual filenames without shell parsing or quoting ambiguity.
    # --stage also detects conflicted index entries and Git submodule contents
    # that would otherwise escape a current-tree file scan.
    result = subprocess.run(["git", "ls-files", "--stage", "-z"], cwd=root,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    if result.returncode:
        raise ValueError("cannot enumerate the tracked source tree")
    findings, checked, allowed = [], set(), []

    def finding(path, rule):
        item = {"path": path, "rule": rule}
        if item not in findings:
            findings.append(item)

    for item in result.stdout.split(b"\0"):
        if not item:
            continue
        metadata, raw = item.split(b"\t", 1)
        relative = os.fsdecode(raw)
        mode, _, stage = metadata.split()
        if stage != b"0":
            finding(relative, "unmerged-index")
        if relative in checked:
            continue
        checked.add(relative)
        rules = path_rules(relative)
        if "unsafe-tracked-path" in rules:
            finding(relative, "unsafe-tracked-path")
            continue
        if mode == b"160000":
            finding(relative, "unscanned-submodule")
            continue
        path = root / relative
        try:
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode):
                # Existing README/LICENSE/assets links stay useful. Never follow
                # an external link or a link into local runtime/signing state.
                target = path.resolve(strict=True)
                if not target.is_relative_to(root) or path_rules(target.relative_to(root).as_posix()):
                    finding(relative, "unsafe-symlink")
                for rule in rules:
                    finding(relative, rule)
                continue
            if not path.resolve().is_relative_to(root) or not stat.S_ISREG(info.st_mode):
                finding(relative, "unsafe-tracked-file")
                continue
            data = path.read_bytes()
        except OSError:
            finding(relative, "unreadable-tracked-file")
            continue
        if relative in UPSTREAM_FIXTURES:
            if hashlib.sha256(data).hexdigest() == UPSTREAM_FIXTURES[relative]:
                allowed.append(relative)
            else:
                finding(relative, "changed-upstream-fixture")
            continue
        for rule in [*rules, *content_rules(relative, data)]:
            finding(relative, rule)
    return {"status": "FAIL" if findings else "PASS", "scope": "current-tracked-working-tree",
            "files_checked": len(checked), "upstream_fixture_baseline": UPSTREAM_BASELINE,
            "unchanged_upstream_fixtures": sorted(allowed),
            "findings": sorted(findings, key=lambda item: (item["path"], item["rule"]))}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    try:
        report = scan(args.source)
    except (OSError, ValueError):
        # Neither git stderr nor filesystem exception text belongs in a public
        # CI log: it may contain credential-bearing filenames or local paths.
        print(json.dumps({"status": "FAIL", "rule": "source-scan-unavailable"}))
        return 1
    print(json.dumps(report, indent=2, ensure_ascii=True))
    return int(report["status"] != "PASS")


if __name__ == "__main__":
    raise SystemExit(main())
