import type { NodeConfigRecord } from './node-config';

export function supportsUplinkSelectionForTarget(platform: string, mode: { mode: string }): boolean {
    return mode.mode === 'remote' || (platform !== 'android' && platform !== 'ios');
}

export function normalizeUplinkForTarget(value: NodeConfigRecord, supported: boolean): NodeConfigRecord {
    if (supported) return value;
    const next = { ...value };
    delete next.uplink;
    return next;
}
