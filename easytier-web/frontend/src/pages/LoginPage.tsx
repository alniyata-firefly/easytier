import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type ApiClient from '../lib/api';
import { Button, Field, Alert, BrandMark, LanguageSwitch, Panel } from '../components/ui';
import { errorMessage } from '../lib/hooks';

export function LoginPage({api,onLogin}: {api: ApiClient; onLogin: () => void}) {
  const {t}=useTranslation('app');
  const [username,setUsername]=useState(''),[password,setPassword]=useState(''),[captcha,setCaptcha]=useState('');
  const [register,setRegister]=useState(false),[registration,setRegistration]=useState(false),[oidc,setOidc]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState<'registration'|'login'>(),[failure,setFailure]=useState<unknown>(),[success,setSuccess]=useState(false),[stamp,setStamp]=useState(0);
  useEffect(() => {
    let active=true;
    Promise.allSettled([api.get_auth_config(),api.getOidcConfig()]).then(([auth,sso]) => {if (!active) return; if (auth.status==='fulfilled') setRegistration(auth.value.registration_enabled); if (sso.status==='fulfilled') setOidc(sso.value.enabled);});
    return () => {active=false;};
  },[api]);
  const submit=async (e: FormEvent) => {
    e.preventDefault(); if (busy) return;
    setBusy(true); setError(undefined); setFailure(undefined); setSuccess(false);
    try {
      if (register) {
        const result=await api.register({credentials:{username:username.trim(),password},captcha});
        if (!result.success) {setError('registration');setStamp(Date.now());return;}
        setRegister(false);setPassword('');setCaptcha('');setSuccess(true);
      } else {
        const result=await api.login({username:username.trim(),password});
        if (!result.success) {setError('login');return;}
        setPassword('');onLogin();
      }
    } catch (error) {setFailure(error);}
    finally {setBusy(false);}
  };
  return <main className="login-layout"><header className="login-header"><div className="login-brand"><span className="brand-mark"><BrandMark size={22}/></span><strong>EasyTier</strong></div><LanguageSwitch/></header><Panel className="login-panel"><h1>{t(register?'auth.register':'auth.title')}</h1><form className="form-stack" onSubmit={submit}>{error||failure?<Alert tone="error">{error?t(`auth.errors.${error}`):errorMessage(failure)}</Alert>:null}{success?<Alert tone="success">{t('auth.created')}</Alert>:null}<Field label={t('auth.username')}><input id="username" autoComplete="username" required maxLength={64} value={username} onChange={e=>setUsername(e.target.value)} disabled={busy}/></Field><Field label={t('auth.password')}><input id="password" type="password" autoComplete={register?'new-password':'current-password'} required value={password} onChange={e=>setPassword(e.target.value)} disabled={busy}/></Field>{register?<Field label={t('auth.captcha')}><div className="actions"><input aria-label={t('auth.captcha')} value={captcha} onChange={e=>setCaptcha(e.target.value)} required autoComplete="off" disabled={busy}/><button type="button" className="captcha-button" onClick={()=>setStamp(Date.now())} aria-label={t('auth.refreshCaptcha')} disabled={busy}><img src={`${api.captcha_url()}?r=${stamp}`} alt={t('auth.captcha')}/></button></div></Field>:null}<Button type="submit" busy={busy} className="full">{t(register?'auth.register':'auth.login')}</Button>{oidc&&!register?<a className="button ghost full" href={api.oidcLoginUrl()}>{t('auth.sso')}</a>:null}</form>{registration?<div className="login-extra"><Button tone="ghost" disabled={busy} onClick={()=>{setRegister(!register);setError(undefined);setFailure(undefined);setSuccess(false);setPassword('');}}>{t(register?'auth.backToLogin':'auth.register')}</Button></div>:null}<footer className="login-license"><a href="/fonts/font-notices.html" target="_blank" rel="noreferrer">{t('fontNotices')}</a></footer></Panel></main>;
}
