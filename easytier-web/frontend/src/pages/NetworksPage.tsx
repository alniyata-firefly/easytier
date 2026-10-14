import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ApiClient, { type ConsoleInfo } from '../lib/api';
import { useResource } from '../lib/hooks';
import { navigate, networkPath } from '../lib/router';
import { Alert, Button, Dialog, Empty, Panel, Status, useNotice } from '../components/ui';
import { NetworkSettingsForm, networkMethodName } from '../components/NetworkSettingsForm';

export function NetworksPage({ api, consoleInfo }: { api: ApiClient; consoleInfo: ConsoleInfo }) {
    const { t } = useTranslation('networks');
    const resource = useResource(() => api.list_networks(), 'central-networks', 5000);
    const gateway = useResource(() => api.get_gateway_info(), 'network-gateway');
    const [search, setSearch] = useState('');
    const [create, setCreate] = useState(false);
    const [busy, setBusy] = useState(false);
    const notice = useNotice();
    const networks = useMemo(() => (resource.data ?? []).filter(network => `${network.display_name} ${network.network_name}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).sort((a, b) => a.display_name.localeCompare(b.display_name)), [resource.data, search]);
    if (consoleInfo.webhook_auth) return <Empty title={t('list.externalTitle')} />;
    return <div className="page networks-page">
        <header className="page-heading"><div><h1>{t('list.title')}</h1></div><Button icon="plus" onClick={() => setCreate(true)} disabled={gateway.loading}>{t('list.create')}</Button></header>
        {resource.error && <Alert tone="error">{t('list.readFailed', { error: resource.error })} <Button tone="ghost" onClick={resource.refresh}>{t('actions.retry')}</Button></Alert>}
        <Panel action={<Button icon="refresh" tone="ghost" busy={resource.loading} onClick={() => { api.clear_snapshots(); resource.refresh(); }}>{t('actions.refresh')}</Button>}>
            <div className="list-toolbar"><label className="search-field"><span className="sr-only">{t('list.search')}</span><input aria-label={t('list.search')} type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder={t('list.searchPlaceholder')} /></label><span className="muted">{resource.data === undefined ? t('actions.loading') : t('list.count', { count: networks.length })}</span></div>
            {resource.loading && !resource.data ? <div className="loading-lines" role="status">{t('list.loading')}</div> : resource.data?.length === 0 ? <Empty title={t('list.emptyTitle')} action={<Button onClick={() => setCreate(true)}>{t('list.create')}</Button>} /> : networks.length === 0 && resource.data ? <Empty title={t('list.noMatches')} action={<Button tone="ghost" onClick={() => setSearch('')}>{t('actions.clearSearch')}</Button>} /> : <div className="entity-list network-list">
                {networks.map(network => <article key={network.network_id} className="entity-row">
                    <button className="entity-name" onClick={() => navigate(networkPath(network.network_id))}><span className="entity-symbol" aria-hidden="true">◇</span><span><strong>{network.display_name}</strong><small className="mono">{network.network_name}</small></span></button>
                    <div className="entity-facts"><span>{networkMethodName(network.networking_method)}</span><span>{t('list.online', { online: network.online_member_count, total: network.member_count })}</span><Status state={network.secure_mode ? 'applied' : 'unknown'} label={t(network.secure_mode ? 'modes.secure' : 'modes.standard')} /></div>
                    <Button tone="ghost" icon="arrow" onClick={() => navigate(networkPath(network.network_id))}>{t('list.manage')}</Button>
                </article>)}
            </div>}
        </Panel>
        <Dialog open={create} title={t('list.create')} onClose={() => { if (!busy) setCreate(false); }} wide>
            {gateway.error && <Alert tone="warning">{t('list.gatewayUnavailable')}<Button tone="ghost" onClick={gateway.refresh}>{t('actions.reload')}</Button></Alert>}
            {create && <NetworkSettingsForm gateway={gateway.data} busy={busy} onCancel={() => setCreate(false)} onSave={async (settings, secret) => {
                setBusy(true);
                try { const network = await api.create_network(settings, secret); setCreate(false); resource.refresh(); notice({ key: 'list.created', ns: 'networks' }, 'success'); navigate(networkPath(network.network_id)); }
                finally { setBusy(false); }
            }} />}
        </Dialog>
    </div>;
}

export default NetworksPage;
