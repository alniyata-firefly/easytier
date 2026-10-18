#!/usr/bin/env python3
"""Build/run a disposable x86_64 debug Android IPC test on a hosted CI runner.

No release key, management controller, production network or publishing API is
used. Native compilation is deliberately refused outside GitHub Actions.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import zipfile

from build import prepare_offline_dependencies, run_logged
from signing import SECRETS

TOOLS = Path(__file__).resolve().parent
PACKAGE = "com.kkrainbow.easytier.adapted.debug"
TEST_CLASS = "com.kkrainbow.easytier.AndroidIpcSmokeTest"
IMAGE = "system-images;android-34;google_apis;x86_64"


def checked(command, *, env, cwd=None, timeout=120, input=None):
    result = subprocess.run(list(map(str, command)), env=env, cwd=cwd, input=input,
                            capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f"{Path(str(command[0])).name} failed: {result.stderr[-2000:]}")
    return result.stdout


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def debug_overlay():
    return {"build": {"beforeBuildCommand": None}, "app": {"windows": [{
        "label": "main", "title": "Android IPC smoke", "url": "ipc-smoke.html",
    }]}}


def native_command(pnpm, overlay):
    return [pnpm, "tauri", "android", "build", "--debug", "--apk", "--target", "x86_64",
            "--split-per-abi", "--features", "tauri/custom-protocol", "--config", overlay,
            "--ci", "--", "--locked"]


def instrumentation_build_command():
    # The Tauri CLI's native callback server exits after its APK build. Native
    # output is already built for this same debug variant; do not compile again
    # or invoke android-studio-script against an absent callback server.
    return ["./gradlew", ":app:assembleX86_64DebugAndroidTest", "-x", ":app:rustBuildX86_64Debug",
            "-PtargetList=x86_64", "-ParchList=x86_64", "-PabiList=x86_64", "--no-daemon"]


def validate_report(report):
    if report.get("status") != "PASS" or report.get("cycles") != 2:
        raise RuntimeError("Android report did not confirm both complete VPN cycles")
    events = report.get("events", [])
    passed = {event.get("phase") for event in events if event.get("status") == "pass"}
    required = {"cold_direct_js_status", "core_version", "local_rpc_init", "cold_validated_getter", "complete"}
    for cycle in (1, 2):
        required.update(f"{phase}_{cycle}" for phase in ["resume", "config_parse", "core_start", "vpn_permission",
                        "native_start", "native_owner", "native_establish_status", "rust_set_tun_fd", "validated_getter",
                        "system_vpn_present", "native_stop", "native_stopped_status", "rust_clear_tun_fd", "core_stop",
                        "stopped_validated_getter", "system_vpn_absent"])
        required.update(f"concurrent_status_{cycle}_{sample}" for sample in range(10))
    if not required <= passed or any(event.get("status") == "fail" for event in events):
        raise RuntimeError("Android report is missing successful real IPC stages")
    system = report.get("androidSystemObservations", [])
    for cycle in (1, 2):
        for prefix, value in [("system_vpn_present", True), ("system_vpn_absent", False)]:
            if not any(event.get("phase") == f"{prefix}_{cycle}" and event.get("vpnTransportPresent") is value for event in system):
                raise RuntimeError("Android report did not independently observe the system VPN transport")
    gui_events = report.get("guiEvents", [])
    gui_passed = {event.get("phase") for event in gui_events if event.get("status") == "pass"}
    gui_required = {"gui_fixture_prepare", "gui_index_navigation", "gui_complete"}
    for cycle in (1, 2):
        gui_required.update(f"{phase}_{cycle}" for phase in ["gui_connect_button", "gui_native_and_validated",
                            "gui_connected_stable", "gui_disconnect_button", "gui_stopped_native_and_validated"])
    if report.get("guiStatus") != "PASS" or not gui_required <= gui_passed or any(event.get("status") == "fail" for event in gui_events):
        raise RuntimeError("Android report did not confirm actual GUI Connect/Disconnect cycles")
    for cycle in (1, 2):
        live = next(event["details"] for event in gui_events if event.get("phase") == f"gui_native_and_validated_{cycle}" and event.get("status") == "pass")
        stopped = next(event["details"] for event in gui_events if event.get("phase") == f"gui_stopped_native_and_validated_{cycle}" and event.get("status") == "pass")
        if not all(live.get(key) is True for key in ["nativeEstablished", "correctInstance", "positiveFd", "validatedOwner", "connected", "vpnTransportPresent"]):
            raise RuntimeError("GUI label is not backed by native TUN, Core owner and system VPN")
        if stopped.get("nativeStopped") is not True or stopped.get("validatedCleared") is not True or stopped.get("vpnTransportPresent") is not False:
            raise RuntimeError("GUI Disconnect is not backed by native/Core/system VPN cleanup")


def environment(source, output):
    env = dict(os.environ)
    for name in [*SECRETS, "ET_ANDROID_KEYSTORE_PROPERTIES", "RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS",
                 "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER", "REMOVE_UNUSED_COMMANDS", "CARGO_BUILD_TARGET"]:
        env.pop(name, None)
    sdk = Path(env.get("ANDROID_HOME") or env.get("ANDROID_SDK_ROOT") or "")
    if not sdk.is_dir():
        raise RuntimeError("Android SDK is required")
    ndk = sdk / "ndk/26.0.10792818"
    env.update({
        "CI": "true", "ANDROID_HOME": str(sdk), "ANDROID_SDK_ROOT": str(sdk),
        "NDK_HOME": str(ndk), "ANDROID_NDK_HOME": str(ndk), "RUSTUP_TOOLCHAIN": "1.95",
        "CARGO_BUILD_JOBS": "2", "CARGO_INCREMENTAL": "0", "CARGO_PROFILE_DEV_DEBUG": "0",
        "CARGO_TARGET_DIR": str(output / "cargo-target"), "GRADLE_USER_HOME": str(output / "gradle-home"),
        "ANDROID_USER_HOME": str(output / "android-home"), "ANDROID_AVD_HOME": str(output / "avd"),
        "GRADLE_OPTS": "-Dorg.gradle.jvmargs=-Xmx2048m -Dorg.gradle.workers.max=2 -Dorg.gradle.daemon=false -Dorg.gradle.parallel=false",
        "ET_ANDROID_OVERLAY_ROOT": str(source / "easytier-gui/src-tauri/gen/android"),
    })
    env["PATH"] = os.pathsep.join([str(sdk / "platform-tools"), str(sdk / "emulator"),
                                   str(sdk / "cmdline-tools/latest/bin"),
                                   str(ndk / "toolchains/llvm/prebuilt/linux-x86_64/bin"), env["PATH"]])
    return env


def build(source, output, env):
    gui = source / "easytier-gui"
    android = gui / "src-tauri/gen/android"
    pnpm = shutil.which("pnpm", path=env["PATH"])
    if not pnpm:
        raise RuntimeError("pnpm is required")
    if not checked(["rustc", "--version"], env=env).startswith("rustc 1.95."):
        raise RuntimeError("Rust 1.95 is required")
    init = output / "gradle-home/init.d"
    init.mkdir(parents=True, exist_ok=True)
    shutil.copy2(TOOLS / "compat.init.gradle", init / "android-ci-compat.gradle")
    run_logged([pnpm, "--dir", "tauri-plugin-vpnservice", "build"], cwd=source, env=env,
               log=output / "vpnservice-frontend.log")
    run_logged([pnpm, "build"], cwd=gui, env=env, log=output / "frontend.log")
    # These assets are never copied into the production/public source tree.
    for name in ["ipc-smoke.html", "ipc-smoke.js"]:
        shutil.copy2(TOOLS / name, gui / "dist" / name)
    overlay = output / "smoke-tauri-config.json"
    overlay.write_text(json.dumps(debug_overlay()) + "\n")
    prepare_offline_dependencies(source, env, output)
    env["RUSTFLAGS"] = " ".join(["-Clink-arg=-landroid", "-Clink-arg=-llog", "-Clink-arg=-lOpenSLES",
                                     "-Clink-arg=-Wl,-z,max-page-size=16384", "-Clink-arg=-Wl,-z,common-page-size=16384"])
    started = time.time()
    run_logged(native_command(pnpm, overlay), cwd=gui, env=env, log=output / "debug-native-build.log")
    run_logged(instrumentation_build_command(), cwd=android, env=env, log=output / "instrumentation-build.log")
    candidates = [p for p in (android / "app/build/outputs/apk").rglob("*.apk")
                  if p.stat().st_mtime >= started - 1 and "debug" in str(p).lower() and "x86_64" in str(p)]
    apps = [p for p in candidates if "androidtest" not in str(p).lower()]
    tests = [p for p in candidates if "androidtest" in str(p).lower()]
    if len(apps) != 1 or len(tests) != 1:
        raise RuntimeError(f"expected one fresh x86_64 debug APK and test APK; found {len(apps)}/{len(tests)}")
    with zipfile.ZipFile(apps[0]) as apk:
        native = apk.read("lib/x86_64/libapp_lib.so")
        if native[:5] != b"\x7fELF\x02" or int.from_bytes(native[18:20], "little") != 62:
            raise RuntimeError("debug APK does not contain the actual x86_64 native runtime")
    proof = {"schema": 1, "status": "BUILT_DEBUG_ONLY", "sourceCommit": checked(["git", "rev-parse", "HEAD"], env=env, cwd=source).strip(),
             "package": PACKAGE, "abi": "x86_64", "signingSecretsUsed": False, "published": False,
             "app": str(apps[0]), "test": str(tests[0]), "apkSha256": digest(apps[0]),
             "testApkSha256": digest(tests[0]), "overlay": debug_overlay(),
             "testPageSha256": digest(TOOLS / "ipc-smoke.js")}
    (output / "build.json").write_text(json.dumps(proof, indent=2) + "\n")
    # Authenticated, one-day CI artifact for re-running the exact debug binaries
    # without a second Rust compilation. Never added to a GitHub Release.
    internal = output / "internal-debug-build"
    internal.mkdir(exist_ok=True)
    shutil.copy2(apps[0], internal / "app-debug.apk")
    shutil.copy2(tests[0], internal / "app-debug-androidTest.apk")
    public = {key: value for key, value in proof.items() if key not in ("app", "test")}
    (internal / "manifest.json").write_text(json.dumps(public, indent=2) + "\n")
    (output / "reports/build-proof.json").write_text(json.dumps(public, indent=2) + "\n")


def run(source, output, env):
    proof = json.loads((output / "build.json").read_text())
    current = checked(["git", "rev-parse", "HEAD"], env=env, cwd=source).strip()
    if proof["sourceCommit"] != current or digest(proof["app"]) != proof["apkSha256"] or digest(proof["test"]) != proof["testApkSha256"]:
        raise RuntimeError("debug build identity no longer matches this checkout")
    if not os.access("/dev/kvm", os.R_OK | os.W_OK):
        raise RuntimeError("emulator requires accessible /dev/kvm; no software-CPU fallback or repeated build")
    avd = output / "avd"
    avd.mkdir(exist_ok=True)
    checked(["avdmanager", "create", "avd", "--name", "easytier-ipc-smoke", "--package", IMAGE,
             "--force"], env=env, input="no\n", timeout=180)
    adb = ["adb", "-s", "emulator-5554"]
    emulator_log = (output / "emulator.log").open("w")
    emulator = subprocess.Popen(["emulator", "-avd", "easytier-ipc-smoke", "-port", "5554", "-no-window",
                                 "-no-audio", "-no-boot-anim", "-no-snapshot", "-gpu", "swiftshader_indirect",
                                 "-accel", "on", "-cores", "2", "-memory", "2048"],
                                env=env, stdout=emulator_log, stderr=subprocess.STDOUT)
    instrumentation = None
    try:
        checked([*adb, "wait-for-device"], env=env, timeout=120)
        deadline = time.monotonic() + 180
        while checked([*adb, "shell", "getprop", "sys.boot_completed"], env=env).strip() != "1":
            if time.monotonic() >= deadline or emulator.poll() is not None:
                raise RuntimeError("emulator did not complete boot")
            time.sleep(1)
        for setting in ["window_animation_scale", "transition_animation_scale", "animator_duration_scale"]:
            checked([*adb, "shell", "settings", "put", "global", setting, "0"], env=env)
        checked([*adb, "shell", "input", "keyevent", "82"], env=env)
        checked([*adb, "logcat", "-c"], env=env)
        for apk in [proof["app"], proof["test"]]:
            checked([*adb, "install", "-r", "-t", apk], env=env)
        result = subprocess.run([*adb, "shell", "am", "instrument", "-w", "-r", "-e", "class", TEST_CLASS,
                                 f"{PACKAGE}.test/androidx.test.runner.AndroidJUnitRunner"],
                                env=env, capture_output=True, text=True, timeout=390)
        instrumentation = result.stdout + result.stderr
        (output / "reports/instrumentation.txt").write_text(instrumentation)
        if result.returncode or "OK (1 test)" not in instrumentation or "FAILURES!!!" in instrumentation:
            print(instrumentation[-6000:], flush=True)
            raise RuntimeError("real Android IPC instrumentation failed")
    finally:
        try:
            result = checked([*adb, "exec-out", "run-as", PACKAGE, "cat", "files/android-ipc-smoke-report.json"], env=env, timeout=10)
            report = json.loads(result)
            report["sourceCommit"] = current
            report["emulatorOnly"] = True
            (output / "reports/ipc-smoke-report.json").write_text(json.dumps(report, indent=2) + "\n")
        except (RuntimeError, subprocess.TimeoutExpired, json.JSONDecodeError):
            report = {"status": "NO_COMPLETED_REPORT", "sourceCommit": current, "emulatorOnly": True}
            (output / "reports/ipc-smoke-report.json").write_text(json.dumps(report, indent=2) + "\n")
        try:
            log = checked([*adb, "logcat", "-d", "-v", "threadtime", "-s", "AndroidIpcSmoke:I", "AndroidRuntime:E", "*:S"],
                          env=env, timeout=10)
            (output / "reports/filtered-logcat.txt").write_text(log)
        except (RuntimeError, subprocess.TimeoutExpired):
            pass
        emulator.terminate()
        try:
            emulator.wait(timeout=15)
        except subprocess.TimeoutExpired:
            emulator.kill()
            emulator.wait(timeout=5)
        emulator_log.close()
    validate_report(report)
    print("Real Android IPC and actual GUI Connect/Disconnect, native TUN, Core ownership and system VPN: PASS", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phase", choices=["build", "run"], required=True)
    parser.add_argument("--source", type=Path, default=TOOLS.parents[1])
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("Android smoke native build/run is CI-only; no local native compilation")
    source, output = args.source.resolve(), args.output.resolve()
    if output == source or source in output.parents:
        raise RuntimeError("smoke output must be outside the source checkout")
    output.mkdir(parents=True, exist_ok=True)
    (output / "reports").mkdir(exist_ok=True)
    env = environment(source, output)
    if args.phase == "build":
        build(source, output, env)
    else:
        run(source, output, env)


if __name__ == "__main__":
    main()
