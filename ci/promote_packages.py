#!/usr/bin/env python3
"""Publish existing, verified CI packages without rebuilding or changing a tag."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import urllib.error
import urllib.parse
import urllib.request

from artifacts import validate_manifest

VERSION = "2.7.2"
PLATFORMS = {"android-arm64", "gui-macos-aarch64", "gui-macos-x86_64",
             "gui-windows-x86_64", "linux-aarch64", "linux-x86_64", "web-static"}
PROFILES = {"full": PLATFORMS, "android-web": {"android-arm64", "web-static"}}


class Refused(Exception):
    """Contains only an operator-safe explanation, never a remote response."""


def require(condition, message):
    if not condition:
        raise Refused(message)


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def validate_profile(profile):
    require(isinstance(profile, str) and profile in PROFILES, "Invalid package profile")


def validate_inputs(repo, run_id, commit, tag, profile="full"):
    validate_profile(profile)
    require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo), "Invalid repository")
    require(type(run_id) is int and run_id > 0, "Invalid source run ID")
    require(re.fullmatch(r"[0-9a-f]{40}", commit), "Expected a full source commit SHA")
    require(re.fullmatch(r"fix-[A-Za-z0-9][A-Za-z0-9._-]{0,80}", tag),
            "Only a fix-* tag is allowed; version tags must remain unchanged")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


class GitHub:
    def __init__(self, repo):
        self.repo = repo
        self.token = os.environ.get("GH_TOKEN", "")
        require(bool(self.token), "Missing workflow API token")
        self.opener = urllib.request.build_opener(NoRedirect)

    def _request(self, method, url, payload=None, path=None, optional=False):
        headers = {"Authorization": f"Bearer {self.token}", "Accept": "application/vnd.github+json",
                   "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "verified-package-promotion"}
        body = None if payload is None else json.dumps(payload).encode()
        if payload is not None:
            headers["Content-Type"] = "application/json"
        stream = None
        try:
            if path is not None:
                stream = path.open("rb")
                body = stream
                headers.update({"Content-Type": "application/octet-stream", "Content-Length": str(path.stat().st_size)})
            request = urllib.request.Request(url, data=body, headers=headers, method=method)
            with self.opener.open(request, timeout=180) as response:
                raw = response.read(8 * 1024 * 1024 + 1)
                require(len(raw) <= 8 * 1024 * 1024, "GitHub response exceeds the size bound")
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as error:
            if optional and error.code == 404:
                return None
            raise Refused(f"GitHub operation failed (HTTP {error.code}); draft can be resumed safely") from None
        except Refused:
            raise
        except Exception:
            raise Refused("GitHub operation failed; credentials and remote responses were not logged") from None
        finally:
            if stream is not None:
                stream.close()

    def request(self, method, endpoint, payload=None, optional=False):
        return self._request(method, f"https://api.github.com/repos/{self.repo}/{endpoint}", payload, optional=optional)

    def upload(self, release_id, path):
        url = f"https://uploads.github.com/repos/{self.repo}/releases/{release_id}/assets?name={urllib.parse.quote(path.name)}"
        return self._request("POST", url, path=path)


def validate_source(api, repo, run_id, commit, tag, profile="full"):
    validate_inputs(repo, run_id, commit, tag, profile)
    run = api.request("GET", f"actions/runs/{run_id}")
    repository = run.get("repository", {})
    require(run.get("id") == run_id and run.get("head_sha") == commit
            and run.get("status") == "completed" and run.get("conclusion") == "success"
            and run.get("path") == ".github/workflows/packages.yml"
            and repository.get("full_name", "").lower() == repo.lower()
            and type(repository.get("id")) is int
            and run.get("head_repository", {}).get("id") == repository["id"],
            "Source must be a successful packages workflow from this repository and exact commit")
    artifacts = []
    for page in range(1, 11):
        response = api.request("GET", f"actions/runs/{run_id}/artifacts?per_page=100&page={page}")
        entries = response.get("artifacts")
        require(isinstance(entries, list), "Invalid source artifact listing")
        artifacts.extend(item for item in entries if item.get("name") == "release-packages")
        if len(entries) < 100:
            break
    else:
        raise Refused("Source artifact listing exceeds the size bound")
    require(len(artifacts) == 1, "Expected exactly one release-packages artifact")
    artifact = artifacts[0]
    binding = artifact.get("workflow_run", {})
    require(type(artifact.get("id")) is int and artifact["id"] > 0
            and artifact.get("expired") is False and artifact.get("size_in_bytes", 0) > 0
            and re.fullmatch(r"sha256:[0-9a-f]{64}", artifact.get("digest", ""))
            and binding.get("id") == run_id and binding.get("head_sha") == commit
            and binding.get("repository_id") == repository["id"]
            and binding.get("head_repository_id") == repository["id"],
            "Artifact is expired, invalid or not bound to the approved source run")
    check_tag(api, tag, commit)
    return {"repository": repo, "run_id": run_id, "source_commit": commit, "version": VERSION, "tag": tag, "profile": profile,
            "artifact_id": artifact["id"], "artifact_digest": artifact["digest"], "artifact_bytes": artifact["size_in_bytes"]}


def check_tag(api, tag, commit):
    reference = api.request("GET", "git/ref/tags/" + urllib.parse.quote(tag, safe=""))
    require(reference.get("ref") == "refs/tags/" + tag, "Remote tag differs")
    target = reference.get("object", {})
    for _ in range(4):
        if target.get("type") == "commit":
            break
        require(target.get("type") == "tag" and re.fullmatch(r"[0-9a-f]{40}", target.get("sha", "")), "Invalid remote tag object")
        target = api.request("GET", "git/tags/" + target["sha"]).get("object", {})
    require(target.get("type") == "commit" and target.get("sha") == commit,
            "Remote tag does not resolve to the approved commit; refusing to move it")


def expected_names(commit, profile="full"):
    validate_profile(profile)
    short = commit[:8]
    android_web = {f"easytier-gui-{VERSION}-adapted-{short}-arm64.apk",
                   f"easytier-gui-{VERSION}-adapted-{short}-arm64.apk.sha256", "verification.json",
                   f"easytier-web-static-{VERSION}-{short}.tar.gz"}
    if profile == "android-web":
        return android_web
    return android_web | {
            f"easytier-gui_{VERSION}_aarch64.dmg", f"easytier-gui-{VERSION}-arm64.app.tgz",
            f"easytier-gui_{VERSION}_x64.dmg", f"easytier-gui-{VERSION}-x86_64.app.tgz",
            f"easytier-gui_{VERSION}_x64-setup.exe", f"easytier-gui_{VERSION}_x64_en-US.msi",
            f"easytier-linux-aarch64-{VERSION}-{short}.tar.gz", f"easytier-linux-x86_64-{VERSION}-{short}.tar.gz"}


def validate_bundle(root, commit, profile="full"):
    validate_profile(profile)
    require(root.is_dir() and not root.is_symlink(), "Missing package directory")
    entries = list(root.iterdir())
    require(all(item.is_file() and not item.is_symlink() for item in entries), "Package contains nonregular entries")
    manifest = json.loads((root / "build-manifest.json").read_text())
    require(manifest.get("platform") == "release" and isinstance(manifest.get("platforms"), list)
            and len(manifest["platforms"]) == len(PROFILES[profile]) and set(manifest["platforms"]) == PROFILES[profile],
            "Package platform set differs from the selected profile")
    # Deliberately explicit: checkout HEAD contains this publisher, not the older built source.
    files = validate_manifest(root, manifest, commit, VERSION)
    names = {item.name for item in files}
    require(names == expected_names(commit, profile) and len(files) == len(names), "Missing, duplicate or unexpected original assets")
    require({item.name for item in entries} == names | {"build-manifest.json", "SHA256SUMS"}, "Package has unrecorded files")
    sums = "".join(f"{item['sha256']}  {item['path']}\n" for item in manifest["files"])
    require((root / "SHA256SUMS").read_text() == sums, "SHA256SUMS differs from the original manifest")
    return {item.name: {"name": item.name, "size": item.stat().st_size, "digest": "sha256:" + digest(item)} for item in entries}


def release_text(state):
    profile = state.get("profile", "full")
    validate_profile(profile)
    marker = f"<!-- verified-ci-promotion:{state['repository']}:{state['run_id']}:{state['source_commit']}:{state['tag']} -->"
    if profile == "android-web":
        marker = marker.removesuffix(" -->") + ":android-web -->"
        body = f"""{marker}
