import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NetworkTypes, RuntimeDisplay } from '../lib/shared';
import { Alert, Button, Dialog, Field, Tabs } from './ui';

type Acl = NetworkTypes.Acl;
type Chain = NetworkTypes.AclChain;
type Rule = NetworkTypes.AclRule;
const list = (text: string) => text.split(/[\n,]+/).map(item => item.trim()).filter(Boolean);
const emptyAcl = (): Acl => ({ acl_v1: { chains: [], group: { declares: [], members: [] } } });
const clone = (value: Acl | undefined): Acl => {
  const next = structuredClone(value ?? emptyAcl());
  for (const chain of NetworkTypes.ensureAclV1(next).chains) chain.rules.sort((a, b) => b.priority - a.priority);
  return next;
};
const chainTypes = [NetworkTypes.AclChainType.Inbound, NetworkTypes.AclChainType.Outbound, NetworkTypes.AclChainType.Forward];
const protocols = [NetworkTypes.AclProtocol.Any, NetworkTypes.AclProtocol.TCP, NetworkTypes.AclProtocol.UDP, NetworkTypes.AclProtocol.ICMP, NetworkTypes.AclProtocol.ICMPv6];
const uint32 = (value: number) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;

export function validateInstanceAcl(value: Acl | undefined): string | undefined {
  if (!value?.acl_v1) return undefined;
  for (const chain of value.acl_v1.chains ?? []) {
    for (const rule of chain.rules ?? []) {
      if (![rule.priority, rule.rate_limit, rule.burst_limit].every(uint32)) return 'instanceAcl.invalidNumber';
      for (const port of [...(rule.source_ports ?? []), ...(rule.ports ?? [])]) {
        const match = /^(\d+)(?:-(\d+))?$/.exec(port);
        if (!match || Number(match[1]) < 1 || Number(match[2] ?? match[1]) > 65535 || Number(match[1]) > Number(match[2] ?? match[1])) return 'instanceAcl.invalidPort';
      }
      for (const address of [...(rule.source_ips ?? []), ...(rule.destination_ips ?? [])]) {
        if (!RuntimeDisplay.networkCidr(address.includes('/') ? address : `${address}/${address.includes(':') ? 128 : 32}`)) return 'instanceAcl.invalidAddress';
      }
    }
  }
  return undefined;
}

export function renameInstanceAclGroup(value: Acl, index: number, name: string, secret: string): Acl {
  const next = clone(value), v1 = NetworkTypes.ensureAclV1(next), oldName = v1.group.declares[index]?.group_name;
  v1.group.declares[index] = { ...v1.group.declares[index], group_name: name, group_secret: secret };
  if (oldName && oldName !== name) {
    v1.group.members = v1.group.members.map(member => member === oldName ? name : member);
    for (const chain of v1.chains) for (const rule of chain.rules) {
      rule.source_groups = (rule.source_groups ?? []).map(group => group === oldName ? name : group);
      rule.destination_groups = (rule.destination_groups ?? []).map(group => group === oldName ? name : group);
    }
  }
  return next;
}

export function moveInstanceAclRule(value: Acl, chainIndex: number, index: number, delta: number): Acl {
  const next = clone(value), rules = NetworkTypes.ensureAclV1(next).chains[chainIndex]?.rules;
  if (!rules || !Number.isInteger(index) || ![-1, 1].includes(delta) || index < 0 || index >= rules.length || index + delta < 0 || index + delta >= rules.length) return next;
  [rules[index], rules[index + delta]] = [rules[index + delta], rules[index]];
  rules.forEach((rule, position) => { rule.priority = rules.length - position - 1; });
  return next;
}

function ListField({ label, value, onChange, busy }: { label: string; value: string[]; onChange: (value: string[]) => void; busy?: boolean }) {
  const [text, setText] = useState(value.join('\n'));
  useEffect(() => { if (value.join('\0') !== list(text).join('\0')) setText(value.join('\n')); }, [value, text]);
  return <Field label={label}><textarea value={text} rows={2} disabled={busy} onChange={event => { setText(event.target.value); onChange(list(event.target.value)); }}/></Field>;
}

