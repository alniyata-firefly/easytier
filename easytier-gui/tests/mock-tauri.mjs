export const localId = '11111111-1111-4111-8111-111111111111';
export const managedId = '22222222-2222-4222-8222-222222222222';
export function installMockTauri({ platform = 'windows', warmNativeEnabled = false, managedOnly = false } = {}) {
  const localId = '11111111-1111-4111-8111-111111111111', managedId = '22222222-2222-4222-8222-222222222222';
  const uuid = id => { const h = id.replaceAll('-', ''); return { part1: parseInt(h.slice(0, 8), 16), part2: parseInt(h.slice(8, 16), 16), part3: parseInt(h.slice(16, 24), 16), part4: parseInt(h.slice(24, 32), 16) }; };
  const localConfig = { instance_id: localId, network_name: 'Local lab', network_secret: 'mock-secret', dhcp: false, virtual_ipv4: '10.100.0.2', network_length: 24, hostname: 'Mock desktop', peer_urls: ['udp://192.0.2.2:11010'], listener_urls: ['udp://0.0.0.0:11010'], bind_device: true, multi_thread: true, no_tun: false, proxy_cidrs: [], port_forwards: [] };
  const configs = {
    ...(managedOnly ? {} : { [localId]: localConfig }),
    [managedId]: { instance_id: managedId, network_name: 'Managed lab', dhcp: false, virtual_ipv4: '10.101.0.2', network_length: 24, peer_urls: [], listener_urls: [], no_tun: platform === 'android' && !managedOnly, proxy_cidrs: [] },
  };
  const initiallyEnabled = platform !== 'android' || warmNativeEnabled;
  const running = new Set(initiallyEnabled ? Object.keys(configs) : []);
  const sources = { [localId]: 'user', [managedId]: 'web' };
  const persistConfigs = () => localStorage.setItem('networkList', JSON.stringify(Object.values(configs).map(config => ({ config, source: sources[config.instance_id] || 'user' }))));
  const persistEnabled = () => localStorage.setItem('enabled_networks', JSON.stringify([...running]));
  if (localStorage.getItem('networkList') === null) persistConfigs();
  // Remembered configuration is independent from this native process's intent.
  if (localStorage.getItem('enabled_networks') === null) localStorage.setItem('enabled_networks', JSON.stringify(Object.keys(configs)));
  let nativeEnabled = initiallyEnabled, rpcReady = initiallyEnabled, nextTunFd = 10;
  window.__MOCK_LOCAL_CLIENT_PAUSED__ = !nativeEnabled;
  window.__MOCK_NATIVE_ENABLED__ = nativeEnabled;
  window.__MOCK_RPC_READY__ = rpcReady;
  window.__MOCK_MANAGEMENT_CONNECTED__ = initiallyEnabled;
  window.__MOCK_MANAGEMENT_FOREGROUND__ = initiallyEnabled;
  let nativeVpn = platform === 'android' && warmNativeEnabled
    ? { running: true, state: 'established', established: true, requestId: 'warm-native-request', instanceId: localId, fd: 9, ipv4Addr: '10.100.0.2/24', routes: ['10.50.0.0/24'] }
    : { running: false, state: 'stopped', established: false };
  const setNativeVpn = value => { nativeVpn = value; window.__MOCK_NATIVE_VPN__ = structuredClone(value); };
  window.__MOCK_SET_NATIVE_VPN__ = setNativeVpn;
  setNativeVpn(nativeVpn);
  if (platform === 'android' && warmNativeEnabled) window.__MOCK_TUN_BINDING__ = { requestId: nativeVpn.requestId, instanceId: nativeVpn.instanceId, fd: nativeVpn.fd };
  const vpnConnected = () => nativeEnabled && nativeVpn.running === true
    && nativeVpn.state === 'established' && nativeVpn.established === true
    && running.has(nativeVpn.instanceId) && window.__MOCK_TUN_BINDING__?.requestId === nativeVpn.requestId
    && window.__MOCK_TUN_BINDING__?.instanceId === nativeVpn.instanceId
    && window.__MOCK_TUN_BINDING__?.fd === nativeVpn.fd;
  const remoteId = '33333333-3333-4333-8333-333333333333';
  const serviceId = '44444444-4444-4444-8444-444444444444';
  const remoteConfigs = { [remoteId]: { ...localConfig, instance_id: remoteId, network_name: 'Remote core only' } };
  const serviceConfigs = { [serviceId]: { ...localConfig, instance_id: serviceId, network_name: 'Service core only' } };
  const remoteRunning = new Set([remoteId]), serviceRunning = new Set([serviceId]);
  const activeConfigs = () => window.__MOCK_REMOTE_ACTIVE__ ? remoteConfigs : window.__MOCK_SERVICE_ACTIVE__ ? serviceConfigs : configs;
  const activeRunning = () => window.__MOCK_REMOTE_ACTIVE__ ? remoteRunning : window.__MOCK_SERVICE_ACTIVE__ ? serviceRunning : running;
  const info = instanceId => ({ dev_name: 'easytier0', running: true, my_node_info: { hostname: 'Mock desktop', version: '2.7.0-browser-mock', peer_id: 1, virtual_ipv4: { address: { addr: (activeConfigs()[instanceId]?.virtual_ipv4 || '10.100.0.2').split('.').reduce((value, part) => value * 256 + Number(part), 0) }, network_length: activeConfigs()[instanceId]?.network_length || 24 }, ips: { public_ipv4: { addr: 3221225994 }, interface_ipv4s: [], public_ipv6: null, interface_ipv6s: [] }, listeners: [{ url: 'udp://0.0.0.0:11010' }], stun_info: { udp_nat_type: 2, tcp_nat_type: 1 } }, routes: [{ peer_id: 2, hostname: 'Mock peer', ipv4_addr: { address: { addr: 174325763 }, network_length: 24 }, next_hop_peer_id: 2, cost: 1, proxy_cidrs: ['10.50.0.0/24'], version: '2.7.0' }], peers: [{ peer_id: 2, conns: [{ conn_id: 'mock-conn', peer_id: 2, tunnel: { tunnel_type: 'udp', local_addr: { url: 'udp://192.0.2.10:11010' }, remote_addr: { url: 'udp://192.0.2.11:11010' } }, stats: { tx_bytes: '1024', rx_bytes: '2048', latency_us: '1200' }, loss_rate: 0 }] }], peer_route_pairs: [{ route: { peer_id: 2, hostname: 'Mock peer', ipv4_addr: '10.100.0.3/24', next_hop_peer_id: 2, cost: 1, proxy_cidrs: [], version: '2.7.0' }, peer: { peer_id: 2, conns: [{ conn_id: 'mock-conn', tunnel: { tunnel_type: 'udp' }, stats: { rx_bytes: '2048', tx_bytes: '1024', latency_us: '1200' }, loss_rate: 0 }] } }], events: ['{"PeerAdded":2}'] });
  window.__MOCK_CALLS__ = [];
  window.__MOCK_CONFIGS__ = configs;
  window.__TAURI_OS_PLUGIN_INTERNALS__ = { os_type: platform, platform, arch: 'x86_64', eol: '\n' };
  const callbacks = new Map(), eventListeners = new Map();
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(_event, eventId) { eventListeners.delete(eventId); } };
  let cb = 1;
  window.__MOCK_EMIT_EVENT__ = (event, payload) => {
    for (const [id, listener] of eventListeners) if (listener.event === event) callbacks.get(listener.handler)?.({ event, id, payload });
  };
  window.__MOCK_CONTROLLER_REFRESH__ = ({ rename = true } = {}) => {
    if (!configs[managedId]) return;
    if (rename) configs[managedId] = { ...configs[managedId], network_name: 'Managed refresh while VPN disconnected' };
    const authorized = !window.__MOCK_MANAGEMENT_STATUS__ || window.__MOCK_MANAGEMENT_STATUS__ === 'authorized';
    const runtimeAllowed = window.__MOCK_MANAGEMENT_CONNECTED__ && authorized && (platform !== 'android' || nativeEnabled);
    if (runtimeAllowed) running.add(managedId);
    window.__MOCK_EMIT_EVENT__('save_configs', Object.values(configs).map(config => ({ config, source: sources[config.instance_id] || 'user' })));
    if (runtimeAllowed) {
      window.__MOCK_EMIT_EVENT__('save_enabled_networks', [...running]);
      window.__MOCK_EMIT_EVENT__('pre_run_network_instance', managedId);
      window.__MOCK_EMIT_EVENT__('post_run_network_instance', managedId);
      window.__MOCK_EMIT_EVENT__('dhcp_ip_changed', managedId);
    }
  };
  const scheduleController = () => {
    if (!window.__MOCK_MANAGEMENT_CONNECTED__ || window.__MOCK_CONTROLLER_AUTO__ === false) return;
    setTimeout(() => { if (window.__MOCK_CONTROLLER_AUTO__ !== false) window.__MOCK_CONTROLLER_REFRESH__({ rename: false }); }, 50);
  };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    transformCallback(callback) { const id = cb++; callbacks.set(id, callback); return id; }, unregisterCallback(id) { callbacks.delete(id); }, convertFileSrc(path) { return path; },
    invoke: async (command, args = {}) => {
      window.__MOCK_CALLS__.push({ command, args: JSON.parse(JSON.stringify(args)) });
      if (command === 'plugin:event|listen') { const id = cb++; eventListeners.set(id, { event: args.event, handler: args.handler }); return id; }
      if (command === 'plugin:event|unlisten') { eventListeners.delete(args.eventId); return; }
      if (command === 'easytier_version') return '2.7.0-browser-mock';
      if (command === 'init_rpc_connection') { rpcReady = true; window.__MOCK_RPC_READY__ = true; window.__MOCK_NORMAL_MODE__ = args.isNormalMode; window.__MOCK_REMOTE_ACTIVE__ = args.url === 'tcp://192.0.2.44:15999'; window.__MOCK_SERVICE_ACTIVE__ = !args.isNormalMode && !window.__MOCK_REMOTE_ACTIVE__; return; }
      if (command === 'list_network_instance_ids') { const current = activeRunning(); return { running_inst_ids: [...current].map(uuid), disabled_inst_ids: Object.keys(activeConfigs()).filter(id => !current.has(id)).map(uuid) }; }
      if (command === 'get_network_metas') { const source = activeConfigs(), result = { metas: Object.fromEntries(args.instanceIds.filter(id => source[id]).map(id => [id, { network_name: source[id].network_name, config_permission: sources[id] === 'web' ? 3 : 0, source: sources[id] === 'web' ? 2 : 1 }])) }; if (window.__MOCK_HOLD_META__) { window.__MOCK_HOLD_META__ = false; window.__MOCK_META_WAITING__ = true; return new Promise(resolve => { window.__MOCK_RELEASE_META__ = () => { window.__MOCK_META_WAITING__ = false; resolve(result); }; }); } return result; }
      if (command === 'get_config') return activeConfigs()[args.instanceId];
      if (command === 'get_saved_remote_config') return structuredClone(activeConfigs()[args.instanceId]);
      if (command === 'collect_network_info') {
        if (window.__MOCK_FAIL_RUNTIME_INFO__) throw new Error('synthetic runtime observation failure');
        const tick = window.__MOCK_COUNTER_TICKS__ = (window.__MOCK_COUNTER_TICKS__ || 0) + 1;
        const ids = args.instanceId ? [args.instanceId] : [...activeRunning()];
        return { info: { map: Object.fromEntries(ids.map(id => {
          const value = info(id);
          for (const peer of value.peers) for (const conn of peer.conns) { conn.stats.rx_bytes = String(2048 + tick * 256); conn.stats.tx_bytes = String(1024 + tick * 1024); }
          if (window.__MOCK_NO_PEERS__) { value.peers = []; value.peer_route_pairs = []; }
          return [id, value];
        })) } };
      }
      if (command === 'validate_config') { if (!args.config || args.cfg) throw new Error('wrong validate config payload'); return { toml_config: 'network_name = "validated"' }; }
      if (command === 'save_network_config' || command === 'run_network_instance') {
        if (command === 'run_network_instance' && (sources[args.cfg.instance_id] === 'web' || platform === 'android' && !nativeEnabled)) throw new Error('network lifecycle is not allowed');
        activeConfigs()[args.cfg.instance_id] = args.cfg;
        sources[args.cfg.instance_id] ??= 'user';
        if (command === 'run_network_instance') activeRunning().add(args.cfg.instance_id);
        if (window.__MOCK_NORMAL_MODE__) { persistConfigs(); persistEnabled(); }
        return;
      }
      if (command === 'save_remote_network_config') { activeConfigs()[args.cfg.instance_id] = structuredClone(args.cfg); return structuredClone(args.cfg); }
      if (command === 'update_network_config_state') { if (sources[args.instanceId] === 'web') throw new Error('managed lifecycle belongs to controller'); if (platform === 'android' && !nativeEnabled) throw new Error('global runtime is paused'); if (args.disabled) activeRunning().delete(args.instanceId); else activeRunning().add(args.instanceId); if (window.__MOCK_NORMAL_MODE__) persistEnabled(); return; }
      if (command === 'remove_network_instance') { delete activeConfigs()[args.instanceId]; delete sources[args.instanceId]; activeRunning().delete(args.instanceId); if (window.__MOCK_NORMAL_MODE__) { persistConfigs(); persistEnabled(); } return; }
      if (command === 'load_configs') {
        // Service/remote Core processes retain their own running instances.
        if (!window.__MOCK_NORMAL_MODE__) return;
        for (const id of Object.keys(configs)) delete configs[id];
        for (const entry of args.configs) { configs[entry.config.instance_id] = entry.config; sources[entry.config.instance_id] = entry.source; }
        for (const id of args.enabledNetworks) if (configs[id]) running.add(id);
        return;
      }
      if (command === 'parse_network_config') return `network_name = "${args.cfg.network_name}"\n[flags]\nprefer_ipv6 = ${!!args.cfg.prefer_ipv6}\n`;
      if (command === 'generate_network_config') return window.__MOCK_IMPORTED_CONFIG__ || { ...configs[localId], network_name: 'Imported lab' };
      if (command === 'get_vpn_portal_info') return { vpn_type: 'wireguard', listener: '0.0.0.0:22022', clients: [{ name: 'mock-phone', virtual_ip: '10.100.0.20/24', groups: [], client_config: '[Interface]\nPrivateKey = mock-client\nAddress = 10.100.0.20/24\n[Peer]\nPublicKey = mock-server\nEndpoint = 0.0.0.0:22022\n' }] };
      if (command === 'is_local_client_enabled') return nativeEnabled;
      if (command === 'is_local_vpn_connected') return vpnConnected();
      if (command === 'get_local_vpn_status') return vpnConnected() ? structuredClone(nativeVpn) : { running: false, state: 'stopped', established: false };
      if (command === 'stop_local_client') { nativeEnabled = false; window.__MOCK_NATIVE_ENABLED__ = false; window.__MOCK_LOCAL_CLIENT_PAUSED__ = true; if (window.__MOCK_FAIL_CORE_STOP__) throw new Error('synthetic Core cleanup failure'); running.clear(); delete window.__MOCK_TUN_BINDING__; return; }
      if (command === 'resume_local_client') { nativeEnabled = true; window.__MOCK_NATIVE_ENABLED__ = true; window.__MOCK_LOCAL_CLIENT_PAUSED__ = false; scheduleController(); return; }
      if (command === 'is_client_running') return rpcReady;
      if (command === 'is_web_client_connected') return window.__MOCK_MANAGEMENT_CONNECTED__;
      if (command === 'get_web_client_status') return window.__MOCK_MANAGEMENT_STATUS__ || (window.__MOCK_MANAGEMENT_CONNECTED__ ? 'authorized' : 'disconnected');
      if (command === 'get_management_device_id') return '11111111-2222-4333-8444-555555555555';
      if (command === 'get_service_status') return window.__MOCK_SERVICE_STATUS__ || 'NotInstalled';
      if (command === 'set_service_status') { window.__MOCK_SERVICE_STATUS__ = args.enable ? 'Running' : 'Stopped'; return; }
      if (command === 'init_service') { window.__MOCK_SERVICE_STATUS__ = args.opts ? 'Stopped' : 'NotInstalled'; return; }
      if (command === 'init_web_client') {
        if (window.__MOCK_FAIL_MANAGEMENT__) throw new Error('mock-sensitive-token');
        window.__MOCK_MANAGEMENT_CONNECTED__ = !!args.url;
        // Managed networks return through controller reconciliation, not the
        // local GUI's enabled-network restoration during load_configs.
        if (args.url && (!window.__MOCK_MANAGEMENT_STATUS__ || window.__MOCK_MANAGEMENT_STATUS__ === 'authorized') && (platform !== 'android' || nativeEnabled))
          for (const [id, source] of Object.entries(sources)) if (source === 'web' && configs[id]) running.add(id);
        return;
      }
      if (command === 'get_log_dir_path') return '/mock/logs';
      if (command === 'plugin:path|resolve_directory') return '/mock/config';
      if (command === 'plugin:path|join') return args.paths.join('/');
      if (command === 'plugin:clipboard-manager|write_text') { window.__MOCK_CLIPBOARD__ = args.text; return; }
      if (command === 'plugin:vpnservice|get_vpn_status') return structuredClone(nativeVpn);
      if (command === 'plugin:vpnservice|set_client_enabled') { window.__MOCK_MANAGEMENT_FOREGROUND__ = args.enabled; return {}; }
      if (command === 'plugin:vpnservice|start_vpn') {
        if (window.__MOCK_FAIL_START_VPN__) return { errorMsg: 'vpn_tun_start_failed' };
        if (!nativeEnabled) return { errorMsg: 'client_paused' };
        if (nativeVpn.state !== 'stopped') return { errorMsg: 'vpn_service_busy' };
        if (!args.requestId || !args.instanceId) throw new Error('mock start requires native request ownership');
        setNativeVpn({ running: true, state: 'established', established: true, requestId: args.requestId, instanceId: args.instanceId, fd: nextTunFd++, ipv4Addr: args.ipv4Addr, routes: args.routes || [], dns: args.dns });
        return {};
      }
      if (command === 'plugin:vpnservice|stop_vpn') {
        setNativeVpn({ running: false, state: 'stopped', established: false, requestId: nativeVpn.requestId, instanceId: nativeVpn.instanceId });
        return {};
      }
      if (command === 'set_tun_fd') {
        if (!nativeVpn.running || !nativeVpn.established || nativeVpn.state !== 'established'
          || !Number.isInteger(args.fd) || args.fd <= 0 || nativeVpn.fd !== args.fd
          || nativeVpn.requestId !== args.requestId || nativeVpn.instanceId !== args.instanceId
          || !running.has(args.instanceId) || configs[args.instanceId]?.no_tun || window.__MOCK_LOCAL_CLIENT_PAUSED__)
          throw new Error('mock rejected stale TUN attachment');
        window.__MOCK_TUN_BINDING__ = structuredClone(args);
        return;
      }
      if (command === 'clear_tun_fd') {
        if (window.__MOCK_FAIL_CORE_STOP__) throw new Error('synthetic Core detach failure');
        if (window.__MOCK_TUN_BINDING__?.requestId === args.requestId && window.__MOCK_TUN_BINDING__?.instanceId === args.instanceId)
          delete window.__MOCK_TUN_BINDING__;
        return;
      }
      if (command === 'plugin:vpnservice|consume_vpn_tile_action') return {};
      if (command === 'plugin:vpnservice|prepare_vpn') return { granted: true };
      if (command.startsWith('plugin:tray|') || command.startsWith('plugin:menu|')) return command.endsWith('get_by_id') ? null : [cb++, 'main'];
    },
  };
}
