import { createRoot } from 'react-dom/client';
import { i18nReady } from './react/lib/i18n';
import { App } from './react/App';
import { NoticeProvider } from './react/components/ui';
import './react/fonts.css';
import './react/style.css';
import './react/client.css';
void i18nReady.then(() => { createRoot(document.getElementById('app')!).render(<NoticeProvider><App /></NoticeProvider>); });
