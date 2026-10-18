import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type ApiClient from '../lib/api';
import type { ConsoleInfo, ServerLogLevel, ServerLogQuery } from '../lib/api';
import { useResource } from '../lib/hooks';
import { currentLocale, formatDate } from '../lib/i18n';
import { navigate } from '../lib/router';
import { Utils } from '../lib/shared';
import { serializeServerLogs } from '../lib/server-logs';
import { ConnectionLogs } from '../components/ConnectionLogs';
import { Alert, Button, Empty, Field, Panel, Tabs } from '../components/ui';

const logDate = (time: number) => formatDate(time, { dateStyle: 'short', timeStyle: 'medium' });

function DeviceConnectionLogs({ api }: { api: ApiClient }) {
    const { t } = useTranslation('logs');
    const devices = useResource(() => api.list_machines().then(rows => rows.map(Utils.buildDeviceInfo)), 'log-devices');
    return <Panel title={t('connections')}>
        <p className="log-help">{t('connectionScope')}</p>
        {devices.error && <Alert tone="warning">{t('deviceNamesUnavailable')}</Alert>}
        <ConnectionLogs api={api} embedded devices={(devices.data ?? []).map(device => ({ id: device.machine_id, name: device.alias || device.hostname || device.machine_id }))}/>
    </Panel>;
}

