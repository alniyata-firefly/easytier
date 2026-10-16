import { UplinkInventoryError } from '../../../../easytier-web/frontend-lib/src/modules/uplinkInventory';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NetworkTypes } from '../lib/shared';
import { applyNodePatch, nodeList, prepareNodeParametersForBackend, validateNodeParameters, type NodeConfigRecord } from '../lib/node-config';
import type { GUIRemoteClient } from '../../native/bridge';
import { NodeParameters } from './NodeParameters';
import { normalizeUplinkForTarget } from '../lib/uplink-capabilities';
import { InstanceAclEditor, validateInstanceAcl } from './InstanceAclEditor';
import { Alert, Button, Dialog, Field, Tabs } from './ui';

export function NetworkEditor({ initial, onClose, onSaved, client, allowRemoteSave, canStart = true, supportsUplinkSelection = true }: {
  initial: NetworkTypes.NetworkConfig; onClose: () => void; onSaved: () => void;
  client: GUIRemoteClient; allowRemoteSave: boolean; canStart?: boolean; supportsUplinkSelection?: boolean;
}) {
  const { t } = useTranslation('client');
  const [config, setConfig] = useState<NetworkTypes.NetworkConfig>(() => normalizeUplinkForTarget(structuredClone(initial) as unknown as NodeConfigRecord, supportsUplinkSelection) as unknown as NetworkTypes.NetworkConfig);
  const [tab, setTab] = useState('basic'), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [credentialMode, setCredentialMode] = useState(!!initial.credential_secret), [showSecret, setShowSecret] = useState(false);
  const [toml, setToml] = useState('');
  const loadUplinkInventory = useCallback(() => client.get_network_interfaces ? client.get_network_interfaces(initial.instance_id) : Promise.reject(new UplinkInventoryError('unsupported')), [client, initial.instance_id]);
  const patch = (next: NodeConfigRecord) => setConfig(old => applyNodePatch(old as unknown as NodeConfigRecord, next) as unknown as NetworkTypes.NetworkConfig);
  const valid = (config.network_name ?? '').trim().length > 0 && (!credentialMode || !!config.credential_secret?.trim())
    && validateNodeParameters(config as unknown as NodeConfigRecord).length === 0 && !validateInstanceAcl(config.acl);
  const save = async (start: boolean) => {
    if (!valid || busy || start && !canStart) return;
    setBusy(true); setError('');
    try {
      const next = prepareNodeParametersForBackend(normalizeUplinkForTarget(config as unknown as NodeConfigRecord, supportsUplinkSelection)) as unknown as NetworkTypes.NetworkConfig;
      await client.validate_config(next);
      if (allowRemoteSave) await client.save_config(next);
      if (start) await client.run_network(next, allowRemoteSave);
      onSaved();
    } catch { setError(t('configError')); } finally { setBusy(false); }
  };
  const changeTab = async (next: string) => {
    setTab(next);
    if (next === 'toml') { setBusy(true); try { const result = await client.generate_config(normalizeUplinkForTarget(config as unknown as NodeConfigRecord, supportsUplinkSelection) as unknown as NetworkTypes.NetworkConfig); if (result.error) throw new Error('config_generation_failed'); setToml(result.toml_config ?? ''); } catch { setError(t('configError')); } finally { setBusy(false); } }
  };
  return <Dialog open title={t('editNetwork')} onClose={() => { if (!busy) onClose(); }} wide footer={<>
    <Button tone="ghost" disabled={busy} onClick={onClose}>{t('cancel')}</Button>
    {allowRemoteSave && <Button disabled={!valid} busy={busy} onClick={() => void save(false)}>{t('save')}</Button>}
    <Button disabled={!valid || !canStart} busy={busy} onClick={() => void save(true)}>{t('saveAndStart')}</Button>
  </>}>
    {error && <Alert tone="error">{error}</Alert>}
    <Tabs items={['basic', 'parameters', 'acl', 'toml'].map(id => ({ id, label: t(id) }))} value={tab} onChange={next => void changeTab(next)}/>
    {tab === 'basic' && <fieldset className="form-stack" disabled={busy}>
      <div className="form-grid"><Field label={t('newName')}><input value={config.network_name} onChange={event => patch({ network_name: event.target.value })}/></Field><Field label={t('hostname')}><input value={config.hostname ?? ''} onChange={event => patch({ hostname: event.target.value })}/></Field></div>
      <Field label={t('identity')}><select value={credentialMode ? 'credential' : 'secret'} onChange={event => { const next = event.target.value === 'credential'; setCredentialMode(next); setShowSecret(false); if (!next) patch({ credential_secret: undefined }); }}><option value="secret">{t('secretMode')}</option><option value="credential">{t('credentialMode')}</option></select></Field>
      <Field label={t(credentialMode ? 'credential' : 'networkSecret')}><input type={showSecret ? 'text' : 'password'} autoComplete="new-password" value={credentialMode ? config.credential_secret ?? '' : config.network_secret ?? ''} onChange={event => patch({ [credentialMode ? 'credential_secret' : 'network_secret']: event.target.value })}/></Field>
      <div className="actions"><Button tone="ghost" icon="eye" onClick={() => setShowSecret(value => !value)}>{t(showSecret ? 'hideSecret' : 'showSecret')}</Button>{!credentialMode && <label className="check-row"><input type="checkbox" checked={config.secure_mode?.enabled === true} onChange={event => patch({ secure_mode: event.target.checked ? { enabled: true } : undefined })}/>{t('secureMode')}</label>}</div>
      <label className="check-row"><input type="checkbox" checked={config.dhcp} onChange={event => patch({ dhcp: event.target.checked })}/>{t('dhcp')}</label>
      <div className="form-grid"><Field label={t('ipv4')}><input disabled={config.dhcp} value={config.virtual_ipv4 ?? ''} onChange={event => patch({ virtual_ipv4: event.target.value })}/></Field><Field label={t('prefix')}><input type="number" min={1} max={32} disabled={config.dhcp} value={config.network_length} onChange={event => patch({ network_length: Number(event.target.value) })}/></Field></div>
      <Field label={t('networkingMethod')}><select value={config.networking_method} onChange={event => patch({ networking_method: Number(event.target.value) })}><option value={NetworkTypes.NetworkingMethod.Manual}>{t('manualPeers')}</option><option value={NetworkTypes.NetworkingMethod.PublicServer}>{t('publicServer')}</option><option value={NetworkTypes.NetworkingMethod.Standalone}>{t('standalone')}</option></select></Field>
      {config.networking_method === NetworkTypes.NetworkingMethod.PublicServer ? <Field label={t('publicServerUrl')}><input value={config.public_server_url ?? ''} onChange={event => patch({ public_server_url: event.target.value })}/></Field> : config.networking_method === NetworkTypes.NetworkingMethod.Manual ? <Field label={t('peers')}><ListInput value={config.peer_urls} onChange={value => patch({ peer_urls: value })}/></Field> : null}
    </fieldset>}
    {tab === 'parameters' && <NodeParameters loadUplinkInventory={loadUplinkInventory} supportsUplinkSelection={supportsUplinkSelection} mode="instance" value={config as unknown as NodeConfigRecord} onPatch={patch} busy={busy}/>}
    {tab === 'acl' && <InstanceAclEditor value={config.acl} onChange={acl => patch({ acl })} busy={busy}/>}
    {tab === 'toml' && <pre className="code-block">{toml || '—'}</pre>}
  </Dialog>;
}

export function ListInput({ value, onChange }: { value: string[]; onChange: (value: string[]) => void }) {
  const [text, setText] = useState(value.join('\n'));
  return <textarea rows={3} spellCheck={false} value={text} onChange={event => { setText(event.target.value); onChange(nodeList(event.target.value)); }}/>;
}
