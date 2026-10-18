import type { SessionSnapshot } from '../../native/types';
import type { NetworkInstanceRunningInfo } from '../../../../easytier-web/frontend-lib/src/types/network';

export type NetworkConnectionState = 'connected' | 'running' | 'stopped' | 'failed' | 'unknown';

export function networkConnectionState(running: boolean, info?: NetworkInstanceRunningInfo): NetworkConnectionState {
  if (!running) return 'stopped';
  if (!info) return 'unknown';
  if (info.error_msg) return 'failed';
  // A listed ID can outlive its stopped actor. A false runtime bit does not
  // prove startup; showing "connecting" here would never clear on a clean stop.
  if (!info.running) return 'stopped';
  return info.peers?.some(peer => peer.conns?.some(conn => !!conn.conn_id && !conn.is_closed)) ? 'connected' : 'running';
}

export function aggregateNetworkState(runningIds: string[], infos: Record<string, NetworkInstanceRunningInfo>): NetworkConnectionState {
  const states = runningIds.map(id => networkConnectionState(true, infos[id]));
  return (['connected', 'running', 'unknown', 'failed'] as const).find(state => states.includes(state)) ?? 'stopped';
}

export function networkConnectionStatus(state: NetworkConnectionState): { state: string; label: string } {
  switch (state) {
    case 'connected': return { state: 'online', label: 'networkConnected' };
    case 'running': return { state: 'running', label: 'running' };
    case 'failed': return { state: 'failed', label: 'networkFailed' };
    case 'unknown': return { state: 'unknown', label: 'networkUnknown' };
    default: return { state: 'offline', label: 'stopped' };
  }
}

export function clientConnectionStatus(snapshot: SessionSnapshot, dataPlane: NetworkConnectionState = 'unknown'): { state: string; label: string } {
  if (snapshot.platform === 'android') {
    if (snapshot.vpnTransition) return { state: snapshot.vpnTransition, label: snapshot.vpnTransition === 'disconnecting' ? 'vpnDisconnecting' : 'clientStarted' };
    if (snapshot.vpnStopIncomplete || snapshot.errorCode === 'client_stop_failed') return { state: 'failed', label: 'vpnDisconnectFailed' };
    if (snapshot.vpnConnected) return { state: 'online', label: 'vpnConnected' };
    return snapshot.clientPaused ? { state: 'offline', label: 'clientPaused' } : { state: 'connecting', label: 'clientStarted' };
  }
  if (!snapshot.connected) return { state: 'unknown', label: 'vpnUnknown' };
  if (dataPlane === 'stopped') return { state: 'offline', label: 'clientPaused' };
  return networkConnectionStatus(dataPlane);
}

export function managementStatus(snapshot: SessionSnapshot): { state: string; label: string } {
  if (!snapshot.mode.config_server_url || !snapshot.connected) return { state: 'offline', label: 'disconnected' };
  switch (snapshot.managementState) {
    case 'authorized': return { state: 'online', label: 'managementAuthorized' };
    case 'authenticating': return { state: 'authenticating', label: 'managementAuthenticating' };
    case 'rejected': return { state: 'failed', label: 'managementRejected' };
    case 'pending_approval': return { state: 'pending', label: 'managementPendingApproval' };
    case 'unknown': return { state: 'unknown', label: 'managementUnknown' };
    case 'connecting': return { state: 'connecting', label: 'managementConnecting' };
    default: return { state: 'offline', label: 'disconnected' };
  }
}