function RuntimeLogs({ api }: { api: ApiClient }) {
    const { t } = useTranslation('logs');
    const [level, setLevel] = useState<ServerLogLevel>('INFO');
    const [target, setTarget] = useState(''), [search, setSearch] = useState('');
    const [filters, setFilters] = useState<ServerLogQuery>({ level: 'INFO' });
    const [cursors, setCursors] = useState<Array<number | undefined>>([undefined]);
    const [live, setLive] = useState(true), [restarted, setRestarted] = useState(false);
    const lastInstance = useRef<string | undefined>(undefined);
    const cursor = cursors[cursors.length - 1];
    const query = { ...filters, before_id: cursor, limit: 50 };
    const resource = useResource(() => api.list_server_logs(query), `server-logs:${JSON.stringify(query)}`, live && cursor === undefined ? 5000 : 0);
    const data = resource.data;
    const changedInstance = !!data && !!lastInstance.current && data.instance_id !== lastInstance.current;
    useEffect(() => {
        if (!data) return;
        if (lastInstance.current && lastInstance.current !== data.instance_id) {
            setRestarted(true);
            setCursors([undefined]);
        }
        lastInstance.current = data.instance_id;
    }, [data]);
    const apply = (event: FormEvent) => {
        event.preventDefault();
        setFilters({ level, ...(target.trim() ? { target: target.trim() } : {}), ...(search.trim() ? { q: search.trim() } : {}) });
        setCursors([undefined]);
    };
    const download = () => {
        if (!data || changedInstance || resource.loading || resource.error) return;
        const url = URL.createObjectURL(new Blob([serializeServerLogs(data, query)], { type: 'application/json;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `easytier-server-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    const rows = changedInstance ? undefined : data?.entries;
    return <Panel title={t('server')} className="server-log-panel">
        <p className="log-help">{t('scope')}</p>
        {data && <p className="log-meta">{t('retention', { started: logDate(data.started_at), capacity: data.capacity.toLocaleString(currentLocale()), dropped: data.dropped_entries.toLocaleString(currentLocale()) })}</p>}
        {restarted && <Alert tone="info">{t('restarted')}</Alert>}
        <form className="server-log-filters" onSubmit={apply}>
            <Field label={t('level')}><select value={level} onChange={event => setLevel(event.target.value as ServerLogLevel)}>
                <option value="INFO">{t('levels.INFO')}</option><option value="WARN">{t('levels.WARN')}</option><option value="ERROR">{t('levels.ERROR')}</option>
            </select></Field>
            <Field label={t('target')}><input type="search" value={target} maxLength={128} placeholder={t('targetPlaceholder')} onChange={event => setTarget(event.target.value)}/></Field>
            <Field label={t('search')}><input type="search" value={search} maxLength={128} placeholder={t('searchPlaceholder')} onChange={event => setSearch(event.target.value)}/></Field>
            <Button type="submit">{t('apply')}</Button>
        </form>
        <div className="list-toolbar server-log-actions">
            <Button icon="refresh" tone="ghost" busy={resource.loading} onClick={resource.refresh}>{t('refresh')}</Button>
            <Button icon={live ? 'pause' : 'play'} tone="ghost" aria-pressed={live} onClick={() => setLive(value => !value)}>{t(live ? 'pause' : 'resume')}</Button>
            <Button tone="ghost" disabled={cursor === undefined || resource.loading} onClick={() => setCursors([undefined])}>{t('latest')}</Button>
            <Button icon="download" tone="ghost" disabled={!rows?.length || resource.loading || !!resource.error} onClick={download}>{t('export')}</Button>
            <span className="log-live-state" role="status">{t(cursor !== undefined ? 'historical' : live ? 'live' : 'paused')}</span>
        </div>
        {resource.error && <Alert tone="error">{resource.error} {t('loadFailed')}</Alert>}
        {!rows ? resource.loading ? <p role="status">{t('loading')}</p> : null : rows.length ? <div className="table-wrap server-log-table"><table className="data-table">
            <thead><tr>{['time', 'severity', 'module', 'message'].map(key => <th key={key}>{t(key)}</th>)}</tr></thead>
            <tbody>{rows.map(entry => <tr key={`${data?.instance_id}:${entry.id}`}>
                <td className="mono"><time dateTime={new Date(entry.occurred_at).toISOString()}>{logDate(entry.occurred_at)}</time></td>
                <td><span className={`status ${entry.level === 'ERROR' ? 'failed' : entry.level === 'WARN' ? 'pending' : 'online'}`}>{entry.level}</span></td>
                <td className="mono log-target">{entry.target}</td>
                <td className="log-message"><div>{entry.message}</div>{Object.keys(entry.fields).length ? <details><summary>{t('fields')}</summary><dl>{Object.entries(entry.fields).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl></details> : null}</td>
            </tr>)}</tbody>
        </table></div> : !resource.error ? <Empty title={t(cursor !== undefined ? 'olderEmpty' : filters.q || filters.target || filters.level !== 'INFO' ? 'noMatches' : 'empty')}/> : null}
        <div className="actions end server-log-pagination">
            <Button tone="ghost" disabled={cursors.length < 2 || resource.loading} onClick={() => setCursors(previous => previous.slice(0, -1))}>{t('newer')}</Button>
            <Button tone="ghost" disabled={data?.next_before_id == null || resource.loading || !!resource.error || changedInstance} onClick={() => { const next = data?.next_before_id; if (next != null) setCursors(previous => [...previous, next]); }}>{t('older')}</Button>
        </div>
    </Panel>;
}

export function ServerLogsPage({ api, consoleInfo, section }: { api: ApiClient; consoleInfo: Pick<ConsoleInfo, 'server_logs_access'>; section?: string }) {
    const { t } = useTranslation('logs');
    const hasAccess = consoleInfo.server_logs_access === true;
    const restricted = section === 'server' && !hasAccess;
    const active = section === 'connections' || !hasAccess ? 'connections' : 'server';
    const items = [...(hasAccess ? [{ id: 'server', label: t('server') }] : []), { id: 'connections', label: t('connections') }];
    return <div className="page stack logs-page">
        <Tabs items={items} value={active} onChange={value => navigate(`/h/logs/${value}`)}/>
        {restricted && <Alert tone="warning">{t('restricted')}</Alert>}
        <div role="tabpanel" aria-label={t(active)}>{active === 'server' ? <RuntimeLogs api={api}/> : <DeviceConnectionLogs api={api}/>}</div>
    </div>;
}
