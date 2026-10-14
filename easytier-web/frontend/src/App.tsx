import { Component, lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import ApiClient, {type ConsoleInfo} from './lib/api';
import {getApiBase} from './lib/api-host';
import {navigate, useRoute} from './lib/router';
import {errorDescriptor,errorMessage} from './lib/hooks';
import i18n from './lib/i18n';
import {Alert,Button,Dialog,Field,Icon,LanguageSwitch,NoticeProvider,useNotice} from './components/ui';

const LoginPage=lazy(()=>import('./pages/LoginPage').then(module=>({default:module.LoginPage})));
const OverviewPage=lazy(()=>import('./pages/OverviewPage').then(module=>({default:module.OverviewPage})));
const DevicesPage=lazy(()=>import('./pages/DevicesPage').then(module=>({default:module.DevicesPage})));
const DevicePage=lazy(()=>import('./pages/DevicePage').then(module=>({default:module.DevicePage})));
const TokensPage=lazy(()=>import('./pages/TokensPage').then(module=>({default:module.TokensPage})));
const NetworksPage=lazy(()=>import('./pages/NetworksPage').then(module=>({default:module.NetworksPage})));
const NetworkPage=lazy(()=>import('./pages/NetworkPage').then(module=>({default:module.NetworkPage})));

class PageBoundary extends Component<{children:ReactNode}, {failed:boolean}> {
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  render(){return this.state.failed?<div className="stack"><Alert tone="error">{i18n.t('app:page.failed')}</Alert><Button onClick={()=>window.location.reload()}>{i18n.t('app:page.reload')}</Button></div>:this.props.children;}
}
function PasswordDialog({api,open,onClose}: {api:ApiClient;open:boolean;onClose:()=>void}) {
  const {t}=useTranslation('app');
  const [password,setPassword]=useState(''),[confirm,setConfirm]=useState(''),[busy,setBusy]=useState(false),[mismatch,setMismatch]=useState(false),[failure,setFailure]=useState<unknown>(),notice=useNotice();
  useEffect(()=>{if(!open){setPassword('');setConfirm('');setMismatch(false);setFailure(undefined);}},[open]);
  const save=async(e:FormEvent)=>{e.preventDefault();if(busy)return;setFailure(undefined);if(password!==confirm){setMismatch(true);return;}setBusy(true);setMismatch(false);try{await api.change_password(password);setPassword('');setConfirm('');onClose();notice({key:'password.changed',ns:'app'});}catch(error){setFailure(error);}finally{setBusy(false);}};
  return <Dialog open={open} title={t('password.title')} onClose={()=>{if(!busy)onClose();}}><form className="form-stack" onSubmit={save}>{mismatch||failure?<Alert tone="error">{mismatch?t('password.mismatch'):errorMessage(failure)}</Alert>:null}<Field label={t('password.new')}><input type="password" autoComplete="new-password" required minLength={8} value={password} onChange={e=>setPassword(e.target.value)} disabled={busy}/></Field><Field label={t('password.confirm')}><input type="password" autoComplete="new-password" required value={confirm} onChange={e=>setConfirm(e.target.value)} disabled={busy}/></Field><div className="actions end"><Button tone="ghost" disabled={busy} onClick={onClose}>{t('common:cancel')}</Button><Button type="submit" busy={busy}>{t('password.title')}</Button></div></form></Dialog>;
}
type NavigationEntry = {id:string;path:string;label:string;icon:string};
function PrimaryNavigation({active,entries,onNavigate}: {active:string;entries:NavigationEntry[];onNavigate?:()=>void}) {
  const {t}=useTranslation('app');
  return <><nav className="navigation-items" aria-label={t('nav.primary')}>{entries.map(item=><a key={item.id} href={`#${item.path}`} className={`navigation-link ${active===item.id?'selected':''}`} aria-current={active===item.id?'page':undefined} onClick={onNavigate}><Icon name={item.icon} size={20}/><span>{item.label}</span></a>)}</nav><footer className="navigation-footer"><a href="/fonts/font-notices.html" target="_blank" rel="noreferrer">{t('fontNotices')}</a></footer></>;
}
function Console() {
  const {t}=useTranslation('app');
  const route=useRoute(),[info,setInfo]=useState<ConsoleInfo>(),[checking,setChecking]=useState(true),[connectionError,setConnectionError]=useState<unknown>(),[loginRevision,setLoginRevision]=useState(0);
  const [navOpen,setNavOpen]=useState(false),[passwordOpen,setPasswordOpen]=useState(false),[loggingOut,setLoggingOut]=useState(false),notice=useNotice();
  const [mobile,setMobile]=useState(()=>window.matchMedia('(max-width: 760px)').matches),navToggle=useRef<HTMLButtonElement>(null);
  const api=useMemo(()=>new ApiClient(getApiBase(),()=>window.dispatchEvent(new Event('easytier-auth-invalid'))),[]);
  useEffect(()=>{let active=true;setChecking(true);setConnectionError(undefined);api.get_console_info().then(value=>{if(!active)return;setInfo(value);if(route.startsWith('/auth'))navigate('/h');}).catch(error=>{if(!active)return;if(error?.response?.status===401){setInfo(undefined);navigate('/auth');}else setConnectionError(error);}).finally(()=>{if(active)setChecking(false);});return()=>{active=false;};},[api,loginRevision]);
  useEffect(()=>{const invalid=()=>{api.clear_snapshots();setInfo(undefined);setPasswordOpen(false);navigate('/auth');};window.addEventListener('easytier-auth-invalid',invalid);return()=>window.removeEventListener('easytier-auth-invalid',invalid);},[api]);
  useEffect(()=>setNavOpen(false),[route]);
  useEffect(()=>{const query=window.matchMedia('(max-width: 760px)');const update=()=>setMobile(query.matches);query.addEventListener('change',update);return()=>query.removeEventListener('change',update);},[]);
  useEffect(()=>{if(!navOpen)return;const close=(event:KeyboardEvent)=>{if(event.key==='Escape'){setNavOpen(false);navToggle.current?.focus();}};window.addEventListener('keydown',close);return()=>window.removeEventListener('keydown',close);},[navOpen]);
  if(checking)return <main className="login-layout"><div className="loading" role="status">{t('connection.checking')}</div></main>;
  if(connectionError)return <main className="login-layout"><div className="stack"><Alert tone="error">{errorMessage(connectionError)}</Alert><Button onClick={()=>setLoginRevision(v=>v+1)}>{t('connection.retry')}</Button></div></main>;
  if(!info)return <PageBoundary><Suspense fallback={<main className="login-layout"><div className="loading" role="status">{t('page.loading')}</div></main>}><LoginPage api={api} onLogin={()=>setLoginRevision(v=>v+1)}/></Suspense></PageBoundary>;
  const entries=[{id:'overview',path:'/h',label:t('nav.overview'),icon:'dashboard'},{id:'networks',path:'/h/networks',label:t('nav.networks'),icon:'network'},{id:'devices',path:'/h/deviceList',label:t('nav.devices'),icon:'devices'},{id:'tokens',path:'/h/tokens',label:t('nav.tokens'),icon:'key'}].filter(item=>!info.webhook_auth||!['networks','tokens'].includes(item.id));
  const requestedActive=route.startsWith('/h/networks')?'networks':route.startsWith('/h/deviceList')?'devices':route.startsWith('/h/tokens')?'tokens':'overview';
  const active=entries.some(item=>item.id===requestedActive)?requestedActive:'overview';
  const parts=route.split('/').filter(Boolean);
  let page:ReactNode=<OverviewPage api={api} consoleInfo={info}/>;
  const title=entries.find(entry=>entry.id===active)?.label??t('nav.overview');
  try {
    if(active==='networks'&&!info.webhook_auth){page=parts[2]?<NetworkPage api={api} networkId={decodeURIComponent(parts[2])} consoleInfo={info}/>:<NetworksPage api={api} consoleInfo={info}/>;}
    if(active==='devices'){page=parts[2]==='device'&&parts[3]?<DevicePage api={api} deviceId={decodeURIComponent(parts[3])} instanceId={parts[4]?decodeURIComponent(parts[4]):undefined}/>:<DevicesPage api={api}/>;}
    if(active==='tokens'&&!info.webhook_auth){page=<TokensPage api={api} consoleInfo={info}/>;}
  } catch {page=<Alert tone="error">{t('page.invalidLink')}</Alert>;}
  const logout=async()=>{if(loggingOut)return;setLoggingOut(true);try{await api.logout();}catch(failure){notice(errorDescriptor(failure),'error');}finally{setLoggingOut(false);}};
  const closeNavigation=()=>{setNavOpen(false);navToggle.current?.focus();};
  return <div className={`shell ${navOpen?'nav-open':''}`}>
    <a className="skip-link" href="#console-workspace" onClick={event=>{event.preventDefault();document.getElementById('console-workspace')?.focus();}}>{t('nav.skip')}</a>
    <header className="global-topbar">
      <button ref={navToggle} className="button ghost mobile-nav-toggle icon-only" type="button" aria-label={t(navOpen?'nav.close':'nav.open')} aria-expanded={navOpen} aria-controls="console-navigation" onClick={()=>setNavOpen(value=>!value)}><Icon name="menu"/></button>
      <div className="topbar-brand"><span className="brand-mark"><Icon name="network" size={21}/></span><span>EasyTier</span></div>
      <div className="topbar-scope"><span>{t(info.webhook_auth?'scope.external':'scope.central')}</span><Icon name="arrow" size={12}/><strong>{title}</strong></div>
      <div className="topbar-account"><LanguageSwitch/><span className="account-name" title={info.username}><span className="avatar" aria-hidden="true">{info.username.slice(0,1).toUpperCase()}</span><span className="account-username">{info.username}</span></span><div className="account-controls"><Button icon="settings" tone="ghost" aria-label={t('password.title')} title={t('password.title')} onClick={()=>setPasswordOpen(true)}/><Button icon="logout" tone="ghost" busy={loggingOut} aria-label={t('auth.logout')} title={t('auth.logout')} onClick={logout}/></div></div>
    </header>
    {!mobile?<aside className="primary-navigation" id="console-navigation"><PrimaryNavigation entries={entries} active={active}/></aside>:null}
    <main className="workspace" id="console-workspace" tabIndex={-1}><div className="workspace-breadcrumb"><span>{t('console')}</span><Icon name="arrow" size={12}/><span>{title}</span>{parts[2]&&active==='networks'?<><Icon name="arrow" size={12}/><span>{t('nav.networkDetail')}</span></>:parts[2]==='device'&&active==='devices'?<><Icon name="arrow" size={12}/><span>{t('nav.deviceDetail')}</span></>:null}</div><PageBoundary key={`${info.username}:${route}`}><Suspense fallback={<div className="loading" role="status">{t('page.loading')}</div>}>{page}</Suspense></PageBoundary></main>
    {mobile?<Dialog open={navOpen} title={t('nav.title')} onClose={closeNavigation}><div id="console-navigation" className="mobile-navigation"><PrimaryNavigation entries={entries} active={active} onNavigate={()=>setNavOpen(false)}/></div></Dialog>:null}
    <PasswordDialog api={api} open={passwordOpen} onClose={()=>setPasswordOpen(false)}/>
  </div>;
}
export default function App(){return <NoticeProvider><Console/></NoticeProvider>;}
