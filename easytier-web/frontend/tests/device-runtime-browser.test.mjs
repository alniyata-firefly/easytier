import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve('vite'))('esbuild');
const deviceId = '10000000-0000-4000-8000-000000000001';
const instanceId = '20000000-0000-4000-8000-000000000002';
const uuid = id => { const hex = id.replaceAll('-', ''); return Object.fromEntries([1, 2, 3, 4].map(part => [`part${part}`, parseInt(hex.slice((part - 1) * 8, part * 8), 16)])); };

test('device instance runtime comes from live batch info rather than registered instance IDs', { timeout: 60000 }, async context => {
    const temporary = await mkdtemp(join(tmpdir(), 'et-device-runtime-ui-'));
    context.after(() => rm(temporary, { recursive: true, force: true }));
    const outfile = join(temporary, 'fixture.js');
    const fixture = `import React from'react';import{createRoot}from'react-dom/client';
        import ApiClient from'./src/lib/api';import{DevicePage}from'./src/pages/DevicePage';
        import{NoticeProvider}from'./src/components/ui';import i18n,{i18nReady}from'./src/lib/i18n';
        const api=new ApiClient(location.origin);
        i18nReady.then(async()=>{await i18n.changeLanguage(new URLSearchParams(location.search).get('lang')||'zh-CN');createRoot(document.getElementById('root')).render(<React.Suspense fallback="Loading"><NoticeProvider><DevicePage api={api} deviceId="${deviceId}"/></NoticeProvider></React.Suspense>);});`;
    await esbuild.build({ stdin: { contents: fixture, resolveDir: frontend, loader: 'tsx' }, outfile, bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', loader: { '.svg': 'dataurl' }, logLevel: 'silent' });
    const bundle = await readFile(outfile);
    let scenario = 'created';
    const unexpected = [], runtimeReads = [];
    const server = createServer(async (request, response) => {
        const path = new URL(request.url, 'http://127.0.0.1').pathname;
        const json = (value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
        try {
            if (path === '/fixture.js') { response.setHeader('content-type', 'text/javascript'); response.end(bundle); }
            else if (path.startsWith('/locales/')) json(JSON.parse(await readFile(join(frontend, 'public', path), 'utf8')));
            else if (path === '/api/v1/machines') json({ machines: [{ online: scenario !== 'offline', info: { machine_id: uuid(deviceId), hostname: 'Fixture device', running_network_instances: [uuid(instanceId)], easytier_version: '2.7.2' } }] });
            else if (path === '/api/v1/console-info') json({ webhook_auth: true });
            else if (path === `/api/v1/machines/${deviceId}/networks`) json({ running_inst_ids: [uuid(instanceId)], disabled_inst_ids: [] });
            else if (path === `/api/v1/machines/${deviceId}/networks/metas` && request.method === 'POST') json({ metas: { [instanceId]: { network_name: 'Fixture instance', config_permission: 0 } } });
            else if (path === `/api/v1/machines/${deviceId}/networks/info`) {
                runtimeReads.push({ method: request.method, contentLength: request.headers['content-length'] });
                if (scenario === 'failure') json({ error: 'Synthetic runtime read failure' }, 503);
                else json({ info: { map: scenario === 'missing' ? {} : { [instanceId]: scenario === 'created' ? {} : { running: !['stopped', 'failed'].includes(scenario), ...(scenario === 'failed' ? { error_msg: 'Synthetic actor startup failed' } : {}) } } } });
            }
            else if (path === '/api/v1/management-connection-events') json({ events: [], next_before_id: null });
            else if (path === `/api/v1/machines/${deviceId}/proxy-rpc` && request.method === 'POST') {
                let body = ''; for await (const chunk of request) body += chunk;
                const payload = JSON.parse(body);
                if (payload.service_name !== 'api.instance.PeerManageRpcService' || payload.method_name !== 'show_node_info') unexpected.push(`${payload.service_name}/${payload.method_name}`);
                json({ node_info: { hostname: 'Live node' } });
            }
            else if (path === '/favicon.ico') response.writeHead(204).end();
            else if (path === '/') { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><html><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'); }
            else { unexpected.push(`${request.method} ${path}`); response.writeHead(404).end(); }
        } catch { response.writeHead(500).end(); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    context.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const browser = await chromium.launch({ executablePath: process.env.ET_CHROMIUM_PATH || undefined, headless: true, args: ['--no-sandbox'] });
    context.after(() => browser.close());
    for (const language of ['zh-CN', 'en']) {
        scenario = 'created';
        const labels = JSON.parse(await readFile(join(frontend, `public/locales/${language}/devices.json`)));
        const common = JSON.parse(await readFile(join(frontend, `public/locales/${language}/common.json`)));
        const tunnelLabels = JSON.parse(await readFile(join(frontend, `public/locales/${language}/tunnel-events.json`)));
        const page = await browser.newPage();
        page.setDefaultTimeout(7000);
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}/?lang=${language}`);
        const row = page.locator('table.data-table tbody tr').filter({ has: page.getByRole('link', { name: 'Fixture instance', exact: true }) });
        const refresh = page.locator('header.page-heading').getByRole('button', { name: labels.actions.refresh, exact: true });
        const update = async value => { scenario = value; await refresh.click(); await page.waitForFunction(() => !document.querySelector('header.page-heading button[aria-busy="true"]')); };
        await row.locator('.status.stopped').waitFor();
        await page.getByText(labels.instance.notRunning, { exact: true }).waitFor();
        assert.equal(await row.getByRole('button', { name: labels.actions.stopInstance, exact: true }).count(), 1, 'registry membership still drives lifecycle action');
        await update('stopped'); await row.locator('.status.stopped').waitFor();
        await page.getByRole('tab', { name: tunnelLabels.title, exact: true }).click();
        await page.getByText(tunnelLabels.empty, { exact: true }).waitFor();
        await page.getByRole('tab', { name: labels.tabs.overview, exact: true }).click();
        await page.getByText(labels.instance.notRunning, { exact: true }).waitFor();

        await update('running'); await row.locator('.status.running').waitFor();
        await page.getByText('Live node', { exact: true }).waitFor();
        await page.getByRole('tab', { name: tunnelLabels.title, exact: true }).click();
        await page.getByText(tunnelLabels.empty, { exact: true }).waitFor();
        await page.getByRole('tab', { name: labels.tabs.overview, exact: true }).click();
        await page.getByText('Live node', { exact: true }).waitFor();

        await update('failure'); await row.locator('.status.unknown').waitFor();
        await page.getByText(labels.instance.runtimeUnknown, { exact: true }).last().waitFor();
        assert.equal(await page.getByText('Live node', { exact: true }).count(), 0, 'cached successful runtime does not enable live panels after failed refresh');
        assert.equal(await page.getByText(labels.instance.notRunning, { exact: true }).count(), 0);

        await update('failed'); await row.locator('.status.failed').waitFor();
        assert.equal(await row.locator('.status.failed').textContent(), labels.instance.runtimeFailed);
        assert.equal(await page.getByText(labels.instance.notRunning, { exact: true }).count(), 0);

        await update('missing'); await row.locator('.status.unknown').waitFor();
        assert.equal(await page.getByText(labels.instance.notRunning, { exact: true }).count(), 0);

        await update('offline'); await row.locator('.status.unknown').waitFor();
        assert.equal(await page.locator('header.page-heading .status.offline').textContent(), common.managementStatus.offline);
        await update('running'); await row.locator('.status.running').waitFor();
        await page.getByText('Live node', { exact: true }).waitFor();
        assert.deepEqual(errors, []);
        await page.close();
    }
    assert.ok(runtimeReads.length >= 16);
    assert.ok(runtimeReads.every(read => read.method === 'GET' && !read.contentLength), 'one batch GET without a request body per refresh');
    assert.deepEqual(unexpected, []);
});
