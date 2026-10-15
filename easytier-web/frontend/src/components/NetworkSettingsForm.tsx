import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { CentralNetworkDetail, CentralNetworkSettings, CentralNetworkTransport, GatewayInfo } from '../lib/api';
import { Alert, Button, Field } from './ui';
import { v4 as uuidv4 } from 'uuid';
import { errorMessage as requestErrorMessage } from '../lib/hooks';
import i18next from '../lib/i18n';
import { ENCRYPTION_ALGORITHMS, NODE_PROTOCOLS, NodeParameterValidationError, validateNodeParameters } from '../lib/node-config';

/** Keep validation identity, rather than a translated string, across language changes. */
export class NetworkValidationError extends Error {
    constructor(public readonly key: string, public readonly values?: Record<string, string | number>) { super(key); this.name = 'NetworkValidationError'; }
}
export const errorMessage = (error: unknown) => error instanceof NodeParameterValidationError
    ? i18next.t(`node-config:${error.issue.key}`, error.issue.values)
    : error instanceof NetworkValidationError
    ? i18next.t(`networks:${error.key}`, error.values)
    : error instanceof TypeError || error instanceof SyntaxError ? i18next.t('networks:validation.invalidFormat') : requestErrorMessage(error);
export const splitList = (text: string) => [...new Set(text.split(/[\s,]+/).map(value => value.trim()).filter(Boolean))];
export const networkMethodName = (method: string) => ['Gateway', 'Manual', 'PublicServer', 'Standalone'].includes(method) ? i18next.t(`networks:methods.${method}`) : method;

