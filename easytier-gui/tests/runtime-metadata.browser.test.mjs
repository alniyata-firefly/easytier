import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { installMockTauri } from './mock-tauri.mjs';

const base = process.env.ET_GUI_QA_URL || 'http://127.0.0.1:19420';
for (const scenario of [
  { mode: { mode: 'normal' }, heading: 'Local lab' },
  { mode: { mode: 'service', config_dir: '/mock/config', rpc_portal: '127.0.0.1:15999', file_log_level: 'info', file_log_dir: '/mock/logs' }, heading: 'Local lab' },
  { mode: { mode: 'remote', remote_rpc_address: 'tcp://192.0.2.44:15999' }, heading: 'Remote core only' },
]) test(`metadata permissions through ${scenario.mode.mode} GUI RPC entry`, async () => {
  const browser = await chromium.launch({ executablePath: process.env.ET_CHROMIUM_PATH || undefined, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext(), page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(installMockTauri, { platform: 'windows' });
  await page.addInitScript(mode => {
    localStorage.setItem('app_mode', JSON.stringify(mode));
    window.__MOCK_METADATA_CASE__ = 'omitted-zero';
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      const response = await invoke(command, args);
      if (command === 'collect_network_info') return { info: { map: { [args.instanceId]: {
        running: true, my_node_info: { stun_info: { udp_nat_type: 'FullCone', tcp_nat_type: 'Symmetric' } },
        routes: [{ peer_id: 6, hostname: 'Schema peer', next_hop_peer_id: 6 }],
        peer_route_pairs: [{}, { route: { peer_id: 6, hostname: 'Schema peer' }, peer: { peer_id: 6, conns: [{ conn_id: 'zero-loss' }] } }],
      } } } };
      if (command !== 'get_network_metas') return response;
      if (window.__MOCK_METADATA_CASE__ === 'missing-message') return { metas: {} };
      for (const meta of Object.values(response.metas)) {
        if (window.__MOCK_METADATA_CASE__ === 'explicit-three') meta.config_permission = 3;
        else if (meta.config_permission === 0) delete meta.config_permission;
      }
      return response;
    };
  }, scenario.mode);
  try {
    await page.goto(base);
    await page.getByRole('heading', { name: scenario.heading, exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '编辑网络', exact: true }).isEnabled(), true);
    assert.equal(await page.getByRole('button', { name: '删除', exact: true }).isEnabled(), true);
    await page.getByText('UDP FullCone / TCP Symmetric', { exact: true }).waitFor();
    await page.getByRole('tab', { name: '连接', exact: true }).click();
    await page.getByRole('cell', { name: '0%', exact: true }).waitFor();
    await page.getByRole('tab', { name: '路由', exact: true }).click();
    await page.getByRole('columnheader', { name: '下一跳', exact: true }).waitFor();
    assert.deepEqual(await page.locator('table tbody tr').getByRole('cell').allTextContents(), ['Schema peer', '—', 'Schema peer', '0', '—']);
    const calls = await page.evaluate(() => window.__MOCK_CALLS__);
    assert.ok(calls.some(call => call.command === 'init_rpc_connection' && call.args.isNormalMode === (scenario.mode.mode === 'normal')));
    assert.ok(calls.some(call => call.command === 'get_network_metas'));
    await page.evaluate(() => { window.__MOCK_METADATA_CASE__ = 'explicit-three'; });
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('button[aria-label="删除"]')?.disabled);
    assert.equal(await page.getByRole('button', { name: '编辑网络', exact: true }).isEnabled(), false);
    assert.equal(await page.getByRole('button', { name: '删除', exact: true }).isEnabled(), false);
    await page.evaluate(() => { window.__MOCK_METADATA_CASE__ = 'missing-message'; });
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.panel-heading h2')?.textContent?.includes('-'));
    assert.equal(await page.getByRole('button', { name: '编辑网络', exact: true }).isEnabled(), false);
    assert.equal(await page.getByRole('button', { name: '删除', exact: true }).isEnabled(), false);
    assert.deepEqual(errors, []);
  } finally { await context.close(); await browser.close(); }
});
