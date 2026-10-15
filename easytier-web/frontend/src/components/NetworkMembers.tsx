import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ApiClient, { type CentralNetworkDetail, type CentralNetworkMember, type TemporaryPeer } from '../lib/api';
import { useResource } from '../lib/hooks';
import { Utils } from '../lib/shared';
import { Alert, Button, Dialog, Empty, Field, Panel, Status, useNotice } from './ui';
import { errorMessage, NetworkValidationError } from './NetworkSettingsForm';
import { MemberEditor, memberName } from './MemberEditor';
import { CustomLifetimeFields } from './CustomLifetimeFields';
import { MAX_JOIN_CREDENTIAL_SECONDS, resolveLifetime } from '../lib/lifetime';
import { supportsUplinkSelectionForOs } from '../../../frontend-lib/src/modules/uplinkCapabilities';

export function NetworkMembers({ api, network, members, temporaryPeers, loading, onChanged, onObserve }: {
    api: ApiClient; network: CentralNetworkDetail; members: CentralNetworkMember[]; temporaryPeers: TemporaryPeer[];
    loading: boolean; onChanged: () => void; onObserve: () => void;
}) {
    const { t } = useTranslation('networks');
    const [search, setSearch] = useState(''), [adding, setAdding] = useState(false), [editing, setEditing] = useState<CentralNetworkMember | null>(null), [removing, setRemoving] = useState<CentralNetworkMember | null>(null);
    const [selected, setSelected] = useState<string[]>([]), [temporary, setTemporary] = useState(false), [ttl, setTtl] = useState('604800');
    const [customTtl, setCustomTtl] = useState('7');
    const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null);
    const notice = useNotice();
    const devices = useResource(() => api.list_machines(), `member-candidates:${network.network_id}`, adding ? 5000 : 0);
    const deviceInfos = useMemo(() => (devices.data ?? []).map(Utils.buildDeviceInfo), [devices.data]);
    const candidates = useMemo(() => deviceInfos.filter(device => !!device.machine_id && !members.some(member => member.device_id === device.machine_id)).sort((a, b) => Number(b.online) - Number(a.online) || (a.alias || a.hostname || '').localeCompare(b.alias || b.hostname || '')), [deviceInfos, members]);
    const supportsUplinkSelection = supportsUplinkSelectionForOs(deviceInfos.find(device => device.machine_id === editing?.device_id)?.device_os?.os_type);
    const filtered = useMemo(() => members.filter(member => `${memberName(member)} ${member.device_id} ${member.runtime_virtual_ipv4 ?? member.virtual_ipv4 ?? member.allocated_ipv4 ?? ''}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).sort((a, b) => Number(b.online) - Number(a.online) || memberName(a).localeCompare(memberName(b))), [members, search]);
    const external = temporaryPeers.filter(peer => !members.some(member => member.credential_id && member.credential_id === peer.credential_id));
    useEffect(() => { setAdding(false); setEditing(null); setRemoving(null); setSearch(''); }, [network.network_id]);
    const openAdd = () => { setError(null); setSelected([]); setTemporary(network.secure_mode === true); setTtl('604800'); setCustomTtl('7'); setAdding(true); api.clear_snapshots(); devices.refresh(); };
    const add = async () => {
        if (!selected.length || busy) return; setError(null);
        const lifetime = temporary ? resolveLifetime(ttl, customTtl, MAX_JOIN_CREDENTIAL_SECONDS) : { valid: true as const, seconds: undefined };
        if (!lifetime.valid) { setError(new NetworkValidationError('members.invalidTtl')); return; }
        setBusy(true);
        try { await api.add_network_members(network.network_id, selected, temporary, lifetime.seconds); setAdding(false); notice({ key: 'members.added', ns: 'networks' }, 'success'); onChanged(); }
        catch (failure) { setError(failure); }
        finally { setBusy(false); }
    };
    const remove = async () => {
        if (!removing) return; setBusy(true); setError(null);
        try { await api.remove_network_member(network.network_id, removing.device_id); setRemoving(null); notice({ key: 'members.removed', ns: 'networks' }, 'success'); onChanged(); }
        catch (failure) { setError(failure); }
        finally { setBusy(false); }
    };
    return <>
        <Panel title={t('members.title')} action={<Button icon="plus" onClick={openAdd}>{t('members.add')}</Button>}>
            <div className="list-toolbar"><label className="search-field"><span className="sr-only">{t('members.search')}</span><input aria-label={t('members.search')} type="search" placeholder={t('members.searchPlaceholder')} value={search} onChange={event => setSearch(event.target.value)} /></label><span className="muted">{t('list.online', { online: members.filter(member => member.online).length, total: members.length })}</span><Button tone="ghost" busy={loading} icon="refresh" onClick={onChanged}>{t('actions.refresh')}</Button></div>
            {members.length === 0 ? <Empty title={t('members.emptyTitle')} action={<Button onClick={openAdd}>{t('members.add')}</Button>} /> : filtered.length === 0 ? <Empty title={t('members.noMatches')} action={<Button tone="ghost" onClick={() => setSearch('')}>{t('actions.clearSearch')}</Button>} /> : <div className="entity-list member-list">
                {filtered.map(member => <article className="entity-row member-row" key={member.member_id}>
                    <div className="entity-name"><span className={`connection-dot ${member.online ? 'online' : ''}`} aria-hidden="true" /><span><strong>{memberName(member)}</strong><small className="mono">{member.runtime_virtual_ipv4 || member.virtual_ipv4 || member.allocated_ipv4 || t('members.addressPending')}{member.version ? ` · v${member.version.split('-')[0]}` : ''}</small><small>{t(member.online ? 'members.deviceOnline' : 'members.deviceOffline')} · {t(member.running === true ? 'members.running' : member.running === false ? 'members.stopped' : 'members.runningUnknown')}{member.temporary ? ` · ${t('members.credentialMember')}` : ''}</small></span></div>
                    <div className="deployment-fact"><Status state={member.deployment?.state ?? 'unknown'} /><small className="mono" title={t('members.revisions', { applied: member.deployment?.applied_revision ?? t('values.unknown'), desired: member.deployment?.desired_revision ?? t('values.unknown') })}>{member.deployment?.applied_revision?.slice(0, 8) ?? '—'} → {member.deployment?.desired_revision?.slice(0, 8) ?? '—'}</small>{(member.deployment?.last_error || member.error_msg) && <small className="error-text">{member.deployment?.last_error || member.error_msg}</small>}</div>
                    <div className="row-actions"><Button tone="ghost" onClick={() => setEditing(member)}>{t('members.configure')}</Button><Button tone="ghost" onClick={onObserve} disabled={!member.online}>{t('members.observe')}</Button><Button tone="danger" onClick={() => { setError(null); setRemoving(member); }}>{t('members.remove')}</Button></div>
                </article>)}
            </div>}
        </Panel>
        {external.length > 0 && <Panel title={t('members.temporaryTitle')}><div className="entity-list">{external.map(peer => <article className="entity-row" key={peer.peer_id}><div className="entity-name"><span><strong>{peer.hostname || t('members.peerName', { id: peer.peer_id })}</strong><small className="mono">{peer.ipv4 || t('members.addressUnknown')}</small></span></div><span className="mono">{peer.credential_id || t('members.credentialRemoved')}</span><Status state="online" label={t('members.connected')} /></article>)}</div></Panel>}
        <Dialog open={adding} title={t('members.addTitle')} onClose={() => { if (!busy) setAdding(false); }} wide footer={<><Button tone="ghost" onClick={() => setAdding(false)} disabled={busy}>{t('actions.cancel')}</Button><Button busy={busy} disabled={!selected.length || devices.loading} onClick={add}>{t('members.joinDevices', { count: selected.length })}</Button></>}>
            {error !== null && <Alert tone="error">{errorMessage(error)}</Alert>}
            {devices.error && <Alert tone="error">{t('members.devicesReadFailed', { error: devices.error })}<Button tone="ghost" onClick={devices.refresh}>{t('actions.retry')}</Button></Alert>}
            {devices.loading && !devices.data ? <p role="status">{t('members.candidatesLoading')}</p> : candidates.length === 0 ? <Empty title={t('members.noCandidates')} action={<Button tone="ghost" onClick={devices.refresh}>{t('actions.reload')}</Button>} /> : <div className="selection-list">{candidates.map(device => <label className="selection-row" key={device.machine_id}><input type="checkbox" checked={selected.includes(device.machine_id)} disabled={busy} onChange={event => setSelected(previous => event.target.checked ? [...previous, device.machine_id] : previous.filter(id => id !== device.machine_id))} /><span><strong>{device.alias || device.hostname || device.machine_id}</strong><small className="mono">{device.machine_id}</small></span><Status state={device.online ? 'online' : 'offline'} label={t(device.online ? 'members.online' : 'members.offline')} /></label>)}</div>}
            {network.secure_mode && <><Field label={t('members.identity')}><select aria-label={t('members.identity')} value={temporary ? 'credential' : 'trusted'} onChange={event => setTemporary(event.target.value === 'credential')} disabled={busy}><option value="credential">{t('members.credentialIdentity')}</option><option value="trusted">{t('members.trustedIdentity')}</option></select></Field>{temporary && <><Field label={t('members.ttl')}><select aria-label={t('members.ttl')} value={ttl} onChange={event => setTtl(event.target.value)} disabled={busy}><option value="86400">{t('durations.days1')}</option><option value="604800">{t('durations.days7')}</option><option value="2592000">{t('durations.days30')}</option><option value="custom">{t('common:duration.custom')}</option></select></Field>{ttl === 'custom' && <CustomLifetimeFields value={customTtl} maxDays={MAX_JOIN_CREDENTIAL_SECONDS / 86400} disabled={busy} onValueChange={setCustomTtl} />}</>}</>}
        </Dialog>
        <Dialog open={!!removing} title={t('members.removeTitle')} onClose={() => { if (!busy) setRemoving(null); }} footer={<><Button tone="ghost" onClick={() => setRemoving(null)} disabled={busy}>{t('actions.cancel')}</Button><Button tone="danger" busy={busy} onClick={remove}>{t('members.removeConfirm')}</Button></>}>
            {error !== null && <Alert tone="error">{errorMessage(error)}</Alert>}<p>{t('members.removePrompt', { member: removing ? memberName(removing) : '', network: network.display_name })}</p>{removing?.temporary && <Alert tone="warning">{t('members.removeCredentialWarning')}</Alert>}
        </Dialog>
        <MemberEditor api={api} network={network} member={editing} supportsUplinkSelection={supportsUplinkSelection} onClose={() => setEditing(null)} onSaved={onChanged} />
    </>;
}
