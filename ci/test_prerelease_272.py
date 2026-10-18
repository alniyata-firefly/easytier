import copy
import os
from pathlib import Path
import unittest
from unittest.mock import patch

import prerelease_272 as metadata


class FakeGitHub:
    def __init__(self):
        self.releases = {1: {"id": 1, "tag_name": "v2.7.2", "name": "Original title", "body": "Original body",
                             "draft": False, "prerelease": False, "published_at": "2026-10-17"},
                         2: {"id": 2, "tag_name": "fix-2.7.2-20261018", "draft": False, "prerelease": True},
                         3: {"id": 3, "tag_name": "v2.7.3", "draft": False, "prerelease": False},
                         4: {"id": 4, "tag_name": "fix-2.7.2-android-web-20261018", "draft": True, "prerelease": False}}
        self.assets = {i: [{"id": i * 100, "name": "original.zip", "size": 99, "digest": "sha256:abc"}] for i in self.releases}
        self.writes = []
        self.corrupt = None

    def request(self, method, endpoint, payload=None):
        if endpoint.startswith("releases?"):
            return copy.deepcopy(list(self.releases.values()))
        release_id = int(endpoint.split("/")[1])
        if "/assets?" in endpoint:
            return copy.deepcopy(self.assets[release_id])
        if method == "PATCH":
            self.writes.append((method, endpoint, copy.deepcopy(payload)))
            self.releases[release_id]["prerelease"] = payload["prerelease"]
            if self.corrupt:
                self.corrupt(self, release_id)
        return copy.deepcopy(self.releases[release_id])


class MetadataTests(unittest.TestCase):
    def test_fixed_version_boundaries(self):
        for tag in ["v2.7.2", "v2.7.2-rc.1", "v2.7.2+build.1", "fix-2.7.2-20261018", "fix-2.7.2-android-web-20261018"]:
            with self.subTest(tag=tag): self.assertTrue(metadata.matches(tag))
        for tag in ["v2.7.20", "v2.7.3", "v2.7.2evil", "fix-2.7.20-a", "fix-2.7.2", "2.7.2", "other-v2.7.2", "v2.7.2\n", "v2.7.2/unsafe", None]:
            with self.subTest(tag=tag): self.assertFalse(metadata.matches(tag))

    def test_only_public_matching_releases_and_exact_patch(self):
        api = FakeGitHub(); original = copy.deepcopy(api.releases); assets = copy.deepcopy(api.assets)
        report = metadata.mark_prereleases(api)
        self.assertEqual([item["id"] for item in report], [1, 2])
        self.assertEqual(api.writes, [("PATCH", "releases/1", {"prerelease": True, "make_latest": "false"}),
                                     ("PATCH", "releases/2", {"prerelease": True, "make_latest": "false"})])
        self.assertEqual(api.assets, assets)
        for release_id, before in original.items():
            self.assertEqual(api.releases[release_id], {**before, **({"prerelease": True} if release_id in {1, 2} else {})})
        self.assertEqual(metadata.mark_prereleases(api), report)

    def test_metadata_or_asset_changes_are_reported_as_failure(self):
        for corrupt in [lambda api, i: api.releases[i].update(body="changed"),
                        lambda api, i: api.releases[i].update(draft=True),
                        lambda api, i: api.releases[i].update(tag_name="v2.7.3"),
                        lambda api, i: api.releases[i].update(prerelease=False),
                        lambda api, i: api.assets[i].clear(),
                        lambda api, i: api.assets[i][0].update(id=999)]:
            with self.subTest(corrupt=corrupt):
                api = FakeGitHub(); api.corrupt = corrupt
                with self.assertRaises(metadata.Refused): metadata.mark_prereleases(api)

    def test_no_matching_public_release_refuses_without_writes(self):
        api = FakeGitHub(); api.releases = {3: api.releases[3], 4: api.releases[4]}
        with self.assertRaises(metadata.Refused): metadata.mark_prereleases(api)
        self.assertEqual(api.writes, [])

    def test_cli_rejects_other_events_branches_and_repositories_without_api_calls(self):
        good = {"GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_REF": "refs/heads/main",
                "GITHUB_REPOSITORY": metadata.REPOSITORY, "GITHUB_TOKEN": "synthetic"}
        for invalid in [{"GITHUB_EVENT_NAME": "push"}, {"GITHUB_REF": "refs/heads/test"},
                        {"GITHUB_REPOSITORY": "other/repository"}, {"GITHUB_TOKEN": ""}]:
            with self.subTest(invalid=invalid), patch.dict(os.environ, {**good, **invalid}, clear=True), patch.object(metadata, "GitHub") as api:
                with self.assertRaises(metadata.Refused): metadata.main()
                api.assert_not_called()

    def test_workflow_is_manual_main_only_and_has_no_build_or_upload(self):
        text = (Path(__file__).resolve().parents[1] / ".github/workflows/prerelease-2.7.2.yml").read_text()
        self.assertIn("on:\n  workflow_dispatch:", text)
        self.assertIn("if: github.ref == 'refs/heads/main'", text)
        self.assertIn("contents: write", text)
        self.assertNotRegex(text, r"(?m)^  (push|pull_request|workflow_run):")
        self.assertNotRegex(text, r"(?i)\b(cargo|rustup|pnpm|npm|upload-artifact|download-artifact)\b")


if __name__ == "__main__":
    unittest.main()
