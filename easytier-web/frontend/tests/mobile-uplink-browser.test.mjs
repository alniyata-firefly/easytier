import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve('vite'))('esbuild');
const output = process.env.ET_MOBILE_UPLINK_QA_OUTPUT || join(tmpdir(), 'easytier-web-mobile-uplink-qa');
const instanceId = '20000000-0000-4000-8000-000000000001';

test('Web member and instance editors gate by target OS and normalize mobile JSON/TOML saves', { timeout: 180000 }, async context => {
  const temporary = await mkdtemp(join(tmpdir(), 'et-web-mobile-uplink-'));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  await mkdir(output, { recursive: true });
  const fixture = `import React from 'react';import {createRoot} from 'react-dom/client';
    import {NetworkMembers} from './src/components/NetworkMembers';
    import {DevicePage} from './src/pages/DevicePage';
    import {NetworkTypes} from './src/lib/shared';
    import {NoticeProvider} from './src/components/ui';
    import {i18nReady} from './src/lib/i18n';
    const args=new URLSearchParams(location.search), targetOs=args.get('os'), entry=args.get('entry');
    const deviceId='10000000-0000-4000-8000-000000000001', instanceId=${JSON.stringify(instanceId)};
    const uuid=value=>{const hex=value.replaceAll('-','');return Object.fromEntries([1,2,3,4].map(part=>['part'+part,parseInt(hex.slice((part-1)*8,part*8),16)]));};
    const network={network_id:instanceId,display_name:'Fixture network',network_name:'fixture-net',networking_method:'Standalone',virtual_cidr:'10.80.0.0/24',secure_mode:false,member_count:1,network_secret:'synthetic-fixture-only',peer_urls:[]};
    const member={member_id:'30000000-0000-4000-8000-000000000001',device_id:deviceId,hostname:'Fixture target',hostname_override:null,virtual_ipv4:null,allocated_ipv4:'10.80.0.2',online:true,running:false,runtime_virtual_ipv4:null,version:'2.7.1',error_msg:null,has_override:true};
    const config={...NetworkTypes.DEFAULT_NETWORK_CONFIG(),instance_id:instanceId,network_name:'Fixture instance',network_secret:'synthetic-fixture-only',networking_method:NetworkTypes.NetworkingMethod.Standalone,mtu:1280,bind_device:true,uplink:{mode:'manual',interfaces:['eth0']},future_fixture:{keep:'initial'}};
    const machine={alias:'Fixture target',client_url:'udp://192.0.2.10:30000',online:true,info:{machine_id:uuid(deviceId),hostname:'Fixture target',easytier_version:'2.7.1',running_network_instances:[],...(targetOs==='unknown'?{}:{device_os:{os_type:targetOs}})},networks:[]};
    window.__CAPTURE__=[];window.__LIST_CALLS__=0;window.__INVENTORY_CALLS__=0;window.__PARSE_TEXT__=[];
    const capture=(kind,value)=>window.__CAPTURE__.push({kind,config:structuredClone(value)});
    const inventory=async()=>{window.__INVENTORY_CALLS__++;return {interfaces:[{name:'eth0',addresses:['192.0.2.10/24'],kind:'ethernet',up:true,selectable:true}]};};
    const remote={list_network_instance_ids:async()=>({running_inst_ids:[],disabled_inst_ids:[uuid(instanceId)]}),get_network_metas:async()=>({metas:{[instanceId]:{network_name:'Fixture instance',config_permission:0}}}),get_network_config:async()=>structuredClone(config),
      generate_config:async value=>{capture('generate',value);return {toml_config:'instance_id = "'+instanceId+'"\\nmtu = '+value.mtu+'\\n'+(value.uplink?'[uplink]\\nmode = "manual"\\ninterfaces = ["eth0"]\\n':'')};},
      parse_config:async text=>{window.__PARSE_TEXT__.push(text);return {config:{...structuredClone(config),mtu:1340,bind_device:true,uplink:{mode:'manual',interfaces:['eth0']},future_fixture:{keep:'toml'}}};},
      validate_config:async value=>capture('validate',value),save_config:async value=>capture('instance-save',value),run_network:async value=>capture('instance-run',value),get_network_interfaces:inventory};
    const api={clear_snapshots:()=>{},list_machines:async()=>{window.__LIST_CALLS__++;return [structuredClone(machine)];},get_member_config:async()=>structuredClone(config),set_member_config:async(networkId,memberId,value)=>capture('member-save',value),get_network_interfaces:inventory,get_remote_client:()=>remote,get_console_info:async()=>({webhook_auth:true}),list_networks:async()=>[]};
    i18nReady.then(()=>createRoot(document.getElementById('root')).render(<React.Suspense fallback="Loading"><NoticeProvider><main>{entry==='member'?<NetworkMembers api={api} network={network} members={[member]} temporaryPeers={[]} loading={false} onChanged={()=>{}} onObserve={()=>{}}/>:<DevicePage api={api} deviceId={deviceId}/>}</main></NoticeProvider></React.Suspense>));`;
  const outfile = join(temporary, 'fixture.js');
  await esbuild.build({ stdin: { contents: fixture, resolveDir: frontend, loader: 'tsx' }, outfile, bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', loader: { '.svg': 'dataurl' }, logLevel: 'silent' });
  const bundle = await readFile(outfile);
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      if (path === '/fixture.js') { response.setHeader('content-type', 'text/javascript'); response.end(bundle); }
      else if (path === '/style.css') { response.setHeader('content-type', 'text/css'); response.end(await readFile(join(frontend, 'src/style.css'))); }
      else if (path.startsWith('/locales/')) { response.setHeader('content-type', 'application/json'); response.end(await readFile(join(frontend, 'public', path))); }
      else { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'); }
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const browser = await chromium.launch({ executablePath: process.env.ET_CHROMIUM_PATH || undefined, headless: true, args: ['--no-sandbox'] });
  context.after(() => browser.close());
  const proof = { scope: 'Real React NetworkMembers/DevicePage through target list_machines metadata to editors and captured synthetic API/RPC payloads; no native Core or production access', cases: [] };
  context.after(() => writeFile(join(output, 'proof.json'), JSON.stringify(proof, null, 2)));
  for (const entry of ['member', 'instance']) for (const os of ['android', 'ios', 'windows', 'linux', 'unknown']) {
    const mobile = os === 'android' || os === 'ios';
    const page = await browser.newPage({ viewport: mobile ? { width: 1440, height: 1050 } : { width: 390, height: 844 } });
    const errors = [], failedRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('requestfailed', request => failedRequests.push(request.url()));
    page.setDefaultTimeout(10000);
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}/?entry=${entry}&os=${os}`);
      await page.waitForFunction(() => window.__LIST_CALLS__ > 0);
      const open = async () => {
        await page.getByRole('button', { name: entry === 'member' ? '配置' : '编辑 Fixture instance', exact: true }).click();
        const dialog = page.getByRole('dialog').filter({ has: page.getByRole('tab', { name: '节点参数', exact: true }) });
        await dialog.waitFor();
        await dialog.getByRole('tab', { name: '节点参数', exact: true }).click();
        await dialog.locator('.node-parameters').waitFor();
        return dialog;
      };
      let dialog = await open();
      assert.equal(await dialog.getByRole('combobox', { name: '上联网卡选择', exact: true }).count(), mobile ? 0 : 1, `${entry}/${os} selector`);
      assert.equal(await dialog.getByRole('checkbox', { name: '绑定网络接口', exact: true }).count(), mobile ? 0 : 1, `${entry}/${os} binding checkbox`);
      assert.equal(await dialog.getByRole('textbox', { name: '网络接口名称', exact: true }).count(), 1, 'TUN name remains configurable');
      if (!mobile) assert.equal(await dialog.getByRole('combobox', { name: '上联网卡选择', exact: true }).inputValue(), 'manual');
      const submit = () => dialog.getByRole('button', { name: entry === 'member' ? '保存当前页并下发' : '保存配置', exact: true }).click();
      await submit();
      const kind = entry === 'member' ? 'member-save' : 'instance-save';
      await page.waitForFunction(kind => window.__CAPTURE__.filter(row => row.kind === kind).length === 1, kind);
      const advanced = await page.evaluate(kind => window.__CAPTURE__.find(row => row.kind === kind).config, kind);
      assert.equal(advanced.mtu, 1280);
      assert.deepEqual(advanced.future_fixture, { keep: 'initial' });
      if (mobile) { assert.equal(advanced.uplink, undefined); assert.equal(advanced.bind_device, false); }
      else { assert.deepEqual(advanced.uplink, { mode: 'manual', interfaces: ['eth0'] }); assert.equal(advanced.bind_device, true); }
      dialog = await open();
      await dialog.getByRole('tab', { name: entry === 'member' ? '完整配置' : 'TOML', exact: true }).click();
      const raw = dialog.getByRole('textbox', { name: entry === 'member' ? '成员覆盖配置 JSON' : '实例 TOML', exact: true });
      if (entry === 'member') {
        const value = JSON.parse(await raw.inputValue());
        if (mobile) { assert.equal(value.uplink, undefined); assert.equal(value.bind_device, false); }
        await raw.fill(JSON.stringify({ ...value, mtu: 1340, bind_device: true, uplink: { mode: 'manual', interfaces: ['eth0'] }, future_fixture: { keep: 'json' } }));
      } else {
        if (mobile) assert.equal((await raw.inputValue()).includes('[uplink]'), false);
        await raw.fill(`instance_id = "${instanceId}"\nmtu = 1340\nbind_device = true\n[uplink]\nmode = "manual"\ninterfaces = ["eth0"]\n`);
      }
      await submit();
      await page.waitForFunction(kind => window.__CAPTURE__.filter(row => row.kind === kind).length === 2, kind);
      const imported = await page.evaluate(kind => window.__CAPTURE__.filter(row => row.kind === kind).at(-1).config, kind);
      assert.equal(imported.mtu, 1340);
      assert.deepEqual(imported.future_fixture, { keep: entry === 'member' ? 'json' : 'toml' });
      if (mobile) { assert.equal(imported.uplink, undefined); assert.equal(imported.bind_device, false); }
      else { assert.deepEqual(imported.uplink, { mode: 'manual', interfaces: ['eth0'] }); assert.equal(imported.bind_device, true); }
      if (entry === 'instance') assert.ok((await page.evaluate(() => window.__PARSE_TEXT__)).some(text => text.includes('[uplink]')));
      if (mobile) assert.equal(await page.evaluate(() => window.__INVENTORY_CALLS__), 0);
      assert.deepEqual(errors, []);
      assert.deepEqual(failedRequests, []);
      proof.cases.push({ entry, os, viewport: mobile ? 'desktop' : 'phone', source: entry === 'member' ? 'NetworkMembers snapshot' : 'DevicePage device info', advanced: 'PASS', import: entry === 'member' ? 'JSON PASS' : 'TOML PASS', preserved: ['mtu', 'future_fixture', 'dev_name control'], normalized: mobile, errors });
      await page.screenshot({ path: join(output, `${entry}-${os}.png`), fullPage: true });
    } catch (error) {
      proof.cases.push({ entry, os, status: 'FAIL', error: String(error), errors, failedRequests });
      await page.screenshot({ path: join(output, `${entry}-${os}-failed.png`), fullPage: true });
      throw error;
    } finally { await page.close(); }
  }
  proof.status = 'PASS';
  proof.case_count = proof.cases.length;
});
