import i18next from 'i18next';
import HttpBackend from 'i18next-http-backend';
import { initReactI18next } from 'react-i18next';

export const languageKey = 'easytier.locale';
export const supportedLanguages = ['zh-CN', 'en'] as const;
export type Language = typeof supportedLanguages[number];
export const isLanguage = (value: unknown): value is Language => value === 'zh-CN' || value === 'en';
let initial: Language = 'zh-CN';
if (typeof window !== 'undefined') {
  try { const saved = window.localStorage.getItem(languageKey); if (isLanguage(saved)) initial = saved; } catch { /* Storage can be disabled. */ }
}
if (typeof window !== 'undefined') i18next.use(HttpBackend);
i18next.use(initReactI18next);
export const i18nReady = i18next.init({
  lng: initial, fallbackLng: 'zh-CN', supportedLngs: [...supportedLanguages], load: 'currentOnly',
  ns: ['common', 'app'], defaultNS: 'common', fallbackNS: 'common',
  ...(typeof window === 'undefined' ? { resources: { 'zh-CN': { common: {}, app: {} } } } : {}),
  backend: { loadPath: '/locales/{{lng}}/{{ns}}.json', requestOptions: { credentials: 'same-origin' } },
  interpolation: { escapeValue: false }, returnNull: false, returnEmptyString: false,
  react: { useSuspense: true }, debug: false,
});
const updateDocument = (language: string) => {
  if (typeof document !== 'undefined') { document.documentElement.lang = language; document.title = i18next.t('app:documentTitle'); }
};
i18next.on('languageChanged', language => { updateDocument(language); if (typeof window !== 'undefined' && isLanguage(language)) try { window.localStorage.setItem(languageKey, language); } catch { /* Do not block rendering. */ } });
i18nReady.then(() => updateDocument(i18next.resolvedLanguage || initial));
export const currentLocale = () => i18next.resolvedLanguage === 'en' ? 'en-US' : 'zh-CN';
export function formatDate(value: string | number | Date, options?: Intl.DateTimeFormatOptions) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(currentLocale(), options).format(date);
}
export default i18next;
