import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import {
    webBinary, coreBinary, requireBinaries, freePort, waitFor, startWeb, startCore,
    stopCore, seedUser, seedOfflineDevice, sqlite, httpApi, trackSecret,
    assertNoSecretLogs, maskSecrets, protoUuid,
} from './e2e-native-helpers.mjs';

const passwordHash = '$argon2id$v=19$m=4096,t=3,p=1$ZWFzeXRpZXItZTJlLXNhbHQ$FHbDjVElaTXuArgEEQrQrO4AdsnqNOcXGA5PFY8cG/s';

test('actual HTTP approval recovers a reinstalled Core while pending clients receive no configuration', { timeout: 180000 }, async () => {
    await requireBinaries(webBinary, coreBinary);
    const temp = await mkdtemp(join(tmpdir(), 'easytier-device-rebind-native-'));
    const database = join(temp, 'web.db');
    const ports = { api: await freePort(), config: await freePort() };
    const oldId = randomUUID(), rejectedId = randomUUID(), newId = randomUUID();
    const processes = [];
    const proof = { scope: 'localhost HTTP + real UDP Core, no TUN', checks: [], started_at: new Date().toISOString() };
    const interfacesBefore = (await readdir('/sys/class/net')).sort();
    const check = value => proof.checks.push(value);
    const readMember = () => sqlite(database,
        "db.row_factory=sqlite3.Row\nprint(json.dumps(dict(db.execute('SELECT id,device_id,allocated_ipv4,credential_id,hostname_override FROM network_members WHERE user_id=?',(sys.argv[2],)).fetchone())))", [ownerId]);
    let ownerId, api, web, current;
    async function spawn(id, token) {
        const directory = join(temp, id); await mkdir(directory, { recursive: true });
        const item = startCore(directory, '127.0.0.1', ports.config, token, {
            protocol: 'udp', machineId: id, hostname: 'reinstalled-phone', rpcPort: await freePort(),
        });
        processes.push(item); return item;
    }
    try {
        web = startWeb(database, ports.api, ports.config, '127.0.0.1', {
            gateway: false, protocol: 'udp', configBindAddr: '127.0.0.1',
        });
        processes.push(web);
        api = httpApi(`http://127.0.0.1:${ports.api}`);
        await waitFor(async () => (await api.raw('GET', '/auth/config')).ok, 'local server');
        ownerId = seedUser(database, 'rebind-owner', passwordHash);
        seedUser(database, 'rebind-other', passwordHash);
        seedOfflineDevice(database, ownerId, oldId, 'original-phone');
        const login = { username: 'rebind-owner', password: createHash('md5').update('e2e-password').digest('hex') };
        await api.post('auth/login', login);
        const other = httpApi(`http://127.0.0.1:${ports.api}`);
        await other.post('auth/login', { ...login, username: 'rebind-other' });
        const anonymous = httpApi(`http://127.0.0.1:${ports.api}`);
        await anonymous.get('device-rebind-requests', 401);
        const issued = await api.post('device-access-tokens', { label: 'phone', machine_id: oldId });
        const networkName = `rebind-${randomUUID()}`;
        const network = await api.post('networks', {
            settings: { display_name: 'Recovery test', network_name: networkName,
                networking_method: 'Standalone', peer_urls: [], virtual_cidr: '100.64.244.0/29', secure_mode: true },
            network_secret: trackSecret(randomUUID()),
        });
        const networkId = network.network_id;
        const hasExpectedInstance = response => (response.running_inst_ids ?? []).some(id => {
            if (typeof id === 'string') return id === networkId;
            return Object.entries(protoUuid(networkId)).every(([part, value]) => id?.[part] === value);
        });
        await api.post(`networks/${networkId}/members`, { device_ids: [oldId], temporary: true, ttl_seconds: 86400 }, 204);
        await api.put(`networks/${networkId}/members/${oldId}/config`, { config: {
            no_tun: true, disable_upnp: true, disable_p2p: true, multi_thread: false,
            disable_ipv6: true, listener_urls: [],
        } });
        current = await spawn(oldId, issued.token);
        await waitFor(async () => (await api.get('sessions')).some(x => x.machine_id === oldId), 'original Core authorization');
        await waitFor(async () => hasExpectedInstance(await api.get(`machines/${oldId}/networks`)), 'original Core runs the no-TUN instance');
        assert.match(await readFile(join(temp, oldId, `${networkId}.toml`), 'utf8'), /no_tun\s*=\s*true/);
        const original = readMember();
        assert.ok(original.credential_id, 'the temporary member has a real VPN credential');
        const readVpnSecret = () => sqlite(database,
            "print(json.dumps(db.execute('SELECT credential_secret FROM network_credentials WHERE user_id=? AND network_id=? AND credential_id=?',(sys.argv[2],sys.argv[3],sys.argv[4])).fetchone()[0]))", [ownerId, networkId, original.credential_id]);
        const originalVpnSecret = trackSecret(readVpnSecret());
        await stopCore(current);
        await waitFor(async () => !(await api.get('sessions')).some(x => x.machine_id === oldId), 'original Core disconnect', 45000);
        current = await spawn(rejectedId, issued.token);
        const rejected = await waitFor(async () => (await api.get('device-rebind-requests')).requests.find(x => x.new_machine_id === rejectedId), 'actual mismatch creates pending request');
        assert.equal((await other.get('device-rebind-requests')).requests.length, 0);
        await other.post(`device-rebind-requests/${rejected.id}/approve`, undefined, 404);
        await other.post(`device-rebind-requests/${rejected.id}/reject`, undefined, 404);
        const listed = JSON.stringify(await api.get('device-rebind-requests'));
        assert.ok(!listed.includes(issued.token)); assert.ok(!listed.includes('token_hash'));
        assert.equal((await api.get('sessions')).some(x => x.machine_id === rejectedId), false);
        assert.equal((await readdir(join(temp, rejectedId))).some(x => x.endsWith('.toml')), false);
        check('mismatch remains unauthorized, exposes no config or token and is owner isolated');
        await api.post(`device-rebind-requests/${rejected.id}/reject`, undefined, 204);
        await delay(12000);
        assert.equal((await api.get('device-rebind-requests')).requests.some(x => x.new_machine_id === rejectedId), false);
        assert.deepEqual(readMember(), original);
        await stopCore(current);
        check('explicit rejection survives Core retries and preserves the original member');
        current = await spawn(newId, issued.token);
        const pending = await waitFor(async () => (await api.get('device-rebind-requests')).requests.find(x => x.new_machine_id === newId), 'new candidate pending approval');
        assert.equal(pending.old_machine_id, oldId);
        assert.equal((await readdir(join(temp, newId))).some(x => x.endsWith('.toml')), false);
        const approval = await api.post(`device-rebind-requests/${pending.id}/approve`);
        assert.equal(approval.old_machine_id, oldId); assert.equal(approval.new_machine_id, newId);
        assert.equal(approval.auth_generation, 2);
        await api.post(`device-rebind-requests/${pending.id}/approve`, undefined, 409);
        await waitFor(async () => (await api.get('sessions')).some(x => x.machine_id === newId), 'approved Core authenticates without changing the token');
        await waitFor(async () => hasExpectedInstance(await api.get(`machines/${newId}/networks`)), 'approved Core runs the preserved instance');
        const restoredConfig = await readFile(join(temp, newId, `${networkId}.toml`), 'utf8');
        assert.match(restoredConfig, /no_tun\s*=\s*true/);
        assert.ok(restoredConfig.includes(networkName));
        assert.deepEqual(readMember(), { ...original, device_id: newId });
        assert.equal(readVpnSecret(), originalVpnSecret);
        assert.equal(sqlite(database, "print(json.dumps(db.execute('SELECT COUNT(*) FROM devices WHERE user_id=? AND machine_id=?',(sys.argv[2],sys.argv[3])).fetchone()[0]))", [ownerId, oldId]), 0);
        const tokenInfo = (await api.get('device-access-tokens')).tokens.find(x => x.id === issued.info.id);
        assert.equal(tokenInfo.machine_id, newId); assert.equal(tokenInfo.auth_generation, 2);
        assert.equal((await api.get('device-rebind-requests')).requests.length, 0);
        check('explicit approval preserves member identity, allocated IP, VPN credential and restores actual Core configuration');
        assertNoSecretLogs(processes);
        assert.deepEqual((await readdir('/sys/class/net')).sort(), interfacesBefore);
        check('no secrets in process logs and no host interfaces created');
        proof.passed = true;
    } catch (error) {
        proof.passed = false; proof.error = maskSecrets(error.message);
        throw new Error(maskSecrets(`${error.message}\n${processes.map(x => x.logs()).join('\n')}`));
    } finally {
        for (const process of processes.slice().reverse()) await stopCore(process);
        proof.finished_at = new Date().toISOString();
        proof.owned_processes_released = processes.every(x => x.child.exitCode !== null || x.child.signalCode !== null);
        await rm(temp, { recursive: true, force: true });
        if (process.env.EASYTIER_E2E_PROOF) await writeFile(process.env.EASYTIER_E2E_PROOF, JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 });
    }
});
