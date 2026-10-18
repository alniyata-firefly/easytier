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

test('server logs use credentialed, uncached GET and preserve query options without mutating snapshots', async context => {
    const temporary = await mkdtemp(join(tmpdir(), 'et-server-logs-api-'));
    context.after(() => rm(temporary, { recursive: true, force: true }));
    const outfile = join(temporary, 'api.cjs');
    await esbuild.build({ entryPoints: [join(frontend, 'src/lib/api.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
    const ApiClient = require(outfile).default;
    const api = new ApiClient('http://unused.invalid');
    const calls = [];
    let id = 0, summaries = 0;
    api.client.defaults.adapter = async config => {
        calls.push(config);
        const data = config.url === '/summary' ? { device_count: ++summaries }
            : { entries: [{ id: ++id, occurred_at: 1792291796048, level: 'INFO', target: 'easytier_web', message: 'Started', fields: {} }], next_before_id: null, instance_id: 'synthetic', started_at: 1792291795000, capacity: 1000, dropped_entries: 0 };
        return { data, status: 200, statusText: 'OK', headers: {}, config };
    };
    await api.get_summary();
    const first = await api.list_server_logs();
    const filters = { level: 'WARN', q: 'a&b / 测试', target: 'easytier_web::', before_id: 42, limit: 50 };
    const second = await api.list_server_logs(filters);
    await api.get_summary();
    assert.equal(first.entries[0].id, 1);
    assert.equal(second.entries[0].id, 2);
    assert.equal(first.entries[0].occurred_at, 1792291796048, 'timestamps stay in Unix milliseconds');
    assert.deepEqual(calls.filter(call => call.url === '/server/logs').map(call => [call.method, call.params, call.data, call.withCredentials]), [
        ['get', {}, undefined, true], ['get', filters, undefined, true],
    ]);
    assert.equal(summaries, 1);
});

test('exports include only the displayed page and applied filters; language contracts stay complete', async context => {
    const temporary = await mkdtemp(join(tmpdir(), 'et-server-logs-export-'));
    context.after(() => rm(temporary, { recursive: true, force: true }));
    const outfile = join(temporary, 'export.cjs');
    await esbuild.build({ entryPoints: [join(frontend, 'src/lib/server-logs.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
    const { serializeServerLogs } = require(outfile);
    const entry = { id: 7, occurred_at: 1792291796048, level: 'WARN', target: 'easytier_web::test', message: '<img src=x>', fields: { error_code: 'unavailable' }, unexpected: 'do not export' };
    const result = JSON.parse(serializeServerLogs({ entries: [entry], next_before_id: 6, instance_id: 'process-a', started_at: 1792291795000, capacity: 1000, dropped_entries: 2, session: 'never export' }, { level: 'WARN', before_id: 8, limit: 50, q: 'query', session: 'never export' }));
    assert.deepEqual(result.entries, [{ id: 7, occurred_at: 1792291796048, level: 'WARN', target: 'easytier_web::test', message: '<img src=x>', fields: { error_code: 'unavailable' } }]);
    assert.deepEqual(result.filters, { level: 'WARN', before_id: 8, q: 'query' });
    assert.equal(JSON.stringify(result).includes('never export'), false);
    const locales = await Promise.all(['zh-CN', 'en'].map(async locale => JSON.parse(await readFile(join(frontend, 'public/locales', locale, 'logs.json'), 'utf8'))));
    const keys = object => Object.entries(object).flatMap(([key, value]) => typeof value === 'object' ? keys(value).map(child => `${key}.${child}`) : [key]).sort();
    assert.deepEqual(keys(locales[0]), keys(locales[1]));
    for (const labels of locales) assert.ok(labels.restricted && labels.retention && labels.restarted && labels.loadFailed && labels.noMatches);
});
