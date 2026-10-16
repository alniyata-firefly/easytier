#!/usr/bin/env python3
"""Choose CI packages without exposing signing secret values."""
import json
import os
from pathlib import Path
import tomllib


def plan(env, version):
    event = env.get("GITHUB_EVENT_NAME", "push")
    tag = env.get("GITHUB_REF", "").startswith("refs/tags/")
    if tag and env["GITHUB_REF_NAME"] != f"v{version}":
        raise ValueError("release tag must match the Cargo package version")
    linux = env.get("WANT_LINUX") == "true"
    gui = env.get("WANT_GUI") == "true"
    android = env.get("WANT_ANDROID") == "true"
    if tag and not (linux and gui and android):
        raise ValueError("version tags require all Linux, GUI and signed Android packages")
    names = ("ANDROID_KEYSTORE_BASE64", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD")
    missing = [name for name in names if not env.get(name)]
    warning = None
    if android and missing:
        message = "Android signing secrets are missing: " + ", ".join(missing)
        if tag or event == "workflow_dispatch":
            raise ValueError(message + ". Configure repository Actions secrets or uncheck Android for a test build.")
        warning = message + ". Android is skipped on this branch push; the other packages will build."
        android = False
    platforms = ["web-static"]
    if linux:
        platforms += ["linux-x86_64", "linux-aarch64"]
    if gui:
        platforms += ["gui-windows-x86_64", "gui-macos-x86_64", "gui-macos-aarch64"]
    if android:
        platforms += ["android-arm64"]
    return {"linux": str(linux).lower(), "gui": str(gui).lower(), "android": str(android).lower(),
            "platforms": json.dumps(platforms)}, warning


def main():
    root = Path(__file__).resolve().parents[1]
    version = tomllib.loads((root / "easytier/Cargo.toml").read_text())["package"]["version"]
    outputs, warning = plan(os.environ, version)
    if warning:
        print("::warning::" + warning)
    with Path(os.environ["GITHUB_OUTPUT"]).open("a") as stream:
        for name, value in outputs.items():
            stream.write(f"{name}={value}\n")
    with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a") as stream:
        stream.write(f"Building EasyTier {version} from `{os.environ['GITHUB_SHA']}`.\n\n")
        stream.write("Platforms: " + ", ".join(json.loads(outputs["platforms"])) + ".\n")
        if warning:
            stream.write("\n" + warning + "\n")


if __name__ == "__main__":
    main()
