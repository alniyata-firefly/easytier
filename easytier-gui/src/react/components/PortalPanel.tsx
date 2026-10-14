import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import QRCode from 'qrcode';
import { type GUIRemoteClient, copyText } from '../../native/bridge';
import type { NetworkTypes } from '../lib/shared';
import { normalizeVpnPortalEndpoint, vpnPortalClientConfig, vpnPortalEndpoint, vpnPortalListener, vpnPortalUsedIps, validVpnPortalAddress } from '../../../../easytier-web/frontend-lib/src/modules/vpnPortal';
import { Alert, Button, Dialog, Empty, Field, useNotice } from './ui';

export function PortalPanel({ id, info, client, readOnly }: { id: string; info: NetworkTypes.NetworkInstanceRunningInfo; client: GUIRemoteClient; readOnly: boolean }) {
  const { t } = useTranslation('client'), notice = useNotice();
  const [portal, setPortal] = useState<NetworkTypes.VpnPortalInfo>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false), [name, setName] = useState(''), [address, setAddress] = useState(''), [groups, setGroups] = useState('');
  const [selected, setSelected] = useState(''), [endpoint, setEndpoint] = useState(''), [qr, setQr] = useState('');
  const [removing, setRemoving] = useState<string>();
  const refresh = async () => { try { setPortal(await client.get_vpn_portal_info(id)); setError(''); } catch { setError(t('refreshError')); } };
  useEffect(() => { let alive = true, timer: ReturnType<typeof setTimeout>; const run = async () => { try { const next = await client.get_vpn_portal_info(id); if (alive) { setPortal(next); setError(''); } } catch { if (alive) setError(t('refreshError')); } if (alive) timer = setTimeout(run, 5000); }; void run(); return () => { alive = false; clearTimeout(timer); }; }, [id, client, t]);
  const clients = portal?.clients ?? [], chosen = clients.find(item => item.name === selected);
  const automatic = vpnPortalEndpoint(portal?.listener ?? '', info.my_node_info), resolved = normalizeVpnPortalEndpoint(endpoint || automatic, vpnPortalListener(portal?.listener ?? '')?.port ?? '');
  const config = vpnPortalClientConfig(chosen?.client_config ?? portal?.client_config ?? '', resolved);
  useEffect(() => { let alive = true; setQr(''); if (config) void QRCode.toDataURL(config, { width: 230, margin: 1 }).then(value => { if (alive) setQr(value); }).catch(() => {}); return () => { alive = false; }; }, [config]);
  const mutate = async (operation: () => Promise<unknown>) => { setBusy(true); try { await operation(); await refresh(); } catch { setError(t('nativeError')); } finally { setBusy(false); } };
  const validName = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(name) && !clients.some(item => item.name === name);
  const used = vpnPortalUsedIps({ instance_id: id, running: true, error_msg: '', detail: info }, clients);
  const [ip, prefix] = address.split('/');
  const canAdd = validName && validVpnPortalAddress(ip, prefix ? Number(prefix) : undefined, used) && clients.length < 64;
  if (!portal) return <>{error && <Alert tone="error">{error}</Alert>}<Empty title={t('resourceUnavailable')}/></>;
  return <div className="form-stack">
    {error && <Alert tone="error">{error}</Alert>}
    <div className="toolbar"><h3>{t('portal')}</h3>{!readOnly && portal.listener && <div className="actions"><Button icon="plus" disabled={busy || clients.length >= 64} onClick={() => { setName(`device-${crypto.randomUUID().slice(0, 8)}`); setAddress(''); setGroups(''); setAdding(true); }}>{t('addClient')}</Button><Button tone="danger" disabled={busy || !clients.length} onClick={() => setRemoving('*')}>{t('clearClients')}</Button></div>}</div>
    <div className="table-wrap"><table className="data-table"><thead><tr><th>{t('clientName')}</th><th>{t('clientIp')}</th><th>{t('clientGroups')}</th><th>{t('actions')}</th></tr></thead><tbody>{clients.map(item => <tr key={item.name}><td>{item.name}</td><td>{item.virtual_ip}</td><td>{item.groups?.join(', ') || '—'}</td><td><div className="actions"><Button icon="download" onClick={() => setSelected(item.name)}>{t('clientConfig')}</Button>{!readOnly && <Button icon="trash" tone="danger" disabled={busy} aria-label={t('removeClient')} onClick={() => setRemoving(item.name)}/>}</div></td></tr>)}</tbody></table></div>
    {!clients.length && <Empty title={t('noClients')}/>}
    <Dialog open={adding} title={t('addClient')} onClose={() => { if (!busy) setAdding(false); }} footer={<><Button tone="ghost" disabled={busy} onClick={() => setAdding(false)}>{t('cancel')}</Button><Button disabled={!canAdd || busy} onClick={() => void mutate(async () => { await client.add_vpn_portal_client(id, { name, virtual_ip: address, groups: groups.split(/[\n,]/).map(item => item.trim()).filter(Boolean) }); setAdding(false); })}>{t('save')}</Button></>}><Field label={t('clientName')}><input value={name} onChange={event => setName(event.target.value)}/></Field><Field label={t('clientIp')}><input value={address} onChange={event => setAddress(event.target.value)}/></Field><Field label={t('clientGroups')}><input value={groups} onChange={event => setGroups(event.target.value)}/></Field></Dialog>
    <Dialog open={!!selected} title={t('clientConfig')} onClose={() => { setSelected(''); setEndpoint(''); }} footer={<Button icon="copy" disabled={!config} onClick={() => void copyText(config).then(() => notice(t('copied'))).catch(() => notice(t('nativeError'), 'error'))}>{t('copy')}</Button>}><Field label={t('endpoint')}><input value={endpoint || automatic} onChange={event => setEndpoint(event.target.value)}/></Field>{qr && <img className="portal-qr" src={qr} alt={t('clientConfig')}/>}<pre className="code-block">{config || '—'}</pre></Dialog>
    <Dialog open={!!removing} title={t('removeClient')} onClose={() => { if (!busy) setRemoving(undefined); }} footer={<><Button tone="ghost" disabled={busy} onClick={() => setRemoving(undefined)}>{t('cancel')}</Button><Button tone="danger" busy={busy} onClick={() => void mutate(async () => { if (removing === '*') await client.clear_vpn_portal_clients(id); else if (removing) await client.remove_vpn_portal_client(id, removing); setRemoving(undefined); })}>{t('confirm')}</Button></>}><p>{t(removing === '*' ? 'confirmClear' : 'confirmDelete')}</p></Dialog>
  </div>;
}
