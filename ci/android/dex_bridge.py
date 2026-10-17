#!/usr/bin/env python3
"""Check the R8 output's actual Android JNI/reflection bridge, without a device."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
from pathlib import Path
import re
import struct
import sys
import zipfile


def instruction_evidence(units, strings, types, methods, fields):
    """Read references at instruction boundaries, never from operand/payload data.

    Widths follow the public DEX bytecode formats. This is a packaging regression
    gate, not an interpreter or a claim that Android lifecycle tests ran.
    """
    widths = {opcode: 1 for opcode in range(256)}
    for opcode in [2, 5, 8, 0x13, 0x15, 0x16, 0x19, 0x1a, 0x1c, 0x1f, 0x20, 0x22, 0x23, 0x29,
                   *range(0x2d, 0x3e), *range(0x44, 0x6e), *range(0x90, 0xb0), *range(0xd0, 0xe3), 0xfe, 0xff]:
        widths[opcode] = 2
    for opcode in [3, 6, 9, 0x14, 0x17, 0x1b, *range(0x24, 0x27), *range(0x2a, 0x2d),
                   *range(0x6e, 0x73), *range(0x74, 0x79), 0xfc, 0xfd]:
        widths[opcode] = 3
    widths.update({0x18: 5, 0xfa: 4, 0xfb: 4})
    calls, referenced_types, used_strings, literals = set(), set(), set(), set()
    field_reads, field_writes = set(), set()
    conditional = False
    offset = 0
    while offset < len(units):
        word = units[offset]
        opcode = word & 0xff
        width = widths[opcode]
        if opcode == 0 and word:
            if offset + 2 > len(units):
                raise ValueError("truncated DEX instruction payload")
            if word == 0x0100:
                width = 4 + units[offset + 1] * 2
            elif word == 0x0200:
                width = 2 + units[offset + 1] * 4
            elif word == 0x0300 and offset + 4 <= len(units):
                count = units[offset + 2] | units[offset + 3] << 16
                width = 4 + (units[offset + 1] * count + 1) // 2
            else:
                raise ValueError("unsupported DEX instruction payload")
        if offset + width > len(units):
            raise ValueError("truncated DEX instruction")
        if opcode in [*range(0x6e, 0x73), *range(0x74, 0x79), 0xfa, 0xfb]:
            method = methods[units[offset + 1]]
            calls.add(method)
        elif opcode in [0x1a, 0x1b]:
            index = units[offset + 1] | (units[offset + 2] << 16 if opcode == 0x1b else 0)
            used_strings.add(strings[index])
        elif opcode in [0x1c, 0x1f, 0x20, 0x22, 0x23, 0x24, 0x25]:
            referenced_types.add(types[units[offset + 1]])
        elif 0x52 <= opcode <= 0x6d:
            field = fields[units[offset + 1]]
            owner, _, field_type = field
            referenced_types.update([owner, field_type])
            (field_reads if opcode <= 0x58 or 0x60 <= opcode <= 0x66 else field_writes).add(field)
        elif opcode == 0x12:
            value = word >> 12
            literals.add(value - 16 if value & 8 else value)
        elif opcode in [0x13, 0x14]:
            value = units[offset + 1]
            bits = 16
            if opcode == 0x14:
                value |= units[offset + 2] << 16
                bits = 32
            literals.add(value - (1 << bits) if value & (1 << (bits - 1)) else value)
        conditional |= 0x32 <= opcode <= 0x3d
        offset += width
    return {"calls": sorted(calls), "types": sorted(referenced_types), "strings": sorted(used_strings),
            "field_reads": sorted(field_reads), "field_writes": sorted(field_writes),
            "literal_constants": sorted(literals), "has_conditional": conditional}


class Dex:
    def __init__(self, data):
        self.data = data
        if not data.startswith(b"dex\n") or data[7] != 0:
            raise ValueError("APK contains an unsupported DEX format")
        if self.u32(32) != len(data) or self.u32(40) != 0x12345678:
            raise ValueError("invalid DEX size or byte order")
        if hashlib.sha1(data[32:]).digest() != data[12:32]:
            raise ValueError("DEX SHA-1 integrity verification failed")
        self.strings = [self.string(self.u32(self.u32(60) + i * 4)) for i in range(self.u32(56))]
        self.types = [self.strings[self.u32(self.u32(68) + i * 4)] for i in range(self.u32(64))]
        self.methods = []
        for i in range(self.u32(88)):
            class_id, proto_id, name_id = struct.unpack_from("<HHI", data, self.u32(92) + i * 8)
            self.methods.append((self.types[class_id], self.strings[name_id], self.proto(proto_id)))
        self.fields = []
        for i in range(self.u32(80)):
            class_id, type_id, name_id = struct.unpack_from("<HHI", data, self.u32(84) + i * 8)
            self.fields.append((self.types[class_id], self.strings[name_id], self.types[type_id]))

    def u32(self, offset):
        return struct.unpack_from("<I", self.data, offset)[0]

    def uleb(self, offset):
        value, shift = 0, 0
        for _ in range(5):
            byte = self.data[offset]
            offset += 1
            value |= (byte & 0x7f) << shift
            if not byte & 0x80:
                return value, offset
            shift += 7
        raise ValueError("invalid DEX uleb128")

    def string(self, offset):
        _, offset = self.uleb(offset)
        end = self.data.index(0, offset)
        return self.data[offset:end].decode("utf-8", errors="replace")

    def proto(self, index):
        offset = self.u32(76) + index * 12
        result = self.types[self.u32(offset + 4)]
        arguments = self.u32(offset + 8)
        if not arguments:
            return "()" + result
        types = [self.types[struct.unpack_from("<H", self.data, arguments + 4 + i * 2)[0]]
                 for i in range(self.u32(arguments))]
        return "(" + "".join(types) + ")" + result

    def annotations(self, offset):
        if not offset:
            return {}
        result = {}
        for i in range(self.u32(offset)):
            item = self.u32(offset + 4 + i * 4)
            type_id, _ = self.uleb(item + 1)
            result[self.types[type_id]] = self.data[item]
        return result

    def code_evidence(self, offset):
        if not offset:
            return {}
        length = self.u32(offset + 12)
        units = struct.unpack_from(f"<{length}H", self.data, offset + 16)
        return instruction_evidence(units, self.strings, self.types, self.methods, self.fields)

    def definitions(self):
        result = {}
        for i in range(self.u32(96)):
            entry = self.u32(100) + i * 32
            descriptor = self.types[self.u32(entry)]
            annotation_directory = self.u32(entry + 20)
            method_annotations = {}
            class_annotations = {}
            if annotation_directory:
                class_annotations = self.annotations(self.u32(annotation_directory))
                fields_count, methods_count = struct.unpack_from("<II", self.data, annotation_directory + 4)
                offset = annotation_directory + 16 + fields_count * 8
                for j in range(methods_count):
                    method_id, annotations_offset = struct.unpack_from("<II", self.data, offset + j * 8)
                    method_annotations[method_id] = self.annotations(annotations_offset)
            methods, fields = [], []
            offset = self.u32(entry + 24)
            if offset:
                counts = []
                for _ in range(4):
                    value, offset = self.uleb(offset)
                    counts.append(value)
                for count in counts[:2]:
                    index = 0
                    for _ in range(count):
                        difference, offset = self.uleb(offset)
                        index += difference
                        access, offset = self.uleb(offset)
                        owner, name, field_type = self.fields[index]
                        fields.append({"name": name, "type": field_type, "access": access})
                for count in counts[2:]:
                    index = 0
                    for _ in range(count):
                        difference, offset = self.uleb(offset)
                        index += difference
                        access, offset = self.uleb(offset)
                        code_offset, offset = self.uleb(offset)
                        owner, name, signature = self.methods[index]
                        if owner != descriptor:
                            raise ValueError("DEX method/class ownership mismatch")
                        methods.append({"name": name, "signature": signature, "access": access,
                                        "code_present": bool(code_offset),
                                        "annotations": method_annotations.get(index, {}),
                                        **self.code_evidence(code_offset)})
            interfaces_offset = self.u32(entry + 12)
            interfaces = ([self.types[struct.unpack_from("<H", self.data, interfaces_offset + 4 + j * 2)[0]]
                           for j in range(self.u32(interfaces_offset))] if interfaces_offset else [])
            superclass_index = self.u32(entry + 8)
            result[descriptor] = {
                "methods": methods, "fields": fields, "annotations": class_annotations,
                "access": self.u32(entry + 4),
                "interfaces": interfaces,
                "superclass": None if superclass_index == 0xffffffff else self.types[superclass_index],
            }
        return result


def verify_lifecycle(definitions, mapping_text=""):
    """Follow R8-renamed helpers and require distinct management/VPN guards.

    R8 can inline or merge ClientForegroundPolicy, so do not require an
    implementation class/method name that is allowed to disappear. Android
    framework callbacks and reflected plugin commands remain stable roots.
    """
    prefixes = ("com.plugin.vpnservice.", "com.kkrainbow.easytier.")
    app_types = {descriptor for descriptor in definitions
                 if descriptor.replace("/", ".")[1:-1].startswith(prefixes)}
    closure_types = {descriptor for descriptor in app_types if "$" in descriptor and not descriptor.endswith("$Companion;")}
    class_mapping = dict(re.findall(r"^([^ #\s][^ ]*) -> ([^:]+):$", mapping_text, re.M))
    # Private lifecycle fields may be renamed even when the Android service
    # class is kept. Resolve their real identities from this build's mapping;
    # a field with the same short name in an unrelated class is not evidence.
    field_mapping = {}
    mapping_owner = None
    for line in mapping_text.splitlines():
        owner = re.match(r"^([^ #\s][^ ]*) -> ([^:]+):$", line)
        if owner:
            mapping_owner = owner.groups()
            continue
        field = re.match(r"^\s+[^ ()]+ ([^ ()]+) -> ([^ ]+)$", line)
        if mapping_owner and field:
            original, actual = field.groups()
            field_mapping[("L" + mapping_owner[0].replace(".", "/") + ";", original)] = (
                "L" + mapping_owner[1].replace(".", "/") + ";", actual)
    for original, actual in class_mapping.items():
        if original.startswith(prefixes):
            descriptor = "L" + actual.replace(".", "/") + ";"
            app_types.add(descriptor)
            if "$" in original and not original.endswith("$Companion"):
                closure_types.add(descriptor)
    # Desugared/merged lambdas can be assigned another original class's name
    # and have no app-prefixed class mapping. Use the actual DEX hierarchy to
    # identify their functional role. Only types referenced by reachable code
    # are followed below; an unrelated callback elsewhere is never evidence.
    functional_types = {"Ljava/lang/Runnable;"}
    functional_types.update("Lkotlin/jvm/functions/Function" + str(arity) + ";" for arity in range(23))
    for original in tuple(functional_types):
        mapped = class_mapping.get(original[1:-1].replace("/", "."))
        if mapped:
            functional_types.add("L" + mapped.replace(".", "/") + ";")
    changed = True
    while changed:
        changed = False
        for descriptor, definition in definitions.items():
            bases = [*definition.get("interfaces", []), definition.get("superclass")]
            if descriptor not in functional_types and any(base in functional_types for base in bases):
                functional_types.add(descriptor)
                changed = True
    closure_types.update(descriptor for descriptor in functional_types & definitions.keys()
                         if not definitions[descriptor].get("access", 0) & (0x200 | 0x400))
    method_map = {(owner, method["name"], method["signature"]): method
                  for owner, definition in definitions.items() for method in definition["methods"]}
    trace = {}

    def evidence(owner, name, signature):
        root = (owner, name, signature)
        if root not in method_map or not method_map[root]["code_present"]:
            raise ValueError("R8 removed a required Android lifecycle entry: " + name)
        pending, seen = [root], set()
        calls, strings, literals, referenced = set(), set(), set(), set()
        reads, writes = set(), set()
        conditional = False
        while pending:
            key = pending.pop()
            if key in seen:
                continue
            seen.add(key)
            method = method_map[key]
            calls.update(tuple(item) for item in method.get("calls", []))
            strings.update(method.get("strings", []))
            literals.update(method.get("literal_constants", []))
            referenced.update(method.get("types", []))
            reads.update(tuple(item) for item in method.get("field_reads", []))
            writes.update(tuple(item) for item in method.get("field_writes", []))
            conditional |= method.get("has_conditional", False)
            for call in method.get("calls", []):
                call = tuple(call)
                # R8 can move an app method to a library-named holder. Its
                # actual invoke edge remains authoritative; class-name
                # filtering would discard a real call. Do not guess virtual
                # implementations or collect unrelated methods from a class.
                if call in method_map and method_map[call]["code_present"]:
                    pending.append(call)
            # Runnable/Function closures may be passed to framework methods,
            # invoked later. Follow their actual post-R8 app class references.
            for descriptor in method.get("types", []):
                if descriptor in closure_types and descriptor in definitions:
                    pending.extend((descriptor, item["name"], item["signature"])
                                   for item in definitions[descriptor]["methods"])
        # Only symbols and counts enter failure diagnostics. Never emit DEX
        # string constants, payload bytes or source/signing file contents.
        trace.clear()
        trace.update(root=root, visited_count=len(seen), visited=sorted(seen)[:48],
                     call_count=len(calls), calls=sorted(calls)[:48],
                     referenced_type_count=len(referenced), referenced_types=sorted(referenced)[:48])
        return calls, strings, literals, conditional, reads, writes

    def fail_gate(message):
        raise ValueError(message + "; reachable DEX symbols: " + json.dumps(trace, separators=(",", ":")))

    def require_api(calls, name, signature, label):
        if not any(item[1] == name and item[2] == signature for item in calls):
            fail_gate("R8 lifecycle gate missing " + label + ": " + name)

    def require_fields(fields, owner, names, label):
        identities = {item[:2] for item in fields}
        for name in names:
            identity = field_mapping.get((owner, name), (owner, name))
            if identity not in identities:
                fail_gate("R8 lifecycle gate missing " + label + ": " + name)

    plugin = "Lcom/plugin/vpnservice/VpnServicePlugin;"
    setter, setter_strings, _, _, _, _ = evidence(plugin, "setClientEnabled", "(Lapp/tauri/plugin/Invoke;)V")
    require_api(setter, "putBoolean", "(Ljava/lang/String;Z)Landroid/content/SharedPreferences$Editor;", "persisted pause")
    require_api(setter, "apply", "()V", "persisted pause")
    require_api(setter, "stopService", "(Landroid/content/Intent;)Z", "paused foreground service")
    if not {"easytier_client_lifecycle", "enabled"} <= setter_strings:
        fail_gate("R8 lifecycle gate missing persisted pause preference keys")
    stopping, stop_strings, _, stop_conditional, _, stop_writes = evidence(plugin, "stopVpn", "(Lapp/tauri/plugin/Invoke;)V")
    require_api(stopping, "stopService", "(Landroid/content/Intent;)Z", "explicit VPN stop")
    require_api(stopping, "close", "()V", "requested VPN tunnel close")
    service = "Lcom/plugin/vpnservice/TauriVpnService;"
    require_fields(stop_writes, service, ["state", "establishedFd"], "pending VPN start cancellation")
    if not {"stopping", "stopped"} <= stop_strings or not stop_conditional:
        fail_gate("R8 lifecycle gate missing conditional pending VPN start cancellation")
    # Stop only requests shutdown. Android acknowledges real service exit via
    # onDestroy; do not require an early/manual onRevoke or foreground removal
    # inside the plugin command as proof of a completed stop.
    destroyed, _, _, _, _, _ = evidence(service, "onDestroy", "()V")
    require_api(destroyed, "close", "()V", "framework VPN destroy cleanup")
    require_api(destroyed, "stopForeground", "(I)V", "framework VPN destroy cleanup")
    revoked, _, _, _, _, _ = evidence(service, "onRevoke", "()V")
    require_api(revoked, "close", "()V", "framework VPN revoke cleanup")
    require_api(revoked, "stopSelf", "()V", "framework VPN revoke cleanup")
    signature = "(Landroid/content/Intent;II)I"
    calls, strings, literals, conditional, _, _ = evidence(
        "Lcom/kkrainbow/easytier/MainForegroundService;", "onStartCommand", signature)
    require_api(calls, "getBoolean", "(Ljava/lang/String;Z)Z", "saved management enabled guard")
    require_api(calls, "stopSelf", "()V", "paused management service stop")
    require_api(calls, "stopForeground", "(I)V", "paused foreground removal")
    if not {"easytier_client_lifecycle", "enabled"} <= strings or not conditional or not {1, 2} <= literals:
        fail_gate("R8 lifecycle gate missing conditional START_STICKY/START_NOT_STICKY management guard")

    # Management keepalive is independent of the VPN/TUN switch. Requiring its
    # saved boolean here would reintroduce the old coupling. The VPN service
    # instead rejects queued intents unless both owner IDs and state still
    # match the pending start; stop must invalidate that same state above.
    calls, strings, literals, conditional, reads, _ = evidence(service, "onStartCommand", signature)
    require_api(calls, "getStringExtra", "(Ljava/lang/String;)Ljava/lang/String;", "VPN intent identity guard")
    require_api(calls, "stopSelf", "()V", "cancelled VPN intent stop")
    require_fields(reads, service, ["requestId", "instanceId", "state"], "VPN request identity/state guard")
    if not {"REQUEST_ID", "INSTANCE_ID", "starting", "stopped", "stopping"} <= strings or not conditional or not {1, 2} <= literals:
        fail_gate("R8 lifecycle gate missing conditional START_STICKY/START_NOT_STICKY VPN intent guard")
    return {"set_client_enabled_persists_management_intent": True, "explicit_stop_service_apis_preserved": True,
            "framework_on_destroy_cleanup_preserved": True,
            "framework_revoke_cleanup_preserved": True,
            "main_foreground_management_guard_preserved": True,
            "vpn_request_identity_guard_preserved": True, "vpn_stop_invalidates_pending_start": True,
            "r8_application_helpers_followed": True,
            "static_check_only": True}


def verify_apk_bridge(apk, mapping=None):
    definitions, dex_files = {}, []
    with zipfile.ZipFile(apk) as archive:
        for name in archive.namelist():
            if name.startswith("classes") and name.endswith(".dex") and "/" not in name:
                payload = archive.read(name)
                dex_files.append({"name": name, "sha256": hashlib.sha256(payload).hexdigest()})
                for descriptor, definition in Dex(payload).definitions().items():
                    if descriptor in definitions:
                        raise ValueError("duplicate DEX class definition")
                    definitions[descriptor] = definition
    if not dex_files:
        raise ValueError("APK has no DEX files")
    result = verify_bridge_definitions(definitions, mapping)
    result["dex_files"] = dex_files
    return result


def verify_bridge_definitions(definitions, mapping=None):
    required_classes = ["com.kkrainbow.easytier.MainActivity", "com.kkrainbow.easytier.TauriActivity",
                        "com.plugin.vpnservice.VpnServicePlugin", "com.plugin.vpnservice.TauriVpnService",
                        "com.plugin.vpnservice.StartVpnArgs", "com.plugin.vpnservice.SetClientEnabledArgs",
                        "com.kkrainbow.easytier.MainForegroundService"]
    for name in required_classes:
        if "L" + name.replace(".", "/") + ";" not in definitions:
            raise ValueError(f"R8 removed or renamed required Android bridge class: {name}")
    plugin = definitions["Lcom/plugin/vpnservice/VpnServicePlugin;"]
    if plugin["annotations"].get("Lapp/tauri/annotation/TauriPlugin;") != 1:
        raise ValueError("R8 removed the runtime TauriPlugin annotation")
    commands = ["ping", "prepareVpn", "startVpn", "stopVpn", "getVpnStatus", "consumeVpnTileAction", "setClientEnabled"]
    checked = []
    for command in commands:
        found = [method for method in plugin["methods"] if method["name"] == command
                 and method["signature"] == "(Lapp/tauri/plugin/Invoke;)V" and method["access"] & 1
                 and method["code_present"]
                 and method["annotations"].get("Lapp/tauri/annotation/Command;") == 1]
        if len(found) != 1:
            raise ValueError(f"R8 damaged the reflected VPN command signature or annotation: {command}")
        checked.append(command)
    constructors = [method for method in plugin["methods"] if method["name"] == "<init>"
                    and method["signature"] == "(Landroid/app/Activity;)V" and method["access"] & 1
                    and method["code_present"]]
    if len(constructors) != 1:
        raise ValueError("R8 damaged the plugin's reflected Activity constructor")
    # R8 may rename an AndroidX parameter class, while preserving the reflected
    # callback name/annotation and the same class identity at both call sites.
    # Resolve this type only from the actual build's mapping; never guess it.
    activity_result = "Landroidx/activity/result/ActivityResult;"
    mapping_sha256 = None
    mapping_text = ""
    if mapping is not None:
        mapping_path = Path(mapping)
        mapping_payload = gzip.decompress(mapping_path.read_bytes()) if mapping_path.suffix == ".gz" else mapping_path.read_bytes()
        mapping_text = mapping_payload.decode("utf-8")
        mapped = re.search(r"^androidx\.activity\.result\.ActivityResult -> ([^:]+):$", mapping_text, re.M)
        if mapped:
            activity_result = "L" + mapped.group(1).replace(".", "/") + ";"
        mapping_sha256 = hashlib.sha256(mapping_payload).hexdigest()
    if activity_result not in definitions:
        raise ValueError("actual mapped ActivityResult class is absent from the DEX")
    callback = [method for method in plugin["methods"] if method["name"] == "onPrepareVpnResult"
                and method["signature"] == f"(Lapp/tauri/plugin/Invoke;{activity_result})V"
                and method["annotations"].get("Lapp/tauri/annotation/ActivityCallback;") == 1]
    if len(callback) != 1:
        raise ValueError("R8 damaged the reflected VPN permission callback")
    fields = {field["name"] for field in definitions["Lcom/plugin/vpnservice/StartVpnArgs;"]["fields"]}
    required_fields = {"requestId", "instanceId", "ipv4Addr", "routes", "dns", "disallowedApplications", "mtu"}
    if not required_fields <= fields:
        raise ValueError("R8 renamed or removed reflected VPN argument fields")
    client_fields = definitions["Lcom/plugin/vpnservice/SetClientEnabledArgs;"]["fields"]
    if not any(field["name"] == "enabled" and field["type"] == "Z" for field in client_fields):
        raise ValueError("R8 renamed or removed the reflected client enabled boolean")
    lifecycle = verify_lifecycle(definitions, mapping_text)
    return {"status": "PASS", "required_classes_preserved": required_classes,
            "vpn_commands_preserved": checked, "runtime_annotations_preserved": True,
            "activity_constructor_preserved": True, "vpn_permission_callback_preserved": True,
            "activity_result_descriptor": activity_result, "r8_mapping_sha256": mapping_sha256,
            "vpn_argument_fields_preserved": sorted(required_fields), "client_enabled_argument_preserved": True,
            "client_lifecycle": lifecycle, "static_check_only": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=Path)
    parser.add_argument("--proof", type=Path)
    parser.add_argument("--mapping", type=Path, help="actual R8 mapping for renamed AndroidX callback parameter classes")
    args = parser.parse_args()
    result = verify_apk_bridge(args.apk, args.mapping)
    if args.proof:
        args.proof.parent.mkdir(parents=True, exist_ok=True)
        args.proof.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
