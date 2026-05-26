import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import enUS from './locales/en-US.json';
import zhCN from './locales/zh-CN.json';

const saved = typeof localStorage !== 'undefined'
  ? localStorage.getItem('cpb-locale') || 'en-US'
  : 'en-US';

i18n.use(initReactI18next).init({
  resources: {
    'en-US': { translation: enUS },
    'zh-CN': { translation: zhCN },
  },
  lng: saved,
  fallbackLng: 'en-US',
  interpolation: { escapeValue: false },
  ns: ['translation'],
  defaultNS: 'translation',
});

export default i18n;
