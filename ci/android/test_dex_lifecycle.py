"""Synthetic DEX instruction/bridge regressions; no device or build required."""
from pathlib import Path
import tempfile
import unittest

from dex_bridge import instruction_evidence, verify_bridge_definitions, verify_lifecycle


PLUGIN = "Lcom/plugin/vpnservice/VpnServicePlugin;"
SERVICE = "Lcom/plugin/vpnservice/TauriVpnService;"
MAIN = "Lcom/kkrainbow/easytier/MainForegroundService;"
ARGS = "Lcom/plugin/vpnservice/SetClientEnabledArgs;"


def method(name, signature, *, calls=(), types=(), strings=(), literals=(), conditional=False, annotation=None):
    return {"name": name, "signature": signature, "access": 1, "code_present": True,
            "annotations": {annotation: 1} if annotation else {}, "calls": list(calls), "types": list(types),
            "strings": list(strings), "literal_constants": list(literals), "has_conditional": conditional}


def fixture():
    invoke = "(Lapp/tauri/plugin/Invoke;)V"
    command = "Lapp/tauri/annotation/Command;"
    stop = ("Landroid/content/Context;", "stopService", "(Landroid/content/Intent;)Z")
    definitions = {name: {"methods": [], "fields": [], "annotations": {}} for name in [
        PLUGIN, SERVICE, MAIN, ARGS, "Lcom/plugin/vpnservice/StartVpnArgs;",
        "Lcom/kkrainbow/easytier/MainActivity;", "Lcom/kkrainbow/easytier/TauriActivity;",
        "Landroidx/activity/result/ActivityResult;", "La/b;"]}
    definitions[PLUGIN]["annotations"] = {"Lapp/tauri/annotation/TauriPlugin;": 1}
    definitions[PLUGIN]["methods"] = [method(name, invoke, annotation=command) for name in [
        "ping", "prepareVpn", "startVpn", "stopVpn", "getVpnStatus", "consumeVpnTileAction", "setClientEnabled"]]
    definitions[PLUGIN]["methods"] += [
        method("<init>", "(Landroid/app/Activity;)V"),
        method("onPrepareVpnResult", "(Lapp/tauri/plugin/Invoke;Landroidx/activity/result/ActivityResult;)V",
               annotation="Lapp/tauri/annotation/ActivityCallback;")]
    setter = next(item for item in definitions[PLUGIN]["methods"] if item["name"] == "setClientEnabled")
    setter["types"] = ["La/b;"]  # post-R8 Runnable class, not its source name
    definitions["La/b;"]["methods"] = [method("run", "()V", calls=[
        ("Landroid/content/SharedPreferences$Editor;", "putBoolean", "(Ljava/lang/String;Z)Landroid/content/SharedPreferences$Editor;"),
        ("Landroid/content/SharedPreferences$Editor;", "apply", "()V"), stop],
        strings=["easytier_client_lifecycle", "enabled"])]
    stopper = next(item for item in definitions[PLUGIN]["methods"] if item["name"] == "stopVpn")
    stopper["calls"] = [stop, (SERVICE, "onRevoke", "()V")]
    for owner in [SERVICE, MAIN]:
        definitions[owner]["methods"] = [method("onStartCommand", "(Landroid/content/Intent;II)I", calls=[
            ("Landroid/content/SharedPreferences;", "getBoolean", "(Ljava/lang/String;Z)Z"),
            ("Landroid/app/Service;", "stopSelf", "()V"), ("Landroid/app/Service;", "stopForeground", "(I)V")],
            strings=["easytier_client_lifecycle", "enabled"], literals=[1, 2], conditional=True)]
    definitions[ARGS]["fields"] = [{"name": "enabled", "type": "Z"}]
    definitions["Lcom/plugin/vpnservice/StartVpnArgs;"]["fields"] = [{"name": name} for name in
        ["ipv4Addr", "routes", "dns", "disallowedApplications", "mtu"]]
    return definitions


MAPPING = "com.plugin.vpnservice.VpnServicePlugin$setClientEnabled$1 -> a.b:\n"


