# React native bridge

`bridge.ts` is the public interface used by the React Windows and Android UI.
It calls the existing Tauri commands and VPN plugin protocol; it contains no
Vue state or components. Configuration DTOs and generated protocol helpers are
imported from individual shared TypeScript modules, not the frontend library
entry point that exports Vue components.

`NativeSession` owns mode changes, listeners and the non-overlapping connection
poller. Subscribe with `useSyncExternalStore`. Its mutations are serialized;
stale polls and listeners that register after disposal cannot revive the old
session. Failed connections retry with a delay capped at 30 seconds. Explicitly
stopped services stay stopped, including after failed mode changes or a service
configuration rollback. Create a new session after disposing an old one.

`GUIRemoteClient` exposes the original network API, including multiple instances,
TOML generation/import, permissions and VPN portal clients. Start or stop an
existing network with `update_network_instance_state`: this preserves its
configuration source. The Rust `run_network_instance` command must also preserve
an existing source when editing and starting a writable configuration. Edit,
delete and persistent-save permissions are independent flags, not an inferred
central/local classification.

`get_network_info` restores protobuf JSON's omitted empty arrays and default route
scalars at the GUI boundary. Routes with no proxy prefixes remain valid rows;
optional node, connection and pair-route messages remain optional. Prefixes and
additional IPv6 or latency fields are preserved. Missing IPs and unspecified next
hops display an em dash; a known next-hop ID is retained when its name is absent.
The same GUI client also normalizes metadata in normal, service and remote modes:
an existing metadata message with an omitted permission scalar means permission
zero. A missing message keeps the UI's read-only/no-delete fallback. Explicit
permission bits remain unchanged.
NAT enum names from protobuf JSON become numeric codes before display, and an
omitted non-optional connection loss scalar means zero loss. Absent STUN messages,
peers and counter-stat messages remain absent.

Existing `networkList`, `app_mode` and `last_network_instance_id` keys remain
compatible. Bare old network configurations become `legacy`; `webhook` becomes
`web`. Invalid saved account-only central registrations require a new endpoint
and token. `save_enabled_networks` now persists the existing native enabled list.
Only local user/legacy enabled configurations are restored by the GUI; a central
server reconciles its own networks and a remote/service Core owns its lifecycle.

Android retains the foreground VPN service, permission request, TUN descriptor,
quick settings tile and route/IP/DNS update reconciliation. The descriptor may be
zero. Installing a descriptor must succeed before reporting the VPN as running.
Failed or timed-out native starts clean partial VPN state, late network results
cannot restart a stopped network, and pending permission requests can be canceled
by a stop. A denied permission request keeps a previous VPN running. Tile starts
use the state-update API and preserve central ownership.

Run `pnpm --dir easytier-gui exec vitest run src/native/*.test.ts --silent`.
The suite checks native payload names, credential migration/error redaction,
storage/events, service rollback, connection/disposal races and Android ownership,
permission, descriptor and tile boundaries. These are mocked IPC boundary tests;
they do not create a host TUN, contact production or establish a real Android or
Windows VPN. Device/platform integration must be tested separately.

`ET_GUI_QA_URL=http://127.0.0.1:19420 pnpm --dir easytier-gui exec node --test tests/runtime-routes.browser.test.mjs`
checks actual omitted-field protobuf JSON fixtures through the GUI API and the
Routes, Connections, Events and Overview tabs, with synthetic Tauri IPC only.
