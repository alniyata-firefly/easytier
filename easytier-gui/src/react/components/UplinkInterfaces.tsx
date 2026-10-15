import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
    buildUplinkOptions, inventoryFailure, toggleUplinkSelection, UplinkInventoryError,
    type TargetUplinkInventory, type UplinkInventoryFailure, type UplinkInventoryLoader,
} from '../../../../easytier-web/frontend-lib/src/modules/uplinkInventory';
import { Button, Icon } from './ui';

export function UplinkInterfaces({ value, onChange, load, busy = false, error }: {
    value: string[]; onChange: (names: string[]) => void; load?: UplinkInventoryLoader; busy?: boolean; error?: string;
}) {
    const { t } = useTranslation('node-config');
    const id = useId(), root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
    const request = useRef(0);
    const [open, setOpen] = useState(false), [loading, setLoading] = useState(false);
    const [inventory, setInventory] = useState<TargetUplinkInventory>();
    const [fresh, setFresh] = useState(false), [failure, setFailure] = useState<UplinkInventoryFailure>();
    const refresh = useCallback(async () => {
        const current = ++request.current;
        setLoading(true); setFresh(false); setFailure(undefined);
        try {
            if (!load) throw new UplinkInventoryError('unsupported');
            const next = await load();
            if (request.current === current) { setInventory(next); setFresh(true); }
        } catch (error) { if (request.current === current) setFailure(inventoryFailure(error)); }
        finally { if (request.current === current) setLoading(false); }
    }, [load]);
    useEffect(() => {
        setInventory(undefined); setFresh(false);
        void refresh();
        return () => { request.current++; };
    }, [refresh]);
    useEffect(() => {
        if (!open) return;
        const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
        const keyboard = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus();
        };
        document.addEventListener('pointerdown', outside);
        document.addEventListener('keydown', keyboard);
        return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', keyboard); };
    }, [open]);
    const options = buildUplinkOptions(inventory, value, fresh);
    const label = t('fields.uplink_interfaces');
    return <div className="field uplink-picker" ref={root}>
        <span className="field-label" id={`${id}-label`}>{label}</span>
        <button ref={trigger} type="button" className="uplink-picker-trigger" aria-labelledby={`${id}-label ${id}-selection`}
            aria-haspopup="dialog" aria-expanded={open} aria-controls={`${id}-options`} disabled={busy}
            onClick={() => setOpen(current => !current)} onKeyDown={event => {
                if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); }
            }}>
            <span id={`${id}-selection`}>{value.length ? value.join(', ') : t('uplink.choose')}</span><Icon name="arrow" size={16}/>
        </button>
        {open && <div id={`${id}-options`} role="dialog" aria-label={label} className="uplink-picker-popover">
            <div className="uplink-picker-toolbar">
                <span role="status">{loading ? t('uplink.loading') : failure ? t(`uplink.${failure}`) : t('uplink.count', { count: options.length })}</span>
                <Button type="button" tone="ghost" icon="refresh" aria-label={t('uplink.refresh')} disabled={loading || busy} onClick={() => void refresh()}/>
            </div>
            <div className="uplink-picker-options">
                {!loading && !failure && !options.length && <p className="uplink-picker-empty">{t('uplink.empty')}</p>}
                {options.map(option => <label key={option.name} className="uplink-picker-option">
                    <input type="checkbox" aria-label={option.name} checked={option.selected}
                        disabled={busy || (!option.selected && (!fresh || !option.selectable))}
                        onChange={event => onChange(toggleUplinkSelection(value, option.name, event.target.checked))}/>
                    <span className="uplink-picker-info">
                        <span className="uplink-picker-name"><span>{option.name}</span><span className="uplink-picker-state">
                            {option.availability === 'missing' ? t('uplink.missing') : option.stale ? t('uplink.unverified')
                                : !option.selectable ? t('uplink.unavailable') : option.up === false ? t('uplink.down') : ''}
                        </span></span>
                        {option.addresses.length > 0 && <span className="uplink-picker-addresses mono">{option.addresses.join(' · ')}</span>}
                        {option.source === 'inventory' && option.kind && <span className="uplink-picker-kind">{t(`uplink.kinds.${option.kind}`, { defaultValue: option.kind })}</span>}
                    </span>
                </label>)}
            </div>
        </div>}
        {!open && (loading || failure) && <span role="status" className="uplink-picker-status">{loading ? t('uplink.loading') : t(`uplink.${failure}`)}</span>}
        {error && <span role="alert" className="field-error">{error}</span>}
    </div>;
}
