import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve('vite'))('esbuild');

test('connection event history uses tenant-authenticated GET, cursor pagination and uncached reads', async context => {
    const temporary = await mkdtemp(join(tmpdir(), 'et-connection-events-'));
    context.after(() => rm(temporary, { recursive: true, force: true }));
    const outfile = join(temporary, 'api.cjs');
    await esbuild.build({ entryPoints: [join(frontend, 'src/lib/api.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
    const ApiClient = require(outfile).default;
    const api = new ApiClient('http://unused.invalid');
    const calls = [];
    let page = 0, summaries = 0;
    api.client.defaults.adapter = async config => {
        calls.push(config);
        const data = config.url.endsWith('/networks/info') ? { info: { map: { created: {}, failed: { error_msg: 'failed' }, running: { running: true } } } }
            : config.url === '/summary' ? { device_count: ++summaries }
            : { events: [{ id: ++page, device_id: 'fixture', event: 'authorized', reason: 'authorization_granted', occurred_at: 1792195200 }], next_before_id: page };
        return { data, status: 200, statusText: 'OK', headers: {}, config };
    };
    await api.get_summary();
    const first = await api.list_management_connection_events();
    const second = await api.list_management_connection_events({ device_id: 'device/one', before_id: 42, limit: 50 });
    await api.get_summary();
    assert.equal(first.events[0].id, 1);
    assert.equal(second.events[0].id, 2, 'history cannot reuse a stale runtime cache');
    const history = calls.filter(call => call.url === '/management-connection-events');
    assert.deepEqual(history.map(call => [call.method, call.params, call.data]), [
        ['get', {}, undefined], ['get', { device_id: 'device/one', before_id: 42, limit: 50 }, undefined],
    ]);
    assert.ok(history.every(call => call.withCredentials === true));
    assert.equal(summaries, 1, 'reading history must not invalidate unrelated snapshots');
    const runtimes = await api.get_node_runtime_infos('device/one');
    assert.equal(runtimes.created.running, false, 'pbjson omits the false running scalar');
    assert.equal(runtimes.failed.running, false);
    assert.equal(runtimes.running.running, true);
    assert.equal(runtimes.absent, undefined, 'a missing runtime cannot be fabricated');
    assert.equal(calls.at(-1).url, '/machines/device%2Fone/networks/info');
    assert.equal(calls.at(-1).method, 'get');
    assert.equal(calls.at(-1).data, undefined);
});

test('connection log states and translations distinguish authorization, disconnect, approval and errors', async context => {
    const temporary = await mkdtemp(join(tmpdir(), 'et-connection-event-labels-'));
    context.after(() => rm(temporary, { recursive: true, force: true }));
    const outfile = join(temporary, 'states.cjs');
    await esbuild.build({ entryPoints: [join(frontend, 'src/lib/connection-logs.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
    const { connectionEventState } = require(outfile);
    for (const [event, expected] of Object.entries({ authorized: 'online', disconnected: 'offline', pending_approval: 'pending', authentication_rejected: 'failed', configuration_apply_failed: 'failed', future_event: 'unknown' })) {
        assert.equal(connectionEventState(event), expected);
    }
    const labels = await Promise.all(['zh-CN', 'en'].map(async locale => JSON.parse(await readFile(join(frontend, 'public/locales', locale, 'devices.json'), 'utf8')).connectionLogs));
    const flatten = object => Object.entries(object).flatMap(([key, value]) => typeof value === 'object' ? flatten(value).map(child => `${key}.${child}`) : [key]).sort();
    assert.deepEqual(flatten(labels[0]), flatten(labels[1]));
    for (const label of labels) {
        assert.notEqual(label.events.authorized, label.events.disconnected);
        assert.notEqual(label.events.pending_approval, label.events.authentication_rejected);
        assert.ok(label.events.unknown && label.reasons.unknown);
    }
});
