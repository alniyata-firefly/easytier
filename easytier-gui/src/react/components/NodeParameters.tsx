import type { UplinkInventoryLoader } from '../../../../easytier-web/frontend-lib/src/modules/uplinkInventory';
import { UplinkInterfaces } from './UplinkInterfaces';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
    ENCRYPTION_ALGORITHMS, NODE_PROTOCOLS, MAX_VPN_PORTAL_CLIENTS, NODE_BOOLEAN_FLAGS, isConfigRecord, nodeList, parseUint64Input,
    patchNodeRecord, patchNodeRow, validateNodeParameters, type NodeConfigRecord,
} from '../lib/node-config';
import { Button, Field } from './ui';

function TextDraft({ value, onChange, multiline = false, busy = false, label, numeric = false }: {
    value: string; onChange: (text: string) => void; multiline?: boolean; busy?: boolean; label: string; numeric?: boolean;
}) {
    const [draft, setDraft] = useState(value);
    const focused = useRef(false);
    useEffect(() => { if (!focused.current) setDraft(value); }, [value]);
    const props = { 'aria-label': label, value: draft, disabled: busy, className: 'mono',
        onFocus: () => { focused.current = true; },
        onBlur: () => { focused.current = false; setDraft(value); },
        onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setDraft(event.target.value); onChange(event.target.value); } };
    return multiline ? <textarea {...props} rows={3} spellCheck={false} />
        : <input {...props} inputMode={numeric ? 'numeric' : undefined} spellCheck={false} />;
}

const presentString = (value: unknown): boolean => typeof value === 'string' && value.length > 0;
const textValue = (value: unknown) => value == null ? '' : String(value);
const listValue = (value: unknown) => Array.isArray(value) ? value.filter(entry => typeof entry === 'string').join('\n') : '';
const integerDraft = (text: string): unknown => !text.trim() ? undefined : /^\d+$/.test(text.trim()) ? Number(text) : text;
const NETWORK_TRANSPORT_FLAGS = new Set(['enable_kcp_proxy', 'disable_kcp_input', 'enable_quic_proxy', 'disable_quic_input', 'disable_encryption']);
const RELAY_FLAGS = new Set(['relay_all_peer_rpc', 'disable_relay_data', 'prefer_peer_relay', 'disable_relay_kcp', 'disable_relay_quic', 'enable_relay_foreign_network_kcp', 'enable_relay_foreign_network_quic']);

function OptionalListField({ label, value, onChange, busy, error }: {
    label: string; value: unknown; onChange: (value: NodeConfigRecord | undefined) => void; busy: boolean; error?: string;
}) {
    const { t } = useTranslation('node-config');
    const [editingCustom, setEditingCustom] = useState(false);
    const values = isConfigRecord(value) && Array.isArray(value.values) ? value.values : [];
    const mode = value == null ? 'default' : editingCustom || values.length > 0 ? 'custom' : 'disabled';
    return <div className="form-stack">
        <Field label={label} error={error}><select aria-label={label} value={mode} disabled={busy} onChange={event => {
            const next = event.target.value; setEditingCustom(next === 'custom');
            onChange(next === 'default' ? undefined : patchNodeRecord(value, { values: next === 'disabled' ? [] : values }));
        }}><option value="default">{t('lists.default')}</option><option value="disabled">{t('lists.disabled')}</option><option value="custom">{t('lists.custom')}</option></select></Field>
        {mode === 'custom' && <TextDraft label={t('lists.entries', { field: label })} value={listValue(values)} multiline busy={busy} onChange={text => onChange(patchNodeRecord(value, { values: nodeList(text) }))}/>}
    </div>;
}

function enabledPortal(current: unknown): NodeConfigRecord {
    const portal = patchNodeRecord(current, { enabled: true });
    if (!portal.wireguard_listen) portal.wireguard_listen = '0.0.0.0:22022';
    if (!Array.isArray(portal.clients)) portal.clients = [];
    if (!portal.wireguard_private_key) {
        const key = crypto.getRandomValues(new Uint8Array(32));
        key[0] &= 248; key[31] = (key[31] & 127) | 64;
        portal.wireguard_private_key = btoa(String.fromCharCode(...key));
    }
    return portal;
}

