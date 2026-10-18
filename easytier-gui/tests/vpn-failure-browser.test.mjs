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
const coreVersion = '2.7.2-abc526b8-browser-fixture';

test('Android failure details expose only safe translated stages and the complete Core version', { timeout: 60000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), 'et-vpn-diagnosis-ui-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = join(directory, 'fixture.js');
  await esbuild.build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';
    import {App} from './src/react/App';import {NoticeProvider} from './src/react/components/ui';import {i18nReady} from './src/react/lib/i18n';
    i18nReady.then(()=>createRoot(document.getElementById('root')).render(<React.Suspense fallback="Loading"><NoticeProvider><App/></NoticeProvider></React.Suspense>));`,
  resolveDir: gui, loader: 'tsx' }, outfile, bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', loader: { '.svg': 'dataurl' }, logLevel: 'silent' });
  const bundle = await readFile(outfile);
  const server = createServer((request, response) => {
    if (request.url === '/fixture.js') { response.setHeader('content-type', 'text/javascript'); response.end(bundle); }
    else { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><html><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const browser = await chromium.launch({ executablePath: process.env.ET_CHROMIUM_PATH || undefined, headless: true, args: ['--no-sandbox'] });
  context.after(() => browser.close());
  for (const locale of ['zh-CN', 'en']) await context.test(locale, async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.addInitScript(installMockTauri, { platform: 'android' });
      await page.addInitScript(({ locale, coreVersion }) => {
        localStorage.setItem('easytier.locale', locale);
        window.__MOCK_FAIL_START_VPN__ = true;
        const original = window.__TAURI_INTERNALS__.invoke;
        window.__TAURI_INTERNALS__.invoke = async (command, args) => {
          if (command === 'easytier_version') return coreVersion;
          if (command === 'resume_local_client' && window.__DIAG_RAW_ERROR__)
            throw new Error('private-token-at-udp://private.invalid/secret');
          if (command === 'plugin:vpnservice|get_vpn_status' && window.__DIAG_STATUS_REJECT__)
            // eslint-disable-next-line prefer-promise-reject-errors -- Tauri plugin failures are serialized objects.
            return Promise.reject({ code: 'NO_PLUGIN', message: 'private-token-at-udp://private.invalid/secret' });
          return original(command, args);
        };
      }, { locale, coreVersion });
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.locator('.desktop-version').getByText(coreVersion, { exact: true }).waitFor();
      const connect = () => page.getByRole('button', { name: locale === 'en' ? 'Connect' : '连接', exact: true });
      await connect().click();
      const detail = page.getByTestId('vpn-failure-detail');
      await detail.getByText('vpn_tun_start_failed', { exact: true }).waitFor();
      assert.match(await detail.textContent(), locale === 'en' ? /Android VPN interface creation failed/ : /Android VPN 接口创建失败/);
      assert.ok((await detail.textContent()).includes(coreVersion));
      assert.ok((await page.getByRole('alert').textContent()).includes(locale === 'en' ? 'The VPN could not connect.' : 'VPN 连接失败'));
      assert.doesNotMatch(await page.locator('body').textContent(), /mock-secret|private-token-at|private\.invalid/);
      await page.evaluate(() => { window.__MOCK_FAIL_START_VPN__ = false; });
      await connect().click();
      await page.locator('.client-topbar').getByText(locale === 'en' ? 'VPN connected' : 'VPN 已连接', { exact: true }).waitFor();
      assert.equal(await detail.count(), 0, 'successful retry clears the old failure');
      await page.getByRole('button', { name: locale === 'en' ? 'Disconnect' : '断开', exact: true }).click();
      await connect().waitFor();
      assert.equal(await detail.count(), 0);
      await page.evaluate(() => { window.__DIAG_STATUS_REJECT__ = true; });
      await connect().click();
      await detail.getByText('vpn_native_preflight_rejected', { exact: true }).waitFor();
      assert.match(await detail.textContent(), locale === 'en' ? /before starting the system VPN/ : /启动系统 VPN 前的状态查询被拒绝/);
      assert.doesNotMatch(await page.locator('body').textContent(), /private-token-at|private\.invalid|NO_PLUGIN/);
      await page.evaluate(() => { window.__DIAG_STATUS_REJECT__ = false; });
      await page.getByRole('button', { name: locale === 'en' ? 'Retry disconnecting' : '重试断开', exact: true }).click();
      await connect().waitFor();
      await page.evaluate(() => { window.__DIAG_RAW_ERROR__ = true; });
      await connect().click();
      await detail.getByText('vpn_start_failed', { exact: true }).waitFor();
      assert.doesNotMatch(await page.locator('body').textContent(), /private-token-at|private\.invalid|mock-secret/);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
});