class DexLifecycleTests(unittest.TestCase):
    def test_instruction_parser_skips_operands_and_array_payloads(self):
        calls = [("Landroid/app/Service;", "stopSelf", "()V")]
        units = [0x001a, 0, 0x106e, 0, 0, 0x2212, 0x0038, 2,
                 0x0300, 2, 3, 0, 0x001a, 0x006e, 0x0032, 0x000e]
        result = instruction_evidence(units, ["enabled"], [], calls, [])
        self.assertEqual(result["calls"], calls)
        self.assertEqual(result["strings"], ["enabled"])
        self.assertEqual(result["literal_constants"], [2])
        self.assertTrue(result["has_conditional"])

    def test_truncated_instruction_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "truncated"):
            instruction_evidence([0x006e, 0], [], [], [], [])

    def test_new_stop_bridge_and_renamed_closure_pass(self):
        definitions = fixture()
        result = verify_lifecycle(definitions, MAPPING)
        self.assertTrue(result["both_service_pause_guards_preserved"])
        # The class mapping is necessary; do not guess obfuscated helper names.
        with self.assertRaisesRegex(ValueError, "persisted pause"):
            verify_lifecycle(definitions)

    def test_complete_new_bridge_passes_with_actual_mapping_input(self):
        with tempfile.TemporaryDirectory() as temporary:
            mapping = Path(temporary) / 'mapping.txt'
            mapping.write_text(MAPPING)
            proof = verify_bridge_definitions(fixture(), mapping)
        self.assertIn('setClientEnabled', proof['vpn_commands_preserved'])
        self.assertTrue(proof['client_enabled_argument_preserved'])
        self.assertTrue(proof['client_lifecycle']['static_check_only'])

    def test_new_command_without_runtime_annotation_is_rejected(self):
        definitions = fixture()
        next(item for item in definitions[PLUGIN]['methods'] if item['name'] == 'setClientEnabled')['annotations'] = {}
        with self.assertRaisesRegex(ValueError, 'setClientEnabled'):
            verify_bridge_definitions(definitions)

    def test_old_bridge_without_new_command_is_rejected(self):
        definitions = fixture()
        definitions[PLUGIN]["methods"] = [item for item in definitions[PLUGIN]["methods"]
                                           if item["name"] != "setClientEnabled"]
        with self.assertRaisesRegex(ValueError, "setClientEnabled"):
            verify_bridge_definitions(definitions)

    def test_removed_reflected_enabled_field_is_rejected(self):
        definitions = fixture()
        definitions[ARGS]["fields"] = [{"name": "a", "type": "Z"}]
        with self.assertRaisesRegex(ValueError, "enabled boolean"):
            verify_bridge_definitions(definitions)

    def test_lost_stopped_foreground_guard_is_rejected(self):
        definitions = fixture()
        definitions[MAIN]["methods"][0]["calls"] = [call for call in definitions[MAIN]["methods"][0]["calls"]
                                                     if call[1] != "stopForeground"]
        with self.assertRaisesRegex(ValueError, "stopForeground"):
            verify_lifecycle(definitions, MAPPING)

    def test_sticky_only_old_service_is_rejected(self):
        definitions = fixture()
        definitions[SERVICE]["methods"][0]["literal_constants"] = [1]
        with self.assertRaisesRegex(ValueError, "START_NOT_STICKY"):
            verify_lifecycle(definitions, MAPPING)

    def test_pause_without_stop_service_is_rejected(self):
        definitions = fixture()
        definitions["La/b;"]["methods"][0]["calls"] = [call for call in definitions["La/b;"]["methods"][0]["calls"]
                                                         if call[1] != "stopService"]
        with self.assertRaisesRegex(ValueError, "stopService"):
            verify_lifecycle(definitions, MAPPING)

    def test_inlined_revoke_cleanup_is_accepted(self):
        definitions = fixture()
        stopper = next(item for item in definitions[PLUGIN]['methods'] if item['name'] == 'stopVpn')
        stopper['calls'] = [call for call in stopper['calls'] if call[1] != 'onRevoke']
        stopper['calls'] += [('Landroid/app/Service;', 'stopForeground', '(I)V'),
                             ('Landroid/os/ParcelFileDescriptor;', 'close', '()V')]
        self.assertTrue(verify_lifecycle(definitions, MAPPING)['explicit_stop_service_apis_preserved'])


if __name__ == "__main__":
    unittest.main()
