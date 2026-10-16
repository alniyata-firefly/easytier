import { describe, expect, it } from 'vitest';
import type { ManagementConnectionState, SessionSnapshot } from '../../native/types';
import { managementStatus } from './management-status';

const snapshot: SessionSnapshot = {
  platform: 'android', version: 'fixture', mode: { mode: 'normal', config_server_url: 'udp://example.invalid:22020/fixture' },
  connected: true, managementConnected: false, managementState: 'connecting', clientPaused: false,
  serviceStatus: 'NotInstalled', busy: false, revision: 0,
};

describe('management connection labels', () => {
  it.each<ManagementConnectionState>(['connecting', 'authenticating', 'pending_approval', 'rejected', 'unknown', 'disconnected'])('does not label %s as authorized when local Core is running', managementState => {
    const result = managementStatus({ ...snapshot, managementState });
    expect(result.label).not.toBe('managementAuthorized');
    expect(result.state).not.toBe('online');
  });
  it('shows approval and authentication rejection as different conditions', () => {
    expect(managementStatus({ ...snapshot, managementState: 'pending_approval' })).toEqual({ state: 'pending', label: 'managementPendingApproval' });
    expect(managementStatus({ ...snapshot, managementState: 'rejected' })).toEqual({ state: 'failed', label: 'managementRejected' });
  });
  it('clears the authorized label when the local client is paused or disconnected', () => {
    expect(managementStatus({ ...snapshot, managementState: 'authorized' })).toEqual({ state: 'online', label: 'managementAuthorized' });
    expect(managementStatus({ ...snapshot, managementState: 'authorized', clientPaused: true })).toEqual({ state: 'stopped', label: 'clientPaused' });
    expect(managementStatus({ ...snapshot, managementState: 'authorized', connected: false })).toEqual({ state: 'offline', label: 'disconnected' });
  });
});
