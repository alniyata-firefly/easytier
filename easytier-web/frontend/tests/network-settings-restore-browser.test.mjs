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
const initial = {
    network_id: '4f9407e5-c72a-4542-af12-9504c8671995', display_name: 'Initial synthetic network',
    network_name: 'synthetic-identity', networking_method: 'Standalone', peer_urls: [],
    virtual_cidr: '10.66.0.0/24', secure_mode: true, prefer_ipv6: true,
    network_secret: 'synthetic-network-secret', member_count: 0,
    transport: { data_compress_algo: 1, enable_kcp_proxy: false },
};

test('network settings restore waits for fresh data, preserves failed drafts, and ignores abandoned reads', { timeout: 60000 }, async context => {
    const temporary = await mkdtemp(join(tmpdir(), 'et-network-restore-'));
    context.after(() => rm(temporary, { recursive: true, force: true }));
    const outfile = join(temporary, 'fixture.js');
    const fixture = `import React from'react';import{createRoot}from'react-dom/client';
    import{NetworkPage}from${JSON.stringify(join(frontend, 'src/pages/NetworkPage.tsx'))};
    import ApiClient from${JSON.stringify(join(frontend, 'src/lib/api.ts'))};
    import{i18nReady}from${JSON.stringify(join(frontend, 'src/lib/i18n.ts'))};
    const api=new ApiClient(location.origin);const onTitleChange=title=>window.__NETWORK_TITLE__=title;
    i18nReady.then(()=>createRoot(document.getElementById('root')).render(<React.Suspense fallback="Loading"><NetworkPage api={api} networkId=${JSON.stringify(initial.network_id)} consoleInfo={{webhook_auth:false}} onTitleChange={onTitleChange}/></React.Suspense>));`;
    await esbuild.build({ stdin: { contents: fixture, resolveDir: frontend, loader: 'tsx' }, outfile, bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', loader: { '.svg': 'dataurl' }, logLevel: 'silent' });
    const bundle = await readFile(outfile);
    let stored = structuredClone(initial), gate, releaseGate, failReads = false, networkReads = 0;
    const writes = [];
    context.after(() => releaseGate?.());
    const server = createServer(async (request, response) => {
        try {
            const path = new URL(request.url, 'http://127.0.0.1').pathname;
            if (path === `/api/v1/networks/${initial.network_id}`) {
                response.setHeader('content-type', 'application/json');
                if (request.method === 'GET') {
                    networkReads++; if (gate) await gate;
                    if (failReads) { response.writeHead(500).end(JSON.stringify({ message: 'Synthetic read failure' })); return; }
                    response.end(JSON.stringify(stored)); return;
                }
                const chunks = []; for await (const chunk of request) chunks.push(chunk);
                const body = JSON.parse(Buffer.concat(chunks).toString()); writes.push(body);
                stored = { ...stored, ...body.settings }; response.end(JSON.stringify(stored));
            } else if (path.startsWith('/api/')) {
                response.setHeader('content-type', 'application/json');
                if (path.endsWith('/members')) response.end(JSON.stringify({ members: [], temporary_peers: [] }));
                else if (path.endsWith('/gateway-info')) response.end(JSON.stringify({ enabled: true, peer_url: 'udp://127.0.0.1:22020', relay_data: true }));
                else if (path.endsWith('/machines')) response.end(JSON.stringify({ machines: [] }));
                else response.writeHead(404).end('{}');
            } else if (path === '/fixture.js') { response.setHeader('content-type', 'text/javascript'); response.end(bundle); }
            else if (path === '/style.css') { response.setHeader('content-type', 'text/css'); response.end(await readFile(join(frontend, 'src/style.css'))); }
            else if (path.startsWith('/locales/')) { response.setHeader('content-type', 'application/json'); response.end(await readFile(join(frontend, 'public', path))); }
            else if (path === '/') { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'); }
            else response.writeHead(404).end();
        } catch (error) { response.writeHead(500).end(error.message); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    context.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const browser = await chromium.launch({ executablePath: process.env.ET_CHROMIUM_PATH || undefined, headless: true, args: ['--no-sandbox'] });
    context.after(() => browser.close());
    const page = await browser.newPage(); page.setDefaultTimeout(7000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('tab', { name: '网络设置', exact: true }).click();
    const panel = page.getByRole('tabpanel', { name: '网络设置', exact: true }).locator('.panel').first();
    const name = () => panel.getByRole('textbox', { name: '网络名称', exact: true });
    const compression = () => panel.getByRole('combobox', { name: '数据压缩', exact: true });
    const restore = panel.locator(':scope > .form-actions > button');
    await name().waitFor();
    await name().fill('Unsubmitted local draft'); await compression().selectOption('2');

    stored = { ...stored, display_name: 'Fresh server state', virtual_cidr: '10.67.0.0/24', transport: { data_compress_algo: 1, enable_kcp_proxy: true, disable_kcp_input: false } };
    await page.waitForFunction(() => window.__NETWORK_TITLE__ === 'Fresh server state', undefined, { timeout: 12000 });
    assert.equal(await name().inputValue(), 'Unsubmitted local draft');
    assert.equal(await compression().inputValue(), '2');
    assert.equal(writes.length, 0);

    gate = new Promise(resolve => { releaseGate = resolve; });
    const beforeRestore = networkReads;
    await restore.click();
    await assert.doesNotReject(async () => { const end = Date.now() + 3000; while (networkReads === beforeRestore && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20)); assert.ok(networkReads > beforeRestore); });
    assert.equal(await name().inputValue(), 'Unsubmitted local draft');
    assert.equal(await compression().inputValue(), '2');
    assert.equal(await name().isDisabled(), true);
    assert.equal(await restore.isDisabled(), true);
    releaseGate(); gate = undefined;
    await page.waitForFunction(() => document.querySelector('input[aria-label="网络名称"]')?.value === 'Fresh server state');
    assert.equal(await compression().inputValue(), '1');
    assert.equal(await panel.getByRole('textbox', { name: '虚拟 IPv4 网段', exact: true }).inputValue(), '10.67.0.0/24');
    assert.equal(await panel.getByRole('combobox', { name: '发起 KCP 代理', exact: true }).inputValue(), 'enabled');
    assert.equal(await panel.getByRole('combobox', { name: '接收 KCP 代理', exact: true }).inputValue(), 'enabled');

    await name().fill('Draft preserved on failure'); await compression().selectOption('2');
    failReads = true; await restore.click();
    await panel.getByRole('alert').filter({ hasText: '恢复设置失败' }).waitFor();
    assert.equal(await name().inputValue(), 'Draft preserved on failure');
    assert.equal(await compression().inputValue(), '2');
    assert.equal(await name().isEnabled(), true);
    assert.equal(await restore.isEnabled(), true);
    failReads = false;
    await panel.getByRole('button', { name: '保存网络设置', exact: true }).click();
    await page.waitForFunction(() => window.__NETWORK_TITLE__ === 'Draft preserved on failure');
    assert.equal(await panel.getByRole('alert').filter({ hasText: '恢复设置失败' }).count(), 0);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].settings.display_name, 'Draft preserved on failure');
    assert.deepEqual(writes[0].settings.transport, { data_compress_algo: 2, enable_kcp_proxy: true, disable_kcp_input: false });

    gate = new Promise(resolve => { releaseGate = resolve; });
    await restore.click();
    await page.getByRole('tab', { name: /^成员/ }).click();
    await page.getByRole('tab', { name: '网络设置', exact: true }).click();
    await name().fill('New draft after leaving settings');
    stored = { ...stored, display_name: 'Abandoned delayed response' };
    releaseGate(); gate = undefined;
    await page.waitForFunction(() => window.__NETWORK_TITLE__ === 'Abandoned delayed response', undefined, { timeout: 12000 });
    assert.equal(await name().inputValue(), 'New draft after leaving settings');
    assert.equal(writes.length, 1);
    assert.deepEqual(errors, []);
});
