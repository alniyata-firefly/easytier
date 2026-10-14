import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import ApiClient, { type AclPolicy, type AclPolicyRule, type AclProtocolTarget, type AclSelector, type CentralNetworkMember } from '../lib/api';
import { useResource } from '../lib/hooks';
import { Alert, Button, Dialog, Empty, Field, Panel, Status, useNotice } from './ui';
import { errorMessage, NetworkValidationError, splitList } from './NetworkSettingsForm';
import { memberName } from './MemberEditor';
import { v4 as uuidv4 } from 'uuid';

const blankRule = (): AclPolicyRule => ({ id: uuidv4(), name: '', enabled: true, action: 'allow', sources: [{ type: 'all' }], destinations: [{ type: 'all' }], protocols: [{ protocol: 'any', ports: [], stateful: false }] });
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
function SelectorEditor({ label, values, destination, members, onChange }: { label: string; values: AclSelector[]; destination?: boolean; members: CentralNetworkMember[]; onChange: (values: AclSelector[]) => void }) {
    const { t } = useTranslation('networks');
    const update = (index: number, next: AclSelector) => onChange(values.map((value, at) => at === index ? next : value));
    return <fieldset className="rule-section"><legend>{label}</legend>
        {values.map((value, index) => <div className="selector-row" key={index}>
            <Field label={t('acl.selectorType', { label, index: index + 1 })}><select aria-label={t('acl.selectorType', { label, index: index + 1 })} value={value.type} onChange={event => {
                const kind = event.target.value;
                update(index, kind === 'all' ? { type: 'all' } : kind === 'group' ? { type: 'group', name: '' } : kind === 'subnet' ? { type: 'subnet', member_id: members[0]?.member_id ?? '', cidrs: [] } : { type: 'member', member_id: members[0]?.member_id ?? '' });
            }}><option value="all">{t('acl.allMembers')}</option><option value="member" disabled={!members.length}>{t('acl.member')}</option>{destination ? <option value="subnet" disabled={!members.length}>{t('acl.subnet')}</option> : <option value="group">{t('acl.groupSelector')}</option>}</select></Field>
            {(value.type === 'member' || value.type === 'subnet') && <Field label={t('acl.selectorMember', { label, index: index + 1 })}><select aria-label={t('acl.selectorMember', { label, index: index + 1 })} value={value.member_id} onChange={event => update(index, { ...value, member_id: event.target.value })}><option value="" disabled>{t('acl.chooseMember')}</option>{members.map(member => <option key={member.member_id} value={member.member_id}>{memberName(member)}</option>)}</select></Field>}
            {value.type === 'group' && <Field label={t('acl.groupName')}><input aria-label={t('acl.selectorGroup', { label, index: index + 1 })} value={value.name} onChange={event => update(index, { ...value, name: event.target.value })} required /></Field>}
            {value.type === 'subnet' && <Field label={t('acl.cidrs')}><input aria-label={t('acl.selectorCidrs', { label, index: index + 1 })} className="mono" value={value.cidrs.join(', ')} onChange={event => update(index, { ...value, cidrs: event.target.value.split(',').map(item => item.trim()) })} required /></Field>}
            <Button tone="ghost" aria-label={t('acl.removeSelector', { label, index: index + 1 })} icon="close" disabled={values.length === 1} onClick={() => onChange(values.filter((_, at) => at !== index))} />
        </div>)}
        <Button tone="ghost" icon="plus" onClick={() => onChange([...values, { type: 'all' }])}>{t('acl.addSelector', { label })}</Button>
    </fieldset>;
}

