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
import re
import shutil
import stat
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

from build import prepare_offline_dependencies, run_logged
from signing import SECRETS

TOOLS = Path(__file__).resolve().parent
PACKAGE = "com.kkrainbow.easytier.adapted.debug"
TEST_CLASS = "com.kkrainbow.easytier.AndroidIpcSmokeTest"
IMAGE = "system-images;android-34;google_apis;x86_64"
DEBUG_ARTIFACT = "android-ipc-smoke-internal-debug"
MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


class ReadOnlyGitHub:
    """GET-only API; the signed archive redirect never receives the API token."""

    def __init__(self, repository):
        require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository), "Invalid repository")
        self.root = f"https://api.github.com/repos/{repository}/"
        self.token = os.environ.get("GH_TOKEN", "")
        require(bool(self.token), "Missing read-only workflow API token")
        self.opener = urllib.request.build_opener(NoRedirect)

    def request(self, endpoint):
        request = urllib.request.Request(self.root + endpoint, headers={
            "Authorization": f"Bearer {self.token}", "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "android-ipc-smoke-reuse",
        })
        return self.opener.open(request, timeout=180)

    def json(self, endpoint):
        try:
            with self.request(endpoint) as response:
                raw = response.read(1024 * 1024 + 1)
            require(len(raw) <= 1024 * 1024, "GitHub response exceeds size bound")
            return json.loads(raw)
        except Exception:
            raise RuntimeError("Read-only GitHub metadata request failed; remote details withheld") from None

    def archive(self, artifact_id, destination):
        try:
            try:
                response = self.request(f"actions/artifacts/{artifact_id}/zip")
            except urllib.error.HTTPError as redirect:
                require(redirect.code == 302, "Artifact archive did not redirect")
                location = redirect.headers.get("Location", "")
                parsed = urllib.parse.urlsplit(location)
                require(parsed.scheme == "https" and parsed.port in (None, 443)
                        and not parsed.username and not parsed.password
                        and any((parsed.hostname or "").endswith(suffix) for suffix in
                                [".blob.core.windows.net", ".actions.githubusercontent.com", ".githubusercontent.com"]),
                        "Invalid artifact download destination")
                # A new unauthenticated request: do not forward bearer credentials
                # from api.github.com to the signed blob-storage URL.
                response = self.opener.open(urllib.request.Request(location), timeout=180)
            with response, destination.open("xb") as stream:
                count = 0
                while chunk := response.read(1024 * 1024):
                    count += len(chunk)
                    require(count <= MAX_ARCHIVE_BYTES, "Artifact archive exceeds size bound")
                    stream.write(chunk)
        except Exception:
            raise RuntimeError("Read-only artifact download failed; signed URL and credentials withheld") from None


def source_artifact(api, repository, run_id, expected_commit):
    require(type(run_id) is int and run_id > 0, "Invalid source run ID")
    require(re.fullmatch(r"[0-9a-f]{40}", expected_commit or ""), "Expected a full source commit SHA")
    run = api.json(f"actions/runs/{run_id}")
    repo = run.get("repository", {})
    require(run.get("id") == run_id and run.get("head_sha") == expected_commit
            and run.get("status") == "completed" and run.get("conclusion") in ("success", "failure")
            and run.get("path") == ".github/workflows/android-ipc-smoke.yml"
            and repo.get("full_name", "").lower() == repository.lower()
            and type(repo.get("id")) is int and run.get("head_repository", {}).get("id") == repo["id"],
            "Source must be a completed same-repository Android smoke run at the expected commit")
    listing = api.json(f"actions/runs/{run_id}/artifacts?per_page=100")
    require(type(listing.get("total_count")) is int and listing["total_count"] <= 100
            and isinstance(listing.get("artifacts"), list), "Invalid source artifact listing")
    matches = [item for item in listing["artifacts"] if item.get("name") == DEBUG_ARTIFACT]
    require(len(matches) == 1, "Expected exactly one internal Android debug artifact")
    artifact = matches[0]
    binding = artifact.get("workflow_run", {})
    require(type(artifact.get("id")) is int and artifact["id"] > 0 and artifact.get("expired") is False
            and type(artifact.get("size_in_bytes")) is int and 0 < artifact["size_in_bytes"] <= MAX_ARCHIVE_BYTES
            and re.fullmatch(r"sha256:[0-9a-f]{64}", artifact.get("digest", ""))
            and binding.get("id") == run_id and binding.get("head_sha") == expected_commit
            and binding.get("repository_id") == repo["id"] and binding.get("head_repository_id") == repo["id"],
            "Internal artifact is expired or not bound to the source run")
    return artifact


