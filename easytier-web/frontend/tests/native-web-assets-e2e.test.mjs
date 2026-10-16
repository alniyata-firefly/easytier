// Explicit native integration test. Prebuilt Web and independent frontend inputs;
// only loopback in a fresh namespace, no Core, TUN, compilation or external URLs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { freePort, requireBinaries, startWeb, stopWeb, waitFor, webBinary, maskSecrets } from './e2e-native-helpers.mjs';
import { loadFrontendExpectation, verifyEmbeddedFrontend } from './e2e-web-assets-helpers.mjs';

async function networkSnapshot() {
    assert.equal(process.env.ET_TEST_NETWORK_ISOLATED, '1', 'run in a fresh loopback-only network namespace');
    assert.notEqual(await readlink('/proc/self/ns/net'), await readlink('/proc/1/ns/net'), 'refusing the host network namespace');
    const devices = (await readFile('/proc/net/dev', 'utf8')).split('\n').slice(2)
        .filter(line => line.includes(':')).map(line => line.split(':')[0].trim()).sort();
    assert.deepEqual(devices, ['lo'], 'the namespace must contain only loopback');
    const routes = (await readFile('/proc/net/route', 'utf8')).trim().split('\n').slice(1).filter(Boolean);
    assert.ok(routes.every(line => line.trim().split(/\s+/)[0] === 'lo'), 'no egress routes are allowed');
    assert.ok(routes.every(line => line.trim().split(/\s+/)[1] !== '00000000'), 'no default route is allowed');
    return { devices, routes };
}

await test('release Web serves the exact commit-bound React frontend embedded in its executable', { timeout: 180000 }, async () => {
    const before = await networkSnapshot();
    await requireBinaries(webBinary);
    const expectedDist = process.env.ET_EXPECTED_FRONTEND_DIST;
    assert.ok(expectedDist, 'ET_EXPECTED_FRONTEND_DIST must identify the independently restored frontend');
    const expected = await loadFrontendExpectation(expectedDist, process.env.ET_EXPECTED_SOURCE_COMMIT || process.env.GITHUB_SHA);
    const output = resolve(process.env.ET_NATIVE_E2E_OUTPUT || tmpdir());
    await mkdir(output, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(output, 'native-web-assets-'));
    const runtime = join(directory, 'private-runtime');
    await mkdir(runtime, { mode: 0o700 });
    const database = join(runtime, 'web.db');
    const ports = { api: await freePort(), config: await freePort() };
    assert.notEqual(ports.api, ports.config, 'fixture ports must be distinct');
    const proof = {
        test: 'native-web-assets', started_at: new Date().toISOString(),
        scope: 'actual release Web HTTP responses compared with independently restored, commit-bound React assets; isolated loopback only',
        source_commit: expected.manifest.source_commit, version: expected.manifest.version,
    };
    const failures = [];
    let web;
    function safeError(error) {
        return maskSecrets(String(error?.message || error)).replaceAll(resolve(expectedDist), '[expected-frontend]')
            .replaceAll(runtime, '[private-runtime]').replaceAll(webBinary, '[web-binary]');
    }
    try {
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(webBinary)) hash.update(chunk);
        proof.binary_sha256 = hash.digest('hex');
        web = startWeb(database, ports.api, ports.config, '127.0.0.1', {
            protocol: 'udp', configBindAddr: '127.0.0.1', gateway: false, logLevel: 'warn',
        });
        const base = `http://127.0.0.1:${ports.api}`;
        await waitFor(async () => {
            const response = await fetch(`${base}/api_meta.js`, { redirect: 'manual', signal: AbortSignal.timeout(1000) });
            await response.arrayBuffer();
            return response.status === 200;
        }, 'the fixture Web HTTP listener', 20000);
        proof.verification = await verifyEmbeddedFrontend(base, expected);
    } catch (error) {
        failures.push(safeError(error));
    } finally {
        await stopWeb(web);
        proof.owned_process_released = !web || web.child.exitCode !== null || web.child.signalCode !== null;
        if (!proof.owned_process_released) failures.push('fixture Web process was not released');
        try { assert.deepEqual(await networkSnapshot(), before); }
        catch (error) { failures.push(safeError(error)); }
        await rm(runtime, { recursive: true, force: true });
        proof.temporary_database_removed = true;
        proof.status = failures.length ? 'FAIL' : 'PASS';
        proof.failures = failures;
        proof.finished_at = new Date().toISOString();
        await writeFile(join(directory, 'proof.json'), JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 });
        console.log(`Evidence: ${join(directory, 'proof.json')}`);
    }
    assert.deepEqual(failures, [], 'native embedded frontend verification failed; see structured proof');
});
