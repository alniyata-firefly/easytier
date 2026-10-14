import { ConfigFilePermission, type NetworkMeta } from '../../../frontend-lib/src/modules/api';

export type InstanceControl = {
  meta?: NetworkMeta & { instance_name?: string };
  centralName?: string;
};

export function normalizeInstanceMeta(value: NetworkMeta | undefined): InstanceControl['meta'] {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as NetworkMeta & { configPermission?: number; networkName?: string; instanceName?: string; instance_name?: string };
  const permission = raw.config_permission ?? raw.configPermission ?? 0;
  if (!Number.isInteger(permission) || permission < 0 || permission > 0xffffffff) return undefined;
  return { network_name: raw.network_name ?? raw.networkName ?? '', instance_name: raw.instance_name ?? raw.instanceName, config_permission: permission };
}

export function canEditInstance(row?: InstanceControl): boolean {
  return !!row?.meta && !row.centralName && ConfigFilePermission.isEditable(row.meta.config_permission ?? 0);
}

export function canDeleteInstance(row?: InstanceControl): boolean {
  return !!row?.meta && !row.centralName && ConfigFilePermission.isDeletable(row.meta.config_permission ?? 0);
}

export function canChangeInstanceState(row: InstanceControl | undefined, disabled: boolean): boolean {
  return disabled ? canDeleteInstance(row) : canEditInstance(row);
}
