export function connectionEventState(event: string): string {
    switch (event) {
        case 'authorized': return 'online';
        case 'disconnected': return 'offline';
        case 'pending_approval': return 'pending';
        case 'authentication_rejected':
        case 'configuration_apply_failed': return 'failed';
        default: return 'unknown';
    }
}
