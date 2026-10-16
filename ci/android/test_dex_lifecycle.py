"""Synthetic DEX instruction/bridge regressions; no device or build required."""
from pathlib import Path
import tempfile
import unittest

from dex_bridge import instruction_evidence, verify_bridge_definitions, verify_lifecycle


PLUGIN = "Lcom/plugin/vpnservice/VpnServicePlugin;"
SERVICE = "Lcom/plugin/vpnservice/TauriVpnService;"
MAIN = "Lcom/kkrainbow/easytier/MainForegroundService;"
ARGS = "Lcom/plugin/vpnservice/SetClientEnabledArgs;"
COMPANION = "Lcom/plugin/vpnservice/TauriVpnService$Companion;"


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
        "Landroidx/activity/result/ActivityResult;", "La/b;", COMPANION]}
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
    stopper["calls"] = [(COMPANION, "requestStop", "(Landroid/content/Context;)V")]
    definitions[COMPANION]["methods"] = [method("requestStop", "(Landroid/content/Context;)V", calls=[
        stop, ("Landroid/os/ParcelFileDescriptor;", "close", "()V")])]
    for owner in [SERVICE, MAIN]:
        definitions[owner]["methods"] = [method("onStartCommand", "(Landroid/content/Intent;II)I", calls=[
            ("Landroid/content/SharedPreferences;", "getBoolean", "(Ljava/lang/String;Z)Z"),
            ("Landroid/app/Service;", "stopSelf", "()V"), ("Landroid/app/Service;", "stopForeground", "(I)V")],
            strings=["easytier_client_lifecycle", "enabled"], literals=[1, 2], conditional=True)]
    definitions[SERVICE]["methods"].append(method("onDestroy", "()V", calls=[
        ("Landroid/os/ParcelFileDescriptor;", "close", "()V"), ("Landroid/app/Service;", "stopForeground", "(I)V")]))
    definitions[SERVICE]["methods"].append(method("onRevoke", "()V", calls=[
        ("Landroid/os/ParcelFileDescriptor;", "close", "()V"), ("Landroid/app/Service;", "stopSelf", "()V")]))
    definitions[ARGS]["fields"] = [{"name": "enabled", "type": "Z"}]
    definitions["Lcom/plugin/vpnservice/StartVpnArgs;"]["fields"] = [{"name": name} for name in
        ["requestId", "instanceId", "ipv4Addr", "routes", "dns", "disallowedApplications", "mtu"]]
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

    def test_reachable_merged_runnable_without_app_mapping_passes(self):
        definitions = fixture()
        definitions['La/b;']['interfaces'] = ['Ljava/lang/Runnable;']
        self.assertTrue(verify_lifecycle(definitions)['set_client_enabled_persists_pause'])

    def test_reachable_function_with_renamed_interface_and_superclass_passes(self):
        definitions = fixture()
        definitions['La/b;']['superclass'] = 'La/base;'
        definitions['La/b;']['methods'][0]['name'] = 'invoke'
        definitions['La/b;']['methods'][0]['signature'] = '(Ljava/lang/Object;)Ljava/lang/Object;'
        definitions['La/base;'] = {'methods': [], 'interfaces': ['La/function;'], 'access': 0x401}
        definitions['La/function;'] = {'methods': [], 'access': 0x601}
        mapping = 'kotlin.jvm.functions.Function1 -> a.function:\n'
        self.assertTrue(verify_lifecycle(definitions, mapping)['set_client_enabled_persists_pause'])

    def test_unreferenced_functional_class_cannot_supply_missing_pause_evidence(self):
        definitions = fixture()
        definitions['La/b;']['interfaces'] = ['Ljava/lang/Runnable;']
        setter = next(item for item in definitions[PLUGIN]['methods'] if item['name'] == 'setClientEnabled')
        setter['types'] = []
        with self.assertRaisesRegex(ValueError, 'persisted pause'):
            verify_lifecycle(definitions)

    def test_interface_reference_does_not_follow_all_implementations(self):
        definitions = fixture()
        definitions['La/b;']['interfaces'] = ['La/function;']
        definitions['La/function;'] = {'methods': [], 'access': 0x601}
        setter = next(item for item in definitions[PLUGIN]['methods'] if item['name'] == 'setClientEnabled')
        setter['types'] = ['La/function;']
        mapping = 'kotlin.jvm.functions.Function1 -> a.function:\n'
        with self.assertRaisesRegex(ValueError, 'persisted pause'):
            verify_lifecycle(definitions, mapping)

    def test_plain_helper_type_reference_does_not_supply_pause_evidence(self):
        definitions = fixture()
        descriptor = 'Lcom/plugin/vpnservice/UnrelatedPolicy;'
        definitions[descriptor] = definitions.pop('La/b;')
        setter = next(item for item in definitions[PLUGIN]['methods'] if item['name'] == 'setClientEnabled')
        setter['types'] = [descriptor]
        with self.assertRaisesRegex(ValueError, 'persisted pause'):
            verify_lifecycle(definitions)

    def test_merged_function_still_requires_persisted_write(self):
        for removed in ['putBoolean', 'apply']:
            with self.subTest(removed=removed):
                definitions = fixture()
                definitions['La/b;']['interfaces'] = ['Ljava/lang/Runnable;']
                definitions['La/b;']['methods'][0]['calls'] = [call for call in definitions['La/b;']['methods'][0]['calls']
                                                             if call[1] != removed]
                with self.assertRaisesRegex(ValueError, 'persisted pause'):
                    verify_lifecycle(definitions)

    def test_merged_function_still_requires_pause_preference_keys(self):
        definitions = fixture()
        definitions['La/b;']['interfaces'] = ['Ljava/lang/Runnable;']
        definitions['La/b;']['methods'][0]['strings'] = ['unrelated']
        with self.assertRaisesRegex(ValueError, 'preference keys'):
            verify_lifecycle(definitions)

    def test_failed_gate_reports_symbols_without_dex_string_contents(self):
        definitions = fixture()
        setter = next(item for item in definitions[PLUGIN]['methods'] if item['name'] == 'setClientEnabled')
        setter['strings'] = ['fixture-private-string']
        with self.assertRaises(ValueError) as failure:
            verify_lifecycle(definitions)
        self.assertIn('reachable DEX symbols', str(failure.exception))
        self.assertIn('setClientEnabled', str(failure.exception))
        self.assertNotIn('fixture-private-string', str(failure.exception))

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

    def test_requested_stop_and_framework_destroy_are_separate(self):
        definitions = fixture()
        stopper = next(item for item in definitions[PLUGIN]['methods'] if item['name'] == 'stopVpn')
        self.assertFalse(any(call[1] in ['onRevoke', 'stopForeground'] for call in stopper['calls']))
        proof = verify_lifecycle(definitions, MAPPING)
        self.assertTrue(proof['explicit_stop_service_apis_preserved'])
        self.assertTrue(proof['framework_on_destroy_cleanup_preserved'])

    def test_stop_request_without_closing_tunnel_is_rejected(self):
        definitions = fixture()
        definitions[COMPANION]['methods'][0]['calls'] = [call for call in definitions[COMPANION]['methods'][0]['calls']
                                                         if call[1] != 'close']
        with self.assertRaisesRegex(ValueError, 'requested VPN tunnel close'):
            verify_lifecycle(definitions, MAPPING)

    def test_missing_framework_destroy_cleanup_is_rejected(self):
        definitions = fixture()
        destroyed = next(item for item in definitions[SERVICE]['methods'] if item['name'] == 'onDestroy')
        destroyed['calls'] = [call for call in destroyed['calls'] if call[1] != 'stopForeground']
        with self.assertRaisesRegex(ValueError, 'framework VPN destroy cleanup'):
            verify_lifecycle(definitions, MAPPING)

    def test_request_identity_fields_must_survive_reflection(self):
        definitions = fixture()
        arguments = definitions['Lcom/plugin/vpnservice/StartVpnArgs;']
        arguments['fields'] = [field for field in arguments['fields'] if field['name'] != 'requestId']
        with self.assertRaisesRegex(ValueError, 'reflected VPN argument fields'):
            verify_bridge_definitions(definitions)

    def test_framework_revoke_dispatch_can_follow_a_renamed_main_thread_closure(self):
        definitions = fixture()
        revoked = next(item for item in definitions[SERVICE]['methods'] if item['name'] == 'onRevoke')
        cleanup = method('run', '()V', calls=revoked['calls'])
        revoked['calls'], revoked['types'] = [], ['La/c;']
        definitions['La/c;'] = {'methods': [cleanup], 'fields': [], 'annotations': {}}
        mapping = MAPPING + 'com.plugin.vpnservice.TauriVpnService$onRevoke$1 -> a.c:\n'
        self.assertTrue(verify_lifecycle(definitions, mapping)['framework_revoke_cleanup_preserved'])

    def test_framework_revoke_without_real_close_is_rejected(self):
        definitions = fixture()
        revoked = next(item for item in definitions[SERVICE]['methods'] if item['name'] == 'onRevoke')
        revoked['calls'] = [call for call in revoked['calls'] if call[1] != 'close']
        with self.assertRaisesRegex(ValueError, 'framework VPN revoke cleanup'):
            verify_lifecycle(definitions, MAPPING)


if __name__ == "__main__":
    unittest.main()
