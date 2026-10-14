import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import ApiClient, { type CentralNetworkDetail, type CentralNetworkMember } from '../lib/api';
import { RuntimeDisplay } from '../lib/shared';
import { Alert, Button, Dialog, Field, Tabs, useNotice } from './ui';
import { errorMessage, NetworkValidationError, splitList } from './NetworkSettingsForm';
import { NodeParameters } from './NodeParameters';
import { applyNodePatch, NodeParameterValidationError, prepareNodeParametersForBackend, validateNodeParameters } from '../lib/node-config';

type MemberConfig = Record<string, unknown> & { listener_urls?: string[]; prefer_ipv6?: boolean; proxy_cidrs?: string[] };
export const memberName = (member: CentralNetworkMember) => member.hostname_override || member.alias || member.hostname || member.device_id;

export function MemberEditor({ api, network, member, onClose, onSaved }: {
    api: ApiClient; network: CentralNetworkDetail; member: CentralNetworkMember | null;
    onClose: () => void; onSaved: () => void;
}) {
    const { t } = useTranslation(['networks', 'node-config']);
    const [tab, setTab] = useState('basic');
    const [hostname, setHostname] = useState(''), [address, setAddress] = useState(''), [cidrs, setCidrs] = useState('');
    const [config, setConfig] = useState<MemberConfig>();
    const [parametersValid, setParametersValid] = useState(true);
    const [raw, setRaw] = useState('');
    const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null);
    const [resetConfirm, setResetConfirm] = useState(false);
    const [loadAttempt, setLoadAttempt] = useState(0);
    const notice = useNotice();
    useEffect(() => {
        let active = true;
        setTab('basic'); setError(null); setConfig(undefined); setResetConfirm(false); setParametersValid(true);
        if (!member) { setRaw(''); return; }
        setHostname(member.hostname_override ?? ''); setAddress(member.virtual_ipv4 ?? ''); setCidrs((member.proxy_cidrs ?? []).join('\n'));
        setLoading(true);
        api.get_member_config(network.network_id, member.device_id).then(value => {
            if (!active) return;
            setConfig(value); setRaw(JSON.stringify(value, null, 2));
        }).catch(failure => { if (active) setError(failure); }).finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, [api, network.network_id, member?.device_id, loadAttempt]);
    const changeConfig = (patch: Record<string, unknown>) => {
        const next = applyNodePatch(config ?? {}, patch);
        setConfig(next); setRaw(JSON.stringify(next, null, 2));
        if (Array.isArray(patch.proxy_cidrs)) setCidrs(patch.proxy_cidrs.join('\n'));
    };
    const changeTab = (next: string) => {
        if (tab === 'json' && next !== 'json') {
            try { const parsed = JSON.parse(raw); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new NetworkValidationError('member.errors.jsonObject'); setConfig(parsed); if (Array.isArray(parsed.proxy_cidrs)) setCidrs(parsed.proxy_cidrs.join('\n')); setError(null); }
            catch (failure) { setError(failure); return; }
        }
        setTab(next);
    };
    const submit = async (event: FormEvent) => {
        event.preventDefault(); if (!member || busy) return; setError(null);
        try {
            setBusy(true);
            if (tab === 'basic') {
                const proxyCidrs = splitList(cidrs).map(value => {
                    if (value.includes(':')) throw new NetworkValidationError('member.errors.ipv4Only');
                    const parts = value.split('->');
                    if (parts.length > 2) throw new NetworkValidationError('member.errors.invalidCidr', { value });
                    return parts.map(part => {
                        const normalized = RuntimeDisplay.networkCidr(part);
                        if (!normalized) throw new NetworkValidationError('member.errors.invalidCidr', { value });
                        return normalized;
                    }).join('->');
                });
                await api.update_network_member(network.network_id, member.device_id, { hostname_override: hostname.trim(), virtual_ipv4: address.trim(), proxy_cidrs: [...new Set(proxyCidrs)] });
            } else {
                const next: MemberConfig = tab === 'json' ? JSON.parse(raw) : { ...config };
                if (!next || typeof next !== 'object' || Array.isArray(next)) throw new NetworkValidationError('member.errors.jsonObject');
                const issues = validateNodeParameters(next);
                if (issues.length) throw new NodeParameterValidationError(issues[0]);
                await api.set_member_config(network.network_id, member.device_id, prepareNodeParametersForBackend(next));
            }
            notice({ key: 'member.saved', ns: 'networks' }, 'success'); onSaved(); onClose();
        } catch (failure) { setError(failure); }
        finally { setBusy(false); }
    };
    const reset = async () => {
        if (!member) return; setBusy(true); setError(null);
        try { await api.clear_member_config(network.network_id, member.device_id); notice({ key: 'member.resetSaved', ns: 'networks' }, 'success'); onSaved(); onClose(); }
        catch (failure) { setError(failure); }
        finally { setBusy(false); }
    };
    return <Dialog open={!!member} title={t('member.title', { name: member ? memberName(member) : '' })} onClose={() => { if (!busy) onClose(); }} wide>
        <Tabs items={[{ id: 'basic', label: t('member.tabs.basic') }, { id: 'advanced', label: t('member.tabs.advanced') }, { id: 'json', label: t('member.tabs.json') }]} value={tab} onChange={changeTab} />
        {error !== null && <Alert tone="error">{error instanceof NodeParameterValidationError ? t(error.issue.key, { ns: 'node-config', ...error.issue.values }) : errorMessage(error)}{!config && !loading && tab !== 'basic' && <Button tone="ghost" onClick={() => setLoadAttempt(value => value + 1)}>{t('member.reloadConfig')}</Button>}</Alert>}
        <form className="form-stack" onSubmit={submit}>
            {tab === 'basic' ? <>
                <Field label={t('member.hostname')}><input aria-label={t('member.hostname')} value={hostname} onChange={event => setHostname(event.target.value)} disabled={busy} /></Field>
                <Field label={t('member.address')}><input aria-label={t('member.address')} className="mono" value={address} onChange={event => setAddress(event.target.value)} disabled={busy} /></Field>
                <Field label={t('member.proxyCidrs')}><textarea aria-label={t('member.proxyCidrs')} className="mono" rows={3} value={cidrs} onChange={event => setCidrs(event.target.value)} disabled={busy} /></Field>
            </> : loading ? <p role="status" className="loading-lines">{t('member.loading')}</p> : !config ? <Button tone="ghost" onClick={() => setLoadAttempt(value => value + 1)}>{t('actions.reload')}</Button> : tab === 'json' ? <>
                
                <Field label={t('member.json')}><textarea aria-label={t('member.json')} className="mono code-editor" rows={16} value={raw} onChange={event => setRaw(event.target.value)} spellCheck={false} disabled={busy} /></Field>
            </> : <NodeParameters mode="member" value={config} onPatch={changeConfig} busy={busy} onValidityChange={setParametersValid} />}
            <div className="form-actions"><Button tone="ghost" type="button" onClick={onClose} disabled={busy}>{t('actions.cancel')}</Button><Button type="submit" busy={busy} disabled={tab !== 'basic' && (loading || !config || (tab === 'advanced' && !parametersValid))}>{t('member.save')}</Button></div>
        </form>
        {member?.has_override && <div className="danger-actions">{resetConfirm ? <><p>{t('member.resetExplanation')}</p><Button tone="ghost" onClick={() => setResetConfirm(false)} disabled={busy}>{t('member.cancelReset')}</Button><Button tone="danger" busy={busy} onClick={reset}>{t('member.confirmReset')}</Button></> : <Button tone="ghost" onClick={() => setResetConfirm(true)} disabled={busy}>{t('member.reset')}</Button>}</div>}
    </Dialog>;
}
