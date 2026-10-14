import { useEffect, useRef, useState } from 'react';
import { AxiosError } from 'axios';
import { useTranslation } from 'react-i18next';
import i18n from './i18n';

export type ErrorDescriptor = { key: string; ns: 'common'; values?: Record<string, unknown> };
export function errorDescriptor(error: unknown): ErrorDescriptor {
  const message = (key: string, values?: Record<string, unknown>): ErrorDescriptor => ({ key: `errors.${key}`, ns: 'common', values });
  if (error instanceof AxiosError) {
    const status = error.response?.status;
    if (status === 401) return message('unauthorized');
    if (status === 403) return message('forbidden');
    if (status === 404) return message('notFound');
    if (status === 409) return message('conflict');
    if (status === 504 || error.code === 'ECONNABORTED') return message('timeout');
    if (status) return message('http', { status });
    return message('network');
  }
  return message('invalid');
}
export function errorMessage(error: unknown): string {
  const descriptor = errorDescriptor(error);
  return i18n.t(descriptor.key, { ns: descriptor.ns, ...descriptor.values });
}

/** Serial visible polling; request results belong to one key and one mounted effect. */
export function useResource<T>(loader: () => Promise<T>, key: string, interval = 0) {
  const { t } = useTranslation('common');
  const load = useRef(loader);
  useEffect(() => {load.current = loader;}, [loader]);
  const refreshRef = useRef<() => void>(() => {});
  const [state, setState] = useState<{key: string; data?: T; error?: ErrorDescriptor; errorRevision: number; loading: boolean; updatedAt: number}>({ key, loading: true, updatedAt: 0, errorRevision: 0 });
  useEffect(() => {
    let cancelled = false, running = false, queued = false, failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState({ key, loading: true, updatedAt: 0, errorRevision: 0 });
    const run = async () => {
      if (cancelled || running || document.hidden) return;
      running = true;
      setState(old => ({...old, loading: true}));
      try {
        const value = await load.current();
        if (!cancelled) { failures = 0; setState(old => ({key, data: value, loading: false, updatedAt: Date.now(), errorRevision: old.errorRevision})); }
      } catch (error) {
        if (!cancelled) { failures++; setState(old => ({...old, error: errorDescriptor(error), errorRevision: old.errorRevision + 1, loading: false})); }
      } finally {
        running = false;
        if (!cancelled && (queued || interval)) {
          const delay = queued ? 0 : Math.min(interval * 2 ** Math.min(failures, 4), 60000);
          queued = false;
          timer = setTimeout(run, delay);
        }
      }
    };
    const refresh = () => {
      if (cancelled) return;
      clearTimeout(timer);
      if (running) queued = true;
      else void run();
    };
    const visible = () => { if (!document.hidden) refresh(); else clearTimeout(timer); };
    refreshRef.current = refresh;
    document.addEventListener('visibilitychange', visible);
    void run();
    return () => { cancelled = true; clearTimeout(timer); document.removeEventListener('visibilitychange', visible); refreshRef.current = () => {}; };
  }, [key, interval]);
  return {...state, data: state.key === key ? state.data : undefined,
    error: state.key === key && state.error ? t(state.error.key, state.error.values) : undefined,
    loading: state.key !== key || state.loading, refresh: () => refreshRef.current()};
}
