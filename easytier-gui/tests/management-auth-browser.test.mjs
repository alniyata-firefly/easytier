import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { installMockTauri } from './mock-tauri.mjs';

const gui = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve('vite'))('esbuild');
const managementDeviceId = '11111111-2222-4333-8444-555555555555';

test('managed GUI distinguishes Core readiness, authentication, denial, and approval', { timeout: 90000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), 'et-management-auth-ui-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = join(directory, 'fixture.js');
  await esbuild.build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';
    import {App} from './src/react/App';import {NoticeProvider} from './src/react/components/ui';import {i18nReady} from './src/react/lib/i18n';
    i18nReady.then(()=>createRoot(document.getElementById('root')).render(<React.Suspense fallback="Loading"><NoticeProvider><App/></NoticeProvider></React.Suspense>));`,
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
      const header = page.locator('.client-topbar .status');
      await header.getByText('正在验证设备身份', { exact: true }).waitFor();
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
      await assertHeaderFits('正在验证设备身份');
      assert.equal(await page.getByRole('button', { name: '新建网络', exact: true }).isEnabled(), true);
      await page.locator('.client-navigation').getByRole('button', { name: '设置', exact: true }).click();
      const settings = page.locator('.client-settings-grid .status');
      await page.locator('.management-device-id code').getByText(managementDeviceId, { exact: true }).waitFor();
      await page.getByRole('button', { name: '复制设备 ID', exact: true }).click();
      assert.equal(await page.evaluate(() => window.__MOCK_CLIPBOARD__), managementDeviceId);
      for (const [state, label] of [
        ['pending_approval', '设备变更待审批'], ['rejected', '设备认证失败'],
        ['unknown', '管理服务器认证状态未知'], ['authorized', '管理服务器认证通过'],
      ]) {
        await page.evaluate(state => { window.__MOCK_MANAGEMENT_STATUS__ = state; }, state);
        await header.getByText(label, { exact: true }).waitFor({ timeout: 6000 });
        await settings.getByText(label, { exact: true }).waitFor();
        assert.equal(await header.getAttribute('class'), `status ${state === 'authorized' ? 'online' : state === 'rejected' ? 'failed' : state === 'pending_approval' ? 'pending' : 'unknown'}`);
        await assertHeaderFits(label);
      }
      await page.evaluate(() => { window.__MOCK_MANAGEMENT_STATUS__ = 'unknown'; });
      await page.locator('.language-switcher select').selectOption('en');
      await header.getByText('Management authorization status unknown', { exact: true }).waitFor({ timeout: 6000 });
      await assertHeaderFits('Management authorization status unknown');
      await page.locator('.language-switcher select').selectOption('zh-CN');
      await header.getByText('管理服务器认证状态未知', { exact: true }).waitFor();
      if (platform === 'android') {
        await page.locator('.client-navigation').getByRole('button', { name: '网络', exact: true }).click();
        await page.getByRole('button', { name: '停止客户端', exact: true }).click();
        await header.getByText('客户端已暂停', { exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: '新建网络', exact: true }).isEnabled(), true);
        assert.equal(await page.getByRole('button', { name: '导入配置', exact: true }).isEnabled(), true);
        await page.locator('.client-navigation').getByRole('button', { name: '设置', exact: true }).click();
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
