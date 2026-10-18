"""Metadata-only maintenance for the fixed 2.7.2 release family."""
import json
import os
import re
import sys
import urllib.error
import urllib.request

REPOSITORY = "alniyata-firefly/easytier"
TAG = re.compile(r"(?:v2\.7\.2(?:[-+][A-Za-z0-9][A-Za-z0-9._+-]*)?|fix-2\.7\.2-[A-Za-z0-9][A-Za-z0-9._+-]*)", re.ASCII)
PATCH = {"prerelease": True, "make_latest": "false"}
UNCHANGED = ("id", "tag_name", "name", "body", "draft", "target_commitish", "published_at")
ASSET_FIELDS = ("id", "name", "size", "digest", "state", "label", "created_at", "updated_at")


class Refused(RuntimeError):
    pass


def matches(tag):
    return isinstance(tag, str) and TAG.fullmatch(tag) is not None


class GitHub:
    def __init__(self, token):
        self.token = token

    def request(self, method, endpoint, payload=None):
        if method not in {"GET", "PATCH"}:
            raise Refused("Only read operations and release metadata PATCH are allowed")
        if method == "PATCH" and (not re.fullmatch(r"releases/[0-9]+", endpoint) or payload != PATCH):
            raise Refused("Refused an unexpected metadata mutation")
        request = urllib.request.Request(
            f"https://api.github.com/repos/{REPOSITORY}/{endpoint}",
            method=method,
            data=None if payload is None else json.dumps(payload).encode(),
            headers={"Authorization": "Bearer " + self.token,
                     "Accept": "application/vnd.github+json",
                     "Content-Type": "application/json", "User-Agent": "easytier-release-metadata",
                     "X-GitHub-Api-Version": "2022-11-28"},
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            # Do not expose credentials, response bodies or download URLs in logs.
            raise Refused(f"GitHub API returned HTTP {error.code}") from None
        except urllib.error.URLError:
            raise Refused("GitHub API connection failed") from None


def pages(api, endpoint):
    result = []
    for page in range(1, 101):
        batch = api.request("GET", f"{endpoint}?per_page=100&page={page}")
        if not isinstance(batch, list):
            raise Refused("Unexpected GitHub list response")
        result.extend(batch)
        if len(batch) < 100:
            return result
    raise Refused("GitHub pagination exceeded the safety limit")


def asset_snapshot(api, release_id):
    assets = pages(api, f"releases/{release_id}/assets")
    snapshot = [{key: asset.get(key) for key in ASSET_FIELDS} for asset in assets]
    if any(type(asset["id"]) is not int for asset in snapshot):
        raise Refused("Missing asset identity")
    if len({asset["id"] for asset in snapshot}) != len(snapshot):
        raise Refused("Duplicate asset identity")
    return sorted(snapshot, key=lambda asset: asset["id"])


def mark_prereleases(api):
    releases = pages(api, "releases")
    selected = [release for release in releases if matches(release.get("tag_name")) and release.get("draft") is False]
    if not selected:
        raise Refused("No existing public 2.7.2 releases found")
    report = []
    for listed in selected:
        release_id = listed.get("id")
        if type(release_id) is not int:
            raise Refused("Missing release identity")
        endpoint = f"releases/{release_id}"
        before = api.request("GET", endpoint)
        if before.get("id") != release_id or before.get("tag_name") != listed["tag_name"] or before.get("draft") is not False:
            raise Refused("Release identity or visibility changed before update")
        assets = asset_snapshot(api, release_id)
        api.request("PATCH", endpoint, PATCH.copy())
        after = api.request("GET", endpoint)
        if any(after.get(key) != before.get(key) for key in UNCHANGED):
            raise Refused(f"Release {release_id}: immutable metadata changed")
        if after.get("prerelease") is not True:
            raise Refused(f"Release {release_id}: prerelease flag not applied")
        if asset_snapshot(api, release_id) != assets:
            raise Refused(f"Release {release_id}: assets changed during metadata update")
        report.append({"id": release_id, "tag": after["tag_name"], "name": after.get("name"),
                       "prerelease": True, "draft": after["draft"], "asset_count": len(assets),
                       "asset_ids": [asset["id"] for asset in assets], "metadata_and_assets_preserved": True})
    return report


def main():
    if (os.environ.get("GITHUB_EVENT_NAME") != "workflow_dispatch"
            or os.environ.get("GITHUB_REF") != "refs/heads/main"
            or os.environ.get("GITHUB_REPOSITORY") != REPOSITORY):
        raise Refused("Run only via the manual workflow on this repository's main branch")
    token = os.environ.get("GITHUB_TOKEN", "")
    if not token:
        raise Refused("GITHUB_TOKEN is required")
    print(json.dumps(mark_prereleases(GitHub(token)), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Refused as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
