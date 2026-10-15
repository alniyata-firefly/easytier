import { UplinkInventoryError } from '../../../frontend-lib/src/modules/uplinkInventory';
import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RemoteClient } from '../../../frontend-lib/src/modules/api';
import { NetworkTypes } from '../lib/shared';
import { errorDescriptor } from '../lib/hooks';
import { applyNodePatch, validateNodeParameters, prepareNodeParametersForBackend, NodeParameterValidationError } from '../lib/node-config';
import { NodeParameters } from './NodeParameters';
import { InstanceAclEditor, validateInstanceAcl } from './InstanceAclEditor';
import { Alert, Button, Field, Tabs } from './ui';
import { normalizeUplinkForTarget } from '../../../frontend-lib/src/modules/uplinkCapabilities';

type Config = NetworkTypes.NetworkConfig;
type SaveMode = 'save' | 'run';
type IdentityMode = 'secret' | 'credential';
type UiError = { key: string; ns: string; values?: Record<string, unknown> };
class InstanceConfigError extends Error {}
const peerUrls = (text: string) => text.split('\n').map(row => row.trim()).filter(Boolean);
const targetConfig = (config: Config, supported: boolean): Config => normalizeUplinkForTarget(config as unknown as Record<string, unknown>, supported) as unknown as Config;
const backendDraft = (config: Config, supported = true): Config => prepareNodeParametersForBackend(targetConfig(config, supported) as unknown as Record<string, unknown>) as unknown as Config;

export function validateInstanceConfigDraft(config: Config, instanceId: string, identity?: IdentityMode): void {
  if (typeof config.instance_id !== 'string' || config.instance_id.toLowerCase() !== instanceId.toLowerCase()) throw new InstanceConfigError('editor.wrongId');
  if (identity === 'credential' && !(config.credential_secret ?? '').trim()) throw new InstanceConfigError('editor.credentialRequired');
  if (config.networking_method === NetworkTypes.NetworkingMethod.PublicServer && !(config.public_server_url ?? '').trim()) throw new InstanceConfigError('editor.serverRequired');
  const issues = validateNodeParameters(config as unknown as Record<string, unknown>);
  if (issues.length) throw new NodeParameterValidationError(issues[0]);
  const aclError = validateInstanceAcl(config.acl);
  if (aclError) throw new InstanceConfigError(aclError);
}

