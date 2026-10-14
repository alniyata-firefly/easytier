import { useTranslation } from 'react-i18next';
import { currentLocale } from '../lib/i18n';
import { RuntimeDisplay } from '../lib/shared';

const byteUnits = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];
export function useMetricFormat() {
    const { t } = useTranslation('metrics');
    const number = (value: number, digits = 2, fixed = false) => new Intl.NumberFormat(currentLocale(), { maximumFractionDigits: digits, minimumFractionDigits: fixed ? digits : 0 }).format(value);
    const quantity = (value: unknown, bytes = false) => {
        const count = RuntimeDisplay.counter(value);
        if (count === undefined) return '—';
        if (!bytes) return count.toLocaleString(currentLocale());
        let scale = 1n, index = 0;
        while (count >= scale * 1024n && index < byteUnits.length - 1) { scale *= 1024n; index++; }
        return t('units.quantity', { value: number(Number(count * 100n / scale) / 100), unit: t(`units.${byteUnits[index]}`) });
    };
    const percent = (value: number | undefined, digits = 1) => value === undefined || !Number.isFinite(value) ? '—' : t('units.percent', { value: number(value, digits, true) });
    const milliseconds = (value: number | undefined) => value === undefined || !Number.isFinite(value) ? '—' : t('units.milliseconds', { value: number(value) });
    const history = (value: number | null | undefined, unit: string) => {
        if (value == null || !Number.isFinite(value) || value < 0) return '—';
        if (unit === 'percent') return percent(value, 2);
        if (unit === 'bytes' || unit === 'bytes_per_second') {
            let amount = value, index = 0;
            while (amount >= 1024 && index < byteUnits.length - 1) { amount /= 1024; index++; }
            const formatted = t('units.quantity', { value: number(amount), unit: t(`units.${byteUnits[index]}`) });
            return unit === 'bytes_per_second' ? t('units.perSecond', { value: formatted }) : formatted;
        }
        return unit.endsWith('_per_second') ? t('units.perSecond', { value: number(value) }) : number(value);
    };
    return { quantity, percent, milliseconds, history, number };
}