def unpack_debug_archive(archive, artifact, expected_commit, destination):
    require(digest(archive) == artifact["digest"].removeprefix("sha256:"), "GitHub artifact archive digest mismatch")
    require(archive.stat().st_size == artifact["size_in_bytes"], "GitHub artifact archive size mismatch")
    with zipfile.ZipFile(archive) as package:
        entries = package.infolist()
        names = {entry.filename for entry in entries}
        require(len(entries) == 3 and names == {"app-debug.apk", "app-debug-androidTest.apk", "manifest.json"}
                and all(not entry.is_dir() and not stat.S_ISLNK(entry.external_attr >> 16)
                        and 0 < entry.file_size <= MAX_ARCHIVE_BYTES for entry in entries),
                "Internal artifact must contain exactly the two regular APKs and manifest")
        require(package.getinfo("manifest.json").file_size <= 64 * 1024, "Debug manifest exceeds size bound")
        manifest = json.loads(package.read("manifest.json"))
        require(manifest.get("schema") == 1 and manifest.get("status") == "BUILT_DEBUG_ONLY"
                and manifest.get("sourceCommit") == expected_commit and manifest.get("package") == PACKAGE
                and manifest.get("abi") == "x86_64" and manifest.get("signingSecretsUsed") is False
                and manifest.get("published") is False and manifest.get("overlay") == debug_overlay()
                and all(re.fullmatch(r"[0-9a-f]{64}", manifest.get(key, "")) for key in
                        ["apkSha256", "testApkSha256", "testPageSha256"]),
                "Debug manifest does not describe the exact unsigned-release-free source APKs")
        destination.mkdir(exist_ok=False)
        for name, key in [("app-debug.apk", "apkSha256"), ("app-debug-androidTest.apk", "testApkSha256")]:
            target = destination / name
            with package.open(name) as original, target.open("xb") as output:
                shutil.copyfileobj(original, output)
            require(digest(target) == manifest[key], "Original debug APK hash mismatch")
    return manifest


def import_debug_build(source, output, repository, run_id, expected_commit):
    api = ReadOnlyGitHub(repository)
    artifact = source_artifact(api, repository, run_id, expected_commit)
    archive = output / "original-debug-artifact.zip"
    api.archive(artifact["id"], archive)
    original = output / "reused-debug-build"
    manifest = unpack_debug_archive(archive, artifact, expected_commit, original)
    driver_commit = checked(["git", "rev-parse", "HEAD"], env=os.environ, cwd=source).strip()
    proof = dict(manifest, status="REUSED_DEBUG_ONLY", reused=True, driverCommit=driver_commit,
                 sourceRunId=run_id, artifactId=artifact["id"], artifactDigest=artifact["digest"],
                 artifactBytes=artifact["size_in_bytes"], repository=repository,
                 app=str(original / "app-debug.apk"), test=str(original / "app-debug-androidTest.apk"),
                 coverageNote="Original APKs reused unchanged; later product source changes are not covered.")
    (output / "build.json").write_text(json.dumps(proof, indent=2) + "\n")
    public = {key: value for key, value in proof.items() if key not in ("app", "test")}
    (output / "reports/build-proof.json").write_text(json.dumps(public, indent=2) + "\n")
    archive.unlink()
    print(f"Verified original debug APKs from run {run_id}, source {expected_commit}; no compilation", flush=True)


