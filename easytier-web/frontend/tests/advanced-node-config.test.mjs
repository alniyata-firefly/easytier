import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(frontend, '../..');
const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve('vite'))('esbuild');

const directory = await mkdtemp(join(tmpdir(), 'et-advanced-config-'));
const compile = async (source, name) => {
    const outfile = join(directory, `${name}.cjs`);
    await esbuild.build({ entryPoints: [source], outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
    return require(outfile);
};
const [network, exporter, webHelpers, guiHelpers] = await Promise.all([
    compile(join(root, 'easytier-web/frontend-lib/src/types/network.ts'), 'network'),
    compile(join(frontend, 'src/lib/credential-export.ts'), 'exporter'),
    compile(join(frontend, 'src/lib/node-config.ts'), 'helpers-web'),
    compile(join(root, 'easytier-gui/src/react/lib/node-config.ts'), 'helpers-gui'),
]);

test('advanced configuration survives real protobuf JSON and credential TOML export', async context => {
    context.after(() => rm(directory, { recursive: true, force: true }));
    for (const [index, helpers] of [webHelpers, guiHelpers].entries()) {
        await context.test(`${index === 0 ? 'Web' : 'GUI'} preserves explicit zero, empty list and disabled SOCKS`, () => {
            const input = {
                ...network.DEFAULT_NETWORK_CONFIG(), networking_method: network.NetworkingMethod.Standalone,
                instance_recv_bps_limit: '0', foreign_relay_bps_limit: '18446744073709551615',
                default_protocol: 'udp', encryption_algorithm: 'chacha20', socket_mark: 0,
                tld_dns_zone: 'Sites.Example.', virtual_ipv6: 'fd00:7::42/64', instance_name: 'test-instance', netns: 'vpn-space',
                disable_relay_data: false, prefer_peer_relay: true, disable_relay_kcp: true, disable_relay_quic: false,
                enable_relay_foreign_network_kcp: true, enable_relay_foreign_network_quic: false,
                stun_servers: { values: [] }, tcp_stun_servers: { values: ['stun.example.test', '[2001:db8::1]:3478'] },
                stun_servers_v6: undefined, tcp_whitelist: { values: ['0', '80', '8000-8100'] }, udp_whitelist: { values: [] },
                socks5_proxy: '', enable_socks5: true, socks5_port: 1080,
            };
            assert.deepEqual(helpers.validateNodeParameters(input), []);
            const output = network.normalizeNetworkConfig(network.toBackendNetworkConfig(helpers.prepareNodeParametersForBackend(input)));
            for (const key of ['instance_recv_bps_limit', 'foreign_relay_bps_limit', 'default_protocol', 'encryption_algorithm', 'socket_mark', 'tld_dns_zone', 'virtual_ipv6', 'instance_name', 'netns', 'disable_relay_data', 'prefer_peer_relay', 'disable_relay_kcp', 'disable_relay_quic', 'enable_relay_foreign_network_kcp', 'enable_relay_foreign_network_quic', 'stun_servers', 'tcp_stun_servers', 'tcp_whitelist', 'udp_whitelist', 'socks5_proxy']) assert.deepEqual(key.endsWith('_bps_limit') ? String(output[key]) : output[key], input[key], key);
            assert.equal(output.stun_servers_v6, undefined);
            assert.deepEqual(helpers.parseUint64Input('0'), { valid: true, value: '0' });
            const reset = helpers.applyNodePatch(input, { stun_servers: undefined, socks5_proxy: undefined, foreign_relay_bps_limit: undefined });
            assert.equal(reset.stun_servers, undefined); assert.equal(reset.socks5_proxy, undefined);
            assert.equal(reset.enable_socks5, true); assert.equal(reset.socks5_port, 1080);
        });
        await context.test(`${index === 0 ? 'Web' : 'GUI'} rejects malformed typed boundaries`, () => {
            for (const [key, value] of [
                ['default_protocol', 'https'], ['encryption_algorithm', 'unknown'], ['socket_mark', 4294967296],
                ['socket_mark', -1], ['virtual_ipv6', '10.0.0.1/24'], ['netns', '../escape'],
                ['foreign_relay_bps_limit', 9007199254740992], ['foreign_relay_bps_limit', '18446744073709551616'],
                ['stun_servers', []], ['stun_servers', { values: [123] }], ['stun_servers', { values: ['bad host'] }],
                ['tcp_whitelist', { values: ['9000-8000'] }], ['udp_whitelist', { values: ['65536'] }],
                ['socks5_proxy', 'socks5://127.0.0.1:0'], ['stun_servers', {values:['[::1]']}], ['socks5_proxy', 'http://127.0.0.1:1080'], ['socks5_proxy', 'socks5://user:pass@127.0.0.1:1080'],
                ['stun_servers',{values:['测试.example']}], ['stun_servers',{values:['bad_name.example']}], ['netns','.'], ['netns','..'], ['netns',' vpn'], ['netns','中'.repeat(86)], ['instance_name','中'.repeat(86)], ['instance_name','bad\u0085name'], ['tld_dns_zone','-mesh.example'], ['tld_dns_zone','mesh-.example'], ['tld_dns_zone','bad_name.example'], ['tld_dns_zone', 'bad zone'], ['tld_dns_zone', ''],
            ]) assert.ok(helpers.validateNodeParameters({ [key]: value }).some(issue => issue.path === key), `${key}: ${JSON.stringify(value)}`);
            assert.deepEqual(helpers.validateNodeParameters({stun_servers:{values:['txt:stun.example.test','2001:db8::1']}}), []);
            assert.deepEqual(helpers.validateNodeParameters({ socks5_proxy: 'socks5://[::1]:1080', enable_socks5: true, socks5_port: 'stale-ignored' }), []);
            assert.ok(helpers.validateNodeParameters({ enable_socks5: true, socks5_port: 'bad' }).length > 0);
            assert.ok(helpers.validateNodeParameters({ enable_socks5: true, socks5_port: 0 }).length > 0);
            assert.deepEqual(helpers.validateNodeParameters({instance_name:'',netns:'',tcp_whitelist:{values:['0','0-1']}}),[]);
        });
    }
    await context.test('CLI options and TOML flags preserve all nine network settings and IPv6 preference', () => {
        const settings = {
            networking_method: 'Manual', network_name: 'Synthetic space', peer_urls: ['udp://127.0.0.1:22020'], prefer_ipv6: false,
            transport: { data_compress_algo: 1, enable_kcp_proxy: false, disable_kcp_input: false, enable_quic_proxy: true, disable_quic_input: true, disable_encryption: false, encryption_algorithm: 'aes-256-gcm', default_protocol: 'udp', tld_dns_zone: 'nodes.example.' },
        };
        const snapshot = exporter.networkCredentialSnapshot(settings, 'synthetic-credential');
        const parsed = spawnSync('python3', ['-c', 'import json,sys,tomllib,shlex;d=json.load(sys.stdin);print(json.dumps({"toml":tomllib.loads(d["toml"]),"argv":shlex.split(d["cli"])}))'], { input: JSON.stringify(snapshot), encoding: 'utf8' });
        assert.equal(parsed.status, 0, parsed.stderr);
        const { toml, argv } = JSON.parse(parsed.stdout);
        assert.equal(toml.network_identity.network_name, 'Synthetic space');
        assert.equal(toml.secure_mode.local_private_key, 'synthetic-credential');
        assert.deepEqual(toml.flags, { prefer_ipv6: false, data_compress_algo: 'None', enable_kcp_proxy: false, disable_kcp_input: false, enable_quic_proxy: true, disable_quic_input: true, enable_encryption: true, encryption_algorithm: 'aes-256-gcm', default_protocol: 'udp', tld_dns_zone: 'nodes.example.' });
        for (const [flag, value] of [['--compression', 'none'], ['--enable-kcp-proxy', 'false'], ['--disable-kcp-input', 'false'], ['--enable-quic-proxy', 'true'], ['--disable-quic-input', 'true'], ['--disable-encryption', 'false'], ['--encryption-algorithm', 'aes-256-gcm'], ['--default-protocol', 'udp'], ['--tld-dns-zone', 'nodes.example.'], ['--prefer-ipv6', 'false']]) assert.equal(argv[argv.indexOf(flag) + 1], value, flag);
        assert.equal(argv.includes('--data-compress-algo'), false);
        const defaultSnapshot = exporter.networkCredentialSnapshot({ ...settings, transport: {} }, 'synthetic');
        assert.ok(!defaultSnapshot.cli.includes('--compression'));
        assert.ok(!defaultSnapshot.toml.includes('data_compress_algo'));
        const enabledSnapshot = exporter.networkCredentialSnapshot({ ...settings, transport: { data_compress_algo: 2 }, networking_method: 'Gateway' }, 'synthetic', 'udp://[::1]:22020');
        assert.ok(enabledSnapshot.cli.includes('--compression zstd'));
        assert.ok(enabledSnapshot.toml.includes('uri = "udp://[::1]:22020"'));
    });
});