export function InstanceConfigEditor({ remote, instanceId, isNew = false, online, checkPermission, onSaved, onBusyChange, supportsUplinkSelection = true }: {
  remote: RemoteClient; instanceId: string; isNew?: boolean; online: boolean;
  checkPermission: () => Promise<void>; onSaved: (mode: SaveMode) => void; onBusyChange: (value: boolean) => void;
  supportsUplinkSelection?: boolean;
}) {
  const { t } = useTranslation(['devices', 'node-config']);
  const [config, setConfig] = useState<Config>();
  const [text, setText] = useState(''), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true);
  const [peerText, setPeerText] = useState(''), [identity, setIdentity] = useState<IdentityMode>('secret');
  const [tab, setTab] = useState('basic'), [error, setError] = useState<UiError>(), [validated, setValidated] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const uplinkCapability = useRef(supportsUplinkSelection);
  uplinkCapability.current = supportsUplinkSelection;
  const loadUplinkInventory = useCallback(() => {
    if (!online) return Promise.reject(new UplinkInventoryError('offline'));
    if (!remote.get_network_interfaces) return Promise.reject(new UplinkInventoryError('unsupported'));
    return remote.get_network_interfaces(instanceId);
  }, [remote, instanceId, online]);
  const mounted = useRef(true), locked = useRef(false);
  const shownError = error ? t(error.key, { ns: error.ns, ...error.values }) : '';
  const acceptConfig = (value: Config) => { const next = targetConfig(value, uplinkCapability.current); setConfig(next); setPeerText((next.peer_urls ?? []).join('\n')); setIdentity(next.credential_secret ? 'credential' : 'secret'); setShowSecret(false); };
  useEffect(() => {
    mounted.current = true; let current = true;
    const load = async () => {
      try {
        const initial = isNew ? { ...NetworkTypes.DEFAULT_NETWORK_CONFIG(), instance_id: instanceId, listener_urls: [] } : await remote.get_network_config(instanceId);
        const generated = await remote.generate_config(backendDraft(initial, uplinkCapability.current));
        if (!generated.toml_config || generated.error) throw new InstanceConfigError('editor.invalid');
        if (current) { acceptConfig(initial); setText(generated.toml_config); }
      } catch (failure) { if (current) setError(failure instanceof InstanceConfigError ? { key: failure.message, ns: 'devices' } : errorDescriptor(failure)); }
      finally { if (current) setLoading(false); }
    };
    void load();
    return () => { current = false; mounted.current = false; };
  }, [remote, instanceId, isNew]);
  useEffect(() => {
    if (supportsUplinkSelection) return;
    setConfig(value => value ? targetConfig(value, false) : value);
    setValidated(false);
  }, [supportsUplinkSelection]);

  const change = (patch: Record<string, unknown>) => {
    setConfig(old => old ? targetConfig(applyNodePatch(old as unknown as Record<string, unknown>, patch) as unknown as Config, supportsUplinkSelection) : old);
    setValidated(false);
  };
  const work = async (task: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); onBusyChange(true); setError(undefined);
    try { await task(); }
    catch (failure) {
      if (mounted.current) setError(failure instanceof NodeParameterValidationError ? { key: failure.issue.key, ns: 'node-config', values: failure.issue.values }
        : failure instanceof InstanceConfigError ? { key: failure.message, ns: 'devices' } : errorDescriptor(failure));
    } finally { locked.current = false; onBusyChange(false); if (mounted.current) setBusy(false); }
  };
  const draft = (): Config => {
    if (!config) throw new InstanceConfigError('editor.loadFailed');
    return targetConfig({ ...config, peer_urls: peerUrls(peerText) }, uplinkCapability.current);
  };
  const generate = async (next: Config): Promise<string> => {
    const normalized = targetConfig(next, uplinkCapability.current);
    validateInstanceConfigDraft(normalized, instanceId, identity);
    const generated = await remote.generate_config(backendDraft(normalized, uplinkCapability.current));
    if (!generated.toml_config || generated.error) throw new InstanceConfigError('editor.invalid');
    return generated.toml_config;
  };
  const parse = async (): Promise<Config> => {
    const parsed = await remote.parse_config(text);
    if (!parsed.config || parsed.error) throw new InstanceConfigError('editor.invalid');
    const normalized = targetConfig(parsed.config, uplinkCapability.current);
    validateInstanceConfigDraft(normalized, instanceId);
    return normalized;
  };
  const currentConfig = async (): Promise<Config> => {
    if (tab === 'toml') return parse();
    const next = draft(), generated = await generate(next);
    if (mounted.current) setText(generated);
    return next;
  };
  const switchTab = (next: string) => work(async () => {
    if (next === tab) return;
    if (tab === 'toml') { const parsed = await parse(); if (mounted.current) acceptConfig(parsed); }
    else if (next === 'toml') { const generated = await generate(draft()); if (mounted.current) setText(generated); }
    if (mounted.current) { setTab(next); setValidated(false); }
  });
  const validate = () => work(async () => {
    const next = await currentConfig();
    if (online) await remote.validate_config(backendDraft(next, uplinkCapability.current));
    if (mounted.current) { if (tab === 'toml') acceptConfig(next); setValidated(true); }
  });
  const submit = (mode: SaveMode) => work(async () => {
    if (mode === 'run' && !online) throw new InstanceConfigError('editor.offline');
    const next = await currentConfig();
    await checkPermission();
    if (online) await remote.validate_config(backendDraft(next, uplinkCapability.current));
    if (mode === 'run') await remote.run_network(backendDraft(next, uplinkCapability.current), true); else await remote.save_config(backendDraft(next, uplinkCapability.current));
    if (mounted.current) onSaved(mode);
  });
  if (loading) return <p className="loading" role="status">{t('editor.loading')}</p>;
  if (!config) return <Alert tone="error">{shownError || t('editor.loadFailed')}</Alert>;
  return <div className="form-stack">
    {shownError && <Alert tone="error">{shownError}</Alert>}
    <div className="mono">{instanceId}</div>
    <Tabs items={['basic', 'advanced', 'acl', 'toml'].map(id => ({ id, label: t(`editor.sections.${id}`) }))} value={tab} onChange={next => { if (!busy) void switchTab(next); }}/>
    {tab === 'basic' && <>
      <div className="form-grid">
        <Field label={t('editor.networkName')}><input value={config.network_name ?? ''} disabled={busy} onChange={event => change({ network_name: event.target.value })}/></Field>
        <Field label={t('labels.hostname')}><input value={config.hostname ?? ''} disabled={busy} onChange={event => change({ hostname: event.target.value })}/></Field>
        <Field label={t('editor.identityMode')}><select value={identity} disabled={busy} onChange={event => { const next = event.target.value as IdentityMode; setIdentity(next); setShowSecret(false); if (next === 'secret') change({ credential_secret: undefined }); else change({ secure_mode: { ...config.secure_mode, enabled: true } }); }}><option value="secret">{t('editor.sharedSecret')}</option><option value="credential">{t('editor.credential')}</option></select></Field>
        <Field label={t(identity === 'credential' ? 'editor.credential' : 'editor.networkSecret')}><input type={showSecret ? 'text' : 'password'} autoComplete="new-password" value={identity === 'credential' ? config.credential_secret ?? '' : config.network_secret ?? ''} disabled={busy} onChange={event => change(identity === 'credential' ? { credential_secret: event.target.value } : { network_secret: event.target.value })}/></Field>
        <Field label={t('labels.virtualIpv4')}><input value={config.virtual_ipv4 ?? ''} disabled={busy || !!config.dhcp} onChange={event => change({ virtual_ipv4: event.target.value })}/></Field>
        <Field label={t('editor.ipv4Length')}><input type="number" min={1} max={32} value={config.network_length ?? 24} disabled={busy || !!config.dhcp} onChange={event => change({ network_length: Number(event.target.value) })}/></Field>
        <Field label={t('editor.networkMethod')}><select value={config.networking_method} disabled={busy} onChange={event => change({ networking_method: Number(event.target.value) })}>{[NetworkTypes.NetworkingMethod.Manual, NetworkTypes.NetworkingMethod.PublicServer, NetworkTypes.NetworkingMethod.Standalone].map(method => <option key={method} value={method}>{t(`editor.method.${method}`)}</option>)}</select></Field>
        {config.networking_method === NetworkTypes.NetworkingMethod.Manual && <Field label={t('editor.peers')}><textarea value={peerText} disabled={busy} onChange={event => { setPeerText(event.target.value); setValidated(false); }}/></Field>}
        {config.networking_method === NetworkTypes.NetworkingMethod.PublicServer && <Field label={t('editor.publicServer')}><input value={config.public_server_url ?? ''} disabled={busy} onChange={event => change({ public_server_url: event.target.value })}/></Field>}
      </div>
      <div className="actions">
        <label className="check-row"><input type="checkbox" checked={!!config.dhcp} disabled={busy} onChange={event => change({ dhcp: event.target.checked })}/>{t('editor.dhcp')}</label>
        {identity === 'secret' && <label className="check-row"><input type="checkbox" checked={config.secure_mode?.enabled === true} disabled={busy} onChange={event => change({ secure_mode: event.target.checked ? { ...config.secure_mode, enabled: true } : undefined })}/>{t('editor.secureMode')}</label>}
        <Button tone="ghost" icon="eye" disabled={busy} onClick={() => setShowSecret(value => !value)}>{t(showSecret ? 'editor.hideSecret' : 'editor.showSecret')}</Button>
      </div>
    </>}
    {tab === 'advanced' && <NodeParameters loadUplinkInventory={loadUplinkInventory} supportsUplinkSelection={supportsUplinkSelection} mode="instance" value={config as unknown as Record<string, unknown>} onPatch={change} busy={busy}/>}
    {tab === 'acl' && <InstanceAclEditor value={config.acl} onChange={acl => change({ acl })} busy={busy}/>}
    {tab === 'toml' && <><Alert tone="warning">{t('runtime.tomlWarning')}</Alert><Field label={t('editor.toml')}><textarea className="code-editor mono" rows={18} value={text} spellCheck={false} autoComplete="off" disabled={busy} onChange={event => { setText(event.target.value); setValidated(false); }}/></Field></>}
    {validated && <Alert tone="success">{online ? t('editor.validated') : t('editor.parsedOffline')}</Alert>}
    <div className="actions end"><Button tone="ghost" disabled={busy} onClick={validate}>{t('editor.validate')}</Button><Button disabled={busy} onClick={() => submit('save')}>{t('editor.save')}</Button><Button icon="play" disabled={busy || !online} busy={busy} onClick={() => submit('run')}>{t('editor.saveRun')}</Button></div>
  </div>;
}
