// Explicit integration test: prebuilt native Web/Core, fresh loopback-only netns.
// No compilation, production connections, TUN devices or host route changes.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import {
    webBinary, coreBinary, requireBinaries, freePort, waitFor, startWeb, startCore,
    stopWeb, stopCore, seedUser, seedOfflineDevice, trackSecret, maskSecrets,
    assertNoSecretLogs, httpApi, sqlite,
} from './e2e-native-helpers.mjs';

const passwordHash = '$argon2id$v=19$m=4096,t=3,p=1$ZWFzeXRpZXItZTJlLXNhbHQ$FHbDjVElaTXuArgEEQrQrO4AdsnqNOcXGA5PFY8cG/s';
const safe = {
    no_tun: true, disable_upnp: true, bind_device: false, disable_p2p: true,
    disable_ipv6: true, multi_thread: false, enable_manual_routes: false,
    disable_udp_hole_punching: true, disable_tcp_hole_punching: true, disable_sym_hole_punching: true,
    proxy_cidrs: [], routes: [], exit_nodes: [], listener_urls: ['tcp://127.0.0.1:0'],
    stun_servers: { values: [] }, tcp_stun_servers: { values: [] }, stun_servers_v6: { values: [] },
};

async function isolatedNetworkSnapshot() {
    assert.equal(process.env.ET_TEST_NETWORK_ISOLATED, '1', 'run in a fresh loopback-only network namespace');
    assert.notEqual(await readlink('/proc/self/ns/net'), await readlink('/proc/1/ns/net'), 'refusing the host network namespace');
    const devices = (await readFile('/proc/net/dev', 'utf8')).split('\n').slice(2)
        .filter(line => line.includes(':')).map(line => line.split(':')[0].trim()).sort();
    assert.deepEqual(devices, ['lo'], 'the namespace may contain only loopback');
    const routes = (await readFile('/proc/net/route', 'utf8')).trim().split('\n').slice(1).filter(Boolean);
    assert.ok(routes.every(line => line.trim().split(/\s+/)[0] === 'lo'), 'no egress routes are allowed');
    assert.ok(routes.every(line => line.trim().split(/\s+/)[1] !== '00000000'), 'no default route is allowed');
    return { devices, routes };
}

