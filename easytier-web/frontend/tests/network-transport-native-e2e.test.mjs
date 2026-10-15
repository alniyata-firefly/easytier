// Explicit native integration test: use prebuilt binaries in an isolated netns.
// The wrapper must create a fresh namespace, enable only lo, and set
// ET_TEST_NETWORK_ISOLATED=1. This test never creates a namespace or host routes.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
    webBinary, coreBinary, requireBinaries, freePort, waitFor,
    startWeb, stopWeb, startCore, stopCore, seedUser, seedOfflineDevice,
    protoUuid, trackSecret, maskSecrets, assertNoSecretLogs, httpApi, sqlite,
} from './e2e-native-helpers.mjs';

const passwordHash = '$argon2id$v=19$m=4096,t=3,p=1$ZWFzeXRpZXItZTJlLXNhbHQ$FHbDjVElaTXuArgEEQrQrO4AdsnqNOcXGA5PFY8cG/s';
const field = (value, key) => value?.[key] ?? value?.[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
const keys = ['data_compress_algo', 'enable_kcp_proxy', 'disable_kcp_input', 'enable_quic_proxy', 'disable_quic_input',
    'encryption_algorithm', 'disable_encryption', 'default_protocol', 'tld_dns_zone'];
const inherited = [
    { data_compress_algo: 1, enable_kcp_proxy: false, disable_kcp_input: true, enable_quic_proxy: false, disable_quic_input: true,
        encryption_algorithm: 'aes-gcm', disable_encryption: false, default_protocol: 'tcp', tld_dns_zone: 'member-a.example.' },
    { data_compress_algo: 1, enable_kcp_proxy: true, disable_kcp_input: false, enable_quic_proxy: true, disable_quic_input: false,
        encryption_algorithm: 'aes-gcm', disable_encryption: false, default_protocol: 'tcp', tld_dns_zone: 'member-b.example.' },
];
const policyA = { data_compress_algo: 2, enable_kcp_proxy: true, disable_kcp_input: false, enable_quic_proxy: false, disable_quic_input: true,
    encryption_algorithm: 'aes-256-gcm', disable_encryption: false, default_protocol: 'tcp', tld_dns_zone: 'network-one.example.' };
const policyB = { data_compress_algo: 1, enable_kcp_proxy: false, disable_kcp_input: true, enable_quic_proxy: true, disable_quic_input: false,
    encryption_algorithm: 'chacha20', disable_encryption: false, default_protocol: 'udp', tld_dns_zone: 'network-two.example.' };
const safe = {
    no_tun: true, disable_upnp: true, bind_device: false, disable_p2p: true,
    disable_ipv6: true, multi_thread: false, enable_manual_routes: false,
    disable_udp_hole_punching: true, disable_tcp_hole_punching: true, disable_sym_hole_punching: true,
    proxy_cidrs: [], routes: [], exit_nodes: [], listener_urls: ['tcp://127.0.0.1:0'],
    stun_servers: { values: [] }, tcp_stun_servers: { values: [] }, stun_servers_v6: { values: [] },
};

async function isolatedNetworkSnapshot() {
    assert.equal(process.env.ET_TEST_NETWORK_ISOLATED, '1', 'run this fixture in a fresh loopback-only network namespace');
    assert.notEqual(await readlink('/proc/self/ns/net'), await readlink('/proc/1/ns/net'), 'refusing the host network namespace');
    const devices = (await readFile('/proc/net/dev', 'utf8')).split('\n').slice(2)
        .filter(line => line.includes(':')).map(line => line.split(':')[0].trim()).sort();
    assert.deepEqual(devices, ['lo'], 'the test namespace must have only its loopback interface');
    const routes = (await readFile('/proc/net/route', 'utf8')).trim().split('\n').slice(1).filter(Boolean);
    assert.ok(routes.every(line => line.trim().split(/\s+/)[0] === 'lo'), 'the test namespace must have no egress routes');
    assert.ok(routes.every(line => line.trim().split(/\s+/)[1] !== '00000000'), 'the test namespace must have no default route');
    return { devices, routes };
}

// ConfigRpc converts the native configuration back to its protobuf model. Its
// default compression (None=1) can be omitted; all directional booleans are set.
function transportOf(config) {
    const defaults = { data_compress_algo: 1, encryption_algorithm: 'aes-gcm' };
    return Object.fromEntries(keys.map(key => [key, field(config, key) ?? defaults[key]]));
}
function assertSafeConfig(config) {
    for (const key of ['no_tun', 'disable_upnp', 'disable_p2p', 'disable_ipv6',
        'disable_udp_hole_punching', 'disable_tcp_hole_punching', 'disable_sym_hole_punching']) {
        assert.equal(field(config, key), true, `native runtime safety flag ${key}`);
    }
    assert.equal(field(config, 'bind_device'), false);
    assert.deepEqual(field(config, 'proxy_cidrs') || [], []);
    assert.deepEqual(field(config, 'routes') || [], []);
    assert.deepEqual(field(config, 'exit_nodes') || [], []);
    for (const key of ['stun_servers', 'tcp_stun_servers', 'stun_servers_v6']) {
        assert.ok(field(config, key), 'native runtime must report the new optional list capability');
        assert.deepEqual(field(field(config, key), 'values') || [], [], 'STUN list must remain explicitly disabled');
    }
    const listeners = field(config, 'listener_urls') || [];
    assert.ok(listeners.length > 0 && listeners.every(value => /^tcp:\/\/127\.0\.0\.1:\d+\/?$/.test(value)), 'all member listeners must use IPv4 loopback');
}

await test('network transport reaches permanent/temporary native Core and embedded Gateway', { timeout: 240000 }, async () => {
    const namespaceBefore = await isolatedNetworkSnapshot();
    await requireBinaries(webBinary, coreBinary);
    const output = resolve(process.env.ET_NATIVE_E2E_OUTPUT || tmpdir());
    await mkdir(output, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(output, 'network-transport-native-'));
    const stateDirectory = join(directory, 'private-runtime');
    await mkdir(stateDirectory, { mode: 0o700 });
    const database = join(stateDirectory, 'web.db');
    const ports = { api: await freePort(), config: await freePort(), rpcA: await freePort(), rpcB: await freePort() };
    assert.equal(new Set(Object.values(ports)).size, Object.values(ports).length, 'fixture ports must be distinct');
    const processes = [];
    const cores = [];
    const ids = [randomUUID(), randomUUID()];
    const coreDirectories = ids.map((_, index) => join(stateDirectory, `core-${index}`));
    const checks = [];
    const proof = {
        scope: 'real native Web + two managed Core instances + embedded Gateway; loopback-only namespace; no TUN or host routes',
        transport_coverage: 'runtime outgoing proxy flags and compression, native input capability advertisements, Gateway recreation and input advertisements',
        exclusions: 'no synthetic TCP/UDP user payloads: this fixture verifies configuration application rather than proxy throughput or compression ratio',
        ports, checks,
    };
    let web;
    let api;
    let networkId;
    let owner;
    let tokens;
    let latestSettings;
    let failed;

    const memberPath = id => `networks/${networkId}/members/${id}`;
    const settings = {
        display_name: 'Transport validation', network_name: `transport-${randomUUID()}`, networking_method: 'Gateway',
        peer_urls: [], virtual_cidr: '10.246.252.0/29', secure_mode: true, prefer_ipv6: false,
    };
    async function step(name, action) {
        const started = Date.now();
        const value = await action();
        checks.push({ name, status: 'PASS', elapsed_ms: Date.now() - started });
        console.log(`PASS ${name}`);
        return value;
    }
    async function rpc(id, service, method, payload = {}) {
        return api.post(`machines/${id}/proxy-rpc`, {
            service_name: service, method_name: method,
            payload: { instance: { id: protoUuid(networkId) }, ...payload },
        });
    }
    async function runtimeConfig(id) {
        const config = field(await rpc(id, 'api.config.ConfigRpcService', 'get_config'), 'config');
        const secure = field(config, 'secure_mode');
        trackSecret(field(secure, 'local_private_key'));
        trackSecret(field(field(config, 'vpn_portal_config'), 'wireguard_private_key'));
        return config;
    }
    async function nodeInfo(id) {
        return field(await rpc(id, 'api.instance.PeerManageRpcService', 'show_node_info'), 'node_info');
    }
    async function nativeInputFeatures(id) {
        const info = await nodeInfo(id);
        const features = field(info, 'feature_flag');
        return { peer_id: field(info, 'peer_id'), kcp_input: !!field(features, 'kcp_input'), quic_input: !!field(features, 'quic_input') };
    }
    async function gatewayFromPermanent(expectedPolicy) {
        return waitFor(async () => {
            const network = await api.get(`networks/${networkId}`);
            const gateway = network.deployment?.gateway;
            if (!gateway?.running || gateway.state !== 'applied' || !gateway.peer_id) return false;
            const response = await rpc(ids[0], 'api.instance.PeerManageRpcService', 'list_route');
            const route = (field(response, 'routes') || []).find(item => field(item, 'peer_id') === gateway.peer_id);
            if (!route) return false;
            const features = field(route, 'feature_flag');
            const input = { kcp_input: !!field(features, 'kcp_input'), quic_input: !!field(features, 'quic_input') };
            if (expectedPolicy && (input.kcp_input !== !expectedPolicy.disable_kcp_input || input.quic_input !== !expectedPolicy.disable_quic_input)) return false;
            const peers = field(await rpc(ids[0], 'api.instance.PeerManageRpcService', 'list_peer'), 'peer_infos') || [];
            if (!peers.some(peer => field(peer, 'peer_id') === gateway.peer_id && (field(peer, 'conns') || []).length)) return false;
            return { peer_id: gateway.peer_id, peer_url: gateway.peer_url, ...input };
        }, 'actual embedded Gateway connected with expected input capabilities', 45000);
    }
    async function applied() {
        const network = await api.get(`networks/${networkId}`);
        const deployment = network.deployment;
        if (deployment?.state !== 'applied' || !deployment.gateway?.running || deployment.gateway.state !== 'applied') return false;
        if (deployment.devices.length !== 2 || !deployment.devices.every(device => device.state === 'applied'
            && device.desired_revision && device.applied_revision === device.desired_revision)) return false;
        return network;
    }
    async function assertRuntimes(expected) {
        const result = [];
        for (let index = 0; index < ids.length; index++) {
            const config = await runtimeConfig(ids[index]);
            assertSafeConfig(config);
            assert.deepEqual(transportOf(config), expected[index], `member ${index} native runtime transport`);
            assert.equal(field(config, 'mtu'), 1300 + index * 20, 'unrelated member MTU must be preserved');
            const input = await nativeInputFeatures(ids[index]);
            assert.equal(input.kcp_input, !expected[index].disable_kcp_input, 'KCP input capability must follow the input flag');
            assert.equal(input.quic_input, !expected[index].disable_quic_input, 'QUIC input capability must follow the input flag');
            result.push({ member: index === 0 ? 'permanent' : 'temporary', transport: transportOf(config), input });
        }
        return result;
    }
    async function saveTransport(value) {
        latestSettings = { ...latestSettings, transport: value };
        const saved = await api.put(`networks/${networkId}`, { settings: latestSettings });
        assert.deepEqual(saved.transport, value);
        return saved;
    }
    function durableSnapshot() {
        // Only hashes leave SQLite: generated configurations and member rows
        // contain synthetic secrets, which must not appear in assertion output.
        return sqlite(database, [
            'import hashlib',
            'def digest(rows): return hashlib.sha256(json.dumps(rows,sort_keys=True).encode()).hexdigest()',
            'nid=sys.argv[2]; uid=int(sys.argv[3])',
            'policy=db.execute("SELECT transport_config FROM networks WHERE id=? AND user_id=?",(nid,uid)).fetchone()[0]',
            'configs=db.execute("SELECT device_id,network_config FROM user_running_network_configs WHERE network_instance_id=? AND user_id=? ORDER BY device_id",(nid,uid)).fetchall()',
            'members=db.execute("SELECT id,device_id,virtual_ipv4,allocated_ipv4,override_config,credential_id,acl_group_secret FROM network_members WHERE network_id=? AND user_id=? ORDER BY device_id",(nid,uid)).fetchall()',
            'revisions=db.execute("SELECT device_id,config_revision FROM managed_config_revisions WHERE user_id=? ORDER BY device_id",(uid,)).fetchall()',
            'print(json.dumps({"policy":json.loads(policy),"configs":digest(configs),"members":digest(members),"revisions":revisions}))',
        ].join('\n'), [networkId, owner]);
    }
    function launchCore(index) {
        const core = startCore(coreDirectories[index], '127.0.0.1', ports.config, tokens[index], {
            protocol: 'tcp', machineId: ids[index], hostname: `transport-${index}`, logLevel: 'warn',
            rpcPort: index === 0 ? ports.rpcA : ports.rpcB,
        });
        cores[index] = core;
        processes.push(core);
        return core;
    }
    try {
        web = startWeb(database, ports.api, ports.config, '127.0.0.1', { protocol: 'tcp', gateway: true, logLevel: 'warn' });
        processes.push(web);
        api = httpApi(`http://127.0.0.1:${ports.api}`);
        await waitFor(() => api.raw('GET', '/auth/config').then(response => response.status === 200), 'native Web startup');
        const username = `transport-${randomUUID()}`;
        owner = seedUser(database, username, passwordHash);
        for (let index = 0; index < ids.length; index++) seedOfflineDevice(database, owner, ids[index], `transport-${index}`);
        await api.post('auth/login', { username, password: createHash('md5').update('e2e-password').digest('hex') });
        tokens = [];
        for (let index = 0; index < ids.length; index++) {
            tokens.push(trackSecret((await api.post('device-access-tokens', { label: `transport-${index}`, machine_id: ids[index] })).token));
            await mkdir(coreDirectories[index], { mode: 0o700 });
        }
        const created = await api.post('networks', { settings, network_secret: trackSecret(randomBytes(32).toString('base64url')) });
        networkId = created.network_id;
        latestSettings = { ...settings };
        assert.deepEqual(created.transport, {});
        await step('safe overrides exist before permanent and temporary Core enrollment', async () => {
            await api.post(`networks/${networkId}/members`, { device_ids: [ids[0]], temporary: false }, 204);
            await api.post(`networks/${networkId}/members`, { device_ids: [ids[1]], temporary: true, ttl_seconds: 3600 }, 204);
            // Register generated credential material with the helper's log
            // redactor before any native process can receive that material.
            await api.get(`networks/${networkId}/credentials`);
            for (let index = 0; index < ids.length; index++) {
                await api.patch(memberPath(ids[index]), { virtual_ipv4: `10.246.252.${index + 1}` });
                await api.put(`${memberPath(ids[index])}/config`, { config: { ...safe, ...inherited[index], mtu: 1300 + index * 20 } });
            }
            const members = (await api.get(`networks/${networkId}/members`)).members;
            assert.equal(members.find(member => member.device_id === ids[0])?.temporary, false);
            assert.equal(members.find(member => member.device_id === ids[1])?.temporary, true);
            assert.equal((await api.get(`networks/${networkId}`)).deployment.state, 'waiting_offline');
        });
        launchCore(0);
        launchCore(1);
        await step('both real Core runtimes inherit their distinct member transport settings', async () => {
            await waitFor(applied, 'initial native members applied', 45000);
            proof.inherited_runtime = await assertRuntimes(inherited);
            proof.initial_gateway = await gatewayFromPermanent();
        });
        const initialDurable = durableSnapshot();
        await step('Zstd and KCP outgoing/input policy overrides both member types and rebuilds Gateway', async () => {
            await saveTransport(policyA);
            await waitFor(applied, 'Zstd/KCP native policy applied', 45000);
            proof.policy_a_runtime = await assertRuntimes([policyA, policyA]);
            proof.policy_a_gateway = await gatewayFromPermanent(policyA);
            assert.notEqual(proof.policy_a_gateway.peer_id, proof.initial_gateway.peer_id, 'Gateway must rebuild for transport changes');
            assert.equal(durableSnapshot().members, initialDurable.members, 'network policy must not overwrite member inheritance');
        });
        await step('omitted transport preserves saved policy, live revisions and Gateway identity', async () => {
            const before = durableSnapshot();
            const { transport: omitted, ...withoutTransport } = latestSettings;
            assert.deepEqual(omitted, policyA);
            latestSettings = { ...withoutTransport, display_name: 'Transport validation renamed' };
            const response = await api.put(`networks/${networkId}`, { settings: latestSettings });
            assert.deepEqual(response.transport, policyA);
            await waitFor(applied, 'omitted transport retained', 30000);
            assert.deepEqual(durableSnapshot(), before, 'omitted policy must preserve compiled configurations and revisions');
            assert.equal((await gatewayFromPermanent(policyA)).peer_id, proof.policy_a_gateway.peer_id);
            await assertRuntimes([policyA, policyA]);
        });
        await step('offline member retains pending policy while online Core and Gateway switch to QUIC', async () => {
            await stopCore(cores[1]);
            await waitFor(async () => !(await api.get(`networks/${networkId}/members`)).members.find(member => member.device_id === ids[1])?.online,
                'temporary Core offline', 20000);
            await saveTransport(policyB);
            await waitFor(async () => {
                const network = await api.get(`networks/${networkId}`);
                const online = network.deployment.devices.find(device => device.device_id === ids[0]);
                const offline = network.deployment.devices.find(device => device.device_id === ids[1]);
                return online?.state === 'applied' && online.applied_revision === online.desired_revision
                    && offline?.state === 'waiting_offline' && network.deployment.state === 'waiting_offline';
            }, 'online policy applied and offline member pending', 45000);
            const config = await runtimeConfig(ids[0]);
            assertSafeConfig(config);
            assert.deepEqual(transportOf(config), policyB);
            proof.policy_b_gateway = await gatewayFromPermanent(policyB);
            assert.notEqual(proof.policy_b_gateway.peer_id, proof.policy_a_gateway.peer_id);
            assert.equal(durableSnapshot().members, initialDurable.members);
        });
        await step('reconnecting temporary Core receives the latest policy instead of its stale local copy', async () => {
            launchCore(1);
            const network = await waitFor(applied, 'reconnected native Core applied', 45000);
            proof.reconnected_runtime = await assertRuntimes([policyB, policyB]);
            proof.reconnected_revisions = network.deployment.devices.map(({ device_id, desired_revision, applied_revision }) => ({ device_id, desired_revision, applied_revision }));
        });
        await step('invalid algorithm, unknown transport field and wrong type fail without durable changes', async () => {
            const before = durableSnapshot();
            const gatewayBefore = (await gatewayFromPermanent(policyB)).peer_id;
            for (const transport of [{ data_compress_algo: 3 }, { enable_kcp_proxy: true, unknown_transport: true }, { disable_quic_input: 'false' },
                { encryption_algorithm: 'bad-cipher' }, { default_protocol: 'https' }, { tld_dns_zone: 'bad..example' }]) {
                await api.put(`networks/${networkId}`, { settings: { ...latestSettings, transport } }, [400, 422]);
                assert.deepEqual(durableSnapshot(), before, 'invalid transport must not change durable desired state');
                assert.deepEqual((await api.get(`networks/${networkId}`)).transport, policyB);
            }
            await waitFor(applied, 'valid native policy remains applied', 15000);
            await assertRuntimes([policyB, policyB]);
            assert.equal((await gatewayFromPermanent(policyB)).peer_id, gatewayBefore);
        });
        await step('explicit empty transport restores original per-member inheritance without removing membership', async () => {
            await saveTransport({});
            await waitFor(applied, 'inherited native transport restored', 45000);
            proof.restored_runtime = await assertRuntimes(inherited);
            proof.restored_gateway = await gatewayFromPermanent();
            assert.notEqual(proof.restored_gateway.peer_id, proof.policy_b_gateway.peer_id);
            const after = durableSnapshot();
            assert.deepEqual(after.policy, {});
            assert.equal(after.members, initialDurable.members);
            const members = (await api.get(`networks/${networkId}/members`)).members;
            assert.equal(members.length, 2);
            assert.equal(members.find(member => member.device_id === ids[1])?.temporary, true);
        });
        assertNoSecretLogs(processes);
        proof.status = 'PASS';
    } catch (error) {
        failed = error;
        proof.status = 'FAIL';
        proof.error = maskSecrets(String(error?.stack || error));
    } finally {
        await Promise.all(processes.filter(item => item !== web).map(stopCore));
        await stopWeb(web);
        try {
            assert.deepEqual(await isolatedNetworkSnapshot(), namespaceBefore, 'no interfaces or routes may be added by native fixtures');
        } catch (error) {
            failed ||= error;
            proof.status = 'FAIL';
            proof.cleanup_error = maskSecrets(String(error?.stack || error));
        }
        for (let index = 0; index < processes.length; index++) {
            await writeFile(join(directory, `process-${index}.log`), processes[index].logs(), { mode: 0o600 });
        }
        await rm(stateDirectory, { recursive: true, force: true });
        await writeFile(join(directory, 'proof.json'), `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
    }
    if (failed) throw new Error(maskSecrets(String(failed?.stack || failed)));
});
