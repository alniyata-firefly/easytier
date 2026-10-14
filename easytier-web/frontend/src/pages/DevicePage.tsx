import { useTranslation } from 'react-i18next';
import { useEffect, useMemo, useRef, useState } from 'react';
import { currentLocale } from '../lib/i18n';
import type ApiClient from '../lib/api';
import type { NetworkMeta } from '../../../frontend-lib/src/modules/api';
import { NetworkTypes, Utils } from '../lib/shared';
import { errorDescriptor, type ErrorDescriptor, useResource } from '../lib/hooks';
import { devicePath, navigate, networkPath } from '../lib/router';
import { Alert, Button, Dialog, Empty, Panel, Status, Tabs, useNotice } from '../components/ui';
import { InstanceConfigEditor } from '../components/InstanceConfigEditor';
import { InstanceAcl, InstanceLogger, InstanceNodeInfo, InstancePeers, InstanceRoutes, InstanceRunningConfig } from '../components/InstanceRuntimePanels';
import { NodeMetrics } from '../components/NodeMetrics';
import { canChangeInstanceState, canDeleteInstance as deletable, canEditInstance as editable, normalizeInstanceMeta as normalizeMeta } from '../components/InstancePermissions';

type InstanceRow = { id: string; running: boolean; meta?: NetworkMeta & { instance_name?: string }; centralName?: string };
type Action = 'edit' | 'new' | 'stop' | 'start' | 'delete';
function uuid(value: Utils.UUID | string): string { return typeof value === 'string' ? value.toLowerCase() : Utils.UuidToStr(value); }
const validId = (value: string) => /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(value);

