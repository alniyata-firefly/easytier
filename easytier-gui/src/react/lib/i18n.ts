import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import zhCommon from '../../../public/locales/zh-CN/common.json';
import enCommon from '../../../public/locales/en/common.json';
import zhNode from '../../../public/locales/zh-CN/node-config.json';
import enNode from '../../../public/locales/en/node-config.json';
import zhDevices from '../../../public/locales/zh-CN/devices.json';
import enDevices from '../../../public/locales/en/devices.json';
import zhClient from '../../../public/locales/zh-CN/client.json';
import enClient from '../../../public/locales/en/client.json';
export const isLanguage = (value: unknown): value is 'zh-CN' | 'en' => value === 'zh-CN' || value === 'en';
let initial = 'zh-CN';
try { const saved = localStorage.getItem('easytier.locale'); if (isLanguage(saved)) initial = saved; else { const legacy = localStorage.getItem('lang'); if (legacy === 'en') initial = 'en'; else if (legacy === 'cn') initial = 'zh-CN'; } } catch {}
i18next.use(initReactI18next);
export const i18nReady = i18next.init({
 lng: initial, fallbackLng: 'zh-CN', supportedLngs: ['zh-CN', 'en'],
 resources: { 'zh-CN': { common: zhCommon, 'node-config': zhNode, devices: zhDevices, client: zhClient }, en: { common: enCommon, 'node-config': enNode, devices: enDevices, client: enClient } },
 ns: ['common', 'client', 'node-config', 'devices'], defaultNS: 'client', fallbackNS: 'common',
 interpolation: { escapeValue: false }, returnNull: false, returnEmptyString: false,
});
i18next.on('languageChanged', lang => { document.documentElement.lang = lang; try { localStorage.setItem('easytier.locale', lang); } catch {} });
i18nReady.then(() => { document.documentElement.lang = i18next.resolvedLanguage || initial; });
export default i18next;
