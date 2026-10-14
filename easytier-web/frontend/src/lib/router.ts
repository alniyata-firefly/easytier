import { useSyncExternalStore } from 'react';

const subscribe = (listener: () => void) => {
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
};
const snapshot = () => window.location.hash.replace(/^#/, '') || '/h';
export const useRoute = () => useSyncExternalStore(subscribe, snapshot);
export function navigate(path: string) { window.location.hash = path; }
export const networkPath = (id: string) => `/h/networks/${encodeURIComponent(id)}`;
export const devicePath = (id: string, instance?: string) => `/h/deviceList/device/${encodeURIComponent(id)}${instance ? '/' + encodeURIComponent(instance) : ''}`;
