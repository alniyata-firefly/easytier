import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AccountMenu } from './components/AccountMenu';
import { GlobalSearch } from './components/GlobalSearch';
import ApiClient, {type ConsoleInfo} from './lib/api';
import {getApiBase} from './lib/api-host';
import {navigate, useRoute} from './lib/router';
import {errorDescriptor,errorMessage} from './lib/hooks';
import i18n from './lib/i18n';
import {Alert,Button,Dialog,Field,Icon,BrandMark,NoticeProvider,useNotice} from './components/ui';

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
const decodedPart=(value:string)=>{try{return decodeURIComponent(value);}catch{return value;}};
type NavigationEntry = {id:string;path:string;label:string;icon:string};
function PrimaryNavigation({active,entries,onNavigate,account}: {active:string;entries:NavigationEntry[];onNavigate?:()=>void;account:ReactNode}) {
  const {t}=useTranslation('app');
  return <><nav className="navigation-items" aria-label={t('nav.primary')}>{entries.map(item=><a key={item.id} href={`#${item.path}`} className={`navigation-link ${active===item.id?'selected':''}`} aria-current={active===item.id?'page':undefined} onClick={onNavigate}><Icon name={item.icon} size={20}/><span>{item.label}</span></a>)}</nav><footer className="navigation-footer">{account}</footer></>;
}
function Console() {
  const {t}=useTranslation('app');
  const location=useRoute(), route=location.split('?')[0];
  const [detailTitle,setDetailTitle]=useState({path:'',label:'',instance:''});
  const updateDetailTitle=useCallback((label:string,instance='')=>setDetailTitle({path:route,label,instance}),[route]);
  const [info,setInfo]=useState<ConsoleInfo>(),[checking,setChecking]=useState(true),[connectionError,setConnectionError]=useState<unknown>(),[loginRevision,setLoginRevision]=useState(0);
  const [navOpen,setNavOpen]=useState(false),[passwordOpen,setPasswordOpen]=useState(false),[loggingOut,setLoggingOut]=useState(false),notice=useNotice();
  const [mobile,setMobile]=useState(()=>window.matchMedia('(max-width: 760px)').matches),navToggle=useRef<HTMLButtonElement>(null);
  const api=useMemo(()=>new ApiClient(getApiBase(),()=>window.dispatchEvent(new Event('easytier-auth-invalid'))),[]);
  useEffect(()=>{let active=true;setChecking(true);setConnectionError(undefined);api.get_console_info().then(value=>{if(!active)return;setInfo(value);if(route.startsWith('/auth'))navigate('/h');}).catch(error=>{if(!active)return;if(error?.response?.status===401){setInfo(undefined);navigate('/auth');}else setConnectionError(error);}).finally(()=>{if(active)setChecking(false);});return()=>{active=false;};},[api,loginRevision]);
  useEffect(()=>{const invalid=()=>{api.clear_snapshots();setInfo(undefined);setPasswordOpen(false);navigate('/auth');};window.addEventListener('easytier-auth-invalid',invalid);return()=>window.removeEventListener('easytier-auth-invalid',invalid);},[api]);
  useEffect(()=>setNavOpen(false),[route]);
  useEffect(()=>{const query=window.matchMedia('(max-width: 760px)');const update=()=>setMobile(query.matches);query.addEventListener('change',update);return()=>query.removeEventListener('change',update);},[]);
  useEffect(()=>{if(!navOpen)return;const close=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!event.defaultPrevented){setNavOpen(false);navToggle.current?.focus();}};window.addEventListener('keydown',close);return()=>window.removeEventListener('keydown',close);},[navOpen]);
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
    if(active==='networks'&&!info.webhook_auth){page=parts[2]?<NetworkPage api={api} networkId={decodeURIComponent(parts[2])} consoleInfo={info} onTitleChange={updateDetailTitle}/>:<NetworksPage api={api} consoleInfo={info}/>;}
    if(active==='devices'){page=parts[2]==='device'&&parts[3]?<DevicePage api={api} deviceId={decodeURIComponent(parts[3])} instanceId={parts[4]?decodeURIComponent(parts[4]):undefined} onTitleChange={updateDetailTitle}/>:<DevicesPage api={api}/>;}
    if(active==='tokens'&&!info.webhook_auth){page=<TokensPage api={api} consoleInfo={info}/>;}
  } catch {page=<Alert tone="error">{t('page.invalidLink')}</Alert>;}
  const logout=async()=>{if(loggingOut)return;setLoggingOut(true);try{await api.logout();}catch(failure){notice(errorDescriptor(failure),'error');}finally{setLoggingOut(false);}};
  const closeNavigation=()=>{setNavOpen(false);navToggle.current?.focus();};
  const account=<AccountMenu initial={info.username.slice(0,1).toUpperCase()} onPassword={()=>{setNavOpen(false);setPasswordOpen(true);}} onLogout={logout} busy={loggingOut}/>;
  const detail=detailTitle.path===route?detailTitle:undefined;
  const detailPath=active==='networks'&&parts[2]?`/h/networks/${encodeURIComponent(decodedPart(parts[2]))}`:active==='devices'&&parts[3]?`/h/deviceList/device/${encodeURIComponent(decodedPart(parts[3]))}`:undefined;
  return <div className={`shell ${navOpen?'nav-open':''}`}>
    <a className="skip-link" href="#console-workspace" onClick={event=>{event.preventDefault();document.getElementById('console-workspace')?.focus();}}>{t('nav.skip')}</a>
    <header className="global-topbar">
      <button ref={navToggle} className="button ghost mobile-nav-toggle icon-only" type="button" aria-label={t(navOpen?'nav.close':'nav.open')} aria-expanded={navOpen} aria-controls="console-navigation" onClick={()=>setNavOpen(value=>!value)}><Icon name="menu"/></button>
      <div className="topbar-brand"><span className="brand-mark"><BrandMark size={21}/></span><span>EasyTier</span></div>
      <nav className="topbar-breadcrumb" aria-label={t('nav.breadcrumb')}><ol>
        <li>{active==='overview'?<span aria-current="page">{title}</span>:<a href={`#${entries.find(entry=>entry.id===active)?.path}`} aria-current={!detailPath?'page':undefined}>{title}</a>}</li>
        {detailPath&&<li><Icon name="arrow" size={12}/><a href={`#${detailPath}`} aria-current={!parts[4]?'page':undefined}>{detail?.label||t(active==='networks'?'nav.networkDetail':'nav.deviceDetail')}</a></li>}
        {active==='devices'&&parts[4]&&<li><Icon name="arrow" size={12}/><span aria-current="page">{detail?.instance||decodedPart(parts[4])}</span></li>}
      </ol></nav>
      <GlobalSearch api={api} external={info.webhook_auth} route={location}/>

    </header>
    {!mobile?<aside className="primary-navigation" id="console-navigation"><PrimaryNavigation entries={entries} active={active} account={account}/></aside>:null}
    <main className="workspace" id="console-workspace" tabIndex={-1}><PageBoundary key={`${info.username}:${location}`}><Suspense fallback={<div className="loading" role="status">{t('page.loading')}</div>}>{page}</Suspense></PageBoundary></main>
    {mobile?<Dialog open={navOpen} title={t('nav.title')} onClose={closeNavigation}><div id="console-navigation" className="mobile-navigation"><PrimaryNavigation entries={entries} active={active} account={account} onNavigate={()=>setNavOpen(false)}/></div></Dialog>:null}
    <PasswordDialog api={api} open={passwordOpen} onClose={()=>setPasswordOpen(false)}/>
  </div>;
}
export default function App(){return <NoticeProvider><Console/></NoticeProvider>;}