export function InstanceAclEditor({ value, onChange, busy }: { value?: Acl; onChange: (value: Acl | undefined) => void; busy?: boolean }) {
  const { t } = useTranslation('devices');
  const [tab, setTab] = useState('chains'), [chainIndex, setChainIndex] = useState(0);
  const [ruleEditor, setRuleEditor] = useState<{ index: number; rule: Rule }>();
  const [groupEditor, setGroupEditor] = useState<{ index: number; name: string; secret: string }>();
  const [editorError, setEditorError] = useState('');
  const [showGroupSecret, setShowGroupSecret] = useState(false);
  const [removing, setRemoving] = useState<{ kind: 'chain' | 'rule' | 'group'; index: number }>();
  const acl = clone(value), v1 = NetworkTypes.ensureAclV1(acl), chain = v1.chains[chainIndex];
  const commit = (edit: (draft: NetworkTypes.NormalizedAclV1) => void) => { const next = clone(value); edit(NetworkTypes.ensureAclV1(next)); onChange(next); };
  const updateChain = (patch: Partial<Chain>) => commit(draft => { draft.chains[chainIndex] = { ...draft.chains[chainIndex], ...patch }; });
  const addChain = (chain_type: NetworkTypes.AclChainType) => {
    commit(draft => draft.chains.push({ name: NetworkTypes.AclChainType[chain_type], chain_type, description: '', enabled: true, rules: [], default_action: NetworkTypes.AclAction.Allow }));
    setChainIndex(v1.chains.length);
  };
  const newRule = (): Rule => ({ name: '', description: '', priority: chain?.rules.length ?? 0, enabled: true, protocol: NetworkTypes.AclProtocol.Any, ports: [], source_ips: [], destination_ips: [], source_ports: [], action: NetworkTypes.AclAction.Allow, rate_limit: 0, burst_limit: 0, stateful: false, source_groups: [], destination_groups: [] });
  const saveRule = () => {
    if (!ruleEditor || !chain) return;
    const invalid = validateInstanceAcl({ acl_v1: { chains: [{ ...chain, rules: [ruleEditor.rule] }] } });
    if (invalid) { setEditorError(invalid); return; }
    commit(draft => { const rules = draft.chains[chainIndex].rules; if (ruleEditor.index < 0) rules.push(ruleEditor.rule); else rules[ruleEditor.index] = ruleEditor.rule; rules.sort((a, b) => b.priority - a.priority); });
    setRuleEditor(undefined); setEditorError('');
  };
  const moveRule = (index: number, delta: number) => onChange(moveInstanceAclRule(value ?? emptyAcl(), chainIndex, index, delta));
  const remove = () => {
    if (!removing) return;
    commit(draft => {
      if (removing.kind === 'chain') draft.chains.splice(removing.index, 1);
      else if (removing.kind === 'rule') draft.chains[chainIndex].rules.splice(removing.index, 1);
      else draft.group.declares.splice(removing.index, 1);
    });
    if (removing.kind === 'chain') setChainIndex(Math.max(0, Math.min(chainIndex, v1.chains.length - 2)));
    setRemoving(undefined);
  };
  return <div className="form-stack">
    <label className="check-row"><input type="checkbox" checked={value !== undefined} disabled={busy} onChange={event => onChange(event.target.checked ? emptyAcl() : undefined)}/>{t('instanceAcl.enabled')}</label>
    {value !== undefined && <>
      <Tabs items={[{ id: 'chains', label: t('instanceAcl.chains') }, { id: 'groups', label: t('instanceAcl.groups') }]} value={tab} onChange={setTab}/>
      {tab === 'groups' ? <>
        <div className="toolbar"><h3>{t('instanceAcl.declares')}</h3><Button icon="plus" disabled={busy} onClick={() => { setGroupEditor({ index: -1, name: '', secret: '' }); setShowGroupSecret(false); setEditorError(''); }}>{t('instanceAcl.addGroup')}</Button></div>
        <div className="table-wrap"><table className="data-table"><thead><tr><th>{t('instanceAcl.groupName')}</th><th>{t('instanceAcl.groupSecret')}</th><th>{t('labels.actions')}</th></tr></thead><tbody>{v1.group.declares.map((group, index) => <tr key={index}><td>{group.group_name}</td><td>••••••••</td><td><div className="actions"><Button tone="ghost" icon="edit" aria-label={t('instanceAcl.editGroup')} disabled={busy} onClick={() => { setGroupEditor({ index, name: group.group_name, secret: group.group_secret }); setShowGroupSecret(false); setEditorError(''); }}/><Button tone="danger" icon="trash" aria-label={t('instanceAcl.deleteGroup')} disabled={busy} onClick={() => setRemoving({ kind: 'group', index })}/></div></td></tr>)}</tbody></table></div>
        <ListField label={t('instanceAcl.members')} value={v1.group.members} busy={busy} onChange={members => commit(draft => { draft.group.members = members; })}/>
      </> : <>
        <div className="actions">{chainTypes.map(type => <Button key={type} icon="plus" tone="ghost" disabled={busy} onClick={() => addChain(type)}>{t(`instanceAcl.chainType.${type}`)}</Button>)}</div>
        {v1.chains.length > 0 && <>
          <div className="actions"><Field label={t('instanceAcl.chain')}><select value={chainIndex} disabled={busy} onChange={event => setChainIndex(Number(event.target.value))}>{v1.chains.map((item, index) => <option key={index} value={index}>{item.name || t('instanceAcl.chainIndex', { index: index + 1 })}</option>)}</select></Field><Button tone="danger" icon="trash" disabled={busy} onClick={() => setRemoving({ kind: 'chain', index: chainIndex })}>{t('instanceAcl.deleteChain')}</Button></div>
          {chain && <>
            <div className="form-grid"><Field label={t('instanceAcl.chainName')}><input value={chain.name} disabled={busy} onChange={event => updateChain({ name: event.target.value })}/></Field><Field label={t('instanceAcl.description')}><input value={chain.description} disabled={busy} onChange={event => updateChain({ description: event.target.value })}/></Field><Field label={t('instanceAcl.chainTypeLabel')}><select value={chain.chain_type} disabled={busy} onChange={event => updateChain({ chain_type: Number(event.target.value) })}><option value={0}>{t('instanceAcl.unspecified')}</option>{chainTypes.map(type => <option value={type} key={type}>{t(`instanceAcl.chainType.${type}`)}</option>)}</select></Field><Field label={t('instanceAcl.defaultAction')}><select value={chain.default_action} disabled={busy} onChange={event => updateChain({ default_action: Number(event.target.value) })}>{[0, 1, 2].map(action => <option key={action} value={action}>{t(`instanceAcl.action.${action}`)}</option>)}</select></Field></div>
            <label className="check-row"><input type="checkbox" checked={chain.enabled} disabled={busy} onChange={event => updateChain({ enabled: event.target.checked })}/>{t('instanceAcl.chainEnabled')}</label>
            <div className="toolbar"><h3>{t('instanceAcl.rules')}</h3><Button icon="plus" disabled={busy} onClick={() => { setRuleEditor({ index: -1, rule: newRule() }); setEditorError(''); }}>{t('instanceAcl.addRule')}</Button></div>
            <div className="table-wrap"><table className="data-table"><thead><tr><th>{t('instanceAcl.ruleName')}</th><th>{t('instanceAcl.priority')}</th><th>{t('labels.protocol')}</th><th>{t('instanceAcl.actionLabel')}</th><th>{t('labels.status')}</th><th>{t('labels.actions')}</th></tr></thead><tbody>{chain.rules.map((rule, index) => <tr key={index}><td>{rule.name || t('labels.unnamedRule')}</td><td>{rule.priority}</td><td>{rule.protocol === NetworkTypes.AclProtocol.Any ? t('instanceAcl.any') : rule.protocol === NetworkTypes.AclProtocol.Unspecified ? t('instanceAcl.unspecified') : NetworkTypes.AclProtocol[rule.protocol]}</td><td>{t(`instanceAcl.action.${rule.action}`)}</td><td>{t(rule.enabled ? 'instanceAcl.on' : 'instanceAcl.off')}</td><td><div className="actions"><Button icon="up" tone="ghost" disabled={busy || index === 0} aria-label={t('instanceAcl.moveUp')} onClick={() => moveRule(index, -1)}/><Button icon="down" tone="ghost" disabled={busy || index === chain.rules.length - 1} aria-label={t('instanceAcl.moveDown')} onClick={() => moveRule(index, 1)}/><Button tone="ghost" icon="edit" aria-label={t('instanceAcl.editRule')} disabled={busy} onClick={() => { setRuleEditor({ index, rule: structuredClone(rule) }); setEditorError(''); }}/><Button tone="danger" icon="trash" aria-label={t('instanceAcl.deleteRule')} disabled={busy} onClick={() => setRemoving({ kind: 'rule', index })}/></div></td></tr>)}</tbody></table></div>
          </>}
        </>}
      </>}
    </>}
    <Dialog open={!!groupEditor} title={t('instanceAcl.group')} onClose={() => { if (!busy) { setGroupEditor(undefined); setEditorError(''); } }}>
      {groupEditor && <div className="form-stack">{editorError && <Alert tone="error">{t(editorError)}</Alert>}<Field label={t('instanceAcl.groupName')}><input value={groupEditor.name} disabled={busy} onChange={event => setGroupEditor({ ...groupEditor, name: event.target.value })}/></Field><Field label={t('instanceAcl.groupSecret')}><input type={showGroupSecret ? 'text' : 'password'} autoComplete="new-password" value={groupEditor.secret} disabled={busy} onChange={event => setGroupEditor({ ...groupEditor, secret: event.target.value })}/></Field><Button icon="eye" tone="ghost" disabled={busy} onClick={() => setShowGroupSecret(value => !value)}>{t(showGroupSecret ? 'editor.hideSecret' : 'editor.showSecret')}</Button><div className="actions end"><Button tone="ghost" disabled={busy} onClick={() => setGroupEditor(undefined)}>{t('actions.cancel')}</Button><Button disabled={busy} onClick={() => { const name = groupEditor.name.trim(); if (!name || v1.group.declares.some((item, index) => index !== groupEditor.index && item.group_name === name)) { setEditorError('instanceAcl.invalidGroup'); return; } if (groupEditor.index < 0) commit(draft => draft.group.declares.push({ group_name: name, group_secret: groupEditor.secret })); else onChange(renameInstanceAclGroup(acl, groupEditor.index, name, groupEditor.secret)); setGroupEditor(undefined); setEditorError(''); }}>{t('instanceAcl.save')}</Button></div></div>}
    </Dialog>
    <Dialog open={!!ruleEditor} title={t('instanceAcl.rule')} onClose={() => { if (!busy) { setRuleEditor(undefined); setEditorError(''); } }} wide>
      {ruleEditor && <div className="form-stack">
        {editorError && <Alert tone="error">{t(editorError)}</Alert>}
        <div className="form-grid">{(['name', 'description'] as const).map(key => <Field key={key} label={t(key === 'name' ? 'instanceAcl.ruleName' : 'instanceAcl.description')}><input value={ruleEditor.rule[key]} disabled={busy} onChange={event => setRuleEditor({ ...ruleEditor, rule: { ...ruleEditor.rule, [key]: event.target.value } })}/></Field>)}{(['priority', 'rate_limit', 'burst_limit'] as const).map(key => <Field key={key} label={t(`instanceAcl.${key}`)}><input type="number" min={0} max={0xffffffff} value={ruleEditor.rule[key]} disabled={busy} onChange={event => setRuleEditor({ ...ruleEditor, rule: { ...ruleEditor.rule, [key]: Number(event.target.value) } })}/></Field>)}<Field label={t('labels.protocol')}><select value={ruleEditor.rule.protocol} disabled={busy} onChange={event => setRuleEditor({ ...ruleEditor, rule: { ...ruleEditor.rule, protocol: Number(event.target.value) } })}><option value={0}>{t('instanceAcl.unspecified')}</option>{protocols.map(protocol => <option key={protocol} value={protocol}>{protocol === NetworkTypes.AclProtocol.Any ? t('instanceAcl.any') : NetworkTypes.AclProtocol[protocol]}</option>)}</select></Field><Field label={t('instanceAcl.actionLabel')}><select value={ruleEditor.rule.action} disabled={busy} onChange={event => setRuleEditor({ ...ruleEditor, rule: { ...ruleEditor.rule, action: Number(event.target.value) } })}>{[0, 1, 2].map(action => <option key={action} value={action}>{t(`instanceAcl.action.${action}`)}</option>)}</select></Field></div>
        <div className="form-grid">{(['source_ips', 'destination_ips', 'source_ports', 'ports', 'source_groups', 'destination_groups'] as const).map(key => <ListField key={key} label={t(`instanceAcl.${key}`)} value={ruleEditor.rule[key] ?? []} busy={busy} onChange={items => setRuleEditor({ ...ruleEditor, rule: { ...ruleEditor.rule, [key]: items } })}/>)}</div>
        <div className="actions">{(['enabled', 'stateful'] as const).map(key => <label className="check-row" key={key}><input type="checkbox" checked={ruleEditor.rule[key]} disabled={busy} onChange={event => setRuleEditor({ ...ruleEditor, rule: { ...ruleEditor.rule, [key]: event.target.checked } })}/>{t(`instanceAcl.${key}`)}</label>)}</div>
        <div className="actions end"><Button tone="ghost" disabled={busy} onClick={() => setRuleEditor(undefined)}>{t('actions.cancel')}</Button><Button disabled={busy} onClick={saveRule}>{t('instanceAcl.save')}</Button></div>
      </div>}
    </Dialog>
    <Dialog open={!!removing} title={t('instanceAcl.removeTitle')} onClose={() => { if (!busy) setRemoving(undefined); }}><p>{t('instanceAcl.removePrompt')}</p><div className="actions end"><Button tone="ghost" disabled={busy} onClick={() => setRemoving(undefined)}>{t('actions.cancel')}</Button><Button tone="danger" disabled={busy} onClick={remove}>{t('actions.confirmDelete')}</Button></div></Dialog>
  </div>;
}
