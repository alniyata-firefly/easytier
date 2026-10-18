"""Focused identity, replacement and mutation tests; no network requests."""
import copy
from pathlib import Path
import re
import unittest
from unittest.mock import patch

import retire_old_fix as retire


class FakeAPI:
    def __init__(self):
        title, original_body, _ = retire.bodies()
        self.latest = {"id": retire.LATEST_ID, "tag_name": retire.LATEST_TAG, "name": title,
                       "body": original_body, "draft": False, "prerelease": True, "target_commitish": "main"}
        self.old = {"id": retire.OLD_ID, "tag_name": retire.OLD_TAG, "draft": False, "prerelease": True,
                    "body": f"<!-- verified-ci-promotion:{retire.REPO}:38998168675:{retire.OLD_COMMIT}:{retire.OLD_TAG} -->"}
        self.original = {"id": 123456, "tag_name": retire.ORIGINAL_TAG, "name": "Original 2.7.2",
                         "body": "Unchanged original notes", "draft": False, "prerelease": True}
        self.tags = {name: {"ref": "refs/tags/" + name, "object": {"type": "commit", "sha": commit}}
                     for name, commit in [(retire.LATEST_TAG, retire.LATEST_COMMIT),
                                          (retire.OLD_TAG, retire.OLD_COMMIT), (retire.ORIGINAL_TAG, "a" * 40)]}
        latest = [{"id": index + 1, "name": name, "size": size, "digest": digest, "state": "uploaded"}
                  for index, (name, (size, digest)) in enumerate(retire.LATEST_ASSETS.items())]
        old = [{"id": index + 20, "name": name, "size": 1, "digest": "sha256:" + "0" * 64,
                "state": "uploaded", "download_count": 0}
               for index, name in enumerate(sorted(retire.expected_names(retire.OLD_COMMIT) | {"build-manifest.json", "SHA256SUMS"}))]
        self.asset_lists = {retire.LATEST_ID: latest, retire.OLD_ID: old, 123456: []}
        self.old_by_tag_override = None
        self.after_delete = None
        self.writes = []

    def request(self, method, endpoint, payload=None, optional=False):
        retire.check_operation(method, endpoint, payload)
        if method != "GET":
            self.writes.append((method, endpoint, copy.deepcopy(payload)))
        if method == "PATCH":
            self.latest.update(payload)
            return copy.deepcopy(self.latest)
        if method == "DELETE":
            self.old = None
            if self.after_delete:
                self.after_delete(self)
            return None
        if endpoint.startswith("git/ref/tags/"):
            return copy.deepcopy(self.tags[endpoint.removeprefix("git/ref/tags/")])
        if endpoint.startswith("releases/tags/"):
            name = endpoint.removeprefix("releases/tags/")
            value = self.original if name == retire.ORIGINAL_TAG else self.old_by_tag_override or self.old
        elif endpoint.endswith("/assets?per_page=100"):
            release_id = int(endpoint.split("/")[1])
            for asset in self.asset_lists[release_id]:
                asset["download_count"] = asset.get("download_count", 0) + 1
            return copy.deepcopy(self.asset_lists[release_id])
        elif endpoint == f"releases/{retire.LATEST_ID}":
            value = self.latest
        elif endpoint == f"releases/{retire.OLD_ID}":
            value = self.old
        else:
            raise AssertionError("Unexpected fixed-maintenance endpoint")
        if value is None and not optional:
            raise retire.Refused("Missing test response")
        return copy.deepcopy(value)