function signalCore(core, signal) {
    if (!core || core.child.exitCode !== null || core.child.signalCode !== null) return false;
    try { process.kill(core.child.pid, signal); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

function observation(member) {
    return {
        member_id: member.member_id, device_id: member.device_id, online: member.online,
        running: member.running, error_msg: member.error_msg ?? null,
        runtime_query_error: member.runtime_query_error ?? null,
        deployment_state: member.deployment?.state,
        deployment_error: member.deployment?.last_error ?? null,
        desired_revision: member.deployment?.desired_revision,
        applied_revision: member.deployment?.applied_revision,
    };
}

async function fileDigest(path) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex');
}

await test('UDP member observation survives silent client loss without reporting an instance/configuration failure', { timeout: 180000 }, async () => {
    const namespaceBefore = await isolatedNetworkSnapshot();
    await requireBinaries(webBinary, coreBinary);
    const output = resolve(process.env.ET_NATIVE_E2E_OUTPUT || tmpdir());
    await mkdir(output, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(output, 'member-offline-native-'));
    const privateRuntime = join(directory, 'private-runtime');
    await mkdir(privateRuntime, { mode: 0o700 });
    const database = join(privateRuntime, 'web.db');
    const coreDirectory = join(privateRuntime, 'core');
    await mkdir(coreDirectory, { mode: 0o700 });
    const ports = { api: await freePort(), config: await freePort() };
    assert.notEqual(ports.api, ports.config);
    const machineId = randomUUID();
    const processes = [], failures = [];
    const proof = {
        test: 'member-offline-native', started_at: new Date().toISOString(),
        scope: 'actual native Web + managed native Core over loopback UDP; SIGSTOP affects only the dedicated Core process',
        exclusions: 'does not invoke Android VPNService or simulate Android UI; verifies the silent UDP management disconnect seen by the network GUI',
        binary_paths: { web: webBinary, core: coreBinary },
        binary_sha256: { web: await fileDigest(webBinary), core: await fileDigest(coreBinary) }, ports, checks: [],
    };
    let web, core, api, networkId, owner, token;

    async function step(name, action, { continueOnFailure = false } = {}) {
        const started = Date.now();
        try {
            const result = await action();
            proof.checks.push({ name, status: 'PASS', elapsed_ms: Date.now() - started });
            console.log(`PASS ${name}`);
            return result;
        } catch (error) {
            const safeError = maskSecrets(String(error?.stack || error));
            proof.checks.push({ name, status: 'FAIL', elapsed_ms: Date.now() - started, error: safeError });
            failures.push(safeError);
            console.log(`FAIL ${name}`);
            if (!continueOnFailure) throw error;
        }
    }
    async function member() {
        const response = await api.get(`networks/${networkId}/members`, 200, { timeout: 12000 });
        assert.equal(response.members.length, 1, 'the fixture must retain exactly one member');
        return response.members.find(row => row.device_id === machineId);
    }
    async function applied() {
        const row = await member();
        return row?.online && row.running === true && !row.error_msg && !row.runtime_query_error
            && row.deployment?.state === 'applied' && row.deployment.desired_revision
            && row.deployment.desired_revision === row.deployment.applied_revision ? row : false;
    }
    function durableSnapshot() {
        // Heartbeat timestamps and endpoint addresses are intentionally dynamic.
        // Hash stable business content; never emit credential/configuration data.
        return sqlite(database, [
            'import hashlib',
            'def digest(rows): return hashlib.sha256(json.dumps(rows,sort_keys=True).encode()).hexdigest()',
            'uid=int(sys.argv[2]); nid=sys.argv[3]',
            'tables=["users","networks","network_members","devices","device_access_tokens","user_running_network_configs","managed_config_revisions"]',
            'counts={table:db.execute("SELECT COUNT(*) FROM "+table).fetchone()[0] for table in tables}',
            'members=db.execute("SELECT id,device_id,virtual_ipv4,allocated_ipv4,override_config,credential_id,acl_group_secret FROM network_members WHERE user_id=? AND network_id=? ORDER BY id",(uid,nid)).fetchall()',
            'tokens=db.execute("SELECT id,user_id,machine_id,token_hash,auth_generation,revoked_at,expires_at FROM device_access_tokens WHERE user_id=? ORDER BY id",(uid,)).fetchall()',
            'devices=db.execute("SELECT user_id,machine_id,alias,first_seen_time FROM devices WHERE user_id=? ORDER BY machine_id",(uid,)).fetchall()',
            'configs=db.execute("SELECT user_id,device_id,network_instance_id,network_config,source FROM user_running_network_configs WHERE user_id=? ORDER BY device_id,network_instance_id",(uid,)).fetchall()',
            'revisions=db.execute("SELECT device_id,config_revision FROM managed_config_revisions WHERE user_id=? ORDER BY device_id",(uid,)).fetchall()',
            'print(json.dumps({"counts":counts,"members":digest(members),"tokens":digest(tokens),"devices":digest(devices),"configs":digest(configs),"revisions":digest(revisions)}))',
        ].join('\n'), [owner, networkId]);
    }
    function launchCore() {
        core = startCore(coreDirectory, '127.0.0.1', ports.config, token, {
            protocol: 'udp', machineId, hostname: 'offline-native-device', logLevel: 'warn',
        });
        processes.push(core);
    }
    try {
        web = startWeb(database, ports.api, ports.config, '127.0.0.1', {
            protocol: 'udp', configBindAddr: '127.0.0.1', gateway: false, logLevel: 'warn',
        });
        processes.push(web);
        api = httpApi(`http://127.0.0.1:${ports.api}`);
        await waitFor(() => api.raw('GET', '/auth/config').then(response => response.status === 200), 'isolated native Web startup');
        const username = `offline-native-${randomUUID()}`;
        owner = seedUser(database, username, passwordHash);
        seedOfflineDevice(database, owner, machineId, 'offline-native-device');
        await api.post('auth/login', { username, password: createHash('md5').update('e2e-password').digest('hex') });
        token = trackSecret((await api.post('device-access-tokens', { label: 'offline-native-device', machine_id: machineId })).token);
        const network = await api.post('networks', {
            settings: { display_name: 'Offline lifecycle regression', network_name: `offline-${randomUUID()}`,
                networking_method: 'Standalone', peer_urls: [], virtual_cidr: '10.246.253.0/29', secure_mode: true },
            network_secret: trackSecret(randomBytes(32).toString('base64url')),
        });
        networkId = network.network_id;
        await api.post(`networks/${networkId}/members`, { device_ids: [machineId], temporary: false }, 204);
        await api.patch(`networks/${networkId}/members/${machineId}`, { virtual_ipv4: '10.246.253.1' });
        await api.put(`networks/${networkId}/members/${machineId}/config`, { config: safe });
        launchCore();
        const initial = await step('real UDP Core applies its saved network before interruption', () => waitFor(applied, 'native UDP member applied', 45000));
        proof.initial = observation(initial);
        const durableBefore = durableSnapshot();
        proof.durable_before = durableBefore;

        const stoppedAt = Date.now();
        assert.ok(signalCore(core, 'SIGSTOP'), 'the dedicated Core must still be running before SIGSTOP');
        await waitFor(async () => /^State:\s+T/m.test(await readFile(`/proc/${core.child.pid}/status`, 'utf8')), 'Core process stopped', 3000);
        proof.core_stopped_confirmed = true;
        await step('five-second UDP observation timeout is distinct from an instance or deployment failure', async () => {
            const began = Date.now();
            const row = await member();
            proof.timeout_window = { ...observation(row), elapsed_ms: Date.now() - began, since_stop_ms: Date.now() - stoppedAt };
            proof.durable_after_timeout = durableSnapshot();
            assert.deepEqual(proof.durable_after_timeout, durableBefore, 'read-only timeout polling must not mutate business data');
            assert.ok(proof.timeout_window.elapsed_ms >= 4000, 'exercise the real RPC deadline rather than an immediate disconnected response');
            assert.ok(proof.timeout_window.since_stop_ms < 25000, 'the sample must precede the default 30-second session expiry');
            assert.equal(row.online, true, 'UDP receive timeout has not yet confirmed the session offline');
            assert.equal(row.running ?? null, null, 'running state is unobserved while packets cannot return');
            assert.equal(row.error_msg ?? null, null, 'an observation timeout is not an instance error');
            assert.equal(row.runtime_query_error, 'timeout', 'the API must expose a typed observation timeout');
            assert.notEqual(row.deployment?.state, 'failed', 'a read timeout must not mark configuration deployment failed');
            assert.equal(row.deployment?.last_error ?? null, null);
        }, { continueOnFailure: true });

        const offline = await step('expired UDP session becomes offline without raw runtime errors', async () => {
            const row = await waitFor(async () => { const value = await member(); return value?.online === false ? value : false; }, 'UDP receive timeout confirms offline', 45000);
            proof.offline = { ...observation(row), since_stop_ms: Date.now() - stoppedAt };
            assert.equal(row.running ?? null, null);
            assert.equal(row.error_msg ?? null, null);
            assert.ok(row.runtime_query_error == null, 'confirmed offline members must not carry a stale observation timeout');
            assert.equal(row.deployment?.state, 'waiting_offline');
            assert.equal(row.deployment?.last_error ?? null, null);
            assert.deepEqual(durableSnapshot(), durableBefore);
            return row;
        });
        assert.equal(offline.member_id, initial.member_id);

        await step('same Core identity reconnects and reapplies without new membership or credentials', async () => {
            const resumed = signalCore(core, 'SIGCONT');
            proof.core_resume_sent = resumed;
            if (!resumed) { proof.core_resume_required_relaunch = true; launchCore(); }
            let restored;
            try { restored = await waitFor(applied, 'same native UDP Core reconnected', 55000); }
            catch (error) {
                if (core.child.exitCode === null && core.child.signalCode === null) throw error;
                proof.core_resume_required_relaunch = true;
                launchCore();
                restored = await waitFor(applied, 'same native UDP Core restarted after exit', 30000);
            }
            proof.restored = observation(restored);
            assert.equal(restored.member_id, initial.member_id);
            assert.equal(restored.device_id, initial.device_id);
            assert.deepEqual(durableSnapshot(), durableBefore, 'reconnect must preserve credentials, memberships and desired configurations');
        });

        await step('a replacement session discards an already pending old-session observation', async () => {
            const oldCore = core;
            assert.ok(signalCore(oldCore, 'SIGSTOP'));
            await waitFor(async () => /^State:\s+T/m.test(await readFile(`/proc/${oldCore.child.pid}/status`, 'utf8')), 'old Core stopped before takeover', 3000);
            const began = Date.now();
            // Keep the request running while another process authenticates the
            // same identity. An old RPC completion must not describe its successor.
            const pending = member();
            await delay(500);
            const replacementDirectory = join(privateRuntime, 'replacement-core');
            await mkdir(replacementDirectory, { mode: 0o700 });
            core = startCore(replacementDirectory, '127.0.0.1', ports.config, token, {
                protocol: 'udp', machineId, hostname: 'offline-native-replacement', logLevel: 'warn',
            });
            processes.push(core);
            const ready = waitFor(applied, 'replacement UDP Core authenticated and applied', 30000);
            const oldResult = await pending;
            proof.replacement = observation(await ready);
            proof.session_takeover = { ...observation(oldResult), elapsed_ms: Date.now() - began };
            proof.durable_after_takeover = durableSnapshot();
            assert.deepEqual(proof.durable_after_takeover, durableBefore);
            assert.equal(oldResult.online, true, 'the new authenticated session remains online');
            assert.equal(oldResult.running ?? null, null, 'runtime data from the old session must be discarded');
            assert.equal(oldResult.error_msg ?? null, null, 'old transport failure must not become a new instance error');
            assert.ok(oldResult.runtime_query_error == null, 'old query diagnostics must not contaminate the replacement session');
            assert.notEqual(oldResult.deployment?.state, 'failed');
            assert.equal((await applied()).member_id, initial.member_id);
        }, { continueOnFailure: true });
        assertNoSecretLogs(processes);
    } catch (error) {
        const safeError = maskSecrets(String(error?.stack || error));
        if (!failures.includes(safeError)) failures.push(safeError);
    } finally {
        // SIGCONT always precedes shutdown: a suspended Core cannot process SIGINT.
        for (const item of processes.filter(item => item !== web)) signalCore(item, 'SIGCONT');
        await Promise.all(processes.filter(item => item !== web).map(stopCore));
        await stopWeb(web);
        try { assert.deepEqual(await isolatedNetworkSnapshot(), namespaceBefore); }
        catch (error) { failures.push(maskSecrets(String(error?.stack || error))); }
        proof.owned_processes_released = processes.every(item => item.child.exitCode !== null || item.child.signalCode !== null);
        if (!proof.owned_processes_released) failures.push('a fixture process was not released');
        for (let index = 0; index < processes.length; index++) await writeFile(join(directory, `process-${index}.log`), processes[index].logs(), { mode: 0o600 });
        await rm(privateRuntime, { recursive: true, force: true });
        proof.temporary_database_removed = true;
        proof.finished_at = new Date().toISOString();
        proof.status = failures.length ? 'FAIL' : 'PASS';
        proof.failures = failures;
        await writeFile(join(directory, 'proof.json'), `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
        console.log(`Evidence: ${join(directory, 'proof.json')}`);
    }
    if (failures.length) throw new Error(failures.join('\n'));
});
