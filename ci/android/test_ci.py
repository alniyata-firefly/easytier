"""Fast validation of failure boundaries and artifact inspection; no compilation."""
from __future__ import annotations

import contextlib
import io
import json
import os
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import build
from signing import CERTIFICATE_SHA256, SECRETS, property_value, require_secrets, signing_inputs
from verify_page_size import inspect_native_libraries
from verify_apk import check_package_identity, check_product_labels


class AndroidCiTests(unittest.TestCase):
    def test_easy_tier_distribution_name_preserves_build_identity(self):
        self.assertEqual(build.apk_filename("2.7.2", "a" * 40), "EasyTier-2.7.2-adapted-aaaaaaaa-arm64.apk")

    def test_application_and_launcher_labels_are_verified_and_recorded(self):
        badging = ("application-label:'EasyTier'\napplication-label-en:'EasyTier'\n"
                   "application-label-zh-CN:'EasyTier'\n"
                   "launchable-activity: name='com.kkrainbow.easytier.MainActivity' label='EasyTier' icon=''\n")
        proof = check_product_labels(badging)
        self.assertEqual(proof['product_name'], 'EasyTier')
        self.assertEqual(proof['application_label'], 'EasyTier')
        self.assertEqual(proof['launcher_label'], 'EasyTier')
        self.assertEqual(len(proof['application_labels']), 3)
        for invalid in [badging.replace("application-label:'EasyTier'", "application-label:'EasyTier GUI'"),
                        badging.replace("application-label-zh-CN:'EasyTier'", "application-label-zh-CN:'easytier-gui'"),
                        badging.replace("label='EasyTier'", "label='EasyTier GUI'"),
                        badging.replace('com.kkrainbow.easytier.MainActivity', 'com.other.MainActivity'),
                        "application-label:'EasyTier'\n", ""]:
            with self.subTest(badging=invalid), self.assertRaises(RuntimeError):
                check_product_labels(invalid)

    def test_apk_identity_accepts_the_exact_adapted_release(self):
        check_package_identity(
            "package: name='com.kkrainbow.easytier.adapted' versionCode='2007003' versionName='2.7.2' platformBuildVersionCode='36'\n",
            "2.7.2",
        )

    def test_apk_identity_rejects_each_changed_field_and_reports_observed_values(self):
        expected = ("com.kkrainbow.easytier.adapted", "2007003", "2.7.2")
        for index, replacement in enumerate(["com.kkrainbow.easytier", "2007002", "2.7.1"]):
            observed = list(expected)
            observed[index] = replacement
            badging = "package: name='%s' versionCode='%s' versionName='%s'\n" % tuple(observed)
            with self.subTest(field=index), self.assertRaises(RuntimeError) as failure:
                check_package_identity(badging, "2.7.2")
            diagnostic = json.loads(str(failure.exception).split(": ", 1)[1])
            self.assertEqual(diagnostic, {"expected": list(expected), "observed": observed})

    def test_apk_identity_rejects_missing_package_metadata_explicitly(self):
        with self.assertRaises(RuntimeError) as failure:
            check_package_identity("sdkVersion:'24'\n", "2.7.2")
        diagnostic = json.loads(str(failure.exception).split(": ", 1)[1])
        self.assertIsNone(diagnostic["observed"])

    def test_prefetch_covers_all_platforms_before_locked_offline_metadata(self):
        environment = {name: "fixture-signing-value" for name in SECRETS}
        environment.update({"ET_ANDROID_KEYSTORE_PROPERTIES": "/fixture/private/release.properties",
                            "CARGO_BUILD_TARGET": "aarch64-linux-android", "CARGO_NET_OFFLINE": "true"})
        with patch.object(build, "run_logged") as run:
            build.prepare_offline_dependencies(Path("/fixture/source"), environment, Path("/fixture/output"))
        self.assertEqual(run.call_count, 2)
        fetch, metadata = run.call_args_list
        self.assertEqual(fetch.args[0], ["cargo", "fetch", "--locked", "--manifest-path",
                                        Path("/fixture/source/easytier-gui/src-tauri/Cargo.toml")])
        self.assertEqual(fetch.kwargs["env"]["CARGO_NET_OFFLINE"], "false")
        self.assertNotIn("--target", fetch.args[0])
        self.assertEqual(metadata.args[0], ["cargo", "metadata", "--locked", "--offline", "--format-version", "1",
                                           "--manifest-path", Path("/fixture/source/easytier-gui/src-tauri/Cargo.toml"),
                                           "--features", "tauri/custom-protocol"])
        self.assertEqual(metadata.kwargs["env"]["CARGO_NET_OFFLINE"], "true")
        self.assertNotIn("--no-deps", metadata.args[0])
        self.assertNotIn("--filter-platform", metadata.args[0])
        for call in [fetch, metadata]:
            self.assertNotIn("CARGO_BUILD_TARGET", call.kwargs["env"])
            self.assertNotIn("ET_ANDROID_KEYSTORE_PROPERTIES", call.kwargs["env"])
            self.assertTrue(all(name not in call.kwargs["env"] for name in SECRETS))
        self.assertEqual(environment["CARGO_NET_OFFLINE"], "true")
        self.assertNotIn("CARGO_BUILD_TARGET", environment)

    def test_failed_fetch_stops_before_offline_metadata_or_build(self):
        environment = {"CARGO_NET_OFFLINE": "false"}
        with patch.object(build, "run_logged", side_effect=RuntimeError("fixture fetch failure")) as run:
            with self.assertRaisesRegex(RuntimeError, "fetch failure"):
                build.prepare_offline_dependencies(Path("/fixture/source"), environment, Path("/fixture/output"))
        self.assertEqual(run.call_count, 1)
        self.assertEqual(environment["CARGO_NET_OFFLINE"], "false")

    def test_missing_offline_dependency_stops_before_native_build(self):
        environment = {"CARGO_NET_OFFLINE": "false"}
        with patch.object(build, "run_logged", side_effect=[None, RuntimeError("fixture missing arboard")]) as run:
            with self.assertRaisesRegex(RuntimeError, "missing arboard"):
                build.prepare_offline_dependencies(Path("/fixture/source"), environment, Path("/fixture/output"))
        self.assertEqual(run.call_count, 2)
        self.assertEqual(environment["CARGO_NET_OFFLINE"], "false")

    def test_missing_signing_values_fail_before_output_or_toolchain_work(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "not-created"
            with patch.dict(os.environ, {}, clear=True), patch("sys.argv", ["build.py", "--output", str(output)]):
                with self.assertRaisesRegex(RuntimeError, "Signing check failed"):
                    build.main()
            self.assertFalse(output.exists())

    def test_missing_secret_report_names_only(self):
        values = {SECRETS[0]: "not-a-real-private-secret"}
        with self.assertRaises(RuntimeError) as failure:
            require_secrets(values)
        self.assertNotIn(values[SECRETS[0]], str(failure.exception))
        self.assertIn("ANDROID_KEYSTORE_PASSWORD", str(failure.exception))
        self.assertIn("no replacement/debug key", str(failure.exception))

    def test_invalid_base64_does_not_invoke_a_tool_or_leave_files(self):
        values = {name: "fixture-value" for name in SECRETS}
        values[SECRETS[0]] = "bad!base64!"
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, values, clear=True), patch("subprocess.run") as run:
            with self.assertRaisesRegex(RuntimeError, "BASE64 is invalid"):
                with signing_inputs("keytool", Path(temporary) / "source", temporary):
                    self.fail("invalid input was accepted")
            self.assertFalse(run.called)
            self.assertEqual(list(Path(temporary).iterdir()), [])

    def test_property_escaping_preserves_non_ascii_and_line_separators(self):
        self.assertEqual(property_value("a\\b:=#! c\n\t"), "a\\\\b\\:\\=\\#\\!\\ c\\u000a\\u0009")
        self.assertEqual(property_value("\U0001f512"), "\\ud83d\\udd12")
        self.assertEqual(len(CERTIFICATE_SHA256), 64)

    def test_wrong_certificate_is_rejected_and_temporary_key_is_removed(self):
        import base64
        values = {name: "fixture-value" for name in SECRETS}
        values[SECRETS[0]] = base64.b64encode(b"fixture-keystore-bytes").decode()
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, values, clear=True), patch("subprocess.run") as run:
            run.return_value.returncode = 0
            run.return_value.stdout = b"different-public-certificate"
            with self.assertRaisesRegex(RuntimeError, "certificate differs"):
                with signing_inputs("keytool", Path(temporary) / "source", temporary):
                    self.fail("wrong signer was accepted")
            self.assertEqual(run.call_count, 1)
            self.assertEqual(list(Path(temporary).iterdir()), [])

    def test_failed_build_logs_show_first_error_and_tail_without_secrets(self):
        values = {name: f"fixture-sensitive-{index}" for index, name in enumerate(SECRETS)}
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, values, clear=True), patch("subprocess.run") as run:
            log = Path(temporary) / "android-build.log"
            private = Path(temporary) / "private-signing/release.properties"
            content = ["normal line"] * 110
            content[3] = "error: first linker detail " + values[SECRETS[1]]
            content[-1] = f"last detail {values[SECRETS[0]]} {private} {private.parent}/release.keystore"
            run.return_value.returncode = 1
            def failed_build(*args, **kwargs):
                kwargs["stdout"].write("\n".join(content))
                return run.return_value
            run.side_effect = failed_build
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                with self.assertRaisesRegex(RuntimeError, "redacted diagnostics are above"):
                    build.run_logged(["cargo"], cwd=temporary, env={"ET_ANDROID_KEYSTORE_PROPERTIES": str(private)}, log=log)
            text = output.getvalue()
            self.assertIn("first linker detail", text)
            self.assertIn("last detail", text)
            self.assertIn("[REDACTED]", text)
            self.assertNotIn(str(private.parent), text)
            self.assertTrue(all(value not in text for value in values.values()))

    def test_page_inspector_measures_actual_load_and_relro_headers(self):
        # Synthetic ELF header checks the inspector, not a runtime/VPN claim.
        elf = bytearray(256)
        elf[:6] = b"\x7fELF\x02\x01"
        struct.pack_into("<Q", elf, 32, 64)
        struct.pack_into("<HH", elf, 54, 56, 2)
        struct.pack_into("<IIQQQQQQ", elf, 64, 1, 4, 0, 0, 0, 256, 256, 16384)
        struct.pack_into("<IIQQQQQQ", elf, 120, 0x6474e552, 4, 0, 0, 0, 16384, 16384, 1)
        with tempfile.TemporaryDirectory() as temporary:
            apk = Path(temporary) / "fixture.apk"
            with zipfile.ZipFile(apk, "w") as archive:
                archive.writestr("lib/arm64-v8a/libapp_lib.so", elf)
            libraries = inspect_native_libraries(apk)
        self.assertEqual(libraries[0]["pt_load_segments"][0]["align"], 16384)
        self.assertEqual(libraries[0]["gnu_relro_segments"][0]["end_virtual_address"], 16384)
        self.assertFalse(libraries[0]["zip_stored_alignment_16k_pass"])


if __name__ == "__main__":
    unittest.main()
