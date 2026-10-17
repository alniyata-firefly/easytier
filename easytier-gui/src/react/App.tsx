import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { NativeSession, Api, NetworkTypes, Utils, loadLastNetworkInstanceId, saveLastNetworkInstanceId, initializeDesktopTray, updateDesktopTray, copyText } from '../native/bridge';
import { Alert, Button, Dialog, Empty, Field, Icon, BrandMark, LanguageSwitch, Panel, Status, useNotice } from './components/ui';
import { RuntimePanel } from './components/RuntimePanel';
import { supportsUplinkSelectionForTarget } from './lib/uplink-capabilities';
import { aggregateNetworkState, clientConnectionStatus, networkConnectionState, networkConnectionStatus } from './lib/management-status';
const NetworkEditor = lazy(() => import('./components/NetworkEditor').then(module => ({ default: module.NetworkEditor })));
const SettingsPanel = lazy(() => import('./components/SettingsPanel').then(module => ({ default: module.SettingsPanel })));

interface NetworkRow { id: string; running: boolean; meta: Api.NetworkMeta }
export function App() {
  const { t, i18n } = useTranslation('client'), notice = useNotice();
  const [session] = useState(() => new NativeSession());
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot), client = session.remoteClient;
  const localAndroid = snapshot.platform === 'android' && snapshot.mode.mode === 'normal';
  const retryDisconnect = snapshot.vpnStopIncomplete || snapshot.errorCode === 'client_stop_failed';
  const disconnectVpn = retryDisconnect || !snapshot.clientPaused;
  const canManageConfigs = snapshot.connected || snapshot.mode.mode === 'normal';
  const configurationScope = JSON.stringify(snapshot.mode);
  const [page, setPage] = useState('networks'), [networks, setNetworks] = useState<NetworkRow[]>([]);
  const [selected, setSelected] = useState<string>(() => loadLastNetworkInstanceId() ?? ''), [info, setInfo] = useState<NetworkTypes.NetworkInstanceRunningInfo>();
  const [runtimes, setRuntimes] = useState<Record<string, NetworkTypes.NetworkInstanceRunningInfo>>({});
  const [loadingError, setLoadingError] = useState(false), [busy, setBusy] = useState(false), [refreshKey, setRefreshKey] = useState(0);
  const connectionStatus = clientConnectionStatus(snapshot, loadingError ? 'unknown' : aggregateNetworkState(networks.filter(network => network.running).map(network => network.id), runtimes));
  const [editor, setEditor] = useState<NetworkTypes.NetworkConfig>(), [removing, setRemoving] = useState<string>();
  const [exported, setExported] = useState<{ name: string; text: string }>();
  const [importing, setImporting] = useState(false), [importText, setImportText] = useState(''), [importError, setImportError] = useState(false);
  const selectedRef = useRef(selected), busyRef = useRef(false);
  const rpcContext = useRef<string | undefined>(undefined);
  selectedRef.current = selected; busyRef.current = busy || snapshot.busy;
  useEffect(() => { void session.initialize(); return () => session.dispose(); }, [session]);
  useEffect(() => { const media = matchMedia('(prefers-color-scheme: dark)'); const update = () => { let theme = 'system'; try { theme = localStorage.getItem('easytier.client.theme') || 'system'; } catch {} document.documentElement.dataset.theme = theme === 'system' ? media.matches ? 'dark' : 'light' : theme === 'dark' ? 'dark' : 'light'; }; update(); media.addEventListener('change', update); return () => media.removeEventListener('change', update); }, []);
  useEffect(() => { if (snapshot.version) void initializeDesktopTray(snapshot.version, { show: i18n.t('tray.show', { ns: 'devices', defaultValue: 'EasyTier' }), exit: t('exit') }).catch(() => {}); }, [snapshot.version, i18n, t]);
  useEffect(() => { if (snapshot.platform !== 'android') void updateDesktopTray({ show: 'EasyTier', exit: t('exit') }, networks.filter(item => item.running).map(item => item.meta.network_name).join(', ')).catch(() => {}); }, [networks, snapshot.platform, t]);
  useEffect(() => { if (selected) saveLastNetworkInstanceId(selected); }, [selected]);
  useEffect(() => {
    if (rpcContext.current !== configurationScope) { setNetworks([]); setRuntimes({}); setInfo(undefined); setEditor(undefined); setRemoving(undefined); setExported(undefined); setImporting(false); setImportText(''); setImportError(false); rpcContext.current = configurationScope; }
    if (!canManageConfigs) { setNetworks([]); setRuntimes({}); setInfo(undefined); return; }
    let alive = true, timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      if (!busyRef.current && !document.hidden) try {
        const ids = await client.list_network_instance_ids(), running = new Set((ids.running_inst_ids ?? []).map(Utils.UuidToStr));
        const all = [...new Set([...running, ...(ids.disabled_inst_ids ?? []).map(Utils.UuidToStr)])];
        const metas = await client.get_network_metas(all);
        const currentRuntimes = running.size ? await client.get_network_infos() : {};
        if (!alive) return;
        const rows = all.map(id => ({ id, running: running.has(id), meta: metas.metas[id] ?? { network_name: id, config_permission: Api.ConfigFilePermission.READ_ONLY | Api.ConfigFilePermission.NO_DELETE } }));
        setNetworks(rows); setRuntimes(currentRuntimes); setLoadingError(false);
        const id = all.includes(selectedRef.current) ? selectedRef.current : all[0] ?? '';
        if (id !== selectedRef.current) { selectedRef.current = id; setSelected(id); }
        if (id && running.has(id)) {
          const runtime = currentRuntimes[id];
          if (alive && selectedRef.current === id) setInfo(runtime);
        } else if (alive) setInfo(undefined);
      } catch { if (alive) { setLoadingError(true); setRuntimes({}); setInfo(undefined); } }
      if (alive) timer = setTimeout(refresh, 3000);
    };
    void refresh(); return () => { alive = false; clearTimeout(timer); };
  }, [canManageConfigs, configurationScope, snapshot.connected, snapshot.revision, refreshKey, client]);
  const refresh = () => setRefreshKey(key => key + 1);
  const mutate = async (operation: () => Promise<unknown>) => { setBusy(true); try { await operation(); refresh(); } catch { notice(t('nativeError'), 'error'); } finally { setBusy(false); } };
  const row = networks.find(item => item.id === selected), permission = row?.meta.config_permission ?? 3;
  const canEdit = !!row && !loadingError && !Api.isManagedNetwork(row.meta) && Api.ConfigFilePermission.isEditable(permission), canDelete = !!row && !loadingError && !Api.isManagedNetwork(row.meta) && Api.ConfigFilePermission.isDeletable(permission);
  const canControl = !!row && !Api.isManagedNetwork(row.meta);
  const networkStatus = (item: NetworkRow) => { const status = networkConnectionStatus(loadingError ? 'unknown' : networkConnectionState(item.running, runtimes[item.id])); return <Status state={status.state} label={t(status.label)}/>; };
  const openEditor = async (id?: string) => { if (!id) { setEditor(NetworkTypes.DEFAULT_NETWORK_CONFIG()); return; } await mutate(async () => { const config = await client.get_network_config(id); setEditor(config); }); };
  const download = async () => mutate(async () => {
    if (!selected) return;
    const config = await client.get_network_config(selected), result = await client.generate_config(config);
    if (result.error || !result.toml_config) throw new Error('config_generation_failed');
    setExported({ name: config.network_name ?? 'network', text: result.toml_config });
  });
  const parseImport = async () => { setBusy(true); setImportError(false); try { const parsed = await client.parse_config(importText); if (!parsed.config || parsed.error) throw new Error('config_parse_failed'); const config = { ...parsed.config, instance_id: crypto.randomUUID() }; setImporting(false); setImportText(''); setEditor(config); } catch { setImportError(true); } finally { setBusy(false); } };
  return <div className="client-shell">
    <header className="client-topbar"><a className="client-brand" href="#" onClick={event => { event.preventDefault(); setPage('networks'); }}><span className="brand-mark"><BrandMark size={24}/></span>EasyTier</a><span className="desktop-version">{snapshot.version}</span><div className="client-topbar-actions"><Status state={connectionStatus.state} label={t(connectionStatus.label)}/><LanguageSwitch/></div></header>
    <nav className="client-navigation" aria-label="EasyTier"><Button icon="network" tone={page === 'networks' ? 'primary' : 'ghost'} onClick={() => setPage('networks')}>{t('networks')}</Button><Button icon="settings" tone={page === 'settings' ? 'primary' : 'ghost'} onClick={() => setPage('settings')}>{t('settings')}</Button></nav>
    <main className="client-workspace">
      {snapshot.errorCode && <Alert tone="error">{t(snapshot.errorCode === 'config_server_credentials_required' ? 'legacyCredentials' : snapshot.errorCode === 'client_stop_failed' ? 'clientStopFailed' : snapshot.errorCode === 'client_start_failed' ? 'clientStartFailed' : snapshot.errorCode === 'vpn_no_network' ? 'vpnNoNetwork' : snapshot.errorCode === 'vpn_permission_revoked' ? 'vpnPermissionRevoked' : snapshot.errorCode === 'vpn_connection_timeout' ? 'vpnConnectionTimeout' : 'nativeError')}</Alert>}
      {page === 'settings' ? <Suspense fallback={<div className="loading">{t('common:busy')}</div>}><SettingsPanel session={session} snapshot={snapshot}/></Suspense> : <>
        <div className="page-heading"><h1>{t('networks')}</h1><div className="actions">{localAndroid && <Button icon={disconnectVpn ? 'pause' : 'play'} busy={snapshot.busy} onClick={() => void (disconnectVpn ? session.stopLocalClient() : session.startLocalClient()).catch(() => {})}>{t(retryDisconnect ? 'retryStopClient' : disconnectVpn ? 'stopClient' : 'startClient')}</Button>}<Button icon="refresh" busy={busy || snapshot.busy} onClick={refresh}>{t('refresh')}</Button><Button icon="download" disabled={!canManageConfigs || busy || snapshot.busy} onClick={() => { setImporting(true); setImportError(false); }}>{t('import')}</Button><Button icon="plus" disabled={!canManageConfigs || busy || snapshot.busy} onClick={() => void openEditor()}>{t('newNetwork')}</Button></div></div>
        {!canManageConfigs ? <Panel><Empty title={t(snapshot.clientPaused ? 'clientPaused' : 'disconnected')} action={snapshot.clientPaused ? snapshot.errorCode === 'client_stop_failed' ? <Button busy={snapshot.busy} onClick={() => void session.stopLocalClient().catch(() => {})}>{t('retryStopClient')}</Button> : undefined : <Button busy={snapshot.busy} onClick={() => void session.reconnect().catch(() => notice(t('nativeError'), 'error'))}>{t('retry')}</Button>}/></Panel> : <div className="client-network-layout">
          <Panel className="network-list-panel">
            {loadingError && <Alert tone="error">{t('refreshError')}</Alert>}
            {networks.length ? <div className="client-network-list">{networks.map(item => <button type="button" className={`client-network-item ${selected === item.id ? 'selected' : ''}`} key={item.id} onClick={() => { setInfo(undefined); setSelected(item.id); selectedRef.current = item.id; refresh(); }}><Icon name="network"/><span><strong>{item.meta.network_name}</strong>{!Api.ConfigFilePermission.isEditable(item.meta.config_permission) && <small>{t('readOnly')}</small>}</span>{networkStatus(item)}</button>)}</div> : <Empty title={t('noNetworks')}/>}
          </Panel>
          <Panel title={row?.meta.network_name ?? t('noSelection')} action={row && <>{canControl && <Button icon={row.running ? 'pause' : 'play'} disabled={!snapshot.connected || (localAndroid && snapshot.clientPaused) || loadingError || busy || snapshot.busy} onClick={() => void mutate(() => client.update_network_instance_state(row.id, row.running))}>{t(row.running ? 'stop' : 'start')}</Button>}<Button icon="edit" disabled={!canEdit || busy} onClick={() => void openEditor(row.id)}>{t('editNetwork')}</Button><Button icon="download" disabled={busy || loadingError} onClick={() => void download()}>{t('export')}</Button><Button icon="trash" tone="danger" disabled={!canDelete || busy} aria-label={t('delete')} onClick={() => setRemoving(row.id)}/></>}>
            {row ? <RuntimePanel key={row.id} id={row.id} info={info} running={row.running} client={client} readOnly={!canEdit}/> : <Empty title={t('noSelection')}/>}
          </Panel>
        </div>}
      </>}
    </main>
    {editor && <Suspense fallback={<div className="loading">{t('common:busy')}</div>}><NetworkEditor initial={editor} client={client} canStart={snapshot.connected && !(localAndroid && snapshot.clientPaused) && !Api.isManagedNetwork(networks.find(item => item.id === editor.instance_id)?.meta)} supportsUplinkSelection={supportsUplinkSelectionForTarget(snapshot.platform, snapshot.mode)} allowRemoteSave={Api.ConfigFilePermission.isRemoveSaveable(networks.find(item => item.id === editor.instance_id)?.meta.config_permission ?? 0)} onClose={() => setEditor(undefined)} onSaved={() => { setSelected(editor.instance_id); setEditor(undefined); refresh(); notice(t('saved')); }}/></Suspense>}
    <Dialog open={!!exported} title={t('export')} onClose={() => setExported(undefined)} wide footer={<><Button icon="copy" onClick={() => { if (exported) void copyText(exported.text).then(() => notice(t('copied'))).catch(() => notice(t('nativeError'), 'error')); }}>{t('copy')}</Button>{snapshot.platform !== 'android' && <Button icon="download" onClick={() => { if (!exported) return; const url = URL.createObjectURL(new Blob([exported.text], { type: 'application/toml' })), anchor = document.createElement('a'); anchor.href = url; anchor.download = `${exported.name.replace(/[^a-zA-Z0-9_-]/g, '_') || 'network'}.toml`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 5000); }}>{t('export')}</Button>}</>}><pre className="code-block">{exported?.text}</pre></Dialog>
    <Dialog open={importing} title={t('importConfig')} onClose={() => { if (!busy) { setImporting(false); setImportText(''); setImportError(false); } }} wide footer={<><Button tone="ghost" disabled={busy} onClick={() => { setImporting(false); setImportText(''); }}>{t('cancel')}</Button><Button disabled={!importText.trim()} busy={busy} onClick={() => void parseImport()}>{t('confirm')}</Button></>}>
      {importError && <Alert tone="error">{t('configError')}</Alert>}<input type="file" accept=".toml,.conf,.txt" aria-label={t('importConfig')} disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (file) void file.text().then(text => { if (JSON.stringify(session.getSnapshot().mode) === configurationScope) setImportText(text); }).catch(() => { if (JSON.stringify(session.getSnapshot().mode) === configurationScope) setImportError(true); }); }}/><Field label="TOML"><textarea className="code-editor" value={importText} onChange={event => setImportText(event.target.value)} disabled={busy}/></Field>
    </Dialog>
    <Dialog open={!!removing} title={t('delete')} onClose={() => { if (!busy) setRemoving(undefined); }} footer={<><Button tone="ghost" disabled={busy} onClick={() => setRemoving(undefined)}>{t('cancel')}</Button><Button tone="danger" busy={busy} onClick={() => void mutate(async () => { if (removing) await client.delete_network(removing); setRemoving(undefined); notice(t('deleted')); })}>{t('delete')}</Button></>}><p>{t('confirmDelete')}</p></Dialog>
  </div>;
}
