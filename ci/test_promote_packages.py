"""Exercise actual package validation and stateful release refusal/recovery."""
import copy
import hashlib
import json
from pathlib import Path
import re
import tempfile
import unittest

import promote_packages as promote

COMMIT = "1ec2b559205d3df15669c0b63270fbedd89f81d3"
RUN = 38998168675
REPO = "example/easytier"
TAG = "fix-2.7.2-test"


class FakeGitHub:
    def __init__(self):
        self.run = {"id": RUN, "head_sha": COMMIT, "status": "completed", "conclusion": "success",
                    "path": ".github/workflows/packages.yml", "repository": {"id": 5, "full_name": REPO}, "head_repository": {"id": 5}}
        self.artifact = {"id": 6, "name": "release-packages", "expired": False, "size_in_bytes": 100,
                         "digest": "sha256:" + "a" * 64,
                         "workflow_run": {"id": RUN, "head_sha": COMMIT, "repository_id": 5, "head_repository_id": 5}}
        self.tag_commit = COMMIT
        self.release = None
        self.assets = {}
        self.writes = []
        self.uploaded = []
        self.fail_upload_at = None
        self.corrupt_upload = False

    def request(self, method, endpoint, payload=None, optional=False):
        if method != "GET":
            self.writes.append((method, endpoint))
        if endpoint == f"actions/runs/{RUN}":
            return copy.deepcopy(self.run)
        if endpoint.startswith(f"actions/runs/{RUN}/artifacts?"):
            return {"artifacts": [copy.deepcopy(self.artifact)]}
        if endpoint == "git/ref/tags/" + TAG:
            return {"ref": "refs/tags/" + TAG, "object": {"type": "commit", "sha": self.tag_commit}}
        if endpoint == "releases/tags/" + TAG:
            if self.release is not None and self.release.get("draft"):
                return None
            return copy.deepcopy(self.release)
        if endpoint.startswith("releases?per_page=100&page="):
            return [copy.deepcopy(self.release)] if self.release else []
        if method == "POST" and endpoint == "releases":
            self.release = {"id": 7, **payload}
            return copy.deepcopy(self.release)
        if endpoint == "releases/7/assets?per_page=100":
            return copy.deepcopy(list(self.assets.values()))
        if method == "DELETE" and endpoint.startswith("releases/assets/"):
            asset_id = int(endpoint.rsplit("/", 1)[1])
            self.assets = {name: asset for name, asset in self.assets.items() if asset["id"] != asset_id}
            return None
        if method == "PATCH" and endpoint == "releases/7":
            self.release.update(payload)
            return copy.deepcopy(self.release)
        raise AssertionError(f"Unexpected test API operation: {method} {endpoint}")

    def upload(self, release_id, path):
        if self.fail_upload_at is not None and len(self.uploaded) == self.fail_upload_at:
            self.fail_upload_at = None
            raise promote.Refused("Synthetic interrupted upload")
        self.uploaded.append(path.name)
        asset = {"id": len(self.uploaded) + 100, "name": path.name, "state": "uploaded",
                 "size": path.stat().st_size, "digest": "sha256:" + promote.digest(path)}
        if self.corrupt_upload:
            asset["digest"] = "sha256:" + "0" * 64
        self.assets[path.name] = asset
        return copy.deepcopy(asset)


class PromotionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        records = []
        for name in sorted(promote.expected_names(COMMIT)):
            payload = ("synthetic package content: " + name).encode()
            (self.root / name).write_bytes(payload)
            records.append({"path": name, "bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()})
        self.manifest = {"source_commit": COMMIT, "version": promote.VERSION, "platform": "release",
                         "platforms": sorted(promote.PLATFORMS), "files": records}
        self.write_metadata()
        self.api = FakeGitHub()
        self.state = promote.validate_source(self.api, REPO, RUN, COMMIT, TAG)

    def write_metadata(self):
        (self.root / "build-manifest.json").write_text(json.dumps(self.manifest))
        (self.root / "SHA256SUMS").write_text("".join(f"{item['sha256']}  {item['path']}\n" for item in self.manifest["files"]))

    def owned_draft(self):
        title, body = promote.release_text(self.state)
        self.api.release = {"id": 7, "tag_name": TAG, "target_commitish": "main",
                            "name": title, "body": body, "draft": True, "prerelease": False}

    def test_source_binding_and_tag_mismatch_refuse_without_writes(self):
        for mutate in [lambda api: api.run.update(conclusion="failure"),
                       lambda api: api.run.update(path=".github/workflows/other.yml"),
                       lambda api: api.run["head_repository"].update(id=99),
                       lambda api: api.artifact.update(expired=True),
                       lambda api: api.artifact["workflow_run"].update(head_sha="0" * 40),
                       lambda api: setattr(api, "tag_commit", "0" * 40)]:
            with self.subTest(mutate=mutate):
                api = FakeGitHub(); mutate(api)
                with self.assertRaises(promote.Refused):
                    promote.validate_source(api, REPO, RUN, COMMIT, TAG)
                self.assertEqual(api.writes, [])

    def test_actual_bundle_rejects_tamper_unrecorded_files_missing_platform_and_version(self):
        self.assertEqual(len(promote.validate_bundle(self.root, COMMIT)), 14)
        asset = self.root / self.manifest["files"][0]["path"]
        original = asset.read_bytes(); asset.write_bytes(original + b"tamper")
        with self.assertRaises(ValueError): promote.validate_bundle(self.root, COMMIT)
        asset.write_bytes(original)
        extra = self.root / "unexpected.txt"; extra.write_text("unrecorded")
        with self.assertRaises(promote.Refused): promote.validate_bundle(self.root, COMMIT)
        extra.unlink()
        self.manifest["platforms"].pop(); self.write_metadata()
        with self.assertRaises(promote.Refused): promote.validate_bundle(self.root, COMMIT)
        self.manifest["platforms"] = sorted(promote.PLATFORMS)
        self.manifest["version"] = "2.7.3"; self.write_metadata()
        with self.assertRaises(ValueError): promote.validate_bundle(self.root, COMMIT)

    def test_interrupted_owned_draft_recovers_without_reuploading_completed_assets(self):
        self.api.fail_upload_at = 2
        with self.assertRaises(promote.Refused): promote.promote(self.api, self.root, self.state)
        self.assertTrue(self.api.release["draft"])
        completed = self.api.uploaded.copy()
        remaining = next(name for name in promote.validate_bundle(self.root, COMMIT) if name not in self.api.assets)
        self.api.assets[remaining] = {"id": 999, "name": remaining, "state": "starter", "size": 0, "digest": None}
        result = promote.promote(self.api, self.root, self.state)
        self.assertTrue(result["passed"])
        self.assertEqual(result["asset_count"], 14)
        self.assertFalse(self.api.release["draft"])
        self.assertEqual(self.api.release["make_latest"], "true")
        self.assertIn(("DELETE", "releases/assets/999"), self.api.writes)
        self.assertTrue(all(self.api.uploaded.count(name) == 1 for name in completed))
        writes = self.api.writes.copy(); uploaded = self.api.uploaded.copy()
        self.assertTrue(promote.promote(self.api, self.root, self.state)["passed"])
        self.assertEqual(self.api.writes, writes)
        self.assertEqual(self.api.uploaded, uploaded)

    def test_unowned_release_or_mismatched_existing_asset_refuses_without_writes(self):
        self.owned_draft(); self.api.release["body"] = "another publisher"
        with self.assertRaises(promote.Refused): promote.promote(self.api, self.root, self.state)
        self.assertEqual(self.api.writes, [])
        self.owned_draft()
        name = next(iter(promote.validate_bundle(self.root, COMMIT)))
        self.api.assets[name] = {"id": 8, "name": name, "state": "uploaded", "size": 5, "digest": "sha256:" + "0" * 64}
        with self.assertRaises(promote.Refused): promote.promote(self.api, self.root, self.state)
        self.assertEqual(self.api.writes, [])
        self.assertEqual(self.api.uploaded, [])

    def test_wrong_remote_digest_never_exposes_the_draft(self):
        self.api.corrupt_upload = True
        with self.assertRaises(promote.Refused): promote.promote(self.api, self.root, self.state)
        self.assertTrue(self.api.release["draft"])
        self.assertFalse(any(method == "PATCH" for method, _ in self.api.writes))

    def test_workflow_is_manual_only_pinned_and_never_builds_or_moves_version_tags(self):
        workflow = (Path(__file__).resolve().parents[1] / ".github/workflows/publish-existing.yml").read_text()
        self.assertIn("on:\n  workflow_dispatch:", workflow)
        self.assertNotRegex(workflow, r"(?m)^  (push|pull_request|workflow_run):")
        self.assertNotRegex(workflow, r"(?i)\b(cargo|rustup|pnpm|npm|cmake)\b")
        self.assertIn("  actions: read\n  contents: write", workflow)
        self.assertIn("run-id: ${{ inputs.source-run-id }}", workflow)
        self.assertIn("github-token: ${{ github.token }}", workflow)
        for action in re.findall(r"uses: ([^\s]+)", workflow):
            self.assertRegex(action, r"^actions/(checkout|download-artifact)@[0-9a-f]{40}$")
        for tag in ["v2.7.2", "../fix-invalid", "fix-;echo-invalid"]:
            with self.assertRaises(promote.Refused): promote.validate_inputs(REPO, RUN, COMMIT, tag)


if __name__ == "__main__":
    unittest.main()
