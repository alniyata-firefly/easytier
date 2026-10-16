#!/usr/bin/env python3
"""Inspect the actual APK for 16 KiB loading compatibility; never install it."""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import re
import struct
import subprocess
import zipfile


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def read_elf_segments(payload):
    if payload[:6] != b'\x7fELF\x02\x01':
        raise ValueError('native library must be little-endian ELF64')
    offset = struct.unpack_from('<Q', payload, 32)[0]
    size, count = struct.unpack_from('<HH', payload, 54)
    if size < 56 or count == 0 or offset + size * count > len(payload):
        raise ValueError('invalid ELF64 program-header table')
    loads, relro = [], []
    for index in range(count):
        kind, _, file_offset, vaddr, _, file_size, mem_size, align = struct.unpack_from(
            '<IIQQQQQQ', payload, offset + index * size)
        if kind == 1:
            loads.append(dict(index=index, offset=file_offset, vaddr=vaddr,
                              mem_size=mem_size, file_size=file_size, align=align))
        elif kind == 0x6474e552:
            relro.append(dict(index=index, vaddr=vaddr, mem_size=mem_size,
                              end_virtual_address=vaddr + mem_size))
    return {'pt_load_segments': loads, 'gnu_relro_segments': relro}


def inspect_native_libraries(apk, page_size=16384):
    libraries = []
    with zipfile.ZipFile(apk) as archive, Path(apk).open('rb') as raw:
        entries = [entry for entry in archive.infolist()
                   if entry.filename.startswith('lib/') and entry.filename.endswith('.so')]
        if not entries or len({entry.filename for entry in entries}) != len(entries):
            raise ValueError('APK must contain unique native libraries')
        for entry in sorted(entries, key=lambda item: item.filename):
            payload = archive.read(entry)
            raw.seek(entry.header_offset)
            header = raw.read(30)
            if header[:4] != b'PK\x03\x04':
                raise ValueError('invalid ZIP local file header')
            name_size, extra_size = struct.unpack_from('<HH', header, 26)
            data_offset = entry.header_offset + 30 + name_size + extra_size
            libraries.append({
                'member': entry.filename, 'sha256': hashlib.sha256(payload).hexdigest(),
                **read_elf_segments(payload), 'zip_compression_method': entry.compress_type,
                'zip_data_offset': data_offset,
                'zip_stored_alignment_16k_pass': entry.compress_type == zipfile.ZIP_STORED
                    and data_offset % page_size == 0,
            })
    return libraries


def extract_native_libs_from_manifest(text):
    matches = re.findall(r'android:extractNativeLibs\([^\n]*?\)=([^\r\n]*)', text)
    if len(matches) > 1:
        raise ValueError('multiple extractNativeLibs manifest attributes')
    if not matches:
        return None
    value = matches[0].strip()
    if re.fullmatch(r'\(type 0x12\)0x0+', value):
        return False
    if re.fullmatch(r'\(type 0x12\)0x[fF]+', value):
        return True
    raise ValueError('unsupported extractNativeLibs manifest value')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--apk', type=Path, required=True)
    parser.add_argument('--sdk', type=Path, required=True)
    parser.add_argument('--proof', type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch('[0-9a-f]{40}', args.commit):
        parser.error('a full frozen source commit is required')
    apk = args.apk.resolve()
    aapt = args.sdk / 'build-tools/35.0.0/aapt'
    zipalign = args.sdk / 'build-tools/35.0.0/zipalign'
    manifest = subprocess.run([str(aapt), 'dump', 'xmltree', str(apk), 'AndroidManifest.xml'],
                              capture_output=True, text=True, check=True).stdout
    extract_native_libs = extract_native_libs_from_manifest(manifest)
    libraries = inspect_native_libraries(apk)
    primary = next(item for item in libraries if item['member'] == 'lib/arm64-v8a/libapp_lib.so')
    log = args.proof.with_name('page-size-zipalign.log')
    command = [str(zipalign), '-c', '-P', '16', '-v', '4', str(apk)]
    result = subprocess.run(command, capture_output=True, text=True)
    log.write_text(result.stdout + result.stderr)
    load_alignment = all(item['pt_load_segments'] and all(
        segment['align'] >= 16384 and segment['align'] & (segment['align'] - 1) == 0
        for segment in item['pt_load_segments']) for item in libraries)
    load_congruence = all(item['pt_load_segments'] and all(
        segment['offset'] % 16384 == segment['vaddr'] % 16384
        and segment['align'] > 0
        and segment['offset'] % segment['align'] == segment['vaddr'] % segment['align']
        for segment in item['pt_load_segments']) for item in libraries)
    relro_alignment = all(item['gnu_relro_segments'] and all(
        segment['end_virtual_address'] % 16384 == 0
        for segment in item['gnu_relro_segments']) for item in libraries)
    zipalign_pass = result.returncode == 0 and any(
        message in result.stdout for message in ('Verification successful', 'Verification succesful'))
    zip_policy = extract_native_libs is True or all(item['zip_stored_alignment_16k_pass'] for item in libraries)
    passed = all([load_alignment, load_congruence, relro_alignment, zipalign_pass, zip_policy])
    record = {
        'format_version': 1, 'status': 'PASS' if passed else 'BLOCKED_16K_ALIGNMENT',
        'source_commit': args.commit, 'artifact': str(apk), 'artifact_sha256': digest(apk),
        'native_library_member': primary['member'], 'native_library_sha256': primary['sha256'],
        'page_size_bytes': 16384, 'pt_load_alignment_pass': load_alignment,
        'pt_load_congruence_pass': load_congruence, 'gnu_relro_end_alignment_pass': relro_alignment,
        'zipalign_16k_pass': zipalign_pass, 'native_zip_policy_pass': zip_policy,
        'extract_native_libs': extract_native_libs,
        'zipalign': {'tool': str(zipalign), 'returncode': result.returncode,
                     'log': str(log.resolve()), 'log_sha256': digest(log)},
        'native_libraries': libraries, 'physical_android_device_tested': False,
        'checked_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    args.proof.write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps({key: record[key] for key in ['status', 'source_commit', 'artifact_sha256',
        'pt_load_alignment_pass', 'pt_load_congruence_pass', 'gnu_relro_end_alignment_pass',
        'zipalign_16k_pass', 'native_zip_policy_pass']}, indent=2))
    return 0 if passed else 2


if __name__ == '__main__':
    raise SystemExit(main())
