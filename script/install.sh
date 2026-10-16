#!/usr/bin/env bash
# EasyTier downstream release installer. Origin: https://github.com/EasyTier/EasyTier
# License: GNU LGPL v3; see ../LICENSE. Previous installers remain in Git history.
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v python3 >/dev/null 2>&1; then
  echo 'Python 3 is required. Install python3, then run this script again.' >&2
  exit 1
fi
if [[ ! -f "$script_dir/release_downloader.py" ]]; then
  echo 'Keep release_downloader.py beside install.sh, or run from the full repository.' >&2
  exit 1
fi
exec python3 "$script_dir/release_downloader.py" "$@"
