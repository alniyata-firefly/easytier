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
const deviceA = '10000000-0000-4000-8000-000000000001';
const deviceB = '20000000-0000-4000-8000-000000000002';
const historicalDevice = '30000000-0000-4000-8000-000000000003';
const uuid = id => { const value = id.replaceAll('-', ''); return Object.fromEntries([1, 2, 3, 4].map(part => [`part${part}`, parseInt(value.slice((part - 1) * 8, part * 8), 16)])); };
const occurredAt = Date.parse('2026-10-17T00:15:30Z') / 1000;
const events = Array.from({ length: 121 }, (_, index) => ({
    id: 300 - index,
    device_id: index === 0 ? historicalDevice : index % 2 ? deviceA : deviceB,
    event: ['authorized', 'disconnected', 'authentication_rejected', 'pending_approval', 'configuration_apply_failed'][index % 5],
    reason: ['authorization_granted', 'connection_closed', 'device_identity_mismatch', 'device_rebind_required', 'configuration_rpc_failed'][index % 5],
    occurred_at: occurredAt - index,
    peer_ip: index === 0 ? '198.51.100.30' : index % 2 ? '198.51.100.11' : '198.51.100.22',
    instance_id: index % 2 ? null : '40000000-0000-4000-8000-000000000004',
}));

