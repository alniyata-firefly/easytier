import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
    MAX_VPN_PORTAL_CLIENTS, NODE_BOOLEAN_FLAGS, isConfigRecord, nodeList, parseUint64Input,
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

const textValue = (value: unknown) => value == null ? '' : String(value);
const listValue = (value: unknown) => Array.isArray(value) ? value.filter(entry => typeof entry === 'string').join('\n') : '';
const integerDraft = (text: string): unknown => !text.trim() ? undefined : /^\d+$/.test(text.trim()) ? Number(text) : text;

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

export function NodeParameters({ mode, value, onPatch, busy = false, onValidityChange }: {
    mode: 'member' | 'instance'; value: NodeConfigRecord; onPatch: (patch: NodeConfigRecord) => void;
    busy?: boolean; onValidityChange?: (valid: boolean) => void;
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
            onChange={text => onPatch({ [key]: numeric ? integerDraft(text) : text })} />
    </Field>;
    const listField = (key: string) => <Field label={field(key)} error={errorAt(key)}>
        <TextDraft label={field(key)} value={listValue(value[key])} multiline busy={busy} onChange={text => onPatch({ [key]: nodeList(text) })} />
    </Field>;
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
            <div className="settings-options">{NODE_BOOLEAN_FLAGS.map(key => check(key, key === 'bind_device' || key === 'multi_thread'))}</div>
        </fieldset>
        <fieldset className="node-parameter-section form-stack" disabled={busy}>
            <legend>{t('sections.interface')}</legend>
            <Field label={field('uplink_mode')} error={errorAt('uplink') ?? errorAt('uplink.mode')}>
                <select aria-label={field('uplink_mode')} value={uplinkMode} onChange={event => onPatch({ uplink: event.target.value === 'manual' ? { mode: 'manual', interfaces: [] } : { mode: 'auto', interfaces: [] } })}>
                    <option value="auto">{t('uplink.auto')}</option><option value="manual">{t('uplink.manual')}</option>
                </select>
            </Field>
            {uplinkMode === 'manual' && <Field label={field('uplink_interfaces')} error={errorAt('uplink.interfaces')}>
                <TextDraft label={field('uplink_interfaces')} value={listValue(uplink?.interfaces)} multiline busy={busy}
                    onChange={text => onPatch({ uplink: { mode: 'manual', interfaces: text.split('\n').map(name => name.trim()).filter(Boolean) } })} />
            </Field>}
            <div className="form-grid">{textField('dev_name')}{textField('mtu', true)}</div>
            <Field label={field('instance_recv_bps_limit')} error={errorAt('instance_recv_bps_limit')}>
                <TextDraft label={field('instance_recv_bps_limit')} value={textValue(value.instance_recv_bps_limit)} numeric busy={busy} onChange={text => {
                    const parsed = parseUint64Input(text);
                    onPatch({ instance_recv_bps_limit: parsed.valid ? parsed.value : text });
                }} />
            </Field>
        </fieldset>
        <fieldset className="node-parameter-section form-stack" disabled={busy}>
            <legend>{t('sections.addressing')}</legend>
            {listField('proxy_cidrs')}{listField('exit_nodes')}
            <div className="settings-options">{check('enable_relay_network_whitelist')}</div>
            {value.enable_relay_network_whitelist === true && listField('relay_network_whitelist')}
            <div className="settings-options">{check('enable_manual_routes')}</div>
            {value.enable_manual_routes === true && listField('routes')}
            <div className="settings-options">{check('enable_socks5')}</div>
            {value.enable_socks5 === true && textField('socks5_port', true)}
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
