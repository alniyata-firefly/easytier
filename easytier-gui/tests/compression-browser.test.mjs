import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const gui = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve('vite'))('esbuild');
const output = process.env.ET_COMPRESSION_QA_OUTPUT || resolve(gui, '../../evidence/gui-compression');
const labels = JSON.parse(await readFile(join(gui, 'public/locales/zh-CN/node-config.json')));

test('GUI compression saves default, Off and Zstd on Windows and Android without losing other parameters', { timeout: 90000 }, async context => {
  const temporary = await mkdtemp(join(tmpdir(), 'et-gui-compression-'));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  await mkdir(output, { recursive: true });
  const fixture = `import React from 'react';import {createRoot} from 'react-dom/client';
    import {NetworkEditor} from './src/react/components/NetworkEditor';
    import {NetworkTypes} from './src/react/lib/shared';
    import {supportsUplinkSelectionForTarget} from './src/react/lib/uplink-capabilities';
    import {i18nReady} from './src/react/lib/i18n';
    const platform=new URLSearchParams(location.search).get('os');
    const initial={...NetworkTypes.DEFAULT_NETWORK_CONFIG(),instance_id:'20000000-0000-4000-8000-000000000002',network_name:'Compression fixture',network_secret:'synthetic-fixture-only',networking_method:NetworkTypes.NetworkingMethod.Standalone,mtu:1280,data_compress_algo:2,bind_device:true,uplink:{mode:'manual',interfaces:['eth0']},future_fixture:{keep:'unchanged'}};
    window.__INITIAL__=initial;window.__CAPTURE__=[];window.__INVENTORY_CALLS__=0;window.__SAVED__=0;
    const capture=(kind,config)=>window.__CAPTURE__.push({kind,config:structuredClone(config)});
    const client={validate_config:async config=>capture('validate',config),save_config:async config=>capture('save',config),get_network_interfaces:async()=>{window.__INVENTORY_CALLS__++;return {interfaces:[{name:'eth0',addresses:['192.0.2.10/24'],kind:'ethernet',up:true,selectable:true}]};}};
    i18nReady.then(()=>createRoot(document.getElementById('root')).render(<React.Suspense fallback="Loading"><NetworkEditor initial={initial} client={client} allowRemoteSave={true} supportsUplinkSelection={supportsUplinkSelectionForTarget(platform,{mode:'normal'})} onClose={()=>{}} onSaved={()=>window.__SAVED__++}/></React.Suspense>));`;
  const outfile = join(temporary, 'fixture.js');
  await esbuild.build({ stdin: { contents: fixture, resolveDir: gui, loader: 'tsx' }, outfile, bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', loader: { '.svg': 'dataurl' }, logLevel: 'silent' });
  const bundle = await readFile(outfile);
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      if (path === '/fixture.js') { response.setHeader('content-type', 'text/javascript'); response.end(bundle); }
      else if (path === '/style.css') { response.setHeader('content-type', 'text/css'); response.end(await readFile(join(gui, 'src/react/style.css'))); }
      else if (path === '/') { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'); }
      else response.writeHead(404).end();
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const browser = await chromium.launch({ executablePath: process.env.ET_CHROMIUM_PATH || (existsSync('/root/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome') ? '/root/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' : undefined), headless: true, args: ['--no-sandbox'] });
  context.after(() => browser.close());
  const proof = { scope: 'Actual GUI NetworkEditor with synthetic local client RPC; no native Core, APK, production access or deployment', cases: [] };
  context.after(() => writeFile(join(output, 'proof.json'), JSON.stringify(proof, null, 2)));
  for (const os of ['windows', 'android']) {
    const mobile = os === 'android';
    const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
    page.setDefaultTimeout(10000);
    const errors = [], failedRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('requestfailed', request => failedRequests.push(request.url()));
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}/?os=${os}`);
      const editor = page.getByRole('dialog', { name: '编辑网络', exact: true });
      await editor.waitFor();
      await editor.getByRole('tab', { name: '节点参数', exact: true }).click();
      const compression = editor.getByRole('combobox', { name: labels.fields.data_compress_algo, exact: true });
      await compression.waitFor();
      assert.equal(await compression.inputValue(), '2', `${os} reads existing Zstd configuration`);
      assert.deepEqual(await compression.locator('option').evaluateAll(options => options.map(option => ({ value: option.value, text: option.textContent }))), [
        { value: 'default', text: labels.compression.default }, { value: '1', text: labels.compression.disabled }, { value: '2', text: 'Zstd' },
      ]);
      assert.equal(await editor.getByRole('combobox', { name: labels.fields.uplink_mode, exact: true }).count(), mobile ? 0 : 1);
      assert.equal(await editor.getByRole('checkbox', { name: labels.fields.bind_device, exact: true }).count(), mobile ? 0 : 1);
      assert.equal(await editor.getByRole('textbox', { name: labels.fields.dev_name, exact: true }).count(), 1);
      for (const key of ['netns','socket_mark']) assert.equal(await editor.getByRole('textbox',{name:labels.fields[key],exact:true}).count(),mobile ? 0 : 1);
      for (const key of ['enable_kcp_proxy', 'disable_kcp_input', 'enable_quic_proxy', 'disable_quic_input']) {
        assert.equal(await editor.getByRole('checkbox', { name: labels.fields[key], exact: true }).count(), 1, `${os} standalone ${key} remains configurable`);
      }
      const saves = [];
      for (const [index, choice] of ['default', '1', '2'].entries()) {
        await compression.selectOption(choice);
        const save = editor.getByRole('button', { name: '保存', exact: true });
        assert.equal(await save.isEnabled(), true);
        await save.click();
        await page.waitForFunction(count => window.__SAVED__ === count, index + 1);
        const captured = await page.evaluate(count => window.__CAPTURE__.slice((count - 1) * 2, count * 2), index + 1);
        assert.deepEqual(captured.map(row => row.kind), ['validate', 'save']);
        for (const { config } of captured) {
          assert.equal(config.data_compress_algo, choice === 'default' ? undefined : Number(choice));
          if (choice === 'default') assert.equal(Object.hasOwn(config, 'data_compress_algo'), false, 'returning to default removes the previous explicit compression value');
          assert.equal(config.mtu, 1280);
          assert.deepEqual(config.future_fixture, { keep: 'unchanged' });
          if (mobile) { assert.equal(config.uplink, undefined); assert.equal(config.bind_device, false); }
          else { assert.deepEqual(config.uplink, { mode: 'manual', interfaces: ['eth0'] }); assert.equal(config.bind_device, true); }
        }
        saves.push({ selected: choice || 'default', saved: captured[1].config.data_compress_algo ?? null });
      }
      const initial = await page.evaluate(() => window.__INITIAL__);
      assert.equal(initial.data_compress_algo, 2);
      assert.equal(initial.bind_device, true);
      assert.deepEqual(initial.uplink, { mode: 'manual', interfaces: ['eth0'] });
      const inventoryCalls = await page.evaluate(() => window.__INVENTORY_CALLS__);
      if (mobile) assert.equal(inventoryCalls, 0);
      else assert.ok(inventoryCalls > 0);
      assert.deepEqual(errors, []);
      assert.deepEqual(failedRequests, []);
      await page.screenshot({ path: join(output, `${os}.png`), fullPage: true });
      proof.cases.push({ os, status: 'PASS', saves, preserved: ['mtu', 'future_fixture', 'TUN name', 'standalone KCP/QUIC controls'], interfaceControls: mobile ? 'hidden and normalized' : 'visible and preserved', inventoryCalls, errors });
    } catch (error) {
      proof.cases.push({ os, status: 'FAIL', error: String(error), errors, failedRequests });
      await page.screenshot({ path: join(output, `${os}-failed.png`), fullPage: true });
      throw error;
    } finally { await page.close(); }
  }
  proof.status = 'PASS';
  proof.case_count = proof.cases.length;
});
