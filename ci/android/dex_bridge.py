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
                                        "annotations": method_annotations.get(index, {})})
            result[descriptor] = {"methods": methods, "fields": fields, "annotations": class_annotations}
        return result


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
    required_classes = ["com.kkrainbow.easytier.MainActivity", "com.kkrainbow.easytier.TauriActivity",
                        "com.plugin.vpnservice.VpnServicePlugin", "com.plugin.vpnservice.TauriVpnService",
                        "com.plugin.vpnservice.StartVpnArgs"]
    for name in required_classes:
        if "L" + name.replace(".", "/") + ";" not in definitions:
            raise ValueError(f"R8 removed or renamed required Android bridge class: {name}")
    plugin = definitions["Lcom/plugin/vpnservice/VpnServicePlugin;"]
    if plugin["annotations"].get("Lapp/tauri/annotation/TauriPlugin;") != 1:
        raise ValueError("R8 removed the runtime TauriPlugin annotation")
    commands = ["ping", "prepareVpn", "startVpn", "stopVpn", "getVpnStatus", "consumeVpnTileAction"]
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
    if mapping is not None:
        mapping_path = Path(mapping)
        mapping_payload = gzip.decompress(mapping_path.read_bytes()) if mapping_path.suffix == ".gz" else mapping_path.read_bytes()
        mapped = re.search(r"^androidx\.activity\.result\.ActivityResult -> ([^:]+):$",
                           mapping_payload.decode("utf-8"), re.M)
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
    required_fields = {"ipv4Addr", "routes", "dns", "disallowedApplications", "mtu"}
    if not required_fields <= fields:
        raise ValueError("R8 renamed or removed reflected VPN argument fields")
    return {"status": "PASS", "dex_files": dex_files, "required_classes_preserved": required_classes,
            "vpn_commands_preserved": checked, "runtime_annotations_preserved": True,
            "activity_constructor_preserved": True, "vpn_permission_callback_preserved": True,
            "activity_result_descriptor": activity_result, "r8_mapping_sha256": mapping_sha256,
            "vpn_argument_fields_preserved": sorted(required_fields), "static_check_only": True}


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
