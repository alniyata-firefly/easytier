import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(frontend, '../..');
const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve('vite'))('esbuild');

for (const target of ['web', 'gui']) test(`${target} advanced controls save real protobuf payloads without losing defaults`, { timeout: 90000 }, async context => {
    const directory = await mkdtemp(join(tmpdir(), 'et-advanced-node-ui-'));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const base = target === 'web' ? frontend : join(root, 'easytier-gui');
    const code = target === 'web' ? join(base, 'src') : join(base, 'src/react');
    const labels = JSON.parse(await readFile(join(base, 'public/locales/zh-CN/node-config.json')));
    const fixture = `import React,{useState}from'react';import{createRoot}from'react-dom/client';
    import{NodeParameters}from${JSON.stringify(join(code, 'components/NodeParameters.tsx'))};
    import{applyNodePatch,prepareNodeParametersForBackend}from${JSON.stringify(join(code, 'lib/node-config.ts'))};
    import{NetworkTypes}from${JSON.stringify(join(code, 'lib/shared.ts'))};
    import{i18nReady}from${JSON.stringify(join(code, 'lib/i18n.ts'))};
    const initial={instance_name:'Original instance',mtu:1280,enable_socks5:true,socks5_port:1080,socks5_proxy:'socks5://[::1]:1080',future:{keep:true}};window.__CAPTURE__=[];
    function Fixture(){const[value,setValue]=useState(initial);const[valid,setValid]=useState(true);return <main style={{maxWidth:840,margin:'24px auto',padding:16}}><NodeParameters mode="instance" value={value} supportsUplinkSelection={true} onPatch={patch=>setValue(old=>applyNodePatch(old,patch))} onValidityChange={setValid}/><button id="save" disabled={!valid} onClick={()=>window.__CAPTURE__.push({raw:structuredClone(value),json:NetworkTypes.toBackendNetworkConfig({...NetworkTypes.DEFAULT_NETWORK_CONFIG(),...prepareNodeParametersForBackend(value)})})}>Save fixture</button></main>};i18nReady.then(()=>createRoot(document.getElementById('root')).render(<React.Suspense fallback="Loading"><Fixture/></React.Suspense>));`;
    const outfile = join(directory, 'fixture.js');
    await esbuild.build({ stdin: { contents: fixture, resolveDir: frontend, loader: 'tsx' }, outfile, bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', loader: { '.svg': 'dataurl' }, logLevel: 'silent' });
    const bundle = await readFile(outfile);
    const server = createServer(async (request, response) => {
        try {
            const path = new URL(request.url, 'http://127.0.0.1').pathname;
            if (path === '/fixture.js') { response.setHeader('content-type', 'text/javascript'); response.end(bundle); }
            else if (path === '/style.css') { response.setHeader('content-type', 'text/css'); response.end(await readFile(join(code, 'style.css'))); }
            else if (path.startsWith('/locales/')) { response.setHeader('content-type', 'application/json'); response.end(await readFile(join(base, 'public', path))); }
            else if (path === '/') { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'); }
            else response.writeHead(404).end();
        } catch { response.writeHead(404).end(); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    context.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const browser = await chromium.launch({ executablePath: process.env.ET_CHROMIUM_PATH || (existsSync('/root/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome') ? '/root/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' : undefined), headless: true, args: ['--no-sandbox'] });
    context.after(() => browser.close());
    const page = await browser.newPage(); page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const text = key => page.getByRole('textbox', { name: labels.fields[key], exact: true });
    const select = key => page.getByRole('combobox', { name: labels.fields[key], exact: true });
    const checked = key => page.getByRole('checkbox', { name: labels.fields[key], exact: true });
    await select('socks5_mode').waitFor();
    assert.equal(await select('socks5_mode').inputValue(), 'custom');
    assert.equal(await checked('enable_socks5').count(), 0);
    assert.equal(await text('socks5_proxy').inputValue(), 'socks5://[::1]:1080');
    await select('encryption_algorithm').selectOption('aes-256-gcm');
    await select('default_protocol').selectOption('udp');
    await text('tld_dns_zone').fill('sites.example.');
    await text('instance_name').fill('Custom instance');
    await text('virtual_ipv6').fill('fd00:7::42/64');
    await text('socket_mark').fill('0');
    await text('instance_recv_bps_limit').fill('0');
    await text('foreign_relay_bps_limit').fill('18446744073709551615');
    await checked('disable_relay_kcp').check();
    await checked('enable_relay_foreign_network_quic').check();
    await select('stun_servers').selectOption('custom');
    const stunEntries = page.getByRole('textbox', { name: labels.lists.entries.replace('{{field}}', labels.fields.stun_servers), exact: true });
    await stunEntries.fill('stun.example.test\n[2001:db8::1]:3478');
    await select('tcp_stun_servers').selectOption('disabled');
    await select('tcp_whitelist').selectOption('custom');
    await page.getByRole('textbox', { name: labels.lists.entries.replace('{{field}}', labels.fields.tcp_whitelist), exact: true }).fill('80\n8000-8100');
    await select('udp_whitelist').selectOption('disabled');
    await select('socks5_mode').selectOption('disabled');
    await page.locator('#save').click();
    const first = await page.evaluate(() => window.__CAPTURE__[0]);
    for (const key of ['raw', 'json']) {
        const value = first[key];
        assert.equal(String(value.instance_recv_bps_limit), '0');
        assert.equal(String(value.foreign_relay_bps_limit), '18446744073709551615');
        assert.equal(value.socket_mark, 0);
        assert.equal(value.virtual_ipv6, 'fd00:7::42/64');
        assert.equal(value.instance_name, 'Custom instance');
        assert.equal(value.encryption_algorithm, 'aes-256-gcm');
        assert.deepEqual(value.stun_servers, { values: ['stun.example.test', '[2001:db8::1]:3478'] });
        assert.deepEqual(value.tcp_stun_servers, { values: [] });
        assert.deepEqual(value.tcp_whitelist, { values: ['80', '8000-8100'] });
        assert.deepEqual(value.udp_whitelist, { values: [] });
        assert.equal(value.socks5_proxy, '');
        assert.equal(value.enable_relay_foreign_network_quic, true);
    }
    assert.deepEqual(first.raw.future, { keep: true });
    await select('stun_servers').selectOption('default');
    await select('tcp_stun_servers').selectOption('custom');
    await page.getByRole('textbox', { name: labels.lists.entries.replace('{{field}}', labels.fields.tcp_stun_servers), exact: true }).fill('tcp-stun.example.test:3478');
    await select('socks5_mode').selectOption('port');
    await checked('enable_socks5').uncheck();
    await page.locator('#save').click();
    const second = await page.evaluate(() => window.__CAPTURE__[1]);
    for (const key of ['raw', 'json']) {
        assert.equal(second[key].stun_servers, undefined);
        assert.deepEqual(second[key].tcp_stun_servers, { values: ['tcp-stun.example.test:3478'] });
        assert.equal(second[key].socks5_proxy, undefined);
        assert.equal(second[key].enable_socks5, false);
    }
    await text('foreign_relay_bps_limit').fill('18446744073709551616');
    assert.equal(await page.locator('#save').isDisabled(), true);
    await text('foreign_relay_bps_limit').fill('0');
    assert.equal(await page.locator('#save').isEnabled(), true);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
});

test('Web file logger submits zero and preserves a failed selection for retry', { timeout: 60000 }, async context => {
    const directory = await mkdtemp(join(tmpdir(), 'et-file-log-ui-'));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const fixture = `import React from'react';import{createRoot}from'react-dom/client';import{InstanceLogger}from${JSON.stringify(join(frontend, 'src/components/InstanceRuntimePanels.tsx'))};import ApiClient from${JSON.stringify(join(frontend, 'src/lib/api.ts'))};import{i18nReady}from${JSON.stringify(join(frontend, 'src/lib/i18n.ts'))};const api=new ApiClient(location.origin);i18nReady.then(()=>createRoot(document.getElementById('root')).render(<React.Suspense fallback="Loading"><InstanceLogger api={api} deviceId="synthetic-device"/></React.Suspense>));`;
    const outfile = join(directory, 'fixture.js');
    await esbuild.build({ stdin: { contents: fixture, resolveDir: frontend, loader: 'tsx' }, outfile, bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', loader: { '.svg': 'dataurl' }, logLevel: 'silent' });
    const bundle = await readFile(outfile), writes = [];
    let level = 2;
    const server = createServer(async (request, response) => {
        try {
            const path = new URL(request.url, 'http://127.0.0.1').pathname;
            if (path.endsWith('/proxy-rpc')) {
                const chunks = []; for await (const chunk of request) chunks.push(chunk);
                const body = JSON.parse(Buffer.concat(chunks).toString());
                response.setHeader('content-type', 'application/json');
                assert.equal(body.service_name, 'api.logger.LoggerRpcService');
                if (body.method_name === 'set_logger_config') {
                    writes.push(body.payload.level);
                    if (body.payload.level === 5) { response.writeHead(500).end('{}'); return; }
                    level = body.payload.level; response.end('{}');
                } else response.end(JSON.stringify({ level }));
            } else if (path === '/fixture.js') { response.setHeader('content-type', 'text/javascript'); response.end(bundle); }
            else if (path.startsWith('/locales/')) { response.setHeader('content-type', 'application/json'); response.end(await readFile(join(frontend, 'public', path))); }
            else if (path === '/') { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><html><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'); }
            else response.writeHead(404).end();
        } catch (error) { response.writeHead(500).end(error.message); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    context.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const browser = await chromium.launch({ executablePath: process.env.ET_CHROMIUM_PATH || (existsSync('/root/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome') ? '/root/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' : undefined), headless: true, args: ['--no-sandbox'] });
    context.after(() => browser.close());
    const page = await browser.newPage(); page.setDefaultTimeout(7000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const selector = page.getByRole('combobox', { name: '文件日志级别', exact: true });
    const save = page.getByRole('button', { name: '保存文件日志级别', exact: true });
    await selector.waitFor(); assert.equal(await selector.inputValue(), '2');
    await selector.selectOption('0'); await save.click();
    await page.waitForFunction(() => document.querySelector('select')?.value === '0' && document.querySelector('button[type="submit"]')?.disabled === true);
    assert.equal(level, 0);
    await selector.selectOption('5'); await save.click();
    await page.getByRole('alert').filter({ hasText: '保存日志级别失败' }).waitFor();
    assert.equal(await selector.inputValue(), '5'); assert.equal(level, 0);
    await selector.selectOption('1'); await save.click();
    await page.waitForFunction(() => document.querySelector('select')?.value === '1' && document.querySelector('button[type="submit"]')?.disabled === true);
    assert.equal(level, 1); assert.deepEqual(writes, [0, 5, 1]);
    assert.equal(await page.getByRole('alert').count(), 0);
    assert.deepEqual(errors, []);
});
