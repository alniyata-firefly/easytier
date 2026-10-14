import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve('vite'))('esbuild');

test('Node parameter contracts use synthetic configuration only', async context => {
    const temporary = await mkdtemp(join(tmpdir(), 'easytier-node-config-'));
    context.after(() => rm(temporary, { recursive: true, force: true }));
    const outfile = join(temporary, 'node-config.cjs');
    await esbuild.build({ entryPoints: [join(frontend, 'src/lib/node-config.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
    const { NODE_BOOLEAN_FLAGS, MAX_VPN_PORTAL_CLIENTS, applyNodePatch, patchNodeRecord, patchNodeRow, prepareNodeParametersForBackend, nodeList, parseUint64Input, validateNodeParameters } = require(outfile);
    await context.test('all 26 original non-preference boolean flags are available', () => {
        assert.equal(NODE_BOOLEAN_FLAGS.length, 26);
        assert.equal(new Set(NODE_BOOLEAN_FLAGS).size, 26);
        assert.equal(NODE_BOOLEAN_FLAGS.includes('prefer_ipv6'), false);
        for (const key of ['use_smoltcp', 'enable_quic_proxy', 'disable_tcp_hole_punching', 'enable_private_mode']) assert.equal(NODE_BOOLEAN_FLAGS.includes(key), true);
    });
    await context.test('receive limits preserve every uint64 digit and reject overflow or unsafe numbers', () => {
        assert.deepEqual(parseUint64Input('9007199254740993'), { valid: true, value: '9007199254740993' });
        assert.deepEqual(parseUint64Input('18446744073709551615'), { valid: true, value: '18446744073709551615' });
        assert.deepEqual(parseUint64Input('18446744073709551616'), { valid: false });
        assert.deepEqual(parseUint64Input('-1'), { valid: false });
        assert.deepEqual(parseUint64Input('1.5'), { valid: false });
        assert.deepEqual(parseUint64Input('0'), { valid: true });
        assert.deepEqual(parseUint64Input(''), { valid: true });
        assert.equal(validateNodeParameters({ instance_recv_bps_limit: '18446744073709551615' }).length, 0);
        assert.equal(validateNodeParameters({ instance_recv_bps_limit: 9007199254740992 })[0].key, 'errors.uint64');
    });
    await context.test('editing one field preserves all unedited fields without filling defaults', () => {
        const unknown = { future_option: { nested: true }, peers: [{ uri: 'tcp://127.0.0.1:1', public_key: 'synthetic' }] };
        const initial = { ...unknown, no_tun: true };
        const patched = applyNodePatch(initial, { mtu: 1280 });
        assert.deepEqual(patched, { ...initial, mtu: 1280 });
        assert.equal(patched.future_option, initial.future_option);
        assert.equal('multi_thread' in patched, false);
        assert.equal('mtu' in initial, false);
    });
    await context.test('IPv6 inheritance removes only prefer_ipv6 and preserves explicit false', () => {
        const original = { prefer_ipv6: true, unknown: 'preserved' };
        const inherited = applyNodePatch(original, { prefer_ipv6: undefined });
        assert.deepEqual(inherited, { unknown: 'preserved' });
        assert.deepEqual(applyNodePatch(inherited, { prefer_ipv6: false }), { unknown: 'preserved', prefer_ipv6: false });
        assert.equal(original.prefer_ipv6, true);
    });
    await context.test('nested portal and row patches preserve keys, clients, groups and unknown values', () => {
        const client = { name: 'client-a', virtual_ip: '10.66.0.2/24', groups: ['ops'], future: 1 };
        const portal = { wireguard_private_key: 'synthetic-key', wireguard_listen: '127.0.0.1:22022', clients: [client], unknown: true };
        const clients = patchNodeRow(portal.clients, 0, { name: 'client-b' });
        const changed = patchNodeRecord(portal, { clients });
        assert.equal(changed.wireguard_private_key, portal.wireguard_private_key);
        assert.equal(changed.wireguard_listen, portal.wireguard_listen);
        assert.deepEqual(clients[0], { ...client, name: 'client-b' });
        assert.equal(client.name, 'client-a');
        assert.equal(changed.unknown, true);
        const forward = { proto: 'tcp', bind_ip: '::1', bind_port: 22000, dst_ip: '127.0.0.1', dst_port: 22001, future: 'preserved' };
        assert.deepEqual(patchNodeRow([forward], 0, { dst_port: 22002 })[0], { ...forward, dst_port: 22002 });
    });
    await context.test('list drafts parse multiple lines without altering their source text', () => {
        const draft = 'tcp://127.0.0.1:22001\n\ntcp://[::1]:22001\n';
        assert.deepEqual(nodeList(draft), ['tcp://127.0.0.1:22001', 'tcp://[::1]:22001']);
        assert.equal(draft.endsWith('\n'), true);
    });
    await context.test('IPv6 port forwarding is serialized in a copy without changing raw fields or row metadata', () => {
        const original = { future: 'preserved', port_forwards: [{ proto: 'tcp', bind_ip: '::1', bind_port: 1, dst_ip: '2001:db8::2', dst_port: 2, unknown: { preserved: true } }, { proto: 'udp', bind_ip: '[::1]', bind_port: 3, dst_ip: '127.0.0.1', dst_port: 4 }] };
        assert.deepEqual(validateNodeParameters(original), []);
        const prepared = prepareNodeParametersForBackend(original);
        assert.equal(prepared.port_forwards[0].bind_ip, '[::1]');
        assert.equal(prepared.port_forwards[0].dst_ip, '[2001:db8::2]');
        assert.equal(prepared.port_forwards[1].bind_ip, '[::1]');
        assert.equal(prepared.port_forwards[0].unknown, original.port_forwards[0].unknown);
        assert.equal(prepared.future, 'preserved');
        assert.equal(original.port_forwards[0].bind_ip, '::1');
        assert.equal(original.port_forwards[0].dst_ip, '2001:db8::2');
    });
    await context.test('actual CIDR, listener, port and VPN client contracts are checked', () => {
        const config = { proxy_cidrs: ['10.10.0.0/24->192.168.0.0/24'], listener_urls: ['tcp://127.0.0.1:22001'], mapped_listeners: ['udp://[::1]:22001'], enable_manual_routes: true, routes: ['10.0.0.0/8'], exit_nodes: ['10.66.0.2', '::1'], enable_socks5: true, socks5_port: 1080, port_forwards: [{ proto: 'udp', bind_ip: '[::1]', bind_port: 22002, dst_ip: '127.0.0.1', dst_port: 22003 }], vpn_portal_config: { wireguard_listen: '[::1]:22022', clients: [{ name: 'client-a', virtual_ip: '10.66.0.2/24', groups: ['ops'] }] } };
        assert.deepEqual(validateNodeParameters(config), []);
        assert.equal(validateNodeParameters({ listener_urls: ['https://example.invalid'] })[0].key, 'errors.listenerUrl');
        assert.equal(validateNodeParameters({ proxy_cidrs: ['10.0.0.0/90'] })[0].key, 'errors.proxyCidr');
        assert.equal(validateNodeParameters({ port_forwards: [{ proto: 'tcp', bind_ip: '127.0.0.1', bind_port: 65536, dst_ip: '127.0.0.1', dst_port: 1 }] })[0].path, 'port_forwards.0.bind_port');
        const clients = [{ name: 'same', virtual_ip: '10.66.0.2/24' }, { name: 'same', virtual_ip: '10.66.0.2/24' }];
        assert.deepEqual(validateNodeParameters({ vpn_portal_config: { enabled: false, wireguard_listen: '127.0.0.1:22022', clients } }).map(issue => issue.key), ['errors.duplicateName', 'errors.duplicateIp']);
        assert.equal(validateNodeParameters({ vpn_portal_config: { enabled: false } })[0].key, 'errors.socket');
        assert.equal(validateNodeParameters({ enable_manual_routes: true, routes: ['::/64'] })[0].key, 'errors.ipv4Cidr');
    });
    await context.test('only VPN clients have a 64 row limit; port-forward rules remain uncapped', () => {
        assert.equal(MAX_VPN_PORTAL_CLIENTS, 64);
        assert.deepEqual(validateNodeParameters({ port_forwards: Array(65).fill({ proto: 'tcp', bind_ip: '127.0.0.1', bind_port: 1, dst_ip: '127.0.0.1', dst_port: 2 }) }), []);
        const clients = Array.from({ length: 65 }, (_, index) => ({ name: `client-${index}`, virtual_ip: `10.66.0.${index + 1}/24` }));
        assert.equal(validateNodeParameters({ vpn_portal_config: { enabled: false, wireguard_listen: '127.0.0.1:22022', clients } })[0].key, 'errors.rowLimit');
    });
});
