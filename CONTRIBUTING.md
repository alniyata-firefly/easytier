# Contributing to this EasyTier fork

[简体中文](CONTRIBUTING_zh.md) | English

This guide applies to [alniyata-firefly/easytier](https://github.com/alniyata-firefly/easytier), a downstream adaptation of [EasyTier/EasyTier](https://github.com/EasyTier/EasyTier) with React Web, desktop, and mobile interfaces. Preserve upstream attribution, copyright notices, and the [GNU LGPL version 3 license](LICENSE). A contribution here is not automatically a contribution to upstream.

## Development environment

Use the versions used by the active workflows:

| Tool | Version |
| --- | --- |
| Node.js | 22 |
| pnpm | 10.12.4 |
| Rust | 1.95 |
| Protocol Buffers compiler (`protoc`) | 35.1 |
| Python | 3.12 in CI |

Native builds also need the compiler and platform libraries required by Tauri and Rust. Android packaging uses Java 21, Android SDK 36, Build Tools 35.0.0, and NDK 26.0.10792818; the current release workflow builds ARM64. See the [build guide](docs/github-actions.md) and active [workflows](.github/workflows) for setup and signing requirements.

```bash
git clone https://github.com/alniyata-firefly/easytier.git
cd easytier
git switch -c fix/describe-the-change main

# Use the same pnpm version throughout the workspace as CI.
export npm_config_manage_package_manager_versions=false
export npm_config_package_manager_strict=false
pnpm install --frozen-lockfile
pnpm --dir easytier-web/frontend-lib codegen:proto
```

Install the listed tools before running these commands. The root and GUI manifests pin pnpm 10.12.4. The environment variables above match CI and prevent external settings from switching package-manager versions.

## Source layout

| Path | Purpose |
| --- | --- |
| `easytier/` | Rust networking core |
| `easytier-web/src/` | Web API and management backend |
| `easytier-web/frontend/` | React management console |
| `easytier-gui/src/react/` | React desktop and mobile interface |
| `easytier-gui/src/native/` | Client session, storage, and native bridge |
| `tauri-plugin-vpnservice/` | Android VPN service and bridge |
| `easytier-web/frontend-lib/src/` | Shared TypeScript and generated protocol types |
| `ci/`, `.github/workflows/` | Current package verification and automation |

Default Web and GUI builds use React. Retained upstream Vue tools are optional source, not part of the default interface. Do not use a recursive workspace build to prepare a React-only change. Archived files in `.github/upstream-workflows/` are not active CI.

## Focused validation

Run checks relevant to the change from the repository root:

```bash
pnpm --dir easytier-web/frontend typecheck
pnpm --dir easytier-web/frontend test
pnpm --dir easytier-gui typecheck
pnpm --dir easytier-gui test:react
pnpm --dir easytier-gui test:native
python3 ci/test_artifacts.py
python3 ci/test_public_source.py
python3 ci/public_source.py
```

For the isolated local-configuration browser regression:

```bash
pnpm --dir easytier-gui exec playwright install --with-deps chromium
pnpm --dir easytier-gui exec node --test --test-concurrency=1 tests/local-config-offline-browser.test.mjs
```

This runs React with a mocked Tauri bridge on loopback and does not start a VPN. It cannot establish that native installers, Android lifecycle, or real tunnels work. Follow fixture or preview-server requirements and the source-check workflow for other browser tests.

For Rust changes, run formatting and relevant package tests rather than treating a complete release build as a unit test. Tests that alter routes, interfaces, firewall rules, or TUN devices belong in a disposable VM or isolated network namespace. Do not apply host-wide network changes for UI tests or use production credentials and networks as fixtures.

Release packaging, artifact verification, and optional signing are documented in [GitHub Actions builds](docs/github-actions.md). Signing files and passwords must remain outside Git; CI receives them through the documented Secrets. Ordinary pull requests must not require private signing credentials.

## Pull requests

Open issues in [this fork](https://github.com/alniyata-firefly/easytier/issues). Base changes on `main` and target `main`.

- Describe the concrete problem and resulting behavior; keep the change focused.
- Include relevant check results and distinguish mocked browser checks from native or live-network tests.
- For session, configuration, or protocol changes, describe compatibility, migration, and stop/start or reconnect behavior on affected platforms.
- Update documentation when commands or behavior change. Preserve existing options unless removing them is part of the agreed change.
- Remove credentials, token-bearing URLs, private keys, device identifiers, and private deployment details from logs, screenshots, fixtures, and commit history. The public-source check does not replace review.

For suspected vulnerabilities, follow the [security policy](.github/SECURITY.md) instead of publishing exploit details in an issue.
