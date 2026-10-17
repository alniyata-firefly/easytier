import { useTranslation } from 'react-i18next';
import { managementConnectionState } from '../lib/management-status';
import { Status } from './ui';

export function ManagementStatus({ online, unknown = false }: { online?: boolean; unknown?: boolean }) {
    const { t } = useTranslation('common');
    const state = managementConnectionState(online, unknown);
    return <Status state={state} label={t(`managementStatus.${state}`)} />;
}
