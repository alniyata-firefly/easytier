import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { installMockTauri } from './mock-tauri.mjs';

const base = process.env.ET_GUI_QA_URL || 'http://127.0.0.1:19420';
const routeFixture = {
  running: true,
  routes: [
    { peer_id: 2, hostname: 'No subnet peer', next_hop_peer_id: 2, cost: 1 },
    { peer_id: 3, hostname: 'Subnet peer', next_hop_peer_id: 2, cost: 2,
      ipv4_addr: { address: { addr: 174325763 }, network_length: 24 },
      proxy_cidrs: ['10.50.0.0/24', 'fd00:50::/64'] },
    { peer_id: 4, hostname: 'Unknown hop peer', next_hop_peer_id: 2633692368, cost: 3 },
    { peer_id: 5, hostname: 'Unspecified hop peer' },
  ],
  // Real protobuf JSON may omit the route message, conns and stats messages.
  peers: [{ peer_id: 2 }, { peer_id: 3, conns: [{ conn_id: 'no-nested-messages' }] }],
  peer_route_pairs: [{}, { route: { peer_id: 2, hostname: 'No subnet peer' } },
    { route: { peer_id: 3, hostname: 'Subnet peer' }, peer: { peer_id: 3 } }],
};
for (const scenario of [
  { name: 'omitted fields and real prefixes', fixture: routeFixture, rows: 4 },
  { name: 'omitted empty route list', fixture: { running: true }, rows: 0 },
]) test(`routes click with protobuf JSON: ${scenario.name}`, async () => {
  const browser = await chromium.launch({ executablePath: process.env.ET_CHROMIUM_PATH || undefined, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext(), page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(installMockTauri, { platform: 'windows' });
  await page.addInitScript(fixture => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => command === 'collect_network_info'
      ? { info: { map: { [args.instanceId]: fixture } } } : invoke(command, args);
  }, scenario.fixture);
  try {
    await page.goto(base);
    await page.getByRole('heading', { name: 'Local lab', exact: true }).waitFor();
    const routes = page.getByRole('tab', { name: '路由', exact: true });
    await routes.click();
    await page.getByRole('columnheader', { name: '下一跳', exact: true }).waitFor({ timeout: 5000 });
    assert.equal(await page.locator('table tbody tr').count(), scenario.rows);
    if (scenario.rows) {
      const cells = name => page.locator('table tbody tr').filter({ has: page.locator('td:first-child', { hasText: new RegExp(`^${name}$`) }) }).getByRole('cell').allTextContents();
      assert.deepEqual(await cells('No subnet peer'), ['No subnet peer', '—', 'No subnet peer', '1', '—']);
      assert.deepEqual(await cells('Subnet peer'), ['Subnet peer', '10.100.0.3/24', 'No subnet peer', '2', '10.50.0.0/24, fd00:50::/64']);
      assert.deepEqual(await cells('Unknown hop peer'), ['Unknown hop peer', '—', '2633692368', '3', '—']);
      assert.deepEqual(await cells('Unspecified hop peer'), ['Unspecified hop peer', '—', '—', '0', '—']);
    }
    await page.getByRole('tab', { name: '连接', exact: true }).click();
    await page.getByRole('columnheader', { name: '协议', exact: true }).first().waitFor();
    await page.getByRole('tab', { name: '事件', exact: true }).click();
    await page.getByRole('heading', { name: '暂无数据', exact: true }).waitFor();
    await page.getByRole('tab', { name: '状态', exact: true }).click();
    assert.equal(await page.getByRole('heading', { name: 'Local lab', exact: true }).count(), 1);
    assert.equal(await page.locator('.detail-list').getByText('undefined', { exact: true }).count(), 0);
    assert.deepEqual(errors, []);
  } catch (error) {
    if (errors.length) throw new Error(`${error.message}\nBrowser errors: ${errors.join('; ')}`, { cause: error });
    throw error;
  } finally { await context.close(); await browser.close(); }
});
