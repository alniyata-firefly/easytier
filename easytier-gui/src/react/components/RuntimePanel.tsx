import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RuntimeDisplay, Utils, NetworkTypes } from '../lib/shared';
import { latencyMs, lossRate } from '../../../../easytier-web/frontend-lib/src/modules/statusDisplay';
import { Empty, Tabs } from './ui';
import type { GUIRemoteClient } from '../../native/bridge';
import { connectionTotal, TrafficHistory, type TrafficPoint } from '../lib/traffic-history';
import { TrafficChart } from './TrafficChart';
import { runtimeIpv4Label, runtimeNextHopLabel } from '../lib/runtime-routes';
const PortalPanel = lazy(() => import('./PortalPanel').then(module => ({ default: module.PortalPanel })));

export function RuntimePanel({ id, info, running, client, readOnly }: { id: string; info?: NetworkTypes.NetworkInstanceRunningInfo; running: boolean; client: GUIRemoteClient; readOnly: boolean }) {
  const { t } = useTranslation('client');
  const [tab, setTab] = useState('overview');
  const history = useRef(new TrafficHistory());
  const [points, setPoints] = useState<TrafficPoint[]>([]);
  const [rate, setRate] = useState<{ rx?: number; tx?: number }>({});
  useEffect(() => {
    if (!running || !info) { history.current.reset(); setPoints([]); setRate({}); return; }
    const conns = info.peers.flatMap(peer => peer.conns), rx = connectionTotal(conns, 'rx'), tx = connectionTotal(conns, 'tx');
    const scope = `${id}:${conns.map(conn => conn.conn_id).sort().join(',')}`, now = performance.now();
    const next = history.current.sample(scope, now, rx, tx), last = next[next.length - 1];
    setPoints(next); setRate({ rx: last?.rx ?? undefined, tx: last?.tx ?? undefined });
  }, [id, info, running]);
  if (!running) return <Empty title={t('notRunning')}/>;
  if (!info) return <Empty title={t('resourceUnavailable')}/>;
  const node = info.my_node_info;
  const quantity = (value: unknown) => RuntimeDisplay.formatQuantity(value, true);
  const speed = (value?: number) => value == null ? '—' : `${quantity(Math.floor(value))}/s`;
  return <div className="form-stack">
    <Tabs items={['overview', 'connections', 'routes', 'events', 'portal'].map(id => ({ id, label: t(id) }))} value={tab} onChange={setTab}/>
    {tab === 'overview' && <>
      <div className="client-metrics"><div><span>{t('upload')}</span><strong>{speed(rate.tx)}</strong></div><div><span>{t('download')}</span><strong>{speed(rate.rx)}</strong></div><div><span>{t('connections')}</span><strong>{info.peers.length}</strong></div></div>
      <TrafficChart points={points}/>
      <dl className="detail-list"><dt>{t('hostname')}</dt><dd>{node?.hostname || '—'}</dd><dt>{t('version')}</dt><dd>{node?.version || '—'}</dd><dt>{t('peerId')}</dt><dd>{node?.peer_id ?? '—'}</dd><dt>{t('virtualIp')}</dt><dd>{runtimeIpv4Label(node?.virtual_ipv4)}</dd><dt>{t('device')}</dt><dd>{info.dev_name || '—'}</dd><dt>{t('publicIp')}</dt><dd>{[Utils.ipv4ToString(node?.ips?.public_ipv4), Utils.ipv6ToString(node?.ips?.public_ipv6)].filter(Boolean).join(', ') || '—'}</dd><dt>{t('nat')}</dt><dd>UDP {node?.stun_info?.udp_nat_type == null ? '—' : NetworkTypes.NatType[node.stun_info.udp_nat_type]} / TCP {node?.stun_info?.tcp_nat_type == null ? '—' : NetworkTypes.NatType[node.stun_info.tcp_nat_type]}</dd><dt>{t('listeners')}</dt><dd>{node?.listeners?.map(item => item.url).join(', ') || '—'}</dd></dl>
    </>}
    {tab === 'connections' && <div className="table-wrap"><table className="data-table"><thead><tr>{['hostname', 'virtualIp', 'direct', 'protocol', 'latency', 'loss', 'upload', 'download', 'version'].map(key => <th key={key}>{t(key)}</th>)}</tr></thead><tbody>{info.peer_route_pairs.map(pair => <tr key={pair.route.peer_id}><td>{pair.route.hostname || String(pair.route.peer_id)}</td><td>{runtimeIpv4Label(pair.route.ipv4_addr)}</td><td>{t(pair.peer?.conns?.length ? 'direct' : 'relay')}</td><td>{pair.peer?.conns?.map(conn => conn.tunnel?.tunnel_type).filter(Boolean).join(', ') || '—'}</td><td>{latencyMs(pair) || '—'}</td><td>{lossRate(pair) || '—'}</td><td>{quantity(connectionTotal(pair.peer?.conns, 'tx'))}</td><td>{quantity(connectionTotal(pair.peer?.conns, 'rx'))}</td><td>{pair.route.version || '—'}</td></tr>)}</tbody></table></div>}
    {tab === 'connections' && info.peers.length > 0 && <div className="table-wrap"><table className="data-table"><thead><tr><th>{t('peerId')}</th><th>{t('protocol')}</th><th>{t('endpoint')}</th></tr></thead><tbody>{info.peers.flatMap(peer => peer.conns.map(conn => <tr key={conn.conn_id}><td>{peer.peer_id}</td><td>{conn.tunnel?.tunnel_type || '—'}</td><td className="endpoint-cell">{conn.tunnel?.local_addr?.url || '—'} → {conn.tunnel?.remote_addr?.url || '—'}</td></tr>))}</tbody></table></div>}
    {tab === 'routes' && <div className="table-wrap"><table className="data-table"><thead><tr>{['hostname', 'virtualIp', 'gateway', 'cost', 'routes'].map(key => <th key={key}>{t(key)}</th>)}</tr></thead><tbody>{info.routes.map(route => <tr key={route.peer_id}><td>{route.hostname || String(route.peer_id)}</td><td>{runtimeIpv4Label(route.ipv4_addr)}</td><td>{runtimeNextHopLabel(route, info.routes)}</td><td>{route.cost}</td><td>{route.proxy_cidrs.join(', ') || '—'}</td></tr>)}</tbody></table></div>}
    {tab === 'events' && <div className="event-list">{info.events.length ? info.events.map((event, index) => <pre className="code-block" key={index}>{event}</pre>) : <Empty title={t('resourceUnavailable')}/>}</div>}
    {tab === 'portal' && <Suspense fallback={<div className="loading">{t('common:busy')}</div>}><PortalPanel id={id} info={info} client={client} readOnly={readOnly}/></Suspense>}
  </div>;
}
