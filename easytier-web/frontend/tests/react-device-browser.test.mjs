#!/usr/bin/env node
// Explicit, real localhost browser/API/Core validation. No mocked requests,
// screenshots, traces, response-body logs or production endpoints.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const argument = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
if (!args.includes('--run')) {
  console.log('Read-only preparation: pass --run to test the authorized localhost preview; credentials come from --state (private JSON).');
  process.exit(0);
}
const deviceUi = JSON.parse(await readFile(new URL('../public/locales/zh-CN/devices.json', import.meta.url), 'utf8'));
const nodeFields = JSON.parse(await readFile(new URL('../public/locales/zh-CN/node-config.json', import.meta.url), 'utf8')).fields;
const base = new URL(argument('--base', process.env.ET_REACT_BROWSER_URL || 'http://127.0.0.1:5188'));
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Only a loopback preview may be tested');
assert.equal(base.protocol, 'http:', 'Use the local HTTP preview');
assert.ok(!base.username && !base.password && !base.search && !base.hash, 'The preview URL must not include credentials');
const statePath = resolve(argument('--state', resolve(workspace, 'runtime/private/state.json')));
const proofPath = resolve(argument('--proof', resolve(workspace, 'evidence/react-device-browser-proof.json')));
const stateStat = await stat(statePath);
assert.equal(stateStat.mode & 0o077, 0, 'The account fixture must be private');
const state = JSON.parse(await readFile(statePath, 'utf8'));
assert.ok(typeof state.username === 'string' && typeof state.password === 'string');
const deviceId = state.tokens?.[0]?.device_id;
const centralId = state.network_id;
const uuidPattern = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
assert.ok(uuidPattern.test(deviceId) && uuidPattern.test(centralId), 'Invalid local fixture identities');
const fixtureName = `react-device-qa-${Date.now()}`;
const checks = [], apiStatuses = [], fatalErrors = [], forbiddenWrites = [], externalRequests = [];
const proof = { status: 'RUNNING', scope: 'Real React browser / existing localhost Web API / actual native Core; no TUN or production', checks, fixture_device_id: deviceId, central_instance_id: centralId, ordinary_instance_name: fixtureName,
  screenshots_saved: false, traces_saved: false, credentials_recorded: false, requests_mocked: false, production_touched: false };
