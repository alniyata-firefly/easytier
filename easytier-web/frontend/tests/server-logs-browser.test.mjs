import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve('vite'))('esbuild');
const device = '10000000-0000-4000-8000-000000000001';
const time = Date.parse('2026-10-18T02:49:56.048Z');
const entries = Array.from({ length: 121 }, (_, index) => ({ id: 500 - index, occurred_at: time - index, level: ['INFO', 'WARN', 'ERROR'][index % 3], target: index % 2 ? 'easytier_web::auth' : 'easytier_web::runtime', message: index === 0 ? '<img src=x onerror="window.__INJECTED__=true">' : `Runtime event ${index}`, fields: { event: index % 2 ? 'authentication_rejected' : 'started', error_code: 'unavailable' } }));

test('Logs navigation provides usable runtime logs with filters, live controls, export, isolation and restart recovery', { timeout: 90000 }, async context => {
    const temporary = await mkdtemp(join(tmpdir(), 'et-server-logs-browser-'));
    context.after(() => rm(temporary, { recursive: true, force: true }));
    const outfile = join(temporary, 'fixture.js');
    const fixture = `import React from 'react';import{createRoot}from'react-dom/client';import App from './src/App';import{LanguageSwitch}from'./src/components/ui';import{i18nReady}from'./src/lib/i18n';i18nReady.then(()=>createRoot(document.getElementById('root')).render(<><LanguageSwitch/><App/></>));`;
    await esbuild.build({ stdin: { contents: fixture, resolveDir: frontend, loader: 'tsx' }, outfile, bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', loader: { '.svg': 'dataurl' }, logLevel: 'silent' });
    const bundle = await readFile(outfile), calls = [];
    let admin = true, status = 200, instance = 'instance-a';
    const server = createServer(async (request, response) => {
        const url = new URL(request.url, 'http://127.0.0.1');
        const json = (data, code = 200) => { response.writeHead(code, { 'content-type': 'application/json' }); response.end(JSON.stringify(data)); };
        if (url.pathname.startsWith('/api/')) calls.push({ method: request.method, path: url.pathname, params: Object.fromEntries(url.searchParams) });
        try {
            if (url.pathname === '/fixture.js') { response.setHeader('content-type', 'text/javascript'); response.end(bundle); }
            else if (url.pathname === '/style.css') { response.setHeader('content-type', 'text/css'); response.end(await readFile(join(frontend, 'src/style.css'))); }
            else if (url.pathname.startsWith('/locales/')) json(JSON.parse(await readFile(join(frontend, 'public', url.pathname), 'utf8')));
            else if (url.pathname === '/api/v1/console-info') json({ username: admin ? 'admin' : 'ordinary', webhook_auth: false, config_server_protocol: 'udp', config_server_port: 22020, server_logs_access: admin });
            else if (url.pathname === '/api/v1/device-access-tokens') json({ tokens: [] });
            else if (url.pathname === '/api/v1/machines') json({ machines: [{ alias: 'Offline phone', online: false, info: { machine_id: { part1: 268435456, part2: 16384, part3: 2147483648, part4: 1 }, hostname: 'phone', running_network_instances: [] } }] });
            else if (url.pathname === '/api/v1/management-connection-events') json({ events: [{ id: 1, occurred_at: time / 1000, device_id: device, event: 'disconnected', reason: 'connection_closed', peer_ip: '198.51.100.4' }], next_before_id: null });
            else if (url.pathname === '/api/v1/server/logs') {
                if (status !== 200) { json({ error: 'synthetic failure' }, status); return; }
                const source = instance === 'instance-a' ? entries : [{ ...entries[1], id: 20, message: 'Restarted service' }];
                const minimum = ['INFO', 'WARN', 'ERROR'].indexOf(url.searchParams.get('level') || 'INFO');
                const filtered = source.filter(entry => entry.id < (Number(url.searchParams.get('before_id')) || Infinity) && ['INFO', 'WARN', 'ERROR'].indexOf(entry.level) >= minimum && entry.target.startsWith(url.searchParams.get('target') || '') && JSON.stringify(entry).toLowerCase().includes((url.searchParams.get('q') || '').toLowerCase()));
                const rows = filtered.slice(0, 50);
                json({ entries: rows, next_before_id: filtered.length > 50 ? rows.at(-1).id : null, instance_id: instance, started_at: time - 1000, capacity: 1000, dropped_entries: 4 });
            }
            else if (url.pathname === '/favicon.ico') response.writeHead(204).end();
            else if (url.pathname === '/') { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'); }
            else response.writeHead(404).end();
        } catch { if (!response.headersSent) response.writeHead(500); response.end(); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    context.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const browser = await chromium.launch({ executablePath: process.env.ET_CHROMIUM_PATH || undefined, headless: true, args: ['--no-sandbox'] });
    context.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: 'UTC', acceptDownloads: true });
    const proofDirectory = process.env.ET_SERVER_LOG_QA_OUTPUT;
    if (proofDirectory) await mkdir(proofDirectory, { recursive: true, mode: 0o700 });
    page.setDefaultTimeout(7000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const logCalls = () => calls.filter(call => call.path === '/api/v1/server/logs');
    const rows = () => page.locator('.server-log-table tbody tr');
    const cases = [], step = async (name, action) => { await action(); cases.push(name); };
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/#/h/tokens`);
    await step('Standalone navigation opens admin logs; milliseconds, severity and literal text render safely', async () => {
        await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '日志', exact: true }).click();
        await rows().first().waitFor(); assert.equal(await rows().count(), 50);
        assert.deepEqual(logCalls()[0].params, { level: 'INFO', limit: '50' });
        await page.getByRole('tab', { name: '服务端日志', exact: true }).waitFor();
        assert.equal(await page.locator('.server-log-table time').first().getAttribute('datetime'), new Date(time).toISOString());
        assert.ok((await rows().first().textContent()).includes('<img src=x'));
        assert.equal(await page.locator('.server-log-table img').count(), 0);
        assert.equal(await page.evaluate(() => window.__INJECTED__), undefined);
        await rows().first().getByText('查看字段', { exact: true }).click();
        assert.ok((await rows().first().textContent()).includes('error_code'));
        assert.ok((await page.locator('.log-meta').textContent()).includes('重启后清空'));
        if (proofDirectory) await page.screenshot({ path: join(proofDirectory, 'server-logs-desktop.png'), fullPage: true });
    });
    await step('Auto-refresh polls latest, pauses on request and manual refresh remains available', async () => {
        const count = logCalls().length;
        await page.waitForFunction(before => window.performance.getEntriesByType('resource').filter(entry => entry.name.includes('/api/v1/server/logs')).length > before, count, { timeout: 7000 });
        await page.getByRole('button', { name: '暂停自动刷新', exact: true }).click();
        await rows().first().waitFor(); const paused = logCalls().length;
        await page.waitForTimeout(5200); assert.equal(logCalls().length, paused);
        await page.getByRole('button', { name: '刷新', exact: true }).click();
        await page.waitForFunction(before => window.performance.getEntriesByType('resource').filter(entry => entry.name.includes('/api/v1/server/logs')).length > before, paused);
    });
    await step('Older/Newer/Latest preserve cursors; applying filters resets pagination and controls request values', async () => {
        await page.getByRole('button', { name: '较早记录', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('.server-log-table tbody tr')?.textContent.includes('Runtime event 50'));
        assert.equal(logCalls().at(-1).params.before_id, '451');
        await page.getByRole('button', { name: '较新记录', exact: true }).click(); await rows().first().getByText('<img src=x onerror="window.__INJECTED__=true">', { exact: true }).waitFor();
        await page.getByRole('button', { name: '较早记录', exact: true }).click(); await rows().first().waitFor();
        await page.getByRole('button', { name: '最新记录', exact: true }).click(); await rows().first().getByText('<img src=x onerror="window.__INJECTED__=true">', { exact: true }).waitFor();
        await page.getByRole('combobox', { name: '最低级别' }).selectOption('WARN');
        await page.getByRole('searchbox', { name: '模块前缀' }).fill('easytier_web::auth');
        await page.getByRole('searchbox', { name: '搜索日志' }).fill('event 1');
        await page.getByRole('button', { name: '筛选', exact: true }).click(); await rows().first().waitFor();
        assert.deepEqual(logCalls().at(-1).params, { level: 'WARN', target: 'easytier_web::auth', q: 'event 1', limit: '50' });
        assert.ok((await rows().allTextContents()).every(text => text.includes('easytier_web::auth') && !text.includes('INFO')));
        assert.equal(await page.getByRole('button', { name: '较新记录', exact: true }).isDisabled(), true);
    });
    await step('JSON export matches the filtered current page and contains no session/client properties', async () => {
        const count = await rows().count();
        const downloading = page.waitForEvent('download');
        await page.getByRole('button', { name: '导出当前页 JSON', exact: true }).click();
        const download = await downloading;
        const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
        assert.equal(exported.entries.length, count);
        assert.deepEqual(exported.filters, { level: 'WARN', target: 'easytier_web::auth', q: 'event 1' });
        assert.equal(Object.keys(exported).some(key => /token|cookie|client|password|session/i.test(key)), false);
    });
    await step('Languages switch in place and unmatched filters are distinct from API errors', async () => {
        await page.getByRole('combobox', { name: '语言', exact: true }).selectOption('en');
        await page.getByRole('heading', { name: 'Server logs', exact: true }).waitFor();
        assert.equal(await page.getByRole('searchbox', { name: 'Search logs', exact: true }).inputValue(), 'event 1');
        await page.getByRole('searchbox', { name: 'Search logs', exact: true }).fill('absent');
        await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
        await page.getByRole('heading', { name: 'No logs match these filters', exact: true }).waitFor();
        status = 503; await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await page.getByRole('alert').waitFor();
        assert.equal(await page.getByRole('heading', { name: 'No logs match these filters', exact: true }).count(), 0);
        assert.ok((await page.getByRole('alert').textContent()).includes('HTTP 503'));
        status = 403; await page.getByRole('button', { name: 'Refresh', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('[role=alert]')?.textContent.includes('permission'));
        status = 404; await page.getByRole('button', { name: 'Refresh', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('[role=alert]')?.textContent.includes('server supports'));
        status = 200;
    });
    await step('Server restart while browsing older entries discards the old process cursor', async () => {
        await page.getByRole('combobox', { name: 'Minimum level' }).selectOption('INFO');
        await page.getByRole('searchbox', { name: 'Module prefix' }).fill(''); await page.getByRole('searchbox', { name: 'Search logs' }).fill('');
        await page.getByRole('button', { name: 'Apply filters', exact: true }).click(); await rows().first().waitFor();
        await page.getByRole('button', { name: 'Older', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('.server-log-table tbody tr')?.textContent.includes('Runtime event 50'));
        instance = 'instance-b'; await page.getByRole('button', { name: 'Refresh', exact: true }).click();
        await page.getByText('The server restarted. Showing the latest logs from the current service instance.', { exact: true }).waitFor();
        await page.getByText('Restarted service', { exact: true }).waitFor();
        assert.equal(logCalls().at(-1).params.before_id, undefined);
        assert.equal(await page.getByRole('button', { name: 'Newer', exact: true }).isDisabled(), true);
        assert.equal(await rows().count(), 1);
    });
    await step('Device log tab reuses current-account history and ordinary accounts never query global logs', async () => {
        await page.getByRole('tab', { name: 'Device connection logs', exact: true }).click();
        await page.locator('.connection-log-table tbody tr').first().waitFor();
        assert.ok((await page.locator('.connection-log-table').textContent()).includes('Offline phone'));
        admin = false; const prior = logCalls().length;
        await page.goto(`${base}/?account=ordinary#/h/logs`); await page.locator('.connection-log-table tbody tr').first().waitFor();
        assert.equal(await page.getByRole('tab', { name: 'Server logs', exact: true }).count(), 0);
        assert.equal(logCalls().length, prior);
        await page.goto(`${base}/#/h/logs/server`);
        await page.getByText('Server logs are available to authorized administrators. You can still view device connection logs for your account.', { exact: true }).waitFor();
        assert.equal(logCalls().length, prior);
    });
    await step('Mobile navigation exposes Logs and the page stays within the viewport', async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
        await page.getByRole('dialog').getByRole('link', { name: 'Logs', exact: true }).click();
        await page.locator('.connection-log-table tbody tr').first().waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
        if (proofDirectory) await page.screenshot({ path: join(proofDirectory, 'logs-mobile.png'), fullPage: true });
    });
    assert.deepEqual(errors, []);
    assert.ok(calls.every(call => call.method === 'GET'), 'the logs module must not mutate server state');
    const proof = { status: 'PASS', scope: 'Actual App, Logs page, ApiClient, ConnectionLogs and i18n with synthetic loopback HTTP API', cases, requests: logCalls(), nativeBuildExecuted: false, productionChanged: false };
    if (proofDirectory) await writeFile(join(proofDirectory, 'server-logs-browser-proof.json'), JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify(proof));
});
