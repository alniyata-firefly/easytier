import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
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
  const inventoryModule = resolve(root, 'easytier-web/frontend-lib/src/modules/uplinkInventory.ts');
  const mobileFixture = `import React from 'react'; import {createRoot} from 'react-dom/client'; import {NetworkEditor} from ${JSON.stringify(join(root, 'easytier-gui/src/react/components/NetworkEditor.tsx'))}; import {NetworkTypes} from ${JSON.stringify(join(root, 'easytier-gui/src/react/lib/shared.ts'))}; import {i18nReady} from ${JSON.stringify(i18n)};
  const initial={...NetworkTypes.DEFAULT_NETWORK_CONFIG(), network_name:'Mobile fixture',networking_method:NetworkTypes.NetworkingMethod.Standalone,uplink:{mode:'manual',interfaces:['eth0']}};window.__UPLINK_ORIGINAL__=initial;window.__UPLINK_CAPTURE__=[];
  const client={validate_config:async config=>window.__UPLINK_CAPTURE__.push(config),save_config:async config=>window.__UPLINK_CAPTURE__.push(config)};
  i18nReady.then(()=>createRoot(document.getElementById('root')).render(<React.Suspense fallback="Loading"><NetworkEditor initial={initial} client={client} allowRemoteSave={true} supportsUplinkSelection={false} onClose={()=>{}} onSaved={()=>{}}/></React.Suspense>));`;
  const desktopFixture = `import React, {useCallback,useState} from 'react'; import {createRoot} from 'react-dom/client'; import {NodeParameters} from ${JSON.stringify(component)}; import {i18nReady} from ${JSON.stringify(i18n)}; import {UplinkInventoryError} from ${JSON.stringify(inventoryModule)};
  const make=(name,addresses=[],extra={})=>({name,addresses,kind:'ethernet',up:true,selectable:true,...extra});
  window.__INVENTORY__={interfaces:[make('eth0',['192.0.2.46/24','2001:db8:7::46/64']),make('Ethernet 2',['192.168.1.5/24']),make('备用网卡',[],{up:false}),make('wg0',['fd00:8::1/64'],{kind:'wireguard'}),make('lo',['127.0.0.1/8'],{kind:'loopback',selectable:false})]};window.__FAILURE__=undefined;window.__DEFER__=false;window.__CALLS__=0;
  function Fixture(){const[value,setValue]=useState(${JSON.stringify(initial)});const[valid,setValid]=useState(true);const load=useCallback(async()=>{window.__CALLS__++;if(window.__DEFER__)return new Promise(resolve=>window.__RESOLVE__=resolve);if(window.__FAILURE__)throw new UplinkInventoryError(window.__FAILURE__);return structuredClone(window.__INVENTORY__);},[]);return <main style={{maxWidth:700,margin:'24px auto',padding:16}}><NodeParameters loadUplinkInventory={load} mode=${JSON.stringify(target === 'web' ? 'member' : 'instance')} value={value} onPatch={patch=>setValue(old=>({...old,...patch}))} onValidityChange={setValid}/><button disabled={!valid} id="save">Save fixture</button><button id="saved-config" onClick={()=>setValue({mtu:1280,uplink:{mode:'manual',interfaces:['old adapter']}})}>Load saved fixture</button><pre id="value" style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(value)}</pre></main>};i18nReady.then(()=>createRoot(document.getElementById('root')).render(<React.Suspense fallback="Loading"><Fixture/></React.Suspense>));`;
  await esbuild.build({ stdin: { contents: unsupported ? mobileFixture : desktopFixture, resolveDir: frontend, loader: 'tsx' }, outfile, bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', loader: { '.svg': 'dataurl' }, logLevel: 'silent' });
  const bundle = await readFile(outfile);
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/style.css') { response.setHeader('content-type', 'text/css'); response.end(await readFile(join(componentRoot, target === 'web' ? 'src/style.css' : 'src/react/style.css'))); }
      else if (request.url === '/fixture.js') { response.setHeader('content-type', 'text/javascript'); response.end(bundle); }
      else if (request.url?.startsWith('/locales/')) { response.setHeader('content-type', 'application/json'); response.end(await readFile(join(componentRoot, 'public', request.url))); }
      else { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'); }
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const browser = await chromium.launch({ executablePath: process.env.ET_CHROMIUM_PATH || undefined, headless: true, args: ['--no-sandbox'] });
  context.after(() => browser.close());
  const page = await browser.newPage(); page.setDefaultTimeout(7000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  if (unsupported) {
    const editor = page.getByRole('dialog', { name: '编辑网络', exact: true });
    await editor.waitFor();
    await editor.getByRole('tab', { name: '节点参数', exact: true }).click();
    await editor.locator('.node-parameters').waitFor();
    assert.equal(await editor.getByRole('combobox', { name: '上联网卡选择', exact: true }).count(), 0);
    assert.equal(await editor.getByRole('textbox', { name: '允许使用的接口', exact: true }).count(), 0);
    assert.equal(await editor.getByRole('checkbox', { name: '绑定网络接口', exact: true }).count(), 0);
    const save = editor.getByRole('button', { name: '保存', exact: true });
    assert.equal(await save.isEnabled(), true);
    await save.click();
    await page.waitForFunction(() => window.__UPLINK_CAPTURE__?.length === 2);
    const captured = await page.evaluate(() => window.__UPLINK_CAPTURE__);
    for (const config of captured) { assert.equal(config.uplink, undefined); assert.equal(config.bind_device, false); assert.equal(config.network_name, 'Mobile fixture'); }
    assert.deepEqual(await page.evaluate(() => window.__UPLINK_ORIGINAL__.uplink), { mode: 'manual', interfaces: ['eth0'] });
    assert.deepEqual(errors, []);
    return;
  }
  const selector = page.getByRole('combobox', { name: '上联网卡选择', exact: true });
  await selector.waitFor();
  assert.equal(await selector.inputValue(), 'auto');
  const trigger = page.getByRole('button', { name: /^允许使用的接口/ });
  assert.equal(await trigger.count(), 0);
  await selector.selectOption('manual');
  await trigger.waitFor();
  assert.equal(await page.locator('#save').isDisabled(), true);
  await trigger.click();
  const popup = page.getByRole('dialog', { name: '允许使用的接口', exact: true });
  await popup.getByRole('checkbox', { name: 'Ethernet 2', exact: true }).waitFor();
  assert.equal(await popup.getByRole('checkbox', { name: 'lo', exact: true }).isDisabled(), true);
  assert.equal(await popup.getByRole('checkbox', { name: '备用网卡', exact: true }).isEnabled(), true);
  assert.equal(await popup.getByRole('checkbox', { name: 'wg0', exact: true }).isEnabled(), true);
  assert.ok((await popup.textContent()).includes('2001:db8:7::46/64'));
  await popup.getByRole('checkbox', { name: 'eth0', exact: true }).check();
  await popup.getByRole('checkbox', { name: 'Ethernet 2', exact: true }).check();
  await page.waitForFunction(() => !document.getElementById('save').disabled);
  const snapshot = async () => JSON.parse(await page.locator('#value').textContent());
  assert.deepEqual((await snapshot()).uplink, { mode: 'manual', interfaces: ['eth0', 'Ethernet 2'] });
  const refresh = popup.getByRole('button', { name: '刷新网卡列表', exact: true });
  await page.evaluate(() => { window.__INVENTORY__={interfaces:[{name:'eth0',addresses:['10.7.0.99/24'],kind:'ethernet',selectable:true,up:true},{name:'new0',addresses:['10.0.0.2/24'],kind:'ethernet',selectable:true,up:true}]}; });
  await refresh.click();
  await popup.getByText('已失联', { exact: true }).waitFor();
  assert.ok((await popup.textContent()).includes('10.7.0.99/24'));
  assert.deepEqual((await snapshot()).uplink.interfaces, ['eth0','Ethernet 2']);
  await page.evaluate(() => { window.__FAILURE__='offline'; });
  await refresh.click();
  await popup.getByText('节点离线', { exact: true }).waitFor();
  assert.equal(await popup.getByRole('checkbox', { name: 'new0', exact: true }).isDisabled(), true);
  assert.deepEqual((await snapshot()).uplink.interfaces, ['eth0','Ethernet 2']);
  for (const [failure,message] of [['unsupported','节点版本不支持网卡查询'],['failed','网卡查询失败']]) {
    await page.evaluate(failure => { window.__FAILURE__=failure; }, failure);
    await refresh.click(); await popup.getByText(message, { exact:true }).waitFor();
    assert.deepEqual((await snapshot()).uplink.interfaces,['eth0','Ethernet 2']);
  }
  await popup.getByRole('checkbox', { name: 'Ethernet 2', exact: true }).click({noWaitAfter:true});
  assert.deepEqual((await snapshot()).uplink.interfaces,['eth0']);
  await page.evaluate(() => { window.__FAILURE__=undefined; });
  await refresh.click(); await popup.getByText('2 个接口', { exact: true }).waitFor();
  await popup.getByRole('checkbox', { name: 'new0', exact: true }).check();
  await page.keyboard.press('Escape'); assert.equal(await popup.count(),0);
  assert.equal(await trigger.evaluate(element => element===document.activeElement),true);
  await trigger.click();
  await page.locator('legend').first().click(); assert.equal(await popup.count(),0);
  await trigger.click();
  const proof = resolve(root,'../runtime/uplink-inventory-ui'); await mkdir(proof,{recursive:true});
  await page.screenshot({path:join(proof,`${target}-manual.png`),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:join(proof,`${target}-manual-mobile-width.png`),fullPage:true});
  await page.setViewportSize({width:1280,height:900});
  await page.keyboard.press('Escape');
  await selector.selectOption('auto');
  await page.waitForFunction(() => !document.getElementById('save').disabled);
  assert.deepEqual(await snapshot(), { mtu: 1280, uplink: { mode: 'auto', interfaces: [] } });
  assert.equal(await trigger.count(),0);
  await page.evaluate(() => { window.__DEFER__=true; });
  await selector.selectOption('manual'); await page.waitForFunction(()=>typeof window.__RESOLVE__==='function');
  await selector.selectOption('auto');
  await page.evaluate(() => { window.__DEFER__=false; });
  await selector.selectOption('manual'); await trigger.click();
  await popup.getByRole('checkbox',{name:'new0',exact:true}).waitFor();
  await page.evaluate(() => window.__RESOLVE__({interfaces:[{name:'wrong-target',addresses:[],kind:'ethernet',selectable:true}]}));
  assert.equal(await popup.getByRole('checkbox',{name:'wrong-target',exact:true}).count(),0);
  await page.keyboard.press('Escape');
  await selector.selectOption('auto');
  await page.evaluate(() => { window.__FAILURE__='unsupported'; });
  await page.locator('#saved-config').click(); await trigger.click();
  await popup.getByText('节点版本不支持网卡查询',{exact:true}).waitFor();
  assert.equal(await popup.getByRole('checkbox',{name:'old adapter',exact:true}).isChecked(),true);
  assert.equal(await popup.getByText('未验证',{exact:true}).count(),1);
  assert.equal(await popup.getByText('已失联',{exact:true}).count(),0);
  assert.deepEqual((await snapshot()).uplink.interfaces,['old adapter']);
  await popup.getByRole('checkbox',{name:'old adapter',exact:true}).click({noWaitAfter:true});
  assert.deepEqual((await snapshot()).uplink.interfaces,[]);
  assert.equal(await page.locator('#save').isDisabled(),true);
  assert.deepEqual(errors, []);
});
