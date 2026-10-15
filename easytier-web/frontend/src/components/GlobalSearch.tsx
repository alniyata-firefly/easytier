import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type ApiClient from '../lib/api';
import { devicePath, navigate, networkPath } from '../lib/router';
import { buildDeviceInfo } from '../../../frontend-lib/src/modules/utils';
import { Icon } from './ui';

type SearchResult = { id: string; label: string; detail: string; path: string; kind: 'devices' | 'networks' | 'tokens' };
export function GlobalSearch({ api, external = false, route }: { api: ApiClient; external?: boolean; route: string }) {
  const { t } = useTranslation('app');
  const [query, setQuery] = useState(''), [open, setOpen] = useState(false), [loading, setLoading] = useState(false), [failed, setFailed] = useState(false), [index, setIndex] = useState(0), [rows, setRows] = useState<SearchResult[]>([]);
  const root = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null), id = useId();
  const term = query.trim().toLocaleLowerCase();
  const results = useMemo(() => rows.filter(row => `${row.label} ${row.detail}`.toLocaleLowerCase().includes(term)).slice(0, 12), [rows, term]);
  useEffect(() => { setOpen(false); }, [route]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent | FocusEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside); document.addEventListener('focusin', outside);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside); };
  }, [open]);
  useEffect(() => {
    if (!open || !term) { setLoading(false); return; }
    let current = true;
    setLoading(true); setFailed(false);
    const timer = setTimeout(async () => {
      const [devices, networks, tokens] = await Promise.allSettled([api.list_machines(), external ? Promise.resolve([]) : api.list_networks(), external ? Promise.resolve([]) : api.list_device_access_tokens()]);
      if (!current) return;
      const next: SearchResult[] = [];
      if (devices.status === 'fulfilled') for (const raw of devices.value) { const device = buildDeviceInfo(raw); next.push({ id: `device:${device.machine_id}`, label: device.alias || device.hostname || device.machine_id, detail: [device.public_ip, device.machine_id].filter(Boolean).join(' · '), path: devicePath(device.machine_id, device.running_network_instances?.[0]), kind: 'devices' }); }
      if (networks.status === 'fulfilled') for (const network of networks.value) next.push({ id: `network:${network.network_id}`, label: network.display_name, detail: [network.network_name, network.virtual_cidr].filter(Boolean).join(' · '), path: networkPath(network.network_id), kind: 'networks' });
      if (tokens.status === 'fulfilled') for (const token of tokens.value) next.push({ id: `token:${token.id}`, label: token.label, detail: token.machine_id || token.id, path: `/h/tokens?q=${encodeURIComponent(token.label)}`, kind: 'tokens' });
      setRows(next); setIndex(0); setFailed([devices, networks, tokens].some(value => value.status === 'rejected')); setLoading(false);
    }, 160);
    return () => { current = false; clearTimeout(timer); };
  }, [api, external, open, term]);
  const show = open && !!term;
  const choose = (row: SearchResult) => { setOpen(false); setQuery(''); navigate(row.path); };
  return <div className="global-search" ref={root}>
    <Icon name="search" size={17}/>
    <input ref={input} type="search" role="combobox" aria-label={t('search.label')} aria-autocomplete="list" aria-expanded={show} aria-controls={show ? id : undefined} aria-activedescendant={show && results[index] ? `${id}-${index}` : undefined} placeholder={t('search.placeholder')} value={query} onFocus={() => setOpen(true)} onChange={event => { setQuery(event.target.value); setIndex(0); setOpen(true); }} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); return; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); setIndex(value => results.length ? (value + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length : 0); }
      if (event.key === 'Enter' && show && results[index]) { event.preventDefault(); choose(results[index]); }
    }}/>
    {show && <div className="global-search-popover" aria-label={t('search.results')}>
      {loading && <p role="status">{t('search.loading')}</p>}
      {failed && !loading && <p role="status">{t('search.partial')}</p>}
      <div id={id} role="listbox" aria-label={t('search.results')}>{results.map((row, item) => <a href={`#${row.path}`} id={`${id}-${item}`} key={row.id} role="option" aria-selected={index === item} className={`global-search-result ${index === item ? 'selected' : ''}`} onPointerMove={() => setIndex(item)} onClick={event => { event.preventDefault(); choose(row); }}><Icon name={row.kind === 'devices' ? 'devices' : row.kind === 'networks' ? 'network' : 'key'} size={17}/><span><strong>{row.label}</strong><small>{t(`nav.${row.kind}`)} · {row.detail}</small></span></a>)}</div>
      {!loading && !results.length && <p role="status">{t('search.empty')}</p>}
    </div>}
  </div>;
}
