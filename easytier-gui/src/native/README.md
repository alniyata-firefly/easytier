# React native bridge

`bridge.ts` is the public interface used by the React desktop and Android UI.
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
TOML generation/import, permissions and VPN portal clients. Start or stop a
user-owned network with `update_network_instance_state`: this preserves its
configuration source. Managed instances are controlled by the controller; GUI
controls and native entry points reject individual local lifecycle changes to an
explicitly Web-owned instance. Ownership is read from the source field,
separately from file permissions.

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
quick settings tile and route/IP/DNS update reconciliation. A valid descriptor must be positive; zero is a Core sentinel and is rejected.
Installing a descriptor must succeed before reporting the VPN as running.
Opening the Android App initializes local RPC and its configured management
connection. Management authentication is displayed only in the management panel;
the home status observes the actual system VPN and its committed Core TUN lease.
Windows, macOS and Linux GUI home status instead observes all target Core
instances in one runtime snapshot. RPC availability, management authorization
and a running Core actor alone cannot report an established peer connection.
Running without peers, startup, failures and unavailable observation are distinct;
only an open peer connection with a connection ID counts as connected. Closed
peer entries are ignored. Each network card uses the same runtime distinction.
Disconnect closes the Android VPN interface and stops all local Core data-plane
instances, including peer sessions and forwarding. It retains configuration,
credentials and management. A new process connects management without starting
saved Core instances, even if old JavaScript storage records them as enabled.
Connect opens the native run gate; managed networks start only from the
controller's current desired state, never from cached Web configuration. The
optional runtime-control heartbeat defers controller Run/Patch while paused;
the native pre-run gate also blocks requests already in flight. Reopening a
WebView adopts a still-running native interface and reconciles it once with the
current Core address/routes. It keeps the interface when these match and restores
the ownership context needed for subsequent DHCP and route updates. A pending
warm connection resumes reconciliation without reconnecting management.
A removed managed network may remain as a read-only cached card while paused;
it cannot start from that cache or block selection of a fresh controller instance.
Coordinated server/client upgrades are required for deferred status reporting.
A new client's native pause gate remains safe with an older server, but that
server may report a rejected start as a failure instead of deferring it.
Android hides manual uplink selection and interface binding; saved and imported
uplink settings are normalized to automatic selection before reaching Core.
The Android Host also ignores an otherwise valid unsupported uplink policy from
central configuration at runtime while retaining its stored TOML for revision
matching. Other unsupported or invalid configuration still fails validation.
System revocation suspends VPN intent, without allowing a DHCP notification to
restart it. Incomplete cleanup remains visible as Retry Disconnect. A connection
that cannot establish a VPN ends with an error after at most 150 seconds; this
does not close management or remove the network configuration.
Remote/service save-only uses the target Core's durable save API and reads the
persisted desired configuration across reconnects. A pathless, read-only or old
Core returns an error instead of reporting a GUI-memory-only save. Local
configurations are never imported into service/remote mode. Stop uses the
non-destructive stop RPC, preserving saved files; Delete remains distinct.
Only explicit old-Core/pathless capability errors allow reading live configuration
for edit-and-run compatibility. Timeouts, missing files and invalid or read-only
saved configuration propagate errors instead of replacing desired state with live
state. An explicit Stop retains management even for a non-daemon CLI process;
ordinary runtime failure and natural exit do not acquire that keepalive.

Failed or timed-out native starts clean partial VPN state, late network results
cannot restart a stopped network, and pending permission requests can be canceled
by a stop. A denied permission request keeps a previous VPN running. Tile starts
use the state-update API for user instances and wait for current controller
instances for managed networks.

Run `pnpm --dir easytier-gui exec vitest run src/native/*.test.ts --silent`.
The suite checks native payload names, credential migration/error redaction,
storage/events, service rollback, connection/disposal races and Android ownership,
permission, descriptor and tile boundaries. These are mocked IPC boundary tests;
they do not create a host TUN, contact production or establish a real Android or
Windows VPN. Device/platform integration must be tested separately.

`ET_GUI_QA_URL=http://127.0.0.1:19420 pnpm --dir easytier-gui exec node --test tests/runtime-routes.browser.test.mjs`
checks actual omitted-field protobuf JSON fixtures through the GUI API and the
Routes, Connections, Events and Overview tabs, with synthetic Tauri IPC only.

Local configurations remain editable while a normal-mode client is stopped.
`GUIRemoteClient` then validates TOML through the pure native parser and writes
only user-managed storage entries; it does not run a network or initialize Core.
Managed entries remain read-only. Service and remote modes never substitute local
storage for an unavailable remote Core. Configuration clients are scoped to their
mode and connection so a stale editor cannot save into a different destination.

Android TUN ownership uses a unique start request ID and instance ID. Events only
wake reconciliation; bounded native status queries confirm establishment and real
service destruction. Both JavaScript and the Rust attachment boundary reject stale
owners. Session status polling observes native VPN state; it does not periodically
rebuild an established TUN. Reconciliation retries are bounded.

The Android attachment command waits for real Core NIC installation, not merely
an fd queue receipt. Core holds an owned duplicate through its actual read/write
tasks. Stop clears that binding by instance/request identity and waits for task
shutdown; a native Rust channel also handles service destruction without JS.
A canceled wait does not abandon cleanup or permit a late request to replace a
new owner. Pure ownership tests are available with:

`cargo test --locked --manifest-path ci/android/lease-tests/Cargo.toml`
