import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import { currentLocale } from '../lib/i18n';
import type ApiClient from '../lib/api';
import { errorMessage, useResource } from '../lib/hooks';
import { RuntimeDisplay, Utils } from '../lib/shared';
import { Alert, Button, Empty, Field, Panel } from './ui';

function endpoint(value: unknown): string {
  const text = typeof value === 'string' ? value : value && typeof value === 'object' && 'url' in value ? String(value.url) : '';
  try { const url = new URL(text); return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`; }
  catch { return '—'; }
}
function finite(value: unknown, divisor = 1, suffix = '') {
  const number = value === undefined || value === null || value === '' ? NaN : Number(value);
  return Number.isFinite(number) ? `${(number / divisor).toLocaleString(currentLocale(), { maximumFractionDigits: 2 })}${suffix}` : '—';
}
function quantity(value: unknown, bytes = false): string {
  const n = RuntimeDisplay.counter(value);
  if (n === undefined) return '—';
  if (!bytes) return n.toLocaleString(currentLocale());
  const formatted = RuntimeDisplay.formatQuantity(value, true);
  const match = /^([\d.]+) (.+)$/.exec(formatted);
  return match ? `${Number(match[1]).toLocaleString(currentLocale(), { maximumFractionDigits: 2 })} ${match[2]}` : formatted;
}
function Loading() { const { t } = useTranslation('devices'); return <p className="loading" role="status">{t('runtime.loading')}</p>; }

export function InstanceRoutes({ api, deviceId, instanceId }: { api: ApiClient; deviceId: string; instanceId: string }) {
  const { t } = useTranslation('devices');
  const resource = useResource(() => api.get_node_routes(deviceId, instanceId), `routes:${deviceId}:${instanceId}`, 6000);
  return <Panel title={t('tabs.routes')} action={<Button icon="refresh" tone="ghost" busy={resource.loading} onClick={resource.refresh}>{t('actions.refresh')}</Button>}>
    {resource.error && <Alert tone="error">{resource.error}</Alert>}
    {!resource.data ? resource.loading ? <Loading/> : <Empty title={t('runtime.routesUnavailable')} action={<Button onClick={resource.refresh}>{t('actions.retry')}</Button>}/> : resource.data.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>{t('labels.peer')}</th><th>{t('runtime.virtualAddress')}</th><th>{t('runtime.nextHop')}</th><th>{t('runtime.hops')}</th><th>{t('runtime.pathLatency')}</th><th>{t('runtime.proxyCidrs')}</th><th>{t('runtime.version')}</th></tr></thead><tbody>{resource.data.map(route => <tr key={route.peer_id}><td><span className="entity-name">{route.hostname || t('labels.unnamedPeer')}</span><div className="entity-secondary">{t('runtime.peerLabel', { id: route.peer_id })}</div></td><td className="mono">{route.ipv4_addr ? Utils.ipv4InetToString(route.ipv4_addr as Parameters<typeof Utils.ipv4InetToString>[0]) : '—'}{route.ipv6_addr?.address && <div>{Utils.ipv6ToString(route.ipv6_addr.address as Parameters<typeof Utils.ipv6ToString>[0])}/{route.ipv6_addr.network_length}</div>}</td><td>{route.next_hop_peer_id ?? 0}</td><td>{route.cost ?? 0}</td><td>{finite(route.path_latency, 1, ' ms')}</td><td className="mono">{route.proxy_cidrs?.join(', ') || '—'}</td><td>{route.version || '—'}</td></tr>)}</tbody></table></div> : <Empty title={t('runtime.noRoutes')}/>}
  </Panel>;
}

export function InstancePeers({ api, deviceId, instanceId }: { api: ApiClient; deviceId: string; instanceId: string }) {
  const { t } = useTranslation('devices');
  const resource = useResource(() => api.get_node_peers(deviceId, instanceId), `peers:${deviceId}:${instanceId}`, 5000);
  const connections = resource.data?.flatMap(peer => (peer.conns ?? [])
    .filter(connection => connection.conn_id && !connection.is_closed)
    .map(connection => ({ peerId: peer.peer_id, connection })));
  return <Panel title={t('runtime.peersTitle')} action={<Button icon="refresh" tone="ghost" busy={resource.loading} onClick={resource.refresh}>{t('actions.refresh')}</Button>}>
    {resource.error && <Alert tone="error">{resource.error}</Alert>}
    {resource.error ? <Empty title={t('runtime.peersUnavailable')} action={<Button onClick={resource.refresh}>{t('actions.retry')}</Button>}/> : !resource.data ? resource.loading ? <Loading/> : <Empty title={t('runtime.peersUnavailable')} action={<Button onClick={resource.refresh}>{t('actions.retry')}</Button>}/> : connections?.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>{t('labels.peer')}</th><th>{t('labels.protocol')}</th><th>{t('runtime.localAddress')}</th><th>{t('runtime.remoteAddress')}</th><th>{t('runtime.latency')}</th><th>{t('runtime.loss')}</th><th>{t('runtime.rxTx')}</th></tr></thead><tbody>{connections.map(({ peerId, connection }) => <tr key={`${peerId}:${connection.conn_id}`}><td>{t('runtime.peerLabel', { id: peerId })}</td><td>{connection.tunnel?.tunnel_type || '—'}</td><td className="mono">{endpoint(connection.tunnel?.local_addr)}</td><td className="mono">{endpoint(connection.tunnel?.remote_addr)}</td><td>{finite(connection.stats?.latency_us, 1000, ' ms')}</td><td>{finite(connection.loss_rate, 0.01, '%')}</td><td className="numeric">{quantity(connection.stats?.rx_bytes, true)} / {quantity(connection.stats?.tx_bytes, true)}</td></tr>)}</tbody></table></div> : <Empty title={t('runtime.noPeers')}/>}
  </Panel>;
}

export function InstanceAcl({ api, deviceId, instanceId }: { api: ApiClient; deviceId: string; instanceId: string }) {
  const { t } = useTranslation('devices');
  const resource = useResource(() => api.get_node_acl_stats(deviceId, instanceId), `acl:${deviceId}:${instanceId}`, 7000);
  return <Panel title={t('runtime.aclTitle')} action={<Button icon="refresh" tone="ghost" busy={resource.loading} onClick={resource.refresh}>{t('actions.refresh')}</Button>}>
    {resource.error && <Alert tone="error">{resource.error}</Alert>}
    {!resource.data ? resource.loading ? <Loading/> : <Empty title={t('runtime.aclUnavailable')} action={<Button onClick={resource.refresh}>{t('actions.retry')}</Button>}/> : resource.data.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>{t('runtime.rule')}</th><th>{t('runtime.packets')}</th><th>{t('runtime.bytes')}</th></tr></thead><tbody>{resource.data.map((row, index) => <tr key={`${row.rule?.name}:${index}`}><td>{row.rule?.name || t('labels.unnamedRule')}</td><td>{quantity(row.stat ? row.stat.packet_count ?? 0 : undefined)}</td><td>{quantity(row.stat ? row.stat.byte_count ?? 0 : undefined, true)}</td></tr>)}</tbody></table></div> : <Empty title={t('runtime.noAcl')}/>}
  </Panel>;
}

function LoadedToml({ api, deviceId, instanceId }: { api: ApiClient; deviceId: string; instanceId: string }) {
  const { t } = useTranslation('devices');
  const resource = useResource(() => api.get_node_toml_config(deviceId, instanceId), `runtime-toml:${deviceId}:${instanceId}`);
  return <div className="form-stack">{resource.error && <Alert tone="error">{resource.error}</Alert>}{resource.data === undefined ? resource.loading ? <Loading/> : <Button tone="ghost" onClick={resource.refresh}>{t('runtime.retryToml')}</Button> : <Field label={t('runtime.currentToml')}><textarea className="code-editor mono" rows={22} readOnly value={resource.data} spellCheck={false}/></Field>}</div>;
}

export function InstanceRunningConfig({ api, deviceId, instanceId }: { api: ApiClient; deviceId: string; instanceId: string }) {
  const { t } = useTranslation('devices');
  const [visible, setVisible] = useState(false);
  return <Panel title={t('runtime.runningConfig')}><div className="form-stack"><p className="muted">{t('runtime.tomlWarning')}</p><div className="actions"><Button icon="eye" tone="ghost" onClick={() => setVisible(value => !value)}>{visible ? t('runtime.hideToml') : t('runtime.showToml')}</Button></div>{visible && <LoadedToml api={api} deviceId={deviceId} instanceId={instanceId}/>}</div></Panel>;
}

export function InstanceLogger({ api, deviceId }: { api: ApiClient; deviceId: string }) {
  const { t } = useTranslation('devices');
  const resource = useResource(() => api.get_node_logger_level(deviceId), `logger:${deviceId}`);
  const names = ['runtime.logOff', 'runtime.logError', 'runtime.logWarn', 'runtime.logInfo', 'runtime.logDebug', 'runtime.logTrace'];
  return <Panel title={t('runtime.logTitle')} action={<Button icon="refresh" tone="ghost" busy={resource.loading} onClick={resource.refresh}>{t('actions.refresh')}</Button>}>{resource.error && <Alert tone="error">{resource.error}</Alert>}{resource.data === undefined ? resource.loading ? <Loading/> : <p className="muted">{t('runtime.logUnavailable')}</p> : <div className="form-stack"><p>{t('runtime.currentLevel')}<strong>{t(names[resource.data] ?? 'labels.unknown')}</strong></p><FileLoggerForm key={deviceId} api={api} deviceId={deviceId} currentLevel={resource.data} onSaved={resource.refresh}/></div>}</Panel>;
}

function FileLoggerForm({ api, deviceId, currentLevel, onSaved }: { api: ApiClient; deviceId: string; currentLevel: number; onSaved: () => void }) {
  const { t } = useTranslation('devices');
  const [level, setLevel] = useState<number>(), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null);
  const selected = level ?? currentLevel;
  const names = ['runtime.logOff', 'runtime.logError', 'runtime.logWarn', 'runtime.logInfo', 'runtime.logDebug', 'runtime.logTrace'];
  return <form className="form-stack" onSubmit={async event => {
    event.preventDefault(); if (busy || selected < 0 || selected > 5) return;
    setBusy(true); setError(null);
    try { await api.set_node_logger_level(deviceId, selected); setLevel(undefined); onSaved(); }
    catch (failure) { setError(failure); }
    finally { setBusy(false); }
  }}>
    {error !== null && <Alert tone="error">{t('runtime.logSaveFailed', { error: errorMessage(error) })}</Alert>}
    <Field label={t('runtime.fileLogLevel')}><select aria-label={t('runtime.fileLogLevel')} value={selected} disabled={busy} onChange={event => setLevel(Number(event.target.value))}>
      {names.map((name, index) => <option key={name} value={index}>{t(name)}</option>)}
    </select></Field>
    <div className="form-actions"><Button type="submit" busy={busy} disabled={selected === currentLevel || selected < 0}>{t('runtime.saveLogLevel')}</Button></div>
  </form>;
}

export function InstanceNodeInfo({ api, deviceId, instanceId }: { api: ApiClient; deviceId: string; instanceId: string }) {
  const { t } = useTranslation('devices');
  const resource = useResource(() => api.get_node_info(deviceId, instanceId), `node-info:${deviceId}:${instanceId}`, 6000);
  const node = resource.data;
  return <Panel title={t('runtime.nodeTitle')} action={<Button icon="refresh" tone="ghost" busy={resource.loading} onClick={resource.refresh}>{t('actions.refresh')}</Button>}>
    {resource.error && <Alert tone="error">{resource.error}</Alert>}
    {!node ? resource.loading ? <Loading/> : <Empty title={t('runtime.nodeUnavailable')}/> : <div className="form-stack"><div className="summary-strip"><div className="summary-item"><span>{t('runtime.peerId')}</span><strong>{node.peer_id ?? 0}</strong></div><div className="summary-item"><span>{t('labels.virtualIpv4')}</span><strong style={{ fontSize: '20px' }}>{node.ipv4_addr || '—'}</strong></div><div className="summary-item"><span>{t('labels.hostname')}</span><strong style={{ fontSize: '20px' }}>{node.hostname || '—'}</strong></div></div><h3>{t('runtime.interfaces')}</h3>{node.ip_list?.interface_networks?.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>{t('runtime.interface')}</th><th>{t('labels.address')}</th><th>{t('runtime.prefixLength')}</th></tr></thead><tbody>{node.ip_list.interface_networks.map((network, index) => <tr key={`${network.name}:${index}`}><td>{network.name || '—'}</td><td className="mono">{network.address?.ipv4 ? Utils.ipv4ToString(network.address.ipv4) : network.address?.ipv6 ? Utils.ipv6ToString(network.address.ipv6 as Parameters<typeof Utils.ipv6ToString>[0]) : '—'}</td><td>{network.prefix_length ?? '—'}</td></tr>)}</tbody></table></div> : <p className="muted">{t('runtime.noInterfaces')}</p>}</div>}
  </Panel>;
}
