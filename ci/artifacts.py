#!/usr/bin/env python3
"""Build and validate portable, commit-bound CI packages using only the stdlib."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import tomllib
from html.parser import HTMLParser

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "easytier-web/frontend/dist"


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def fresh_directory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    if any(path.iterdir()):
        raise ValueError(f"refusing to mix artifacts in a nonempty output directory: {path}")


def source() -> tuple[str, str]:
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    expected = os.environ.get("GITHUB_SHA", commit)
    if commit != expected:
        raise ValueError("checked-out source differs from the workflow commit")
    version = tomllib.loads((ROOT / "easytier/Cargo.toml").read_text())["package"]["version"]
    return commit, version


def safe_file(root: Path, relative: str) -> Path:
    path = PurePosixPath(relative)
    if not path.parts or path.is_absolute() or ".." in path.parts or "\\" in relative or str(path) != relative:
        raise ValueError(f"unsafe artifact path: {relative}")
    result = root.joinpath(*path.parts)
    if result.is_symlink() or not result.resolve().is_relative_to(root.resolve()) or not result.is_file():
        raise ValueError(f"artifact file missing or unsafe: {relative}")
    return result


def file_record(root: Path, path: Path) -> dict:
    return {"path": path.relative_to(root).as_posix(), "bytes": path.stat().st_size, "sha256": sha256(path)}


def validate_manifest(root: Path, manifest: dict, commit: str, version: str) -> list[Path]:
    if manifest.get("source_commit") != commit or manifest.get("version") != version:
        raise ValueError("artifact source commit/version mismatch")
    records = manifest.get("files")
    if not isinstance(records, list) or not records:
        raise ValueError("empty artifact manifest")
    result, seen = [], set()
    for item in records:
        relative = item["path"]
        if relative in seen:
            raise ValueError("duplicate artifact path")
        seen.add(relative)
        path = safe_file(root, relative)
        if sha256(path) != item["sha256"] or path.stat().st_size != item["bytes"]:
            raise ValueError(f"artifact digest/size mismatch: {relative}")
        result.append(path)
    return result


class HeadResources(HTMLParser):
    def __init__(self):
        super().__init__()
        self.entries: list[str] = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        url = attrs.get("src") if tag == "script" and attrs.get("type") == "module" else None
        if tag == "link" and attrs.get("rel") in {"stylesheet", "icon", "apple-touch-icon", "preload"}:
            url = attrs.get("href")
        if url:
            self.entries.append(url.lstrip("/"))


def verify_web() -> dict:
    commit, version = source()
    manifest = json.loads((DIST / "source-manifest.json").read_text())
    validate_manifest(DIST, manifest, commit, version)
    expected = {record["path"] for record in manifest["files"]} | {"source-manifest.json"}
    actual = {path.relative_to(DIST).as_posix() for path in DIST.rglob("*") if path.is_file()}
    if actual != expected or "api_meta.js" in actual:
        raise ValueError("frontend contains unrecorded files or deployment-specific API metadata")
    return manifest


def archive_tree(root: Path, output: Path) -> None:
    epoch = int(subprocess.check_output(["git", "show", "-s", "--format=%ct", "HEAD"], cwd=ROOT, text=True))
    with tarfile.open(output, "w:gz") as archive:
        for path in sorted(root.rglob("*")):
            if not path.is_file():
                continue
            safe_file(root, path.relative_to(root).as_posix())
            info = archive.gettarinfo(path, arcname=path.relative_to(root).as_posix())
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            info.mtime = epoch
            with path.open("rb") as stream:
                archive.addfile(info, stream)


def finish_artifact(output: Path, platform: str, paths: list[Path]) -> dict:
    commit, version = source()
    manifest = {"source_commit": commit, "version": version, "platform": platform,
                "files": [file_record(output, path) for path in paths]}
    write_json(output / "build-manifest.json", manifest)
    (output / "SHA256SUMS").write_text("".join(f"{item['sha256']}  {item['path']}\n" for item in manifest["files"]))
    return manifest


def package_web() -> None:
    commit, version = source()
    if not (DIST / "index.html").is_file() or not (DIST / "config-generator/index.html").is_file():
        raise ValueError("build both the Web and config generator first")
    # api_meta.js is served dynamically by the backend and must come from the target deployment.
    (DIST / "api_meta.js").unlink(missing_ok=True)
    (DIST / "source-manifest.json").unlink(missing_ok=True)
    head = HeadResources()
    head.feed((DIST / "index.html").read_text())
    if len(head.entries) < 4:
        raise ValueError("frontend is missing its entry, stylesheet, fonts or brand icons")
    for relative in head.entries:
        safe_file(DIST, relative)
    paths = sorted(path for path in DIST.rglob("*") if path.is_file())
    for path in paths:
        safe_file(DIST, path.relative_to(DIST).as_posix())
        if path.suffix.lower() in {".map", ".env", ".db", ".sqlite", ".jks", ".p12", ".pem", ".key", ".log", ".har"}:
            raise ValueError("unexpected private or debug file in the frontend")
    write_json(DIST / "source-manifest.json", {"source_commit": commit, "version": version,
               "platform": "web-static", "files": [file_record(DIST, path) for path in paths]})
    verify_web()
    output = ROOT / "artifacts/web"
    fresh_directory(output)
    package = output / f"easytier-web-static-{version}-{commit[:8]}.tar.gz"
    archive_tree(DIST, package)
    finish_artifact(output, "web-static", [package])
    print(f"Packaged {len(paths)} frontend assets from {commit}")


def restore_web(directory: Path) -> None:
    commit, version = source()
    manifest = json.loads((directory / "build-manifest.json").read_text())
    paths = validate_manifest(directory, manifest, commit, version)
    if manifest.get("platform") != "web-static" or len(paths) != 1 or not paths[0].name.endswith(".tar.gz"):
        raise ValueError("expected exactly one Web static archive")
    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir(parents=True)
    with tarfile.open(paths[0], "r:gz") as archive:
        for member in archive.getmembers():
            relative = PurePosixPath(member.name)
            if not member.isfile() or relative.is_absolute() or ".." in relative.parts or "\\" in member.name:
                raise ValueError("unexpected archive member")
        archive.extractall(DIST, filter="data")
    verify_web()
    print(f"Restored frontend from {commit}")


def package_linux(target: str, arch: str) -> None:
    allowed = {"x86_64": "x86_64-unknown-linux-musl", "aarch64": "aarch64-unknown-linux-musl"}
    if allowed.get(arch) != target:
        raise ValueError("target and architecture disagree")
    commit, version = source()
    verify_web()
    describe = subprocess.check_output(["git", "describe", "--abbrev=8", "--always", "--dirty=~"], cwd=ROOT, text=True).strip()
    if describe.endswith("~"):
        raise ValueError("tracked source changed during the Linux build")
    stage = ROOT / "artifacts/stage" / f"linux-{arch}"
    fresh_directory(stage)
    for name in ("easytier-core", "easytier-cli", "easytier-web"):
        binary = ROOT / "target" / target / "release" / name
        shown = subprocess.check_output([str(binary), "--version"], text=True).strip()
        if shown != f"{name} {version}-{describe}":
            raise ValueError(f"binary source version mismatch: {name}")
        header = subprocess.check_output(["readelf", "-h", str(binary)], text=True)
        machine = "X86-64" if arch == "x86_64" else "AArch64"
        if "ELF64" not in header or machine not in header:
            raise ValueError(f"wrong ELF architecture: {name}")
        linkage = subprocess.check_output(["readelf", "-l", "-d", str(binary)], text=True)
        if "INTERP" in linkage or "(NEEDED)" in linkage:
            raise ValueError(f"Linux package is not static musl: {name}")
        destination = stage / name
        shutil.copy2(binary, destination)
        destination.chmod(0o755)
    shutil.copy2(ROOT / "LICENSE", stage / "LICENSE")
    write_json(stage / "source.json", {"source_commit": commit, "version": version, "target": target})
    output = ROOT / "artifacts" / f"linux-{arch}"
    fresh_directory(output)
    package = output / f"easytier-linux-{arch}-{version}-{commit[:8]}.tar.gz"
    archive_tree(stage, package)
    finish_artifact(output, f"linux-{arch}", [package])
    print(f"Verified static Core, CLI and embedded Web for {arch}")


def collect(directory: Path, output: Path, expected_platforms: list[str]) -> None:
    commit, version = source()
    manifests = sorted(directory.glob("*/build-manifest.json"))
    observed, files = set(), []
    for path in manifests:
        manifest = json.loads(path.read_text())
        platform = manifest.get("platform")
        if platform in observed or platform not in expected_platforms:
            raise ValueError("unexpected or duplicate platform in the release")
        observed.add(platform)
        for artifact in validate_manifest(path.parent, manifest, commit, version):
            if artifact.name in {item.name for item in files}:
                raise ValueError("duplicate release asset name")
            files.append(artifact)
    if observed != set(expected_platforms):
        raise ValueError(f"missing platforms: {sorted(set(expected_platforms) - observed)}")
    fresh_directory(output)
    for artifact in files:
        shutil.copy2(artifact, output / artifact.name)
    release = finish_artifact(output, "release", [output / artifact.name for artifact in files])
    release["platforms"] = sorted(observed)
    write_json(output / "build-manifest.json", release)
    print(f"Verified {len(files)} release assets from {commit}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("web")
    commands.add_parser("verify-web")
    restore = commands.add_parser("restore-web")
    restore.add_argument("--input", type=Path, required=True)
    linux = commands.add_parser("linux")
    linux.add_argument("--target", required=True)
    linux.add_argument("--arch", required=True)
    release = commands.add_parser("collect")
    release.add_argument("--input", type=Path, required=True)
    release.add_argument("--output", type=Path, required=True)
    release.add_argument("--platform", action="append", required=True)
    args = parser.parse_args()
    if args.command == "web":
        package_web()
    elif args.command == "verify-web":
        verify_web()
    elif args.command == "restore-web":
        restore_web(args.input)
    elif args.command == "linux":
        package_linux(args.target, args.arch)
    else:
        collect(args.input, args.output, args.platform)


if __name__ == "__main__":
    main()
