// Explicitly invoked integration tests only: never compile or touch a running service.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const target = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(repo, 'target');
export const webBinary = resolve(process.env.EASYTIER_WEB_BIN || process.env.ET_WEB_BIN || join(target,'debug/easytier-web'));
export const coreBinary = resolve(process.env.EASYTIER_CORE_BIN || process.env.ET_CORE_BIN || join(target,'debug/easytier-core'));
export const cliBinary = resolve(process.env.EASYTIER_CLI_BIN || process.env.ET_CLI_BIN || join(target,'debug/easytier-cli'));
const secrets = new Set();
export function trackSecret(value) { if (typeof value === 'string' && value.length >= 8) secrets.add(value); return value; }
export function maskSecrets(text) { for (const secret of secrets) text = text.replaceAll(secret,'[REDACTED]'); return text; }
function trackResponse(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key,item] of Object.entries(value)) {
        if (['token','credential_secret','network_secret','private_key','secret'].includes(key)) trackSecret(item);
        else if (item && typeof item === 'object') trackResponse(item);
    }
}

export async function requireBinaries(...paths) {
    for (const path of paths) await access(path).catch(() => { throw new Error(`Missing prebuilt binary ${path}; configure EASYTIER_WEB_BIN/EASYTIER_CORE_BIN/EASYTIER_CLI_BIN. Tests do not compile binaries.`); });
}

export function freePort() {
    return new Promise((accept,reject) => {
        const server = createServer(); server.once('error',reject);
        server.listen(0,'127.0.0.1',() => { const port = server.address().port; server.close(() => accept(port)); });
    });
}

export async function waitFor(check,label,timeout=30000) {
    const deadline = Date.now()+timeout;
    while (Date.now()<deadline) {
        const result = await check().catch(() => null);
        if (result) return result;
        await delay(150);
    }
    throw new Error(`Timed out waiting for ${label}`);
}

function start(binary,args,options={}) {
    const child = spawn(binary,args,{cwd:options.cwd,stdio:['ignore','pipe','pipe'],detached:true,
        env:{...process.env}});
    let output = ''; let startupError;
    child.on('error',error => { startupError = error.message; });
    for (const stream of [child.stdout,child.stderr]) stream.on('data',chunk => { output += chunk; });
    return {child,logs:() => maskSecrets(output),rawLogs:() => output,startupError:() => startupError};
}

async function stop(process) {
    if (!process || process.child.exitCode !== null || process.child.signalCode !== null) return;
    const child = process.child;
    const exited = new Promise(resolveExit => child.once('exit',resolveExit));
    const signal = kind => { try { if (child.pid) globalThis.process.kill(-child.pid,kind); } catch { /* Already exited. */ } };
    signal('SIGINT'); await Promise.race([exited,delay(3000)]);
    if (child.exitCode === null && child.signalCode === null) { signal('SIGTERM'); await Promise.race([exited,delay(2000)]); }
    if (child.exitCode === null && child.signalCode === null) { signal('SIGKILL'); await exited; }
}
export const stopWeb = stop;
export const stopCore = stop;

export function startWeb(database,apiPort,configPort,gatewayHost='127.0.0.1',options={}) {
    const protocol = options.protocol || 'tcp';
    const args = ['--db',database,'--api-server-addr','127.0.0.1','--api-server-port',String(apiPort),
        '--config-server-protocol',protocol,'--config-server-port',String(configPort),'--console-log-level',options.logLevel || 'info'];
    if (options.gateway !== false) args.push('--gateway-peer-url',`${protocol}://${gatewayHost}:${configPort}`);
    if (options.registrationDisabled !== false) args.push('--disable-registration');
    if (options.advertisedUrl) args.push('--advertised-config-server-url',options.advertisedUrl);
    if (options.internalToken) args.push('--internal-auth-token',trackSecret(options.internalToken));
    args.push(...(options.extraArgs || []));
    return start(webBinary,args,{cwd:dirname(database)});
}

export function startCore(configDir,gatewayHost,configPort,token,options={}) {
    const protocol = options.protocol || 'tcp';
    trackSecret(token);
    const args = ['--config-server',`${protocol}://${gatewayHost}:${configPort}/${token}`,
        '--machine-id',options.machineId || '00000000-0000-0000-0000-000000000002','--config-dir',configDir,
        '--no-listener','--no-tun','--disable-upnp','--hostname',options.hostname || 'e2e-device',
        '--console-log-level',options.logLevel || 'info'];
    if (options.rpcPort) args.push('--rpc-portal',`127.0.0.1:${options.rpcPort}`);
    args.push(...(options.extraArgs || []));
    return start(coreBinary,args,{cwd:configDir});
}