test('management connection history works across account, offline device, pagination, stale requests and languages', { timeout: 90000 }, async context => {
    const temporary = await mkdtemp(join(tmpdir(), 'et-management-events-ui-'));
    context.after(() => rm(temporary, { recursive: true, force: true }));
    const outfile = join(temporary, 'fixture.js');
    const fixture = `import React from 'react';import{createRoot}from'react-dom/client';
        import ApiClient from './src/lib/api';import{DevicesPage}from'./src/pages/DevicesPage';import{DevicePage}from'./src/pages/DevicePage';
        import{NoticeProvider,LanguageSwitch}from'./src/components/ui';import{i18nReady}from'./src/lib/i18n';
        const api=new ApiClient(location.origin);function Fixture(){const[target,setTarget]=React.useState('');
          window.__SHOW_DEVICE__=id=>setTarget(id);window.__SHOW_DEVICES__=()=>setTarget('');
          return <NoticeProvider><LanguageSwitch/>{target?<DevicePage api={api} deviceId={target}/>:<DevicesPage api={api} consoleInfo={{webhook_auth:true}}/>}</NoticeProvider>;}
        i18nReady.then(()=>createRoot(document.getElementById('root')).render(<React.Suspense fallback="Loading"><Fixture/></React.Suspense>));`;
    await esbuild.build({ stdin: { contents: fixture, resolveDir: frontend, loader: 'tsx' }, outfile,
        bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', loader: { '.svg': 'dataurl' }, logLevel: 'silent' });
    const bundle = await readFile(outfile);
    const calls = [], releases = [];
    let failEvents = false, holdDeviceA = false;
    const machines = [
        { alias: 'Offline phone', online: false, client_url: '198.51.100.11', info: { machine_id: uuid(deviceA), hostname: 'phone-offline', running_network_instances: [], easytier_version: '2.7.2', device_os: { os_type: 'Android' } } },
        { alias: 'Empty desktop', online: true, client_url: '198.51.100.22', info: { machine_id: uuid(deviceB), hostname: 'desktop-empty', running_network_instances: [], easytier_version: '2.7.2', device_os: { os_type: 'Windows' } } },
    ];
    const server = createServer(async (request, response) => {
        const url = new URL(request.url, 'http://127.0.0.1');
        const json = (value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
        try {
            if (url.pathname.startsWith('/api/')) calls.push({ method: request.method, path: url.pathname, params: Object.fromEntries(url.searchParams) });
            if (url.pathname === '/fixture.js') { response.setHeader('content-type', 'text/javascript'); response.end(bundle); }
            else if (url.pathname === '/style.css') { response.setHeader('content-type', 'text/css'); response.end(await readFile(join(frontend, 'src/style.css'))); }
            else if (url.pathname.startsWith('/locales/')) { json(JSON.parse(await readFile(join(frontend, 'public', url.pathname), 'utf8'))); }
            else if (url.pathname === '/api/v1/machines') json({ machines });
            else if (url.pathname === '/api/v1/blocked-devices') json({ blocked: [] });
            else if (url.pathname === '/api/v1/console-info') json({ webhook_auth: true });
            else if (url.pathname === `/api/v1/machines/${deviceA}/networks`) json({}, 503);
            else if (url.pathname === `/api/v1/machines/${deviceB}/networks`) json({ running_inst_ids: [], disabled_inst_ids: [] });
            else if (url.pathname === '/api/v1/management-connection-events') {
                if (failEvents) { json({ error: 'synthetic event query failure' }, 503); return; }
                const selected = url.searchParams.get('device_id');
                const before = Number(url.searchParams.get('before_id')) || Infinity;
                const filtered = events.filter(event => (!selected || event.device_id === selected) && event.id < before);
                const rows = filtered.slice(0, 50);
                const result = { events: rows, next_before_id: filtered.length > 50 ? rows.at(-1).id : null };
                if (holdDeviceA && selected === deviceA) await new Promise(resolve => releases.push(resolve));
                if (!response.destroyed) json(result);
            }
            else if (url.pathname === '/favicon.ico') response.writeHead(204).end();
            else if (url.pathname === '/') { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'); }
            else response.writeHead(404).end();
        } catch { if (!response.headersSent) response.writeHead(500); response.end(); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    context.after(() => { releases.splice(0).forEach(release => release()); return new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); });
    const browser = await chromium.launch({ executablePath: process.env.ET_CHROMIUM_PATH || undefined, headless: true, args: ['--no-sandbox'] });
    context.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: 'UTC' });
    page.setDefaultTimeout(7000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const proof = { scope: 'Real React DevicesPage, DevicePage, ConnectionLogs, LanguageSwitch and ApiClient; synthetic loopback HTTP API only', cases: [] };
    const step = async (name, action) => { await action(); proof.cases.push({ name, status: 'PASS' }); };
    const eventCalls = () => calls.filter(call => call.path === '/api/v1/management-connection-events');
    const rows = region => region.locator('.connection-log-table tbody tr');
    const waitForHeldRequest = async () => { for (let i = 0; i < 100 && !releases.length; i++) await new Promise(resolve => setTimeout(resolve, 20)); assert.ok(releases.length, 'expected an in-flight device A history request'); };
    const releaseHeldRequests = () => { holdDeviceA = false; releases.splice(0).forEach(release => release()); };
    const logPanel = () => page.locator('section.panel').filter({ has: page.getByRole('heading', { name: '连接日志', exact: true }) });
    await page.goto(`http://127.0.0.1:${server.address().port}`);

    await step('DevicesPage header opens all-account history with fifty records and Unix-second timestamps', async () => {
        const button = page.locator('.list-header-actions').getByRole('button', { name: '连接日志', exact: true });
        await button.waitFor(); await page.getByRole('link', { name: 'Offline phone', exact: false }).waitFor();
        await button.click();
        const dialog = page.getByRole('dialog', { name: '连接日志', exact: true });
        await rows(dialog).first().waitFor();
        assert.equal(await rows(dialog).count(), 50);
        assert.deepEqual(eventCalls()[0].params, { limit: '50' });
        assert.equal(await dialog.getByRole('combobox', { name: '设备', exact: true }).inputValue(), '');
        assert.deepEqual(await dialog.getByRole('combobox').locator('option').allTextContents(), ['全部设备', 'Offline phone', 'Empty desktop']);
        await dialog.getByRole('link', { name: historicalDevice, exact: true }).waitFor();
        const expected = await page.evaluate(value => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value * 1000)), occurredAt);
        assert.equal(await rows(dialog).first().locator('td').first().textContent(), expected);
        for (const text of ['管理认证通过', '管理连接断开', '管理认证拒绝', '等待设备审批', '配置应用失败']) assert.ok((await dialog.textContent()).includes(text));
    });

    await step('Cursor pagination uses before_id and resets through Newer and Latest', async () => {
        const dialog = page.getByRole('dialog');
        await dialog.getByRole('button', { name: '较早记录', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('dialog .connection-log-table tbody tr:first-child td:nth-child(5)')?.textContent === '198.51.100.22');
        assert.deepEqual(eventCalls().at(-1).params, { before_id: '251', limit: '50' });
        assert.equal(await rows(dialog).count(), 50);
        await dialog.getByRole('button', { name: '较新记录', exact: true }).click();
        await dialog.getByRole('link', { name: historicalDevice, exact: true }).waitFor();
        assert.equal(await dialog.getByRole('button', { name: '较新记录', exact: true }).isDisabled(), true);
        await dialog.getByRole('button', { name: '较早记录', exact: true }).click();
        await dialog.getByRole('button', { name: '最新记录', exact: true }).waitFor({ state: 'visible' });
        await page.waitForFunction(() => !Array.from(document.querySelectorAll('dialog button')).find(button => button.textContent === '最新记录')?.disabled);
        await dialog.getByRole('button', { name: '最新记录', exact: true }).click();
        await dialog.getByRole('link', { name: historicalDevice, exact: true }).waitFor();
        assert.deepEqual(eventCalls().at(-1).params, { limit: '50' });
    });

    await step('Device dropdown discards a late result after switching filters', async () => {
        const dialog = page.getByRole('dialog'), select = dialog.getByRole('combobox', { name: '设备', exact: true });
        holdDeviceA = true; await select.selectOption(deviceA); await waitForHeldRequest();
        await select.selectOption(deviceB); await rows(dialog).first().waitFor();
        assert.deepEqual(eventCalls().at(-1).params, { device_id: deviceB, limit: '50' });
        assert.equal(await rows(dialog).count(), 50);
        assert.ok((await rows(dialog).allTextContents()).every(text => text.includes('Empty desktop') && text.includes('198.51.100.22')));
        releaseHeldRequests(); await page.waitForTimeout(150);
        assert.equal(await select.inputValue(), deviceB);
        assert.ok((await rows(dialog).allTextContents()).every(text => text.includes('Empty desktop') && !text.includes('Offline phone')));
    });

    await step('Chinese and English log labels switch in place without changing records', async () => {
        await page.getByRole('combobox', { name: '语言', exact: true }).selectOption('en');
        const dialog = page.getByRole('dialog', { name: 'Connection logs', exact: true });
        await dialog.getByRole('columnheader', { name: 'Source IP', exact: true }).waitFor();
        await dialog.getByRole('button', { name: 'Older', exact: true }).waitFor();
        assert.equal(await dialog.getByRole('combobox', { name: 'Device', exact: true }).inputValue(), deviceB);
        assert.equal(await rows(dialog).count(), 50);
        assert.ok((await dialog.textContent()).includes('Management authorized'));
        await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN');
        await page.getByRole('dialog', { name: '连接日志', exact: true }).waitFor();
    });

    await step('Request failures are explicit with retained data or a fresh empty resource, never fake empty success', async () => {
        const dialog = page.getByRole('dialog');
        failEvents = true; await dialog.getByRole('button', { name: '刷新', exact: true }).click();
        await dialog.getByRole('alert').waitFor();
        assert.ok((await dialog.getByRole('alert').textContent()).includes('HTTP 503'));
        assert.equal(await rows(dialog).count(), 50);
        assert.equal(await dialog.getByRole('button', { name: '较早记录', exact: true }).isDisabled(), true);
        await dialog.getByRole('combobox', { name: '设备', exact: true }).selectOption(deviceA);
        await dialog.getByRole('alert').waitFor();
        assert.equal(await rows(dialog).count(), 0);
        assert.equal(await dialog.getByRole('heading', { name: '暂无连接日志', exact: true }).count(), 0);
        failEvents = false; await dialog.getByRole('button', { name: '刷新', exact: true }).click();
        await rows(dialog).first().waitFor(); await dialog.getByRole('alert').waitFor({ state: 'hidden' });
        await dialog.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    });

    await step('Offline DevicePage history survives unavailable runtime and a zero-instance device has history', async () => {
        await page.evaluate(id => window.__SHOW_DEVICE__(id), deviceA);
        let panel = logPanel(); await rows(panel).first().waitFor();
        assert.equal(await rows(panel).count(), 50);
        assert.ok((await rows(panel).allTextContents()).every(text => text.includes('198.51.100.11')));
        assert.equal(await panel.getByRole('combobox').count(), 0);
        assert.ok(eventCalls().some(call => call.params.device_id === deviceA));
        assert.ok(calls.some(call => call.path === `/api/v1/machines/${deviceA}/networks`));
        await page.evaluate(id => window.__SHOW_DEVICE__(id), deviceB);
        panel = logPanel(); await rows(panel).first().waitFor();
        assert.ok((await rows(panel).allTextContents()).every(text => text.includes('198.51.100.22')));
        assert.ok(calls.some(call => call.path === `/api/v1/machines/${deviceB}/networks`));
    });

    await step('Switching DevicePage drops the prior device in-flight history', async () => {
        holdDeviceA = true; await page.evaluate(id => window.__SHOW_DEVICE__(id), deviceA); await waitForHeldRequest();
        await page.evaluate(id => window.__SHOW_DEVICE__(id), deviceB);
        const panel = logPanel(); await rows(panel).first().waitFor();
        releaseHeldRequests(); await page.waitForTimeout(150);
        assert.ok((await rows(panel).allTextContents()).every(text => text.includes('198.51.100.22') && !text.includes('198.51.100.11')));
        assert.equal(await rows(panel).count(), 50);
    });

    assert.deepEqual(errors, []);
    assert.ok(calls.every(call => call.method === 'GET'), 'history browsing must not mutate any resource');
    assert.ok(eventCalls().every(call => call.params.limit === '50'));
    proof.status = 'PASS'; proof.case_count = proof.cases.length;
    proof.eventRequests = eventCalls(); proof.pageErrors = errors;
    proof.nativeBuildExecuted = false; proof.productionChanged = false;
    if (process.env.ET_CONNECTION_LOG_QA_OUTPUT) {
        await mkdir(process.env.ET_CONNECTION_LOG_QA_OUTPUT, { recursive: true, mode: 0o700 });
        await writeFile(join(process.env.ET_CONNECTION_LOG_QA_OUTPUT, 'proof.json'), JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 });
    }
    console.log(JSON.stringify(proof));
});
