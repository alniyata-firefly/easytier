import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve('vite'))('esbuild');
const output = process.env.ET_LAYOUT_QA_OUTPUT || '/root/easytier-uplink-policy-20261015/runtime/ui-layout';
const deviceId = '10000000-0000-4000-8000-000000000001', instanceId = '20000000-0000-4000-8000-000000000001';
const uuid = value => { const hex = value.replaceAll('-', ''); return Object.fromEntries([1,2,3,4].map(part => [`part${part}`, parseInt(hex.slice((part - 1) * 8, part * 8), 16)])); };
const network = { network_id: instanceId, display_name: 'Office network', network_name: 'office-net', networking_method: 'Standalone', virtual_cidr: '10.80.0.0/24', secure_mode: false, prefer_ipv6: true, member_count: 1, online_member_count: 0, network_secret: 'synthetic-only', peer_urls: [], deployment: { state: 'applied', devices: [] } };
const machines = [{ alias: 'Office gateway', client_url: '198.51.100.12', online: false, info: { machine_id: uuid(deviceId), hostname: 'gateway', easytier_version: '2.7.0', running_network_instances: [] }, networks: [] }, { alias: 'Lab phone', client_url: '203.0.113.8', online: true, info: { machine_id: uuid('10000000-0000-4000-8000-000000000002'), hostname: 'phone', easytier_version: '2.7.0', running_network_instances: [] }, networks: [] }];
const tokens = [{ id: 'synthetic-office-token', label: 'Office token', machine_id: deviceId, created_at: new Date().toISOString() }, { id: 'synthetic-lab-token', label: 'Lab token', created_at: new Date().toISOString() }];

