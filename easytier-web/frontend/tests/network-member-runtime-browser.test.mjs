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

test('member runtime queries stay separate from connection, instance and deployment states', { timeout: 90000 }, async context => {
    const directory = await mkdtemp(join(tmpdir(), 'et-member-runtime-ui-'));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const fixture = `import React,{useState}from'react';import{createRoot}from'react-dom/client';
        import{NetworkMembers}from'./src/components/NetworkMembers';
        import{NoticeProvider}from'./src/components/ui';
        import i18n,{i18nReady}from'./src/lib/i18n';
        const networkDummy={network_id:'20000000-0000-4000-8000-000000000001',display_name:'Fixture network',network_name:'fixture-network',networking_method:'Standalone',virtual_cidr:'10.80.0.0/24',secure_mode:false,member_count:1,network_secret:'synthetic-fixture-only',peer_urls:[]};
        const memberDummy={member_id:'30000000-0000-4000-8000-000000000001',device_id:'10000000-0000-4000-8000-000000000001',hostname:'Android fixture',hostname_override:null,virtual_ipv4:null,allocated_ipv4:'10.80.0.2',online:true,running:null,runtime_virtual_ipv4:null,version:'2.7.2',error_msg:null,runtime_query_error:'timeout',deployment:{state:'applied',desired_revision:'fixture-revision',applied_revision:'fixture-revision',last_error:null}};
        window.__WRITES__=[];
        const mockApi={list_machines:async()=>[],clear_snapshots:()=>{},remove_network_member:async()=>window.__WRITES__.push('remove'),add_network_members:async()=>window.__WRITES__.push('add'),set_member_config:async()=>window.__WRITES__.push('set')};
        function Fixture(){const[scenario,setScenario]=useState('timeout');window.__SCENARIO__=setScenario;
            const member={...memberDummy,deployment:{...memberDummy.deployment}};
            if(scenario==='unavailable')member.runtime_query_error='unavailable';
            if(scenario==='offline'||scenario==='offline-errors'){member.online=false;member.deployment.state='waiting_offline';}
            if(scenario==='errors'||scenario==='offline-errors'){member.error_msg='Fixture instance startup failed';member.deployment.state='failed';member.deployment.last_error='Fixture publication failed';}
            if(scenario==='recovered'||scenario==='legacy'){member.running=true;member.runtime_virtual_ipv4='10.80.0.2/24';if(scenario==='legacy')delete member.runtime_query_error;else member.runtime_query_error=null;}
            if(scenario==='query-failed')member.running=true;
            return <main data-scenario={scenario}><NetworkMembers api={mockApi} network={networkDummy} members={[member]} temporaryPeers={[]} loading={false} managementUnknown={scenario==='query-failed'} onChanged={()=>{}} onObserve={()=>{}}/></main>;
        }
        i18nReady.then(async()=>{await i18n.changeLanguage(new URLSearchParams(location.search).get('lang')||'zh-CN');createRoot(document.getElementById('root')).render(<React.Suspense fallback="Loading"><NoticeProvider><Fixture/></NoticeProvider></React.Suspense>);});`;
    const outfile = join(directory, 'fixture.js');
    await esbuild.build({ stdin: { contents: fixture, resolveDir: frontend, loader: 'tsx' }, outfile, bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', loader: { '.svg': 'dataurl' }, logLevel: 'silent' });
    const bundle = await readFile(outfile);
    const server = createServer(async (request, response) => {
        try {
            const path = new URL(request.url, 'http://127.0.0.1').pathname;
            if (path === '/fixture.js') { response.setHeader('content-type', 'text/javascript'); response.end(bundle); }
            else if (path === '/style.css') { response.setHeader('content-type', 'text/css'); response.end(await readFile(join(frontend, 'src/style.css'))); }
            else if (path.startsWith('/locales/')) { response.setHeader('content-type', 'application/json'); response.end(await readFile(join(frontend, 'public', path))); }
            else if (path === '/favicon.ico') response.writeHead(204).end();
            else if (path === '/') { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'); }
            else response.writeHead(404).end();
        } catch { response.writeHead(404).end(); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    context.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const browser = await chromium.launch({ executablePath: process.env.ET_CHROMIUM_PATH || undefined, headless: true, args: ['--no-sandbox'] });
    context.after(() => browser.close());
    const proof = { scope: 'Real React NetworkMembers and Chromium with mocked API/member fixtures; no native Core, production or physical Android test', cases: [] };
    for (const language of ['zh-CN', 'en']) {
        const labels = JSON.parse(await readFile(join(frontend, `public/locales/${language}/networks.json`))).members;
        const managementLabels = JSON.parse(await readFile(join(frontend, `public/locales/${language}/common.json`))).managementStatus;
        const page = await browser.newPage();
        page.setDefaultTimeout(7000);
        const errors = [], failedRequests = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('requestfailed', request => failedRequests.push(request.url()));
        await page.goto(`http://127.0.0.1:${server.address().port}/?lang=${language}`);
        const row = page.locator('article.member-row');
        const queryNotice = row.locator('small[role="status"]');
        const scenario = async value => {
            await page.evaluate(next => window.__SCENARIO__(next), value);
            await page.locator(`main[data-scenario="${value}"]`).waitFor();
        };
        await row.waitFor();
        assert.equal(await queryNotice.textContent(), labels.runtimeQueryTimeout);
        assert.ok((await row.textContent()).includes(labels.runningUnknown));
        assert.equal(await row.locator('.status.applied').count(), 1);
        assert.equal(await row.locator('.status.failed,.error-text').count(), 0);
        assert.equal(await queryNotice.evaluate(element => element.classList.contains('error-text')), false);
        assert.ok(!(await row.textContent()).includes('Timeout: deadline has elapsed'));
        proof.cases.push({ language, scenario: 'online timeout', result: 'unknown runtime with localized muted notice; applied config unchanged' });

        await scenario('unavailable');
        assert.equal(await queryNotice.textContent(), labels.runtimeQueryUnavailable);
        assert.equal(await row.locator('.status.applied').count(), 1);
        proof.cases.push({ language, scenario: 'online unavailable', result: 'localized non-error runtime notice' });

        await scenario('offline');
        assert.equal(await queryNotice.count(), 0);
        assert.ok((await row.textContent()).includes(managementLabels.offline));
        assert.equal(await row.locator('.status.waiting_offline').count(), 1);
        proof.cases.push({ language, scenario: 'offline with stale timeout', result: 'offline shown and stale query notice absent' });

        await scenario('errors');
        assert.equal(await queryNotice.textContent(), labels.runtimeQueryTimeout);
        assert.equal(await row.locator('.error-text').count(), 2);
        assert.equal(await row.getByText('Fixture instance startup failed', { exact: true }).count(), 1);
        assert.equal(await row.getByText('Fixture publication failed', { exact: true }).count(), 1);
        assert.equal(await row.locator('.status.failed').count(), 1);
        proof.cases.push({ language, scenario: 'real runtime and publication failures', result: 'both real errors retained independently of query notice' });

        await scenario('offline-errors');
        assert.equal(await queryNotice.count(), 0);
        assert.equal(await row.locator('.error-text').count(), 2);
        assert.equal(await row.locator('.status.failed').count(), 1);
        proof.cases.push({ language, scenario: 'offline real failures', result: 'real errors retained; stale query notice absent' });

        await scenario('query-failed');
        assert.ok((await row.textContent()).includes(managementLabels.unknown));
        assert.ok((await row.textContent()).includes(labels.runningUnknown));
        assert.equal(await row.locator('.status.unknown').count(), 1);
        assert.equal(await row.locator('.status.applied').count(), 0);
        assert.ok(!(await row.textContent()).includes('fixture-'));
        proof.cases.push({ language, scenario: 'failed member refresh with retained data', result: 'management, runtime and deployment state unknown; internal revision summary absent' });

        await scenario('recovered');
        assert.equal(await queryNotice.count(), 0);
        assert.ok((await row.textContent()).includes(labels.running));
        assert.equal(await row.locator('.status.applied').count(), 1);
        assert.equal(await row.locator('.error-text').count(), 0);
        proof.cases.push({ language, scenario: 'reconnected and recovered', result: 'running shown and query notice cleared' });

        await scenario('legacy');
        assert.equal(await queryNotice.count(), 0);
        assert.ok((await row.textContent()).includes(labels.running));
        assert.deepEqual(await page.evaluate(() => window.__WRITES__), []);
        assert.deepEqual(errors, []);
        assert.deepEqual(failedRequests, []);
        proof.cases.push({ language, scenario: 'legacy optional field omitted', result: 'running shown; no writes or browser errors' });
        await page.close();
    }
    proof.status = 'PASS';
    proof.case_count = proof.cases.length;
    if (process.env.ET_MEMBER_RUNTIME_QA_OUTPUT) {
        await mkdir(process.env.ET_MEMBER_RUNTIME_QA_OUTPUT, { recursive: true, mode: 0o700 });
        await writeFile(join(process.env.ET_MEMBER_RUNTIME_QA_OUTPUT, 'proof.json'), JSON.stringify(proof, null, 2), { mode: 0o600 });
    }
    console.log(JSON.stringify(proof));
});
