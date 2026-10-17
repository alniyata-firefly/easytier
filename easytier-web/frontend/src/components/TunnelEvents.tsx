import { useTranslation } from 'react-i18next';
import type ApiClient from '../lib/api';
import { useResource } from '../lib/hooks';
import { formatDate } from '../lib/i18n';
import { parseTunnelEvents, tunnelEventState } from '../lib/tunnel-events';
import { Alert, Button, Empty, Panel, Status } from './ui';

export function TunnelEvents({ api, deviceId, instanceId }: { api: ApiClient; deviceId: string; instanceId: string }) {
    const { t } = useTranslation('tunnel-events');
    const resource = useResource(async () => {
        const info = (await api.get_node_runtime_infos(deviceId))[instanceId];
        return { available: !!info, events: parseTunnelEvents(info?.events) };
    }, `tunnel-events:${deviceId}:${instanceId}`, 5000);
    return <Panel title={t('title')} action={<Button icon="refresh" tone="ghost" busy={resource.loading} onClick={resource.refresh}>{t('refresh')}</Button>}>
        {resource.error && <Alert tone="error">{resource.error}</Alert>}
        {resource.error ? <p role="status" className="muted">{t('unavailable')}</p> : resource.data === undefined ? resource.loading ? <p role="status">{t('loading')}</p> : null : !resource.data.available ? <p role="status" className="muted">{t('unavailable')}</p> : resource.data.events.length ? <div className="table-wrap tunnel-event-table"><table className="data-table">
            <thead><tr>{['time', 'event', 'peer', 'protocol', 'local', 'remote', 'reason'].map(column => <th key={column}>{t(`columns.${column}`)}</th>)}</tr></thead>
            <tbody>{resource.data.events.map(event => <tr key={event.id}>
                <td className="mono">{event.occurredAt === undefined ? '—' : formatDate(event.occurredAt, { dateStyle: 'short', timeStyle: 'medium' })}</td>
                <td><Status state={tunnelEventState(event.kind)} label={t(`events.${event.kind}`)}/></td>
                <td className="mono">{event.peerId ?? '—'}</td>
                <td>{[event.protocol, event.ipVersion].filter(Boolean).join(' / ') || '—'}</td>
                <td className="mono">{event.localEndpoint || '—'}</td>
                <td className="mono">{event.remoteEndpoint || '—'}</td>
                <td>{event.failureReason ? t(`reasons.${event.failureReason}`) : '—'}</td>
            </tr>)}</tbody>
        </table></div> : <Empty title={t('empty')}/>}
    </Panel>;
}