保留应用版本 **{VERSION}** 的 Android / Web 修复构建；原版本标签及完整平台发布保持不变。

源码提交：`{state['source_commit']}`。全部原始文件来自成功的 [Actions #{state['run_id']}](https://github.com/{state['repository']}/actions/runs/{state['run_id']})，本次发布不重新编译或重新签名。

- 修复 Android VPN 恢复后残留错误、旧请求错误覆盖新连接状态的问题，并移除 Web 成员行的内部配置版本摘要。
- 仅包含 Android ARM64 APK、对应校验/验证报告及 Web 静态文件。Linux、Windows、macOS 未重新构建，继续使用此前的[完整平台修复版](https://github.com/{state['repository']}/releases/tag/fix-2.7.2-20261018)。
- 已完成 CI 构建及签名/包校验；发布前重新核验每个原始文件与远端 SHA-256。本工作流不执行额外的本机原生测试。
- Android 保留原应用标识、签名及 versionCode `2007003`；同版本替换不会成为递增版本号自动升级。
- **未进行 Android 手机真机测试。** Android 已校验签名、嵌入 Core/前端与 DEX；VPN 恢复仍需在手机上验收。

安装前核对 `SHA256SUMS` 与 `build-manifest.json`。本次发布不修改生产服务或节点，也不替换完整平台的最新发布。
"""
        return f"EasyTier {VERSION} Android / Web 修复版", body
    native_note = ("本次源提交另通过 Linux 本机原生审批、管理日志及隔离 TUN/TCP/UDP/WireGuard 回归。"
                   if state['source_commit'] == '1ec2b559205d3df15669c0b63270fbedd89f81d3'
                   else "本工作流不执行额外的本机原生测试。")
    body = f"""{marker}
保留应用版本 **{VERSION}** 的修复构建；原 `v2.7.2` 标签及发布保持不变。

源码提交：`{state['source_commit']}`。全部原始文件来自成功的 [Actions #{state['run_id']}](https://github.com/{state['repository']}/actions/runs/{state['run_id']})，本次不重新编译或重新签名。

- 修复连接/断开生命周期、管理连接与 VPN 状态区分、重装设备审批和管理连接日志。
- 包含 Linux x64/ARM64 Core、CLI、Web，Windows x64，macOS Intel/Apple Silicon，Android ARM64，以及 Web 静态文件。
- 已完成 CI 构建及签名/包校验；发布前重新核验每个原始文件与远端 SHA-256。{native_note}
- Android 保留原应用标识、签名及 versionCode `2007003`；同版本替换不会成为递增版本号自动升级。
- **未进行 Android 手机或 Windows/macOS GUI 与 VPN 真机测试。** Android 已校验签名、嵌入 Core/前端与 DEX；macOS 为 ad-hoc 签名，未经 Apple 公证。

安装前核对 `SHA256SUMS` 与 `build-manifest.json`。本次发布不修改生产服务或节点。
"""
    return f"EasyTier {VERSION} 修复版", body


def list_assets(api, release_id):
    entries = api.request("GET", f"releases/{release_id}/assets?per_page=100")
    require(isinstance(entries, list) and len(entries) < 100, "Invalid or oversized release asset list")
    result = {item.get("name"): item for item in entries}
    require(len(result) == len(entries), "Duplicate remote release asset names")
    return result


def find_release(api, tag):
    release = api.request("GET", "releases/tags/" + urllib.parse.quote(tag, safe=""), optional=True)
    if release is not None:
        return release
    # The by-tag endpoint is documented for published releases. Authenticated
    # listings also include drafts and are necessary for interrupted promotion.
    matches = []
    for page in range(1, 11):
        entries = api.request("GET", f"releases?per_page=100&page={page}")
        require(isinstance(entries, list), "Invalid release listing")
        matches.extend(item for item in entries if item.get("tag_name") == tag)
        if len(entries) < 100:
            require(len(matches) <= 1, "Multiple releases use the requested tag")
            return matches[0] if matches else None
    raise Refused("Release listing exceeds the size bound")


def verify_asset(asset, record):
    require(all(asset.get(key) == record[key] for key in ["name", "size", "digest"])
            and asset.get("state") == "uploaded", "Remote asset digest, size or state differs; refusing replacement")


def promote(api, root, state):
    profile = state.get("profile")
    records = validate_bundle(root, state["source_commit"], profile)
    require(validate_source(api, state["repository"], state["run_id"], state["source_commit"], state["tag"], profile) == state,
            "Source artifact identity changed after preflight")
    title, body = release_text(state)

    def owned(release):
        require(type(release.get("id")) is int and release["id"] > 0 and release.get("tag_name") == state["tag"]
                and release.get("name") == title and release.get("body") == body
                and release.get("target_commitish") == "main" and release.get("prerelease") is False,
                "Existing release belongs to another publication; refusing modification")

    endpoint = "releases/tags/" + urllib.parse.quote(state["tag"], safe="")
    release = find_release(api, state["tag"])
    if release is None:
        # This field is unused for an existing tag. Keeping its workflow tree at
        # main avoids requesting forbidden Workflows permission for an old SHA.
        # The pre-existing tag, checked before and after uploads, binds the source.
        release = api.request("POST", "releases", {"tag_name": state["tag"], "target_commitish": "main",
                              "name": title, "body": body, "draft": True, "prerelease": False, "make_latest": "false"})
    owned(release)
    release_id = release["id"]
    assets = list_assets(api, release_id)
    require(set(assets) <= set(records), "Release contains extra assets; refusing removal")
    if not release.get("draft"):
        require(set(assets) == set(records), "Published release is incomplete; refusing modification")
    # Check every completed existing asset before making any additional writes.
    for name, asset in assets.items():
        if asset.get("state") == "starter" and asset.get("size") == 0 and asset.get("digest") is None:
            require(release.get("draft") is True and type(asset.get("id")) is int and asset["id"] > 0,
                    "Cannot recover an incomplete asset outside an owned draft")
        else:
            verify_asset(asset, records[name])
    for name, record in records.items():
        existing = assets.get(name)
        if existing is not None and existing.get("state") == "starter":
            api.request("DELETE", f"releases/assets/{existing['id']}")
            existing = None
        if existing is None:
            require(release.get("draft") is True, "Published release cannot accept missing assets")
            verify_asset(api.upload(release_id, root / name), record)
    assets = list_assets(api, release_id)
    require(set(assets) == set(records), "Remote fileset differs after upload")
    for name, record in records.items():
        verify_asset(assets[name], record)
    require(validate_bundle(root, state["source_commit"], profile) == records, "Local files changed during upload")
    require(validate_source(api, state["repository"], state["run_id"], state["source_commit"], state["tag"], profile) == state,
            "Source artifact identity changed during upload")
    current = find_release(api, state["tag"])
    require(current is not None and current.get("id") == release_id and current.get("draft") == release.get("draft"),
            "Release identity or publication state changed during upload")
    owned(current)
    if release.get("draft"):
        release = api.request("PATCH", f"releases/{release_id}",
                              {"draft": False, "make_latest": "true" if profile == "full" else "false"})
    owned(release)
    require(release.get("draft") is False, "Release is not public")
    published = api.request("GET", endpoint)
    owned(published)
    require(published.get("id") == release_id and published.get("draft") is False, "Public release identity changed")
    assets = list_assets(api, release_id)
    require(set(assets) == set(records), "Public release fileset differs")
    for name, record in records.items():
        verify_asset(assets[name], record)
    check_tag(api, state["tag"], state["source_commit"])
    return {"passed": True, "source_commit": state["source_commit"], "version": VERSION, "profile": profile, "asset_count": len(records),
            "release_url": f"https://github.com/{state['repository']}/releases/tag/{state['tag']}"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", type=int, required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--profile", choices=tuple(PROFILES), default="full")
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--input", type=Path)
    parser.add_argument("--publish", action="store_true")
    args = parser.parse_args()
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    validate_inputs(repo, args.run_id, args.commit, args.tag, args.profile)
    api = GitHub(repo)
    if args.publish:
        require(args.input is not None, "Missing downloaded package directory")
        state = json.loads(args.state.read_text())
        require(state == validate_source(api, repo, args.run_id, args.commit, args.tag, args.profile), "Preflight source binding changed")
        print(json.dumps(promote(api, args.input, state)))
    else:
        state = validate_source(api, repo, args.run_id, args.commit, args.tag, args.profile)
        args.state.write_text(json.dumps(state) + "\n")
        print(json.dumps({"passed": True, "mode": "preflight", "artifact_id": state["artifact_id"]}))


if __name__ == "__main__":
    try:
        main()
    except Refused as error:
        print(json.dumps({"passed": False, "error": str(error)}))
        raise SystemExit(1)
    except Exception:
        print(json.dumps({"passed": False, "error": "Promotion failed; no credentials or remote responses were logged"}))
        raise SystemExit(1)
