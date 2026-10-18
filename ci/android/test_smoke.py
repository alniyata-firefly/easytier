import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

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
                           "ET_ANDROID_KEYSTORE_PROPERTIES": "/private/signing.properties"})
            with patch.dict(os.environ, values, clear=True):
                environment = smoke.environment(root / "source", root / "output")
            self.assertFalse(set(smoke.SECRETS).intersection(environment))
            self.assertNotIn("ET_ANDROID_KEYSTORE_PROPERTIES", environment)

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
        return {"status": "PASS", "cycles": 2, "events": [{"phase": phase, "status": "pass"} for phase in phases],
                "androidSystemObservations": system}

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


if __name__ == "__main__":
    unittest.main()
