import { describe, expect, it } from 'vitest';
import { TrafficHistory, connectionTotal, trafficPath } from './traffic-history';
import type { PeerConnInfo } from '../../../../easytier-web/frontend-lib/src/types/network';

describe('sampled traffic history', () => {
  it('uses the first counter as a baseline and retains an actual zero delta', () => {
    const history = new TrafficHistory();
    expect(history.sample('a', 0, 50n, 60n)[0]).toEqual({ time: 0, rx: null, tx: null });
    expect(history.sample('a', 1000, 50n, 60n)[1]).toEqual({ time: 1000, rx: 0, tx: 0 });
  });
  it('subtracts large uint64 counters before converting the rate', () => {
    const history = new TrafficHistory();
    history.sample('a', 0, '9007199254740993', '9007199254740993');
    expect(history.sample('a', 2000, '9007199254741193', '9007199254741393')[1]).toMatchObject({ rx: 100, tx: 200 });
  });
  it('clears samples when the instance or connection set changes', () => {
    const history = new TrafficHistory();
    history.sample('a:conn1', 0, 10n, 10n); history.sample('a:conn1', 1000, 20n, 20n);
    expect(history.sample('a:conn1,conn2', 2000, 100n, 100n)).toEqual([{ time: 2000, rx: null, tx: null }]);
    expect(history.sample('b:conn1,conn2', 3000, 150n, 150n)).toEqual([{ time: 3000, rx: null, tx: null }]);
  });
  it('keeps unknown direction separate and requires a new baseline after a gap', () => {
    const history = new TrafficHistory(); history.sample('a', 0, 10n, 10n);
    expect(history.sample('a', 1000, 20n, undefined)[1]).toMatchObject({ rx: 10, tx: null });
    expect(history.sample('a', 2000, 30n, 30n)[2]).toMatchObject({ rx: 10, tx: null });
    expect(history.sample('a', 3000, 40n, 40n)[3]).toMatchObject({ rx: 10, tx: 10 });
  });
  it('inserts a gap if a counter resets', () => {
    const history = new TrafficHistory(); history.sample('a', 0, 100n, 100n);
    expect(history.sample('a', 1000, 20n, 30n)[1]).toMatchObject({ rx: null, tx: null });
    expect(history.sample('a', 2000, 25n, 40n)[2]).toMatchObject({ rx: 5, tx: 10 });
  });
  it('clears history and rate baselines on stop/no-info and starts clean when resumed', () => {
    const history = new TrafficHistory(); history.sample('a', 0, 10n, 10n); history.sample('a', 1000, 20n, 20n);
    history.reset(); expect(history.snapshot()).toEqual([]);
    expect(history.sample('a', 2000, 40n, 40n)).toEqual([{ time: 2000, rx: null, tx: null }]);
  });
  it('resets a backwards or invalid sample clock', () => {
    const history = new TrafficHistory(); history.sample('a', 1000, 10n, 10n);
    expect(history.sample('a', 500, 20n, 20n)).toEqual([{ time: 500, rx: null, tx: null }]);
    expect(history.sample('a', NaN, 20n, 20n)).toEqual([]);
  });
  it('enforces a maximum point count', () => {
    const history = new TrafficHistory(3);
    for (let time = 0; time <= 4; time++) history.sample('a', time, time, time);
    expect(history.snapshot().map(point => point.time)).toEqual([2, 3, 4]);
  });
  it('enforces the time window independently of point count', () => {
    const history = new TrafficHistory(120, 1000);
    for (const time of [0, 500, 2000]) history.sample('a', time, time, time);
    expect(history.snapshot().map(point => point.time)).toEqual([2000]);
  });
  it('returns snapshots that cannot mutate stored points', () => {
    const history = new TrafficHistory(); const points = history.sample('a', 0, 0n, 0n);
    points[0].rx = 999; points.push({ time: 1, rx: 1, tx: 1 });
    expect(history.snapshot()).toEqual([{ time: 0, rx: null, tx: null }]);
  });
  it('does not invent counters for absent stats, missing peers, or invalid values', () => {
    const conns = [{ stats: { rx_bytes: '0', tx_bytes: '9007199254740993' } }, { stats: { rx_bytes: '2', tx_bytes: '10' } }] as PeerConnInfo[];
    expect(connectionTotal(conns, 'rx')).toBe(2n); expect(connectionTotal(conns, 'tx')).toBe(9007199254741003n);
    expect(connectionTotal([], 'rx')).toBeUndefined(); expect(connectionTotal(undefined, 'tx')).toBeUndefined();
    expect(connectionTotal([{ stats: undefined }] as PeerConnInfo[], 'rx')).toBeUndefined();
    expect(connectionTotal([{ stats: { rx_bytes: 'invalid' } }] as PeerConnInfo[], 'rx')).toBeUndefined();
  });
  it('starts a new SVG segment after unknown data instead of connecting across it', () => {
    const points = [{ time: 0, rx: null, tx: null }, { time: 1, rx: 0, tx: 0 }, { time: 2, rx: 2, tx: 2 }, { time: 3, rx: null, tx: null }, { time: 4, rx: 4, tx: 4 }];
    expect(trafficPath(points, 'rx', value => value, value => value).trim()).toBe('M1.00,0.00 L2.00,2.00  M4.00,4.00');
    expect(trafficPath([{ time: 0, rx: null, tx: null }], 'rx', value => value, value => value).trim()).toBe('');
  });
});
