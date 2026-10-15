import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon, LanguageSwitch } from './ui';

export function AccountMenu({ initial, onPassword, onLogout, busy = false }: {
  initial: string; onPassword: () => void; onLogout: () => void; busy?: boolean;
}) {
  const { t } = useTranslation('app');
  const [open, setOpen] = useState(false), root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), first = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    first.current?.focus();
    const outside = (event: PointerEvent | FocusEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('focusin', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  return <div className="account-menu" ref={root}>
    <button ref={trigger} type="button" className="account-trigger button ghost" aria-label={t('account.title')} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)}><span className="avatar" aria-hidden="true">{initial}</span></button>
    {open && <section className="account-popover" id={id} role="dialog" aria-label={t('account.title')}>
      <button ref={first} type="button" className="account-menu-item" onClick={() => { setOpen(false); onPassword(); }}><Icon name="settings" size={17}/><span>{t('password.title')}</span></button>
      <div className="account-language"><span>{t('account.language')}</span><LanguageSwitch/></div>
      <a className="account-menu-item" href="/fonts/font-notices.html" target="_blank" rel="noreferrer" onClick={() => setOpen(false)}><Icon name="info" size={17}/><span>{t('fontNotices')}</span></a>
      <div className="account-menu-divider"/>
      <button type="button" className="account-menu-item" disabled={busy} onClick={() => { setOpen(false); onLogout(); }}><Icon name="logout" size={17}/><span>{t('auth.logout')}</span></button>
    </section>}
  </div>;
}
