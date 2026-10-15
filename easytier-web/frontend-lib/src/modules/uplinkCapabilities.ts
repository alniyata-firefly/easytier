export function supportsUplinkSelectionForOs(osType: unknown): boolean {
    return typeof osType !== 'string' || !['android', 'ios'].includes(osType.trim().toLowerCase());
}

export function normalizeUplinkForTarget<T extends Record<string, unknown>>(value: T, supported: boolean): T {
    if (supported) return value;
    const next = { ...value, bind_device: false };
    delete next.uplink;
    return next;
}
