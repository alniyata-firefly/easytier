import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve('vite'))('esbuild');
const envelope = (kind, payload, time = '2026-10-17T08:15:30+08:00') => JSON.stringify({ time, event: { [kind]: payload } });

test('Core tunnel journal parser retains only typed connection metadata and safe failure classes', async context => {
    const directory = await mkdtemp(join(tmpdir(), 'et-tunnel-events-'));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const output = join(directory, 'tunnel-events.cjs');
    await esbuild.build({ entryPoints: [join(frontend, 'src/lib/tunnel-events.ts')], outfile: output, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
    const { parseTunnelEvents, safeTunnelEndpoint, classifyTunnelFailure, tunnelEventKinds, tunnelFailureReasons, tunnelEventState } = require(output);

    await context.test('parses all eight GlobalCtxEvent shapes including protobuf camel and snake fields', () => {
        const input = [
            envelope('Connecting', 'udp://[2001:db8::1]:22020'),
            envelope('ConnectError', ['udp://198.51.100.2:22020', 'V4', 'operation timed out']),
            envelope('ConnectionAccepted', ['tcp://192.0.2.1:11010', 'tcp://198.51.100.3:50000']),
            envelope('ConnectionError', ['tcp://192.0.2.1:11010', 'tcp://198.51.100.3:50000', 'Connection reset by peer']),
            envelope('PeerAdded', 2633692368), envelope('PeerRemoved', 0),
            envelope('PeerConnAdded', { peer_id: 55, tunnel: { tunnel_type: 'udp', local_addr: { url: 'udp://192.0.2.1:11010' }, remote_addr: { url: 'udp://198.51.100.4:22020' } } }),
            envelope('PeerConnRemoved', { peerId: 66, tunnel: { tunnelType: 'wss', localAddr: { url: 'wss://local.example:9443/' }, resolvedRemoteAddr: { url: 'wss://remote.example:9443/' } } }),
        ];
        const parsed = parseTunnelEvents(input);
        assert.deepEqual(parsed.map(event => event.kind), tunnelEventKinds);
        assert.equal(parsed[0].occurredAt, Date.parse('2026-10-17T00:15:30Z'));
        assert.equal(parsed[0].remoteEndpoint, 'udp://[2001:db8::1]:22020');
        assert.equal(parsed[1].protocol, 'UDP'); assert.equal(parsed[1].ipVersion, 'IPv4'); assert.equal(parsed[1].failureReason, 'timeout');
        assert.equal(parsed[3].failureReason, 'reset'); assert.equal(parsed[4].peerId, 2633692368); assert.equal(parsed[5].peerId, 0);
        assert.equal(parsed[6].peerId, 55); assert.equal(parsed[6].localEndpoint, 'udp://192.0.2.1:11010');
        assert.equal(parsed[7].peerId, 66); assert.equal(parsed[7].protocol, 'WSS'); assert.equal(parsed[7].remoteEndpoint, 'wss://remote.example:9443');
    });

    await context.test('excludes configuration, credentials, unknown events and malformed envelopes', () => {
        for (const input of [undefined, {}, 'raw-json', [null, {}, 42]]) assert.deepEqual(parseTunnelEvents(input), []);
        assert.deepEqual(parseTunnelEvents([
            envelope('ConfigPatched', { network_secret: 'fixture-secret' }), envelope('CredentialChanged', 'fixture-secret'),
            envelope('TunDeviceError', 'secret file path'), envelope('FutureEvent', { credential: 'fixture-secret' }),
            '{broken-json fixture-secret', JSON.stringify({ time: 'bad', event: { PeerAdded: 12, CredentialChanged: 'fixture-secret' } }),
            envelope('PeerAdded', '12'), envelope('PeerRemoved', -1), envelope('PeerAdded', 0x100000000),
            envelope('Connecting', { url: 'udp://192.0.2.1' }), envelope('ConnectionAccepted', ['only one']), envelope('PeerConnAdded', null),
        ]), []);
    });

    await context.test('never carries userinfo, URL path, query, hash, key material or raw errors into parsed output', () => {
        const secret = 'synthetic-credential-must-not-leave-parser';
        const address = `wss://user:${secret}@vpn.example.test:9443/config/${secret}?token=${secret}#${secret}`;
        const parsed = parseTunnelEvents([
            envelope('Connecting', address), envelope('ConnectError', [address, secret, `connection refused ${secret}`]),
            envelope('ConnectionError', [address, address, `arbitrary error ${secret}`]),
            envelope('PeerConnAdded', { peer_id: 1, network_name: secret, noise_local_static_pubkey: secret, noise_remote_static_pubkey: secret,
                tunnel: { tunnel_type: secret, local_addr: { url: address }, remote_addr: { url: address } } }),
        ]);
        const output = JSON.stringify(parsed);
        assert.ok(!output.includes(secret)); assert.ok(!output.includes('userinfo')); assert.ok(!output.includes('network_name')); assert.ok(!output.includes('pubkey'));
        assert.equal(parsed[0].remoteEndpoint, 'wss://vpn.example.test:9443');
        assert.equal(parsed[1].failureReason, 'refused'); assert.equal(parsed[1].ipVersion, undefined); assert.equal(parsed[2].failureReason, 'unknown');
        assert.equal(parsed[3].protocol, 'WSS');
        for (const value of [`javascript:${secret}`, `file:///${secret}`, `not a URL ${secret}`, { url: 5 }, 9]) assert.equal(safeTunnelEndpoint(value), undefined);
        assert.deepEqual(safeTunnelEndpoint('faketcp://198.51.100.2:22020'), { endpoint: 'faketcp://198.51.100.2:22020', protocol: 'FAKETCP' });
        assert.equal(safeTunnelEndpoint(`https://discovery.example/${secret}?token=${secret}`).endpoint, 'https://discovery.example');
        assert.equal(parseTunnelEvents([envelope('PeerConnAdded', { tunnel: { tunnel_type: 'unix', local_addr: { url: `unix:///${secret}` } } })])[0].protocol, 'UNIX');
    });

    await context.test('classifies recognizable failures using fixed reason keys only', () => {
        for (const [error, expected] of [
            ['Timeout: deadline has elapsed', 'timeout'], ['Connection refused (os error 111)', 'refused'],
            ['Network is unreachable', 'unreachable'], ['failed to lookup address information: dns error', 'name_resolution'],
            ['Connection reset by peer', 'reset'], ['unexpected EOF', 'closed'], ['Permission denied', 'permission'],
            ['Handshake failed', 'authentication'], ['request canceled', 'cancelled'], ['unknown private payload', 'unknown'],
        ]) assert.equal(classifyTunnelFailure(error), expected);
        assert.equal(classifyTunnelFailure({ message: 'timeout' }), 'unknown');
    });

    await context.test('honors the total twenty-event memory window and invalid timestamps stay unknown', () => {
        assert.equal(parseTunnelEvents(Array.from({ length: 30 }, (_, id) => envelope('PeerAdded', id))).length, 20);
        assert.deepEqual(parseTunnelEvents([...Array.from({ length: 20 }, () => envelope('ConfigPatched', {})), envelope('PeerAdded', 1)]), []);
        assert.equal(parseTunnelEvents([envelope('PeerAdded', 1, 'invalid-date')])[0].occurredAt, undefined);
        assert.equal(tunnelEventState('ConnectionAccepted'), 'running');
        assert.equal(tunnelEventState('Connecting'), 'connecting');
        assert.equal(tunnelEventState('PeerConnAdded'), 'online');
        assert.equal(tunnelEventState('ConnectionError'), 'failed');
        assert.equal(tunnelEventState('PeerRemoved'), 'offline');
    });

    await context.test('both language namespaces cover every allowed event and fixed failure category', async () => {
        for (const language of ['zh-CN', 'en']) {
            const messages = JSON.parse(await readFile(join(frontend, `public/locales/${language}/tunnel-events.json`), 'utf8'));
            for (const kind of tunnelEventKinds) assert.ok(typeof messages.events[kind] === 'string' && messages.events[kind].length);
            for (const reason of tunnelFailureReasons) assert.ok(typeof messages.reasons[reason] === 'string' && messages.reasons[reason].length);
        }
    });
});
