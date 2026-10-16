#!/usr/bin/env python3
"""Build the signed arm64 adapted APK from a clean checkout; no local paths."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

from signing import SECRETS, VERSION_CODE, property_value, require_secrets, signing_inputs

TOOLS = Path(__file__).resolve().parent


def checked(command, *, cwd=None, env=None):
    result = subprocess.run(list(map(str, command)), cwd=cwd, env=env, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f"{Path(str(command[0])).name} validation failed")
    return result.stdout.strip()


def run_logged(command, *, cwd, env, log):
    print(f"Running {Path(str(command[0])).name}; log: {log.name}", flush=True)
    with log.open("w") as stream:
        result = subprocess.run(list(map(str, command)), cwd=cwd, env=env,
                                stdout=stream, stderr=subprocess.STDOUT)
    if result.returncode:
        # Hosted runners disappear after the job. Publish useful diagnostics,
        # while withholding all credential values and private signing paths.
        text = redacted_log(log.read_text(errors="replace"), env)
        lines = text.splitlines()
        first = next((index for index, line in enumerate(lines)
                      if re.search(r"(^|\s)(error(?:\[[^]]+\])?:|FAILURE:|What went wrong:|Execution failed for task)", line)), None)
        if first is not None and first < max(0, len(lines) - 80):
            print("First build error (redacted):", flush=True)
            for line in lines[max(0, first - 3):first + 24]:
                print("| " + line, flush=True)
        print("Last 80 build-log lines (redacted):", flush=True)
        for line in lines[-80:]:
            print("| " + line, flush=True)
        raise RuntimeError(f"{log.name} failed (exit {result.returncode}); redacted diagnostics are above")


def redacted_log(text, environment):
    values = set()
    for name in SECRETS:
        value = os.environ.get(name)
        if value:
            values.update([value, property_value(value)])
            if name == "ANDROID_KEYSTORE_BASE64":
                values.add("".join(value.split()))
                values.update(line for line in value.splitlines() if len(line) >= 8)
    properties = environment.get("ET_ANDROID_KEYSTORE_PROPERTIES")
    if properties:
        values.update([properties, str(Path(properties).parent)])
    for value in sorted(values, key=len, reverse=True):
        text = text.replace(value, "[REDACTED]")
    return re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=TOOLS.parents[1])
    parser.add_argument("--sdk", type=Path, default=os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT"))
    parser.add_argument("--jdk", type=Path, default=os.environ.get("JAVA_HOME"))
    parser.add_argument("--output", type=Path, required=True, help="private build directory outside checkout")
    parser.add_argument("--jobs", type=int, choices=range(1, 5), default=2)
    parser.add_argument("--pnpm", default="pnpm")
    args = parser.parse_args()
    require_secrets()  # Fail before frontend/native work, never generate a key.
    source, output = args.source.resolve(), args.output.resolve()
    if output.is_relative_to(source):
        parser.error("--output must be outside the source checkout")
    if not args.sdk or not args.jdk:
        parser.error("--sdk/ANDROID_HOME and --jdk/JAVA_HOME are required")
    sdk, jdk = args.sdk.resolve(), args.jdk.resolve()
    pnpm = shutil.which(args.pnpm)
    if not pnpm:
        parser.error("pnpm is not installed")
    commit = checked(["git", "rev-parse", "HEAD"], cwd=source)
    if not re.fullmatch("[0-9a-f]{40}", commit):
        raise RuntimeError("a full source commit is required")
    if checked(["git", "status", "--porcelain", "--untracked-files=no"], cwd=source):
        raise RuntimeError("tracked source must be clean before release build")
    gui = source / "easytier-gui"
    config = json.loads((gui / "src-tauri/tauri.conf.json").read_text())
    version = config["version"]
    if version != "2.7.2" or config["bundle"]["android"]["versionCode"] != VERSION_CODE:
        raise RuntimeError("retain version 2.7.2 and versionCode 2007003 for this release")
    if not checked(["rustc", "--version"]).startswith("rustc 1.95."):
        raise RuntimeError("Rust 1.95 is required")
    ndk = sdk / "ndk/26.0.10792818"
    for path in [jdk / "bin/java", jdk / "bin/keytool", sdk / "platforms/android-36/android.jar",
                 sdk / "build-tools/35.0.0/apksigner", sdk / "build-tools/35.0.0/zipalign",
                 ndk / "toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android24-clang"]:
        if not path.is_file():
            raise RuntimeError(f"required tool is missing: {path.name}")
    if checked(["protoc", "--version"]) != "libprotoc 35.1":
        raise RuntimeError("protoc 35.1 is required for reproducible generated sources")
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    artifacts = output / "artifacts"
    artifacts.mkdir(mode=0o700, exist_ok=True)
    if any(artifacts.iterdir()):
        raise RuntimeError("artifact output must be empty; do not mix release runs")
    environment = dict(os.environ)
    for name in [*SECRETS, "RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "RUSTC_WRAPPER",
                 "RUSTC_WORKSPACE_WRAPPER", "REMOVE_UNUSED_COMMANDS"]:
        environment.pop(name, None)
    gradle_home = output / "gradle-home"
    init_dir = gradle_home / "init.d"
    init_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(TOOLS / "compat.init.gradle", init_dir / "android-ci-compat.gradle")
    android = gui / "src-tauri/gen/android"
    environment.update({
        "CI": "true", "JAVA_HOME": str(jdk), "ANDROID_HOME": str(sdk), "ANDROID_SDK_ROOT": str(sdk),
        "NDK_HOME": str(ndk), "ANDROID_NDK_HOME": str(ndk), "RUSTUP_TOOLCHAIN": "1.95",
        "CARGO_BUILD_JOBS": str(args.jobs), "CARGO_INCREMENTAL": "0",
        "CARGO_TARGET_DIR": str(output / "cargo-target"),
        "CARGO_PROFILE_RELEASE_LTO": "thin", "CARGO_PROFILE_RELEASE_CODEGEN_UNITS": "8",
        "GRADLE_USER_HOME": str(gradle_home), "ANDROID_USER_HOME": str(output / "android-home"),
        "GRADLE_OPTS": f"-Dorg.gradle.jvmargs=-Xmx2048m -Dorg.gradle.workers.max={args.jobs} -Dorg.gradle.daemon=false -Dorg.gradle.parallel=false",
        "ET_ANDROID_OVERLAY_ROOT": str(android),
        "PATH": os.pathsep.join([str(Path(pnpm).parent), str(jdk / "bin"),
                                 str(sdk / "platform-tools"), str(ndk / "toolchains/llvm/prebuilt/linux-x86_64/bin"), environment["PATH"]]),
    })
    started = time.time()
    with signing_inputs(jdk / "bin/keytool", source, os.environ.get("RUNNER_TEMP")) as (properties, private_key, secrets):
        environment["ET_ANDROID_KEYSTORE_PROPERTIES"] = str(properties)
        # Compile and tests never inherit the four signing-secret values.
        run_logged([pnpm, "--dir", "tauri-plugin-vpnservice", "build"], cwd=source, env=environment,
                   log=output / "vpnservice-frontend.log")
        run_logged([pnpm, "build"], cwd=gui, env=environment, log=output / "frontend.log")
        run_logged([pnpm, "exec", "vitest", "run", "src/native/mobile_vpn.test.ts",
                    "src/native/mobile_vpn_tile.test.ts", "src/native/session.test.ts",
                    "src/react/lib/node-config.test.ts", "--silent"],
                   cwd=gui, env=environment, log=output / "focused-tests.log")
        run_logged(["cargo", "fetch", "--locked", "--target", "aarch64-linux-android"],
                   cwd=source, env=environment, log=output / "cargo-fetch.log")
        # Tauri's CLI generates its own target rustflags. Global RUSTFLAGS has
        # Cargo precedence and retains its required Android libraries as well
        # as both flags from the proven 16 KiB build. Use the same flags for its
        # initial native build and its Gradle callback, including cached crates.
        environment["RUSTFLAGS"] = " ".join([
            "-Clink-arg=-landroid", "-Clink-arg=-llog", "-Clink-arg=-lOpenSLES",
            "-Clink-arg=-Wl,-z,max-page-size=16384", "-Clink-arg=-Wl,-z,common-page-size=16384",
        ])
        environment["CARGO_NET_OFFLINE"] = "true"
        overlay = output / "tauri-build.json"
        overlay.write_text(json.dumps({"build": {"beforeBuildCommand": None}}) + "\n")
        run_logged([pnpm, "tauri", "android", "build", "--apk", "--target", "aarch64", "--split-per-abi",
                    "--features", "tauri/custom-protocol", "--config", overlay, "--", "--locked"],
                   cwd=gui, env=environment, log=output / "android-build.log")
        if checked(["git", "diff", "HEAD", "--name-only"], cwd=source):
            raise RuntimeError("tracked source changed during release build")
        outputs = android / "app/build/outputs/apk"
        candidates = [path for path in outputs.rglob("*.apk") if "release" in path.parts
                      and path.stat().st_mtime >= started - 1]
        if len(candidates) != 1:
            raise RuntimeError(f"expected one freshly built arm64 release APK, found {len(candidates)}")
        destination = artifacts / f"easytier-gui-{version}-adapted-{commit[:8]}-arm64.apk"
        shutil.copy2(candidates[0], destination)
        verify = [sys.executable, TOOLS / "verify_apk.py", "--apk", destination, "--source", source,
                  "--sdk", sdk, "--jdk", jdk, "--commit", commit, "--proof", artifacts / "verification.json"]
        verify.extend(["--native", output / "cargo-target/aarch64-linux-android/release/libapp_lib.so"])
        run_logged(verify, cwd=source, env=environment, log=output / "verification.log")
        # Never distribute private signing material as application data.
        import zipfile
        with zipfile.ZipFile(destination) as archive:
            for entry in archive.infolist():
                payload = archive.read(entry)
                if private_key in payload or any(value.encode() in payload for name, value in secrets.items()
                                               if name != "ANDROID_KEYSTORE_BASE64" and len(value) >= 8):
                    raise RuntimeError("APK contains private signing material")
        sha_file = destination.with_suffix(".apk.sha256")
        sha_file.write_text(f"{digest(destination)}  {destination.name}\n")
    files = [{"path": path.name, "sha256": digest(path), "bytes": path.stat().st_size}
             for path in sorted(artifacts.iterdir()) if path.is_file()]
    manifest = {"source_commit": commit, "version": version, "platform": "android-arm64", "files": files,
                "application_id": "com.kkrainbow.easytier.adapted", "version_code": VERSION_CODE,
                "physical_android_device_tested": False}
    (artifacts / "build-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"status": "PASS", "source_commit": commit, "artifact": destination.name,
                      "elapsed_seconds": round(time.time() - started, 2)}))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, KeyError) as error:
        raise SystemExit(str(error)) from None