const field = (value, key) => value?.[key] ?? value?.[key.replace(/_([a-z])/g, (_, char) => char.toUpperCase())];
function uuid(value) {
  if (typeof value === 'string') return value.toLowerCase();
  const hex = [1, 2, 3, 4].map(part => (Number(field(value, `part${part}`) ?? 0) >>> 0).toString(16).padStart(8, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const classify = pathname => pathname.endsWith('/auth/login') ? 'login' : pathname.endsWith('/parse-config') ? 'parse-config' : pathname.endsWith('/generate-config') ? 'generate-config' : pathname.endsWith('/validate-config') ? 'validate-config' : pathname.endsWith('/proxy-rpc') ? 'runtime-rpc' : pathname.includes('/networks/config/') ? 'instance-config' : pathname.includes('/networks/metas') ? 'instance-metas' : pathname.includes('/networks') ? 'networks' : 'other';
const beforeInterfaces = (await readdir('/sys/class/net')).sort();
let browser, context, page, ownId, created = false, authenticated = false, stage = 'startup';
async function step(name, action) { stage = name; const time = Date.now(); await action(); checks.push({ name, status: 'PASS', elapsed_ms: Date.now() - time }); console.log(`PASS ${name}`); }
async function api(path, method = 'GET', data) {
  const response = await context.request.fetch(`${base.origin}/api/v1/${path}`, { method, ...(data === undefined ? {} : { data }), timeout: 20000 });
  assert.ok(response.ok(), `Local API HTTP ${response.status()}`);
  const text = await response.text();
  try { return JSON.parse(text); } catch { return text; }
}
async function waitUntil(check, timeout = 25000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await check()) return; await new Promise(done => setTimeout(done, 200)); } throw new Error('state-timeout'); }
async function listIds() { const result = await api(`machines/${deviceId}/networks`); return { running: (result.running_inst_ids ?? []).map(uuid), stopped: (result.disabled_inst_ids ?? []).map(uuid) }; }
async function waitResponse(method, suffix, action) { const response = page.waitForResponse(item => item.request().method() === method && new URL(item.url()).pathname.endsWith(suffix), { timeout: 25000 }); await action(); const result = await response; assert.ok(result.ok(), `Browser API HTTP ${result.status()}`); return result; }
function setFlags(text) {
  const lines = text.split('\n');
  let start = lines.findIndex(line => /^\[flags\]\s*$/.test(line));
  if (start < 0) { start = lines.length; lines.push('', '[flags]'); start++; }
  let end = lines.findIndex((line, index) => index > start && /^\[/.test(line));
  if (end < 0) end = lines.length;
  const values = { no_tun: true, disable_upnp: true, bind_device: false, disable_p2p: true, disable_udp_hole_punching: true, disable_tcp_hole_punching: true, multi_thread: false };
  for (const [key, value] of Object.entries(values)) {
    const index = lines.findIndex((line, index) => index > start && index < end && new RegExp(`^${key}\\s*=`).test(line));
    if (index >= 0) lines[index] = `${key} = ${value}`;
    else { lines.splice(end, 0, `${key} = ${value}`); end++; }
  }
  return lines.join('\n');
}
const row = id => page.locator('tr').filter({ has: page.locator('.entity-secondary', { hasText: id }) });
const dialog = () => page.getByRole('dialog');
async function assertSafety(config) {
  assert.equal(field(config, 'no_tun'), true);
  assert.equal(field(config, 'disable_upnp'), true);
  assert.equal(field(config, 'disable_p2p'), true);
  assert.equal(field(config, 'bind_device') ?? false, false);
  assert.equal((field(config, 'listener_urls') ?? []).length, 0);
  assert.equal((field(config, 'peer_urls') ?? []).length, 0);
  assert.equal((field(config, 'peers') ?? []).length, 0);
}
try {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: false });
  await context.route('**/*', async route => {
    if (new URL(route.request().url()).origin === base.origin) return route.continue();
    externalRequests.push({ kind: 'blocked-external-request' }); return route.abort();
  });
  page = await context.newPage();
  page.on('pageerror', () => fatalErrors.push({ kind: 'browser-javascript-error' }));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin !== base.origin || !url.pathname.startsWith('/api/v1/')) return;
    if (['GET', 'HEAD'].includes(request.method())) return;
    const path = url.pathname;
    const seedMutation = path.includes(`/networks/${centralId}`) && !path.endsWith('/proxy-rpc')
      || path.includes('/device-access-tokens') || path.includes('/alias')
      || request.method() === 'DELETE' && path === `/api/v1/machines/${deviceId}`;
    if (seedMutation) forbiddenWrites.push({ kind: 'forbidden-seed-mutation', method: request.method() });
  });
  page.on('response', response => { const path = new URL(response.url()).pathname; if (path.startsWith('/api/v1/')) apiStatuses.push({ kind: classify(path), method: response.request().method(), status: response.status() }); });
  await step('actual browser login to the localhost console', async () => {
    await page.goto(`${base.origin}/#/auth`, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('用户名', { exact: true }).fill(state.username);
    await page.getByLabel('密码', { exact: true }).fill(state.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('button', { name: '账户菜单', exact: true }).waitFor(); authenticated = true;
  });
  await step('central managed instance exposes no ordinary edit stop or delete', async () => {
    await page.goto(`${base.origin}/#/h/deviceList/device/${deviceId}/${centralId}`);
    await row(centralId).getByText('中央网络', { exact: false }).waitFor();
    const target = row(centralId);
    assert.ok(await target.getByRole('button', { name: /^编辑 / }).isDisabled());
    assert.ok(await target.getByRole('button', { name: '停用实例', exact: true }).isDisabled());
    assert.ok(await target.getByRole('button', { name: '删除实例', exact: true }).isDisabled());
    assert.ok(await page.getByRole('link', { name: '前往中央网络管理' }).isVisible());
  });
  await step('new ordinary instance form preserves multiline input and generates safe TOML', async () => {
    await page.getByRole('button', { name: '新建实例', exact: true }).first().click();
    await dialog().getByRole('tab', { name: deviceUi.editor.sections.basic, exact: true }).waitFor();
    await dialog().getByLabel(deviceUi.editor.networkName, { exact: true }).fill(fixtureName);
    await dialog().getByLabel(deviceUi.labels.hostname, { exact: true }).fill('React QA instance');
    await dialog().getByLabel(deviceUi.editor.dhcp, { exact: true }).uncheck();
    await dialog().getByLabel(/^虚拟 IPv4/).fill('10.246.253.2');
    const peers = dialog().getByLabel(deviceUi.editor.peers, { exact: true });
    await peers.fill('tcp://127.0.0.1:1'); await peers.press('End'); await peers.press('Enter');
    assert.equal(await peers.inputValue(), 'tcp://127.0.0.1:1\n'); await peers.fill('');
    await dialog().getByRole('tab', { name: deviceUi.editor.sections.advanced, exact: true }).click();
    await dialog().getByLabel(nodeFields.no_tun, { exact: true }).check();
    const listeners = dialog().getByLabel(nodeFields.listener_urls, { exact: true });
    await listeners.fill('tcp://127.0.0.1:0'); await listeners.press('End'); await listeners.press('Enter');
    assert.equal(await listeners.inputValue(), 'tcp://127.0.0.1:0\n'); await listeners.fill('');
    await waitResponse('POST', '/generate-config', () => dialog().getByRole('tab', { name: deviceUi.editor.sections.toml, exact: true }).click());
    const editor = dialog().getByLabel(deviceUi.editor.toml, { exact: true });
    await editor.waitFor();
    let text = await editor.inputValue(); ownId = /^instance_id\s*=\s*"([a-f\d-]+)"/mi.exec(text)?.[1];
    assert.ok(uuidPattern.test(ownId)); assert.notEqual(ownId, centralId);
    const baseline = await listIds(); assert.ok(![...baseline.running, ...baseline.stopped].includes(ownId));
    text = setFlags(text); await editor.fill(text); proof.ordinary_instance_id = ownId;
  });
  await step('TOML UUID mismatch is rejected before any write', async () => {
    const editor = dialog().getByLabel(deviceUi.editor.toml, { exact: true }); const valid = await editor.inputValue();
    await editor.fill(valid.replace(ownId, randomUUID()));
    await waitResponse('POST', '/parse-config', () => dialog().getByRole('button', { name: deviceUi.editor.validate, exact: true }).click());
    await dialog().getByText(deviceUi.editor.wrongId, { exact: true }).waitFor();
    assert.ok(!(await listIds()).running.includes(ownId)); await editor.fill(valid);
  });
  await step('TOML parses and passes real native configuration validation', async () => {
    await waitResponse('POST', `/machines/${deviceId}/validate-config`, () => dialog().getByRole('button', { name: deviceUi.editor.validate, exact: true }).click());
    await dialog().getByText(deviceUi.editor.validated, { exact: true }).waitFor();
  });
  await step('save only persists one stopped ordinary instance', async () => {
    await waitResponse('PUT', `/machines/${deviceId}/networks/config/${ownId}`, () => dialog().getByRole('button', { name: deviceUi.editor.save, exact: true }).click());
    created = true; await dialog().waitFor({ state: 'hidden' });
    await waitUntil(async () => { const ids = await listIds(); return ids.stopped.includes(ownId) && !ids.running.includes(ownId); });
    await row(ownId).getByText('已停止', { exact: true }).waitFor();
    const config = await api(`machines/${deviceId}/networks/config/${ownId}`); await assertSafety(config);
    assert.equal(field(config, 'instance_id'), ownId); assert.equal(field(config, 'network_name'), fixtureName);
  });
  await step('saved TOML opens and save-and-run starts the same UUID', async () => {
    await waitResponse('GET', `/machines/${deviceId}/networks/config/${ownId}`, () => row(ownId).getByRole('button', { name: /^编辑 / }).click());
    const basic = dialog().getByRole('tab', { name: deviceUi.editor.sections.basic, exact: true });
    await basic.waitFor(); assert.equal(await basic.getAttribute('aria-selected'), 'true');
    assert.equal(await dialog().getByLabel(deviceUi.editor.toml, { exact: true }).count(), 0);
    await waitResponse('POST', '/generate-config', () => dialog().getByRole('tab', { name: deviceUi.editor.sections.toml, exact: true }).click());
    const savedEditor = dialog().getByLabel(deviceUi.editor.toml, { exact: true }); await savedEditor.waitFor();
    const savedId = /^instance_id\s*=\s*"([a-f\d-]+)"/mi.exec(await savedEditor.inputValue())?.[1];
    assert.equal(savedId, ownId, 'Opening saved TOML must retain the same instance ID');
    await waitResponse('POST', `/machines/${deviceId}/networks`, () => dialog().getByRole('button', { name: deviceUi.editor.saveRun, exact: true }).click());
    await dialog().waitFor({ state: 'hidden' });
    await waitUntil(async () => (await listIds()).running.includes(ownId));
    await row(ownId).getByText('运行中', { exact: true }).waitFor();
  });
  await step('running instance reports actual node identity and safe native flags', async () => {
    await page.getByRole('tab', { name: '运行信息', exact: true }).click();
    await page.getByRole('heading', { name: '实例运行信息', exact: true }).waitFor();
    await page.getByText('React QA instance', { exact: true }).waitFor();
    const config = await api(`machines/${deviceId}/networks/config/${ownId}`); await assertSafety(config);
    const info = await api(`machines/${deviceId}/proxy-rpc`, 'POST', { service_name: 'api.instance.PeerManageRpcService', method_name: 'show_node_info', payload: { instance: { id: Object.fromEntries([0, 1, 2, 3].map(index => [`part${index + 1}`, parseInt(ownId.replaceAll('-', '').slice(index * 8, index * 8 + 8), 16)])) } } });
    assert.ok(Number(field(field(info, 'node_info'), 'peer_id')) > 0);
    proof.ordinary_peer_id = field(field(info, 'node_info'), 'peer_id');
  });
  await step('resource tab reads actual stats scoped to the ordinary UUID', async () => {
    await waitResponse('POST', `/machines/${deviceId}/proxy-rpc`, () => page.getByRole('tab', { name: '资源与流量', exact: true }).click());
    await page.getByRole('heading', { name: '资源与流量', exact: true }).waitFor();
    await page.getByText('全部实时指标', { exact: false }).waitFor();
    await waitUntil(async () => /全部实时指标 \([1-9]\d*\)/.test(await page.getByText('全部实时指标', { exact: false }).innerText()));
    assert.ok(!await page.getByText('设备离线', { exact: true }).count());
  });
  await step('routes peers ACL and logger tabs use real read-only RPC', async () => {
    for (const [tab, heading] of [['连接节点', '节点连接'], ['路由表', '路由表'], ['访问规则', '访问规则计数'], ['日志级别', '设备日志级别']]) {
      await waitResponse('POST', `/machines/${deviceId}/proxy-rpc`, () => page.getByRole('tab', { name: tab, exact: true }).click());
      await page.getByRole('heading', { name: heading, exact: true }).waitFor();
    }
  });
  await step('running TOML is explicitly shown read-only and can be hidden', async () => {
    await page.getByRole('tab', { name: '运行配置', exact: true }).click();
    await waitResponse('POST', `/machines/${deviceId}/proxy-rpc`, () => page.getByRole('button', { name: '显示只读 TOML', exact: true }).click());
    const input = page.getByLabel(/^当前运行 TOML/);
    assert.ok(await input.evaluate(element => element.readOnly));
    const text = await input.inputValue(); assert.match(text, /no_tun\s*=\s*true/); assert.match(text, /disable_upnp\s*=\s*true/);
    proof.ordinary_running_toml_sha256 = createHash('sha256').update(text).digest('hex');
    await page.getByRole('button', { name: '隐藏配置', exact: true }).click(); await input.waitFor({ state: 'hidden' });
  });
  await step('stop retains the saved UUID while removing its runtime', async () => {
    await row(ownId).getByRole('button', { name: '停用实例', exact: true }).click();
    await waitResponse('PUT', `/machines/${deviceId}/networks/${ownId}`, () => dialog().getByRole('button', { name: '确认停用', exact: true }).click());
    await dialog().waitFor({ state: 'hidden' });
    await waitUntil(async () => { const ids = await listIds(); return !ids.running.includes(ownId) && ids.stopped.includes(ownId); });
    await row(ownId).getByText('已停止', { exact: true }).waitFor();
  });
  await step('start reuses the same saved configuration and UUID', async () => {
    await row(ownId).getByRole('button', { name: '启动实例', exact: true }).click();
    await waitResponse('PUT', `/machines/${deviceId}/networks/${ownId}`, () => dialog().getByRole('button', { name: '确认启动', exact: true }).click());
    await dialog().waitFor({ state: 'hidden' }); await waitUntil(async () => (await listIds()).running.includes(ownId));
    await row(ownId).getByText('运行中', { exact: true }).waitFor();
    await assertSafety(await api(`machines/${deviceId}/networks/config/${ownId}`));
  });
  await step('delete removes only the owned ordinary instance and saved row', async () => {
    await row(ownId).getByRole('button', { name: '删除实例', exact: true }).click();
    await waitResponse('DELETE', `/machines/${deviceId}/networks/${ownId}`, () => dialog().getByRole('button', { name: '确认删除', exact: true }).click());
    await dialog().waitFor({ state: 'hidden' }); await waitUntil(async () => { const ids = await listIds(); return ![...ids.running, ...ids.stopped].includes(ownId); });
    await row(ownId).waitFor({ state: 'hidden' }); created = false;
    assert.ok((await listIds()).running.includes(centralId));
  });
  await step('no fatal JavaScript errors or seed mutations occurred', async () => {
    assert.equal(fatalErrors.length, 0); assert.equal(forbiddenWrites.length, 0); assert.equal(externalRequests.length, 0);
    assert.deepEqual((await readdir('/sys/class/net')).sort(), beforeInterfaces);
  });
} catch (failure) {
  proof.failure = { stage, kind: 'assertion-or-browser-api-failure', error_type: ['TimeoutError', 'AssertionError', 'Error'].includes(failure?.name) ? failure.name : 'other' };
  checks.push({ name: stage, status: 'FAIL' });
} finally {
  const cleanup = { ordinary_instance_absent: !ownId, own_session_logged_out: !authenticated, browser_closed: false, context_closed: false, no_screenshots_or_traces: true };
  if (context && ownId) {
    try {
      const ids = await listIds();
      if ([...ids.running, ...ids.stopped].includes(ownId)) {
        // ownId is freshly generated and verified absent before this test;
        // this is the sole permitted cleanup mutation, even after UI failure.
        const response = await context.request.delete(`${base.origin}/api/v1/machines/${deviceId}/networks/${ownId}`);
        assert.ok(response.ok());
      }
      await waitUntil(async () => { const ids = await listIds(); return ![...ids.running, ...ids.stopped].includes(ownId); });
      cleanup.ordinary_instance_absent = true;
    } catch { cleanup.ordinary_instance_absent = false; }
  }
  if (page && authenticated) {
    try { await page.keyboard.press('Escape'); } catch { /* no input is persisted */ }
    try { await page.getByRole('button', { name: '账户菜单', exact: true }).click(); await page.getByRole('button', { name: '退出登录', exact: true }).click(); await page.getByRole('button', { name: '登录', exact: true }).waitFor(); cleanup.own_session_logged_out = true; }
    catch { try { const response = await context.request.get(`${base.origin}/api/v1/auth/logout`); cleanup.own_session_logged_out = response.ok(); } catch { /* fixed cleanup status below */ } }
  }
  if (context) { try { await context.close(); cleanup.context_closed = true; } catch { /* status only */ } }
  if (browser) { try { await browser.close(); cleanup.browser_closed = true; } catch { /* status only */ } }
  proof.cleanup = cleanup;
  proof.host_interfaces_unchanged = JSON.stringify((await readdir('/sys/class/net')).sort()) === JSON.stringify(beforeInterfaces);
  proof.browser_javascript_errors = fatalErrors.length;
  proof.external_requests_blocked = externalRequests.length;
  proof.seed_mutation_requests = forbiddenWrites.length;
  proof.api_status_counts = Object.entries(apiStatuses.reduce((counts, item) => { const key = `${item.kind}:${item.method}:${item.status}`; counts[key] = (counts[key] ?? 0) + 1; return counts; }, {})).map(([kind, count]) => ({ kind, count }));
  proof.status = !proof.failure && Object.values(cleanup).every(Boolean) && proof.host_interfaces_unchanged ? 'PASS' : 'FAIL';
  await mkdir(dirname(proofPath), { recursive: true }); await writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ status: proof.status, checks_passed: checks.filter(check => check.status === 'PASS').length, checks_failed: checks.filter(check => check.status === 'FAIL').length, failed_stage: proof.failure?.stage, proof: proofPath }));
  process.exitCode = proof.status === 'PASS' ? 0 : 1;
}
