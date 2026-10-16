import { useRef, useState, type FormEvent } from 'react';
import { AxiosError } from 'axios';
import { useTranslation } from 'react-i18next';
import type ApiClient from '../lib/api';
import type { DeviceRebindRequest } from '../lib/api';
import { currentLocale, formatDate } from '../lib/i18n';
import { errorDescriptor, type ErrorDescriptor } from '../lib/hooks';
import { Alert, Button, Dialog, Empty, Panel, useNotice } from './ui';

type Selection = { request: DeviceRebindRequest; action: 'approve' | 'reject' };

function deviceOs(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && 'os_type' in parsed && typeof parsed.os_type === 'string') return parsed.os_type;
  } catch { /* Older clients can report an unstructured OS name. */ }
  return value || '—';
}

export function DeviceRebindRequests({ api, requests, loading, error, onRefresh, onResolved }: {
  api: ApiClient;
  requests?: DeviceRebindRequest[];
  loading: boolean;
  error?: string;
  onRefresh: () => void;
  onResolved: () => void;
}) {
  const { t } = useTranslation('devices');
  const notice = useNotice();
  const [selection, setSelection] = useState<Selection>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ErrorDescriptor | 'conflict'>();
  const [resolved, setResolved] = useState<Set<string>>(() => new Set());
  const submitting = useRef(false);
  const pending = (requests ?? []).filter(request => request.status === 'pending' && !resolved.has(request.id));
  const current = selection && pending.some(request => request.id === selection.request.id);
  const open = (request: DeviceRebindRequest, action: Selection['action']) => {
    setFailure(undefined);
    setSelection({ request, action });
  };
  const close = () => { if (!submitting.current) setSelection(undefined); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selection || !current || error || failure === 'conflict' || submitting.current) return;
    const { request, action } = selection;
    submitting.current = true;
    setBusy(true);
    setFailure(undefined);
    try {
      if (action === 'approve') await api.approve_device_rebind_request(request.id);
      else await api.reject_device_rebind_request(request.id);
      setResolved(old => new Set(old).add(request.id));
      setSelection(undefined);
      notice({ ns: 'devices', key: action === 'approve' ? 'rebind.approved' : 'rebind.rejected' });
      onResolved();
    } catch (error) {
      setFailure(error instanceof AxiosError && error.response?.status === 409 ? 'conflict' : errorDescriptor(error));
      onRefresh();
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  const message = failure === 'conflict' ? t('rebind.conflict') : failure ? t(failure.key, { ns: failure.ns, ...failure.values }) : '';
  return <>
    <Panel title={t('rebind.title')} action={<Button tone="ghost" icon="refresh" disabled={loading || busy} onClick={onRefresh}>{t('actions.refresh')}</Button>}>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {requests === undefined && loading ? <div className="loading" role="status">{t('rebind.loading')}</div> : pending.length ? <div className="table-wrap"><table className="data-table"><thead><tr>
        <th>{t('rebind.originalDevice')}</th><th>{t('rebind.newIdentity')}</th><th>{t('rebind.client')}</th><th>{t('rebind.discovered')}</th><th>{t('labels.actions')}</th>
      </tr></thead><tbody>{pending.map(request => <tr key={request.id}>
        <td><span className="entity-name">{request.old_device_alias || request.old_hostname || request.token_label || t('labels.unnamedDevice')}</span><div className="entity-secondary mono">{request.old_machine_id}</div><div className="entity-secondary">{t('rebind.tokenLabel', { label: request.token_label || '—' })}</div></td>
        <td><span className="entity-name">{request.hostname || t('labels.unnamedDevice')}</span><div className="entity-secondary mono">{request.new_machine_id}</div></td>
        <td>{deviceOs(request.device_os)}<div className="entity-secondary">{request.easytier_version || '—'}</div></td>
        <td>{formatDate(request.created_at)}<div className="entity-secondary">{t('rebind.attemptCount', { count: request.attempt_count, countFormatted: request.attempt_count.toLocaleString(currentLocale()) })}</div></td>
        <td><div className="actions"><Button disabled={busy || !!error} onClick={() => open(request, 'approve')}>{t('rebind.approve')}</Button><Button tone="danger" disabled={busy || !!error} onClick={() => open(request, 'reject')}>{t('rebind.reject')}</Button></div></td>
      </tr>)}</tbody></table></div> : !error ? <Empty title={t('rebind.none')}/> : null}
    </Panel>
    <Dialog open={!!selection} title={t(selection?.action === 'reject' ? 'rebind.rejectTitle' : 'rebind.approveTitle')} onClose={close}>
      {selection ? <form className="form-stack" onSubmit={submit}>
        {message ? <Alert tone="error">{message}</Alert> : !current ? <Alert tone="warning">{t('rebind.noLongerPending')}</Alert> : null}
        <p>{t(selection.action === 'approve' ? 'rebind.approvePrompt' : 'rebind.rejectPrompt', { name: selection.request.old_device_alias || selection.request.old_hostname || selection.request.token_label || t('labels.unnamedDevice') })}</p>
        <dl className="detail-list"><dt>{t('rebind.oldId')}</dt><dd className="mono">{selection.request.old_machine_id}</dd><dt>{t('rebind.newId')}</dt><dd className="mono">{selection.request.new_machine_id}</dd><dt>{t('labels.hostname')}</dt><dd>{selection.request.hostname || '—'}</dd><dt>{t('rebind.token')}</dt><dd>{selection.request.token_label || '—'}</dd><dt>{t('rebind.lastSeen')}</dt><dd>{formatDate(selection.request.last_seen_at)}</dd></dl>
        <div className="actions end"><Button tone="ghost" disabled={busy} onClick={close}>{t('actions.cancel')}</Button><Button type="submit" tone={selection.action === 'reject' ? 'danger' : 'primary'} busy={busy} disabled={!current || !!error || failure === 'conflict'}>{t(selection.action === 'reject' ? 'rebind.confirmReject' : 'rebind.confirmApprove')}</Button></div>
      </form> : null}
    </Dialog>
  </>;
}
