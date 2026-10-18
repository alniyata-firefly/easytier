import { describe, expect, it } from 'vitest';
import type { ManagementConnectionState, SessionSnapshot } from '../../native/types';
import type { NetworkInstanceRunningInfo } from '../../../../easytier-web/frontend-lib/src/types/network';
import { aggregateNetworkState, clientConnectionStatus, managementStatus, networkConnectionState, networkConnectionStatus } from './management-status';

const snapshot: SessionSnapshot = {
  platform: 'android', version: 'fixture', mode: { mode: 'normal', config_server_url: 'udp://example.invalid:22020/fixture' },
  connected: true, managementConnected: false, managementState: 'connecting', clientPaused: false, vpnConnected: false,
  serviceStatus: 'NotInstalled', busy: false, revision: 0,
};

describe('management connection labels', () => {
  it('does not report management authorization or RPC readiness as a connected VPN', () => {
    const local = { ...snapshot, mode: { mode: 'normal' as const } };
    expect(clientConnectionStatus(local)).toEqual({ state: 'connecting', label: 'clientStarted' });
    expect(clientConnectionStatus({ ...local, vpnConnected: true })).toEqual({ state: 'online', label: 'vpnConnected' });
    expect(clientConnectionStatus({ ...local, clientPaused: true })).toEqual({ state: 'offline', label: 'clientPaused' });
    expect(clientConnectionStatus({ ...local, platform: 'windows' }, 'stopped')).toEqual({ state: 'offline', label: 'clientPaused' });
    expect(clientConnectionStatus({ ...local, platform: 'windows' }, 'connected')).toEqual({ state: 'online', label: 'networkConnected' });
    expect(clientConnectionStatus({ ...local, platform: 'windows', connected: false }, 'connected')).toEqual({ state: 'unknown', label: 'vpnUnknown' });
    expect(clientConnectionStatus({ ...local, vpnTransition: 'disconnecting' })).toEqual({ state: 'disconnecting', label: 'vpnDisconnecting' });
    expect(clientConnectionStatus({ ...local, errorCode: 'client_stop_failed' })).toEqual({ state: 'failed', label: 'vpnDisconnectFailed' });
    expect(clientConnectionStatus({ ...local, clientPaused: true, vpnStopIncomplete: true })).toEqual({ state: 'failed', label: 'vpnDisconnectFailed' });
    expect(clientConnectionStatus({ ...snapshot, managementState: 'authorized', clientPaused: true })).toEqual({ state: 'offline', label: 'clientPaused' });
    expect(clientConnectionStatus({ ...snapshot, managementState: 'disconnected', connected: false, vpnConnected: true })).toEqual({ state: 'online', label: 'vpnConnected' });
  });
  it.each<ManagementConnectionState>(['connecting', 'authenticating', 'pending_approval', 'rejected', 'unknown', 'disconnected'])('does not label %s as authorized when local Core is running', managementState => {
    const result = managementStatus({ ...snapshot, managementState });
    expect(result.label).not.toBe('managementAuthorized');
    expect(result.state).not.toBe('online');
  });
  it('shows approval and authentication rejection as different conditions', () => {
    expect(managementStatus({ ...snapshot, managementState: 'pending_approval' })).toEqual({ state: 'pending', label: 'managementPendingApproval' });
    expect(managementStatus({ ...snapshot, managementState: 'rejected' })).toEqual({ state: 'failed', label: 'managementRejected' });
  });
  it('keeps management authorization independent of VPN disconnection', () => {
    expect(managementStatus({ ...snapshot, managementState: 'authorized' })).toEqual({ state: 'online', label: 'managementAuthorized' });
    expect(managementStatus({ ...snapshot, managementState: 'authorized', clientPaused: true })).toEqual({ state: 'online', label: 'managementAuthorized' });
    expect(managementStatus({ ...snapshot, managementState: 'authorized', connected: false })).toEqual({ state: 'offline', label: 'disconnected' });
  });
});


const runtime = (overrides: Partial<NetworkInstanceRunningInfo> = {}) => ({ running: true, peers: [], ...overrides } as NetworkInstanceRunningInfo);

describe('cross-platform data-plane observation', () => {
  it.each(['windows', 'macos', 'linux'])('%s never infers a VPN connection from RPC, authorization or a running actor', platform => {
    const local = { ...snapshot, platform, managementState: 'authorized' as const, managementConnected: true };
    expect(clientConnectionStatus(local, networkConnectionState(true, runtime()))).toEqual({ state: 'running', label: 'running' });
    expect(clientConnectionStatus(local, networkConnectionState(true))).toEqual({ state: 'unknown', label: 'networkUnknown' });
    expect(clientConnectionStatus(local, networkConnectionState(true, runtime({ running: false })))).toEqual({ state: 'offline', label: 'clientPaused' });
    expect(clientConnectionStatus(local, networkConnectionState(true, runtime({ running: false, error_msg: 'failed' })))).toEqual({ state: 'failed', label: 'networkFailed' });
    expect(clientConnectionStatus(local, 'stopped')).toEqual({ state: 'offline', label: 'clientPaused' });
    expect(managementStatus(local)).toEqual({ state: 'online', label: 'managementAuthorized' });
  });
  it('requires an open peer connection, ignores closed leftovers and aggregates across all instances', () => {
    const closed = runtime({ peers: [{ peer_id: 1, conns: [{ conn_id: 'old', is_closed: true }] as NetworkInstanceRunningInfo['peers'][number]['conns'] }] });
    const connected = runtime({ peers: [{ peer_id: 2, conns: [{ conn_id: 'open' }] as NetworkInstanceRunningInfo['peers'][number]['conns'] }] });
    expect(networkConnectionState(true, closed)).toBe('running');
    expect(networkConnectionState(true, connected)).toBe('connected');
    expect(networkConnectionStatus(networkConnectionState(true, connected))).toEqual({ state: 'online', label: 'networkConnected' });
    // Core can connect to peers before Android creates a system VPN interface.
    expect(clientConnectionStatus(snapshot, 'connected')).toEqual({ state: 'connecting', label: 'clientStarted' });
    expect(networkConnectionState(false, connected)).toBe('stopped');
    expect(aggregateNetworkState(['idle', 'active'], { idle: runtime(), active: connected })).toBe('connected');
    expect(aggregateNetworkState(['missing'], {})).toBe('unknown');
    expect(aggregateNetworkState([], { old: connected })).toBe('stopped');
    expect(aggregateNetworkState(['broken'], { broken: runtime({ error_msg: 'failed' }) })).toBe('failed');
  });
});
