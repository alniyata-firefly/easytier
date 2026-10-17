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
const deviceA = '10000000-0000-4000-8000-000000000001', deviceB = '20000000-0000-4000-8000-000000000002';
const instanceA = '30000000-0000-4000-8000-000000000003', instanceB = '40000000-0000-4000-8000-000000000004';
const secret = 'synthetic-tunnel-secret-never-render';
const time = '2026-10-17T08:15:30+08:00';
const event = (kind, payload) => JSON.stringify({ time, event: { [kind]: payload } });
const endpoint = `wss://user:${secret}@vpn.example.test:9443/config/${secret}?token=${secret}#${secret}`;
const fixtureEvents = [
    event('ConfigPatched', { network_secret: secret }), event('CredentialChanged', secret),
    event('Connecting', endpoint), event('ConnectError', [endpoint, 'V6', `Connection timed out ${secret}`]),
    event('ConnectionAccepted', ['tcp://192.0.2.10:11010', 'tcp://198.51.100.20:23000']),
    event('ConnectionError', ['tcp://192.0.2.10:11010', 'tcp://198.51.100.20:23000', `Connection refused ${secret}`]),
    event('PeerAdded', 2633692368), event('PeerRemoved', 22),
    event('PeerConnAdded', { peer_id: 33, network_name: secret, noise_local_static_pubkey: secret,
        tunnel: { tunnel_type: 'udp', local_addr: { url: 'udp://192.0.2.10:11010' }, remote_addr: { url: 'udp://[2001:db8::2]:11010' } } }),
    event('PeerConnRemoved', { peerId: 44, noiseRemoteStaticPubkey: secret,
        tunnel: { tunnelType: 'tcp', localAddr: { url: 'tcp://192.0.2.10:11010' }, remoteAddr: { url: 'tcp://198.51.100.20:23000' } } }),
    `{broken-json ${secret}`, event('FutureEvent', secret),
];

