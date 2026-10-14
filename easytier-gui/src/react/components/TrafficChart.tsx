import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { formatQuantity } from '../../../../easytier-web/frontend-lib/src/modules/runtimeDisplay';
import { trafficPath, type TrafficPoint } from '../lib/traffic-history';

export function TrafficChart({ points, maxAgeMs = 300000 }: { points: TrafficPoint[]; maxAgeMs?: number }) {
  const { t } = useTranslation('client'), titleId = useId();
  if (!points.some(point => point.rx !== null || point.tx !== null)) return <div className="chart-empty muted" role="status">{t('resourceUnavailable')}</div>;
  const width = 700, height = 180, left = window.matchMedia('(max-width: 600px)').matches ? 150 : 82, right = 16, top = 14, bottom = 30;
  const end = points[points.length - 1].time, start = end - maxAgeMs;
  const values = points.flatMap(point => [point.rx, point.tx]).filter((value): value is number => value !== null && Number.isFinite(value));
  const scale = Math.max(1, ...values) * 1.12;
  const x = (time: number) => left + (time - start) / maxAgeMs * (width - left - right);
  const y = (value: number) => height - bottom - value / scale * (height - top - bottom);
  return <figure className="metric-chart traffic-chart">
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={titleId}>
      <title id={titleId}>{t('trafficHistory')}</title>
      {[0, .5, 1].map(ratio => <g key={ratio}><line className="chart-grid" x1={left} x2={width - right} y1={y(scale * ratio)} y2={y(scale * ratio)}/><text className="chart-axis-label" textAnchor="end" x={left - 10} y={y(scale * ratio) + 4}>{formatQuantity(Math.floor(scale * ratio), true)}/s</text></g>)}
      {[0, .5, 1].map(ratio => <text key={ratio} className="chart-axis-label" textAnchor={ratio === 0 ? 'start' : ratio === 1 ? 'end' : 'middle'} x={x(start + ratio * maxAgeMs)} y={height - 6}>{ratio === 1 ? t('now') : t('minutesAgo', { value: maxAgeMs * (1 - ratio) / 60000 })}</text>)}
      {(['tx', 'rx'] as const).map(direction => { const valid = points.filter(point => point[direction] !== null); const color = direction === 'tx' ? 'var(--chart-1)' : 'var(--chart-2)'; return <g key={direction}><path data-direction={direction} d={trafficPath(points, direction, x, y)} fill="none" stroke={color} strokeWidth={1.6}/>{valid.length === 1 && <circle cx={x(valid[0].time)} cy={y(valid[0][direction]!)} r={2} fill="none" stroke={color}/>}</g>; })}
    </svg>
    <figcaption className="chart-legend"><span><i className="traffic-legend-tx" aria-hidden="true"/>{t('upload')}</span><span><i className="traffic-legend-rx" aria-hidden="true"/>{t('download')}</span></figcaption>
  </figure>;
}
