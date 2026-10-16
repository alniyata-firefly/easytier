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

test('device identity approval API preserves ownership paths, encodes IDs and sends no identity override or token', async context => {
  const temporary = await mkdtemp(join(tmpdir(), 'et-device-rebind-api-'));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const outfile = join(temporary, 'api.cjs');
  await esbuild.build({ entryPoints: [join(frontend, 'src/lib/api.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const ApiClient = require(outfile).default;
  const api = new ApiClient('http://unused.invalid');
  const calls = [];
  let summaryRequests = 0;
  const approval = { request_id: 'request', old_machine_id: 'old', new_machine_id: 'new', token_id: 'token-record-id', auth_generation: 2 };
  api.client.defaults.adapter = async config => {
    calls.push({ method: config.method, url: config.url, body: config.data });
    const data = config.url === '/summary' ? { device_count: ++summaryRequests }
      : config.url === '/device-rebind-requests' ? { requests: [{ id: 'request', status: 'pending' }] }
      : config.url.endsWith('/approve') ? approval : undefined;
    return { data, status: config.url.endsWith('/reject') ? 204 : 200, statusText: 'OK', headers: {}, config };
  };
  await api.get_summary();
  assert.deepEqual(await api.list_device_rebind_requests(), [{ id: 'request', status: 'pending' }]);
  await api.get_summary();
  assert.equal(summaryRequests, 1, 'reading requests must not invalidate read caches');
  assert.deepEqual(await api.approve_device_rebind_request('request/one?x=1'), approval);
  await api.get_summary();
  assert.equal(summaryRequests, 2, 'approval must invalidate stale device summary caches');
  await api.reject_device_rebind_request('request/two');
  assert.deepEqual(calls.filter(call => call.method === 'post'), [
    { method: 'post', url: '/device-rebind-requests/request%2Fone%3Fx%3D1/approve', body: undefined },
    { method: 'post', url: '/device-rebind-requests/request%2Ftwo/reject', body: undefined },
  ]);
});

test('device identity approvals have matching Simplified Chinese and English translation keys', async () => {
  const chinese = JSON.parse(await readFile(join(frontend, 'public/locales/zh-CN/devices.json'), 'utf8')).rebind;
  const english = JSON.parse(await readFile(join(frontend, 'public/locales/en/devices.json'), 'utf8')).rebind;
  assert.deepEqual(Object.keys(chinese).sort(), Object.keys(english).sort());
  assert.ok(Object.values(chinese).every(value => typeof value === 'string' && value.length));
  assert.ok(Object.values(english).every(value => typeof value === 'string' && value.length));
});
