import { CounterRate, counter } from '../../../../easytier-web/frontend-lib/src/modules/runtimeDisplay';
import type { PeerConnInfo } from '../../../../easytier-web/frontend-lib/src/types/network';

export interface TrafficPoint { time: number; rx: number | null; tx: number | null }
export function connectionTotal(conns: PeerConnInfo[] | undefined, direction: 'rx' | 'tx'): bigint | undefined {
  if (!conns?.length) return undefined;
  let total = 0n;
  for (const conn of conns) {
    const value = counter(conn.stats?.[`${direction}_bytes`]);
    if (value === undefined) return undefined;
    total += value;
  }
  return total;
}

export class TrafficHistory {
  private scope?: string;
  private points: TrafficPoint[] = [];
  private rx = new CounterRate();
  private tx = new CounterRate();
  constructor(private readonly maxPoints = 120, readonly maxAgeMs = 300000) {}
  reset(): void { this.scope = undefined; this.points = []; this.rx.reset(); this.tx.reset(); }
  snapshot(): TrafficPoint[] { return this.points.map(point => ({ ...point })); }
  sample(scope: string, time: number, rxBytes: unknown, txBytes: unknown): TrafficPoint[] {
    if (!Number.isFinite(time) || time < 0) { this.reset(); return []; }
    if (this.scope !== scope || (this.points.length && time <= this.points[this.points.length - 1].time)) this.reset();
    this.scope = scope;
    this.points.push({ time, rx: this.rx.sample(rxBytes, time, scope) ?? null, tx: this.tx.sample(txBytes, time, scope) ?? null });
    this.points = this.points.filter(point => point.time >= time - this.maxAgeMs).slice(-this.maxPoints);
    return this.snapshot();
  }
}

export function trafficPath(points: TrafficPoint[], direction: 'rx' | 'tx', x: (time: number) => number, y: (value: number) => number): string {
  let drawing = false;
  return points.map(point => {
    const value = point[direction];
    if (value === null || !Number.isFinite(value)) { drawing = false; return ''; }
    const segment = `${drawing ? 'L' : 'M'}${x(point.time).toFixed(2)},${y(value).toFixed(2)}`;
    drawing = true;
    return segment;
  }).join(' ');
}
