import { useTranslation } from 'react-i18next';
import { Field } from './ui';

export function CustomLifetimeFields({ value, maxDays, disabled, onValueChange }: {
    value: string; maxDays: number; disabled: boolean; onValueChange: (value: string) => void;
}) {
    const { t } = useTranslation('common');
    return <Field label={t('duration.days')}><input aria-label={t('duration.days')} type="number" inputMode="numeric" min={1} max={maxDays} step={1} required value={value} onChange={event => onValueChange(event.target.value)} disabled={disabled} /></Field>;
}
