/**
 * i18next bootstrap.
 *
 * PRD §2.8: i18n framework is wired up now (so P1 English work is a
 * translation-only task, not a refactor), but MVP only ships zh-CN UI.
 * English keys are reserved (translations marked TODO) and not surfaced.
 */
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { zhCN } from './zh-CN';
import { en } from './en';

let initialized = false;

/**
 * Initialise i18next. Safe to call multiple times — second+ calls are no-ops.
 * Synchronous (no async backend), so the first paint is already translated.
 */
export function initI18n(): void {
  if (initialized) return;
  initialized = true;
  void i18next.use(initReactI18next).init({
    resources: {
      'zh-CN': { translation: zhCN },
      en: { translation: en },
    },
    lng: 'zh-CN',
    fallbackLng: 'zh-CN',
    interpolation: { escapeValue: false },
    returnNull: false,
  });
}

export { i18next };
