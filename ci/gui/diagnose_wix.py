#!/usr/bin/env python3
"""Run only in Windows CI: render and validate focused native WiX fixtures.

This renders with the same pinned Handlebars engine as Tauri before creating
diagnostic MSI files. It never installs or publishes them. Actual cleanup
components are copied from the rendered application template unchanged.
No ICE validation is disabled and no business template is modified.
"""
from pathlib import Path, PurePosixPath
import argparse
import datetime
import hashlib
import json
import os
import re
import shutil
import subprocess
import tomllib
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[2]
WIX_URL = 'https://github.com/wixtoolset/wix3/releases/download/wix3141rtm/wix314-binaries.zip'
WIX_SHA256 = '6ac824e1642d6f7277d0ed7ea09411a508f6116ba6fae0aa5f2c7daa2ff43d31'
LEGACY_KEY = 'Software\\kkrainbow\\easytier-gui'
PROTOCOL_KEY = 'Software\\Classes\\easytier-diagnostic'


def validate_renderer_lock(original, resolved):
    """Allow Cargo to prune unused edges, never change locked package identities."""
    packages = lambda value: {(row['name'], row['version'], row.get('source')): row
                              for row in tomllib.loads(value)['package']}
    expected, actual = packages(original), packages(resolved)
    if not actual or not set(actual) <= set(expected):
        raise RuntimeError('Diagnostic renderer resolved packages outside the Tauri lock')
    for key, row in actual.items():
        if row.get('checksum') != expected[key].get('checksum'):
            raise RuntimeError('Diagnostic renderer registry checksum differs from the Tauri lock')
    for name, version in [('handlebars', '6.3.0'), ('serde_json', '1.0.140')]:
        if [(key[0], key[1]) for key in actual if key[0] == name] != [(name, version)]:
            raise RuntimeError('Diagnostic template engine differs from locked Tauri 2.7.1')
    return len(actual)


def validate_rendered_contract(text):
    if '{{' in text or '}}' in text:
        raise RuntimeError('Real renderer left unresolved Handlebars expressions')
    root = ET.fromstring(text)
    ns = {'w': 'http://schemas.microsoft.com/wix/2006/wi'}
    product = root.find('w:Product', ns)
    directory = root.find('.//w:Directory[@Id="INSTALLDIR"]', ns)
    keys = [item.get('Key', '') for item in root.iter() if 'Key' in item.attrib]
    searches = root.findall('.//w:Property[@Id="INSTALLDIR"]/w:RegistrySearch', ns)
    if (product is None or product.get('Name') != 'EasyTier' or product.get('Manufacturer') != 'kkrainbow'
            or product.get('UpgradeCode', '').strip('{}').lower() != 'f8a6cf4a-bdd8-5924-ac7e-aa00c156b9c1'
            or directory is None or directory.get('Name') != 'easytier-gui'
            or keys.count(LEGACY_KEY) != 8 or len(searches) != 2
            or any(item.get('Key') != LEGACY_KEY for item in searches)
            or keys.count(PROTOCOL_KEY) != 1 or any('\\\\' in key for key in keys)):
        raise RuntimeError('Real rendered legacy or protocol registry identity differs')
    return {'manufacturer': 'kkrainbow', 'legacy_registry_key_count': 8, 'protocol_registry_key': PROTOCOL_KEY,
            'unresolved_expressions': False, 'doubled_registry_separators': False}


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def component(template, identifier):
    found = re.findall(r'<Component\s+Id="' + re.escape(identifier) + r'"[^>]*>.*?</Component>', template, re.S)
    if len(found) != 1:
        raise RuntimeError('Expected exactly one original template component: ' + identifier)
    value = found[0]
    if '{{' in value or '}}' in value:
        raise RuntimeError('Unexpected context in focused WiX component')
    return value


def render_fixture(template, fixture, cleanup):
    validate_rendered_contract(template)
    desktop = component(template, 'ApplicationShortcutDesktop')
    additions = {
        '@@APPLICATION_DESKTOP_COMPONENT@@': desktop,
        '@@LEGACY_DESKTOP_COMPONENT@@': component(template, 'LegacyDesktopCleanup') if cleanup else '',
        '@@LEGACY_STARTMENU_DIRECTORY@@': ('<Directory Id="LegacyApplicationProgramsFolder" Name="easytier-gui">\n'
            + component(template, 'LegacyStartMenuCleanup') + '\n</Directory>') if cleanup else '',
        '@@LEGACY_COMPONENT_REFS@@': ('<ComponentRef Id="LegacyDesktopCleanup" />\n'
                                     '<ComponentRef Id="LegacyStartMenuCleanup" />') if cleanup else '',
        '@@PROTOCOL_REGISTRY_KEY@@': PROTOCOL_KEY,
    }
    for marker, value in additions.items():
        if fixture.count(marker) != 1:
            raise RuntimeError('Diagnostic fixture marker is missing or ambiguous')
        fixture = fixture.replace(marker, value)
    return fixture


