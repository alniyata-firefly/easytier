import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(frontend, '../..');
const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve('vite'))('esbuild');

for (const target of ['web', 'gui', 'gui-android', 'gui-ios']) test(`${target} uplink interface editor validates, preserves exact names and resets automatic policy`, { timeout: 60000 }, async context => {
  const temporary = await mkdtemp(join(tmpdir(), 'et-uplink-ui-'));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const componentRoot = target === 'web' ? frontend : resolve(root, 'easytier-gui');
  const component = target === 'web' ? join(componentRoot, 'src/components/NodeParameters.tsx') : join(componentRoot, 'src/react/components/NodeParameters.tsx');
  const i18n = target === 'web' ? join(componentRoot, 'src/lib/i18n.ts') : join(componentRoot, 'src/react/lib/i18n.ts');
  const unsupported = target === 'gui-android' || target === 'gui-ios';
  const initial = unsupported ? { mtu: 1280, uplink: { mode: 'manual', interfaces: ['eth0'] } } : { mtu: 1280 };
  const outfile = join(temporary, 'fixture.js');
  const mobileFixture = `import React from 'react'; import {createRoot} from 'react-dom/client'; import {NetworkEditor} from ${JSON.stringify(join(root, 'easytier-gui/src/react/components/NetworkEditor.tsx'))}; import {NetworkTypes} from ${JSON.stringify(join(root, 'easytier-gui/src/react/lib/shared.ts'))}; import {i18nReady} from ${JSON.stringify(i18n)};
  const initial={...NetworkTypes.DEFAULT_NETWORK_CONFIG(), network_name:'Mobile fixture',networking_method:NetworkTypes.NetworkingMethod.Standalone,uplink:{mode:'manual',interfaces:['eth0']}};window.__UPLINK_ORIGINAL__=initial;window.__UPLINK_CAPTURE__=[];
  const client={validate_config:async config=>window.__UPLINK_CAPTURE__.push(config),save_config:async config=>window.__UPLINK_CAPTURE__.push(config)};
  i18nReady.then(()=>createRoot(document.getElementById('root')).render(<React.Suspense fallback="Loading"><NetworkEditor initial={initial} client={client} allowRemoteSave={true} supportsUplinkSelection={false} onClose={()=>{}} onSaved={()=>{}}/></React.Suspense>));`;
  await esbuild.build({ stdin: { contents: unsupported ? mobileFixture : `import React, {useState} from 'react'; import {createRoot} from 'react-dom/client'; import {NodeParameters} from ${JSON.stringify(component)}; import {i18nReady} from ${JSON.stringify(i18n)}; function Fixture(){const[value,setValue]=useState(${JSON.stringify(initial)});const[valid,setValid]=useState(true);return <><NodeParameters supportsUplinkSelection={${!unsupported}} mode=${JSON.stringify(target === 'web' ? 'member' : 'instance')} value={value} onPatch={patch=>setValue(old=>({...old,...patch}))} onValidityChange={setValid}/><button disabled={!valid} id="save">Save fixture</button><pre id="value">{JSON.stringify(value)}</pre></>};i18nReady.then(()=>createRoot(document.getElementById('root')).render(<React.Suspense fallback="Loading"><Fixture/></React.Suspense>));`, resolveDir: frontend, loader: 'tsx' }, outfile, bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', logLevel: 'silent' });
  const bundle = await readFile(outfile);
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/fixture.js') { response.setHeader('content-type', 'text/javascript'); response.end(bundle); }
      else if (request.url?.startsWith('/locales/')) { response.setHeader('content-type', 'application/json'); response.end(await readFile(join(componentRoot, 'public', request.url))); }
      else { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><html><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'); }
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const browser = await chromium.launch({ executablePath: process.env.ET_CHROMIUM_PATH || (existsSync('/root/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome') ? '/root/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' : undefined), headless: true, args: ['--no-sandbox'] });
  context.after(() => browser.close());
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  if (unsupported) {
    const editor = page.getByRole('dialog', { name: '编辑网络', exact: true });
    await editor.waitFor();
    await editor.getByRole('tab', { name: '节点参数', exact: true }).click();
    await editor.locator('.node-parameters').waitFor();
    assert.equal(await editor.getByRole('combobox', { name: '上联网卡选择', exact: true }).count(), 0);
    assert.equal(await editor.getByRole('textbox', { name: '允许使用的接口', exact: true }).count(), 0);
    const save = editor.getByRole('button', { name: '保存', exact: true });
    assert.equal(await save.isEnabled(), true);
    await save.click();
    await page.waitForFunction(() => window.__UPLINK_CAPTURE__?.length === 2);
    const captured = await page.evaluate(() => window.__UPLINK_CAPTURE__);
    for (const config of captured) { assert.equal(config.uplink, undefined); assert.equal(config.network_name, 'Mobile fixture'); }
    assert.deepEqual(await page.evaluate(() => window.__UPLINK_ORIGINAL__.uplink), { mode: 'manual', interfaces: ['eth0'] });
    assert.deepEqual(errors, []);
    return;
  }
  const selector = page.getByRole('combobox', { name: '上联网卡选择', exact: true });
  await selector.waitFor();
  assert.equal(await selector.inputValue(), 'auto');
  assert.equal(await page.getByRole('textbox', { name: '允许使用的接口', exact: true }).count(), 0);
  await selector.selectOption('manual');
  const interfaces = page.getByRole('textbox', { name: '允许使用的接口', exact: true });
  await interfaces.waitFor();
  assert.equal(await page.locator('#save').isDisabled(), true);
  await interfaces.fill('eth0\nEthernet 2');
  await page.waitForFunction(() => !document.getElementById('save').disabled);
  const snapshot = async () => JSON.parse(await page.locator('#value').textContent());
  assert.deepEqual((await snapshot()).uplink, { mode: 'manual', interfaces: ['eth0', 'Ethernet 2'] });
  await interfaces.fill('eth0\neth0');
  await page.waitForFunction(() => document.getElementById('save').disabled);
  await selector.selectOption('auto');
  await page.waitForFunction(() => !document.getElementById('save').disabled);
  assert.deepEqual(await snapshot(), { mtu: 1280, uplink: { mode: 'auto', interfaces: [] } });
  assert.equal(await interfaces.count(), 0);
  assert.deepEqual(errors, []);
});
