import type { SessionSnapshot } from '../../native/types';

export function managementStatus(snapshot: SessionSnapshot): { state: string; label: string } {
  if (snapshot.clientPaused) return { state: 'stopped', label: 'clientPaused' };
  if (!snapshot.mode.config_server_url || !snapshot.connected) return { state: 'offline', label: 'disconnected' };
  switch (snapshot.managementState) {
    case 'authorized': return { state: 'online', label: 'managementAuthorized' };
    case 'authenticating': return { state: 'unknown', label: 'managementAuthenticating' };
    case 'rejected': return { state: 'failed', label: 'managementRejected' };
    case 'pending_approval': return { state: 'pending', label: 'managementPendingApproval' };
    case 'unknown': return { state: 'unknown', label: 'managementUnknown' };
    case 'connecting': return { state: 'unknown', label: 'managementConnecting' };
    default: return { state: 'offline', label: 'disconnected' };
  }
}
