#!/usr/bin/env python3
"""Run only in Windows CI: compare native WiX cleanup fixtures without Rust.

This creates diagnostic MSI files but never installs or publishes them. Actual
cleanup components are copied from the current application template unchanged.
No ICE validation is disabled and no business template is modified.
"""
from pathlib import Path, PurePosixPath
import argparse
import datetime
import hashlib
import json
import os
import re
import subprocess
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[2]
WIX_URL = 'https://github.com/wixtoolset/wix3/releases/download/wix3141rtm/wix314-binaries.zip'
WIX_SHA256 = '6ac824e1642d6f7277d0ed7ea09411a508f6116ba6fae0aa5f2c7daa2ff43d31'


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def component(template, identifier):
    found = re.findall(r'<Component\s+Id="' + re.escape(identifier) + r'"[^>]*>.*?</Component>', template, re.S)
    if len(found) != 1:
        raise RuntimeError('Expected exactly one original template component: ' + identifier)
    value = found[0].replace('{{product_name}}', 'EasyTier').replace('{{manufacturer}}', 'kkrainbow')
    if '{{' in value or '}}' in value:
        raise RuntimeError('Unexpected context in focused WiX component')
    return value


def render_fixture(template, fixture, cleanup):
    desktop = component(template, 'ApplicationShortcutDesktop')
    additions = {
        '@@APPLICATION_DESKTOP_COMPONENT@@': desktop,
        '@@LEGACY_DESKTOP_COMPONENT@@': component(template, 'LegacyDesktopCleanup') if cleanup else '',
        '@@LEGACY_STARTMENU_DIRECTORY@@': ('<Directory Id="LegacyApplicationProgramsFolder" Name="easytier-gui">\n'
            + component(template, 'LegacyStartMenuCleanup') + '\n</Directory>') if cleanup else '',
        '@@LEGACY_COMPONENT_REFS@@': ('<ComponentRef Id="LegacyDesktopCleanup" />\n'
                                     '<ComponentRef Id="LegacyStartMenuCleanup" />') if cleanup else '',
    }
    for marker, value in additions.items():
        if fixture.count(marker) != 1:
            raise RuntimeError('Diagnostic fixture marker is missing or ambiguous')
        fixture = fixture.replace(marker, value)
    return fixture


def tool(command, directory, output, label):
    result = subprocess.run(list(map(str, command)), cwd=directory, capture_output=True, timeout=120)
    stdout, stderr = result.stdout.decode('utf-8', errors='replace'), result.stderr.decode('utf-8', errors='replace')
    (output / (label + '.stdout.log')).write_text(stdout, encoding='utf-8')
    (output / (label + '.stderr.log')).write_text(stderr, encoding='utf-8')
    print('=== ' + label + ' exit=' + str(result.returncode) + ' ===', flush=True)
    print(stdout, end='', flush=True)
    print(stderr, end='', flush=True)
    return {'exit_code': result.returncode, 'stdout_sha256': digest(output / (label + '.stdout.log')),
            'stderr_sha256': digest(output / (label + '.stderr.log')),
            'validation_codes': sorted(set(re.findall(r'\b(?:ICE\d+|LGHT\d+|CNDL\d+)\b', stdout + stderr)))}


def extract_tools(package, destination):
    with zipfile.ZipFile(package) as archive:
        entries = archive.infolist()
        if len(entries) > 1000 or sum(item.file_size for item in entries) > 512 * 1024 * 1024:
            raise RuntimeError('Pinned WiX archive exceeds extraction bounds')
        for item in entries:
            name = item.filename.replace('\\', '/')
            parsed = PurePosixPath(name)
            if not parsed.parts or parsed.is_absolute() or '..' in parsed.parts or ':' in name:
                raise RuntimeError('Unsafe WiX archive path')
            mode = (item.external_attr >> 16) & 0o170000
            if mode not in {0, 0o100000, 0o040000}:
                raise RuntimeError('Nonregular WiX archive entry')
        archive.extractall(destination)
    if not all((destination / name).is_file() for name in ['candle.exe', 'light.exe', 'darice.cub']):
        raise RuntimeError('Pinned WiX tools are incomplete')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if os.name != 'nt' or os.environ.get('CI') != 'true':
        raise SystemExit('This native diagnostic may run only in Windows CI')
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    reports = output / 'reports'
    reports.mkdir()
    template_path = ROOT / 'easytier-gui/src-tauri/windows/main.wxs'
    fixture_path = ROOT / 'ci/gui/wix-cleanup-diagnostic.wxs'
    template, fixture = template_path.read_text(), fixture_path.read_text()
    package = output / 'wix314-binaries.zip'
    with urllib.request.urlopen(WIX_URL, timeout=60) as incoming, package.open('xb') as target:
        count = 0
        while chunk := incoming.read(1024 * 1024):
            count += len(chunk)
            if count > 128 * 1024 * 1024:
                raise RuntimeError('Pinned WiX download exceeds bounds')
            target.write(chunk)
    if digest(package) != WIX_SHA256:
        raise RuntimeError('WiX tool ZIP differs from Tauri CLI 2.7.1 pin')
    tools = output / 'tools'
    extract_tools(package, tools)
    payload = output / 'diagnostic-payload.txt'
    payload.write_text('EasyTier WiX cleanup diagnostic only. Never execute or install this package.\n')
    proof = {'source_commit': os.environ.get('GITHUB_SHA'), 'wix_url': WIX_URL,
             'wix_sha256': WIX_SHA256, 'template_sha256': digest(template_path),
             'fixture_sha256': digest(fixture_path), 'rust_built': False,
             'msi_installed_or_published': False, 'ice_validation_disabled': False, 'cases': {}}
    for label, cleanup in [('baseline', False), ('current-cleanup', True)]:
        wxs = reports / (label + '.wxs')
        obj, msi = reports / (label + '.wixobj'), output / (label + '.msi')
        wxs.write_text(render_fixture(template, fixture, cleanup), encoding='utf-8')
        candle = tool([tools / 'candle.exe', '-nologo', '-arch', 'x64', '-dPayloadPath=' + str(payload),
                       '-out', obj, wxs], reports, reports, label + '-candle')
        item = {'candle': candle, 'wxs_sha256': digest(wxs)}
        if candle['exit_code'] == 0:
            item['light'] = tool([tools / 'light.exe', '-nologo', '-v', '-out', msi, obj],
                                 reports, reports, label + '-light')
        proof['cases'][label] = item
    success = all(case['candle']['exit_code'] == 0 and case.get('light', {}).get('exit_code') == 0
                  for case in proof['cases'].values())
    proof.update(status='PASS' if success else 'FAIL', completed_at=datetime.datetime.now(datetime.timezone.utc).isoformat())
    (reports / 'diagnostic-proof.json').write_text(json.dumps(proof, indent=2) + '\n')
    print(json.dumps(proof, indent=2))
    if not success:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
