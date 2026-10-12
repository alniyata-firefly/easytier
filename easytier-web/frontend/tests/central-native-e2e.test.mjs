// Real local Web/Core coverage. No TUN, host routes, containers or compilation.
// The two offline registry fixtures allow safe overrides to commit before Core starts.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
    webBinary, coreBinary, requireBinaries, freePort, waitFor,
    startWeb, stopWeb, startCore, stopCore, seedUser, seedOfflineDevice,
    protoUuid, trackSecret, assertNoSecretLogs, httpApi,
} from './e2e-native-helpers.mjs';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const passwordHash = '$argon2id$v=19$m=4096,t=3,p=1$ZWFzeXRpZXItZTJlLXNhbHQ$FHbDjVElaTXuArgEEQrQrO4AdsnqNOcXGA5PFY8cG/s';
const field = (value, key) => value?.[key] ?? value?.[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];

await test('native central Gateway, grants, ACL, stats and named WireGuard clients', { timeout: 180000 }, async () => {
    await requireBinaries(webBinary, coreBinary);
    const directory = join(process.env.ET_NATIVE_E2E_OUTPUT || join(workspace, 'validation'), `central-native-${Date.now()}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const database = join(directory, 'web.db');
    const ports = { api: 18271, config: 28271, rpcA: 28272, rpcB: 28273, portal: await freePort() };
    const processes = [];
    const checks = [];
    const proof = { scope: 'native no-TUN localhost Web/Core', registry_bootstrap: 'offline fixtures before safe overrides; real Core enrollment and config application follow', ports, checks };
    let web;
    let api;
    let networkId;
    const ids = [randomUUID(), randomUUID()];
    const username = `central-native-${Date.now()}`;
    const networkSecret = trackSecret(randomBytes(32).toString('base64url'));
    const portalKey = trackSecret(randomBytes(32).toString('base64'));
    async function step(name, action) {
        const started = Date.now();
        await action();
        checks.push({ name, status: 'PASS', elapsed_ms: Date.now() - started });
        console.log(`PASS ${name}`);
    }
    const memberPath = id => `networks/${networkId}/members/${id}`;
    async function rpc(id, service, method, payload = {}) {
        return api.post(`machines/${id}/proxy-rpc`, { service_name: service, method_name: method,
            payload: { instance: { id: protoUuid(networkId) }, ...payload } });
    }
    async function runtimeConfig(id) {
        return field(await rpc(id, 'api.config.ConfigRpcService', 'get_config'), 'config');
    }
    async function nodeIdentity(id) {
        const response = await rpc(id, 'api.instance.PeerManageRpcService', 'show_node_info');
        return field(field(response, 'node_info'), 'peer_id');
    }
    async function gatewayPeerIds(id) {
        const response = await rpc(id, 'api.instance.PeerManageRpcService', 'list_peer');
        return (field(response, 'peer_infos') || []).filter(peer => (field(peer, 'conns') || []).length > 0)
            .map(peer => field(peer, 'peer_id')).sort((a, b) => a - b);
    }
    async function applied() {
        const network = await api.get(`networks/${networkId}`);
        if (network.deployment?.state !== 'applied') return false;
        if (!network.deployment.gateway?.running || network.deployment.gateway.state !== 'applied') return false;
        if (network.deployment.devices.length !== 2) return false;
        if (!network.deployment.devices.every(device => device.state === 'applied' && device.desired_revision && device.applied_revision === device.desired_revision)) return false;
        return network;
    }
    try {
        web = startWeb(database, ports.api, ports.config, '127.0.0.1', { protocol: 'tcp', gateway: true });
        processes.push(web);
        api = httpApi(`http://127.0.0.1:${ports.api}`);
        await waitFor(() => api.raw('GET', '/auth/config').then(response => response.status === 200), 'native Web startup');
        const owner = seedUser(database, username, passwordHash);
        for (let index = 0; index < ids.length; index++) seedOfflineDevice(database, owner, ids[index], `central-native-${index}`);
        await api.post('auth/login', { username, password: createHash('md5').update('e2e-password').digest('hex') });
        const tokens = [];
        await step('bound device credentials issued without exposing token in lists', async () => {
            for (let index = 0; index < ids.length; index++) {
                const token = await api.post('device-access-tokens', { label: `native-${index}`, machine_id: ids[index] });
                trackSecret(token.token); tokens.push(token.token);
            }
            const listed = await api.get('device-access-tokens');
            assert.equal(listed.tokens.length, 2);
            assert.ok(!tokens.some(token => JSON.stringify(listed).includes(token)));
        });
        const settings = { display_name: 'Native validation', network_name: `native-${randomUUID()}`, networking_method: 'Gateway',
            peer_urls: [], virtual_cidr: '10.246.252.0/29', secure_mode: true };
        const network = await api.post('networks', { settings, network_secret: networkSecret });
        networkId = network.network_id;
        await step('offline members keep pending deployment while no-TUN overrides commit', async () => {
            await api.post(`networks/${networkId}/members`, { device_ids: [ids[0]], temporary: false }, 204);
            await api.post(`networks/${networkId}/members`, { device_ids: [ids[1]], temporary: true, ttl_seconds: 3600 }, 204);
            for (let index = 0; index < ids.length; index++) {
                await api.patch(memberPath(ids[index]), { virtual_ipv4: `10.246.252.${index + 1}` });
                const config = { no_tun: true, disable_upnp: true, bind_device: false, disable_p2p: true, multi_thread: false,
                    listener_urls: ['tcp://127.0.0.1:0'] };
                if (index === 0) config.vpn_portal_config = { enabled: true, wireguard_listen: `127.0.0.1:${ports.portal}`,
                    wireguard_private_key: portalKey, clients: [{ name: 'phone', virtual_ip: '10.246.252.5/29', groups: [] }] };
                await api.put(`${memberPath(ids[index])}/config`, { config });
            }
            const saved = await api.get(`networks/${networkId}`);
            assert.equal(saved.deployment.state, 'waiting_offline');
            assert.ok(saved.deployment.devices.every(device => device.state === 'waiting_offline'));
        });
        for (let index = 0; index < ids.length; index++) {
            const coreDirectory = join(directory, `core-${index}`);
            await mkdir(coreDirectory, { mode: 0o700 });
            processes.push(startCore(coreDirectory, '127.0.0.1', ports.config, tokens[index], { protocol: 'tcp',
                machineId: ids[index], hostname: `central-native-${index}`, rpcPort: index === 0 ? ports.rpcA : ports.rpcB }));
        }
        await step('two actual Core instances apply the saved central snapshot', async () => {
            const network = await waitFor(applied, 'both native members applied', 45000);
            proof.applied_revisions = network.deployment.devices.map(device => ({ device_id: device.device_id, desired: device.desired_revision, applied: device.applied_revision }));
            for (const id of ids) {
                const config = await runtimeConfig(id);
                assert.equal(field(config, 'no_tun'), true);
                assert.equal(field(config, 'disable_upnp'), true);
            }
            const machines = await api.get('machines');
            for (const id of ids) {
                const machine = machines.machines.find(machine => JSON.stringify(field(machine.info, 'machine_id')) === JSON.stringify(protoUuid(id)));
                assert.ok(machine?.online, 'real enrolled member must be online');
                assert.ok(String(field(machine.info, 'easytier_version')).startsWith('2.7.0'), 'heartbeat must replace offline fixture metadata');
            }
        });
        await step('native interface discovery reports actual IPv4 /23 and ULA /64 masks', async () => {
            const interfaces = await waitFor(async () => {
                const response = await rpc(ids[0], 'api.instance.PeerManageRpcService', 'show_node_info');
                const networks = field(field(field(response, 'node_info'), 'ip_list'), 'interface_networks') || [];
                const v4 = networks.find(network => field(field(field(network, 'address'), 'ipv4'), 'addr') === 0x0a00030b);
                const ula = networks.find(network => {
                    const address = field(field(network, 'address'), 'ipv6');
                    return address && ((Number(field(address, 'part1')) >>> 24) & 0xfe) === 0xfc;
                });
                if (!v4 || !ula) return false;
                assert.equal(field(v4, 'prefix_length'), 23);
                assert.equal(field(ula, 'prefix_length'), 64);
                return networks;
            }, 'real host interface networks', 30000);
            proof.interface_networks = interfaces.map(network => {
                const address = field(network, 'address');
                const v4 = field(address, 'ipv4');
                const v6 = field(address, 'ipv6');
                let text;
                if (v4) { const n = Number(field(v4, 'addr')); text = [24,16,8,0].map(shift => (n >>> shift) & 255).join('.'); }
                if (v6) { text = [1,2,3,4].flatMap(part => { const n = Number(field(v6, `part${part}`) ?? 0); return [(n >>> 16).toString(16), (n & 65535).toString(16)]; }).join(':'); }
                return { name: field(network, 'name'), address: text, prefix_length: field(network, 'prefix_length') };
            });
        });
        const identities = await Promise.all(ids.map(nodeIdentity));
        assert.ok(identities.every(identity => Number(identity) > 0));
        const gatewayPeers = await waitFor(async () => {
            const peers = await gatewayPeerIds(ids[1]); return peers.length ? peers : false;
        }, 'temporary member connected to native Gateway');
        proof.peer_ids = identities;
        await step('Gateway topology identity matches actual connected native peer', async () => {
            const current = await api.get(`networks/${networkId}`);
            const gateway = current.deployment.gateway;
            assert.ok(Number(gateway.peer_id) > 0, 'published native Gateway must expose its real peer ID');
            assert.ok(gatewayPeers.includes(gateway.peer_id), 'Gateway status must map to the actual connected tunnel peer');
            assert.equal(gateway.peer_url, `tcp://127.0.0.1:${ports.config}`);
            proof.gateway_peer_id = gateway.peer_id;
        });
        await step('managed grants update hot while Core and Gateway peer identities remain stable', async () => {
            const credentials = await api.get(`networks/${networkId}/credentials`);
            const memberCredential = credentials.credentials.find(credential => credential.device_id === ids[1]);
            assert.equal(memberCredential.credential_id, ids[1]);
            const updated = await api.patch(`networks/${networkId}/credentials/${encodeURIComponent(ids[1])}`, {
                ttl_seconds: 7200, acl_groups: ['mobile'], allow_relay: true, allowed_proxy_cidrs: ['10.200.0.0/24'], reusable: false });
            assert.ok(updated.acl_groups.includes('mobile'));
            assert.ok(updated.acl_groups.some(group => group.startsWith('member:')));
            await waitFor(applied, 'grant change applied', 30000);
            assert.deepEqual(await Promise.all(ids.map(nodeIdentity)), identities);
            assert.deepEqual(await gatewayPeerIds(ids[1]), gatewayPeers);
            const observed = await rpc(ids[0], 'api.instance.CredentialManageRpcService', 'list_credentials');
            const credential = field(observed, 'credentials').find(credential => field(credential, 'credential_id') === ids[1]);
            assert.ok(field(credential, 'groups').includes('mobile'));
            assert.equal(field(credential, 'allow_relay'), true);
            assert.deepEqual(field(credential, 'allowed_proxy_cidrs'), ['10.200.0.0/24']);
        });
        await step('ICMPv6 ACL persists and reaches both native configurations', async () => {
            const policy = { default_action: 'allow', rules: [{ id: 'native-v6', name: 'Native ICMPv6', enabled: true, action: 'deny',
                sources: [{ type: 'group', name: 'mobile' }], destinations: [{ type: 'all' }],
                protocols: [{ protocol: 'icmpv6', ports: [], stateful: false }] }] };
            const saved = await api.put(`networks/${networkId}/acl-policy`, policy);
            assert.equal(saved.policy.rules[0].protocols[0].protocol, 'icmpv6');
            await waitFor(applied, 'ICMPv6 ACL applied', 30000);
            for (const id of ids) {
                const config = await runtimeConfig(id);
                const acl = field(config, 'acl');
                const rules = (field(field(acl, 'acl_v1'), 'chains') || []).flatMap(chain => field(chain, 'rules') || []);
                assert.ok(rules.some(rule => field(rule, 'protocol') === 'ICMPv6' || field(rule, 'protocol') === 4));
            }
        });
        await step('real native stats and authenticated Prometheus HTTP export', async () => {
            for (const id of ids) {
                const stats = await rpc(id, 'api.instance.StatsRpcService', 'get_stats');
                assert.ok(Array.isArray(field(stats, 'metrics')) && field(stats, 'metrics').length > 0);
                proof.stats_sample = field(stats, 'metrics').slice(0, 8).map(metric => ({ name: field(metric, 'name'), value: field(metric, 'value'), keys: Object.keys(metric) }));
                proof.stats_omitted_zero = field(stats, 'metrics').filter(metric => field(metric, 'value') === undefined).slice(0, 4).map(metric => ({ name: field(metric, 'name'), keys: Object.keys(metric), normalized_value: '0' }));
                // Proto3 JSON omits a scalar uint64 whose defined default is
                // zero. An existing named metric with omitted value is known
                // zero; an absent metric remains unavailable.
                assert.ok(field(stats, 'metrics').every(metric => field(metric, 'name') && /^\d+$/.test(String(field(metric, 'value') ?? 0))));
                const prometheus = await api.get(`machines/${id}/networks/${networkId}/metrics`);
                assert.ok(typeof prometheus === 'string' && /^# TYPE (traffic_|peer_rpc_)/m.test(prometheus));
                proof.prometheus_types = prometheus.split('\n').filter(line => line.startsWith('# TYPE')).slice(0, 8);
                const anonymous = await httpApi(`http://127.0.0.1:${ports.api}`).raw('GET', `machines/${id}/networks/${networkId}/metrics`);
                assert.ok([302, 401, 403].includes(anonymous.status));
            }
        });
        await step('named WireGuard Portal clients export independent configurations', async () => {
            const portal = field(await rpc(ids[0], 'api.instance.VpnPortalRpcService', 'get_vpn_portal_info'), 'vpn_portal_info');
            const clients = field(portal, 'clients');
            assert.ok(clients.some(client => field(client, 'name') === 'phone'));
            for (const client of clients) {
                const text = field(client, 'client_config');
                assert.ok(typeof text === 'string' && text.includes('[Interface]') && text.includes('[Peer]'));
                const key = text.match(/PrivateKey\s*=\s*(\S+)/)?.[1]; if (key) trackSecret(key);
            }
            const override = await api.get(`${memberPath(ids[0])}/config`);
            override.vpn_portal_config.clients.push({ name: 'tablet', virtual_ip: '10.246.252.6/29', groups: [] });
            await api.put(`${memberPath(ids[0])}/config`, { config: override });
            await waitFor(applied, 'Portal client addition applied', 30000);
            assert.equal(await nodeIdentity(ids[0]), identities[0]);
            const observed = field(await rpc(ids[0], 'api.instance.VpnPortalRpcService', 'get_vpn_portal_info'), 'vpn_portal_info');
            const named = field(observed, 'clients');
            assert.deepEqual(named.map(client => field(client, 'name')).sort(), ['phone', 'tablet']);
            assert.ok(field(named[0], 'client_config') !== field(named[1], 'client_config'));
            for (const client of named) {
                const key = field(client, 'client_config').match(/PrivateKey\s*=\s*(\S+)/)?.[1]; if (key) trackSecret(key);
            }
        });
        await step('central runtime credentials cannot be changed through ephemeral proxy RPC', async () => {
            await api.post(`machines/${ids[0]}/proxy-rpc`, { service_name: 'api.instance.CredentialManageRpcService', method_name: 'generate_credential',
                payload: { instance: { id: protoUuid(networkId) }, ttl_seconds: 3600, groups: [] } }, 409);
        });
        await step('deleting the network withdraws both actual managed instances', async () => {
            await api.delete(`networks/${networkId}`);
            await waitFor(async () => {
                for (const id of ids) {
                    const instances = await api.post(`machines/${id}/proxy-rpc`, { service_name: 'api.manage.WebClientService',
                        method_name: 'list_network_instance', payload: {} });
                    if ((field(instances, 'inst_ids') || []).some(instance => JSON.stringify(instance) === JSON.stringify(protoUuid(networkId)))) return false;
                }
                return true;
            }, 'both native instances removed', 30000);
        });
        assertNoSecretLogs(processes);
        proof.status = 'PASS';
    } catch (error) {
        proof.status = 'FAIL'; proof.error = error.message; throw error;
    } finally {
        for (const process of processes.slice(1).reverse()) await stopCore(process);
        if (web) await stopWeb(web);
        proof.processes_stopped = processes.every(process => process.child.exitCode !== null || process.child.signalCode !== null);
        for (let index = 0; index < processes.length; index++) await writeFile(join(directory, `process-${index}.log`), processes[index].logs(), { mode: 0o600 });
        await writeFile(join(directory, 'proof.json'), JSON.stringify(proof, null, 2), { mode: 0o600 });
        console.log(`PROOF=${join(directory, 'proof.json')}`);
    }
});
