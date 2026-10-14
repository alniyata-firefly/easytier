// Synthetic contract fixtures only. No server, private state, token, database or network access.
// Reuse Vite's existing esbuild dependency to load the TypeScript modules under Node.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve('vite'))('esbuild');
test('React observation contracts', async context => {
const temporary = await mkdtemp(join(tmpdir(), 'easytier-react-contracts-'));
await chmod(temporary, 0o700);
context.after(async () => { await rm(temporary, { recursive: true, force: true }); });
const bundles = [
    ['counters.cjs', join(frontend, '../frontend-lib/src/modules/runtimeDisplay.ts')],
    ['resources.cjs', join(frontend, '../frontend-lib/src/modules/observabilityDisplay.ts')],
    ['node-info.cjs', join(frontend, '../frontend-lib/src/generated/proto/api_instance.ts')],
];
await Promise.all(bundles.map(async ([name, path]) => { const outfile = join(temporary, name); await esbuild.build({ entryPoints: [path], outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' }); await chmod(outfile, 0o600); }));
const { CounterRate, counter } = require(join(temporary, 'counters.cjs'));
const { percentage, usedMemory, staleSample, historyPoints, normalizeHostResources } = require(join(temporary, 'resources.cjs'));
const { NodeInfo } = require(join(temporary, 'node-info.cjs'));
await context.test('device overview fixture uses the actual instance NodeInfo wire contract', async () => {
    const fixture = JSON.parse(await readFile(new URL('./fixtures/node-info.json', import.meta.url), 'utf8'));
    const node = NodeInfo.fromJson(fixture.node_info);
    assert.equal(node.ipv4_addr, '100.64.4.7/24');
    assert.equal(node.hostname, 'Node contract fixture');
    assert.equal('virtual_ipv4' in node, false, 'MyNodeInfo is a different runtime message');
    const { ipv4_addr, ...withoutAddress } = fixture.node_info;
    assert.equal(NodeInfo.fromJson(withoutAddress).ipv4_addr, '');
});
await context.test('uint64 differences remain exact above JavaScript safe integers', () => {
    const rate = new CounterRate();
    assert.equal(rate.sample('1152921504606846976', 1000, 'a'), undefined);
    assert.equal(rate.sample('1152921504606848000', 2000, 'a'), 1024);
    assert.equal(counter(Number.MAX_SAFE_INTEGER + 1), undefined);
});
await context.test('first samples, counter resets and changed scopes have unknown rates', () => {
    const rate = new CounterRate();
    assert.equal(rate.sample('100', 1000, 'a'), undefined);
    assert.equal(rate.sample('0', 2000, 'a'), undefined);
    assert.equal(rate.sample('100', 3000, 'b'), undefined);
});
await context.test('unknown resources stay unknown while explicit zero remains a valid value', () => {
    assert.equal(percentage(undefined), undefined); assert.equal(percentage(0), 0);
    assert.equal(usedMemory('100', '110'), undefined); assert.equal(usedMemory('100', '100').used, 0n);
    assert.equal(normalizeHostResources({ memory_total_bytes: '100' }).cpu_usage_percent, undefined);
});
await context.test('host and disk resource expiry windows remain distinct', () => {
    assert.equal(staleSample(1000, 16001, 15000), true);
    assert.equal(staleSample(1000, 90999, 90000), false);
    assert.equal(staleSample(1000, 91001, 90000), true);
});
await context.test('history gaps remain null and valid zero samples remain zero', () => {
    assert.deepEqual(historyPoints([[0, 0], [30, 2]], 10), [[0, 0], [10, null], [30, 2]]);
});
});
