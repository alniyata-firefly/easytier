# Interface screenshots

These images show the downstream EasyTier 2.7.2 React interfaces, rendered locally in Chromium from the existing Web and GUI builds. The Web interface includes the offline observation fix from source revision `faea0cfcfeb928752077a6dd630ef0927a1d45f1`.

All network names, hostnames, addresses, device identifiers, resource values and network states are synthetic examples. No production service, account, management token, private configuration, HAR or browser trace was used. Public-facing example addresses use `192.0.2.0/24` and the `.example` domain; the illustrated overlay subnets are also examples.

| Image | View |
| --- | --- |
| `overview.png` | Web overview and server resources |
| `network-members.png` | Managed members, including an offline member |
| `network-settings.png` | Network compression, KCP, QUIC, encryption and protocol settings |
| `node-routes.png` | A managed node's route view |
| `desktop-client.png` | Current React desktop client interface |

The desktop client image renders the real GUI frontend in a browser with a simulated Tauri/Core bridge. It illustrates the interface; it does not establish that a native Windows application or VPN connection was tested. The original UI implementation, fonts, brand assets and their licenses are unchanged.

The screenshots are part of this downstream project's documentation. Project provenance and license notices remain in the repository [README](../../../README.md) and [LICENSE](../../../LICENSE).
