import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type ApiClient from '../lib/api';
import { useResource } from '../lib/hooks';
import { formatDate } from '../lib/i18n';
import { devicePath } from '../lib/router';
import { connectionEventState } from '../lib/connection-logs';
import { Alert, Button, Empty, Panel, Status } from './ui';

const eventKeys = new Set(['authorized', 'disconnected', 'authentication_rejected', 'pending_approval', 'configuration_apply_failed']);
const reasonKeys = new Set(['authorization_granted', 'connection_closed', 'authorization_lost', 'device_identity_mismatch', 'device_rebind_required', 'node_reported_failure', 'configuration_rpc_failed']);

export function ConnectionLogs({ api, deviceId, devices = [], embedded = false }: {
    api: ApiClient; deviceId?: string; devices?: Array<{ id: string; name: string }>; embedded?: boolean;
}) {
    const { t } = useTranslation('devices');
    const [filter, setFilter] = useState('');
    const [cursors, setCursors] = useState<Array<number | undefined>>([undefined]);
    const cursor = cursors[cursors.length - 1];
    const selectedDevice = deviceId || filter || undefined;
    const resource = useResource(() => api.list_management_connection_events({ device_id: selectedDevice, before_id: cursor, limit: 50 }),
        `connection-events:${selectedDevice ?? '*'}:${cursor ?? 'latest'}`, cursor === undefined ? 5000 : 0);
    const names = new Map(devices.map(device => [device.id, device.name]));
    const content = <div className="form-stack">
        <div className="list-toolbar">
            {!deviceId && <select aria-label={t('connectionLogs.device')} value={filter} onChange={event => { setFilter(event.target.value); setCursors([undefined]); }}>
                <option value="">{t('connectionLogs.allDevices')}</option>
                {devices.map(device => <option key={device.id} value={device.id}>{device.name}</option>)}
            </select>}
            <Button icon="refresh" tone="ghost" busy={resource.loading} onClick={resource.refresh}>{t('actions.refresh')}</Button>
            <Button tone="ghost" disabled={cursor === undefined || resource.loading} onClick={() => setCursors([undefined])}>{t('connectionLogs.latest')}</Button>
        </div>
        {resource.error && <Alert tone="error">{resource.error}</Alert>}
        {!resource.data ? resource.loading ? <p role="status">{t('connectionLogs.loading')}</p> : null : resource.data.events.length ? <div className="table-wrap connection-log-table"><table className="data-table">
            <thead><tr>{['time', ...(!deviceId ? ['device'] : []), 'event', 'reason', 'source', 'instance'].map(key => <th key={key}>{t(`connectionLogs.${key}`)}</th>)}</tr></thead>
            <tbody>{resource.data.events.map(entry => <tr key={entry.id}>
                <td className="mono">{formatDate(entry.occurred_at * 1000, { dateStyle: 'short', timeStyle: 'medium' })}</td>
                {!deviceId && <td><a href={`#${devicePath(entry.device_id)}`}>{names.get(entry.device_id) || entry.device_id}</a></td>}
                <td><Status state={connectionEventState(entry.event)} label={t(`connectionLogs.events.${eventKeys.has(entry.event) ? entry.event : 'unknown'}`)}/></td>
                <td>{t(`connectionLogs.reasons.${reasonKeys.has(entry.reason) ? entry.reason : 'unknown'}`)}</td>
                <td className="mono">{entry.peer_ip || '—'}</td>
                <td className="mono">{entry.instance_id || '—'}</td>
            </tr>)}</tbody>
        </table></div> : <Empty title={t('connectionLogs.empty')}/>}
        <div className="actions end">
            <Button tone="ghost" disabled={cursors.length < 2 || resource.loading} onClick={() => setCursors(previous => previous.slice(0, -1))}>{t('connectionLogs.newer')}</Button>
            <Button tone="ghost" disabled={resource.data?.next_before_id == null || resource.loading || !!resource.error} onClick={() => { const next = resource.data?.next_before_id; if (next != null) setCursors(previous => [...previous, next]); }}>{t('connectionLogs.older')}</Button>
        </div>
    </div>;
    return embedded ? content : <Panel title={t('connectionLogs.title')}>{content}</Panel>;
}
