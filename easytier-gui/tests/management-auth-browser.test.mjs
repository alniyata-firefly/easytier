import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { installMockTauri, managedId } from './mock-tauri.mjs';

const gui = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve('vite'))('esbuild');
const managementDeviceId = '11111111-2222-4333-8444-555555555555';

test('managed GUI distinguishes Core readiness, authentication, denial, and approval', { timeout: 150000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), 'et-management-auth-ui-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = join(directory, 'fixture.js');
  await esbuild.build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';
    import {App} from './src/react/App';import {NoticeProvider} from './src/react/components/ui';import {i18nReady} from './src/react/lib/i18n';
    let root;const mount=()=>{root=createRoot(document.getElementById('root'));root.render(<React.Suspense fallback="Loading"><NoticeProvider><App/></NoticeProvider></React.Suspense>)};
    window.__remountApp=()=>{root.unmount();mount()};i18nReady.then(mount);`,
  resolveDir: gui, loader: 'tsx' }, outfile, bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', loader: { '.svg': 'dataurl' }, logLevel: 'silent' });
  const bundle = await readFile(outfile);
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      if (path === '/fixture.js') { response.setHeader('content-type', 'text/javascript'); response.end(bundle); }
      else if (path === '/style.css' || path === '/client.css' || path === '/fonts.css') {
        response.setHeader('content-type', 'text/css'); response.end(await readFile(join(gui, 'src/react', path.slice(1))));
      }
      else if (path.startsWith('/fonts/')) { response.setHeader('content-type', 'font/woff2'); response.end(await readFile(join(gui, 'public', path))); }
      else if (path === '/') { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/client.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'); }
      else response.writeHead(404).end();
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const browser = await chromium.launch({ executablePath: process.env.ET_CHROMIUM_PATH || undefined, headless: true, args: ['--no-sandbox'] });
  context.after(() => browser.close());
  const address = `http://127.0.0.1:${server.address().port}`;
  const startsVpn = call => ['resume_local_client', 'set_tun_fd', 'plugin:vpnservice|prepare_vpn', 'plugin:vpnservice|start_vpn'].includes(call.command);
  const reconnectsManagement = call => ['init_rpc_connection', 'load_configs', 'init_web_client'].includes(call.command);
  const stopsManagement = call => call.command === 'plugin:vpnservice|set_client_enabled' && call.args.enabled === false;
  const waitIdle = page => page.waitForFunction(() => document.querySelector('.client-topbar .desktop-version')?.textContent
    && !document.querySelector('.page-heading button[aria-busy="true"]'));
  await context.test('Android automatically connects management while VPN requires explicit connection and stays stopped after reopen', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    try {
      await page.addInitScript(installMockTauri, { platform: 'android' });
      await page.addInitScript(() => {
        if (!localStorage.getItem('manual-start-fixture')) {
          localStorage.setItem('manual-start-fixture', 'true');
          localStorage.setItem('local_client_paused', 'false');
          localStorage.setItem('app_mode', JSON.stringify({ mode: 'normal', config_server_url: `udp://example.invalid:22020/${'A'.repeat(43)}` }));
        }
      });
      await page.goto(address);
      await waitIdle(page);
      const header = page.locator('.client-topbar .status');
      await header.getByText('VPN 未连接', { exact: true }).waitFor();
      await page.getByRole('heading', { name: 'Local lab', exact: true }).waitFor();
      let calls = await page.evaluate(() => window.__MOCK_CALLS__);
      assert.ok(calls.some(call => call.command === 'is_local_client_enabled'));
      for (const command of ['init_rpc_connection', 'load_configs', 'init_web_client']) assert.ok(calls.some(call => call.command === command), command);
      assert.ok(calls.some(call => call.command === 'plugin:vpnservice|set_client_enabled' && call.args.enabled === true), 'management foreground stays enabled');
      assert.deepEqual(calls.filter(startsVpn), [], 'cold mount must not request permission, enable or start the Android VPN');
      assert.equal(await page.evaluate(() => window.__MOCK_NATIVE_ENABLED__), false);
      assert.equal(await page.evaluate(() => window.__MOCK_RPC_READY__), true);
      const rememberedEnabled = await page.evaluate(() => JSON.parse(localStorage.getItem('enabled_networks')));
      assert.ok(rememberedEnabled.length > 0, 'fixture must include saved enabled networks');
      await page.locator('.client-navigation').getByRole('button', { name: '设置', exact: true }).click();
      const settings = page.locator('.client-settings-grid .status');
      await settings.getByText('管理服务器认证通过', { exact: true }).waitFor({ timeout: 6000 });
      assert.equal(await header.textContent(), 'VPN 未连接', 'management authentication cannot imply VPN connection');
      const beforeSettings = await page.evaluate(() => window.__MOCK_CALLS__.length);
      await page.getByRole('button', { name: '连接管理服务器', exact: true }).click();
      const management = page.getByRole('dialog', { name: '管理服务器', exact: true });
      await management.getByRole('textbox', { name: '服务器地址', exact: true }).fill('udp://settings.invalid:22020');
      await management.getByLabel('管理令牌', { exact: true }).fill('B'.repeat(43));
      await management.getByRole('button', { name: '保存', exact: true }).click();
      await management.waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('app_mode')).config_server_url), `udp://settings.invalid:22020/${'B'.repeat(43)}`);
      await page.waitForTimeout(2300);
      await settings.getByText('管理服务器认证通过', { exact: true }).waitFor();
      calls = await page.evaluate(offset => window.__MOCK_CALLS__.slice(offset), beforeSettings);
      assert.ok(calls.some(call => call.command === 'init_web_client' && call.args.url?.startsWith('udp://settings.invalid:22020/')), 'saved settings connect management');
      assert.deepEqual(calls.filter(startsVpn), [], 'saving management settings and polling cannot start the VPN');
      assert.equal(await header.textContent(), 'VPN 未连接');
      await page.locator('.client-navigation').getByRole('button', { name: '网络', exact: true }).click();
      const runningBeforeVpn = await page.evaluate(async () => (await window.__TAURI_INTERNALS__.invoke('list_network_instance_ids')).running_inst_ids);
      assert.deepEqual(runningBeforeVpn, [], 'cold Android management must not restore local or managed data-plane instances');
      const beforeConnect = await page.evaluate(() => window.__MOCK_CALLS__.length);
      await page.getByRole('button', { name: '连接', exact: true }).click();
      await page.waitForFunction(() => window.__MOCK_TUN_BINDING__?.requestId
        && !document.querySelector('.page-heading button[aria-busy="true"]'));
      await header.getByText('VPN 已连接', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.__MOCK_NATIVE_ENABLED__), true);
      calls = await page.evaluate(offset => window.__MOCK_CALLS__.slice(offset), beforeConnect);
      for (const command of ['resume_local_client', 'plugin:vpnservice|start_vpn', 'set_tun_fd'])
        assert.ok(calls.some(call => call.command === command), `${command} must follow explicit start`);
      assert.deepEqual(calls.filter(reconnectsManagement), [], 'connecting VPN reuses management and starts data-plane instances only after explicit permission');
      assert.ok((await page.evaluate(async () => (await window.__TAURI_INTERNALS__.invoke('list_network_instance_ids')).running_inst_ids)).length > 0);
      const existingBinding = await page.evaluate(() => window.__MOCK_TUN_BINDING__);
      const beforeRemount = await page.evaluate(() => window.__MOCK_CALLS__.length);
      await page.evaluate(() => window.__remountApp());
      await waitIdle(page);
      await page.getByRole('button', { name: '断开', exact: true }).waitFor();
      await header.getByText('VPN 已连接', { exact: true }).waitFor();
      const remountCalls = await page.evaluate(offset => window.__MOCK_CALLS__.slice(offset), beforeRemount);
      assert.ok(remountCalls.some(call => call.command === 'is_local_client_enabled'));
      assert.ok(remountCalls.some(call => call.command === 'get_local_vpn_status'));
      assert.deepEqual(remountCalls.filter(call => startsVpn(call) || reconnectsManagement(call) || stopsManagement(call)
        || ['stop_local_client', 'plugin:vpnservice|stop_vpn', 'clear_tun_fd'].includes(call.command)), [], 'same-process remount must adopt the existing Core, management session and TUN');
      assert.deepEqual(await page.evaluate(() => window.__MOCK_TUN_BINDING__), existingBinding);
      const beforeStop = await page.evaluate(() => window.__MOCK_CALLS__.length);
      await page.getByRole('button', { name: '断开', exact: true }).click();
      await waitIdle(page);
      await header.getByText('VPN 未连接', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.__MOCK_NATIVE_ENABLED__), false);
      assert.equal(await page.evaluate(() => window.__MOCK_NATIVE_VPN__.state), 'stopped');
      assert.equal(await page.evaluate(() => window.__MOCK_TUN_BINDING__), undefined);
      assert.equal(await page.evaluate(() => window.__MOCK_RPC_READY__), true);
      assert.equal(await page.evaluate(() => window.__MOCK_MANAGEMENT_CONNECTED__), true);
      assert.deepEqual(await page.evaluate(async () => (await window.__TAURI_INTERNALS__.invoke('list_network_instance_ids')).running_inst_ids), [], 'global Disconnect must stop every Core instance');
      assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('enabled_networks'))), rememberedEnabled);
      calls = await page.evaluate(offset => window.__MOCK_CALLS__.slice(offset), beforeStop);
      assert.deepEqual(calls.filter(call => reconnectsManagement(call) || stopsManagement(call)
        || ['remove_network_instance', 'update_network_config_state'].includes(call.command)), [], 'global Disconnect preserves management and saved configuration without per-instance GUI mutations');
      await page.locator('.client-navigation').getByRole('button', { name: '设置', exact: true }).click();
      await settings.getByText('管理服务器认证通过', { exact: true }).waitFor();
      const afterStop = await page.evaluate(() => window.__MOCK_CALLS__.length);
      await page.evaluate(() => {
        window.__MOCK_CONTROLLER_REFRESH__();
        for (const event of ['pre_run_network_instance', 'post_run_network_instance', 'dhcp_ip_changed'])
          window.__MOCK_EMIT_EVENT__(event, '11111111-1111-4111-8111-111111111111');
      });
      await page.waitForFunction(() => JSON.parse(localStorage.getItem('networkList')).some(entry => entry.source === 'web'
        && entry.config.network_name === 'Managed refresh while VPN disconnected' && entry.config.no_tun === true));
      assert.equal(await page.evaluate(() => window.__MOCK_TUN_BINDING__), undefined);
      assert.deepEqual(await page.evaluate(async () => (await window.__TAURI_INTERNALS__.invoke('list_network_instance_ids')).running_inst_ids), [], 'paused controller refresh must not recreate Core instances');
      assert.equal(await header.textContent(), 'VPN 未连接', 'new managed configuration and native network events cannot enable system VPN');
      await settings.getByText('管理服务器认证通过', { exact: true }).waitFor();
      await page.waitForTimeout(2300);
      await page.evaluate(() => window.__remountApp());
      await waitIdle(page);
      await header.getByText('VPN 未连接', { exact: true }).waitFor();
      assert.deepEqual((await page.evaluate(offset => window.__MOCK_CALLS__.slice(offset), afterStop)).filter(call => startsVpn(call) || reconnectsManagement(call)), [], 'stopped VPN must stay disconnected through polling and same-process remount');
      await page.reload();
      await waitIdle(page);
      await header.getByText('VPN 未连接', { exact: true }).waitFor();
      calls = await page.evaluate(() => window.__MOCK_CALLS__);
      assert.deepEqual(calls.filter(startsVpn), [], 'fresh process after stop must not reconnect VPN');
      assert.ok(calls.some(call => call.command === 'init_web_client'), 'fresh process still reconnects management automatically');
      await page.locator('.client-navigation').getByRole('button', { name: '设置', exact: true }).click();
      await settings.getByText('管理服务器认证通过', { exact: true }).waitFor({ timeout: 6000 });
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
  await context.test('Android managed Connect waits for fresh controller state and Disconnect stops every Core', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    try {
      await page.addInitScript(installMockTauri, { platform: 'android', managedOnly: true });
      await page.addInitScript(() => {
        localStorage.setItem('app_mode', JSON.stringify({ mode: 'normal', config_server_url: `udp://example.invalid:22020/${'A'.repeat(43)}` }));
        window.__MOCK_CONTROLLER_AUTO__ = false;
      });
      await page.goto(address); await waitIdle(page);
      const header = page.locator('.client-topbar .status');
      await header.getByText('VPN 未连接', { exact: true }).waitFor();
      await page.getByRole('heading', { name: 'Managed lab', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: '启动', exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: '停止', exact: true }).count(), 0);
      await page.evaluate(() => window.__MOCK_CONTROLLER_REFRESH__({ rename: false }));
      assert.deepEqual(await page.evaluate(async () => (await window.__TAURI_INTERNALS__.invoke('list_network_instance_ids')).running_inst_ids), [], 'a paused heartbeat cannot start managed Core');
      const beforeConnect = await page.evaluate(() => window.__MOCK_CALLS__.length);
      await page.getByRole('button', { name: '连接', exact: true }).click();
      await header.getByText('VPN 连接中', { exact: true }).waitFor();
      await waitIdle(page);
      assert.equal(await page.evaluate(() => window.__MOCK_NATIVE_ENABLED__), true);
      assert.equal(await page.evaluate(() => window.__MOCK_TUN_BINDING__), undefined);
      const waiting = await page.evaluate(offset => window.__MOCK_CALLS__.slice(offset), beforeConnect);
      assert.equal(waiting.some(call => ['run_network_instance', 'update_network_config_state', 'plugin:vpnservice|start_vpn'].includes(call.command)), false, 'cached Web configuration cannot start a Core or tunnel');
      await page.evaluate(id => {
        window.__MOCK_CONFIGS__[id].virtual_ipv4 = '10.101.8.2';
        window.__MOCK_CONTROLLER_REFRESH__({ rename: false });
      }, managedId);
      await header.getByText('VPN 已连接', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.__MOCK_TUN_BINDING__.instanceId), managedId);
      assert.equal(await page.evaluate(() => window.__MOCK_CALLS__.findLast(call => call.command === 'plugin:vpnservice|start_vpn').args.ipv4Addr), '10.101.8.2/24', 'the tunnel must use the fresh controller configuration');
      assert.equal(await page.evaluate(id => window.__MOCK_CALLS__.some(call => ['run_network_instance', 'update_network_config_state'].includes(call.command)
        && (call.args.instanceId || call.args.cfg?.instance_id) === id), managedId), false);
      await page.getByRole('button', { name: '断开', exact: true }).click();
      await header.getByText('VPN 未连接', { exact: true }).waitFor();
      await page.evaluate(() => window.__MOCK_CONTROLLER_REFRESH__({ rename: false }));
      await page.waitForTimeout(100);
      assert.deepEqual(await page.evaluate(async () => (await window.__TAURI_INTERNALS__.invoke('list_network_instance_ids')).running_inst_ids), []);
      assert.equal(await page.evaluate(() => window.__MOCK_RPC_READY__ && window.__MOCK_MANAGEMENT_CONNECTED__), true);
      assert.ok(await page.evaluate(id => JSON.parse(localStorage.getItem('networkList')).some(entry => entry.source === 'web' && entry.config.instance_id === id), managedId));
      await page.locator('.client-navigation').getByRole('button', { name: '设置', exact: true }).click();
      await page.locator('.client-settings-grid .status').getByText('管理服务器认证通过', { exact: true }).waitFor({ timeout: 6000 });
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
  await context.test('Android existing native process overrides stale paused storage without restarting its tunnel', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    try {
      await page.addInitScript(installMockTauri, { platform: 'android', warmNativeEnabled: true });
      await page.addInitScript(() => localStorage.setItem('local_client_paused', 'true'));
      await page.goto(address);
      await waitIdle(page);
      const header = page.locator('.client-topbar .status');
      await header.getByText('VPN 已连接', { exact: true }).waitFor();
      await page.getByRole('button', { name: '断开', exact: true }).waitFor();
      await page.getByRole('img', { name: '实时流量', exact: true }).waitFor();
      let calls = await page.evaluate(() => window.__MOCK_CALLS__);
      assert.ok(calls.some(call => call.command === 'is_local_client_enabled'));
      assert.deepEqual(calls.filter(call => startsVpn(call) || reconnectsManagement(call) || stopsManagement(call)
        || ['stop_local_client', 'plugin:vpnservice|stop_vpn', 'clear_tun_fd'].includes(call.command)), []);
      assert.equal(await page.evaluate(() => window.__MOCK_TUN_BINDING__.requestId), 'warm-native-request');
      await page.evaluate(() => {
        const invoke = window.__TAURI_INTERNALS__.invoke;
        window.__TAURI_INTERNALS__.invoke = async (command, args) => {
          const result = await invoke(command, args);
          return command === 'get_local_vpn_status' ? { running: false, state: 'stopped', established: false }
            : command === 'is_local_vpn_connected' ? false
            : command === 'plugin:vpnservice|get_vpn_status' ? { running: false, state: 'stopped', established: false } : result;
        };
      });
      await header.getByText('VPN 连接中', { exact: true }).waitFor({ timeout: 6000 });
      assert.equal(await header.getByText('VPN 已连接', { exact: true }).count(), 0, 'RPC readiness must not imply VPN connectivity');
      calls = await page.evaluate(() => window.__MOCK_CALLS__);
      assert.deepEqual(calls.filter(startsVpn), [], 'observation must not repair a stopped TUN by starting it');
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
  await context.test('Android shows pending connection, retries incomplete disconnect and keeps management after VPN failures', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    try {
      await page.addInitScript(installMockTauri, { platform: 'android' });
      await page.addInitScript(() => {
        localStorage.setItem('app_mode', JSON.stringify({ mode: 'normal', config_server_url: `udp://example.invalid:22020/${'A'.repeat(43)}` }));
        const invoke = window.__TAURI_INTERNALS__.invoke;
        let hold = true;
        window.__TAURI_INTERNALS__.invoke = async (command, args) => {
          const result = await invoke(command, args);
          if (command === 'plugin:vpnservice|start_vpn' && hold) {
            hold = false;
            await new Promise(resolve => { window.__MOCK_RELEASE_START__ = resolve; });
          }
          return result;
        };
      });
      await page.goto(address); await waitIdle(page);
      const header = page.locator('.client-topbar .status');
      await page.locator('.client-navigation').getByRole('button', { name: '设置', exact: true }).click();
      const settings = page.locator('.client-settings-grid .status');
      await settings.getByText('管理服务器认证通过', { exact: true }).waitFor({ timeout: 6000 });
      const offset = await page.evaluate(() => window.__MOCK_CALLS__.length);
      const running = await page.evaluate(async () => (await window.__TAURI_INTERNALS__.invoke('list_network_instance_ids')).running_inst_ids);
      await page.locator('.client-navigation').getByRole('button', { name: '网络', exact: true }).click();
      await page.getByRole('button', { name: '连接', exact: true }).click();
      await header.getByText('VPN 连接中', { exact: true }).waitFor();
      await page.waitForFunction(() => typeof window.__MOCK_RELEASE_START__ === 'function');
      assert.equal(await header.getByText('VPN 已连接', { exact: true }).count(), 0, 'native receipt without committed Core fd cannot imply connected');
      await page.evaluate(() => window.__MOCK_RELEASE_START__());
      await header.getByText('VPN 已连接', { exact: true }).waitFor();
      await page.evaluate(() => { window.__MOCK_FAIL_CORE_STOP__ = true; });
      await page.getByRole('button', { name: '断开', exact: true }).click();
      await header.getByText('VPN 尚未完全断开', { exact: true }).waitFor();
      const retry = page.getByRole('button', { name: '重试断开', exact: true });
      await retry.waitFor(); assert.equal(await retry.isEnabled(), true);
      assert.equal(await page.getByRole('button', { name: '连接', exact: true }).count(), 0, 'cleanup failure must offer retry disconnect instead of reconnect');
      await page.locator('.client-navigation').getByRole('button', { name: '设置', exact: true }).click();
      await settings.getByText('管理服务器认证通过', { exact: true }).waitFor();
      await page.evaluate(() => { window.__MOCK_FAIL_CORE_STOP__ = false; });
      await page.locator('.client-navigation').getByRole('button', { name: '网络', exact: true }).click();
      await retry.click();
      await header.getByText('VPN 未连接', { exact: true }).waitFor();
      await page.evaluate(() => { window.__MOCK_FAIL_START_VPN__ = true; });
      await page.getByRole('button', { name: '连接', exact: true }).click();
      await page.getByRole('alert').getByText('VPN 连接失败，请检查后重试。', { exact: true }).waitFor();
      await header.getByText('VPN 未连接', { exact: true }).waitFor();
      await page.locator('.client-navigation').getByRole('button', { name: '设置', exact: true }).click();
      await settings.getByText('管理服务器认证通过', { exact: true }).waitFor();
      assert.deepEqual(running, [], 'cold management fixture has no running Core');
      assert.deepEqual(await page.evaluate(async () => (await window.__TAURI_INTERNALS__.invoke('list_network_instance_ids')).running_inst_ids), [], 'failed start rolls back every data-plane instance');
      const calls = await page.evaluate(offset => window.__MOCK_CALLS__.slice(offset), offset);
      assert.deepEqual(calls.filter(call => reconnectsManagement(call) || stopsManagement(call)), []);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
  await context.test('Android warm pre-attachment system revocation never automatically reconnects VPN', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    try {
      await page.addInitScript(installMockTauri, { platform: 'android', warmNativeEnabled: true });
      await page.addInitScript(() => {
        localStorage.setItem('app_mode', JSON.stringify({ mode: 'normal', config_server_url: `udp://example.invalid:22020/${'A'.repeat(43)}` }));
        delete window.__MOCK_TUN_BINDING__;
        window.__MOCK_SET_NATIVE_VPN__({ running: false, state: 'stopped', established: false, stopReason: 'system_revoked',
          requestId: 'revoked-before-Core-attachment', instanceId: '11111111-1111-4111-8111-111111111111' });
      });
      await page.goto(address); await waitIdle(page);
      await page.locator('.client-topbar .status').getByText('VPN 未连接', { exact: true }).waitFor();
      await page.getByRole('alert').getByText('VPN 权限已被系统撤销，请重新连接并授权。管理连接已保留。', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: '连接', exact: true }).isEnabled(), true);
      await page.locator('.client-navigation').getByRole('button', { name: '设置', exact: true }).click();
      await page.locator('.client-settings-grid .status').getByText('管理服务器认证通过', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.__MOCK_NATIVE_ENABLED__), false);
      const calls = await page.evaluate(() => window.__MOCK_CALLS__);
      assert.deepEqual(calls.filter(call => startsVpn(call) || reconnectsManagement(call) || stopsManagement(call)), []);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
  for (const platform of ['android', 'windows']) await context.test(platform, async () => {
    const page = await browser.newPage({ viewport: platform === 'android' ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    try {
      await page.addInitScript(installMockTauri, { platform });
      await page.addInitScript(() => {
        localStorage.setItem('app_mode', JSON.stringify({ mode: 'normal', config_server_url: `udp://example.invalid:22020/${'A'.repeat(43)}` }));
        window.__MOCK_MANAGEMENT_STATUS__ = 'authenticating';
      });
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await waitIdle(page);
      const header = page.locator('.client-topbar .status');
      const vpnLabel = platform === 'android' ? 'VPN 未连接' : 'VPN 已连接';
      await header.getByText(vpnLabel, { exact: true }).waitFor();
      const assertHeaderFits = async label => {
        await page.evaluate(() => document.fonts.ready);
        const bounds = await page.evaluate(() => {
          const bar = document.querySelector('.client-topbar'), actions = document.querySelector('.client-topbar-actions'), status = actions.querySelector('.status');
          const viewport = window.innerWidth;
          return { viewport, pageWidth: document.documentElement.scrollWidth,
            barWidth: bar.scrollWidth, barClientWidth: bar.clientWidth,
            actionsRight: actions.getBoundingClientRect().right, statusRight: status.getBoundingClientRect().right,
            statusLeft: status.getBoundingClientRect().left, brandRight: document.querySelector('.client-brand').getBoundingClientRect().right,
            statusTop: status.getBoundingClientRect().top, statusBottom: status.getBoundingClientRect().bottom,
            barTop: bar.getBoundingClientRect().top, barBottom: bar.getBoundingClientRect().bottom,
            languageLeft: actions.querySelector('.language-switcher').getBoundingClientRect().left };
        });
        assert.ok(bounds.pageWidth <= bounds.viewport + 1, `${platform} ${label} page overflow: ${JSON.stringify(bounds)}`);
        assert.ok(bounds.barWidth <= bounds.barClientWidth + 1, `${platform} ${label} topbar overflow: ${JSON.stringify(bounds)}`);
        assert.ok(bounds.actionsRight <= bounds.viewport + 1 && bounds.statusRight <= bounds.viewport + 1 && bounds.statusLeft >= bounds.brandRight,
          `${platform} ${label} status overlaps or exceeds topbar: ${JSON.stringify(bounds)}`);
        assert.ok(bounds.statusTop >= bounds.barTop && bounds.statusBottom <= bounds.barBottom && bounds.statusRight <= bounds.languageLeft,
          `${platform} ${label} status is clipped or overlaps language control: ${JSON.stringify(bounds)}`);
      };
      await assertHeaderFits(vpnLabel);
      assert.equal(await page.getByRole('button', { name: '新建网络', exact: true }).isEnabled(), true);
      await page.locator('.client-navigation').getByRole('button', { name: '设置', exact: true }).click();
      const settings = page.locator('.client-settings-grid .status');
      await settings.getByText('正在验证设备身份', { exact: true }).waitFor({ timeout: 6000 });
      await page.locator('.management-device-id code').getByText(managementDeviceId, { exact: true }).waitFor();
      await page.getByRole('button', { name: '复制设备 ID', exact: true }).click();
      assert.equal(await page.evaluate(() => window.__MOCK_CLIPBOARD__), managementDeviceId);
      for (const [state, label] of [
        ['pending_approval', '设备变更待审批'], ['rejected', '设备认证失败'],
        ['unknown', '管理服务器认证状态未知'], ['authorized', '管理服务器认证通过'],
      ]) {
        await page.evaluate(state => { window.__MOCK_MANAGEMENT_STATUS__ = state; }, state);
        await settings.getByText(label, { exact: true }).waitFor({ timeout: 6000 });
        assert.equal(await settings.getAttribute('class'), `status ${state === 'authorized' ? 'online' : state === 'rejected' ? 'failed' : state === 'pending_approval' ? 'pending' : 'unknown'}`);
        assert.equal(await header.textContent(), vpnLabel, `${platform} VPN state must stay independent of management ${state}`);
        await assertHeaderFits(label);
      }
      await page.evaluate(() => { window.__MOCK_MANAGEMENT_STATUS__ = 'unknown'; });
      await page.locator('.language-switcher select').selectOption('en');
      await settings.getByText('Management authorization status unknown', { exact: true }).waitFor({ timeout: 6000 });
      await assertHeaderFits('Management authorization status unknown');
      await page.locator('.language-switcher select').selectOption('zh-CN');
      await settings.getByText('管理服务器认证状态未知', { exact: true }).waitFor();
      if (platform === 'android') {
        await page.locator('.client-navigation').getByRole('button', { name: '网络', exact: true }).click();
        await page.getByRole('button', { name: '连接', exact: true }).click();
        await header.getByText('VPN 已连接', { exact: true }).waitFor();
        await page.getByRole('button', { name: '断开', exact: true }).click();
        await header.getByText('VPN 未连接', { exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: '新建网络', exact: true }).isEnabled(), true);
        assert.equal(await page.getByRole('button', { name: '导入配置', exact: true }).isEnabled(), true);
        await page.locator('.client-navigation').getByRole('button', { name: '设置', exact: true }).click();
        await settings.getByText('管理服务器认证状态未知', { exact: true }).waitFor();
        await page.locator('.management-device-id code').getByText(managementDeviceId, { exact: true }).waitFor();
        await page.getByRole('button', { name: '复制设备 ID', exact: true }).click();
        assert.equal(await page.evaluate(() => window.__MOCK_CLIPBOARD__), managementDeviceId);
      } else {
        const identityReads = await page.evaluate(() => window.__MOCK_CALLS__.filter(call => call.command === 'get_management_device_id').length);
        for (const mode of ['service', 'remote']) {
          await page.getByRole('button', { name: '运行模式', exact: true }).click();
          const dialog = page.getByRole('dialog', { name: '运行模式', exact: true });
          await dialog.getByRole('combobox', { name: '运行模式', exact: true }).selectOption(mode);
          if (mode === 'remote') await dialog.getByRole('textbox', { name: 'RPC 地址', exact: true }).fill('tcp://192.0.2.44:15999');
          await dialog.getByRole('button', { name: '保存', exact: true }).click();
          await dialog.waitFor({ state: 'hidden' });
          assert.equal(await page.locator('.management-device-id').count(), 0);
          assert.equal(await page.getByRole('button', { name: '复制设备 ID', exact: true }).count(), 0);
          assert.equal(await page.evaluate(() => window.__MOCK_CALLS__.filter(call => call.command === 'get_management_device_id').length), identityReads);
        }
      }
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
});
