import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import ApiClient, { type CentralNetworkMember, type NetworkDeployment, type NodePeerConn, type NodeRouteInfo, type NodePeerInfo } from '../lib/api';
import { errorDescriptor, useResource, type ErrorDescriptor } from '../lib/hooks';
import { RuntimeDisplay, Utils } from '../lib/shared';
import { formatDate } from '../lib/i18n';
import { Alert, Button, Empty, Field, Panel, Status } from './ui';
import { ManagementStatus } from './ManagementStatus';
import { NodeMetrics } from './NodeMetrics';
import { useMetricFormat } from './MetricFormat';

const name = (member: CentralNetworkMember) => member.hostname_override || member.alias || member.hostname || member.device_id;
const endpoint = (value: unknown) => typeof value === 'string' ? value : value && typeof value === 'object' ? String((value as { url?: string }).url ?? '') : '';
const latency = (value: unknown, microseconds = false) => { const count = RuntimeDisplay.counter(value); return count === undefined ? undefined : Number(count) / (microseconds ? 1000 : 1); };
const routeAddress = (route: NodeRouteInfo) => route.ipv4_addr?.address ? `${Utils.ipv4ToString({ addr: route.ipv4_addr.address.addr ?? 0 })}/${route.ipv4_addr.network_length ?? '?'}` : route.ipv6_addr?.address ? `${Utils.ipv6ToString(route.ipv6_addr.address)}/${route.ipv6_addr.network_length ?? '?'}` : '—';
type LocalObservation = { deviceId: string; peers?: NodePeerInfo[]; routes?: NodeRouteInfo[]; errors: Array<{ part: string; error: ErrorDescriptor }> };
const errorParts = ['connections', 'routes'];
export function NetworkObservability({ api, networkId, members, gateway, managementUnknown = false }: { api: ApiClient; networkId: string; members: CentralNetworkMember[]; gateway?: NetworkDeployment['gateway']; managementUnknown?: boolean }) {
    const { t } = useTranslation('metrics'), metricFormat = useMetricFormat();
    const [selection, setSelection] = useState('');
    const selected = members.find(member => member.device_id === selection) ?? members.find(member => member.online) ?? members[0];
    const available = !!selected?.online && selected.running !== false;
    const resource = useResource(async () => {
        if (!selected || !available) return undefined;
        const requests = await Promise.allSettled([api.get_node_peers(selected.device_id, networkId), api.get_node_routes(selected.device_id, networkId)]);
        return { deviceId: selected.device_id, peers: requests[0].status === 'fulfilled' ? requests[0].value : undefined, routes: requests[1].status === 'fulfilled' ? requests[1].value : undefined,
            errors: requests.flatMap((result, index) => result.status === 'rejected' ? [{ part: errorParts[index], error: errorDescriptor(result.reason) }] : []),
        } satisfies LocalObservation;
    }, `node-observation:${networkId}:${selected?.device_id ?? ''}:${available}`, available ? 8000 : 0);
    const observation = resource.data?.deviceId === selected?.device_id ? resource.data : undefined;
    const connections: Array<{ peerId: number; hostname: string; conn: NodePeerConn }> = (observation?.peers ?? []).flatMap(peer => peer.conns.map(conn => ({ peerId: peer.peer_id, hostname: observation?.routes?.find(route => route.peer_id === peer.peer_id)?.hostname || (gateway?.peer_id === peer.peer_id ? t('network.gateway') : t('network.nodeName', { id: peer.peer_id })), conn })));
    const observationErrors = (item: LocalObservation) => item.errors.map(failure => t('network.requestFailed', { part: t(`network.parts.${failure.part}`), error: t(failure.error.key, { ...failure.error.values, ns: failure.error.ns }) })).join(t('errorSeparator'));
    return <div className="network-observability stack">
        {resource.error && <Alert tone="warning">{t('network.readFailed', { error: resource.error })}<Button tone="ghost" onClick={resource.refresh}>{t('common:retry')}</Button></Alert>}
        {selected ? <Panel title={t('network.nodeObservation', { name: name(selected) })} className="node-observation-panel" action={<div className="actions">{available && <small className="muted">{resource.updatedAt ? t('network.updated', { time: formatDate(resource.updatedAt, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }) : t('network.loading')}</small>}<Button icon="refresh" tone="ghost" busy={resource.loading} onClick={resource.refresh}>{t('common:refresh')}</Button></div>}>
            <div className="node-observation-toolbar"><Field label={t('network.selectNode')}><select aria-label={t('network.selectNode')} value={selected.device_id} onChange={event => setSelection(event.target.value)}>{members.map(member => <option key={member.device_id} value={member.device_id}>{name(member)}{member.online || managementUnknown ? '' : t('network.offlineSuffix')}</option>)}</select></Field><ManagementStatus online={selected.online} unknown={managementUnknown} /><Status state={managementUnknown ? 'unknown' : selected.running === true ? 'running' : selected.running === false ? 'stopped' : 'unknown'} /></div>
            {selected.running === false && selected.online ? <Empty title={t('network.stopped')} /> : <>
                <NodeMetrics key={`${networkId}:${selected.device_id}`} api={api} machineId={selected.device_id} instanceId={networkId} online={selected.online} nodeName={name(selected)} />
                {selected.online && <div className="node-connectivity stack">
                    {!!observation?.errors.length && <Alert tone="warning">{observationErrors(observation)}<Button tone="ghost" onClick={resource.refresh}>{t('network.reread')}</Button></Alert>}
                    <details open className="connection-details"><summary>{t('network.connectionCount', { count: connections.length })}</summary>{observation?.peers === undefined ? <p className="muted">{t(resource.loading ? 'network.connectionsLoading' : 'network.connectionsUnavailable')}</p> : connections.length === 0 ? <p className="muted">{t('network.noConnections')}</p> : <div className="table-wrap"><table className="data-table"><thead><tr><th>{t('network.remoteNode')}</th><th>{t('network.tunnel')}</th><th>{t('network.remoteAddress')}</th><th>{t('network.latency')}</th><th>{t('network.traffic')}</th><th>{t('network.state')}</th></tr></thead><tbody>{connections.map(({ peerId, hostname, conn }) => <tr key={`${peerId}:${conn.conn_id}`}><td>{hostname}<div className="muted small">#{peerId}</div></td><td>{conn.tunnel?.tunnel_type || t('unknown')} {RuntimeDisplay.endpointFamily(endpoint(conn.tunnel?.remote_addr))}</td><td className="mono small">{endpoint(conn.tunnel?.remote_addr) || '—'}</td><td className="numeric">{metricFormat.milliseconds(latency(conn.stats?.latency_us, true))}</td><td className="numeric small">↓ {metricFormat.quantity(conn.stats?.rx_bytes, true)}<br />↑ {metricFormat.quantity(conn.stats?.tx_bytes, true)}</td><td><Status state={conn.is_closed ? 'stopped' : conn.tunnel ? 'running' : 'unknown'} label={t(conn.is_closed ? 'network.closed' : conn.tunnel ? 'network.active' : 'unknown')} /></td></tr>)}</tbody></table></div>}</details>
                    <details className="route-details"><summary>{t('network.routesCount', { count: observation?.routes?.length, value: observation?.routes?.length ?? t('unknown') })}</summary>{observation?.routes === undefined ? <p className="muted">{t(resource.loading ? 'network.routesLoading' : 'network.routesUnavailable')}</p> : observation.routes.length === 0 ? <p className="muted">{t('network.noRoutes')}</p> : <div className="table-wrap"><table className="data-table"><thead><tr><th>{t('network.node')}</th><th>{t('network.virtualAddress')}</th><th>{t('network.cost')}</th><th>{t('network.nextHop')}</th><th>{t('network.pathLatency')}</th><th>{t('network.proxyNetworks')}</th></tr></thead><tbody>{observation.routes.map(route => <tr key={route.peer_id}><td>{route.hostname || `#${route.peer_id}`}</td><td className="mono">{routeAddress(route)}</td><td>{route.cost ?? '—'}</td><td className="mono">{route.next_hop_peer_id == null ? '—' : `#${route.next_hop_peer_id}`}</td><td className="numeric">{metricFormat.milliseconds(route.path_latency == null || !Number.isFinite(route.path_latency) ? undefined : Number(route.path_latency.toFixed(2)))}</td><td className="mono small">{route.proxy_cidrs?.join(', ') || '—'}</td></tr>)}</tbody></table></div>}</details>
                </div>}
            </>}
        </Panel> : <Empty title={t('network.noMembers')} />}
    </div>;
}

export default NetworkObservability;