def tool(command, directory, output, label, timeout=120, emit_output=True):
    result = subprocess.run(list(map(str, command)), cwd=directory, capture_output=True, timeout=timeout)
    stdout, stderr = result.stdout.decode('utf-8', errors='replace'), result.stderr.decode('utf-8', errors='replace')
    (output / (label + '.stdout.log')).write_text(stdout, encoding='utf-8')
    (output / (label + '.stderr.log')).write_text(stderr, encoding='utf-8')
    print('=== ' + label + ' exit=' + str(result.returncode) + ' ===', flush=True)
    if emit_output:
        print(stdout, end='', flush=True)
        print(stderr, end='', flush=True)
    return {'exit_code': result.returncode, 'stdout_sha256': digest(output / (label + '.stdout.log')),
            'stderr_sha256': digest(output / (label + '.stderr.log')),
            'diagnostics': [line for line in (stdout + stderr).splitlines()
                            if re.search(r'\b(?:error|warning) (?:LGHT|CNDL)\d+', line)],
            'validation_codes': sorted(set(re.findall(r'\b(?:ICE\d+|LGHT\d+|CNDL\d+)\b', stdout + stderr)))}


def build_renderer(output, reports):
    original = ROOT / 'ci/gui/wix-template-renderer'
    source = output / 'renderer-source'
    shutil.copytree(original, source, ignore=shutil.ignore_patterns('target'))
    locked = (original / 'Cargo.lock').read_text()
    resolution = tool(['cargo', 'metadata', '--format-version', '1', '--manifest-path', source / 'Cargo.toml'],
                      source, reports, 'renderer-resolve', timeout=600, emit_output=False)
    if resolution['exit_code']:
        raise RuntimeError('The isolated diagnostic renderer dependency resolution failed')
    resolved = source / 'Cargo.lock'
    count = validate_renderer_lock(locked, resolved.read_text())
    result = tool(['cargo', 'build', '--locked', '--release', '--manifest-path', source / 'Cargo.toml',
                   '--target-dir', output / 'renderer-target'], source, reports, 'renderer-build', timeout=600)
    if result['exit_code']:
        raise RuntimeError('The isolated pinned diagnostic renderer failed to build')
    validate_renderer_lock(locked, resolved.read_text())
    shutil.copyfile(resolved, reports / 'renderer-resolved-Cargo.lock')
    binary = output / 'renderer-target/release/easytier-wix-template-renderer.exe'
    if not binary.is_file():
        raise RuntimeError('The native diagnostic renderer executable is missing')
    return binary, {'handlebars_version': '6.3.0', 'serde_json_version': '1.0.140',
                    'escape_function': 'handlebars::no_escape', 'resolved_package_count': count,
                    'original_lock_sha256': digest(original / 'Cargo.lock'),
                    'resolved_lock_sha256': digest(resolved), 'binary_sha256': digest(binary),
                    'main_rs_sha256': digest(original / 'src/main.rs'), 'resolution': resolution, 'build': result}


def real_render(renderer, template, context, destination, reports, label):
    result = tool([renderer, template, context, destination], reports, reports, label)
    if result['exit_code']:
        raise RuntimeError('The pinned Handlebars renderer failed')
    return destination.read_text(encoding='utf-8')


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
             'fixture_sha256': digest(fixture_path), 'rust_built': True,
             'application_rust_built': False, 'diagnostic_renderer_built': True,
             'msi_installed_or_published': False, 'ice_validation_disabled': False, 'cases': {}}
    renderer, proof['renderer'] = build_renderer(output, reports)
    context = reports / 'render-context.json'
    context.write_text(json.dumps({'product_name': 'EasyTier', 'manufacturer': 'kkrainbow',
                                  'version': '2.7.2', 'upgrade_code': 'f8a6cf4a-bdd8-5924-ac7e-aa00c156b9c1',
                                  'bundle_id': 'com.kkrainbow.easytier', 'allow_downgrades': True,
                                  'path_component_guid': '09BC9A9F-217A-46CB-A147-70EF30A2E762',
                                  'main_binary_path': str(payload),
                                  'icon_path': str(ROOT / 'easytier-gui/src-tauri/icons/icon.ico'),
                                  'deep_link_protocols': ['easytier-diagnostic'], 'resources': ''}, indent=2))
    rendered_path = reports / 'actual-rendered-main.wxs'
    rendered = real_render(renderer, template_path, context, rendered_path, reports, 'render-application-template')
    proof['rendering_contract'] = validate_rendered_contract(rendered)
    proof['rendered_main_sha256'] = digest(rendered_path)
    # Prove this diagnostic distinguishes the exact escaped-expression bug that
    # a Python str.replace pseudo-render incorrectly certified previously.
    bad = template.replace(LEGACY_KEY, 'Software\\{{manufacturer}}\\easytier-gui')
    bad = bad.replace('Software\\Classes&#92;{{protocol}}', 'Software\\Classes\\{{protocol}}')
    if bad == template:
        raise RuntimeError('Escaped-expression negative control is missing')
    bad_template = output / 'escaped-boundary-negative.wxs'
    bad_template.write_text(bad, encoding='utf-8')
    bad_path = reports / 'actual-rendered-negative.wxs'
    invalid = real_render(renderer, bad_template, context, bad_path, reports, 'render-negative-control')
    try:
        validate_rendered_contract(invalid)
    except RuntimeError:
        proof['escaped_expression_negative_control_rejected'] = True
    else:
        raise RuntimeError('Real rendering did not reject the escaped-expression negative control')
    for label, cleanup in [('baseline', False), ('current-cleanup', True)]:
        wxs = reports / (label + '.wxs')
        obj, msi = reports / (label + '.wixobj'), output / (label + '.msi')
        wxs.write_text(render_fixture(rendered, fixture, cleanup), encoding='utf-8')
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