export function NetworkSettingsForm({ network, gateway, busy, onSave, onCancel }: {
    network?: CentralNetworkDetail; gateway?: GatewayInfo; busy: boolean;
    onSave: (settings: CentralNetworkSettings, secret?: string) => Promise<void>; onCancel?: () => void;
}) {
    const { t } = useTranslation('networks');
    const [name, setName] = useState(network?.display_name ?? '');
    const [identity, setIdentity] = useState(network?.network_name ?? '');
    const [cidr, setCidr] = useState(network?.virtual_cidr ?? '');
    const [method, setMethod] = useState(network?.networking_method ?? (gateway?.enabled ? 'Gateway' : 'Manual'));
    const [peers, setPeers] = useState((network?.peer_urls ?? []).join('\n'));
    const [server, setServer] = useState(network?.public_server_url ?? '');
    const [secure, setSecure] = useState(network?.secure_mode ?? gateway?.enabled ?? false);
    const [preferIpv6, setPreferIpv6] = useState(network?.prefer_ipv6 ?? false);
    const [transport, setTransport] = useState<CentralNetworkTransport>(() => ({ ...network?.transport }));
    const [rotate, setRotate] = useState(false);
    const [error, setError] = useState<unknown>(null);
    const changeTransport = <K extends keyof CentralNetworkTransport,>(key: K, value: CentralNetworkTransport[K]) => {
        setTransport(current => {
            const next = { ...current };
            if (value === undefined) delete next[key]; else next[key] = value;
            return next;
        });
    };
    const transportToggle = (key: Exclude<keyof CentralNetworkTransport, 'data_compress_algo' | 'encryption_algorithm' | 'default_protocol' | 'tld_dns_zone'>, inverted = false) => {
        const current = transport[key];
        const selected = current === undefined ? 'inherit' : current !== inverted ? 'enabled' : 'disabled';
        const label = t(`transport.${key}`);
        return <Field key={key} label={label}>
            <select aria-label={label} value={selected} disabled={busy}
                onChange={event => changeTransport(key, event.target.value === 'inherit' ? undefined : (event.target.value === 'enabled') !== inverted)}>
                <option value="inherit">{t('transport.inherit')}</option>
                <option value="disabled">{t('transport.disabled')}</option>
                <option value="enabled">{t('transport.enabled')}</option>
            </select>
        </Field>;
    };
    const submit = async (event: FormEvent) => {
        event.preventDefault(); setError(null);
        const urls = splitList(peers);
        if (!name.trim()) { setError(new NetworkValidationError('validation.nameRequired')); return; }
        if (method === 'Gateway' && !gateway?.enabled) { setError(new NetworkValidationError('validation.gatewayDisabled')); return; }
        if (method === 'Manual' && urls.length === 0) { setError(new NetworkValidationError('validation.peerRequired')); return; }
        try {
            const issues = validateNodeParameters(transport as Record<string, unknown>);
            if (issues.length) throw new NodeParameterValidationError(issues[0]);
            for (const url of method === 'Manual' ? urls : method === 'PublicServer' ? [server.trim()] : []) {
                if (!url) throw new NetworkValidationError('validation.serverRequired');
                new URL(url);
            }
            await onSave({ display_name: name.trim(), network_name: identity.trim() || null,
                networking_method: method, public_server_url: method === 'PublicServer' ? server.trim() : null,
                peer_urls: method === 'Manual' ? urls : [], virtual_cidr: cidr.trim() || null,
                secure_mode: secure, prefer_ipv6: preferIpv6, transport: { ...transport } }, rotate ? uuidv4() : undefined);
            setRotate(false);
        } catch (failure) { setError(failure); }
    };
    return <form onSubmit={submit} className="form-stack">
        {error !== null && <Alert tone="error">{errorMessage(error)}</Alert>}
        <div className="form-grid">
            <Field label={t('settings.name')}><input aria-label={t('settings.name')} value={name} onChange={event => setName(event.target.value)} required maxLength={128} disabled={busy} /></Field>
            <Field label={t('settings.cidr')}><input aria-label={t('settings.cidr')} value={cidr} onChange={event => setCidr(event.target.value)} className="mono" disabled={busy} /></Field>
        </div>
        <Field label={t('settings.method')}><select aria-label={t('settings.method')} value={method} onChange={event => setMethod(event.target.value)} disabled={busy}>
            <option value="Gateway" disabled={!gateway?.enabled}>{t(gateway?.enabled ? 'methods.Gateway' : 'methods.gatewayDisabled')}</option>
            <option value="Manual">{t('methods.Manual')}</option><option value="PublicServer">{t('methods.PublicServer')}</option><option value="Standalone">{t('methods.Standalone')}</option>
        </select></Field>
        {method === 'Gateway' && <p className="mono">{gateway?.peer_url ?? t('settings.gatewayLoading')}</p>}
        {method === 'Manual' && <Field label={t('settings.peers')}><textarea aria-label={t('settings.peers')} rows={3} value={peers} onChange={event => setPeers(event.target.value)} className="mono" disabled={busy} /></Field>}
        {method === 'PublicServer' && <Field label={t('settings.server')}><input aria-label={t('settings.server')} value={server} onChange={event => setServer(event.target.value)} required className="mono" disabled={busy} /></Field>}
        <div className="settings-options">
            <label className="check-row"><input type="checkbox" checked={secure} onChange={event => setSecure(event.target.checked)} disabled={busy} /><span>{t('settings.secure')}</span></label>
            <label className="check-row"><input type="checkbox" checked={preferIpv6} onChange={event => setPreferIpv6(event.target.checked)} disabled={busy} /><span>{t('settings.preferIpv6')}</span></label>
        </div>
        <fieldset className="node-parameter-section form-stack" disabled={busy}>
            <legend>{t('transport.title')}</legend>
            <div className="form-grid">
                <Field label={t('transport.data_compress_algo')}>
                    <select aria-label={t('transport.data_compress_algo')} value={transport.data_compress_algo ?? 'inherit'} disabled={busy}
                        onChange={event => changeTransport('data_compress_algo', event.target.value === 'inherit' ? undefined : event.target.value === '2' ? 2 : 1)}>
                        <option value="inherit">{t('transport.inherit')}</option>
                        <option value="1">{t('transport.disabled')}</option>
                        <option value="2">{t('transport.zstd')}</option>
                    </select>
                </Field>
                {transportToggle('enable_kcp_proxy')}
                {transportToggle('disable_kcp_input', true)}
                {transportToggle('enable_quic_proxy')}
                {transportToggle('disable_quic_input', true)}
                {transportToggle('disable_encryption', true)}
                {(['encryption_algorithm', 'default_protocol'] as const).map(key => <Field key={key} label={t(`transport.${key}`)}>
                    <select aria-label={t(`transport.${key}`)} value={transport[key] ?? 'inherit'} disabled={busy} onChange={event => changeTransport(key, event.target.value === 'inherit' ? undefined : event.target.value)}>
                        <option value="inherit">{t('transport.inherit')}</option>
                        {(key === 'encryption_algorithm' ? ENCRYPTION_ALGORITHMS : NODE_PROTOCOLS).map(option => <option key={option} value={option}>{option}</option>)}
                    </select>
                </Field>)}
                <Field label={t('transport.tld_dns_zone_mode')}>
                    <select aria-label={t('transport.tld_dns_zone_mode')} value={transport.tld_dns_zone === undefined ? 'inherit' : 'custom'} disabled={busy} onChange={event => changeTransport('tld_dns_zone', event.target.value === 'inherit' ? undefined : transport.tld_dns_zone || 'et.net.')}>
                        <option value="inherit">{t('transport.inherit')}</option><option value="custom">{t('transport.custom')}</option>
                    </select>
                </Field>
                {transport.tld_dns_zone !== undefined && <Field label={t('transport.tld_dns_zone')}><input aria-label={t('transport.tld_dns_zone')} value={transport.tld_dns_zone} required disabled={busy} onChange={event => changeTransport('tld_dns_zone', event.target.value)}/></Field>}

            </div>
        </fieldset>
        <details className="advanced-fields"><summary>{t('settings.identitySection')}</summary>
            <Field label={t('settings.identity')}><input aria-label={t('settings.identity')} value={identity} onChange={event => setIdentity(event.target.value)} className="mono" disabled={busy} /></Field>
            {network && <label className="check-row"><input type="checkbox" checked={rotate} onChange={event => setRotate(event.target.checked)} disabled={busy} /><span>{t('settings.rotate')}</span></label>}
        </details>
        <div className="form-actions">{onCancel && <Button tone="ghost" type="button" onClick={onCancel} disabled={busy}>{t('actions.cancel')}</Button>}<Button type="submit" busy={busy}>{t(network ? 'settings.save' : 'list.create')}</Button></div>
    </form>;
}
