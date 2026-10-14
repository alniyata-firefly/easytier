import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ObservabilityDisplay } from '../lib/shared';
import { formatDate } from '../lib/i18n';
import { useMetricFormat } from './MetricFormat';

export type ChartSeries = { name: string; values: ObservabilityDisplay.HistoryPoint[] };
const colors = ['var(--chart-1, #0070ff)', 'var(--chart-2, #2b8a57)', 'var(--chart-3, #b88618)', 'var(--chart-4, #64748b)'];
export function MetricChart({ title, unit, series, start, end }: { title: string; unit: string; series: ChartSeries[]; start: number; end: number }) {
    const {t}=useTranslation('metrics');
    const metricFormat=useMetricFormat();
    const titleId = useId(), descriptionId = useId();
    const [selectedTime, setSelectedTime] = useState<number>();
    const width = 780, height = 235, left = 90, right = 20, top = 20, bottom = 40;
    const valid = useMemo(() => series.flatMap(row => row.values.filter(point => point[1] !== null && Number.isFinite(point[1]))), [series]);
    const maximum = valid.reduce((max, point) => Math.max(max, point[1] ?? 0), 0);
    const scale = maximum > 0 ? maximum * 1.12 : 1;
    const x = (time: number) => left + (Math.max(start, Math.min(end, time)) - start) / Math.max(1, end - start) * (width - left - right);
    const y = (value: number) => height - bottom - value / scale * (height - top - bottom);
    const times = useMemo(() => [...new Set(series.flatMap(row => row.values.map(point => point[0])))].sort((a, b) => a - b), [series]);
    const format = (value: number | null | undefined) => metricFormat.history(value, unit);
    const timeLabel = (time: number) => formatDate(time * 1000, { hour: '2-digit', minute: '2-digit' });
    const path = (values: ObservabilityDisplay.HistoryPoint[]) => { let active = false; return values.map(([time, value]) => { if (value === null || !Number.isFinite(value)) { active = false; return ''; } const result = `${active ? 'L' : 'M'}${x(time).toFixed(2)},${y(value).toFixed(2)}`; active = true; return result; }).join(' '); };
    const select = (time: number) => { if (times.length) setSelectedTime(times.reduce((nearest, current) => Math.abs(current - time) < Math.abs(nearest - time) ? current : nearest, times[0])); };
    if (!valid.length) return <p className="chart-empty muted">{t('chart.empty')}</p>;
    return <figure className="metric-chart">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={`${titleId} ${descriptionId}`} tabIndex={0}
            onPointerMove={event => { const box = event.currentTarget.getBoundingClientRect(); select(start + ((event.clientX - box.left) / box.width * width - left) / (width - left - right) * (end - start)); }}
            onPointerLeave={() => setSelectedTime(undefined)} onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const at = selectedTime === undefined ? times.length - 1 : times.indexOf(selectedTime); const next = event.key === 'Home' ? 0 : event.key === 'End' ? times.length - 1 : Math.max(0, Math.min(times.length - 1, at + (event.key === 'ArrowRight' ? 1 : -1))); setSelectedTime(times[next]); }}>
            <title id={titleId}>{title}</title><desc id={descriptionId}>{t('chart.description')}</desc>
            {[0, 0.5, 1].map(ratio => <g key={ratio}><line className="chart-grid" x1={left} x2={width - right} y1={y(scale * ratio)} y2={y(scale * ratio)} /><text className="chart-axis-label" textAnchor="end" x={left - 12} y={y(scale * ratio) + 4}>{format(scale * ratio)}</text></g>)}
            {[start, (start + end) / 2, end].map((time, index) => <text className="chart-axis-label" key={index} textAnchor={index === 0 ? 'start' : index === 2 ? 'end' : 'middle'} x={x(time)} y={height - 10}>{timeLabel(time)}</text>)}
            {series.map((row, index) => <g key={row.name}><path className="chart-series" d={path(row.values)} fill="none" stroke={colors[index % colors.length]} strokeWidth={1.8} strokeDasharray={index >= colors.length ? '5 3' : undefined} />{row.values.filter(point => point[1] !== null).length === 1 && row.values.filter(point => point[1] !== null).map(point => <circle key={point[0]} cx={x(point[0])} cy={y(point[1]!)} r={3} fill={colors[index % colors.length]} />)}</g>)}
            {selectedTime !== undefined && <line className="chart-cursor" x1={x(selectedTime)} x2={x(selectedTime)} y1={top} y2={height - bottom} />}
        </svg>
        <figcaption className="chart-legend">{series.map((row, index) => <span key={row.name}><i style={{ backgroundColor: colors[index % colors.length] }} aria-hidden="true" />{row.name}</span>)}</figcaption>
        <div className="chart-reading" role="status"><span>{selectedTime === undefined ? null : formatDate(selectedTime * 1000)}</span>{series.map(row => <span key={row.name}>{t('chart.value',{name:row.name,value:selectedTime===undefined?'—':format(row.values.find(point=>point[0]===selectedTime)?.[1])})}</span>)}</div>
    </figure>;
}
