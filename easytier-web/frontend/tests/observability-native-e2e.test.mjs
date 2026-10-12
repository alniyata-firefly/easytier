// No mock APIs: browser -> owner-scoped Web -> native Core -> actual VM scrape/query.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium } from 'playwright';
import {
  webBinary, coreBinary, requireBinaries, freePort, waitFor, startWeb, startCore, stopCore,
  seedUser, seedOfflineDevice, httpApi, protoUuid, trackSecret, assertNoSecretLogs, maskSecrets,
} from './e2e-native-helpers.mjs';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const vmBinary = process.env.ET_VM_BIN || join(workspace, 'tools/victoriametrics-1.153.0/victoria-metrics-prod');
const passwordHash = '$argon2id$v=19$m=4096,t=3,p=1$ZWFzeXRpZXItZTJlLXNhbHQ$FHbDjVElaTXuArgEEQrQrO4AdsnqNOcXGA5PFY8cG/s';
const field = (value, key) => value?.[key] ?? value?.[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];

test('native resources, read-only collection and stored owner-scoped history render in the actual browser',
  { timeout: 240000 }, async () => {
    await requireBinaries(webBinary, coreBinary, vmBinary);
    const directory = join(process.env.ET_NATIVE_E2E_OUTPUT || join(workspace, 'validation'), `observability-native-${Date.now()}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const database = join(directory, 'web.db');
    const ports = { api: await freePort(), config: await freePort(), vm: await freePort() };
    const base = `http://127.0.0.1:${ports.api}`, vmBase = `http://127.0.0.1:${ports.vm}`;
    const machineId = randomUUID(), username = 'observability-owner';
    const token = trackSecret(randomBytes(32).toString('base64url'));
    const tokenFile = join(directory, 'collector.token'), scrapeFile = join(directory, 'scrape.yml');
    await writeFile(tokenFile, token, { mode: 0o600 });
    const processes = [], proof = { scope: 'actual Web/Core/VictoriaMetrics/Chromium, no TUN or API interception',
      ports, checks: [] };
    let api, other, browser, networkId, core;
    const check = name => { proof.checks.push({ name, status: 'PASS' }); console.log(`PASS ${name}`); };
    const fetchCollector = path => fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
    try {
      const bootstrap = startWeb(database, ports.api, ports.config, '127.0.0.1', { gateway: false, logLevel: 'warn' });
      processes.push(bootstrap);
      await waitFor(() => fetch(`${base}/auth/config`).then(response => response.ok), 'bootstrap migrations');
      await stopCore(bootstrap);
      const ownerId = seedUser(database, username, passwordHash);
      seedUser(database, 'observability-other', passwordHash);
      seedOfflineDevice(database, ownerId, machineId, 'Native resource node');
      const web = startWeb(database, ports.api, ports.config, '127.0.0.1', { protocol: 'tcp', gateway: true, logLevel: 'warn',
        extraArgs: ['--metrics-history-url', vmBase, '--metrics-web-id', 'observability-native',
          '--metrics-collector-token-file', tokenFile, '--metrics-collector-user-id', String(ownerId),
          '--metrics-collector-base-url', base] });
      processes.push(web); api = httpApi(base); other = httpApi(base);
      await waitFor(() => api.raw('GET', '/auth/config').then(response => response.ok), 'observability Web');
      const password = createHash('md5').update('e2e-password').digest('hex');
      await api.post('auth/login', { username, password });
      await other.post('auth/login', { username: 'observability-other', password });
      const capabilities = await api.get('observability/capabilities');
      assert.equal(capabilities.history_available, true);
      assert.ok(capabilities.metrics.some(metric => metric.id === 'host_memory_used_bytes'));
      assert.equal((await fetch(`${base}/api/metrics/discovery`)).status, 401);
      assert.equal((await fetch(`${base}/api/metrics/discovery`, { headers: { 'X-Internal-Auth': token } })).status, 401);
      const denied = await fetch(`${base}/api/v1/machines`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'manual' });
      assert.ok([302, 401, 403].includes(denied.status), 'collector token cannot access management APIs');
      check('optional history capability and collector-only authorization');

      const credential = await api.post('device-access-tokens', { label: 'Native resources', machine_id: machineId });
      const network = await api.post('networks', { settings: { display_name: 'Native Observability',
        network_name: `observability-${randomUUID()}`, networking_method: 'Gateway', peer_urls: [],
        virtual_cidr: '10.246.250.0/29', secure_mode: true }, network_secret: trackSecret(randomBytes(32).toString('base64url')) });
      networkId = network.network_id;
      await api.post(`networks/${networkId}/members`, { device_ids: [machineId], temporary: false }, 204);
      await api.put(`networks/${networkId}/members/${machineId}/config`, { config: { no_tun: true,
        disable_upnp: true, bind_device: false, disable_p2p: true, multi_thread: false,
        disable_udp_hole_punching: true, disable_tcp_hole_punching: true, listener_urls: ['tcp://127.0.0.1:0'] } });
      await mkdir(join(directory, 'core'), { mode: 0o700 });
      core = startCore(join(directory, 'core'), '127.0.0.1', ports.config, credential.token,
        { protocol: 'tcp', machineId, hostname: 'Native resource node', logLevel: 'warn' });
      processes.push(core);
      await waitFor(async () => (await api.get(`networks/${networkId}`)).deployment?.state === 'applied', 'actual managed Core', 45000);
      const stats = () => api.post(`machines/${machineId}/proxy-rpc`, { service_name: 'api.instance.StatsRpcService',
        method_name: 'get_stats', payload: { instance: { id: protoUuid(networkId) } } });
      const first = await stats();
      assert.equal(field(first, 'host_resources_supported'), true);
      const resources = field(first, 'host_resources');
      assert.ok(resources && BigInt(field(resources, 'memory_total_bytes')) > 0n);
      assert.ok(BigInt(field(resources, 'process_rss_bytes')) > 0n);
      assert.ok(field(resources, 'disks').length > 0);
      const sampled = await waitFor(async () => {
        const snapshot = field(await stats(), 'host_resources'), cpu = field(snapshot, 'cpu_usage_percent');
        return cpu != null && cpu >= 0 && cpu <= 100 ? snapshot : false;
      }, 'second CPU sample', 15000);
      proof.resource_sample = sampled;
      check('real CPU, RAM, process RSS and mounted disk samples');

      const discovery = await (await fetchCollector('/api/metrics/discovery')).json();
      assert.ok(discovery.length > 0);
      const target = discovery.find(target => target.labels.machine_id === machineId && target.labels.network_id === networkId);
      assert.ok(target, 'stable IDs are present in target discovery');
      const scrapePath = target.labels.__metrics_path__;
      assert.ok(scrapePath?.startsWith('/api/metrics/'));
      const text = await (await fetchCollector(scrapePath)).text();
      assert.match(text, /# TYPE easytier_host_memory_total_bytes gauge/);
      assert.ok(text.includes(`machine_id="${machineId}"`) && text.includes(`network_id="${networkId}"`));
      proof.scrape_bytes = Buffer.byteLength(text);
      check('authorized actual metrics include stable collector identity labels');
      await writeFile(scrapeFile, `global:\n  scrape_interval: 3s\n  scrape_timeout: 2s\nscrape_configs:\n  - job_name: easytier-native\n    authorization:\n      type: Bearer\n      credentials_file: ${tokenFile}\n    http_sd_configs:\n      - url: ${base}/api/metrics/discovery\n        authorization:\n          type: Bearer\n          credentials_file: ${tokenFile}\n`, { mode: 0o600 });
      const child = spawn(vmBinary, ['-storageDataPath', join(directory, 'vm-data'), '-httpListenAddr', `127.0.0.1:${ports.vm}`,
        '-retentionPeriod', '180d', '-memory.allowedBytes', '128MiB', '-promscrape.config', scrapeFile,
        '-promscrape.httpSDCheckInterval', '3s', '-search.latencyOffset', '0s', '-loggerLevel', 'WARN'],
      { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
      const vm = { child, logs: () => maskSecrets(output), rawLogs: () => output }; processes.push(vm);
      await waitFor(() => fetch(`${vmBase}/health`).then(response => response.ok), 'real VictoriaMetrics');
      const historyPath = `machines/${machineId}/networks/${networkId}/metrics/history`;
      const history = () => {
        const end = Math.floor(Date.now() / 1000);
        return api.get(`${historyPath}?metric=host_memory_used_bytes&start=${end - 120}&end=${end}&step=15`);
      };
      const stored = await waitFor(async () => {
        const result = await history();
        return result.series?.some(series => series.values.some(point => point[1] != null && point[1] > 0)) ? result : false;
      }, 'real scrape stored and returned through Web', 45000);
      proof.history_series = stored.series.length;
      proof.history_sample_count = stored.series.reduce((count, series) => count + series.values.filter(point => point[1] != null).length, 0);
      check('actual HTTP discovery, VM scraping, storage and Web history querying');
      const end = Math.floor(Date.now() / 1000);
      await other.get(`${historyPath}?metric=host_memory_used_bytes&start=${end - 120}&end=${end}&step=15`, 404);
      await api.get(`${historyPath}?metric=up%7B%7D&start=${end - 120}&end=${end}&step=15`, 400);
      await api.get(`${historyPath}?metric=host_memory_used_bytes&start=${end - 120}&end=${end}&step=1`, 400);
      check('history rejects other owners, arbitrary expressions and excessive resolution');

      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 1000 } });
      await context.addInitScript(() => localStorage.setItem('lang', 'en'));
      const page = await context.newPage(), pageErrors = [];
      page.on('pageerror', error => pageErrors.push(maskSecrets(error.message)));
      await page.goto('/#/auth'); await page.locator('#username').fill(username);
      await page.locator('#password input').fill('e2e-password');
      await page.getByRole('button', { name: 'Login', exact: true }).click();
      await page.locator('.console-page').waitFor();
      await page.goto(`/#/h/networks/${networkId}`);
      await page.getByRole('tab', { name: 'Members', exact: true }).click();
      await page.getByRole('row').filter({ hasText: 'Native resource node' }).getByRole('button', { name: 'Node Detail', exact: true }).click();
      const drawer = page.locator('.console-node-drawer');
      await drawer.getByRole('tab', { name: 'Runtime metrics', exact: true }).click();
      await drawer.getByTestId('host-memory').waitFor();
      await waitFor(async () => /[0-9].*(MiB|GiB)/.test(await drawer.getByTestId('host-memory').textContent()), 'real memory rendered');
      await drawer.getByRole('combobox', { name: 'Metric type', exact: true }).click();
      await page.getByRole('option', { name: 'Memory usage', exact: true }).click();
      await drawer.getByTestId('history-chart').waitFor({ timeout: 30000 });
      assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
      await drawer.screenshot({ path: join(directory, 'native-resources-history.png'), animations: 'disabled' });
      proof.browser_page_errors = pageErrors;
      check('real browser displays current machine resources and stored history');
      await browser.close(); browser = undefined;

      await stopCore(core); core = undefined;
      await waitFor(async () => !(await api.get('machines')).machines.some(machine => machine.online), 'offline Core');
      assert.ok((await history()).series.some(series => series.values.some(point => point[1] != null)), 'offline history remains available');
      const unavailable = await fetchCollector(scrapePath); assert.ok([403, 404, 503].includes(unavailable.status));
      check('offline device retains history and live collection fails instead of inserting zero');
      assertNoSecretLogs(processes); proof.status = 'PASS';
    } catch (error) { proof.status = 'FAIL'; proof.error = maskSecrets(error.message); throw error; }
    finally {
      await browser?.close();
      for (const process of processes.slice().reverse()) await stopCore(process);
      proof.processes_stopped = processes.every(process => process.child.exitCode !== null || process.child.signalCode !== null);
      for (let i = 0; i < processes.length; i++) await writeFile(join(directory, `process-${i}.log`), processes[i].logs(), { mode: 0o600 });
      await writeFile(join(directory, 'proof.json'), JSON.stringify(proof, null, 2), { mode: 0o600 });
      console.log(`PROOF=${join(directory, 'proof.json')}`);
    }
  });
