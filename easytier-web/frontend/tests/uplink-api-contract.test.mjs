import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve('vite'))('esbuild');
test('interface discovery addresses the target RPC and does not invalidate read snapshots', async context => {
  const temporary = await mkdtemp(join(tmpdir(), 'et-uplink-api-'));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const outfile = join(temporary, 'api.cjs');
  await esbuild.build({ entryPoints: [join(frontend, 'src/lib/api.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const ApiClient = require(outfile).default;
  const api = new ApiClient('http://unused.invalid');
  const calls = [];
  let summaries = 0;
  api.client.defaults.adapter = async config => {
    calls.push({ url: config.url, body: config.data ? JSON.parse(config.data) : undefined });
    const data = config.url === '/summary' ? { device_count: ++summaries } : { supported: true, interfaces: [{ name: 'Ethernet 2', addresses: [{ address: '10.7.0.46', prefix_length: 24 }], manual_selectable: true }] };
    return { data, status: 200, statusText: 'OK', headers: {}, config };
  };
  const machine = '01234567-89ab-cdef-0123-456789abcdef';
  const instance = '89abcdef-0123-4567-89ab-cdef01234567';
  await api.get_summary();
  const inventory = await api.get_network_interfaces(machine, instance);
  assert.equal(inventory.interfaces[0].name, 'Ethernet 2');
  assert.deepEqual(inventory.interfaces[0].addresses, ['10.7.0.46/24']);
  assert.deepEqual(calls[1], { url: `/machines/${machine}/proxy-rpc`, body: {
    service_name: 'api.manage.WebClientService', method_name: 'get_network_interfaces',
    payload: { inst_id: { part1: 0x89abcdef, part2: 0x01234567, part3: 0x89abcdef, part4: 0x01234567 } },
  } });
  await api.get_summary(); assert.equal(summaries, 1, 'read-only inventory must preserve the summary cache');
  await api.get_remote_client(machine).get_network_interfaces();
  assert.deepEqual(calls.at(-1).body.payload, {}, 'new instances query the target default namespace');
  assert.equal(calls.at(-1).url, `/machines/${machine}/proxy-rpc`);
});
