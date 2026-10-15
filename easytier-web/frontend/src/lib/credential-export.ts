import type { CentralNetworkDetail } from './api';
import { shellQuote } from '../../../frontend-lib/src/modules/runtimeDisplay';

const booleanFlags = ['enable_kcp_proxy', 'disable_kcp_input', 'enable_quic_proxy', 'disable_quic_input'] as const;
const stringFlags = ['encryption_algorithm', 'default_protocol', 'tld_dns_zone'] as const;

export function networkCredentialSnapshot(network: CentralNetworkDetail, secret: string, gatewayPeerUrl?: string): { cli: string; toml: string } {
    const peers = network.networking_method === 'Gateway' && gatewayPeerUrl ? [gatewayPeerUrl]
        : network.networking_method === 'PublicServer' ? [network.public_server_url].filter((value): value is string => !!value) : network.peer_urls;
    const transport = network.transport ?? {};
    const cli = ['easytier-core', `--network-name ${shellQuote(network.network_name)}`, '--secure-mode', `--credential ${shellQuote(secret)}`, ...peers.map(peer => `-p ${shellQuote(peer)}`), `--prefer-ipv6 ${network.prefer_ipv6 === true}`];
    const flags = [`prefer_ipv6 = ${network.prefer_ipv6 === true}`];
    if (transport.data_compress_algo !== undefined) {
        cli.push(`--compression ${transport.data_compress_algo === 2 ? 'zstd' : 'none'}`);
        flags.push(`data_compress_algo = ${JSON.stringify(transport.data_compress_algo === 2 ? 'Zstd' : 'None')}`);
    }
    for (const key of booleanFlags) if (transport[key] !== undefined) {
        cli.push(`--${key.replaceAll('_', '-')} ${transport[key]}`);
        flags.push(`${key} = ${transport[key]}`);
    }
    if (transport.disable_encryption !== undefined) {
        cli.push(`--disable-encryption ${transport.disable_encryption}`);
        flags.push(`enable_encryption = ${!transport.disable_encryption}`);
    }
    for (const key of stringFlags) if (transport[key] !== undefined) {
        cli.push(`--${key.replaceAll('_', '-')} ${shellQuote(transport[key])}`);
        flags.push(`${key} = ${JSON.stringify(transport[key])}`);
    }
    const toml = ['[network_identity]', `network_name = ${JSON.stringify(network.network_name)}`, '',
        ...peers.flatMap(peer => ['[[peer]]', `uri = ${JSON.stringify(peer)}`, '']),
        '[secure_mode]', 'enabled = true', `local_private_key = ${JSON.stringify(secret)}`, '', '[flags]', ...flags].join('\n');
    return { cli: cli.join(' '), toml };
}