export function AclPolicyPanel({ api, networkId, members, onChanged }: { api: ApiClient; networkId: string; members: CentralNetworkMember[]; onChanged: () => void }) {
    const { t } = useTranslation('networks');
    const resource = useResource(() => api.get_network_acl_policy(networkId), `network-acl:${networkId}`);
    const [policy, setPolicy] = useState<AclPolicy>({ default_action: 'allow', rules: [] });
    const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null);
    const [editor, setEditor] = useState<AclPolicyRule | null>(null), [editingId, setEditingId] = useState<string | null>(null), [editorError, setEditorError] = useState<unknown>(null);
    const [discard, setDiscard] = useState(false), [deleteRule, setDeleteRule] = useState<AclPolicyRule | null>(null);
    const loadedAt = useRef(0);
    const notice = useNotice();
    useEffect(() => { if (resource.data && !dirty && resource.updatedAt > loadedAt.current) { loadedAt.current = resource.updatedAt; setPolicy(clone(resource.data.policy)); } }, [resource.data, resource.updatedAt, dirty]);
    useEffect(() => { setDirty(false); setError(null); setEditor(null); }, [networkId]);
    const mutate = (next: AclPolicy) => { setPolicy(next); setDirty(true); setError(null); };
    const move = (index: number, direction: number) => { const rules = [...policy.rules]; const [rule] = rules.splice(index, 1); rules.splice(index + direction, 0, rule); mutate({ ...policy, rules }); };
    const open = (rule?: AclPolicyRule) => { setEditor(rule ? clone(rule) : blankRule()); setEditingId(rule?.id ?? null); setEditorError(null); };
    const saveRule = (event: FormEvent) => {
        event.preventDefault(); if (!editor) return;
        if (!editor.name.trim() || !editor.sources.length || !editor.destinations.length || !editor.protocols.length) { setEditorError(new NetworkValidationError('acl.validation.required')); return; }
        for (const selector of [...editor.sources, ...editor.destinations]) {
            if ((selector.type === 'member' || selector.type === 'subnet') && !selector.member_id) { setEditorError(new NetworkValidationError('acl.validation.member')); return; }
            if (selector.type === 'group' && !selector.name.trim()) { setEditorError(new NetworkValidationError('acl.validation.group')); return; }
            if (selector.type === 'subnet' && !selector.cidrs.some(value => value.trim())) { setEditorError(new NetworkValidationError('acl.validation.cidr')); return; }
        }
        for (const protocol of editor.protocols) {
            for (const port of splitList(protocol.ports.join(','))) {
                const [start, end = start] = port.split('-').map(Number);
                if (!/^\d+(?:-\d+)?$/.test(port) || !Number.isInteger(start) || start <= 0 || end < start || end > 65535) { setEditorError(new NetworkValidationError('acl.validation.port', { port })); return; }
            }
        }
        const normalized: AclPolicyRule = { ...editor, name: editor.name.trim(), sources: editor.sources.map(selector => selector.type === 'group' ? { ...selector, name: selector.name.trim() } : selector), destinations: editor.destinations.map(selector => selector.type === 'subnet' ? { ...selector, cidrs: selector.cidrs.map(value => value.trim()).filter(Boolean) } : selector), protocols: editor.protocols.map(protocol => ({ ...protocol, ports: splitList(protocol.ports.join(',')) })) };
        mutate({ ...policy, rules: editingId ? policy.rules.map(rule => rule.id === editingId ? normalized : rule) : [...policy.rules, normalized] }); setEditor(null);
    };
    const save = async () => {
        if (busy || !resource.data) return; setBusy(true); setError(null);
        try { const result = await api.update_network_acl_policy(networkId, policy); setPolicy(clone(result.policy)); setDirty(false); resource.refresh(); onChanged(); notice({ key: 'acl.saved', ns: 'networks' }, 'success'); }
        catch (failure) { setError(failure); }
        finally { setBusy(false); }
    };
    const selectorLabel = (selector: AclSelector) => selector.type === 'all' ? t('acl.allMembers') : selector.type === 'group' ? t('acl.groupLabel', { name: selector.name }) : `${members.find(member => member.member_id === selector.member_id) ? memberName(members.find(member => member.member_id === selector.member_id)!) : selector.member_id.slice(0, 8)}${selector.type === 'subnet' ? ` · ${selector.cidrs.join(', ')}` : ''}`;
    const updateProtocol = (index: number, update: Partial<AclProtocolTarget>) => setEditor(previous => previous ? { ...previous, protocols: previous.protocols.map((item, at) => at === index ? { ...item, ...update } : item) } : previous);
    return <>
        <Panel title={t('acl.title')} action={<div className="actions"><Button tone="ghost" onClick={() => dirty ? setDiscard(true) : resource.refresh()} busy={resource.loading}>{t('actions.reload')}</Button><Button busy={busy} disabled={!dirty || !resource.data} onClick={save}>{t('acl.save')}</Button></div>}>
            
            {dirty && <Alert tone="info">{t('acl.unsaved')}</Alert>}
            {(error !== null || resource.error) && <Alert tone="error">{error !== null ? errorMessage(error) : resource.error}<Button tone="ghost" onClick={() => resource.refresh()}>{t('actions.retryRead')}</Button></Alert>}
            {resource.loading && !resource.data ? <p role="status" className="loading-lines">{t('acl.loading')}</p> : resource.data ? <>
                <div className="list-toolbar"><Field label={t('acl.defaultAction')}><select aria-label={t('acl.defaultAction')} value={policy.default_action} disabled={busy} onChange={event => mutate({ ...policy, default_action: event.target.value as 'allow' | 'deny' })}><option value="allow">{t('acl.allowAccess')}</option><option value="deny">{t('acl.denyAccess')}</option></select></Field><Button icon="plus" onClick={() => open()} disabled={busy}>{t('acl.add')}</Button></div>
                {policy.rules.length === 0 ? <Empty title={t('acl.emptyTitle')} action={<Button onClick={() => open()}>{t('acl.add')}</Button>} /> : <ol className="acl-list">{policy.rules.map((rule, index) => <li className="acl-row" key={rule.id}>
                    <div className="acl-order"><span>{String(index + 1).padStart(2, '0')}</span><div className="actions"><Button tone="ghost" aria-label={t('acl.moveUp', { name: rule.name })} disabled={index === 0 || busy} onClick={() => move(index, -1)}>↑</Button><Button tone="ghost" aria-label={t('acl.moveDown', { name: rule.name })} disabled={index === policy.rules.length - 1 || busy} onClick={() => move(index, 1)}>↓</Button></div></div>
                    <div className="acl-rule-content"><div className="actions"><strong>{rule.name}</strong><Status state={!rule.enabled ? 'disabled' : rule.action === 'allow' ? 'applied' : 'failed'} label={t(!rule.enabled ? 'acl.disabled' : rule.action === 'allow' ? 'acl.allow' : 'acl.deny')} /></div><p>{rule.sources.map(selectorLabel).join(t('values.listSeparator'))} <span aria-label={t('acl.accessTarget')}>→</span> {rule.destinations.map(selectorLabel).join(t('values.listSeparator'))}</p><small className="mono muted">{rule.protocols.map(protocol => `${protocol.protocol.toUpperCase()} ${protocol.ports.length ? protocol.ports.join(', ') : t('acl.allPorts')}${protocol.stateful ? ` · ${t('acl.statefulSummary')}` : ''}`).join(' / ')}</small></div>
                    <div className="row-actions"><Button tone="ghost" disabled={busy} onClick={() => mutate({ ...policy, rules: policy.rules.map(item => item.id === rule.id ? { ...item, enabled: !item.enabled } : item) })}>{t(rule.enabled ? 'acl.disable' : 'acl.enable')}</Button><Button tone="ghost" disabled={busy} onClick={() => open(rule)}>{t('actions.edit')}</Button><Button tone="danger" disabled={busy} onClick={() => setDeleteRule(rule)}>{t('actions.delete')}</Button></div>
                </li>)}</ol>}
            </> : <Empty title={t('acl.unavailable')} action={<Button onClick={resource.refresh}>{t('actions.reload')}</Button>} />}
        </Panel>
        <Dialog open={!!editor} title={t(editingId ? 'acl.editTitle' : 'acl.addTitle')} onClose={() => setEditor(null)} wide>
            {editor && <form className="form-stack" onSubmit={saveRule}>
                {editorError !== null && <Alert tone="error">{errorMessage(editorError)}</Alert>}
                <div className="form-grid"><Field label={t('acl.ruleName')}><input aria-label={t('acl.ruleName')} value={editor.name} onChange={event => setEditor({ ...editor, name: event.target.value })} required /></Field><Field label={t('acl.action')}><select aria-label={t('acl.action')} value={editor.action} onChange={event => setEditor({ ...editor, action: event.target.value as 'allow' | 'deny' })}><option value="allow">{t('acl.allow')}</option><option value="deny">{t('acl.deny')}</option></select></Field></div>
                <label className="check-row"><input type="checkbox" checked={editor.enabled} onChange={event => setEditor({ ...editor, enabled: event.target.checked })} /><span>{t('acl.enabled')}</span></label>
                <SelectorEditor label={t('acl.source')} values={editor.sources} members={members} onChange={sources => setEditor({ ...editor, sources })} />
                <SelectorEditor label={t('acl.destination')} values={editor.destinations} destination members={members} onChange={destinations => setEditor({ ...editor, destinations })} />
                <fieldset className="rule-section"><legend>{t('acl.protocols')}</legend>{editor.protocols.map((protocol, index) => <div className="protocol-row" key={index}>
                    <Field label={t('acl.protocolIndex', { index: index + 1 })}><select aria-label={t('acl.protocolIndex', { index: index + 1 })} value={protocol.protocol} onChange={event => { const next = event.target.value as AclProtocolTarget['protocol']; updateProtocol(index, { protocol: next, ports: next === 'icmp' || next === 'icmpv6' || next === 'any' ? [] : protocol.ports, stateful: next === 'tcp' ? protocol.stateful : false }); }}><option value="any">{t('acl.anyProtocol')}</option><option value="tcp">TCP</option><option value="udp">UDP</option><option value="icmp">ICMP</option><option value="icmpv6">ICMPv6</option></select></Field>
                    {(protocol.protocol === 'tcp' || protocol.protocol === 'udp' || (protocol.protocol === 'any' && protocol.ports.length > 0)) && <Field label={t('acl.ports')}><input aria-label={t('acl.protocolPorts', { index: index + 1 })} className="mono" value={protocol.ports.join(', ')} onChange={event => updateProtocol(index, { ports: event.target.value.split(',').map(value => value.trim()) })} /></Field>}
                    {protocol.protocol === 'tcp' && <label className="check-row"><input type="checkbox" checked={protocol.stateful} onChange={event => updateProtocol(index, { stateful: event.target.checked })} /><span>{t('acl.stateful')}</span></label>}
                    <Button tone="ghost" icon="close" aria-label={t('acl.removeProtocol', { index: index + 1 })} disabled={editor.protocols.length === 1} onClick={() => setEditor({ ...editor, protocols: editor.protocols.filter((_, at) => at !== index) })} />
                </div>)}<Button tone="ghost" icon="plus" onClick={() => setEditor({ ...editor, protocols: [...editor.protocols, { protocol: 'tcp', ports: [], stateful: true }] })}>{t('acl.addProtocol')}</Button></fieldset>
                <div className="form-actions"><Button tone="ghost" type="button" onClick={() => setEditor(null)}>{t('actions.cancel')}</Button><Button type="submit">{t('acl.saveRule')}</Button></div>
            </form>}
        </Dialog>
        <Dialog open={discard} title={t('acl.reloadTitle')} onClose={() => setDiscard(false)} footer={<><Button tone="ghost" onClick={() => setDiscard(false)}>{t('acl.continueEdit')}</Button><Button tone="danger" onClick={() => { setDirty(false); resource.refresh(); setDiscard(false); }}>{t('acl.discardAndRead')}</Button></>}><p>{t('acl.discardPrompt')}</p></Dialog>
        <Dialog open={!!deleteRule} title={t('acl.removeTitle')} onClose={() => setDeleteRule(null)} footer={<><Button tone="ghost" onClick={() => setDeleteRule(null)}>{t('actions.cancel')}</Button><Button tone="danger" onClick={() => { mutate({ ...policy, rules: policy.rules.filter(rule => rule.id !== deleteRule?.id) }); setDeleteRule(null); }}>{t('acl.removeFromList')}</Button></>}><p>{t('acl.removePrompt', { name: deleteRule?.name ?? '' })}</p></Dialog>
    </>;
}
