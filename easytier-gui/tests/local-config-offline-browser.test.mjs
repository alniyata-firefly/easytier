import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { installMockTauri, localId, managedId } from './mock-tauri.mjs';

const gui = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve('vite'))('esbuild');
const version = JSON.parse(await readFile(join(gui, 'package.json'))).version;
const coreVersion = 'synthetic-core-offline';

for (const scenario of [
  { platform: 'android', mode: 'normal', editable: true },
  { platform: 'windows', mode: 'normal', editable: true },
  { platform: 'windows', mode: 'remote', editable: false },
  { platform: 'windows', mode: 'service', editable: false },
]) test(`${scenario.platform} ${scenario.mode} keeps stopped-client configuration separate from runtime activation`, { timeout: 90000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), 'et-offline-config-ui-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = join(directory, 'fixture.js');
  const fixture = `import React from 'react';import {createRoot} from 'react-dom/client';
    import {App} from './src/react/App';import {NoticeProvider} from './src/react/components/ui';import {i18nReady} from './src/react/lib/i18n';
    i18nReady.then(()=>createRoot(document.getElementById('root')).render(<React.Suspense fallback="Loading"><NoticeProvider><App/></NoticeProvider></React.Suspense>));`;
  await esbuild.build({ stdin: { contents: fixture, resolveDir: gui, loader: 'tsx' }, outfile,
    bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', loader: { '.svg': 'dataurl' }, logLevel: 'silent' });
  const bundle = await readFile(outfile);
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      if (path === '/fixture.js') { response.setHeader('content-type', 'text/javascript'); response.end(bundle); }
      else if (path === '/style.css') { response.setHeader('content-type', 'text/css'); response.end(await readFile(join(gui, 'src/react/style.css'))); }
      else if (path === '/client.css') { response.setHeader('content-type', 'text/css'); response.end(await readFile(join(gui, 'src/react/client.css'))); }
      else if (path.startsWith('/locales/')) { response.setHeader('content-type', 'application/json'); response.end(await readFile(join(gui, 'public', path))); }
      else if (path === '/') { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/client.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'); }
      else response.writeHead(404).end();
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const browser = await chromium.launch({ executablePath: process.env.ET_CHROMIUM_PATH || undefined, headless: true, args: ['--no-sandbox'] });
  context.after(() => browser.close());
  const page = await browser.newPage({ viewport: scenario.platform === 'android' ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(installMockTauri, { platform: scenario.platform });
  await page.addInitScript(({ platform, mode, coreVersion }) => {
    if (!localStorage.getItem('offline-fixture-initialized')) {
      localStorage.setItem('offline-fixture-initialized', 'true');
      localStorage.setItem('local_client_paused', String(platform === 'android'));
      localStorage.setItem('networkList', JSON.stringify(Object.values(window.__MOCK_CONFIGS__).map((config, index) => ({ config, source: index ? 'web' : 'user' }))));
      localStorage.setItem('enabled_networks', JSON.stringify(['11111111-1111-4111-8111-111111111111']));
      localStorage.setItem('app_mode', JSON.stringify(mode === 'normal' ? { mode } : mode === 'remote'
        ? { mode, remote_rpc_address: 'tcp://192.0.2.44:15999' }
        : { mode, config_dir: '/mock/config', file_log_dir: '/mock/logs', file_log_level: 'warn', rpc_portal: '127.0.0.1:15999', installed_core_version: coreVersion }));
    }
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      if (command === 'easytier_version') return coreVersion;
      if (command === 'is_client_running') return false;
      if (command === 'plugin:vpnservice|get_vpn_status') return { running: false, state: 'stopped', established: false };
      if (command === 'get_service_status') return 'Stopped';
      if (command === 'generate_network_config') {
        window.__MOCK_CALLS__.push({ command, args });
        return { ...window.__MOCK_CONFIGS__['22222222-2222-4222-8222-222222222222'], network_name: 'Imported offline' };
      }
      if (['init_rpc_connection', 'set_service_status', 'list_network_instance_ids', 'get_network_metas', 'get_config', 'save_network_config', 'validate_config'].includes(command)) {
        window.__MOCK_CALLS__.push({ command, args }); throw new Error('synthetic runtime unavailable');
      }
      return invoke(command, args);
    };
  }, { ...scenario, coreVersion });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const create = page.getByRole('button', { name: '新建网络', exact: true });
  const importing = page.getByRole('button', { name: '导入配置', exact: true });
  await page.waitForFunction(() => document.querySelector('.client-topbar')?.textContent?.includes('synthetic-core-offline')
    && !document.querySelector('.page-heading button[aria-busy="true"]'));
  if (!scenario.editable) {
    assert.equal(await create.isDisabled(), true);
    assert.equal(await importing.isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: /Local lab/ }).count(), 0);
    assert.deepEqual(errors, []);
    return;
  }
  assert.equal(await create.isEnabled(), true);
  assert.equal(await importing.isEnabled(), true);
  await page.getByRole('button', { name: /Local lab/ }).waitFor();
  const initialManaged = await page.evaluate(id => JSON.parse(localStorage.getItem('networkList')).find(row => row.config.instance_id === id), managedId);
  const callsBefore = await page.evaluate(() => window.__MOCK_CALLS__.length);
  await create.click();
  let editor = page.getByRole('dialog', { name: '编辑网络', exact: true });
  await editor.waitFor();
  assert.equal(await editor.getByRole('button', { name: '保存并启动', exact: true }).isDisabled(), true);
  await editor.getByRole('textbox', { name: '网络名称', exact: true }).fill('Created offline');
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await editor.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: /Created offline/ }).waitFor();
  await page.getByRole('button', { name: '编辑网络', exact: true }).click();
  editor = page.getByRole('dialog', { name: '编辑网络', exact: true });
  await editor.getByRole('textbox', { name: '网络名称', exact: true }).fill('Renamed offline');
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await editor.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: /Renamed offline/ }).waitFor();
  await importing.click();
  const importer = page.getByRole('dialog', { name: '导入 TOML 配置', exact: true });
  await importer.getByRole('textbox', { name: 'TOML', exact: true }).fill('network_name = "Imported offline"');
  await importer.getByRole('button', { name: '确定', exact: true }).click();
  editor = page.getByRole('dialog', { name: '编辑网络', exact: true });
  await editor.waitFor();
  assert.equal(await editor.getByRole('button', { name: '保存并启动', exact: true }).isDisabled(), true);
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await editor.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: /Imported offline/ }).waitFor();
  const stored = await page.evaluate(() => ({ configs: JSON.parse(localStorage.getItem('networkList')), enabled: JSON.parse(localStorage.getItem('enabled_networks')) }));
  assert.equal(stored.configs.length, 4);
  assert.deepEqual(stored.configs.find(row => row.config.instance_id === managedId), initialManaged);
  for (const name of ['Renamed offline', 'Imported offline']) {
    const entry = stored.configs.find(row => row.config.network_name === name);
    assert.equal(entry.source, 'user'); assert.notEqual(entry.config.instance_id, managedId); assert.notEqual(entry.config.instance_id, localId);
    assert.equal(stored.enabled.includes(entry.config.instance_id), false);
  }
  assert.equal(await page.getByRole('button', { name: '启动', exact: true }).isDisabled(), true);
  const commands = await page.evaluate(offset => window.__MOCK_CALLS__.slice(offset).map(call => call.command), callsBefore);
  for (const forbidden of ['resume_local_client', 'init_web_client', 'plugin:vpnservice|prepare_vpn', 'run_network_instance', 'update_network_config_state', 'save_network_config', 'validate_config', 'list_network_instance_ids', 'get_network_metas', 'get_config']) assert.equal(commands.includes(forbidden), false, forbidden);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '关于', exact: true }).click();
  const about = page.getByRole('dialog', { name: '关于', exact: true });
  assert.equal(await about.locator('dt').filter({ hasText: /^EasyTier GUI$/ }).evaluate(el => el.nextElementSibling.textContent), version);
  assert.equal(await about.locator('dt').filter({ hasText: /^Core$/ }).evaluate(el => el.nextElementSibling.textContent), coreVersion);
  await page.reload();
  await page.getByRole('button', { name: /Imported offline/ }).waitFor();
  await page.getByRole('button', { name: /Managed lab/ }).click();
  assert.equal(await page.getByRole('button', { name: '编辑网络', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '删除', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: /Renamed offline/ }).click();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('dialog', { name: '删除', exact: true }).getByRole('button', { name: '删除', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('networkList')).length === 3);
  assert.equal(await page.getByRole('button', { name: /Renamed offline/ }).count(), 0);
  assert.deepEqual(errors, []);
});
