export type ManagementConnectionState = 'online' | 'offline' | 'unknown';

export function managementConnectionState(online: boolean | undefined, unavailable = false): ManagementConnectionState {
    if (unavailable || online === undefined) return 'unknown';
    return online ? 'online' : 'offline';
}
