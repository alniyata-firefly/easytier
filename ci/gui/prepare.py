#!/usr/bin/env python3
"""Freeze the React assets and prepare ignored, platform-specific CI inputs."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tomllib

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from frontend_assets import Head, freeze_frontend

TARGETS = {'x86_64-pc-windows-msvc', 'x86_64-apple-darwin', 'aarch64-apple-darwin'}
IDENTIFIER = 'com.kkrainbow.easytier'
PRODUCT = 'EasyTier'
BINARY = 'easytier-gui'
LEGACY_PRODUCT = 'easytier-gui'
PUBLISHER = 'kkrainbow'
# Tauri CLI 2.7.1's old default: UUIDv5(DNS, "easytier-gui.exe.app.x64").
MSI_UPGRADE_CODE = 'f8a6cf4a-bdd8-5924-ac7e-aa00c156b9c1'


def verify_installer_config(config, windows, cargo):
    if (config['version'] != '2.7.2' or config['identifier'] != IDENTIFIER
            or config['productName'] != PRODUCT or cargo['package']['name'] != BINARY
            or config.get('mainBinaryName', BINARY) != BINARY):
        raise RuntimeError('Application display name or stable native identity changed')
    if config['bundle'].get('publisher', PUBLISHER) != PUBLISHER:
        raise RuntimeError('The existing Windows publisher must remain stable')
    installers = windows['bundle']['windows']
    if (installers.get('wix', {}).get('upgradeCode', '').lower() != MSI_UPGRADE_CODE
            or installers.get('wix', {}).get('template') != 'windows/main.wxs'
            or installers.get('nsis', {}).get('template') != 'windows/installer.nsi'):
        raise RuntimeError('Windows installation identity compatibility settings are missing')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git(source, *args):
    return subprocess.check_output(['git', *args], cwd=source, text=True).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--target', choices=sorted(TARGETS), required=True)
    parser.add_argument('--work', type=Path, required=True)
    parser.add_argument('--macos-sign', action='store_true')
    args = parser.parse_args()
    source, work = args.source.resolve(), args.work.resolve()
    work.mkdir(parents=True, exist_ok=True)
    config = json.loads((source / 'easytier-gui/src-tauri/tauri.conf.json').read_text())
    windows = json.loads((source / 'easytier-gui/src-tauri/tauri.windows.conf.json').read_text())
    cargo = tomllib.loads((source / 'easytier-gui/src-tauri/Cargo.toml').read_text())
    verify_installer_config(config, windows, cargo)
    if windows['bundle']['externalBin'] != [] or 'easytier-core' not in cargo['dependencies']:
        raise RuntimeError('The GUI must contain Core as a Rust dependency, without external Core executables')
    dist = source / 'easytier-gui/dist'
    frontend = freeze_frontend(dist)
    overlay = {'build': {'beforeBuildCommand': None}, 'bundle': {'externalBin': []}}
    vendor = []
    if args.target.endswith('windows-msvc'):
        for name in ['Packet.dll', 'wintun.dll', 'WinDivert64.sys']:
            original = source / 'easytier/third_party/x86_64' / name
            destination = source / 'easytier-gui/src-tauri' / name
            shutil.copyfile(original, destination)
            vendor.append({'name': name, 'sha256': sha(original)})
        icon = source / 'easytier-gui/src-tauri/icons/icon.ico'
        if '"' in str(icon) or '$' in str(icon):
            raise RuntimeError('Unsafe NSIS icon path')
        # The locked Tauri CLI 2.7.1 supports installerHooks, but not the newer
        # uninstallerIcon setting. This hook is included before MUI pages.
        hook = work / 'brand-hooks.nsh'
        hook.write_text('!define MUI_UNICON "' + str(icon) + '"\n', encoding='utf-8')
        overlay['bundle']['windows'] = {'nsis': {'installerHooks': str(hook), 'installMode': 'currentUser'}}
    elif not args.macos_sign:
        # Apple Silicon requires ad-hoc signing. No Apple account, Developer ID
        # signature or notarization is used in the default build.
        overlay['bundle']['macOS'] = {'signingIdentity': '-'}
    (work / 'tauri-ci.json').write_text(json.dumps(overlay, indent=2) + '\n')
    commit = git(source, 'rev-parse', 'HEAD')
    describe = git(source, 'describe', '--abbrev=8', '--always', '--dirty=~')
    if describe.endswith('~'):
        raise RuntimeError('Tracked source changed before the GUI input freeze')
    manifest = {'schema_version': 1, 'source_commit': commit, 'version': config['version'],
                'expected_core_version': config['version'] + '-' + describe,
                'target': args.target, 'identifier': IDENTIFIER, 'product_name': PRODUCT,
                'native_binary_name': BINARY,
                'windows_upgrade_code': MSI_UPGRADE_CODE,
                'core_embedded': True, 'external_bin': [], **frontend, 'vendor_files': vendor,
                'brand_files': {name: sha(source / 'easytier-gui/src-tauri/icons' / name)
                                for name in ['icon.ico', 'icon.icns', 'icon.png']},
                'macos_developer_id_requested': args.macos_sign}
    (work / 'source-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'status': 'PASS', 'target': args.target, 'source_commit': commit, 'frontend_files': len(frontend['frontend_files'])}))


if __name__ == '__main__':
    main()
