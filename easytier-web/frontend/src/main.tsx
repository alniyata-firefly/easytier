import { StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { i18nReady } from './lib/i18n';
import './fonts.css';
import './style.css';

i18nReady.finally(() => {
  createRoot(document.getElementById('root')!).render(<StrictMode><Suspense fallback={<main className="loading" role="status" aria-label="Loading" />}><App/></Suspense></StrictMode>);
});
