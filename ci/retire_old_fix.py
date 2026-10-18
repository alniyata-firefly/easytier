#!/usr/bin/env python3
"""Retire one superseded release while preserving its tag and verified replacement."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import urllib.error
import urllib.request

from promote_packages import expected_names, release_text

REPO = "alniyata-firefly/easytier"
OLD_ID = 416165641
OLD_TAG = "fix-2.7.2-20261018"
OLD_COMMIT = "1ec2b559205d3df15669c0b63270fbedd89f81d3"
LATEST_ID = 416185746
LATEST_TAG = "fix-2.7.2-android-20261018"
LATEST_COMMIT = "abc526b847f2539d175940c7ba5d65a5dee270e5"
ORIGINAL_TAG = "v2.7.2"
LATEST_ASSETS = {
    "SHA256SUMS": (423, "sha256:67a0c0e1baa1a399f5a3a6f98a2d64e44ec21a81f51661dd70b75403ed09ce85"),
    "build-manifest.json": (893, "sha256:40a379eb9622c1d63ef52044dda3e75e61004915d2dec5b7de4d6832492f6bc1"),
    "easytier-gui-2.7.2-adapted-abc526b8-arm64.apk": (37009924, "sha256:cea3788edb8857782f87154eb390878673253acf8ce54718e62c555ae4ac3f5d"),
    "easytier-gui-2.7.2-adapted-abc526b8-arm64.apk.sha256": (112, "sha256:31567765bddf15bc8bfaff6a1a8f0e1ef9364a45f8824fbe13de8c06a50f60e0"),
    "easytier-web-static-2.7.2-abc526b8.tar.gz": (7033478, "sha256:14b2fb477c248dda65bb288e16626afd2a72758ca6bd1394079bdb369faf9f2e"),
    "verification.json": (106498, "sha256:bd9ada031ec94ea90d8603885de5d2e2a5ff3e22767ab5cd055f0c243f60a31e"),
}
BODY_EDITS = (
    ("保留应用版本 **2.7.2** 的 Android / Web 修复构建；原版本标签及完整平台发布保持不变。",
     "保留应用版本 **2.7.2** 的 Android / Web 修复构建。"),
    ("Linux、Windows、macOS 未重新构建，继续使用此前的[完整平台修复版](https://github.com/alniyata-firefly/easytier/releases/tag/fix-2.7.2-20261018)。",
     "Linux、Windows、macOS 未重新构建；本次补丁未修改这些平台的运行时代码。"),
    ("安装前核对 `SHA256SUMS` 与 `build-manifest.json`。本次发布不修改生产服务或节点，也不替换完整平台的最新发布。",
     "安装前核对 `SHA256SUMS` 与 `build-manifest.json`。本工作流只发布安装包；生产服务或节点的部署另行验收。"),
)


class Refused(Exception):
    pass


def require(condition, message):
    if not condition:
        raise Refused(message)


def bodies():
    title, wanted = release_text({"repository": REPO, "run_id": 39087615977,
                                  "source_commit": LATEST_COMMIT, "tag": LATEST_TAG, "profile": "android-web"})
    original = wanted
    for before, after in BODY_EDITS:
        require(original.count(after) == 1, "Publisher body no longer matches the fixed maintenance operation")
        original = original.replace(after, before, 1)
    return title, original, wanted


def replacement_body(body):
    _, original, wanted = bodies()
    require(body in (original, wanted), "Replacement release body differs; refusing unrelated edits")
    return wanted


def check_operation(method, endpoint, payload):
    if method == "GET":
        require(payload is None, "Read requests cannot contain a payload")
    elif method == "DELETE":
        require(endpoint == f"releases/{OLD_ID}" and payload is None, "Only the fixed old release may be deleted")
    elif method == "PATCH":
        require(endpoint == f"releases/{LATEST_ID}" and payload == {"body": bodies()[2]},
                "Only the exact replacement release body may be patched")
    else:
        raise Refused("Unsupported write operation")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


class GitHub:
    def __init__(self):
        self.token = os.environ.get("GH_TOKEN", "")
        require(bool(self.token), "Missing workflow API token")
        self.opener = urllib.request.build_opener(NoRedirect)

    def request(self, method, endpoint, payload=None, optional=False):
        check_operation(method, endpoint, payload)
        require(not endpoint.startswith("/") and ":" not in endpoint and ".." not in endpoint,
                "Unsafe API endpoint")
        headers = {"Authorization": "Bearer " + self.token, "Accept": "application/vnd.github+json",
                   "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "fixed-release-retirement"}
        data = None if payload is None else json.dumps(payload).encode()
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(f"https://api.github.com/repos/{REPO}/{endpoint}",
                                         data=data, method=method, headers=headers)
        try:
            with self.opener.open(request, timeout=40) as response:
                raw = response.read(4 * 1024 * 1024 + 1)
                require(len(raw) <= 4 * 1024 * 1024, "API response exceeds the bound")
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as error:
            if optional and error.code == 404:
                return None
            raise Refused(f"GitHub operation failed (HTTP {error.code})") from None
        except Refused:
            raise
        except Exception:
            raise Refused("GitHub operation failed; no credentials or response bodies were logged") from None


def assets(api, release_id):
    entries = api.request("GET", f"releases/{release_id}/assets?per_page=100")
    require(isinstance(entries, list) and len(entries) < 100, "Invalid or oversized asset list")
    records = {item["name"]: {key: item.get(key) for key in ("id", "name", "size", "digest", "state")}
               for item in entries}
    require(len(records) == len(entries), "Duplicate release asset names")
    return records


def tag(api, name, commit=None):
    value = api.request("GET", "git/ref/tags/" + name)
    require(value.get("ref") == "refs/tags/" + name, "Unexpected tag identity")
    if commit is not None:
        require(value.get("object", {}).get("type") == "commit" and value["object"].get("sha") == commit,
                "Fixed source tag does not point to the verified commit")
    return value


def latest(api):
    release = api.request("GET", f"releases/{LATEST_ID}")
    require(release.get("id") == LATEST_ID and release.get("tag_name") == LATEST_TAG
            and release.get("draft") is False and release.get("prerelease") is True
            and release.get("name") == bodies()[0], "Verified replacement is not the expected public prerelease")
    replacement_body(release.get("body"))
    reference = tag(api, LATEST_TAG, LATEST_COMMIT)
    records = assets(api, LATEST_ID)
    require(set(records) == set(LATEST_ASSETS), "Replacement asset fileset differs")
    for name, (size, digest) in LATEST_ASSETS.items():
        require(records[name]["state"] == "uploaded" and records[name]["size"] == size
                and records[name]["digest"] == digest, "Replacement asset hash, size or state differs")
    return release, reference, records


def original_snapshot(api):
    release = api.request("GET", "releases/tags/" + ORIGINAL_TAG)
    require(type(release.get("id")) is int and release["id"] not in (OLD_ID, LATEST_ID)
            and release.get("tag_name") == ORIGINAL_TAG, "Original version release is missing or misidentified")
    fields = ("id", "tag_name", "name", "body", "draft", "prerelease", "target_commitish", "updated_at")
    return {key: release.get(key) for key in fields}, assets(api, release["id"]), tag(api, ORIGINAL_TAG)


def old_release(api):
    release = api.request("GET", f"releases/{OLD_ID}", optional=True)
    by_tag = api.request("GET", "releases/tags/" + OLD_TAG, optional=True)
    if release is None:
        require(by_tag is None, "A different release now occupies the retired tag")
        return None
    require(by_tag is not None and by_tag.get("id") == OLD_ID and release.get("id") == OLD_ID
            and release.get("tag_name") == OLD_TAG and by_tag.get("tag_name") == OLD_TAG
            and release.get("draft") is False, "Old release identity differs")
    marker = f"<!-- verified-ci-promotion:{REPO}:38998168675:{OLD_COMMIT}:{OLD_TAG} -->"
    require(marker in release.get("body", ""), "Old release source ownership marker differs")
    records = assets(api, OLD_ID)
    require(set(records) == expected_names(OLD_COMMIT) | {"build-manifest.json", "SHA256SUMS"},
            "Old release does not contain the expected fourteen assets")
    fields = ("id", "tag_name", "name", "body", "draft", "prerelease", "target_commitish", "published_at")
    return {key: release.get(key) for key in fields} | {"assets": records}


def retire(api, apply=False):
    before, latest_tag, latest_assets = latest(api)
    old_tag = tag(api, OLD_TAG, OLD_COMMIT)
    original = original_snapshot(api)
    old = old_release(api)
    wanted = replacement_body(before["body"])
    if not apply:
        return {"passed": True, "mode": "preflight", "old_release_id": OLD_ID,
                "replacement_release_id": LATEST_ID, "body_update_needed": before["body"] != wanted,
                "old_release_present": old is not None, "writes_performed": False}
    if before["body"] != wanted:
        api.request("PATCH", f"releases/{LATEST_ID}", {"body": wanted})
    current, current_tag, current_assets = latest(api)
    require(current["body"] == wanted and current_tag == latest_tag and current_assets == latest_assets,
            "Replacement changed while updating its release notes")
    require(original_snapshot(api) == original and tag(api, OLD_TAG, OLD_COMMIT) == old_tag,
            "A protected version or tag changed before deletion")
    if old is not None:
        require(old_release(api) == old, "Old release changed before deletion")
        api.request("DELETE", f"releases/{OLD_ID}")
    require(old_release(api) is None, "Retired release remains accessible")
    after, after_tag, after_assets = latest(api)
    require(after["body"] == wanted and after_tag == latest_tag and after_assets == latest_assets,
            "Replacement changed after retirement")
    require(original_snapshot(api) == original and tag(api, OLD_TAG, OLD_COMMIT) == old_tag,
            "A protected version or tag changed after retirement")
    return {"passed": True, "mode": "apply", "retired_release_id": OLD_ID, "old_release_absent": True,
            "already_absent": old is None, "replacement_release_id": LATEST_ID, "replacement_source_commit": LATEST_COMMIT,
            "replacement_asset_count": 6, "replacement_assets_unchanged": True, "replacement_body_matches_publisher": True,
            "replacement_body_sha256": hashlib.sha256(wanted.encode()).hexdigest(),
            "old_tag_preserved": True, "original_version_unchanged": True, "prerelease": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.apply:
        require(os.environ.get("GITHUB_REPOSITORY") == REPO and os.environ.get("GITHUB_REF") == "refs/heads/main"
                and os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch", "Apply requires this repository's manual main workflow")
    result = retire(GitHub(), args.apply)
    if args.output:
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Refused as error:
        print(json.dumps({"passed": False, "error": str(error)}))
        raise SystemExit(1)
    except Exception:
        print(json.dumps({"passed": False, "error": "Fixed release maintenance failed; no credentials or responses logged"}))
        raise SystemExit(1)
