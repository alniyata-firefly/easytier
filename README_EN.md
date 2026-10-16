# EasyTier · React Console and Clients

<p align="center"><img src="assets/brand/easytier.svg" width="80" height="80" alt="EasyTier three-node mark"/></p>

An independently maintained EasyTier adaptation for self-hosted networks, with a React Web console, desktop and Android clients embedding Core, and Linux Core / CLI / Web packages.

[![Build packages](https://github.com/alniyata-firefly/easytier/actions/workflows/packages.yml/badge.svg)](https://github.com/alniyata-firefly/easytier/actions/workflows/packages.yml)
[![Source checks](https://github.com/alniyata-firefly/easytier/actions/workflows/checks.yml/badge.svg)](https://github.com/alniyata-firefly/easytier/actions/workflows/checks.yml)
[![LGPL-3.0](https://img.shields.io/github/license/alniyata-firefly/easytier)](LICENSE)

[简体中文](README.md) | [English](README_EN.md)

[Releases](https://github.com/alniyata-firefly/easytier/releases) · [Builds](https://github.com/alniyata-firefly/easytier/actions/workflows/packages.yml) · [Installation](docs/installation.md) · [Issues](https://github.com/alniyata-firefly/easytier/issues)

## Features in this branch

- **Central management:** device enrollment, management access tokens, networks and members, and node-acknowledged configuration status.
- **React interfaces:** Web, desktop GUI and Android share configuration types and interface conventions, with Simplified Chinese / English translations, HarmonyOS Sans SC and Inter, and an independently drawn three-node mark.
- **Self-managed networks:** local TOML configurations and CLI networking remain available without central management.
- **Network settings:** distribute compression, KCP / QUIC, encryption, protocol preferences and DNS suffixes across managed members. Per-node settings include supported subnet, ACL, listener, mapping and SOCKS5 options.
- **Dual-stack connectivity:** each node pair selects its own address family, preferring IPv6 while retaining available IPv4 or relay fallback.
- **Uplink selection:** supported platforms can automatically identify uplinks or specify allowed interfaces per instance. Mobile platforms use system Wi-Fi / cellular selection.
- **Observability:** device and server resources, peer connections, routes and live traffic. Historical data requires backend storage to be enabled.
- **Multiple instances:** one Core process can run multiple network instances, with instance-specific status available through CLI and GUI.

Applying network policy can rebuild instances and cause a brief reconnect. Online application results and offline pending states are reported separately. See [connectivity and configuration semantics](docs/central-network-connectivity.md) and [uplink selection](docs/uplink-interface-policy.md).

## Screenshots

These screenshots show this branch's React interfaces with anonymized example data. The desktop preview uses mocked Core data.

| Console overview | Network members |
| --- | --- |
| ![Console overview](docs/images/console/overview.png) | ![Network members](docs/images/console/network-members.png) |
| Network settings | Desktop client |
| ![Transport settings](docs/images/console/network-settings.png) | ![React desktop client](docs/images/console/desktop-client.png) |

## Packages

The current source version is **2.7.2**. Each build records its source commit, checksums and verification results; a source version does not mean every platform package has been published.

| Platform | Packages built by this repository |
| --- | --- |
| Linux x86_64 / ARM64 | Static musl `easytier-core`, `easytier-cli` and `easytier-web` with embedded React assets, `.tar.gz` |
| Windows x64 | GUI embedding Core, NSIS / MSI installers |
| macOS Intel / Apple Silicon | GUI embedding Core, DMG / application archive |
| Android ARM64 | Signed APK embedding Core |
| Web | React static assets, requiring this branch's management backend |

Use published packages from [this repository's Releases](https://github.com/alniyata-firefly/easytier/releases). Development packages are available under **Artifacts → release-packages** in successful builds; artifact downloads require a GitHub login. Check the accompanying `SHA256SUMS` and `build-manifest.json` from the same build.

This branch is not published through upstream Homebrew, Docker Hub or OpenWrt package feeds. The [installation guide](docs/installation.md) and repository installers use this branch's package layout.

## Centrally managed enrollment

1. Deploy this branch's `easytier-web` and open your own console.
2. Issue a device management access token.
3. Enter your server and token in the client, or run:

```sh
sudo ./easytier-core --config-server 'udp://vpn.example.com:22020/YOUR_DEVICE_TOKEN'
```

4. Check that the device is online in the console, add it to a network, and check the member's applied status.

`vpn.example.com` and `YOUR_DEVICE_TOKEN` are placeholders. The Web login, configuration transport and VPN data listeners are separate endpoints. An HTTPS Web reverse proxy does not automatically carry UDP configuration traffic. See [installation and enrollment](docs/installation.md) for ports and startup options.

## Self-managed networking

Use the same network name and secret on both nodes and assign distinct virtual addresses. Replace the example secret and reachable peer address:

```sh
# Node A
sudo ./easytier-core --network-name example-net --network-secret CHANGE_ME \
  --ipv4 10.144.144.1 --rpc-portal 127.0.0.1:15888 --listeners udp://0.0.0.0:11010

# Node B
sudo ./easytier-core --network-name example-net --network-secret CHANGE_ME \
  --ipv4 10.144.144.2 --rpc-portal 127.0.0.1:15888 --peers udp://node-a.example.com:11010
```

Inspect status with `./easytier-cli peer` and `./easytier-cli route`. For multiple instances, consult `./easytier-cli --help` to select the intended instance. The GUI also supports local network creation and TOML import. Centrally supplied and locally managed configurations retain their separate ownership.

## Development

Builds use Rust 1.95, Node.js 22 and pnpm 10.12.4 with locked dependencies. Current platform SDKs, signing and packaging are defined in `.github/workflows/` and `ci/`.

- [GitHub Actions and signing](docs/github-actions.md)
- [Contributing and local checks](CONTRIBUTING.md)
- [React Web](easytier-web/frontend/README.md) / [React GUI](easytier-gui/README.md)
- [Core architecture](docs/core-architecture.md)

The active interfaces are `easytier-web/frontend` and `easytier-gui/src/react`; `frontend-lib` contains shared protocol types and configuration conversion. Retained upstream Vue configuration tools, contribution tools and optional Go / JS / WASI sources are outside the default React packages. Original upstream workflows are [archived](.github/upstream-workflows/README.md) and are not active workflows.

Automated checks, package inspection and browser mocks do not replace real Android / Windows / macOS VPN, background lifecycle and upgrade testing. Consult the verification record for each release.

## Project provenance and downstream changes

This project is based on **[EasyTier/EasyTier](https://github.com/EasyTier/EasyTier)** and preserves its VPN Core, protocols, native integration and contribution history. The recorded baseline is [`8b7f1f0196edb5b580829ed5f135050fb5853478`](https://github.com/EasyTier/EasyTier/commit/8b7f1f0196edb5b580829ed5f135050fb5853478) (2026-10-05, version 2.7.0). This branch adds central management, token enrollment, configuration acknowledgement, resource observations, dual-stack and uplink policies, and React interfaces. Downstream version numbers are maintained independently.

Code remains under **[GNU LGPL v3](LICENSE)**, preserving original license, copyright and author notices. Modified source is public in this repository; packages include license and source-location notices.

HarmonyOS Sans SC and Inter retain their respective [HarmonyOS font license](easytier-web/frontend/public/fonts/LICENSE-HarmonyOS-Sans.txt) and [SIL OFL 1.1](easytier-web/frontend/public/fonts/LICENSE-Inter-GoogleFonts.txt). See the [font provenance record](easytier-web/frontend/public/fonts/provenance.json).
