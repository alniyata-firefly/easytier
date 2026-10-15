import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDate } from '../lib/i18n';
import ApiClient, { type CentralNetworkDetail, type GatewayInfo, type NetworkCredential } from '../lib/api';
import { useResource } from '../lib/hooks';
import { RuntimeDisplay } from '../lib/shared';
import { Alert, Button, Dialog, Empty, Field, Panel, Status, useNotice } from './ui';
import { errorMessage, NetworkValidationError, splitList } from './NetworkSettingsForm';
import { MAX_JOIN_CREDENTIAL_SECONDS, resolveLifetime } from '../lib/lifetime';
import { networkCredentialSnapshot } from '../lib/credential-export';

type GrantForm = { id: string; ttl: string; groups: string; cidrs: string; reusable: boolean; relay: boolean; rotate: boolean };
const blankForm = (): GrantForm => ({ id: '', ttl: '1', groups: '', cidrs: '', reusable: true, relay: false, rotate: false });
export function CredentialPanel({ api, network, gateway, onChanged }: { api: ApiClient; network: CentralNetworkDetail; gateway?: GatewayInfo; onChanged: () => void }) {
    const { t } = useTranslation('networks');
    const resource = useResource(() => api.list_credentials(network.network_id), `network-credentials:${network.network_id}`, 5000);
    const [editor, setEditor] = useState<NetworkCredential | 'new' | null>(null), [form, setForm] = useState<GrantForm>(blankForm), [removing, setRemoving] = useState<NetworkCredential | null>(null);
    const [revealed, setRevealed] = useState<NetworkCredential | null>(null), [format, setFormat] = useState('cli');
    const [revealedAt, setRevealedAt] = useState(0);
    const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null);
    const notice = useNotice();
    useEffect(() => {
        if (!revealed || !resource.data || resource.updatedAt <= revealedAt) return;
        const current = resource.data.find(item => item.credential_id === revealed.credential_id);
        if (!current || current.expiry_unix <= Date.now() / 1000) setRevealed(null);
        else if (current.credential_secret !== revealed.credential_secret) setRevealed(current);
    }, [resource.data, resource.updatedAt, revealedAt, revealed?.credential_id]);
    const openEditor = (credential: NetworkCredential | 'new') => {
        setError(null); setEditor(credential); setForm(credential === 'new' ? blankForm() : {
            id: credential.credential_id, ttl: '', groups: (credential.acl_groups ?? []).join(', '), cidrs: (credential.allowed_proxy_cidrs ?? []).join('\n'),
            reusable: credential.device_id ? false : credential.reusable, relay: credential.allow_relay ?? false, rotate: false,
        });
    };
    const change = <K extends keyof GrantForm>(key: K, value: GrantForm[K]) => setForm(previous => ({ ...previous, [key]: value }));
    const save = async (event: FormEvent) => {
        event.preventDefault(); if (!editor || busy) return; setError(null);
        const lifetime = editor !== 'new' && form.ttl === '' ? { valid: true as const, seconds: undefined } : resolveLifetime('custom', form.ttl, MAX_JOIN_CREDENTIAL_SECONDS);
        if (!lifetime.valid) { setError(new NetworkValidationError('credentials.invalidTtl')); return; }
        setBusy(true);
        try {
            const grant = { acl_groups: splitList(form.groups), allowed_proxy_cidrs: splitList(form.cidrs), allow_relay: form.relay };
            const credential = editor === 'new'
                ? await api.generate_credential(network.network_id, lifetime.seconds!, form.reusable, form.id.trim() || undefined, grant)
                : await api.update_credential(network.network_id, editor.credential_id, { ...grant, ttl_seconds: lifetime.seconds, reusable: editor.device_id ? false : form.reusable, rotate_secret: form.rotate });
            if (editor === 'new' || form.rotate) { setRevealedAt(Date.now()); setRevealed(credential); setFormat('cli'); }
            setEditor(null); resource.refresh(); onChanged(); notice({ key: 'credentials.saved', ns: 'networks' }, 'success');
        } catch (failure) { setError(failure); }
        finally { setBusy(false); }
    };
    const remove = async () => {
        if (!removing) return; setBusy(true); setError(null);
        try { await api.revoke_credential(network.network_id, removing.credential_id); if (revealed?.credential_id === removing.credential_id) setRevealed(null); setRemoving(null); resource.refresh(); onChanged(); notice({ key: 'credentials.deleted', ns: 'networks' }, 'success'); }
        catch (failure) { setError(failure); }
        finally { setBusy(false); }
    };
    const snapshot = revealed ? networkCredentialSnapshot(network, revealed.credential_secret, gateway?.peer_url) : undefined;
    const joinText = format === 'toml' ? snapshot?.toml ?? '' : format === 'secret' ? revealed?.credential_secret ?? '' : snapshot?.cli ?? '';
    const copy = async () => { const copied = await RuntimeDisplay.copyText(joinText); notice({ key: copied ? 'credentials.copied' : 'credentials.copyFailed', ns: 'networks' }, copied ? 'success' : 'error'); };
    return <>
        <Panel title={t('credentials.title')} action={<Button icon="plus" onClick={() => openEditor('new')}>{t('credentials.generate')}</Button>}>
            
            {resource.error && <Alert tone="error">{t('credentials.readFailed', { error: resource.error })}<Button tone="ghost" onClick={resource.refresh}>{t('actions.retry')}</Button></Alert>}
            {resource.loading && !resource.data ? <p className="loading-lines" role="status">{t('credentials.loading')}</p> : resource.data?.length === 0 ? <Empty title={t('credentials.emptyTitle')} action={<Button onClick={() => openEditor('new')}>{t('credentials.generate')}</Button>} /> : <div className="entity-list credential-list">{(resource.data ?? []).map(credential => {
                const expired = credential.expiry_unix <= Date.now() / 1000;
                return <article className="entity-row credential-row" key={credential.credential_id}><div className="entity-name"><span><strong className="mono">{credential.credential_id}</strong><small>{t(credential.device_id ? 'credentials.bound' : credential.reusable ? 'credentials.reusableType' : 'credentials.singleDevice')} · {t('credentials.expires', { date: formatDate(credential.expiry_unix * 1000, { dateStyle: 'medium', timeStyle: 'short' }) })}</small><small>{(credential.acl_groups ?? []).join(' · ') || t('credentials.noGroups')}</small></span></div><div className="entity-facts"><Status state={expired ? 'expired' : 'active'} /><span>{t('credentials.onlineConnections', { count: credential.online_peers?.length ?? 0 })}</span></div><div className="row-actions"><Button tone="ghost" icon="key" onClick={() => { setRevealedAt(Date.now()); setRevealed(credential); setFormat('cli'); }} disabled={expired}>{t('credentials.join')}</Button><Button tone="ghost" onClick={() => openEditor(credential)}>{t('actions.edit')}</Button><Button tone="danger" disabled={!!credential.device_id} onClick={() => { setError(null); setRemoving(credential); }}>{t('actions.delete')}</Button></div></article>;
            })}</div>}
        </Panel>
        <Dialog open={!!editor} title={t(editor === 'new' ? 'credentials.createTitle' : 'credentials.editTitle')} onClose={() => { if (!busy) setEditor(null); }} wide>
            {error !== null && <Alert tone="error">{errorMessage(error)}</Alert>}
            <form className="form-stack" onSubmit={save}>
                {editor === 'new' ? <Field label={t('credentials.name')}><input aria-label={t('credentials.name')} value={form.id} onChange={event => change('id', event.target.value)} disabled={busy} /></Field> : <p className="mono">{editor?.credential_id}</p>}
                <Field label={t(editor === 'new' ? 'credentials.ttl' : 'credentials.resetTtl')}><input aria-label={t('credentials.ttlAria')} type="number" inputMode="numeric" min={1} max={MAX_JOIN_CREDENTIAL_SECONDS / 86400} step={1} value={form.ttl} onChange={event => change('ttl', event.target.value)} required={editor === 'new'} disabled={busy} /></Field>
                <Field label={t('credentials.groups')}><textarea aria-label={t('credentials.groups')} rows={2} value={form.groups} onChange={event => change('groups', event.target.value)} disabled={busy} /></Field>
                <Field label={t('credentials.cidrs')}><textarea aria-label={t('credentials.cidrs')} className="mono" rows={2} value={form.cidrs} onChange={event => change('cidrs', event.target.value)} disabled={busy} /></Field>
                <label className="check-row"><input type="checkbox" checked={form.reusable} onChange={event => change('reusable', event.target.checked)} disabled={busy || (editor !== 'new' && !!editor?.device_id)} /><span>{t('credentials.reusable')}</span></label>
                <label className="check-row"><input type="checkbox" checked={form.relay} onChange={event => change('relay', event.target.checked)} disabled={busy} /><span>{t('credentials.relay')}</span></label>
                {editor !== 'new' && <label className="check-row"><input type="checkbox" checked={form.rotate} onChange={event => change('rotate', event.target.checked)} disabled={busy} /><span>{t('credentials.rotate')}</span></label>}
                {editor !== 'new' && form.rotate && <Alert tone="warning">{t('credentials.rotateHint')}</Alert>}
                <div className="form-actions"><Button tone="ghost" type="button" onClick={() => setEditor(null)} disabled={busy}>{t('actions.cancel')}</Button><Button type="submit" busy={busy}>{t(editor === 'new' ? 'credentials.generate' : 'credentials.save')}</Button></div>
            </form>
        </Dialog>
        <Dialog open={!!removing} title={t('credentials.deleteTitle')} onClose={() => { if (!busy) setRemoving(null); }} footer={<><Button tone="ghost" onClick={() => setRemoving(null)} disabled={busy}>{t('actions.cancel')}</Button><Button tone="danger" busy={busy} onClick={remove}>{t('actions.confirmDelete')}</Button></>}>
            {error !== null && <Alert tone="error">{errorMessage(error)}</Alert>}<p>{t('credentials.deletePrompt', { id: removing?.credential_id ?? '' })}</p>
        </Dialog>
        <Dialog open={!!revealed} title={t('credentials.joinTitle')} onClose={() => setRevealed(null)} wide footer={<Button icon="copy" onClick={copy}>{t(format === 'secret' ? 'credentials.copySecret' : format === 'toml' ? 'credentials.copyConfig' : 'credentials.copyCommand')}</Button>}>
            <Alert tone="warning">{t('credentials.secretWarning')}</Alert><Field label={t('credentials.format')}><select aria-label={t('credentials.format')} value={format} onChange={event => setFormat(event.target.value)}><option value="cli">{t('credentials.formatCli')}</option><option value="toml">{t('credentials.formatToml')}</option><option value="secret">{t('credentials.formatSecret')}</option></select></Field><pre className="code-block mono">{joinText}</pre>
        </Dialog>
    </>;
}
