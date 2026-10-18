import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch
import urllib.error
import urllib.request
import zipfile

import smoke


class AndroidIpcSmokeDriverTest(unittest.TestCase):
    def test_debug_build_has_one_x86_target_and_no_release_path(self):
        command = smoke.native_command("pnpm", Path("/private/overlay.json"))
        self.assertIn("--debug", command)
        self.assertEqual(command[command.index("--target") + 1], "x86_64")
        self.assertEqual(command.count("build"), 1)
        self.assertNotIn("--release", command)
        self.assertEqual(command[-2:], ["--", "--locked"])
        self.assertEqual(smoke.debug_overlay()["app"]["windows"][0]["url"], "ipc-smoke.html")

    def test_instrumentation_reuses_matching_native_variant_without_second_compile(self):
        command = smoke.instrumentation_build_command()
        self.assertIn(":app:assembleX86_64DebugAndroidTest", command)
        skip = command.index("-x")
        self.assertEqual(command[skip + 1], ":app:rustBuildX86_64Debug")
        self.assertIn("-PtargetList=x86_64", command)
        self.assertIn("-ParchList=x86_64", command)

    def test_signing_environment_is_not_forwarded_to_debug_build(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            values = {name: "fixture-secret-do-not-forward" for name in smoke.SECRETS}
            values.update({"ANDROID_HOME": str(root), "PATH": "/bin",
                           "ET_ANDROID_KEYSTORE_PROPERTIES": "/private/signing.properties",
                           "GH_TOKEN": "api-only-token", "GITHUB_TOKEN": "also-api-only"})
            with patch.dict(os.environ, values, clear=True):
                environment = smoke.environment(root / "source", root / "output")
            self.assertFalse(set(smoke.SECRETS).intersection(environment))
            self.assertNotIn("ET_ANDROID_KEYSTORE_PROPERTIES", environment)
            self.assertNotIn("GH_TOKEN", environment)
            self.assertNotIn("GITHUB_TOKEN", environment)

    def test_no_native_compilation_can_run_locally(self):
        with patch.dict(os.environ, {}, clear=True), patch("sys.argv", ["smoke.py", "--phase", "build", "--output", "/tmp/smoke-fixture"]):
            with patch.object(smoke, "build") as build:
                with self.assertRaisesRegex(RuntimeError, "CI-only"):
                    smoke.main()
                build.assert_not_called()

    @staticmethod
    def report():
        phases = {"cold_direct_js_status", "core_version", "local_rpc_init", "cold_validated_getter", "complete"}
        system = []
        for cycle in (1, 2):
            phases.update(f"{phase}_{cycle}" for phase in ["resume", "config_parse", "core_start", "vpn_permission",
                          "native_start", "native_owner", "native_establish_status", "rust_set_tun_fd", "validated_getter",
                          "system_vpn_present", "native_stop", "native_stopped_status", "rust_clear_tun_fd", "core_stop",
                          "stopped_validated_getter", "system_vpn_absent"])
            phases.update(f"concurrent_status_{cycle}_{sample}" for sample in range(10))
            system.extend([{"phase": f"system_vpn_present_{cycle}", "vpnTransportPresent": True},
                           {"phase": f"system_vpn_absent_{cycle}", "vpnTransportPresent": False}])
        gui = [{"phase": phase, "status": "pass"} for phase in ["gui_fixture_prepare", "gui_index_navigation", "gui_complete"]]
        for cycle in (1, 2):
            gui.extend({"phase": f"{phase}_{cycle}", "status": "pass"} for phase in
                       ["gui_connect_button", "gui_connected_stable", "gui_disconnect_button"])
            gui.extend([
                {"phase": f"gui_native_and_validated_{cycle}", "status": "pass", "details": {
                    key: True for key in ["nativeEstablished", "correctInstance", "positiveFd", "validatedOwner", "connected", "vpnTransportPresent"]}},
                {"phase": f"gui_stopped_native_and_validated_{cycle}", "status": "pass", "details": {
                    "nativeStopped": True, "validatedCleared": True, "vpnTransportPresent": False}},
            ])
        return {"status": "PASS", "cycles": 2, "events": [{"phase": phase, "status": "pass"} for phase in phases],
                "androidSystemObservations": system, "guiStatus": "PASS", "guiEvents": gui}

    def test_empty_or_ui_only_pass_is_rejected(self):
        for report in [{"status": "PASS", "cycles": 2}, self.report() | {"androidSystemObservations": []}]:
            with self.assertRaises(RuntimeError):
                smoke.validate_report(report)

    def test_every_native_stage_and_system_observation_are_required(self):
        report = self.report()
        smoke.validate_report(report)
        for phase in ["vpn_permission_1", "native_establish_status_1", "rust_set_tun_fd_1", "validated_getter_1",
                      "concurrent_status_2_9", "native_stopped_status_2"]:
            incomplete = json.loads(json.dumps(report))
            incomplete["events"] = [event for event in incomplete["events"] if event["phase"] != phase]
            with self.assertRaises(RuntimeError):
                smoke.validate_report(incomplete)

    def test_native_only_success_or_gui_label_without_system_vpn_is_rejected(self):
        native_only = self.report() | {"guiEvents": [], "guiStatus": "not_started"}
        with self.assertRaisesRegex(RuntimeError, "actual GUI"):
            smoke.validate_report(native_only)
        report = self.report()
        event = next(event for event in report["guiEvents"] if event["phase"] == "gui_native_and_validated_1")
        event["details"]["vpnTransportPresent"] = False
        with self.assertRaisesRegex(RuntimeError, "not backed"):
            smoke.validate_report(report)


class AndroidOriginalApkReuseTest(unittest.TestCase):
    commit = "a" * 40
    driver_commit = "b" * 40
    repository = "owner/repo"

    def source(self):
        run = {"id": 123, "head_sha": self.commit, "status": "completed", "conclusion": "failure",
               "path": ".github/workflows/android-ipc-smoke.yml",
               "repository": {"full_name": self.repository, "id": 99}, "head_repository": {"id": 99}}
        artifact = {"id": 456, "name": smoke.DEBUG_ARTIFACT, "expired": False, "size_in_bytes": 100,
                    "digest": "sha256:" + "c" * 64,
                    "workflow_run": {"id": 123, "head_sha": self.commit, "repository_id": 99, "head_repository_id": 99}}
        return run, artifact

    def archive(self, root, *, extra=None, change_manifest=None, change_apk=False):
        app, test = b"original app APK fixture", b"original instrumentation APK fixture"
        manifest = {"schema": 1, "status": "BUILT_DEBUG_ONLY", "sourceCommit": self.commit,
                    "package": smoke.PACKAGE, "abi": "x86_64", "signingSecretsUsed": False, "published": False,
                    "overlay": smoke.debug_overlay(), "apkSha256": hashlib.sha256(app).hexdigest(),
                    "testApkSha256": hashlib.sha256(test).hexdigest(), "testPageSha256": "d" * 64}
        if change_manifest:
            manifest.update(change_manifest)
        archive = root / "original.zip"
        with zipfile.ZipFile(archive, "w") as bundle:
            bundle.writestr("app-debug.apk", app + b"changed" if change_apk else app)
            bundle.writestr("app-debug-androidTest.apk", test)
            bundle.writestr("manifest.json", json.dumps(manifest))
            if extra:
                bundle.writestr(extra, b"unexpected")
        artifact = {"digest": "sha256:" + smoke.digest(archive), "size_in_bytes": archive.stat().st_size}
        return archive, artifact, manifest

    def test_completed_failed_original_smoke_is_usable_but_wrong_identity_is_refused(self):
        run, artifact = self.source()
        api = MagicMock()
        api.json.side_effect = [run, {"total_count": 1, "artifacts": [artifact]}]
        self.assertEqual(smoke.source_artifact(api, self.repository, 123, self.commit), artifact)
        for wrong in [{"head_sha": "e" * 40}, {"path": ".github/workflows/packages.yml"},
                      {"status": "in_progress"}, {"conclusion": "cancelled"}, {"head_repository": {"id": 98}}]:
            with self.subTest(wrong=wrong):
                api.json.side_effect = [run | wrong]
                with self.assertRaisesRegex(RuntimeError, "same-repository"):
                    smoke.source_artifact(api, self.repository, 123, self.commit)

    def test_artifact_must_be_unique_unexpired_and_bound_to_exact_run_and_sha(self):
        run, artifact = self.source()
        for entries in [[], [artifact, artifact], [artifact | {"expired": True}],
                        [artifact | {"workflow_run": artifact["workflow_run"] | {"head_sha": "e" * 40}}],
                        [artifact | {"digest": ""}]]:
            api = MagicMock()
            api.json.side_effect = [run, {"total_count": len(entries), "artifacts": entries}]
            with self.subTest(entries=entries), self.assertRaises(RuntimeError):
                smoke.source_artifact(api, self.repository, 123, self.commit)

    def test_original_archive_digest_and_apk_hashes_are_required(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive, artifact, manifest = self.archive(root)
            actual = smoke.unpack_debug_archive(archive, artifact, self.commit, root / "valid")
            self.assertEqual(actual, manifest)
            self.assertEqual(smoke.digest(root / "valid/app-debug.apk"), manifest["apkSha256"])
            with self.assertRaisesRegex(RuntimeError, "archive digest"):
                smoke.unpack_debug_archive(archive, artifact | {"digest": "sha256:" + "0" * 64}, self.commit, root / "invalid")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive, artifact, _ = self.archive(root, change_apk=True)
            with self.assertRaisesRegex(RuntimeError, "APK hash"):
                smoke.unpack_debug_archive(archive, artifact, self.commit, root / "invalid")

    def test_exact_three_files_and_manifest_source_are_required(self):
        for options in [{"extra": "../escape"}, {"extra": "extra.apk"},
                        {"change_manifest": {"sourceCommit": "e" * 40}},
                        {"change_manifest": {"signingSecretsUsed": True}}]:
            with self.subTest(options=options), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                archive, artifact, _ = self.archive(root, **options)
                with self.assertRaises(RuntimeError):
                    smoke.unpack_debug_archive(archive, artifact, self.commit, root / "invalid")
                self.assertFalse((root.parent / "escape").exists())

    def test_archive_redirect_uses_no_authorization_header_on_blob_request(self):
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {"GH_TOKEN": "api-token-fixture"}):
            api = smoke.ReadOnlyGitHub(self.repository)
            api.opener = MagicMock()
            redirect = urllib.error.HTTPError("https://api.github.com/fixture", 302, "redirect",
                        {"Location": "https://fixture.blob.core.windows.net/archive?signature=private"}, None)
            api.opener.open.side_effect = [redirect, io.BytesIO(b"archive fixture")]
            api.archive(456, Path(temporary) / "artifact.zip")
            requests = [call.args[0] for call in api.opener.open.call_args_list]
            self.assertEqual(requests[0].get_header("Authorization"), "Bearer api-token-fixture")
            self.assertIsNone(requests[1].get_header("Authorization"))
            self.assertEqual(requests[0].get_method(), "GET")
            self.assertEqual(requests[1].get_method(), "GET")

    def test_provenance_distinguishes_original_apk_source_and_current_driver(self):
        proof = {"sourceCommit": self.commit, "apkSha256": "c" * 64, "testApkSha256": "d" * 64}
        baseline = smoke.run_provenance(proof, self.commit)
        self.assertEqual(baseline["apiLevel"], 34)
        self.assertFalse(baseline["apkReused"])
        with self.assertRaises(RuntimeError):
            smoke.run_provenance(proof, self.driver_commit)
        proof.update(reused=True, driverCommit=self.driver_commit, sourceRunId=123, artifactId=456,
                     artifactDigest="sha256:" + "e" * 64, coverageNote="Later product changes are not covered")
        rerun = smoke.run_provenance(proof, self.driver_commit, 36)
        self.assertEqual(rerun["sourceCommit"], self.commit)
        self.assertEqual(rerun["driverCommit"], self.driver_commit)
        self.assertEqual(rerun["systemImage"], "system-images;android-36;google_apis;x86_64")
        self.assertTrue(rerun["apkReused"])
        with self.assertRaises(RuntimeError):
            smoke.run_provenance(proof, self.commit, 36)

    def test_import_phase_does_not_prepare_sdk_or_call_any_build_path(self):
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {"GITHUB_ACTIONS": "true"}, clear=True):
            arguments = ["smoke.py", "--phase", "import", "--output", temporary,
                         "--source-run-id", "123", "--repository", self.repository,
                         "--expected-source-commit", self.commit]
            with patch("sys.argv", arguments), patch.object(smoke, "import_debug_build") as importer, \
                    patch.object(smoke, "environment") as environment, patch.object(smoke, "build") as build, \
                    patch.object(smoke, "run") as run:
                smoke.main()
                importer.assert_called_once()
                environment.assert_not_called()
                build.assert_not_called()
                run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
