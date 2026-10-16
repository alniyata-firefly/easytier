"""Fast validation of failure boundaries and artifact inspection; no compilation."""
from __future__ import annotations

import contextlib
import io
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


class AndroidCiTests(unittest.TestCase):
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
