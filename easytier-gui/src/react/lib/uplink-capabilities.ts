import { supportsUplinkSelectionForOs } from '../../../../easytier-web/frontend-lib/src/modules/uplinkCapabilities';

export { normalizeUplinkForTarget } from '../../../../easytier-web/frontend-lib/src/modules/uplinkCapabilities';

export function supportsUplinkSelectionForTarget(platform: string, mode: { mode: string }): boolean {
    return mode.mode === 'remote' || supportsUplinkSelectionForOs(platform);
}
