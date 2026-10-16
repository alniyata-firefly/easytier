#!/usr/bin/env python3
"""Notarize signed DMGs without printing credentials or failed command lines."""
import argparse
import os
from pathlib import Path
import subprocess


def invoke(command):
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode:
        raise SystemExit('Apple notarization/stapling failed; credentials and tool output were suppressed')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle-dir', type=Path, required=True)
    args = parser.parse_args()
    credentials = {name: os.environ.get(name, '') for name in ['APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID']}
    if not all(credentials.values()):
        raise SystemExit('Missing Apple notarization credentials')
    packages = list(args.bundle_dir.glob('*.dmg'))
    if len(packages) != 1:
        raise SystemExit('Expected one DMG for notarization')
    for package in packages:
        invoke(['xcrun', 'notarytool', 'submit', str(package), '--apple-id', credentials['APPLE_ID'],
                '--password', credentials['APPLE_PASSWORD'], '--team-id', credentials['APPLE_TEAM_ID'],
                '--wait', '--timeout', '40m'])
        invoke(['xcrun', 'stapler', 'staple', str(package)])
        invoke(['xcrun', 'stapler', 'validate', str(package)])
    print('Signed DMG notarization and stapling passed')


if __name__ == '__main__':
    main()
