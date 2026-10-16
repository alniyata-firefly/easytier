import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve('vite'))('esbuild');

const request = (id, label) => ({
  id, token_id: `token-${id}`, token_label: label,
  old_machine_id: `original-${id}`, new_machine_id: `replacement-${id}`,
  old_device_alias: `${label} original`, old_hostname: 'old-host', hostname: `${label} reinstalled`,
  easytier_version: '2.7.2-fixture', device_os: JSON.stringify({ os_type: 'Android', version: '15' }),
  created_at: '2026-10-16T10:00:00Z', last_seen_at: '2026-10-16T10:01:00Z', attempt_count: 3, status: 'pending',
});

test('device rebind is an explicit approval workflow with cancellation, serialized mutations, rejection and stale-state handling', { timeout: 60000 }, async context => {
  const temporary = await mkdtemp(join(tmpdir(), 'et-device-rebind-ui-'));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const bundlePath = join(temporary, 'fixture.js');
  await esbuild.build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import ApiClient from ${JSON.stringify(join(frontend, 'src/lib/api.ts'))};import {DevicesPage} from ${JSON.stringify(join(frontend, 'src/pages/DevicesPage.tsx'))};import {NoticeProvider} from ${JSON.stringify(join(frontend, 'src/components/ui.tsx'))};import {i18nReady} from ${JSON.stringify(join(frontend, 'src/lib/i18n.ts'))};const api=new ApiClient(location.origin);function Fixture(){const[info,setInfo]=React.useState(()=>new URLSearchParams(location.search).get('mode')==='unready'?undefined:{webhook_auth:false});React.useEffect(()=>{window.__updateConsoleInfo=setInfo;},[]);return <NoticeProvider><div id="fixture-mode">{info===undefined?'unready':info.webhook_auth?'external':'local'}</div><DevicesPage api={api} consoleInfo={info}/></NoticeProvider>;}i18nReady.then(()=>createRoot(document.getElementById('root')).render(<React.Suspense fallback="Loading"><Fixture/></React.Suspense>));`, resolveDir: frontend, loader: 'tsx' }, outfile: bundlePath, bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', loader: { '.svg': 'dataurl' }, logLevel: 'silent' });
  const bundle = await readFile(bundlePath);
  const pending = [request('approval', 'Phone A'), request('rejection', 'Phone B'), request('stale', 'Phone C')];
  const calls = [];
  let listFailure = false, conflict = false, releaseApproval;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const json = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    calls.push({ method: req.method, path: url.pathname });
    if (url.pathname === '/fixture.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(bundle); }
    else if (url.pathname === '/style.css') { res.writeHead(200, { 'content-type': 'text/css' }); res.end(await readFile(join(frontend, 'src/style.css'))); }
    else if (url.pathname.startsWith('/locales/')) {
      try { json(JSON.parse(await readFile(join(frontend, 'public', url.pathname), 'utf8'))); } catch { res.writeHead(404).end(); }
    }
    else if (url.pathname === '/api/v1/machines') json({ machines: [] });
    else if (url.pathname === '/api/v1/blocked-devices') json({ blocked: [] });
    else if (url.pathname === '/api/v1/device-rebind-requests' && req.method === 'GET') json(listFailure ? {} : { requests: pending }, listFailure ? 503 : 200);
    else if (req.method === 'POST' && /^\/api\/v1\/device-rebind-requests\/[^/]+\/(approve|reject)$/.test(url.pathname)) {
      const [, id, action] = /\/device-rebind-requests\/([^/]+)\/(approve|reject)$/.exec(url.pathname);
      if (conflict) { conflict = false; json({ error: 'request conflict' }, 409); return; }
      if (id === 'approval') await new Promise(resolve => { releaseApproval = resolve; });
      const index = pending.findIndex(item => item.id === id);
      if (index < 0) { json({}, 409); return; }
      const [item] = pending.splice(index, 1);
      if (action === 'reject') res.writeHead(204).end();
      else json({ request_id: id, old_machine_id: item.old_machine_id, new_machine_id: item.new_machine_id, token_id: item.token_id, auth_generation: 2 });
    }
    else { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => { releaseApproval?.(); return new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); });
  const browser = await chromium.launch({ executablePath: process.env.ET_CHROMIUM_PATH || undefined, headless: true, args: ['--no-sandbox'] });
  context.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(7000);
  const errors = [], nativeDialogs = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { nativeDialogs.push(dialog.type()); void dialog.dismiss(); });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const panel = page.locator('section').filter({ has: page.getByRole('heading', { name: '设备身份变更审批', exact: true }) });
  const row = label => panel.getByRole('row').filter({ hasText: `${label} original` });
  const dialog = () => page.getByRole('dialog').filter({ visible: true });
  const mutations = () => calls.filter(item => item.method === 'POST');
  await row('Phone A').waitFor();
  assert.ok((await row('Phone A').textContent()).includes('Android'));
  assert.equal(await panel.getByRole('row').count(), 4);
  assert.equal(mutations().length, 0, 'discovering a new identity must never approve automatically');
  assert.ok((await row('Phone A').textContent()).includes('replacement-approval'));
  assert.ok((await row('Phone A').textContent()).includes('3 次接入尝试'));

  await row('Phone A').getByRole('button', { name: '审批', exact: true }).click();
  await dialog().getByText(/继承原设备的网络成员身份、虚拟 IP 和保存的配置/).waitFor();
  await dialog().getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(mutations().length, 0, 'cancel must not submit approval');

  listFailure = true;
  await panel.getByRole('button', { name: '刷新', exact: true }).click();
  await panel.getByRole('alert').waitFor();
  assert.equal(await row('Phone A').getByRole('button', { name: '审批', exact: true }).isDisabled(), true);
  listFailure = false;
  await panel.getByRole('button', { name: '刷新', exact: true }).click();
  await panel.getByRole('alert').waitFor({ state: 'hidden' });

  const baselineMachines = calls.filter(item => item.path === '/api/v1/machines').length;
  await row('Phone A').getByRole('button', { name: '审批', exact: true }).click();
  await dialog().getByRole('button', { name: '确认批准', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('dialog[open] button[type="submit"]')?.disabled);
  assert.equal(mutations().length, 1);
  await page.keyboard.press('Escape');
  assert.equal(await dialog().isVisible(), true, 'an active approval must not be dismissed mid-request');
  assert.equal(await row('Phone B').getByRole('button', { name: '拒绝', exact: true }).isDisabled(), true);
  releaseApproval();
  await row('Phone A').waitFor({ state: 'hidden' });
  await dialog().waitFor({ state: 'hidden' });
  await page.getByText('身份变更已批准，等待设备重新认证。', { exact: true }).waitFor();
  assert.equal(mutations().filter(item => item.path.endsWith('/approval/approve')).length, 1);
  assert.ok(calls.filter(item => item.path === '/api/v1/machines').length > baselineMachines, 'approval refreshes registered devices');

  await row('Phone B').getByRole('button', { name: '拒绝', exact: true }).click();
  await dialog().getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(mutations().length, 1);
  await row('Phone B').getByRole('button', { name: '拒绝', exact: true }).click();
  await dialog().getByRole('button', { name: '确认拒绝', exact: true }).click();
  await row('Phone B').waitFor({ state: 'hidden' });
  assert.equal(mutations().filter(item => item.path.endsWith('/rejection/reject')).length, 1);

  conflict = true;
  await row('Phone C').getByRole('button', { name: '审批', exact: true }).click();
  await dialog().getByRole('button', { name: '确认批准', exact: true }).click();
  await dialog().getByText('此请求已失效或目标设备存在冲突，请刷新并重新核对设备。', { exact: true }).waitFor();
  assert.equal(await dialog().getByRole('button', { name: '确认批准', exact: true }).isDisabled(), true);
  await dialog().getByRole('button', { name: '取消', exact: true }).click();
  await row('Phone C').getByRole('button', { name: '审批', exact: true }).click();
  const beforeStale = mutations().length;
  pending.splice(0, pending.length);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await dialog().getByText('此请求已不在待审批列表中，请关闭弹窗后刷新。', { exact: true }).waitFor();
  assert.equal(await dialog().getByRole('button', { name: '确认批准', exact: true }).isDisabled(), true);
  assert.equal(mutations().length, beforeStale);
  await dialog().getByRole('button', { name: '取消', exact: true }).click();
  await panel.getByText('没有待审批的身份变更', { exact: true }).waitFor();
  const approvalListCalls = () => calls.filter(item => item.path === '/api/v1/device-rebind-requests').length;
  const beforeExternal = approvalListCalls();
  await page.goto(`http://127.0.0.1:${server.address().port}/?mode=unready`);
  await page.getByRole('heading', { name: '已登记设备', exact: true }).waitFor();
  await page.locator('#fixture-mode').getByText('unready', { exact: true }).waitFor();
  assert.equal(await panel.count(), 0, 'unknown authentication mode must not render local approvals');
  assert.equal(approvalListCalls(), beforeExternal, 'unknown authentication mode must not query local approvals');
  await page.evaluate(() => window.__updateConsoleInfo({ webhook_auth: true }));
  await page.locator('#fixture-mode').getByText('external', { exact: true }).waitFor();
  assert.equal(await panel.count(), 0, 'external webhook mode must not render local approvals');
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/machines');
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await refreshed;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  assert.equal(approvalListCalls(), beforeExternal, 'external webhook mode must not query local approvals even on refresh');
  await page.evaluate(() => window.__updateConsoleInfo({ webhook_auth: false }));
  await panel.getByText('没有待审批的身份变更', { exact: true }).waitFor();
  assert.ok(approvalListCalls() > beforeExternal, 'local mode enables the approval resource only after configuration is ready');
  assert.deepEqual(nativeDialogs, [], 'all confirmations must use the shared flat dialog');
  assert.deepEqual(errors, []);
});
