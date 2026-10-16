import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { version as guiVersion } from '../../../package.json';
import { type NativeSession, buildConfigServerUrl, splitConfigServerUrl, getServiceDefaults, nativeApi, copyText, getLogDirPath, openLogDirectory, exitApplication, type Mode, type SessionSnapshot } from '../../native/bridge';
import { Alert, Button, Dialog, Field, Panel, Status, useNotice } from './ui';
import { managementStatus } from '../lib/management-status';

const levels = ['off', 'warn', 'info', 'debug', 'trace'] as const;
export function SettingsPanel({ session, snapshot }: { session: NativeSession; snapshot: SessionSnapshot }) {
  const { t, i18n } = useTranslation('client'), notice = useNotice();
  const [modeOpen, setModeOpen] = useState(false), [managementOpen, setManagementOpen] = useState(false), [aboutOpen, setAboutOpen] = useState(false);
  const [draft, setDraft] = useState<Mode>(() => structuredClone(snapshot.mode)), [address, setAddress] = useState(''), [token, setToken] = useState('');
  const [managementError, setManagementError] = useState(''), [pending, setPending] = useState<'stop' | 'uninstall' | 'management'>();
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('easytier.client.theme') || 'system'; } catch { return 'system'; } });
  const [logLevel, setLogLevel] = useState('off');
  const [modePreparing, setModePreparing] = useState(false);
  const [managementDeviceId, setManagementDeviceId] = useState<string>(), [deviceIdFailed, setDeviceIdFailed] = useState(false);
  const showManagementDeviceId = snapshot.mode.mode === 'normal' && !!snapshot.mode.config_server_url;
  const connectionStatus = managementStatus(snapshot);
  useEffect(() => {
    let active = true;
    setManagementDeviceId(undefined); setDeviceIdFailed(false);
    if (showManagementDeviceId) void nativeApi.getManagementDeviceId()
      .then(value => { if (active) setManagementDeviceId(value); })
      .catch(() => { if (active) setDeviceIdFailed(true); });
    return () => { active = false; };
  }, [showManagementDeviceId]);
  useEffect(() => { const media = matchMedia('(prefers-color-scheme: dark)'); const update = () => { document.documentElement.dataset.theme = theme === 'system' ? media.matches ? 'dark' : 'light' : theme; }; update(); media.addEventListener('change', update); try { localStorage.setItem('easytier.client.theme', theme); } catch {} return () => media.removeEventListener('change', update); }, [theme]);
  const operation = async (task: () => Promise<unknown>, done?: () => void) => { try { await task(); done?.(); notice(t('saved')); } catch { notice(t('nativeError'), 'error'); } };
  const closeManagement = () => { setManagementOpen(false); setAddress(''); setToken(''); setManagementError(''); setPending(undefined); };
  const openManagement = () => { const saved = splitConfigServerUrl(snapshot.mode.config_server_url); setAddress(saved.address); setToken(saved.token); setManagementError(saved.legacy || snapshot.mode.config_server_needs_credentials ? 'legacyCredentials' : ''); setManagementOpen(true); };
  const saveManagement = async () => {
    let url: string | undefined;
    try { url = buildConfigServerUrl(address, token); } catch { setManagementError('invalidManagement'); return; }
    try { const next = { ...snapshot.mode, config_server_url: url }; delete next.config_server_needs_credentials;
      await session.applyMode(next); closeManagement(); notice(t('saved'));
    } catch { setManagementError('nativeError'); }
  };
  const openMode = async (service = false) => { const fresh = structuredClone(snapshot.mode); setDraft(fresh); if (service) await switchMode('service', fresh); setModeOpen(true); };
  async function switchMode(mode: Mode['mode'], input: Mode = draft) {
    const current = { ...input };
    if (mode === 'service') { setModePreparing(true); try { const defaults = await getServiceDefaults(); setDraft({ ...defaults, ...current, mode: 'service', rpc_portal: current.mode === 'service' ? current.rpc_portal : defaults.rpc_portal } as Mode); } catch { notice(t('nativeError'), 'error'); } finally { setModePreparing(false); } }
    else if (mode === 'remote') setDraft({ ...current, mode: 'remote', remote_rpc_address: 'remote_rpc_address' in current ? current.remote_rpc_address : 'tcp://127.0.0.1:15999' });
    else setDraft({ ...current, mode: 'normal', rpc_portal: current.mode === 'normal' ? current.rpc_portal : undefined, enable_rpc_port_listen: false });
  };
  return <div className="form-stack">
    <div className="page-heading"><h1>{t('settings')}</h1></div>
    <div className="client-settings-grid">
      <Panel title={t('management')} action={<Button icon="key" disabled={snapshot.busy || snapshot.mode.mode === 'remote'} onClick={openManagement}>{t('connectManagement')}</Button>}>
        <Status state={connectionStatus.state} label={t(connectionStatus.label)}/>
        {snapshot.mode.config_server_url && <p className="entity-secondary">{splitConfigServerUrl(snapshot.mode.config_server_url).address}</p>}
        {showManagementDeviceId && <dl className="detail-list setting-actions"><dt>{t('managementDeviceId')}</dt><dd className="management-device-id"><code>{managementDeviceId || (deviceIdFailed ? t('resourceUnavailable') : '—')}</code><Button tone="ghost" icon="copy" disabled={!managementDeviceId} aria-label={t('copyManagementDeviceId')} onClick={() => { if (managementDeviceId) void copyText(managementDeviceId).then(() => notice(t('copied'))).catch(() => notice(t('nativeError'), 'error')); }}/></dd></dl>}
      </Panel>
      {snapshot.platform !== 'android' && <Panel title={t('mode')} action={<Button icon="settings" disabled={snapshot.busy || modePreparing} onClick={() => void openMode()}>{t('mode')}</Button>}><dl className="detail-list"><dt>{t('mode')}</dt><dd>{t(snapshot.mode.mode)}</dd><dt>{t('serviceStatus')}</dt><dd>{t(snapshot.serviceStatus)}</dd></dl><div className="actions setting-actions"><Button icon="clock" disabled={snapshot.busy || modePreparing} onClick={() => void openMode(true)}>{t('boot')}</Button></div></Panel>}
      <Panel title={t('theme')}><div className="form-grid"><Field label={t('theme')}><select value={theme} onChange={event => setTheme(event.target.value)}>{['system', 'light', 'dark'].map(value => <option key={value} value={value}>{t(value)}</option>)}</select></Field><Field label={t('language')}><select value={i18n.resolvedLanguage} onChange={event => void i18n.changeLanguage(event.target.value)}><option value="zh-CN">简体中文</option><option value="en">English</option></select></Field></div></Panel>
      <Panel title={t('logging')}><Field label={t('logLevel')}><select value={logLevel} onChange={event => { const level = event.target.value; void operation(() => nativeApi.setLoggingLevel(level), () => setLogLevel(level)); }}>{levels.map(level => <option key={level} value={level}>{level}</option>)}</select></Field><div className="actions setting-actions">{snapshot.platform !== 'android' && <Button icon="server" onClick={() => void operation(openLogDirectory)}>{t('openLog')}</Button>}<Button icon="copy" onClick={() => void getLogDirPath().then(copyText).then(() => notice(t('copied'))).catch(() => notice(t('nativeError'), 'error'))}>{t('copyLog')}</Button></div></Panel>
    </div>
    <div className="actions"><Button icon="info" tone="ghost" onClick={() => setAboutOpen(true)}>{t('about')}</Button><Button icon="logout" tone="danger" onClick={() => void exitApplication().catch(() => notice(t('nativeError'), 'error'))}>{t('exit')}</Button></div>
    <Dialog open={modeOpen} title={t('mode')} onClose={() => { if (!snapshot.busy && !modePreparing) setModeOpen(false); }} footer={<><Button tone="ghost" disabled={snapshot.busy || modePreparing} onClick={() => setModeOpen(false)}>{t('cancel')}</Button><Button busy={snapshot.busy || modePreparing} onClick={() => void operation(() => session.applyMode(draft), () => setModeOpen(false))}>{t('save')}</Button></>}>
      <Field label={t('mode')}><select disabled={snapshot.busy || modePreparing} value={draft.mode} onChange={event => void switchMode(event.target.value as Mode['mode'])}>{['normal', 'service', 'remote'].map(value => <option key={value} value={value}>{t(value)}</option>)}</select></Field>
      {draft.mode === 'normal' && <><label className="check-row"><input type="checkbox" checked={!!draft.enable_rpc_port_listen} onChange={event => { const enabled = event.target.checked, port = draft.rpc_listen_port || 15999; setDraft({ ...draft, enable_rpc_port_listen: enabled, rpc_listen_port: port, rpc_portal: enabled ? `tcp://0.0.0.0:${port}` : undefined }); }}/>{t('rpcListen')}</label>{draft.enable_rpc_port_listen && <Field label={t('rpcPort')}><input type="number" min={1} max={65535} value={draft.rpc_listen_port ?? 15999} onChange={event => { const port = Number(event.target.value); setDraft({ ...draft, rpc_listen_port: port, rpc_portal: `tcp://0.0.0.0:${port}` }); }}/></Field>}</>}
      {draft.mode === 'service' && <><div className="form-stack">{(['config_dir', 'rpc_portal', 'file_log_dir'] as const).map(key => <Field key={key} label={t(key === 'config_dir' ? 'configDir' : key === 'file_log_dir' ? 'logDir' : 'rpcAddress')}><input value={draft[key]} disabled={snapshot.busy || modePreparing} onChange={event => setDraft({ ...draft, [key]: event.target.value })}/></Field>)}<Field label={t('logLevel')}><select value={draft.file_log_level} disabled={snapshot.busy || modePreparing} onChange={event => setDraft({ ...draft, file_log_level: event.target.value as 'off' })}>{levels.map(level => <option key={level} value={level}>{level}</option>)}</select></Field></div><div className="actions">{snapshot.serviceStatus === 'Running' && <Button tone="danger" disabled={snapshot.busy || modePreparing} onClick={() => setPending('stop')}>{t('stopService')}</Button>}{snapshot.serviceStatus !== 'NotInstalled' && <Button tone="danger" disabled={snapshot.busy || modePreparing} onClick={() => setPending('uninstall')}>{t('uninstallService')}</Button>}</div></>}
      {draft.mode === 'remote' && <Field label={t('rpcAddress')}><input value={draft.remote_rpc_address} onChange={event => setDraft({ ...draft, remote_rpc_address: event.target.value })}/></Field>}
    </Dialog>
    <Dialog open={managementOpen} title={t('management')} onClose={() => { if (!snapshot.busy && !modePreparing) closeManagement(); }} footer={<><Button tone="ghost" disabled={snapshot.busy || modePreparing} onClick={closeManagement}>{t('cancel')}</Button><Button busy={snapshot.busy || modePreparing} onClick={() => { if (snapshot.mode.mode === 'service') setPending('management'); else void saveManagement(); }}>{t('save')}</Button></>}>
      {managementError && <Alert tone="error">{t(managementError)}</Alert>}<Field label={t('managementAddress')}><input autoComplete="off" spellCheck={false} value={address} disabled={snapshot.busy || modePreparing} onChange={event => setAddress(event.target.value)}/></Field><Field label={t('managementToken')}><input type="password" autoComplete="off" spellCheck={false} value={token} disabled={snapshot.busy || modePreparing} onChange={event => setToken(event.target.value)}/></Field>{snapshot.mode.config_server_url && <Button tone="danger" disabled={snapshot.busy || modePreparing} onClick={() => void operation(() => session.applyMode({ ...snapshot.mode, config_server_url: undefined }), closeManagement)}>{t('disconnectManagement')}</Button>}
    </Dialog>
    <Dialog open={!!pending} title={t('confirm')} onClose={() => { if (!snapshot.busy && !modePreparing) setPending(undefined); }} footer={<><Button tone="ghost" disabled={snapshot.busy || modePreparing} onClick={() => setPending(undefined)}>{t('cancel')}</Button><Button busy={snapshot.busy || modePreparing} tone="danger" onClick={() => { const action = pending; setPending(undefined); if (action === 'management') void saveManagement(); else void operation(() => action === 'stop' ? session.stopService() : session.uninstallService(), () => setModeOpen(false)); }}>{t('confirm')}</Button></>}><p>{t(pending === 'stop' ? 'confirmStopService' : pending === 'uninstall' ? 'confirmUninstall' : 'confirmManagement')}</p></Dialog>
    <Dialog open={aboutOpen} title={t('about')} onClose={() => setAboutOpen(false)}><dl className="detail-list"><dt>EasyTier GUI</dt><dd>{guiVersion}</dd><dt>Core</dt><dd>{snapshot.version || '—'}</dd><dt>{t('device')}</dt><dd>{snapshot.platform}</dd></dl></Dialog>
  </div>;
}