export function DevicePage({ api, deviceId, instanceId }: { api: ApiClient; deviceId: string; instanceId?: string }) {
  const { t } = useTranslation('devices');
  const remote = useMemo(() => api.get_remote_client(deviceId), [api, deviceId]);
  const devices = useResource(() => api.list_machines().then(rows => rows.map(Utils.buildDeviceInfo)), `device:${deviceId}`, 6000);
  const instances = useResource(async () => {
    const [ids, consoleInfo] = await Promise.all([remote.list_network_instance_ids(), api.get_console_info()]);
    const running = new Set((ids.running_inst_ids ?? []).map(uuid));
    const all = [...new Set([...running, ...(ids.disabled_inst_ids ?? []).map(uuid)])].filter(validId);
    const [metadata, networks] = await Promise.all([
      all.length ? remote.get_network_metas(all) : Promise.resolve({ metas: {} as Record<string, NetworkMeta> }),
      consoleInfo.webhook_auth ? Promise.resolve([]) : api.list_networks(),
    ]);
    const central = new Map(networks.map(network => [network.network_id.toLowerCase(), network.display_name || network.network_id]));
    return all.map(id => ({ id, running: running.has(id), meta: normalizeMeta(metadata.metas[id]), centralName: central.get(id) } as InstanceRow))
      .sort((left, right) => Number(right.running) - Number(left.running) || (left.meta?.network_name ?? left.id).localeCompare(right.meta?.network_name ?? right.id));
  }, `instances:${deviceId}`, 6000);
  const device = devices.data?.find(row => row.machine_id === deviceId);
  const rows = instances.data ?? (device?.running_network_instances ?? []).map(id => ({ id, running: true } as InstanceRow));
  const selectedId = instanceId?.toLowerCase() ?? rows[0]?.id;
  const selected = rows.find(row => row.id === selectedId);
  const online = !!device?.online;
  const [tab, setTab] = useState('overview'), [action, setAction] = useState<Action>(), [target, setTarget] = useState<InstanceRow>();
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState<ErrorDescriptor>();
  const actionLock = useRef(false), notice = useNotice();
  const error = failure ? t(failure.key, { ns: failure.ns, ...failure.values }) : '';
  useEffect(() => { setTab('overview'); setAction(undefined); setTarget(undefined); setFailure(undefined); }, [deviceId, instanceId]);
  const refresh = () => { api.clear_snapshots(); devices.refresh(); instances.refresh(); };
  const open = (kind: Action, row?: InstanceRow) => {
    setFailure(undefined); setAction(kind);
    setTarget(row ?? { id: NetworkTypes.DEFAULT_NETWORK_CONFIG().instance_id, running: false });
  };
  const checkPermission = async (row: InstanceRow, kind: Action) => {
    api.clear_snapshots();
    const [ids, metas, consoleInfo] = await Promise.all([remote.list_network_instance_ids(), remote.get_network_metas(kind === 'new' ? [] : [row.id]), api.get_console_info()]);
    const networks = consoleInfo.webhook_auth ? [] : await api.list_networks();
    if (networks.some(network => network.network_id.toLowerCase() === row.id)) throw new Error('central-managed');
    const present = [...(ids.running_inst_ids ?? []), ...(ids.disabled_inst_ids ?? [])].some(id => uuid(id) === row.id);
    if (kind === 'new') { if (present) throw new Error('instance-already-exists'); return; }
    const current: InstanceRow = { ...row, meta: normalizeMeta(metas.metas[row.id]), centralName: undefined };
    const allowed = kind === 'delete' ? deletable(current) : kind === 'stop' || kind === 'start' ? canChangeInstanceState(current, kind === 'stop') : editable(current);
    if (!present || !allowed) throw new Error('permission-changed');
  };
  const execute = async () => {
    if (!action || !target || actionLock.current) return;
    actionLock.current = true; setBusy(true); setFailure(undefined);
    try {
      await checkPermission(target, action);
      if (action === 'delete') await remote.delete_network(target.id);
      else await remote.update_network_instance_state(target.id, action === 'stop');
      const wasDeleted = action === 'delete';
      setAction(undefined); setTarget(undefined); refresh();
      notice({ ns: 'devices', key: wasDeleted ? 'notice.deleted' : action === 'stop' ? 'notice.stopped' : 'notice.started' });
      if (wasDeleted && selectedId === target.id) navigate(devicePath(deviceId));
    } catch (failure) { setFailure(errorDescriptor(failure)); }
    finally { actionLock.current = false; setBusy(false); }
  };
  const runtimeAvailable = online && !!selected?.running;
  const tabs = [{ id: 'overview', label: t('tabs.overview') }, { id: 'metrics', label: t('tabs.metrics') }, { id: 'peers', label: t('tabs.peers') }, { id: 'routes', label: t('tabs.routes') }, { id: 'acl', label: t('tabs.acl') }, { id: 'toml', label: t('tabs.toml') }, { id: 'logger', label: t('tabs.logger') }];
  const close = () => { if (!busy) { setAction(undefined); setTarget(undefined); setFailure(undefined); } };

  return <div className="page stack">
    <header className="page-heading"><div><a className="breadcrumb-link" href="#/h/deviceList">{t('labels.device')} /</a><h1>{device?.alias || device?.hostname || t('page.detail')}</h1><p className="mono">{deviceId}</p></div><div className="actions"><Status state={!device || devices.error ? 'unknown' : online ? 'online' : 'offline'}/><Button icon="refresh" tone="ghost" busy={devices.loading || instances.loading} onClick={refresh}>{t('actions.refresh')}</Button><Button icon="plus" disabled={!device || !!instances.error || busy} onClick={() => open('new')}>{t('actions.newInstance')}</Button></div></header>
    {devices.error && <Alert tone="error">{devices.error}</Alert>}
    {instances.error && <Alert tone="error">{t('instance.listFailure', { error: instances.error })}</Alert>}
    <Panel title={t('instance.title')} action={<span className="muted">{t('instance.count', { count: rows.length, countFormatted: rows.length.toLocaleString(currentLocale()) })}</span>}>
      {instances.loading && !instances.data && !rows.length ? <p className="loading" role="status">{t('instance.loading')}</p> : rows.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>{t('labels.instance')}</th><th>{t('labels.status')}</th><th>{t('labels.management')}</th><th>{t('labels.actions')}</th></tr></thead><tbody>{rows.map(row => <tr key={row.id} className={selectedId === row.id ? 'selected-row' : undefined}><td><a className="entity-name" href={`#${devicePath(deviceId, row.id)}`} aria-current={selectedId === row.id ? 'page' : undefined}>{row.meta?.instance_name || row.meta?.network_name || row.id.slice(0, 8)}</a><div className="entity-secondary mono">{row.id}</div></td><td><Status state={!online || instances.error ? 'unknown' : row.running ? 'running' : 'stopped'}/></td><td>{row.centralName ? <a href={`#${networkPath(row.id)}`}>{t('central.memberLabel', { name: row.centralName })}</a> : !row.meta ? t('instance.checkPermissions') : !editable(row) ? t('instance.readOnly') : t('instance.deviceManaged')}</td><td><div className="actions"><Button tone="ghost" icon="edit" disabled={!editable(row) || busy} aria-label={t('instance.editAria', { name: row.meta?.network_name || row.id })} onClick={() => open('edit', row)}/><Button tone="ghost" icon={row.running ? 'pause' : 'play'} disabled={!canChangeInstanceState(row, row.running) || !online || busy} aria-label={row.running ? t('actions.stopInstance') : t('actions.startInstance')} onClick={() => open(row.running ? 'stop' : 'start', row)}/><Button tone="danger" icon="trash" disabled={!deletable(row) || busy} aria-label={t('actions.deleteInstance')} onClick={() => open('delete', row)}/></div></td></tr>)}</tbody></table></div> : <Empty title={t('instance.none')} action={<Button icon="plus" disabled={!device || !!instances.error} onClick={() => open('new')}>{t('actions.newInstance')}</Button>}/>}
    </Panel>
    {selectedId && !selected && instances.data ? <Empty title={t('instance.missing')}/> : selected ? <>
      <div className="toolbar"><div><h2>{selected.meta?.instance_name || selected.meta?.network_name || t('instance.detail')}</h2><p className="muted small mono">{selected.id}</p></div>{selected.centralName && <a className="button" href={`#${networkPath(selected.id)}`}>{t('central.open')}</a>}</div>
      <Tabs items={tabs} value={tab} onChange={setTab}/>
      <div role="tabpanel" aria-label={tabs.find(item => item.id === tab)?.label}>
        {!runtimeAvailable ? <Panel><Empty title={online ? t('instance.notRunning') : t('instance.deviceOffline')} action={editable(selected) && online ? <Button icon="play" onClick={() => open('start', selected)}>{t('actions.startInstance')}</Button> : undefined}/></Panel> : <>
          {tab === 'overview' && <InstanceNodeInfo key={selected.id} api={api} deviceId={deviceId} instanceId={selected.id}/>}
          {tab === 'metrics' && <Panel title={t('tabs.metrics')}><NodeMetrics key={`${deviceId}:${selected.id}`} api={api} machineId={deviceId} instanceId={selected.id} online={online} nodeName={device?.alias || device?.hostname}/></Panel>}
          {tab === 'peers' && <InstancePeers key={selected.id} api={api} deviceId={deviceId} instanceId={selected.id}/>}
          {tab === 'routes' && <InstanceRoutes key={selected.id} api={api} deviceId={deviceId} instanceId={selected.id}/>}
          {tab === 'acl' && <InstanceAcl key={selected.id} api={api} deviceId={deviceId} instanceId={selected.id}/>}
          {tab === 'toml' && <InstanceRunningConfig key={selected.id} api={api} deviceId={deviceId} instanceId={selected.id}/>}
          {tab === 'logger' && <InstanceLogger api={api} deviceId={deviceId}/>}
        </>}
      </div>
    </> : null}
    <Dialog open={!!action && !!target} title={action === 'new' ? t('instance.newDialog') : action === 'edit' ? t('instance.editDialog') : action === 'delete' ? t('actions.deleteInstance') : action === 'stop' ? t('actions.stopInstance') : t('actions.startInstance')} onClose={close} wide={action === 'new' || action === 'edit'}>
      {(action === 'new' || action === 'edit') && target ? <InstanceConfigEditor key={`${deviceId}:${target.id}`} remote={remote} instanceId={target.id} isNew={action === 'new'} online={online} onBusyChange={setBusy} checkPermission={() => checkPermission(target, action)} onSaved={mode => { setAction(undefined); setTarget(undefined); refresh(); notice({ ns: 'devices', key: mode === 'run' ? 'notice.configRun' : 'notice.configSaved' }); navigate(devicePath(deviceId, target.id)); }}/> : <>
        {error && <Alert tone="error">{error}</Alert>}
        <p>{action === 'delete' ? t('instance.deleteHint') : action === 'stop' ? t('instance.stopHint') : t('instance.startHint')}</p>
        <p className="mono">{target?.id}</p>
        <div className="actions end"><Button tone="ghost" disabled={busy} onClick={close}>{t('actions.cancel')}</Button><Button tone={action === 'delete' ? 'danger' : 'primary'} busy={busy} onClick={execute}>{action === 'delete' ? t('actions.confirmDelete') : action === 'stop' ? t('actions.confirmStop') : t('actions.confirmStart')}</Button></div>
      </>}
    </Dialog>
  </div>;
}

export default DevicePage;