test('console layout, navigation, global search and account popover use synthetic API fixtures', { timeout: 120000 }, async context => {
  const temporary = await mkdtemp(join(tmpdir(), 'et-console-layout-'));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  await mkdir(output, { recursive: true });
  const outfile = join(temporary, 'fixture.js');
  await esbuild.build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import App from './src/App';import {i18nReady} from './src/lib/i18n';i18nReady.then(()=>createRoot(document.getElementById('root')).render(<App/>));`, resolveDir: frontend, loader: 'tsx' }, outfile, bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', logLevel: 'silent' });
  const bundle = await readFile(outfile), css = `${await readFile(join(frontend, 'src/fonts.css'))}\n${await readFile(join(frontend, 'src/style.css'))}`;
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname === '/fixture.js') { response.setHeader('content-type', 'text/javascript'); response.end(bundle); }
      else if (pathname === '/style.css') { response.setHeader('content-type', 'text/css'); response.end(css); }
      else if (pathname.startsWith('/locales/') || pathname.startsWith('/fonts/')) { response.setHeader('content-type', pathname.endsWith('.json') ? 'application/json' : pathname.endsWith('.woff2') ? 'font/woff2' : 'text/html'); response.end(await readFile(join(frontend, 'public', pathname))); }
      else { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'); }
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const browser = await chromium.launch({ executablePath: process.env.ET_CHROMIUM_PATH || (existsSync('/root/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome') ? '/root/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' : undefined), headless: true, args: ['--no-sandbox'] });
  context.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], unexpected = [], checked = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname.replace('/api/v1', '');
    let data;
    if (request.method() === 'GET' && pathname === '/console-info') data = { username: 'admin', config_server_protocol: 'udp', config_server_port: 22020, webhook_auth: false };
    else if (request.method() === 'GET' && pathname === '/machines') data = { machines };
    else if (request.method() === 'GET' && pathname === '/networks') data = { networks: [network] };
    else if (request.method() === 'GET' && pathname === `/networks/${instanceId}`) data = network;
    else if (request.method() === 'GET' && pathname === `/networks/${instanceId}/members`) data = { members: [], temporary_peers: [] };
    else if (request.method() === 'GET' && pathname === '/networks/gateway-info') data = { enabled: false, relay_data: true };
    else if (request.method() === 'GET' && pathname === '/device-access-tokens') data = { tokens };
    else if (request.method() === 'GET' && pathname === '/blocked-devices') data = { blocked: [] };
    else if (request.method() === 'GET' && pathname === `/machines/${deviceId}/networks`) data = { running_inst_ids: [], disabled_inst_ids: [uuid(instanceId)] };
    else if (request.method() === 'POST' && pathname === `/machines/${deviceId}/networks/metas`) data = { metas: { [instanceId]: { network_name: 'Office instance', source: 'user' } } };
    else if (request.method() === 'GET' && pathname === '/server/resources') data = { host_resources_supported: true, host_resources: { cpu_usage_percent: 4.2, memory_total_bytes: '8589934592', memory_available_bytes: '6442450944', process_rss_bytes: '75497472', sampled_at_unix_ms: String(Date.now()), disks: [] } };
    else { unexpected.push(`${request.method()} ${pathname}`); return route.fulfill({ status: 404, json: {} }); }
    await route.fulfill({ json: data });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const crumb = () => page.getByRole('navigation', { name: '当前位置', exact: true });
  const noOverflow = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
  await page.goto(base);
  await crumb().getByText('概览', { exact: true }).waitFor();
  await page.locator('.summary-item strong').first().getByText('2', { exact: true }).waitFor();
  assert.equal(await page.locator('main h1').count(), 0);
  assert.equal(await page.locator('.workspace-breadcrumb').count(), 0);
  assert.equal(await page.getByText('admin', { exact: true }).count(), 0);
  const kpi = await page.locator('.summary-strip').boundingBox(), grid = await page.locator('.overview-grid').boundingBox();
  assert.ok(Math.abs(kpi.x - grid.x) <= 1 && Math.abs(kpi.width - grid.width) <= 1);
  assert.equal(await page.locator('.summary-item').first().evaluate(element => getComputedStyle(element).borderTopWidth), '1px');
  const secondKpi=await page.locator('.summary-item').nth(1).boundingBox(), lowerLeft=await page.locator('.overview-grid > .stack > .panel').first().boundingBox();
  assert.ok(Math.abs(secondKpi.x+secondKpi.width-lowerLeft.x-lowerLeft.width)<=1);
  await page.screenshot({ path: join(output, 'overview-desktop.png'), fullPage: true }); checked.push('overview cards and no duplicate headings');
  const account = page.getByRole('button', { name: '账户菜单', exact: true });
  await noOverflow();
  const avatar = await account.boundingBox(); assert.ok(avatar.y > 850 && avatar.x < 88);
  await account.focus(); await page.keyboard.press('Enter');
  const popover = page.getByRole('dialog', { name: '账户菜单', exact: true }); await popover.waitFor();
  assert.equal(await popover.getByRole('button', { name: '修改密码', exact: true }).evaluate(element => element === document.activeElement), true);
  assert.equal(await popover.getByRole('link', { name: '字体与许可', exact: true }).count(), 1);
  await page.screenshot({ path: join(output, 'account-desktop.png'), fullPage: true });
  await page.keyboard.press('Escape'); await popover.waitFor({ state: 'hidden' }); assert.equal(await account.evaluate(element => element === document.activeElement), true);
  await account.click(); await page.locator('.topbar-brand').click(); await popover.waitFor({ state: 'hidden' });
  await account.click(); await popover.getByRole('button', { name: '修改密码', exact: true }).click();
  const password = page.getByRole('dialog', { name: '修改密码', exact: true }); await password.waitFor();
  const passwordField = password.getByLabel('新密码', { exact: true }); await passwordField.focus();
  assert.equal(await passwordField.evaluate(element => getComputedStyle(element).outlineStyle), 'none');
  assert.equal(await passwordField.evaluate(element => getComputedStyle(element).boxShadow), 'none');
  await password.getByRole('button', { name: '取消', exact: true }).click(); checked.push('account keyboard, outside click, password dialog and focus style');
  await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('link', { name: '网络', exact: true }).click();
  await page.locator('.network-list').waitFor();
  const listHeader = page.locator('.list-panel > .panel-heading');
  assert.equal(await listHeader.getByRole('searchbox').count(), 1); assert.equal(await listHeader.getByRole('button', { name: '创建网络', exact: true }).count(), 1);
  const controls = await listHeader.locator('input,button').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().top)); assert.ok(Math.max(...controls) - Math.min(...controls) < 3);
  await listHeader.getByRole('searchbox').focus(); assert.equal(await listHeader.getByRole('searchbox').evaluate(element => getComputedStyle(element).outlineStyle), 'none');
  assert.ok(parseFloat(await listHeader.getByRole('button', { name: '创建网络', exact: true }).evaluate(element => getComputedStyle(element).borderTopLeftRadius)) >= 8);
  await page.screenshot({ path: join(output, 'networks-desktop.png'), fullPage: true });
  await page.locator('.network-list').getByRole('button', { name: /Office network/ }).click(); await crumb().getByRole('link', { name: 'Office network', exact: true }).waitFor();
  await crumb().getByRole('link', { name: '网络', exact: true }).click(); await page.locator('.network-list').waitFor(); checked.push('list header alignment and network breadcrumb navigation');
  assert.equal(await page.locator('main h1').count(), 0);
  const search = page.getByRole('combobox', { name: '全局搜索', exact: true });
  await search.fill('Office network'); await page.getByRole('option', { name: /Office network/ }).waitFor(); await search.press('Enter');
  await crumb().getByRole('link', { name: 'Office network', exact: true }).waitFor();
  await crumb().getByRole('link', { name: '网络', exact: true }).click(); await page.locator('.network-list').waitFor();
  await search.fill('Office gateway'); await page.getByRole('option', { name: /Office gateway/ }).waitFor();
  await search.press('Escape'); await page.getByRole('listbox', { name: '搜索结果', exact: true }).waitFor({ state: 'hidden' });
  await search.focus(); await search.press('ArrowDown'); await page.getByRole('option', { name: /Office gateway/ }).waitFor();
  await page.locator('.topbar-brand').click(); await page.getByRole('listbox', { name: '搜索结果', exact: true }).waitFor({ state: 'hidden' });
  await search.focus(); await search.press('ArrowDown'); await page.getByRole('option', { name: /Office gateway/ }).waitFor(); await search.press('Enter');
  await crumb().getByRole('link', { name: 'Office gateway', exact: true }).waitFor();
  await page.getByRole('link', { name: 'Office instance', exact: true }).click(); await crumb().getByText('Office instance', { exact: true }).waitFor();
  await crumb().getByRole('link', { name: '设备', exact: true }).click(); await page.locator('.list-panel .data-table').waitFor();
  assert.equal(await page.locator('.list-panel > .panel-heading').getByRole('searchbox').count(), 1);
  assert.equal(await page.locator('main h1').count(), 0);
  await page.screenshot({ path: join(output, 'devices-desktop.png'), fullPage: true });
  await search.fill('Office token'); await page.getByRole('option', { name: /Office token/ }).waitFor(); await search.press('Enter');
  await page.locator('.list-panel .data-table').waitFor(); assert.equal(await page.locator('.list-panel tbody tr').count(), 1);
  assert.equal(await page.locator('.list-panel tbody').getByText('Office token', { exact: true }).count(), 1);
  assert.equal(await page.locator('main h1').count(), 0);
  await page.screenshot({ path: join(output, 'tokens-desktop.png'), fullPage: true }); checked.push('global search navigation across devices and tokens, query filtering');
  await account.click(); await popover.getByRole('combobox', { name: '语言', exact: true }).selectOption('en');
  await page.getByRole('navigation', { name: 'Breadcrumb', exact: true }).waitFor();
  await page.getByRole('dialog', { name: 'Account menu', exact: true }).getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN');
  await page.keyboard.press('Escape'); checked.push('account language switch');
  for (const viewport of [{ width: 1024, height: 768 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport); await noOverflow();
    if (viewport.width < 760) { await page.getByRole('button', { name: '打开导航', exact: true }).click(); await page.getByRole('dialog', { name: '导航', exact: true }).getByRole('button', { name: '账户菜单', exact: true }).click(); await page.getByRole('dialog', { name: '账户菜单', exact: true }).waitFor(); await page.screenshot({ path: join(output, 'account-mobile.png'), fullPage: true }); await page.keyboard.press('Escape'); await page.getByRole('dialog', { name: '账户菜单', exact: true }).waitFor({ state: 'hidden' }); assert.equal(await page.getByRole('dialog', { name: '导航', exact: true }).isVisible(), true); await page.keyboard.press('Escape'); await page.getByRole('dialog', { name: '导航', exact: true }).waitFor({ state: 'hidden' }); }
    await page.screenshot({ path: join(output, `tokens-${viewport.width}.png`), fullPage: true });
  }
  const fills = await page.locator('button:visible').evaluateAll(elements => elements.map(element => getComputedStyle(element).backgroundColor));
  assert.ok(fills.every(fill => fill === 'rgba(0, 0, 0, 0)')); checked.push('responsive layouts and unfilled buttons');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${base}/#/h/networks/%E0%A4%A`); await page.getByText('链接格式不正确，请从导航进入页面。', { exact: true }).waitFor();
  await page.getByRole('navigation', { name: '当前位置', exact: true }).getByRole('link', { name: '网络', exact: true }).click(); await page.locator('.network-list').waitFor();
  checked.push('malformed route stays recoverable');
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  await writeFile(join(output, 'proof.json'), JSON.stringify({ checked, pageErrors: errors, unexpectedApiRequests: unexpected, syntheticOnly: true }, null, 2));
});
