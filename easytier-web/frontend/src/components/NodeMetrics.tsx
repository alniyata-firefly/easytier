import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ApiClient, { type MetricSnapshot } from '../lib/api';
import { useResource } from '../lib/hooks';
import { ObservabilityDisplay, RuntimeDisplay } from '../lib/shared';
import { formatDate } from '../lib/i18n';
import { Alert, Button, Empty } from './ui';
import { HostResources } from './HostResources';
import { MetricChart } from './MetricChart';
import { MetricHistory } from './MetricHistory';
import { useMetricFormat } from './MetricFormat';

const metricKey = (metric: MetricSnapshot) => `${metric.name}:${JSON.stringify(Object.entries(metric.labels ?? {}).sort())}`;
const isCounter = (name: string) => /(?:bytes|packets|errors)/.test(name) || (name.startsWith('peer_rpc_') && !name.endsWith('_ms'));
const sum = (rows: MetricSnapshot[], name: string) => { const matches = rows.filter(row => row.name === name); if (!matches.length) return undefined; const values = matches.map(row => RuntimeDisplay.counter(row.value)); return values.every((value): value is bigint => value !== undefined) ? values.reduce((total, value) => total + value, 0n) : undefined; };
export function NodeMetrics({ api, machineId, instanceId, online = true, nodeName }: { api: ApiClient; machineId: string; instanceId: string; online?: boolean; nodeName?: string }) {
    const { t } = useTranslation('metrics'), metricFormat = useMetricFormat();
    const resource = useResource(() => online ? api.get_node_stats_snapshot(machineId, instanceId) : Promise.resolve(undefined), `node-metrics:${machineId}:${instanceId}:${online}`, online ? 8000 : 0);
    const hasError = Boolean(resource.error), errorRevision = resource.errorRevision;
    const samples = useRef(new Map<string, InstanceType<typeof RuntimeDisplay.CounterRate>>());
    const [rates, setRates] = useState(new Map<string, number | undefined>());
    const [live, setLive] = useState<Array<{ time: number; rx: number | null; tx: number | null }>>([]), [filter, setFilter] = useState('');
    const download = useRef(false), [downloading, setDownloading] = useState(false), [downloadError, setDownloadError] = useState<string>();
    useEffect(() => { samples.current.clear(); setRates(new Map()); setLive([]); setFilter(''); setDownloadError(undefined); }, [machineId, instanceId, online]);
    useEffect(() => {
        if (!resource.data || hasError) { if (hasError) { samples.current.clear(); setRates(new Map()); setLive(previous => [...previous, { time: Date.now() / 1000, rx: null, tx: null }].slice(-45)); } return; }
        const next = new Map<string, number | undefined>(), present = new Set<string>(), scope = `${machineId}:${instanceId}`;
        for (const metric of resource.data.metrics) {
            if (!isCounter(metric.name)) continue;
            const key = metricKey(metric); present.add(key); const counter = samples.current.get(key) ?? new RuntimeDisplay.CounterRate(); samples.current.set(key, counter);
            next.set(key, counter.sample(metric.value, resource.updatedAt, scope));
        }
        for (const key of samples.current.keys()) if (!present.has(key)) samples.current.delete(key);
        setRates(next);
        const rate = (name: string) => { const values = resource.data!.metrics.filter(metric => metric.name === name).map(metric => next.get(metricKey(metric))); return values.length && values.every((value): value is number => value !== undefined && Number.isFinite(value)) ? values.reduce((total, value) => total + value, 0) : null; };
        setLive(previous => [...previous, { time: resource.updatedAt / 1000, rx: rate('traffic_bytes_rx'), tx: rate('traffic_bytes_tx') }].slice(-45));
    }, [resource.data, resource.updatedAt, hasError, errorRevision, machineId, instanceId]);
    const rows = useMemo(() => (resource.data?.metrics ?? []).filter(metric => `${metric.name} ${Object.values(metric.labels ?? {}).join(' ')}`.toLowerCase().includes(filter.toLowerCase())).map(metric => ({ ...metric, key: metricKey(metric) })), [resource.data, filter]);
    const downloadMetrics = async () => {
        if (download.current) return; download.current = true; setDownloading(true); setDownloadError(undefined);
        try { const text = await api.get_node_http_metrics(machineId, instanceId); const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${machineId}.prom`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0); }
        catch { setDownloadError('node.exportFailed'); }
        finally { download.current = false; setDownloading(false); }
    };
    if (!online) return <Empty title={t('node.offline')} />;
    const metrics = resource.error ? [] : resource.data?.metrics ?? [];
    const currentLive = resource.data ? live : [];
    const liveSeries = [{ name: t('metricNames.traffic_rx_rate'), values: currentLive.map(sample => [sample.time, sample.rx] as ObservabilityDisplay.HistoryPoint) }, { name: t('metricNames.traffic_tx_rate'), values: currentLive.map(sample => [sample.time, sample.tx] as ObservabilityDisplay.HistoryPoint) }];
    return <div className="node-metrics stack" aria-label={nodeName ? t('node.namedMetrics', { name: nodeName }) : t('node.title')}>
        <div className="resource-subheading"><h3>{t('node.live')}</h3><div className="actions"><small className="muted">{resource.updatedAt ? formatDate(resource.updatedAt, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : t('node.waiting')}</small><Button tone="ghost" icon="refresh" busy={resource.loading} onClick={resource.refresh}>{t('common:refresh')}</Button><Button tone="ghost" icon="download" busy={downloading} onClick={downloadMetrics}>{t('node.export')}</Button></div></div>
        {resource.error && <Alert tone="warning">{t('node.readFailed', { error: resource.error })}<Button tone="ghost" onClick={resource.refresh}>{t('common:retry')}</Button></Alert>}
        {downloadError && <Alert tone="error">{t(downloadError)}</Alert>}
        <dl className="traffic-values"><div><dt>{t('node.received')}</dt><dd>{metricFormat.quantity(sum(metrics, 'traffic_bytes_rx'), true)}</dd></div><div><dt>{t('node.sent')}</dt><dd>{metricFormat.quantity(sum(metrics, 'traffic_bytes_tx'), true)}</dd></div><div><dt>{t('node.receiveRate')}</dt><dd>{metricFormat.history(resource.error ? undefined : currentLive.at(-1)?.rx, 'bytes_per_second')}</dd></div><div><dt>{t('node.sendRate')}</dt><dd>{metricFormat.history(resource.error ? undefined : currentLive.at(-1)?.tx, 'bytes_per_second')}</dd></div></dl>
        {currentLive.length > 1 && <MetricChart title={t('node.rateChart')} unit="bytes_per_second" start={currentLive[0].time} end={currentLive.at(-1)!.time} series={liveSeries} />}
        <section aria-label={t('node.hostSection')}><div className="resource-subheading"><h3>{t('node.hostResources')}</h3></div><HostResources resources={resource.error ? undefined : resource.data?.host_resources} supported={resource.data?.host_resources_supported} loading={resource.loading} error={resource.error} /></section>
        <MetricHistory api={api} machineId={machineId} instanceId={instanceId} />
        <details className="metric-details"><summary>{t('node.all', { count: resource.data?.metrics.length ?? 0 })}</summary><label className="search-field"><span className="sr-only">{t('node.filter')}</span><input aria-label={t('node.filter')} value={filter} onChange={event => setFilter(event.target.value)} placeholder={t('node.filterPlaceholder')} /></label><div className="table-wrap"><table className="data-table"><thead><tr><th>{t('node.metric')}</th><th>{t('node.sampleValue')}</th><th>{t('node.perSecond')}</th><th>{t('node.labels')}</th></tr></thead><tbody>{rows.map(metric => <tr key={metric.key}><td className="mono">{metric.name}</td><td className="numeric">{resource.error ? '—' : metric.name.endsWith('_ms') ? t('units.milliseconds', { value: metricFormat.quantity(metric.value) }) : metricFormat.quantity(metric.value, metric.name.includes('bytes'))}</td><td className="numeric">{!isCounter(metric.name) || resource.error ? '—' : metricFormat.history(rates.get(metric.key), metric.name.includes('bytes') ? 'bytes_per_second' : 'count_per_second')}</td><td className="small mono">{Object.entries(metric.labels ?? {}).map(([key, value]) => `${key}=${value}`).join(' · ') || '—'}</td></tr>)}</tbody></table></div>{resource.loading && !resource.data ? <p role="status" className="muted">{t('node.loading')}</p> : !rows.length && <p className="muted">{t('node.noMatch')}</p>}</details>
    </div>;
}

export default NodeMetrics;
