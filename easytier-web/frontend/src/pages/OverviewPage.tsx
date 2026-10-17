import { useTranslation } from 'react-i18next';
import type ApiClient from '../lib/api';
import type {ConsoleInfo} from '../lib/api';
import { Utils } from '../lib/shared';
import { useResource } from '../lib/hooks';
import { devicePath, networkPath } from '../lib/router';
import { Alert, Button, Empty, Icon, Panel } from '../components/ui';
import { ManagementStatus } from '../components/ManagementStatus';
import { ServerResources } from '../components/HostResources';

export function OverviewPage({api,consoleInfo}: {api:ApiClient;consoleInfo:ConsoleInfo}) {
  const {t,i18n}=useTranslation('overview');
  const devices=useResource(()=>api.list_machines().then(rows=>rows.map(Utils.buildDeviceInfo)),`overview-devices:${consoleInfo.username}`,6000);
  const networks=useResource(()=>consoleInfo.webhook_auth?Promise.resolve([]):api.list_networks(),`overview-networks:${consoleInfo.username}`,6000);
  const latest=[...(devices.data??[])].sort((a,b)=>Number(b.online)-Number(a.online)||(a.alias||a.hostname||'').localeCompare(b.alias||b.hostname||'')).slice(0,5);
  const number=(value:number|undefined)=>value===undefined?'—':new Intl.NumberFormat(i18n.resolvedLanguage).format(value);
  return <div className="page stack">
    <header className="page-actions"><div className="actions"><Button icon="refresh" tone="ghost" disabled={devices.loading||networks.loading} onClick={()=>{api.clear_snapshots();devices.refresh();networks.refresh();}}>{t('common:refresh')}</Button>{!consoleInfo.webhook_auth?<a className="button" href="#/h/tokens"><Icon name="plus"/>{t('connectDevice')}</a>:null}</div></header>
    {devices.error||networks.error?<Alert tone="error">{devices.error||networks.error}</Alert>:null}
    <section className="summary-strip" aria-label={t('summary')}>
      <div className="summary-item"><span>{t('registered')}</span><strong>{number(devices.data?.length)}</strong></div>
      <div className="summary-item"><span>{t('online')}</span><strong>{number(devices.error?undefined:devices.data?.filter(d=>d.online).length)}</strong></div>
      {!consoleInfo.webhook_auth?<div className="summary-item"><span>{t('centralNetworks')}</span><strong>{number(networks.data?.length)}</strong></div>:null}
      <div className="summary-item"><span>{t('instances')}</span><strong>{number(devices.error?undefined:devices.data?.reduce((sum,d)=>sum+d.running_network_count,0))}</strong></div>
    </section>
    <div className="overview-grid"><div className="stack">
      <Panel title={t('devices')} action={<a href="#/h/deviceList">{t('viewAll')}</a>}>{latest.length?<div className="preview-list">{latest.map(device=><a key={device.machine_id} href={`#${devicePath(device.machine_id,device.running_network_instances?.[0])}`} className="preview-row"><span className="device-name"><span className="avatar"><Icon name="devices" size={18}/></span><span><span className="entity-name">{device.alias||device.hostname||t('unnamed')}</span><span className="entity-secondary" style={{display:'block'}}>{device.public_ip||'—'}</span></span></span><ManagementStatus online={device.online} unknown={!!devices.error}/></a>)}</div>:<Empty title={t(devices.loading?'loadingDevices':'emptyDevices')}/>}</Panel>
      <Panel title={t('networks')} action={!consoleInfo.webhook_auth?<a href="#/h/networks">{t('viewAll')}</a>:null}>{networks.data?.length?<div className="preview-list">{networks.data.slice(0,5).map(network=><a className="preview-row" href={`#${networkPath(network.network_id)}`} key={network.network_id}><span><span className="entity-name">{network.display_name}</span><span className="entity-secondary" style={{display:'block'}}>{network.virtual_cidr||network.network_name}</span></span><span className="numeric small muted">{t('networkOnline',{online:number(networks.error?undefined:network.online_member_count),total:number(network.member_count)})}</span></a>)}</div>:<Empty title={t(networks.loading?'loadingNetworks':consoleInfo.webhook_auth?'external.title':'emptyNetworks')}/>}</Panel>
    </div><ServerResources api={api}/></div>
  </div>;
}
