"""Local release-download/archive fixtures: never contact GitHub or execute a binary."""
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import stat
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

SCRIPT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("fork_release_downloader", SCRIPT / "release_downloader.py")
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)
COMMIT = "12345678" + "a" * 32
NAME = "easytier-linux-x86_64-2.7.2-12345678.tar.gz"


def release():
    def asset(name):
        return {"name": name, "browser_download_url": "https://github.com/alniyata-firefly/easytier/releases/download/v2.7.2/" + name}
    return {"draft": False, "prerelease": False, "tag_name": "v2.7.2", "assets": [asset(NAME), asset("SHA256SUMS")]}


def archive_bytes(extra=(), replace=None):
    contents = {name: b"fixture executable; never run" for name in installer.FILES if name.startswith("easytier-")}
    contents["LICENSE"] = b"fixture license"
    contents["source.json"] = json.dumps({"source_commit": COMMIT, "version": "2.7.2",
                                        "target": "x86_64-unknown-linux-musl"}).encode()
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w:gz") as archive:
        for name, data in contents.items():
            item = tarfile.TarInfo(name)
            item.size, item.mode = len(data), 0o7777
            if replace and replace[0] == name:
                item = replace[1]
            archive.addfile(item, io.BytesIO(data) if item.isreg() else None)
        for item in extra:
            archive.addfile(item, io.BytesIO(b"x" * item.size) if item.isreg() else None)
    return stream.getvalue()


class ReleaseInstallerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)
        self.network = patch.object(installer, "urlopen", side_effect=AssertionError("fixture must not use the network"))
        self.network.start()
        self.addCleanup(self.network.stop)

    def install(self, payload, destination=None, checksum=None):
        observed = []
        checksum = checksum if checksum is not None else hashlib.sha256(payload).hexdigest()
        def download(url, path, limit):
            observed.append(url)
            path.write_bytes((checksum + "  " + NAME + "\n").encode() if path.name == "SHA256SUMS" else payload)
        result = installer.install_release(release(), "x86_64", destination or self.root / "installed", download)
        return result, observed

    def test_real_archive_layout_checksum_modes_and_no_program_execution(self):
        with patch.object(subprocess, "run", side_effect=AssertionError("must not execute a program")):
            destination, observed = self.install(archive_bytes())
        self.assertEqual({path.name for path in destination.iterdir()}, installer.FILES)
        self.assertEqual(len(observed), 2)
        for path in destination.iterdir():
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o755 if path.name.startswith("easytier-") else 0o644)
        self.assertFalse(list(self.root.glob(".easytier-download-*")))

    def test_existing_empty_directory_is_supported(self):
        destination = self.root / "empty"
        destination.mkdir()
        self.assertEqual(self.install(archive_bytes(), destination)[0], destination)

    def test_nonempty_user_directory_is_never_changed(self):
        destination = self.root / "existing"
        destination.mkdir()
        existing = destination / "config.toml"
        existing.write_text("keep this configuration")
        with self.assertRaisesRegex(ValueError, "new or empty"):
            self.install(archive_bytes(), destination)
        self.assertEqual(existing.read_text(), "keep this configuration")
        self.assertEqual(list(destination.iterdir()), [existing])

    def test_symlink_destination_is_rejected(self):
        destination = self.root / "link"
        destination.symlink_to(self.root / "other", target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "new or empty"):
            self.install(archive_bytes(), destination)
        self.assertTrue(destination.is_symlink())

    def test_checksum_mismatch_installs_nothing(self):
        with self.assertRaisesRegex(ValueError, "SHA256 verification failed"):
            self.install(archive_bytes(), checksum="0" * 64)
        self.assertFalse((self.root / "installed").exists())
        self.assertFalse(list(self.root.glob(".easytier-download-*")))

    def test_checksum_requires_exactly_one_matching_filename(self):
        checksum = "a" * 64
        self.assertEqual(installer.expected_checksum(checksum + " *" + NAME, NAME), checksum)
        for text in [checksum + "  other.tar.gz", (checksum + "  " + NAME + "\n") * 2]:
            with self.subTest(text=text), self.assertRaisesRegex(ValueError, "exactly one"):
                installer.expected_checksum(text, NAME)

    def test_link_members_are_rejected_even_with_expected_names(self):
        for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.DIRTYPE, tarfile.GNUTYPE_SPARSE]:
            info = tarfile.TarInfo("easytier-core")
            info.type, info.linkname = kind, "easytier-cli"
            with self.subTest(kind=kind), self.assertRaisesRegex(ValueError, "ordinary files"):
                self.install(archive_bytes(replace=("easytier-core", info)))
        self.assertFalse((self.root / "installed").exists())

    def test_duplicate_traversal_absolute_and_unknown_members_are_rejected(self):
        for name in ["easytier-core", "../outside", "/tmp/outside", "sub/file", "config.toml"]:
            extra = tarfile.TarInfo(name)
            extra.size = 1
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "duplicate, missing or unexpected"):
                self.install(archive_bytes(extra=[extra]))
        self.assertFalse((self.root / "outside").exists())

    def test_archive_source_identity_must_match_asset_architecture_and_commit(self):
        payload = archive_bytes()
        unpacked = self.root / "unpacked"
        path = self.root / "release.tar.gz"
        path.write_bytes(payload)
        with self.assertRaisesRegex(ValueError, "source identity"):
            installer.unpack(path, unpacked, "2.7.2", "87654321", "x86_64")

    def test_missing_or_ambiguous_release_assets_never_fall_back_upstream(self):
        for changed in [dict(release(), assets=[]), dict(release(), prerelease=True), dict(release(), draft=True)]:
            with self.subTest(release=changed), self.assertRaises(ValueError):
                installer.select_assets(changed, "x86_64")
        ambiguous = release()
        ambiguous["assets"].append(copy.deepcopy(ambiguous["assets"][0]))
        with self.assertRaisesRegex(ValueError, "exactly one"):
            installer.select_assets(ambiguous, "x86_64")

    def test_upstream_or_external_download_url_is_rejected(self):
        item = release()["assets"][0]
        for url in [item["browser_download_url"].replace("alniyata-firefly/easytier", "EasyTier/EasyTier"),
                    item["browser_download_url"].replace("github.com", "example.test")]:
            with self.subTest(url=url), self.assertRaisesRegex(ValueError, "this fork"):
                installer.asset_url(dict(item, browser_download_url=url), "v2.7.2")

    def test_version_selection_and_missing_release_message(self):
        self.assertTrue(installer.release_url("2.7.2").endswith("/tags/v2.7.2"))
        self.assertTrue(installer.release_url("latest").endswith("/releases/latest"))
        with self.assertRaisesRegex(ValueError, "--version"):
            installer.release_url("../../upstream")
        with patch.object(installer, "urlopen", side_effect=HTTPError("fixture", 404, "not found", {}, None)):
            with self.assertRaisesRegex(ValueError, "never falls back"):
                installer.get_release("latest")

    @unittest.skipUnless(shutil.which("pwsh") or shutil.which("powershell"), "PowerShell is not installed on this host")
    def test_windows_selection_and_checksum_fixtures(self):
        shell = shutil.which("pwsh") or shutil.which("powershell")
        subprocess.run([shell, "-NoProfile", "-File", str(SCRIPT / "test_install.ps1")], check=True)


if __name__ == "__main__":
    unittest.main()
