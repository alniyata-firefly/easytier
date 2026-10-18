"""Small negative checks for the gate that prevents stale GUI payload releases."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import uuid
from unittest.mock import patch

from prepare import BINARY, Head, MSI_UPGRADE_CODE, PRODUCT, verify_installer_config
from frontend_assets import freeze_frontend
from verify import native_assets, verify_nsis_identity, verify_wix_identity


class InstallerBrandingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = Path(__file__).resolve().parents[2]
        cls.config = json.loads((cls.source / 'easytier-gui/src-tauri/tauri.conf.json').read_text())
        cls.windows = json.loads((cls.source / 'easytier-gui/src-tauri/tauri.windows.conf.json').read_text())
        import tomllib
        cls.cargo = tomllib.loads((cls.source / 'easytier-gui/src-tauri/Cargo.toml').read_text())
        cls.nsis = (cls.source / 'easytier-gui/src-tauri/windows/installer.nsi').read_text()
        cls.wix = (cls.source / 'easytier-gui/src-tauri/windows/main.wxs').read_text()
        # This substitutes the identity fields only; the real CLI renders and
        # compiles these templates on Windows CI before the artifact verifier.
        fields = {'product_name': PRODUCT, 'main_binary_name': BINARY,
                  'bundle_id': 'com.kkrainbow.easytier', 'manufacturer': 'kkrainbow',
                  'version': '2.7.2', 'install_mode': 'currentUser', 'arch': 'x64',
                  'upgrade_code': MSI_UPGRADE_CODE}
        for key, value in fields.items():
            cls.nsis = cls.nsis.replace('{{' + key + '}}', value)
            cls.wix = cls.wix.replace('{{' + key + '}}', value)
        cls.properties = {'ProductName': PRODUCT, 'ProductVersion': '2.7.2',
                          'Manufacturer': 'kkrainbow', 'UpgradeCode': '{' + MSI_UPGRADE_CODE.upper() + '}',
                          'ProductCode': '{12345678-1234-4234-9234-123456789ABC}'}

    def test_display_brand_keeps_binary_package_identifier_and_upgrade_code(self):
        verify_installer_config(self.config, self.windows, self.cargo)
        self.assertEqual(str(uuid.uuid5(uuid.NAMESPACE_DNS, 'easytier-gui.exe.app.x64')), MSI_UPGRADE_CODE)
        self.assertNotEqual(str(uuid.uuid5(uuid.NAMESPACE_DNS, 'EasyTier.exe.app.x64')), MSI_UPGRADE_CODE)

    def test_changed_legacy_upgrade_code_is_rejected_before_build(self):
        windows = json.loads(json.dumps(self.windows))
        windows['bundle']['windows']['wix']['upgradeCode'] = str(uuid.uuid4())
        with self.assertRaisesRegex(RuntimeError, 'compatibility'):
            verify_installer_config(self.config, windows, self.cargo)

    def test_nsis_easy_display_keeps_one_legacy_uninstaller_and_install_location(self):
        identity = verify_nsis_identity(self.nsis, '2.7.2')
        self.assertEqual(identity['PRODUCTNAME'], PRODUCT)
        self.assertEqual(identity['MAINBINARYNAME'], BINARY)
        self.assertLess(self.nsis.index('!macro MigrateLegacyShortcut'), self.nsis.index('Section Install'))
        migration = self.nsis.split('!macro MigrateLegacyShortcut', 1)[1].split('!macroend', 1)[0]
        self.assertIn('IsShortcutTarget "${OLD}" "$INSTDIR\\${MAINBINARYNAME}.exe"', migration)
        self.assertIn('IsShortcutTarget "${NEW}" "$INSTDIR\\${MAINBINARYNAME}.exe"', migration)

    def test_nsis_new_display_name_must_not_create_second_uninstall_key(self):
        bad = self.nsis.replace('Uninstall\\${LEGACYPRODUCTNAME}', 'Uninstall\\${PRODUCTNAME}')
        with self.assertRaisesRegex(RuntimeError, 'identity'):
            verify_nsis_identity(bad, '2.7.2')

    def test_msi_actual_properties_and_template_preserve_install_identity(self):
        result = verify_wix_identity(self.wix, self.properties, '2.7.2')
        self.assertEqual(result['installation_directory_name'], BINARY)
        self.assertTrue(all(BINARY not in name for name in result['shortcut_names']))

    def test_msi_new_default_upgrade_code_is_rejected(self):
        properties = dict(self.properties, UpgradeCode='{' + str(uuid.uuid5(uuid.NAMESPACE_DNS, 'EasyTier.exe.app.x64')) + '}')
        with self.assertRaisesRegex(RuntimeError, 'UpgradeCode'):
            verify_wix_identity(self.wix, properties, '2.7.2')

    def test_msi_install_directory_or_registry_rename_is_rejected(self):
        for bad in [self.wix.replace('Id="INSTALLDIR" Name="easytier-gui"', 'Id="INSTALLDIR" Name="EasyTier"'),
                    self.wix.replace('kkrainbow\\\\easytier-gui', 'kkrainbow\\\\EasyTier')]:
            with self.assertRaisesRegex(RuntimeError, 'compatibility'):
                verify_wix_identity(bad, self.properties, '2.7.2')


class PayloadGateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.source = Path(cls.temp.name) / 'source'
        cls.release = Path(cls.temp.name) / 'release'
        cls.dist = cls.source / 'easytier-gui/dist'
        cls.dist.mkdir(parents=True)
        cls.assets = cls.release / 'build/easytier-gui-test/out/tauri-codegen-assets'
        cls.assets.mkdir(parents=True)
        content = {'index.html': b'<html><script type="module" src="/assets/current.js"></script><link rel="stylesheet" href="/assets/current.css"></html>',
                   'assets/current.js': b'console.log("current React revision")',
                   'assets/current.css': b'body { color: #123456 }',
                   'fonts/font-notices.html': '<html>Complete font license: 鸿蒙字体与许可</html>'.encode('utf-8'),
                   'react-bundle-audit.json': json.dumps({'framework': 'react', 'react_module_count': 1,
                                                        'legacy_vue_module_count': 0}).encode()}
        for name, data in content.items():
            path = cls.dist / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        cls.frozen = freeze_frontend(cls.dist)
        command = "const fs=require('node:fs'),z=require('node:zlib'),p=require('node:path');for(const x of JSON.parse(fs.readFileSync(0,'utf8'))){fs.writeFileSync(p.join(process.argv[1],x.name.replaceAll('/','_')),z.brotliCompressSync(fs.readFileSync(x.file)));}"
        subprocess.run(['node', '-e', command, str(cls.assets)], input=json.dumps([
            {'name': name, 'file': str(cls.dist / name)} for name in content]), text=True, check=True)
        cls.encoded = {name: (cls.assets / name.replace('/', '_')).read_bytes() for name in content}
        cls.binary = b'native-prefix-fonts/font-notices.html\0' + b'\0'.join(cls.encoded.values())

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_current_compressed_assets_and_full_license_pass(self):
        result = native_assets(self.release, self.binary, self.source, self.frozen)
        self.assertEqual(result['non_entry_assets_verified'], 4)
        self.assertTrue(result['font_notice_full_html_verified'])

    def test_windows_ansi_locale_still_decodes_utf8_font_notices(self):
        with patch('locale.getencoding', return_value='cp1252'):
            result = native_assets(self.release, self.binary, self.source, self.frozen)
        self.assertTrue(result['font_notice_full_html_verified'])

    def test_native_payload_missing_current_script_is_rejected(self):
        encoded = self.encoded['assets/current.js']
        binary = self.binary.replace(encoded, b'\0' * len(encoded))
        with self.assertRaisesRegex(RuntimeError, 'absent from the native binary'):
            native_assets(self.release, binary, self.source, self.frozen)

    def test_license_content_without_runtime_route_is_rejected(self):
        binary = self.binary.replace(b'fonts/font-notices.html', b'fonts/missing-key.html')
        with self.assertRaisesRegex(RuntimeError, 'runtime route'):
            native_assets(self.release, binary, self.source, self.frozen)

    def test_frontend_mutation_after_freeze_is_rejected(self):
        frozen = json.loads(json.dumps(self.frozen))
        frozen['frontend_files'][1]['sha256'] = '0' * 64
        with self.assertRaisesRegex(RuntimeError, 'Frozen frontend changed'):
            native_assets(self.release, self.binary, self.source, frozen)

    def test_all_asset_keys_with_stale_content_are_rejected(self):
        encoded = self.encoded['assets/current.js']
        binary = self.binary.replace(encoded, b'assets/current.js' + b'\0' * len(encoded))
        with self.assertRaisesRegex(RuntimeError, 'absent from the native binary'):
            native_assets(self.release, binary, self.source, self.frozen)

    def test_report_is_frozen_and_must_be_embedded(self):
        self.assertIn('react-bundle-audit.json', [item['path'] for item in self.frozen['frontend_files']])
        binary = self.binary.replace(self.encoded['react-bundle-audit.json'], b'old-report')
        with self.assertRaisesRegex(RuntimeError, 'react-bundle-audit.json'):
            native_assets(self.release, binary, self.source, self.frozen)

    def test_unfrozen_extra_file_is_rejected(self):
        added = self.dist / 'unexpected.json'
        added.write_text('{}')
        try:
            with self.assertRaisesRegex(RuntimeError, 'Frozen frontend changed'):
                native_assets(self.release, self.binary, self.source, self.frozen)
        finally:
            added.unlink()

    def test_entry_parser_collects_module_and_stylesheet(self):
        head = Head()
        head.feed((self.dist / 'index.html').read_text())
        self.assertEqual(head.entries, self.frozen['entry_assets'])


if __name__ == '__main__':
    unittest.main()
