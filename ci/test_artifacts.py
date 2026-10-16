#!/usr/bin/env python3
"""Regression tests for release mixing and artifact tampering, without native builds."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import artifacts
from plan_packages import plan

COMMIT = "a" * 40
VERSION = "2.7.2"


class ArtifactValidation(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.file = self.root / "package.tar.gz"
        self.file.write_bytes(b"fixture-package")
        self.manifest = {"source_commit": COMMIT, "version": VERSION, "platform": "fixture",
                         "files": [artifacts.file_record(self.root, self.file)]}

    def test_matching_artifact(self):
        self.assertEqual(artifacts.validate_manifest(self.root, self.manifest, COMMIT, VERSION), [self.file])

    def test_rejects_mixed_commit(self):
        with self.assertRaises(ValueError):
            artifacts.validate_manifest(self.root, self.manifest, "b" * 40, VERSION)

    def test_rejects_modified_asset(self):
        self.file.write_bytes(b"tampered")
        with self.assertRaises(ValueError):
            artifacts.validate_manifest(self.root, self.manifest, COMMIT, VERSION)

    def test_rejects_traversal_and_duplicate_paths(self):
        for unsafe in ("../package.tar.gz", "/package.tar.gz", "a/../package.tar.gz", "a\\package.tar.gz"):
            manifest = copy.deepcopy(self.manifest)
            manifest["files"][0]["path"] = unsafe
            with self.subTest(unsafe=unsafe), self.assertRaises(ValueError):
                artifacts.validate_manifest(self.root, manifest, COMMIT, VERSION)
        self.manifest["files"] *= 2
        with self.assertRaises(ValueError):
            artifacts.validate_manifest(self.root, self.manifest, COMMIT, VERSION)

    def test_rejects_symlink(self):
        link = self.root / "linked.tar.gz"
        link.symlink_to(self.file)
        with self.assertRaises(ValueError):
            artifacts.safe_file(self.root, link.name)

    def test_release_requires_every_platform(self):
        with patch.object(artifacts, "source", return_value=(COMMIT, VERSION)):
            with self.assertRaises(ValueError):
                artifacts.collect(self.root, self.root / "release", ["linux-x86_64", "android-arm64"])

    def test_release_rejects_old_unrecorded_files(self):
        incoming = self.root / "incoming" / "fixture"
        incoming.mkdir(parents=True)
        (incoming / self.file.name).write_bytes(self.file.read_bytes())
        (incoming / "build-manifest.json").write_text(json.dumps(self.manifest))
        output = self.root / "release"
        output.mkdir()
        (output / "old-other-commit.apk").write_bytes(b"old-package")
        with patch.object(artifacts, "source", return_value=(COMMIT, VERSION)):
            with self.assertRaises(ValueError):
                artifacts.collect(incoming.parent, output, ["fixture"])


class PackagePlanning(unittest.TestCase):
    def setUp(self):
        self.env = {"WANT_LINUX": "true", "WANT_GUI": "true", "WANT_ANDROID": "true",
                    "GITHUB_EVENT_NAME": "push", "GITHUB_REF": "refs/heads/main"}

    def test_branch_skips_unsigned_android_explicitly(self):
        outputs, warning = plan(self.env, VERSION)
        self.assertEqual(outputs["android"], "false")
        self.assertIn("signing secrets are missing", warning)

    def test_manual_android_cannot_silently_skip_signing(self):
        self.env["GITHUB_EVENT_NAME"] = "workflow_dispatch"
        with self.assertRaises(ValueError):
            plan(self.env, VERSION)

    def test_release_tag_requires_complete_platform_set(self):
        self.env.update(GITHUB_EVENT_NAME="workflow_dispatch", GITHUB_REF="refs/tags/v2.7.2",
                        GITHUB_REF_NAME="v2.7.2", WANT_LINUX="false", WANT_GUI="false", WANT_ANDROID="false")
        with self.assertRaises(ValueError):
            plan(self.env, VERSION)

    def test_release_tag_requires_matching_version(self):
        self.env.update(GITHUB_REF="refs/tags/v2.7.3", GITHUB_REF_NAME="v2.7.3")
        with self.assertRaises(ValueError):
            plan(self.env, VERSION)

    def test_configured_signing_enables_android(self):
        for name in ("ANDROID_KEYSTORE_BASE64", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD"):
            self.env[name] = "synthetic-fixture"
        outputs, warning = plan(self.env, VERSION)
        self.assertEqual(outputs["android"], "true")
        self.assertIsNone(warning)


if __name__ == "__main__":
    unittest.main()
