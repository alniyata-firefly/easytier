// Explicit native integration test: isolated SQLite, loopback Gateway and no TUN.
// Uses real browser -> Web API -> managed Core; no API interception or mocks.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import {
    repo, webBinary, coreBinary, requireBinaries, freePort, waitFor,
    startWeb, stopWeb, startCore, stopCore, seedUser, protoUuid,
    httpApi, trackSecret, maskSecrets, assertNoSecretLogs,
} from './e2e-native-helpers.mjs';

const username = 'central-browser-e2e';
const password = 'e2e-password';
const passwordHash = '$argon2id$v=19$m=4096,t=3,p=1$ZWFzeXRpZXItZTJlLXNhbHQ$FHbDjVElaTXuArgEEQrQrO4AdsnqNOcXGA5PFY8cG/s';
const devices = [
    { id: '00000000-0000-0000-0000-000000000012', name: 'e2e-browser-one' },
    { id: '00000000-0000-0000-0000-000000000013', name: 'e2e-browser-two' },
];

async function login(page) {
    await page.goto('/#/auth');
    await page.locator('#username').fill(username);
    await page.locator('#password input').fill(password);
    await page.getByRole('button', { name: 'Login', exact: true }).click();
    await page.locator('.console-page').waitFor();
}

async function issueDeviceToken(page, label) {
    await page.getByRole('button', { name: 'Device Enrollment', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Device access tokens', exact: true });
    await dialog.getByLabel('Device label', { exact: true }).fill(label);
    const issuedResponse = page.waitForResponse(response => response.url().endsWith('/api/v1/device-access-tokens') && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Issue device token', exact: true }).click();
    const response = await issuedResponse;
    assert.equal(response.status(), 200, 'device token issued by real backend');
    const issued = await response.json();
    trackSecret(issued.token);
    await dialog.locator('code').waitFor();
    assert.ok((await dialog.locator('code').textContent()).includes(issued.token), 'one-time command contains the newly issued token');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    return issued;
}

async function rotateDeviceToken(page, label, id) {
    await page.getByRole('button', { name: 'Device Enrollment', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Device access tokens', exact: true });
    const row = dialog.getByRole('row').filter({ hasText: label });
    const rotatedResponse = page.waitForResponse(response => response.url().endsWith(`/api/v1/device-access-tokens/${id}/rotate`) && response.request().method() === 'POST');
    await row.getByRole('button', { name: 'Rotate', exact: true }).click();
    const response = await rotatedResponse;
    assert.equal(response.status(), 200);
    const issued = await response.json(); trackSecret(issued.token);
    await dialog.locator('code').waitFor();
    assert.ok((await dialog.locator('code').textContent()).includes(issued.token), 'rotation command reflects the new token');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    return issued;
}

async function revokeDeviceToken(page, label, id) {
    await page.getByRole('button', { name: 'Device Enrollment', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Device access tokens', exact: true });
    const deletedResponse = page.waitForResponse(response => response.url().endsWith(`/api/v1/device-access-tokens/${id}`) && response.request().method() === 'DELETE');
    const row = dialog.getByRole('row').filter({ hasText: label });
    await row.getByRole('button', { name: 'Revoke', exact: true }).click();
    const response = await deletedResponse;
    assert.equal(response.status(), 200);
    assert.equal((await response.json()).status, 'revoked');
    await row.getByText('Revoked', { exact: true }).waitFor();
    assert.equal(await dialog.locator('code').count(), 0);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
}

async function nodeRpc(api, machineId, networkId, method, service = 'api.instance.PeerManageRpcService') {
    return api.post(`/api/v1/machines/${machineId}/proxy-rpc`, {
        service_name: service, method_name: method,
        payload: { instance: { id: protoUuid(networkId) } },
    });
}

test('real browser, Web API and native Core agree on central management', { timeout: 300000 }, async () => {
    await requireBinaries(webBinary, coreBinary);
    const temp = await mkdtemp(join(repo, '.central-native-browser-'));
    const database = join(temp, 'web.db');
    const apiPort = await freePort(), configPort = await freePort();
    const base = `http://127.0.0.1:${apiPort}`;
    const web = startWeb(database, apiPort, configPort, '127.0.0.1', {
        advertisedUrl: `tcp://127.0.0.1:${configPort}/`, registrationDisabled: true,
    });
    const processes = [web], activeCores = new Map();
    const issuedTokens = new Map(), coreDirectories = new Map();
    let browser;
    const proof = { mock_api: false, host_tun: false, gateway_loopback: true, device_count: devices.length };
    const screenshotDir = process.env.EASYTIER_E2E_SCREENSHOT_DIR;
    try {
        if (screenshotDir) await mkdir(screenshotDir, { recursive: true, mode: 0o700 });
        await waitFor(async () => (await fetch(`${base}/api_meta.js`)).ok, 'isolated Web server');
        seedUser(database, username, passwordHash);
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ baseURL: base, acceptDownloads: true });
        await context.addInitScript(() => localStorage.setItem('lang', 'en'));
        const page = await context.newPage();
        page.setDefaultTimeout(20000);
        const pageErrors = [];
        page.on('pageerror', error => pageErrors.push(maskSecrets(error.message)));
        await login(page);
        const cookies = await context.cookies(base);
        cookies.forEach(cookie => trackSecret(cookie.value));
        const api = httpApi(base, cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '));
        assert.equal((await api.get('/auth/config')).registration_enabled, false);

        // Enroll clean daemon-only Cores, then stop them before adding managed instances.
        for (const device of devices) {
            const directory = join(temp, device.name); await mkdir(directory); coreDirectories.set(device.id, directory);
            const issued = await issueDeviceToken(page, device.name); issuedTokens.set(device.id, issued);
            const core = startCore(directory, '127.0.0.1', configPort, issued.token, { machineId: device.id, hostname: device.name });
            activeCores.set(device.id, core); processes.push(core);
            await waitFor(async () => (await api.get('/api/v1/machines')).machines.some(machine => machine.online && machine.info?.hostname === device.name), `${device.name} enrollment`);
        }
        for (const [id, core] of activeCores) { await stopCore(core); activeCores.delete(id); }
        await waitFor(async () => { const machines = (await api.get('/api/v1/machines')).machines; return machines.length === devices.length && machines.every(machine => !machine.online); }, 'offline clean daemons');

        await page.goto('/#/h/networks');
        await page.getByRole('button', { name: 'Create Network', exact: true }).first().click();
        await page.locator('#network-display-name').fill('Native Browser E2E');
        await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
        await page.waitForURL(/\/networks\/[0-9a-f-]{36}$/);
        const networkId = page.url().split('/').at(-1);
        const network = await api.get(`/api/v1/networks/${networkId}`);
        assert.equal(network.secure_mode, true); proof.secure_gateway_default = true;

        await page.getByRole('button', { name: 'Add Devices', exact: true }).click();
        const addDialog = page.getByRole('dialog', { name: 'Add Devices', exact: true });
        assert.equal(await addDialog.getByRole('button', { name: 'Device (dedicated credential)', exact: true }).getAttribute('aria-pressed'), 'true');
        for (const device of devices) await addDialog.getByRole('row').filter({ hasText: device.name }).getByRole('checkbox').check();
        await addDialog.getByRole('button', { name: 'Confirm', exact: true }).click();
        await addDialog.waitFor({ state: 'detached' });
        const offlineMembers = (await api.get(`/api/v1/networks/${networkId}/members`)).members;
        assert.equal(offlineMembers.length, devices.length);
        assert.ok(offlineMembers.every(member => member.temporary && member.credential_id === member.device_id));
        proof.temporary_default_machine_id_credentials = true;
        const managedCredentials = (await api.get(`/api/v1/networks/${networkId}/credentials`)).credentials;
        assert.ok(managedCredentials.length === devices.length && managedCredentials.every(credential => !credential.reusable && credential.device_id === credential.credential_id));
        assert.ok(offlineMembers.every(member => member.deployment.state === 'waiting_offline'));

        // Real API fixture preparation: never permit a managed Core to create a host TUN.
        for (const device of devices) {
            const config = await api.get(`/api/v1/networks/${networkId}/members/${device.id}/config`);
            assert.ok(!config.network_secret, 'ordinary devices never receive the shared network secret');
            trackSecret(config.secure_mode?.local_private_key);
            Object.assign(config, { no_tun: true, disable_upnp: true, bind_device: false, disable_p2p: true,
                listener_urls: ['tcp://127.0.0.1:0'], disable_udp_hole_punching: true, disable_tcp_hole_punching: true });
            await api.put(`/api/v1/networks/${networkId}/members/${device.id}/config`, { config });
        }
        await page.getByRole('tab', { name: 'Settings', exact: true }).click();
        await page.locator('#settings-display-name').fill('Native Browser E2E Saved');
        const savedResponse = page.waitForResponse(response => response.url().endsWith(`/api/v1/networks/${networkId}`) && response.request().method() === 'PATCH');
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        assert.equal((await savedResponse).status(), 200);
        assert.equal((await api.get(`/api/v1/networks/${networkId}`)).display_name, 'Native Browser E2E Saved');
        proof.browser_network_save = true;

        for (const device of devices) {
            const core = startCore(coreDirectories.get(device.id), '127.0.0.1', configPort, issuedTokens.get(device.id).token, { machineId: device.id, hostname: device.name });
            activeCores.set(device.id, core); processes.push(core);
        }
        await waitFor(async () => {
            const { members } = await api.get(`/api/v1/networks/${networkId}/members`);
            return members.length === devices.length && members.every(member => member.online && member.running && member.deployment.state === 'applied');
        }, 'managed no-TUN Cores applying desired revisions', 60000);
        proof.deployment_applied = true;
        for (const device of devices) {
            const config = await api.get(`/api/v1/networks/${networkId}/members/${device.id}/config`);
            assert.equal(config.no_tun, true);
            assert.ok((await readdir(coreDirectories.get(device.id))).includes(`${networkId}.toml`));
            await waitFor(async () => (await nodeRpc(api, device.id, networkId, 'list_peer')).peer_infos?.length > 0, `${device.name} Gateway connection`);
        }

        await page.getByRole('tab', { name: 'Members', exact: true }).click();
        await page.getByRole('row').filter({ hasText: devices[0].name }).getByRole('button', { name: 'Node Detail', exact: true }).click();
        const nodeDrawer = page.locator('.console-node-drawer');
        await nodeDrawer.getByRole('tab', { name: 'Runtime metrics', exact: true }).click();
        const stats = await waitFor(async () => {
            const result = await nodeRpc(api, devices[0].id, networkId, 'get_stats', 'api.instance.StatsRpcService');
            return result.metrics?.length > 0 ? result : null;
        }, 'actual Core metrics');
        proof.stats_metric_count = stats.metrics.length;
        await waitFor(async () => {
            const cells = nodeDrawer.getByRole('tabpanel').locator('tbody tr').first().locator('td');
            return await cells.count() === 4 && /^[a-z][a-z0-9_]+$/.test((await cells.first().textContent()).trim());
        }, 'real metrics rendered in the browser');
        if (screenshotDir) await nodeDrawer.screenshot({ path: join(screenshotDir, 'native-core-metrics.png'), animations: 'disabled' });
        const metricsText = await api.get(`/api/v1/machines/${devices[0].id}/networks/${networkId}/metrics`);
        assert.equal(typeof metricsText, 'string'); assert.ok(metricsText.length > 0);
        proof.prometheus_export_bytes = Buffer.byteLength(metricsText);
        const downloadEvent = page.waitForEvent('download');
        await nodeDrawer.getByRole('button', { name: 'Export Prometheus', exact: true }).click();
        assert.equal((await downloadEvent).suggestedFilename(), `${devices[0].id}.prom`);
        await page.keyboard.press('Escape'); await nodeDrawer.waitFor({ state: 'hidden' });

        await page.getByRole('tab', { name: 'Network topology', exact: true }).click();
        const topology = page.getByRole('img', { name: 'Network topology', exact: true });
        await waitFor(async () => await topology.locator('circle').count() === devices.length + 1, 'topology without duplicate managed temporary devices');
        await waitFor(async () => await topology.locator('line').count() >= devices.length, 'observed connection or reported route in topology');
        proof.topology_nodes_including_gateway = await topology.locator('circle').count();
        proof.topology_edges = await topology.locator('line').count();
        if (screenshotDir) await topology.screenshot({ path: join(screenshotDir, 'native-network-topology.png'), animations: 'disabled' });

        await page.getByRole('tab', { name: 'Access Control', exact: true }).click();
        await page.getByRole('button', { name: 'Add Rule', exact: true }).click();
        const aclDrawer = page.getByRole('complementary').filter({ has: page.locator('#acl-rule-name') });
        await aclDrawer.locator('#acl-rule-name').fill('Native E2E IPv6');
        for (const placeholder of ['Search and choose the members that initiate access', 'Search and choose target members or subnets']) {
            await aclDrawer.getByText(placeholder, { exact: true }).click();
            await page.getByRole('option', { name: 'All members', exact: true }).click(); await page.keyboard.press('Escape');
        }
        await aclDrawer.getByRole('checkbox', { name: 'ICMPv6', exact: true }).check();
        await aclDrawer.getByRole('checkbox', { name: 'Any protocol', exact: true }).check();
        await aclDrawer.getByRole('button', { name: 'Save Rule', exact: true }).click();
        await page.getByRole('button', { name: 'Save Policy', exact: true }).click();
        await page.getByText('Access policy saved', { exact: true }).waitFor();
        assert.deepEqual((await api.get(`/api/v1/networks/${networkId}/acl-policy`)).policy.rules[0].protocols.map(item => item.protocol), ['icmpv6', 'any']);
        proof.browser_acl_roundtrip = true;

        const rotated = await rotateDeviceToken(page, devices[0].name, issuedTokens.get(devices[0].id).info.id);
        assert.equal(rotated.info.machine_id, devices[0].id);
        assert.ok(rotated.info.auth_generation > issuedTokens.get(devices[0].id).info.auth_generation);
        await stopCore(activeCores.get(devices[0].id)); activeCores.delete(devices[0].id);
        issuedTokens.set(devices[0].id, rotated);
        const reconnected = startCore(coreDirectories.get(devices[0].id), '127.0.0.1', configPort, rotated.token, { machineId: devices[0].id, hostname: devices[0].name });
        activeCores.set(devices[0].id, reconnected); processes.push(reconnected);
        await waitFor(async () => (await api.get(`/api/v1/networks/${networkId}/members`)).members.some(member => member.device_id === devices[0].id && member.online && member.running && member.deployment.state === 'applied'), 'Core reconnect after browser token rotation', 60000);
        proof.browser_token_rotation_reconnect = true;

        await page.getByRole('tab', { name: 'Settings', exact: true }).click();
        await page.getByRole('button', { name: 'Delete Network', exact: true }).click();
        await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm', exact: true }).click();
        await page.waitForURL('**/#/h/networks');
        await waitFor(async () => !(await api.get('/api/v1/networks')).networks.some(item => item.network_id === networkId), 'network removed');
        for (const device of devices) await waitFor(async () => !(await readdir(coreDirectories.get(device.id))).includes(`${networkId}.toml`), `${device.name} managed config cleanup`, 45000);
        proof.browser_delete_core_cleanup = true;
        for (const device of devices) await revokeDeviceToken(page, device.name, issuedTokens.get(device.id).info.id);
        await waitFor(async () => (await api.get('/api/v1/machines')).machines.every(machine => !machine.online), 'live session revocation');
        const metadata = await api.get('/api/v1/device-access-tokens');
        assert.ok(metadata.tokens.every(token => token.status === 'revoked' && !Object.hasOwn(token, 'token')));
        proof.browser_token_revocation = true;
        assert.deepEqual(pageErrors, []);
        assertNoSecretLogs(processes);
        proof.process_logs_redacted = true;
        if (process.env.EASYTIER_E2E_PROOF_PATH) await writeFile(process.env.EASYTIER_E2E_PROOF_PATH, JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 });
    } catch (error) {
        throw new Error(maskSecrets(`${error.message}\nWeb logs:\n${web.logs()}\nCore logs:\n${processes.slice(1).map(item => item.logs()).join('\n')}`), { cause: error });
    } finally {
        await browser?.close();
        for (const core of activeCores.values()) await stopCore(core);
        await stopWeb(web);
        await rm(temp, { recursive: true, force: true });
    }
});
