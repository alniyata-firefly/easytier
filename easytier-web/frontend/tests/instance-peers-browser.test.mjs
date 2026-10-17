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

test('peer panel excludes closed connections and never presents cached peers as current after query failure', { timeout: 60000 }, async context => {
    const directory = await mkdtemp(join(tmpdir(), 'et-instance-peers-ui-'));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const fixture = `import React from'react';import{createRoot}from'react-dom/client';
        import{InstancePeers}from'./src/components/InstanceRuntimePanels';
        import i18n,{i18nReady}from'./src/lib/i18n';
        window.__SCENARIO__='mixed';window.__READS__=0;
        const connection=(conn_id,is_closed,port)=>({conn_id,is_closed,tunnel:{tunnel_type:'udp',local_addr:'udp://192.0.2.1:22020',remote_addr:'udp://198.51.100.1:'+port},stats:{latency_us:1200,rx_bytes:'1024',tx_bytes:'2048'}});
        const live=connection('live',false,22021),closed=connection('closed',true,22022),legacy=connection('legacy',undefined,22023),missingId=connection('',false,22024);
        const api={get_node_peers:async()=>{window.__READS__++;if(window.__SCENARIO__==='failure')throw new Error('Synthetic read failure');return[{peer_id:42,conns:window.__SCENARIO__==='closed-only'?[closed,missingId]:[live,closed,legacy,missingId]}];}};
        i18nReady.then(async()=>{await i18n.changeLanguage(new URLSearchParams(location.search).get('lang')||'zh-CN');createRoot(document.getElementById('root')).render(<React.Suspense fallback="Loading"><InstancePeers api={api} deviceId="fixture-device" instanceId="fixture-instance"/></React.Suspense>);});`;
    const outfile = join(directory, 'fixture.js');
    await esbuild.build({ stdin: { contents: fixture, resolveDir: frontend, loader: 'tsx' }, outfile, bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', loader: { '.svg': 'dataurl' }, logLevel: 'silent' });
    const bundle = await readFile(outfile);
    const server = createServer(async (request, response) => {
        try {
            const path = new URL(request.url, 'http://127.0.0.1').pathname;
            if (path === '/fixture.js') { response.setHeader('content-type', 'text/javascript'); response.end(bundle); }
            else if (path.startsWith('/locales/')) { response.setHeader('content-type', 'application/json'); response.end(await readFile(join(frontend, 'public', path))); }
            else if (path === '/favicon.ico') response.writeHead(204).end();
            else if (path === '/') { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><html><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'); }
            else response.writeHead(404).end();
        } catch { response.writeHead(404).end(); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    context.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const browser = await chromium.launch({ executablePath: process.env.ET_CHROMIUM_PATH || undefined, headless: true, args: ['--no-sandbox'] });
    context.after(() => browser.close());
    for (const language of ['zh-CN', 'en']) {
        const labels = JSON.parse(await readFile(join(frontend, `public/locales/${language}/devices.json`)));
        const page = await browser.newPage();
        page.setDefaultTimeout(7000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}/?lang=${language}`);
        const refresh = page.getByRole('button', { name: labels.actions.refresh, exact: true });
        const setScenario = async scenario => {
            await page.evaluate(value => { window.__SCENARIO__ = value; }, scenario);
            await refresh.click();
            await refresh.waitFor({ state: 'visible' });
            await page.waitForFunction(() => !document.querySelector('button[aria-busy="true"]'));
        };
        await page.locator('tbody tr').first().waitFor();
        assert.equal(await page.locator('tbody tr').count(), 2, `${language}: live and legacy-open connections only`);
        assert.equal(await page.getByText('udp://198.51.100.1:22021', { exact: true }).count(), 1);
        assert.equal(await page.getByText('udp://198.51.100.1:22023', { exact: true }).count(), 1);
        assert.equal(await page.getByText('udp://198.51.100.1:22022', { exact: true }).count(), 0);
        assert.equal(await page.getByText('udp://198.51.100.1:22024', { exact: true }).count(), 0);

        await setScenario('failure');
        await page.getByText(labels.runtime.peersUnavailable, { exact: true }).waitFor();
        assert.equal(await page.locator('table').count(), 0, `${language}: cached peers must not look current`);
        assert.equal(await page.getByText(labels.runtime.noPeers, { exact: true }).count(), 0, `${language}: failed query does not establish no connected peers`);

        await setScenario('mixed');
        await page.locator('tbody tr').first().waitFor();
        assert.equal(await page.locator('tbody tr').count(), 2);
        assert.equal(await page.getByText(labels.runtime.peersUnavailable, { exact: true }).count(), 0);

        await setScenario('closed-only');
        await page.getByText(labels.runtime.noPeers, { exact: true }).waitFor();
        assert.equal(await page.locator('table').count(), 0);
        assert.deepEqual(errors, []);
        await page.close();
    }
});
