import { useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import ApiClient from '../lib/api';
import { useResource } from '../lib/hooks';
import { ObservabilityDisplay } from '../lib/shared';
import { Alert, Button, Field } from './ui';
import { MetricChart } from './MetricChart';

const groups = [
    { id: 'traffic', labelKey: 'history.groups.traffic', metrics: ['traffic_rx_rate', 'traffic_tx_rate'] },
    { id: 'cpu', labelKey: 'history.groups.cpu', metrics: ['host_cpu_percent'] },
    { id: 'memory', labelKey: 'history.groups.memory', metrics: ['host_memory_used_bytes', 'host_process_rss_bytes'] },
    { id: 'disks', labelKey: 'history.groups.disks', metrics: ['host_disk_used_bytes'] },
    { id: 'rpc', labelKey: 'history.groups.rpc', metrics: ['rpc_error_rate'] },
];
const metricNames: Record<string, string> = { traffic_rx_rate: 'metricNames.traffic_rx_rate', traffic_tx_rate: 'metricNames.traffic_tx_rate', host_cpu_percent: 'metricNames.host_cpu_percent', host_memory_used_bytes: 'metricNames.host_memory_used_bytes', host_process_rss_bytes: 'metricNames.host_process_rss_bytes', host_disk_used_bytes: 'metricNames.host_disk_used_bytes', rpc_error_rate: 'metricNames.rpc_error_rate' };
const ranges = [{ value: 3600, labelKey: 'history.ranges.hour' }, { value: 21600, labelKey: 'history.ranges.sixHours' }, { value: 86400, labelKey: 'history.ranges.day' }, { value: 604800, labelKey: 'history.ranges.week' }, { value: 2592000, labelKey: 'history.ranges.month' }];
const localDate = (time: number) => { const value = new Date(time); return new Date(time - value.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
export function MetricHistory({ api, machineId, instanceId }: { api: ApiClient; machineId: string; instanceId: string }) {
    const { t } = useTranslation('metrics');
    const capability = useResource(() => api.get_observability_capabilities(), 'history-capabilities', 60000);
    const [group, setGroup] = useState('traffic'), [range, setRange] = useState(3600), [custom, setCustom] = useState<{ start: number; end: number }>();
    const [from, setFrom] = useState(() => localDate(Date.now() - 3600000)), [to, setTo] = useState(() => localDate(Date.now())), [validation, setValidation] = useState<string>();
    const available = capability.data?.history_available === true;
    const definition = groups.find(item => item.id === group) ?? groups[0];
    const ids = definition.metrics.filter(id => capability.data?.metrics.some(metric => metric.id === id));
    const history = useResource(async () => {
        if (!available || !capability.data || !ids.length || (range === -1 && !custom)) return undefined;
        const end = range === -1 ? custom!.end : Math.floor(Date.now() / 1000), start = range === -1 ? custom!.start : end - Math.min(range, capability.data.max_range_seconds);
        const step = ObservabilityDisplay.historyStep(end - start, capability.data.min_step_seconds, capability.data.max_points_per_series);
        const results = await Promise.allSettled(ids.map(metric => api.get_node_metrics_history(machineId, instanceId, metric, start, end, step)));
        return { start, end, step, results: results.flatMap(result => result.status === 'fulfilled' && result.value.available ? [result.value] : []), errors: results.flatMap((result, index) => result.status === 'rejected' ? [ids[index]] : []) };
    }, `history:${machineId}:${instanceId}:${available}:${ids.join(',')}:${range}:${custom?.start}:${custom?.end}`, available ? 60000 : 0);
    const series = useMemo(() => (history.data?.results ?? []).flatMap(result => result.series.map(row => ({ name: `${metricNames[result.metric] ? t(metricNames[result.metric]) : result.metric}${row.labels.mount_point ? ` (${row.labels.mount_point})` : ''}`, values: ObservabilityDisplay.historyPoints(row.values, result.step) }))), [history.data, t]);
    const applyRange = (event: FormEvent) => {
        event.preventDefault(); const start = Math.floor(new Date(from).getTime() / 1000), end = Math.floor(new Date(to).getTime() / 1000);
        if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end > Date.now() / 1000 || end - start > (capability.data?.max_range_seconds ?? 2678400)) { setValidation('history.invalidRange'); return; }
        setValidation(undefined); setCustom({ start, end });
    };
    return <section className="metric-history" data-testid="metrics-history" aria-label={t('history.title')} aria-busy={history.loading || capability.loading}>
        <div className="resource-subheading"><h3>{t('history.title')}</h3><Button tone="ghost" icon="refresh" busy={capability.loading || history.loading} onClick={() => { capability.refresh(); history.refresh(); }}>{t('common:refresh')}</Button></div>
        {capability.error ? <Alert tone="warning">{t('history.capabilityFailed', { error: capability.error })}<Button tone="ghost" onClick={capability.refresh}>{t('common:retry')}</Button></Alert> : capability.loading && !capability.data ? <p role="status" className="muted">{t('history.capabilityLoading')}</p> : !available ? <Alert tone="info">{t('history.disabled')}</Alert> : <>
            <div className="history-controls"><Field label={t('history.type')}><select aria-label={t('history.type')} value={group} onChange={event => setGroup(event.target.value)}>{groups.filter(item => item.metrics.some(id => capability.data?.metrics.some(metric => metric.id === id))).map(item => <option key={item.id} value={item.id}>{t(item.labelKey)}</option>)}</select></Field><Field label={t('history.range')}><select aria-label={t('history.range')} value={range} onChange={event => { setRange(Number(event.target.value)); setValidation(undefined); }}>{ranges.filter(item => item.value <= (capability.data?.max_range_seconds ?? 0)).map(item => <option key={item.value} value={item.value}>{t(item.labelKey)}</option>)}<option value={-1}>{t('history.custom')}</option></select></Field></div>
            {range === -1 && <form className="history-custom" onSubmit={applyRange}><Field label={t('history.start')}><input aria-label={t('history.start')} type="datetime-local" value={from} onChange={event => setFrom(event.target.value)} required /></Field><Field label={t('history.end')}><input aria-label={t('history.end')} type="datetime-local" value={to} onChange={event => setTo(event.target.value)} required /></Field><Button type="submit">{t('history.query')}</Button>{validation && <p role="alert" className="error-text">{t(validation)}</p>}</form>}
            {history.error && <Alert tone="warning">{t('history.queryFailed', { error: history.error })}<Button tone="ghost" onClick={history.refresh}>{t('common:retry')}</Button></Alert>}
            {!!history.data?.errors.length && <Alert tone="warning">{t('history.partialFailed', { metrics: history.data.errors.map(id => metricNames[id] ? t(metricNames[id]) : id).join(t('listSeparator')) })}<Button tone="ghost" onClick={history.refresh}>{t('common:retry')}</Button></Alert>}
            {history.loading && !history.data ? <p role="status" className="muted">{t('history.loading')}</p> : history.data ? <MetricChart title={t(definition.labelKey)} unit={history.data.results[0]?.unit ?? ''} start={history.data.start} end={history.data.end} series={series} /> : range === -1 && !custom ? null : <p className="muted">{t('history.empty')}</p>}
        </>}
    </section>;
}