test('real React tunnel journal displays typed safe events, request failures, languages and current instance ownership', { timeout: 60000 }, async context => {
    const temporary = await mkdtemp(join(tmpdir(), 'et-tunnel-journal-ui-'));
    context.after(() => rm(temporary, { recursive: true, force: true }));
    const outfile = join(temporary, 'fixture.js');
    const fixture = `import React from'react';import{createRoot}from'react-dom/client';import ApiClient from'./src/lib/api';
      import{TunnelEvents}from'./src/components/TunnelEvents';import{LanguageSwitch}from'./src/components/ui';import{i18nReady}from'./src/lib/i18n';
      const api=new ApiClient(location.origin);function Fixture(){const[target,setTarget]=React.useState({deviceId:${JSON.stringify(deviceA)},instanceId:${JSON.stringify(instanceA)}});
      window.__TARGET__=setTarget;return <><LanguageSwitch/><TunnelEvents api={api} {...target}/></>;}
      i18nReady.then(()=>createRoot(document.getElementById('root')).render(<React.Suspense fallback="Loading"><Fixture/></React.Suspense>));`;
    await esbuild.build({ stdin: { contents: fixture, resolveDir: frontend, loader: 'tsx' }, outfile, bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', loader: { '.svg': 'dataurl' }, logLevel: 'silent' });
    const bundle = await readFile(outfile), calls = [], held = [];
    let mode = 'normal', holdA = false;
    const server = createServer(async (request, response) => {
        const path = new URL(request.url, 'http://127.0.0.1').pathname;
        const json = (value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
        try {
            if (path === '/fixture.js') { response.setHeader('content-type', 'text/javascript'); response.end(bundle); }
            else if (path === '/style.css') { response.setHeader('content-type', 'text/css'); response.end(await readFile(join(frontend, 'src/style.css'))); }
            else if (path.startsWith('/locales/')) json(JSON.parse(await readFile(join(frontend, 'public', path), 'utf8')));
            else if (/^\/api\/v1\/machines\/[^/]+\/networks\/info$/.test(path)) {
                calls.push({ method: request.method, path });
                if (mode === 'failed') { json({ error: secret }, 503); return; }
                const id = path.split('/')[4];
                const map = mode === 'missing' ? {} : mode === 'unrelated' ? { [instanceA]: { running: true, events: [event('ConfigPatched', { network_secret: secret }), `{bad-json ${secret}`] } }
                    : id === deviceA ? { [instanceA]: { running: true, events: fixtureEvents }, [instanceB]: { running: true, events: [event('Connecting', 'udp://instance-b.example:11010')] } }
                    : { [instanceA]: { running: true, events: [event('PeerAdded', 99)] } };
                if (holdA && id === deviceA) await new Promise(resolve => held.push(resolve));
                if (!response.destroyed) json({ info: { map } });
            }
            else if (path === '/favicon.ico') response.writeHead(204).end();
            else if (path === '/') { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'); }
            else response.writeHead(404).end();
        } catch { if (!response.headersSent) response.writeHead(500); response.end(); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    context.after(() => { held.splice(0).forEach(release => release()); return new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); });
    const browser = await chromium.launch({ executablePath: process.env.ET_CHROMIUM_PATH || undefined, headless: true, args: ['--no-sandbox'] });
    context.after(() => browser.close());
    const page = await browser.newPage({ timezoneId: 'UTC', viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(7000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const rows = page.locator('.tunnel-event-table tbody tr');
    const proof = { scope: 'Current real React TunnelEvents and ApiClient, synthetic Core EventJournal JSON over loopback HTTP; no native Core or production', cases: [] };
    const step = async (name, action) => { await action(); proof.cases.push({ name, status: 'PASS' }); };
    await page.goto(`http://127.0.0.1:${server.address().port}`);

    await step('Only eight typed connection event kinds render, with sanitized endpoints and categorized reasons', async () => {
        await rows.first().waitFor(); assert.equal(await rows.count(), 8);
        await page.getByRole('heading', { name: '近期隧道事件', exact: true }).waitFor();
        const text = await page.locator('body').textContent();
        assert.ok(!text.includes(secret)); assert.ok(!text.includes('ConfigPatched')); assert.ok(!text.includes('CredentialChanged')); assert.ok(!text.includes('FutureEvent')); assert.ok(!text.includes('broken-json'));
        for (const value of ['正在建立隧道', '隧道连接失败', '已接受传输连接', '传输连接异常', '节点已连接', '节点已断开', '节点隧道已建立', '节点隧道已断开', 'wss://vpn.example.test:9443', '2633692368', '连接超时', '对端拒绝连接']) assert.ok(text.includes(value));
        const firstCells = await rows.first().locator('td').allTextContents();
        const expectedTime = await page.evaluate(value => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value)), time);
        assert.equal(firstCells[0], expectedTime); assert.equal(firstCells[3], 'WSS'); assert.equal(firstCells[5], 'wss://vpn.example.test:9443');
        assert.equal(await rows.nth(1).locator('.status.failed').count(), 1);
    });

    await step('Chinese and English labels switch without exposing raw event or failure payloads', async () => {
        await page.getByRole('combobox', { name: '语言', exact: true }).selectOption('en');
        await page.getByRole('heading', { name: 'Recent tunnel events', exact: true }).waitFor();
        await page.getByRole('columnheader', { name: 'Failure reason', exact: true }).waitFor();
        await page.getByText('Connection timed out', { exact: true }).waitFor();
        assert.equal(await rows.count(), 8); assert.ok(!(await page.locator('body').textContent()).includes(secret));
        await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN');
        await page.getByRole('heading', { name: '近期隧道事件', exact: true }).waitFor();
    });

    await step('Changing instance uses its own journal without mixing events from other running instances', async () => {
        await page.evaluate(target => window.__TARGET__(target), { deviceId: deviceA, instanceId: instanceB });
        await page.getByRole('cell', { name: 'udp://instance-b.example:11010', exact: true }).waitFor();
        assert.equal(await rows.count(), 1); assert.ok(!(await page.locator('body').textContent()).includes('2633692368'));
    });

    await step('A late response from the prior device cannot replace the new device journal', async () => {
        holdA = true; await page.getByRole('button', { name: '刷新', exact: true }).click();
        for (let i = 0; i < 100 && !held.length; i++) await new Promise(resolve => setTimeout(resolve, 20));
        assert.ok(held.length);
        await page.evaluate(target => window.__TARGET__(target), { deviceId: deviceB, instanceId: instanceA });
        await page.getByRole('cell', { name: '99', exact: true }).waitFor();
        holdA = false; held.splice(0).forEach(release => release()); await page.waitForTimeout(150);
        assert.equal(await rows.count(), 1); assert.equal(await page.getByRole('cell', { name: '99', exact: true }).count(), 1);
        assert.ok(!(await page.locator('body').textContent()).includes('instance-b.example'));
    });

    await step('Unavailable request or missing instance is explicit and never presented as empty successful history', async () => {
        mode = 'failed'; await page.getByRole('button', { name: '刷新', exact: true }).click();
        await page.getByRole('alert').waitFor(); assert.ok((await page.getByRole('alert').textContent()).includes('HTTP 503'));
        assert.equal(await rows.count(), 0); assert.ok(!(await page.locator('body').textContent()).includes(secret));
        assert.equal(await page.getByRole('heading', { name: '当前内存窗口暂无隧道连接事件', exact: true }).count(), 0);
        mode = 'missing'; await page.getByRole('button', { name: '刷新', exact: true }).click();
        await page.getByRole('alert').waitFor({ state: 'hidden' });
        await page.getByText('无法读取当前实例事件，请检查设备与实例状态。', { exact: true }).waitFor();
        assert.equal(await page.getByRole('heading', { name: '当前内存窗口暂无隧道连接事件', exact: true }).count(), 0);
    });

    await step('An available journal containing only unrelated or malformed events is a safe empty connection window', async () => {
        mode = 'unrelated'; await page.getByRole('button', { name: '刷新', exact: true }).click();
        await page.getByRole('heading', { name: '当前内存窗口暂无隧道连接事件', exact: true }).waitFor();
        assert.equal(await page.getByRole('alert').count(), 0); assert.ok(!(await page.locator('body').textContent()).includes(secret));
    });

    assert.deepEqual(errors, []); assert.ok(calls.length > 0 && calls.every(call => call.method === 'GET'));
    proof.status = 'PASS'; proof.scenarioChecks = proof.cases.length; proof.tapLeafCases = 1; proof.pageErrors = errors;
    proof.nativeBuildExecuted = false; proof.productionChanged = false;
    if (process.env.ET_TUNNEL_EVENTS_QA_OUTPUT) {
        await mkdir(process.env.ET_TUNNEL_EVENTS_QA_OUTPUT, { recursive: true, mode: 0o700 });
        await writeFile(join(process.env.ET_TUNNEL_EVENTS_QA_OUTPUT, 'proof.json'), JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 });
    }
    console.log(JSON.stringify(proof));
});