class RetirementTests(unittest.TestCase):
    def test_preflight_retirement_and_idempotence_preserve_protected_objects(self):
        api = FakeAPI()
        self.assertTrue(retire.retire(api)["passed"])
        self.assertEqual(api.writes, [])
        latest_assets = [{key: value for key, value in asset.items() if key != "download_count"}
                         for asset in api.asset_lists[retire.LATEST_ID]]
        tags, original = copy.deepcopy(api.tags), copy.deepcopy(api.original)
        result = retire.retire(api, apply=True)
        self.assertTrue(result["old_release_absent"])
        self.assertEqual([(method, endpoint) for method, endpoint, _ in api.writes],
                         [("PATCH", f"releases/{retire.LATEST_ID}"), ("DELETE", f"releases/{retire.OLD_ID}")])
        self.assertEqual(api.latest["body"], retire.bodies()[2])
        self.assertEqual(api.tags, tags)
        self.assertEqual(api.original, original)
        self.assertEqual([{k: v for k, v in asset.items() if k != "download_count"}
                          for asset in api.asset_lists[retire.LATEST_ID]], latest_assets)
        writes = copy.deepcopy(api.writes)
        self.assertTrue(retire.retire(api, apply=True)["already_absent"])
        self.assertEqual(api.writes, writes)

    def test_wrong_replacement_identity_source_or_assets_refuse_all_writes(self):
        mutations = [lambda api: api.latest.update(id=retire.OLD_ID),
                     lambda api: api.latest.update(tag_name="another-tag"),
                     lambda api: api.latest.update(draft=True),
                     lambda api: api.latest.update(prerelease=False),
                     lambda api: api.tags[retire.LATEST_TAG]["object"].update(sha="0" * 40),
                     lambda api: api.asset_lists[retire.LATEST_ID][0].update(size=0),
                     lambda api: api.asset_lists[retire.LATEST_ID][0].update(digest="sha256:" + "0" * 64),
                     lambda api: api.asset_lists[retire.LATEST_ID].append({"name": "unexpected"})]
        for mutation in mutations:
            api = FakeAPI(); mutation(api)
            with self.subTest(mutation=mutation), self.assertRaises(retire.Refused):
                retire.retire(api, apply=True)
            self.assertEqual(api.writes, [])
            self.assertIsNotNone(api.old)

    def test_wrong_old_identity_source_assets_or_recreated_tag_refuse_deletion(self):
        mutations = [lambda api: api.old.update(id=999),
                     lambda api: api.old.update(tag_name="another-tag"),
                     lambda api: api.old.update(body="another source owner"),
                     lambda api: api.tags[retire.OLD_TAG]["object"].update(sha="0" * 40),
                     lambda api: api.asset_lists[retire.OLD_ID].pop(),
                     lambda api: (setattr(api, "old", None), setattr(api, "old_by_tag_override", {"id": 999}))]
        for mutation in mutations:
            api = FakeAPI(); mutation(api)
            with self.subTest(mutation=mutation), self.assertRaises(retire.Refused):
                retire.retire(api, apply=True)
            self.assertEqual(api.writes, [])

    def test_exact_three_body_replacements_match_publisher_and_preserve_other_text(self):
        _, before, wanted = retire.bodies()
        expected = before
        for original, replacement in retire.BODY_EDITS:
            self.assertEqual(expected.count(original), 1)
            expected = expected.replace(original, replacement, 1)
        self.assertEqual(retire.replacement_body(before), expected)
        self.assertEqual(expected, wanted)
        self.assertEqual(retire.replacement_body(wanted), wanted)
        self.assertEqual(before.splitlines()[0], wanted.splitlines()[0])
        self.assertNotIn("/releases/tag/" + retire.OLD_TAG, wanted)
        for changed in [before + "Unrelated edit", before.replace("此前的", "其他的"), wanted + "Unrelated edit"]:
            with self.assertRaises(retire.Refused):
                retire.replacement_body(changed)

    def test_write_guard_rejects_other_deletions_fields_and_body_changes(self):
        api = FakeAPI()
        calls = [("DELETE", f"releases/{retire.LATEST_ID}", None),
                 ("DELETE", "git/refs/tags/" + retire.OLD_TAG, None),
                 ("POST", "releases", {}),
                 ("PATCH", f"releases/{retire.LATEST_ID}", {"body": "another body"}),
                 ("PATCH", f"releases/{retire.LATEST_ID}", {"body": retire.bodies()[2], "draft": False}),
                 ("PATCH", f"releases/{retire.OLD_ID}", {"body": retire.bodies()[2]})]
        for method, endpoint, payload in calls:
            with self.subTest(endpoint=endpoint), self.assertRaises(retire.Refused):
                api.request(method, endpoint, payload)
        self.assertEqual(api.writes, [])

    def test_post_delete_verification_and_manual_main_workflow_guard(self):
        api = FakeAPI()
        api.after_delete = lambda value: value.asset_lists[retire.LATEST_ID][0].update(size=0)
        with self.assertRaisesRegex(retire.Refused, "Replacement asset"):
            retire.retire(api, apply=True)
        self.assertIsNone(api.old)
        workflow = (Path(__file__).resolve().parents[1] / ".github/workflows/retire-old-fix.yml").read_text()
        self.assertIn("on:\n  workflow_dispatch:\n", workflow)
        self.assertNotRegex(workflow, r"(?m)^  (push|pull_request|workflow_run):")
        self.assertIn("github.ref == 'refs/heads/main'", workflow)
        self.assertIn("github.repository == 'alniyata-firefly/easytier'", workflow)
        self.assertNotRegex(workflow, r"\b(cargo|rustup|pnpm|npm|gradle)\b")
        for action in re.findall(r"uses: (\S+)", workflow):
            self.assertRegex(action, r"^actions/(checkout|upload-artifact)@[0-9a-f]{40}$")
        with patch.dict("os.environ", {}, clear=True), patch("sys.argv", ["retire_old_fix.py", "--apply"]):
            with self.assertRaisesRegex(retire.Refused, "manual main workflow"):
                retire.main()


if __name__ == "__main__":
    unittest.main()
