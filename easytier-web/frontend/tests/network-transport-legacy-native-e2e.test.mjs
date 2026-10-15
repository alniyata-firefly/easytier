// Explicit integration test. Run the whole process tree in a fresh netns with
// only lo enabled and ET_TEST_NETWORK_ISOLATED=1. No native build is performed.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import {
    repo, webBinary, requireBinaries, freePort, waitFor, startWeb, stopWeb,
    startCore, stopCore, seedUser, seedOfflineDevice, protoUuid, trackSecret,
    maskSecrets, assertNoSecretLogs, httpApi, sqlite,
} from './e2e-native-helpers.mjs';

const legacyCore = resolve(process.env.ET_LEGACY_CORE_BIN || join(repo, '../runtime/legacy-core/easytier-core-2.7.1'));
const passwordHash = '$argon2id$v=19$m=4096,t=3,p=1$ZWFzeXRpZXItZTJlLXNhbHQ$FHbDjVElaTXuArgEEQrQrO4AdsnqNOcXGA5PFY8cG/s';
const field = (value, key) => value?.[key] ?? value?.[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
const safe = {
    no_tun: true, disable_upnp: true, bind_device: false, disable_p2p: true,
    disable_ipv6: true, multi_thread: false, disable_udp_hole_punching: true,
    disable_tcp_hole_punching: true, disable_sym_hole_punching: true,
    proxy_cidrs: [], routes: [], exit_nodes: [], listener_urls: ['tcp://127.0.0.1:0'],
};
const oldPolicy = { data_compress_algo: 2, enable_kcp_proxy: true, disable_kcp_input: false, enable_quic_proxy: false, disable_quic_input: true };

async function isolatedNetworkSnapshot() {
    assert.equal(process.env.ET_TEST_NETWORK_ISOLATED, '1', 'run in a fresh loopback-only network namespace');
    assert.notEqual(await readlink('/proc/self/ns/net'), await readlink('/proc/1/ns/net'), 'refusing the host network namespace');
    const devices = (await readFile('/proc/net/dev', 'utf8')).split('\n').slice(2)
        .filter(line => line.includes(':')).map(line => line.split(':')[0].trim()).sort();
    assert.deepEqual(devices, ['lo']);
    const routes = (await readFile('/proc/net/route', 'utf8')).trim().split('\n').slice(1).filter(Boolean);
    assert.ok(routes.every(line => line.trim().split(/\s+/)[0] === 'lo' && line.trim().split(/\s+/)[1] !== '00000000'));
    return { devices, routes };
}

await test('legacy 2.7.1 Core rejects new configuration without runtime restart or false application', { timeout: 180000 }, async () => {
    const namespaceBefore = await isolatedNetworkSnapshot();
    await requireBinaries(webBinary, legacyCore);
    const output = resolve(process.env.ET_NATIVE_E2E_OUTPUT || tmpdir());
    await mkdir(output, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(output, 'network-transport-legacy-native-'));
    const stateDirectory = join(directory, 'private-runtime');
    const coreDirectory = join(stateDirectory, 'legacy-core');
    await mkdir(coreDirectory, { recursive: true, mode: 0o700 });
    const database = join(stateDirectory, 'web.db');
    const ports = { api: await freePort(), config: await freePort(), rpc: await freePort() };
    assert.equal(new Set(Object.values(ports)).size, Object.values(ports).length);
    const processes = [];
    const checks = [];
    const proof = { scope: 'new native Web + real 2.7.1 Core + embedded Gateway, isolated loopback/no-TUN namespace', ports, checks };
    const id = randomUUID();
    const standaloneId = randomUUID();
    let networkId;
    let api;
    let web;
    let core;
    let token;
    let owner;
    let failed;
    const settings = { display_name: 'Legacy compatibility', network_name: `legacy-${randomUUID()}`,
        networking_method: 'Gateway', peer_urls: [], virtual_cidr: '10.246.251.0/29', secure_mode: false, prefer_ipv6: false };
    const standalone = { ...safe, instance_id: standaloneId, network_name: `standalone-${randomUUID()}`,
        network_secret: trackSecret(randomBytes(32).toString('base64url')), networking_method: 'Standalone', default_protocol: 'udp' };

    async function step(name, action) {
        const started = Date.now();
        await action();
        checks.push({ name, status: 'PASS', elapsed_ms: Date.now() - started });
        console.log(`PASS ${name}`);
    }
    async function rpc(service, method, payload = {}) {
        return api.post(`machines/${id}/proxy-rpc`, { service_name: service, method_name: method,
            payload: { instance: { id: protoUuid(networkId) }, ...payload } });
    }
    async function runtimeConfig() {
        return field(await rpc('api.config.ConfigRpcService', 'get_config'), 'config');
    }
    async function runtimeIdentity() {
        const info = field(await rpc('api.instance.PeerManageRpcService', 'show_node_info'), 'node_info');
        const instances = field(await rpc('api.manage.WebClientService', 'list_network_instance', {}), 'inst_ids') || [];
        return { peer_id: field(info, 'peer_id'), instance_count: instances.length };
    }
    function durableSnapshot() {
        return sqlite(database, [
            'import hashlib',
            'uid=int(sys.argv[2])',
            'rows=db.execute("SELECT network_instance_id,network_config,source,disabled FROM user_running_network_configs WHERE user_id=? ORDER BY network_instance_id",(uid,)).fetchall()',
            'print(json.dumps(hashlib.sha256(json.dumps(rows,sort_keys=True).encode()).hexdigest()))',
        ].join('\n'), [owner]);
    }
    function standaloneState() {
        return sqlite(database,
            'row=db.execute("SELECT disabled FROM user_running_network_configs WHERE user_id=? AND network_instance_id=?",(int(sys.argv[2]),sys.argv[3])).fetchone()\nprint(json.dumps(None if row is None else bool(row[0])))',
            [owner, standaloneId]);
    }
    function launchCore() {
        core = startCore(coreDirectory, '127.0.0.1', ports.config, token, {
            binary: legacyCore, machineId: id, hostname: 'legacy-transport', rpcPort: ports.rpc, protocol: 'tcp', logLevel: 'warn',
        });
        processes.push(core);
    }
    async function applied() {
        const network = await api.get(`networks/${networkId}`);
        const device = network.deployment?.devices.find(device => device.device_id === id);
        return network.deployment?.state === 'applied' && device?.state === 'applied'
            && device.desired_revision && device.applied_revision === device.desired_revision ? network : false;
    }
    async function rejectsUpgrade(method, path, body) {
        const response = await api.request(method, path, body, 400);
        assert.match(String(response.message), /2\.7\.2/, 'legacy refusal must explain the required upgrade');
    }
    try {
        web = startWeb(database, ports.api, ports.config, '127.0.0.1', { protocol: 'tcp', configBindAddr: '127.0.0.1', gateway: true, logLevel: 'warn' });
        processes.push(web);
        api = httpApi(`http://127.0.0.1:${ports.api}`);
        await waitFor(() => api.raw('GET', '/auth/config').then(response => response.status === 200), 'native Web startup');
        const username = `legacy-${randomUUID()}`;
        owner = seedUser(database, username, passwordHash);
        seedOfflineDevice(database, owner, id, 'legacy-transport');
        await api.post('auth/login', { username, password: createHash('md5').update('e2e-password').digest('hex') });
        token = trackSecret((await api.post('device-access-tokens', { label: 'legacy-transport', machine_id: id })).token);
        const created = await api.post('networks', { settings, network_secret: trackSecret(randomBytes(32).toString('base64url')) });
        networkId = created.network_id;
        await api.post(`networks/${networkId}/members`, { device_ids: [id], temporary: false }, 204);
        await api.put(`networks/${networkId}/members/${id}/config`, { config: safe });
        launchCore();
        await step('real legacy Core applies its original safe managed configuration', async () => {
            await waitFor(applied, 'legacy managed instance applied', 45000);
            const config = await runtimeConfig();
            assert.equal(field(config, 'no_tun'), true);
            assert.equal(field(config, 'disable_upnp'), true);
            assert.equal(field(config, 'bind_device'), false);
            assert.equal(field(config, 'disable_p2p'), true);
            assert.equal(field(config, 'default_protocol'), undefined, 'fixture must exercise the old Core DTO');
            assert.equal((await runtimeIdentity()).instance_count, 1);
        });
        await step('existing Zstd and KCP/QUIC settings remain supported on 2.7.1', async () => {
            await api.put(`networks/${networkId}`, { settings: { ...settings, transport: oldPolicy } });
            await waitFor(applied, 'legacy compression/KCP policy applied', 45000);
            const config = await runtimeConfig();
            for (const [key, value] of Object.entries(oldPolicy)) assert.equal(field(config, key), value, key);
        });
        const stableRuntime = await runtimeIdentity();
        await step('new DTO policy reports upgrade failure without restarting the legacy instance', async () => {
            await api.put(`networks/${networkId}`, { settings: { ...settings, transport: { ...oldPolicy, default_protocol: 'udp' } } });
            const rejected = await waitFor(async () => {
                const network = await api.get(`networks/${networkId}`);
                const device = network.deployment?.devices.find(device => device.device_id === id);
                return network.deployment?.state === 'failed' && device?.state === 'failed'
                    && /2\.7\.2/.test(device.last_error || '') ? network : false;
            }, 'explicit legacy upgrade failure', 30000);
            const device = rejected.deployment.devices.find(device => device.device_id === id);
            assert.notEqual(device.applied_revision, device.desired_revision, 'unsupported desired state must not be marked applied');
            proof.upgrade_error = device.last_error;
            proof.heartbeat_runtime_samples = [];
            for (let sample = 0; sample < 4; sample++) {
                await delay(3700);
                const identity = await runtimeIdentity();
                assert.deepEqual(identity, stableRuntime, 'legacy Core must retain peer ID and instance count across heartbeats');
                const current = await runtimeConfig();
                assert.equal(field(current, 'default_protocol'), undefined);
                assert.equal(field(current, 'no_tun'), true);
                const saved = await api.get(`networks/${networkId}`);
                assert.equal(saved.deployment.state, 'failed');
                proof.heartbeat_runtime_samples.push(identity);
            }
        });
        await step('standalone run, validation, live save and raw proxy Run reject before writes', async () => {
            const before = durableSnapshot();
            await rejectsUpgrade('POST', `machines/${id}/validate-config`, { config: standalone });
            await rejectsUpgrade('POST', `machines/${id}/networks`, { config: standalone, save: true });
            await rejectsUpgrade('PUT', `machines/${id}/networks/config/${standaloneId}`, { config: standalone });
            await rejectsUpgrade('POST', `machines/${id}/proxy-rpc`, { service_name: 'api.manage.WebClientService', method_name: 'run_network_instance',
                payload: { inst_id: protoUuid(standaloneId), config: standalone, overwrite: true, source: 2 } });
            assert.equal(durableSnapshot(), before);
            assert.equal(standaloneState(), null);
            assert.deepEqual(await runtimeIdentity(), stableRuntime);
        });
        await step('clearing the unsupported policy recovers without replacing the preserved old runtime', async () => {
            await api.put(`networks/${networkId}`, { settings: { ...settings, transport: oldPolicy } });
            await waitFor(applied, 'legacy policy recovered', 30000);
            assert.deepEqual(await runtimeIdentity(), stableRuntime);
        });
        await step('offline save stays disabled and legacy enable is refused after reconnect', async () => {
            await stopCore(core);
            await waitFor(async () => !(await api.get(`networks/${networkId}/members`)).members.find(member => member.device_id === id)?.online,
                'legacy Core offline', 20000);
            await api.put(`machines/${id}/networks/config/${standaloneId}`, { config: standalone });
            assert.equal(standaloneState(), true, 'offline draft must stay disabled');
            launchCore();
            await waitFor(applied, 'legacy Core reconnected without running disabled draft', 45000);
            assert.equal((await runtimeIdentity()).instance_count, 1);
            const before = durableSnapshot();
            await rejectsUpgrade('PUT', `machines/${id}/networks/${standaloneId}`, { disabled: false });
            assert.equal(durableSnapshot(), before);
            assert.equal(standaloneState(), true);
            assert.equal((await runtimeIdentity()).instance_count, 1);
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
            assert.deepEqual(await isolatedNetworkSnapshot(), namespaceBefore);
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
