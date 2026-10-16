"""Synthetic temporary Git repositories; no production or generated key material."""
from __future__ import annotations

import contextlib
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import public_source


class PublicSourceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        subprocess.run(["git", "init", "--quiet", str(self.root)], check=True)

    def tracked(self, relative, data=b"synthetic fixture\n"):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        subprocess.run(["git", "add", "-f", "--", relative], cwd=self.root, check=True)
        return path

    def rules(self):
        return {item["rule"] for item in public_source.scan(self.root)["findings"]}

    def test_clean_source_and_environment_templates_are_allowed(self):
        for relative in ("src/runtime/engine.rs", "proto/build/main.rs", "easytier-js/runtime/src/index.ts",
                         ".env.example", "nested/.env.production.template", "deploy/web.env.example", "tools/env.sh", "example/env.d.ts"):
            self.tracked(relative, b"TOKEN=${TOKEN_FROM_ENV}\n")
        self.assertEqual(public_source.scan(self.root)["status"], "PASS")

    def test_untracked_files_are_outside_the_declared_scope(self):
        self.tracked("README.md")
        (self.root / "production.db").write_bytes(b"synthetic data")
        report = public_source.scan(self.root)
        self.assertEqual(report["status"], "PASS")
        self.assertEqual(report["files_checked"], 1)

    def test_runtime_and_compilation_paths_are_rejected(self):
        for relative in ("runtime/config.toml", "private/state.json", "artifacts/package.txt", "nested/node_modules/a.js",
                         "nested/target-release/a", "frontend/dist/index.html", "nested/__pycache__/a.pyc"):
            self.tracked(relative)
        self.assertIn("local-or-generated-directory", self.rules())
        self.assertEqual(len({item["path"] for item in public_source.scan(self.root)["findings"]}), 7)

    def test_credentials_databases_logs_and_release_archives_are_rejected(self):
        for relative in ("state.sqlite3", "state.db-wal", "prod.p12", "upload.jks", "keystore.properties",
                         "android-release.properties", ".env.production", "web.env.production", "record.har", "trace.log", "backup.zip", "client.apk"):
            self.tracked(relative)
        report = public_source.scan(self.root)
        self.assertEqual(len({item["path"] for item in report["findings"]}), 12)

    def test_database_magic_is_found_without_a_database_extension(self):
        self.tracked("notes.txt", b"SQLite format 3\x00" + b"synthetic" * 16)
        self.assertIn("sqlite-database-content", self.rules())

    def test_complete_private_blocks_include_encrypted_and_openssh_keys(self):
        for kind in ("PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY", "DSA PRIVATE KEY",
                     "OPENSSH PRIVATE KEY", "ENCRYPTED PRIVATE KEY"):
            relative = kind.replace(" ", "-") + ".txt"
            # A plausible base64 block is enough to test matching; this is not a key.
            block = b"-----BEGIN " + kind.encode() + b"-----\n" + b"A" * 128 + b"\n-----END " + kind.encode() + b"-----\n"
            self.tracked(relative, block)
        report = public_source.scan(self.root)
        self.assertEqual(sum(item["rule"] == "private-key-material" for item in report["findings"]), 6)

    def test_public_keys_certificates_and_header_mentions_do_not_match(self):
        for kind, suffix in (("PUBLIC KEY", ".pem"), ("RSA PUBLIC KEY", ".key"), ("CERTIFICATE", ".pem")):
            self.tracked(kind.replace(" ", "-") + suffix,
                         b"-----BEGIN " + kind.encode() + b"-----\n" + b"A" * 128 + b"\n-----END " + kind.encode() + b"-----\n")
        self.tracked("docs/key-format.md", b"The header is -----BEGIN PRIVATE KEY-----; insert your own key.\n")
        self.tracked("public.key", b"ssh-ed25519 " + b"A" * 64 + b" public fixture\n")
        self.assertEqual(public_source.scan(self.root)["status"], "PASS")

    def test_traditional_encrypted_private_key_headers_are_rejected(self):
        kind = b"RSA PRIVATE KEY"
        self.tracked("encrypted.txt", b"-----BEGIN " + kind + b"-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-256-CBC,ABCDEF0123456789\n\n" + b"A" * 128 + b"\n-----END " + kind + b"-----\n")
        self.assertIn("private-key-material", self.rules())

    def test_template_name_cannot_bypass_actual_private_content(self):
        token_url = b"udp://config.example.invalid:22020/" + b"A" * 43
        self.tracked(".env.example", token_url)
        self.assertIn("embedded-enrollment-token", self.rules())

    def test_high_confidence_tokens_and_wireguard_keys_are_rejected(self):
        values = {
            "enrollment.txt": b"wss://config.example.invalid:443/" + b"A" * 43,
            "provider.txt": b"ghp_" + b"B" * 36,
            "wireguard.conf": b"PrivateKey = " + b"C" * 43 + b"=\n",
            "jwt.txt": b"eyJ" + b"D" * 16 + b".eyJ" + b"E" * 16 + b"." + b"F" * 32,
        }
        for relative, data in values.items():
            self.tracked(relative, data)
        self.assertTrue({"embedded-enrollment-token", "provider-access-token", "wireguard-private-key", "embedded-signed-token"} <= self.rules())

    def test_fixture_exception_requires_both_exact_path_and_exact_hash(self):
        relative = "upstream/keystore.properties"
        data = b"synthetic public fixture\n"
        path = self.tracked(relative, data)
        self.tracked("copy/keystore.properties", data)
        with patch.dict(public_source.UPSTREAM_FIXTURES, {relative: hashlib.sha256(data).hexdigest()}, clear=True):
            report = public_source.scan(self.root)
            self.assertEqual(report["unchanged_upstream_fixtures"], [relative])
            self.assertEqual({item["path"] for item in report["findings"]}, {"copy/keystore.properties"})
            path.write_bytes(data + b"changed")
            self.assertIn("changed-upstream-fixture", self.rules())

    def test_exactly_the_five_audited_upstream_fixture_paths_are_configured(self):
        self.assertEqual(len(public_source.UPSTREAM_FIXTURES), 5)
        self.assertEqual(len(public_source.UPSTREAM_BASELINE), 40)
        self.assertTrue(all(len(value) == 64 for value in public_source.UPSTREAM_FIXTURES.values()))

    def test_vendored_binary_exception_does_not_allow_new_build_outputs_or_private_content(self):
        self.tracked("easytier/third_party/arm64/wintun.dll")
        self.tracked("local/wintun.dll")
        self.assertEqual(public_source.scan(self.root)["findings"], [{"path": "local/wintun.dll", "rule": "compiled-or-archive-output"}])
        self.tracked("easytier/third_party/arm64/wintun.dll", b"PrivateKey = " + b"A" * 43 + b"=\n")
        self.assertIn("wireguard-private-key", self.rules())

    def test_current_unstaged_content_is_scanned_instead_of_only_index_blobs(self):
        path = self.tracked("config.txt", b"safe\n")
        path.write_bytes(b"tcp://config.example.invalid:22020/" + b"A" * 43)
        self.assertIn("embedded-enrollment-token", self.rules())

    def test_internal_source_symlinks_are_allowed_and_external_links_fail_closed(self):
        self.tracked("README.md")
        (self.root / "internal.md").symlink_to("README.md")
        (self.root / "external.md").symlink_to(self.root.parent / "not-in-repo")
        subprocess.run(["git", "add", "--", "internal.md", "external.md"], cwd=self.root, check=True)
        report = public_source.scan(self.root)
        self.assertEqual({item["path"] for item in report["findings"]}, {"external.md"})

    def test_missing_tracked_files_fail_closed(self):
        self.tracked("deleted.txt").unlink()
        self.assertIn("unreadable-tracked-file", self.rules())

    def test_output_reports_paths_and_rules_without_matching_content(self):
        secret = b"udp://config.example.invalid:22020/" + b"Z" * 43
        self.tracked("accidental.txt", secret)
        output = io.StringIO()
        with patch("sys.argv", ["public_source.py", "--source", str(self.root)]), contextlib.redirect_stdout(output):
            self.assertEqual(public_source.main(), 1)
        report = json.loads(output.getvalue())
        self.assertEqual(report["findings"], [{"path": "accidental.txt", "rule": "embedded-enrollment-token"}])
        self.assertNotIn(secret.decode(), output.getvalue())
        self.assertNotIn(str(self.root), output.getvalue())


if __name__ == "__main__":
    unittest.main()
