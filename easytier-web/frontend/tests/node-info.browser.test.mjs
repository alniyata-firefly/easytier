// Synthetic protobuf fixtures in the real React UI. All API requests are intercepted;
// only static files from an explicitly selected loopback preview may be fetched.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = new URL(process.env.EASYTIER_NODE_INFO_TEST_URL || 'http://127.0.0.1:19423');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname));
assert.equal(base.protocol, 'http:');
const fixture = JSON.parse(await readFile(new URL('./fixtures/node-info.json', import.meta.url), 'utf8'));
const deviceId = '00000000-0000-4000-8000-000000000001';
const instanceId = fixture.node_info.inst_id;
const toUuid = value => Object.fromEntries([1, 2, 3, 4].map((part, index) => [`part${part}`, parseInt(value.replaceAll('-', '').slice(index * 8, index * 8 + 8), 16)]));
const checks = [];

test('device overview displays actual NodeInfo IPv4 and handles an omitted address', { timeout: 60000 }, async () => {
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const errors = [], unexpected = [], readRequests = [];
    let nodeInfo = fixture.node_info;
    try {
        await context.route('**/*', async route => {
            const request = route.request(), url = new URL(request.url());
            if (url.origin !== base.origin) { unexpected.push('external-request'); return route.abort(); }
            if (!url.pathname.startsWith('/api/v1/')) return route.continue();
            const path = url.pathname.slice('/api/v1/'.length);
            let data;
            if (request.method() === 'GET' && path === 'console-info') data = { username: 'fixture', config_server_protocol: 'udp', config_server_port: 22020, webhook_auth: true };
            else if (request.method() === 'GET' && path === 'machines') data = { machines: [{ client_url: 'udp://192.0.2.1:22020', online: true, info: { machine_id: toUuid(deviceId), hostname: 'Fixture device', running_network_instances: [toUuid(instanceId)], easytier_version: '2.7.0' } }] };
            else if (request.method() === 'GET' && path === `machines/${deviceId}/networks`) data = { running_inst_ids: [toUuid(instanceId)] };
            else if (request.method() === 'POST' && path === `machines/${deviceId}/networks/metas`) data = { metas: { [instanceId]: { network_name: 'Fixture network' } } };
            else if (request.method() === 'POST' && path === `machines/${deviceId}/proxy-rpc`) {
                const payload = request.postDataJSON();
                assert.equal(payload.service_name, 'api.instance.PeerManageRpcService');
                assert.equal(payload.method_name, 'show_node_info');
                assert.deepEqual(payload.payload, { instance: { id: toUuid(instanceId) } });
                readRequests.push(payload.method_name); data = { node_info: nodeInfo };
            } else { unexpected.push(`${request.method()} ${path}`); return route.fulfill({ status: 500, json: { message: 'Unexpected fixture request' } }); }
            return route.fulfill({ status: 200, json: data });
        });
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.name));
        await page.goto(`${base.origin}/#/h/deviceList/device/${deviceId}/${instanceId}`, { waitUntil: 'domcontentloaded' });
        const panel = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: '实例运行信息', exact: true }) });
        await panel.getByText('Node contract fixture', { exact: true }).waitFor();
        const address = panel.locator('.summary-item').filter({ has: page.getByText('虚拟 IPv4', { exact: true }) }).locator('strong');
        assert.equal(await address.textContent(), fixture.node_info.ipv4_addr);
        checks.push('actual NodeInfo IPv4 CIDR displayed in device overview');
        const { ipv4_addr, ...withoutAddress } = fixture.node_info;
        nodeInfo = withoutAddress;
        await panel.getByRole('button', { name: '刷新', exact: true }).click();
        await page.waitForFunction(() => [...document.querySelectorAll('.summary-item')].some(item => item.querySelector('span')?.textContent === '虚拟 IPv4' && item.querySelector('strong')?.textContent === '—'));
        assert.equal(await address.textContent(), '—');
        checks.push('omitted proto3 IPv4 string remains unknown without a crash');
        nodeInfo = { ...fixture.node_info, ipv4_addr: '100.64.4.8/23' };
        await panel.getByRole('button', { name: '刷新', exact: true }).click();
        await panel.getByText('100.64.4.8/23', { exact: true }).waitFor();
        checks.push('refreshed address and prefix are preserved');
        assert.ok(readRequests.length >= 3);
        assert.deepEqual(errors, []);
        assert.deepEqual(unexpected, []);
        checks.push('only scoped read-only mocked RPC used; no browser errors or external requests');
    } finally {
        await context.close(); await browser.close();
        if (process.env.EASYTIER_NODE_INFO_TEST_PROOF) await writeFile(process.env.EASYTIER_NODE_INFO_TEST_PROOF, JSON.stringify({ status: checks.length === 4 ? 'PASS' : 'INCOMPLETE', checks, scope: 'real Chromium and local static React dist with intercepted synthetic protobuf API fixtures', production_touched: false, native_core_or_tun_started: false, requests_mocked: true }, null, 2) + '\n');
    }
});