export function startCredentialCore(configDir,networkName,credential,peerUrl,hostname,rpcPort) {
    trackSecret(credential);
    return start(coreBinary,['--network-name',networkName,'--secure-mode','--credential',credential,
        '-p',peerUrl,'--no-listener','--no-tun','--disable-upnp','--hostname',hostname,
        '--machine-id',randomUUID(),'--rpc-portal',`127.0.0.1:${rpcPort}`,'--console-log-level','info'],{cwd:configDir});
}

export function credentialPeers(rpcPort) {
    const result = spawnSync(cliBinary,['--rpc-portal',`127.0.0.1:${rpcPort}`,'--output','json','peer'],{encoding:'utf8'});
    if (result.status !== 0) throw new Error(maskSecrets(result.stderr || result.stdout || 'CLI peer query failed'));
    return JSON.parse(result.stdout);
}

export function sqlite(database,script,args=[]) {
    const result = spawnSync('python3',['-c',`import sqlite3,json,sys\ndb=sqlite3.connect(sys.argv[1],timeout=10)\ntry:\n${script.split('\n').map(line=>'    '+line).join('\n')}\n    db.commit()\nfinally:\n    db.close()`,database,...args.map(String)],{encoding:'utf8'});
    if (result.status !== 0) throw new Error(maskSecrets(result.stderr || 'SQLite test fixture failed'));
    return result.stdout.trim() ? JSON.parse(result.stdout) : undefined;
}

export function seedUser(database,username,passwordHash) {
    return sqlite(database,"user=db.execute('INSERT INTO users(username,password) VALUES (?,?)',(sys.argv[2],sys.argv[3])).lastrowid\ngroup=db.execute(\"SELECT id FROM groups WHERE name='users'\").fetchone()[0]\ndb.execute('INSERT INTO users_groups(user_id,group_id) VALUES (?,?)',(user,group))\nprint(json.dumps(user))",[username,passwordHash]);
}

export function seedOfflineDevice(database,userId,machineId,hostname='e2e-device') {
    sqlite(database,"db.execute(\"INSERT INTO devices(user_id,machine_id,hostname,first_seen_time,last_seen_time) VALUES (?,?,?,'2026-10-12T00:00:00.000Z','2026-10-12T00:00:00.000Z')\",(sys.argv[2],sys.argv[3],sys.argv[4]))",[userId,machineId,hostname]);
}

export function protoUuid(uuid) {
    const hex = uuid.replaceAll('-','');
    return Object.fromEntries([0,1,2,3].map(index=>[`part${index+1}`,parseInt(hex.slice(index*8,index*8+8),16)]));
}

/** cookie-authenticated HTTP client; get/post/put/patch/delete return decoded JSON or text. */
export function httpApi(base,initialCookie='') {
    let cookie = initialCookie;
    const raw = async(method,path,data,options={}) => {
        const response = await fetch(`${base}${path.startsWith('/')?path:'/api/v1/'+path}`,{
            method,redirect:'manual',headers:{...(data===undefined?{}:{'Content-Type':'application/json'}),...(cookie?{Cookie:cookie}:{}),...options.headers},
            body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(options.timeout || 10000)});
        const setCookie = response.headers.get('set-cookie'); if (setCookie) cookie = setCookie.split(';')[0];
        return response;
    };
    const request = async(method,path,data,expected=200,options={}) => {
        const response = await raw(method,path,data,options); const text = await response.text();
        let value; try {value=JSON.parse(text);trackResponse(value);} catch {value=text;}
        assert.ok((Array.isArray(expected)?expected:[expected]).includes(response.status),`${method} ${path}: HTTP ${response.status} ${maskSecrets(text)}`);
        return value;
    };
    return {request,raw,cookie:()=>cookie,
        get:(path,expected=200,options={})=>request('GET',path,undefined,expected,options),
        post:(path,data,expected=200,options={})=>request('POST',path,data,expected,options),
        put:(path,data,expected=200,options={})=>request('PUT',path,data,expected,options),
        patch:(path,data,expected=200,options={})=>request('PATCH',path,data,expected,options),
        delete:(path,expected=204,options={})=>request('DELETE',path,undefined,expected,options),
    };
}

export function assertNoSecretLogs(processes) {
    for (const item of processes.filter(Boolean)) for (const secret of secrets) {
        assert.ok(!item.rawLogs().includes(secret),'a tracked credential appeared in a process log');
    }
}
