import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ApiClient from '../lib/api';
import { useResource } from '../lib/hooks';
import { ObservabilityDisplay } from '../lib/shared';
import { formatDate } from '../lib/i18n';
import { useMetricFormat } from './MetricFormat';
import { Alert, Button, Panel } from './ui';

function useSampleClock() {
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        const update = () => { if (!document.hidden) setNow(Date.now()); };
        const clock = setInterval(update, 1000); document.addEventListener('visibilitychange', update);
        return () => { clearInterval(clock); document.removeEventListener('visibilitychange', update); };
    }, []);
    return now;
}
export function HostResources({ resources, supported, loading = false, error, processLabel }: {
    resources?: ObservabilityDisplay.HostResources; supported?: boolean; loading?: boolean; error?: string; processLabel?: string;
}) {
    const { t } = useTranslation('metrics'), metricFormat = useMetricFormat(), now = useSampleClock();
    const memoryLabel = processLabel ?? t('resources.coreMemory');
    const sampleLabel = (value: unknown) => { const time = ObservabilityDisplay.sampleTimestamp(value); return time ? formatDate(time, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : t('unknown'); };
    const stale = !!resources && ObservabilityDisplay.staleSample(resources.sampled_at_unix_ms, now, 15000);
    const disksStale = !!resources?.disks?.length && ObservabilityDisplay.staleSample(resources.disks_sampled_at_unix_ms, now, 90000);
    const unknown = (component: string, expired = stale) => !!error || expired || resources?.collection_errors?.includes(component);
    const cpu = unknown('cpu') ? undefined : ObservabilityDisplay.percentage(resources?.cpu_usage_percent);
    const memory = unknown('memory') ? undefined : ObservabilityDisplay.usedMemory(resources?.memory_total_bytes, resources?.memory_available_bytes);
    const rss = unknown('process_rss') ? undefined : resources?.process_rss_bytes;
    const labels: Record<string, string> = { cpu: t('resources.cpu'), memory: t('resources.memory'), process_rss: memoryLabel, disks: t('resources.disks') };
    return <div className="host-resources" data-testid="host-resources" aria-busy={loading}>
        {error && <Alert tone="warning">{t('resources.readFailed', { error })}</Alert>}
        {!loading && !resources && !error && <Alert tone="info">{t(supported === false ? 'resources.unsupported' : supported === true ? 'resources.unavailable' : 'resources.unreported')}</Alert>}
        <dl className="resource-values">
            <div className="resource-value" data-testid="host-cpu"><dt>{t('resources.cpuUsage')}</dt><dd>{metricFormat.percent(cpu)}</dd><progress aria-label={t('resources.cpuUsage')} max={100} value={cpu ?? 0} aria-valuetext={cpu === undefined ? t('unknown') : metricFormat.percent(cpu)} /></div>
            <div className="resource-value" data-testid="host-memory"><dt>{t('resources.hostMemory')}</dt><dd>{metricFormat.quantity(memory?.used, true)}</dd><small className="muted">{t('resources.total', { value: metricFormat.quantity(unknown('memory') ? undefined : resources?.memory_total_bytes, true) })}</small><progress aria-label={t('resources.memoryUsage')} max={100} value={memory?.percent ?? 0} aria-valuetext={memory ? metricFormat.percent(memory.percent) : t('unknown')} /></div>
            <div className="resource-value" data-testid="host-rss"><dt>{memoryLabel}</dt><dd>{metricFormat.quantity(rss, true)}</dd></div>
        </dl>
        {loading && !resources && <p role="status" className="muted small">{t('resources.loading')}</p>}
        {resources && <p className="sample-note muted small">{t('resources.diskSample', { time: sampleLabel(resources.sampled_at_unix_ms), stale: stale ? t('resources.stale') : '' })}</p>}
        {!!resources?.collection_errors?.length && <p className="error-text small">{t('resources.collectionFailed', { components: resources.collection_errors.map(key => labels[key] ?? key).join(t('listSeparator')) })}</p>}
        {!!resources?.disks?.length && <div className="resource-disks" data-testid="host-disks"><div className="resource-subheading"><h3>{t('resources.disks')}</h3><small className="muted">{t('resources.diskSample', { time: sampleLabel(resources.disks_sampled_at_unix_ms), stale: disksStale ? t('resources.stale') : '' })}</small></div>{resources.disks.map(disk => {
            const used = unknown('disks', disksStale) ? undefined : ObservabilityDisplay.usedMemory(disk.total_bytes, disk.available_bytes);
            return <div className="disk-resource-row" key={disk.mount_point}><span className="mono">{disk.mount_point}</span><span className="numeric">{t('resources.usedOfTotal', { used: metricFormat.quantity(used?.used, true), total: metricFormat.quantity(unknown('disks', disksStale) ? undefined : disk.total_bytes, true) })}</span><span>{metricFormat.percent(used?.percent)}</span><progress aria-label={t('resources.diskUsage', { mount: disk.mount_point })} max={100} value={used?.percent ?? 0} aria-valuetext={used ? metricFormat.percent(used.percent) : t('unknown')} /></div>;
        })}</div>}
    </div>;
}

export function ServerResources({ api }: { api: ApiClient }) {
    const { t } = useTranslation('metrics');
    const forbidden = useRef(false), [hidden, setHidden] = useState(false);
    const resource = useResource(async () => {
        if (forbidden.current) return undefined;
        try { return await api.get_server_resources(); }
        catch (error) {
            if ((error as { response?: { status?: number } })?.response?.status === 403) { forbidden.current = true; setHidden(true); return undefined; }
            throw error;
        }
    }, 'web-server-resources', hidden ? 0 : 10000);
    useEffect(() => { forbidden.current = false; setHidden(false); }, [api]);
    if (hidden) return null;
    return <Panel title={t('resources.serverTitle')} className="server-resources" action={<Button tone="ghost" icon="refresh" busy={resource.loading} onClick={resource.refresh}>{t('common:refresh')}</Button>}>
        <HostResources resources={resource.error ? undefined : resource.data?.host_resources} supported={resource.data?.host_resources_supported} loading={resource.loading} error={resource.error} processLabel={t('resources.webMemory')} />
    </Panel>;
}

export default HostResources;
