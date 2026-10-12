// Explicit, privileged integration test. All VPN interfaces and routes live in
// disposable network namespaces; production interfaces and routes are untouched.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  webBinary, coreBinary, requireBinaries, startWeb, startCore, stopCore,
  seedUser, seedOfflineDevice, httpApi, protoUuid, waitFor, trackSecret,
  assertNoSecretLogs, maskSecrets,
} from './e2e-native-helpers.mjs';

const file = fileURLToPath(import.meta.url);
const workspace = resolve(dirname(file), '../../../..');
const enabled = process.env.ET_RUN_DATAPLANE === '1';
const worker = process.env.ET_DATAPLANE_NAMESPACE_WORKER === '1';
const passwordHash = '$argon2id$v=19$m=4096,t=3,p=1$ZWFzeXRpZXItZTJlLXNhbHQ$FHbDjVElaTXuArgEEQrQrO4AdsnqNOcXGA5PFY8cG/s';
const field = (value, key) => value?.[key] ?? value?.[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 15000, ...options });
  assert.equal(result.status, 0, maskSecrets(`${binary}: ${result.stderr || result.stdout || result.error || 'failed'}`));
  return result.stdout.trim();
}

function trackedProcess(binary, args, options = {}) {
  const child = spawn(binary, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  return { child, logs: () => maskSecrets(output), rawLogs: () => output };
}

test('standard WireGuard client and actual mesh TCP/UDP data survive reconnect',
  { skip: !enabled, timeout: 240000 }, async () => {
    await requireBinaries(webBinary, coreBinary);
    if (!worker) {
      const suffix = `${process.pid}-${randomBytes(3).toString('hex')}`;
      const namespaces = [`et-hub-${suffix}`, `et-peer-${suffix}`, `et-wg-${suffix}`];
      const before = (await readdir('/sys/class/net')).sort();
      try {
        for (const name of namespaces) command('ip', ['netns', 'add', name]);
        const [hub, peer, phone] = namespaces;
        command('ip', ['link', 'add', 'et-uplink-b', 'netns', hub, 'type', 'veth',
          'peer', 'name', 'et-uplink-a', 'netns', peer]);
        command('ip', ['link', 'add', 'et-uplink-w', 'netns', hub, 'type', 'veth',
          'peer', 'name', 'et-uplink-a', 'netns', phone]);
        for (const name of namespaces) command('ip', ['-n', name, 'link', 'set', 'lo', 'up']);
        for (const [name, device, cidr] of [
          [hub, 'et-uplink-b', '192.0.2.1/30'], [peer, 'et-uplink-a', '192.0.2.2/30'],
          [hub, 'et-uplink-w', '192.0.2.5/30'], [phone, 'et-uplink-a', '192.0.2.6/30'],
        ]) {
          command('ip', ['-n', name, 'address', 'add', cidr, 'dev', device]);
          command('ip', ['-n', name, 'link', 'set', device, 'up']);
        }
        command('ip', ['-n', phone, 'route', 'add', '192.0.2.0/30', 'via', '192.0.2.5']);
        const environment = { ...process.env, ET_DATAPLANE_NAMESPACE_WORKER: '1', ET_DATAPLANE_PEER_NAMESPACE: peer,
          ET_DATAPLANE_WG_NAMESPACE: phone };
        // Node otherwise suppresses a nested test runner and can exit zero
        // without running the namespace worker at all.
        delete environment.NODE_TEST_CONTEXT;
        const child = trackedProcess('ip', ['netns', 'exec', hub, process.execPath, '--test', file], { env: environment });
        try {
          const code = await new Promise((resolveExit, reject) => {
            child.child.once('exit', resolveExit); child.child.once('error', reject);
          });
          console.log(child.logs());
          assert.equal(code, 0, 'isolated data-plane worker failed');
          assert.ok(child.logs().includes('PROOF='), 'namespace worker produced no verification evidence');
        } finally { await stopCore(child); }
      } finally {
        for (const name of namespaces.reverse()) spawnSync('ip', ['netns', 'del', name]);
        assert.deepEqual((await readdir('/sys/class/net')).sort(), before, 'host interfaces changed');
      }
      return;
    }

    const directory = join(process.env.ET_NATIVE_E2E_OUTPUT || join(workspace, 'validation'), `dataplane-native-${Date.now()}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const database = join(directory, 'web.db');
    const peerNamespace = process.env.ET_DATAPLANE_PEER_NAMESPACE;
    const wgNamespace = process.env.ET_DATAPLANE_WG_NAMESPACE;
    const wg = process.env.ET_WG_BIN || join(workspace, 'tools/wireguard-test/extracted/usr/bin/wg');
    await requireBinaries(wg);
    const ports = { api: 18492, config: 28492, portal: 28495, tcp: 18494, udp: 18495 };
    const ids = [randomUUID(), randomUUID()];
    const processes = [];
    const proof = { scope: 'disposable network namespaces, real TUN/Core/standard kernel WireGuard',
      mobile_hardware_test: false, checks: [], ports };
    let api, networkId;
    const nsCommand = (ns, binary, args, options = {}) => command('ip', ['netns', 'exec', ns, binary, ...args], options);
    async function step(name, action) { await action(); proof.checks.push({ name, status: 'PASS' }); console.log(`PASS ${name}`); }
    async function rpc(id, service, method) {
      return api.post(`machines/${id}/proxy-rpc`, { service_name: service, method_name: method,
        payload: { instance: { id: protoUuid(networkId) } } });
    }
    const peerArgs = token => ['--config-server', `tcp://192.0.2.1:${ports.config}/${token}`, '--machine-id', ids[1],
      '--config-dir', join(directory, 'core-b'), '--no-listener', '--no-tun', '--disable-upnp',
      '--hostname', 'dataplane-b', '--console-log-level', 'warn'];
    try {
      const web = startWeb(database, ports.api, ports.config, '192.0.2.1', { protocol: 'tcp', gateway: true,
        logLevel: 'warn', extraArgs: ['--gateway-relay-data'] });
      processes.push(web); api = httpApi(`http://127.0.0.1:${ports.api}`);
      await waitFor(() => api.raw('GET', '/auth/config').then(response => response.ok), 'isolated Web');
      const owner = seedUser(database, 'dataplane-owner', passwordHash);
      for (let i = 0; i < ids.length; i++) seedOfflineDevice(database, owner, ids[i], `dataplane-${i}`);
      await api.post('auth/login', { username: 'dataplane-owner', password: createHash('md5').update('e2e-password').digest('hex') });
      const tokens = [];
      for (const id of ids) tokens.push(trackSecret((await api.post('device-access-tokens', { label: 'dataplane', machine_id: id })).token));
      const network = await api.post('networks', {
        settings: { display_name: 'Data-plane validation', network_name: `dataplane-${randomUUID()}`, networking_method: 'Gateway',
          peer_urls: [], virtual_cidr: '10.246.251.0/29', secure_mode: true },
        network_secret: trackSecret(randomBytes(32).toString('base64url')),
      });
      networkId = network.network_id;
      for (let i = 0; i < ids.length; i++) {
        await api.post(`networks/${networkId}/members`, { device_ids: [ids[i]], temporary: false }, 204);
        await api.patch(`networks/${networkId}/members/${ids[i]}`, { virtual_ipv4: `10.246.251.${i + 1}` });
        const config = { no_tun: false, dev_name: `et-test-${i}`, disable_upnp: true, bind_device: false,
          disable_p2p: true, disable_ipv6: true, disable_udp_hole_punching: true, disable_tcp_hole_punching: true,
          multi_thread: false, listener_urls: ['tcp://127.0.0.1:0'] };
        if (i === 0) config.vpn_portal_config = { enabled: true, wireguard_listen: `192.0.2.5:${ports.portal}`,
          wireguard_private_key: trackSecret(randomBytes(32).toString('base64')),
          clients: [{ name: 'standard-wg', virtual_ip: '10.246.251.5/29', groups: [] }] };
        await api.put(`networks/${networkId}/members/${ids[i]}/config`, { config });
        await mkdir(join(directory, i === 0 ? 'core-a' : 'core-b'), { mode: 0o700 });
      }
      processes.push(startCore(join(directory, 'core-a'), '192.0.2.1', ports.config, tokens[0],
        { protocol: 'tcp', machineId: ids[0], hostname: 'dataplane-a', logLevel: 'warn' }));
      let coreB = trackedProcess('ip', ['netns', 'exec', peerNamespace, coreBinary, ...peerArgs(tokens[1])]);
      processes.push(coreB);
      await step('central configuration creates real isolated TUN interfaces', async () => {
        await waitFor(async () => {
          const current = await api.get(`networks/${networkId}`);
          return current.deployment?.state === 'applied' && current.deployment.devices.every(device => device.state === 'applied');
        }, 'both actual TUN members', 45000);
        assert.match(command('ip', ['-j', 'address', 'show', 'dev', 'et-test-0']), /10\.246\.251\.1/);
        assert.match(nsCommand(peerNamespace, 'ip', ['-j', 'address', 'show', 'dev', 'et-test-1']), /10\.246\.251\.2/);
      });
      await step('actual mesh ICMP passes both ways', async () => {
        await waitFor(async () => {
          const a = spawnSync('ping', ['-c', '1', '-W', '1', '10.246.251.2']);
          const b = spawnSync('ip', ['netns', 'exec', peerNamespace, 'ping', '-c', '1', '-W', '1', '10.246.251.1']);
          return a.status === 0 && b.status === 0;
        }, 'bidirectional mesh ICMP', 30000);
      });
      const echoCode = `import socket,threading,time\n` +
        `def echo(c):\n try:\n  with c:\n   while b:=c.recv(65536):c.sendall(b)\n except OSError:pass\n` +
        `def tcp():\n s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(('10.246.251.2',${ports.tcp}));s.listen()\n while True:\n  c,a=s.accept();threading.Thread(target=echo,args=(c,),daemon=True).start()\n` +
        `threading.Thread(target=tcp,daemon=True).start()\n` +
        `s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.bind(('10.246.251.2',${ports.udp}))\nwhile True:\n b,a=s.recvfrom(65536);s.sendto(b,a)\n`;
      processes.push(trackedProcess('ip', ['netns', 'exec', peerNamespace, 'python3', '-u', '-c', echoCode]));
      // Read while producing: an echo server can legitimately fill both TCP
      // receive windows if a large request is sent before consuming its echo.
      const tcpRequest = `import socket,hashlib,threading\npayload=bytes(range(256))*4096\ns=socket.create_connection(('10.246.251.2',${ports.tcp}),10);s.settimeout(15)\n` +
        `def produce():\n s.sendall(payload);s.shutdown(socket.SHUT_WR)\n` +
        `producer=threading.Thread(target=produce,daemon=True);producer.start();data=b''\n` +
        `while len(data)<len(payload):\n b=s.recv(min(65536,len(payload)-len(data)));assert b;data+=b\n` +
        `producer.join(5);assert not producer.is_alive();assert data==payload\nprint(hashlib.sha256(data).hexdigest())\n`;
      const udpRequest = `import socket\ns=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.settimeout(10)\nfor i in range(32):\n b=(str(i)+':'+('x'*1100)).encode();s.sendto(b,('10.246.251.2',${ports.udp}));r,a=s.recvfrom(4096);assert r==b\nprint('32 UDP echo payloads verified')\n`;
      await step('mesh TCP 1 MiB and UDP echo payloads are intact', async () => {
        await waitFor(async () => spawnSync('python3', ['-c', tcpRequest], { timeout: 20000 }).status === 0, 'TCP echo server', 30000);
        proof.mesh_tcp_sha256 = command('python3', ['-c', tcpRequest], { timeout: 20000 });
        command('python3', ['-c', udpRequest]);
      });
      await step('standard kernel WireGuard client imports exported named-client config and handshakes', async () => {
        const response = await rpc(ids[0], 'api.instance.VpnPortalRpcService', 'get_vpn_portal_info');
        const client = field(field(response, 'vpn_portal_info'), 'clients').find(item => field(item, 'name') === 'standard-wg');
        const text = field(client, 'client_config');
        assert.ok(text?.includes('[Peer]'));
        const privateKey = trackSecret(text.match(/PrivateKey\s*=\s*(\S+)/)?.[1]);
        assert.ok(privateKey);
        const address = text.match(/^\s*Address\s*=\s*(.+)$/m)?.[1].trim();
        const allowed = text.match(/^\s*AllowedIPs\s*=\s*(.+)$/m)?.[1].split(',').map(value => value.trim());
        const mtu = text.match(/^\s*MTU\s*=\s*(\d+)$/m)?.[1];
        assert.ok(address && allowed?.length);
        proof.wireguard_config = { address, allowed_ips: allowed, mtu: mtu ? Number(mtu) : null,
          endpoint: text.match(/^\s*Endpoint\s*=\s*(.+)$/m)?.[1].trim() };
        const stripped = text.split('\n').filter(line => !/^\s*(Address|DNS|MTU|Table|PreUp|PostUp|PreDown|PostDown)\s*=/.test(line)).join('\n');
        const configPath = join(directory, 'standard-wg.conf');
        await writeFile(configPath, stripped, { mode: 0o600 });
        nsCommand(wgNamespace, 'ip', ['link', 'add', 'et-wg-client', 'type', 'wireguard']);
        nsCommand(wgNamespace, wg, ['setconf', 'et-wg-client', configPath]);
        nsCommand(wgNamespace, 'ip', ['address', 'add', address, 'dev', 'et-wg-client']);
        if (mtu) nsCommand(wgNamespace, 'ip', ['link', 'set', 'et-wg-client', 'mtu', mtu]);
        nsCommand(wgNamespace, 'ip', ['link', 'set', 'et-wg-client', 'up']);
        for (const prefix of allowed) nsCommand(wgNamespace, 'ip', ['route', 'add', prefix, 'dev', 'et-wg-client']);
        await waitFor(async () => {
          spawnSync('ip', ['netns', 'exec', wgNamespace, 'ping', '-c', '1', '-W', '1', '10.246.251.2']);
          const result = spawnSync('ip', ['netns', 'exec', wgNamespace, wg, 'show', 'et-wg-client', 'latest-handshakes'], { encoding: 'utf8' });
          return result.status === 0 && result.stdout.trim().split(/\s+/).some(item => /^\d{9,}$/.test(item) && Number(item) > 0);
        }, 'actual standard WireGuard handshake', 30000);
      });
      await step('WireGuard client reaches mesh member using TCP and UDP', async () => {
        proof.wireguard_tcp_sha256 = nsCommand(wgNamespace, 'python3', ['-c', tcpRequest], { timeout: 20000 });
        assert.equal(proof.wireguard_tcp_sha256, proof.mesh_tcp_sha256);
        nsCommand(wgNamespace, 'python3', ['-c', udpRequest]);
        const stats = await rpc(ids[0], 'api.instance.StatsRpcService', 'get_stats');
        const named = (field(stats, 'metrics') || []).filter(metric => field(metric, 'name')?.startsWith('vpn_portal_client_'));
        assert.ok(named.some(metric => BigInt(field(metric, 'value') || 0) > 0), 'named-client traffic is counted');
        proof.named_client_metric_count = named.length;
      });
      await step('mesh member reconnect restores actual WireGuard access', async () => {
        await stopCore(coreB);
        coreB = trackedProcess('ip', ['netns', 'exec', peerNamespace, coreBinary, ...peerArgs(tokens[1])]);
        processes.push(coreB);
        await waitFor(async () => spawnSync('ip', ['netns', 'exec', wgNamespace, 'python3', '-c', tcpRequest], { timeout: 20000 }).status === 0,
          'mesh service after member reconnect', 45000);
      });
      assertNoSecretLogs(processes);
      proof.status = 'PASS';
    } catch (error) { proof.status = 'FAIL'; proof.error = maskSecrets(error.message); throw error; }
    finally {
      for (const process of processes.reverse()) await stopCore(process);
      for (let i = 0; i < processes.length; i++) await writeFile(join(directory, `process-${i}.log`), processes[i].logs(), { mode: 0o600 });
      proof.processes_stopped = processes.every(process => process.child.exitCode !== null || process.child.signalCode !== null);
      await writeFile(join(directory, 'proof.json'), JSON.stringify(proof, null, 2), { mode: 0o600 });
      console.log(`PROOF=${join(directory, 'proof.json')}`);
    }
  });