def checked(command, *, env, cwd=None, timeout=120, input=None):
    result = subprocess.run(list(map(str, command)), env=env, cwd=cwd, input=input,
                            capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f"{Path(str(command[0])).name} failed: {result.stderr[-2000:]}")
    return result.stdout


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


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
    queries = {event.get("phase") for event in events if event.get("status") == "query_response"}
    transitions = {event.get("phase") for event in events if event.get("status") == "transition_pass"}
    required = {"core_version", "local_rpc_init", "cold_validated_getter", "complete"}
    required_transitions = set()
    for cycle in (1, 2):
        required.update(f"{phase}_{cycle}" for phase in ["resume", "config_parse", "core_start", "vpn_permission",
                        "native_start", "native_owner", "rust_set_tun_fd", "validated_getter",
                        "system_vpn_present", "native_stop", "rust_clear_tun_fd", "core_stop",
                        "stopped_validated_getter", "system_vpn_absent"])
        required_transitions.update(f"{phase}_{cycle}" for phase in ["native_establish_status", "native_stopped_status"])
        required.update(f"concurrent_status_{cycle}_{sample}" for sample in range(10))
    if (not required <= passed or not required_transitions <= transitions
            or not (required_transitions | {"cold_direct_js_status"}) <= queries
            or any(event.get("status") == "fail" for event in events)):
        raise RuntimeError("Android report is missing successful real IPC stages")
    for cycle in (1, 2):
        stop_order = [(f"native_stop_{cycle}", "pass"), (f"rust_clear_tun_fd_{cycle}", "pass"),
                      (f"native_stopped_status_{cycle}", "transition_pass")]
        positions = [next(index for index, event in enumerate(events) if (event.get("phase"), event.get("status")) == stage)
                     for stage in stop_order]
        if positions != sorted(positions):
            raise RuntimeError("Native stop must release Core's TUN before awaiting service exit")
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
    for name in [*SECRETS, "GH_TOKEN", "GITHUB_TOKEN", "ET_ANDROID_KEYSTORE_PROPERTIES", "RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS",
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


def run_provenance(proof, current, api_level=34):
    identity = proof.get("driverCommit") if proof.get("reused") else proof["sourceCommit"]
    require(identity == current, "Debug build/driver identity no longer matches this checkout")
    require(api_level in (34, 36), "Only the API 34 and API 36 smoke checks are supported")
    image = f"system-images;android-{api_level};google_apis;x86_64"
    provenance = {"sourceCommit": proof["sourceCommit"], "driverCommit": current,
                  "apkReused": proof.get("reused", False), "apiLevel": api_level,
                  "systemImage": image, "emulatorOnly": True,
                  "apkSha256": proof["apkSha256"], "testApkSha256": proof["testApkSha256"]}
    if proof.get("reused"):
        provenance.update({key: proof[key] for key in ["sourceRunId", "artifactId", "artifactDigest", "coverageNote"]})
    return provenance


def run(source, output, env, api_level=34):
    proof = json.loads((output / "build.json").read_text())
    current = checked(["git", "rev-parse", "HEAD"], env=env, cwd=source).strip()
    provenance = run_provenance(proof, current, api_level)
    image = provenance["systemImage"]
    if digest(proof["app"]) != proof["apkSha256"] or digest(proof["test"]) != proof["testApkSha256"]:
        raise RuntimeError("Original debug APK hashes no longer match the verified build")
    if not os.access("/dev/kvm", os.R_OK | os.W_OK):
        raise RuntimeError("emulator requires accessible /dev/kvm; no software-CPU fallback or repeated build")
    avd = output / "avd"
    avd.mkdir(exist_ok=True)
    checked(["avdmanager", "create", "avd", "--name", "easytier-ipc-smoke", "--package", image,
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
        observed_api = checked([*adb, "shell", "getprop", "ro.build.version.sdk"], env=env).strip()
        require(observed_api == str(api_level), "Booted emulator does not match the requested Android API")
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
            report.update(provenance)
            (output / "reports/ipc-smoke-report.json").write_text(json.dumps(report, indent=2) + "\n")
        except (RuntimeError, subprocess.TimeoutExpired, json.JSONDecodeError):
            report = {"status": "NO_COMPLETED_REPORT", **provenance}
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
    parser.add_argument("--phase", choices=["build", "import", "run"], required=True)
    parser.add_argument("--source", type=Path, default=TOOLS.parents[1])
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--api-level", type=int, choices=[34, 36], default=34)
    parser.add_argument("--repository", default=os.environ.get("GITHUB_REPOSITORY", ""))
    parser.add_argument("--source-run-id", type=int)
    parser.add_argument("--expected-source-commit")
    args = parser.parse_args()
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("Android smoke native build/run is CI-only; no local native compilation")
    source, output = args.source.resolve(), args.output.resolve()
    if output == source or source in output.parents:
        raise RuntimeError("smoke output must be outside the source checkout")
    output.mkdir(parents=True, exist_ok=True)
    (output / "reports").mkdir(exist_ok=True)
    if args.phase == "import":
        import_debug_build(source, output, args.repository, args.source_run_id, args.expected_source_commit)
        return
    env = environment(source, output)
    if args.phase == "build":
        build(source, output, env)
    else:
        run(source, output, env, args.api_level)


if __name__ == "__main__":
    main()