export function NodeParameters({ mode, value, onPatch, busy = false, loadUplinkInventory, onValidityChange, supportsUplinkSelection = true }: {
    mode: 'member' | 'instance'; value: NodeConfigRecord; onPatch: (patch: NodeConfigRecord) => void;
    busy?: boolean; loadUplinkInventory?: UplinkInventoryLoader; onValidityChange?: (valid: boolean) => void;
    supportsUplinkSelection?: boolean;
}) {
    const { t } = useTranslation('node-config');
    const issues = useMemo(() => validateNodeParameters(value), [value]);
    const valid = issues.length === 0;
    useEffect(() => { onValidityChange?.(valid); }, [valid, onValidityChange]);
    const errorAt = (path: string) => {
        const issue = issues.find(item => item.path === path);
        return issue ? t(issue.key, issue.values) : undefined;
    };
    const field = (key: string) => t(`fields.${key}`);
    const check = (key: string, defaultValue = false) => <label className="check-row" key={key}>
        <input type="checkbox" checked={value[key] == null ? defaultValue : value[key] === true}
            onChange={event => onPatch({ [key]: event.target.checked })} disabled={busy} />
        <span>{field(key)}</span>
        {errorAt(key) && <span role="alert" className="field-error">{errorAt(key)}</span>}
    </label>;
    const textField = (key: string, numeric = false) => <Field label={field(key)} error={errorAt(key)}>
        <TextDraft label={field(key)} value={textValue(value[key])} numeric={numeric} busy={busy}
            onChange={text => onPatch({ [key]: numeric ? integerDraft(text) : !text && ['tld_dns_zone', 'netns'].includes(key) ? undefined : text })} />
    </Field>;
    const listField = (key: string) => <Field label={field(key)} error={errorAt(key)}>
        <TextDraft label={field(key)} value={listValue(value[key])} multiline busy={busy} onChange={text => onPatch({ [key]: nodeList(text) })} />
    </Field>;
    const rateField = (key: string) => <Field key={key} label={field(key)} error={errorAt(key)}>
        <TextDraft label={field(key)} value={textValue(value[key])} numeric busy={busy} onChange={text => {
            const parsed = parseUint64Input(text); onPatch({ [key]: parsed.valid ? parsed.value : text });
        }}/>
    </Field>;
    const enumField = (key: string, options: readonly string[]) => <Field label={field(key)} error={errorAt(key)}>
        <select aria-label={field(key)} value={textValue(value[key])} disabled={busy} onChange={event => onPatch({ [key]: event.target.value || undefined })}>
            <option value="">{t('compression.default')}</option>
            {options.map(option => <option key={option} value={option}>{option}</option>)}
            {presentString(value[key]) && !options.includes(String(value[key])) && <option value={String(value[key])}>{String(value[key])}</option>}
        </select>
    </Field>;
    const optionalList = (key: string) => <OptionalListField key={key} label={field(key)} value={value[key]} onChange={next => onPatch({ [key]: next })} busy={busy} error={errorAt(key)}/>;
    const socksMode = value.socks5_proxy == null ? 'port' : value.socks5_proxy === '' ? 'disabled' : 'custom';
    const uplink = isConfigRecord(value.uplink) ? value.uplink : undefined;
    const uplinkMode = uplink?.mode === 'manual' ? 'manual' : 'auto';
    const forwards = Array.isArray(value.port_forwards) ? value.port_forwards : [];
    const portal = isConfigRecord(value.vpn_portal_config) ? value.vpn_portal_config : undefined;
    const clients = Array.isArray(portal?.clients) ? portal.clients : [];
    const patchPortal = (patch: NodeConfigRecord) => onPatch({ vpn_portal_config: patchNodeRecord(portal, patch) });
    const patchClient = (index: number, patch: NodeConfigRecord) => patchPortal({ clients: patchNodeRow(clients, index, patch) });
    return <div className="node-parameters form-stack">
        <fieldset className="node-parameter-section form-stack" disabled={busy}>
            <legend>{t('sections.connection')}</legend>
            {mode === 'member' ? <Field label={field('prefer_ipv6')} error={errorAt('prefer_ipv6')}>
                <select aria-label={field('prefer_ipv6')} value={value.prefer_ipv6 === true ? 'ipv6' : value.prefer_ipv6 === false ? 'default' : 'inherit'}
                    onChange={event => onPatch({ prefer_ipv6: event.target.value === 'inherit' ? undefined : event.target.value === 'ipv6' })}>
                    <option value="inherit">{t('preference.inherit')}</option><option value="ipv6">{t('preference.ipv6')}</option><option value="default">{t('preference.default')}</option>
                </select>
            </Field> : <div className="settings-options">{check('prefer_ipv6')}</div>}
            <div className="settings-options">{NODE_BOOLEAN_FLAGS.filter(key => (supportsUplinkSelection || key !== 'bind_device') && (mode !== 'member' || !NETWORK_TRANSPORT_FLAGS.has(key)) && !RELAY_FLAGS.has(key)).map(key => check(key, key === 'bind_device' || key === 'multi_thread'))}</div>
            {mode === 'instance' && <Field label={field('data_compress_algo')} error={errorAt('data_compress_algo')}>
                <select aria-label={field('data_compress_algo')} value={value.data_compress_algo == null ? 'default' : textValue(value.data_compress_algo)} disabled={busy}
                    onChange={event => onPatch({ data_compress_algo: event.target.value === 'default' ? undefined : Number(event.target.value) })}>
                    <option value="default">{t('compression.default')}</option>
                    <option value="1">{t('compression.disabled')}</option>
                    <option value="2">{t('compression.zstd')}</option>
                </select>
            </Field>}
            {mode === 'instance' && <div className="form-grid">{enumField('encryption_algorithm', ENCRYPTION_ALGORITHMS)}{enumField('default_protocol', NODE_PROTOCOLS)}{textField('tld_dns_zone')}</div>}
        </fieldset>
        <fieldset className="node-parameter-section form-stack" disabled={busy}>
            <legend>{t('sections.interface')}</legend>
            {supportsUplinkSelection && <Field label={field('uplink_mode')} error={errorAt('uplink') ?? errorAt('uplink.mode')}>
                <select aria-label={field('uplink_mode')} value={uplinkMode} onChange={event => onPatch({ uplink: event.target.value === 'manual' ? { mode: 'manual', interfaces: [] } : { mode: 'auto', interfaces: [] } })}>
                    <option value="auto">{t('uplink.auto')}</option><option value="manual">{t('uplink.manual')}</option>
                </select>
            </Field>}
            {supportsUplinkSelection && uplinkMode === 'manual' && <UplinkInterfaces value={Array.isArray(uplink?.interfaces) ? uplink.interfaces.filter((name): name is string => typeof name === 'string') : []}
                onChange={interfaces => onPatch({ uplink: { mode: 'manual', interfaces } })} load={loadUplinkInventory} busy={busy} error={errorAt('uplink.interfaces')}/>}
            <div className="form-grid">{textField('dev_name')}{textField('mtu', true)}{textField('instance_name')}{textField('virtual_ipv6')}{supportsUplinkSelection && textField('socket_mark', true)}{supportsUplinkSelection && textField('netns')}</div>
            <div className="settings-options">{check('ipv6_public_addr_provider')}</div>
            {value.ipv6_public_addr_provider === true && textField('ipv6_public_addr_prefix')}
            {rateField('instance_recv_bps_limit')}
        </fieldset>
        <fieldset className="node-parameter-section form-stack" disabled={busy}>
            <legend>{t('sections.addressing')}</legend>
            {listField('proxy_cidrs')}{listField('exit_nodes')}
            <div className="settings-options">{check('enable_relay_network_whitelist')}</div>
            {value.enable_relay_network_whitelist === true && listField('relay_network_whitelist')}
            <div className="settings-options">{check('enable_manual_routes')}</div>
            {value.enable_manual_routes === true && listField('routes')}
            <Field label={field('socks5_mode')}><select aria-label={field('socks5_mode')} value={socksMode} onChange={event => {
                const next = event.target.value;
                onPatch({ socks5_proxy: next === 'port' ? undefined : next === 'disabled' ? '' : (typeof value.socks5_proxy === 'string' && value.socks5_proxy ? value.socks5_proxy : `socks5://0.0.0.0:${typeof value.socks5_port === 'number' ? value.socks5_port : 1080}`) });
            }}><option value="port">{t('socks.port')}</option><option value="disabled">{t('lists.disabled')}</option><option value="custom">{t('socks.custom')}</option></select></Field>
            {socksMode === 'port' && <><div className="settings-options">{check('enable_socks5')}</div>{value.enable_socks5 === true && textField('socks5_port', true)}</>}
            {socksMode === 'custom' && textField('socks5_proxy')}
        </fieldset>
        <fieldset className="node-parameter-section form-stack" disabled={busy}>
            <legend>{t('sections.relay')}</legend>
            <div className="settings-options">{[...RELAY_FLAGS].map(key => check(key))}</div>
            {rateField('foreign_relay_bps_limit')}
        </fieldset>
        <fieldset className="node-parameter-section form-stack" disabled={busy}>
            <legend>{t('sections.discovery')}</legend>
            {['stun_servers', 'tcp_stun_servers', 'stun_servers_v6'].map(optionalList)}
        </fieldset>
        <fieldset className="node-parameter-section form-stack" disabled={busy}>
            <legend>{t('sections.ports')}</legend>
            {['tcp_whitelist', 'udp_whitelist'].map(optionalList)}
        </fieldset>
        <fieldset className="node-parameter-section form-stack" disabled={busy}>
            <legend>{t('sections.listeners')}</legend>
            {listField('listener_urls')}{listField('mapped_listeners')}
        </fieldset>
        <fieldset className="node-parameter-section form-stack" disabled={busy}>
            <legend>{t('sections.forwards')}</legend>
            {errorAt('port_forwards') && <p role="alert" className="field-error">{errorAt('port_forwards')}</p>}
            <div className="node-row-list">{forwards.map((item, index) => {
                const row = isConfigRecord(item) ? item : {};
                const path = `port_forwards.${index}`;
                const patch = (next: NodeConfigRecord) => onPatch({ port_forwards: patchNodeRow(forwards, index, next) });
                return <fieldset key={index} className="node-parameter-row form-stack">
                    <legend>{t('rows.forward', { index: index + 1 })}</legend>
                    {errorAt(path) && <p role="alert" className="field-error">{errorAt(path)}</p>}
                    <div className="form-grid">
                        <Field label={field('proto')} error={errorAt(`${path}.proto`)}><select aria-label={t('rows.field', { index: index + 1, field: field('proto') })} value={textValue(row.proto)} onChange={event => patch({ proto: event.target.value })}><option value="">—</option><option value="tcp">TCP</option><option value="udp">UDP</option></select></Field>
                        {(['bind_ip', 'bind_port', 'dst_ip', 'dst_port'] as const).map(key => <Field key={key} label={field(key)} error={errorAt(`${path}.${key}`)}><TextDraft label={t('rows.field', { index: index + 1, field: field(key) })} value={textValue(row[key])} numeric={key.endsWith('_port')} busy={busy} onChange={text => patch({ [key]: key.endsWith('_port') ? integerDraft(text) : text })} /></Field>)}
                    </div>
                    <div className="actions"><Button type="button" tone="danger" icon="trash" aria-label={t('actions.removeForward', { index: index + 1 })} onClick={() => onPatch({ port_forwards: forwards.filter((_, i) => i !== index) })}>{t('actions.remove')}</Button></div>
                </fieldset>;
            })}</div>
            <div className="actions"><Button type="button" icon="plus" onClick={() => onPatch({ port_forwards: [...forwards, { proto: 'tcp', bind_ip: '0.0.0.0', bind_port: 0, dst_ip: '', dst_port: 0 }] })}>{t('actions.addForward')}</Button></div>
        </fieldset>
        <fieldset className="node-parameter-section form-stack" disabled={busy}>
            <legend>{t('sections.portal')}</legend>
            {errorAt('vpn_portal_config') && <p role="alert" className="field-error">{errorAt('vpn_portal_config')}</p>}
            <label className="check-row"><input type="checkbox" checked={!!portal && portal.enabled !== false} onChange={event => onPatch({ vpn_portal_config: event.target.checked ? enabledPortal(portal) : patchNodeRecord(portal, { enabled: false }) })} /><span>{field('vpn_portal_enabled')}</span></label>
            {errorAt('vpn_portal_config.enabled') && <p role="alert" className="field-error">{errorAt('vpn_portal_config.enabled')}</p>}
            {portal && <>
                <Field label={field('wireguard_listen')} error={errorAt('vpn_portal_config.wireguard_listen')}><TextDraft label={field('wireguard_listen')} value={textValue(portal.wireguard_listen)} busy={busy} onChange={text => patchPortal({ wireguard_listen: text })} /></Field>
                {errorAt('vpn_portal_config.clients') && <p role="alert" className="field-error">{errorAt('vpn_portal_config.clients')}</p>}
                <div className="node-row-list">{clients.map((item, index) => {
                    const row = isConfigRecord(item) ? item : {};
                    const path = `vpn_portal_config.clients.${index}`;
                    return <fieldset key={index} className="node-parameter-row form-stack">
                        <legend>{t('rows.client', { index: index + 1 })}</legend>
                        {errorAt(path) && <p role="alert" className="field-error">{errorAt(path)}</p>}
                        <div className="form-grid">{(['name', 'virtual_ip'] as const).map(key => <Field key={key} label={field(`client_${key}`)} error={errorAt(`${path}.${key}`)}><TextDraft label={t('rows.field', { index: index + 1, field: field(`client_${key}`) })} value={textValue(row[key])} busy={busy} onChange={text => patchClient(index, { [key]: text })} /></Field>)}</div>
                        <Field label={field('client_groups')} error={errorAt(`${path}.groups`)}><TextDraft label={t('rows.field', { index: index + 1, field: field('client_groups') })} value={listValue(row.groups)} multiline busy={busy} onChange={text => patchClient(index, { groups: nodeList(text) })} /></Field>
                        <div className="actions"><Button type="button" tone="danger" icon="trash" aria-label={t('actions.removeClient', { index: index + 1 })} onClick={() => patchPortal({ clients: clients.filter((_, i) => i !== index) })}>{t('actions.remove')}</Button></div>
                    </fieldset>;
                })}</div>
                <div className="actions"><Button type="button" icon="plus" disabled={clients.length >= MAX_VPN_PORTAL_CLIENTS} onClick={() => patchPortal({ clients: [...clients, { name: '', virtual_ip: '', groups: [] }] })}>{t('actions.addClient')}</Button></div>
            </>}
        </fieldset>
    </div>;
}
