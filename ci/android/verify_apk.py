#!/usr/bin/env python3
"""Gate the real release APK, its embedded Core/React assets, JNI and 16 KiB ABI."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import struct
import subprocess
import zipfile

from dex_bridge import verify_apk_bridge
from signing import APPLICATION_ID, CERTIFICATE_SHA256, VERSION_CODE
from verify_page_size import extract_native_libs_from_manifest, inspect_native_libraries


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


def run(command, environment=None):
    result = subprocess.run(list(map(str, command)), capture_output=True, text=True, env=environment)
    check(result.returncode == 0, f"{Path(str(command[0])).name} verification failed")
    return result.stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apk", type=Path, required=True)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--sdk", type=Path, required=True)
    parser.add_argument("--jdk", type=Path, required=True)
    parser.add_argument("--native", type=Path, required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--proof", type=Path, required=True)
    args = parser.parse_args()
    check(bool(re.fullmatch("[0-9a-f]{40}", args.commit)), "full source commit required")
    check(run(["git", "-C", args.source, "rev-parse", "HEAD"]).strip() == args.commit,
          "verification source differs from the requested commit")
    config = json.loads((args.source / "easytier-gui/src-tauri/tauri.conf.json").read_text())
    version = config["version"]
    aapt = args.sdk / "build-tools/35.0.0/aapt"
    apksigner = args.sdk / "build-tools/35.0.0/apksigner"
    zipalign = args.sdk / "build-tools/35.0.0/zipalign"
    import os
    environment = dict(os.environ, JAVA_HOME=str(args.jdk),
                       PATH=str(args.jdk / "bin") + os.pathsep + os.environ.get("PATH", ""))
    certificates = run([apksigner, "verify", "--verbose", "--print-certs", args.apk], environment)
    fingerprints = re.findall(r"certificate SHA-256 digest:\s*([0-9a-fA-F:]+)", certificates)
    check(len(fingerprints) == 1 and fingerprints[0].replace(":", "").lower() == CERTIFICATE_SHA256,
          "APK signer differs from the existing adapted release certificate")
    badging = run([aapt, "dump", "badging", args.apk])
    package = re.search(r"^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'", badging, re.M)
    check(package and package.groups() == (APPLICATION_ID, str(VERSION_CODE), version), "APK package/version identity changed")
    check("platformBuildVersionCode='36'" in badging, "APK was not compiled against Android API 36")
    check(re.search(r"^sdkVersion:'24'$", badging, re.M), "APK minSdk must remain 24")
    check(re.search(r"^targetSdkVersion:'34'$", badging, re.M), "APK targetSdk must remain 34")
    check(re.search(r"^native-code:\s*'arm64-v8a'\s*$", badging, re.M), "APK must contain only arm64-v8a")
    check("launchable-activity: name='com.kkrainbow.easytier.MainActivity'" in badging, "Java/JNI launcher namespace changed")
    manifest = run([aapt, "dump", "xmltree", args.apk, "AndroidManifest.xml"])
    extract_native = extract_native_libs_from_manifest(manifest)
    alignment = run([zipalign, "-c", "-P", "16", "-v", "4", args.apk])
    check(any(text in alignment for text in ["Verification successful", "Verification succesful"]), "APK ZIP alignment verification failed")
    libraries = inspect_native_libraries(args.apk)
    for library in libraries:
        check(library["pt_load_segments"], "ELF contains no load segments")
        for segment in library["pt_load_segments"]:
            size = segment["align"]
            check(size >= 16384 and size & (size - 1) == 0, "ELF PT_LOAD alignment is below 16 KiB")
            check(segment["offset"] % size == segment["vaddr"] % size
                  and segment["offset"] % 16384 == segment["vaddr"] % 16384,
                  "ELF file and virtual addresses are not 16 KiB congruent")
        check(library["gnu_relro_segments"] and all(segment["end_virtual_address"] % 16384 == 0
                                                   for segment in library["gnu_relro_segments"]),
              "GNU_RELRO does not end at a 16 KiB boundary")
        check(extract_native is True or library["zip_stored_alignment_16k_pass"],
              "uncompressed native libraries must be ZIP aligned to 16 KiB")
    with zipfile.ZipFile(args.apk) as archive:
        check(archive.testzip() is None, "APK ZIP CRC check failed")
        metadata = archive.read("META-INF/com/android/build/gradle/app-metadata.properties").decode()
        check("androidGradlePluginVersion=8.10.1" in metadata, "APK was not built with AGP 8.10.1")
        library = archive.read("lib/arm64-v8a/libapp_lib.so")
        check(library[:6] == b"\x7fELF\x02\x01" and struct.unpack_from("<H", library, 18)[0] == 183,
              "embedded Core is not ELF64 AArch64")
        check(hashlib.sha256(library).digest() == hashlib.sha256(args.native.read_bytes()).digest(),
              "packaged JNI differs from the actual native build output")
        description = run(["git", "-C", args.source, "describe", "--abbrev=8", "--always", "--dirty=~"]).strip()
        check(not description.endswith("~"), "source checkout became dirty")
        # Match git_version!'s actual arguments, including annotated release
        # tags. On a tagged checkout Core intentionally reports the tag rather
        # than a bare short SHA; the manifest still binds the full commit.
        core_version = f"{version}-{description}"
        check(core_version.encode() in library and (core_version + "~").encode() not in library,
              "embedded Core does not report this clean source version")
        frontend = args.source / "easytier-gui/dist"
        assets = [path.relative_to(frontend).as_posix() for path in frontend.rglob("*") if path.is_file()]
        check("index.html" in assets and any(name.startswith("assets/") and name.endswith(".js") for name in assets),
              "React production assets are missing")
        check(all(name.encode() in library for name in assets), "JNI is missing a production frontend asset key (custom-protocol required)")
        check(any("font" in name.lower() and "notice" in name.lower() for name in assets), "font notices are missing")
        for entry in archive.namelist():
            check(not entry.lower().endswith((".jks", ".keystore", ".p12", "keystore.properties", "release.properties")),
                  "private signing files were packaged")
    mapping = args.source / "easytier-gui/src-tauri/gen/android/app/build/outputs/mapping/arm64Release/mapping.txt"
    check(mapping.is_file(), "R8 mapping required to verify the reflected JNI bridge")
    bridge = verify_apk_bridge(args.apk, mapping)
    proof = {
        "status": "PASS", "source_commit": args.commit, "version": version,
        "version_code": VERSION_CODE, "application_id": APPLICATION_ID, "abi": "arm64-v8a",
        "apk_sha256": hashlib.sha256(args.apk.read_bytes()).hexdigest(),
        "native_sha256": hashlib.sha256(library).hexdigest(), "core_version": core_version,
        "signing_certificate_sha256": CERTIFICATE_SHA256, "signature_verified": True,
        "compile_sdk": 36, "target_sdk": 34, "min_sdk": 24, "android_gradle_plugin": "8.10.1",
        "all_native_libraries_16k_compatible": True, "zip_16k_alignment": True,
        "embedded_frontend_asset_count": len(assets), "embedded_core_verified": True,
        "dex_reflection_bridge": bridge, "physical_android_device_tested": False,
    }
    args.proof.write_text(json.dumps(proof, indent=2) + "\n")
    print(json.dumps({"status": "PASS", "artifact": args.apk.name, "core_version": core_version,
                      "all_native_libraries_16k_compatible": True, "embedded_frontend_asset_count": len(assets)}))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError, KeyError) as error:
        raise SystemExit(str(error)) from None
