export const localId = '11111111-1111-4111-8111-111111111111';
export const managedId = '22222222-2222-4222-8222-222222222222';
export function installMockTauri({ platform = 'windows' } = {}) {
  const localId = '11111111-1111-4111-8111-111111111111', managedId = '22222222-2222-4222-8222-222222222222';
  const uuid = id => { const h = id.replaceAll('-', ''); return { part1: parseInt(h.slice(0, 8), 16), part2: parseInt(h.slice(8, 16), 16), part3: parseInt(h.slice(16, 24), 16), part4: parseInt(h.slice(24, 32), 16) }; };
  const configs = {
    [localId]: { instance_id: localId, network_name: 'Local lab', network_secret: 'mock-secret', dhcp: false, virtual_ipv4: '10.100.0.2', network_length: 24, hostname: 'Mock desktop', peer_urls: ['udp://192.0.2.2:11010'], listener_urls: ['udp://0.0.0.0:11010'], bind_device: true, multi_thread: true, no_tun: platform === 'android', proxy_cidrs: [], port_forwards: [] },
    [managedId]: { instance_id: managedId, network_name: 'Managed lab', dhcp: false, virtual_ipv4: '10.101.0.2', network_length: 24, peer_urls: [], listener_urls: [], proxy_cidrs: [] },
  };
  const running = new Set([localId, managedId]);
  const remoteId = '33333333-3333-4333-8333-333333333333';
  const remoteConfigs = { [remoteId]: { ...configs[localId], instance_id: remoteId, network_name: 'Remote core only' } };
  const activeConfigs = () => window.__MOCK_REMOTE_ACTIVE__ ? remoteConfigs : configs;
  const info = () => ({ dev_name: 'easytier0', running: true, my_node_info: { hostname: 'Mock desktop', version: '2.7.0-browser-mock', peer_id: 1, virtual_ipv4: { address: { addr: 174325762 }, network_length: 24 }, ips: { public_ipv4: { addr: 3221225994 }, interface_ipv4s: [], public_ipv6: null, interface_ipv6s: [] }, listeners: [{ url: 'udp://0.0.0.0:11010' }], stun_info: { udp_nat_type: 2, tcp_nat_type: 1 } }, routes: [{ peer_id: 2, hostname: 'Mock peer', ipv4_addr: { address: { addr: 174325763 }, network_length: 24 }, next_hop_peer_id: 2, cost: 1, proxy_cidrs: ['10.50.0.0/24'], version: '2.7.0' }], peers: [{ peer_id: 2, conns: [{ conn_id: 'mock-conn', peer_id: 2, tunnel: { tunnel_type: 'udp', local_addr: { url: 'udp://192.0.2.10:11010' }, remote_addr: { url: 'udp://192.0.2.11:11010' } }, stats: { tx_bytes: '1024', rx_bytes: '2048', latency_us: '1200' }, loss_rate: 0 }] }], peer_route_pairs: [{ route: { peer_id: 2, hostname: 'Mock peer', ipv4_addr: '10.100.0.3/24', next_hop_peer_id: 2, cost: 1, proxy_cidrs: [], version: '2.7.0' }, peer: { peer_id: 2, conns: [{ conn_id: 'mock-conn', tunnel: { tunnel_type: 'udp' }, stats: { rx_bytes: '2048', tx_bytes: '1024', latency_us: '1200' }, loss_rate: 0 }] } }], events: ['{"PeerAdded":2}'] });
  window.__MOCK_CALLS__ = [];
  window.__MOCK_CONFIGS__ = configs;
  window.__TAURI_OS_PLUGIN_INTERNALS__ = { os_type: platform, platform, arch: 'x86_64', eol: '\n' };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  let cb = 1;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    transformCallback() { return cb++; }, unregisterCallback() {}, convertFileSrc(path) { return path; },
    invoke: async (command, args = {}) => {
      window.__MOCK_CALLS__.push({ command, args: JSON.parse(JSON.stringify(args)) });
      if (command === 'plugin:event|listen') return cb++;
      if (command === 'easytier_version') return '2.7.0-browser-mock';
      if (command === 'init_rpc_connection') { window.__MOCK_REMOTE_ACTIVE__ = args.url === 'tcp://192.0.2.44:15999'; return; }
      if (command === 'list_network_instance_ids') return window.__MOCK_REMOTE_ACTIVE__ ? { running_inst_ids: [uuid(remoteId)], disabled_inst_ids: [] } : { running_inst_ids: [...running].map(uuid), disabled_inst_ids: Object.keys(configs).filter(id => !running.has(id)).map(uuid) };
      if (command === 'get_network_metas') { const source = activeConfigs(), result = { metas: Object.fromEntries(args.instanceIds.filter(id => source[id]).map(id => [id, { network_name: source[id].network_name, config_permission: id === managedId ? 3 : 0 }])) }; if (window.__MOCK_HOLD_META__) { window.__MOCK_HOLD_META__ = false; window.__MOCK_META_WAITING__ = true; return new Promise(resolve => { window.__MOCK_RELEASE_META__ = () => { window.__MOCK_META_WAITING__ = false; resolve(result); }; }); } return result; }
      if (command === 'get_config') return activeConfigs()[args.instanceId];
      if (command === 'collect_network_info') { const tick = window.__MOCK_COUNTER_TICKS__ = (window.__MOCK_COUNTER_TICKS__ || 0) + 1; const value = info(args.instanceId); for (const peer of value.peers) for (const conn of peer.conns) { conn.stats.rx_bytes = String(2048 + tick * 256); conn.stats.tx_bytes = String(1024 + tick * 1024); } return { info: { map: { [args.instanceId]: value } } }; }
      if (command === 'validate_config') { if (!args.config || args.cfg) throw new Error('wrong validate config payload'); return { toml_config: 'network_name = "validated"' }; }
      if (command === 'save_network_config' || command === 'run_network_instance') { configs[args.cfg.instance_id] = args.cfg; if (command === 'run_network_instance') running.add(args.cfg.instance_id); return; }
      if (command === 'update_network_config_state') { if (args.disabled) running.delete(args.instanceId); else running.add(args.instanceId); return; }
      if (command === 'remove_network_instance') { delete configs[args.instanceId]; running.delete(args.instanceId); return; }
      if (command === 'parse_network_config') return `network_name = "${args.cfg.network_name}"\n[flags]\nprefer_ipv6 = ${!!args.cfg.prefer_ipv6}\n`;
      if (command === 'generate_network_config') return { ...configs[localId], network_name: 'Imported lab' };
      if (command === 'get_vpn_portal_info') return { vpn_type: 'wireguard', listener: '0.0.0.0:22022', clients: [{ name: 'mock-phone', virtual_ip: '10.100.0.20/24', groups: [], client_config: '[Interface]\nPrivateKey = mock-client\nAddress = 10.100.0.20/24\n[Peer]\nPublicKey = mock-server\nEndpoint = 0.0.0.0:22022\n' }] };
      if (command === 'stop_local_client') { window.__MOCK_LOCAL_CLIENT_PAUSED__ = true; return; }
      if (command === 'resume_local_client') { window.__MOCK_LOCAL_CLIENT_PAUSED__ = false; return; }
      if (command === 'is_client_running') return !window.__MOCK_LOCAL_CLIENT_PAUSED__;
      if (command === 'is_web_client_connected') return true;
      if (command === 'get_service_status') return window.__MOCK_SERVICE_STATUS__ || 'NotInstalled';
      if (command === 'set_service_status') { window.__MOCK_SERVICE_STATUS__ = args.enable ? 'Running' : 'Stopped'; return; }
      if (command === 'init_service') { window.__MOCK_SERVICE_STATUS__ = args.opts ? 'Stopped' : 'NotInstalled'; return; }
      if (command === 'init_web_client' && window.__MOCK_FAIL_MANAGEMENT__) throw new Error('mock-sensitive-token');
      if (command === 'get_log_dir_path') return '/mock/logs';
      if (command === 'plugin:path|resolve_directory') return '/mock/config';
      if (command === 'plugin:path|join') return args.paths.join('/');
      if (command === 'plugin:clipboard-manager|write_text') { window.__MOCK_CLIPBOARD__ = args.text; return; }
      if (command === 'plugin:vpnservice|get_vpn_status') return { running: false };
      if (command === 'plugin:vpnservice|consume_vpn_tile_action') return {};
      if (command === 'plugin:vpnservice|prepare_vpn') return { granted: true };
      if (command.startsWith('plugin:tray|') || command.startsWith('plugin:menu|')) return command.endsWith('get_by_id') ? null : [cb++, 'main'];
    },
  };
}
