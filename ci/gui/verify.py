#!/usr/bin/env python3
"""Verify real desktop payloads before collecting same-commit CI artifacts."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import struct
import subprocess
import sys
import tarfile
import xml.etree.ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from frontend_assets import verify_native_assets
from branding import ico_images, verify_icons
from prepare import BINARY, IDENTIFIER, LEGACY_PRODUCT, MSI_UPGRADE_CODE, PRODUCT, PUBLISHER, TARGETS, git, sha


def run(command, **kwargs):
    return subprocess.run(list(map(str, command)), capture_output=True, text=True, check=True, **kwargs)


def one(paths, label):
    paths = list(paths)
    if len(paths) != 1:
        raise RuntimeError('Expected exactly one ' + label)
    return paths[0]


def native_assets(release, binary, source, manifest):
    return verify_native_assets(release, binary, source / 'easytier-gui/dist', manifest)


def verify_nsis_identity(text, version):
    constants = dict(re.findall(r'^!define (\w+) "(.*)"$', text, re.M))
    identity = {'MANUFACTURER': PUBLISHER, 'PRODUCTNAME': PRODUCT, 'INSTALLMODE': 'currentUser',
                'MAINBINARYNAME': BINARY, 'BUNDLEID': IDENTIFIER, 'ARCH': 'x64',
                'LEGACYPRODUCTNAME': LEGACY_PRODUCT,
                'UNINSTKEY': r'Software\Microsoft\Windows\CurrentVersion\Uninstall\${LEGACYPRODUCTNAME}',
                'MANUPRODUCTKEY': r'${MANUKEY}\${LEGACYPRODUCTNAME}'}
    if any(constants.get(key) != value for key, value in identity.items()) or constants.get('VERSION') != version:
        raise RuntimeError('NSIS display name or stable installation identity changed')
    if (r'StrCpy $INSTDIR "$LOCALAPPDATA\${LEGACYPRODUCTNAME}"' not in text
            or '"DisplayName" "${PRODUCTNAME}"' not in text
            or 'StrCmp "$R0$R1" "${LEGACYPRODUCTNAME}${MANUFACTURER}" 0 wix_loop' not in text
            or text.count('!insertmacro MigrateLegacyShortcut ') != 4):
        raise RuntimeError('NSIS previous-installation and shortcut compatibility is missing')
    return identity


def verify_wix_identity(text, properties, version):
    if (properties['ProductName'] != PRODUCT or properties['ProductVersion'] != version
            or properties['Manufacturer'] != PUBLISHER
            or properties['UpgradeCode'].strip('{}').lower() != MSI_UPGRADE_CODE):
        raise RuntimeError('MSI display name or existing UpgradeCode changed')
    for field in ['ProductCode', 'UpgradeCode']:
        if not re.fullmatch(r'\{[0-9A-Fa-f-]{36}\}', properties[field]):
            raise RuntimeError('MSI identity GUID is missing')
    root = ET.fromstring(text)
    ns = {'w': 'http://schemas.microsoft.com/wix/2006/wi'}
    product = root.find('w:Product', ns)
    directory = root.find('.//w:Directory[@Id="INSTALLDIR"]', ns)
    searches = root.findall('.//w:Property[@Id="INSTALLDIR"]/w:RegistrySearch', ns)
    registry = root.findall('.//w:RegistryKey', ns) + root.findall('.//w:RegistryValue', ns)
    expected_key = r'Software\\' + PUBLISHER + r'\\' + LEGACY_PRODUCT
    if (product is None or product.get('Name') != PRODUCT
            or product.get('UpgradeCode', '').strip('{}').lower() != MSI_UPGRADE_CODE
            or directory is None or directory.get('Name') != LEGACY_PRODUCT
            or len(searches) != 2 or any(item.get('Key') != expected_key for item in searches)
            or not any(item.get('Key') == expected_key for item in registry)):
        raise RuntimeError('MSI existing installation directory/registry compatibility is missing')
    shortcuts = root.findall('.//w:Shortcut', ns)
    if not shortcuts or any(LEGACY_PRODUCT in item.get('Name', '') for item in shortcuts):
        raise RuntimeError('MSI shortcuts still expose the internal application name')
    return {'upgrade_code': MSI_UPGRADE_CODE, 'installation_registry_key': expected_key,
            'installation_directory_name': LEGACY_PRODUCT, 'display_name': PRODUCT,
            'shortcut_names': [item.get('Name') for item in shortcuts]}


def windows(release, binary_path, source, work, frozen):
    binary = binary_path.read_bytes()
    pe = struct.unpack_from('<I', binary, 0x3c)[0]
    if binary[pe:pe + 4] != b'PE\0\0' or struct.unpack_from('<H', binary, pe + 4)[0] != 0x8664:
        raise RuntimeError('The Windows application is not an x86_64 PE')
    nsis = one((release / 'bundle/nsis').glob('*-setup.exe'), 'NSIS installer')
    msi = one((release / 'bundle/msi').glob('*.msi'), 'MSI installer')
    expected_icons = ico_images((source / 'easytier-gui/src-tauri/icons/icon.ico').read_bytes())
    app_icons, setup_icons = verify_icons(binary, expected_icons), verify_icons(nsis.read_bytes(), expected_icons)
    script = release / 'nsis/x64/installer.nsi'
    text = script.read_text(encoding='utf-8-sig')
    identity = verify_nsis_identity(text, frozen['version'])
    hook = work / 'brand-hooks.nsh'
    if str(hook) not in text or hook.read_text().strip() != '!define MUI_UNICON "' + str(source / 'easytier-gui/src-tauri/icons/icon.ico') + '"':
        raise RuntimeError('NSIS installer/uninstaller do not share the canonical icon policy')
    extract = work / 'nsis-extracted'
    if extract.exists():
        raise RuntimeError('NSIS verification directory already exists')
    sevenzip = shutil.which('7z') or shutil.which('7z.exe')
    if not sevenzip:
        raise RuntimeError('7-Zip is required to inspect the actual NSIS payload')
    run([sevenzip, 't', nsis])
    run([sevenzip, 'x', '-y', '-o' + str(extract), nsis])
    payload = one(extract.rglob(BINARY + '.exe'), 'embedded NSIS application')
    if sha(payload) != sha(binary_path):
        raise RuntimeError('NSIS does not contain the freshly verified application')
    for item in frozen['vendor_files']:
        vendor = one(extract.rglob(item['name']), 'embedded ' + item['name'])
        if sha(vendor) != item['sha256']:
            raise RuntimeError('NSIS driver/DLL content differs from source')
    properties = json.loads(run(['powershell', '-NoProfile', '-NonInteractive', '-File',
        source / 'ci/gui/verify_msi.ps1', '-MsiPath', msi]).stdout)
    wix_identity = verify_wix_identity((release / 'wix/x64/main.wxs').read_text(encoding='utf-8-sig'), properties, frozen['version'])
    return [nsis, msi], {'application_pe_icons': app_icons, 'installer_pe_icons': setup_icons,
                        'nsis_identity': identity, 'nsis_payload_sha256': sha(payload),
                        'uninstaller_icon_policy_verified': True, 'msi_properties': properties,
                        'msi_installation_identity': wix_identity,
                        'installer_execution_or_nsis_to_msi_migration_tested': False}


def macos(release, source, work, frozen):
    app = one((release / 'bundle/macos').glob('*.app'), 'macOS application')
    dmg = one((release / 'bundle/dmg').glob('*.dmg'), 'DMG')
    with (app / 'Contents/Info.plist').open('rb') as stream:
        info = plistlib.load(stream)
    if info['CFBundleIdentifier'] != IDENTIFIER or info['CFBundleShortVersionString'] != frozen['version']:
        raise RuntimeError('macOS application identity or version changed')
    if (info['CFBundleExecutable'] != BINARY or info.get('CFBundleDisplayName') != PRODUCT
            or info.get('CFBundleName') != PRODUCT or app.name != PRODUCT + '.app'):
        raise RuntimeError('Unexpected macOS application executable')
    binary = app / 'Contents/MacOS' / info['CFBundleExecutable']
    expected_arch = 'arm64' if frozen['target'].startswith('aarch64') else 'x86_64'
    if run(['lipo', '-archs', binary]).stdout.strip() != expected_arch:
        raise RuntimeError('macOS binary architecture differs from its artifact label')
    icon_name = info['CFBundleIconFile']
    icon = app / 'Contents/Resources' / (icon_name if icon_name.endswith('.icns') else icon_name + '.icns')
    if sha(icon) != frozen['brand_files']['icon.icns']:
        raise RuntimeError('macOS application icon differs from source')
    run(['hdiutil', 'verify', dmg])
    run(['codesign', '--verify', '--deep', '--strict', app])
    signature = run(['codesign', '-dv', '--verbose=4', app]).stderr
    developer_id = 'Authority=Developer ID Application:' in signature
    if developer_id != frozen['macos_developer_id_requested']:
        raise RuntimeError('macOS signing mode differs from the requested mode')
    if developer_id:
        run(['xcrun', 'stapler', 'validate', app])
        run(['xcrun', 'stapler', 'validate', dmg])
    archive = work / (PRODUCT + '-' + frozen['version'] + '-' + expected_arch + '.app.tgz')
    if archive.exists():
        raise RuntimeError('macOS application archive already exists')
    with tarfile.open(archive, 'w:gz') as package:
        package.add(app, arcname=app.name, recursive=True)
    return binary, [dmg, archive], {'bundle_identifier': IDENTIFIER, 'architecture': expected_arch,
                                  'canonical_icns_verified': True, 'dmg_verified': True,
                                  'signing': 'developer-id-notarized' if developer_id else 'ad-hoc-no-apple-account',
                                  'native_gui_execution_tested': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--target', choices=sorted(TARGETS), required=True)
    parser.add_argument('--target-dir', type=Path, required=True)
    parser.add_argument('--work', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    source, work = args.source.resolve(), args.work.resolve()
    release = args.target_dir.resolve() / args.target / 'release'
    frozen_path = work / 'source-manifest.json'
    frozen = json.loads(frozen_path.read_text())
    if git(source, 'rev-parse', 'HEAD') != frozen['source_commit'] or frozen['target'] != args.target:
        raise RuntimeError('Source commit or target changed after the input freeze')
    if git(source, 'diff', '--name-only', 'HEAD'):
        raise RuntimeError('Tracked source changed during the build')
    for name, expected in frozen['brand_files'].items():
        if sha(source / 'easytier-gui/src-tauri/icons' / name) != expected:
            raise RuntimeError('Native icon changed after the input freeze')
    if args.target.endswith('windows-msvc'):
        binary = release / (BINARY + '.exe')
        products, brand = windows(release, binary, source, work, frozen)
        platform = 'gui-windows-x86_64'
    else:
        binary, products, brand = macos(release, source, work, frozen)
        platform = 'gui-macos-' + ('aarch64' if args.target.startswith('aarch64') else 'x86_64')
    native = binary.read_bytes()
    if frozen['expected_core_version'].encode() not in native:
        raise RuntimeError('The native application does not contain the expected embedded Core version')
    if (source / 'easytier-gui/src-tauri/icons/icon.png').read_bytes() not in native:
        raise RuntimeError('The canonical tray image is absent from the native executable')
    assets = native_assets(release, native, source, frozen)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    files = []
    for product in products:
        destination = output / product.name
        if destination.exists():
            raise RuntimeError('Distribution filenames collide')
        shutil.copy2(product, destination)
        files.append({'path': product.name, 'sha256': sha(destination), 'bytes': destination.stat().st_size})
    shutil.copyfile(frozen_path, output / 'source-manifest.json')
    proof = {'status': 'PASS', 'source_commit': frozen['source_commit'], 'version': frozen['version'],
             'platform': platform, 'target': args.target, 'native_binary_sha256': sha(binary),
             'embedded_core_version': frozen['expected_core_version'], 'core_embedded': True,
             'source_manifest_sha256': sha(frozen_path), 'brand': brand, 'embedded_frontend': assets,
             'verification_boundary': 'Real native payload, bundle identity and packaging checks; no GUI/VPN runtime or existing-installation upgrade claim.'}
    (output / 'verification-proof.json').write_text(json.dumps(proof, indent=2) + '\n')
    manifest = {'schema_version': 1, 'status': 'PASS', 'source_commit': frozen['source_commit'],
                'version': frozen['version'], 'platform': platform, 'target': args.target, 'files': files,
                'core_embedded': True, 'external_bin': [], 'identifier': IDENTIFIER,
                'product_name': PRODUCT, 'native_binary_name': BINARY,
                'source_manifest_sha256': sha(output / 'source-manifest.json'),
                'verification_proof_sha256': sha(output / 'verification-proof.json')}
    (output / 'build-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    (output / 'SHA256SUMS').write_text(''.join(item['sha256'] + '  ' + item['path'] + '\n' for item in files))
    print(json.dumps({'status': 'PASS', 'source_commit': frozen['source_commit'], 'platform': platform, 'files': len(files)}))


if __name__ == '__main__':
    main()
