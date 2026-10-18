# Windows installer identity compatibility

The application display name is `EasyTier`. The executable and existing install
identity remain `easytier-gui` so changing the visible name does not create a new
Windows product or lose the previous installation location.

These templates derive from Tauri CLI 2.7.1 (the version pinned in
`easytier-gui/package.json`):

- [NSIS template](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.7.1/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi)
  original SHA-256: `fe22026f68bdb3292fab376756035496ce0a35e3d580e06ebaa6a28295916eb3`.
- [WiX template](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.7.1/crates/tauri-bundler/src/bundle/windows/msi/main.wxs)
  original SHA-256: `c49ce8f2f138b70d492ce3135436504e0cdacebd810baa3b59dd6054d42f562b`.

Tauri licenses this code under MIT or Apache-2.0. These copies use the MIT option;
its original copyright and license notice are included in `LICENSE-MIT-tauri`.

The local changes preserve the old NSIS uninstall key, manufacturer/product key,
installation directory, publisher, executable name and installation scope while
writing `EasyTier` as the display name. NSIS recognizes both old and new MSI display
names. A shortcut is renamed only after its target matches this installation's
executable; an unrelated existing shortcut is not overwritten. The unchanged
uninstall key is updated in place, so no second uninstall entry is created.

WiX retains the old install-directory and registry paths. Its explicit UpgradeCode
is the original CLI 2.7.1 default UUIDv5(DNS, `easytier-gui.exe.app.x64`):
`f8a6cf4a-bdd8-5924-ac7e-aa00c156b9c1`. ProductCode remains generated per package.
New shortcuts display `EasyTier`; related MSI upgrades remove the fixed legacy
shortcut names. The old upstream package skips shortcut removal during an upgrade,
which is why the cleanup components are needed.

Registry `Key` attributes use one literal backslash between names: XML does not
escape backslashes. The focused native WiX diagnostic run 39106948256 reproduced
`LGHT0204 / ICE03: Invalid registry path` for doubled separators in both its
control and cleanup fixtures. The verifier rejects that exact regression.

`ci/gui/verify.py` checks the actual generated NSIS/WiX scripts, extracts and hashes
the NSIS executable, and checks ProductName, Publisher and UpgradeCode from the real
MSI database. The local tests exercise the validation gates with source templates
and changed identities. These checks do not constitute an executed upgrade or
NSIS-to-MSI migration test. Native builds run only in GitHub Actions.
