import { cloneElement, createContext, isValidElement, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { isLanguage } from '../lib/i18n';
import brandMarkUrl from '../../../../assets/brand/easytier.svg?url';

export function LanguageSwitch({className=''}: {className?:string}) {
  const {t,i18n}=useTranslation('common');
  return <label className={`language-switcher ${className}`}><span className="sr-only">{t('language.label')}</span><select aria-label={t('language.label')} value={i18n.resolvedLanguage==='en'?'en':'zh-CN'} onChange={event=>{if(isLanguage(event.target.value))void i18n.changeLanguage(event.target.value);}}><option value="zh-CN">{t('language.zhCN')}</option><option value="en">{t('language.en')}</option></select></label>;
}

export function BrandMark({size = 24}: {size?: number}) {
  return <img src={brandMarkUrl} alt="" aria-hidden="true" width={size} height={size} draggable={false}/>;
}

export function Icon({name, size = 20}: {name: string; size?: number}) {
  const shapes: Record<string, ReactNode> = {
    network: <><circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="m6 8 5 8m7-8-5 8M7 6h10"/></>,
    dashboard: <><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></>,
    devices: <><rect x="3" y="4" width="18" height="12" rx="3"/><path d="M8 21h8m-4-5v5"/></>,
    key: <><circle cx="8" cy="9" r="5"/><path d="m12 13 8 8m-3-3 3-3m-6 0 3-3"/></>,
    activity: <path d="M2 12h4l3-8 6 16 3-8h4"/>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/></>,
    plus: <path d="M12 4v16M4 12h16"/>, add: <path d="M12 4v16M4 12h16"/>,
    close: <path d="m6 6 12 12M6 18 18 6"/>,
    check: <path d="m5 12 4 4L19 6"/>,
    edit: <><path d="m15 4 5 5-11 11H4v-5Z"/><path d="m13 6 5 5"/></>,
    trash: <><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/></>,
    delete: <><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/></>,
    copy: <><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 5V3H3v13h2"/></>,
    eye: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></>,
    menu: <path d="M4 6h16M4 12h16M4 18h16"/>,
    logout: <><path d="M9 4H4v16h5m5-16 7 8-7 8m-6-8h13"/></>,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/></>,
    arrow: <path d="m9 5 7 7-7 7"/>,
    up: <path d="M12 20V4m-6 6 6-6 6 6"/>,
    down: <path d="M12 4v16m-6-6 6 6 6-6"/>,
    server: <><rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6h.01M7 17h.01m4-11h6m-6 11h6"/></>,
    gateway: <><rect x="3" y="5" width="18" height="10" rx="2"/><path d="M7 9h.01M10 9h.01m4 0h3M12 15v4m-5 0h10"/></>,
    router: <><rect x="3" y="11" width="18" height="8" rx="2"/><path d="M6 11V5m12 6V5M7 15h.01M10 15h.01m4 0h3"/></>,
    pc: <><rect x="3" y="3" width="18" height="13" rx="1.5"/><path d="M12 16v4m-4 0h8"/></>,
    mobile: <><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M10 5h4m-2 14h.01"/></>,
    cloud: <path d="M6.5 19h11a4.5 4.5 0 0 0 .3-9 6 6 0 0 0-11.6-1.3A5.2 5.2 0 0 0 6.5 19Z"/>,
    switch: <><rect x="2" y="7" width="20" height="10" rx="1.5"/>{[5,9,13,17].map(x=><rect key={x} x={x} y="11" width="2" height="3" rx=".25"/>)}<path d="M5 9h.01m4 0h.01m4 0h.01m4 0h.01"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="m10 3-1 3-3 1-3-1-1 4 3 2v3l-2 3 4 2 2-2h3l3 2 3-3-1-3 1-3 3-1-1-4-3 1-3-1-1-3Z"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/></>,
    search: <><circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/></>,
    info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/></>,
    pause: <path d="M8 5v14m8-14v14"/>, play: <path d="m7 4 14 8-14 8Z"/>,
    download: <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{shapes[name] ?? shapes.network}</svg>;
}

export function Button({children, icon, busy, tone = 'primary', className = '', disabled, ...props}: ButtonHTMLAttributes<HTMLButtonElement> & {icon?: string; busy?: boolean; tone?: 'primary'|'danger'|'ghost'}) {
  const {t}=useTranslation('common');
  return <button type="button" {...props} disabled={disabled || busy} className={`button ${tone} ${icon&&!children?'icon-only':''} ${className}`} aria-busy={busy || undefined}>{icon ? <Icon name={icon}/> : null}{busy ? <span className={icon&&!children?'sr-only':undefined}>{t('busy')}</span> : children}</button>;
}
export function Panel({title, action, children, className = ''}: {title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string}) {
  return <section className={`panel ${className}`}>{title || action ? <header className="panel-heading">{title?<h2>{title}</h2>:null}{action?<div className="actions">{action}</div>:null}</header> : null}{children}</section>;
}
export function Field({label, error, children}: {label: string; error?: string; children: ReactNode}) {
  const id=useId();
  const input=isValidElement(children)&&typeof children.type==='string'&&['input','textarea','select'].includes(children.type);
  const child=children as ReactElement<Record<string,unknown>>;
  const controlId=input?(typeof child.props.id==='string'?child.props.id:id):undefined;
  const descriptions=[input?child.props['aria-describedby']:undefined,error?`${id}-error`:undefined].filter(Boolean).join(' ')||undefined;
  return <label className="field" htmlFor={controlId}><span className="field-label">{label}</span>{input?cloneElement(child,{id:controlId,'aria-label':child.props['aria-label']??label,'aria-describedby':descriptions,'aria-invalid':error?true:undefined}):children}{error ? <small id={`${id}-error`} className="field-error">{error}</small> : null}</label>;
}
export function Alert({children, tone = 'info'}: {children: ReactNode; tone?: 'info'|'error'|'success'|'warning'}) {
  return <div className={`alert ${tone}`} role={tone === 'error' ? 'alert' : 'status'}><Icon name={tone === 'success' ? 'check' : 'info'}/><div>{children}</div></div>;
}
export function Empty({title, action}: {title: string; action?: ReactNode}) {
  return <div className="empty"><span className="empty-symbol"><Icon name="network" size={32}/></span><h3>{title}</h3>{action}</div>;
}
export function Status({state, label}: {state: string; label?: string}) {
  const {t}=useTranslation('common');
  return <span className={`status ${state}`}><span aria-hidden="true" className="status-dot"/>{label ?? t(`status.${state}`,{defaultValue:state})}</span>;
}
export function Dialog({open, title, onClose, children, footer, wide = false}: {open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean}) {
  const {t}=useTranslation('common');
  const ref = useRef<HTMLDialogElement>(null), titleId = useId();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return <dialog ref={ref} aria-labelledby={titleId} className={`dialog ${wide ? 'wide' : ''}`} onCancel={e => {e.preventDefault(); onClose();}} onClick={e => {if (e.target === e.currentTarget) { const rect=e.currentTarget.getBoundingClientRect(); if (e.clientX<rect.left || e.clientX>rect.right || e.clientY<rect.top || e.clientY>rect.bottom) onClose(); }}}><header className="panel-heading"><h2 id={titleId}>{title}</h2><Button tone="ghost" icon="close" aria-label={t('closeDialog')} onClick={onClose}/></header><div className="dialog-body">{children}</div>{footer ? <footer className="dialog-footer">{footer}</footer> : null}</dialog>;
}
export function Tabs({items, value, onChange}: {items: Array<{id: string; label: string; count?: number}>; value: string; onChange: (id: string) => void}) {
  const {t}=useTranslation('common');
  return <div className="tabs" role="tablist" aria-label={t('detailTabs')}>{items.map((item,index) => <button key={item.id} role="tab" type="button" aria-selected={value === item.id} tabIndex={value === item.id ? 0 : -1} className={value === item.id ? 'selected' : ''} onClick={() => onChange(item.id)} onKeyDown={e => {if (!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return; e.preventDefault(); const target=e.key==='Home'?0:e.key==='End'?items.length-1:(index+(e.key==='ArrowRight'?1:-1)+items.length)%items.length; onChange(items[target].id); (e.currentTarget.parentElement?.children[target] as HTMLElement)?.focus();}}>{item.label}{item.count !== undefined ? <span className="tab-count">{item.count}</span> : null}</button>)}</div>;
}
export type NoticeMessage = string | {key:string;ns?:string;values?:Record<string,unknown>};
type NoticeFn = (message: NoticeMessage, tone?: 'success'|'error'|'info') => void;
const NoticeContext = createContext<NoticeFn>(() => {});
export const useNotice = () => useContext(NoticeContext);
export function NoticeProvider({children}: {children: ReactNode}) {
  const {t}=useTranslation('common');
  const [notices,setNotices] = useState<Array<{id: number; message: NoticeMessage; tone: 'success'|'error'|'info'}>>([]);
  const ids = useRef(0), timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const notify: NoticeFn = useCallback((message,tone='success') => {const id=++ids.current; setNotices(old => [...old.slice(-2),{id,message,tone}]); const timer=setTimeout(() => {setNotices(old => old.filter(n => n.id!==id));timers.current=timers.current.filter(handle=>handle!==timer);},6000); timers.current.push(timer);},[]);
  return <NoticeContext.Provider value={notify}>{children}<div className="notices" aria-live="polite">{notices.map(n => <div className={`notice ${n.tone}`} key={n.id}><Icon name={n.tone==='success'?'check':'info'}/><span>{typeof n.message==='string'?n.message:t(n.message.key,{...n.message.values,ns:n.message.ns??'common'})}</span><button type="button" aria-label={t('closeNotice')} onClick={() => setNotices(old => old.filter(row => row.id!==n.id))}><Icon name="close" size={16}/></button></div>)}</div></NoticeContext.Provider>;
}
