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

for (const target of ['web', 'gui', 'gui-android']) test(`${target} uplink interface editor validates, preserves exact names and resets automatic policy`, { timeout: 60000 }, async context => {
  const temporary = await mkdtemp(join(tmpdir(), 'et-uplink-ui-'));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const componentRoot = target === 'web' ? frontend : resolve(root, 'easytier-gui');
  const component = target === 'web' ? join(componentRoot, 'src/components/NodeParameters.tsx') : join(componentRoot, 'src/react/components/NodeParameters.tsx');
  const i18n = target === 'web' ? join(componentRoot, 'src/lib/i18n.ts') : join(componentRoot, 'src/react/lib/i18n.ts');
  const unsupported = target === 'gui-android';
  const initial = unsupported ? { mtu: 1280, uplink: { mode: 'manual', interfaces: ['eth0'] } } : { mtu: 1280 };
  const outfile = join(temporary, 'fixture.js');
  await esbuild.build({ stdin: { contents: `import React, {useState} from 'react'; import {createRoot} from 'react-dom/client'; import {NodeParameters} from ${JSON.stringify(component)}; import {i18nReady} from ${JSON.stringify(i18n)}; function Fixture(){const[value,setValue]=useState(${JSON.stringify(initial)});const[valid,setValid]=useState(true);return <><NodeParameters supportsUplinkSelection={${!unsupported}} mode=${JSON.stringify(target === 'web' ? 'member' : 'instance')} value={value} onPatch={patch=>setValue(old=>({...old,...patch}))} onValidityChange={setValid}/><button disabled={!valid} id="save">Save fixture</button><pre id="value">{JSON.stringify(value)}</pre></>};i18nReady.then(()=>createRoot(document.getElementById('root')).render(<React.Suspense fallback="Loading"><Fixture/></React.Suspense>));`, resolveDir: frontend, loader: 'tsx' }, outfile, bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', logLevel: 'silent' });
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
  const selector = page.getByRole('combobox', { name: '上联网卡选择', exact: true });
  await selector.waitFor();
  if (unsupported) {
    assert.equal(await selector.inputValue(), 'manual');
    assert.equal(await selector.locator('option[value=manual]').evaluate(option => option.disabled), true, await selector.innerHTML());
    assert.equal(await page.getByRole('textbox', { name: '允许使用的接口', exact: true }).count(), 0);
    assert.equal(await page.locator('#save').isDisabled(), true);
    await selector.selectOption('auto');
    await page.waitForFunction(() => !document.getElementById('save').disabled);
    assert.deepEqual(JSON.parse(await page.locator('#value').textContent()), { mtu: 1280, uplink: { mode: 'auto', interfaces: [] } });
    assert.deepEqual(errors, []);
    return;
  }
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
