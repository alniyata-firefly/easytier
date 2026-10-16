#!/usr/bin/env python3
"""Install this fork's verified Linux release into a new or empty directory.

Project origin: https://github.com/EasyTier/EasyTier; GNU LGPL v3, see ../LICENSE.
No service, firewall, PATH, configuration or running process is modified.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import sys
import tarfile
import tempfile
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote, urlsplit
from urllib.request import Request, urlopen

REPOSITORY = "alniyata-firefly/easytier"
API = "https://api.github.com/repos/" + REPOSITORY
RELEASES = "https://github.com/" + REPOSITORY + "/releases"
FILES = {"easytier-core", "easytier-cli", "easytier-web", "LICENSE", "source.json"}
TARGETS = {"x86_64": "x86_64-unknown-linux-musl", "aarch64": "aarch64-unknown-linux-musl"}
MAX_DOWNLOAD = 2 * 1024 ** 3


def release_url(version):
    if version == "latest":
        return API + "/releases/latest"
    if not re.fullmatch(r"v?\d+\.\d+\.\d+", version):
        raise ValueError("--version must be latest or a release version such as v2.7.2")
    tag = version if version.startswith("v") else "v" + version
    return API + "/releases/tags/" + quote(tag, safe="")


def get_release(version):
    request = Request(release_url(version), headers={"User-Agent": "EasyTier-Fork-Installer",
                                                    "Accept": "application/vnd.github+json"})
    try:
        with urlopen(request, timeout=30) as response:
            payload = response.read(5 * 1024 ** 2 + 1)
        if len(payload) > 5 * 1024 ** 2:
            raise ValueError("GitHub release response is unexpectedly large")
        return json.loads(payload)
    except HTTPError as error:
        if error.code == 404:
            raise ValueError("No published release found for this fork/version. See " + RELEASES
                             + "; this installer never falls back to upstream.") from None
        raise ValueError("GitHub release request failed (HTTP " + str(error.code) + ")") from None


def asset_url(asset, tag):
    url = asset.get("browser_download_url", "")
    parsed = urlsplit(url)
    expected = "/" + REPOSITORY + "/releases/download/" + tag + "/" + asset["name"]
    if (parsed.scheme != "https" or parsed.netloc.lower() != "github.com"
            or unquote(parsed.path) != expected or parsed.query or parsed.fragment):
        raise ValueError("Release asset does not belong to this fork")
    return url


def select_assets(release, arch):
    if not isinstance(release, dict) or release.get("draft") is not False or release.get("prerelease") is not False:
        raise ValueError("A published stable release is required; draft/prerelease packages are not installed")
    tag = release.get("tag_name", "")
    if not re.fullmatch(r"v\d+\.\d+\.\d+", tag):
        raise ValueError("Release tag must be a version such as v2.7.2")
    version = tag[1:]
    pattern = re.compile(r"easytier-linux-" + re.escape(arch) + "-" + re.escape(version) + r"-([0-9a-f]{8})\.tar\.gz")
    assets = release.get("assets", [])
    packages = [item for item in assets if pattern.fullmatch(item.get("name", ""))]
    checksums = [item for item in assets if item.get("name") == "SHA256SUMS"]
    if len(packages) != 1 or len(checksums) != 1:
        raise ValueError("Release must contain exactly one Linux " + arch + " archive and SHA256SUMS")
    package = packages[0]
    commit = pattern.fullmatch(package["name"]).group(1)
    return package, checksums[0], version, commit


def download(url, destination, limit=MAX_DOWNLOAD):
    request = Request(url, headers={"User-Agent": "EasyTier-Fork-Installer"})
    with urlopen(request, timeout=60) as response, destination.open("xb") as output:
        count = 0
        while True:
            block = response.read(1024 * 1024)
            if not block:
                break
            count += len(block)
            if count > limit:
                raise ValueError("Release download exceeds the size limit")
            output.write(block)


def expected_checksum(text, filename):
    matches = []
    for line in text.splitlines():
        match = re.fullmatch(r"([0-9A-Fa-f]{64}) [ *](.+)", line)
        if match and match.group(2) == filename:
            matches.append(match.group(1).lower())
    if len(matches) != 1:
        raise ValueError("SHA256SUMS must contain exactly one entry for the selected archive")
    return matches[0]


def sha256(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def require_empty(directory):
    if directory.is_symlink() or (directory.exists() and (not directory.is_dir() or any(directory.iterdir()))):
        raise ValueError("Destination must be new or empty. Use a separate directory for upgrades; existing data is never replaced.")


def unpack(package, directory, version, commit, arch):
    with tarfile.open(package, "r:gz") as archive:
        members, names, total = [], set(), 0
        for item in archive:
            if item.name not in FILES or item.name in names:
                raise ValueError("Archive contains duplicate, missing or unexpected paths")
            names.add(item.name)
            limit = 512 * 1024 ** 2 if item.name.startswith("easytier-") else 1024 ** 2
            if item.type not in (tarfile.REGTYPE, tarfile.AREGTYPE) or item.sparse is not None or not 0 <= item.size <= limit:
                raise ValueError("Archive must contain only the expected ordinary files")
            total += item.size
            members.append(item)
        if names != FILES:
            raise ValueError("Archive contains duplicate, missing or unexpected paths")
        if total > 1537 * 1024 ** 2:
            raise ValueError("Unpacked release is unexpectedly large")
        directory.mkdir()
        for item in members:
            target = directory / item.name
            with archive.extractfile(item) as source, target.open("xb") as output:
                shutil.copyfileobj(source, output)
            target.chmod(0o755 if item.name.startswith("easytier-") else 0o644)
    source = json.loads((directory / "source.json").read_text(encoding="utf-8"))
    if not isinstance(source, dict):
        raise ValueError("Archive source identity is invalid")
    full_commit = source.get("source_commit", "")
    if (not re.fullmatch(r"[0-9a-f]{40}", full_commit) or not full_commit.startswith(commit)
            or source.get("version") != version or source.get("target") != TARGETS[arch]):
        raise ValueError("Archive source identity does not match the selected release")


def install_release(release, arch, directory, downloader=download):
    if arch not in TARGETS:
        raise ValueError("Supported Linux architectures: x86_64 and aarch64")
    package, checksums, version, commit = select_assets(release, arch)
    directory = Path(os.path.abspath(os.path.expanduser(str(directory))))
    require_empty(directory)
    directory.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".easytier-download-", dir=directory.parent) as temporary:
        temporary = Path(temporary)
        sums_path = temporary / "SHA256SUMS"
        downloader(asset_url(checksums, release["tag_name"]), sums_path, 5 * 1024 ** 2)
        expected = expected_checksum(sums_path.read_text(encoding="utf-8"), package["name"])
        archive = temporary / package["name"]
        downloader(asset_url(package, release["tag_name"]), archive, MAX_DOWNLOAD)
        if sha256(archive) != expected:
            raise ValueError("SHA256 verification failed; nothing was installed")
        unpacked = temporary / "unpacked"
        unpack(archive, unpacked, version, commit, arch)
        require_empty(directory)
        # Atomic directory rename replaces at most an empty directory, never
        # existing files or a running executable. No binaries are executed here.
        os.rename(unpacked, directory)
    return directory


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", default="latest", help="latest or a release tag such as v2.7.2")
    parser.add_argument("--directory", type=Path, default=Path.cwd() / "easytier", help="new or empty destination directory")
    args = parser.parse_args(argv)
    if platform.system() != "Linux":
        parser.error("This entry is for Linux; use install.ps1 for Windows GUI downloads")
    machine = platform.machine().lower()
    arch = {"amd64": "x86_64", "arm64": "aarch64"}.get(machine, machine)
    if arch not in TARGETS:
        parser.error("Supported Linux architectures: x86_64 and aarch64")
    require_empty(Path(os.path.abspath(os.path.expanduser(str(args.directory)))))
    directory = install_release(get_release(args.version), arch, args.directory)
    print("Verified release installed in " + str(directory))
    print("Core: " + str(directory / "easytier-core"))
    print("CLI:  " + str(directory / "easytier-cli"))
    print("Web:  " + str(directory / "easytier-web"))
    print("Services and configuration are managed separately. For upgrades, switch to this directory manually.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, URLError, tarfile.TarError) as error:
        print("Error: " + str(error), file=sys.stderr)
        raise SystemExit(1)
