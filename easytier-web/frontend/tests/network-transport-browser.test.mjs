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
    network_id: '4f9407e5-c72a-4542-af12-9504c8671995',
    display_name: 'Synthetic transport network', network_name: 'synthetic-identity',
    networking_method: 'Manual', public_server_url: null,
    peer_urls: ['udp://127.0.0.1:22020', 'tcp://[::1]:22021'],
    virtual_cidr: '10.66.0.0/24', secure_mode: true, prefer_ipv6: true,
    network_secret: 'synthetic-network-secret', member_count: 2,
    transport: { data_compress_algo: 2, enable_kcp_proxy: false, disable_kcp_input: false, enable_quic_proxy: true, disable_quic_input: true, encryption_algorithm: 'chacha20', disable_encryption: true, default_protocol: 'udp', tld_dns_zone: 'nodes.example.' },
};

for (const language of ['zh-CN', 'en']) test(`network transport round trips and node controls in ${language}`, { timeout: 60000 }, async context => {
    const temporary = await mkdtemp(join(tmpdir(), 'et-network-transport-'));
    context.after(() => rm(temporary, { recursive: true, force: true }));
    const outfile = join(temporary, 'fixture.js');
    const fixture = `import React,{useState} from 'react';import{createRoot}from'react-dom/client';
    import{NetworkSettingsForm}from${JSON.stringify(join(frontend, 'src/components/NetworkSettingsForm.tsx'))};
    import{NodeParameters}from${JSON.stringify(join(frontend, 'src/components/NodeParameters.tsx'))};
    import{applyNodePatch}from${JSON.stringify(join(frontend, 'src/lib/node-config.ts'))};
    import ApiClient from${JSON.stringify(join(frontend, 'src/lib/api.ts'))};
    import{i18nReady}from${JSON.stringify(join(frontend, 'src/lib/i18n.ts'))};
    const api=new ApiClient(location.origin);const initial=${JSON.stringify(initial)};
    function Fixture(){const[network,setNetwork]=useState(initial);const[open,setOpen]=useState(true);const[revision,setRevision]=useState(0);const[busy,setBusy]=useState(false);const[mode,setMode]=useState('member');const[node,setNode]=useState({mtu:1280,enable_kcp_proxy:true,disable_quic_input:false,future:{preserved:true}});
    return <main style={{maxWidth:840,margin:'24px auto',padding:16}}><section id="network-editor">{open&&<NetworkSettingsForm key={revision} network={network} gateway={{enabled:true,peer_url:'udp://127.0.0.1:22020',relay_data:true}} busy={busy} onSave={async(settings,secret)=>{setBusy(true);try{window.__SAVED__=network?await api.update_network(network.network_id,settings,secret):await api.create_network(settings,secret);setOpen(false)}finally{setBusy(false)}}}/>}</section>
    <button id="reopen" onClick={async()=>{setNetwork(await api.get_network(initial.network_id));setRevision(n=>n+1);setOpen(true)}}>Reopen fixture</button>
    <button id="new-network" onClick={()=>{setNetwork(undefined);setRevision(n=>n+1);setOpen(true)}}>New fixture</button>
    <section id="node-editor"><NodeParameters mode={mode} supportsUplinkSelection={false} value={node} onPatch={patch=>setNode(old=>applyNodePatch(old,patch))}/><button id="node-mode" onClick={()=>setMode(old=>old==='member'?'instance':'member')}>Switch node mode</button><pre id="node-value" style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(node)}</pre></section></main>}
    i18nReady.then(()=>createRoot(document.getElementById('root')).render(<React.Suspense fallback="Loading"><Fixture/></React.Suspense>));`;
    await esbuild.build({ stdin: { contents: fixture, resolveDir: frontend, loader: 'tsx' }, outfile, bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', loader: { '.svg': 'dataurl' }, logLevel: 'silent' });
    const bundle = await readFile(outfile);
    let stored = structuredClone(initial);
    const requests = [];
    const server = createServer(async (request, response) => {
        try {
            const path = new URL(request.url, 'http://127.0.0.1').pathname;
            if (path.startsWith('/api/v1/networks')) {
                response.setHeader('content-type', 'application/json');
                if (request.method === 'GET') { response.end(JSON.stringify(stored)); return; }
                const chunks = []; for await (const chunk of request) chunks.push(chunk);
                const body = JSON.parse(Buffer.concat(chunks).toString());
                requests.push({ method: request.method, path, body });
                stored = { ...stored, ...body.settings };
                response.end(JSON.stringify(stored));
            } else if (path === '/fixture.js') { response.setHeader('content-type', 'text/javascript'); response.end(bundle); }
            else if (path === '/style.css') { response.setHeader('content-type', 'text/css'); response.end(await readFile(join(frontend, 'src/style.css'))); }
            else if (path.startsWith('/locales/')) { response.setHeader('content-type', 'application/json'); response.end(await readFile(join(frontend, 'public', path))); }
            else if (path === '/') { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'); }
            else response.writeHead(404).end();
        } catch (error) { response.writeHead(500).end(error.message); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    context.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const browser = await chromium.launch({ executablePath: process.env.ET_CHROMIUM_PATH || undefined, headless: true, args: ['--no-sandbox'] });
    context.after(() => browser.close());
    const browserContext = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    await browserContext.addInitScript(locale => localStorage.setItem('easytier.locale', locale), language);
    const page = await browserContext.newPage(); page.setDefaultTimeout(7000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const locale = JSON.parse(await readFile(join(frontend, 'public/locales', language, 'networks.json')));
    const nodeLocale = JSON.parse(await readFile(join(frontend, 'public/locales', language, 'node-config.json')));
    const editor = page.locator('#network-editor');
    const select = key => editor.getByRole('combobox', { name: locale.transport[key === 'tld_dns_zone' ? 'tld_dns_zone_mode' : key], exact: true });
    const save = () => editor.getByRole('button', { name: locale.settings.save, exact: true }).click();
    await select('data_compress_algo').waitFor();
    assert.equal(await select('data_compress_algo').inputValue(), '2');
    assert.equal(await select('enable_kcp_proxy').inputValue(), 'disabled');
    assert.equal(await select('disable_kcp_input').inputValue(), 'enabled');
    assert.equal(await select('enable_quic_proxy').inputValue(), 'enabled');
    assert.equal(await select('disable_quic_input').inputValue(), 'disabled');
    assert.equal(await select('disable_encryption').inputValue(), 'disabled');
    assert.equal(await select('encryption_algorithm').inputValue(), 'chacha20');
    assert.equal(await select('default_protocol').inputValue(), 'udp');
    assert.equal(await editor.getByRole('textbox', {name:locale.transport.tld_dns_zone,exact:true}).inputValue(), 'nodes.example.');
    await save(); await page.waitForFunction(() => Boolean(window.__SAVED__));
    assert.deepEqual(requests[0].body.settings, {
        display_name: initial.display_name, network_name: initial.network_name,
        networking_method: initial.networking_method, public_server_url: null,
        peer_urls: initial.peer_urls, virtual_cidr: initial.virtual_cidr,
        secure_mode: true, prefer_ipv6: true, transport: initial.transport,
    });
    await page.locator('#reopen').click(); await select('data_compress_algo').waitFor();
    await select('data_compress_algo').selectOption('1');
    await select('enable_kcp_proxy').selectOption('enabled');
    await select('disable_kcp_input').selectOption('disabled');
    await select('enable_quic_proxy').selectOption('disabled');
    await select('disable_quic_input').selectOption('enabled');
    await select('disable_encryption').selectOption('enabled');
    await select('encryption_algorithm').selectOption('aes-256-gcm');
    await select('default_protocol').selectOption('tcp');
    await editor.getByRole('textbox',{name:locale.transport.tld_dns_zone,exact:true}).fill('next.example.');
    await save(); await editor.getByRole('combobox').first().waitFor({ state: 'hidden' });
    const changed = { data_compress_algo: 1, enable_kcp_proxy: true, disable_kcp_input: true, enable_quic_proxy: false, disable_quic_input: false, encryption_algorithm: 'aes-256-gcm', disable_encryption: false, default_protocol: 'tcp', tld_dns_zone: 'next.example.' };
    assert.deepEqual(requests[1].body.settings.transport, changed);
    assert.equal(requests[1].body.network_secret, undefined);
    await page.locator('#reopen').click(); await select('data_compress_algo').waitFor();
    assert.equal(await select('data_compress_algo').inputValue(), '1');
    assert.equal(await select('enable_quic_proxy').inputValue(), 'disabled');
    assert.equal(await select('disable_quic_input').inputValue(), 'enabled');
    await select('enable_kcp_proxy').selectOption('inherit');
    await save(); await editor.getByRole('combobox').first().waitFor({ state: 'hidden' });
    const partial = { ...changed }; delete partial.enable_kcp_proxy;
    assert.deepEqual(requests[2].body.settings.transport, partial);
    await page.locator('#reopen').click(); await select('enable_kcp_proxy').waitFor();
    assert.equal(await select('enable_kcp_proxy').inputValue(), 'inherit');
    for (const key of Object.keys(initial.transport)) await select(key).selectOption('inherit');
    await save(); await editor.getByRole('combobox').first().waitFor({ state: 'hidden' });
    assert.deepEqual(requests[3].body.settings.transport, {});
    assert.equal(requests[3].body.settings.secure_mode, true);
    assert.equal(requests[3].body.settings.prefer_ipv6, true);
    await page.locator('#reopen').click(); await select('data_compress_algo').waitFor();
    for (const key of Object.keys(initial.transport)) assert.equal(await select(key).inputValue(), 'inherit');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.locator('#new-network').click(); await select('data_compress_algo').waitFor();
    for (const key of Object.keys(initial.transport)) assert.equal(await select(key).inputValue(), 'inherit');
    await editor.getByRole('textbox', { name: locale.settings.name, exact: true }).fill('Synthetic new network');
    await editor.getByRole('button', { name: locale.list.create, exact: true }).click();
    await editor.getByRole('combobox').first().waitFor({ state: 'hidden' });
    assert.equal(requests[4].method, 'POST');
    assert.deepEqual(requests[4].body.settings.transport, {});
    const node = page.locator('#node-editor');
    for (const key of ['enable_kcp_proxy', 'disable_kcp_input', 'enable_quic_proxy', 'disable_quic_input']) assert.equal(await node.getByRole('checkbox', { name: nodeLocale.fields[key], exact: true }).count(), 0);
    assert.equal(await node.getByRole('combobox', { name: nodeLocale.fields.data_compress_algo, exact: true }).count(), 0);
    const snapshot = () => page.locator('#node-value').textContent().then(JSON.parse);
    assert.equal((await snapshot()).enable_kcp_proxy, true);
    await page.locator('#node-mode').click();
    for (const key of ['enable_kcp_proxy', 'disable_kcp_input', 'enable_quic_proxy', 'disable_quic_input']) assert.equal(await node.getByRole('checkbox', { name: nodeLocale.fields[key], exact: true }).count(), 1);
    const compression = node.getByRole('combobox', { name: nodeLocale.fields.data_compress_algo, exact: true });
    assert.equal(await compression.inputValue(), 'default');
    await compression.selectOption('2'); assert.equal((await snapshot()).data_compress_algo, 2);
    await compression.selectOption('1'); assert.equal((await snapshot()).data_compress_algo, 1);
    await compression.selectOption('default');
    assert.deepEqual(await snapshot(), { mtu: 1280, enable_kcp_proxy: true, disable_quic_input: false, future: { preserved: true } });
    assert.equal(await node.getByRole('checkbox', { name: nodeLocale.fields.enable_kcp_proxy, exact: true }).isChecked(), true);
    assert.deepEqual(errors, []);
});
