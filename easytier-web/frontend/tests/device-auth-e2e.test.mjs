import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import {
    webBinary,coreBinary,requireBinaries,freePort,waitFor,startWeb,startCore,stopWeb,stopCore,
    seedUser,sqlite,httpApi,protoUuid,trackSecret,assertNoSecretLogs,maskSecrets,
} from './e2e-native-helpers.mjs';

const password = 'e2e-password';
// Existing integration-test fixture: Argon2id of the frontend's MD5 password.
const passwordHash = '$argon2id$v=19$m=4096,t=3,p=1$ZWFzeXRpZXItZTJlLXNhbHQ$FHbDjVElaTXuArgEEQrQrO4AdsnqNOcXGA5PFY8cG/s';

test('native HTTP authentication, device credentials, Core configuration and metrics remain isolated', {timeout:240000}, async () => {
    await requireBinaries(webBinary,coreBinary);
    const ports = {api:await freePort(),config:await freePort(),rpc:await freePort(),listener:await freePort()};
    const temp = await mkdtemp(join(tmpdir(),'easytier-device-auth-e2e-'));
    const database = join(temp,'web.db');
    const coreDir = join(temp,'core'); await mkdir(coreDir);
    const base = `http://127.0.0.1:${ports.api}`;
    const hostname = `auth-device-${randomUUID().slice(0,8)}`;
    const machineId = randomUUID(), instanceId = randomUUID();
    const proof = {test:'device-auth-native',started_at:new Date().toISOString(),ports,checks:[],real_core:true};
    const processes = []; let web; let core;
    const check = name => proof.checks.push(name);
    const netBefore = (await readdir('/sys/class/net')).sort();
    const spawnCore = async (token,id=machineId,name=hostname) => {
        const dir = id===machineId ? coreDir : join(temp,id); await mkdir(dir,{recursive:true});
        const item = startCore(dir,'127.0.0.1',ports.config,token,{machineId:id,hostname:name,rpcPort:await freePort()});
        processes.push(item); return item;
    };
    try {
        web = startWeb(database,ports.api,ports.config,'127.0.0.1',{
            gateway:false,advertisedUrl:`tcp://127.0.0.1:${ports.config}/managed/`,
            extraArgs:['--allow-auto-create-user'],
        }); processes.push(web);
        await waitFor(async () => (await fetch(`${base}/auth/config`)).ok,'isolated HTTP server');
        const ownerId = seedUser(database,'auth-owner-a',passwordHash);
        seedUser(database,'auth-owner-b',passwordHash);
        const owner = httpApi(base), other = httpApi(base), anonymous = httpApi(base);
        await owner.post('/api/v1/auth/login',{username:'auth-owner-a',password:createHash('md5').update(password).digest('hex')});
        await other.post('/api/v1/auth/login',{username:'auth-owner-b',password:createHash('md5').update(password).digest('hex')});
        const publicConfig = await anonymous.get('/auth/config');
        assert.equal(publicConfig.registration_enabled,false);
        const consoleInfo = await owner.get('/api/v1/console-info');
        assert.equal(consoleInfo.advertised_config_server_url,`tcp://127.0.0.1:${ports.config}/managed/`);
        check('actual HTTP login and advertised configuration endpoint');
        await anonymous.get('/api/v1/device-access-tokens',401);
        const issued = await owner.post('/api/v1/device-access-tokens',{label:'native laptop'});
        assert.equal(Buffer.from(issued.token,'base64url').length,32);
        assert.equal(issued.info.machine_id,null);
        assert.equal(issued.info.auth_generation,1);
        const storedHash = sqlite(database,"print(json.dumps(db.execute('SELECT token_hash FROM device_access_tokens WHERE id=?',(sys.argv[2],)).fetchone()[0]))",[issued.info.id]);
        assert.ok(storedHash === createHash('sha256').update(issued.token).digest('hex'),'database contains only the SHA-256 token digest');
        await other.post(`/api/v1/device-access-tokens/${issued.info.id}/rotate`,undefined,404);
        await other.delete(`/api/v1/device-access-tokens/${issued.info.id}`,404);
        const missingTokenId = randomUUID();
        await owner.post(`/api/v1/device-access-tokens/${missingTokenId}/rotate`,undefined,404);
        await owner.delete(`/api/v1/device-access-tokens/${missingTokenId}`,404);
        assert.equal((await other.get('/api/v1/device-access-tokens')).tokens.length,0);
        check('256-bit token, hash-only persistence and cross-owner lifecycle denial');

        core = await spawnCore(issued.token);
        const currentSession = async () => (await owner.get('/api/v1/sessions')).find(session=>session.machine_id===machineId);
        await waitFor(currentSession,'actual Core heartbeat and first-use device binding');
        const metadata = (await owner.get('/api/v1/device-access-tokens')).tokens.find(token=>token.id===issued.info.id);
        assert.equal(metadata.machine_id,machineId); assert.equal(metadata.status,'active');
        await other.delete(`/api/v1/machines/${machineId}`,404);
        assert.ok(await currentSession(),'cross-owner device deletion preserves the authorized session');
        const secrets = [issued.token];
        for (const path of ['/api/v1/sessions','/api/v1/machines','/api/v1/device-access-tokens','/api/v1/console-info']) {
            const json = JSON.stringify(await owner.get(path));
            assert.ok(secrets.every(secret=>!json.includes(secret)),`secret exposed by ${path}`);
        }
        const duplicate = await owner.post('/api/v1/device-access-tokens',{label:'duplicate',machine_id:machineId},409);
        assert.match(duplicate.message,/active access token/);
        const impostorId = randomUUID(); const impostor = await spawnCore(issued.token,impostorId,'wrong-device');
        await delay(3500);
        assert.equal(sqlite(database,"print(json.dumps(db.execute('SELECT COUNT(*) FROM devices WHERE user_id=? AND machine_id=?',(sys.argv[2],sys.argv[3])).fetchone()[0]))",[ownerId,impostorId]),0);
        await stopCore(impostor);
        assert.ok(await currentSession());
        check('Core binding, public API redaction, single credential and wrong-machine rejection');

        // Send a complete no-TUN configuration in the first request. No unsafe
        // interval exists between starting a member and applying an override.
        const config = {
            instance_id:instanceId,network_name:'auth-native-e2e',network_secret:trackSecret(randomUUID()),
            hostname,networking_method:2,dhcp:false,virtual_ipv4:'10.254.250.2',network_length:24,
            advanced_settings:true,no_tun:true,disable_upnp:true,disable_ipv6:true,multi_thread:false,
            disable_udp_hole_punching:true,disable_tcp_hole_punching:true,
            listener_urls:[`tcp://127.0.0.1:${ports.listener}`],
        };
        const hasInstance = response => (response.running_inst_ids ?? []).some(id => {
            if (typeof id === 'string') return id === instanceId;
            const expected = protoUuid(instanceId);
            return Object.entries(expected).every(([part,value]) => id?.[part] === value);
        });
        await owner.post(`/api/v1/machines/${machineId}/networks`,{config,save:true});
        await waitFor(async () => hasInstance(await owner.get(`/api/v1/machines/${machineId}/networks`)), 'Web configuration actually running in Core');
        const persisted = await readFile(join(coreDir,`${instanceId}.toml`),'utf8');
        assert.match(persisted,/no_tun\s*=\s*true/); assert.match(persisted,/disable_upnp\s*=\s*true/);
        assert.ok(persisted.includes('auth-native-e2e'));
        const stats = await owner.post(`/api/v1/machines/${machineId}/proxy-rpc`,{
            service_name:'api.instance.StatsRpcService',method_name:'get_stats',payload:{instance:{id:protoUuid(instanceId)}},
        });
        assert.ok(Array.isArray(stats.metrics ?? []));
        const metricsPath = `/api/v1/machines/${machineId}/networks/${instanceId}/metrics`;
        const metrics = await owner.get(metricsPath); assert.equal(typeof metrics,'string');
        await anonymous.get(metricsPath,401); await other.get(metricsPath,404);
        proof.metrics_count = stats.metrics?.length ?? 0; proof.prometheus_bytes = metrics.length;
        check('actual persisted no-TUN Core instance, Stats RPC and owner-scoped HTTP metrics');

        const rotated = await owner.post(`/api/v1/device-access-tokens/${issued.info.id}/rotate`);
        assert.ok(rotated.token !== issued.token,'rotation creates a new secret'); assert.equal(rotated.info.machine_id,machineId);
        assert.equal(rotated.info.auth_generation,2);
        await waitFor(async()=>!(await currentSession()),'online rotation closes the old management session');
        await owner.get(metricsPath,[403,404]);
        await delay(3000); assert.equal(await currentSession(),undefined);
        await stopCore(core); core = await spawnCore(rotated.token);
        await waitFor(currentSession,'same machine reconnects with its rotated token');
        await waitFor(async()=> hasInstance(await owner.get(`/api/v1/machines/${machineId}/networks`)),'stored Web configuration recovered after rotation');
        check('online rotation rejects old-token reconnect and restores configuration with the new token');
        const revoked = await owner.delete(`/api/v1/device-access-tokens/${issued.info.id}`,200);
        assert.equal(revoked.status,'revoked');
        await waitFor(async()=>!(await currentSession()),'online revocation closes management session');
        assert.equal((await owner.get('/api/v1/device-access-tokens')).tokens.some(token=>token.id===issued.info.id),false,'revocation removes the useless credential-list record');
        assert.equal(sqlite(database,"print(json.dumps(db.execute('SELECT COUNT(*) FROM device_access_tokens WHERE id=?',(sys.argv[2],)).fetchone()[0]))",[issued.info.id]),0,'revocation physically removes the invalid token row after disconnection');
        assert.equal(sqlite(database,"print(json.dumps(db.execute('SELECT COUNT(*) FROM devices WHERE user_id=? AND machine_id=?',(sys.argv[2],sys.argv[3])).fetchone()[0]))",[ownerId,machineId]),1,'revoke keeps the registered device');
        assert.equal(sqlite(database,"print(json.dumps(db.execute('SELECT COUNT(*) FROM user_running_network_configs WHERE user_id=? AND device_id=? AND network_instance_id=?',(sys.argv[2],sys.argv[3],sys.argv[4])).fetchone()[0]))",[ownerId,machineId,instanceId]),1,'revoke keeps the saved network configuration');
        await delay(3000); assert.equal(await currentSession(),undefined);
        await owner.get(metricsPath,[403,404]);
        await stopCore(core); core = undefined;
        check('online revoke removes the token record, preserves device configuration and prevents old-token reconnect');

        const replacement = await owner.post('/api/v1/device-access-tokens',{label:'replacement',machine_id:machineId});
        const activeTickets = (await owner.get('/api/v1/device-access-tokens')).tokens
            .filter(token=>token.machine_id===machineId && token.status==='active');
        assert.equal(activeTickets.length,1);
        assert.equal(activeTickets[0].id,replacement.info.id);
        core = await spawnCore(replacement.token); await waitFor(currentSession,'fresh device credential reconnect');
        await owner.delete(`/api/v1/machines/${machineId}`);
        await waitFor(async()=>!(await currentSession()),'device deletion closes old credential sessions');
        await delay(3000);
        assert.equal(sqlite(database,"print(json.dumps(db.execute('SELECT COUNT(*) FROM devices WHERE user_id=? AND machine_id=?',(sys.argv[2],sys.argv[3])).fetchone()[0]))",[ownerId,machineId]),0);
        const deletedToken = (await owner.get('/api/v1/device-access-tokens')).tokens.find(token=>token.id===replacement.info.id);
        assert.equal(deletedToken,undefined,'device cleanup leaves no revoked credential rows in its list');
        assert.equal(sqlite(database,"print(json.dumps(db.execute('SELECT COUNT(*) FROM device_access_tokens WHERE id=?',(sys.argv[2],)).fetchone()[0]))",[replacement.info.id]),0,'device cleanup deletes credential tombstones after pending sessions disconnect');
        assert.equal(await currentSession(),undefined);
        await stopCore(core); core = undefined;
        check('device deletion atomically revokes credentials and old Core cannot register again');

        const badId = randomUUID(); const usernameCore = await spawnCore('auth-owner-a',badId,'username-is-not-a-token');
        await delay(3500); await stopCore(usernameCore);
        assert.equal(sqlite(database,"print(json.dumps(db.execute('SELECT COUNT(*) FROM devices WHERE machine_id=?',(sys.argv[2],)).fetchone()[0]))",[badId]),0);
        check('username enrollment rejected even with allow-auto-create-user enabled');
        assertNoSecretLogs(processes);
        assert.deepEqual((await readdir('/sys/class/net')).sort(),netBefore);
        check('no tracked secrets in process logs and no host network interfaces created');
        proof.passed = true;
    } catch(error) {
        proof.passed = false; proof.error = maskSecrets(error.message);
        throw new Error(`${maskSecrets(error.message)}\n${processes.map(item=>item.logs()).join('\n')}`,{cause:new Error(maskSecrets(error.stack || error.message))});
    } finally {
        for (const item of processes.slice().reverse()) await stopCore(item);
        proof.finished_at = new Date().toISOString();
        proof.owned_processes_released = processes.every(item=>item.child.exitCode!==null || item.child.signalCode!==null);
        await rm(temp,{recursive:true,force:true}); proof.temporary_database_removed = true;
        if (process.env.EASYTIER_E2E_PROOF) await writeFile(process.env.EASYTIER_E2E_PROOF,JSON.stringify(proof,null,2)+'\n',{mode:0o600});
    }
});
