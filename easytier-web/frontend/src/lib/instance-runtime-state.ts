import type { NetworkInstanceRunningInfo } from '../../../frontend-lib/src/types/network';

export type InstanceRuntimeState = 'running' | 'stopped' | 'failed' | 'unknown';

export function instanceRuntimeState(info: NetworkInstanceRunningInfo | undefined, unavailable = false): InstanceRuntimeState {
  if (unavailable || !info) return 'unknown';
  if (info.error_msg?.trim()) return 'failed';
  if (info.running === true) return 'running';
  if (info.running === false) return 'stopped';
  return 'unknown';
}
