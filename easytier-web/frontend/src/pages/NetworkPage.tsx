import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ApiClient, { type ConsoleInfo } from '../lib/api';
import { useResource } from '../lib/hooks';
import { navigate } from '../lib/router';
import { Alert, Button, Dialog, Empty, Panel, Status, Tabs, useNotice } from '../components/ui';
import { NetworkSettingsForm, errorMessage, networkMethodName } from '../components/NetworkSettingsForm';
import { NetworkMembers } from '../components/NetworkMembers';
import { CredentialPanel } from '../components/CredentialPanel';
import { AclPolicyPanel } from '../components/AclPolicyPanel';
import { NetworkObservability } from '../components/NetworkObservability';

export function NetworkPage({ api, networkId, consoleInfo }: { api: ApiClient; networkId: string; consoleInfo: ConsoleInfo }) {
    const { t } = useTranslation('networks');
    const resource = useResource(() => api.get_network(networkId), `network:${networkId}`, 5000);
    const members = useResource(() => api.list_network_members(networkId), `network-members:${networkId}`, 5000);
    const gateway = useResource(() => api.get_gateway_info(), 'network-page-gateway');
    const [tab, setTab] = useState('members'), [settingsRevision, setSettingsRevision] = useState(0);
    const [busy, setBusy] = useState(false), [deleting, setDeleting] = useState(false), [deleteError, setDeleteError] = useState<unknown>(null);
    const notice = useNotice();
    useEffect(() => { setTab('members'); setDeleting(false); setDeleteError(null); setSettingsRevision(0); }, [networkId]);
    const refresh = () => { api.clear_snapshots(); resource.refresh(); members.refresh(); };
    const network = resource.data;
    if (consoleInfo.webhook_auth) return <Empty title={t('detail.externalTitle')} />;
    if (!network) return <div className="page"><header className="page-heading"><div><h1>{t('detail.title')}</h1></div><Button tone="ghost" onClick={() => navigate('/h/networks')}>{t('detail.back')}</Button></header>{resource.loading ? <Panel><p role="status" className="loading-lines">{t('list.loading')}</p></Panel> : <>{resource.error && <Alert tone="error">{resource.error}</Alert>}<Empty title={t('detail.unavailable')} action={<Button onClick={refresh}>{t('actions.retry')}</Button>} /></>}</div>;
    const tabs = [{ id: 'members', label: t('tabs.members'), count: members.data?.members.length }, { id: 'observability', label: t('tabs.observability') }, { id: 'acl', label: t('tabs.acl') }, ...(network.secure_mode ? [{ id: 'credentials', label: t('tabs.credentials') }] : []), { id: 'settings', label: t('tabs.settings') }];
    const currentTab = tabs.some(item => item.id === tab) ? tab : 'members';
    return <div className="page network-page">
        <header className="page-heading"><div><button className="breadcrumb-link" onClick={() => navigate('/h/networks')}>{t('detail.breadcrumb')}</button><h1>{network.display_name}</h1><div className="entity-facts"><span>{networkMethodName(network.networking_method)}</span>{network.virtual_cidr && <span className="mono">{network.virtual_cidr}</span>}<span>{t(network.prefer_ipv6 ? 'preference.ipv6' : 'preference.default')}</span></div></div><Button tone="ghost" icon="refresh" busy={resource.loading || members.loading} onClick={refresh}>{t('actions.refresh')}</Button></header>
        {resource.error && <Alert tone="error">{t('detail.refreshFailed', { error: resource.error })}<Button tone="ghost" onClick={resource.refresh}>{t('actions.retry')}</Button></Alert>}
        <div className="deployment-summary" role="status"><span>{t('detail.deployment')}</span><Status state={network.deployment?.state ?? 'unknown'} />{network.deployment?.gateway && <><span className="muted">{t('detail.gateway')}</span><Status state={network.deployment.gateway.state} /><Status state={network.deployment.gateway.running ? 'running' : 'stopped'} /></>}</div>
        {network.deployment?.gateway?.last_error && <Alert tone="warning">{t('detail.gatewayError', { error: network.deployment.gateway.last_error })}</Alert>}
        <Tabs items={tabs} value={currentTab} onChange={setTab} />
        <div className="tab-content" role="tabpanel" aria-label={tabs.find(item => item.id === currentTab)?.label}>
            {currentTab === 'members' && <>{members.error && <Alert tone="error">{t('detail.membersReadFailed', { error: members.error })}<Button tone="ghost" onClick={members.refresh}>{t('actions.retry')}</Button></Alert>}{members.loading && !members.data ? <Panel><p className="loading-lines" role="status">{t('detail.membersLoading')}</p></Panel> : members.data ? <NetworkMembers api={api} network={network} members={members.data.members} temporaryPeers={members.data.temporary_peers} loading={members.loading} onChanged={refresh} onObserve={() => setTab('observability')} /> : <Empty title={t('detail.membersUnavailable')} action={<Button onClick={members.refresh}>{t('actions.retry')}</Button>} />}</>}
            {currentTab === 'observability' && <>{members.error && <Alert tone="warning">{t('detail.membersRefreshFailed')}<Button tone="ghost" onClick={members.refresh}>{t('actions.retry')}</Button></Alert>}<NetworkObservability api={api} networkId={networkId} members={members.data?.members ?? []} gateway={network.networking_method === 'Gateway' ? network.deployment?.gateway : undefined} /></>}
            {currentTab === 'acl' && <AclPolicyPanel api={api} networkId={networkId} members={members.data?.members ?? []} onChanged={refresh} />}
            {currentTab === 'credentials' && <CredentialPanel api={api} network={network} gateway={gateway.data} onChanged={refresh} />}
            {currentTab === 'settings' && <>
                <Panel title={t('settings.title')}><NetworkSettingsForm key={`${networkId}:${settingsRevision}`} network={network} gateway={gateway.data} busy={busy || gateway.loading} onSave={async (settings, secret) => {
                    setBusy(true);
                    try { await api.update_network(networkId, settings, secret); refresh(); notice({ key: 'settings.saved', ns: 'networks' }, 'success'); }
                    finally { setBusy(false); }
                }} /><div className="form-actions"><Button tone="ghost" disabled={busy} onClick={() => { resource.refresh(); gateway.refresh(); setSettingsRevision(value => value + 1); }}>{t('settings.restore')}</Button></div>{gateway.error && <Alert tone="warning">{t('detail.gatewayReadFailed', { error: gateway.error })}<Button tone="ghost" onClick={gateway.refresh}>{t('actions.retryRead')}</Button></Alert>}</Panel>
                <Panel title={t('detail.deleteTitle')}><Button tone="danger" icon="trash" onClick={() => { setDeleteError(null); setDeleting(true); }}>{t('detail.deleteAction')}</Button></Panel>
            </>}
        </div>
        <Dialog open={deleting} title={t('detail.deleteTitle')} onClose={() => { if (!busy) setDeleting(false); }} footer={<><Button tone="ghost" onClick={() => setDeleting(false)} disabled={busy}>{t('actions.cancel')}</Button><Button tone="danger" busy={busy} onClick={async () => {
            setBusy(true); setDeleteError(null);
            try { await api.delete_network(networkId); setDeleting(false); notice({ key: 'detail.deleted', ns: 'networks' }, 'success'); navigate('/h/networks'); }
            catch (failure) { setDeleteError(failure); }
            finally { setBusy(false); }
        }}>{t('detail.deleteConfirm')}</Button></>}><p>{t('detail.deletePrompt', { name: network.display_name, count: network.member_count })}</p>{deleteError !== null && <Alert tone="error">{errorMessage(deleteError)}</Alert>}</Dialog>
    </div>;
}

export default NetworkPage;
