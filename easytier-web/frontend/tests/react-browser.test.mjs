// Opt-in browser tests against an isolated local preview only. Never run on production.
// Supply EASYTIER_TEST_STATE with a private {username,password} JSON fixture;
// credentials, response bodies, screenshots and traces are intentionally not recorded.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const enabled = process.env.EASYTIER_LOCAL_WRITE_TEST === '1';
const nodeFields = JSON.parse(await readFile(new URL('../public/locales/zh-CN/node-config.json', import.meta.url), 'utf8')).fields;
test('React network, membership, ACL, credentials and management-token workflows', { skip: !enabled, timeout: 240000 }, async () => {
  const base = process.env.EASYTIER_TEST_URL || 'http://127.0.0.1:5188';
  const origin = new URL(base);
  assert.ok(['127.0.0.1', 'localhost', '10.0.3.11'].includes(origin.hostname) && origin.port === '5188', 'Tests require the dedicated local preview origin');
  const state = JSON.parse(await readFile(process.env.EASYTIER_TEST_STATE, 'utf8'));
  const deviceId = process.env.EASYTIER_TEST_DEVICE_ID || 'c0660000-0000-4000-8000-000000000003';
  const tag = `browser-qa-${randomUUID().slice(0, 8)}`;
  const nodeControl = process.env.EASYTIER_TEST_NODE_CONTROL ? await import(pathToFileURL(process.env.EASYTIER_TEST_NODE_CONTROL).href) : undefined;
  const results = [], networks = new Set(), tokenIds = new Set();
  let stage = 'launch', browser, context, page;
  const checked = name => { results.push(name); stage = name; console.log(`PASS ${name}`); };
  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.setDefaultNavigationTimeout(15000);
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.name));
    const request = async (method, path, data) => {
      const response = await context.request.fetch(`${base}/api/v1/${path}`, { method, data });
      assert.ok(response.ok(), `Local verification request returned HTTP ${response.status()}`);
      return response.status() === 204 ? undefined : response.json().catch(() => undefined);
    };
    const dialog = () => page.getByRole('dialog').filter({ visible: true });
    const tab = name => page.getByRole('tab', { name: name === '成员' ? /^成员(?:\s*\d+)?$/ : name, exact: name !== '成员' }).click();
    const wait = async predicate => { await assert.doesNotReject(async () => { const end = Date.now() + 45000; while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 300)); } throw new Error('Local state did not converge'); }); };

    stage = 'login';
    await page.goto(base);
    await page.getByLabel('用户名', { exact: true }).fill(state.username);
    await page.getByLabel('密码', { exact: true }).fill(state.password);
    assert.equal(await page.getByLabel('密码', { exact: true }).getAttribute('type'), 'password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('navigation', { name: '当前位置' }).getByText('概览', { exact: true }).waitFor();
    checked('real login and password masking');
    const baselineTokens = await request('GET', 'device-access-tokens');
    const baselineTokenIds = baselineTokens.tokens.map(value => value.id).sort();
    const baselineMachines = await request('GET', 'machines');
    assert.ok(baselineMachines.machines.length >= 3, 'Three preview nodes must be registered');
    // The preview intentionally lacks network-admin privileges. Configure a new
    // managed instance while its fixture Core is offline, then start it with no-TUN.
    await nodeControl?.pause();

    stage = 'network create';
    await page.goto(`${base}/#/h/networks`);
    await page.getByRole('button', { name: '创建网络', exact: true }).first().click();
    await dialog().getByLabel('网络名称', { exact: true }).fill(tag);
    await dialog().getByLabel('虚拟 IPv4 网段', { exact: true }).fill('10.67.0.0/24');
    await dialog().getByLabel('组网方式', { exact: true }).selectOption('Standalone');
    await dialog().getByRole('checkbox', { name: /启用安全模式/ }).check();
    await dialog().getByRole('checkbox', { name: /优先使用 IPv6/ }).check();
    await dialog().getByRole('button', { name: '创建网络', exact: true }).click();
    await page.getByRole('navigation', { name: '当前位置' }).getByRole('link', { name: tag, exact: true }).waitFor();
    const networkId = decodeURIComponent(page.url().split('/networks/')[1]);
    networks.add(networkId);
    let network = await request('GET', `networks/${networkId}`);
    assert.equal(network.prefer_ipv6, true); assert.equal(network.secure_mode, true);
    checked('network create persists settings');

    stage = 'network edit';
    await tab('网络设置');
    await page.getByLabel('网络名称', { exact: true }).fill(`${tag}-edited`);
    await page.getByRole('checkbox', { name: /优先使用 IPv6/ }).uncheck();
    await page.getByRole('button', { name: '保存网络设置', exact: true }).click();
    await page.getByRole('navigation', { name: '当前位置' }).getByRole('link', { name: `${tag}-edited`, exact: true }).waitFor();
    network = await request('GET', `networks/${networkId}`);
    assert.equal(network.prefer_ipv6, false);
    checked('network edit roundtrip');

    stage = 'member add';
    await tab('成员');
    await page.getByRole('button', { name: '添加设备', exact: true }).first().click();
    await dialog().locator('.selection-row').filter({ hasText: deviceId }).getByRole('checkbox').check();
    await dialog().getByRole('button', { name: '加入 1 个设备', exact: true }).click();
    await wait(async () => (await request('GET', `networks/${networkId}/members`)).members.some(value => value.device_id === deviceId));
    checked('member persisted while fixture Core is offline');
    await page.locator('.member-row').getByRole('button', { name: '配置', exact: true }).click();
    await dialog().getByRole('tab', { name: '完整配置', exact: true }).click();
    const configField = dialog().getByLabel('成员覆盖配置 JSON', { exact: true });
    await configField.waitFor();
    const config = JSON.parse(await configField.inputValue());
    Object.assign(config, { no_tun: true, disable_upnp: true, multi_thread: false, disable_tcp_hole_punching: true, disable_udp_hole_punching: true, listener_urls: ['tcp://127.0.0.1:22233'], prefer_ipv6: true });
    await configField.fill(JSON.stringify(config, null, 2));
    await dialog().getByRole('button', { name: '保存当前页并下发', exact: true }).click();
    await wait(async () => (await dialog().count()) === 0);
    const initialOverride = await request('GET', `networks/${networkId}/members/${deviceId}/config`);
    assert.equal(initialOverride.no_tun, true);
    checked('member no-TUN override persisted before fixture restart');
    await nodeControl?.resume();
    stage = 'member fixture Core online and applied';
    await wait(async () => (await request('GET', `networks/${networkId}/members`)).members.some(value => value.device_id === deviceId && value.running && value.deployment?.state === 'applied'));
    checked('member add and real Core applied override');

    for (const [option, expected] of [['default', false], ['inherit', undefined], ['ipv6', true]]) {
      stage = `member IPv6 ${option}`;
      await page.locator('.member-row').getByRole('button', { name: '配置', exact: true }).click();
      await dialog().getByRole('tab', { name: '节点参数', exact: true }).click();
      await dialog().getByLabel(nodeFields.prefer_ipv6, { exact: true }).selectOption(option);
      const listeners = dialog().getByLabel(nodeFields.listener_urls, { exact: true });
      await listeners.fill('tcp://127.0.0.1:22233\ntcp://[::1]:22233');
      assert.ok((await listeners.inputValue()).includes('\n'));
      await dialog().getByRole('button', { name: '保存当前页并下发', exact: true }).click();
      await wait(async () => (await dialog().count()) === 0);
      const stored = await request('GET', `networks/${networkId}/members/${deviceId}/config`);
      const saved = stored.config ?? stored;
      assert.equal(saved.prefer_ipv6, expected); assert.equal(saved.disable_tcp_hole_punching, true);
      assert.equal(saved.listener_urls.length, 2);
    }
    checked('IPv6 inherit false true and multiline listeners preserve other fields');

    stage = 'ACL create and reorder';
    await tab('访问规则');
    for (const ruleName of [`${tag}-tcp`, `${tag}-icmp`]) {
      await page.getByRole('button', { name: '添加规则', exact: true }).first().click();
      await dialog().getByLabel('规则名称', { exact: true }).fill(ruleName);
      await dialog().getByLabel('协议 1', { exact: true }).selectOption(ruleName.endsWith('-tcp') ? 'tcp' : 'icmp');
      if (ruleName.endsWith('-tcp')) { await dialog().getByLabel('协议 1 端口或范围', { exact: true }).fill('443, 8000-8100'); await dialog().getByRole('checkbox', { name: '有状态匹配', exact: true }).check(); }
      await dialog().getByRole('button', { name: '保存到规则列表', exact: true }).click();
    }
    await page.getByRole('button', { name: `上移规则 ${tag}-icmp`, exact: true }).click();
    await page.locator('.acl-row').filter({ hasText: `${tag}-icmp` }).getByRole('button', { name: '禁用', exact: true }).click();
    await page.getByRole('button', { name: '保存并下发', exact: true }).click();
    await wait(async () => !await page.getByRole('button', { name: '保存并下发', exact: true }).isEnabled());
    const acl = (await request('GET', `networks/${networkId}/acl-policy`)).policy;
    assert.equal(acl.rules[0].name, `${tag}-icmp`); assert.equal(acl.rules[0].enabled, false);
    assert.equal(acl.rules[1].protocols[0].stateful, true);
    checked('ACL rules save order and disabled state via LAN HTTP');

    stage = 'network credential';
    await tab('入网凭据');
    await page.getByRole('button', { name: '生成凭据', exact: true }).first().click();
    await dialog().getByLabel('凭据名称', { exact: true }).fill(tag);
    await dialog().getByLabel('ACL 权限组', { exact: true }).fill('qa-read');
    await dialog().getByRole('button', { name: '生成凭据', exact: true }).click();
    await page.getByRole('dialog', { name: '节点加入命令', exact: true }).waitFor();
    await dialog().getByLabel('显示格式', { exact: true }).selectOption('toml');
    assert.ok((await dialog().locator('pre').textContent()).includes('[secure_mode]'));
    await dialog().getByRole('button', { name: '关闭弹窗', exact: true }).click();
    let credentialRow = page.locator('.credential-row').filter({ has: page.locator('strong', { hasText: tag }) });
    await credentialRow.getByRole('button', { name: '编辑', exact: true }).click();
    await dialog().getByLabel('ACL 权限组', { exact: true }).fill('qa-read, qa-more');
    await dialog().getByRole('button', { name: '保存凭据', exact: true }).click();
    await wait(async () => (await request('GET', `networks/${networkId}/credentials`)).credentials.some(value => value.credential_id === tag && value.acl_groups.includes('qa-more')));
    await credentialRow.getByRole('button', { name: '删除', exact: true }).click();
    await dialog().getByRole('button', { name: '确认删除', exact: true }).click();
    await wait(async () => !await credentialRow.count());
    checked('network credential create edit and physical delete');

    stage = 'member remove preserves registry and tokens';
    await tab('成员');
    await page.locator('.member-row').getByRole('button', { name: '移出', exact: true }).click();
    await dialog().getByRole('button', { name: '确认移出', exact: true }).click();
    await wait(async () => (await request('GET', `networks/${networkId}/members`)).members.length === 0);
    assert.equal((await request('GET', 'machines')).machines.length, baselineMachines.machines.length);
    assert.deepEqual((await request('GET', 'device-access-tokens')).tokens.map(value => value.id).sort(), baselineTokenIds);
    checked('network removal retains device management credentials');
    await tab('网络设置');
    await page.getByRole('button', { name: '删除此网络', exact: true }).click();
    await dialog().getByRole('button', { name: '确认删除网络', exact: true }).click();
    await page.getByRole('navigation', { name: '当前位置' }).getByRole('link', { name: '网络', exact: true }).waitFor();
    assert.ok(!(await request('GET', 'networks')).networks.some(value => value.network_id === networkId));
    networks.delete(networkId);
    checked('network delete through confirmation');

    stage = 'management token';
    await page.goto(`${base}/#/h/tokens`);
    await page.getByRole('button', { name: '签发令牌', exact: true }).first().click();
    await dialog().getByLabel('名称', { exact: true }).fill(tag);
    await dialog().getByRole('button', { name: '签发令牌', exact: true }).click();
    await page.getByRole('dialog', { name: '客户端接入', exact: true }).waitFor();
    const tokenList = (await request('GET', 'device-access-tokens')).tokens;
    const issued = tokenList.find(value => value.label === tag); assert.ok(issued); tokenIds.add(issued.id);
    const boxes = dialog().locator('.secret-box');
    assert.equal(await boxes.nth(1).textContent(), '•'.repeat(32));
    await dialog().getByRole('button', { name: '显示', exact: true }).click();
    const oldSecret = await boxes.nth(1).textContent(); assert.ok(oldSecret.length > 16);
    await dialog().getByRole('button', { name: '隐藏', exact: true }).click();
    await dialog().getByRole('button', { name: '复制服务器地址', exact: true }).click();
    await dialog().getByRole('button', { name: '关闭弹窗', exact: true }).click();
    const row = page.getByRole('row').filter({ hasText: tag });
    await row.getByRole('button', { name: '更换', exact: true }).click();
    await dialog().getByRole('button', { name: '更换令牌', exact: true }).click();
    await page.getByRole('dialog', { name: '客户端接入', exact: true }).waitFor();
    await dialog().getByRole('button', { name: '显示', exact: true }).click();
    assert.ok((await dialog().locator('.secret-box').nth(1).textContent()) !== oldSecret, 'Rotated token must be different');
    await dialog().getByRole('button', { name: '关闭弹窗', exact: true }).click();
    await row.getByRole('button', { name: '删除', exact: true }).click();
    await dialog().getByRole('button', { name: '删除令牌', exact: true }).click();
    await wait(async () => !await row.count());
    assert.deepEqual((await request('GET', 'device-access-tokens')).tokens.map(value => value.id).sort(), baselineTokenIds);
    tokenIds.delete(issued.id);
    assert.equal(await page.evaluate(() => {
      const locale = localStorage.getItem('easytier.locale');
      const allowedLocale = locale === null || locale === 'zh-CN' || locale === 'en';
      return allowedLocale && sessionStorage.length === 0
        && Object.keys(localStorage).every(key => key === 'easytier.locale');
    }), true, 'Only a supported locale preference may be stored; credentials must not persist');
    checked('token issue masked display copy rotate delete and no credential storage');
    assert.deepEqual(pageErrors, [], 'Browser must have no uncaught JavaScript errors');
    await page.getByRole('button', { name: '账户菜单', exact: true }).click();
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await page.getByRole('heading', { name: '登录控制台', exact: true }).waitFor();
    checked('logout invalidates local session');
  } catch (error) {
    const message = String(error.message).replaceAll(state.password, '[redacted]');
    throw new Error(`Browser verification failed at ${stage}: ${message}`);
  } finally {
    // Cleanup is limited to IDs created by this test. Never remove seeded networks or tokens.
    if (context) {
      for (const id of networks) await context.request.delete(`${base}/api/v1/networks/${id}`).catch(() => {});
      for (const id of tokenIds) await context.request.delete(`${base}/api/v1/device-access-tokens/${id}`).catch(() => {});
    }
    await context?.close(); await browser?.close();
    await nodeControl?.resume();
    if (process.env.EASYTIER_TEST_PROOF) await writeFile(process.env.EASYTIER_TEST_PROOF, JSON.stringify({ status: results.includes('logout invalidates local session') ? 'PASS' : 'INCOMPLETE', checked_at: new Date().toISOString(), scope: 'real Chromium and isolated local API/Core only; no production', checks: results }, null, 2), { mode: 0o600 });
  }
});
