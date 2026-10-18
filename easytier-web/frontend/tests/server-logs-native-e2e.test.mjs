// Explicit CI integration test. Uses a prebuilt Web binary, temporary SQLite and
// loopback HTTP; never compiles or contacts a deployed service or managed Core.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { freePort, httpApi, requireBinaries, seedUser, sqlite, startWeb, stopWeb, waitFor, webBinary } from './e2e-native-helpers.mjs';

const passwordHash = '$argon2id$v=19$m=4096,t=3,p=1$ZWFzeXRpZXItZTJlLXNhbHQ$FHbDjVElaTXuArgEEQrQrO4AdsnqNOcXGA5PFY8cG/s';

test('actual Web captures runtime logs with all sinks off and enforces fresh administrator access', { timeout: 90000 }, async () => {
    await requireBinaries(webBinary);
    assert.equal(process.env.RUST_LOG, 'off', 'run with RUST_LOG=off to verify collection without ordinary sinks');
    assert.equal(process.env.ET_TEST_NETWORK_ISOLATED, '1', 'run inside the CI loopback-only network namespace');
    if (process.env.ET_NATIVE_E2E_OUTPUT) await mkdir(process.env.ET_NATIVE_E2E_OUTPUT, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(process.env.ET_NATIVE_E2E_OUTPUT || tmpdir(), 'server-logs-native-'));
    const database = join(directory, 'web.db');
    const ports = { api: await freePort(), config: await freePort() };
    const base = `http://127.0.0.1:${ports.api}`;
    const processes = [];
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(webBinary)) hash.update(bytes);
    const proof = { scope: 'prebuilt Web, temporary SQLite, real loopback HTTP, console/file/RUST_LOG off, no managed Core', source_commit: process.env.ET_EXPECTED_SOURCE_COMMIT, binary_sha256: hash.digest('hex'), checks: [] };
    const check = name => { proof.checks.push({ name, status: 'PASS' }); };
    const launch = () => {
        const web = startWeb(database, ports.api, ports.config, '127.0.0.1', { gateway: false, logLevel: 'off', extraArgs: ['--file-log-level', 'off'] });
        processes.push(web);
        return web;
    };
    let web;
    try {
        web = launch();
        await waitFor(() => fetch(`${base}/auth/config`).then(response => response.ok), 'Web schema bootstrap');
        await stopWeb(web);
        const adminId = seedUser(database, 'log-operator', passwordHash);
        seedUser(database, 'log-viewer', passwordHash);
        const setRole = enabled => sqlite(database, enabled
            ? "db.execute(\"INSERT INTO users_groups(user_id,group_id) SELECT ?,id FROM groups WHERE name='admins'\",(sys.argv[2],))"
            : "db.execute(\"DELETE FROM users_groups WHERE user_id=? AND group_id IN (SELECT id FROM groups WHERE name='admins')\",(sys.argv[2],))", [adminId]);
        setRole(true);
        web = launch();
        await waitFor(() => fetch(`${base}/auth/config`).then(response => response.ok), 'Web after test account setup');
        const anonymous = await fetch(`${base}/api/v1/server/logs`, { redirect: 'manual' });
        assert.ok([401, 302, 303].includes(anonymous.status));
        const bearerOnly = await fetch(`${base}/api/v1/server/logs`, { headers: { Authorization: `Bearer ${randomBytes(32).toString('hex')}` }, redirect: 'manual' });
        assert.ok([401, 302, 303].includes(bearerOnly.status));
        const admin = httpApi(base), viewer = httpApi(base);
        const password = createHash('md5').update('e2e-password').digest('hex');
        await admin.post('auth/login', { username: 'log-operator', password });
        await viewer.post('auth/login', { username: 'log-viewer', password });
        assert.equal((await admin.get('console-info')).server_logs_access, true);
        assert.equal((await viewer.get('console-info')).server_logs_access, false);
        assert.equal((await viewer.get('server/logs', 403)).code, 'server_logs_forbidden');
        check('anonymous, bearer-only and ordinary accounts cannot read process logs');

        const initial = await waitFor(async () => {
            const page = await admin.get('server/logs');
            return page.entries.some(entry => entry.message === 'easytier-web ready') ? page : false;
        }, 'actual tracing observer startup and ready events');
        assert.ok(initial.entries.some(entry => entry.message === 'easytier-web starting'));
        assert.ok(initial.started_at > 0 && initial.started_at <= Date.now());
        assert.equal(typeof initial.instance_id, 'string');
        assert.ok(initial.capacity > 0 && initial.capacity <= 10000);
        assert.ok(initial.entries.every(entry => entry.occurred_at >= initial.started_at && ['INFO', 'WARN', 'ERROR'].includes(entry.level)));
        const headers = await admin.raw('GET', 'server/logs');
        assert.match(headers.headers.get('cache-control') || '', /no-store/);
        assert.equal(web.rawLogs().trim(), '', 'all ordinary logging sinks remain disabled');
        check('real startup records are queryable independently of console and file sinks');

        const secret = randomBytes(32).toString('base64url');
        await viewer.post('auth/register', { credentials: { username: 'blocked-registration', password: secret }, captcha: secret }, 403);
        const warnings = await waitFor(async () => {
            const page = await admin.get('server/logs?level=WARN&q=Registration');
            return page.entries.length ? page : false;
        }, 'server warning event after disabled registration request');
        assert.ok(warnings.entries.every(entry => ['WARN', 'ERROR'].includes(entry.level)));
        assert.ok(warnings.entries.some(entry => entry.message === 'Registration attempt blocked: registration is disabled'));
        assert.ok(!JSON.stringify(await admin.get('server/logs?limit=200')).includes(secret));
        const first = await admin.get('server/logs?limit=1');
        assert.equal(first.entries.length, 1);
        assert.equal(first.next_before_id, first.entries[0].id);
        const older = await admin.get(`server/logs?limit=1&before_id=${first.next_before_id}`);
        assert.ok(older.entries[0].id < first.entries[0].id);
        for (const query of ['limit=201', 'limit=0', 'before_id=0', 'level=DEBUG', `q=${'x'.repeat(129)}`]) await admin.get(`server/logs?${query}`, 400);
        check('real request warnings, filtering, stable cursors, bounds and credential omission');

        setRole(false);
        assert.equal((await admin.get('console-info')).server_logs_access, false);
        await admin.get('server/logs', 403);
        setRole(true);
        await admin.get('server/logs');
        check('administrator role removal and restoration take effect on an existing session');

        await stopWeb(web);
        web = launch();
        await waitFor(() => fetch(`${base}/auth/config`).then(response => response.ok), 'Web restart');
        const restarted = httpApi(base);
        await restarted.post('auth/login', { username: 'log-operator', password });
        const after = await restarted.get('server/logs');
        assert.notEqual(after.instance_id, initial.instance_id);
        assert.ok(after.started_at >= initial.started_at);
        assert.ok(!after.entries.some(entry => entry.message.startsWith('Registration attempt blocked')));
        check('restart exposes a new process identity and does not pretend to retain old ring entries');
        proof.status = 'PASS';
    } catch (error) {
        proof.status = 'FAIL';
        proof.error = error.message;
        throw error;
    } finally {
        for (const child of processes.slice().reverse()) await stopWeb(child);
        proof.processes_stopped = processes.every(child => child.child.exitCode !== null || child.child.signalCode !== null);
        await writeFile(join(directory, 'proof.json'), JSON.stringify(proof, null, 2), { mode: 0o600 });
        console.log(`PROOF=${join(directory, 'proof.json')}`);
    }
});
